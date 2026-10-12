'use strict';
/*
 * Repeating messages ("Repeat this message", Oct 2026) and rotating versions.
 *
 * A repeat series is a schedule: every day / weekdays (Mon–Fri) / chosen days / every week, at a time of day in the
 * workspace time zone (Settings → Workspace), ending never / on a date / after N sends. It has 1 to 30 message versions;
 * with 2 or more each run sends the next one, in order or at random without repeating until all were used.
 *
 * Each run becomes a NORMAL broadcast (status 'scheduled', send_at = the run time), so reports, delivery stats, audiences,
 * the subscriber limit, the Telegram rate and auto-delete / auto-pin all work as they do for one-off messages: the
 * broadcast job (workers/jobs.js broadcastsTick) calls tick() first, then queues due broadcasts as usual.
 *
 * Safe against double sends: one broadcast per series and run date (unique index broadcasts_series_run), made inside
 * the same transaction that moves the series to its next run, with the series row locked (FOR UPDATE SKIP LOCKED).
 * A run that is more than LATE_MS late (the server was down, maintenance, the plan was paused) is skipped, never
 * sent late: the series carries on with the next upcoming time, so nothing floods out afterwards. While the plan
 * can't send (paused, trial over, Free, over the subscriber limit, over the plan's repeating messages), runs are
 * skipped the same way and the series says why (last_error); it continues by itself once the plan can send again.
 *
 * Plan limits (billing.js BOT_PLANS max_repeat_series): Free 0 (no broadcasts), Starter 3, Growth 20 (and the trial),
 * Scale unlimited with a fair-use cap of 100. Active and waiting-for-approval series count; paused and stopped don't.
 */

const db = require('../db');
const log = require('../lib/log');
const settings = require('./settings');
const billing = require('./billing');
const B = require('./broadcasts');
const { badRequest, httpError, int, oneOf, fmtUSD } = require('../lib/util');

const FREQS = ['daily', 'weekdays', 'days', 'weekly'];
const END_MODES = ['never', 'date', 'count'];
const ROTATIONS = ['order', 'random'];
const MAX_VERSIONS = 30;
const MAX_END_COUNT = 1000;
const LATE_MS = 3 * 3600000;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TIME_RX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RX = /^(\d{4})-(\d{2})-(\d{2})$/;

/* ---------- Time math (pure; tested on its own) ---------- */

function safeZone(tz) { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; } catch { return 'UTC'; } }
const pad = (n) => String(n).padStart(2, '0');
const ymd = (w) => `${w.y}-${pad(w.m)}-${pad(w.d)}`;
/**
 * The UTC instant (ms) of wall-clock y-m-d h:min in a zone. Tries the zone's offset before and after that day (a DST
 * change on that day is right). A time that happens twice (clocks going back) gives the first one. A time that does not
 * exist that day (clocks jumping forward over it, e.g. 00:00 in Santiago or Cairo on their DST day) gives the same
 * moment after the jump (00:00 → 01:00) ON THAT DAY: before, it fell on the evening before, so that day's run clashed
 * with the day before's (one run per date) and was silently lost, and a "Sundays" run went out on Saturday.
 */
function zonedInstant(zone, y, m, d, h, min) {
  const wall = Date.UTC(y, m - 1, d, h, min);
  const before = wall - B.offsetMinutes(zone, wall - 86400000) * 60000;
  const after = wall - B.offsetMinutes(zone, wall + 86400000) * 60000;
  const matches = (t) => { const w = B.wallClock(zone, t); return w.y === y && w.m === m && w.d === d && w.h === h && w.min === min; };
  const ok = [before, after].filter(matches);
  if (ok.length) return Math.min(...ok);
  return Math.max(before, after);
}
/** Does a local date (day of week 0 = Sunday) match the schedule? */
function dayMatches(s, dow) {
  if (s.freq === 'daily') return true;
  if (s.freq === 'weekdays') return dow >= 1 && dow <= 5;
  const days = (s.days || []).map(Number);
  if (s.freq === 'weekly') return dow === days[0];
  return days.includes(dow);
}
/**
 * The next run strictly after `afterMs` (ms), or null when the end date is passed. s: { freq, days, time_of_day,
 * end_mode, end_date }. Count endings are checked by the caller (they depend on runs made).
 */
function nextRun(s, zone, afterMs) {
  zone = safeZone(zone);
  const [h, min] = String(s.time_of_day).split(':').map(Number);
  const start = B.wallClock(zone, afterMs);
  const end = s.end_mode === 'date' && s.end_date ? dateStr(s.end_date) : null;
  for (let i = 0; i <= 8; i++) {
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
    const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate();
    if (end && `${y}-${pad(m)}-${pad(d)}` > end) return null;
    if (!dayMatches(s, day.getUTCDay())) continue;
    const t = zonedInstant(zone, y, m, d, h, min);
    if (t > afterMs) return t;
  }
  return null;
}
/** Runs from `fromMs` up to `untilMs` (at most `limit`), honouring the end date and the sends left. */
function upcoming(s, zone, fromMs, untilMs, limit = 40) {
  const out = [];
  let left = s.end_mode === 'count' && s.end_count ? Math.max(0, Number(s.end_count) - Number(s.runs || 0)) : Infinity;
  let t = fromMs;
  while (out.length < limit && left > 0) {
    const n = nextRun(s, zone, t);
    if (n == null || n > untilMs) break;
    out.push(n);
    left--;
    t = n;
  }
  return out;
}
/** A date column (Date at UTC midnight, or 'YYYY-MM-DD') as 'YYYY-MM-DD'. */
function dateStr(v) {
  if (!v) return null;
  if (v instanceof Date) return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  return String(v).slice(0, 10);
}
/** "Tue 9:00 AM" in the workspace time zone (plus the date when it is not within the next 6 days). */
function label(t, zone) {
  if (t == null) return null;
  const z = safeZone(zone);
  const d = new Date(t);
  const time = d.toLocaleTimeString('en-US', { timeZone: z, hour: 'numeric', minute: '2-digit' });
  const day = d.toLocaleDateString('en-US', { timeZone: z, weekday: 'short' });
  if (Number(t) - Date.now() < 6 * 86400000) return `${day} ${time}`;
  return `${day} ${d.toLocaleDateString('en-US', { timeZone: z, month: 'short', day: 'numeric' })}, ${time}`;
}
/** "Every day at 9:00 AM", "Mon, Wed, Fri at 18:30"... */
function describe(s) {
  const [h, m] = String(s.time_of_day).split(':').map(Number);
  const time = new Date(Date.UTC(2026, 0, 1, h, m)).toLocaleTimeString('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' });
  const days = (s.days || []).map(Number).sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((x) => DAY_NAMES[x]);
  const when = s.freq === 'daily' ? 'Every day' : s.freq === 'weekdays' ? 'Weekdays (Mon–Fri)' : s.freq === 'weekly' ? `Every ${DAY_NAMES[Number((s.days || [])[0])] || 'week'}` : days.join(', ');
  const end = s.end_mode === 'date' ? `, until ${dateStr(s.end_date)}` : s.end_mode === 'count' ? `, ${s.end_count} time${Number(s.end_count) === 1 ? '' : 's'}` : '';
  return `${when} at ${time}${end}`;
}

/* ---------- Rotation ---------- */

/**
 * After version `cur` (index) was sent, which one goes next? 'order': the next one. 'random': a random one not used yet
 * in this round (never the one just sent, when there are 2 or more); a new round starts when all were used.
 */
function rotate(rotation, n, cur, used, rnd = Math.random) {
  if (n <= 1) return { next: 0, used: [] };
  if (rotation !== 'random') return { next: (cur + 1) % n, used: [] };
  let u = [...new Set([...(used || []).map(Number), cur])].filter((i) => i >= 0 && i < n);
  let left = Array.from({ length: n }, (_, i) => i).filter((i) => !u.includes(i));
  if (!left.length) { u = []; left = Array.from({ length: n }, (_, i) => i).filter((i) => i !== cur); }
  return { next: left[Math.floor(rnd() * left.length)], used: u };
}
/** The first version of a new (or re-shuffled) series. */
const firstVersion = (rotation, n, rnd = Math.random) => (rotation === 'random' && n > 1 ? Math.floor(rnd() * n) : 0);

/* ---------- Plan limits ---------- */

/** The most active repeating messages for a workspace (-1 = unlimited) and the fair-use cap. */
async function seriesLimit(ws) {
  const l = await billing.limits(ws);
  const b = l.bots || {};
  return { max: b.max_repeat_series ?? 0, fair: b.max_repeat_series_fair_use || null };
}
const LIVE = ['active', 'pending_approval'];
async function liveCount(wsId, exceptId = 0) {
  return (await db.one('select count(*)::int n from repeat_series where workspace_id = $1 and status = any($2::text[]) and id <> $3', [wsId, LIVE, exceptId])).n;
}
/** Throws a friendly 402 when one more active repeating message is over the plan. */
async function assertSlot(ws, exceptId = 0) {
  if (!(await billing.hasFeature(ws, 'broadcasts'))) await billing.requirePlanFeature(ws, 'broadcasts');
  await billing.requirePlanFeature(ws, 'schedule');
  const { max, fair } = await seriesLimit(ws);
  const used = await liveCount(ws.id, exceptId);
  const cap = max === -1 ? (fair || Infinity) : max;
  if (used < cap) return;
  if (max === -1) throw httpError(402, `You have ${used} repeating messages running, the fair-use amount. Pause or stop one, or talk to us if you need more.`, 'limit_repeats', { used, limit: cap });
  const plans = (await settings.plans({ activeOnly: true })).filter((p) => Number(p.price_month_cents) > 0).sort((a, b) => Number(a.price_month_cents) - Number(b.price_month_cents));
  const up = plans.find((p) => { const m = billing.botPlanOf(p).max_repeat_series; return m === -1 || m > max; });
  const l = await billing.limits(ws);
  throw httpError(402, `Your ${l.plan.name} plan runs ${max} repeating message${max === 1 ? '' : 's'} at a time${used ? ` and you have ${used}` : ''}. Pause or stop one${up ? `, or upgrade to ${up.name} (${fmtUSD(up.price_month_cents)} a month) for ${billing.botPlanOf(up).max_repeat_series === -1 ? 'unlimited' : billing.botPlanOf(up).max_repeat_series}` : ''}.`, 'limit_repeats', { used, limit: max, plan: up ? up.code : null });
}

/* ---------- Checking a form ---------- */

/** Schedule part of a form → clean values. today: the workspace's local date ('YYYY-MM-DD'). */
function cleanSchedule(b, today) {
  const freq = oneOf(String(b.freq || ''), 'How often', FREQS);
  let days = [];
  if (freq === 'days' || freq === 'weekly') {
    days = [...new Set((Array.isArray(b.days) ? b.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))];
    if (!days.length) throw badRequest(freq === 'weekly' ? 'Pick the day of the week.' : 'Pick at least one day.');
    if (freq === 'weekly') days = days.slice(0, 1);
  }
  const time = String(b.time_of_day || b.time || '').trim();
  if (!TIME_RX.test(time)) throw badRequest('Pick a time of day, like 09:00.');
  const end = oneOf(String(b.end_mode || 'never'), 'Ends', END_MODES);
  let endDate = null, endCount = null;
  if (end === 'date') {
    endDate = String(b.end_date || '').slice(0, 10);
    if (!DATE_RX.test(endDate) || Number.isNaN(Date.parse(endDate + 'T00:00:00Z'))) throw badRequest('Pick the last day it should go out.');
    if (endDate < today) throw badRequest('That end date has already passed.');
    const max = new Date(Date.parse(today + 'T00:00:00Z') + 2 * 366 * 86400000).toISOString().slice(0, 10);
    if (endDate > max) throw badRequest('Pick an end date within 2 years, or choose "Never".');
  }
  if (end === 'count') endCount = int(b.end_count, 'Number of sends', { min: 1, max: MAX_END_COUNT });
  const rotation = oneOf(String(b.rotation || 'order'), 'Rotation', ROTATIONS);
  return { freq, days, time_of_day: time, end_mode: end, end_date: endDate, end_count: endCount, rotation };
}

/** Versions part of a form → clean messages (each checked like a broadcast). */
async function cleanVersions(wsId, list) {
  const raw = Array.isArray(list) ? list : [];
  if (!raw.length) throw badRequest('Write the message first.');
  if (raw.length > MAX_VERSIONS) throw badRequest(`Use ${MAX_VERSIONS} versions or fewer.`);
  const out = [];
  for (const [i, v] of raw.entries()) {
    try {
      const m = await B.checkMessage(wsId, { body: v && v.body, media_id: v && v.media_id, buttons: v && v.buttons });
      out.push(m);
    } catch (e) {
      if (raw.length > 1) e.message = `Version ${i + 1}: ${e.message}`;
      throw e;
    }
  }
  return out;
}

/**
 * The next run from now for a series being saved, resumed or approved. When that run would be later TODAY and today's
 * message already went out (one run per day), it moves to the next day it repeats and says so gently (note).
 */
async function nextFresh(s, zone, now = Date.now()) {
  let next = nextRun(s, zone, now);
  if (next == null || !s.id) return { next, note: null };
  const today = ymd(B.wallClock(safeZone(zone), now));
  if (ymd(B.wallClock(safeZone(zone), next)) !== today) return { next, note: null };
  const sent = await db.one("select 1 from broadcasts where series_id = $1 and run_date = $2 and status <> 'cancelled'", [s.id, today]);
  if (!sent) return { next, note: null };
  next = nextRun(s, zone, next);
  if (next == null) return { next, note: 'Today\'s message was already sent, and there is no later day left before the end date.' };
  const tomorrow = ymd(B.wallClock(safeZone(zone), now + 86400000)) === ymd(B.wallClock(safeZone(zone), next));
  return { next, note: tomorrow ? 'Today\'s message was already sent; the new time starts tomorrow.' : `Today's message was already sent; the new time starts ${label(next, zone)}.` };
}

/* ---------- Reading ---------- */

const todayIn = (zone) => ymd(B.wallClock(safeZone(zone), Date.now()));

/** One series for the dashboard: schedule words, next run ("Tue 9:00 AM"), versions, what goes next, history. */
async function view(s, ws, { history = true } = {}) {
  const zone = safeZone(ws.timezone);
  const versions = await db.many(`select v.position, v.body, v.media_id, v.buttons, m.kind as media_kind, m.filename as media_filename, m.size_bytes as media_size, m.duration_sec as media_duration
    from repeat_versions v left join media m on m.id = v.media_id where v.series_id = $1 order by v.position`, [s.id]);
  const conn = await db.one('select id, kind, title, username from connections where id = $1', [s.connection_id]);
  const seg = s.segment_id ? await db.one('select name from segments where id = $1', [s.segment_id]) : null;
  const next = s.next_run_at ? new Date(s.next_run_at).getTime() : null;
  const out = {
    id: s.id, title: s.title, status: s.status, connection_id: s.connection_id, connection: conn, segment_id: s.segment_id, segment_name: seg ? seg.name : null, include_stop: s.include_stop,
    freq: s.freq, days: (s.days || []).map(Number), time_of_day: s.time_of_day, end_mode: s.end_mode, end_date: dateStr(s.end_date), end_count: s.end_count, rotation: s.rotation,
    timezone: zone, schedule: describe(s), next_run_at: s.next_run_at, next_label: label(next, zone), runs: s.runs, last_run_at: s.last_run_at, last_skip_at: s.last_skip_at, last_error: s.last_error,
    delete_after_hours: s.delete_after_hours, pin: s.pin, pin_notify: s.pin_notify, unpin_after_hours: s.unpin_after_hours,
    versions: versions.map((v) => ({ position: v.position, body: v.body, buttons: (v.buttons || []).map((b) => ({ label: b.label, url: b.url })),
      media: v.media_id ? { id: v.media_id, kind: v.media_kind, filename: v.media_filename, size: Number(v.media_size || 0), duration: v.media_duration } : null })),
    next_version: versions.length ? Math.min(s.next_version, versions.length - 1) : 0,
    created_at: s.created_at,
  };
  if (history) {
    out.history = await db.many(`select id, title, status, version_pos, run_date, send_at, total, sent, failed, started_at, finished_at,
        (select count(*)::int from clicks k join links l on l.code = k.code where l.broadcast_id = b.id) as clicks
      from broadcasts b where series_id = $1 order by id desc limit 20`, [s.id]);
  }
  return out;
}

/** Every series of a workspace, plus the plan limit and the runs of the next `days` days (the calendar). */
async function list(ws, { days = 31 } = {}) {
  const rows = await db.many('select * from repeat_series where workspace_id = $1 and status <> $2 order by id desc limit 200', [ws.id, 'stopped']);
  const stopped = await db.many("select * from repeat_series where workspace_id = $1 and status = 'stopped' order by updated_at desc limit 10", [ws.id]);
  const zone = safeZone(ws.timezone);
  const series = [];
  const calendar = [];
  const until = Date.now() + days * 86400000;
  for (const s of [...rows, ...stopped]) {
    const v = await view(s, ws, { history: false });
    series.push(v);
    if (s.status === 'active' && s.next_run_at) {
      const first = new Date(s.next_run_at).getTime();
      // The next run counts as one of the sends left, then the ones after it.
      const times = [first, ...upcoming({ ...s, runs: Number(s.runs) + 1 }, zone, first, until, 40)];
      for (const t of times) {
        if (t > until) continue;
        // date / time on the workspace's own clock, so the calendar grid puts it on the right day (whatever the browser's zone).
        const w = B.wallClock(zone, t);
        calendar.push({ series_id: s.id, title: s.title, at: new Date(t).toISOString(), label: label(t, zone), date: ymd(w), time: `${pad(w.h)}:${pad(w.min)}` });
      }
    }
  }
  calendar.sort((a, b) => a.at.localeCompare(b.at));
  const lim = await seriesLimit(ws).catch(() => ({ max: 0, fair: null }));
  return { series, calendar, limit: { max: lim.max, fair_use: lim.fair, active: await liveCount(ws.id) }, timezone: zone };
}

/* ---------- The scheduler ---------- */

/** Make the broadcasts of every due series. Returns how many runs were made. Called by the broadcast job. */
async function tick() {
  const f = await settings.features();
  if (f.maintenance) return 0; // runs that come due now are skipped later if maintenance lasts over LATE_MS
  const due = await db.many("select id from repeat_series where status = 'active' and next_run_at <= now() order by next_run_at limit 50");
  let n = 0;
  for (const { id } of due) {
    try { if (await runOne(id, f)) n++; } catch (e) { log.warn('repeat run failed', { series: id, err: e.message }); }
  }
  return n;
}

/**
 * One due run of one series (inside a transaction, the series row locked). Either makes the run's broadcast or
 * skips it with a reason; in both cases the series moves to its next upcoming time (never backwards, never a flood).
 */
async function runOne(id, f) {
  return db.tx(async (c) => {
    const s = (await c.query("select * from repeat_series where id = $1 and status = 'active' and next_run_at <= now() for update skip locked", [id])).rows[0];
    if (!s) return false;
    const ws = (await c.query('select * from workspaces where id = $1', [s.workspace_id])).rows[0];
    const zone = safeZone(ws.timezone);
    const runAt = new Date(s.next_run_at).getTime();
    const now = Date.now();
    const moveOn = async (fields) => {
      const next = nextRun(s, zone, Math.max(runAt, now));
      const runs = fields.runs ?? s.runs;
      const ended = next == null || (s.end_mode === 'count' && s.end_count && runs >= s.end_count);
      await c.query(`update repeat_series set next_run_at = $2, status = $3, runs = $4, last_run_at = coalesce($5, last_run_at), last_skip_at = coalesce($6, last_skip_at),
          last_error = $7, next_version = $8, used_versions = $9, updated_at = now() where id = $1`,
      [s.id, ended ? null : new Date(next), ended ? 'ended' : 'active', runs, fields.ran ? new Date() : null, fields.skipped ? new Date() : null, fields.error ?? null, fields.next_version ?? s.next_version, fields.used ?? s.used_versions]);
      return !!fields.ran;
    };
    const skip = (reason) => moveOn({ skipped: true, error: reason });
    if (now - runAt > LATE_MS) return skip(`The ${label(runAt, zone)} send was missed while sending was paused, so it was skipped. It carries on at the next time.`);
    if (!f.broadcasts || f.repeats === false) return skip('Sending was switched off by the Castvoo team at that time, so this send was skipped.');
    try { await billing.assertCanSend(ws); await billing.requirePlanFeature(ws, 'schedule'); } catch (e) { return skip(`Skipped: ${e.message}`); }
    // More running than the plan allows (after a move to a smaller plan): only the oldest ones send.
    const { max, fair } = await seriesLimit(ws);
    const cap = max === -1 ? (fair || Infinity) : max;
    const rank = (await c.query("select count(*)::int n from repeat_series where workspace_id = $1 and status = 'active' and id <= $2", [ws.id, s.id])).rows[0].n;
    if (rank > cap) return skip(`Skipped: your plan runs ${cap} repeating message${cap === 1 ? '' : 's'} at a time. Pause or stop another one, or upgrade.`);
    const conn = (await c.query("select * from connections where id = $1 and status = 'active'", [s.connection_id])).rows[0];
    if (!conn) return skip('Skipped: the bot, channel or group needs attention (Channels & bots).');
    const versions = (await c.query('select * from repeat_versions where series_id = $1 order by position', [s.id])).rows;
    if (!versions.length) return skip('Skipped: this repeating message has no message to send.');
    const idx = Math.min(Math.max(0, s.next_version), versions.length - 1);
    const v = versions[idx];
    const runDate = ymd(B.wallClock(zone, runAt));
    const title = (s.title || B.titleFrom(v.body, null)).slice(0, 60) + ' · ' + runDate;
    const br = (await c.query(`insert into broadcasts(workspace_id, connection_id, segment_id, title, body, media_id, buttons, include_stop, send_mode, send_at, status, created_by,
        series_id, run_date, version_pos, delete_after_hours, pin, pin_notify, unpin_after_hours)
      values ($1,$2,$3,$4,$5,$6,'[]',$7,'at',$8,'scheduled',$9,$10,$11,$12,$13,$14,$15,$16)
      on conflict (series_id, run_date) where series_id is not null do nothing returning *`,
    [ws.id, conn.id, s.segment_id, title, v.body, v.media_id, conn.kind === 'bot' ? s.include_stop : false, new Date(runAt), s.created_by,
      s.id, runDate, idx, s.delete_after_hours, s.pin, s.pin_notify, s.unpin_after_hours])).rows[0];
    if (!br) return moveOn({}); // this date already has its run (a restarted worker, or the time was moved to later the same day)
    const btns = await B.makeLinks(c, ws.id, (v.buttons || []).map((b) => ({ label: b.label, url: b.url })), { broadcastId: br.id });
    await c.query('update broadcasts set buttons = $2 where id = $1', [br.id, JSON.stringify(btns)]);
    const r = rotate(s.rotation, versions.length, idx, s.used_versions);
    return moveOn({ ran: true, runs: s.runs + 1, next_version: r.next, used: r.used });
  });
}

module.exports = {
  FREQS, END_MODES, ROTATIONS, MAX_VERSIONS, LATE_MS, LIVE,
  safeZone, zonedInstant, nextRun, upcoming, label, describe, dateStr, todayIn, rotate, firstVersion,
  seriesLimit, liveCount, assertSlot, nextFresh, cleanSchedule, cleanVersions, view, list, tick, runOne,
};

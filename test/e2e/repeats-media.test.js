'use strict';
/*
 * Oct 2026 features end to end: repeating messages (schedule math, end conditions, idempotency, pause/resume without a
 * flood, plan limits), rotating versions, voice notes and round videos (upload checks, ffmpeg conversion through a
 * stand-in, round video + text split send), auto-delete (48-hour guard) and auto-pin / unpin (rights), and workspace
 * isolation.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { startApp, FILES } = require('../helpers/app');

const FAKE_FFMPEG = path.join(__dirname, '..', 'helpers', 'fake-ffmpeg.js');
const FF_LOG = path.join(os.tmpdir(), `castvoo-ffmpeg-${process.pid}.log`);

let app;
before(async () => {
  process.env.FAKE_FFMPEG_LOG = FF_LOG;
  app = await startApp({ env: { FFMPEG_PATH: FAKE_FFMPEG } });
});
after(async () => { if (app) await app.stop(); fs.rmSync(FF_LOG, { force: true }); delete process.env.FAKE_FFMPEG_LOG; });
beforeEach(() => { app.rl._reset(); app.fakes.tg.pinError = null; app.fakes.tg.deleteError = null; app.fakes.tg.chatMember = null; delete process.env.FAKE_FFMPEG_FAIL; });

let seq = 0;
const R = () => app.require('services/repeats');
async function setPlan(wsId, code, status = 'active') {
  await app.db.query("update workspaces set plan_code = $2, plan_status = $3, trial_ends_at = null, period_end = case when $2 = 'free' then null else now() + interval '20 days' end where id = $1", [wsId, code, status]);
  app.settings.bust();
}
/** An owner on `plan` with a bot and n subscribers (tg ids base+1..). */
async function setup(plan = 'starter', n = 2, tz = 'Africa/Lagos') {
  const c = await app.loginByEmail(`rpt-${++seq}@example.com`);
  const ws = await app.ws(c);
  await setPlan(ws.id, plan);
  await app.db.query('update workspaces set timezone = $2 where id = $1', [ws.id, tz]);
  const bot = await app.connectBot(c);
  const base = 900000 + seq * 100;
  for (let i = 1; i <= n; i++) await app.start(bot.connId, base + i);
  return { c, ws, bot, ids: Array.from({ length: n }, (_, i) => base + i + 1) };
}
const series = (s, extra = {}) => ({ connection_id: s.bot.connId, freq: 'daily', time_of_day: '09:00', versions: [{ body: 'Daily tip' }], ...extra });
const sendsTo = (token) => app.fakes.tgCalls(null, token).filter((c) => /^send/.test(c.method));
const callsTo = (token, method) => app.fakes.tgCalls(method, token);
/** Make a series due now (a minute ago) and run the broadcast job. */
async function runDue(id, ago = "interval '1 minute'") {
  await app.db.query(`update repeat_series set next_run_at = now() - ${ago} where id = $1`, [id]);
  await app.jobs.broadcastsTick();
  await app.flush();
}
/** Free today's run date of a series, as if its last run was on another day (so the next forced run is a new date). */
const freeToday = (id) => app.db.query("update broadcasts set run_date = run_date - (select count(*)::int from broadcasts x where x.series_id = $1) - 1 where series_id = $1 and run_date = (select max(run_date) from broadcasts where series_id = $1)", [id]);
const runsOf = (id) => app.db.many('select * from broadcasts where series_id = $1 order by id', [id]);
const upload = (c, buf, type, as, name = 'rec') => c.post('/api/media' + (as ? '?as=' + as : ''), buf, { headers: { 'content-type': type, 'x-filename': name } });
const ffCalls = () => (fs.existsSync(FF_LOG) ? fs.readFileSync(FF_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/* Small files for uploads. */
const AUDIO = {
  mp3: () => Buffer.concat([Buffer.from('ID3'), crypto.randomBytes(3000)]),
  ogg: () => Buffer.concat([Buffer.from('OggS'), crypto.randomBytes(3000)]),
  webm: () => Buffer.concat([Buffer.from('1a45dfa3', 'hex'), crypto.randomBytes(3000)]),
};
/** A tiny MP4 the server can read: ftyp, then moov with mvhd (length) and tkhd (width × height), and an avc1 tag. */
function mp4(w, h, seconds = 10) {
  const box = (type, body) => { const b = Buffer.alloc(8 + body.length); b.writeUInt32BE(8 + body.length, 0); b.write(type, 4, 'latin1'); body.copy(b, 8); return b; };
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(seconds * 1000, 16);
  const tkhd = Buffer.alloc(84); tkhd.writeUInt32BE(w * 65536, 76); tkhd.writeUInt32BE(h * 65536, 80);
  const stsd = box('stsd', Buffer.concat([Buffer.alloc(8), box('avc1', Buffer.alloc(16))]));
  return Buffer.concat([box('ftyp', Buffer.from('isomiso2avc1mp41')), box('moov', Buffer.concat([box('mvhd', mvhd), box('trak', Buffer.concat([box('tkhd', tkhd), box('mdia', stsd)]))])), box('mdat', crypto.randomBytes(500))]);
}

/* =========================== Schedule math =========================== */
describe('repeat schedule math', () => {
  const at = (iso) => Date.parse(iso);
  const iso = (t) => (t == null ? null : new Date(t).toISOString());
  it('every day at 09:00 in Lagos (UTC+1, no DST)', () => {
    const s = { freq: 'daily', days: [], time_of_day: '09:00', end_mode: 'never' };
    assert.equal(iso(R().nextRun(s, 'Africa/Lagos', at('2026-10-12T07:30:00Z'))), '2026-10-12T08:00:00.000Z', 'later today');
    assert.equal(iso(R().nextRun(s, 'Africa/Lagos', at('2026-10-12T08:00:00Z'))), '2026-10-13T08:00:00.000Z', 'exactly at the time: the next day');
    assert.equal(iso(R().nextRun(s, 'Africa/Lagos', at('2026-12-31T23:30:00Z'))), '2027-01-01T08:00:00.000Z', 'over the new year (00:30 in Lagos)');
    // 30 days in a row, always 08:00 UTC: Lagos has no daylight saving.
    const list = R().upcoming(s, 'Africa/Lagos', at('2026-10-12T09:00:00Z'), at('2026-11-11T09:00:00Z'), 40);
    assert.equal(list.length, 30);
    assert.ok(list.every((t) => new Date(t).getUTCHours() === 8 && new Date(t).getUTCMinutes() === 0));
  });
  it('weekdays skip the weekend; chosen days; every week', () => {
    const fri = at('2026-10-16T10:00:00Z'); // Friday 11:00 in Lagos
    assert.equal(iso(R().nextRun({ freq: 'weekdays', time_of_day: '09:00' }, 'Africa/Lagos', fri)), '2026-10-19T08:00:00.000Z', 'Monday');
    assert.equal(iso(R().nextRun({ freq: 'days', days: [3, 6], time_of_day: '18:30' }, 'Africa/Lagos', fri)), '2026-10-17T17:30:00.000Z', 'Saturday');
    assert.equal(iso(R().nextRun({ freq: 'weekly', days: [0], time_of_day: '07:15' }, 'Africa/Lagos', fri)), '2026-10-18T06:15:00.000Z', 'Sunday');
    assert.equal(iso(R().nextRun({ freq: 'weekly', days: [5], time_of_day: '09:00' }, 'Africa/Lagos', fri)), '2026-10-23T08:00:00.000Z', 'this Friday is past: next Friday');
  });
  it('time zones with daylight saving and half hours keep the wall-clock time', () => {
    const s = { freq: 'daily', time_of_day: '09:00' };
    // New York leaves daylight saving on Sunday 1 Nov 2026: 9:00 is 13:00 UTC before and 14:00 UTC after.
    assert.equal(iso(R().nextRun(s, 'America/New_York', at('2026-10-31T12:00:00Z'))), '2026-10-31T13:00:00.000Z');
    assert.equal(iso(R().nextRun(s, 'America/New_York', at('2026-10-31T14:00:00Z'))), '2026-11-01T14:00:00.000Z');
    assert.equal(iso(R().nextRun(s, 'Asia/Kolkata', at('2026-10-12T00:00:00Z'))), '2026-10-12T03:30:00.000Z');
    assert.equal(iso(R().nextRun(s, 'Not/AZone', at('2026-10-12T00:00:00Z'))), '2026-10-12T09:00:00.000Z', 'an unknown zone counts as UTC');
  });
  it('end conditions: on a date (inclusive) and after N sends', () => {
    const s = { freq: 'daily', time_of_day: '09:00', end_mode: 'date', end_date: '2026-10-14' };
    assert.equal(iso(R().nextRun(s, 'Africa/Lagos', at('2026-10-13T09:00:00Z'))), '2026-10-14T08:00:00.000Z', 'the end date itself still sends');
    assert.equal(R().nextRun(s, 'Africa/Lagos', at('2026-10-14T09:00:00Z')), null, 'after the end date: nothing');
    const c = { freq: 'daily', time_of_day: '09:00', end_mode: 'count', end_count: 5, runs: 3 };
    assert.equal(R().upcoming(c, 'Africa/Lagos', at('2026-10-12T00:00:00Z'), at('2027-01-01T00:00:00Z')).length, 2, '2 sends left');
    assert.equal(R().describe({ freq: 'days', days: [5, 1, 3], time_of_day: '18:30', end_mode: 'count', end_count: 4 }), 'Mon, Wed, Fri at 6:30 PM, 4 times');
  });
  it('rotation: in order wraps around; random uses every version once per round and never twice in a row', () => {
    let r = { next: 0, used: [] };
    const order = [];
    for (let i = 0; i < 7; i++) { order.push(r.next); r = R().rotate('order', 3, r.next, r.used); }
    assert.deepEqual(order, [0, 1, 2, 0, 1, 2, 0]);
    for (let trial = 0; trial < 20; trial++) {
      const n = 5;
      let cur = R().firstVersion('random', n);
      let used = [];
      const seen = [];
      for (let i = 0; i < n * 3; i++) {
        seen.push(cur);
        const x = R().rotate('random', n, cur, used);
        assert.notEqual(x.next, cur, 'never the same version twice in a row');
        cur = x.next; used = x.used;
      }
      for (let round = 0; round < 3; round++) assert.equal(new Set(seen.slice(round * n, round * n + n)).size, n, 'each round uses all versions once');
    }
  });
});

/* =========================== Repeating messages =========================== */
describe('repeating messages', () => {
  it('a daily repeat makes one normal broadcast per run, with reports, and never twice for the same day', async () => {
    const s = await setup('starter', 3);
    const r = await s.c.post('/api/repeats', series(s, { title: 'Morning tip', buttons: [] , versions: [{ body: 'Tip of the day', buttons: [{ label: 'Read', url: 'https://example.com/tip' }] }] }));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.status, 'active');
    assert.match(r.body.next_label, /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) 9:00 AM$/);
    await runDue(r.body.id);
    const runs = await runsOf(r.body.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'sent');
    assert.equal(runs[0].sent, 3);
    assert.equal(runs[0].buttons.length, 1, 'tracked buttons per run');
    assert.match(runs[0].title, /^Morning tip · \d{4}-\d{2}-\d{2}$/);
    assert.equal(sendsTo(s.bot.token).length, 3);
    const rep = await s.c.get('/api/broadcasts/' + runs[0].id);
    assert.equal(rep.body.series.id, r.body.id);
    // The same run time again (a restarted worker): no second broadcast for that day.
    await app.db.query('update repeat_series set next_run_at = $2 where id = $1', [r.body.id, runs[0].send_at]);
    await app.jobs.broadcastsTick(); await app.flush();
    assert.equal((await runsOf(r.body.id)).length, 1);
    assert.equal(sendsTo(s.bot.token).length, 3, 'nobody got it twice');
    // Two servers at the same moment: one run only.
    await freeToday(r.body.id);
    await app.db.query("update repeat_series set next_run_at = now() - interval '1 minute' where id = $1", [r.body.id]);
    const f = await app.settings.features();
    await Promise.all([R().runOne(r.body.id, f), R().runOne(r.body.id, f), R().runOne(r.body.id, f)]);
    assert.equal((await runsOf(r.body.id)).length, 2);
    const row = await app.db.one('select * from repeat_series where id = $1', [r.body.id]);
    assert.equal(row.runs, 2);
    assert.ok(new Date(row.next_run_at) > new Date(), 'next run is in the future');
    const v = await s.c.get('/api/repeats/' + r.body.id);
    assert.equal(v.body.series.history.length, 2);
    assert.equal(v.body.series.schedule, 'Every day at 9:00 AM');
  });

  it('ends after N sends and on a date', async () => {
    const s = await setup('starter', 1);
    const r = await s.c.post('/api/repeats', series(s, { end_mode: 'count', end_count: 2 }));
    assert.equal(r.status, 200, r.text);
    await runDue(r.body.id);
    await freeToday(r.body.id);
    await runDue(r.body.id);
    const row = await app.db.one('select * from repeat_series where id = $1', [r.body.id]);
    assert.equal(row.status, 'ended');
    assert.equal(row.next_run_at, null);
    assert.equal((await runsOf(r.body.id)).length, 2);
    const past = await s.c.post('/api/repeats', series(s, { end_mode: 'date', end_date: '2020-01-01' }));
    assert.equal(past.status, 400);
    assert.match(past.body.error, /already passed/);
    const today = R().todayIn('Africa/Lagos');
    const d = await s.c.post('/api/repeats', series(s, { end_mode: 'date', end_date: today, time_of_day: '00:00' }));
    assert.equal(d.status, 400, 'today at 00:00 has passed and the series ends today');
    assert.match(d.body.error, /no time left/);
  });

  it('pausing, a paused plan or a long outage never floods: missed runs are skipped, it carries on at the next time', async () => {
    const s = await setup('starter', 2);
    const r = await s.c.post('/api/repeats', series(s));
    const id = r.body.id;
    // Three days late (the server was down): nothing is sent late.
    await runDue(id, "interval '3 days'");
    assert.equal((await runsOf(id)).length, 0);
    let row = await app.db.one('select * from repeat_series where id = $1', [id]);
    assert.ok(new Date(row.next_run_at) > new Date());
    assert.match(row.last_error, /skipped/i);
    // Plan paused: skipped with the reason; active again: it sends.
    await setPlan(s.ws.id, 'starter', 'paused');
    await runDue(id);
    row = await app.db.one('select * from repeat_series where id = $1', [id]);
    assert.equal((await runsOf(id)).length, 0);
    assert.match(row.last_error, /paused/i);
    assert.equal(row.status, 'active');
    await setPlan(s.ws.id, 'starter');
    await runDue(id);
    assert.equal((await runsOf(id)).length, 1);
    // Pause, time passes, resume: the next upcoming time only.
    assert.equal((await s.c.post(`/api/repeats/${id}/pause`)).body.status, 'paused');
    assert.equal((await app.db.one('select next_run_at from repeat_series where id = $1', [id])).next_run_at, null);
    await app.jobs.broadcastsTick();
    const res = await s.c.post(`/api/repeats/${id}/resume`);
    assert.equal(res.status, 200, res.text);
    assert.match(res.body.next_label, /9:00 AM/);
    await app.jobs.broadcastsTick(); await app.flush();
    assert.equal((await runsOf(id)).length, 1, 'resuming sends nothing at once');
    // Stop: finished for good, a waiting run is cancelled.
    await freeToday(id);
    await app.db.query("update repeat_series set next_run_at = now() - interval '1 minute' where id = $1", [id]);
    await R().runOne(id, await app.settings.features()); // the run is made (scheduled), not sent yet
    assert.equal((await s.c.post(`/api/repeats/${id}/stop`)).body.status, 'stopped');
    const last = (await runsOf(id)).pop();
    assert.equal(last.status, 'cancelled');
    assert.equal((await s.c.post(`/api/repeats/${id}/resume`)).status, 400);
  });

  it('rotating versions go in order, or at random without repeats; the next one is shown', async () => {
    const s = await setup('growth', 1);
    const r = await s.c.post('/api/repeats', series(s, { versions: [{ body: 'Version A' }, { body: 'Version B' }, { body: 'Version C' }] }));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.series.next_version, 0);
    for (let i = 0; i < 4; i++) { await runDue(r.body.id); await freeToday(r.body.id); }
    assert.deepEqual((await runsOf(r.body.id)).map((b) => b.body), ['Version A', 'Version B', 'Version C', 'Version A']);
    assert.equal((await s.c.get('/api/repeats/' + r.body.id)).body.series.next_version, 1, 'B goes next');
    const rnd = await s.c.post('/api/repeats', series(s, { rotation: 'random', versions: ['1', '2', '3', '4'].map((x) => ({ body: 'Random ' + x })) }));
    for (let i = 0; i < 4; i++) { await runDue(rnd.body.id); await freeToday(rnd.body.id); }
    assert.equal(new Set((await runsOf(rnd.body.id)).map((b) => b.body)).size, 4, 'all 4 used once before any repeats');
    const many = await s.c.post('/api/repeats', series(s, { versions: Array.from({ length: 31 }, (_, i) => ({ body: 'v' + i })) }));
    assert.equal(many.status, 400);
    assert.match(many.body.error, /30 versions/);
    const bad = await s.c.post('/api/repeats', series(s, { versions: [{ body: 'ok' }, { body: '' }] }));
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /^Version 2:/);
  });

  it('plan limits: none on Free, 3 running on Starter (paused ones don\'t count), unlimited with fair use on Scale', async () => {
    const free = await setup('free', 0);
    const f = await free.c.post('/api/repeats', series(free));
    assert.equal(f.status, 402, f.text);
    const s = await setup('starter', 1);
    const ids = [];
    for (let i = 0; i < 3; i++) { const x = await s.c.post('/api/repeats', series(s)); assert.equal(x.status, 200, x.text); ids.push(x.body.id); }
    const four = await s.c.post('/api/repeats', series(s));
    assert.equal(four.status, 402);
    assert.equal(four.body.code || (four.body.error && four.body.error.code), 'limit_repeats');
    assert.match(four.body.error, /Starter plan runs 3 repeating messages/);
    assert.match(four.body.error, /Growth/);
    await s.c.post(`/api/repeats/${ids[0]}/pause`);
    assert.equal((await s.c.post('/api/repeats', series(s))).status, 200);
    assert.equal((await s.c.post(`/api/repeats/${ids[0]}/resume`)).status, 402, 'resuming would be a 4th');
    const list = await s.c.get('/api/repeats');
    assert.deepEqual(list.body.limit, { max: 3, fair_use: null, active: 3 });
    // A move to a smaller plan: only the oldest ones keep sending.
    await setPlan(s.ws.id, 'growth');
    for (let i = 0; i < 2; i++) assert.equal((await s.c.post('/api/repeats', series(s))).status, 200);
    await setPlan(s.ws.id, 'starter');
    const newest = (await app.db.one("select max(id) id from repeat_series where workspace_id = $1 and status = 'active'", [s.ws.id])).id;
    await runDue(newest);
    assert.equal((await runsOf(newest)).length, 0);
    assert.match((await app.db.one('select last_error from repeat_series where id = $1', [newest])).last_error, /runs 3 repeating messages/);
    const big = await setup('scale', 0);
    assert.deepEqual((await big.c.get('/api/repeats')).body.limit, { max: -1, fair_use: 100, active: 0 });
    const st = await big.c.get('/api/app/state');
    assert.equal(st.body.plan.limits.repeats, -1);
  });

  it('checks the form: days, time, the 48-hour delete limit, the preview of the next times, and the calendar', async () => {
    const s = await setup('starter', 1);
    assert.match((await s.c.post('/api/repeats', series(s, { freq: 'weekly', days: [] }))).body.error, /day of the week/);
    assert.match((await s.c.post('/api/repeats', series(s, { freq: 'days', days: [9] }))).body.error, /at least one day/);
    assert.match((await s.c.post('/api/repeats', series(s, { time_of_day: '25:00' }))).body.error, /time of day/);
    const d48 = await s.c.post('/api/repeats', series(s, { delete_after_hours: 48 }));
    assert.equal(d48.status, 400);
    assert.match(d48.body.error, /48 hours/);
    const p = await s.c.post('/api/repeats/preview', { freq: 'weekdays', time_of_day: '08:30' });
    assert.equal(p.status, 200, p.text);
    assert.equal(p.body.next.length, 5);
    assert.equal(p.body.schedule, 'Weekdays (Mon–Fri) at 8:30 AM');
    assert.equal(p.body.timezone, 'Africa/Lagos');
    assert.ok(p.body.next.every((x) => /8:30 AM/.test(x.label) && !/Sat|Sun/.test(x.label)));
    const r = await s.c.post('/api/repeats', series(s));
    const cal = (await s.c.get('/api/repeats')).body.calendar.filter((x) => x.series_id === r.body.id);
    assert.ok(cal.length >= 30 && cal.length <= 32, 'about 31 days of runs: ' + cal.length);
  });

  it('runs carry auto-delete and auto-pin, and a teammate\'s repeat waits for the owner', async () => {
    const s = await setup('growth', 1);
    const r = await s.c.post('/api/repeats', series(s, { delete_after_hours: 6, pin: true, pin_notify: true, unpin_after_hours: 2 }));
    assert.equal(r.status, 200, r.text);
    await runDue(r.body.id);
    const b = (await runsOf(r.body.id))[0];
    assert.deepEqual([b.delete_after_hours, b.pin, b.pin_notify, b.unpin_after_hours], [6, true, true, 2]);
    const auto = await app.db.many("select action, status from deliveries where broadcast_id = $1 and action <> 'send' order by action", [b.id]);
    assert.deepEqual(auto.map((x) => x.action + ':' + x.status), ['delete:queued', 'pin:sent', 'unpin:queued'], 'pinned at once; unpin and delete wait');
    // Approval: a workspace that needs the owner's approval.
    await app.db.query('update workspaces set require_approval = true where id = $1', [s.ws.id]);
    const mate = await app.loginByEmail(`rpt-mate-${seq}@example.com`);
    await app.db.query("insert into members(workspace_id, user_id, role) values ($1,$2,'sender')", [s.ws.id, mate.user.id]);
    const m = await mate.post('/api/repeats', series(s), { headers: { 'x-ws': String(s.ws.id) } });
    assert.equal(m.status, 200, m.text);
    assert.equal(m.body.status, 'pending_approval');
    assert.equal((await mate.post(`/api/repeats/${m.body.id}/approve`, {}, { headers: { 'x-ws': String(s.ws.id) } })).status, 403);
    const ok = await s.c.post(`/api/repeats/${m.body.id}/approve`);
    assert.equal(ok.body.status, 'active');
  });

  it('workspace isolation: nobody sees, changes or uses another workspace\'s repeats or files', async () => {
    const a = await setup('growth', 1);
    const b = await setup('growth', 1);
    const r = await a.c.post('/api/repeats', series(a));
    const up = await upload(a.c, FILES.jpg(), 'image/jpeg');
    for (const p of [`/api/repeats/${r.body.id}`]) assert.equal((await b.c.get(p)).status, 404);
    for (const act of ['pause', 'stop', 'edit', 'resume', 'approve']) assert.equal((await b.c.post(`/api/repeats/${r.body.id}/${act}`, series(b))).status, act === 'approve' ? 404 : 404, act);
    assert.equal((await b.c.get('/api/repeats')).body.series.length, 0);
    const steal = await b.c.post('/api/repeats', series(b, { versions: [{ body: 'x', media_id: up.body.media.id }] }));
    assert.equal(steal.status, 400);
    const other = await b.c.post('/api/repeats', { ...series(b), connection_id: a.bot.connId });
    assert.equal(other.status, 400, 'another workspace\'s bot');
    assert.equal((await app.db.one('select status from repeat_series where id = $1', [r.body.id])).status, 'active');
  });

  it('editing changes the schedule and versions from now on', async () => {
    const s = await setup('starter', 1);
    const r = await s.c.post('/api/repeats', series(s, { versions: [{ body: 'Old' }] }));
    const e = await s.c.post(`/api/repeats/${r.body.id}/edit`, series(s, { freq: 'weekly', days: [1], time_of_day: '20:00', versions: [{ body: 'New A' }, { body: 'New B' }] }));
    assert.equal(e.status, 200, e.text);
    assert.match(e.body.series.next_label, /^Mon( \w+ \d+,)? 8:00 PM$/);
    assert.deepEqual(e.body.series.versions.map((v) => v.body), ['New A', 'New B']);
    await runDue(r.body.id);
    assert.equal((await runsOf(r.body.id))[0].body, 'New A');
  });
});

/* =========================== Voice notes and round videos =========================== */
describe('voice notes and round videos', () => {
  it('uploads: audio becomes an OGG voice note, a video becomes a round video (through ffmpeg), wrong files are refused', async () => {
    const s = await setup('starter', 0);
    fs.rmSync(FF_LOG, { force: true });
    const v = await upload(s.c, AUDIO.mp3(), 'audio/mpeg');
    assert.equal(v.status, 200, v.text);
    assert.equal(v.body.media.kind, 'voice');
    assert.equal(v.body.media.duration_sec, 7);
    const row = await app.db.one('select * from media where id = $1', [v.body.media.id]);
    assert.equal(row.mime, 'audio/ogg');
    assert.match(row.path, /\.ogg$/);
    assert.ok(fs.existsSync(row.path));
    assert.equal(fs.readdirSync(path.dirname(row.path)).filter((f) => /\.mp3$/.test(f)).length, 0, 'the original is removed');
    const rec = await upload(s.c, AUDIO.webm(), 'audio/webm;codecs=opus', 'voice');
    assert.equal(rec.status, 200, 'a browser recording: ' + rec.text);
    const round = await upload(s.c, FILES.mp4(), 'video/mp4', 'video_note');
    assert.equal(round.status, 200, round.text);
    assert.equal(round.body.media.kind, 'video_note');
    const args = ffCalls().filter((a) => a[0] !== '-version');
    assert.ok(args.some((a) => a.includes('libopus') && a.includes('48000') && a.includes('1')), 'voice: opus 48k mono');
    const rv = args.find((a) => a.includes('libx264'));
    assert.ok(rv && rv.includes('+faststart') && rv.includes('60') && rv.join(' ').includes("crop='min(iw,ih)'"), 'round: square, 60 s, faststart');
    // Wrong files.
    assert.equal((await upload(s.c, crypto.randomBytes(500), 'audio/mpeg')).status, 400, 'not really an MP3');
    assert.equal((await upload(s.c, FILES.png(), 'image/png', 'voice')).status, 400);
    assert.equal((await upload(s.c, AUDIO.mp3(), 'audio/mpeg', 'video_note')).status, 400);
    assert.equal((await upload(s.c, AUDIO.mp3(), 'audio/flac')).status, 400);
    assert.equal((await upload(s.c, AUDIO.mp3(), 'audio/mpeg', 'sticker')).status, 400);
    const big = await s.c.post('/api/media?as=voice', Buffer.alloc(10), { headers: { 'content-type': 'audio/mpeg', 'content-length': String(21 * 1024 * 1024) } }).catch(() => null);
    assert.ok(!big || big.status === 413 || big.status === 400);
    // ffmpeg fails on a broken file: a friendly 422, noted for support.
    process.env.FAKE_FFMPEG_FAIL = '1';
    const broken = await upload(s.c, AUDIO.mp3(), 'audio/mpeg');
    assert.equal(broken.status, 422);
    assert.match(broken.body.error, /couldn't turn that recording into a voice note/);
    assert.equal((await app.db.one('select count(*)::int n from media_conversions where workspace_id = $1 and not ok', [s.ws.id])).n, 1);
    // Storage: voice notes count toward the workspace's storage.
    const used = await app.db.one('select count(*)::int n from media where workspace_id = $1', [s.ws.id]);
    assert.equal(used.n, 3);
  });

  it('without ffmpeg: files already right are accepted, others get "conversion isn\'t set up"', async () => {
    const s = await setup('starter', 0);
    const conv = app.require('services/media-convert');
    const before = app.config.ffmpegPath;
    app.config.ffmpegPath = path.join(os.tmpdir(), 'no-such-ffmpeg-' + process.pid);
    try {
      assert.equal((await conv.detect({ force: true })).ok, false);
      const ogg = await upload(s.c, AUDIO.ogg(), 'audio/ogg');
      assert.equal(ogg.status, 200, ogg.text);
      const mp3 = await upload(s.c, AUDIO.mp3(), 'audio/mpeg');
      assert.equal(mp3.status, 422);
      assert.equal(mp3.body.code || mp3.body.error.code, 'conversion_unavailable');
      assert.match(mp3.body.error, /Voice\/round video conversion isn't set up on this server yet/);
      const square = await upload(s.c, mp4(480, 480, 20), 'video/mp4', 'video_note');
      assert.equal(square.status, 200, square.text);
      assert.equal(square.body.media.duration_sec, 20);
      assert.equal((await upload(s.c, mp4(1280, 720), 'video/mp4', 'video_note')).status, 422, 'not square');
      assert.equal((await upload(s.c, mp4(480, 480, 90), 'video/mp4', 'video_note')).status, 422, 'over 60 seconds');
      // Admin → System shows it.
      const owner = await app.owner();
      const sys = await owner.get('/api/admin/system');
      assert.equal(sys.body.media_tools.ffmpeg, false);
      assert.match(sys.body.media_tools.note, /isn't set up/);
    } finally {
      app.config.ffmpegPath = before;
      await conv.detect({ force: true });
    }
    const owner = await app.owner();
    assert.equal((await owner.get('/api/admin/system')).body.media_tools.ffmpeg, true);
  });

  it('a voice note broadcast: sendVoice with the caption and buttons; uploaded once per bot, then its file_id', async () => {
    const s = await setup('starter', 2);
    const v = await upload(s.c, AUDIO.mp3(), 'audio/mpeg');
    const r = await s.c.post('/api/broadcasts', { connection_id: s.bot.connId, body: 'Listen *now*', media_id: v.body.media.id, buttons: [{ label: 'Join', url: 'https://example.com' }] });
    assert.equal(r.status, 200, r.text);
    await app.flush();
    const calls = callsTo(s.bot.token, 'sendVoice');
    assert.equal(calls.length, 2);
    assert.equal(calls.filter((c) => c.params.voice && c.params.voice.file).length, 1, 'uploaded once');
    assert.equal(calls.filter((c) => typeof c.params.voice === 'string').length, 1, 'then the file_id');
    assert.equal(calls[0].params.caption, 'Listen <b>now</b>');
    assert.equal(calls[0].params.reply_markup.inline_keyboard[0][0].text, 'Join');
    assert.equal(Number(calls[0].params.duration), 7);
    // A voice note with no text is fine; a photo with no text is not.
    assert.equal((await s.c.post('/api/broadcasts', { connection_id: s.bot.connId, body: '', media_id: v.body.media.id })).status, 200);
    const ph = await upload(s.c, FILES.jpg(), 'image/jpeg');
    assert.equal((await s.c.post('/api/broadcasts', { connection_id: s.bot.connId, body: '', media_id: ph.body.media.id })).status, 400);
    const long = await s.c.post('/api/broadcasts', { connection_id: s.bot.connId, body: 'x'.repeat(1100), media_id: v.body.media.id });
    assert.equal(long.status, 400);
    assert.match(long.body.error, /voice note, Telegram allows 1,024/);
  });

  it('a round video with text: the round video first (no caption), then the text with the buttons; edit and delete reach both', async () => {
    const s = await setup('starter', 2);
    const m = await upload(s.c, FILES.mp4(), 'video/mp4', 'video_note');
    const text = 'y'.repeat(2000); // a round video's text is its own message: up to 4,096
    const r = await s.c.post('/api/broadcasts', { connection_id: s.bot.connId, body: text, media_id: m.body.media.id, buttons: [{ label: 'Shop', url: 'https://example.com/shop' }] });
    assert.equal(r.status, 200, r.text);
    await app.flush();
    const sends = sendsTo(s.bot.token);
    for (const id of s.ids) {
      const mine = sends.filter((c) => Number(c.params.chat_id) === id);
      assert.deepEqual(mine.map((c) => c.method), ['sendVideoNote', 'sendMessage']);
      assert.equal(mine[0].params.reply_markup, undefined, 'buttons go with the text');
      assert.equal(mine[0].params.caption, undefined);
      assert.equal(mine[1].params.text, text);
      assert.equal(mine[1].params.reply_markup.inline_keyboard[0][0].text, 'Shop');
    }
    const d = await app.db.many("select message_id, message_id2 from deliveries where broadcast_id = $1 and action = 'send'", [r.body.id]);
    assert.ok(d.every((x) => x.message_id && x.message_id2 && x.message_id2 !== x.message_id));
    const e = await s.c.post(`/api/broadcasts/${r.body.id}/edit`, { body: 'Fixed text' });
    assert.equal(e.status, 200, e.text);
    await app.drain();
    const edits = callsTo(s.bot.token, 'editMessageText');
    assert.equal(edits.length, 2);
    assert.ok(edits.every((c) => d.some((x) => Number(x.message_id2) === Number(c.params.message_id))), 'the text message is edited');
    await s.c.post(`/api/broadcasts/${r.body.id}/delete`);
    await app.drain();
    assert.equal(callsTo(s.bot.token, 'deleteMessage').length, 4, 'round video and text, for each person');
    // Without text: one message, the buttons (here the stop button) under the round video.
    const solo = await s.c.post('/api/broadcasts', { connection_id: s.bot.connId, body: '', media_id: m.body.media.id });
    assert.equal(solo.status, 200, solo.text);
    await app.flush();
    const last = sendsTo(s.bot.token).filter((c) => Number(c.params.chat_id) === s.ids[0]).slice(-1)[0];
    assert.equal(last.method, 'sendVideoNote');
    assert.equal(last.params.reply_markup.inline_keyboard[0][0].callback_data, 'cv_stop');
    assert.equal((await s.c.get('/api/broadcasts/' + solo.body.id)).body.broadcast.title, '⭕ Round video');
  });

  it('voice notes and round videos work in Chat bot steps and repeating messages too', async () => {
    const s = await setup('growth', 0);
    const m = await upload(s.c, FILES.mp4(), 'video/mp4', 'video_note');
    const v = await upload(s.c, AUDIO.mp3(), 'audio/mpeg');
    const f = await s.c.post('/api/flows', { start_type: 'bot_start', name: 'Round bot', bot_id: s.bot.connId, start_code: 'round', active: true, steps: [{ body: 'Watch this 👆', media_id: m.body.media.id }, { body: '', media_id: v.body.media.id }] });
    assert.equal(f.status, 200, f.text);
    const u = 990001;
    await app.start(s.bot.connId, u, 'round');
    for (let i = 0; i < 3; i++) { await app.jobs.dripsTick(); await app.drain(); }
    const mine = sendsTo(s.bot.token).filter((c) => Number(c.params.chat_id) === u).map((c) => c.method);
    assert.deepEqual(mine.slice(0, 3), ['sendVideoNote', 'sendMessage', 'sendVoice']);
    const r = await s.c.post('/api/repeats', series(s, { versions: [{ body: '', media_id: v.body.media.id }, { body: 'Round!', media_id: m.body.media.id }] }));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.series.versions[0].media.kind, 'voice');
    // Files used by a repeating message are not cleared as unused.
    await app.db.query("update media set created_at = now() - interval '10 days' where workspace_id = $1", [s.ws.id]);
    await app.require('services/media-files').removeUnused(3);
    assert.equal((await app.db.one('select count(*)::int n from media where workspace_id = $1', [s.ws.id])).n, 2);
  });
});

/* =========================== Auto-delete and auto-pin =========================== */
describe('auto-delete and auto-pin', () => {
  it('"Delete after 2 hours": each message is deleted 2 hours after it was sent; the report counts them', async () => {
    const s = await setup('starter', 2);
    const r = await s.c.post('/api/broadcasts', { connection_id: s.bot.connId, body: 'Flash sale', delete_after_hours: 2 });
    assert.equal(r.status, 200, r.text);
    await app.flush();
    const q = await app.db.many("select *, extract(epoch from due_at - now())::int secs from deliveries where broadcast_id = $1 and action = 'delete'", [r.body.id]);
    assert.equal(q.length, 2);
    assert.ok(q.every((x) => x.secs > 7000 && x.secs <= 7200 && x.extra.auto), 'due in 2 hours');
    // A retried send never queues a second delete for the same message.
    const one = q[0];
    await app.db.query(`insert into deliveries(workspace_id, sender_key, action, broadcast_id, subscriber_id, chat_id, message_id, due_at, extra) values ($1,$2,'delete',$3,$4,$5,$6, now(), '{"auto":1}') on conflict do nothing`, [one.workspace_id, one.sender_key, one.broadcast_id, one.subscriber_id, one.chat_id, one.message_id]);
    assert.equal((await app.db.one("select count(*)::int n from deliveries where broadcast_id = $1 and action = 'delete'", [r.body.id])).n, 2);
    await app.db.query("update deliveries set due_at = now() where broadcast_id = $1 and action = 'delete'", [r.body.id]);
    await app.drain();
    assert.equal(callsTo(s.bot.token, 'deleteMessage').length, 2);
    const rep = await s.c.get('/api/broadcasts/' + r.body.id);
    assert.equal(rep.body.auto.deleted, 2);
    assert.equal(rep.body.broadcast.delete_after_hours, 2);
    assert.equal((await s.c.post('/api/broadcasts', { connection_id: s.bot.connId, body: 'x', delete_after_hours: 48 })).status, 400);
    assert.equal((await s.c.post('/api/broadcasts', { connection_id: s.bot.connId, body: 'x', delete_after_hours: 1.5 })).status, 400);
  });

  it('48-hour guard: an auto-delete that waited past Telegram\'s limit is skipped, and Telegram refusing is reported', async () => {
    const s = await setup('starter', 2);
    const r = await s.c.post('/api/broadcasts', { connection_id: s.bot.connId, body: 'Old news', delete_after_hours: 1 });
    await app.flush();
    const [a, b] = await app.db.many("select id from deliveries where broadcast_id = $1 and action = 'delete' order by id", [r.body.id]);
    await app.db.query("update deliveries set created_at = now() - interval '49 hours', due_at = now() where id = $1", [a.id]);
    await app.db.query('update deliveries set due_at = now() where id = $1', [b.id]);
    app.fakes.tg.deleteError = "Bad Request: message can't be deleted";
    await app.drain();
    const rows = await app.db.many('select id, status, error from deliveries where id = any($1::bigint[]) order by id', [[a.id, b.id]]);
    assert.equal(rows[0].status, 'skipped');
    assert.match(rows[0].error, /48 hours/);
    assert.equal(rows[1].status, 'failed');
    assert.match(rows[1].error, /did not let the bot delete it/);
    assert.equal(callsTo(s.bot.token, 'deleteMessage').length, 1, 'the too-old one was never tried');
  });

  it('pin it in their chat (with a notification) and unpin after 3 hours', async () => {
    const s = await setup('starter', 2);
    const r = await s.c.post('/api/broadcasts', { connection_id: s.bot.connId, body: 'Read me first', pin: true, pin_notify: true, unpin_after_hours: 3 });
    assert.equal(r.status, 200, r.text);
    await app.flush();
    const pins = callsTo(s.bot.token, 'pinChatMessage');
    assert.equal(pins.length, 2);
    assert.ok(pins.every((p) => p.params.disable_notification === false));
    const un = await app.db.many("select extract(epoch from due_at - now())::int secs from deliveries where broadcast_id = $1 and action = 'unpin'", [r.body.id]);
    assert.ok(un.length === 2 && un.every((x) => x.secs > 10700 && x.secs <= 10800));
    await app.db.query("update deliveries set due_at = now() where broadcast_id = $1 and action = 'unpin'", [r.body.id]);
    await app.drain();
    assert.equal(callsTo(s.bot.token, 'unpinChatMessage').length, 2);
    const rep = (await s.c.get('/api/broadcasts/' + r.body.id)).body.auto;
    assert.deepEqual([rep.pinned, rep.unpinned], [2, 2]);
    // Silent pin by default; a pin Telegram refuses doesn't undo the send.
    app.fakes.tg.pinError = 'Bad Request: not enough rights to manage pinned messages in the chat';
    const q = await s.c.post('/api/broadcasts', { connection_id: s.bot.connId, body: 'Quiet pin', pin: true });
    await app.flush();
    const b = (await s.c.get('/api/broadcasts/' + q.body.id)).body;
    assert.equal(b.broadcast.sent, 2);
    assert.equal(b.auto.auto_failed, 2);
    const failed = await app.db.one("select error from deliveries where broadcast_id = $1 and action = 'pin' limit 1", [q.body.id]);
    assert.match(failed.error, /right to pin/);
  });

  it('pin in a channel: checked when saving, with the fix; with the right it pins the channel post', async () => {
    const s = await setup('starter', 0);
    const chat = -100555000 - seq;
    const ch = await app.db.one("insert into connections(workspace_id, kind, tg_chat_id, title, member_count) values ($1,'channel',$2,'Deals',300) returning id", [s.ws.id, chat]);
    app.fakes.tg.chatMember = { status: 'administrator', can_post_messages: true, can_edit_messages: false };
    const no = await s.c.post('/api/broadcasts', { connection_id: ch.id, body: 'Pinned deal', pin: true });
    assert.equal(no.status, 400);
    assert.equal(no.body.code || no.body.error.code, 'pin_rights');
    assert.match(no.body.error, /can't pin in "Deals" yet.*Edit messages of others/);
    // Without pinning, the same post is fine.
    assert.equal((await s.c.post('/api/broadcasts', { connection_id: ch.id, body: 'Plain deal' })).status, 200);
    app.fakes.tg.chatMember = { status: 'administrator', can_post_messages: true, can_edit_messages: true };
    const ok = await s.c.post('/api/broadcasts', { connection_id: ch.id, body: 'Pinned deal', pin: true });
    assert.equal(ok.status, 200, ok.text);
    await app.flush();
    const pin = callsTo(app.platformBotToken, 'pinChatMessage').find((c) => c.params.chat_id === chat);
    assert.ok(pin, 'pinned in the channel by @CastvooBot');
    assert.equal(pin.params.disable_notification, true);
    // Groups need "Pin messages".
    const g = await app.db.one("insert into connections(workspace_id, kind, tg_chat_id, title) values ($1,'group',$2,'Club') returning id", [s.ws.id, chat - 1]);
    app.fakes.tg.chatMember = { status: 'administrator', can_pin_messages: false };
    assert.match((await s.c.post('/api/broadcasts', { connection_id: g.id, body: 'x', pin: true })).body.error, /Pin messages/);
  });
});

/* =========================== Support AI, Cas and links =========================== */
describe('support and Cas know about repeats', () => {
  it('get_repeats shows status, next send, next version and skips; links to a message report and the repeat page work only for the workspace', async () => {
    const s = await setup('growth', 1);
    const r = await s.c.post('/api/repeats', series(s, { title: 'Daily deal', versions: [{ body: 'A' }, { body: 'B' }] }));
    await runDue(r.body.id);
    process.env.FAKE_FFMPEG_FAIL = '1';
    await upload(s.c, AUDIO.mp3(), 'audio/mpeg');
    const tools = app.require('services/support-tools');
    const scope = { userId: s.c.user.id, workspaceId: s.ws.id, threadId: null, log: false, role: 'owner' };
    const out = (await tools.run('get_repeats', {}, { ...scope, allowed: tools.CAS_TOOLS })).output;
    const one = out.repeating_messages[0];
    assert.equal(one.name, 'Daily deal');
    assert.equal(one.status, 'active');
    assert.match(one.next_send, /9:00 AM/);
    assert.match(one.next_version, /version 2 of 2/);
    assert.equal(one.sent_times, 1);
    assert.equal(out.plan_limit.most_at_once, 20);
    assert.equal(out.failed_voice_or_round_video_conversions_14d.length, 1);
    const links = app.require('services/support-links');
    const bid = one.last_runs[0].broadcast_id;
    const card = await links.resolve('message:' + bid, { workspaceId: s.ws.id });
    assert.equal(card.ok, true);
    assert.equal(card.card.href, '#app/broadcast?id=' + bid);
    assert.equal((await links.resolve('message:' + bid, { workspaceId: s.ws.id + 999 })).ok, false, 'another workspace');
    assert.equal(links.keyFromUrl('#app/broadcast?id=' + bid), 'message:' + bid);
    assert.equal(links.keyFromUrl('#app/broadcast?repeat=1'), 'repeats');
    const rp = await links.resolve('repeats', {});
    assert.equal(rp.card.href, '#app/broadcast?repeat=1');
    assert.ok(links.safeCard(card.card) && links.safeCard(rp.card));
    // The live plan list tells the AI the limits.
    const plans = app.require('services/ai').formatPlans((await app.settings.plans({ activeOnly: true })), {});
    assert.match(plans, /Repeating messages running at a time.*Starter 3; Growth 20; Scale unlimited \(fair use 100\)/);
    const kb = require('../../server/knowledge-defaults');
    for (const k of ['repeating-messages', 'voice-round-video', 'auto-delete-pin']) assert.ok(kb.some((x) => x.key === k), k);
  });
});

/* =========================== Follow-up fixes =========================== */
describe('follow-up fixes', () => {
  it('round video + text: when only the text fails, the retry sends the text alone (never the round video again)', async () => {
    const s = await setup('starter', 1);
    const m = await upload(s.c, FILES.mp4(), 'video/mp4', 'video_note');
    app.fakes.tg.failMethod = { method: 'sendMessage', n: 1 };
    const r = await s.c.post('/api/broadcasts', { connection_id: s.bot.connId, body: 'Read this after the video', media_id: m.body.media.id });
    assert.equal(r.status, 200, r.text);
    await app.drain();
    let d = await app.db.one("select * from deliveries where broadcast_id = $1 and action = 'send'", [r.body.id]);
    assert.equal(d.status, 'queued', 'retried later');
    assert.ok(d.message_id, 'the round video is remembered as sent');
    await app.db.query('update deliveries set due_at = now() where id = $1', [d.id]);
    await app.flush();
    app.fakes.tg.failMethod = null;
    const mine = sendsTo(s.bot.token).filter((c) => Number(c.params.chat_id) === s.ids[0]).map((c) => c.method);
    assert.deepEqual(mine, ['sendVideoNote', 'sendMessage', 'sendMessage'], 'one round video, the text twice (1 failed)');
    d = await app.db.one('select * from deliveries where id = $1', [d.id]);
    assert.equal(d.status, 'sent');
    assert.ok(d.message_id2 && Number(d.message_id2) !== Number(d.message_id));
  });

  it('media previews answer byte ranges (206, Content-Range, HEAD) so iPhone Safari plays them', async () => {
    const s = await setup('starter', 0);
    const m = (await upload(s.c, AUDIO.mp3(), 'audio/mpeg')).body.media;
    const full = await s.c.get('/api/media/' + m.id);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    const size = Number(full.headers.get('content-length'));
    const part = await s.c.get('/api/media/' + m.id, { headers: { range: 'bytes=0-9' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 0-9/${size}`);
    assert.equal(part.headers.get('content-length'), '10');
    assert.equal(Buffer.byteLength(part.text, 'latin1') > 0, true);
    const tail = await s.c.get('/api/media/' + m.id, { headers: { range: 'bytes=-5' } });
    assert.equal(tail.headers.get('content-range'), `bytes ${size - 5}-${size - 1}/${size}`);
    const open = await s.c.get('/api/media/' + m.id, { headers: { range: `bytes=${size - 3}-` } });
    assert.equal(open.status, 206);
    const bad = await s.c.get('/api/media/' + m.id, { headers: { range: `bytes=${size + 10}-` } });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get('content-range'), `bytes */${size}`);
    const head = await s.c.request('HEAD', '/api/media/' + m.id);
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('accept-ranges'), 'bytes');
    assert.equal(head.headers.get('content-length'), String(size));
    assert.equal(head.text, '');
    const other = await setup('starter', 0);
    assert.equal((await other.c.get('/api/media/' + m.id, { headers: { range: 'bytes=0-9' } })).status, 404, 'another workspace');
  });

  it('calendar runs carry their date and time on the workspace clock', async () => {
    const s = await setup('starter', 0, 'Asia/Kolkata');
    await s.c.post('/api/repeats', series(s, { time_of_day: '03:30' }));
    const cal = (await s.c.get('/api/repeats')).body;
    assert.equal(cal.timezone, 'Asia/Kolkata');
    for (const x of cal.calendar) {
      assert.equal(x.time, '03:30');
      const w = app.require('services/broadcasts').wallClock('Asia/Kolkata', Date.parse(x.at));
      assert.equal(x.date, `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`);
      assert.notEqual(x.date, new Date(x.at).toISOString().slice(0, 10), '03:30 in Kolkata is the day before in UTC');
    }
  });

  it('moving the time to later today after today\'s message went out says it starts tomorrow (not a silent skip)', async () => {
    const s = await setup('starter', 1);
    const r = await s.c.post('/api/repeats', series(s));
    await runDue(r.body.id); // today's message (run date = today in Lagos)
    const w = app.require('services/broadcasts').wallClock('Africa/Lagos', Date.now());
    if (w.h >= 23) return; // too close to midnight in Lagos for "later today"
    const later = '23:' + String(Math.min(59, w.min + 1)).padStart(2, '0');
    const e = await s.c.post(`/api/repeats/${r.body.id}/edit`, series(s, { time_of_day: later }));
    assert.equal(e.status, 200, e.text);
    assert.equal(e.body.note, 'Today\'s message was already sent; the new time starts tomorrow.');
    const next = app.require('services/broadcasts').wallClock('Africa/Lagos', new Date(e.body.series.next_run_at).getTime());
    const tomorrow = app.require('services/broadcasts').wallClock('Africa/Lagos', Date.now() + 86400000);
    assert.deepEqual([next.d, next.h], [tomorrow.d, 23]);
    // A series that has not sent today keeps today's later time, with no note.
    const fresh = await s.c.post('/api/repeats', series(s, { time_of_day: later }));
    const e2 = await s.c.post(`/api/repeats/${fresh.body.id}/edit`, series(s, { time_of_day: later }));
    assert.equal(e2.body.note, null);
    assert.equal(app.require('services/broadcasts').wallClock('Africa/Lagos', new Date(e2.body.series.next_run_at).getTime()).d, w.d);
  });
});

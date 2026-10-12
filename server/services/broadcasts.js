'use strict';
/*
 * Broadcasts: checking a message, turning it into queued deliveries, and the
 * follow-up actions (edit, pin, delete) that also go through the rate-limited queue.
 */

const db = require('../db');
const tg = require('./telegram');
const seg = require('./segments');
const { senderKey } = require('./connections');
const config = require('../config');
const { badRequest, httpError, url: vUrl, str, randomCode } = require('../lib/util');

/** Media kinds whose message may be sent without text (a voice note or round video says it all). */
const TEXT_OPTIONAL = ['voice', 'video_note'];
/** The most characters a message may have with this media kind (a round video's text goes in its own message). */
const textLimit = (kind) => (!kind || kind === 'video_note' ? tg.LIMITS.text : tg.LIMITS.caption);

/** Validate text + media + buttons. Returns clean values (media_kind too). */
async function checkMessage(wsId, { body, media_id, buttons }) {
  let media = null;
  if (media_id) {
    media = await db.one('select id, kind from media where id = $1 and workspace_id = $2', [Number(media_id), wsId]);
    if (!media) throw badRequest('That photo or video was not found. Upload it again.');
  }
  const optional = !!media && TEXT_OPTIONAL.includes(media.kind);
  // max here is a rough guard in JS string units (an emoji is 2). The real Telegram limit is checked
  // just below with visibleLength(), so 4,096 emoji (8,192 units) must still pass this line.
  const text = (optional && (body == null || body === '') ? '' : str(body, 'Message', { min: 1, max: 20000, trim: false })).replace(/\r\n/g, '\n');
  if (!text.trim() && !optional) throw badRequest('Write a message first.');
  const len = tg.visibleLength(text);
  if (media && media.kind === 'voice' && len > tg.LIMITS.caption) throw badRequest(`With a voice note, Telegram allows 1,024 characters. This message has ${len.toLocaleString('en-US')}. Shorten it or remove the voice note.`);
  if (media && !optional && len > tg.LIMITS.caption) throw badRequest(`With a photo or video, Telegram allows 1,024 characters. This message has ${len.toLocaleString('en-US')}. Shorten it or remove the file.`);
  if (len > tg.LIMITS.text) throw badRequest(`Telegram allows 4,096 characters per message. This one has ${len.toLocaleString('en-US')}.`);
  const btns = [];
  for (const b of (Array.isArray(buttons) ? buttons : []).slice(0, 6)) {
    if (!b || (!b.label && !b.url)) continue;
    const label = str(b.label, 'Button text', { min: 1, max: 40 });
    btns.push({ label, url: vUrl(b.url, `Link for "${label}"`) });
  }
  if (Array.isArray(buttons) && buttons.length > 6) throw badRequest('Use 6 buttons or fewer.');
  return { body: text.trim() ? text : '', media_id: media ? media.id : null, media_kind: media ? media.kind : null, buttons: btns };
}

/** A short title from the text (or what the message is when it has none). */
function titleFrom(body, mediaKind) {
  const line = String(body || '').replace(/[*_]/g, '').split('\n').find((l) => l.trim());
  if (line) return line.trim().slice(0, 60);
  return mediaKind === 'voice' ? '🎙️ Voice note' : mediaKind === 'video_note' ? '⭕ Round video' : 'Message';
}

/*
 * Auto-delete and auto-pin (Oct 2026). Telegram lets bots delete their messages for 48 hours (private chats; in a
 * channel the bot needs its posting / delete rights), so "Delete this message after…" is 1 to 47 hours. Pinning works in
 * each person's bot chat and in a channel or group where the bot may pin (channels: "Edit messages of others";
 * groups: "Pin messages"). The sender queues the delete / pin / unpin of every message right after it is sent
 * (workers/sender.js followUps), so the times count from each person's own message.
 */
const DELETE_MAX_HOURS = 47;
const UNPIN_MAX_HOURS = 30 * 24;
const hoursOf = (v, name, max) => {
  if (v === undefined || v === null || v === '' || v === false || v === 0 || v === '0') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw badRequest(`${name}: pick a whole number of hours.`);
  if (n > max) throw badRequest(max === DELETE_MAX_HOURS ? 'Telegram lets bots delete messages for up to 48 hours, so pick 47 hours or less.' : 'Unpin after: pick 30 days or less.');
  return n;
};

/** Can the bot pin in this channel or group? Throws a friendly 400 (code pin_rights) with the fix. Bots' own chats: yes. */
async function checkPinRights(conn) {
  if (conn.kind === 'bot') return true;
  const token = config.telegram.botToken;
  const botId = Number(String(token || '').split(':')[0]) || 0;
  const where = conn.kind === 'channel' ? 'channel' : 'group';
  const right = conn.kind === 'channel' ? 'Edit messages of others' : 'Pin messages';
  let m;
  try { m = await tg.platform('getChatMember', { chat_id: conn.tg_chat_id, user_id: botId }); } catch (e) {
    if (e.code === 400 || e.code === 403) m = null; else return true; // Telegram is slow or down: let it save, the pin reports itself
  }
  const ok = m && (m.status === 'creator' || (m.status === 'administrator' && (conn.kind === 'channel' ? m.can_edit_messages : m.can_pin_messages)));
  if (!ok) {
    const name = conn.title ? `"${conn.title}"` : `your ${where}`;
    throw httpError(400, `@${config.telegram.botUsername || 'CastvooBot'} can't pin in ${name} yet. In Telegram, open the ${where} → Administrators → @${config.telegram.botUsername || 'CastvooBot'} and turn on "${right}", then try again.`, 'pin_rights');
  }
  return true;
}

/** "Delete after", "Pin it", "Notify members", "Unpin after" from a form → clean values (checks pin rights). */
async function checkExtras(conn, b) {
  const del = hoursOf(b.delete_after_hours, 'Delete after', DELETE_MAX_HOURS);
  const pin = !!b.pin;
  let unpin = pin ? hoursOf(b.unpin_after_hours, 'Unpin after', UNPIN_MAX_HOURS) : null;
  if (unpin && del && unpin >= del) unpin = null; // it is deleted before it would be unpinned
  if (pin) await checkPinRights(conn);
  return { delete_after_hours: del, pin, pin_notify: pin && !!b.pin_notify, unpin_after_hours: unpin };
}

/** Create tracked short links for the buttons. Returns buttons with codes. */
async function makeLinks(c, wsId, buttons, { broadcastId = null, stepId = null } = {}) {
  const out = [];
  for (const [pos, b] of buttons.entries()) {
    let code;
    for (let i = 0; i < 5; i++) {
      code = randomCode(7);
      const r = await c.query(`insert into links(code, workspace_id, broadcast_id, step_id, label, url, position, row, kind, button_id)
        values ($1,$2,$3,$4,$5,$6,$7,$8, $9, coalesce($10, $1)) on conflict do nothing`, [code, wsId, broadcastId, stepId, b.label, b.url || '', (b.position ?? pos), b.row ?? null, b.kind || 'link', b.button_id || null]);
      if (r.rowCount) break;
    }
    out.push({ ...b, code });
  }
  return out;
}

/** The wall-clock date and time in a zone at moment `t` (ms). */
// One formatter per zone (making an Intl.DateTimeFormat is slow; the repeating-messages calendar calls this thousands of times).
const WALL_FMT = new Map();
function wallFmt(zone) {
  let f = WALL_FMT.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (WALL_FMT.size > 500) WALL_FMT.clear();
    WALL_FMT.set(zone, f);
  }
  return f;
}
function wallClock(zone, t) {
  const parts = Object.fromEntries(wallFmt(zone).formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  return { y: +parts.year, m: +parts.month, d: +parts.day, h: +parts.hour, min: +parts.minute, s: +parts.second };
}
/** How many minutes a zone is ahead of UTC at moment `t` (ms). Uses whole seconds, so no rounding errors. */
function offsetMinutes(zone, t) {
  const w = wallClock(zone, t);
  return Math.round((Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - Math.floor(t / 1000) * 1000) / 60000);
}

/**
 * Next 9:00 in a time zone, as a Date (UTC).
 * (The old version rounded the zone offset from a time without seconds, so after hh:mm:30 it
 * gave 9:01. It also used today's offset for tomorrow, which is an hour off on DST-change days.)
 */
function next9(tz, now = new Date()) {
  let zone = tz;
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); } catch { zone = 'UTC'; }
  const t = now.getTime();
  const today = wallClock(zone, t);
  const at9 = (dayShift) => {
    const wall = Date.UTC(today.y, today.m - 1, today.d + dayShift, 9, 0); // 9:00 on that day, as if it were UTC
    let guess = wall - offsetMinutes(zone, wall) * 60000;
    guess = wall - offsetMinutes(zone, guess) * 60000; // second pass: use the offset that applies on that day
    return guess;
  };
  let target = at9(0);
  if (target <= t + 60000) target = at9(1);
  return new Date(target);
}

/** Statuses a broadcast can be queued from (the routes check which one applies before calling enqueue). */
const QUEUEABLE = ['scheduled', 'draft', 'pending_approval'];

/**
 * Turn a broadcast into deliveries. Bot: one per matching active subscriber.
 * Channel/group: one delivery to the chat. Returns the number queued.
 *
 * Safe to call twice at the same moment (e.g. "send now" while the broadcast job runs, or
 * two clicks on Approve): the first call claims the broadcast by switching it to 'sending'
 * inside the same transaction, so the second call finds nothing to claim and just returns
 * the total the first one queued. Before this, both calls queued everyone, and every
 * subscriber got the message twice.
 */
async function enqueue(b) {
  const conn = await db.one('select * from connections where id = $1', [b.connection_id]);
  const ws = await db.one('select * from workspaces where id = $1', [b.workspace_id]);
  const key = senderKey(conn);
  let n = 0;
  let claimed = true;
  await db.tx(async (c) => {
    // Claim it. If another call already claimed it, this waits for that transaction and then matches nothing.
    const claim = await c.query("update broadcasts set status = 'sending', started_at = now() where id = $1 and status = any($2::text[]) returning id", [b.id, QUEUEABLE]);
    if (!claim.rowCount) { claimed = false; return; }
    if (conn.kind === 'bot') {
      const segment = b.segment_id ? (await c.query('select * from segments where id = $1', [b.segment_id])).rows[0] : null;
      const rules = segment ? segment.rules : [];
      const capSql = ws.daily_cap > 0 ? ` and (select count(*) from deliveries d2 where d2.subscriber_id = s.id and d2.action = 'send' and d2.created_at > now() - interval '1 day') < ${Number(ws.daily_cap)}` : '';
      // Params $1..$7 are fixed below; segment rules start at $8.
      const w = seg.toSql(rules, 8);
      const insert = (at, tzFilter) => c.query(`insert into deliveries(workspace_id, sender_key, broadcast_id, subscriber_id, chat_id, due_at)
          select $1, $2, $3, s.id, s.tg_user_id, $5 from subscribers s
          where s.connection_id = $4 and s.status = 'active' and ($7::text is null or coalesce(s.tz, $6::text) = $7)${w.sql}${capSql}
          on conflict (broadcast_id, subscriber_id) where action = 'send' and broadcast_id is not null and subscriber_id is not null do nothing`,
      [b.workspace_id, key, b.id, conn.id, at, ws.timezone, tzFilter, ...w.params]);
      if (b.send_mode === 'local9') {
        // Each time zone gets its own 9am.
        const zones = (await c.query("select distinct coalesce(s.tz, $2::text) as tz from subscribers s where s.connection_id = $1 and s.status = 'active'", [conn.id, ws.timezone])).rows;
        for (const z of zones) n += (await insert(next9(z.tz), z.tz)).rowCount;
      } else {
        n = (await insert(new Date(), null)).rowCount;
      }
    } else {
      await c.query('insert into deliveries(workspace_id, sender_key, broadcast_id, chat_id, due_at) values ($1,$2,$3,$4, now())', [b.workspace_id, key, b.id, conn.tg_chat_id]);
      n = 1;
    }
    await c.query("update broadcasts set status = case when $2 = 0 then 'sent' else 'sending' end, total = $2, started_at = now(), finished_at = case when $2 = 0 then now() else null end where id = $1", [b.id, n]);
  });
  if (!claimed) return (await db.one('select total from broadcasts where id = $1', [b.id])).total;
  return n;
}

/** Queue edit / pin / delete for every message of a sent broadcast. */
async function queueAction(b, action) {
  const r = await db.query(`insert into deliveries(workspace_id, sender_key, action, broadcast_id, subscriber_id, chat_id, message_id, message_id2, priority, due_at)
    select workspace_id, sender_key, $2, broadcast_id, subscriber_id, chat_id, message_id, message_id2, 3, now() from deliveries
    where broadcast_id = $1 and action = 'send' and status = 'sent' and message_id is not null`, [b.id, action]);
  return r.rowCount;
}

module.exports = { checkExtras, checkPinRights, DELETE_MAX_HOURS, UNPIN_MAX_HOURS, checkMessage, makeLinks, enqueue, queueAction, next9, wallClock, offsetMinutes, titleFrom, textLimit, TEXT_OPTIONAL };

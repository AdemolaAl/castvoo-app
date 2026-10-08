'use strict';
/*
 * Updates from a customer's own bot (Telegram calls /tg/b/<connection id>).
 *  /start [tag]   → saves the subscriber, starts matching follow-ups
 *  /stop or 🔕    → stops broadcasts to that person
 *  any message    → counted as a reply
 *  blocked bot    → marked blocked, follow-ups stop
 *  join request   → Welcome Flows (services/flows.js): welcome within Telegram's 5-minute window, approve, follow up
 */

const db = require('../db');
const tg = require('./telegram');
const drips = require('./drips');
const log = require('../lib/log');
const { tokenOf } = require('./connections');

const TAG_RE = /^[A-Za-z0-9_-]{1,64}$/;

async function upsertSubscriber(conn, from, { source = null, status = 'active' } = {}) {
  return db.one(`insert into subscribers(connection_id, tg_user_id, first_name, username, lang, source, status)
      values ($1,$2,$3,$4,$5,$6,$7)
    on conflict (connection_id, tg_user_id) do update set
      first_name = excluded.first_name, username = excluded.username, lang = coalesce(excluded.lang, subscribers.lang),
      source = coalesce(subscribers.source, excluded.source),
      status = case when excluded.status = 'active' then 'active' else subscribers.status end,
      last_seen_at = now()
    returning *, (xmax = 0) as inserted`,
  [conn.id, from.id, (from.first_name || '').slice(0, 64), from.username || null, from.language_code || null, source, status]);
}

async function reply(conn, chatId, text) {
  await tg.call(tokenOf(conn), 'sendMessage', { chat_id: chatId, text }).catch(() => {});
}

async function onMessage(conn, m) {
  if (!m.chat || m.chat.type !== 'private' || !m.from || m.from.is_bot) return;
  const text = typeof m.text === 'string' ? m.text.trim() : '';
  if (text === '/start' || text.startsWith('/start ')) {
    const payload = text.split(/\s+/)[1] || '';
    // j_<code> comes from a Welcome Flow's "Tap to start" / "Tap to join" button: not an ad tag.
    const fromWelcome = payload.startsWith('j_');
    const tag = !fromWelcome && TAG_RE.test(payload) ? payload : null;
    const before = await db.one('select status from subscribers where connection_id = $1 and tg_user_id = $2', [conn.id, m.from.id]);
    const sub = await upsertSubscriber(conn, m.from, { source: tag });
    const isNew = sub.inserted || (before && before.status !== 'active');
    if (isNew) {
      await drips.start(sub, conn.id, 'start', '');
      if (tag) await drips.start(sub, conn.id, 'start_tag', tag);
    }
    await require('./flows').onStart(conn, sub, m.from, payload);
    return;
  }
  const sub = await db.one('select * from subscribers where connection_id = $1 and tg_user_id = $2', [conn.id, m.from.id]);
  if (text === '/stop') {
    if (sub) { await db.query("update subscribers set status = 'stopped' where id = $1", [sub.id]); await drips.stopFor(sub.id); }
    return reply(conn, m.chat.id, 'Done. You won\'t get broadcasts from this bot any more. Send /start any time to come back.');
  }
  const s2 = sub || (await upsertSubscriber(conn, m.from));
  await db.query('update subscribers set last_seen_at = now() where id = $1', [s2.id]);
  await db.query('insert into replies(workspace_id, connection_id, subscriber_id) values ($1,$2,$3)', [conn.workspace_id, conn.id, s2.id]);
}

async function onCallback(conn, q) {
  if (q.data !== 'cv_stop') { await tg.call(tokenOf(conn), 'answerCallbackQuery', { callback_query_id: q.id }).catch(() => {}); return; }
  const sub = await db.one("update subscribers set status = 'stopped' where connection_id = $1 and tg_user_id = $2 returning id", [conn.id, q.from.id]);
  if (sub) await drips.stopFor(sub.id);
  await tg.call(tokenOf(conn), 'answerCallbackQuery', { callback_query_id: q.id, text: 'Done. No more broadcasts. Send /start to come back.', show_alert: true }).catch(() => {});
}

async function onMyChatMember(conn, u) {
  if (!u.chat || u.chat.type !== 'private') return;
  const st = u.new_chat_member && u.new_chat_member.status;
  if (st === 'kicked') {
    const sub = await db.one("update subscribers set status = 'blocked' where connection_id = $1 and tg_user_id = $2 returning id", [conn.id, u.from.id]);
    if (sub) await drips.stopFor(sub.id);
  }
}

/** Join requests are handled by Welcome Flows (services/flows.js). */
async function onJoinRequest(conn, jr) { return require('./flows').onJoinRequest(conn, jr); }

async function stepButtons(step) {
  const links = await db.many('select code, label, url, row from links where step_id = $1 order by position, created_at, code', [step.id]);
  return links.map((l) => ({ label: l.label, url: l.url, code: l.code, row: l.row }));
}

async function handleUpdate(conn, update) {
  try {
    if (update.message) return await onMessage(conn, update.message);
    if (update.callback_query) return await onCallback(conn, update.callback_query);
    if (update.my_chat_member) return await onMyChatMember(conn, update.my_chat_member);
    if (update.chat_join_request) return await onJoinRequest(conn, update.chat_join_request);
  } catch (e) {
    log.error('bot update failed', { conn: conn.id, err: e });
  }
}

/*
 * ENG-10: a join request is acknowledged to Telegram at once and handled right after, in this process (the welcome,
 * its retries and media upload, and the approval can take many seconds; Telegram would time out and resend).
 * `inflight` lets shutdown (and tests) wait for that work to finish. At most MAX_INFLIGHT run at once; above that the
 * webhook waits for its own update (back-pressure instead of an unbounded pile-up).
 */
const inflight = new Set();
const MAX_INFLIGHT = 200;
async function handleSoon(conn, update) {
  if (!update.chat_join_request || inflight.size >= MAX_INFLIGHT) return handleUpdate(conn, update);
  const p = handleUpdate(conn, update).finally(() => inflight.delete(p));
  inflight.add(p);
  return null;
}
/** Resolves when every join request handled in the background is done (or after `ms`). */
async function idle(ms = 30000) {
  const end = Date.now() + ms;
  while (inflight.size && Date.now() < end) await Promise.race([Promise.allSettled([...inflight]), new Promise((r) => setTimeout(r, Math.max(1, end - Date.now())))]);
  return inflight.size === 0;
}

module.exports = { handleUpdate, handleSoon, idle, upsertSubscriber, stepButtons };

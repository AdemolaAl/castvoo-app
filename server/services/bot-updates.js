'use strict';
/*
 * Updates from a customer's own bot (Telegram calls /tg/b/<connection id>).
 *  /start [tag]   → saves the subscriber, starts matching follow-ups
 *  /stop or 🔕    → stops broadcasts to that person
 *  any message    → counted as a reply
 *  blocked bot    → marked blocked, follow-ups stop
 *  join request   → sends the join-request welcome within Telegram's 5-minute window
 */

const db = require('../db');
const tg = require('./telegram');
const drips = require('./drips');
const send = require('./send');
const log = require('../lib/log');
const settings = require('./settings');
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
    const tag = TAG_RE.test(payload) ? payload : null;
    const before = await db.one('select status from subscribers where connection_id = $1 and tg_user_id = $2', [conn.id, m.from.id]);
    const sub = await upsertSubscriber(conn, m.from, { source: tag });
    const isNew = sub.inserted || (before && before.status !== 'active');
    if (isNew) {
      await drips.start(sub, conn.id, 'start', '');
      if (tag) await drips.start(sub, conn.id, 'start_tag', tag);
    }
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

async function onJoinRequest(conn, jr) {
  if (!(await settings.feature('join_welcome')) || !(await settings.feature('drips'))) return;
  const seq = await db.one(`select * from sequences where connection_id = $1 and active and trigger_type = 'join_request' and trigger_value = $2 order by id limit 1`, [conn.id, String(jr.chat.id)]);
  if (!seq) return;
  const steps = await db.many('select * from sequence_steps where sequence_id = $1 order by position', [seq.id]);
  if (!steps.length) return;
  const existing = await db.one('select * from subscribers where connection_id = $1 and tg_user_id = $2', [conn.id, jr.from.id]);
  const sub = existing || (await upsertSubscriber(conn, jr.from, { status: 'joinreq' }));
  const ws = await db.one('select * from workspaces where id = $1', [conn.workspace_id]);
  const first = steps[0];
  // Same rule as the follow-up job: no sending on a paused plan, an ended trial, or during maintenance.
  const canSend = !['paused', 'cancelled'].includes(ws.plan_status)
    && !(ws.plan_status === 'trial' && new Date(ws.trial_ends_at) < new Date())
    && !(await settings.feature('maintenance'));
  try {
    if (canSend) {
      const msg = await send.sendOne({ body: first.body, media_id: first.media_id, buttons: await stepButtons(first) },
        { token: tokenOf(conn), botKey: 'bot:' + conn.id, chatId: jr.user_chat_id || jr.from.id, subscriberId: sub.id, includeStop: false, firstName: jr.from.first_name });
      await db.query(`insert into deliveries(workspace_id, sender_key, step_id, subscriber_id, chat_id, status, message_id, sent_at, attempts)
        values ($1,$2,$3,$4,$5,'sent',$6, now(), 1)`, [conn.workspace_id, 'bot:' + conn.id, first.id, sub.id, jr.user_chat_id || jr.from.id, msg.message_id]);
    }
  } catch (e) {
    log.warn('join-request welcome failed', { conn: conn.id, err: e.message });
  }
  if (seq.approve_join) await tg.call(tokenOf(conn), 'approveChatJoinRequest', { chat_id: jr.chat.id, user_id: jr.from.id }).catch((e) => log.warn('approve join failed', { err: e.message }));
  if (steps[1]) {
    await db.query(`insert into sequence_runs(sequence_id, subscriber_id, next_position, due_at) values ($1,$2,$3, now() + make_interval(mins => $4))
      on conflict (sequence_id, subscriber_id) do nothing`, [seq.id, sub.id, steps[1].position, steps[1].delay_minutes]);
  }
}

async function stepButtons(step) {
  const links = await db.many('select code, label, url from links where step_id = $1 order by position, created_at, code', [step.id]);
  return links.map((l) => ({ label: l.label, url: l.url, code: l.code }));
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

module.exports = { handleUpdate, upsertSubscriber, stepButtons };

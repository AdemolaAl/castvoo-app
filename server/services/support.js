'use strict';
/*
 * Support chat. A customer has one conversation ("thread") at a time; the team answers
 * from Admin → Support or from VooSquare (via /api/voosquare/support/*). Both use these functions.
 */

const db = require('../db');
const config = require('../config');
const email = require('./email');
const voosquare = require('./voosquare');
const { str, badRequest, notFound } = require('../lib/util');

async function listThreads({ status = 'open', q = '', limit = 50, before = null, assigned = null } = {}) {
  const params = [];
  let where = '1=1';
  if (status && status !== 'all') { params.push(status); where += ` and t.status = $${params.length}`; }
  if (assigned) { params.push(Number(assigned)); where += ` and t.assigned_to = $${params.length}`; }
  if (before) {
    const d = new Date(before);
    if (Number.isNaN(d.getTime())) throw badRequest('"before" must be a date.'); // was a 500 (Invalid Date sent to the database)
    params.push(d); where += ` and t.last_message_at < $${params.length}`;
  }
  if (q) { params.push('%' + String(q).replace(/[%_]/g, '').slice(0, 60) + '%'); where += ` and (u.email ilike $${params.length} or u.name ilike $${params.length} or t.subject ilike $${params.length})`; }
  params.push(Math.min(200, Number(limit) || 50));
  return db.many(`select t.id, t.subject, t.status, t.unread_staff, t.last_message_at, t.created_at, t.assigned_to, a.name as assigned_name,
      u.id as user_id, u.name as user_name, u.email as user_email, u.voo_id, t.workspace_id, w.name as workspace_name, w.plan_code, w.plan_status,
      (select body from support_messages m where m.thread_id = t.id and not m.internal order by m.id desc limit 1) as last_message,
      (select author_type from support_messages m where m.thread_id = t.id and not m.internal order by m.id desc limit 1) as last_author
    from support_threads t join users u on u.id = t.user_id left join workspaces w on w.id = t.workspace_id left join users a on a.id = t.assigned_to
    where ${where} order by t.last_message_at desc limit $${params.length}`, params);
}

async function getThread(id, { includeInternal = true } = {}) {
  const t = await db.one(`select t.*, u.name as user_name, u.email as user_email, u.country as user_country, u.tg_username, u.created_at as user_since,
      w.name as workspace_name, w.plan_code, w.plan_status, w.wallet_cents, w.bonus_cents
    from support_threads t join users u on u.id = t.user_id left join workspaces w on w.id = t.workspace_id where t.id = $1`, [id]);
  if (!t) throw notFound('That conversation');
  const messages = await db.many(`select id, author_type, author_name, body, internal, via, created_at from support_messages
    where thread_id = $1 ${includeInternal ? '' : 'and not internal'} order by id`, [id]);
  return { thread: t, messages };
}

/** A customer writes to support. */
async function userMessage(user, workspaceId, body) {
  const text = str(body, 'Message', { min: 1, max: 4000 });
  let t = await db.one("select * from support_threads where user_id = $1 and status <> 'closed' order by id desc limit 1", [user.id]);
  if (!t) t = await db.one('insert into support_threads(workspace_id, user_id, subject) values ($1,$2,$3) returning *', [workspaceId, user.id, text.slice(0, 80)]);
  await db.query("insert into support_messages(thread_id, author_type, author_user_id, author_name, body) values ($1,'user',$2,$3,$4)", [t.id, user.id, user.name, text]);
  await db.query("update support_threads set unread_staff = true, status = 'open', last_message_at = now() where id = $1", [t.id]);
  voosquare.supportMessage({ threadId: t.id, user, subject: t.subject, body: text }).catch(() => {});
  return t.id;
}

/** The team answers (from the admin panel or VooSquare). */
async function staffReply(threadId, { authorUserId = null, authorName, body, internal = false, via = 'castvoo', notify = true }) {
  const text = str(body, 'Reply', { min: 1, max: 4000 });
  const t = await db.one('select * from support_threads where id = $1', [threadId]);
  if (!t) throw notFound('That conversation');
  const name = str(authorName || 'Castvoo team', 'Name', { min: 1, max: 60 });
  await db.query("insert into support_messages(thread_id, author_type, author_user_id, author_name, body, internal, via) values ($1,'staff',$2,$3,$4,$5,$6)",
    [threadId, authorUserId, name, text, !!internal, via]);
  if (!internal) {
    await db.query("update support_threads set unread_user = true, unread_staff = false, status = 'pending', last_message_at = now() where id = $1", [threadId]);
    const user = await db.one('select * from users where id = $1', [t.user_id]);
    if (notify) await email.send('support_reply', user, { agent_name: name.split(' ')[0], message_preview: text.length > 280 ? text.slice(0, 277) + '…' : text, support_url: config.appUrl + '/#app/help' });
  }
  return { ok: true };
}

async function setStatus(threadId, status) {
  if (!['open', 'pending', 'closed'].includes(status)) throw badRequest('Status must be open, pending or closed.');
  const r = await db.one('update support_threads set status = $2, unread_staff = case when $2 = \'closed\' then false else unread_staff end where id = $1 returning id', [threadId, status]);
  if (!r) throw notFound('That conversation');
  return { ok: true };
}

module.exports = { listThreads, getThread, userMessage, staffReply, setStatus };

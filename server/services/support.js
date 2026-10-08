'use strict';
/*
 * Support chat. A customer has one conversation ("thread") at a time; the team answers
 * from Admin → Support or from VooSquare (via /api/voosquare/support/*). Both use these functions.
 */

const db = require('../db');
const config = require('../config');
const log = require('../lib/log');
const email = require('./email');
const voosquare = require('./voosquare');
const images = require('./support-images');
const { str, badRequest, notFound } = require('../lib/util');

async function listThreads({ status = 'open', q = '', limit = 50, before = null, assigned = null } = {}) {
  const params = [];
  let where = '1=1';
  // "human" = conversations the AI handed to the team that are not closed yet ("Needs human" in the admin).
  if (status === 'human') where += " and t.needs_human and t.status <> 'closed'";
  else if (status && status !== 'all') { params.push(status); where += ` and t.status = $${params.length}`; }
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
      t.needs_human, t.ai_enabled, t.ai_paused, t.ai_paused_reason, t.priority, t.queue, t.handoff_reason,
      (select coalesce(nullif(body, ''), '📷 Image') from support_messages m where m.thread_id = t.id and not m.internal and m.visible_at <= now() order by m.id desc limit 1) as last_message,
      (select author_type from support_messages m where m.thread_id = t.id and not m.internal and m.visible_at <= now() order by m.id desc limit 1) as last_author
    from support_threads t join users u on u.id = t.user_id left join workspaces w on w.id = t.workspace_id left join users a on a.id = t.assigned_to
    where ${where} order by t.last_message_at desc limit $${params.length}`, params);
}

async function getThread(id, { includeInternal = true } = {}) {
  const t = await db.one(`select t.*, u.name as user_name, u.email as user_email, u.country as user_country, u.tg_username, u.created_at as user_since,
      w.name as workspace_name, w.plan_code, w.plan_status, w.wallet_cents, w.bonus_cents,
      exists (select 1 from plans p where p.code = w.plan_code and coalesce(p.price_month_cents, 0) = 0 and coalesce(p.price_year_cents, 0) = 0) as plan_free
    from support_threads t join users u on u.id = t.user_id left join workspaces w on w.id = t.workspace_id where t.id = $1`, [id]);
  if (!t) throw notFound('That conversation');
  const rows = await db.many(`select id, author_type, author_name, body, internal, via, persona_id, visible_at, created_at from support_messages
    where thread_id = $1 ${includeInternal ? '' : 'and not internal'} order by id`, [id]);
  // Images: staff open them through /api/admin/support/attachments/:id (support.view). Paths are never sent.
  const att = await images.forMessages(rows.map((m) => m.id));
  const messages = rows.map((m) => ({ ...m, attachments: (att.get(Number(m.id)) || []).map((a) => images.publicRow(a, '/api/admin/support/attachments')) }));
  return { thread: t, messages };
}

/** The person's open conversation for this workspace (or null). */
const openThread = (userId, workspaceId) => db.one("select * from support_threads where user_id = $1 and workspace_id = $2 and status <> 'closed' order by id desc limit 1", [userId, workspaceId]);
/** The person's latest conversation for this workspace, open or closed (the Help page). */
const latestThread = (userId, workspaceId) => db.one('select * from support_threads where user_id = $1 and workspace_id = $2 order by id desc limit 1', [userId, workspaceId]);

/** A customer writes to support. attachments: ids of images they uploaded first (POST /api/support/attachments), up to 3. */
async function userMessage(user, workspaceId, body, attachments = []) {
  const pics = await images.check(attachments, { userId: user.id, type: 'user' });
  const text = pics.length ? (str(body, 'Message', { min: 0, max: 4000, required: false }) || '') : str(body, 'Message', { min: 1, max: 4000 });
  // One conversation per person PER WORKSPACE (ENG-16, SEC-1): writing from workspace B never continues a thread of
  // workspace A, so the AI always checks the workspace the customer is in (and is still a member of).
  let t = await openThread(user.id, workspaceId);
  if (!t) t = await db.one('insert into support_threads(workspace_id, user_id, subject) values ($1,$2,$3) returning *', [workspaceId, user.id, (text || 'Screenshot').slice(0, 80)]);
  const m = await db.one("insert into support_messages(thread_id, author_type, author_user_id, author_name, body) values ($1,'user',$2,$3,$4) returning id", [t.id, user.id, user.name, text]);
  await images.attach(pics, { messageId: m.id, threadId: t.id });
  await db.query("update support_threads set unread_staff = true, status = 'open', last_message_at = now() where id = $1", [t.id]);
  // Awaited: the copy for the VooSquare HQ inbox is in the outbox before we answer, so the next flush always has it.
  const copy = [text, pics.length ? `[${pics.length} image${pics.length > 1 ? 's' : ''} attached: open the conversation in Castvoo Admin → Support]` : ''].filter(Boolean).join('\n');
  await voosquare.supportMessage({ threadId: t.id, user, subject: t.subject, body: copy }).catch((e) => log.warn('VooSquare support copy not queued', { err: e.message }));
  // The AI support team answers in the background (services/support-ai.js); this request does not wait for it.
  const ai = require('./support-ai');
  if (!t.ai_paused && t.ai_enabled !== false && (await ai.isOn())) await ai.enqueue(t.id).catch((e) => log.warn('support ai not queued', { err: e.message }));
  return t.id;
}

/** The team answers (from the admin panel or VooSquare). */
async function staffReply(threadId, { authorUserId = null, authorName, body, internal = false, via = 'castvoo', notify = true, attachments = [] }) {
  const t = await db.one('select * from support_threads where id = $1', [threadId]);
  if (!t) throw notFound('That conversation');
  const pics = authorUserId ? await images.check(attachments, { userId: authorUserId, type: 'staff', threadId: t.id }) : [];
  const text = pics.length ? (str(body, 'Reply', { min: 0, max: 4000, required: false }) || '') : str(body, 'Reply', { min: 1, max: 4000 });
  const name = str(authorName || 'Castvoo team', 'Name', { min: 1, max: 60 });
  const m = await db.one("insert into support_messages(thread_id, author_type, author_user_id, author_name, body, internal, via) values ($1,'staff',$2,$3,$4,$5,$6) returning id",
    [threadId, authorUserId, name, text, !!internal, via]);
  await images.attach(pics, { messageId: m.id, threadId: t.id });
  if (!internal) {
    await db.query("update support_threads set unread_user = true, unread_staff = false, status = 'pending', last_message_at = now() where id = $1", [threadId]);
    // A person answered: the AI steps back on this conversation until someone presses "Hand back to AI".
    await require('./support-ai').onStaffReply(threadId);
    const user = await db.one('select * from users where id = $1', [t.user_id]);
    const preview = text || (pics.length ? '📷 Sent you an image. Open Help to see it.' : '');
    if (notify) await email.send('support_reply', user, { agent_name: name.split(' ')[0], message_preview: preview.length > 280 ? preview.slice(0, 277) + '…' : preview, support_url: config.appUrl + '/#app/help' });
  }
  return { ok: true };
}

async function setStatus(threadId, status) {
  if (!['open', 'pending', 'closed'].includes(status)) throw badRequest('Status must be open, pending or closed.');
  const r = await db.one('update support_threads set status = $2, unread_staff = case when $2 = \'closed\' then false else unread_staff end where id = $1 returning id', [threadId, status]);
  if (!r) throw notFound('That conversation');
  return { ok: true };
}

module.exports = { listThreads, getThread, userMessage, staffReply, setStatus, openThread, latestThread };

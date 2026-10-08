'use strict';
/*
 * Server-to-server API for VooSquare (see the "VooSquare Integration Spec").
 * Every call needs:  Authorization: Bearer <VOO_API_KEY>   (or <VOO_SERVICE_KEY> if you set one)
 * Staff sync (GET/POST /api/voosquare/staff) accepts ONLY VOO_SERVICE_KEY (inbound-only), never the outgoing key.
 *
 *   GET  /api/voosquare/summary?voo_id=&period=1d|7d|30d          dashboard numbers
 *   POST /api/voosquare/support/webhook                             VooSquare HQ inbox → reply lands in Castvoo
 *        { type: "support.reply", ticket_id, external_ref: "castvoo-<id>", email, body, agent, created_at }
 *
 *   Support desk, worked from VooSquare (Part 5, two-way link):
 *   GET  /api/voosquare/support/boxes
 *   GET  /api/voosquare/support/tickets?status=active|open|pending|closed|all&view=mine|unassigned&q=&voo_id=
 *   GET  /api/voosquare/support/tickets/:ref
 *   POST /api/voosquare/support/tickets/:ref/reply    { voo_id, text, note }
 *   POST /api/voosquare/support/tickets/:ref/update   { status, assignee_voo_id }
 *   GET  /api/voosquare/staff        POST /api/voosquare/staff   { voo_id, email, name, role, active }
 *
 *   Older names that still work: /api/voosquare/support/threads[...]
 */

const db = require('../db');
const config = require('../config');
const support = require('../services/support');
const log = require('../lib/log');
const { httpError, int } = require('../lib/util');
// The router already checks the key for { auth: 'service' } routes (lib/service-key.js); each handler checks again.
const { requireKey: checkKey } = require('../lib/service-key');
const requireKey = (ctx, o) => checkKey(ctx, o);
const SVC = { auth: 'service' };
const SVC_IN = { auth: 'service', inboundOnly: true }; // staff sync: VOO_SERVICE_KEY only (SEC-15)

/* VooSquare roles → Castvoo staff roles. Owners are never created from VooSquare. */
const ROLE_MAP = { admin: 'admin', support: 'support', finance: 'finance', content: 'marketing', marketing: 'marketing', viewer: 'viewer' };
const STATUS_IN = { open: 'open', active: 'open', pending: 'pending', waiting: 'pending', solved: 'closed', closed: 'closed' };
const staffName = async (vooId, fallback) => {
  if (!vooId) return { id: null, name: fallback || 'Castvoo team' };
  const u = await db.one('select id, name from users where voo_id = $1 and staff_role is not null', [String(vooId)]);
  return u ? { id: u.id, name: u.name } : { id: null, name: fallback || 'Castvoo team' };
};
const ticket = (t) => ({
  ref: String(t.id), subject: t.subject, status: t.status === 'closed' ? 'solved' : t.status, priority: 'normal', box: 'general',
  unread: t.unread_staff, customer: { name: t.user_name, email: t.user_email, voo_id: t.voo_id || null }, plan: t.plan_code ? `${t.plan_code} (${t.plan_status})` : null,
  last_message: t.last_message, last_message_at: t.last_message_at, created_at: t.created_at, assignee: t.assigned_name || null,
  url: `${config.appUrl}/admin#support/${t.id}`,
});

const PERIOD = { '1d': 1, '7d': 7, '30d': 30 };

module.exports = (r) => {
  r.get('/api/voosquare/summary', async (ctx) => {
    requireKey(ctx);
    const user = await db.one("select * from users where voo_id = $1 and status = 'active'", [String(ctx.query.voo_id || '')]);
    if (!user) return { tool: 'castvoo', linked: false };
    const ws = await db.one('select * from workspaces where owner_user_id = $1 order by id limit 1', [user.id]);
    if (!ws) return { tool: 'castvoo', linked: true, status: 'none', metrics: [], open_url: config.appUrl + '/dashboard' };
    // hasOwn: "?period=constructor" must not pick up Object.prototype.constructor (that crashed with a 500).
    const period = Object.hasOwn(PERIOD, String(ctx.query.period)) ? String(ctx.query.period) : '1d';
    const days = PERIOD[period];
    const q = async (sql, from, to) => (await db.one(sql, [ws.id, from, to])).n;
    const now = new Date(), start = new Date(now - days * 86400000), prevStart = new Date(now - 2 * days * 86400000);
    const metric = async (key, label, sql, unit = 'count') => {
      const cur = await q(sql, start, now), prev = await q(sql, prevStart, start);
      return { key, label, value: cur, unit, change_pct: prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : null };
    };
    const metrics = [
      await metric('messages_sent', 'Messages sent', "select count(*)::int n from deliveries where workspace_id = $1 and status = 'sent' and action = 'send' and sent_at >= $2 and sent_at < $3"),
      await metric('broadcasts', 'Broadcasts', "select count(*)::int n from broadcasts where workspace_id = $1 and started_at >= $2 and started_at < $3"),
      { key: 'active_drips', label: 'Active follow-ups', value: (await db.one('select count(*)::int n from sequences where workspace_id = $1 and active', [ws.id])).n, unit: 'count', change_pct: null },
      { key: 'subscribers', label: 'Subscribers', value: (await require('../services/billing').usage(ws.id)).subscribers, unit: 'count', change_pct: null },
      await metric('clicks', 'Clicks', 'select count(*)::int n from clicks where workspace_id = $1 and created_at >= $2 and created_at < $3'),
    ];
    const status = ws.plan_status === 'cancelled' ? 'none' : ws.plan_status;
    return { tool: 'castvoo', linked: true, status, period, metrics, open_url: config.appUrl + '/#app' };
  }, SVC);

  /** A staff reply written in VooSquare's HQ inbox. VooSquare has already emailed the customer.
   *  Two addresses: ours, and the Voo Connect default (/hooks/voosquare/support). */
  const supportReply = async (ctx) => {
    requireKey(ctx);
    const b = ctx.body || {};
    if (b.type !== 'support.reply') return { ok: true, ignored: true };
    const m = /^castvoo-(\d+)$/.exec(String(b.external_ref || ''));
    if (!m) return { ok: true, ignored: true };
    await support.staffReply(Number(m[1]), { authorName: String(b.agent || 'Castvoo team').slice(0, 60), body: b.body, via: 'voosquare', notify: false });
    return { ok: true };
  };
  r.post('/api/voosquare/support/webhook', supportReply, SVC);
  r.post('/hooks/voosquare/support', supportReply, SVC);

  r.get('/api/voosquare/support/boxes', async (ctx) => {
    requireKey(ctx);
    const n = await db.one("select count(*)::int n from support_threads where status <> 'closed'");
    return { boxes: [{ id: 'general', name: 'General', open: n.n }] };
  }, SVC);

  r.get('/api/voosquare/support/tickets', async (ctx) => {
    requireKey(ctx);
    const q = ctx.query;
    const status = q.status === 'all' ? 'all' : q.status === 'active' || !q.status ? null : STATUS_IN[q.status] || 'open';
    let assigned = null;
    if (q.view === 'mine' && q.voo_id) { const s = await staffName(q.voo_id); assigned = s.id || -1; }
    let rows = await support.listThreads({ status: status || 'all', q: q.q, limit: q.limit, before: q.before, assigned });
    if (!status) rows = rows.filter((t) => t.status !== 'closed');
    if (q.view === 'unassigned') rows = rows.filter((t) => !t.assigned_to);
    return { tickets: rows.map(ticket) };
  }, SVC);

  r.get('/api/voosquare/support/tickets/:ref', async (ctx) => {
    requireKey(ctx);
    const { thread, messages } = await support.getThread(int(ctx.params.ref, 'Ticket'));
    return { ticket: { ...ticket({ ...thread, last_message: null }), customer: { name: thread.user_name, email: thread.user_email } },
      messages: messages.map((m) => ({ id: m.id, from: m.author_type === 'user' ? 'customer' : 'staff', author: m.author_name, text: m.body, note: m.internal, via: m.via, created_at: m.created_at })) };
  }, SVC);

  r.post('/api/voosquare/support/tickets/:ref/reply', async (ctx) => {
    requireKey(ctx);
    const s = await staffName(ctx.body.voo_id, ctx.body.staff_name);
    return support.staffReply(int(ctx.params.ref, 'Ticket'), { authorUserId: s.id || null, authorName: s.name, body: ctx.body.text || ctx.body.body, internal: !!ctx.body.note, via: 'voosquare' });
  }, SVC);

  r.post('/api/voosquare/support/tickets/:ref/update', async (ctx) => {
    requireKey(ctx);
    const id = int(ctx.params.ref, 'Ticket');
    if (ctx.body.status) await support.setStatus(id, STATUS_IN[String(ctx.body.status)] || String(ctx.body.status));
    if (ctx.body.assignee_voo_id !== undefined) {
      const s = ctx.body.assignee_voo_id ? await staffName(ctx.body.assignee_voo_id) : { id: null };
      await db.query('update support_threads set assigned_to = $2 where id = $1', [id, s.id || null]);
    }
    return { ok: true };
  }, SVC);

  /** VooSquare manages who on the Zedapex team can help with Castvoo. */
  r.get('/api/voosquare/staff', async (ctx) => {
    requireKey(ctx, { inboundOnly: true });
    const rows = await db.many("select voo_id, email, name, staff_role as role, last_login_at from users where staff_role is not null and status = 'active' order by id");
    return { staff: rows };
  }, SVC_IN);

  r.post('/api/voosquare/staff', async (ctx) => {
    requireKey(ctx, { inboundOnly: true });
    const b = ctx.body || {};
    const vooId = String(b.voo_id || '').slice(0, 120);
    if (!vooId) throw httpError(400, 'voo_id is required.', 'bad_request');
    let u = await db.one("select * from users where voo_id = $1 and status <> 'deleted'", [vooId]);
    const mail = b.email ? String(b.email).trim().toLowerCase().slice(0, 254) : null;
    // SEC-15: staff are never matched to an existing customer account by email (that would hand admin rights to
    // whoever owns that inbox's Castvoo account). The person links their Voo ID in Castvoo first, or uses a new email.
    if (!u && mail && (await db.one("select 1 from users where email = $1 and status <> 'deleted'", [mail]))) {
      log.warn('voosquare staff sync refused: email belongs to an existing Castvoo account', { voo_id: vooId });
      throw httpError(409, 'That email already has a Castvoo account. Ask the person to link their Voo ID in Castvoo (Settings → Connect VooSquare) and sync again.', 'conflict');
    }
    if (u && u.staff_role === 'owner') throw httpError(403, 'Castvoo owners are managed inside Castvoo only.', 'forbidden');
    if (b.active === false) {
      if (u) await db.query('update users set staff_role = null where id = $1', [u.id]);
      if (u) await db.query('delete from sessions where user_id = $1', [u.id]);
      if (u) await require('../services/audit').audit({ user: null, ip: 'voosquare' }, 'team.sync.remove', 'user:' + u.id, { voo_id: vooId });
      return { ok: true, removed: !!u };
    }
    const role = ROLE_MAP[String(b.role || '').toLowerCase()];
    if (!role) throw httpError(400, 'role must be admin, support, finance, content or viewer.', 'bad_request');
    if (!u) {
      if (!mail) throw httpError(400, 'email is required for a new staff member.', 'bad_request');
      u = await db.tx(async (c) => {
        const nu = (await c.query("insert into users(email, email_verified, name, voo_id, ref_code) values ($1, true, $2, $3, $4) returning *",
          [mail, String(b.name || mail.split('@')[0]).slice(0, 80), vooId, 'staff' + require('../lib/util').randomCode(8)])).rows[0];
        await require('../services/auth').createWorkspace(c, nu);
        return nu;
      });
    }
    const before = u.staff_role || null;
    await db.query('update users set staff_role = $2 where id = $1', [u.id, role]);
    await require('../services/audit').audit({ user: null, ip: 'voosquare' }, 'team.sync', 'user:' + u.id, { voo_id: vooId, role, before });
    // An alert in the logs whenever VooSquare grants or raises admin-level access.
    if (role === 'admin' && before !== 'admin') log.warn('voosquare staff sync granted admin', { user: u.id, voo_id: vooId });
    return { ok: true, role };
  }, SVC_IN);

  r.get('/api/voosquare/support/threads', async (ctx) => {
    requireKey(ctx);
    return { threads: await support.listThreads({ status: ctx.query.status || 'open', q: ctx.query.q, limit: ctx.query.limit, before: ctx.query.before }) };
  }, SVC);

  r.get('/api/voosquare/support/threads/:id', async (ctx) => {
    requireKey(ctx);
    return support.getThread(int(ctx.params.id, 'Conversation'));
  }, SVC);

  r.post('/api/voosquare/support/threads/:id/reply', async (ctx) => {
    requireKey(ctx);
    return support.staffReply(int(ctx.params.id, 'Conversation'), { authorName: ctx.body.staff_name || 'Castvoo team', body: ctx.body.body, internal: !!ctx.body.internal, via: 'voosquare' });
  }, SVC);

  r.post('/api/voosquare/support/threads/:id/status', async (ctx) => {
    requireKey(ctx);
    return support.setStatus(int(ctx.params.id, 'Conversation'), String(ctx.body.status || ''));
  }, SVC);
};

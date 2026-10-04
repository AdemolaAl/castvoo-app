'use strict';
/*
 * Server-to-server API for VooSquare (see the "VooSquare Integration Spec").
 * Every call needs:  Authorization: Bearer <VOO_API_KEY>   (or <VOO_SERVICE_KEY> if you set one)
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
const { safeEqual, httpError, int } = require('../lib/util');

function requireKey(ctx) {
  const h = String(ctx.req.headers.authorization || '');
  const key = h.startsWith('Bearer ') ? h.slice(7) : '';
  const ok = key && [config.voosquare.apiKey, config.voosquare.serviceKey].some((k) => k && safeEqual(key, k));
  if (!ok) throw httpError(401, 'Bad or missing service key.', 'unauthorized');
}

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
  });

  /** A staff reply written in VooSquare's HQ inbox. VooSquare has already emailed the customer. */
  r.post('/api/voosquare/support/webhook', async (ctx) => {
    requireKey(ctx);
    const b = ctx.body || {};
    if (b.type !== 'support.reply') return { ok: true, ignored: true };
    const m = /^castvoo-(\d+)$/.exec(String(b.external_ref || ''));
    if (!m) return { ok: true, ignored: true };
    await support.staffReply(Number(m[1]), { authorName: String(b.agent || 'Castvoo team').slice(0, 60), body: b.body, via: 'voosquare', notify: false });
    return { ok: true };
  });

  r.get('/api/voosquare/support/boxes', async (ctx) => {
    requireKey(ctx);
    const n = await db.one("select count(*)::int n from support_threads where status <> 'closed'");
    return { boxes: [{ id: 'general', name: 'General', open: n.n }] };
  });

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
  });

  r.get('/api/voosquare/support/tickets/:ref', async (ctx) => {
    requireKey(ctx);
    const { thread, messages } = await support.getThread(int(ctx.params.ref, 'Ticket'));
    return { ticket: { ...ticket({ ...thread, last_message: null }), customer: { name: thread.user_name, email: thread.user_email } },
      messages: messages.map((m) => ({ id: m.id, from: m.author_type === 'user' ? 'customer' : 'staff', author: m.author_name, text: m.body, note: m.internal, via: m.via, created_at: m.created_at })) };
  });

  r.post('/api/voosquare/support/tickets/:ref/reply', async (ctx) => {
    requireKey(ctx);
    const s = await staffName(ctx.body.voo_id, ctx.body.staff_name);
    return support.staffReply(int(ctx.params.ref, 'Ticket'), { authorUserId: s.id || null, authorName: s.name, body: ctx.body.text || ctx.body.body, internal: !!ctx.body.note, via: 'voosquare' });
  });

  r.post('/api/voosquare/support/tickets/:ref/update', async (ctx) => {
    requireKey(ctx);
    const id = int(ctx.params.ref, 'Ticket');
    if (ctx.body.status) await support.setStatus(id, STATUS_IN[String(ctx.body.status)] || String(ctx.body.status));
    if (ctx.body.assignee_voo_id !== undefined) {
      const s = ctx.body.assignee_voo_id ? await staffName(ctx.body.assignee_voo_id) : { id: null };
      await db.query('update support_threads set assigned_to = $2 where id = $1', [id, s.id || null]);
    }
    return { ok: true };
  });

  /** VooSquare manages who on the Zedapex team can help with Castvoo. */
  r.get('/api/voosquare/staff', async (ctx) => {
    requireKey(ctx);
    const rows = await db.many("select voo_id, email, name, staff_role as role, last_login_at from users where staff_role is not null and status = 'active' order by id");
    return { staff: rows };
  });

  r.post('/api/voosquare/staff', async (ctx) => {
    requireKey(ctx);
    const b = ctx.body || {};
    const vooId = String(b.voo_id || '').slice(0, 120);
    if (!vooId) throw httpError(400, 'voo_id is required.', 'bad_request');
    let u = await db.one("select * from users where voo_id = $1 and status <> 'deleted'", [vooId]);
    const mail = b.email ? String(b.email).trim().toLowerCase().slice(0, 254) : null;
    if (!u && mail) {
      u = await db.one("select * from users where email = $1 and status <> 'deleted'", [mail]);
      if (u && u.voo_id && u.voo_id !== vooId) throw httpError(409, 'That email belongs to a different VooSquare account.', 'conflict');
      if (u) await db.query('update users set voo_id = $2 where id = $1', [u.id, vooId]);
    }
    if (u && u.staff_role === 'owner') throw httpError(403, 'Castvoo owners are managed inside Castvoo only.', 'forbidden');
    if (b.active === false) {
      if (u) await db.query('update users set staff_role = null where id = $1', [u.id]);
      if (u) await db.query('delete from sessions where user_id = $1', [u.id]);
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
    await db.query('update users set staff_role = $2 where id = $1', [u.id, role]);
    await require('../services/audit').audit({ user: null, ip: 'voosquare' }, 'team.sync', 'user:' + u.id, { voo_id: vooId, role });
    return { ok: true, role };
  });

  r.get('/api/voosquare/support/threads', async (ctx) => {
    requireKey(ctx);
    return { threads: await support.listThreads({ status: ctx.query.status || 'open', q: ctx.query.q, limit: ctx.query.limit, before: ctx.query.before }) };
  });

  r.get('/api/voosquare/support/threads/:id', async (ctx) => {
    requireKey(ctx);
    return support.getThread(int(ctx.params.id, 'Conversation'));
  });

  r.post('/api/voosquare/support/threads/:id/reply', async (ctx) => {
    requireKey(ctx);
    return support.staffReply(int(ctx.params.id, 'Conversation'), { authorName: ctx.body.staff_name || 'Castvoo team', body: ctx.body.body, internal: !!ctx.body.internal, via: 'voosquare' });
  });

  r.post('/api/voosquare/support/threads/:id/status', async (ctx) => {
    requireKey(ctx);
    return support.setStatus(int(ctx.params.id, 'Conversation'), String(ctx.body.status || ''));
  });
};

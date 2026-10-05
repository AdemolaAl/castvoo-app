'use strict';
/* Admin → Team (staff roles and ranks), Audit log, System health, Integration tests. */

const db = require('../../db');
const config = require('../../config');
const perms = require('../../permissions');
const email = require('../../services/email');
const settings = require('../../services/settings');
const tg = require('../../services/telegram');
const { audit } = require('../../services/audit');
const { email: vEmail, int, badRequest, forbidden, notFound, randomCode } = require('../../lib/util');

module.exports = (r) => {
  r.get('/api/admin/team', async () => {
    const staff = await db.many("select id, name, email, tg_username, staff_role, last_login_at, created_at from users where staff_role is not null and status <> 'deleted' order by id");
    return {
      staff: staff.map((s) => ({ ...s, rank: perms.rank(s.staff_role), role_name: perms.ROLES[s.staff_role].name })).sort((a, b) => b.rank - a.rank),
      roles: Object.entries(perms.ROLES).map(([key, v]) => ({ key, ...v, perms: perms.permsFor(key) })),
      matrix: perms.PERMS,
    };
  }, { staff: 'overview.view' });

  /** Add someone to the team by email (creates their login if they don't have one yet). */
  r.post('/api/admin/team', async (ctx) => {
    const mail = vEmail(ctx.body.email);
    const role = String(ctx.body.role || '');
    if (!perms.ROLES[role]) throw badRequest('Pick a role.');
    let user = await db.one("select * from users where email = $1 and status <> 'deleted'", [mail]);
    if (!perms.canAssign(ctx.user.staff_role, role, user ? user.staff_role : null)) throw forbidden('You can only give roles below your own.');
    if (!user) {
      user = await db.tx(async (c) => {
        const u = (await c.query("insert into users(email, email_verified, name, ref_code) values ($1, false, $2, $3) returning *", [mail, mail.split('@')[0], 'staff' + randomCode(8)])).rows[0];
        await require('../../services/auth').createWorkspace(c, u);
        return u;
      });
    }
    await db.query('update users set staff_role = $2 where id = $1', [user.id, role]);
    await email.sendTo(mail, 'staff_invite', { first_name: user.name, inviter_name: ctx.user.name, role_name: perms.ROLES[role].name, admin_url: config.appUrl + '/admin' });
    await audit(ctx, 'team.add', 'user:' + user.id, { email: mail, role });
    return { ok: true };
  }, { staff: 'team.manage' });

  r.post('/api/admin/team/:id/role', async (ctx) => {
    const id = int(ctx.params.id, 'Team member');
    const target = await db.one('select * from users where id = $1', [id]);
    if (!target || !target.staff_role) throw notFound('That team member');
    if (id === ctx.user.id) throw badRequest('You cannot change your own role.');
    const role = ctx.body.role ? String(ctx.body.role) : null;
    if (role && !perms.ROLES[role]) throw badRequest('Pick a role.');
    if (ctx.user.staff_role !== 'owner' && perms.rank(target.staff_role) >= perms.rank(ctx.user.staff_role)) throw forbidden('You can only manage people ranked below you.');
    if (role && !perms.canAssign(ctx.user.staff_role, role, target.staff_role)) throw forbidden('You can only give roles below your own.');
    if (target.staff_role === 'owner' && role !== 'owner') {
      const owners = await db.one("select count(*)::int n from users where staff_role = 'owner' and status = 'active'");
      if (owners.n <= 1) throw badRequest('There must always be at least one owner.');
    }
    await db.query('update users set staff_role = $2 where id = $1', [id, role]);
    await audit(ctx, role ? 'team.role' : 'team.remove', 'user:' + id, { from: target.staff_role, to: role });
    return { ok: true };
  }, { staff: 'team.manage' });

  r.get('/api/admin/audit', async (ctx) => {
    const page = Math.max(1, Number(ctx.query.page) || 1);
    const params = [];
    let where = '1=1';
    if (ctx.query.q) { params.push('%' + String(ctx.query.q).replace(/[%_]/g, '') + '%'); where += ` and (a.action ilike $1 or a.target ilike $1 or u.name ilike $1 or u.email ilike $1)`; }
    params.push((page - 1) * 100);
    const rows = await db.many(`select a.*, u.name as actor_name, u.email as actor_email from audit_log a left join users u on u.id = a.actor_user_id
      where ${where} order by a.id desc limit 100 offset $${params.length}`, params);
    return { entries: rows, page };
  }, { staff: 'audit.view' });

  r.get('/api/admin/system', async () => {
    const [queue, leases, outbox, failed, dbsize, version, errorsByConn] = await Promise.all([
      db.many("select sender_key, count(*)::int queued, min(due_at) oldest from deliveries where status = 'queued' group by 1 order by 2 desc limit 30"),
      db.many('select * from sender_leases where expires_at > now()'),
      db.one('select count(*) filter (where sent_at is null and failed_at is null)::int pending, count(*) filter (where sent_at is null and failed_at is null and attempts > 3)::int failing, count(*) filter (where failed_at is not null)::int refused from outbox'),
      db.many("select error, count(*)::int n from deliveries where status = 'failed' and sent_at > now() - interval '1 day' group by 1 order by 2 desc limit 10"),
      db.one('select pg_size_pretty(pg_database_size(current_database())) as size'),
      db.one('select version()'),
      db.many("select c.id, c.kind, c.title, c.username, c.last_error, w.name as workspace from connections c join workspaces w on w.id = c.workspace_id where c.status = 'error' order by c.id desc limit 30"),
    ]);
    let platformBot = null;
    if (config.telegram.botToken) {
      try { const info = await tg.platform('getWebhookInfo'); platformBot = { url: info.url, pending: info.pending_update_count, last_error: info.last_error_message || null, last_error_at: info.last_error_date ? new Date(info.last_error_date * 1000) : null }; }
      catch (e) { platformBot = { error: e.message }; }
    }
    const mem = process.memoryUsage();
    return {
      queue, leases, outbox, failed_24h: failed, db: { size: dbsize.size, version: version.version.split(' ').slice(0, 2).join(' ') }, broken_connections: errorsByConn,
      platform_bot: platformBot, integrations: config.integrations(), problems: config.problems(),
      process: { uptime_min: Math.round(process.uptime() / 60), memory_mb: Math.round(mem.rss / 1048576), node: process.version, workers: config.runWorkers },
    };
  }, { staff: 'system.view' });

  /** "Test" buttons next to each integration in Admin → Settings → Connections. */
  r.post('/api/admin/integrations/:name/test', async (ctx) => {
    const name = ctx.params.name;
    const ok = (detail) => ({ ok: true, detail });
    try {
      if (name === 'telegram') { const me = await tg.platform('getMe'); await require('../../services/platform-bot').ensureWebhook(); return ok(`Connected as @${me.username}. Webhook set.`); }
      if (name === 'email') { if (!ctx.user.email) throw badRequest('Add an email to your account first.'); const sent = await email.sendTo(ctx.user.email, 'login_code', { code: '123456' }); return sent ? ok(`Test email sent to ${ctx.user.email}.`) : { ok: false, detail: 'Sending failed. Check RESEND_API_KEY and that your domain is verified in Resend.' }; }
      if (name === 'ai') { const ai = require('../../services/ai'); const res = await ai.complete({ system: 'Reply with the single word: ready', messages: [{ role: 'user', content: 'Are you ready?' }], maxTokens: 10 }); return ok(`Cas answered: "${res.text}" using ${(await settings.get('ai')).model}.`); }
      if (name === 'paystack') { const res = await fetch(config.paystack.apiBase + '/balance', { headers: { Authorization: 'Bearer ' + config.paystack.secretKey }, signal: AbortSignal.timeout(15000) }); const j = await res.json().catch(() => ({})); return j.status ? ok('Paystack key works.' + (String(config.paystack.secretKey).startsWith('sk_test') ? ' (TEST key)' : ' (LIVE key)')) : { ok: false, detail: j.message || 'Key rejected' }; }
      if (name === 'flutterwave') { const res = await fetch(config.flutterwave.apiBase + '/v3/balances', { headers: { Authorization: 'Bearer ' + config.flutterwave.secretKey }, signal: AbortSignal.timeout(15000) }); const j = await res.json().catch(() => ({})); return j.status === 'success' ? ok('Flutterwave key works.' + (String(config.flutterwave.secretKey).includes('TEST') ? ' (TEST key)' : '')) : { ok: false, detail: j.message || 'Key rejected' }; }
      if (name === 'gatevoo') { const res = await fetch(config.gatevoo.url + '/healthz', { signal: AbortSignal.timeout(10000) }); return res.ok ? ok('Gatevoo is reachable. Use "Send test" on Gatevoo\'s Connect page to check the webhook.') : { ok: false, detail: 'Gatevoo answered ' + res.status }; }
      throw notFound('That integration');
    } catch (e) {
      if (e.status) throw e;
      return { ok: false, detail: e.description || e.message };
    } finally {
      await audit(ctx, 'integration.test', name, {});
    }
  }, { staff: 'system.view', rate: [30, 600] });
};

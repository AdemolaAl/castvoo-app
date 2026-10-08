'use strict';
/* Admin → Users: search, details, suspend, change plan or trial, wallet corrections. */

const db = require('../../db');
const settings = require('../../services/settings');
const { audit } = require('../../services/audit');
const { balances } = require('../../services/referrals');
const { int, str, oneOf, cents, badRequest, notFound, forbidden } = require('../../lib/util');

// The Free plan has plan_status 'active' too (billing.dropToFree). "Paying" = active on a plan with a price. `p` = plans.
const FREE_SQL = '(coalesce(p.price_month_cents, 0) = 0 and coalesce(p.price_year_cents, 0) = 0)';
const FREE_OF_W = `exists (select 1 from plans p where p.code = w.plan_code and ${FREE_SQL})`;

module.exports = (r) => {
  r.get('/api/admin/users', async (ctx) => {
    const q = ctx.query;
    const params = [];
    let where = "u.status <> 'deleted'";
    if (q.q) { params.push('%' + String(q.q).replace(/[%_]/g, '').slice(0, 80) + '%'); where += ` and (u.email ilike $${params.length} or u.name ilike $${params.length} or u.tg_username ilike $${params.length} or u.ref_code ilike $${params.length} or w.name ilike $${params.length})`; }
    if (q.status === 'free') where += ` and w.plan_status = 'active' and ${FREE_OF_W}`;
    else if (q.status && ['trial', 'active', 'paused', 'cancelled'].includes(q.status)) { params.push(q.status); where += ` and w.plan_status = $${params.length}` + (q.status === 'active' ? ` and not ${FREE_OF_W}` : ''); }
    if (q.plan) { params.push(String(q.plan)); where += ` and w.plan_code = $${params.length}`; }
    if (q.suspended === '1') where += " and u.status = 'suspended'";
    if (q.staff === '1') where += ' and u.staff_role is not null';
    const page = Math.max(1, Number(q.page) || 1);
    const total = (await db.one(`select count(*)::int n from users u left join workspaces w on w.owner_user_id = u.id where ${where}`, params)).n;
    params.push((page - 1) * 50);
    // Total spent = money this person really paid us (confirmed top-ups) minus refunds we sent back.
    const order = q.sort === 'spent' ? 'spent_cents desc, u.id desc' : 'u.id desc';
    const rows = await db.many(`select * from (select u.id, u.name, u.email, u.tg_username, u.country, u.status, u.staff_role, u.created_at, u.last_login_at,
        w.id as workspace_id, w.name as workspace_name, w.plan_code, w.plan_status, (w.plan_code is not null and ${FREE_OF_W}) as plan_free, w.trial_ends_at, w.period_end, w.wallet_cents, w.bonus_cents,
        (select count(*)::int from connections c where c.workspace_id = w.id and c.status <> 'removed') as connections,
        (select coalesce(sum(p.amount_cents), 0) from payments p where p.user_id = u.id and p.status = 'paid')
          - (select coalesce(sum(-t.amount_cents), 0) from wallet_tx t join workspaces ow on ow.id = t.workspace_id where ow.owner_user_id = u.id and t.kind = 'refund' and t.amount_cents < 0) as spent_cents
      from users u left join workspaces w on w.owner_user_id = u.id where ${where}) x order by ${order.replace(/u\.id/g, 'x.id')} limit 50 offset $${params.length}`, params);
    return { users: rows.map((x) => ({ ...x, wallet: (Number(x.wallet_cents || 0) + Number(x.bonus_cents || 0)) / 100, spent: Math.max(0, Number(x.spent_cents)) / 100 })), total, page, pages: Math.max(1, Math.ceil(total / 50)) };
  }, { staff: 'users.view' });

  r.get('/api/admin/users/:id', async (ctx) => {
    const id = int(ctx.params.id, 'User');
    const user = await db.one('select id, name, email, email_verified, tg_user_id, tg_username, voo_id, country, staff_role, status, ref_code, referred_by, marketing_opt_out, created_at, last_login_at from users where id = $1', [id]);
    if (!user) throw notFound('That user');
    const workspaces = await db.many(`select w.*, m.role, ${FREE_OF_W} as plan_free from workspaces w join members m on m.workspace_id = w.id where m.user_id = $1 order by w.id`, [id]);
    const wsIds = workspaces.map((w) => w.id);
    const [connections, payments, tx, threads, referredBy, referred, usage, links] = await Promise.all([
      db.many("select id, workspace_id, kind, username, title, member_count, status, last_error, created_at from connections where workspace_id = any($1) and status <> 'removed'", [wsIds]),
      db.many("select p.reference, p.provider, p.method_key, p.amount_cents, p.bonus_cents, p.currency, p.amount_local, p.coin, p.txid, p.proof_ref, p.status, p.reason, p.created_at, p.paid_at, pm.label as method_label from payments p left join payment_methods pm on pm.key = p.method_key and p.provider = 'manual' where p.user_id = $1 order by p.id desc limit 30", [id]),
      db.many('select * from wallet_tx where workspace_id = any($1) order by id desc limit 40', [wsIds]),
      db.many('select id, subject, status, last_message_at from support_threads where user_id = $1 order by id desc limit 10', [id]),
      user.referred_by ? db.one('select id, name, email from users where id = $1', [user.referred_by]) : null,
      db.one('select count(*)::int n from users where referred_by = $1', [id]),
      wsIds.length ? require('../../services/billing').usage(wsIds[0]) : null,
      // SEC-7: their tracked button links, newest first, so staff can switch one off (phishing, scam pages).
      db.many(`select l.code, l.workspace_id, l.label, l.url, l.created_at, l.disabled_at, l.disabled_reason,
          (select count(*)::int from clicks k where k.code = l.code) as clicks
        from links l where l.workspace_id = any($1) order by l.disabled_at desc nulls last, l.created_at desc limit 50`, [wsIds]),
    ]);
    // Money, all time: what they paid in, what plans cost them, what we refunded, and what's left in their wallets.
    const owned = workspaces.filter((w) => w.role === 'owner').map((w) => w.id);
    const m = await db.one(`select
        (select coalesce(sum(amount_cents), 0) from payments where user_id = $1 and status = 'paid')::bigint as paid,
        (select count(*)::int from payments where user_id = $1 and status = 'paid') as payments,
        (select min(paid_at) from payments where user_id = $1 and status = 'paid') as first_paid,
        (select max(paid_at) from payments where user_id = $1 and status = 'paid') as last_paid,
        (select coalesce(sum(-amount_cents), 0) from wallet_tx where workspace_id = any($2) and kind = 'plan')::bigint as plans,
        (select coalesce(sum(-cash_cents), 0) from wallet_tx where workspace_id = any($2) and kind = 'plan')::bigint as plans_cash,
        (select coalesce(sum(-amount_cents), 0) from wallet_tx where workspace_id = any($2) and kind = 'refund' and amount_cents < 0)::bigint as refunded,
        (select coalesce(sum(wallet_cents + bonus_cents), 0) from workspaces where id = any($2))::bigint as wallet`, [id, owned]);
    const money = { paid: Number(m.paid) / 100, payments: m.payments, first_paid: m.first_paid, last_paid: m.last_paid, plans: Number(m.plans) / 100, plans_cash: Number(m.plans_cash) / 100, refunded: Number(m.refunded) / 100, spent: Math.max(0, Number(m.paid) - Number(m.refunded)) / 100, wallet: Number(m.wallet) / 100 };
    return { user, workspaces, connections, payments, wallet_tx: tx, threads, referred_by: referredBy, referred_count: referred.n, referral_balance: await balances(id), usage, money, links };
  }, { staff: 'users.view' });

  r.post('/api/admin/users/:id/status', async (ctx) => {
    const id = int(ctx.params.id, 'User');
    const status = oneOf(ctx.body.status, 'Status', ['active', 'suspended']);
    const target = await db.one('select * from users where id = $1', [id]);
    if (!target) throw notFound('That user');
    if (target.staff_role === 'owner' && ctx.user.staff_role !== 'owner') throw forbidden('Only an owner can suspend an owner.');
    // Same rank rule as the Team page: you can only act on staff ranked below you (an admin could suspend another admin).
    const perms = require('../../permissions');
    if (target.staff_role && ctx.user.staff_role !== 'owner' && perms.rank(target.staff_role) >= perms.rank(ctx.user.staff_role)) throw forbidden('You can only suspend team members ranked below you.');
    if (id === ctx.user.id) throw badRequest('You cannot suspend yourself.');
    await db.query('update users set status = $2 where id = $1', [id, status]);
    if (status === 'suspended') {
      await db.query('delete from sessions where user_id = $1', [id]);
      await db.query("update broadcasts set status = 'cancelled' where workspace_id in (select id from workspaces where owner_user_id = $1) and status in ('scheduled','sending','pending_approval')", [id]);
      await db.query("update deliveries set status = 'skipped', error = 'Account suspended' where status = 'queued' and workspace_id in (select id from workspaces where owner_user_id = $1)", [id]);
    }
    await audit(ctx, 'user.' + status, 'user:' + id, { reason: str(ctx.body.reason, 'Reason', { max: 300, required: false }) });
    return { ok: true };
  }, { staff: 'users.edit' });

  /** Change a workspace's plan, status or dates (e.g. extend a trial, comp a month). */
  r.post('/api/admin/workspaces/:id/plan', async (ctx) => {
    const id = int(ctx.params.id, 'Workspace');
    const ws = await db.one('select * from workspaces where id = $1', [id]);
    if (!ws) throw notFound('That workspace');
    const b = ctx.body;
    const plan = b.plan_code ? await settings.plan(b.plan_code) : await settings.plan(ws.plan_code);
    if (!plan) throw badRequest('Unknown plan.');
    const status = b.plan_status ? oneOf(b.plan_status, 'Status', ['trial', 'active', 'paused', 'cancelled']) : ws.plan_status;
    const date = (v, n) => { if (!v) return null; const d = new Date(v); if (Number.isNaN(d.getTime())) throw badRequest(`${n} is not a valid date.`); return d; };
    const trialEnds = b.trial_ends_at !== undefined ? date(b.trial_ends_at, 'Trial end') : ws.trial_ends_at;
    const periodEnd = b.period_end !== undefined ? date(b.period_end, 'Period end') : ws.period_end;
    if (status === 'trial' && !trialEnds) throw badRequest('A trial needs an end date.');
    if (status === 'active' && !periodEnd) throw badRequest('An active plan needs a period end date.');
    await db.query('update workspaces set plan_code = $2, plan_status = $3, trial_ends_at = $4, period_end = $5, reminded_at = null where id = $1', [id, plan.code, status, trialEnds, periodEnd]);
    if (b.reset_ai) await db.query('update workspaces set ai_used = 0 where id = $1', [id]);
    await audit(ctx, 'workspace.plan', 'workspace:' + id, { from: { plan: ws.plan_code, status: ws.plan_status }, to: { plan: plan.code, status, trialEnds, periodEnd }, note: b.note || '' });
    return { ok: true };
  }, { staff: 'users.edit' });

  /** Add or remove wallet money by hand (refund recorded elsewhere, goodwill credit, correction). */
  r.post('/api/admin/workspaces/:id/wallet', async (ctx) => {
    const id = int(ctx.params.id, 'Workspace');
    const amount = cents(ctx.body.amount);
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1000000) throw badRequest('Enter an amount between -$10,000 and $10,000 (not 0).');
    const kind = oneOf(ctx.body.kind || 'cash', 'Balance', ['cash', 'bonus']);
    const reason = str(ctx.body.reason, 'Reason', { min: 3, max: 300 });
    const asRefund = !!ctx.body.refund;
    let clawed = 0;
    await db.tx(async (c) => {
      const ws = (await c.query('select * from workspaces where id = $1 for update', [id])).rows[0];
      if (!ws) throw notFound('That workspace');
      const col = kind === 'cash' ? 'wallet_cents' : 'bonus_cents';
      if (Number(ws[col]) + amount < 0) throw badRequest(`That would make the ${kind} balance negative.`);
      await c.query(`update workspaces set ${col} = ${col} + $2 where id = $1`, [id, amount]);
      const tx = (await c.query('insert into wallet_tx(workspace_id, kind, amount_cents, cash_cents, bonus_part_cents, method, note, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id',
        [id, asRefund ? 'refund' : 'adjustment', amount, kind === 'cash' ? amount : 0, kind === 'bonus' ? amount : 0, 'Castvoo team', reason, ctx.user.id])).rows[0];
      // A refund cancels the referral earnings this customer's payments created that haven't settled yet.
      if (asRefund) clawed = await require('../../services/referrals').clawback(c, id, 'refund');
      // Cash given back to the customer: VooSquare logs a refund (it never reverses affiliate commission).
      if (asRefund && kind === 'cash' && amount < 0) await require('../../services/voosquare').refunded(c, { wsId: id, txId: tx.id, amountCents: -amount, at: new Date() });
    });
    await audit(ctx, asRefund ? 'wallet.refund' : 'wallet.adjust', 'workspace:' + id, { amount_cents: amount, kind, reason, referral_reversed_cents: clawed });
    return { ok: true, referral_reversed: clawed / 100 };
  }, { staff: 'wallet.adjust' });

  /**
   * Switch a tracked link (castvoo.com/l/<code>) off or on again, e.g. when it points at a phishing page (SEC-7).
   * A disabled link shows a short notice instead of redirecting. Body: { disabled: true|false, reason }.
   */
  r.post('/api/admin/links/:code/disable', async (ctx) => {
    const code = String(ctx.params.code || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    const off = ctx.body.disabled !== false;
    const reason = off ? str(ctx.body.reason, 'Reason', { min: 3, max: 300 }) : null;
    const row = await db.one('update links set disabled_at = case when $2 then now() else null end, disabled_reason = $3 where code = $1 returning code, url, workspace_id', [code, off, reason]);
    if (!row) throw notFound('That link');
    await audit(ctx, off ? 'link.disable' : 'link.enable', 'link:' + code, { url: row.url, workspace_id: row.workspace_id, reason });
    return { ok: true, disabled: off };
  }, { staff: 'users.edit' });
};

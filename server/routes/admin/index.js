'use strict';
/*
 * Admin panel API (/api/admin/*). Every route names the permission it needs
 * (see server/permissions.js), and every change is written to the audit log.
 */

const db = require('../../db');
const config = require('../../config');
const perms = require('../../permissions');

module.exports = (r) => {
  r.get('/api/admin/me', async (ctx) => ({
    user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email, role: ctx.user.staff_role },
    role: perms.ROLES[ctx.user.staff_role], perms: perms.permsFor(ctx.user.staff_role),
    roles: Object.entries(perms.ROLES).map(([key, v]) => ({ key, ...v })),
  }), { staff: 'overview.view' });

  r.get('/api/admin/overview', async () => {
    const one = (sql, p) => db.one(sql, p);
    const [users, ws, money, sending, support, queue, ai, signups, revenue, plans] = await Promise.all([
      one(`select count(*)::int total, count(*) filter (where created_at > now() - interval '1 day')::int today,
        count(*) filter (where created_at > now() - interval '7 days')::int week from users where status = 'active'`),
      one(`select count(*) filter (where plan_status = 'trial')::int trials, count(*) filter (where plan_status = 'active')::int paying,
        count(*) filter (where plan_status = 'paused')::int paused, count(*) filter (where plan_status = 'cancelled')::int cancelled from workspaces where purged_at is null`),
      one(`select coalesce(sum(amount_cents) filter (where status = 'paid' and paid_at > now() - interval '30 days'), 0)::bigint topups_30d,
        count(*) filter (where status = 'pending' and provider = 'manual_crypto' and txid is not null)::int crypto_to_check from payments`),
      one(`select count(*) filter (where status = 'sent' and sent_at > now() - interval '1 day')::int sent_24h,
        count(*) filter (where status in ('failed') and sent_at > now() - interval '1 day')::int failed_24h,
        count(*) filter (where status = 'blocked' and sent_at > now() - interval '1 day')::int blocked_24h from deliveries where created_at > now() - interval '2 days'`),
      one(`select count(*) filter (where status <> 'closed')::int open, count(*) filter (where unread_staff and status <> 'closed')::int unread from support_threads`),
      one(`select count(*)::int queued, min(due_at) filter (where due_at <= now()) as oldest_due from deliveries where status = 'queued'`),
      one(`select coalesce(sum(writes), 0)::int writes_24h, coalesce(sum(input_tokens), 0)::bigint input_24h, coalesce(sum(output_tokens), 0)::bigint output_24h from ai_usage where created_at > now() - interval '1 day'`),
      db.many(`select to_char(d, 'YYYY-MM-DD') as day, (select count(*)::int from users u where u.created_at >= d and u.created_at < d + interval '1 day') n
        from generate_series(date_trunc('day', now()) - interval '29 days', date_trunc('day', now()), interval '1 day') d order by d`),
      db.many(`select to_char(d, 'YYYY-MM-DD') as day, (select coalesce(sum(-amount_cents), 0)::bigint from wallet_tx t where t.kind = 'plan' and t.created_at >= d and t.created_at < d + interval '1 day') cents
        from generate_series(date_trunc('day', now()) - interval '29 days', date_trunc('day', now()), interval '1 day') d order by d`),
      db.many(`select w.plan_code, w.billing_cycle, count(*)::int n, max(p.price_month_cents) m, max(p.price_year_cents) y from workspaces w join plans p on p.code = w.plan_code where w.plan_status = 'active' group by 1, 2`),
    ]);
    // Local-currency prices use rates the team types in. Flag any not touched for a week.
    const staleRates = await db.many(`select code, name, currency, rate_updated_at from countries
      where active and currency <> 'USD' and rate_updated_at < now() - interval '7 days' order by rate_updated_at limit 20`);
    const withdrawals = await one("select count(*)::int n, coalesce(sum(amount_cents), 0)::bigint total from withdrawals where status = 'requested'");
    const mrr = plans.reduce((s, p) => s + p.n * (p.billing_cycle === 'year' ? Number(p.y) / 12 : Number(p.m)), 0);
    return {
      users, workspaces: ws, support, queue, ai,
      money: { mrr: Math.round(mrr) / 100, topups_30d: Number(money.topups_30d) / 100, crypto_to_check: money.crypto_to_check, withdrawals_waiting: withdrawals.n, withdrawals_total: Number(withdrawals.total) / 100 },
      sending,
      series: { signups, revenue: revenue.map((x) => ({ day: x.day, usd: Number(x.cents) / 100 })) },
      plans: plans.map((p) => ({ plan: p.plan_code, cycle: p.billing_cycle, workspaces: p.n })),
      integrations: config.integrations(), problems: config.problems(),
      stale_rates: staleRates.map((c) => ({ code: c.code, name: c.name, currency: c.currency, updated_at: c.rate_updated_at })),
    };
  }, { staff: 'overview.view' });

  require('./users')(r);
  require('./money')(r);
  require('./catalog')(r);
  require('./comms')(r);
  require('./team')(r);
};

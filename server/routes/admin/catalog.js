'use strict';
/* Admin → Pricing, Offers, Countries & payments, Features, Website text, Settings. All take effect without a deploy. */

const db = require('../../db');
const config = require('../../config');
const settings = require('../../services/settings');
const { FEATURES } = require('../../features');
const { audit } = require('../../services/audit');
const { str, int, cents, badRequest, notFound, bool } = require('../../lib/util');

const money = (v, name) => { const c = cents(v); if (!Number.isFinite(c) || c < 0 || c > 10000000) throw badRequest(`${name} must be a price like 49 or 49.99.`); return c; };
const changed = async (ctx, action, target, data) => { settings.bust(); await audit(ctx, action, target, data); return { ok: true }; };

module.exports = (r) => {
  /* ---------- Plans ---------- */
  r.get('/api/admin/plans', async () => {
    const plans = await db.many(`select p.*, (select count(*)::int from workspaces w where w.plan_code = p.code and w.plan_status in ('active','trial')) as workspaces from plans p order by sort, id`);
    return { plans: plans.map((p) => ({ ...p, price_month: Number(p.price_month_cents) / 100, price_year: Number(p.price_year_cents) / 100 })) };
  }, { staff: 'users.view' });

  async function planFields(b) {
    const bullets = (Array.isArray(b.bullets) ? b.bullets : String(b.bullets || '').split('\n')).map((x) => String(x).trim()).filter(Boolean).slice(0, 10).map((x) => x.slice(0, 80));
    return {
      name: str(b.name, 'Plan name', { min: 1, max: 30 }), tagline: str(b.tagline, 'Tagline', { max: 120, required: false }) || '',
      price_month_cents: money(b.price_month, 'Monthly price'), price_year_cents: money(b.price_year, 'Yearly price'),
      connections: int(b.connections, 'Connections', { min: 1, max: 1000 }), subscribers: int(b.subscribers, 'Subscribers', { min: 100, max: 100000000 }),
      ai_writes: int(b.ai_writes, 'AI writes', { min: 0, max: 1000000 }), seats: int(b.seats, 'Seats', { min: 1, max: 500 }),
      bullets, popular: bool(b.popular), active: b.active === undefined ? true : bool(b.active), sort: int(b.sort ?? 0, 'Order', { min: 0, max: 100 }),
    };
  }

  r.post('/api/admin/plans', async (ctx) => {
    const code = str(ctx.body.code, 'Plan code', { min: 2, max: 30 }).toLowerCase();
    if (!/^[a-z0-9_-]+$/.test(code)) throw badRequest('Plan code: lowercase letters, numbers, - and _ only.');
    const f = await planFields(ctx.body);
    if (await db.one('select 1 from plans where code = $1', [code])) throw badRequest('A plan with that code already exists.');
    if (f.popular) await db.query('update plans set popular = false');
    await db.query(`insert into plans(code,name,tagline,price_month_cents,price_year_cents,connections,subscribers,ai_writes,seats,bullets,popular,active,sort)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [code, f.name, f.tagline, f.price_month_cents, f.price_year_cents, f.connections, f.subscribers, f.ai_writes, f.seats, JSON.stringify(f.bullets), f.popular, f.active, f.sort]);
    return changed(ctx, 'plan.create', 'plan:' + code, f);
  }, { staff: 'pricing.edit' });

  r.put('/api/admin/plans/:code', async (ctx) => {
    const p = await db.one('select * from plans where code = $1', [ctx.params.code]);
    if (!p) throw notFound('That plan');
    const f = await planFields(ctx.body);
    if (!f.active) {
      const trial = await settings.get('trial');
      if (trial.plan === p.code) throw badRequest('This plan is used for free trials. Pick another trial plan in Settings first.');
    }
    if (f.popular) await db.query('update plans set popular = false where code <> $1', [p.code]);
    await db.query(`update plans set name=$2, tagline=$3, price_month_cents=$4, price_year_cents=$5, connections=$6, subscribers=$7, ai_writes=$8, seats=$9, bullets=$10, popular=$11, active=$12, sort=$13 where code = $1`,
      [p.code, f.name, f.tagline, f.price_month_cents, f.price_year_cents, f.connections, f.subscribers, f.ai_writes, f.seats, JSON.stringify(f.bullets), f.popular, f.active, f.sort]);
    // A price rise: everyone already paying for this plan keeps the old price for 30 days and gets an email now.
    let notified = 0;
    for (const cycle of ['month', 'year']) {
      const oldC = Number(cycle === 'year' ? p.price_year_cents : p.price_month_cents);
      const newC = cycle === 'year' ? f.price_year_cents : f.price_month_cents;
      if (newC <= oldC) continue;
      const rows = await db.many(`update workspaces set locked_price_cents = $3, locked_cycle = $2, locked_until = now() + interval '30 days'
        where plan_code = $1 and billing_cycle = $2 and plan_status = 'active' and (locked_until is null or locked_until < now()) returning id, owner_user_id, locked_until`, [p.code, cycle, oldC]);
      const email = require('../../services/email');
      const { fmtUSD, fmtDate } = require('../../lib/util');
      for (const w of rows) {
        const u = await db.one('select * from users where id = $1', [w.owner_user_id]);
        await email.send('price_change', u, { plan_name: f.name, old_price: fmtUSD(oldC), new_price: fmtUSD(newC), billing_period: cycle === 'year' ? 'year' : 'month', start_date: fmtDate(w.locked_until), billing_url: require('../../config').appUrl + '/#app/wallet' });
        notified++;
      }
    }
    await changed(ctx, 'plan.update', 'plan:' + p.code, { before: { m: p.price_month_cents, y: p.price_year_cents, active: p.active }, after: f, customers_notified: notified });
    return { ok: true, customers_notified: notified };
  }, { staff: 'pricing.edit' });

  /* ---------- Offers (top-up bonuses, coupons, banners) ---------- */
  r.get('/api/admin/offers', async () => ({ offers: await db.many('select * from offers order by kind, id') }), { staff: 'users.view' });

  function offerFields(b) {
    const kind = ['topup_bonus', 'coupon', 'banner'].includes(b.kind) ? b.kind : null;
    if (!kind) throw badRequest('Pick an offer type.');
    const date = (v) => { if (!v) return null; const d = new Date(v); if (Number.isNaN(d.getTime())) throw badRequest('Dates must be valid.'); return d; };
    const f = { kind, title: str(b.title, 'Title', { min: 2, max: 80 }), description: str(b.description, 'Description', { max: 300, required: false }) || '',
      starts_at: date(b.starts_at), ends_at: date(b.ends_at), active: b.active === undefined ? true : bool(b.active),
      max_uses: b.max_uses === '' || b.max_uses == null ? null : int(b.max_uses, 'Max uses', { min: 1, max: 1000000 }),
      code: null, percent: null, months: 1, min_topup_cents: null, bonus_cents: null, link_url: null };
    if (kind === 'coupon') {
      f.code = str(b.code, 'Code', { min: 3, max: 30 }).toUpperCase();
      if (!/^[A-Z0-9_-]+$/.test(f.code)) throw badRequest('Codes use letters, numbers, - and _ only.');
      f.percent = int(b.percent, 'Discount %', { min: 1, max: 100 });
      f.months = int(b.months ?? 1, 'Months', { min: 1, max: 24 });
    }
    if (kind === 'topup_bonus') {
      f.min_topup_cents = money(b.min_topup, 'Top-up from');
      f.bonus_cents = money(b.bonus, 'Bonus');
      if (f.bonus_cents > f.min_topup_cents / 2) throw badRequest('The bonus should not be more than half of the top-up.');
    }
    if (kind === 'banner') f.link_url = str(b.link_url, 'Link', { max: 300, required: false }) || null;
    return f;
  }

  r.post('/api/admin/offers', async (ctx) => {
    const f = offerFields(ctx.body);
    if (f.code && (await db.one('select 1 from offers where code = $1', [f.code]))) throw badRequest('That code already exists.');
    const row = await db.one(`insert into offers(kind,title,description,code,percent,months,min_topup_cents,bonus_cents,link_url,starts_at,ends_at,max_uses,active)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`, [f.kind, f.title, f.description, f.code, f.percent, f.months, f.min_topup_cents, f.bonus_cents, f.link_url, f.starts_at, f.ends_at, f.max_uses, f.active]);
    return changed(ctx, 'offer.create', 'offer:' + row.id, f);
  }, { staff: 'offers.edit' });

  r.put('/api/admin/offers/:id', async (ctx) => {
    const id = int(ctx.params.id, 'Offer');
    const f = offerFields(ctx.body);
    const row = await db.one(`update offers set kind=$2,title=$3,description=$4,code=$5,percent=$6,months=$7,min_topup_cents=$8,bonus_cents=$9,link_url=$10,starts_at=$11,ends_at=$12,max_uses=$13,active=$14 where id = $1 returning id`,
      [id, f.kind, f.title, f.description, f.code, f.percent, f.months, f.min_topup_cents, f.bonus_cents, f.link_url, f.starts_at, f.ends_at, f.max_uses, f.active]);
    if (!row) throw notFound('That offer');
    return changed(ctx, 'offer.update', 'offer:' + id, f);
  }, { staff: 'offers.edit' });

  r.post('/api/admin/offers/:id/toggle', async (ctx) => {
    const id = int(ctx.params.id, 'Offer');
    const row = await db.one('update offers set active = $2 where id = $1 returning id, active', [id, bool(ctx.body.active)]);
    if (!row) throw notFound('That offer');
    return changed(ctx, row.active ? 'offer.on' : 'offer.off', 'offer:' + id, {});
  }, { staff: 'offers.edit' });

  r.delete('/api/admin/offers/:id', async (ctx) => {
    const id = int(ctx.params.id, 'Offer');
    const used = await db.one('select 1 from workspaces where coupon_id = $1 limit 1', [id]);
    if (used) { await db.query('update offers set active = false where id = $1', [id]); return changed(ctx, 'offer.off', 'offer:' + id, { note: 'in use, switched off instead of deleted' }); }
    await db.query('delete from offers where id = $1', [id]);
    return changed(ctx, 'offer.delete', 'offer:' + id, {});
  }, { staff: 'offers.edit' });

  /* ---------- Countries and payment methods ---------- */
  r.get('/api/admin/countries', async () => ({
    countries: await db.many('select c.*, (select count(*)::int from users u where u.country = c.code) as users from countries c order by sort, name'),
    methods: await db.many('select * from payment_methods order by sort'),
    integrations: config.integrations(),
  }), { staff: 'users.view' });

  r.put('/api/admin/countries/:code', async (ctx) => {
    const code = String(ctx.params.code).toUpperCase();
    const b = ctx.body;
    const known = new Set((await db.many('select key from payment_methods')).map((m) => m.key));
    const methods = (Array.isArray(b.methods) ? b.methods : []).filter((k) => known.has(k));
    const rate = Number(b.usd_rate);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 1000000) throw badRequest('Exchange rate must be a positive number (local money per 1 US dollar).');
    const cur = str(b.currency, 'Currency', { min: 3, max: 3 }).toUpperCase();
    const f = [code, str(b.name, 'Country name', { min: 2, max: 60 }), str(b.flag, 'Flag', { max: 8, required: false }) || '🌍', cur, rate, JSON.stringify(methods), bool(b.featured), b.active === undefined ? true : bool(b.active), int(b.sort ?? 100, 'Order', { min: 0, max: 999 })];
    await db.query(`insert into countries(code,name,flag,currency,usd_rate,methods,featured,active,sort) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      on conflict (code) do update set name=excluded.name, flag=excluded.flag, currency=excluded.currency, usd_rate=excluded.usd_rate, methods=excluded.methods, featured=excluded.featured, active=excluded.active, sort=excluded.sort,
        rate_updated_at = case when countries.usd_rate is distinct from excluded.usd_rate or countries.currency is distinct from excluded.currency then now() else countries.rate_updated_at end`, f);
    return changed(ctx, 'country.save', 'country:' + code, { currency: cur, usd_rate: rate, methods });
  }, { staff: 'countries.edit' });

  r.put('/api/admin/methods/:key', async (ctx) => {
    const m = await db.one('select * from payment_methods where key = $1', [ctx.params.key]);
    if (!m) throw notFound('That payment method');
    await db.query('update payment_methods set label = $2, detail = $3, active = $4 where key = $1',
      [m.key, str(ctx.body.label, 'Label', { min: 1, max: 40 }), str(ctx.body.detail, 'Detail', { max: 80, required: false }) || '', ctx.body.active === undefined ? m.active : bool(ctx.body.active)]);
    return changed(ctx, 'method.save', 'method:' + m.key, ctx.body);
  }, { staff: 'countries.edit' });

  /* ---------- Feature switches ---------- */
  r.get('/api/admin/features', async () => {
    const f = await settings.features();
    return { features: FEATURES.map((x) => ({ ...x, enabled: !!f[x.key] })), integrations: config.integrations() };
  }, { staff: 'overview.view' });

  r.post('/api/admin/features/:key', async (ctx) => {
    const feat = FEATURES.find((x) => x.key === ctx.params.key);
    if (!feat) throw notFound('That feature');
    const enabled = bool(ctx.body.enabled);
    await db.query('insert into feature_flags(key, enabled, updated_at) values ($1,$2, now()) on conflict (key) do update set enabled = excluded.enabled, updated_at = now()', [feat.key, enabled]);
    return changed(ctx, enabled ? 'feature.on' : 'feature.off', 'feature:' + feat.key, {});
  }, { staff: 'features.edit' });

  /* ---------- Website text ---------- */
  r.get('/api/admin/content', async () => ({ content: (await settings.load()).content }), { staff: 'overview.view' });

  r.put('/api/admin/content/:key', async (ctx) => {
    const key = String(ctx.params.key);
    if (!/^[a-z0-9_]{2,40}$/.test(key)) throw badRequest('Bad key.');
    if (ctx.body.value === undefined || ctx.body.value === null) throw badRequest('Send the new text as "value".'); // was a 500
    let value = typeof ctx.body.value === 'string' ? ctx.body.value : JSON.stringify(ctx.body.value);
    if (value.length > 20000) throw badRequest('That text is too long.');
    if (key === 'faq') {
      let arr;
      try { arr = JSON.parse(value); } catch { throw badRequest('FAQ must be a list of questions and answers.'); }
      if (!Array.isArray(arr) || arr.some((x) => !x || !x.q || !x.a)) throw badRequest('Every FAQ item needs a question and an answer.');
      value = JSON.stringify(arr.slice(0, 30).map((x) => ({ q: String(x.q).slice(0, 200), a: String(x.a).slice(0, 1500) })));
    }
    await db.query('insert into site_content(key, value, updated_at) values ($1,$2, now()) on conflict (key) do update set value = excluded.value, updated_at = now()', [key, value]);
    return changed(ctx, 'content.save', 'content:' + key, { length: value.length });
  }, { staff: 'content.edit' });

  /* ---------- Settings ---------- */
  r.get('/api/admin/settings', async () => {
    const s = (await settings.load()).settings;
    return { settings: s, integrations: config.integrations(), problems: config.problems(), gatevoo: { configured: config.integrations().gatevoo, url: config.gatevoo.url || null, on: await settings.gatevooOn() } };
  }, { staff: 'overview.view' });

  const VALIDATE = {
    company: (v) => ({ name: str(v.name, 'Company name', { min: 2, max: 80 }), address: str(v.address, 'Address', { min: 2, max: 200 }),
      support_email: str(v.support_email, 'Support email', { min: 5, max: 120 }), privacy_email: str(v.privacy_email, 'Privacy email', { min: 5, max: 120 }), billing_email: str(v.billing_email, 'Billing email', { min: 5, max: 120 }) }),
    trial: async (v) => {
      const plan = await settings.plan(String(v.plan));
      if (!plan || !plan.active) throw badRequest('Pick an active plan for the trial.');
      return { days: int(v.days, 'Trial days', { min: 0, max: 60 }), plan: plan.code, ai_writes: int(v.ai_writes, 'Trial AI writes', { min: 0, max: 100000 }) };
    },
    billing: (v) => ({ refund_days: int(v.refund_days, 'Refund days', { min: 0, max: 90 }), data_retention_days: int(v.data_retention_days, 'Keep data for (days)', { min: 7, max: 3650 }),
      min_topup_cents: money(v.min_topup, 'Minimum top-up'), max_topup_cents: money(v.max_topup, 'Maximum top-up'), renew_reminder_days: int(v.renew_reminder_days, 'Reminder days', { min: 1, max: 14 }) }),
    referral: (v) => {
      const rates = [int(v.rate_1, 'Tier 1 %', { min: 0, max: 60 }), int(v.rate_2, 'Tier 2 %', { min: 0, max: 60 }), int(v.rate_3, 'Tier 3 %', { min: 0, max: 60 })];
      const t2 = int(v.tier2_min, 'Tier 2 starts at', { min: 2, max: 1000 }), t3 = int(v.tier3_min, 'Tier 3 starts at', { min: 3, max: 10000 });
      if (t3 <= t2) throw badRequest('Tier 3 must start higher than tier 2.');
      return { rates, tier2_min: t2, tier3_min: t3, settle_days: int(v.settle_days, 'Settle days', { min: 0, max: 120 }), min_withdraw_cents: money(v.min_withdraw, 'Minimum withdrawal'), cookie_days: int(v.cookie_days, 'Referral cookie days', { min: 1, max: 365 }) };
    },
    ai: (v) => ({ model: str(v.model, 'Model', { min: 3, max: 80 }), max_output_tokens: int(v.max_output_tokens, 'Max answer length', { min: 200, max: 4000 }),
      temperature: Math.max(0, Math.min(1, Number(v.temperature) || 0.7)), house_rules: str(v.house_rules, 'House rules', { max: 4000, required: false }) || '' }),
    crypto: (v) => {
      const usdt = (str(v.usdt_address, 'USDT address', { max: 100, required: false }) || '').trim();
      const btc = (str(v.btc_address, 'BTC address', { max: 100, required: false }) || '').trim();
      if (usdt && !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(usdt)) throw badRequest('The USDT address must be a TRON (TRC20) address starting with T.');
      if (btc && !/^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(btc)) throw badRequest('That is not a valid Bitcoin address.');
      return { use_gatevoo: v.use_gatevoo === undefined ? true : bool(v.use_gatevoo), usdt_address: usdt, btc_address: btc };
    },
    support: (v) => ({ reply_time: str(v.reply_time, 'Reply time text', { min: 5, max: 200 }), telegram_username: (str(v.telegram_username, 'Telegram username', { max: 40, required: false }) || '').replace(/^@/, '') }),
    legal_updated: (v) => str(v, 'Last updated date', { min: 4, max: 40 }),
  };

  r.put('/api/admin/settings/:key', async (ctx) => {
    const key = ctx.params.key;
    const fn = VALIDATE[key];
    if (!fn) throw notFound('That setting');
    const perms = require('../../permissions');
    if (key === 'crypto' && ctx.user.staff_role !== 'owner') throw require('../../lib/util').forbidden('Only an Owner can change where crypto payments go.');
    const moneyKey = ['crypto', 'referral', 'billing'].includes(key);
    if (moneyKey ? !['owner', 'admin', 'finance'].includes(ctx.user.staff_role) : !perms.can(ctx.user.staff_role, 'settings.edit')) {
      throw require('../../lib/util').forbidden(moneyKey ? 'Only Owner, Admin or Finance can change money settings.' : 'Your team role does not allow this.');
    }
    const value = await fn(ctx.body.value === undefined ? ctx.body : ctx.body.value);
    const before = await settings.get(key);
    await db.query('insert into settings(key, value, updated_at) values ($1,$2, now()) on conflict (key) do update set value = excluded.value, updated_at = now()', [key, JSON.stringify(value)]);
    return changed(ctx, 'settings.' + key, 'settings:' + key, { before, after: value });
  }, { staff: 'overview.view' });
};

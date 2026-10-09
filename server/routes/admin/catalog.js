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

/* What a plan can include (Admin → Pricing ticks these). Keys are checked in services/billing.js hasFeature(). */
const PLAN_FEATURES = [
  { key: 'auto_approve', name: 'Auto-approve join requests' },
  { key: 'welcome_message', name: 'Welcome message' },
  { key: 'welcome_flows', name: 'Welcome Flows builder (follow-up steps, manual approval, invite links)' },
  { key: 'tap_to_start', name: 'Tap to start / Tap to join button' },
  { key: 'broadcasts', name: 'Broadcasts' },
  { key: 'schedule', name: 'Schedule and 9am sending' },
  { key: 'drips', name: 'Auto follow-ups' },
  { key: 'tracked_buttons', name: 'Tracked buttons' },
  { key: 'basic_stats', name: 'Basic stats' },
  { key: 'ai', name: 'Cas AI' },
  { key: 'ab_welcome_2', name: 'A/B welcome (2 versions)' },
  { key: 'condition_clicked', name: 'Clicked / didn\'t click conditions' },
  { key: 'audiences', name: 'Audiences' },
  { key: 'start_links', name: 'Start links' },
  { key: 'flow_funnel_stats', name: 'Flow funnel and A/B stats' },
  { key: 'ab_welcome_4', name: 'A/B welcome (up to 4 versions)' },
  { key: 'onboarding_call', name: 'Onboarding call' },
];

/* ---------- Manual payment methods: checking what the admin typed ---------- */
const METHOD_KINDS = [
  { key: 'bank', name: 'Bank transfer', icon: '🏦', color: '#2F6BFF' },
  { key: 'mobile_money', name: 'Mobile money', icon: '📱', color: '#F59E0B' },
  { key: 'crypto_wallet', name: 'Crypto wallet', icon: '₮', color: '#26A17B' },
  { key: 'other', name: 'Other', icon: '$', color: '#0B1430' },
];
const PROOF = ['off', 'optional', 'required'];
// Keys the code already uses for something else.
const RESERVED_KEYS = ['gatevoo', 'usdt', 'btc', 'crypto', 'manual', 'new'];
const pick = (m) => ({ label: m.label, detail: m.detail, active: m.active, kind: m.kind, currency: m.currency, min_cents: m.min_cents, max_cents: m.max_cents, all_countries: m.all_countries, countries: m.countries });
const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);

/** Pick a free key: the one typed, or one made from the name (e.g. "GTBank transfer" → gtbank_transfer). */
async function methodKey(typed, label) {
  const taken = new Set((await db.many('select key from payment_methods')).map((r) => r.key));
  if (typed !== undefined && typed !== null && String(typed).trim() !== '') {
    const k = String(typed).trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]{1,29}$/.test(k)) throw badRequest('Key: 2 to 30 lowercase letters, numbers and _, starting with a letter.');
    if (taken.has(k) || RESERVED_KEYS.includes(k)) throw badRequest('That key is already used. Pick another, or leave it empty.');
    return k;
  }
  let base = slug(label);
  if (!/^[a-z]/.test(base)) base = ('pay_' + base).replace(/_+$/, '');
  if (base.length < 2) base = 'pay';
  let k = base, i = 2;
  while (taken.has(k) || RESERVED_KEYS.includes(k)) k = `${base}_${i++}`;
  return k;
}

/** Validate a manual method. `cur` is the saved row when editing: fields left out keep their value. */
async function manualFields(b, cur = null) {
  const v = (k, curKey = k) => (b[k] !== undefined ? b[k] : cur ? cur[curKey] : undefined);
  const kind = v('kind') || 'bank';
  const K = METHOD_KINDS.find((x) => x.key === kind);
  if (!K) throw badRequest('Pick what kind of method this is.');
  const icon = str(v('icon'), 'Icon', { max: 8, required: false }) || K.icon;
  if ([...icon].length > 3) throw badRequest('Icon: one emoji or up to 3 letters.');
  const color = str(v('color'), 'Colour', { max: 7, required: false }) || K.color;
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw badRequest('Colour must look like #2F6BFF.');
  const instructions = str(v('instructions'), 'Instructions for the customer', { min: 10, max: 2000 }).replace(/\r\n?/g, '\n');
  if (instructions.split('\n').length > 30) throw badRequest('Instructions: 30 lines at most.');
  let currency = (str(v('currency'), 'Currency', { max: 3, required: false }) || '').toUpperCase();
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw badRequest('Currency is a 3-letter code like NGN or KES. Leave it empty for US dollars.');
  if (currency === 'USD') currency = '';
  const rateIn = b.usd_rate !== undefined ? b.usd_rate : cur ? cur.usd_rate : null;
  let usd_rate = null;
  if (currency && rateIn !== null && rateIn !== undefined && rateIn !== '') {
    usd_rate = Number(rateIn);
    if (!Number.isFinite(usd_rate) || usd_rate <= 0 || usd_rate > 1000000) throw badRequest('Exchange rate must be a positive number (local money per 1 US dollar).');
  }
  const amt = (k, ck, name) => {
    const x = b[k] !== undefined ? b[k] : cur && cur[ck] != null ? Number(cur[ck]) / 100 : null;
    return x === null || x === undefined || x === '' ? null : money(x, name);
  };
  const min_cents = amt('min', 'min_cents', 'Smallest top-up');
  const max_cents = amt('max', 'max_cents', 'Largest top-up');
  if (min_cents !== null && max_cents !== null && max_cents < min_cents) throw badRequest('The largest top-up must be more than the smallest.');
  const proof_ref = v('proof_ref') || 'required', proof_image = v('proof_image') || 'optional';
  if (!PROOF.includes(proof_ref) || !PROOF.includes(proof_image)) throw badRequest('Proof must be off, optional or required.');
  const all_countries = bool(v('all_countries'));
  let countries = [];
  if (!all_countries) {
    const list = Array.isArray(v('countries')) ? v('countries') : [];
    const known = new Set((await db.many('select code from countries')).map((c) => c.code));
    countries = [...new Set(list.map((c) => String(c).toUpperCase()))].filter((c) => known.has(c)).slice(0, 300);
    if (!countries.length) throw badRequest('Pick at least one country, or "All countries".');
  }
  return {
    label: str(v('label'), 'Name', { min: 2, max: 40 }), detail: str(v('detail'), 'Short detail', { max: 80, required: false }) || '',
    kind, icon, color, instructions, currency: currency || null, usd_rate, min_cents, max_cents, proof_ref, proof_image, all_countries, countries,
    sort: int(v('sort') ?? 50, 'Order', { min: 0, max: 999 }), active: v('active') === undefined ? true : bool(v('active')),
  };
}

module.exports = (r) => {
  /* ---------- Plans ---------- */
  r.get('/api/admin/plans', async () => {
    const plans = await db.many(`select p.*, (select count(*)::int from workspaces w where w.plan_code = p.code and w.plan_status in ('active','trial')) as workspaces from plans p order by sort, id`);
    return { plans: plans.map((p) => ({ ...p, price_month: Number(p.price_month_cents) / 100, price_year: Number(p.price_year_cents) / 100 })) };
  }, { staff: 'users.view' });

  /** -1 = unlimited. Empty = keep `cur` (or the default for a new plan). */
  const limit = (v, name, cur, def) => (v === undefined || v === null || v === '' ? (cur ?? def) : int(v, name, { min: -1, max: 100000000 }));
  async function planFields(b, cur = null) {
    const bullets = (Array.isArray(b.bullets) ? b.bullets : String(b.bullets || '').split('\n')).map((x) => String(x).trim()).filter(Boolean).slice(0, 10).map((x) => x.slice(0, 80));
    let features = cur ? cur.features : PLAN_FEATURES.filter((f) => !['ab_welcome_4', 'onboarding_call'].includes(f.key)).map((f) => f.key);
    if (b.features !== undefined) {
      const list = Array.isArray(b.features) ? b.features : String(b.features || '').split(/[\s,]+/);
      const known = new Set(PLAN_FEATURES.map((f) => f.key));
      const bad = list.map((x) => String(x).trim()).filter((x) => x && !known.has(x));
      if (bad.length) throw badRequest(`Unknown feature: ${bad.join(', ')}.`);
      features = [...new Set(list.map((x) => String(x).trim()).filter(Boolean))];
    }
    const f = {
      name: str(b.name, 'Plan name', { min: 1, max: 30 }), tagline: str(b.tagline, 'Tagline', { max: 120, required: false }) || '',
      price_month_cents: money(b.price_month, 'Monthly price'), price_year_cents: money(b.price_year, 'Yearly price'),
      connections: int(b.connections, 'Connections', { min: 1, max: 1000 }), subscribers: int(b.subscribers, 'Subscribers', { min: 0, max: 100000000 }),
      ai_writes: int(b.ai_writes, 'AI writes', { min: 0, max: 1000000 }), seats: int(b.seats, 'Seats', { min: 1, max: 500 }),
      join_requests: limit(b.join_requests, 'Join requests a month', cur && cur.join_requests, 5000),
      flows: limit(b.flows, 'Welcome Flows', cur && cur.flows, 3), flow_steps: limit(b.flow_steps, 'Steps per flow', cur && cur.flow_steps, 5),
      branding: b.branding === undefined ? (cur ? !!cur.branding : false) : bool(b.branding), features,
      bullets, popular: bool(b.popular), active: b.active === undefined ? true : bool(b.active), sort: int(b.sort ?? 0, 'Order', { min: 0, max: 100 }),
    };
    if (f.flow_steps === 0) throw badRequest('Steps per flow must be at least 1 (or -1 for unlimited).');
    return f;
  }

  r.get('/api/admin/plan-features', async () => ({ features: PLAN_FEATURES }), { staff: 'users.view' });

  r.post('/api/admin/plans', async (ctx) => {
    const code = str(ctx.body.code, 'Plan code', { min: 2, max: 30 }).toLowerCase();
    if (!/^[a-z0-9_-]+$/.test(code)) throw badRequest('Plan code: lowercase letters, numbers, - and _ only.');
    const f = await planFields(ctx.body);
    if (await db.one('select 1 from plans where code = $1', [code])) throw badRequest('A plan with that code already exists.');
    if (f.popular) await db.query('update plans set popular = false');
    await db.query(`insert into plans(code,name,tagline,price_month_cents,price_year_cents,connections,subscribers,ai_writes,seats,bullets,popular,active,sort,join_requests,flows,flow_steps,branding,features)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`, [code, f.name, f.tagline, f.price_month_cents, f.price_year_cents, f.connections, f.subscribers, f.ai_writes, f.seats, JSON.stringify(f.bullets), f.popular, f.active, f.sort,
      f.join_requests, f.flows, f.flow_steps, f.branding, JSON.stringify(f.features)]);
    return changed(ctx, 'plan.create', 'plan:' + code, f);
  }, { staff: 'pricing.edit' });

  r.put('/api/admin/plans/:code', async (ctx) => {
    const p = await db.one('select * from plans where code = $1', [ctx.params.code]);
    if (!p) throw notFound('That plan');
    const f = await planFields(ctx.body, p);
    if (!f.active) {
      const trial = await settings.get('trial');
      if (trial.plan === p.code) throw badRequest('This plan is used for free trials. Pick another trial plan in Settings first.');
    }
    if (f.popular) await db.query('update plans set popular = false where code <> $1', [p.code]);
    if (p.code === 'free' && (f.price_month_cents > 0 || f.price_year_cents > 0)) throw badRequest('The Free plan must stay at $0. Workspaces drop to it when a plan ends.');
    await db.query(`update plans set name=$2, tagline=$3, price_month_cents=$4, price_year_cents=$5, connections=$6, subscribers=$7, ai_writes=$8, seats=$9, bullets=$10, popular=$11, active=$12, sort=$13,
      join_requests=$14, flows=$15, flow_steps=$16, branding=$17, features=$18 where code = $1`,
      [p.code, f.name, f.tagline, f.price_month_cents, f.price_year_cents, f.connections, f.subscribers, f.ai_writes, f.seats, JSON.stringify(f.bullets), f.popular, f.active, f.sort,
        f.join_requests, f.flows, f.flow_steps, f.branding, JSON.stringify(f.features)]);
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
    methods: (await db.many(`select m.*, (select count(*)::int from payments p where p.method_key = m.key) as payments
      from payment_methods m where m.deleted_at is null order by m.sort, m.key`)).map((m) => ({
      ...m, usd_rate: m.usd_rate == null ? null : Number(m.usd_rate), min: m.min_cents == null ? null : Number(m.min_cents) / 100, max: m.max_cents == null ? null : Number(m.max_cents) / 100 })),
    method_kinds: METHOD_KINDS,
    integrations: config.integrations(),
  }), { staff: 'users.view' });

  r.put('/api/admin/countries/:code', async (ctx) => {
    const code = String(ctx.params.code).toUpperCase();
    const b = ctx.body;
    // Manual methods pick their countries themselves (on the method), so only automatic ones are listed per country.
    const known = new Set((await db.many("select key from payment_methods where provider <> 'manual'")).map((m) => m.key));
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

  /*
   * Payment methods. The seeded ones (Paystack, Flutterwave, crypto) are automatic: only their name, detail and
   * on/off change here, and they can't be deleted. The team adds its own "manual" methods (bank transfer, mobile
   * money, a crypto wallet...): customers see the instructions, pay, send proof, and Finance approves in Payments.
   * A new AUTOMATIC gateway needs code: see the steps at the top of server/payments/index.js.
   */
  r.post('/api/admin/methods', async (ctx) => {
    const f = await manualFields(ctx.body);
    const key = await methodKey(ctx.body.key, f.label);
    await db.query(`insert into payment_methods(key, provider, label, detail, color, icon, active, sort, kind, instructions, currency, usd_rate, min_cents, max_cents, proof_ref, proof_image, all_countries, countries)
      values ($1,'manual',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [key, f.label, f.detail, f.color, f.icon, f.active, f.sort, f.kind, f.instructions, f.currency, f.usd_rate, f.min_cents, f.max_cents, f.proof_ref, f.proof_image, f.all_countries, JSON.stringify(f.countries)]);
    await changed(ctx, 'method.create', 'method:' + key, f);
    return { ok: true, key };
  }, { staff: 'countries.edit' });

  r.put('/api/admin/methods/:key', async (ctx) => {
    const m = await db.one('select * from payment_methods where key = $1 and deleted_at is null', [ctx.params.key]);
    if (!m) throw notFound('That payment method');
    if (m.provider === 'manual') {
      const f = await manualFields(ctx.body, m);
      await db.query(`update payment_methods set label=$2, detail=$3, color=$4, icon=$5, active=$6, sort=$7, kind=$8, instructions=$9, currency=$10, usd_rate=$11,
        min_cents=$12, max_cents=$13, proof_ref=$14, proof_image=$15, all_countries=$16, countries=$17 where key = $1`,
      [m.key, f.label, f.detail, f.color, f.icon, f.active, f.sort, f.kind, f.instructions, f.currency, f.usd_rate, f.min_cents, f.max_cents, f.proof_ref, f.proof_image, f.all_countries, JSON.stringify(f.countries)]);
      return changed(ctx, 'method.save', 'method:' + m.key, { before: pick(m), after: f });
    }
    const after = { label: str(ctx.body.label, 'Label', { min: 1, max: 40 }), detail: str(ctx.body.detail, 'Detail', { max: 80, required: false }) || '', active: ctx.body.active === undefined ? m.active : bool(ctx.body.active) };
    await db.query('update payment_methods set label = $2, detail = $3, active = $4 where key = $1', [m.key, after.label, after.detail, after.active]);
    return changed(ctx, 'method.save', 'method:' + m.key, { before: { label: m.label, detail: m.detail, active: m.active }, after });
  }, { staff: 'countries.edit' });

  /** Delete a manual method. One that payments point to is switched off and hidden instead, so their history keeps its name. */
  r.delete('/api/admin/methods/:key', async (ctx) => {
    const m = await db.one('select * from payment_methods where key = $1 and deleted_at is null', [ctx.params.key]);
    if (!m) throw notFound('That payment method');
    if (m.provider !== 'manual') throw badRequest('Built-in payment methods can\'t be deleted. Switch it off instead.');
    const used = await db.one('select count(*)::int n, count(*) filter (where status = \'pending\')::int pending from payments where method_key = $1', [m.key]);
    if (used.pending) throw badRequest(`${used.pending === 1 ? 'A customer has' : used.pending + ' customers have'} an open payment with this method. Approve or reject ${used.pending === 1 ? 'it' : 'them'} in Payments first, or just switch the method off.`);
    if (used.n) {
      await db.query('update payment_methods set active = false, deleted_at = now() where key = $1', [m.key]);
      await changed(ctx, 'method.delete', 'method:' + m.key, { label: m.label, note: 'payments use it, so it was switched off and hidden instead of deleted' });
      return { ok: true, hidden: true };
    }
    await db.query('delete from payment_methods where key = $1', [m.key]);
    await changed(ctx, 'method.delete', 'method:' + m.key, { label: m.label });
    return { ok: true, hidden: false };
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
    // ai_provider holds the encrypted AI key: it has its own endpoint (GET /api/admin/ai/provider) that never returns it.
    const { ai_provider: _secret, ...s } = (await settings.load()).settings;
    return { settings: s, integrations: config.integrations(), problems: config.problems(), gatevoo: { configured: config.integrations().gatevoo, url: config.gatevoo.url || null, on: await settings.gatevooOn() } };
  }, { staff: 'overview.view' });

  const VALIDATE = {
    company: (v) => ({ name: str(v.name, 'Company name', { min: 2, max: 80 }), address: str(v.address, 'Address', { min: 2, max: 200 }),
      support_email: str(v.support_email, 'Support email', { min: 5, max: 120 }), privacy_email: str(v.privacy_email, 'Privacy email', { min: 5, max: 120 }), billing_email: str(v.billing_email, 'Billing email', { min: 5, max: 120 }) }),
    trial: async (v) => {
      const plan = await settings.plan(String(v.plan));
      if (!plan || !plan.active) throw badRequest('Pick an active plan for the trial.');
      if (Number(plan.price_month_cents) === 0) throw badRequest('Pick a paid plan for the trial.');
      const cur = await settings.get('trial');
      const jr = v.join_requests === undefined || v.join_requests === '' ? (cur.join_requests ?? 3000) : int(v.join_requests, 'Trial join requests', { min: -1, max: 10000000 });
      return { days: int(v.days, 'Trial days', { min: 0, max: 60 }), plan: plan.code, ai_writes: int(v.ai_writes, 'Trial AI writes', { min: 0, max: 100000 }), join_requests: jr, on_end: 'free' };
    },
    billing: async (v) => {
      const cur = (await settings.get('billing')) || {};
      return { refund_days: int(v.refund_days, 'Refund days', { min: 0, max: 90 }), data_retention_days: int(v.data_retention_days, 'Keep data for (days)', { min: 7, max: 3650 }),
        min_topup_cents: money(v.min_topup, 'Minimum top-up'), max_topup_cents: money(v.max_topup, 'Maximum top-up'), renew_reminder_days: int(v.renew_reminder_days, 'Reminder days', { min: 1, max: 14 }),
        limit_grace_pct: v.limit_grace_pct === undefined || v.limit_grace_pct === '' ? 10 : int(v.limit_grace_pct, 'Extra join requests before welcomes pause (%)', { min: 0, max: 100 }),
        // AUD-6: a Free workspace with no login and no join requests for this long is inactive, and its data is deleted.
        inactive_free_days: v.inactive_free_days === undefined || v.inactive_free_days === '' ? (cur.inactive_free_days ?? 365) : int(v.inactive_free_days, 'Delete inactive Free workspaces after (days)', { min: 90, max: 3650 }),
        // Extra team seats on paid plans, per seat per month (yearly plans pay 12 months). 0 = not sold.
        seat_price_cents: v.seat_price === undefined || v.seat_price === '' ? Number(cur.seat_price_cents ?? 500) : Math.min(money(v.seat_price, 'Extra team seat price'), 100000) };
    },
    referral: async (v) => {
      // AUD-1: one commission per payment, never more than 50% of the cash (minus processor fees), 35% on yearly payments.
      const cur = (await settings.get('referral')) || {};
      const keep = (k, label, max, dflt) => (v[k] === undefined || v[k] === '' ? Math.min(max, Number(cur[k] ?? dflt)) : int(v[k], label, { min: 0, max }));
      const flag = (k, dflt) => (v[k] === undefined ? (cur[k] ?? dflt) !== false : bool(v[k]));
      const cap = keep('commission_cap_pct', 'Highest commission (%)', 50, 50);
      const rates = [int(v.rate_1, 'Tier 1 %', { min: 0, max: cap }), int(v.rate_2, 'Tier 2 %', { min: 0, max: cap }), int(v.rate_3, 'Tier 3 %', { min: 0, max: cap })];
      const t2 = int(v.tier2_min, 'Tier 2 starts at', { min: 2, max: 1000 }), t3 = int(v.tier3_min, 'Tier 3 starts at', { min: 3, max: 10000 });
      if (t3 <= t2) throw badRequest('Tier 3 must start higher than tier 2.');
      return { rates, tier2_min: t2, tier3_min: t3, settle_days: int(v.settle_days, 'Settle days', { min: 0, max: 120 }), min_withdraw_cents: money(v.min_withdraw, 'Minimum withdrawal'), cookie_days: int(v.cookie_days, 'Referral cookie days', { min: 1, max: 365 }),
        commission_cap_pct: cap, yearly_cap_pct: Math.min(cap, keep('yearly_cap_pct', 'Highest commission on yearly payments (%)', 50, 35)),
        first_attribution: flag('first_attribution', true), net_of_fees: flag('net_of_fees', true) };
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
    // Referral rates, settle days and the minimum withdrawal decide what gets paid out; Finance pays withdrawals,
    // so Finance must not also set these rules (SEC-14). Billing limits stay open to Finance.
    if (key === 'referral' && !perms.can(ctx.user.staff_role, 'money_settings.edit')) throw require('../../lib/util').forbidden('Only Owner or Admin can change referral rates and payout rules.');
    const moneyKey = ['crypto', 'billing'].includes(key);
    if (key !== 'referral' && (moneyKey ? !['owner', 'admin', 'finance'].includes(ctx.user.staff_role) : !perms.can(ctx.user.staff_role, 'settings.edit'))) {
      throw require('../../lib/util').forbidden(moneyKey ? 'Only Owner, Admin or Finance can change money settings.' : 'Your team role does not allow this.');
    }
    const value = await fn(ctx.body.value === undefined ? ctx.body : ctx.body.value);
    const before = await settings.get(key);
    await db.query('insert into settings(key, value, updated_at) values ($1,$2, now()) on conflict (key) do update set value = excluded.value, updated_at = now()', [key, JSON.stringify(value)]);
    return changed(ctx, 'settings.' + key, 'settings:' + key, { before, after: value });
  }, { staff: 'settings.save' });
};

'use strict';
/*
 * Everything the team can change in the admin panel without a deploy:
 * settings, feature switches, website text, plans, countries, payment methods, offers.
 * Values are cached for 15 seconds so the database isn't asked on every request.
 * Call bust() after a change so this server sees it at once.
 */

const db = require('../db');
const config = require('../config');
const { DEFAULTS } = require('../features');
const { SETTINGS } = require('../seed');
const { forbidden, httpError } = require('../lib/util');

let cache = null, cacheAt = 0;
const TTL = 15000;

async function load() {
  if (cache && Date.now() - cacheAt < TTL) return cache;
  const [settings, flags, content, plans, methods, countries, offers] = await Promise.all([
    db.many('select key, value from settings'),
    db.many('select key, enabled from feature_flags'),
    db.many('select key, value from site_content'),
    db.many('select * from plans order by sort, id'),
    db.many('select * from payment_methods order by sort, key'),
    db.many('select * from countries order by sort, name'),
    db.many('select * from offers order by id'),
  ]);
  const s = { ...SETTINGS };
  for (const r of settings) s[r.key] = r.value;
  const f = { ...DEFAULTS };
  for (const r of flags) f[r.key] = r.enabled;
  cache = {
    settings: s,
    features: f,
    content: Object.fromEntries(content.map((r) => [r.key, r.value])),
    plans, methods, countries, offers,
  };
  cacheAt = Date.now();
  return cache;
}
function bust() { cache = null; }
/** The last loaded settings without waiting (null when nothing is loaded yet). For sync callers only. */
const peek = () => (cache ? cache.settings : null);

const get = async (key) => (await load()).settings[key];
const features = async () => (await load()).features;
async function feature(key) { return !!(await features())[key]; }
/** Throw a friendly error if a feature is switched off. */
async function requireFeature(key, message) {
  const f = await features();
  if (f.maintenance && ['broadcasts', 'drips', 'signups', 'topups'].includes(key)) {
    const c = (await load()).content;
    throw httpError(503, c.maintenance_message || 'Castvoo is under maintenance. Please try again in a few minutes.', 'maintenance');
  }
  if (!f[key]) throw forbidden(message || 'This feature is switched off right now.');
}

async function plans({ activeOnly = false } = {}) {
  const p = (await load()).plans;
  return activeOnly ? p.filter((x) => x.active) : p;
}
async function plan(code) { return (await load()).plans.find((p) => p.code === code) || null; }

/** Gatevoo is used for crypto when it is configured AND switched on in admin. */
async function gatevooOn() {
  const s = await get('crypto');
  return config.integrations().gatevoo && s.use_gatevoo !== false;
}

/**
 * The payment methods a person in `countryCode` can use right now.
 * A method shows only when its provider has keys set and the method is active.
 * 'crypto' becomes one Gatevoo option, or a manual USDT option when Gatevoo is off.
 * After those come the team's own manual methods (provider 'manual') offered in this country or in all countries.
 */
async function methodsFor(countryCode) {
  const all = await load();
  const integ = config.integrations();
  const f = all.features;
  const country = all.countries.find((c) => c.code === countryCode && c.active) || all.countries.find((c) => c.code === 'XX') || { methods: ['flw_card', 'crypto'], currency: 'USD', usd_rate: 1 };
  const crypto = await get('crypto');
  const out = [];
  for (const key of country.methods || []) {
    const m = all.methods.find((x) => x.key === key && x.active);
    if (!m) continue;
    if (m.provider === 'paystack' && f.paystack && integ.paystack) out.push({ ...m, currency: country.currency, usd_rate: Number(country.usd_rate) });
    if (m.provider === 'flutterwave' && f.flutterwave && integ.flutterwave) out.push({ ...m, currency: key === 'flw_card' ? 'USD' : country.currency, usd_rate: key === 'flw_card' ? 1 : Number(country.usd_rate) });
    if (m.provider === 'crypto' && f.crypto) {
      if (await gatevooOn()) out.push({ ...m, key: 'gatevoo', label: 'USDT or Bitcoin', detail: 'Secure crypto checkout by Gatevoo', currency: 'USD', usd_rate: 1, gatevoo: true });
      else {
        // Manual mode is USDT only: each top-up gets its own exact amount, which Bitcoin prices can't do.
        if (crypto.usdt_address) out.push({ key: 'usdt', provider: 'crypto', coin: 'USDT', label: 'USDT · TRC20', detail: 'Send the exact amount, then paste the transaction ID', color: '#26A17B', icon: '₮', currency: 'USD', usd_rate: 1 });
      }
    }
  }
  // The team's own methods (Admin → Countries & payments → Add payment method). They need no provider keys.
  const code = country.code || 'XX';
  for (const m of all.methods) {
    if (m.provider !== 'manual' || !m.active || m.deleted_at) continue;
    if (!m.all_countries && !(m.countries || []).includes(code)) continue;
    const cur = m.currency && m.currency !== 'USD' ? m.currency : 'USD';
    // A local-currency method uses its own rate, or the country's when the country uses that currency.
    const rate = cur === 'USD' ? 1 : m.usd_rate != null ? Number(m.usd_rate) : country.currency === cur ? Number(country.usd_rate) : null;
    if (!(rate > 0)) continue; // no rate to work out the amount: not offered here
    out.push({ ...m, currency: cur, usd_rate: rate, manual: true });
  }
  return out;
}

/** Active offers of a kind, inside their dates and under their use limit. */
async function activeOffers(kind) {
  const now = Date.now();
  return (await load()).offers.filter((o) => o.kind === kind && o.active
    && (!o.starts_at || new Date(o.starts_at).getTime() <= now)
    && (!o.ends_at || new Date(o.ends_at).getTime() > now)
    && (o.max_uses == null || o.uses < o.max_uses));
}
/** The best top-up bonus for an amount (in cents). */
async function topupBonus(amountCents) {
  if (!(await feature('topups'))) return 0;
  let best = 0;
  for (const o of await activeOffers('topup_bonus')) if (amountCents >= Number(o.min_topup_cents) && Number(o.bonus_cents) > best) best = Number(o.bonus_cents);
  return best;
}

/** Variables that legal pages and emails use. */
async function publicVars() {
  const s = (await load()).settings;
  const r = s.referral, b = s.billing, co = s.company;
  return {
    company_name: co.name, company_address: co.address, support_email: co.support_email, privacy_email: co.privacy_email, billing_email: co.billing_email,
    site_url: config.appUrl, app_url: config.appUrl + '/#app', legal_updated: s.legal_updated,
    trial_days: s.trial.days, refund_days: b.refund_days, data_retention_days: b.data_retention_days, renew_reminder_days: b.renew_reminder_days,
    ref_settle_days: r.settle_days, ref_min_withdraw: '$' + (r.min_withdraw_cents / 100).toLocaleString('en-US'),
    ref_rate_1: r.rates[0], ref_rate_2: r.rates[1], ref_rate_3: r.rates[2], ref_tier2_min: r.tier2_min, ref_tier3_min: r.tier3_min,
    referral_cookie_days: r.cookie_days,
  };
}

module.exports = { load, bust, peek, get, features, feature, requireFeature, plans, plan, methodsFor, activeOffers, topupBonus, publicVars, gatevooOn };

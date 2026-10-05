'use strict';
/* Things anyone can read: site config (prices, text, switches), health check, payment methods by country. */

const db = require('../db');
const config = require('../config');
const settings = require('../services/settings');

async function publicConfig() {
  const all = await settings.load();
  const s = all.settings;
  const integ = config.integrations();
  const f = all.features;
  const plans = all.plans.filter((p) => p.active).map((p) => ({
    code: p.code, name: p.name, tagline: p.tagline, price_month: p.price_month_cents / 100, price_year: p.price_year_cents / 100,
    connections: p.connections, subscribers: p.subscribers, ai_writes: p.ai_writes, seats: p.seats, bullets: p.bullets, popular: p.popular,
  }));
  const banners = (await settings.activeOffers('banner')).map((o) => ({ title: o.title, text: o.description, link: o.link_url }));
  const bonuses = (await settings.activeOffers('topup_bonus')).map((o) => ({ min: Number(o.min_topup_cents) / 100, bonus: Number(o.bonus_cents) / 100 })).sort((a, b) => a.min - b.min);
  return {
    features: f,
    content: all.content,
    plans,
    trial: { days: s.trial.days, plan: s.trial.plan, ai_writes: s.trial.ai_writes },
    countries: all.countries.filter((c) => c.active).map((c) => ({ code: c.code, name: c.name, flag: c.flag, featured: c.featured })),
    login: {
      email: f.login_email,
      telegram: f.login_telegram && integ.telegram && !!config.telegram.botUsername,
      google: f.login_google && integ.google,
      voosquare: f.login_voosquare && integ.voosquare_login,
    },
    bot_username: config.telegram.botUsername || null,
    bot_id: config.telegram.botToken ? Number(config.telegram.botToken.split(':')[0]) || null : null,
    gatevoo: await settings.gatevooOn(),
    gatevoo_url: (await settings.gatevooOn()) ? config.gatevoo.url : null,
    referral: { rates: s.referral.rates, tier2_min: s.referral.tier2_min, tier3_min: s.referral.tier3_min, min_withdraw: s.referral.min_withdraw_cents / 100, settle_days: s.referral.settle_days },
    billing: { min_topup: s.billing.min_topup_cents / 100, max_topup: s.billing.max_topup_cents / 100, refund_days: s.billing.refund_days },
    topup_bonuses: f.topups ? bonuses : [],
    banners,
    support: { reply_time: s.support.reply_time, email: s.company.support_email, telegram: s.support.telegram_username || null },
    company: { name: s.company.name, address: s.company.address },
    ai_available: f.ai && integ.ai,
    // VooSquare (Voo Connect): login button, "Part of VooSquare" links, support widget on the public website.
    voo: integ.voo_connect ? {
      app_url: config.voosquare.base + '/app',
      referrals_url: config.voosquare.base + '/app#referrals',
      widget_src: config.voosquare.widget ? config.voosquare.base + '/widget.js' : null,
    } : null,
  };
}

module.exports = (r) => {
  r.get('/api/public/config', async (ctx) => {
    ctx.res.setHeader('Cache-Control', 'public, max-age=15');
    const body = JSON.stringify(await publicConfig());
    ctx.send(200, body, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=15' });
  });

  r.get('/api/public/methods', async (ctx) => {
    const list = await settings.methodsFor(String(ctx.query.country || 'XX'));
    return { methods: list.map((m) => ({ key: m.key, label: m.label, detail: m.detail, color: m.color, icon: m.icon, gatevoo: !!m.gatevoo })) };
  });

  r.get('/health', async () => {
    await db.one('select 1 as ok');
    return { ok: true, time: new Date().toISOString() };
  });
};

module.exports.publicConfig = publicConfig;

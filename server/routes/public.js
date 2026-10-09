'use strict';
/* Things anyone can read: site config (prices, text, switches), health check, payment methods by country. */

const db = require('../db');
const config = require('../config');
const settings = require('../services/settings');

async function siteAgent() {
  const p = await db.one('select id, name, role, updated_at from support_personas where active order by sort, id limit 1');
  return p ? require('../services/support-ai').publicPersona(p) : null;
}

/** The "Powered by Replyvoo" line under the chats (Admin → Support AI), or null when switched off. */
async function poweredBy() {
  const c = await require('../services/support-ai').conf();
  return c.powered_by !== false ? (c.powered_by_text || 'Powered by Replyvoo') : null;
}

async function publicConfig() {
  const all = await settings.load();
  const s = all.settings;
  const integ = config.integrations();
  const f = all.features;
  const plans = all.plans.filter((p) => p.active).map((p) => ({
    code: p.code, name: p.name, tagline: p.tagline, price_month: p.price_month_cents / 100, price_year: p.price_year_cents / 100,
    connections: p.connections, subscribers: p.subscribers, ai_writes: p.ai_writes, seats: p.seats, bullets: p.bullets, popular: p.popular,
    join_requests: p.join_requests, flows: p.flows, flow_steps: p.flow_steps, branding: !!p.branding, features: p.features || [],
  }));
  const banners = (await settings.activeOffers('banner')).map((o) => ({ title: o.title, text: o.description, link: o.link_url }));
  const bonuses = (await settings.activeOffers('topup_bonus')).map((o) => ({ min: Number(o.min_topup_cents) / 100, bonus: Number(o.bonus_cents) / 100 })).sort((a, b) => a.min - b.min);
  return {
    features: f,
    content: all.content,
    plans,
    trial: { days: s.trial.days, plan: s.trial.plan, ai_writes: s.trial.ai_writes, join_requests: s.trial.join_requests ?? null },
    countries: all.countries.filter((c) => c.active).map((c) => ({ code: c.code, name: c.name, flag: c.flag, featured: c.featured })),
    login: {
      email: f.login_email,
      telegram: f.login_telegram && integ.telegram && !!config.telegram.botUsername,
      voosquare: f.login_voosquare && integ.voosquare_login,
    },
    bot_username: config.telegram.botUsername || null,
    bot_id: config.telegram.botToken ? Number(config.telegram.botToken.split(':')[0]) || null : null,
    gatevoo: await settings.gatevooOn(),
    gatevoo_url: (await settings.gatevooOn()) ? config.gatevoo.url : null,
    referral: { rates: s.referral.rates, tier2_min: s.referral.tier2_min, tier3_min: s.referral.tier3_min, min_withdraw: s.referral.min_withdraw_cents / 100, settle_days: s.referral.settle_days },
    billing: { min_topup: s.billing.min_topup_cents / 100, max_topup: s.billing.max_topup_cents / 100, refund_days: s.billing.refund_days,
      // Extra team seats on paid plans, per seat per month (0 = not sold). Yearly plans pay 12 months.
      seat_price: Math.max(0, Number(s.billing.seat_price_cents ?? 500)) / 100 },
    topup_bonuses: f.topups ? bonuses : [],
    banners,
    support: { reply_time: s.support.reply_time, email: s.company.support_email, telegram: s.support.telegram_username || null },
    company: { name: s.company.name, address: s.company.address },
    ai_available: f.ai && integ.ai,
    // The website chat bubble (visitors; knowledge only, no account access) and the face that answers there.
    site_chat: f.site_chat && f.support_chat && integ.ai ? { agent: await siteAgent(), powered_by: await poweredBy() } : null,
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

  /**
   * The visitor's country, for the sign-up country step only (shown pre-selected; the person can change it and must
   * still press Continue). Cloudflare's CF-IPCountry header or the offline DB-IP database (lib/geoip.js); only the
   * code is used, the address is not stored. Null when unknown or not one of the active countries. Not cached by
   * browsers or proxies (it is different for every visitor), and never used for the website language.
   */
  r.get('/api/public/geo', async (ctx) => {
    const cc = require('../lib/geoip').countryOf(ctx);
    const c = cc ? (await settings.load()).countries.find((x) => x.active && x.code === cc) : null;
    const body = JSON.stringify({ country: c ? { code: c.code, name: c.name, flag: c.flag } : null });
    ctx.send(200, body, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', Vary: 'CF-IPCountry, X-Forwarded-For' });
  }, { rate: [120, 600] });

  r.get('/api/public/methods', async (ctx) => {
    const list = await settings.methodsFor(String(ctx.query.country || 'XX'));
    return { methods: list.map((m) => ({ key: m.key, label: m.label, detail: m.detail, color: m.color, icon: m.icon, gatevoo: !!m.gatevoo })) };
  });

  /** A support agent's face: the uploaded photo, or a calm initials avatar on the Castvoo blue. */
  r.get('/api/public/personas/:id/photo', async (ctx) => { await require('../services/support-ai').streamPhoto(ctx, ctx.params.id); });

  /**
   * Website chat for visitors (not logged in): product and pricing answers from the knowledge only.
   * No tools and no account data. Per-IP limits here and per day in services/support-ai.js siteChat().
   * In: { message, history: [{ role: 'user'|'assistant', content }] }   Out: { persona, bubbles, cta }
   */
  r.post('/api/public/chat', async (ctx) => require('../services/support-ai').siteChat({ ip: ctx.ip, visitor: require('../lib/visitor').read(ctx), message: ctx.body.message, history: ctx.body.history, images: ctx.body.images || ctx.body.attachments || ctx.body.image }), { rate: [20, 600], shared: true, csrf: true });

  r.get('/health', async () => {
    await db.one('select 1 as ok');
    return { ok: true, time: new Date().toISOString() };
  });
};

module.exports.publicConfig = publicConfig;

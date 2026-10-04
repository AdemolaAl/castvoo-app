'use strict';
/*
 * Starting data. It is inserted ONCE (only rows that don't exist yet), so
 * anything the team changes in the admin panel is never overwritten.
 * Prices are in cents: 1900 = $19.00.
 */

const db = require('./db');
const { FEATURES } = require('./features');

const PLANS = [
  { code: 'starter', name: 'Starter', tagline: 'For one bot or channel getting started.', price_month_cents: 1900, price_year_cents: 19000, connections: 1, subscribers: 5000, ai_writes: 300, seats: 1, popular: false, sort: 1,
    bullets: ['1 bot, channel or group', '5,000 subscribers', 'Unlimited broadcasts', 'Auto follow-ups', '300 AI writes a month', 'Tracked clicks'] },
  { code: 'growth', name: 'Growth', tagline: 'For growing brands with several channels.', price_month_cents: 4900, price_year_cents: 49000, connections: 5, subscribers: 25000, ai_writes: 2000, seats: 3, popular: true, sort: 2,
    bullets: ['5 bots, channels or groups', '25,000 subscribers', 'Everything in Starter', 'Audiences and start links', '2,000 AI writes a month', '3 team seats'] },
  { code: 'scale', name: 'Scale', tagline: 'For big audiences and teams.', price_month_cents: 9900, price_year_cents: 99000, connections: 20, subscribers: 100000, ai_writes: 5000, seats: 10, popular: false, sort: 3,
    bullets: ['20 bots, channels or groups', '100,000 subscribers', 'Everything in Growth', '5,000 AI writes a month', '10 team seats', 'Priority support'] },
];

const METHODS = [
  { key: 'paystack_ng', provider: 'paystack', label: 'Paystack', detail: 'Card, bank transfer, USSD', color: '#0BA4DB', icon: 'P', sort: 1 },
  { key: 'paystack_gh', provider: 'paystack', label: 'Paystack', detail: 'Card, mobile money', color: '#0BA4DB', icon: 'P', sort: 2 },
  { key: 'paystack_za', provider: 'paystack', label: 'Paystack', detail: 'Card, instant EFT', color: '#0BA4DB', icon: 'P', sort: 3 },
  { key: 'flw_ke', provider: 'flutterwave', label: 'Flutterwave', detail: 'Card, M-Pesa', color: '#F5A623', icon: 'F', sort: 4 },
  { key: 'flw_cm', provider: 'flutterwave', label: 'Flutterwave', detail: 'Card, MTN and Orange mobile money', color: '#F5A623', icon: 'F', sort: 5 },
  { key: 'flw_card', provider: 'flutterwave', label: 'Card', detail: 'Visa, Mastercard', color: '#0B1430', icon: '💳', sort: 6 },
  { key: 'crypto', provider: 'crypto', label: 'Crypto', detail: 'USDT (TRC20) or Bitcoin', color: '#111111', icon: 'G', sort: 9 },
];

// usd_rate = local currency units per 1 US dollar. CHECK THESE IN ADMIN → COUNTRIES BEFORE LAUNCH.
const C = (code, name, flag, currency, usd_rate, methods, featured = false, sort = 100) => ({ code, name, flag, currency, usd_rate, methods, featured, sort });
const CARD = ['flw_card', 'crypto'];
const COUNTRIES = [
  C('NG', 'Nigeria', '🇳🇬', 'NGN', 1550, ['paystack_ng', 'crypto'], true, 1),
  C('KE', 'Kenya', '🇰🇪', 'KES', 129, ['flw_ke', 'crypto'], true, 2),
  C('GH', 'Ghana', '🇬🇭', 'GHS', 12.5, ['paystack_gh', 'crypto'], true, 3),
  C('ZA', 'South Africa', '🇿🇦', 'ZAR', 18, ['paystack_za', 'crypto'], true, 4),
  C('CM', 'Cameroon', '🇨🇲', 'XAF', 570, ['flw_cm', 'crypto'], true, 5),
  C('UG', 'Uganda', '🇺🇬', 'USD', 1, CARD), C('TZ', 'Tanzania', '🇹🇿', 'USD', 1, CARD), C('RW', 'Rwanda', '🇷🇼', 'USD', 1, CARD),
  C('ZM', 'Zambia', '🇿🇲', 'USD', 1, CARD), C('ET', 'Ethiopia', '🇪🇹', 'USD', 1, CARD), C('EG', 'Egypt', '🇪🇬', 'USD', 1, CARD),
  C('MA', 'Morocco', '🇲🇦', 'USD', 1, CARD), C('CI', "Côte d'Ivoire", '🇨🇮', 'USD', 1, CARD), C('SN', 'Senegal', '🇸🇳', 'USD', 1, CARD),
  C('BJ', 'Benin', '🇧🇯', 'USD', 1, CARD), C('TG', 'Togo', '🇹🇬', 'USD', 1, CARD), C('SL', 'Sierra Leone', '🇸🇱', 'USD', 1, CARD),
  C('LR', 'Liberia', '🇱🇷', 'USD', 1, CARD), C('ZW', 'Zimbabwe', '🇿🇼', 'USD', 1, CARD), C('BW', 'Botswana', '🇧🇼', 'USD', 1, CARD),
  C('US', 'United States', '🇺🇸', 'USD', 1, CARD), C('GB', 'United Kingdom', '🇬🇧', 'USD', 1, CARD), C('CA', 'Canada', '🇨🇦', 'USD', 1, CARD),
  C('AE', 'United Arab Emirates', '🇦🇪', 'USD', 1, CARD), C('SA', 'Saudi Arabia', '🇸🇦', 'USD', 1, CARD), C('IN', 'India', '🇮🇳', 'USD', 1, CARD),
  C('PK', 'Pakistan', '🇵🇰', 'USD', 1, CARD), C('BD', 'Bangladesh', '🇧🇩', 'USD', 1, CARD), C('ID', 'Indonesia', '🇮🇩', 'USD', 1, CARD),
  C('PH', 'Philippines', '🇵🇭', 'USD', 1, CARD), C('MY', 'Malaysia', '🇲🇾', 'USD', 1, CARD), C('VN', 'Vietnam', '🇻🇳', 'USD', 1, CARD),
  C('TR', 'Türkiye', '🇹🇷', 'USD', 1, CARD), C('BR', 'Brazil', '🇧🇷', 'USD', 1, CARD), C('MX', 'Mexico', '🇲🇽', 'USD', 1, CARD),
  C('CO', 'Colombia', '🇨🇴', 'USD', 1, CARD), C('AR', 'Argentina', '🇦🇷', 'USD', 1, CARD), C('FR', 'France', '🇫🇷', 'USD', 1, CARD),
  C('DE', 'Germany', '🇩🇪', 'USD', 1, CARD), C('ES', 'Spain', '🇪🇸', 'USD', 1, CARD), C('IT', 'Italy', '🇮🇹', 'USD', 1, CARD),
  C('NL', 'Netherlands', '🇳🇱', 'USD', 1, CARD), C('PT', 'Portugal', '🇵🇹', 'USD', 1, CARD), C('UA', 'Ukraine', '🇺🇦', 'USD', 1, CARD),
  C('AU', 'Australia', '🇦🇺', 'USD', 1, CARD), C('XX', 'Another country', '🌍', 'USD', 1, CARD, false, 999),
];

const SETTINGS = {
  company: { name: 'Zedapex', address: 'Lagos, Nigeria', support_email: 'support@castvoo.com', privacy_email: 'privacy@castvoo.com', billing_email: 'billing@castvoo.com' },
  trial: { days: 7, plan: 'growth', ai_writes: 100 },
  billing: { refund_days: 14, data_retention_days: 60, min_topup_cents: 1000, max_topup_cents: 500000, renew_reminder_days: 3 },
  referral: { rates: [10, 20, 30], tier2_min: 5, tier3_min: 20, settle_days: 30, min_withdraw_cents: 30000, cookie_days: 60 },
  ai: { model: 'claude-haiku-4-5-20251001', max_output_tokens: 900, temperature: 0.7, house_rules: '' },
  crypto: { use_gatevoo: true, usdt_address: '', btc_address: '' },
  support: { reply_time: 'We usually reply within a few hours, every day from 8am to 10pm West Africa Time.', telegram_username: '' },
  legal_updated: '3 October 2026',
};

const CONTENT = {
  announcement_on: '0',
  announcement_text: 'New: Cas, your AI helper, now learns your business. Train it in two minutes.',
  announcement_link: '#ai',
  hero_title: 'Turn your Telegram into a *sales machine.*',
  hero_subtitle: 'Castvoo welcomes every new subscriber, follows up at the right time and sends each group the message written for them. Your bots and channels keep selling while you sleep.',
  hero_cta: 'Start free · 7 days on us',
  pricing_title: 'Simple prices. Everything included.',
  pricing_subtitle: 'Every plan has unlimited broadcasts, auto follow-ups, tracked clicks and Cas the AI helper. No add-on fees.',
  maintenance_message: 'Castvoo is getting an upgrade. Sending is paused for a few minutes. Nothing is lost.',
  footer_tagline: 'Telegram broadcasts and follow-ups that sell while you sleep.',
  faq: JSON.stringify([
    { q: 'Can a message greet each person by name?', a: 'Yes. Write {name} where the name should go, or tap "👤 Name". Everyone who started your bot sees their own first name, like "Hi Tunde!". In channels and groups, or when there is no name, it says "Hi there!".' },
    { q: 'Can I see exactly who read my message?', a: 'No. Telegram does not share read receipts with bots, so no honest tool can show them. Castvoo shows what Telegram does share: who each message was delivered to, who tapped a tracked button, who replied and who blocked the bot. Channel posts also show Telegram\'s own view count inside Telegram.' },
    { q: 'Can I send a message to only some people in my channel?', a: 'No. Telegram doesn\'t let bots see who is in a channel, so a channel post always goes to everyone in it. Audiences work for people who started your bot, because Castvoo can message each of them one by one.' },
    { q: 'Can Castvoo message people who join my channel?', a: 'Yes, if your channel uses join requests and your own bot (connected to Castvoo) is an admin there. Telegram lets the bot message each person for 5 minutes after they ask to join. Castvoo sends your first follow-up message straight away and can let them in automatically. People who then tap Start in your bot also get the rest of the follow-up, so add a button in that first message that opens your bot.' },
    { q: 'How fast does a broadcast go out?', a: 'About 25 messages a second per bot, which keeps you safely inside Telegram\'s limits. That\'s about 7 minutes for 10,000 people and about an hour for 100,000. You see the estimate before you send.' },
    { q: 'Will my bot get banned for broadcasting?', a: 'Castvoo sends within Telegram\'s limits, removes people who blocked your bot and adds a "Stop these messages" button to bot messages by default. Bans come from spam reports, so only message people who asked to hear from you.' },
    { q: 'How long does setup take?', a: 'About five minutes. Create a bot with @BotFather and paste its token, or tap "Add to my channel" to connect a channel or group in one tap. The setup guide shows every step.' },
    { q: 'How do I pay?', a: 'Add money to your Castvoo wallet with the methods for your country, like Paystack in Nigeria or M-Pesa in Kenya, a card anywhere else, or crypto (USDT or Bitcoin). Your plan renews from the wallet each month.' },
    { q: 'What is an AI write?', a: 'One AI write is one time Cas writes, rewrites or translates a message for you, or answers one question. Every plan includes a monthly amount: 300 on Starter, 2,000 on Growth and 5,000 on Scale. If you run out, Cas rests until your next billing date. There is never an extra charge.' },
    { q: 'Can I cancel any time?', a: 'Yes. Cancel in Settings and your plan runs until the end of the period you paid for. Unused wallet top-ups can be refunded within 14 days if you haven\'t spent them.' },
    { q: 'Do I need Joinvoo or Replyvoo?', a: 'No. Castvoo works on its own with any Telegram bot, channel or group. Joinvoo and Replyvoo are separate Zedapex tools you can add later if you want them.' },
  ]),
};

const OFFERS = [
  { kind: 'topup_bonus', title: 'Top up $200, get $10 extra', min_topup_cents: 20000, bonus_cents: 1000 },
  { kind: 'topup_bonus', title: 'Top up $500, get $40 extra', min_topup_cents: 50000, bonus_cents: 4000 },
  { kind: 'topup_bonus', title: 'Top up $1,000, get $100 extra', min_topup_cents: 100000, bonus_cents: 10000 },
  { kind: 'coupon', title: 'Welcome back: 20% off your first month', code: 'COMEBACK20', percent: 20, months: 1, description: 'Used in the win-back email after a trial ends.' },
];

async function run() {
  await db.tx(async (c) => {
    for (const p of PLANS) {
      await c.query(`insert into plans(code,name,tagline,price_month_cents,price_year_cents,connections,subscribers,ai_writes,seats,bullets,popular,sort)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (code) do nothing`,
      [p.code, p.name, p.tagline, p.price_month_cents, p.price_year_cents, p.connections, p.subscribers, p.ai_writes, p.seats, JSON.stringify(p.bullets), p.popular, p.sort]);
    }
    for (const m of METHODS) {
      await c.query('insert into payment_methods(key,provider,label,detail,color,icon,sort) values ($1,$2,$3,$4,$5,$6,$7) on conflict (key) do nothing',
        [m.key, m.provider, m.label, m.detail, m.color, m.icon, m.sort]);
    }
    for (const x of COUNTRIES) {
      await c.query('insert into countries(code,name,flag,currency,usd_rate,methods,featured,sort) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (code) do nothing',
        [x.code, x.name, x.flag, x.currency, x.usd_rate, JSON.stringify(x.methods), x.featured, x.sort]);
    }
    for (const [k, v] of Object.entries(SETTINGS)) {
      await c.query('insert into settings(key,value) values ($1,$2) on conflict (key) do nothing', [k, JSON.stringify(v)]);
    }
    for (const f of FEATURES) {
      await c.query('insert into feature_flags(key,enabled) values ($1,$2) on conflict (key) do nothing', [f.key, f.default]);
    }
    for (const [k, v] of Object.entries(CONTENT)) {
      await c.query('insert into site_content(key,value) values ($1,$2) on conflict (key) do nothing', [k, v]);
    }
    const hasOffers = (await c.query('select count(*)::int n from offers')).rows[0].n;
    if (!hasOffers) {
      for (const o of OFFERS) {
        await c.query('insert into offers(kind,title,description,code,percent,min_topup_cents,bonus_cents,months) values ($1,$2,$3,$4,$5,$6,$7,$8)',
          [o.kind, o.title, o.description || '', o.code || null, o.percent || null, o.min_topup_cents || null, o.bonus_cents || null, o.months || 1]);
      }
    }
    const hasKb = (await c.query('select count(*)::int n from knowledge')).rows[0].n;
    if (!hasKb) {
      for (const k of require('./knowledge-defaults')) await c.query('insert into knowledge(title, body) values ($1,$2)', [k.title, k.body]);
    }
  });
}

module.exports = { run, PLANS, METHODS, COUNTRIES, SETTINGS, CONTENT, OFFERS };

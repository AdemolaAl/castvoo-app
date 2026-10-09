'use strict';
/*
 * Starting data. It is inserted ONCE (only rows that don't exist yet), so
 * anything the team changes in the admin panel is never overwritten.
 * Prices are in cents: 1900 = $19.00.
 */

const db = require('./db');
const { FEATURES } = require('./features');

// Feature keys each plan includes (see docs/PRODUCT-FACTS.md). Each plan includes everything in the plan before it.
const F_FREE = ['auto_approve', 'welcome_message'];
const F_STARTER = [...F_FREE, 'welcome_flows', 'tap_to_start', 'broadcasts', 'schedule', 'drips', 'tracked_buttons', 'basic_stats', 'ai'];
const F_GROWTH = [...F_STARTER, 'ab_welcome_2', 'condition_clicked', 'audiences', 'start_links', 'flow_funnel_stats'];
// AUD-3: no tag branching (it does not exist), and CSV export is on every plan, so neither is listed as a Scale feature.
const F_SCALE = [...F_GROWTH, 'ab_welcome_4', 'onboarding_call'];

// join_requests: per calendar month. flows / flow_steps: -1 = unlimited.
const PLANS = [
  { code: 'free', name: 'Free', tagline: 'Greet every join, free.', price_month_cents: 0, price_year_cents: 0, connections: 1, subscribers: 0, ai_writes: 0, seats: 1, popular: false, sort: 0,
    join_requests: 500, flows: 1, flow_steps: 1, branding: true, features: F_FREE,
    bullets: ['1 channel or group + your welcome bot', '500 join requests a month', '1 welcome message', 'Auto-approve join requests'] },
  { code: 'starter', name: 'Starter', tagline: 'For one channel and its bot, getting started.', price_month_cents: 1900, price_year_cents: 19000, connections: 2, subscribers: 5000, ai_writes: 150, seats: 1, popular: false, sort: 1,
    join_requests: 5000, flows: 3, flow_steps: 5, branding: false, features: F_STARTER,
    bullets: ['2 bots, channels or groups', '5,000 bot subscribers', '5,000 join requests a month', '3 Welcome Flows, 5 steps each', 'Broadcasts and auto follow-ups', '150 AI writes a month'] },
  { code: 'growth', name: 'Growth', tagline: 'For buyers running several channels.', price_month_cents: 4900, price_year_cents: 49000, connections: 5, subscribers: 25000, ai_writes: 600, seats: 3, popular: true, sort: 2,
    join_requests: 30000, flows: 15, flow_steps: 20, branding: false, features: F_GROWTH,
    bullets: ['5 bots, channels or groups', '25,000 bot subscribers', '30,000 join requests a month', '15 Welcome Flows, 20 steps each', 'A/B welcome and click conditions', '600 AI writes a month'] },
  { code: 'scale', name: 'Scale', tagline: 'For big audiences and teams.', price_month_cents: 9900, price_year_cents: 99000, connections: 20, subscribers: 100000, ai_writes: 1500, seats: 10, popular: false, sort: 3,
    join_requests: 150000, flows: -1, flow_steps: -1, branding: false, features: F_SCALE,
    bullets: ['20 bots, channels or groups', '100,000 bot subscribers', '150,000 join requests a month', 'Unlimited Welcome Flows and steps', 'A/B welcome with 4 versions', '1,500 AI writes a month'] },
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
  trial: { days: 7, plan: 'growth', ai_writes: 50, join_requests: 3000, on_end: 'free' },
  billing: { refund_days: 14, data_retention_days: 60, min_topup_cents: 1000, max_topup_cents: 500000, renew_reminder_days: 3, limit_grace_pct: 10, seat_price_cents: 500 },
  referral: { rates: [10, 20, 30], tier2_min: 5, tier3_min: 20, settle_days: 30, min_withdraw_cents: 30000, cookie_days: 60 },
  ai: { model: 'claude-haiku-4-5-20251001', max_output_tokens: 900, temperature: 0.7, house_rules: '' },
  // Who answers for Cas. provider '' = AI_PROVIDER env. key_enc is encrypted and only used for the endpoint in key_for.
  ai_provider: { provider: '', openrouter_model: '', fallback_models: '', key_enc: '', key_for: '' },
  crypto: { use_gatevoo: true, usdt_address: '', btc_address: '' },
  support: { reply_time: 'We usually reply within a few hours, every day from 8am to 10pm West Africa Time.', telegram_username: '' },
  // The 24/7 AI support team (services/support-ai.js, Admin → Support AI).
  support_ai: {
    enabled: true,
    house_rules: '',
    escalation: { human_request: true, sensitive: true, manual_payment: true, frustration: true, low_confidence: true, tool_errors: true, failed_attempts: true },
    typing_min_ms: 1500, typing_max_ms: 6000, debounce_ms: 1200,
    daily_cap_per_user: 60, daily_cap_total: 3000, msgs_per_min: 8,
    free_conversations_per_month: 5,
    model: '', max_tool_rounds: 6,
    // AUD-10: what we promise when a person takes over, by plan. Paid and priority count the team's hours only
    // (team_hours); after hours the promise says it starts when the team is back (services/support-hours.js).
    handoff_eta: { free: 'within 24 hours', paid: 'within one business day (8am to 10pm WAT)', priority: 'within 4 business hours (8am to 10pm WAT)' },
    team_hours: { start: 8, end: 22, tz: 'Africa/Lagos', label: '8am to 10pm WAT' },
    priority_plans: ['scale'],
    site_chat_daily_cap: 500, site_chat_per_ip_day: 40,
    // Website chat budget: after 60% of the daily cap only visitors who loaded the site 5+ minutes ago are answered.
    site_chat_soft_pct: 0.6, site_chat_known_after_s: 300,
    // Answer up to 4 conversations at once per server; one answer may take at most 90 s, then a person takes over.
    concurrency: 4, turn_max_ms: 90000,
    // Admin → Support AI shows the AI resolution rate against this goal.
    resolution_goal_pct: 99,
    // Customers (and the team) can send screenshots in the support chat; the AI reads them. Never in the website chat.
    customer_images: true,
    // The small "Powered by Replyvoo" line under the support chat and the website chat (links to replyvoo.com).
    powered_by: true, powered_by_text: 'Powered by Replyvoo',
  },
  legal_updated: '9 October 2026',
};

// Earlier plan taglines, moved to the new default on start when nobody edited them.
const PLAN_TAGLINES_OLD = {
  free: ['Welcome everyone who asks to join your channel.'],
  growth: ['For growing brands with several channels.'],
};
// The FAQ as it was seeded before the homepage v2 copy (old order, and "removes people who blocked your bot", which was not true:
// they are marked blocked and skipped). Built from FAQ below so the two can't drift apart.
const FAQ_V1_ORDER = ['Can a message greet each person by name?', 'Can I see exactly who read my message?', 'Can I send a message to only some people in my channel?', 'Can Castvoo message people who join my channel?', 'Is there a free plan?'];
const FAQ_V1_BLOCKED = 'removes people who blocked your bot';
const FAQ_BLOCKED = 'skips people who blocked your bot';
const FAQ = [
  { q: 'Can Castvoo message people who join my channel?', a: 'Yes, with Welcome Flows. Your channel must use join requests, and your own bot (connected to Castvoo) must be an admin there with the "Add members" right. Telegram lets the bot message each person for 5 minutes after they ask to join, so your first message goes out straight away, and Castvoo can let them in automatically. Later messages only reach people who tap Start in your bot, so add a "Tap to start" button to the first message.' },
  { q: 'Is there a free plan?', a: 'Yes. The Free plan welcomes people who ask to join one channel or group: 500 join requests a month, auto-approve and one welcome message from your own bot. It needs no card. Free welcomes end with a small "Free welcome bot by Castvoo.com" line. Paid plans remove it and add follow-ups, broadcasts and Cas.' },
  { q: 'Can a message greet each person by name?', a: 'Yes. Write {name} where the name should go, or tap "👤 Name". Everyone who started your bot sees their own first name, like "Hi Tunde!". In channels and groups, or when there is no name, it says "Hi there!".' },
  { q: 'Can I see exactly who read my message?', a: 'No. Telegram does not share read receipts with bots, so no honest tool can show them. Castvoo shows what Telegram does share: who each message was delivered to, who tapped a tracked button, who replied and who blocked the bot. Channel posts also show Telegram\'s own view count inside Telegram.' },
  { q: 'Can I send a message to only some people in my channel?', a: 'No. Telegram doesn\'t let bots see who is in a channel, so a channel post always goes to everyone in it. Audiences work for people who started your bot, because Castvoo can message each of them one by one.' },
  { q: 'How fast does a broadcast go out?', a: 'About 25 messages a second per bot, which keeps you safely inside Telegram\'s limits. That\'s about 7 minutes for 10,000 people and about an hour for 100,000. You see the estimate before you send.' },
  { q: 'Will my bot get banned for broadcasting?', a: 'Castvoo sends within Telegram\'s limits, skips people who blocked your bot and adds a "Stop these messages" button to bot messages by default. Bans come from spam reports, so only message people who asked to hear from you.' },
  { q: 'How long does setup take?', a: 'About five minutes. Create a bot with @BotFather and paste its token, or tap "Add to my channel" to connect a channel or group in one tap. The setup guide shows every step.' },
  { q: 'How do I pay?', a: 'Add money to your Castvoo wallet with the methods for your country, like Paystack in Nigeria or M-Pesa in Kenya, a card anywhere else, or crypto (USDT or Bitcoin). Your plan renews from the wallet each month.' },
  { q: 'What is an AI write?', a: 'One AI write is one time Cas writes, rewrites or translates a message for you, or answers one question. Every paid plan includes a monthly amount: 150 on Starter, 600 on Growth and 1,500 on Scale. The Free plan has no AI writes. If you run out, Cas rests until your next billing date. There is never an extra charge.' },
  { q: 'Can I cancel any time?', a: 'Yes. Cancel in Settings and your plan runs until the end of the period you paid for. Unused wallet top-ups can be refunded within 14 days if you haven\'t spent them.' },
  { q: 'Is there customer support?', a: 'Yes, 24/7. Open Help in your dashboard: AI support agents answer in seconds, day and night, check your own account for you and can read a screenshot you send. Our human team steps in whenever you need a person, and for refunds and payments checked by hand. You can also email support@castvoo.com. The Free plan includes a few instant AI chats a month, then the team answers.' },
  { q: 'Do I need Joinvoo or Replyvoo?', a: 'No. Castvoo works on its own with any Telegram bot, channel or group. Joinvoo and Replyvoo are separate Zedapex tools you can add later if you want them.' },
];
// The FAQ exactly as the first seed stored it (see FAQ_V1_ORDER).
const FAQ_V1 = [...FAQ_V1_ORDER.map((t) => FAQ.find((f) => f.q === t)), ...FAQ.filter((f) => !FAQ_V1_ORDER.includes(f.q))]
  .map((f) => ({ q: f.q, a: f.a.replace(FAQ_BLOCKED, FAQ_V1_BLOCKED) }));

// Earlier default texts, replaced on start when nobody edited them (QA-17: the old hero was hype; v2: the join-request hero; v3: welcome + broadcasts + follow-ups).
const CONTENT_OLD = {
  hero_title: ['Turn your Telegram into a *sales machine.*', 'Welcome everyone who asks to *join your channel.*', 'Turn every join into *a lead you can message.*'],
  hero_subtitle: ['Castvoo welcomes every new subscriber, follows up at the right time and sends each group the message written for them. Your bots and channels keep selling while you sleep.',
    'Your own bot greets each person the moment they ask to join your Telegram channel or group, lets them in and can follow up later. Start free with one channel. Paid plans add broadcasts, follow-ups and Cas, the AI helper.',
    'Your bot welcomes everyone the moment they ask to join, lets them in, and invites them to tap Start so you can follow up.'],
  hero_cta: ['Start free · 7 days on us'],
  pricing_subtitle: ['Start free with a welcome bot for your channel. Paid plans add follow-ups, broadcasts, tracked clicks and Cas the AI helper. No add-on fees.',
    'Free welcomes 500 join requests a month on one channel. Paid plans from $19 add follow-ups, broadcasts, tracked clicks and Cas. No setup or add-on fees.'],
  footer_tagline: ['Telegram broadcasts and follow-ups that sell while you sleep.', 'Telegram welcomes, broadcasts and follow-ups, sent on time.'],
  announcement_text: ['New: Cas, your AI helper, now learns your business. Train it in two minutes.'],
  faq: [JSON.stringify(FAQ_V1)],
};
const CONTENT = {
  announcement_on: '0',
  announcement_text: 'Welcome Flows: greet, let in and follow up everyone who asks to join.',
  announcement_link: '#how',
  hero_title: 'Welcome. Broadcast. Follow up. *All on autopilot.*',
  hero_subtitle: 'Greet everyone who asks to join, send broadcasts to all your subscribers, and build timed follow-up flows with buttons and links in a simple builder. Cas, the AI helper, writes the messages.',
  hero_cta: 'Start my 7-day free trial',
  pricing_title: 'Simple prices. *Start free.*',
  pricing_subtitle: 'Free welcomes 500 join requests a month on one channel. Paid plans from $19 add follow-ups, broadcasts, tracked clicks and Cas. No setup fees.',
  maintenance_message: 'Castvoo is getting an upgrade. Sending is paused for a few minutes. Nothing is lost.',
  footer_tagline: 'Every Telegram join, greeted and followed up.',
  faq: JSON.stringify(FAQ),
};

// The AI support team's starting agents (first names only) and their illustrated faces (public/img/agents/<face>.svg).
// Admin → Support AI changes them, picks another face or uploads a photo.
const PERSONAS = [
  { name: 'Mia', role: 'Customer support', bio: 'Helps with setup, sending and anything that feels stuck.', sort: 1, face: 'mia' },
  { name: 'Daniel', role: 'Technical support', bio: 'Bots, channels, webhooks and delivery problems.', sort: 2, face: 'daniel' },
  { name: 'Amara', role: 'Billing and payments', bio: 'Top-ups, plans, renewals and payment checks.', sort: 3, face: 'amara' },
  { name: 'Leo', role: 'Onboarding', bio: 'Gets new customers from sign-up to their first message.', sort: 4, face: 'leo' },
  { name: 'Aisha', role: 'Customer support', bio: 'Welcome Flows, join requests and getting people let in.', sort: 5, face: 'aisha' },
  { name: 'Kenji', role: 'Technical support', bio: 'Bots, webhooks, start links and anything technical.', sort: 6, face: 'kenji' },
  { name: 'Sofia', role: 'Customer success', bio: 'Helps you get more replies and clicks from your messages.', sort: 7, face: 'sofia' },
  { name: 'Tunde', role: 'Billing and payments', bio: 'Local payments, bank transfers, receipts and top-ups.', sort: 8, face: 'tunde' },
  { name: 'Zara', role: 'Onboarding', bio: 'First channel, first Welcome Flow, first broadcast.', sort: 9, face: 'zara' },
  { name: 'Marcus', role: 'Technical support', bio: 'Delivery problems, blocked bots and Telegram limits.', sort: 10, face: 'marcus' },
  { name: 'Nadia', role: 'Customer support', bio: 'Sending, scheduling and audiences.', sort: 11, face: 'nadia' },
  { name: 'Emeka', role: 'Billing and payments', bio: 'Plans, renewals, wallet and payment checks.', sort: 12, face: 'emeka' },
  { name: 'Lucas', role: 'Customer success', bio: 'Follow-up flows that keep people engaged.', sort: 13, face: 'lucas' },
  { name: 'Priya', role: 'Technical support', bio: 'Groups, channels, admin rights and connections.', sort: 14, face: 'priya' },
  { name: 'Kofi', role: 'Customer support', bio: 'Account, team, setup helper and settings.', sort: 15, face: 'kofi' },
  { name: 'Elena', role: 'Onboarding', bio: 'Moving over from another tool, step by step.', sort: 16, face: 'elena' },
];

const OFFERS = [
  { kind: 'topup_bonus', title: 'Top up $200, get $10 extra', min_topup_cents: 20000, bonus_cents: 1000 },
  { kind: 'topup_bonus', title: 'Top up $500, get $40 extra', min_topup_cents: 50000, bonus_cents: 4000 },
  { kind: 'topup_bonus', title: 'Top up $1,000, get $60 extra', min_topup_cents: 100000, bonus_cents: 6000 },
  { kind: 'coupon', title: 'Welcome back: 20% off your first month', code: 'COMEBACK20', percent: 20, months: 1, description: 'Used in the win-back email after a trial ends.' },
];

async function run() {
  await db.tx(async (c) => {
    for (const p of PLANS) {
      await c.query(`insert into plans(code,name,tagline,price_month_cents,price_year_cents,connections,subscribers,ai_writes,seats,bullets,popular,sort,join_requests,flows,flow_steps,branding,features)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) on conflict (code) do nothing`,
      [p.code, p.name, p.tagline, p.price_month_cents, p.price_year_cents, p.connections, p.subscribers, p.ai_writes, p.seats, JSON.stringify(p.bullets), p.popular, p.sort,
        p.join_requests, p.flows, p.flow_steps, p.branding, JSON.stringify(p.features)]);
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
    // Old default texts the team never changed are moved to the new default (an edited text is never touched).
    // The announcement link moves with its text only (a team that wrote its own announcement keeps its link).
    await c.query(`update site_content set value = $1 where key = 'announcement_link' and value = '#ai'
      and exists (select 1 from site_content t where t.key = 'announcement_text' and t.value = $2)`, [CONTENT.announcement_link, CONTENT_OLD.announcement_text[0]]);
    for (const [k, olds] of Object.entries(CONTENT_OLD)) {
      for (const old of olds) await c.query('update site_content set value = $2 where key = $1 and value = $3', [k, CONTENT[k], old]);
    }
    for (const [code, olds] of Object.entries(PLAN_TAGLINES_OLD)) {
      const now = PLANS.find((p) => p.code === code).tagline;
      for (const old of olds) await c.query('update plans set tagline = $2 where code = $1 and tagline = $3', [code, now, old]);
    }
    const hasOffers = (await c.query('select count(*)::int n from offers')).rows[0].n;
    if (!hasOffers) {
      for (const o of OFFERS) {
        await c.query('insert into offers(kind,title,description,code,percent,min_topup_cents,bonus_cents,months) values ($1,$2,$3,$4,$5,$6,$7,$8)',
          [o.kind, o.title, o.description || '', o.code || null, o.percent || null, o.min_topup_cents || null, o.bonus_cents || null, o.months || 1]);
      }
    }
    const hasPersonas = (await c.query('select count(*)::int n from support_personas')).rows[0].n;
    if (!hasPersonas) {
      for (const p of PERSONAS) await c.query('insert into support_personas(name, role, bio, sort, face) values ($1,$2,$3,$4,$5)', [p.name, p.role, p.bio, p.sort, p.face]);
    }
    await syncKnowledge(c);
  });
  // Blog posts in server/blog-seed/*.md: each slug is added once, ever (never overwrites edits or brings back deletions).
  await require('./services/blog').syncSeed();
}

/*
 * Knowledge defaults (server/knowledge-defaults.js) are kept up to date on every start, WITHOUT touching the
 * team's work:
 *   - a default the team never edited is updated when its text in knowledge-defaults.js changes
 *   - a default the team edited in Admin → Cas knowledge (edited = true) is never overwritten
 *   - a default the team deleted (knowledge_removed) never comes back
 *   - articles the team wrote themselves (no key) are never touched
 *   - a default that was retired (RETIRED in knowledge-defaults.js) is removed, unless the team edited it
 * Older databases: an article with the same title as a default (or one of its `formerly` titles), which nobody
 * edited, is adopted as that default. This is the ONLY way knowledge defaults reach a database (a fresh one too).
 */
const kbHash = (k) => require('node:crypto').createHash('sha256').update(k.title + '\n' + k.body).digest('hex').slice(0, 16);
async function syncKnowledge(c) {
  const all = require('./knowledge-defaults');
  const defaults = all.filter((k) => k.key);
  const rows = (await c.query('select id, key, title, edited, updated_by, default_hash from knowledge')).rows;
  const removed = new Set((await c.query('select key from knowledge_removed')).rows.map((r) => r.key));
  const byKey = new Map(rows.filter((r) => r.key).map((r) => [r.key, r]));
  for (const k of defaults) {
    const h = kbHash(k);
    const row = byKey.get(k.key);
    if (row) {
      if (!row.edited && row.default_hash !== h) await c.query('update knowledge set title = $2, body = $3, default_hash = $4, updated_at = now() where id = $1 and not edited', [row.id, k.title, k.body, h]);
      continue;
    }
    if (removed.has(k.key)) continue;
    const legacy = rows.find((r) => !r.key && r.title === k.title)
      || rows.find((r) => !r.key && (k.formerly || []).includes(r.title));
    if (legacy) {
      legacy.key = k.key;
      if (legacy.edited || legacy.updated_by) await c.query('update knowledge set key = $2, edited = true where id = $1', [legacy.id, k.key]);
      else await c.query('update knowledge set key = $2, title = $3, body = $4, default_hash = $5, updated_at = now() where id = $1', [legacy.id, k.key, k.title, k.body, h]);
      continue;
    }
    await c.query('insert into knowledge(key, title, body, default_hash) values ($1,$2,$3,$4) on conflict do nothing', [k.key, k.title, k.body, h]);
  }
  const retired = (all.RETIRED || []).filter((key) => !defaults.some((k) => k.key === key));
  if (retired.length) await c.query('delete from knowledge where key = any($1::text[]) and not edited and updated_by is null', [retired]);
  // Left by an earlier one-time mechanism (Welcome Flows work, before keys existed); syncKnowledge replaces it.
  await c.query("delete from settings where key = 'knowledge_keys'");
}

module.exports = { run, syncKnowledge, FEATURE_SETS: { F_FREE, F_STARTER, F_GROWTH, F_SCALE }, PLANS, METHODS, COUNTRIES, SETTINGS, CONTENT, OFFERS, PERSONAS };

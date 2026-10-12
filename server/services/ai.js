'use strict';
/*
 * Cas, the AI helper (Claude direct by default; OpenRouter or OpenAI when chosen: see services/llm.js).
 * What Cas knows, in order:
 *   1. House rules           Admin → Cas AI (the team's own instructions)
 *   2. Castvoo knowledge     Admin → Cas knowledge (help articles)
 *   3. Live plans            from the plans table
 *   4. The customer's business  Dashboard → Ask Cas → Train Cas (ai_profile)
 *   5. The task              write / rewrite / translate / sequence / ask / support reply
 * Change the default model in Admin → Cas AI. Every call is logged in ai_usage.
 */

const db = require('../db');
const settings = require('./settings');
const llm = require('./llm');

const PERSONA = `You are Cas, the friendly AI helper inside Castvoo, a Telegram tool. Its main feature is Welcome Flows: when someone asks to join a channel or group, the customer's own bot welcomes them at once, lets them in (straight away, after the welcome, when they tap Start, or when the owner decides) and follows up: right away, after a wait, when they tap Start, when they tap a button, or with a reminder if they don't respond. Castvoo also sends broadcasts and automatic follow-up messages, and tracks button clicks.
Your voice: warm, clear, confident, never pushy. Short sentences. Plain words a 12-year-old understands.
Hard rules you never break:
- Never invent facts, numbers, prices, discounts, deadlines, testimonials or results. If you need a detail you don't have, write it as [ADD DETAIL] so the user fills it in.
- Never promise guaranteed income, profits, winnings or results. No "get rich", "100% sure", "risk-free". Trading and betting messages must stay factual and include no guarantees.
- Never write spam, scams, hate, harassment, adult content, or anything illegal or deceptive. If asked, refuse kindly in one sentence and offer an honest alternative.
- Only describe Castvoo features that are in the knowledge below. If something is not possible (like read receipts), say so honestly.
- To greet each person by their first name in a bot message, write {name} (e.g. "Hi {name}!"). Never use {name} in channel or group posts. Never invent other placeholders.
- Telegram formatting: use *bold* and _italic_ only. No other markdown (no #, no **, no links in brackets). Emojis are fine, 1 to 3 per message.`;

async function knowledgeText(limit = 60000) {
  const rows = await db.many('select title, body from knowledge where active order by id');
  let out = '';
  for (const r of rows) {
    const block = `## ${r.title}\n${r.body}\n\n`;
    if (out.length + block.length > limit) continue; // skip one that doesn't fit, keep trying smaller ones
    out += block;
  }
  return out;
}

// Plan features worth telling a customer about (keys from seed.js FEATURE_SETS). Others are shown as-is.
const FEATURE_TEXT = {
  auto_approve: 'auto-approve join requests', welcome_message: 'a welcome message', welcome_flows: 'Welcome Flows builder (follow-up messages that come right away, after a wait, when they tap Start or a button, or as a reminder; Reply buttons; manual approval; invite links)',
  tap_to_start: '"Tap to start" button', broadcasts: 'broadcasts', schedule: 'scheduling and 9am sending', drips: 'auto follow-ups', tracked_buttons: 'tracked buttons',
  basic_stats: 'stats', ai: 'Cas the AI helper', ab_welcome_2: 'A/B welcome (2 versions)', ab_welcome_4: 'A/B welcome (up to 4 versions)',
  condition_clicked: 'clicked / did not click conditions', cas_builder: 'Cas Builder (build a flow by chatting with Cas)', start_another_flow: '"Start another flow" on a Welcome Flow message', audiences: 'audiences', start_links: 'start links', flow_funnel_stats: 'flow funnel stats',
  onboarding_call: 'an onboarding call',
};
// What a plan without these features cannot do (said for the Free plan, so the AI never offers it there).
const NOT_ON_FREE = [['drips', 'follow-ups'], ['broadcasts', 'broadcasts'], ['tap_to_start', 'tap-to-start'], ['basic_stats', 'stats'], ['audiences', 'audiences'], ['start_links', 'start links'], ['ai', 'AI writes']];

/**
 * The live plan list as plain text, for Cas, the AI support team and the website chat. Pure (no database), so
 * scripts/check.js can check that every price and limit in seed.js reaches the AI. Knowledge articles never repeat
 * these numbers.
 */
function formatPlans(plans, t = {}, billing = null, cas = null) {
  const n = (v) => (v == null || Number(v) < 0 ? 'unlimited' : Number(v).toLocaleString('en-US'));
  const isFree = (p) => Number(p.price_month_cents) === 0 && Number(p.price_year_cents || 0) === 0;
  let prev = [];
  const lines = plans.map((p, i) => {
    const f = Array.isArray(p.features) ? p.features : [];
    const added = f.filter((k) => !prev.includes(k));
    prev = f;
    if (isFree(p)) {
      const no = NOT_ON_FREE.filter(([k]) => !f.includes(k)).map(([, w]) => w);
      return `- ${p.name}: $0, no card; ${n(p.connections)} channel or group plus its own welcome bot; ${n(p.join_requests)} join requests a month; ${n(p.flows)} Welcome Flow with ${n(p.flow_steps)} welcome message (text or 1 photo, up to 3 link buttons, {name})`
        + (Number(p.ai_writes) ? `; ${n(p.ai_writes)} AI writes a month` : '') + casLine(p, true) + `; ${n(p.seats)} seat${Number(p.seats) === 1 ? '' : 's'}`
        + (f.length ? `; includes: ${f.map((k) => FEATURE_TEXT[k] || k).join(', ')}` : '')
        + (no.length ? `; no ${no.join(', ')}` : '')
        + (p.branding ? '; every welcome ends with "⚡ Free welcome bot by Castvoo.com" (cannot be removed on this plan)' : '');
    }
    return `- ${p.name}: $${Number(p.price_month_cents) / 100}/month or $${Number(p.price_year_cents) / 100}/year; ${n(p.connections)} connections; ${n(p.subscribers)} bot subscribers (channel and group members are free)`
      + `; ${n(p.join_requests)} join requests a month; ${n(p.flows)} Welcome Flows with ${n(p.flow_steps)} messages each; ${n(p.ai_writes)} AI writes a month` + casLine(p, false) + `; ${n(p.seats)} seat${Number(p.seats) === 1 ? '' : 's'}`
      + (added.length ? `; ${i > 0 ? 'adds' : 'includes'}: ${added.map((k) => FEATURE_TEXT[k] || k).join(', ')}` : '')
      + (p.branding ? '; welcomes end with "⚡ Free welcome bot by Castvoo.com"' : '');
  });
  return lines.join('\n')
    + botsLines(plans) + repeatsLine(plans)
    + `\nEach plan includes everything in the plan before it.`
    + (t.days ? `\nFree trial: ${t.days} days of ${(plans.find((p) => p.code === t.plan) || {}).name || t.plan}, no card needed, ${n(t.ai_writes)} AI writes and ${n(t.join_requests ?? -1)} join requests during the trial. If no plan is paid when it ends, the workspace moves to the Free plan (not paused).` : '')
    + seatLine(billing) + packLine(plans, billing) + casPackLine(cas);
}
/**
 * Subscriber packs on the top plan (Admin → Settings → Billing sub_pack_*): one line for the live plan list, with what
 * happens over the limit and "talk to us" above the most packs. Without packs on sale, only the over-limit rules.
 */
function packLine(plans, b) {
  let isTop;
  try { isTop = require('./billing').isTopPlan; } catch { return ''; }
  const top = (plans || []).filter((p) => isTop(p)).sort((a, x) => Number(a.price_month_cents) - Number(x.price_month_cents))[0];
  if (!top) return '';
  const size = Number((b && b.sub_pack_size) ?? 50000), price = Number((b && b.sub_pack_price_cents) ?? 2900), max = Number((b && b.sub_pack_max) ?? 8);
  const n = (v) => Number(v).toLocaleString('en-US');
  const usd = (x) => '$' + (x / 100).toLocaleString('en-US', { minimumFractionDigits: x % 100 ? 2 : 0, maximumFractionDigits: 2 });
  const over = `\nOver the bot subscriber limit (plus 10% extra): bots keep working and answering, new subscribers are still saved, channel and group members never count, only broadcasts to bot subscribers pause until there is room again; nothing is deleted.`;
  if (!(price > 0 && max > 0 && size > 0)) return over + ` Above the ${top.name} plan: talk to us (Help chat or the support email) for a custom plan.`;
  return over + `\nSubscriber packs (${top.name} plan only): +${n(size)} bot subscribers for ${usd(price)} a month per pack (yearly plans: ${usd(price * 12)} a year), up to ${max} packs (${n(Number(top.subscribers) + size * max)} bot subscribers in all), added in Wallet and plan → Subscriber packs (or the "Add ${n(size)} subscribers" button when the limit is reached) and paid from the wallet: the first payment covers the days left of the current period, then packs renew with the plan. Fewer packs start at the next renewal (nothing is deleted). Starter and Growth customers upgrade to ${top.name} first. Need more than ${n(Number(top.subscribers) + size * max)}, or a custom deal? Talk to us (Help chat or the support email) for a custom plan.`;
}
/** Bots limits per plan (billing.BOT_PLANS, chosen by plan code or features): live bots, bot types, lead answers... */
function botsLines(plans) {
  let botPlanOf;
  try { botPlanOf = require('./billing').botPlanOf; } catch { return ''; }
  const n = (v) => (v == null || Number(v) < 0 ? 'unlimited' : Number(v).toLocaleString('en-US'));
  const words = { welcome: 'Welcome', join_check: 'Join-check', lead_magnet: 'Free gift (lead magnet)', menu: 'Menu', broadcast: 'Broadcast to bot subscribers', lead_questions: 'Lead questions', referral: 'Invite friends (referral)' };
  const rows = plans.map((p) => {
    const b = botPlanOf(p);
    return `- ${p.name} bots: ${n(b.max_bots)}${b.max_bots_fair_use ? ' (fair use ' + b.max_bots_fair_use + ')' : ''} live bots (Welcome + Chat bots switched on; drafts don't count); types: ${b.bot_types.map((t) => words[t] || t).join(', ')}; ${b.bot_steps === 1 ? '1 message per reply' : n(b.bot_steps) + ' messages per bot'}; ${n(b.menu_buttons)} menu buttons; `
      + (b.lead_questions_per_form ? `${n(b.lead_questions_per_form)} lead questions per bot, ${n(b.lead_answers_per_month)} lead answers a month, lead CSV for the owner; ` : 'no lead questions; ')
      + (b.referral_bots ? `${n(b.referral_bots)}${b.referral_bots_fair_use ? ' (fair use ' + b.referral_bots_fair_use + ')' : ''} live invite-friends bots; ` : 'no invite-friends bots; ')
      + `${b.concurrent_sessions_per_seat} logged-in devices per person` + (b.branding ? '; each bot\'s first message ends with "⚡ Free bot by Castvoo.com"' : '');
  });
  return rows.length ? '\nBots (🤖 Bots page):\n' + rows.join('\n') + '\nThe trial has the Growth bot limits with 300 lead answers. Lead answers get 10% extra; after that the bot still says thanks and the answers are kept hidden until next month or an upgrade.' : '';
}
/** Repeating messages a plan runs at a time (billing.js BOT_PLANS max_repeat_series): one line for the live plan list. */
function repeatsLine(plans) {
  let botPlanOf;
  try { botPlanOf = require('./billing').botPlanOf; } catch { return ''; }
  const parts = plans.map((p) => {
    const b = botPlanOf(p);
    const m = b.max_repeat_series ?? 0;
    return `${p.name} ${m === -1 ? `unlimited (fair use ${b.max_repeat_series_fair_use || 100})` : m === 0 ? 'none' : m}`;
  });
  return parts.length ? `\nRepeating messages running at a time (Send a message → "Repeat this message"; paused ones don't count): ${parts.join('; ')}.` : '';
}
/** Cas credits (Admin → Cas AI → Cas Builder): one line, or nothing when not sold. */
function casPackLine(c) {
  if (!c) return '';
  const price = Math.max(0, Number(c.credit_pack_price_cents) || 0), n = Math.max(0, Number(c.credit_pack_builds) || 0);
  const fair = Number(c.fair_use_monthly) || 0;
  return `\nCas Builder (Welcome Flows → New flow → Cas Builder): build a flow by chatting with Cas; editing an existing flow by chat never counts as a build.`
    + (fair ? ` "Unlimited" builds are fair use (about ${fair.toLocaleString('en-US')} a month).` : '')
    + (price && n ? ` When a plan's builds run out: keep building in the builder (free), upgrade, or buy Cas credits: ${n} builds for $${(price / 100).toLocaleString('en-US', { minimumFractionDigits: price % 100 ? 2 : 0 })} from the wallet (cash, not bonus credit; they don't expire).` : '');
}
/** Cas Builder builds on a plan (plans.cas_builds): new flows built by chatting with Cas; Free counts for the life of the workspace. */
function casLine(p, free) {
  const v = p.cas_builds == null ? 0 : Number(p.cas_builds);
  if (!v) return '';
  if (v < 0) return '; unlimited Cas Builder builds (fair use)';
  if (free) return `; Cas Builder: ${v === 1 ? 'the first flow' : v.toLocaleString('en-US') + ' flows'} built by chatting with Cas (for the life of the workspace)`;
  return `; ${v.toLocaleString('en-US')} Cas Builder builds a month`;
}
/** Extra team seats (Admin → Settings → Billing): one line for the live plan list, or nothing when not sold. */
function seatLine(b) {
  const c = b ? Math.max(0, Number(b.seat_price_cents ?? 500)) : 0;
  if (!c) return '';
  const usd = (x) => '$' + (x / 100).toLocaleString('en-US', { minimumFractionDigits: x % 100 ? 2 : 0, maximumFractionDigits: 2 });
  return `\nExtra team seats: ${usd(c)} a month per seat on any paid plan (yearly plans: ${usd(c * 12)} a year per seat), added by the owner in Settings → Team and paid from the wallet together with the plan (the first payment covers the days left of the current period). Fewer seats start at the next renewal. Not on the Free plan or during the trial. The setup helper never uses a seat.`;
}
async function plansText() {
  const plans = await settings.plans({ activeOnly: true });
  const t = await settings.get('trial');
  return formatPlans(plans, t || {}, await settings.get('billing'), { ...require('./cas-builder').DEFAULTS, ...((await settings.get('cas_builder')) || {}) });
}

/** plansText() that never fails a support answer (a plan edited mid-way, a missing trial plan...). */
async function plansTextSafe() {
  try { return await plansText(); } catch { return 'See the Pricing page for current plans.'; }
}

function profileText(p) {
  if (!p || !Object.keys(p).length) return 'The user has not trained you on their business yet. Write in a friendly general style, and use [ADD DETAIL] for product names, prices and links.';
  const L = [];
  if (p.business) L.push(`Business name: ${p.business}`);
  if (p.what_you_sell) L.push(`What they sell or share: ${p.what_you_sell}`);
  if (p.audience) L.push(`Their audience: ${p.audience}`);
  if (p.tone) L.push(`Tone of voice: ${p.tone}`);
  if (p.language) L.push(`Default language: ${p.language}`);
  if (p.offers) L.push(`Current offers (only use these, never invent others): ${p.offers}`);
  if (p.links) L.push(`Their links: ${p.links}`);
  if (p.always) L.push(`Always: ${p.always}`);
  if (p.never) L.push(`Never: ${p.never}`);
  if (p.faqs && p.faqs.length) L.push('Their FAQs:\n' + p.faqs.map((f) => `Q: ${f.q}\nA: ${f.a}`).join('\n'));
  if (p.examples && p.examples.length) L.push('Messages they wrote before (copy this style):\n' + p.examples.map((e, i) => `Example ${i + 1}:\n${e}`).join('\n\n'));
  return L.join('\n');
}

/**
 * The instructions Cas gets, as two blocks:
 *   1. the same for everyone (persona, house rules, knowledge, plans): marked for prompt caching,
 *      so the API charges about a tenth for it on repeat calls within a few minutes;
 *   2. this customer's business and the task details.
 */
async function systemPrompt({ profile, extra = '' }) {
  const ai = await settings.get('ai');
  const shared = [
    PERSONA,
    ai.house_rules ? `House rules from the Castvoo team:\n${ai.house_rules}` : '',
    `# Castvoo knowledge\n${await knowledgeText()}`,
    `# Current plans\n${await plansText()}`,
  ].filter(Boolean).join('\n\n');
  const mine = [
    profile !== undefined ? `# The user's business\n${profileText(profile)}` : '',
    extra,
  ].filter(Boolean).join('\n\n');
  const blocks = [{ type: 'text', text: shared, cache_control: { type: 'ephemeral' } }];
  if (mine) blocks.push({ type: 'text', text: mine });
  return blocks;
}

/**
 * One call to the AI provider in use (Claude direct by default, or OpenRouter / OpenAI: see services/llm.js).
 * Returns { text, usage } with usage.input_tokens / output_tokens (plus provider, model and, on OpenRouter, cost_usd).
 */
async function complete(opts) { return llm.complete(opts); }

const clean = (t) => String(t || '').replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/^#+\s*/gm, '').replace(/^["“]|["”]$/g, '').trim();

const TASKS = {
  write: (b) => `Write ONE Telegram message.
Goal: ${b.goal}
${b.tone ? 'Tone: ' + b.tone : ''}
${b.language ? 'Language: ' + b.language : ''}
Length: ${b.length === 'short' ? 'under 300 characters' : b.length === 'long' ? 'up to 900 characters' : 'about 400 to 600 characters'}.
Hard limit: ${b.max_chars || 1024} characters.
${b.kind === 'channel' || b.kind === 'group' ? 'It is a post in a channel or group, so do not address one person by name.'
    : b.kind === 'welcome' ? 'It is the Welcome Flow welcome: the bot sends it the moment someone asks to join the channel or group. Greet them with {name}, say what they get from the channel, and keep it short.'
    : b.kind === 'followup' ? 'It is a later Welcome Flow message, sent some time after someone joined the channel and tapped Start in the bot.'
    : 'It goes to people who started a bot.'}
Start with a strong first line (it shows in the notification). End with one clear next step. Reply with the message text only, no explanation.`,
  rewrite: (b) => `Rewrite this Telegram message to make it ${({ shorter: 'shorter (about half the length)', clearer: 'clearer and easier to read', urgent: 'more urgent, using only the real deadline or reason already in it', friendlier: 'warmer and friendlier', fix: 'correct in spelling and grammar, changing nothing else' })[b.how] || 'better'}.
Keep every fact, price, link and name exactly as it is. Keep it under ${b.max_chars || 1024} characters. Reply with the new message only.

Message:
${b.text}`,
  translate: (b) => `Translate this Telegram message into ${b.language}. Keep the meaning, tone, emojis, *bold* and _italic_ marks, prices and links exactly. Use natural, everyday ${b.language}. Reply with the translation only.

Message:
${b.text}`,
  sequence: (b) => `Write an automatic follow-up sequence of exactly ${b.steps} Telegram messages.
Goal: ${b.goal}
${b.trigger ? 'It starts when: ' + b.trigger : ''}
${b.language ? 'Language: ' + b.language : ''}
The first message is sent straight away (wait 0 minutes) and welcomes the person. Space the rest out sensibly (for example 1 day, 3 days, 7 days). Each message under 700 characters with one clear next step.
Reply with ONLY a JSON array, no other text, like:
[{"delay_value":0,"delay_unit":"min","body":"..."},{"delay_value":1,"delay_unit":"day","body":"..."}]
delay_unit is one of "sec", "min", "hour", "day" (use "sec" only when the goal asks for a message a few seconds after the one before).`,
  flow: (b) => `Build a Castvoo Welcome Flow from this description: "${b.prompt}"
A Welcome Flow is what the customer's bot sends to someone who asks to join their Telegram channel. Message 1 is the welcome, sent the moment they ask to join. Every later message says WHEN it comes (its "trigger"):
- "after_previous": right after the message above.
- "wait": after a pause ("seconds": how long, for example 3600 for 1 hour, 86400 for 1 day).
- "on_start": the moment they tap Start in the bot (then set "start_button": true so the welcome shows a Tap Start button).
- "on_button": when they tap a button of a message above ("button": that button's id). Give each choice its own answer message, one after the other.
- "no_response": a reminder if they have not tapped Start or a button of the message above after "seconds".
Buttons: "kind": "reply" (a choice they tap, no link) or "link" (opens a web page; "url" stays "" unless the description gives an https link). Each button has a short "id" (small letters and numbers, unique in the flow) and a "label" under 30 characters, often starting with an emoji.
Telegram's rule: before they tap Start, the bot may message them only in the first 5 minutes. So anything later than 5 minutes should come after "on_start", or be a reminder that asks them to tap Start.
Use at most ${b.max} messages. Each message under 500 characters, warm and short, greeting with {name} in the welcome. Use [ADD DETAIL] for any fact you don't have.
Reply with ONLY one JSON object, no other text, exactly in this shape (no other fields):
{"name":"short flow name","approve_mode":"after_welcome","start_button":true,"start_label":"👆 Tap Start","messages":[{"body":"...","buttons":[]},{"body":"...","buttons":[{"id":"vip","label":"⭐ VIP","kind":"reply"}],"trigger":{"type":"on_start"}},{"body":"...","trigger":{"type":"on_button","button":"vip"}}]}`,
};

/** Workspace stats Cas can see when answering "how did my sends go?" questions. */
async function workspaceFacts(ws) {
  const billing = require('./billing');
  const [u, top, sources, last] = await Promise.all([
    billing.usage(ws.id),
    db.many(`select b.title, b.sent, b.total, b.started_at, (select count(*)::int from clicks k join links l on l.code = k.code where l.broadcast_id = b.id) clicks
      from broadcasts b where b.workspace_id = $1 and b.status = 'sent' order by b.id desc limit 8`, [ws.id]),
    db.many(`select s.source, count(*)::int n from subscribers s join connections c on c.id = s.connection_id where c.workspace_id = $1 and s.source is not null group by 1 order by 2 desc limit 8`, [ws.id]),
    db.one(`select count(*)::int n from subscribers s join connections c on c.id = s.connection_id where c.workspace_id = $1 and s.joined_at > now() - interval '7 days'`, [ws.id]),
  ]);
  // The bot subscriber limit (plan + Scale subscriber packs, or the team's custom limit).
  let allowed = '';
  try {
    const l = await billing.limits(ws);
    allowed = ` of ${Number(l.subscribers).toLocaleString('en-US')} allowed` + (l.subscriber_packs ? ` (plan ${Number(l.plan_subscribers).toLocaleString('en-US')} + ${l.subscriber_packs} subscriber packs)` : '') + (l.custom_subscriber_limit ? ' (custom limit from the team)' : '');
  } catch { /* plan missing: leave the limit out */ }
  return `# This workspace right now (real data)
Plan: ${ws.plan_code} (${ws.plan_status}). Connections: ${u.connections}. Bot subscribers (count toward the plan): ${u.bot_subscribers}${allowed}. Channel/group members (free, not counted): ${u.chat_members}. New subscribers in the last 7 days: ${last.n}.
Recent broadcasts (title · delivered · clicks · when):
${top.map((t) => `- ${t.title} · ${t.sent}/${t.total} · ${t.clicks} clicks · ${t.started_at ? new Date(t.started_at).toISOString().slice(0, 16).replace('T', ' ') : ''}`).join('\n') || '- none yet'}
Where subscribers came from (start link tags): ${sources.map((s) => `${s.source} ${s.n}`).join(', ') || 'no tagged start links yet'}.
Only use these numbers. Castvoo has no read receipts, so never talk about read rates.`;
}

module.exports = { systemPrompt, complete, clean, TASKS, workspaceFacts, knowledgeText, formatPlans, plansText, plansTextSafe, profileText, PERSONA };

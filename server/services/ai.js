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

const PERSONA = `You are Cas, the friendly AI helper inside Castvoo, a Telegram tool. Its main feature is Welcome Flows: when someone asks to join a channel or group, the customer's own bot welcomes them at once, lets them in (straight away, after the welcome, when they tap a button, or when the owner decides) and can follow up later. Castvoo also sends broadcasts and automatic follow-up messages, and tracks button clicks.
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
  auto_approve: 'auto-approve join requests', welcome_message: 'a welcome message', welcome_flows: 'Welcome Flows builder (steps, waits, buttons, manual approval, invite links)',
  tap_to_start: '"Tap to start" button', broadcasts: 'broadcasts', schedule: 'scheduling and 9am sending', drips: 'auto follow-ups', tracked_buttons: 'tracked buttons',
  basic_stats: 'stats', ai: 'Cas the AI helper', ab_welcome_2: 'A/B welcome (2 versions)', ab_welcome_4: 'A/B welcome (up to 4 versions)',
  condition_clicked: 'clicked / did not click conditions', audiences: 'audiences', start_links: 'start links', flow_funnel_stats: 'flow funnel stats',
  onboarding_call: 'an onboarding call',
};
// What a plan without these features cannot do (said for the Free plan, so the AI never offers it there).
const NOT_ON_FREE = [['drips', 'follow-ups'], ['broadcasts', 'broadcasts'], ['tap_to_start', 'tap-to-start'], ['basic_stats', 'stats'], ['audiences', 'audiences'], ['start_links', 'start links'], ['ai', 'AI writes']];

/**
 * The live plan list as plain text, for Cas, the AI support team and the website chat. Pure (no database), so
 * scripts/check.js can check that every price and limit in seed.js reaches the AI. Knowledge articles never repeat
 * these numbers.
 */
function formatPlans(plans, t = {}) {
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
        + (Number(p.ai_writes) ? `; ${n(p.ai_writes)} AI writes a month` : '') + `; ${n(p.seats)} seat${Number(p.seats) === 1 ? '' : 's'}`
        + (f.length ? `; includes: ${f.map((k) => FEATURE_TEXT[k] || k).join(', ')}` : '')
        + (no.length ? `; no ${no.join(', ')}` : '')
        + (p.branding ? '; every welcome ends with "⚡ Free welcome bot by Castvoo.com" (cannot be removed on this plan)' : '');
    }
    return `- ${p.name}: $${Number(p.price_month_cents) / 100}/month or $${Number(p.price_year_cents) / 100}/year; ${n(p.connections)} connections; ${n(p.subscribers)} bot subscribers (channel and group members are free)`
      + `; ${n(p.join_requests)} join requests a month; ${n(p.flows)} Welcome Flows with ${n(p.flow_steps)} messages each; ${n(p.ai_writes)} AI writes a month; ${n(p.seats)} seat${Number(p.seats) === 1 ? '' : 's'}`
      + (added.length ? `; ${i > 0 ? 'adds' : 'includes'}: ${added.map((k) => FEATURE_TEXT[k] || k).join(', ')}` : '')
      + (p.branding ? '; welcomes end with "⚡ Free welcome bot by Castvoo.com"' : '');
  });
  return lines.join('\n')
    + `\nEach plan includes everything in the plan before it.`
    + (t.days ? `\nFree trial: ${t.days} days of ${(plans.find((p) => p.code === t.plan) || {}).name || t.plan}, no card needed, ${n(t.ai_writes)} AI writes and ${n(t.join_requests ?? -1)} join requests during the trial. If no plan is paid when it ends, the workspace moves to the Free plan (not paused).` : '');
}
async function plansText() {
  const plans = await settings.plans({ activeOnly: true });
  const t = await settings.get('trial');
  return formatPlans(plans, t || {});
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
  return `# This workspace right now (real data)
Plan: ${ws.plan_code} (${ws.plan_status}). Connections: ${u.connections}. Bot subscribers (count toward the plan): ${u.bot_subscribers}. Channel/group members (free, not counted): ${u.chat_members}. New subscribers in the last 7 days: ${last.n}.
Recent broadcasts (title · delivered · clicks · when):
${top.map((t) => `- ${t.title} · ${t.sent}/${t.total} · ${t.clicks} clicks · ${t.started_at ? new Date(t.started_at).toISOString().slice(0, 16).replace('T', ' ') : ''}`).join('\n') || '- none yet'}
Where subscribers came from (start link tags): ${sources.map((s) => `${s.source} ${s.n}`).join(', ') || 'no tagged start links yet'}.
Only use these numbers. Castvoo has no read receipts, so never talk about read rates.`;
}

module.exports = { systemPrompt, complete, clean, TASKS, workspaceFacts, knowledgeText, formatPlans, plansText, plansTextSafe, profileText, PERSONA };

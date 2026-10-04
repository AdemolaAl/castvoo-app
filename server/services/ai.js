'use strict';
/*
 * Cas, the AI helper (Anthropic Claude API).
 * What Cas knows, in order:
 *   1. House rules           Admin → Cas AI (the team's own instructions)
 *   2. Castvoo knowledge     Admin → Cas knowledge (help articles)
 *   3. Live plans            from the plans table
 *   4. The customer's business  Dashboard → Ask Cas → Train Cas (ai_profile)
 *   5. The task              write / rewrite / translate / sequence / ask / support reply
 * Change the default model in Admin → Cas AI. Every call is logged in ai_usage.
 */

const db = require('../db');
const config = require('../config');
const settings = require('./settings');
const log = require('../lib/log');
const { httpError } = require('../lib/util');

const PERSONA = `You are Cas, the friendly AI helper inside Castvoo, a tool for sending Telegram broadcasts and automatic follow-up messages.
Your voice: warm, clear, confident, never pushy. Short sentences. Plain words a 12-year-old understands.
Hard rules you never break:
- Never invent facts, numbers, prices, discounts, deadlines, testimonials or results. If you need a detail you don't have, write it as [ADD DETAIL] so the user fills it in.
- Never promise guaranteed income, profits, winnings or results. No "get rich", "100% sure", "risk-free". Trading and betting messages must stay factual and include no guarantees.
- Never write spam, scams, hate, harassment, adult content, or anything illegal or deceptive. If asked, refuse kindly in one sentence and offer an honest alternative.
- Only describe Castvoo features that are in the knowledge below. If something is not possible (like read receipts), say so honestly.
- To greet each person by their first name in a bot message, write {name} (e.g. "Hi {name}!"). Never use {name} in channel or group posts. Never invent other placeholders.
- Telegram formatting: use *bold* and _italic_ only. No other markdown (no #, no **, no links in brackets). Emojis are fine, 1 to 3 per message.`;

async function knowledgeText() {
  const rows = await db.many('select title, body from knowledge where active order by id');
  let out = '';
  for (const r of rows) {
    const block = `## ${r.title}\n${r.body}\n\n`;
    if (out.length + block.length > 24000) break;
    out += block;
  }
  return out;
}

async function plansText() {
  const plans = await settings.plans({ activeOnly: true });
  const t = await settings.get('trial');
  return plans.map((p) => `- ${p.name}: $${p.price_month_cents / 100}/month or $${p.price_year_cents / 100}/year; ${p.connections} connections; ${p.subscribers.toLocaleString('en-US')} bot subscribers (channel and group members are free); ${p.ai_writes.toLocaleString('en-US')} AI writes a month; ${p.seats} seats`).join('\n')
    + `\nFree trial: ${t.days} days of ${t.plan}, no card needed, ${t.ai_writes} AI writes during the trial.`;
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

/** One call to the Claude API. Returns { text, usage }. */
async function complete({ system, messages, maxTokens, temperature }) {
  if (!config.ai.apiKey) throw httpError(503, 'Cas is not switched on yet on this server (ANTHROPIC_API_KEY is missing).', 'ai_not_configured');
  const ai = await settings.get('ai');
  const r = await fetch(config.ai.apiBase + '/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': config.ai.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: ai.model, max_tokens: maxTokens || ai.max_output_tokens || 900, temperature: temperature ?? ai.temperature ?? 0.7, system, messages }),
    signal: AbortSignal.timeout(60000),
  }).catch((e) => { log.warn('AI request failed', { err: e.message }); throw httpError(502, 'Cas could not be reached. Please try again.', 'ai_down'); });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 429 || r.status === 529) throw httpError(503, 'Cas is very busy right now. Please try again in a minute.', 'ai_busy');
    // The provider's own error text stays in our logs; customers get a plain message.
    log.warn('AI provider error', { status: r.status, err: (j.error && j.error.message) || '' });
    throw httpError(502, 'Cas had a problem answering. Please try again.', 'ai_error');
  }
  const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return { text, usage: j.usage || {} };
}

const clean = (t) => String(t || '').replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/^#+\s*/gm, '').replace(/^["“]|["”]$/g, '').trim();

const TASKS = {
  write: (b) => `Write ONE Telegram message.
Goal: ${b.goal}
${b.tone ? 'Tone: ' + b.tone : ''}
${b.language ? 'Language: ' + b.language : ''}
Length: ${b.length === 'short' ? 'under 300 characters' : b.length === 'long' ? 'up to 900 characters' : 'about 400 to 600 characters'}.
Hard limit: ${b.max_chars || 1024} characters.
${b.kind === 'channel' || b.kind === 'group' ? 'It is a post in a channel or group, so do not address one person by name.' : 'It goes to people who started a bot.'}
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
delay_unit is one of "min", "hour", "day".`,
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

module.exports = { systemPrompt, complete, clean, TASKS, workspaceFacts, knowledgeText, profileText, PERSONA };

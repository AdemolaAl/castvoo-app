'use strict';
/*
 * Bots (dashboard → 🤖 Bots, docs/BOTS.md). One section, one builder (public/js/app-flows.js), two ways to start:
 *   👋 Welcome bot  someone asks to join the channel or group (sequences.trigger_type 'join_request', the Welcome
 *                   Flows made before; services/flows.js)
 *   💬 Chat bot     someone opens the customer's own bot through t.me/<bot>?start=<code> and taps Start
 *                   (trigger_type 'bot_start', trigger_value = the code). One Chat bot per Telegram bot can also answer a
 *                   plain /start (sequences.is_default). The person becomes a bot subscriber.
 * Both run on services/flow-runtime.js. This file has what is new for bots:
 *   Step types (sequence_steps.step_type + config, checked by cleanSpecial):
 *     message     as before
 *     check_join  ✅ "Check they joined": the message, a link to the channel and "I've joined ✅". The tap asks Telegram
 *                 (getChatMember; the bot must be an admin there, checked when saving). Joined → the next step. Not
 *                 joined → a gentle popup. Optional reminder if they don't tap. Works in Welcome bots too (not as the
 *                 welcome itself).
 *     ask         ❓ "Ask a question": waits for their reply, checks it by type (text, number, email, phone with a
 *                 "share my number" button, choice buttons), saves it (bot_answers) and goes on. Optional reminder.
 *     referral    🔗 "Invite friends": their own link t.me/<bot>?start=r_<code> and progress ({invite_link},
 *                 {invites}, {goal} in the text). The reward is the next message, trigger 'on_goal'.
 *   Referral counting (recordReferral): only people NEW to that Telegram bot, never themselves, at most
 *   MAX_REFERRALS_PER_DAY counted per inviter a day; every invite is kept with the reason it did not count.
 *   The Free plan's line "⚡ Free bot by Castvoo.com" goes on the first message of each Chat bot (deliveries.extra.brand).
 * Telegram callback data: "cvj:<step id>" (I've joined), "cva:<step id>:<choice>" (a choice answer), "cvr:<bot id>"
 * (my invite link / progress); commands /invite and /mylink show the invite link too.
 * Extension point: STEP_TYPES / START_TYPES are the only lists to grow (paid memberships and the AI chat bot are separate
 * products and are not built here).
 */

const db = require('../db');
const log = require('../lib/log');
const tg = require('./telegram');
const billing = require('./billing');
const { tokenOf } = require('./connections');
const { str, int, oneOf, badRequest, httpError, randomCode } = require('../lib/util');

const flows = () => require('./flows');
const runtime = () => require('./flow-runtime');
const soon = () => require('../workers/soon');

const START_TYPES = ['join_request', 'bot_start'];
const STEP_TYPES = ['message', 'check_join', 'ask', 'referral'];
const SPECIAL = ['check_join', 'ask', 'referral'];
const WAITING_STEPS = ['check_join', 'ask']; // the run waits on these until the person does something
const ANSWER_TYPES = ['text', 'number', 'email', 'phone', 'choice'];
const BOT_TYPES_BUILD = ['join_check', 'lead_magnet', 'menu', 'lead_questions', 'referral', 'custom'];
const CODE_RX = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED_RX = /^(j_|cvf_|cvt|r_|cv_)/i;
const BOT_BRAND_TEXT = 'Free bot by Castvoo.com';
const MAX_REFERRALS_PER_DAY = 50;
const MAX_CHOICES = 8;
const DEFAULTS = {
  open_label: '📣 Open the channel',
  join_label: 'I\'ve joined ✅',
  nudge: 'Looks like you haven\'t joined yet 🙂 Tap the link above, then tap I\'ve joined.',
  check_remind: 'Just a gentle reminder 🙂 Join the channel with the link above, then tap "I\'ve joined".',
  ask_remind: 'Just a gentle reminder 🙂 Whenever you\'re ready, send your answer here.',
  phone_button: '📱 Share my phone number',
};
const LABELS = { text: 'Answer', number: 'Number', email: 'Email', phone: 'Phone', choice: 'Choice' };
const RETRY = {
  text: 'Please type your answer 🙂',
  number: 'Please send a number, like 25 🙂',
  email: 'That doesn\'t look like an email address. Please send it like name@example.com 🙂',
  phone: 'Please send your phone number with the country code, like +234 801 234 5678, or tap the button below 🙂',
  choice: 'Please tap one of the buttons above 🙂',
};

/* ---------- Pure helpers (also used by the flow test and copied in public/js/app-flows.js) ---------- */

/**
 * Check one answer. type: ANSWER_TYPES. raw: the text they sent, or { phone } from a shared contact.
 * Returns { ok: true, value } or { ok: false, message } (a gentle "try again").
 */
function validateAnswer(type, raw, cfg = {}) {
  const retry = String(cfg.retry_text || '').trim() || RETRY[type] || RETRY.text;
  const bad = { ok: false, message: retry };
  if (raw && typeof raw === 'object' && raw.phone) {
    if (type !== 'phone') return bad;
    raw = String(raw.phone);
  }
  const t = String(raw == null ? '' : raw).trim();
  if (!t || t.startsWith('/')) return bad;
  if (type === 'text') return t.length <= 1000 ? { ok: true, value: t } : { ok: false, message: 'That\'s a little long. Please keep it under 1,000 characters 🙂' };
  if (type === 'number') {
    const s = t.replace(/[\s,]/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(s) || s.length > 18) return bad;
    return { ok: true, value: String(Number(s)) };
  }
  if (type === 'email') {
    const s = t.toLowerCase();
    if (s.length > 254 || !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[a-z]{2,}$/.test(s)) return bad;
    return { ok: true, value: s };
  }
  if (type === 'phone') {
    if (!/^\+?[\d\s().-]{7,24}$/.test(t)) return bad;
    const digits = t.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) return bad;
    return { ok: true, value: (t.startsWith('+') ? '+' : '') + digits };
  }
  if (type === 'choice') {
    const choices = (cfg.choices || []).map(String);
    const norm = (x) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const n = /^\d{1,2}$/.test(t) ? Number(t) : 0;
    const hit = n >= 1 && n <= choices.length ? choices[n - 1] : choices.find((c) => norm(c) === norm(t) && norm(t));
    return hit ? { ok: true, value: hit } : bad;
  }
  return bad;
}

/** The text of an invite step for one person: {invite_link}, {invites}, {goal} (the link is added when the text has none). */
function fillInvite(body, { link, invites, goal }) {
  let out = String(body || '');
  const had = out.includes('{invite_link}');
  out = out.replace(/\{invite_link\}/g, link).replace(/\{invites\}/g, String(invites)).replace(/\{goal\}/g, String(goal));
  if (!had) out += `\n\n🔗 ${link}`;
  return out;
}

/** What a Chat bot is, from its steps (shown in the list; the plan checks look at the steps themselves). */
function botTypeOf(steps) {
  const types = new Set(steps.map((s) => s.step_type || s.type || 'message'));
  if (types.has('referral')) return 'referral';
  if (types.has('ask')) return 'lead_questions';
  if (types.has('check_join')) return 'join_check';
  if (steps.some((s) => (s.trigger_type || (s.trigger && s.trigger.type)) === 'on_button')) return 'menu';
  return 'lead_magnet';
}

/** A Chat bot's start code: letters, numbers, _ and - (up to 64, Telegram's rule), not one Castvoo uses itself. */
function cleanStartCode(v) {
  const code = String(v == null ? '' : v).trim();
  if (!code) return 'bot' + randomCode(5);
  if (!CODE_RX.test(code)) throw badRequest('The start link code can use letters, numbers, _ and - (up to 64), like "gift" or "ad_june".');
  if (RESERVED_RX.test(code)) throw badRequest('That start link code is used by Castvoo itself. Pick another one, like "gift".');
  return code;
}

/** { value, unit } or seconds → seconds (0 = no reminder). */
function remindSeconds(raw, what) {
  if (raw == null || raw === '' || raw === false) return 0;
  if (typeof raw === 'number' || /^\d+$/.test(String(raw))) return int(raw, `${what}: reminder`, { min: 0, max: 30 * 86400 });
  if (typeof raw !== 'object') throw badRequest(`${what}: pick when the reminder comes.`);
  if (raw.seconds != null && raw.value == null) return int(raw.seconds, `${what}: reminder`, { min: 0, max: 30 * 86400 });
  const s = flows().waitSeconds({ value: raw.value, unit: raw.unit }, `${what}: reminder`);
  if (s > 30 * 86400) throw badRequest(`${what}: a reminder can come up to 30 days later.`);
  return s;
}

/** The step's settings for the builder: config → { check | ask | referral } with the reminder as { value, unit }. */
function configOut(type, cfg) {
  cfg = cfg || {};
  const remind = cfg.remind_seconds ? (() => { const [value, unit] = flows().splitDelay(cfg.remind_seconds); return { value, unit, seconds: cfg.remind_seconds }; })() : null;
  if (type === 'check_join') return { check: { chat_id: cfg.chat_id || null, open_label: cfg.open_label || DEFAULTS.open_label, join_label: cfg.join_label || DEFAULTS.join_label, link: cfg.link || '', nudge: cfg.nudge || '', remind, remind_text: cfg.remind_text || '' } };
  if (type === 'ask') return { ask: { answer: cfg.answer || 'text', choices: cfg.choices || [], label: cfg.label || LABELS[cfg.answer || 'text'], button: cfg.button || '', retry_text: cfg.retry_text || '', remind, remind_text: cfg.remind_text || '' } };
  if (type === 'referral') return { referral: { goal: Number(cfg.goal) || 3 } };
  return {};
}

/* ---------- Saving (called by services/flows.js cleanFlow) ---------- */

/** Is the bot an admin of this chat (enough to check who joined)? Returns { ok, message }. */
async function checkCanCheck(bot, chat) {
  try {
    const me = await tg.call(tokenOf(bot), 'getChatMember', { chat_id: chat.tg_chat_id, user_id: bot.tg_chat_id });
    if (me.status === 'creator' || me.status === 'administrator') return { ok: true };
  } catch (e) {
    if (e.code === 401) return { ok: false, message: `The token of @${bot.username} stopped working. Reconnect the bot on the Channels & bots page.` };
  }
  return { ok: false, message: `@${bot.username} needs to be an admin of "${chat.title || 'your channel'}" so it can check who joined. In Telegram, open ${chat.title || 'the channel'} → Administrators → Add admin → @${bot.username}. Then try again.` };
}

/**
 * Check a special step's settings (blk.check | blk.ask | blk.referral) and return its config. ctx: { ws, bot, isBot,
 * what, position }. Throws friendly errors. Makes the channel link for a check step when the channel has no public
 * @username and no link was given (createChatInviteLink).
 */
async function cleanSpecial(type, blk, ctx) {
  const { ws, bot, what } = ctx;
  const raw = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : {});
  if (type === 'check_join') {
    const c = raw(blk.check);
    if (c.chat_id == null || c.chat_id === '') throw httpError(400, `${what}: pick the channel or group they should join.`, 'check_no_chat');
    const chat = await db.one("select * from connections where id = $1 and workspace_id = $2 and kind <> 'bot' and status <> 'removed'", [int(c.chat_id, `${what}: Channel`), ws.id]);
    if (!chat) throw httpError(400, `${what}: that channel or group is not connected. Connect it first on the Channels & bots page.`, 'check_no_chat');
    const can = await checkCanCheck(bot, chat);
    if (!can.ok) throw httpError(409, `${what}: ${can.message}`, 'bot_not_admin_check');
    let link = str(c.link, `${what}: Channel link`, { max: 200, required: false }) || '';
    if (link && !/^https:\/\/t\.me\/[A-Za-z0-9_+/-]{3,120}$/.test(link)) throw badRequest(`${what}: the channel link must look like https://t.me/yourchannel or https://t.me/+AbC123.`);
    if (chat.username) link = `https://t.me/${chat.username}`;
    if (!link) {
      try {
        const inv = await tg.call(tokenOf(bot), 'createChatInviteLink', { chat_id: chat.tg_chat_id, name: 'Castvoo join check' });
        link = inv.invite_link;
      } catch {
        throw badRequest(`${what}: Castvoo couldn't make a link to "${chat.title}". Paste its invite link (https://t.me/+...) in the check step, or give @${bot.username} the "Invite users" right.`);
      }
    }
    return {
      chat_id: Number(chat.id), link,
      open_label: str(c.open_label, `${what}: Link button text`, { max: 40, required: false }) || DEFAULTS.open_label,
      join_label: str(c.join_label, `${what}: "I've joined" button text`, { max: 40, required: false }) || DEFAULTS.join_label,
      nudge: str(c.nudge, `${what}: Not-joined note`, { max: 180, required: false }) || '',
      remind_seconds: remindSeconds(c.remind != null ? c.remind : c.remind_seconds, what),
      remind_text: str(c.remind_text, `${what}: Reminder text`, { max: 1000, required: false }) || '',
    };
  }
  if (type === 'ask') {
    if (!ctx.isBot) throw badRequest(`${what}: "Ask a question" works in Chat bots (people who tapped Start in your bot).`);
    const a = raw(blk.ask);
    const answer = oneOf(String(a.answer || 'text'), `${what}: Answer type`, ANSWER_TYPES);
    let choices = [];
    if (answer === 'choice') {
      choices = (Array.isArray(a.choices) ? a.choices : []).map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
      if (choices.length < 2) throw badRequest(`${what}: add at least 2 choices for them to tap.`);
      if (choices.length > MAX_CHOICES) throw badRequest(`${what}: use ${MAX_CHOICES} choices or fewer.`);
      for (const ch of choices) if ([...ch].length > 40) throw badRequest(`${what}: keep each choice under 40 characters.`);
      if (new Set(choices.map((x) => x.toLowerCase())).size !== choices.length) throw badRequest(`${what}: two choices are the same.`);
    }
    return {
      answer, choices,
      label: str(a.label, `${what}: Save the answer as`, { max: 40, required: false }) || LABELS[answer],
      button: answer === 'phone' ? (str(a.button, `${what}: Share button text`, { max: 40, required: false }) || DEFAULTS.phone_button) : '',
      retry_text: str(a.retry_text, `${what}: Try-again text`, { max: 300, required: false }) || '',
      remind_seconds: remindSeconds(a.remind != null ? a.remind : a.remind_seconds, what),
      remind_text: str(a.remind_text, `${what}: Reminder text`, { max: 1000, required: false }) || '',
    };
  }
  if (type === 'referral') {
    if (!ctx.isBot) throw badRequest(`${what}: "Invite friends" works in Chat bots.`);
    const r = raw(blk.referral);
    return { goal: int(r.goal == null ? 3 : r.goal, `${what}: How many friends`, { min: 1, max: 1000 }) };
  }
  return {};
}

/**
 * Plan rules for the steps of a bot (after each step was checked). steps: cleaned steps (step_type, trigger_type,
 * buttons). Throws a friendly 402. Welcome bots keep the Welcome Flow rules (services/flows.js) plus these step types.
 */
async function assertBotPlan(ws, steps, { isBot }) {
  const l = await billing.limits(ws);
  const b = l.bots;
  const has = (t) => steps.some((s) => s.step_type === t);
  if (has('check_join')) await billing.requireBotType(ws, 'join_check');
  if (has('referral')) await billing.requireBotType(ws, 'referral');
  if (has('ask')) {
    await billing.requireBotType(ws, 'lead_questions');
    const n = steps.filter((s) => s.step_type === 'ask').length;
    if (b.lead_questions_per_form !== billing.UNLIMITED && n > b.lead_questions_per_form) {
      const p = await billing.planForBots((x) => x.lead_questions_per_form === billing.UNLIMITED || x.lead_questions_per_form >= n);
      throw httpError(402, `Your ${l.plan.name} plan asks up to ${b.lead_questions_per_form} questions per bot. This one has ${n}. Remove some${p ? `, or upgrade to ${p.name}` : ''}.`, 'limit_lead_questions', { limit: b.lead_questions_per_form, plan: p ? p.code : null });
    }
  }
  if (!isBot) return;
  if (steps.filter((s) => s.step_type === 'referral').length > 1) throw badRequest('A bot can have one "Invite friends" step.');
  // Messages per bot: answers to buttons (a menu) and the check / question steps don't count.
  const msgs = steps.filter((s) => (s.step_type === 'message' || s.step_type === 'referral') && s.trigger_type !== 'on_button').length;
  if (b.bot_steps !== billing.UNLIMITED && msgs > b.bot_steps) {
    const p = await billing.planForBots((x) => x.bot_steps === billing.UNLIMITED || x.bot_steps >= msgs);
    const msg = b.bot_steps <= 1
      ? `On the ${l.plan.name} plan a bot sends 1 message per reply (a menu can still answer each button). Upgrade${p ? ` to ${p.name}` : ''} to add follow-ups.`
      : `Your ${l.plan.name} plan allows ${b.bot_steps} messages per bot. This one has ${msgs}. Remove some${p ? `, or upgrade to ${p.name}` : ''}.`;
    throw httpError(402, msg, 'limit_bot_steps', { limit: b.bot_steps, plan: p ? p.code : null });
  }
}

/** Is another live Chat bot using this start code (or answering plain Start) on the same Telegram bot? */
async function botClash(ws, botId, code, isDefault, exceptId) {
  const sameCode = await db.one(`select id, name from sequences where workspace_id = $1 and connection_id = $2 and trigger_type = 'bot_start' and active
      and lower(trigger_value) = lower($3) and id <> $4 limit 1`, [ws.id, botId, code, exceptId || 0]);
  if (sameCode) return { ...sameCode, why: 'code' };
  if (isDefault) {
    const def = await db.one("select id, name from sequences where workspace_id = $1 and connection_id = $2 and trigger_type = 'bot_start' and active and is_default and id <> $3 limit 1", [ws.id, botId, exceptId || 0]);
    if (def) return { ...def, why: 'default' };
  }
  return null;
}

/* ---------- Runtime: people open the bot ---------- */

const reply = (conn, chatId, text, extra = {}) => tg.call(tokenOf(conn), 'sendMessage', { chat_id: chatId, text, ...extra }).catch(() => null);

/**
 * Start (or start again) a Chat bot for a person. A person who finished it, or who sits at a menu or a reward, starts
 * from the first message again (answers and invites are kept); one waiting on a check or a question gets that step
 * again. Returns the run id.
 */
async function startBot(flow, sub) {
  const first = await db.one('select position, delay_seconds from sequence_steps where sequence_id = $1 and variant = 0 order by position limit 1', [flow.id]);
  if (!first) return null;
  const old = await db.one('select * from sequence_runs where sequence_id = $1 and subscriber_id = $2', [flow.id, sub.id]);
  let row;
  if (!old) {
    row = await db.one(`insert into sequence_runs(sequence_id, subscriber_id, next_position, due_at, status) values ($1,$2,$3, now() + make_interval(secs => $4), 'active')
      on conflict (sequence_id, subscriber_id) do nothing returning id, due_at`, [flow.id, sub.id, first.position, Number(first.delay_seconds) || 0]);
  } else {
    // (services/flows.js onStart has just woken this person's 'awaiting' runs, so an awaiting run may be 'active' here.)
    const at = await db.one('select step_type, trigger_type from sequence_steps where sequence_id = $1 and position = $2 and variant = 0', [flow.id, old.next_position]);
    const waitingOnThem = at && ['on_button', 'on_goal'].includes(at.trigger_type);
    if (['awaiting', 'active'].includes(old.status) && at && WAITING_STEPS.includes(at.step_type) && Number(old.sent_position) === Number(old.next_position)) {
      row = await db.one("update sequence_runs set status = 'active', due_at = now(), sent_position = null where id = $1 returning id, due_at", [old.id]);
    } else if (['done', 'stopped', 'awaiting', 'waiting'].includes(old.status) || (old.status === 'active' && waitingOnThem)) {
      await db.query('delete from flow_step_runs where run_id = $1', [old.id]);
      row = await db.one(`update sequence_runs set next_position = $2, status = 'active', due_at = now() + make_interval(secs => $3), sent_position = null, created_at = now()
        where id = $1 returning id, due_at`, [old.id, first.position, Number(first.delay_seconds) || 0]);
    } else row = null; // a wait is running: let it run
  }
  if (row) soon().at(row.due_at);
  return row ? row.id : (old ? old.id : null);
}

/**
 * Someone pressed Start in a customer's bot (after services/flows.js onStart). payload: the start code ('' for a plain
 * /start). isNew: this person was never seen by this Telegram bot before (for referral counting).
 * Returns { started: flowId } or { skipped }.
 */
async function onStart(conn, sub, from, payload, { isNew = false } = {}) {
  const f = await require('./settings').features();
  if (f.bots === false) return { skipped: 'switched_off' };
  if (payload && /^(j_|cvf_|cvt)/.test(payload)) return { skipped: 'welcome' };
  let flow = null;
  if (payload && payload.startsWith('r_')) {
    const inv = /^r_[a-z0-9]{6,16}$/.test(payload) ? await db.one('select * from bot_invites where code = $1', [payload.slice(2)]) : null;
    if (inv) {
      flow = await db.one("select * from sequences where id = $1 and connection_id = $2 and trigger_type = 'bot_start' and active", [inv.sequence_id, conn.id]);
      if (flow) await recordReferral(conn, flow, inv, sub, from, isNew).catch((e) => log.warn('referral failed', { err: e.message }));
    }
  } else if (payload) {
    flow = await db.one("select * from sequences where connection_id = $1 and trigger_type = 'bot_start' and active and lower(trigger_value) = lower($2) limit 1", [conn.id, payload]);
  }
  if (!flow) flow = await db.one("select * from sequences where connection_id = $1 and trigger_type = 'bot_start' and active and is_default limit 1", [conn.id]);
  if (!flow) return { skipped: 'no_bot' };
  const ws = await db.one('select plan_status from workspaces where id = $1', [flow.workspace_id]);
  if (!ws || ws.plan_status === 'paused' || ws.plan_status === 'cancelled') return { skipped: 'plan' };
  await startBot(flow, sub);
  return { started: flow.id };
}

/* ---------- Referrals ---------- */

const inviteUrl = (bot, code) => `https://t.me/${bot.username}?start=r_${code}`;

/** This person's own invite code for a referral bot (made once). */
async function inviteFor(c, flow, subId) {
  const q = c || db;
  const had = (await q.query('select code from bot_invites where sequence_id = $1 and subscriber_id = $2', [flow.id, subId])).rows[0];
  if (had) return had.code;
  for (let i = 0; i < 5; i++) {
    const code = randomCode(10);
    const r = (await q.query(`insert into bot_invites(code, workspace_id, sequence_id, subscriber_id) values ($1,$2,$3,$4)
      on conflict do nothing returning code`, [code, flow.workspace_id, flow.id, subId])).rows[0];
    if (r) return r.code;
    const again = (await q.query('select code from bot_invites where sequence_id = $1 and subscriber_id = $2', [flow.id, subId])).rows[0];
    if (again) return again.code;
  }
  throw new Error('could not make an invite code');
}

/** Counted invites of one person in a referral bot. */
async function invitesOf(c, flowId, subId) {
  return Number((await (c || db).query('select count(*)::int n from bot_referrals where sequence_id = $1 and referrer_id = $2 and counted', [flowId, subId])).rows[0].n);
}

/** The goal of a referral bot (its "Invite friends" step). */
async function goalOf(c, flowId) {
  const s = (await (c || db).query("select config from sequence_steps where sequence_id = $1 and step_type = 'referral' and variant = 0 order by position limit 1", [flowId])).rows[0];
  return s ? Number((s.config || {}).goal) || 3 : 0;
}

/**
 * Someone opened the bot through an invite link. Counts it when they are new to this Telegram bot, not the inviter,
 * not a bot, and the inviter has fewer than MAX_REFERRALS_PER_DAY counted in the last 24 hours. Each invited person is
 * kept once per bot (counted or not, with the reason). Reaching the goal wakes the inviter's reward.
 */
async function recordReferral(conn, flow, inv, sub, from, isNew) {
  const referrer = await db.one('select * from subscribers where id = $1', [inv.subscriber_id]);
  if (!referrer) return { counted: false, reason: 'gone' };
  let reason = null;
  if (Number(referrer.tg_user_id) === Number(from.id)) reason = 'self';
  else if (from.is_bot) reason = 'bot';
  else if (!isNew) reason = 'not_new';
  else {
    const today = (await db.one("select count(*)::int n from bot_referrals where referrer_id = $1 and counted and created_at > now() - interval '24 hours'", [referrer.id])).n;
    if (today >= MAX_REFERRALS_PER_DAY) reason = 'daily_limit';
  }
  if (reason === 'self') return { counted: false, reason };
  const row = await db.one(`insert into bot_referrals(workspace_id, sequence_id, connection_id, referrer_id, referred_id, referred_tg_user_id, counted, reason)
    values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (sequence_id, referred_tg_user_id) do nothing returning id`,
  [flow.workspace_id, flow.id, conn.id, referrer.id, sub.id, from.id, !reason, reason]);
  if (!row || reason) return { counted: false, reason: reason || 'already' };
  const n = await invitesOf(db, flow.id, referrer.id);
  const goal = await goalOf(db, flow.id);
  if (goal && n >= goal) {
    const hit = await db.one('update bot_invites set reached_at = now() where code = $1 and reached_at is null returning code', [inv.code]);
    if (hit) await db.query("update sequence_runs set status = 'active', due_at = now() where sequence_id = $1 and subscriber_id = $2 and status = 'awaiting'", [flow.id, referrer.id]);
    soon().at(Date.now());
  }
  if (referrer.status === 'active') {
    const left = Math.max(0, goal - n);
    await reply(conn, referrer.tg_user_id, goal && n >= goal ? `🎉 ${n} friends joined through your link. You reached your goal!` : `🎉 A friend joined through your link! ${n} of ${goal}${left ? ` · ${left} to go` : ''}.`);
  }
  return { counted: true, invites: n, goal };
}

/** "My invite link / progress" for one referral bot (callback cvr:<bot id>, or /invite). */
async function sendProgress(conn, sub, flow) {
  const code = await inviteFor(null, flow, sub.id);
  const n = await invitesOf(db, flow.id, sub.id);
  const goal = await goalOf(db, flow.id);
  const link = inviteUrl(conn, code);
  const done = goal && n >= goal;
  await reply(conn, sub.tg_user_id, `🔗 Your invite link:\n${link}\n\n${done ? `🎉 ${n} friends joined. Goal reached!` : `Friends joined: ${n} of ${goal}`}`, {
    reply_markup: { inline_keyboard: [[{ text: '📤 Share my link', url: `https://t.me/share/url?url=${encodeURIComponent(link)}` }]] },
    link_preview_options: { is_disabled: true },
  });
}

/* ---------- Taps and answers from Telegram ---------- */

/** Move a run past a check or question step (only if it still points there). */
async function passStep(run, step) {
  const r = await runtime().advanceRun(run.id, run.sequence_id, step.position);
  await db.query("update flow_step_runs set status = 'cancelled', done_at = now() where run_id = $1 and step_id = $2 and status = 'scheduled'", [run.id, step.id]);
  return r;
}

/** "I've joined ✅" (callback cvj:<step id>): ask Telegram, then go on or nudge gently. */
async function onCheckJoin(conn, q) {
  const answer = (text, alert = false) => tg.call(tokenOf(conn), 'answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text, show_alert: alert } : {}) }).catch(() => {});
  const m = /^cvj:(\d{1,18})$/.exec(String(q.data || ''));
  const step = m ? await db.one(`select s.*, q.connection_id, q.workspace_id from sequence_steps s join sequences q on q.id = s.sequence_id
      where s.id = $1 and s.step_type = 'check_join'`, [m[1]]) : null;
  if (!step || String(step.connection_id) !== String(conn.id) || !q.from || q.from.is_bot) { await answer(step ? null : 'This button is not active any more.'); return { ok: false }; }
  const cfg = step.config || {};
  const chat = await db.one("select * from connections where id = $1 and workspace_id = $2 and kind <> 'bot' and status <> 'removed'", [cfg.chat_id || 0, step.workspace_id]);
  if (!chat) { await answer('This check is not set up right now. Please try again later.', true); return { ok: false }; }
  let joined = false;
  try {
    const mem = await tg.call(tokenOf(conn), 'getChatMember', { chat_id: chat.tg_chat_id, user_id: q.from.id });
    joined = ['creator', 'administrator', 'member'].includes(mem.status) || (mem.status === 'restricted' && mem.is_member === true);
  } catch (e) {
    // Telegram answers "user not found" / PARTICIPANT_ID_INVALID for someone who was never in that chat: not joined
    // (a gentle nudge), not "try again later" forever.
    if (/user not found|participant_id_invalid|user_not_participant/i.test(String(e.description || e.message || ''))) {
      await answer(cfg.nudge || DEFAULTS.nudge, true);
      return { ok: true, joined: false };
    }
    log.warn('join check failed', { conn: conn.id, chat: chat.id, err: e.description || e.message });
    await answer('Hmm, I couldn\'t check right now. Please try again in a minute 🙏', true);
    return { ok: false, error: true };
  }
  if (!joined) { await answer(cfg.nudge || DEFAULTS.nudge, true); return { ok: true, joined: false }; }
  await answer('Thanks for joining! ✅');
  const sub = await db.one('select * from subscribers where connection_id = $1 and tg_user_id = $2', [conn.id, q.from.id]);
  const run = sub ? await db.one('select * from sequence_runs where sequence_id = $1 and subscriber_id = $2', [step.sequence_id, sub.id]) : null;
  if (run && Number(run.next_position) === Number(step.position) && ['awaiting', 'active'].includes(run.status)) await passStep(run, step);
  return { ok: true, joined: true };
}

/**
 * The run (if any) of this person on this bot that waits on a question (the latest asked one), or, with stepId, the run
 * waiting on that very question (a choice button of an older question while another Chat bot also waits on one).
 * 'active' counts too while the question was sent and is still open (a /start just woke the run for a moment).
 */
async function waitingQuestion(conn, subId, stepId = null) {
  return db.one(`select r.*, s.id as step_id, s.config, s.position, s.body, q.workspace_id from sequence_runs r join sequences q on q.id = r.sequence_id
      join sequence_steps s on s.sequence_id = r.sequence_id and s.position = r.next_position and s.variant = 0
    where r.subscriber_id = $1 and q.connection_id = $2 and r.status in ('awaiting','active') and s.step_type = 'ask' and r.sent_position = r.next_position
      and ($3::bigint is null or s.id = $3::bigint)
    order by (r.status = 'awaiting') desc, r.due_at desc, r.id desc limit 1`, [subId, conn.id, stepId]);
}

/** Save an answer (hidden when the month's answers are used up, +10% grace) and go on. */
async function saveAnswer(conn, run, value) {
  const cfg = run.config || {};
  const ws = await db.one('select * from workspaces where id = $1', [run.workspace_id]);
  const meter = await billing.answersMeter(ws);
  await db.query(`insert into bot_answers(workspace_id, sequence_id, step_id, subscriber_id, question, label, answer_type, answer, hidden)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    on conflict (sequence_id, step_id, subscriber_id) where step_id is not null do update set answer = excluded.answer, question = excluded.question,
      label = excluded.label, answer_type = excluded.answer_type, updated_at = now()`,
  [run.workspace_id, run.sequence_id, run.step_id, run.subscriber_id, String(run.body || '').slice(0, 500), cfg.label || LABELS[cfg.answer || 'text'], cfg.answer || 'text', value, meter.over]);
  await passStep(run, { id: run.step_id, position: run.position });
}

/** A choice button of a question (callback cva:<step id>:<choice index>). */
async function onChoice(conn, q) {
  const answer = (text) => tg.call(tokenOf(conn), 'answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text } : {}) }).catch(() => {});
  const m = /^cva:(\d{1,18}):(\d{1,2})$/.exec(String(q.data || ''));
  const sub = m && q.from ? await db.one('select * from subscribers where connection_id = $1 and tg_user_id = $2', [conn.id, q.from.id]) : null;
  const run = sub ? await waitingQuestion(conn, sub.id, m[1]) : null;
  if (!run) { await answer(m ? 'This question was answered already 🙂' : null); return { ok: false }; }
  const choices = (run.config || {}).choices || [];
  const pick = choices[Number(m[2])];
  if (!pick) { await answer(); return { ok: false }; }
  await answer('✅ ' + pick);
  await saveAnswer(conn, run, pick);
  return { ok: true, value: pick };
}

/**
 * A message in the bot (not a command): the answer to a question this person was asked. Returns true when it was one
 * (saved, or a gentle "please try again"). m: Telegram's Message (text or contact).
 */
async function onText(conn, sub, m) {
  const run = await waitingQuestion(conn, sub.id);
  if (!run) return false;
  const cfg = run.config || {};
  let raw = typeof m.text === 'string' ? m.text : null;
  if (m.contact) {
    if (m.contact.user_id && Number(m.contact.user_id) !== Number(m.from.id)) {
      await reply(conn, m.chat.id, 'Please tap the button to share your own number 🙂', { reply_markup: phoneKeyboard(cfg) });
      return true;
    }
    raw = { phone: m.contact.phone_number };
  }
  if (raw == null) { await reply(conn, m.chat.id, cfg.retry_text || RETRY[cfg.answer || 'text'], cfg.answer === 'phone' ? { reply_markup: phoneKeyboard(cfg) } : {}); return true; }
  const v = validateAnswer(cfg.answer || 'text', raw, cfg);
  if (!v.ok) {
    await reply(conn, m.chat.id, v.message, cfg.answer === 'phone' ? { reply_markup: phoneKeyboard(cfg) } : cfg.answer === 'choice' ? { reply_markup: { inline_keyboard: choiceRows(run.step_id, cfg) } } : {});
    return true;
  }
  if (cfg.answer === 'phone') await reply(conn, m.chat.id, 'Thanks! ✅', { reply_markup: { remove_keyboard: true } });
  await saveAnswer(conn, run, v.value);
  return true;
}

/** /invite or /mylink, or the "📊 My progress" button (cvr:<bot id>). */
async function onInviteCommand(conn, sub) {
  const list = await db.many(`select q.* from sequences q join sequence_runs r on r.sequence_id = q.id where r.subscriber_id = $1 and q.connection_id = $2
      and q.trigger_type = 'bot_start' and exists (select 1 from sequence_steps s where s.sequence_id = q.id and s.step_type = 'referral') order by r.id desc limit 3`, [sub.id, conn.id]);
  if (!list.length) return false;
  for (const flow of list) await sendProgress(conn, sub, flow);
  return true;
}
async function onProgress(conn, q) {
  await tg.call(tokenOf(conn), 'answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
  const m = /^cvr:(\d{1,18})$/.exec(String(q.data || ''));
  const sub = m && q.from ? await db.one('select * from subscribers where connection_id = $1 and tg_user_id = $2', [conn.id, q.from.id]) : null;
  const flow = sub ? await db.one(`select * from sequences q where id = $1 and connection_id = $2 and trigger_type = 'bot_start'
      and exists (select 1 from sequence_steps s where s.sequence_id = q.id and s.step_type = 'referral' and s.variant = 0)`, [m[1], conn.id]) : null;
  if (!flow) return { ok: false };
  await sendProgress(conn, sub, flow);
  return { ok: true };
}

/* ---------- What a queued bot step looks like in Telegram (workers/sender.js) ---------- */

function phoneKeyboard(cfg) {
  return { keyboard: [[{ text: String(cfg.button || DEFAULTS.phone_button).slice(0, 64), request_contact: true }]], one_time_keyboard: true, resize_keyboard: true, input_field_placeholder: 'Or type your number' };
}
function choiceRows(stepId, cfg) {
  const rows = [];
  (cfg.choices || []).forEach((c, i) => {
    const btn = { text: String(c).slice(0, 64), callback_data: `cva:${stepId}:${i}` };
    if (rows.length && rows[rows.length - 1].length < 2 && [...String(c)].length <= 18 && [...String(rows[rows.length - 1][0].text)].length <= 18) rows[rows.length - 1].push(btn);
    else rows.push([btn]);
  });
  return rows;
}

/**
 * The parts of a bot step that depend on the step type or the person: content (from the sender's cache: kind, config,
 * step_id, sequence_id, body), d (the delivery: subscriber_id, extra). Returns { msg, extraRows, replyMarkup, footerHtml }.
 */
async function deliveryParts(content, d, conn) {
  const extra = d.extra || {};
  const cfg = content.config || {};
  let msg = { body: content.body, media_id: content.media_id, buttons: content.buttons };
  let extraRows = null, replyMarkup = null, footerHtml = '';
  if (extra.reminder) msg = { body: cfg.remind_text || (content.kind === 'check_join' ? DEFAULTS.check_remind : DEFAULTS.ask_remind), media_id: null, buttons: [] };
  if (content.kind === 'check_join') {
    extraRows = [[{ text: String(cfg.open_label || DEFAULTS.open_label).slice(0, 64), url: cfg.link }], [{ text: String(cfg.join_label || DEFAULTS.join_label).slice(0, 64), callback_data: `cvj:${content.step_id}` }]];
    msg.buttons = [];
  } else if (content.kind === 'ask') {
    msg.buttons = [];
    if (cfg.answer === 'choice') extraRows = choiceRows(content.step_id, cfg);
    else if (cfg.answer === 'phone') replyMarkup = phoneKeyboard(cfg);
  } else if (content.kind === 'referral' && d.subscriber_id) {
    const flow = { id: content.sequence_id, workspace_id: d.workspace_id };
    const code = await inviteFor(null, flow, d.subscriber_id);
    const link = inviteUrl(conn, code);
    msg = { ...msg, body: fillInvite(msg.body, { link, invites: await invitesOf(db, flow.id, d.subscriber_id), goal: Number(cfg.goal) || 3 }), buttons: [] };
    extraRows = [[{ text: '📤 Share my link', url: `https://t.me/share/url?url=${encodeURIComponent(link)}` }], [{ text: '📊 My progress', callback_data: `cvr:${content.sequence_id}` }]];
  }
  if (extra.brand) {
    const ws = await db.one('select * from workspaces where id = $1', [d.workspace_id]);
    if (ws) footerHtml = await flows().brandingHtml(ws, BOT_BRAND_TEXT);
  }
  return { msg, extraRows, replyMarkup, footerHtml };
}

/* ---------- Reading bots for the dashboard ---------- */

/** Chat bots of a workspace with their numbers. */
async function summary(wsId) {
  return db.many(`select q.id, q.name, q.active, q.paused_by_plan, q.trigger_value as start_code, q.is_default, q.bot_type, q.created_at, q.updated_at,
      q.connection_id as bot_id, b.username as bot_username,
      (select count(*)::int from sequence_steps s where s.sequence_id = q.id and s.variant = 0) as steps,
      (select count(*)::int from sequence_runs r where r.sequence_id = q.id) as started,
      (select count(*)::int from sequence_runs r where r.sequence_id = q.id and r.status = 'done') as finished,
      (select count(distinct a.subscriber_id)::int from bot_answers a where a.sequence_id = q.id) as leads,
      (select count(*)::int from bot_referrals x where x.sequence_id = q.id and x.counted) as referrals
    from sequences q join connections b on b.id = q.connection_id
    where q.workspace_id = $1 and q.trigger_type = 'bot_start' and b.status <> 'removed' order by q.active desc, q.id`, [wsId]);
}

/** People who started this Chat bot and can be messaged (the "Broadcast to these people" audience). */
async function startedCount(flowId, botId) {
  return (await db.one(`select count(*)::int n from subscribers s where s.connection_id = $2 and s.status = 'active'
      and exists (select 1 from sequence_runs r where r.subscriber_id = s.id and r.sequence_id = $1)`, [flowId, botId])).n;
}

/**
 * Answers kept hidden (over a month's answers + grace) come back "next month or after an upgrade": every hidden answer
 * of an earlier month, and this month's oldest hidden ones while the plan's answers (+ grace) have room. Returns how
 * many came back.
 */
async function revealAnswers(ws) {
  const meter = await billing.answersMeter(ws);
  let n = (await db.query('update bot_answers set hidden = false where workspace_id = $1 and hidden and created_at < $2', [ws.id, meter.since])).rowCount || 0;
  const room = meter.hard === billing.UNLIMITED ? null
    : meter.hard - (await db.one('select count(*)::int n from bot_answers where workspace_id = $1 and created_at >= $2 and not hidden', [ws.id, meter.since])).n;
  if (room === null || room > 0) {
    n += (await db.query(`update bot_answers set hidden = false where id in (select id from bot_answers where workspace_id = $1 and hidden and created_at >= $2
        order by created_at, id limit $3)`, [ws.id, meter.since, room === null ? null : room])).rowCount || 0;
  }
  return n;
}

/** Answers for the Leads view: one row per person, one column per question. */
async function answers(ws, flowId, { limit = 500, rows: maxRows = 20000 } = {}) {
  await revealAnswers(ws);
  const cols = await db.many(`select id, position, config from sequence_steps where sequence_id = $1 and step_type = 'ask' and variant = 0 order by position`, [flowId]);
  const rows = await db.many(`select a.subscriber_id, a.step_id, a.answer, a.hidden, a.label, a.updated_at, s.first_name, s.username, s.tg_user_id
      from bot_answers a join subscribers s on s.id = a.subscriber_id where a.sequence_id = $1 order by a.updated_at desc limit $2`, [flowId, maxRows]);
  const people = new Map();
  let hidden = 0;
  for (const r of rows) {
    const k = String(r.subscriber_id);
    if (!people.has(k)) people.set(k, { subscriber_id: Number(r.subscriber_id), first_name: r.first_name, username: r.username, tg_user_id: Number(r.tg_user_id), at: r.updated_at, answers: {}, hidden: false });
    const p = people.get(k);
    if (r.hidden) { p.hidden = true; hidden++; p.answers[String(r.step_id)] = null; } else p.answers[String(r.step_id)] = r.answer;
    if (new Date(r.updated_at) > new Date(p.at)) p.at = r.updated_at;
  }
  const meter = await billing.answersMeter(ws);
  return {
    questions: cols.map((c) => ({ step_id: Number(c.id), position: c.position, label: (c.config || {}).label || LABELS[(c.config || {}).answer || 'text'], answer: (c.config || {}).answer || 'text' })),
    people: [...people.values()].slice(0, limit), total: people.size, hidden, meter,
  };
}

const csvCell = (v) => {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // no formulas in spreadsheets
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** The Leads view as a CSV file (answers over the plan's month are left out, like on screen). */
async function answersCsv(ws, flowId) {
  const a = await answers(ws, flowId, { limit: 500000, rows: 500000 });
  const head = ['First name', 'Username', 'Telegram ID', ...a.questions.map((q) => q.label), 'Answered at'];
  const lines = [head.map(csvCell).join(',')];
  for (const p of a.people) lines.push([p.first_name, p.username || '', p.tg_user_id, ...a.questions.map((q) => (p.answers[String(q.step_id)] == null ? '' : p.answers[String(q.step_id)])), new Date(p.at).toISOString()].map(csvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}

/** Referral leaderboard: top inviters, and the invites that did not count (with why). */
async function leaderboard(flowId, { limit = 50 } = {}) {
  const goal = await goalOf(db, flowId);
  const top = await db.many(`select x.referrer_id, s.first_name, s.username, count(*) filter (where x.counted)::int as invites, count(*) filter (where not x.counted)::int as not_counted,
      max(x.created_at) as last_at, (select reached_at from bot_invites i where i.sequence_id = x.sequence_id and i.subscriber_id = x.referrer_id) as reached_at
    from bot_referrals x join subscribers s on s.id = x.referrer_id where x.sequence_id = $1 group by x.referrer_id, s.first_name, s.username, x.sequence_id
    order by invites desc, last_at asc limit $2`, [flowId, limit]);
  const why = await db.many(`select reason, count(*)::int n from bot_referrals where sequence_id = $1 and not counted group by reason order by n desc`, [flowId]);
  const totals = await db.one(`select count(*) filter (where counted)::int counted, count(*) filter (where not counted)::int not_counted,
      (select count(*)::int from bot_invites where sequence_id = $1 and reached_at is not null) as reached from bot_referrals where sequence_id = $1`, [flowId]);
  return { goal, top: top.map((t) => ({ ...t, referrer_id: Number(t.referrer_id) })), not_counted: why, totals, per_day: MAX_REFERRALS_PER_DAY };
}

/**
 * Linked-Telegram-account check, warn-only for now (docs/BOTS-PRICING.md §6 measure 1): each connected Telegram bot
 * should have been started once by a Telegram account linked to someone on the team. Never blocks anything.
 * Returns [{ bot_id, username, message }].
 */
async function ownershipWarnings(wsId) {
  const rows = await db.many(`select c.id, c.username from connections c where c.workspace_id = $1 and c.kind = 'bot' and c.status <> 'removed'
      and not exists (select 1 from users u join members m on m.user_id = u.id where m.workspace_id = c.workspace_id and u.tg_user_id is not null
        and (exists (select 1 from subscribers s where s.connection_id = c.id and s.tg_user_id = u.tg_user_id)
          or exists (select 1 from flow_tests t where t.connection_id = c.id and t.tg_user_id = u.tg_user_id and t.status <> 'need_start')))
    order by c.id`, [wsId]);
  return rows.map((r) => ({ bot_id: Number(r.id), username: r.username, message: `Tip: open @${r.username} from your linked Telegram and tap Start once, so we know this bot belongs to your team.` }));
}

/* ---------- Ready templates for Chat bots (each just fills the builder) ---------- */
const TEMPLATES = [
  {
    key: 'join_check', bot_type: 'join_check', name: 'Join my channel first', emoji: '✅', start_code: 'join',
    about: 'Get people to join your channel first, then they get what you promised.',
    steps: [
      { type: 'check_join', body: 'Hi {name} 👋 Welcome!\n\nTo get started, please join our channel first. Tap the link below, then tap *I\'ve joined*.', check: { chat_id: null, open_label: DEFAULTS.open_label, join_label: DEFAULTS.join_label, remind: { value: 10, unit: 'min' }, remind_text: '' } },
      { body: 'Thanks for joining, {name}! 🎉 You\'re all set.\n\n(Write what they get now here.)' },
    ],
  },
  {
    key: 'lead_magnet', bot_type: 'lead_magnet', name: 'Free gift from my ad', emoji: '🎁', start_code: 'gift',
    about: 'People tap Start from your ad and get your free gift, then a friendly follow-up.',
    steps: [
      { body: 'Hi {name} 👋 Thanks for tapping Start!\n\nHere is your free gift 🎁', buttons: [{ id: 'gift', label: '🎁 Open my gift', url: '', kind: 'link' }] },
      { body: 'Hi {name}, did you get a chance to open your gift? 🙂\n\n(Write one useful tip for your audience here.)', trigger: { type: 'wait', value: 1, unit: 'day' } },
      { body: 'Hi {name}, thanks for staying with us 💙\n\n(Tell them about your offer here, with one clear button.)', trigger: { type: 'wait', value: 2, unit: 'day' } },
    ],
  },
  {
    key: 'menu', bot_type: 'menu', name: 'Menu with buttons', emoji: '📋', start_code: 'menu',
    about: 'A short menu. Each button gets its own answer.',
    steps: [
      { body: 'Hi {name} 👋 What would you like to know?', buttons: [{ id: 'prices', label: '💰 Prices', kind: 'reply' }, { id: 'how', label: '❓ How it works', kind: 'reply' }, { id: 'talk', label: '💬 Talk to us', kind: 'reply' }] },
      { body: 'Here are our prices 💰\n\n(Write your prices here.)', trigger: { type: 'on_button', button: 'prices' } },
      { body: 'Here is how it works ❓\n\n(Explain it in 2 or 3 short lines here.)', trigger: { type: 'on_button', button: 'how' } },
      { body: 'We\'d love to help 💬 Send us a message and we\'ll reply soon.', trigger: { type: 'on_button', button: 'talk' } },
    ],
  },
  {
    key: 'lead_questions', bot_type: 'lead_questions', name: 'Ask a few questions', emoji: '❓', start_code: 'leads',
    about: 'Your bot asks a few questions and saves the answers for you. Export them any time.',
    steps: [
      { body: 'Hi {name} 👋 A few quick questions so we can help you better.' },
      { type: 'ask', body: 'What is your full name?', ask: { answer: 'text', label: 'Full name' } },
      { type: 'ask', body: 'What is your phone number? Tap the button below, or type it with your country code.', ask: { answer: 'phone', label: 'Phone' } },
      { type: 'ask', body: 'What are you most interested in?', ask: { answer: 'choice', label: 'Interest', choices: ['Signals', 'Lessons', 'Something else'] } },
      { body: 'Thank you, {name}! 🙌 We\'ll be in touch soon.' },
    ],
  },
  {
    key: 'referral', bot_type: 'referral', name: 'Invite friends for a reward', emoji: '🔗', start_code: 'invite',
    about: 'Each person gets their own invite link. When enough friends join, your bot sends the reward.',
    steps: [
      { type: 'referral', body: 'Hi {name} 👋 Invite {goal} friends and get a free gift 🎁\n\nYour own link:\n{invite_link}\n\nFriends joined so far: {invites} of {goal}', referral: { goal: 3 } },
      { body: '🎉 You did it, {name}! Here is your reward 👇', buttons: [{ id: 'reward', label: '🎁 Get my reward', url: '', kind: 'link' }], trigger: { type: 'on_goal' } },
    ],
  },
  {
    key: 'custom', bot_type: 'custom', name: 'Something else', emoji: '✨', start_code: 'hello',
    about: 'Start from one friendly message and build it your way.',
    steps: [{ body: 'Hi {name} 👋 Thanks for tapping Start!' }],
  },
];

module.exports = {
  START_TYPES, STEP_TYPES, SPECIAL, WAITING_STEPS, ANSWER_TYPES, BOT_TYPES_BUILD, BOT_BRAND_TEXT, MAX_REFERRALS_PER_DAY, DEFAULTS, LABELS, RETRY, TEMPLATES,
  validateAnswer, fillInvite, botTypeOf, cleanStartCode, configOut, cleanSpecial, checkCanCheck, assertBotPlan, botClash,
  startBot, onStart, recordReferral, inviteFor, inviteUrl, invitesOf, goalOf, sendProgress,
  onCheckJoin, onChoice, onText, onInviteCommand, onProgress, deliveryParts, phoneKeyboard, choiceRows,
  summary, startedCount, answers, answersCsv, leaderboard, ownershipWarnings,
};

'use strict';
/*
 * Welcome Flows: what happens when someone asks to join a channel or group.
 *
 * A flow is a follow-up sequence with trigger_type 'join_request' (same tables as auto follow-ups, so the
 * join-request follow-ups made before Welcome Flows existed keep working and show up here), plus:
 *   approve_mode   instant | after_welcome (default) | tap (when they press Start in the bot) | manual (owner decides)
 *   start_button   a "Tap Start" button on the welcome: t.me/<bot>?start=j_<code>. Pressing Start makes them
 *                  a bot subscriber, so the later steps can reach them ("tap-to-start capture").
 *   invite_link    optional: people who ask to join through this invite link get this flow.
 * Steps are messages (position 1..n, top to bottom). Step 1 is the welcome. Every later message says WHEN it comes
 * (sequence_steps.trigger_type, "Triggers" below). Step 1 can have A/B versions (variant 1..3 next to variant 0).
 * Later time-based steps can have a condition: send only if they clicked / did not click a button in the previous message.
 *
 * Triggers (what the builder calls "When should the next message come?"):
 *   after_previous  ⚡ right after the message above
 *   wait            ⏱ after a wait (delay_seconds: seconds, minutes, hours or days)
 *   on_start        👆 the moment they tap Start in the bot (the welcome's Tap Start button)
 *   on_button       🔘 when they tap a button (trigger_button = that button's stable id) of a message above. Several
 *                   on_button messages in a row that answer buttons of the same message are one choice ("branches"):
 *                   each button gets its own answer. A Reply button is a Telegram callback button (no URL); a Link
 *                   button counts when its tracked link (/l/<code>) is opened.
 *   no_response     💤 a reminder if they have NOT tapped Start (when the message above shows it) or a button of the
 *                   message above within delay_seconds. Cancelled when they do.
 *   A message can also start another flow for that person (action_start_flow_id, same bot, Growth and up).
 * The runtime (services/flow-runtime.js) follows each person's run top to bottom; see flowGraph() for how a message
 * finds "the message above".
 *
 * Telegram rules this code follows:
 *  - After a join request, the bot may message the person for 5 minutes, through user_chat_id, "until the join
 *    request is processed" (core.telegram.org/bots/api#chatjoinrequest). So step 1 is sent at once, before the
 *    person is let in.
 *  - Quick steps: later messages whose waits add up to QUICK_SECONDS or less (and reminders due by then) also reach
 *    everyone who asked to join (sent through user_chat_id while the request is still open, WINDOW_SECONDS at most).
 *    Letting someone in ends that window, so in "Straight away" and "After the welcome" a flow with quick steps
 *    holds the approval (join_requests.hold_position / approve_at) until the last quick message is sent (or they tap
 *    Start); then the person is let in automatically (releaseHeld). "Tap to join" and "I decide" leave the request open anyway.
 *  - After the window, bots cannot message people who never pressed Start. Later steps wait ('waiting' runs, or
 *    'waiting_start' answers) until the person presses Start, then go out. Waiting runs stop after 7 days.
 * Waits are stored in seconds (sequence_steps.delay_seconds); units: sec, min, hour, day.
 *
 * Bots (services/bots.js, docs/BOTS.md): the same tables, builder and runtime also run Chat bots (trigger_type 'bot_start':
 * someone opens t.me/<bot>?start=<code> and taps Start). cleanFlow takes start_type 'join_request' (default, a Welcome
 * bot) or 'bot_start' (start_code, is_default), and steps can have a type: message (default) | check_join | ask |
 * referral (with their settings in check / ask / referral), and the trigger 'on_goal' (the reward of a referral step).
 * The AI-facing JSON for all of it is AI_BOT_KEYS below.
 *
 * Plan rules (services/billing.js): join requests per month (+10% grace, then welcomes pause but people are
 * still let in), flows, steps per flow, features (welcome_flows for steps after the welcome, all triggers and Reply
 * buttons; tap_to_start; start_another_flow; ab_welcome_2/4; condition_clicked ...), and the Free plan's
 * "⚡ Free welcome bot by Castvoo.com" line.
 */

const db = require('../db');
const config = require('../config');
const log = require('../lib/log');
const tg = require('./telegram');
const send = require('./send');
const settings = require('./settings');
const billing = require('./billing');
const email = require('./email');
const B = require('./broadcasts');
const { tokenOf } = require('./connections');
const { str, int, oneOf, bool, badRequest, httpError, randomCode, sleep, fmtDate } = require('../lib/util');

/* Wait units, in seconds. The builder shows "seconds / minutes / hours / days"; the API also takes the long names. */
const UNIT = { sec: 1, min: 60, hour: 3600, day: 86400 };
const UNIT_MAX = { sec: 999, min: 525600, hour: 8760, day: 365 };
const MAX_WAIT = 365 * 86400; // all waits of a flow together
const UNIT_ALIAS = { s: 'sec', sec: 'sec', secs: 'sec', second: 'sec', seconds: 'sec', m: 'min', min: 'min', mins: 'min', minute: 'min', minutes: 'min',
  h: 'hour', hr: 'hour', hour: 'hour', hours: 'hour', d: 'day', day: 'day', days: 'day' };
/** "seconds" → "sec" (unknown units are left as they are, so the validation names them). */
function normUnit(u) { const k = String(u == null || u === '' ? 'min' : u).trim().toLowerCase(); return UNIT_ALIAS[k] || k; }
const UNIT_WORDS = { sec: ['second', 'seconds'], min: ['minute', 'minutes'], hour: ['hour', 'hours'], day: ['day', 'days'] };
/** 1 → "1 second", 90 → "90 seconds", 3600 → "1 hour", 0 → "right away". */
function waitText(seconds) { const [v, u] = splitDelay(seconds); return v ? `${v} ${UNIT_WORDS[u][v === 1 ? 0 : 1]}` : 'right away'; }
/*
 * Telegram's 5-minute window after a join request. QUICK_SECONDS: a later message whose waits (counted from the
 * welcome) add up to this or less is a "quick" message that reaches everyone (the builder says "in the first 5
 * minutes"; 20 s are kept for sending). WINDOW_SECONDS: the runtime never uses user_chat_id after this.
 */
const QUICK_SECONDS = 280;
const WINDOW_SECONDS = 295;
const HOLD_GRACE_SECONDS = 20; // a held request is let in at the latest this long after its last quick message is due
const MODES = ['instant', 'after_welcome', 'tap', 'manual'];
const TRIGGERS = ['after_previous', 'wait', 'on_start', 'on_button', 'no_response', 'on_goal'];
const EVENT_TRIGGERS = ['on_start', 'on_button', 'no_response', 'on_goal'];
const TIME_TRIGGERS = ['after_previous', 'wait'];
const BUTTON_KINDS = ['link', 'reply'];
const BUTTON_ID_RX = /^[a-z0-9]{1,16}$/;
const BRAND_TEXT = 'Free welcome bot by Castvoo.com';
const BRAND_LEN = BRAND_TEXT.length + 4; // "\n\n⚡ " + text, as Telegram counts it
const DEFAULT_TAP = '✅ Tap to join';
const DEFAULT_START = '👆 Tap Start';
const ROW_MAX = 2;

/* ---------- Templates (one tap: the owner changes the words and switches it on) ---------- */
// Steps in the builder's format: { body, buttons: [{ id, label, url, kind }], trigger: { type, value, unit, button } }.
const TEMPLATES = [
  {
    key: 'start_vip', name: 'Welcome + Tap Start + VIP link', emoji: '⭐',
    about: 'They tap Start, then get your VIP link at once.',
    approve_mode: 'after_welcome', start_button: true, start_label: '👆 Tap Start',
    steps: [
      { body: 'Hi {name} 👋 Welcome!\n\nTap *Start* below to get our VIP link.' },
      { body: 'Thanks, {name}! 🎉 Here is your VIP link 👇', buttons: [{ id: 'vip', label: '⭐ Join the VIP group', url: '', kind: 'link' }], trigger: { type: 'on_start' } },
    ],
  },
  {
    key: 'reminder_gift', name: 'Welcome → Please tap Start reminder → Thanks + free gift', emoji: '🎁',
    about: 'A gentle reminder if they don\'t tap Start, and a free gift when they do.',
    approve_mode: 'after_welcome', start_button: true, start_label: '🎁 Tap Start for my gift',
    steps: [
      { body: 'Hi {name}, welcome! 🎁\n\nWe made a free gift for new members. Tap *Start* below to get it.' },
      { body: 'Your free gift is waiting, {name} 👆\n\nPlease tap the button above, then *Start*.', trigger: { type: 'no_response', value: 2, unit: 'min' } },
      { body: 'Thanks for tapping Start, {name}! 💙 Here is your free gift 👇', buttons: [{ id: 'gift', label: '📘 Open my gift', url: '', kind: 'link' }], trigger: { type: 'on_start' } },
    ],
  },
  {
    key: 'two_choices', name: 'Two choices: VIP or Free tips', emoji: '🔀',
    about: 'They pick what they want, and each choice gets its own answer.',
    approve_mode: 'after_welcome', start_button: true, start_label: '👆 Tap Start',
    steps: [
      { body: 'Hi {name} 👋 Welcome!\n\nTap *Start* below and pick what you want.' },
      { body: 'Great, {name}! What would you like?', buttons: [{ id: 'vip', label: '⭐ VIP signals', kind: 'reply' }, { id: 'free', label: '📘 Free tips', kind: 'reply' }], trigger: { type: 'on_start' } },
      { body: 'VIP it is! ⭐ Tap below to join the VIP group.', buttons: [{ id: 'viplink', label: '⭐ Join VIP', url: '', kind: 'link' }], trigger: { type: 'on_button', button: 'vip' } },
      { body: 'Here are our free tips 📘\n\nNew tips come every week. Stay tuned!', trigger: { type: 'on_button', button: 'free' } },
    ],
  },
  {
    key: 'followup', name: 'Welcome + 3-day follow-up', emoji: '📅',
    about: 'A welcome now, a tip on day 1 and your offer on day 3.',
    approve_mode: 'after_welcome', start_button: true, start_label: '👉 Tap Start for more',
    steps: [
      { body: 'Welcome, {name}! 👋 You are in.\n\nTap the button below and press Start, and I will send you our best tips over the next few days.' },
      { body: 'Hi {name}, here is today\'s tip:\n\n(Write one useful tip for your audience here.)', trigger: { type: 'wait', value: 1, unit: 'day' } },
      { body: 'Hi {name}, thanks for staying with us. 💙\n\n(Tell them about your offer here, with one clear button.)', trigger: { type: 'wait', value: 2, unit: 'day' } },
    ],
  },
  {
    key: 'simple', name: 'Simple welcome only', emoji: '👋',
    about: 'One friendly message, then they are let in.',
    approve_mode: 'after_welcome', start_button: false,
    steps: [{ body: 'Hi {name} 👋\n\nThanks for asking to join. You are in!\n\nTurn on notifications so you never miss a post.' }],
  },
];
const template = (key) => TEMPLATES.find((t) => t.key === key) || null;
/** A template's steps as the older blocks format (wait blocks between messages). */
function templateBlocks(t) {
  const out = [];
  t.steps.forEach((s, i) => {
    const tr = s.trigger || {};
    if (i > 0 && tr.type === 'wait') out.push({ type: 'wait', value: tr.value, unit: tr.unit });
    out.push({ type: 'message', body: s.body, buttons: (s.buttons || []).map((b) => ({ ...b })), ...(i > 0 && tr.type && tr.type !== 'wait' ? { trigger: { ...tr } } : {}) });
  });
  return out;
}

/* ---------- Steps ---------- */
/** Seconds → the biggest whole unit: 86400 → [1, 'day'], 120 → [2, 'min'], 45 → [45, 'sec'], 0 → [0, 'min']. */
function splitDelay(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  if (!sec) return [0, 'min'];
  if (sec % 86400 === 0) return [sec / 86400, 'day'];
  if (sec % 3600 === 0) return [sec / 3600, 'hour'];
  if (sec % 60 === 0) return [sec / 60, 'min'];
  return [sec, 'sec'];
}
/** A step's wait in seconds (older rows and callers may only have delay_minutes). */
function delayOf(s) { return s.delay_seconds != null ? Number(s.delay_seconds) || 0 : (Number(s.delay_minutes) || 0) * 60; }
/** One wait block → seconds (validated). Takes { value, unit } or { seconds }. */
function waitSeconds(blk, what) {
  if (blk.seconds != null && blk.value == null) return int(blk.seconds, what, { min: 0, max: MAX_WAIT });
  const unit = oneOf(normUnit(blk.unit), 'Wait unit', Object.keys(UNIT));
  const value = int(blk.value ?? 0, what, { min: 0, max: UNIT_MAX[unit] });
  return value * UNIT[unit];
}
/** A saved step's trigger (old rows: a wait → 'wait', none → 'after_previous'). */
function triggerOf(s) {
  const t = s.trigger_type || 'after_previous';
  if (TIME_TRIGGERS.includes(t)) return delayOf(s) > 0 ? 'wait' : 'after_previous';
  return t;
}

/**
 * How each message hangs off the ones above (pure; the builder has the same rules in public/js/app-flows.js).
 * steps: variant-0 steps in order, each { position, trigger_type, trigger_button, buttons: [{ button_id | id }] }.
 * Returns Map position → {
 *   unit:   positions of "the message above" (a choice's answers count together as one),
 *   group:  for on_button: { owner, members: [positions] } (the message whose buttons are answered, and its answers),
 *   awaits: for no_response: { start, buttons: [ids], positions } (what they should tap to stop the reminder: Start, while
 *           the welcome shows it and no "when they tap Start" message is above; or a button of the message above) }.
 */
function flowGraph(steps, { startButton = false } = {}) {
  const out = new Map();
  const bid = (b) => b.button_id || b.id;
  const owners = new Map(); // button id -> position
  let unit = null;
  let group = null;
  let started = false; // a "when they tap Start" message above: everyone down here tapped Start already
  steps.forEach((s, i) => {
    const t = i === 0 ? 'after_previous' : triggerOf(s);
    const info = { trigger: t, unit: unit ? unit.slice() : [] };
    if (t === 'on_start') started = true;
    if (i > 0 && t === 'no_response') {
      const btns = [];
      for (const p of unit || []) { const st = steps.find((x) => x.position === p); for (const b of (st && st.buttons) || []) btns.push(bid(b)); }
      info.awaits = { start: !!startButton && !started, buttons: btns, positions: (unit || []).slice() };
      out.set(s.position, info);
      for (const b of s.buttons || []) owners.set(bid(b), s.position);
      return; // a reminder is not "the message above" for the next one
    }
    if (i > 0 && t === 'on_button') {
      const owner = owners.get(s.trigger_button) || null;
      if (group && group.owner === owner && group.last === i - 1) { group.members.push(s.position); group.last = i; } else group = { owner, members: [s.position], last: i };
      info.group = group;
      unit = group.members;
    } else {
      group = null;
      unit = [s.position];
    }
    for (const b of s.buttons || []) owners.set(bid(b), s.position);
    out.set(s.position, info);
  });
  // A choice's members all point at the same group object; give each a copy that is complete.
  for (const v of out.values()) if (v.group) v.group = { owner: v.group.owner, members: v.group.members.slice() };
  return out;
}

/** Saved steps (with their variants and buttons) → the builder's steps: each message says when it comes. */
function stepsToV2(steps) {
  return steps.filter((x) => x.variant === 0).sort((a, b) => a.position - b.position).map((s, i) => {
    const t = i === 0 ? null : triggerOf(s);
    const [value, unit] = splitDelay(delayOf(s));
    const type = s.step_type || 'message';
    return {
      id: s.id, type, ...require('./bots').configOut(type, s.config), body: s.body, media_id: s.media_id, media_kind: s.media_kind || null, buttons: s.buttons || [], condition: s.condition || null,
      trigger: t ? { type: t, ...(t === 'wait' || t === 'no_response' ? { value, unit, seconds: delayOf(s) } : {}), ...(t === 'on_button' ? { button: s.trigger_button } : {}) } : null,
      start_flow_id: s.action_start_flow_id || null,
      variants: steps.filter((v) => v.position === s.position && v.variant > 0).sort((a, b) => a.variant - b.variant)
        .map((v) => ({ id: v.id, body: v.body, media_id: v.media_id, media_kind: v.media_kind || null, buttons: v.buttons || [] })),
    };
  });
}
/** Saved steps → the older blocks format (a wait block before a message that waits). Event messages carry `trigger`. */
function stepsToBlocks(steps) {
  const out = [];
  for (const s of stepsToV2(steps)) {
    const tr = s.trigger;
    if (tr && tr.type === 'wait') out.push({ type: 'wait', value: tr.value, unit: tr.unit });
    out.push({ ...s, type: 'message', step_type: s.type, trigger: tr && tr.type !== 'wait' && tr.type !== 'after_previous' ? tr : undefined });
  }
  return out;
}
/** The older blocks format → the builder's steps (waits become the next message's trigger). */
function blocksToSteps(blocks) {
  const steps = [];
  let wait = 0, waited = false;
  for (const [i, blk] of blocks.entries()) {
    if (!blk || typeof blk !== 'object') throw badRequest('One of the steps is empty.');
    if (blk.type === 'wait') {
      if (!steps.length) throw badRequest('A flow starts with a message. Telegram allows the welcome only in the first 5 minutes, so it can\'t wait.');
      wait += waitSeconds(blk, `Wait (step ${i + 1})`);
      if (wait > MAX_WAIT) throw badRequest('Waits can add up to 365 days at most.');
      waited = true;
      continue;
    }
    if (blk.type !== 'message') throw badRequest('Each step is a message or a wait.');
    const tr = blk.trigger && typeof blk.trigger === 'object' ? blk.trigger : null;
    const trigger = tr && tr.type && tr.type !== 'wait' && tr.type !== 'after_previous' ? tr : { type: wait > 0 ? 'wait' : 'after_previous', seconds: wait };
    steps.push({ ...blk, trigger: steps.length ? trigger : null });
    wait = 0; waited = false;
  }
  return { steps, trailingWait: waited };
}

async function loadSteps(seqId) {
  return db.many(`select s.id, s.position, s.variant, s.delay_seconds, s.delay_minutes, s.body, s.media_id, s.condition, s.trigger_type, s.trigger_button, s.action_start_flow_id, s.step_type, s.config, m.kind as media_kind,
      (select coalesce(json_agg(json_build_object('id', l.button_id, 'label', l.label, 'url', l.url, 'code', l.code, 'row', l.row, 'kind', l.kind) order by l.position, l.created_at, l.code), '[]') from links l where l.step_id = s.id) as buttons
    from sequence_steps s left join media m on m.id = s.media_id where s.sequence_id = $1 order by s.position, s.variant`, [seqId]);
}

/**
 * QA-4: the templates' "(Write one useful tip for your audience here.)" lines are instructions for the owner, never
 * words for real people. A message that still has one can be saved as a draft, but not switched on or sent.
 */
const PLACEHOLDER_RX = /\((?:Write|Tell|Add|Put|Paste|Describe)\b[^()\n]{0,160}\bhere\b[^()\n]{0,40}\)/i;
function placeholderIn(text) { const m = PLACEHOLDER_RX.exec(String(text || '')); return m ? m[0] : null; }
/** Throws when any message of a flow (steps and A/B versions) still has template placeholder text. */
function assertNoPlaceholders(steps) {
  for (const s of steps || []) {
    for (const [i, m] of [s, ...(s.variants || [])].entries()) {
      const ph = placeholderIn(m.body);
      if (ph) {
        const what = s.position === 1 ? (i ? `Version ${String.fromCharCode(65 + i)} of the welcome` : 'The welcome message') : `Message ${s.position}`;
        throw httpError(400, `${what} still has the template's placeholder "${ph}". Replace it with your own words before switching the flow on.`, 'placeholder_text');
      }
    }
  }
}

/** The most buttons a Chat bot message can have on a plan (menu_buttons; 12 at most, Telegram stays readable). */
function botMaxButtons(l) { const n = l.bots.menu_buttons; return n === billing.UNLIMITED ? 12 : Math.min(12, n); }

/**
 * Check one message against Telegram and the plan. Buttons: Link buttons (tracked URL) and Reply buttons (no URL).
 * o.bot: a Chat bot message (menu buttons by plan, Reply buttons on every plan); o.brand: it carries the Free plan's line.
 */
async function cleanMessage(ws, m, what, l, feats, o = {}) {
  const raw = Array.isArray(m.buttons) ? m.buttons.filter((b) => b && (String(b.label || '').trim() || String(b.url || '').trim())) : [];
  if (o.bot) {
    const max = botMaxButtons(l);
    if (raw.length > max) throw httpError(402, `Your ${l.plan.name} plan allows ${max} buttons on a bot message. ${what} has ${raw.length}. Remove some, or upgrade for more.`, 'limit_menu_buttons', { limit: max });
  } else {
    const maxButtons = l.branding ? 3 : 6;
    if (raw.length > maxButtons) throw httpError(l.branding ? 402 : 400, l.branding ? `The Free plan allows 3 buttons on the welcome. ${what} has ${raw.length}. Upgrade to add more.` : `Use 6 buttons or fewer (${what}).`, l.branding ? 'plan_feature' : 'bad_request');
  }
  const kinds = raw.map((b) => (b.kind == null || b.kind === '' ? 'link' : oneOf(String(b.kind), 'Button type', BUTTON_KINDS)));
  if (kinds.includes('reply') && !o.bot && !feats.has('welcome_flows')) await billing.requirePlanFeature(ws, 'welcome_flows');
  const links = raw.filter((_, i) => kinds[i] === 'link');
  let msg;
  try { msg = await B.checkMessage(ws.id, { body: m.body, media_id: m.media_id, buttons: links }); } catch (e) { e.message = `${what}: ${e.message}`; throw e; }
  // Rows: up to 2 buttons side by side. row is a small number the builder gives; same number = same row.
  const rows = new Map();
  const ids = new Set();
  let li = 0;
  msg.buttons = raw.map((b, i) => {
    let out;
    if (kinds[i] === 'link') out = { ...msg.buttons[li++], kind: 'link' };
    else out = { label: str(b.label, `${what}: Reply button text`, { min: 1, max: 40 }), url: '', kind: 'reply' };
    const r0 = b.row;
    const row = r0 === undefined || r0 === null || r0 === '' ? null : int(r0, 'Button row', { min: 0, max: 50 });
    if (row !== null) { rows.set(row, (rows.get(row) || 0) + 1); if (rows.get(row) > ROW_MAX) throw badRequest(`${what}: put at most 2 buttons side by side.`); }
    let id = b.id == null || b.id === '' ? null : String(b.id);
    if (id !== null && !BUTTON_ID_RX.test(id)) throw badRequest(`${what}: a button id must be 1 to 16 small letters or numbers.`);
    if (id && ids.has(id)) throw badRequest(`${what}: two buttons have the same id.`);
    if (!id) do id = 'b' + randomCode(6); while (ids.has(id));
    ids.add(id);
    return { ...out, row, button_id: id };
  });
  if (msg.media_id) {
    if (!(await settings.feature('media'))) throw httpError(403, 'Photos and videos are switched off right now.', 'forbidden');
    const media = await db.one('select kind from media where id = $1', [msg.media_id]);
    if (l.branding && !o.bot && media && media.kind !== 'photo') throw httpError(402, 'The Free plan welcome can have 1 photo. Videos and GIFs are on paid plans.', 'plan_feature');
  }
  if (o.bot ? o.brand : l.branding) {
    const text = o.bot ? require('./bots').BOT_BRAND_TEXT : BRAND_TEXT;
    const lim = (msg.media_id ? tg.LIMITS.caption : tg.LIMITS.text) - (text.length + 4);
    if (tg.visibleLength(msg.body) > lim) throw badRequest(`${what}: on the Free plan ${o.bot ? 'the first message of a bot' : 'the welcome'} ends with "${text}", so keep it under ${lim.toLocaleString('en-US')} characters.`);
  }
  return msg;
}

/** One step's trigger from the builder → { type, seconds, button } (validated for its own fields). */
function cleanTrigger(raw, what) {
  const tr = raw && typeof raw === 'object' ? raw : { type: 'after_previous' };
  const type = oneOf(String(tr.type || 'after_previous'), `${what}: When it comes`, TRIGGERS);
  let seconds = 0;
  if (type === 'wait' || type === 'no_response' || (type === 'after_previous' && (tr.seconds != null || tr.value != null))) {
    seconds = waitSeconds(tr.seconds != null && tr.value == null ? { seconds: tr.seconds } : { value: tr.value, unit: tr.unit }, `${what}: Wait`);
  }
  if (type === 'no_response' && seconds < 1) throw badRequest(`${what}: say how long to wait for them (at least 1 second).`);
  if (type === 'on_button' && !(tr.button && BUTTON_ID_RX.test(String(tr.button)))) throw badRequest(`${what}: pick which button they tap.`);
  const t = type === 'after_previous' && seconds > 0 ? 'wait' : type === 'wait' && seconds === 0 ? 'after_previous' : type;
  return { type: t, seconds: TIME_TRIGGERS.includes(t) || t === 'no_response' ? seconds : 0, button: t === 'on_button' ? String(tr.button) : null };
}

/**
 * Validate what the builder sends. Returns { start_type, name, chat, bot, approve_mode, start_button, start_label,
 * invite_link, start_code, is_default, bot_type, steps }.
 * Takes `steps` (each message with its `trigger`) or the older `blocks` (messages and waits).
 * start_type: 'join_request' (a Welcome bot: chat_id + bot_id, the default) or 'bot_start' (a Chat bot: bot_id,
 * start_code, is_default). Steps may have a `type` (services/bots.js STEP_TYPES) with its settings.
 * steps out: [{ id?, position, step_type, config, delay_seconds, trigger_type, trigger_button, action_start_flow_id, body, media_id, buttons, condition, variants }]
 * opts.flowId: the flow being saved (it can't start itself).
 */
async function cleanFlow(ws, b, { partialChecks = true, flowId = null } = {}) {
  const BOTS = require('./bots');
  const l = await billing.limits(ws);
  const feats = billing.featureSet(l);
  const startType = oneOf(b.start_type == null || b.start_type === '' ? 'join_request' : String(b.start_type), 'What starts it', BOTS.START_TYPES);
  const isBot = startType === 'bot_start';
  const name = str(b.name, isBot ? 'Bot name' : 'Flow name', { min: 1, max: 60 });
  let chat = null;
  if (!isBot) {
    chat = await db.one("select * from connections where id = $1 and workspace_id = $2 and kind <> 'bot' and status <> 'removed'", [int(b.chat_id, 'Channel or group'), ws.id]);
    if (!chat) throw badRequest('Pick the channel or group people ask to join. Connect it first on the Channels & bots page.');
  }
  const bot = await db.one("select * from connections where id = $1 and workspace_id = $2 and kind = 'bot' and status <> 'removed'", [int(b.bot_id, 'Bot'), ws.id]);
  if (!bot) throw badRequest(isBot ? 'Pick the Telegram bot people open. Connect your own bot first (Channels & bots → Add a bot).' : 'Pick the bot that sends the welcome. Connect your own bot first (Channels & bots → Add a bot).');
  let mode = 'after_welcome', startButton = false, startLabel = '', invite = null, startCode = null, isDefault = false;
  if (isBot) {
    startCode = BOTS.cleanStartCode(b.start_code);
    isDefault = bool(b.is_default);
  } else {
    mode = oneOf(b.approve_mode || 'after_welcome', 'How people get in', MODES);
    if (mode === 'tap') await billing.requirePlanFeature(ws, 'tap_to_start');
    if (mode === 'manual') await billing.requirePlanFeature(ws, 'welcome_flows');
    startButton = mode === 'tap' || bool(b.start_button);
    if (startButton) await billing.requirePlanFeature(ws, 'tap_to_start');
    startLabel = startButton ? (str(b.start_label, 'Start button text', { max: 40, required: false }) || (mode === 'tap' ? DEFAULT_TAP : DEFAULT_START)) : '';
    invite = str(b.invite_link, 'Invite link', { max: 200, required: false }) || null;
    if (invite) {
      await billing.requirePlanFeature(ws, 'welcome_flows');
      if (!/^https:\/\/t\.me\/\+[A-Za-z0-9_-]{6,64}$/.test(invite)) throw badRequest('The invite link must look like https://t.me/+AbC123xyz. Leave it empty to welcome everyone who asks to join.');
    }
  }

  let input;
  if (Array.isArray(b.steps)) input = b.steps;
  else {
    const blocks = Array.isArray(b.blocks) ? b.blocks : [];
    if (blocks.length > 400) throw badRequest('That flow is too long.');
    if (blocks.length && (!blocks[0] || blocks[0].type !== 'message')) throw badRequest('A flow starts with a message. Telegram allows the welcome only in the first 5 minutes, so it can\'t wait.');
    const conv = blocksToSteps(blocks);
    if (conv.trailingWait && partialChecks) throw badRequest('The last wait has no message after it. Add a message or remove the wait.');
    input = conv.steps;
  }
  if (!input.length) throw badRequest(isBot ? 'Add a first message.' : 'Add a welcome message first.');
  if (input.length > 200) throw badRequest('That flow is too long.');
  const steps = [];
  let waits = 0;
  for (const [i, blk] of input.entries()) {
    if (!blk || typeof blk !== 'object') throw badRequest('One of the steps is empty.');
    const pos = i + 1;
    const what = pos === 1 ? (isBot ? 'The first message' : 'The welcome message') : `Message ${pos}`;
    // The older blocks format uses `type` for message/wait; a step's own type comes as `type` in the steps format.
    const rawType = Array.isArray(b.steps) ? blk.type : (BOTS.SPECIAL.includes(blk.step_type) ? blk.step_type : 'message');
    const stepType = oneOf(rawType == null || rawType === '' ? 'message' : String(rawType), `${what}: Step type`, BOTS.STEP_TYPES);
    const special = stepType !== 'message';
    if (special && pos === 1 && !isBot) throw badRequest('The welcome is a normal message. Add the check right after it.');
    if (special && Array.isArray(blk.buttons) && blk.buttons.some((x) => x && (String(x.label || '').trim() || String(x.url || '').trim()))) {
      throw badRequest(`${what}: this step has its own buttons, so it can't have others. Put your buttons on a message before or after it.`);
    }
    const msg = await cleanMessage(ws, special ? { ...blk, buttons: [] } : blk, what, l, feats, { bot: isBot, brand: isBot && pos === 1 && l.branding });
    if (special && !String(msg.body || '').trim()) throw badRequest(`${what}: write the message for this step.`);
    const config = special ? await BOTS.cleanSpecial(stepType, blk, { ws, bot, isBot, what, position: pos }) : {};
    if (stepType === 'referral') {
      // Their invite link (and the numbers) are filled in when it is sent: that text must still fit Telegram's limit.
      const room = (msg.media_id ? tg.LIMITS.caption : tg.LIMITS.text) - (pos === 1 && l.branding ? BOTS.BOT_BRAND_TEXT.length + 4 : 0);
      const sample = BOTS.fillInvite(msg.body, { link: `https://t.me/${bot.username || 'x'.repeat(32)}?start=r_${'x'.repeat(16)}`, invites: 99999, goal: 1000 });
      if (tg.visibleLength(sample) > room) throw badRequest(`${what}: with their invite link and numbers filled in, this message is too long for Telegram (${room.toLocaleString('en-US')} characters at most). Shorten it a little.`);
    }
    const tr = pos === 1 ? { type: 'after_previous', seconds: 0, button: null } : cleanTrigger(blk.trigger, what);
    if (isBot && tr.type === 'on_start') throw badRequest(`${what}: everyone in a Chat bot has tapped Start already. Pick "Right away" instead.`);
    if (tr.type === 'on_goal' && !isBot) throw badRequest(`${what}: "When they reach their invite goal" works in Chat bots.`);
    if (tr.type === 'on_goal' && special) throw badRequest(`${what}: the reward is a normal message.`);
    if (special && !TIME_TRIGGERS.includes(tr.type)) throw badRequest(`${what}: this step comes "Right away" or "After a wait".`);
    if (EVENT_TRIGGERS.includes(tr.type) && !isBot) await billing.requirePlanFeature(ws, 'welcome_flows');
    waits += tr.seconds;
    if (waits > MAX_WAIT) throw badRequest('Waits can add up to 365 days at most.');
    let condition = blk.condition || null;
    if (condition) {
      condition = oneOf(condition, 'Condition', ['clicked', 'not_clicked']);
      if (pos === 1) throw badRequest('The welcome message is sent to everyone, so it can\'t have a condition.');
      if (EVENT_TRIGGERS.includes(tr.type)) throw badRequest(`${what}: "only if they clicked" works with "Right away" and "After a wait" messages.`);
      await billing.requirePlanFeature(ws, 'condition_clicked');
    }
    let startFlow = blk.start_flow_id == null || blk.start_flow_id === '' ? null : int(blk.start_flow_id, `${what}: Flow to start`, { min: 1 });
    if (startFlow) {
      await billing.requirePlanFeature(ws, 'start_another_flow');
      if (flowId && Number(startFlow) === Number(flowId)) throw badRequest(`${what}: a flow can't start itself. Pick another flow.`);
      const target = await db.one('select id, connection_id from sequences where id = $1 and workspace_id = $2', [startFlow, ws.id]);
      if (!target) throw badRequest(`${what}: the flow to start was not found.`);
      if (Number(target.connection_id) !== Number(bot.id)) throw badRequest(`${what}: pick a flow sent by the same bot (@${bot.username}).`);
    }
    const variants = [];
    const rawV = Array.isArray(blk.variants) ? blk.variants.filter(Boolean) : [];
    if (rawV.length) {
      if (pos !== 1 || isBot) throw badRequest(isBot ? 'A/B versions are for the welcome of a Welcome bot.' : 'A/B versions are for the welcome message only.');
      await billing.requirePlanFeature(ws, 'ab_welcome_2');
      if (rawV.length + 1 > 2) await billing.requirePlanFeature(ws, 'ab_welcome_4');
      if (rawV.length + 1 > 4) throw badRequest('Use up to 4 versions of the welcome.');
      for (const [vi, v] of rawV.entries()) variants.push({ id: v.id || null, ...(await cleanMessage(ws, v, `Version ${String.fromCharCode(66 + vi)} of the welcome`, l, feats)) });
    }
    steps.push({ id: blk.id || null, position: pos, step_type: stepType, config, delay_seconds: tr.seconds, trigger_type: tr.type, trigger_button: tr.button, action_start_flow_id: startFlow, ...msg, condition, variants });
  }
  // The triggers must make sense together: the buttons they answer exist above, Start is on, a reminder has something to wait for.
  const owner = new Map();
  for (const s of steps) {
    for (const bt of s.buttons) {
      if (owner.has(bt.button_id) && owner.get(bt.button_id) !== s.position) throw badRequest(`Message ${s.position}: two messages have a button with the same id. Remove the button and add it again.`);
      owner.set(bt.button_id, s.position);
    }
  }
  const graph = flowGraph(steps, { startButton });
  for (const s of steps.slice(1)) {
    const what = `Message ${s.position}`;
    if (s.trigger_type === 'on_start' && !startButton) throw badRequest(`${what} comes when they tap Start. Turn on the "Tap Start" button on the welcome first.`);
    if (s.trigger_type === 'on_button') {
      const o = owner.get(s.trigger_button);
      if (!o || o >= s.position) throw badRequest(`${what} answers a button that is not on a message above. Pick one of the buttons above.`);
      const g = graph.get(s.position).group;
      const same = g.members.filter((p) => steps[p - 1].trigger_button === s.trigger_button);
      if (same.length > 1) throw badRequest(`${what}: two messages answer the same button. Pick another button for one of them.`);
    }
    if (s.trigger_type === 'no_response') {
      const a = graph.get(s.position).awaits;
      if (!a.start && !a.buttons.length) throw badRequest(`${what} is a reminder, but the message above has nothing to tap. Add a button to it${startButton || isBot ? '' : ' (or the Tap Start button on the welcome)'}.`);
    }
    if (s.trigger_type === 'on_goal' && !steps.some((x) => x.step_type === 'referral' && x.position < s.position)) {
      throw badRequest(`${what} comes when they reach their invite goal. Add an "Invite friends" step above it first.`);
    }
  }
  if (!isBot && l.flow_steps !== billing.UNLIMITED && steps.length > l.flow_steps) {
    if (l.flow_steps <= 1) throw httpError(402, `The ${l.plan.name} plan sends 1 welcome message. Upgrade to Starter to add follow-up steps.`, 'limit_flow_steps', { limit: l.flow_steps });
    throw httpError(402, `Your ${l.plan.name} plan allows ${l.flow_steps} messages per flow. This one has ${steps.length}. Upgrade or remove some.`, 'limit_flow_steps', { limit: l.flow_steps });
  }
  await BOTS.assertBotPlan(ws, steps, { isBot });
  const botType = isBot ? BOTS.botTypeOf(steps) : 'welcome';
  return { start_type: startType, name, chat, bot, approve_mode: mode, start_button: startButton, start_label: startLabel, invite_link: invite, start_code: startCode, is_default: isDefault, bot_type: botType, steps };
}

/* ---------- Cas builds a flow ("Tell Cas what you want") ---------- */
/*
 * Cas answers with ONE JSON object. Everything is checked here, strictly: unknown fields anywhere are refused, so a
 * model that drifts from the format never reaches the builder. The result is a draft the owner reviews (never saved here).
 *   { "name": "...", "approve_mode": "after_welcome", "start_button": true, "start_label": "👆 Tap Start",
 *     "messages": [ { "body": "...", "buttons": [ { "id": "vip", "label": "⭐ VIP", "kind": "reply" | "link", "url": "" } ],
 *                     "trigger": { "type": "after_previous" | "wait" | "on_start" | "on_button" | "no_response", "seconds": 60, "button": "vip" } } ] }
 */
const AI_KEYS = { top: ['name', 'approve_mode', 'start_button', 'start_label', 'messages'], msg: ['body', 'buttons', 'trigger'], btn: ['id', 'label', 'kind', 'url'], trig: ['type', 'seconds', 'button'] };
/*
 * Bots (services/bots.js): the JSON the save API (POST /api/flows, PUT /api/flows/:id, POST /api/flows/tests) takes for
 * Chat bots and the new step types. Cas Builder's AI writes it ("✍️ Something else") and cleanAiBot below checks it
 * strictly against these keys (cleanAiFlow above still takes AI_KEYS only, for "Tell Cas what you want"). Same shape as
 * the builder's steps; every field is checked by cleanFlow and services/bots.js cleanSpecial / assertBotPlan.
 *   { "start_type": "bot_start",            // or "join_request" (a Welcome bot, the default: then chat_id, approve_mode...)
 *     "bot_id": 12, "name": "Free gift", "start_code": "gift",   // t.me/<bot>?start=gift (letters, numbers, _ -; not j_ cvf_ cvt r_ cv_)
 *     "is_default": false,                  // also answer a plain /start (one live per Telegram bot)
 *     "steps": [
 *       { "type": "message", "body": "Hi {name} 👋", "buttons": [ { "id": "vip", "label": "⭐ VIP", "kind": "reply" | "link", "url": "" } ] },
 *       { "type": "check_join", "body": "Join our channel first 👇",
 *         "check": { "chat_id": 34, "open_label": "📣 Open the channel", "join_label": "I've joined ✅", "link": "",
 *                    "nudge": "", "remind": { "value": 10, "unit": "min" } | null, "remind_text": "" },
 *         "trigger": { "type": "after_previous" | "wait", "value": 1, "unit": "hour" } },
 *       { "type": "ask", "body": "What is your email?",
 *         "ask": { "answer": "text" | "number" | "email" | "phone" | "choice", "choices": ["A", "B"], "label": "Email",
 *                  "button": "📱 Share my phone number", "retry_text": "", "remind": null, "remind_text": "" } },
 *       { "type": "referral", "body": "Invite {goal} friends: {invite_link} ({invites} so far)", "referral": { "goal": 3 } },
 *       { "type": "message", "body": "🎉 Here is your reward", "trigger": { "type": "on_goal" } } ] }
 * Rules: check_join, ask and referral steps have no buttons of their own and come "after_previous" or "wait"; ask and
 * referral are Chat bots only; check_join is never the welcome of a Welcome bot; on_goal needs a referral step above;
 * Chat bots never use on_start. Plan limits: services/billing.js BOT_PLANS.
 */
const AI_BOT_KEYS = {
  top: ['start_type', 'name', 'bot_id', 'chat_id', 'start_code', 'is_default', 'approve_mode', 'start_button', 'start_label', 'steps'],
  step: ['type', 'body', 'buttons', 'trigger', 'check', 'ask', 'referral'],
  check: ['chat_id', 'open_label', 'join_label', 'link', 'nudge', 'remind', 'remind_text'],
  ask: ['answer', 'choices', 'label', 'button', 'retry_text', 'remind', 'remind_text'],
  referral: ['goal'],
  trig: ['type', 'value', 'unit', 'seconds', 'button'],
  step_types: ['message', 'check_join', 'ask', 'referral'],
  answer_types: ['text', 'number', 'email', 'phone', 'choice'],
  triggers: ['after_previous', 'wait', 'on_start', 'on_button', 'no_response', 'on_goal'],
};
function aiBad(why) { return httpError(422, `Cas wrote something unexpected (${why}). Please try again, or describe your flow differently.`, 'ai_bad_flow'); }
function onlyKeys(o, allowed, where) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw aiBad(`${where} is not an object`);
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw aiBad(`unknown field "${String(k).slice(0, 30)}" in ${where}`);
}
/** Parse and check Cas's answer. Returns { name, approve_mode, start_button, start_label, steps } in the builder's format. */
function cleanAiFlow(text, { maxMessages = 6 } = {}) {
  let obj;
  const s = String(text || '');
  const a = s.indexOf('{'), z = s.lastIndexOf('}');
  try { obj = JSON.parse(a >= 0 && z > a ? s.slice(a, z + 1) : s); } catch { throw aiBad('not JSON'); }
  onlyKeys(obj, AI_KEYS.top, 'the flow');
  const txt = (v, where, max, min = 0) => {
    if (typeof v !== 'string') throw aiBad(`${where} is not text`);
    const t = v.trim();
    if (t.length < min || [...t].length > max) throw aiBad(`${where} has the wrong length`);
    return t;
  };
  const name = obj.name == null ? 'My welcome flow' : txt(obj.name, 'name', 60, 1);
  const mode = obj.approve_mode == null ? 'after_welcome' : obj.approve_mode;
  if (!MODES.includes(mode)) throw aiBad('approve_mode');
  if (obj.start_button != null && typeof obj.start_button !== 'boolean') throw aiBad('start_button');
  const startLabel = obj.start_label == null ? '' : txt(obj.start_label, 'start_label', 40);
  if (!Array.isArray(obj.messages) || !obj.messages.length) throw aiBad('no messages');
  if (obj.messages.length > maxMessages) throw aiBad(`more than ${maxMessages} messages`);
  const seen = new Map(); // button id -> message index
  let needStart = false;
  const steps = obj.messages.map((m, i) => {
    onlyKeys(m, AI_KEYS.msg, `message ${i + 1}`);
    const body = txt(m.body, `message ${i + 1}`, 3500, 1);
    if (m.buttons != null && !Array.isArray(m.buttons)) throw aiBad(`message ${i + 1} buttons`);
    const buttons = (m.buttons || []).map((bt, j) => {
      onlyKeys(bt, AI_KEYS.btn, `button ${j + 1} of message ${i + 1}`);
      const id = bt.id == null ? `b${i + 1}${j + 1}` : String(bt.id);
      if (!BUTTON_ID_RX.test(id) || seen.has(id)) throw aiBad('button id');
      seen.set(id, i);
      const kind = bt.kind == null ? 'link' : bt.kind;
      if (!BUTTON_KINDS.includes(kind)) throw aiBad('button kind');
      const url = bt.url == null ? '' : txt(bt.url, 'button url', 300);
      if (url && !/^https:\/\/[^\s<>"]+$/i.test(url)) throw aiBad('button url');
      return { id, label: txt(bt.label, 'button text', 40, 1), kind, url: kind === 'link' ? url : '', row: j };
    });
    if (buttons.length > 6) throw aiBad('more than 6 buttons');
    let trigger = null;
    if (i > 0) {
      const tr = m.trigger == null ? { type: 'after_previous' } : m.trigger;
      onlyKeys(tr, AI_KEYS.trig, `the trigger of message ${i + 1}`);
      if (!TRIGGERS.includes(tr.type)) throw aiBad('trigger type');
      const sec = tr.seconds == null ? 0 : tr.seconds;
      if (!Number.isInteger(sec) || sec < 0 || sec > MAX_WAIT) throw aiBad('seconds');
      if ((tr.type === 'wait' || tr.type === 'no_response') && sec < 1) throw aiBad('a wait needs seconds');
      if (tr.type === 'on_button') {
        if (typeof tr.button !== 'string' || !seen.has(tr.button) || seen.get(tr.button) >= i) throw aiBad('a button trigger must name a button of a message above');
      } else if (tr.button != null) throw aiBad('button on a trigger that is not "on_button"');
      if (tr.type === 'on_start') needStart = true;
      const [value, unit] = splitDelay(sec);
      trigger = { type: tr.type, ...(tr.type === 'wait' || tr.type === 'no_response' ? { value, unit } : {}), ...(tr.type === 'on_button' ? { button: tr.button } : {}) };
    } else if (m.trigger != null) {
      onlyKeys(m.trigger, AI_KEYS.trig, 'the trigger of the welcome');
    }
    return { body, buttons, trigger };
  });
  const startButton = obj.start_button === true || needStart || mode === 'tap';
  return { name, approve_mode: mode, start_button: startButton, start_label: startButton ? (startLabel || (mode === 'tap' ? DEFAULT_TAP : DEFAULT_START)) : '', steps };
}

/**
 * Parse and check a whole Chat bot Cas wrote (Cas Builder, "✍️ Something else"), strictly against AI_BOT_KEYS: unknown
 * fields anywhere, unknown step types, answer types or triggers, a trigger that can't work (on_start in a Chat bot,
 * on_button without that button above, on_goal without an "Invite friends" step above, a special step that waits for
 * a tap), buttons on a special step, bad links, too many steps or buttons are all refused (422 ai_bad_flow).
 * Ids are never trusted: bot_id is dropped, chat_id is kept only as a number for the caller to match.
 * Returns { name, start_code, steps: [{ type, body, buttons, trigger: null | { type, seconds?, button? }, check? | ask? | referral? }] }.
 */
function cleanAiBot(text, { maxSteps = 10 } = {}) {
  let obj;
  const s = String(text || '');
  const a = s.indexOf('{'), z = s.lastIndexOf('}');
  try { obj = JSON.parse(a >= 0 && z > a ? s.slice(a, z + 1) : s); } catch { throw aiBad('not JSON'); }
  const K = AI_BOT_KEYS;
  onlyKeys(obj, K.top, 'the bot');
  const txt = (v, where, max, min = 0) => {
    if (typeof v !== 'string') throw aiBad(`${where} is not text`);
    const t = v.trim();
    if (t.length < min || [...t].length > max) throw aiBad(`${where} has the wrong length`);
    if (/<\s*\/?\s*[a-z!?][^>]*>|javascript\s*:/i.test(t)) throw aiBad(`${where} has code in it`);
    return t;
  };
  const opt = (v, where, max) => (v == null || v === '' ? '' : txt(v, where, max));
  if (obj.start_type != null && obj.start_type !== 'bot_start') throw aiBad('start_type must be "bot_start"');
  const name = obj.name == null ? 'My bot' : txt(obj.name, 'name', 60, 1);
  let startCode = '';
  if (obj.start_code != null && obj.start_code !== '') {
    startCode = txt(obj.start_code, 'start_code', 64, 1);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(startCode) || /^(j_|cvf_|cvt|r_|cv_)/i.test(startCode)) throw aiBad('start_code');
  }
  if (obj.is_default != null && typeof obj.is_default !== 'boolean') throw aiBad('is_default');
  for (const k of ['approve_mode', 'start_button', 'start_label']) if (obj[k] != null && obj[k] !== '' && obj[k] !== false) throw aiBad(`${k} is for Welcome bots`);
  if (!Array.isArray(obj.steps) || !obj.steps.length) throw aiBad('no steps');
  if (obj.steps.length > maxSteps) throw aiBad(`more than ${maxSteps} steps`);
  const seen = new Map(); // button id -> step index
  let referralAt = -1;
  const remindOf = (r, where) => {
    if (r == null) return null;
    if (typeof r !== 'object' || Array.isArray(r)) throw aiBad(`${where} reminder`);
    onlyKeys(r, ['value', 'unit', 'seconds'], `${where} reminder`);
    const sec = r.seconds != null && r.value == null ? Number(r.seconds) : Number(r.value) * ({ sec: 1, min: 60, hour: 3600, day: 86400 }[normUnit(r.unit)] || NaN);
    if (!Number.isInteger(sec) || sec < 1 || sec > 30 * 86400) throw aiBad(`${where} reminder`);
    const [value, unit] = splitDelay(sec);
    return { value, unit };
  };
  const steps = obj.steps.map((st, i) => {
    const where = `step ${i + 1}`;
    onlyKeys(st, K.step, where);
    const type = st.type == null ? 'message' : st.type;
    if (!K.step_types.includes(type)) throw aiBad(`${where} type`);
    const special = type !== 'message';
    const body = txt(st.body, where, 3500, 1);
    if (st.buttons != null && !Array.isArray(st.buttons)) throw aiBad(`${where} buttons`);
    if (special && (st.buttons || []).length) throw aiBad(`${where} is a special step and has its own buttons`);
    if ((st.buttons || []).length > 12) throw aiBad('more than 12 buttons');
    const buttons = (st.buttons || []).map((bt, j) => {
      onlyKeys(bt, AI_KEYS.btn, `button ${j + 1} of ${where}`);
      const id = bt.id == null ? `b${i + 1}${j + 1}` : String(bt.id);
      if (!BUTTON_ID_RX.test(id) || seen.has(id)) throw aiBad('button id');
      seen.set(id, i);
      const kind = bt.kind == null ? (bt.url ? 'link' : 'reply') : bt.kind;
      if (!BUTTON_KINDS.includes(kind)) throw aiBad('button kind');
      const url = bt.url == null ? '' : txt(bt.url, 'button url', 300);
      if (kind === 'link' && !/^https:\/\/[^\s<>"]+\.[^\s<>"]+$/i.test(url)) throw aiBad('button url');
      return { id, label: txt(bt.label, 'button text', 40, 1), kind, url: kind === 'link' ? url : '' };
    });
    const out = { type, body, buttons, trigger: null };
    if (i > 0) {
      const tr = st.trigger == null ? { type: 'after_previous' } : st.trigger;
      onlyKeys(tr, K.trig, `the trigger of ${where}`);
      if (!K.triggers.includes(tr.type)) throw aiBad('trigger type');
      if (tr.type === 'on_start') throw aiBad('a Chat bot has no "on_start" (everyone tapped Start)');
      let sec = 0;
      if (tr.seconds != null || tr.value != null) {
        sec = tr.seconds != null && tr.value == null ? Number(tr.seconds) : Number(tr.value) * ({ sec: 1, min: 60, hour: 3600, day: 86400 }[normUnit(tr.unit)] || NaN);
        if (!Number.isInteger(sec) || sec < 0 || sec > MAX_WAIT) throw aiBad('seconds');
      }
      if ((tr.type === 'wait' || tr.type === 'no_response') && sec < 1) throw aiBad('a wait needs seconds');
      if (special && !TIME_TRIGGERS.includes(tr.type)) throw aiBad(`${where} is a special step: it comes "after_previous" or "wait"`);
      if (tr.type === 'on_button') {
        if (typeof tr.button !== 'string' || !seen.has(tr.button) || seen.get(tr.button) >= i) throw aiBad('a button trigger must name a button of a step above');
      } else if (tr.button != null) throw aiBad('button on a trigger that is not "on_button"');
      if (tr.type === 'on_goal' && (referralAt < 0 || special)) throw aiBad('"on_goal" needs an "Invite friends" step above and is a normal message');
      const t = tr.type === 'after_previous' && sec > 0 ? 'wait' : tr.type;
      out.trigger = { type: t, ...(t === 'wait' || t === 'no_response' ? { seconds: sec } : {}), ...(t === 'on_button' ? { button: tr.button } : {}) };
    } else if (st.trigger != null) onlyKeys(st.trigger, K.trig, 'the trigger of the first step');
    for (const k of ['check', 'ask', 'referral']) if (st[k] != null && k !== { check_join: 'check', ask: 'ask', referral: 'referral' }[type]) throw aiBad(`${where} has "${k}" but is a ${type}`);
    if (type === 'check_join') {
      const c = st.check == null ? {} : st.check;
      onlyKeys(c, K.check, `${where} check`);
      if (c.chat_id != null && !Number.isInteger(c.chat_id)) throw aiBad(`${where} chat_id`);
      out.check = { chat_id: c.chat_id || null, open_label: opt(c.open_label, 'open_label', 40), join_label: opt(c.join_label, 'join_label', 40), link: '', nudge: opt(c.nudge, 'nudge', 180), remind: remindOf(c.remind, where), remind_text: opt(c.remind_text, 'remind_text', 1000) };
    }
    if (type === 'ask') {
      const q = st.ask == null ? {} : st.ask;
      onlyKeys(q, K.ask, `${where} ask`);
      const answer = q.answer == null ? 'text' : q.answer;
      if (!K.answer_types.includes(answer)) throw aiBad(`${where} answer type`);
      let choices = [];
      if (answer === 'choice') {
        if (!Array.isArray(q.choices)) throw aiBad(`${where} choices`);
        choices = q.choices.map((x) => txt(x, 'a choice', 40, 1));
        if (choices.length < 2 || choices.length > 8 || new Set(choices.map((x) => x.toLowerCase())).size !== choices.length) throw aiBad(`${where} needs 2 to 8 different choices`);
      } else if (q.choices != null && (!Array.isArray(q.choices) || q.choices.length)) throw aiBad(`${where} has choices but is not a choice question`);
      out.ask = { answer, choices, label: opt(q.label, 'label', 40), button: answer === 'phone' ? opt(q.button, 'button', 40) : '', retry_text: opt(q.retry_text, 'retry_text', 300), remind: remindOf(q.remind, where), remind_text: opt(q.remind_text, 'remind_text', 1000) };
    }
    if (type === 'referral') {
      if (referralAt >= 0) throw aiBad('more than one "Invite friends" step');
      referralAt = i;
      const r = st.referral == null ? {} : st.referral;
      onlyKeys(r, K.referral, `${where} referral`);
      const goal = r.goal == null ? 3 : r.goal;
      if (!Number.isInteger(goal) || goal < 1 || goal > 1000) throw aiBad(`${where} goal`);
      out.referral = { goal };
    }
    return out;
  });
  return { name, start_code: startCode, steps };
}

/** Is the bot an admin of the chat with the "invite users" right? Returns { ok, message }. */
async function checkAdmin(bot, chat) {
  try {
    const me = await tg.call(tokenOf(bot), 'getChatMember', { chat_id: chat.tg_chat_id, user_id: bot.tg_chat_id });
    if (me.status === 'creator' || (me.status === 'administrator' && me.can_invite_users !== false)) return { ok: true };
    if (me.status === 'administrator') return { ok: false, message: `@${bot.username} is an admin of "${chat.title}" but can't let people in. In Telegram, open ${chat.title} → Administrators → @${bot.username} and turn on "Add members" (invite users).` };
    return { ok: false, message: `@${bot.username} is not an admin of "${chat.title}" yet. In Telegram, open ${chat.title} → Administrators → Add admin → @${bot.username}, and turn on "Add members" (invite users).` };
  } catch (e) {
    if (e.code === 401) return { ok: false, message: `The token of @${bot.username} stopped working. Reconnect the bot on the Channels & bots page.` };
    return { ok: false, message: `@${bot.username} is not an admin of "${chat.title}" yet. In Telegram, open ${chat.title} → Administrators → Add admin → @${bot.username}, and turn on "Add members" (invite users).` };
  }
}
async function requireAdmin(bot, chat) {
  const r = await checkAdmin(bot, chat);
  if (!r.ok) throw httpError(409, r.message + ' Telegram only sends join requests to admins who can let people in.', 'bot_not_admin');
}

/** Save steps (create or update) inside transaction c. Keeps step rows by id, so stats and running people stay. */
async function saveSteps(c, wsId, seqId, steps) {
  const old = (await c.query('select id, position, variant from sequence_steps where sequence_id = $1', [seqId])).rows;
  const oldIds = new Set(old.map((o) => String(o.id)));
  // Move every row out of the way first (unique sequence_id + position + variant).
  await c.query('update sequence_steps set position = -id where sequence_id = $1', [seqId]);
  const kept = new Set();
  const put = async (s, position, variant, delay, condition, trig) => {
    let id = s.id && oldIds.has(String(s.id)) && !kept.has(String(s.id)) ? Number(s.id) : null;
    const vals = [s.body, s.media_id, condition, trig.type, trig.button, trig.startFlow, variant ? 'message' : (s.step_type || 'message'), JSON.stringify(variant ? {} : (s.config || {}))];
    if (id) await c.query('update sequence_steps set position = $2, variant = $3, delay_seconds = $4, body = $5, media_id = $6, condition = $7, trigger_type = $8, trigger_button = $9, action_start_flow_id = $10, step_type = $11, config = $12 where id = $1', [id, position, variant, delay, ...vals]);
    else id = (await c.query('insert into sequence_steps(sequence_id, position, variant, delay_seconds, body, media_id, condition, trigger_type, trigger_button, action_start_flow_id, step_type, config) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id', [seqId, position, variant, delay, ...vals])).rows[0].id;
    kept.add(String(id));
    // Keep each button's short link (people may already have it in Telegram): matched by the button's id first (so a
    // moved button keeps its link and its clicks), then by place for older buttons; add new ones, and unhook extra
    // ones (they keep redirecting, their clicks are kept).
    const had = (await c.query('select code, button_id from links where step_id = $1 order by position, created_at, code', [id])).rows;
    const used = new Set();
    const match = s.buttons.map((btn) => { const h = had.find((x) => !used.has(x.code) && x.button_id === btn.button_id); if (h) used.add(h.code); return h || null; });
    s.buttons.forEach((btn, bi) => { if (!match[bi]) { const h = had.find((x) => !used.has(x.code) && !s.buttons.some((y) => y.button_id === x.button_id)); if (h) { used.add(h.code); match[bi] = h; } } });
    const fresh = [];
    for (const [bi, btn] of s.buttons.entries()) {
      if (match[bi]) await c.query('update links set label = $2, url = $3, position = $4, row = $5, kind = $6, button_id = $7 where code = $1', [match[bi].code, btn.label, btn.url || '', bi, btn.row, btn.kind || 'link', btn.button_id]);
      else fresh.push({ ...btn, url: btn.url || '', position: bi });
    }
    if (fresh.length) await B.makeLinks(c, wsId, fresh, { stepId: id });
    for (const extra of had.filter((x) => !used.has(x.code))) await c.query('update links set step_id = null where code = $1', [extra.code]);
    return id;
  };
  for (const s of steps) {
    const trig = { type: s.trigger_type || (delayOf(s) > 0 ? 'wait' : 'after_previous'), button: s.trigger_button || null, startFlow: s.action_start_flow_id || null };
    await put(s, s.position, 0, delayOf(s), s.condition, trig);
    for (const [vi, v] of (s.variants || []).entries()) await put(v, s.position, vi + 1, 0, null, { type: 'after_previous', button: null, startFlow: null });
  }
  const gone = old.filter((o) => !kept.has(String(o.id))).map((o) => o.id);
  if (gone.length) {
    await c.query('update links set step_id = null where step_id = any($1::bigint[])', [gone]);
    await c.query('delete from sequence_steps where id = any($1::bigint[])', [gone]);
  }
  await c.query("update sequence_runs set status = 'done' where sequence_id = $1 and status in ('active','waiting','awaiting') and next_position > $2", [seqId, steps.length]);
  // A run waiting on a check or a question that moved or changed type: it looks again (and sends that step again).
  await c.query(`update sequence_runs r set sent_position = null, status = case when r.status = 'awaiting' then 'active' else r.status end, due_at = case when r.status = 'awaiting' then now() else r.due_at end
    where r.sequence_id = $1 and r.sent_position is not null and not exists (select 1 from sequence_steps s where s.sequence_id = r.sequence_id and s.position = r.sent_position and s.variant = 0 and s.step_type in ('check_join','ask'))`, [seqId]);
}

/** Is another flow already live on this chat (and invite link)? */
async function liveClash(chat, inviteLink, exceptId) {
  // ENG-6: only this workspace's flows (never another tenant's flow name).
  return db.one(`select id, name from sequences where trigger_type = 'join_request' and active and trigger_value = $1 and coalesce(invite_link, '') = coalesce($2, '') and id <> $3
      and workspace_id = $4`, [String(chat.tg_chat_id), inviteLink || null, exceptId || 0, chat.workspace_id]);
}

/** Plan check before a flow goes live. `replacing` = a live flow that will be switched off at the same time. */
async function assertCanGoLive(ws, flowId, replacing) {
  const l = await billing.limits(ws);
  await billing.assertBotSlots(ws, { exceptIds: [flowId || 0, replacing || 0] });
  if (l.flows === billing.UNLIMITED) return;
  const live = (await db.one(`select count(*)::int n from sequences q join connections c on c.id = q.connection_id
    where q.workspace_id = $1 and q.trigger_type = 'join_request' and q.active and c.status <> 'removed' and q.id <> $2 and q.id <> $3`, [ws.id, flowId || 0, replacing || 0])).n;
  if (live >= l.flows) throw httpError(402, `Your ${l.plan.name} plan runs ${l.flows} live Welcome Flow${l.flows === 1 ? '' : 's'}. Switch another one off first, or upgrade.`, 'limit_flows', { limit: l.flows });
}

/* ---------- Runtime: a join request arrives at the customer's own bot ---------- */

function startUrl(bot, code) { return `https://t.me/${bot.username}?start=${code}`; }
async function brandingHtml(ws, text = BRAND_TEXT) {
  const owner = await db.one('select ref_code from users where id = $1', [ws.owner_user_id]);
  const href = `${config.appUrl}/r/${owner ? owner.ref_code : ''}`;
  return `\n\n⚡ <a href="${href.replace(/"/g, '&quot;')}">${text}</a>`;
}

/**
 * ENG-4 / AUD-14: the Free plan's welcome rules, applied when the welcome is SENT (a flow saved on a bigger plan keeps
 * running after a drop to Free): at most 3 buttons (Link buttons only), a photo only (a video or GIF is left out), and
 * the text cut so it still fits with the "Free welcome bot by Castvoo.com" line.
 */
async function freeWelcome(msg) {
  const out = { ...msg, buttons: (msg.buttons || []).filter((b) => (b.kind || 'link') === 'link').slice(0, 3) };
  if (out.media_id) {
    const media = await db.one('select kind from media where id = $1', [out.media_id]);
    if (!media || media.kind !== 'photo') out.media_id = null;
  }
  const lim = (out.media_id ? tg.LIMITS.caption : tg.LIMITS.text) - BRAND_LEN;
  if (tg.visibleLength(out.body) > lim) {
    const chars = [...String(out.body || '')];
    let lo = 0, hi = chars.length;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (tg.visibleLength(chars.slice(0, mid).join('') + '…') <= lim) lo = mid; else hi = mid - 1; }
    out.body = chars.slice(0, lo).join('').trimEnd() + '…';
  }
  return out;
}

/** A send error that is about the message itself (Telegram refused its content), not about the person or the chat. */
function contentError(e) {
  const d = String((e && (e.description || e.message)) || '');
  return Number(e && e.code) === 400 && !/chat not found|blocked|deactivated|PEER_ID_INVALID|USER_ID_INVALID|bot can't initiate|have no rights|not enough rights|kicked/i.test(d);
}

/** Telegram "slow down": wait what it asks (up to 10 s) and try again, at most `tries` times. Join welcomes can't sit in the queue. */
async function withRetry(fn, tries = 3) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (e.code === 429 && i < tries - 1 && (e.retryAfter || 1) <= 10) { await sleep((e.retryAfter || 1) * 1000); continue; }
      throw e;
    }
  }
}

/** Let one person in (or decline). Returns the new status; never throws. */
async function decide(bot, jr, action) {
  const method = action === 'decline' ? 'declineChatJoinRequest' : 'approveChatJoinRequest';
  try {
    await withRetry(() => tg.call(tokenOf(bot), method, { chat_id: jr.chat_id, user_id: jr.tg_user_id }));
    const st = action === 'decline' ? 'declined' : 'approved';
    await db.query("update join_requests set status = $2, decided_at = now(), error = null where id = $1 and status = 'pending'", [jr.id, st]);
    return st;
  } catch (e) {
    const d = String(e.description || e.message || '');
    if (/USER_ALREADY_PARTICIPANT/i.test(d)) { await db.query("update join_requests set status = 'approved', decided_at = now() where id = $1 and status = 'pending'", [jr.id]); return 'approved'; }
    if (/HIDE_REQUESTER_MISSING|request.*not found|USER_ID_INVALID/i.test(d)) { await db.query("update join_requests set status = 'gone', decided_at = now(), error = $2 where id = $1 and status = 'pending'", [jr.id, 'The request is gone (they cancelled it, or another admin handled it).']); return 'gone'; }
    await db.query('update join_requests set error = $2 where id = $1', [jr.id, d.replace(/^Bad Request: /, '').slice(0, 200)]);
    log.warn('join request decision failed', { jr: jr.id, err: d });
    return 'failed';
  }
}

/** Meter emails at 80% and 100% of the month's join requests (once each per month). */
async function meterAlerts(ws, meter) {
  if (meter.limit <= 0 || meter.unlimited_until) return;
  // ENG-21: one pair of emails per meter period (a trial that crosses a month boundary is one period).
  const month = new Date(meter.since || Date.now()).toISOString().slice(0, 10);
  const level = meter.used >= meter.limit ? 100 : meter.used >= Math.ceil(meter.limit * 0.8) ? 80 : 0;
  if (!level) return;
  const key = `${month}:${level}`;
  const prev = String(ws.join_alert || '');
  if (prev === key || (level === 80 && prev === `${month}:100`)) return;
  const row = await db.one('update workspaces set join_alert = $2 where id = $1 and coalesce(join_alert, \'\') = $3 returning id', [ws.id, key, prev]);
  if (!row) return;
  const owner = await db.one('select * from users where id = $1', [ws.owner_user_id]);
  const vars = { used: meter.used.toLocaleString('en-US'), limit: meter.limit.toLocaleString('en-US'), reset_date: fmtDate(meter.resets_at), plans_url: config.appUrl + '/#app/wallet' };
  await email.send(level === 100 ? 'join_limit_reached' : 'join_limit_80', owner, vars).catch((e) => log.warn('meter email failed', { err: e.message }));
}

/**
 * The quick part of a flow for someone who asked to join (Telegram's 5-minute window, waits counted from the welcome):
 * the messages that follow the welcome by time ("Right away", "After a wait") and the reminders due by then. Stops at
 * the first message that waits for them to do something (Start, a button). Returns { last, at } (the step that is
 * last in time, and when), or null when nothing is quick.
 */
function quickPlan(steps, { startButton = false, allowed = Infinity } = {}) {
  const v0 = steps.filter((s) => s.variant === 0).sort((a, b) => a.position - b.position);
  if (v0.length < 2) return null;
  let t = 0, best = null;
  for (const s of v0.slice(1)) {
    if (s.position > allowed) break;
    const tr = triggerOf(s);
    if (tr === 'no_response') { const due = t + delayOf(s); if (due <= QUICK_SECONDS && (!best || due >= best.at)) best = { last: s, at: due }; continue; }
    if (!TIME_TRIGGERS.includes(tr)) break;
    t += delayOf(s);
    if (t > QUICK_SECONDS) break;
    if (!best || t >= best.at) best = { last: s, at: t };
  }
  void startButton;
  return best;
}

/**
 * Handle chat_join_request on a customer's bot. Safe to receive the same update twice (ENG-3):
 *  - a redelivery has the same Telegram `date` as the row we saved: ignored,
 *  - one open request per (chat, person): a repeat within 60 s is the same request; an older open one (they cancelled
 *    and asked again, or the welcome failed / they never tapped) is refreshed and handled again,
 *  - a request handled (approved or declined) in the last 15 s is a redelivery too.
 */
async function onJoinRequest(conn, jr) {
  const f = await settings.features();
  if (!f.join_welcome || !f.welcome_flows) return { skipped: 'switched_off' };
  const chatId = jr.chat && jr.chat.id;
  const from = jr.from || {};
  if (!chatId || !from.id || from.is_bot) return { skipped: 'bad_update' };
  const link = jr.invite_link && jr.invite_link.invite_link ? String(jr.invite_link.invite_link) : null;
  // ENG-27: Telegram hides the end of invite links made by other admins ("https://t.me/+AbC12…"): match the visible start.
  const linkPrefix = link && /(\.\.\.|…)$/.test(link) ? link.replace(/(\.\.\.|…)$/, '') : null;
  const flow = await db.one(`select * from sequences where connection_id = $1 and active and trigger_type = 'join_request' and trigger_value = $2
      and (invite_link is null or invite_link = $3 or ($4::text is not null and length($4::text) >= 18 and starts_with(invite_link, $4::text)))
      order by (invite_link is null), id limit 1`, [conn.id, String(chatId), link, linkPrefix]);
  if (!flow) return { skipped: 'no_flow' };
  const ws = await db.one('select * from workspaces where id = $1', [conn.workspace_id]);
  if (!ws) return { skipped: 'no_workspace' };

  const tgDate = Number.isSafeInteger(Number(jr.date)) && Number(jr.date) > 0 ? Number(jr.date) : null;
  // Uses join_requests_recent (chat_id, tg_user_id, requested_at): no table scan (ENG-2).
  const recent = await db.one(`select id from join_requests where chat_id = $1 and tg_user_id = $2 and status <> 'pending'
      and (($3::bigint is not null and tg_date = $3) or requested_at > now() - interval '15 seconds') and requested_at > now() - interval '2 days' limit 1`, [chatId, from.id, tgDate]);
  if (recent) return { skipped: 'duplicate' };
  const meterSince = await billing.meterEnsure(ws); // before the insert (see billing.meterEnsure)
  const code = 'j_' + randomCode(10);
  const vals = [ws.id, flow.id, conn.id, chatId, from.id, jr.user_chat_id || null, String(from.first_name || '').slice(0, 64), from.username || null, link, code, tgDate];
  let row = await db.one(`insert into join_requests(workspace_id, sequence_id, connection_id, chat_id, tg_user_id, user_chat_id, first_name, username, invite_link, start_code, tg_date)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (chat_id, tg_user_id) where status = 'pending' do nothing returning *`, vals);
  if (!row) {
    // An open request is there already. A new Telegram request (a new date, or older than 60 s): refresh it and handle it again.
    row = await db.one(`update join_requests set workspace_id = $1, sequence_id = $2, connection_id = $3, user_chat_id = $6, first_name = $7, username = $8, invite_link = $9,
        start_code = $10, tg_date = $11, requested_at = now(), welcome = 'none', welcomed_at = null, started_at = null, error = null, step_id = null, variant = 0, hold_position = null, approve_at = null
      where chat_id = $4 and tg_user_id = $5 and status = 'pending'
        and (case when $11::bigint is not null and tg_date is not null then tg_date <> $11 and requested_at < now() - interval '5 seconds' else requested_at < now() - interval '60 seconds' end)
      returning *`, vals);
    if (!row) return { skipped: 'duplicate' };
  }
  // ENG-2 / ENG-26: count it with one atomic increment; this request is over the limit if the new count is.
  const meterNow = await billing.meterBump(ws, meterSince);

  const l = await billing.limits(ws);
  const feats = billing.featureSet(l);
  const has = (k) => feats.has(k);
  const planPaused = ws.plan_status === 'paused' || ws.plan_status === 'cancelled';
  const limitHit = meterNow.paused;
  let skip = null;
  if (planPaused) skip = 'skipped_plan';
  else if (f.maintenance) skip = 'skipped_off';
  else if (limitHit) skip = 'skipped_limit';

  // What the plan allows today (a flow made on a bigger plan keeps running inside the smaller plan's rules).
  let mode = flow.approve_mode || (flow.approve_join ? 'after_welcome' : 'manual');
  if (mode === 'tap' && !has('tap_to_start')) mode = 'after_welcome';
  if (mode === 'manual' && !has('welcome_flows')) mode = 'after_welcome';
  if (mode === 'tap' && skip) mode = 'instant'; // no welcome = no button to tap: auto-approve keeps working
  const startButton = (mode === 'tap' || flow.start_button) && has('tap_to_start');

  try {
    const sub = (await require('./bot-updates').upsertSubscriber(conn, from, { status: 'joinreq' }));
    await db.query('update join_requests set subscriber_id = $2 where id = $1', [row.id, sub.id]);
    const steps = await db.many('select * from sequence_steps where sequence_id = $1 order by position, variant', [flow.id]);
    const firsts = steps.filter((s) => s.position === steps[0].position);
    const welcome = async () => {
      if (skip || !firsts.length) {
        await db.query('update join_requests set welcome = $2 where id = $1', [row.id, skip || 'none']);
        return false;
      }
      const n = Math.max(1, Math.min(firsts.length, l.ab_variants));
      const variant = Number(from.id) % n;
      const step = firsts.find((s) => s.variant === variant) || firsts[0];
      let msg = { body: step.body, media_id: step.media_id, buttons: await stepButtons(step) };
      if (l.branding) msg = await freeWelcome(msg);
      const footerHtml = l.branding ? await brandingHtml(ws) : '';
      const startBtn = startButton ? { label: flow.start_label || (mode === 'tap' ? DEFAULT_TAP : DEFAULT_START), url: startUrl(conn, code) } : null;
      const chat = jr.user_chat_id || from.id;
      if (placeholderIn(msg.body)) {
        // QA-4: never send a template's "(Write ... here)" line to a real person.
        await db.query("update join_requests set welcome = 'failed', error = $2, step_id = $3, variant = $4 where id = $1", [row.id, 'The welcome still has template placeholder text.', step.id, step.variant]);
        return 'content_error';
      }
      try {
        const m = await withRetry(() => send.sendOne(msg, { token: tokenOf(conn), botKey: 'bot:' + conn.id, chatId: chat, subscriberId: sub.id, includeStop: false, firstName: from.first_name, footerHtml, startButton: startBtn }));
        await db.query(`insert into deliveries(workspace_id, sender_key, step_id, subscriber_id, chat_id, status, message_id, sent_at, attempts)
          values ($1,$2,$3,$4,$5,'sent',$6, now(), 1)`, [ws.id, 'bot:' + conn.id, step.id, sub.id, chat, m.message_id]);
        await db.query("update join_requests set welcome = 'sent', welcomed_at = now(), step_id = $2, variant = $3 where id = $1", [row.id, step.id, step.variant]);
        return true;
      } catch (e) {
        const err = String(e.description || e.message || '').replace(/^Bad Request: /, '').slice(0, 200);
        await db.query(`insert into deliveries(workspace_id, sender_key, step_id, subscriber_id, chat_id, status, error, sent_at, attempts)
          values ($1,$2,$3,$4,$5,'failed',$6, now(), 1)`, [ws.id, 'bot:' + conn.id, step.id, sub.id, chat, err]);
        await db.query("update join_requests set welcome = 'failed', error = $2, step_id = $3, variant = $4 where id = $1", [row.id, err, step.id, step.variant]);
        log.warn('join-request welcome failed', { conn: conn.id, err });
        // ENG-4: Telegram refused the message itself (too long, a bad button...): in "after the welcome" mode the
        // person is still let in, instead of waiting in a list for an owner who may never look.
        if (contentError(e)) return 'content_error';
        return false;
      }
    };
    const rowNow = () => ({ ...row, chat_id: chatId, tg_user_id: from.id });
    // Later steps: only on plans with follow-up steps, never while welcomes are paused.
    const later = steps.filter((s) => s.variant === 0 && s.position > firsts[0].position);
    const allowed = l.flow_steps === billing.UNLIMITED ? Infinity : l.flow_steps;
    const runsLater = !skip && later.length > 0 && allowed > 1 && has('welcome_flows');
    // Quick steps: the later messages (and reminders) due inside Telegram's 5-minute window (counted from the welcome).
    const qp = runsLater ? quickPlan(steps, { startButton, allowed }) : null;
    const quickLast = qp ? qp.last : null, quickAt = qp ? qp.at : 0;
    // The welcome always goes first: once a request is processed, Telegram no longer lets the bot message them.
    //  instant:        let them in straight away, even if the welcome could not be sent.
    //  after_welcome:  let them in once the welcome reached them (or welcomes are paused by the plan: auto-approve keeps
    //                  working). If Telegram refused the welcome, they wait in the Requests list for the owner.
    //  (both)          with quick steps, they are let in right after the last quick message instead (hold), or as soon
    //                  as they tap Start.
    //  tap:            let in when they press Start through the welcome's button (bot-updates → onStart).
    //  manual:         the owner lets them in (or declines) from the dashboard.
    const sent = await welcome();
    const hold = !!quickLast && sent === true && (mode === 'instant' || mode === 'after_welcome');
    if (hold) {
      await db.query("update join_requests set hold_position = $2, approve_at = now() + make_interval(secs => $3) where id = $1 and status = 'pending'",
        [row.id, quickLast.position, quickAt + HOLD_GRACE_SECONDS]);
    } else if (mode === 'instant' || (mode === 'after_welcome' && (sent || skip))) await decide(conn, rowNow(), 'approve');
    if (runsLater) {
      // Active now when the next message is quick (it reaches them through the join request) or they already tapped Start.
      const next = later[0];
      const due = TIME_TRIGGERS.includes(triggerOf(next)) ? delayOf(next) : 0;
      const run = await db.one(`insert into sequence_runs(sequence_id, subscriber_id, next_position, due_at, variant, status)
          values ($1,$2,$3, now() + make_interval(secs => $4), $5, $6) on conflict (sequence_id, subscriber_id) do nothing returning id, due_at, status`,
      [flow.id, sub.id, next.position, due, (await db.one('select variant from join_requests where id = $1', [row.id])).variant, sub.status === 'active' || quickLast ? 'active' : 'waiting']);
      if (run && run.status === 'active') require('../workers/soon').at(run.due_at);
    }
    // "Start another flow" on the welcome itself.
    const w = firsts.find((s) => s.variant === 0);
    if (sent === true && w && w.action_start_flow_id && has('start_another_flow')) {
      await require('./flow-runtime').startFlowFor(db, { workspace_id: ws.id, connection_id: conn.id, subscriber_id: sub.id }, w.action_start_flow_id);
    }
  } catch (e) {
    log.error('join request failed', { conn: conn.id, err: e });
    await db.query('update join_requests set error = $2 where id = $1', [row.id, String(e.message || e).slice(0, 200)]).catch(() => {});
  }
  await meterAlerts(ws, meterNow).catch(() => {});
  return { ok: true, id: row.id };
}

/**
 * Let in the held join requests that are due: their last quick message was sent (the sender sets approve_at to now)
 * or their time is up. Each row is claimed first (approve_at → null), so two servers never approve the same person twice.
 */
async function releaseHeld(limit = 100) {
  const rows = await db.many(`update join_requests j set approve_at = null where j.id in (select id from join_requests
      where status = 'pending' and approve_at is not null and approve_at <= now() order by approve_at limit $1 for update skip locked) returning j.*`, [limit]);
  for (const jr of rows) {
    const bot = await db.one("select * from connections where id = $1 and kind = 'bot' and status <> 'removed'", [jr.connection_id]);
    if (bot) await decide(bot, jr, 'approve');
  }
  return rows.length;
}

/** A quick step to someone who has not tapped Start is done (sent or failed): let them in now if their request was held for it. */
async function quickStepDone(jrId) {
  const r = await db.one("update join_requests set approve_at = now() where id = $1 and status = 'pending' and approve_at is not null returning id", [jrId]);
  if (r) await releaseHeld();
}

async function stepButtons(step) {
  const links = await db.many('select code, label, url, row, kind, button_id from links where step_id = $1 order by position, created_at, code', [step.id]);
  return links.map((x) => ({ label: x.label, url: x.url, code: x.code, row: x.row, kind: x.kind, id: x.button_id }));
}

/**
 * Someone pressed Start in a bot. payload 'j_<code>' = they came from a welcome's button.
 * Marks "tapped Start", lets them in for "Tap to join" flows, wakes their waiting steps and the messages that come
 * "when they tap Start", cancels the reminders that waited for it, and lets in a request held for quick messages
 * (they can be reached any time now).
 */
async function onStart(conn, sub, from, payload) {
  await db.query('update join_requests set started_at = now(), subscriber_id = coalesce(subscriber_id, $3) where connection_id = $1 and tg_user_id = $2 and started_at is null', [conn.id, from.id, sub.id]);
  await require('./flow-runtime').onStarted(sub);
  const held = await db.many("select id, sequence_id from join_requests j where connection_id = $1 and tg_user_id = $2 and status = 'pending' and approve_at is not null and exists (select 1 from sequences q where q.id = j.sequence_id and q.approve_mode in ('instant','after_welcome'))", [conn.id, from.id]);
  for (const h of held) await quickStepDone(h.id);
  if (!payload || !payload.startsWith('j_')) return null;
  const jr = await db.one('select j.*, q.approve_mode from join_requests j left join sequences q on q.id = j.sequence_id where j.connection_id = $1 and j.start_code = $2 and j.tg_user_id = $3', [conn.id, payload, from.id]);
  if (!jr || jr.status !== 'pending' || jr.approve_mode !== 'tap') return jr ? jr.status : null;
  const st = await decide(conn, jr, 'approve');
  if (st === 'approved') {
    const chat = await db.one("select title from connections where tg_chat_id = $1 and kind <> 'bot' and status <> 'removed'", [jr.chat_id]);
    await tg.call(tokenOf(conn), 'sendMessage', { chat_id: from.id, text: `✅ You're in! You can open ${chat && chat.title ? chat.title : 'the channel'} now.` }).catch(() => {});
  }
  return st;
}

/* ---------- Reading flows for the dashboard ---------- */

async function summary(wsId) {
  const rows = await db.many(`select q.id, q.name, q.active, q.paused_by_plan, q.approve_mode, q.start_button, q.invite_link, q.created_at, q.updated_at,
      q.connection_id as bot_id, b.username as bot_username, c.id as chat_id, c.title as chat_title, c.kind as chat_kind, c.status as chat_status,
      (select count(*)::int from sequence_steps s where s.sequence_id = q.id and s.variant = 0) as steps,
      (select count(*)::int from join_requests j where j.sequence_id = q.id) as requests,
      (select count(*)::int from join_requests j where j.sequence_id = q.id and j.welcome = 'sent') as welcomed,
      (select count(*)::int from join_requests j where j.sequence_id = q.id and j.status = 'approved') as approved,
      (select count(*)::int from join_requests j where j.sequence_id = q.id and j.status = 'pending') as pending
    from sequences q join connections b on b.id = q.connection_id
    left join connections c on c.workspace_id = q.workspace_id and c.kind <> 'bot' and c.status <> 'removed' and c.tg_chat_id::text = q.trigger_value
    where q.workspace_id = $1 and q.trigger_type = 'join_request' and b.status <> 'removed' order by q.active desc, q.id`, [wsId]);
  return rows;
}

async function getOwn(wsId, id) {
  const q = await db.one(`select q.*, b.username as bot_username, b.status as bot_status from sequences q join connections b on b.id = q.connection_id
    where q.id = $1 and q.workspace_id = $2 and q.trigger_type in ('join_request','bot_start') and b.status <> 'removed'`, [id, wsId]);
  if (!q) throw httpError(404, 'That flow was not found.', 'not_found');
  return q;
}

/** People who tapped Start through this flow and can be messaged (the "Broadcast to these people" audience). */
async function startedCount(wsId, flowId, botId) {
  const r = await db.one(`select count(*)::int n from subscribers s where s.connection_id = $3 and s.status = 'active'
      and exists (select 1 from join_requests j where j.subscriber_id = s.id and j.sequence_id = $2 and j.workspace_id = $1 and j.started_at is not null)`, [wsId, flowId, botId]);
  return r.n;
}

async function detail(ws, q) {
  const steps = await loadSteps(q.id);
  if (q.trigger_type === 'bot_start') {
    return {
      id: q.id, start_type: 'bot_start', name: q.name, active: q.active, paused_by_plan: q.paused_by_plan, bot_id: q.connection_id, bot_username: q.bot_username,
      start_code: q.trigger_value, is_default: !!q.is_default, bot_type: q.bot_type || 'custom', start_url: q.bot_username ? startUrl({ username: q.bot_username }, q.trigger_value) : null,
      approve_mode: 'after_welcome', start_button: false, start_label: '', invite_link: null, chat_id: null, chat: null,
      steps: stepsToV2(steps), blocks: stepsToBlocks(steps), started_count: await require('./bots').startedCount(q.id, q.connection_id),
    };
  }
  const chat = await db.one("select id, title, kind, username from connections where workspace_id = $1 and kind <> 'bot' and status <> 'removed' and tg_chat_id::text = $2", [ws.id, q.trigger_value || '']);
  return {
    start_type: 'join_request', bot_type: 'welcome',
    id: q.id, name: q.name, active: q.active, paused_by_plan: q.paused_by_plan, approve_mode: q.approve_mode, start_button: q.start_button, start_label: q.start_label,
    invite_link: q.invite_link, bot_id: q.connection_id, bot_username: q.bot_username, chat_id: chat ? chat.id : null, chat,
    steps: stepsToV2(steps), blocks: stepsToBlocks(steps), started_count: await startedCount(ws.id, q.id, q.connection_id),
  };
}

/** Flows a message can start for the same person: this bot's Welcome Flows and auto follow-ups (not the flow itself). */
async function startable(wsId) {
  return db.many(`select q.id, q.name, q.trigger_type, q.active, q.connection_id as bot_id from sequences q join connections b on b.id = q.connection_id
    where q.workspace_id = $1 and b.status <> 'removed' order by q.trigger_type <> 'join_request', q.name, q.id limit 200`, [wsId]);
}

/** Numbers for one flow. Free: none. Starter: per-step delivered and clicked (and button taps). Growth and up: the whole funnel and A/B split. */
async function stats(ws, q) {
  const feats = billing.featureSet(await billing.limits(ws));
  const has = (k) => feats.has(k);
  if (!has('basic_stats')) return { locked: 'basic_stats' };
  const f = await db.one(`select count(*)::int requests, count(*) filter (where welcome = 'sent')::int welcomed, count(started_at)::int started,
      count(*) filter (where status = 'approved')::int approved, count(*) filter (where status = 'pending')::int pending,
      count(*) filter (where status = 'declined')::int declined, count(*) filter (where welcome = 'skipped_limit')::int no_welcome,
      count(*) filter (where welcome = 'failed')::int failed
    from join_requests where sequence_id = $1`, [q.id]);
  const clicked = await db.one(`select count(distinct k.subscriber_id)::int n from clicks k join links l on l.code = k.code join sequence_steps s on s.id = l.step_id
    where s.sequence_id = $1 and k.subscriber_id is not null`, [q.id]);
  const steps = await db.many(`select s.id, s.position, s.variant, s.trigger_type,
      (select count(*)::int from deliveries d where d.step_id = s.id and d.status = 'sent') as delivered,
      (select count(*)::int from deliveries d where d.step_id = s.id and d.status in ('failed','blocked')) as failed,
      (select count(*)::int from clicks k join links l on l.code = k.code where l.step_id = s.id) as clicks,
      (select count(distinct k.subscriber_id)::int from clicks k join links l on l.code = k.code where l.step_id = s.id and k.subscriber_id is not null) as clickers,
      (select count(*)::int from sequence_runs r where r.sequence_id = s.sequence_id and r.next_position = s.position and r.status = 'waiting') as waiting_start,
      (select count(*)::int from sequence_runs r where r.sequence_id = s.sequence_id and r.next_position = s.position and r.status = 'awaiting') as awaiting,
      (select count(*)::int from flow_step_runs x where x.step_id = s.id and x.status = 'waiting_start') as answer_waiting,
      (select count(*)::int from flow_step_runs x where x.step_id = s.id and x.status = 'cancelled') as cancelled,
      (select coalesce(json_agg(json_build_object('id', l.button_id, 'label', l.label, 'kind', l.kind,
          'taps', (select count(*)::int from clicks k where k.code = l.code), 'people', (select count(distinct k.subscriber_id)::int from clicks k where k.code = l.code and k.subscriber_id is not null))
        order by l.position, l.created_at), '[]') from links l where l.step_id = s.id) as buttons
    from sequence_steps s where s.sequence_id = $1 order by s.position, s.variant`, [q.id]);
  const out = {
    funnel: has('flow_funnel_stats') ? { ...f, clicked: clicked.n } : null,
    basic: { requests: f.requests, welcomed: f.welcomed, approved: f.approved, no_welcome: f.no_welcome, started: f.started },
    // One row per step; A/B versions of the welcome are added together here (split below in `ab`).
    steps: steps.filter((s) => s.variant === 0).map((s) => {
      const all = steps.filter((v) => v.position === s.position);
      const sum = (k) => all.reduce((n, v) => n + v[k], 0);
      return { id: s.id, position: s.position, trigger: s.position === 1 ? null : s.trigger_type, delivered: sum('delivered'), failed: sum('failed'), clicks: sum('clicks'), clickers: sum('clickers'),
        waiting_start: s.waiting_start + s.answer_waiting, awaiting: s.awaiting, cancelled: s.cancelled, buttons: s.buttons };
    }),
    ab: null,
  };
  if (q.trigger_type === 'bot_start') {
    out.bot = await db.one(`select count(*)::int started, count(*) filter (where status = 'done')::int finished,
        (select count(distinct subscriber_id)::int from bot_answers where sequence_id = $1) as leads,
        (select count(*)::int from bot_referrals where sequence_id = $1 and counted) as referrals,
        (select count(distinct k.subscriber_id)::int from clicks k join links l on l.code = k.code join sequence_steps s on s.id = l.step_id where s.sequence_id = $1 and k.subscriber_id is not null) as clicked
      from sequence_runs where sequence_id = $1`, [q.id]);
    out.funnel = null; out.basic = { requests: 0, welcomed: 0, approved: 0, no_welcome: 0, started: out.bot.started };
  }
  const first = steps.filter((s) => s.position === (steps[0] || {}).position);
  if (first.length > 1 && has('flow_funnel_stats')) {
    out.ab = first.map((s) => ({ variant: s.variant, label: String.fromCharCode(65 + s.variant), delivered: s.delivered, clicks: s.clicks, clickers: s.clickers, rate: s.delivered ? Math.round(s.clickers / s.delivered * 1000) / 10 : 0 }));
  }
  return out;
}

async function pending(wsId, flowId, limit = 200) {
  return db.many(`select j.id, j.first_name, j.username, j.requested_at, j.welcome, j.started_at, j.error, q.name as flow_name
    from join_requests j left join sequences q on q.id = j.sequence_id
    where j.workspace_id = $1 and j.status = 'pending' and ($2::bigint is null or j.sequence_id = $2) order by j.requested_at desc limit $3`, [wsId, flowId || null, limit]);
}

/** Approve or decline many open requests (the owner's "let in" / "decline" buttons). */
async function decideMany(wsId, ids, action) {
  const rows = await db.many("select * from join_requests where workspace_id = $1 and id = any($2::bigint[]) and status = 'pending'", [wsId, ids]);
  const bots = new Map();
  for (const id of new Set(rows.map((r) => String(r.connection_id)))) bots.set(id, await db.one("select * from connections where id = $1 and kind = 'bot' and status <> 'removed'", [id]));
  const out = { approved: 0, declined: 0, gone: 0, failed: 0 };
  // ENG-10: a few at a time (inside Telegram's limits; withRetry waits on a 429), so 200 people don't take minutes.
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const jr = rows[next++];
      const bot = bots.get(String(jr.connection_id));
      const st = bot ? await decide(bot, jr, action) : 'failed';
      out[st === 'approved' ? 'approved' : st === 'declined' ? 'declined' : st === 'gone' ? 'gone' : 'failed']++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, rows.length) }, worker));
  return out;
}

module.exports = {
  UNIT, UNIT_MAX, MAX_WAIT, normUnit, splitDelay, delayOf, waitSeconds, waitText, QUICK_SECONDS, WINDOW_SECONDS, releaseHeld, quickStepDone, quickPlan,
  AI_KEYS, AI_BOT_KEYS, cleanAiBot, botMaxButtons, TEMPLATES, template, templateBlocks, MODES, TRIGGERS, EVENT_TRIGGERS, TIME_TRIGGERS, BRAND_TEXT, DEFAULT_START, stepsToBlocks, stepsToV2, blocksToSteps, loadSteps, cleanFlow, cleanAiFlow, flowGraph, triggerOf,
  checkAdmin, requireAdmin, saveSteps, liveClash, assertCanGoLive, startable, startedCount,
  onJoinRequest, onStart, decide, decideMany, summary, getOwn, detail, stats, pending, brandingHtml, startUrl, freeWelcome, placeholderIn, assertNoPlaceholders, BRAND_LEN, stepButtons,
};

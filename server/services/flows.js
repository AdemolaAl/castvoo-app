'use strict';
/*
 * Welcome Flows: what happens when someone asks to join a channel or group.
 *
 * A flow is a follow-up sequence with trigger_type 'join_request' (same tables as auto follow-ups, so the
 * join-request follow-ups made before Welcome Flows existed keep working and show up here), plus:
 *   approve_mode   instant | after_welcome (default) | tap (when they press Start in the bot) | manual (owner decides)
 *   start_button   a "Tap to start" button on the welcome: t.me/<bot>?start=j_<code>. Pressing Start makes them
 *                  a bot subscriber, so the later steps can reach them ("tap-to-start capture").
 *   invite_link    optional: people who ask to join through this invite link get this flow.
 * Steps are message blocks (position 1..n). A wait block is stored as the delay before the next message.
 * Step 1 can have A/B versions (variant 1..3 next to variant 0). Later steps can have a condition:
 * send only if they clicked / did not click a button in the previous message.
 *
 * Telegram rules this code follows:
 *  - After a join request, the bot may message the person for 5 minutes, through user_chat_id, until the
 *    request is processed. So step 1 is sent at once, before the person is let in.
 *  - Bots cannot message people who never pressed Start. Later steps wait ('waiting' runs) until the person
 *    presses Start, then go out on time. Waiting runs stop after 7 days.
 *
 * Plan rules (services/billing.js): join requests per month (+10% grace, then welcomes pause but people are
 * still let in), flows, steps per flow, features (tap_to_start, ab_welcome_2/4, condition_clicked ...), and the
 * Free plan's "⚡ Free welcome bot by Castvoo.com" line.
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

const UNIT = { min: 1, hour: 60, day: 1440 };
const MODES = ['instant', 'after_welcome', 'tap', 'manual'];
const BRAND_TEXT = 'Free welcome bot by Castvoo.com';
const BRAND_LEN = BRAND_TEXT.length + 4; // "\n\n⚡ " + text, as Telegram counts it
const DEFAULT_TAP = '✅ Tap to join';
const DEFAULT_START = '👉 Tap Start for more';
const ROW_MAX = 2;

/* ---------- Templates (the owner picks one, edits the words, switches it on) ---------- */
const TEMPLATES = [
  {
    key: 'simple', name: 'Simple welcome + let them in', emoji: '👋',
    about: 'One friendly message, then they are let in.',
    approve_mode: 'after_welcome', start_button: false,
    blocks: [{ type: 'message', body: 'Hi {name} 👋\n\nThanks for asking to join. You are in!\n\nTurn on notifications so you never miss a post.' }],
  },
  {
    key: 'vip', name: 'Welcome + VIP link button', emoji: '⭐',
    about: 'A welcome with a button to your VIP group, shop or offer.',
    approve_mode: 'after_welcome', start_button: false,
    blocks: [{ type: 'message', body: 'Welcome, {name}! 🎉\n\nYou are in. Want more? Our VIP group gets the best updates first.', buttons: [{ label: '⭐ Join the VIP group', url: '', row: 0 }] }],
  },
  {
    key: 'tap', name: 'Tap to join (filters bots)', emoji: '✅',
    about: 'They tap one button to get in. Bots and fake accounts usually don\'t.',
    approve_mode: 'tap', start_button: true, start_label: DEFAULT_TAP,
    blocks: [{ type: 'message', body: 'Hi {name}! One quick step to get in:\n\nTap the button below, then press *Start*. You will be let in straight away.' }],
  },
  {
    key: 'followup', name: 'Welcome + 3-day follow-up', emoji: '📅',
    about: 'A welcome now, a tip on day 1 and your offer on day 3.',
    approve_mode: 'after_welcome', start_button: true, start_label: DEFAULT_START,
    blocks: [
      { type: 'message', body: 'Welcome, {name}! 👋 You are in.\n\nTap the button below and press Start, and I will send you our best tips over the next few days.' },
      { type: 'wait', value: 1, unit: 'day' },
      { type: 'message', body: 'Hi {name}, here is today\'s tip:\n\n(Write one useful tip for your audience here.)' },
      { type: 'wait', value: 2, unit: 'day' },
      { type: 'message', body: 'Hi {name}, thanks for staying with us. 💙\n\n(Tell them about your offer here, with one clear button.)' },
    ],
  },
  {
    key: 'gift', name: 'Free gift / lead magnet', emoji: '🎁',
    about: 'Offer a free guide. People tap Start in your bot to get it.',
    approve_mode: 'after_welcome', start_button: true, start_label: '🎁 Get my free gift',
    blocks: [
      { type: 'message', body: 'Hi {name}, welcome! 🎁\n\nWe made a free guide for new members. Tap the button below and press Start to get it.' },
      { type: 'wait', value: 1, unit: 'min' },
      { type: 'message', body: 'Here is your free guide, {name} 👇', buttons: [{ label: '📘 Open the guide', url: '', row: 0 }] },
    ],
  },
];
const template = (key) => TEMPLATES.find((t) => t.key === key) || null;

/* ---------- Blocks <-> steps ---------- */
function splitDelay(m) { m = Number(m) || 0; if (m && m % 1440 === 0) return [m / 1440, 'day']; if (m && m % 60 === 0) return [m / 60, 'hour']; return [m, 'min']; }

/** Saved steps (with their variants and buttons) → the blocks the builder shows. */
function stepsToBlocks(steps) {
  const out = [];
  for (const s of steps.filter((x) => x.variant === 0).sort((a, b) => a.position - b.position)) {
    if (s.position > 1 && s.delay_minutes > 0) { const [value, unit] = splitDelay(s.delay_minutes); out.push({ type: 'wait', value, unit }); }
    out.push({
      type: 'message', id: s.id, body: s.body, media_id: s.media_id, media_kind: s.media_kind || null, buttons: s.buttons || [], condition: s.condition || null,
      variants: steps.filter((v) => v.position === s.position && v.variant > 0).sort((a, b) => a.variant - b.variant)
        .map((v) => ({ id: v.id, body: v.body, media_id: v.media_id, media_kind: v.media_kind || null, buttons: v.buttons || [] })),
    });
  }
  return out;
}

async function loadSteps(seqId) {
  return db.many(`select s.id, s.position, s.variant, s.delay_minutes, s.body, s.media_id, s.condition, m.kind as media_kind,
      (select coalesce(json_agg(json_build_object('label', l.label, 'url', l.url, 'code', l.code, 'row', l.row) order by l.position, l.created_at, l.code), '[]') from links l where l.step_id = s.id) as buttons
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

/** Check one message block against Telegram and the plan. */
async function cleanMessage(ws, m, what, l) {
  const buttons = Array.isArray(m.buttons) ? m.buttons.filter((b) => b && (String(b.label || '').trim() || String(b.url || '').trim())) : [];
  const maxButtons = l.branding ? 3 : 6;
  if (buttons.length > maxButtons) throw httpError(l.branding ? 402 : 400, l.branding ? `The Free plan allows 3 buttons on the welcome. ${what} has ${buttons.length}. Upgrade to add more.` : `Use 6 buttons or fewer (${what}).`, l.branding ? 'plan_feature' : 'bad_request');
  let msg;
  try { msg = await B.checkMessage(ws.id, { body: m.body, media_id: m.media_id, buttons }); } catch (e) { e.message = `${what}: ${e.message}`; throw e; }
  // Rows: up to 2 buttons side by side. row is a small number the builder gives; same number = same row.
  const rows = new Map();
  msg.buttons = msg.buttons.map((b, i) => {
    const raw = buttons[i] && buttons[i].row;
    const row = raw === undefined || raw === null || raw === '' ? null : int(raw, 'Button row', { min: 0, max: 50 });
    if (row !== null) { rows.set(row, (rows.get(row) || 0) + 1); if (rows.get(row) > ROW_MAX) throw badRequest(`${what}: put at most 2 buttons side by side.`); }
    return { ...b, row };
  });
  if (msg.media_id) {
    if (!(await settings.feature('media'))) throw httpError(403, 'Photos and videos are switched off right now.', 'forbidden');
    const media = await db.one('select kind from media where id = $1', [msg.media_id]);
    if (l.branding && media && media.kind !== 'photo') throw httpError(402, 'The Free plan welcome can have 1 photo. Videos and GIFs are on paid plans.', 'plan_feature');
  }
  if (l.branding) {
    const lim = msg.media_id ? tg.LIMITS.caption : tg.LIMITS.text;
    if (tg.visibleLength(msg.body) + BRAND_LEN > lim) throw badRequest(`${what}: on the Free plan the welcome ends with "${BRAND_TEXT}", so keep it under ${(lim - BRAND_LEN).toLocaleString('en-US')} characters.`);
  }
  return msg;
}

/**
 * Validate what the builder sends. Returns { name, chat, bot, approve_mode, start_button, start_label, invite_link, steps }.
 * steps: [{ id?, position, delay_minutes, body, media_id, buttons, condition, variants: [{ id?, body, media_id, buttons }] }]
 */
async function cleanFlow(ws, b, { partialChecks = true } = {}) {
  const l = await billing.limits(ws);
  const name = str(b.name, 'Flow name', { min: 1, max: 60 });
  const chat = await db.one("select * from connections where id = $1 and workspace_id = $2 and kind <> 'bot' and status <> 'removed'", [int(b.chat_id, 'Channel or group'), ws.id]);
  if (!chat) throw badRequest('Pick the channel or group people ask to join. Connect it first on the Channels & bots page.');
  const bot = await db.one("select * from connections where id = $1 and workspace_id = $2 and kind = 'bot' and status <> 'removed'", [int(b.bot_id, 'Bot'), ws.id]);
  if (!bot) throw badRequest('Pick the bot that sends the welcome. Connect your own bot first (Channels & bots → Add a bot).');
  const mode = oneOf(b.approve_mode || 'after_welcome', 'How people get in', MODES);
  if (mode === 'tap') await billing.requirePlanFeature(ws, 'tap_to_start');
  if (mode === 'manual') await billing.requirePlanFeature(ws, 'welcome_flows');
  const startButton = mode === 'tap' || bool(b.start_button);
  if (startButton) await billing.requirePlanFeature(ws, 'tap_to_start');
  const startLabel = startButton ? (str(b.start_label, 'Start button text', { max: 40, required: false }) || (mode === 'tap' ? DEFAULT_TAP : DEFAULT_START)) : '';
  let invite = str(b.invite_link, 'Invite link', { max: 200, required: false }) || null;
  if (invite) {
    await billing.requirePlanFeature(ws, 'welcome_flows');
    if (!/^https:\/\/t\.me\/\+[A-Za-z0-9_-]{6,64}$/.test(invite)) throw badRequest('The invite link must look like https://t.me/+AbC123xyz. Leave it empty to welcome everyone who asks to join.');
  }

  const blocks = Array.isArray(b.blocks) ? b.blocks : [];
  if (!blocks.length) throw badRequest('Add a welcome message first.');
  if (blocks.length > 400) throw badRequest('That flow is too long.');
  if (!blocks[0] || blocks[0].type !== 'message') throw badRequest('A flow starts with a message. Telegram allows the welcome only in the first 5 minutes, so it can\'t wait.');
  const steps = [];
  let wait = 0;
  for (const [i, blk] of blocks.entries()) {
    if (!blk || typeof blk !== 'object') throw badRequest('One of the steps is empty.');
    if (blk.type === 'wait') {
      const unit = oneOf(blk.unit || 'min', 'Wait unit', Object.keys(UNIT));
      const value = int(blk.value ?? 0, `Wait (step ${i + 1})`, { min: 0, max: unit === 'day' ? 365 : unit === 'hour' ? 8760 : 525600 });
      wait += value * UNIT[unit];
      if (wait > 525600) throw badRequest('Waits can add up to one year at most.');
      continue;
    }
    if (blk.type !== 'message') throw badRequest('Each step is a message or a wait.');
    const pos = steps.length + 1;
    const what = pos === 1 ? 'The welcome message' : `Message ${pos}`;
    const msg = await cleanMessage(ws, blk, what, l);
    let condition = blk.condition || null;
    if (condition) {
      condition = oneOf(condition, 'Condition', ['clicked', 'not_clicked']);
      if (pos === 1) throw badRequest('The welcome message is sent to everyone, so it can\'t have a condition.');
      await billing.requirePlanFeature(ws, 'condition_clicked');
    }
    const variants = [];
    const rawV = Array.isArray(blk.variants) ? blk.variants.filter(Boolean) : [];
    if (rawV.length) {
      if (pos !== 1) throw badRequest('A/B versions are for the welcome message only.');
      await billing.requirePlanFeature(ws, 'ab_welcome_2');
      if (rawV.length + 1 > 2) await billing.requirePlanFeature(ws, 'ab_welcome_4');
      if (rawV.length + 1 > 4) throw badRequest('Use up to 4 versions of the welcome.');
      for (const [vi, v] of rawV.entries()) variants.push({ id: v.id || null, ...(await cleanMessage(ws, v, `Version ${String.fromCharCode(66 + vi)} of the welcome`, l)) });
    }
    steps.push({ id: blk.id || null, position: pos, delay_minutes: pos === 1 ? 0 : wait, ...msg, condition, variants });
    wait = 0;
  }
  if (wait > 0 && partialChecks) throw badRequest('The last wait has no message after it. Add a message or remove the wait.');
  if (l.flow_steps !== billing.UNLIMITED && steps.length > l.flow_steps) {
    if (l.flow_steps <= 1) throw httpError(402, `The ${l.plan.name} plan sends 1 welcome message. Upgrade to Starter to add follow-up steps.`, 'limit_flow_steps', { limit: l.flow_steps });
    throw httpError(402, `Your ${l.plan.name} plan allows ${l.flow_steps} messages per flow. This one has ${steps.length}. Upgrade or remove some.`, 'limit_flow_steps', { limit: l.flow_steps });
  }
  return { name, chat, bot, approve_mode: mode, start_button: startButton, start_label: startLabel, invite_link: invite, steps };
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
  const put = async (s, position, variant, delay, condition) => {
    let id = s.id && oldIds.has(String(s.id)) && !kept.has(String(s.id)) ? Number(s.id) : null;
    if (id) await c.query('update sequence_steps set position = $2, variant = $3, delay_minutes = $4, body = $5, media_id = $6, condition = $7 where id = $1', [id, position, variant, delay, s.body, s.media_id, condition]);
    else id = (await c.query('insert into sequence_steps(sequence_id, position, variant, delay_minutes, body, media_id, condition) values ($1,$2,$3,$4,$5,$6,$7) returning id', [seqId, position, variant, delay, s.body, s.media_id, condition])).rows[0].id;
    kept.add(String(id));
    // Keep each button's short link (people may already have it in Telegram): change it in place, add new ones,
    // and unhook extra ones (they keep redirecting, their clicks are kept).
    const had = (await c.query('select code from links where step_id = $1 order by position, created_at, code', [id])).rows;
    for (const [bi, btn] of s.buttons.entries()) if (had[bi]) await c.query('update links set label = $2, url = $3, position = $4, row = $5 where code = $1', [had[bi].code, btn.label, btn.url, bi, btn.row]);
    if (s.buttons.length > had.length) await B.makeLinks(c, wsId, s.buttons.slice(had.length).map((btn, j) => ({ ...btn, position: had.length + j })), { stepId: id });
    for (const extra of had.slice(s.buttons.length)) await c.query('update links set step_id = null where code = $1', [extra.code]);
    return id;
  };
  for (const s of steps) {
    await put(s, s.position, 0, s.delay_minutes, s.condition);
    for (const [vi, v] of (s.variants || []).entries()) await put(v, s.position, vi + 1, 0, null);
  }
  const gone = old.filter((o) => !kept.has(String(o.id))).map((o) => o.id);
  if (gone.length) {
    await c.query('update links set step_id = null where step_id = any($1::bigint[])', [gone]);
    await c.query('delete from sequence_steps where id = any($1::bigint[])', [gone]);
  }
  await c.query("update sequence_runs set status = 'done' where sequence_id = $1 and status in ('active','waiting') and next_position > $2", [seqId, steps.length]);
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
  if (l.flows === billing.UNLIMITED) return;
  const live = (await db.one(`select count(*)::int n from sequences q join connections c on c.id = q.connection_id
    where q.workspace_id = $1 and q.trigger_type = 'join_request' and q.active and c.status <> 'removed' and q.id <> $2 and q.id <> $3`, [ws.id, flowId || 0, replacing || 0])).n;
  if (live >= l.flows) throw httpError(402, `Your ${l.plan.name} plan runs ${l.flows} live Welcome Flow${l.flows === 1 ? '' : 's'}. Switch another one off first, or upgrade.`, 'limit_flows', { limit: l.flows });
}

/* ---------- Runtime: a join request arrives at the customer's own bot ---------- */

function startUrl(bot, code) { return `https://t.me/${bot.username}?start=${code}`; }
async function brandingHtml(ws) {
  const owner = await db.one('select ref_code from users where id = $1', [ws.owner_user_id]);
  const href = `${config.appUrl}/r/${owner ? owner.ref_code : ''}`;
  return `\n\n⚡ <a href="${href.replace(/"/g, '&quot;')}">${BRAND_TEXT}</a>`;
}

/**
 * ENG-4 / AUD-14: the Free plan's welcome rules, applied when the welcome is SENT (a flow saved on a bigger plan keeps
 * running after a drop to Free): at most 3 buttons, a photo only (a video or GIF is left out), and the text cut so it
 * still fits with the "Free welcome bot by Castvoo.com" line.
 */
async function freeWelcome(msg) {
  const out = { ...msg, buttons: (msg.buttons || []).slice(0, 3) };
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
        start_code = $10, tg_date = $11, requested_at = now(), welcome = 'none', welcomed_at = null, started_at = null, error = null, step_id = null, variant = 0
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
    // The welcome always goes first: once a request is processed, Telegram no longer lets the bot message them.
    //  instant:        let them in straight away, even if the welcome could not be sent.
    //  after_welcome:  let them in once the welcome reached them (or welcomes are paused by the plan: auto-approve keeps
    //                  working). If Telegram refused the welcome, they wait in the Requests list for the owner.
    //  tap:            let in when they press Start through the welcome's button (bot-updates → onStart).
    //  manual:         the owner lets them in (or declines) from the dashboard.
    const sent = await welcome();
    if (mode === 'instant' || (mode === 'after_welcome' && (sent || skip))) await decide(conn, rowNow(), 'approve');
    const welcomed = sent === true;
    // Later steps: only on plans with follow-up steps, never while welcomes are paused.
    const later = steps.filter((s) => s.variant === 0 && s.position > firsts[0].position);
    const allowed = l.flow_steps === billing.UNLIMITED ? Infinity : l.flow_steps;
    if (!skip && later.length && allowed > 1 && has('welcome_flows')) {
      await db.query(`insert into sequence_runs(sequence_id, subscriber_id, next_position, due_at, variant, status)
          values ($1,$2,$3, now() + make_interval(mins => $4), $5, $6) on conflict (sequence_id, subscriber_id) do nothing`,
      [flow.id, sub.id, later[0].position, later[0].delay_minutes, (await db.one('select variant from join_requests where id = $1', [row.id])).variant, sub.status === 'active' ? 'active' : 'waiting']);
    }
    void welcomed;
  } catch (e) {
    log.error('join request failed', { conn: conn.id, err: e });
    await db.query('update join_requests set error = $2 where id = $1', [row.id, String(e.message || e).slice(0, 200)]).catch(() => {});
  }
  await meterAlerts(ws, meterNow).catch(() => {});
  return { ok: true, id: row.id };
}

async function stepButtons(step) {
  const links = await db.many('select code, label, url, row from links where step_id = $1 order by position, created_at, code', [step.id]);
  return links.map((x) => ({ label: x.label, url: x.url, code: x.code, row: x.row }));
}

/**
 * Someone pressed Start in a bot. payload 'j_<code>' = they came from a welcome's button.
 * Marks "tapped Start", lets them in for "Tap to join" flows, and wakes their waiting steps.
 */
async function onStart(conn, sub, from, payload) {
  await db.query('update join_requests set started_at = now(), subscriber_id = coalesce(subscriber_id, $3) where connection_id = $1 and tg_user_id = $2 and started_at is null', [conn.id, from.id, sub.id]);
  await db.query("update sequence_runs set status = 'active', due_at = greatest(due_at, now()) where subscriber_id = $1 and status = 'waiting'", [sub.id]);
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
    where q.id = $1 and q.workspace_id = $2 and q.trigger_type = 'join_request' and b.status <> 'removed'`, [id, wsId]);
  if (!q) throw httpError(404, 'That flow was not found.', 'not_found');
  return q;
}

async function detail(ws, q) {
  const chat = await db.one("select id, title, kind, username from connections where workspace_id = $1 and kind <> 'bot' and status <> 'removed' and tg_chat_id::text = $2", [ws.id, q.trigger_value || '']);
  const steps = await loadSteps(q.id);
  return {
    id: q.id, name: q.name, active: q.active, paused_by_plan: q.paused_by_plan, approve_mode: q.approve_mode, start_button: q.start_button, start_label: q.start_label,
    invite_link: q.invite_link, bot_id: q.connection_id, bot_username: q.bot_username, chat_id: chat ? chat.id : null, chat, blocks: stepsToBlocks(steps),
  };
}

/** Numbers for one flow. Free: none. Starter: per-step delivered and clicked. Growth and up: the whole funnel and A/B split. */
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
  const steps = await db.many(`select s.id, s.position, s.variant,
      (select count(*)::int from deliveries d where d.step_id = s.id and d.status = 'sent') as delivered,
      (select count(*)::int from deliveries d where d.step_id = s.id and d.status in ('failed','blocked')) as failed,
      (select count(*)::int from clicks k join links l on l.code = k.code where l.step_id = s.id) as clicks,
      (select count(distinct k.subscriber_id)::int from clicks k join links l on l.code = k.code where l.step_id = s.id and k.subscriber_id is not null) as clickers,
      (select count(*)::int from sequence_runs r where r.sequence_id = s.sequence_id and r.next_position = s.position and r.status = 'waiting') as waiting_start
    from sequence_steps s where s.sequence_id = $1 order by s.position, s.variant`, [q.id]);
  const out = {
    funnel: has('flow_funnel_stats') ? { ...f, clicked: clicked.n } : null,
    basic: { requests: f.requests, welcomed: f.welcomed, approved: f.approved, no_welcome: f.no_welcome },
    // One row per step; A/B versions of the welcome are added together here (split below in `ab`).
    steps: steps.filter((s) => s.variant === 0).map((s) => {
      const all = steps.filter((v) => v.position === s.position);
      const sum = (k) => all.reduce((n, v) => n + v[k], 0);
      return { id: s.id, position: s.position, delivered: sum('delivered'), failed: sum('failed'), clicks: sum('clicks'), clickers: sum('clickers'), waiting_start: s.waiting_start };
    }),
    ab: null,
  };
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
  TEMPLATES, template, MODES, BRAND_TEXT, stepsToBlocks, loadSteps, cleanFlow, checkAdmin, requireAdmin, saveSteps, liveClash, assertCanGoLive,
  onJoinRequest, onStart, decide, decideMany, summary, getOwn, detail, stats, pending, brandingHtml, startUrl, freeWelcome, placeholderIn, assertNoPlaceholders, BRAND_LEN,
};

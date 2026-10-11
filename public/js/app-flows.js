'use strict';
/*
 * app-flows.js: "🤖 Bots" (it absorbed "Welcome Flows"; the page key and URLs stay #app/flows so old links work).
 *   Two kinds of bot, one builder:
 *     👋 Welcome bot  when someone asks to join your channel or group (the Welcome Flows, start_type 'join_request')
 *     💬 Chat bot     when someone opens your bot and taps Start (t.me/<bot>?start=<code>, start_type 'bot_start')
 *   Chat bots add three step kinds (services/bots.js): ✅ Check they joined, ❓ Ask a question, 🔗 Invite friends, and the
 *   trigger 🏆 "When they reach their invite goal" (on_goal). The phone preview plays them too: "they joined / not yet",
 *   typed answers checked like the real bot, and "🧪 pretend a friend joined".
 *   #app/flows?bot=<template>  builder for a new Chat bot from a template
 *   #app/flows?id=<id>&tab=leads | invites   a Chat bot's answers and invite leaderboard
 *   #app/flows              list of bots, the join-request meter, templates (empty state)
 *   #app/flows?tpl=<key>    builder for a new flow made from a template ("blank" = from scratch)
 *   #app/flows?id=<id>      builder for a saved flow (&tab=stats | requests)
 * API: GET/POST /api/flows, GET/PUT/DELETE /api/flows/:id, POST /api/flows/:id/toggle | duplicate | invite-link | audience,
 *      GET /api/flows/:id/stats, POST /api/flows/check, GET /api/flows/requests, POST /api/flows/requests/decide, POST /api/ai/flow
 *
 * The builder is a top-to-bottom list of messages. Between two messages a big chip asks "When should the next message
 * come?": ⚡ Right away · ⏱ After a wait · 👆 When they tap Start · 🔘 When they tap a button · 💤 If they don't respond.
 * Messages that answer buttons of the same message are one choice, shown as tabs ("If they tap 'VIP signals'").
 * The phone on the right is a live, tappable preview (simRun): Start, Reply and Link buttons move it along, waits and
 * reminders are skipped forward with "⏩ Skip".
 * The same rules as the server (services/flows.js flowGraph) are in wfGraph() here.
 *
 * The render helpers flowCardHtml(), stepsHtml(), simHtml(), tgPreviewHtml(), wfWhen() and simRun() are pure (they
 * only build HTML or data, escaping everything) so the tests can run them in a sandbox.
 */

const FL = { data: null, E: null, sel: 0, dirty: false, tab: 'build', admin: null, stats: null, sim: [], open: -1, adding: false, btab: {}, cas: false, mode: 'try', pvStep: null, play: null, test: null };
const WF_UNIT = { sec: ['second', 'seconds'], min: ['minute', 'minutes'], hour: ['hour', 'hours'], day: ['day', 'days'] };
const WF_SECS = { sec: 1, min: 60, hour: 3600, day: 86400 };
/* Telegram's 5-minute window after a join request: messages due this soon after the welcome reach everyone (services/flows.js QUICK_SECONDS). */
const WF_QUICK = 280;
const WF_MODES = [
  ['after_welcome', 'After the welcome', 'They get your welcome first, then they are let in.', 'Recommended', null],
  ['instant', 'Straight away', 'Everyone is let in at once, even if the welcome can\'t be sent.', '', null],
  ['tap', 'When they tap Start', 'They tap Start in your bot to get in. Stops most fake accounts.', '', 'tap_to_start'],
  ['manual', 'I decide', 'Requests wait in a list. You let people in or decline them.', '', 'welcome_flows'],
];
const WF_TRIG = {
  after_previous: ['⚡', 'Right away', 'As soon as the message above is sent'],
  wait: ['⏱', 'After a wait', 'Seconds, minutes, hours or days later'],
  on_start: ['👆', 'When they tap Start', 'The moment they tap Start in your bot'],
  on_button: ['🔘', 'When they tap a button', 'Each button can get its own answer'],
  no_response: ['💤', 'If they don\'t respond in…', 'A reminder if they don\'t tap in time'],
  on_goal: ['🏆', 'When they reach their invite goal', 'The reward, once enough friends joined'],
};
const WF_TRIG_ORDER = ['after_previous', 'wait', 'on_start', 'on_button', 'no_response'];
/* Chat bots: everyone has tapped Start already (no on_start); the reward trigger shows when an invite step is above. */
function wfTrigOrder(E, i) {
  if (!wfIsBot(E)) return WF_TRIG_ORDER;
  const out = ['after_previous', 'wait', 'on_button', 'no_response'];
  if (E.steps.some((s, k) => k < i && wfKind(s) === 'referral')) out.push('on_goal');
  return out;
}
/* The special steps (services/bots.js STEP_TYPES): emoji, name, one plain line. */
const WF_KINDS = {
  check_join: ['✅', 'Check they joined', 'They join your channel first, then tap "I\'ve joined"'],
  ask: ['❓', 'Ask a question', 'Your bot waits for their answer and saves it'],
  referral: ['🔗', 'Invite friends', 'Their own invite link. The reward comes at the goal'],
};
const WF_ANSWERS = [['text', '✍️', 'Text'], ['number', '🔢', 'Number'], ['email', '📧', 'Email'], ['phone', '📱', 'Phone'], ['choice', '🔘', 'Buttons']];
const WF_RETRY = { text: 'Please type your answer 🙂', number: 'Please send a number, like 25 🙂', email: 'That doesn\'t look like an email address. Please send it like name@example.com 🙂', phone: 'Please send your phone number with the country code, like +234 801 234 5678, or tap the button below 🙂', choice: 'Please tap one of the buttons above 🙂' };
const WF_MAX_LINKS = 6; // Link buttons per message (Telegram check, broadcasts.checkMessage)
const WF_SAMPLE = { text: 'Ada Lovelace', number: '25', email: 'ada@example.com', phone: '+234 801 234 5678' };
const WF_BOT_TYPES = { welcome: ['👋', 'Welcome bot'], join_check: ['✅', 'Join check'], lead_magnet: ['🎁', 'Lead magnet'], menu: ['📋', 'Menu'], lead_questions: ['❓', 'Lead questions'], referral: ['🔗', 'Referral'], custom: ['✨', 'Chat bot'], broadcast: ['📣', 'Broadcast'] };
const WF_EMOJI = ['👉', '✅', '⭐', '🎁', '🔥', '📘', '💬', '🛍️', '📈', '🎉'];
const WF_LOCK_PLAN = { ai: 'Starter', tap_to_start: 'Starter', welcome_flows: 'Starter', ab_welcome_2: 'Growth', ab_welcome_4: 'Scale', condition_clicked: 'Growth', flow_funnel_stats: 'Growth', basic_stats: 'Starter', start_another_flow: 'Growth', broadcasts: 'Starter' };
const WF_CAS_EX = [
  'Welcome them, ask them to tap Start, then send my VIP link',
  'Two choices: VIP signals or free tips, each with its own answer',
  'Welcome, remind them after 2 minutes if they don\'t tap Start, then send a free gift',
  'Welcome and a 3-day follow-up with tips',
];

/* ---------- Small helpers ---------- */
function wfIsBot(E) { return !!(E && E.start_type === 'bot_start'); }
function wfKind(s) { return (s && WF_KINDS[s.type]) ? s.type : 'message'; }
/* Bot limits of the plan (services/billing.js BOT_PLANS): bot types and numbers (-1 = unlimited). */
function wfBotLim() { const p = FL.data && FL.data.plan; return (p && p.limits && p.limits.bots) || null; }
function wfBotHas(type) { const b = wfBotLim(); return !b || (b.bot_types || []).includes(type) || (type === 'broadcast' && wfHas('broadcasts')); }
const WF_KIND_TYPE = { check_join: 'join_check', ask: 'lead_questions', referral: 'referral' };
/* The same answer check as the bot (services/bots.js validateAnswer). Returns { ok, value } or { ok: false, message }. */
function wfValidate(type, raw, cfg) {
  cfg = cfg || {};
  const bad = { ok: false, message: String(cfg.retry_text || '').trim() || WF_RETRY[type] || WF_RETRY.text };
  const t = String(raw == null ? '' : raw).trim();
  if (!t || t[0] === '/') return bad;
  if (type === 'text') return t.length <= 1000 ? { ok: true, value: t } : bad;
  if (type === 'number') { const x = t.replace(/[\s,]/g, ''); return /^-?\d+(\.\d+)?$/.test(x) && x.length <= 18 ? { ok: true, value: String(Number(x)) } : bad; }
  if (type === 'email') { const x = t.toLowerCase(); return x.length <= 254 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[a-z]{2,}$/.test(x) ? { ok: true, value: x } : bad; }
  if (type === 'phone') { const d = t.replace(/\D/g, ''); return /^\+?[\d\s().-]{7,24}$/.test(t) && d.length >= 7 && d.length <= 15 ? { ok: true, value: (t[0] === '+' ? '+' : '') + d } : bad; }
  if (type === 'choice') {
    const ch = (cfg.choices || []).map(String);
    const norm = (x) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const n = /^\d{1,2}$/.test(t) ? Number(t) : 0;
    const hit = n >= 1 && n <= ch.length ? ch[n - 1] : ch.find((c) => norm(c) && norm(c) === norm(t));
    return hit ? { ok: true, value: hit } : bad;
  }
  return bad;
}
/* An invite step's text for the preview ({invite_link}, {invites}, {goal}; the link is added when the text has none). */
function wfFillInvite(body, link, invites, goal) {
  let out = String(body || '');
  const had = out.indexOf('{invite_link}') >= 0;
  out = out.split('{invite_link}').join(link).split('{invites}').join(String(invites)).split('{goal}').join(String(goal));
  return had ? out : out + '\n\n🔗 ' + link;
}
/* The text Telegram really gets for length checks: an "Invite friends" step has its link (~60 characters) and numbers
   filled in at send time, so count them like the server does (services/flows.js, S-6). */
function wfLenText(E, i, body) {
  if (!E || !E.steps[i] || wfKind(E.steps[i]) !== 'referral') return String(body || '');
  const b = (typeof FL !== 'undefined' && FL.data && FL.data.bots || []).find((x) => String(x.id) === String(E.bot_id));
  return wfFillInvite(body, 'https://t.me/' + ((b && b.username) || 'x'.repeat(32)) + '?start=r_' + 'x'.repeat(16), 99999, 1000);
}
/* The goal of the invite step above message i (0 = none). */
function wfGoalBefore(E, i) { for (let k = i - 1; k >= 0; k--) if (wfKind(E.steps[k]) === 'referral') return Number((E.steps[k].referral || {}).goal) || 3; return 0; }
function wfHas(k) { const p = FL.data && FL.data.plan; return !!(p && (p.features || []).includes(k)); }
function wfLimit(k) { const p = FL.data && FL.data.plan; return p && p.limits ? p.limits[k] : null; }
function wfWait(v, u) { v = Number(v) || 0; const n = WF_UNIT[u] || WF_UNIT.min; return v + ' ' + (v === 1 ? n[0] : n[1]); }
/* Seconds → [value, unit] in the biggest whole unit: 86400 → [1, 'day'], 45 → [45, 'sec']. */
function wfSplit(s) { s = Math.max(0, Math.round(Number(s) || 0)); if (!s) return [0, 'min']; if (s % 86400 === 0) return [s / 86400, 'day']; if (s % 3600 === 0) return [s / 3600, 'hour']; if (s % 60 === 0) return [s / 60, 'min']; return [s, 'sec']; }
function wfSecs(b) { return (Number(b && b.value) || 0) * (WF_SECS[b && b.unit] || 60); }
/* "1 hour", "2 hours": the unit names follow the number. */
function wfUnitOptions(value, unit) { const one = Number(value) === 1; return Object.keys(WF_UNIT).map((u) => '<option value="' + u + '"' + (unit === u ? ' selected' : '') + '>' + WF_UNIT[u][one ? 0 : 1] + '</option>').join(''); }
function wfLock(feature) { return '<span class="wf-lock" data-up="' + esc(feature) + '">' + icon('lock') + esc(WF_LOCK_PLAN[feature] || 'Upgrade') + '</span>'; }
function wfId() { let s = ''; const abc = 'abcdefghjkmnpqrstuvwxyz23456789'; for (let i = 0; i < 6; i++) s += abc[Math.floor(Math.random() * abc.length)]; return 'b' + s; }
function wfStartOn(E) { return !!(E && (E.approve_mode === 'tap' || E.start_button)); }
function wfStartLabel(E) { return (E.start_label || '').trim() || (E.approve_mode === 'tap' ? '✅ Tap to join' : '👆 Tap Start'); }
/* Words left over from a template, like "(Write one useful tip for your audience here.)", or Cas's [ADD DETAIL]. */
function wfPlaceholder(body) {
  const t = String(body || '');
  const m = t.match(/\((?:write|tell|add|put|replace|describe)\b[^)]*\bhere\b[^)]*\)/i) || t.match(/\[ADD[^\]]*\]/i);
  return m ? m[0] : '';
}
/* API buttons [{label,url,row}] → rows [[{label,url}], ...]; buttons without a row get a row each (the list page's preview). */
function wfRows(buttons) {
  const rows = []; let last = null;
  for (const b of buttons || []) {
    const r = b.row === undefined || b.row === null ? null : Number(b.row);
    if (r !== null && r === last && rows.length && rows[rows.length - 1].length < 2) rows[rows.length - 1].push(b);
    else rows.push([b]);
    last = r;
  }
  return rows;
}

/* ---------- The flow's rules (the same as services/flows.js flowGraph) ---------- */
/** A message's trigger type ('after_previous' for the welcome, and for a wait of 0). */
function wfTrig(E, i) {
  if (i === 0) return 'after_previous';
  const t = (E.steps[i] && E.steps[i].trigger) || {};
  const ty = WF_TRIG[t.type] ? t.type : 'after_previous';
  return ty === 'wait' && !(Number(t.value) > 0) ? 'after_previous' : ty;
}
/** Find a button anywhere in the flow by its id. */
function wfButton(E, id) { for (const s of E.steps) for (const b of s.buttons || []) if (b.id === id) return b; return null; }
function wfOwnerOf(E, id) { return E.steps.findIndex((s) => (s.buttons || []).some((b) => b.id === id)); }
/**
 * For each message: unit (the message(s) above it), group (for answers to buttons: { owner, members }) and awaits
 * (for reminders: { start, buttons }: what they should tap).
 */
function wfGraph(E) {
  const out = [];
  const owners = new Map();
  const startOn = wfStartOn(E);
  let unit = null, group = null, started = false;
  E.steps.forEach((s, i) => {
    const t = wfTrig(E, i);
    const info = { t, unit: unit ? unit.slice() : [] };
    if (t === 'on_start') started = true;
    if (i > 0 && t === 'no_response') {
      const btns = [];
      (unit || []).forEach((k) => (E.steps[k].buttons || []).forEach((b) => btns.push(b.id)));
      info.awaits = { start: startOn && !started, buttons: btns };
      (s.buttons || []).forEach((b) => owners.set(b.id, i));
      out.push(info);
      return;
    }
    if (i > 0 && t === 'on_button') {
      const owner = owners.has(s.trigger.button) ? owners.get(s.trigger.button) : null;
      if (group && group.owner === owner && group.last === i - 1) { group.members.push(i); group.last = i; } else group = { owner, members: [i], last: i };
      info.group = group;
      unit = group.members;
    } else { group = null; unit = [i]; }
    (s.buttons || []).forEach((b) => owners.set(b.id, i));
    out.push(info);
  });
  return out;
}
/** A Chat bot message right below "Check they joined" or "Ask a question": it waits for that, so say so. */
function wfAfterSpecial(E, g) {
  if (!wfIsBot(E) || !g || g.unit.length !== 1) return null;
  const k = wfKind(E.steps[g.unit[0]]);
  return k === 'check_join' ? ['they\'ve joined', 'they join'] : k === 'ask' ? ['they answer', 'they answer'] : null;
}
/** The one plain sentence under each message: when it is sent. */
function wfWhen(E, i) {
  if (i === 0) return wfIsBot(E) ? 'Sends the moment they tap Start' : 'Sends the moment they ask to join';
  const G = wfGraph(E), g = G[i], s = E.steps[i], t = g.t;
  const above = g.unit.length === 1 && g.unit[0] === 0 ? (wfIsBot(E) ? 'the first message' : 'the welcome') : 'the message above';
  if (t === 'on_goal') return 'Sends when they reach their invite goal (' + (wfGoalBefore(E, i) || 3) + ' friends)';
  const sp = wfAfterSpecial(E, g);
  if (sp && t === 'after_previous') return 'Sends once ' + sp[0];
  if (sp && t === 'wait') return 'Sends ' + wfWait(s.trigger.value, s.trigger.unit) + ' after ' + sp[1];
  if (t === 'after_previous') return 'Sends right after ' + above;
  if (t === 'wait') return 'Sends ' + wfWait(s.trigger.value, s.trigger.unit) + ' after ' + above;
  if (t === 'on_start') return 'Sends the moment they tap Start';
  if (t === 'on_button') { const b = wfButton(E, s.trigger.button); return b ? 'Sends when they tap "' + (String(b.label || '').trim() || 'this button') + '"' : 'Pick which button they tap'; }
  const a = g.awaits;
  const what = a.start && a.buttons.length ? 'tapped Start or a button' : a.start ? 'tapped Start' : 'tapped a button';
  return 'Sends if they haven\'t ' + what + ' after ' + wfWait(s.trigger.value, s.trigger.unit);
}
/** Who it reaches (Telegram's 5-minute rule), in plain words. */
function wfReach(E, i) {
  if (wfIsBot(E)) {
    const k = wfKind(E.steps[i]);
    return k === 'check_join' ? 'Then waits for "I\'ve joined" (Castvoo checks they really joined)' : k === 'ask' ? 'Then waits for their answer' : 'Always reaches them: they tapped Start';
  }
  if (i === 0) return 'Reaches everyone who asks to join';
  let t = 0, afterStart = false, blocked = false;
  for (let k = 1; k <= i; k++) {
    const tr = wfTrig(E, k);
    if (tr === 'on_start') afterStart = true;
    if (k === i) {
      if (afterStart) return 'Always reaches them: they tapped Start';
      if (tr === 'no_response') return !blocked && t + wfSecs(E.steps[k].trigger) <= WF_QUICK ? 'Reaches everyone · first 5 minutes' : 'Reaches people who tapped Start';
      if (tr === 'on_button') return 'Reaches people who tapped Start (others only in the first 5 minutes)';
      return !blocked && t + (tr === 'wait' ? wfSecs(E.steps[k].trigger) : 0) <= WF_QUICK ? 'Reaches everyone · first 5 minutes' : 'Reaches people who tapped Start';
    }
    if (tr === 'wait') t += wfSecs(E.steps[k].trigger);
    if (tr === 'on_button') blocked = true;
  }
  return '';
}
function wfReachQuick(E, i) { return /first 5 minutes$/.test(wfReach(E, i)); }
/* Does the flow have later messages inside the first 5 minutes? */
function wfHasQuick(E) { return E.steps.some((_, i) => i > 0 && wfReachQuick(E, i)); }
/* The Telegram-rule note above the messages. */
function wfRuleHtml(E) {
  if (wfIsBot(E)) return '<span>💙</span><p><b>Good to know:</b> everyone who taps <b>Start</b> in your bot can get every message here. They can stop any time with /stop, and Castvoo never messages people who didn\'t start your bot.</p>';
  const quick = wfHasQuick(E);
  const how = !quick ? '' : E.approve_mode === 'tap' ? ' They are let in when they tap Start.'
    : E.approve_mode === 'manual' ? ' If you let someone in before those messages go out, the rest wait until they tap Start.'
      : ' Letting someone in closes that window, so Castvoo lets them in right after your last message in the first 5 minutes (still automatic).';
  return '<span>💙</span><p><b>Good to know:</b> messages in the first 5 minutes reach everyone who asked to join. After that, your bot can message the people who tapped <b>Start</b>.' + how + '</p>';
}
function wfTrigLabel(E, i) {
  const t = wfTrig(E, i), s = E.steps[i];
  const sp = i > 0 ? wfAfterSpecial(E, wfGraph(E)[i]) : null;
  if (sp && t === 'after_previous') return 'Once ' + sp[0];
  if (sp && t === 'wait') return wfWait(s.trigger.value, s.trigger.unit).replace(/^./, (x) => x.toUpperCase()) + ' after ' + sp[1];
  if (t === 'wait') return 'After ' + wfWait(s.trigger.value, s.trigger.unit);
  if (t === 'no_response') return 'If they don\'t respond in ' + wfWait(s.trigger.value, s.trigger.unit);
  return WF_TRIG[t][1];
}

/* ---------- The interactive preview (a tiny copy of the runtime) ---------- */
/**
 * Play the flow for one person. events: [{ start: true } | { tap: buttonId } | { skip: true } | { joined: bool } |
 * { answer: text } | { ref: true }] in order. Returns { log: [{ k: 'sys'|'bot'|'user'|'bot_retry', i?, text? }],
 * sent: [{ i }], waitingFor: 'start'|'button'|'wait'|'joined'|'answer'|'goal'|null, timers: [{ kind, i, secs }],
 * answers: { i: value }, refs }.
 */
function simRun(E, events, name) {
  const G = wfGraph(E), n = E.steps.length;
  const bot = wfIsBot(E);
  const st = { p: 1, started: bot, taps: new Set(), sent: [], log: [], reminders: [], wait: null, skipped: new Set(), answers: {}, refs: 0, hold: null };
  const startOn = wfStartOn(E);
  const kind = (i) => wfKind(E.steps[i]);
  const waits = (i) => kind(i) === 'check_join' || kind(i) === 'ask';
  const send = (i) => { if (st.sent.some((x) => x.i === i)) return; st.sent.push({ i }); st.log.push({ k: 'bot', i, refs: st.refs }); };
  const answered = (r) => { const a = (G[r.i] && G[r.i].awaits) || { start: false, buttons: [] }; return (a.start && !r.armed && st.started) || a.buttons.some((b) => st.taps.has(b)); };
  // A check or a question: sent once, then it waits for them (st.hold).
  const hold = (i) => { send(i); st.hold = i; };
  const pump = () => {
    if (st.hold != null) return;
    for (let guard = 0; guard < 500 && st.p < n; guard++) {
      const i = st.p, t = G[i].t;
      if (t === 'after_previous') { if (waits(i)) { hold(i); return; } send(i); st.p++; continue; }
      if (t === 'wait') { if (st.skipped.has(i)) { if (waits(i)) { hold(i); return; } send(i); st.p++; continue; } st.wait = i; return; }
      if (t === 'no_response') { if (!st.reminders.some((r) => r.i === i)) st.reminders.push({ i, armed: st.started }); st.p++; continue; }
      if (t === 'on_start') { if (st.started) { send(i); st.p++; continue; } return; }
      if (t === 'on_goal') { if (st.refs >= (wfGoalBefore(E, i) || 3)) { send(i); st.p++; continue; } return; }
      if (t === 'on_button') {
        const g = G[i].group;
        const hits = g.members.filter((k) => st.taps.has(E.steps[k].trigger.button));
        if (hits.length) { hits.forEach(send); st.p = Math.max(...g.members) + 1; continue; }
        return;
      }
      st.p++;
    }
  };
  st.log.push({ k: 'sys', text: bot ? '👆 ' + (name || 'Ada') + ' tapped Start in your bot' : '👋 ' + (name || 'Ada') + ' asked to join' });
  if (n) { if (waits(0)) { hold(0); st.p = 0; } else send(0); }
  pump();
  const timers = () => {
    const out = st.reminders.map((r) => ({ kind: 'reminder', i: r.i, secs: wfSecs(E.steps[r.i].trigger), r }));
    if (st.wait != null && st.p === st.wait) out.push({ kind: 'wait', i: st.wait, secs: wfSecs(E.steps[st.wait].trigger) });
    return out.sort((a, b) => a.secs - b.secs);
  };
  const pass = () => { const i = st.hold; st.hold = null; st.p = i + 1; };
  for (const ev of events || []) {
    if (ev.start) {
      if (!startOn || st.started) continue;
      st.started = true; st.log.push({ k: 'user', text: '/start', start: true });
    } else if (ev.joined !== undefined) {
      if (st.hold == null || kind(st.hold) !== 'check_join') continue;
      const c = E.steps[st.hold].check || {};
      st.log.push({ k: 'user', text: String(c.join_label || '').trim() || 'I\'ve joined ✅', label: 'I\'ve joined', join: true });
      if (ev.joined) pass();
      else st.log.push({ k: 'sys', text: '🙈 They haven\'t joined yet, so your bot shows a gentle note: "' + (String(c.nudge || '').trim() || 'Looks like you haven\'t joined yet 🙂 Tap the link above, then tap I\'ve joined.') + '"' });
    } else if (ev.answer !== undefined) {
      if (st.hold == null || kind(st.hold) !== 'ask') continue;
      const a = E.steps[st.hold].ask || {};
      const v = wfValidate(a.answer || 'text', ev.answer, a);
      st.log.push({ k: 'user', text: String(ev.answer), label: String(ev.answer), answer: true });
      if (v.ok) { st.answers[st.hold] = v.value; pass(); } else st.log.push({ k: 'bot_retry', text: v.message });
    } else if (ev.ref) {
      st.refs++;
      st.log.push({ k: 'sys', text: '🧪 A friend joined through their link (' + st.refs + ' of ' + (wfGoalBefore(E, st.p) || wfGoalBefore(E, n) || 3) + ')' });
    } else if (ev.tap) {
      const b = wfButton(E, ev.tap);
      if (!b) continue;
      st.taps.add(ev.tap);
      st.log.push({ k: 'user', text: (b.kind === 'link' ? '🔗 ' : '') + (b.label || 'Button'), link: b.kind === 'link', tap: ev.tap, label: b.label || 'Button' });
      // A choice the person passed already (they tap another button later): its answer comes now.
      E.steps.forEach((s, k) => { const g = G[k].group; if (G[k].t === 'on_button' && s.trigger.button === ev.tap && g && Math.max(...g.members) < st.p) send(k); });
    } else if (ev.skip) {
      const nx = timers()[0];
      if (!nx) continue;
      st.log.push({ k: 'sys', text: '⏩ ' + wfWait(...wfSplit(nx.secs)) + ' later', later: wfWait(...wfSplit(nx.secs)) });
      if (nx.kind === 'wait') { st.skipped.add(nx.i); st.wait = null; } else { st.reminders = st.reminders.filter((r) => r !== nx.r); if (!answered(nx.r)) send(nx.i); }
    }
    st.reminders = st.reminders.filter((r) => !answered(r));
    pump();
  }
  const at = st.hold != null ? null : st.p < n ? G[st.p].t : null;
  const holdKind = st.hold != null ? kind(st.hold) : null;
  const waitingFor = holdKind === 'check_join' ? 'joined' : holdKind === 'ask' ? 'answer' : at === 'on_start' ? 'start' : at === 'on_button' ? 'button' : at === 'wait' ? 'wait' : at === 'on_goal' ? 'goal' : null;
  return { log: st.log, sent: st.sent, p: st.hold != null ? st.hold : st.p, hold: st.hold, waitingFor, answers: st.answers, refs: st.refs, timers: timers().map((x) => ({ kind: x.kind, i: x.i, secs: x.secs })) };
}

/* ---------- Pure render helpers (tested) ---------- */

/** One card in the flow list. */
function flowCardHtml(f) {
  const live = !!f.active;
  const pill = live ? '<span class="pill p-ok"><span class="dl"></span>Live</span>' : f.paused_by_plan ? '<span class="pill p-warn">Paused by plan</span>' : '<span class="pill p-grey">Draft</span>';
  const mode = (WF_MODES.find((m) => m[0] === f.approve_mode) || WF_MODES[0])[1];
  const n = (v) => fmt(v || 0);
  return '<article class="wf-card' + (live ? ' live' : '') + '" data-open="' + Number(f.id) + '">' +
    '<div class="wf-ch"><span class="wf-ci">' + (f.chat_kind === 'group' ? '👥' : '📣') + '</span><div class="wf-ct"><b class="ell">' + esc(f.name) + '</b><small class="ell">' + esc(f.chat_title || 'Channel not connected') + ' · @' + esc(f.bot_username || '') + '</small></div>' + pill + '</div>' +
    '<div class="wf-fun"><span><b class="tnum">' + n(f.requests) + '</b>asked</span><i></i><span><b class="tnum">' + n(f.welcomed) + '</b>welcomed</span><i></i><span><b class="tnum">' + n(f.approved) + '</b>let in</span></div>' +
    '<div class="wf-cf"><span class="wf-chip">' + icon('check') + esc(mode) + '</span><span class="wf-chip">' + icon('send') + plural(f.steps || 1, 'message') + '</span>' + (f.pending ? '<span class="wf-chip warn">' + plural(f.pending, 'person', 'people') + ' waiting</span>' : '') + '<span class="wf-go">Open ' + icon('chev') + '</span></div></article>';
}

/** Telegram-style preview of one message (the list page's example). o: { bot, chat, body, media, buttons, startLabel, branding, first, delay } */
function tgPreviewHtml(o) {
  const rows = wfRows(o.buttons || []);
  const btnRows = (o.startLabel ? [[{ label: o.startLabel, start: true }]] : []).concat(rows.map((r) => r.filter((b) => (b.label || '').trim())).filter((r) => r.length));
  const media = o.media ? (typeof mediaPreview === 'function' ? mediaPreview(o.media) : '') : '';
  const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const brand = o.branding ? '<span class="wf-brand">⚡ <u>Free welcome bot by Castvoo.com</u></span>' : '';
  return '<div class="tg-top"><span class="bk">‹</span><div class="tt"><b>' + esc(o.bot ? '@' + o.bot : 'Your bot') + ' ' + VF + '</b><small>bot</small></div><span class="tg-ava" style="background:var(--grad)"><svg viewBox="0 0 40 40"><use href="#logo"/></svg></span></div>' +
    '<div class="tg-bg wf-tgbg">' +
    (o.first ? '<div class="wf-sys">👋 Ada asked to join ' + esc(o.chat || 'your channel') + '</div>' : (o.delay ? '<div class="wf-sys">⏳ ' + esc(o.delay) + ' later</div>' : '')) +
    '<div class="tm in">' + media + '<span class="px">' + (fmtMsg(o.body || '', { name: 'Ada' }) || '<span style="color:#9AA3B2">Your message appears here</span>') + '</span>' + (brand ? '<span class="px">' + brand + '</span>' : '') + '<span class="ti">' + time + '</span></div>' +
    (btnRows.length ? '<div class="wf-kb">' + btnRows.map((r) => '<div class="wf-kr">' + r.map((b) => '<span' + (b.start ? ' class="st"' : '') + '>' + esc(b.label) + (b.start || b.kind === 'reply' ? '' : ' ↗') + '</span>').join('') + '</div>').join('') + '</div>' : '') +
    '</div><div class="tg-in"><span class="pc0">📎</span><span class="fld">Message</span><span class="sb">➤</span></div>';
}

/** Keyboard rows for a message: the welcome's Tap Start first, Reply buttons two side by side, Link buttons one a row. */
function wfKeyRows(E, i) {
  const s = E.steps[i];
  const rows = [];
  const k = wfKind(s);
  // Special steps have their own buttons (services/bots.js deliveryParts).
  if (k === 'check_join') { const c = s.check || {}; return [[{ label: String(c.open_label || '').trim() || '📣 Open the channel', kind: 'link', fixed: 'open' }], [{ label: String(c.join_label || '').trim() || 'I\'ve joined ✅', join: true }]]; }
  if (k === 'ask') {
    const a = s.ask || {};
    if (a.answer === 'choice') return (a.choices || []).filter((c) => String(c).trim()).map((c) => [{ label: String(c), ans: String(c) }]);
    if (a.answer === 'phone') return [[{ label: String(a.button || '').trim() || '📱 Share my phone number', ans: WF_SAMPLE.phone, contact: true }]];
    return [];
  }
  if (k === 'referral') return [[{ label: '📤 Share my link', kind: 'link', fixed: 'share' }], [{ label: '📊 My progress', fixed: 'progress' }]];
  if (i === 0 && wfStartOn(E)) rows.push([{ start: true, label: wfStartLabel(E) }]);
  let cur = null;
  (s.buttons || []).filter((b) => String(b.label || '').trim()).forEach((b) => {
    if (b.kind === 'reply' && cur && cur.length === 1 && cur[0].kind === 'reply') { cur.push(b); return; }
    cur = [b]; rows.push(cur);
  });
  return rows;
}

/** The phone's top bar (the bot's name). */
function wfTgTop(o) { return '<div class="tg-top"><span class="bk">‹</span><div class="tt"><b>' + esc(o.bot ? '@' + o.bot : 'Your bot') + ' ' + VF + '</b><small>bot</small></div><span class="tg-ava" style="background:var(--grad)"><svg viewBox="0 0 40 40"><use href="#logo"/></svg></span></div>'; }
/**
 * The chat for a simRun() log. o: { branding, name, upto (log items shown), typing, auto (their taps as small "You tapped …" bubbles),
 * target (message index: highlighted, with o.arrive above it), pulse: { start, ids: [button ids] } (the "Tap to continue" pulse) }
 */
function wfChatHtml(E, sim, o = {}) {
  const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const log = o.upto == null ? sim.log : sim.log.slice(0, o.upto);
  const lastBot = (() => { for (let n = log.length - 1; n >= 0; n--) if (log[n].k === 'bot') return n; return -1; })();
  const pulse = o.pulse || {};
  // The pulse goes on the newest bubble that has the button.
  const pulseAt = (() => {
    if (!pulse.start && !pulse.join && !pulse.ans && !(pulse.ids || []).length) return -1;
    for (let n = log.length - 1; n >= 0; n--) {
      const x = log[n]; if (x.k !== 'bot') continue;
      if (pulse.start && x.i === 0) return n;
      if (pulse.join && wfKind(E.steps[x.i]) === 'check_join') return n;
      if (pulse.ans && wfKind(E.steps[x.i]) === 'ask') return n;
      if ((E.steps[x.i].buttons || []).some((b) => (pulse.ids || []).includes(b.id))) return n;
    }
    return -1;
  })();
  const body = log.map((x, n) => {
    if (x.k === 'sys') return x.later ? '<div class="fb-later"><span>… ' + esc(x.later) + ' later …</span></div>' : '<div class="wf-sys">' + esc(x.text) + '</div>';
    if (x.k === 'bot_retry') return '<div class="tm in fb-retry"><span class="px">' + esc(x.text) + '</span><span class="ti">' + time + '</span></div>';
    if (x.k === 'user') return o.auto ? '<div class="wf-sys fb-auto">' + esc(x.start ? 'You tapped Start ✓' : x.answer ? 'They answered "' + (x.label || '') + '" ✓' : 'You tapped ' + (x.label || 'a button') + ' ✓') + '</div>' : '<div class="tm out fb-me">' + esc(x.text) + '<span class="ti">' + time + ' ✓✓</span></div>';
    const s = E.steps[x.i];
    if (!s) return '';
    const media = s.media && typeof mediaPreview === 'function' ? mediaPreview(s.media) : '';
    const brand = x.i === 0 && o.branding ? '<span class="px"><span class="wf-brand">⚡ <u>' + (wfIsBot(E) ? 'Free bot by Castvoo.com' : 'Free welcome bot by Castvoo.com') + '</u></span></span>' : '';
    const kb = wfKeyRows(E, x.i);
    const bodyText = wfKind(s) === 'referral' ? wfFillInvite(s.body, 't.me/' + (o.bot || 'yourbot') + '?start=r_' + String(o.name || 'Ada').toLowerCase().replace(/[^a-z0-9]/g, ''), x.refs || 0, Number((s.referral || {}).goal) || 3) : s.body;
    const isT = o.target === x.i;
    const pl = n === pulseAt;
    return (isT && o.arrive ? '<div class="fb-arrive" data-pvtarget><span>' + esc(o.arrive) + '</span></div>' : '') +
      '<div class="tm in' + (n === lastBot && (o.upto != null || n === log.length - 1) ? ' fb-new' : '') + (isT ? ' fb-target' : '') + '">' + media + '<span class="px">' + (fmtMsg(bodyText || '', { name: o.name || 'Ada' }) || '<span style="color:#9AA3B2">Your message appears here</span>') + '</span>' + brand + '<span class="ti">' + time + '</span></div>' +
      (kb.length ? '<div class="wf-kb fb-kb' + (pl ? ' fb-kbp' : '') + (kb[0][0].contact ? ' fb-rkb' : '') + '">' + kb.map((r) => '<div class="wf-kr">' + r.map((b) => {
        const on = pl && (b.start ? pulse.start : b.join ? pulse.join : b.ans != null ? pulse.ans : (pulse.ids || []).includes(b.id));
        if (b.start) return '<button type="button" class="st' + (on ? ' fb-pulse' : '') + '" data-sims>' + esc(b.label) + '</button>';
        if (b.join) return '<button type="button" class="' + (on ? 'fb-pulse' : '') + '" data-simjoin="1">' + esc(b.label) + '</button>';
        if (b.ans != null) return '<button type="button" class="' + (on ? 'fb-pulse' : '') + '" data-simans="' + esc(b.ans) + '">' + esc(b.label) + '</button>';
        if (b.fixed) return '<button type="button" class="' + (b.kind === 'link' ? 'lk' : '') + '" data-simfix="' + esc(b.fixed) + '">' + esc(b.label) + (b.kind === 'link' ? ' ↗' : '') + '</button>';
        return '<button type="button" class="' + (b.kind === 'link' ? 'lk' : '') + (on ? ' fb-pulse' : '') + '" data-simt="' + esc(b.id) + '">' + esc(b.label) + (b.kind === 'link' ? ' ↗' : '') + '</button>';
      }).join('') + '</div>').join('') + (pl ? '<span class="fb-tapc">👆 Tap to continue</span>' : '') + '</div>' : '');
  }).join('');
  return body + (o.typing ? '<div class="tm in fb-typing"><span class="tg-typing in"><i></i><i></i><i></i></span></div>' : '');
}

/** The phone's chat for a simRun() result (the "Try it" phone). o: { bot, chat, branding, name } */
function simHtml(E, sim, o = {}) {
  const nx = sim.timers[0];
  const hint = sim.waitingFor === 'start' ? '👆 Tap <b>' + esc(wfStartLabel(E)) + '</b> like they would' : sim.waitingFor === 'button' && !nx ? '🔘 Tap a button like they would'
    : sim.waitingFor === 'joined' ? '✅ Did they join? <span class="fb-two"><button type="button" class="chb" data-simjoin="1">They joined</button><button type="button" class="chb" data-simjoin="0">Not yet</button></span>'
      : sim.waitingFor === 'goal' ? '🏆 Waiting for friends to join <button type="button" class="chb" data-simref>🧪 Pretend a friend joined</button>' : '';
  const ask = sim.waitingFor === 'answer' ? (E.steps[sim.hold] || {}).ask || {} : null;
  const answerBar = ask ? '<div class="fb-ansbar"><input class="inp" data-simanswer inputmode="' + (ask.answer === 'number' ? 'decimal' : ask.answer === 'email' ? 'email' : ask.answer === 'phone' ? 'tel' : 'text') + '" maxlength="200" placeholder="Type their answer, like ' + esc(ask.answer === 'choice' ? ((ask.choices || [])[0] || 'a choice') : WF_SAMPLE[ask.answer || 'text']) + '" aria-label="Their answer"><button type="button" class="sb" data-simsend aria-label="Send">➤</button></div>' : '';
  return wfTgTop(o) +
    '<div class="tg-bg wf-tgbg fb-chat" data-simscroll>' + wfChatHtml(E, sim, o) + (hint ? '<div class="fb-nudge">' + hint + '</div>' : '') + '</div>' + answerBar +
    '<div class="fb-simbar">' + (nx ? '<button type="button" class="fb-skip" data-simskip>⏩ Skip ' + esc(wfWait(...wfSplit(nx.secs))) + (nx.kind === 'reminder' ? ' <small>(no reply)</small>' : '') + '</button>' : '<span class="fb-simst">' + (sim.waitingFor ? 'Waiting for them' : sim.sent.length >= E.steps.length ? '✅ That\'s the whole flow' : 'Nothing more for them here') + '</span>') +
    '<button type="button" class="fb-reset" data-simreset aria-label="Start over" title="Start over">' + icon('refresh') + '</button></div>';
}

/* ---------- Preview one step, play the whole flow (pure) ---------- */
/** One gentle line: when message i arrives. */
function wfArrive(E, i) {
  if (i === 0) return wfIsBot(E) ? 'Arrives the moment they tap Start' : 'Arrives the moment they ask to join';
  const g = wfGraph(E)[i], s = E.steps[i], t = g.t;
  if (t === 'on_goal') return 'Arrives when they reach their invite goal';
  const welcomeAbove = g.unit.length === 1 && g.unit[0] === 0;
  const first = wfIsBot(E) ? 'the first message' : 'the welcome';
  const sp = wfAfterSpecial(E, g);
  if (sp && t === 'after_previous') return 'Arrives once ' + sp[0];
  if (sp && t === 'wait') return 'Arrives ' + wfWait(s.trigger.value, s.trigger.unit) + ' after ' + sp[1];
  if (t === 'after_previous') return 'Arrives right after ' + (welcomeAbove ? first : 'the message above');
  if (t === 'wait') return 'Arrives ' + wfWait(s.trigger.value, s.trigger.unit) + ' after ' + (welcomeAbove ? first : 'the last message');
  if (t === 'on_start') return 'Arrives the moment they tap Start';
  if (t === 'on_button') { const b = wfButton(E, s.trigger.button); return b ? 'Arrives when they tap \'' + (String(b.label || '').trim() || 'this button') + '\'' : 'Arrives when they tap a button (pick which one)'; }
  const a = g.awaits;
  const what = a.start && a.buttons.length ? 'tapped Start or a button' : a.start ? 'tapped Start' : 'tapped a button';
  return 'Arrives if they haven\'t ' + what + ' after ' + wfWait(s.trigger.value, s.trigger.unit);
}
/**
 * The taps (and skipped waits) it takes for message `target` to arrive, played on simRun(): Start when the flow waits
 * for it, the button of a choice that leads to the target (any button for a choice above it), ⏩ for waits, and for a
 * reminder: no tap at all, time passes. Returns { ok, events } (ok false = as things are, it can never arrive).
 */
function wfPathTo(E, target) {
  const n = E.steps.length;
  if (!(target > 0 && target < n)) return { ok: target === 0 && n > 0, events: [] };
  const G = wfGraph(E);
  const events = [];
  const isRem = G[target].t === 'no_response';
  if (isRem && !G[target].awaits.start && !G[target].awaits.buttons.length) return { ok: false, events };
  for (let guard = 0; guard < 100; guard++) {
    const sim = simRun(E, events);
    if (sim.sent.some((x) => x.i === target)) return { ok: true, events };
    if (isRem) {
      if (sim.timers.some((x) => x.kind === 'reminder' && x.i === target)) { events.push({ skip: true }); continue; }
      if (sim.p > target) return { ok: false, events };
    }
    if (sim.waitingFor === 'joined') { events.push({ joined: true }); continue; }
    if (sim.waitingFor === 'answer') { events.push({ answer: wfSampleFor(E.steps[sim.hold]) }); continue; }
    if (sim.waitingFor === 'goal') { events.push({ ref: true }); continue; }
    if (sim.p >= n) return { ok: false, events };
    const t = G[sim.p].t;
    if (t === 'wait') { events.push({ skip: true }); continue; }
    if (t === 'on_start') { if (!wfStartOn(E)) return { ok: false, events }; events.push({ start: true }); continue; }
    if (t === 'on_button') {
      const g = G[sim.p].group;
      const ids = (k) => (E.steps[k].trigger || {}).button;
      const pick = g.members.includes(target) ? target : g.members.find((k) => wfButton(E, ids(k)));
      const id = pick != null ? ids(pick) : null;
      const o = id ? wfOwnerOf(E, id) : -1;
      if (!id || o < 0 || o >= pick || !sim.sent.some((x) => x.i === o)) return { ok: false, events };
      events.push({ tap: id });
      continue;
    }
    return { ok: false, events };
  }
  return { ok: false, events };
}
/** A good example answer to a question (the preview types it for you). */
function wfSampleFor(s) { const a = (s && s.ask) || {}; return a.answer === 'choice' ? String((a.choices || [])[0] || 'Yes') : WF_SAMPLE[a.answer || 'text'] || WF_SAMPLE.text; }
/** The phone jumped to message i, as the customer sees it (the taps on the way as small bubbles). o: { bot, branding, name } */
function wfStepPreviewHtml(E, i, o = {}) {
  const path = wfPathTo(E, i);
  const sim = simRun(E, path.events, o.name);
  const chat = path.ok ? wfChatHtml(E, sim, { ...o, auto: true, target: i, arrive: wfArrive(E, i) })
    : wfChatHtml(E, sim, { ...o, auto: true }) + '<div class="fb-arrive soft"><span>🌱 As things are, message ' + (i + 1) + ' can\'t arrive yet. The tip on its card says why.</span></div>';
  return wfTgTop(o) + '<div class="tg-bg wf-tgbg fb-chat" data-simscroll>' + chat + '</div>' +
    '<div class="fb-simbar"><span class="fb-simst">Tap a button to carry on from here</span>' +
    '<button type="button" class="fb-reset" data-simreset aria-label="Try it yourself" title="Try it yourself">' + icon('refresh') + '</button></div>';
}

/**
 * The whole-flow movie: what happens next. v: { events, choices: { start: true, <owner index>: buttonId } (taps made
 * for you, e.g. "Watch the other path") }. Returns { pause: 'start'|'button'|null, choices: [button ids to pick from],
 * auto: the next event to play by itself (a skipped wait), done, other: [{ owner, id, label }] (paths not watched), reminder }.
 */
function wfPlayNext(E, v) {
  const sim = simRun(E, v.events || []);
  const G = wfGraph(E);
  const pre = v.choices || {};
  const out = { pause: null, choices: [], auto: null, done: false, other: [], reminder: sim.timers.some((x) => x.kind === 'reminder'), sim };
  if (sim.waitingFor === 'joined') { if (pre.joined) out.auto = { joined: true }; else out.pause = 'joined'; return out; }
  if (sim.waitingFor === 'answer') { const want = pre['a' + sim.hold]; out.sample = wfSampleFor(E.steps[sim.hold]); if (want) out.auto = { answer: want }; else out.pause = 'answer'; return out; }
  if (sim.waitingFor === 'goal') { out.auto = { ref: true }; return out; }
  if (sim.waitingFor === 'wait') { out.auto = { skip: true }; return out; }
  if (sim.waitingFor === 'start') { if (pre.start) out.auto = { start: true }; else out.pause = 'start'; return out; }
  if (sim.waitingFor === 'button') {
    const g = G[sim.p].group;
    out.choices = g.members.map((k) => (E.steps[k].trigger || {}).button).filter((id) => id && wfButton(E, id));
    const want = pre[String(g.owner)];
    if (want && out.choices.includes(want)) out.auto = { tap: want }; else out.pause = 'button';
    return out;
  }
  if (sim.timers.length) { out.auto = { skip: true }; return out; }
  out.done = true;
  const taps = new Set((v.events || []).filter((x) => x.tap).map((x) => x.tap));
  const seen = new Set();
  G.forEach((g, k) => {
    if (g.t !== 'on_button' || !g.group || g.group.owner == null || !sim.sent.some((x) => x.i === g.group.owner)) return;
    const id = (E.steps[k].trigger || {}).button; const b = wfButton(E, id);
    if (!b || taps.has(id) || seen.has(id)) return;
    seen.add(id);
    out.other.push({ owner: g.group.owner, id, label: String(b.label || '').trim() || 'the other button' });
  });
  return out;
}
/** The movie's phone. v: { events, shown (log items shown so far), typing, pause, choices, paused, done, other, reminder }. o: { bot, branding, name } */
function wfPlayHtml(E, v, o = {}) {
  const sim = simRun(E, v.events || [], o.name);
  const upto = Math.min(v.shown == null ? sim.log.length : v.shown, sim.log.length);
  const shownMsgs = sim.log.slice(0, upto).filter((x) => x.k === 'bot').length;
  const total = E.steps.length;
  const atEnd = upto >= sim.log.length && !v.typing;
  const nx = atEnd ? wfPlayNext(E, v) : {};
  const paused = atEnd ? (nx.pause || null) : null;
  const pulse = paused === 'start' ? { start: true } : paused === 'button' ? { ids: nx.choices || [] } : paused === 'joined' ? { join: true } : paused === 'answer' ? { ans: true } : null;
  const done = atEnd && nx.done;
  const prog = '<div class="fb-prog"><span>' + (done ? '✨ That\'s the whole ' + (wfIsBot(E) ? 'bot' : 'flow') + ' · ' + shownMsgs + ' of ' + total + ' messages on this path' : 'Message ' + Math.max(1, shownMsgs) + ' of ' + total) + '</span><i style="--w:' + (Math.min(1, shownMsgs / Math.max(1, total)) * 100).toFixed(1) + '%"></i></div>';
  let bar;
  if (done) {
    bar = '<div class="fb-playend"><div class="fb-pend1"><button type="button" class="fb-pbtn pri" data-playre>' + icon('refresh') + 'Replay</button><button type="button" class="fb-reset" data-playx aria-label="Close the preview" title="Close"><svg><use href="#i-x"/></svg></button></div>' +
      (nx.other || []).slice(0, 3).map((x) => '<button type="button" class="fb-pbtn" data-playother="' + Number(x.owner) + ':' + esc(x.id) + '">↪ Watch the other path: <b>' + esc(x.label) + '</b></button>').join('') + '</div>';
  } else {
    const special = paused === 'joined' ? '<button type="button" class="fb-pbtn" data-playjoin="0">🙈 Not yet</button>'
      : paused === 'answer' ? '<span class="fb-ansbar in"><input class="inp" data-playanswer maxlength="200" placeholder="' + esc(nx.sample || '') + '" aria-label="Their answer"><button type="button" class="sb" data-playsend aria-label="Send">➤</button></span><button type="button" class="fb-pbtn" data-playsample="' + esc(nx.sample || '') + '">Use "' + esc(nx.sample || '') + '"</button>' : '';
    bar = '<div class="fb-playbar' + (paused ? ' your' + (nx.reminder || special ? ' two' : '') : '') + '">' + (paused ? '<span class="fb-simst">' + (paused === 'start' ? '👆 Your turn: tap the glowing Start button' : paused === 'joined' ? '👆 Your turn: tap "I\'ve joined", or' : paused === 'answer' ? '✍️ Your turn: answer like they would' : '👆 Your turn: pick a glowing button') + '</span>' + special + (nx.reminder ? '<button type="button" class="fb-pbtn" data-playnotap>💤 Don\'t tap: see the reminder</button>' : '')
      : '<button type="button" class="fb-pbtn" data-playpause aria-label="' + (v.paused ? 'Play' : 'Pause') + '">' + (v.paused ? '▶ Play' : '⏸ Pause') + '</button><span class="fb-simst">Playing…</span>') +
      '<button type="button" class="fb-reset" data-playx aria-label="Close the preview" title="Close">' + '<svg><use href="#i-x"/></svg>' + '</button></div>';
  }
  return wfTgTop(o) + prog + '<div class="tg-bg wf-tgbg fb-chat" data-simscroll>' + wfChatHtml(E, sim, { ...o, auto: true, upto, typing: v.typing, pulse }) + '</div>' + bar;
}

/* ---------- Gentle checks (shown on the cards, never in the way) ---------- */
/**
 * Small things to check, kindly worded. Returns [{ i, kind, text, block }]: block 'save' (it can't be saved like this),
 * 'live' (fine as a draft, fix it before switching on) or null (just a tip).
 * kinds: empty, placeholder, nolink, notext, unreachable, longwait, toolong, waitnum, total
 */
function wfTips(E, o = {}) {
  const out = [];
  const G = wfGraph(E);
  const add = (i, kind, text, block) => out.push({ i, kind, text, block: block || null });
  let total = 0;
  // "below" for a button that is above (or the other way round): a tip with [Fix it] (cas-engine.js, shared with Cas Builder).
  let dir = [];
  try { dir = typeof CasEngine !== 'undefined' ? CasEngine.directionIssues(wfDraftOf(E)) : []; } catch (_) { dir = []; }
  E.steps.forEach((s, i) => {
    const t = wfTrig(E, i);
    for (const x of dir) if (x.i === i) out.push({ i, kind: 'direction', text: x.text, block: null, fix: true });
    const versions = [s].concat(s.variants || []);
    versions.forEach((m, k) => {
      const vn = (s.variants || []).length ? ' (version ' + String.fromCharCode(65 + k) + ')' : '';
      if (!(m.body || '').trim() && !m.media) add(i, 'empty', 'This message is empty' + vn + '. Write a few friendly words so it doesn\'t arrive blank.', 'save');
      const ph = wfPlaceholder(m.body);
      if (ph) add(i, 'placeholder', 'Swap the example text "' + ph.slice(0, 60) + '"' + vn + ' for your own words before you switch it on.', 'live');
      const lim = (m.media ? 1024 : 4096) - (o.branding ? 34 : 0);
      if (typeof visibleLength === 'function' && visibleLength(wfLenText(E, i, m.body || '')) > lim) add(i, 'toolong', 'This one is a little long for Telegram' + vn + (wfKind(s) === 'referral' ? ' once their invite link is added' : '') + '. Trim it to ' + fmt(lim) + ' characters' + (wfKind(s) === 'referral' ? ' (the link counts too)' : '') + '.', 'save');
      if (wfIsBot(E) && (m.buttons || []).filter((b) => b.kind !== 'reply' && (String(b.label || '').trim() || String(b.url || '').trim())).length > WF_MAX_LINKS) add(i, 'links', 'Up to 6 link buttons fit on one message' + vn + '. Switch the others to 💬 Reply, so people tap them and your bot answers.', 'save');
      for (const b of m.buttons || []) {
        const l = String(b.label || '').trim();
        if (!l && !(b.url || '').trim()) continue;
        if (!l) { add(i, 'notext', 'A button' + vn + ' needs a little text, like "👉 Open".', 'save'); continue; }
        if (b.kind !== 'reply') { const u = typeof fixUrl === 'function' ? fixUrl(b.url) : b.url; if (!u || !/^https?:\/\/[^\s.]+\.[^\s]+/.test(u)) add(i, 'nolink', '"' + l + '" needs a link' + vn + '. Paste the page it should open, like https://your-shop.com', 'save'); }
      }
    });
    const kind = wfKind(s);
    if (kind === 'check_join') {
      const c = s.check || {};
      if (!c.chat_id) add(i, 'nochat', 'Pick the channel or group they should join (just below the message).', 'save');
      else if (o.joinAdmin && o.joinAdmin[String(c.chat_id)] && o.joinAdmin[String(c.chat_id)].ok === false) add(i, 'notadmin', o.joinAdmin[String(c.chat_id)].message || 'Make your bot an admin of that channel so it can check who joined.', 'live');
    }
    if (kind === 'ask') {
      const a = s.ask || {};
      const ch = (a.choices || []).filter((x) => String(x).trim());
      if (a.answer === 'choice' && ch.length < 2) add(i, 'choices', 'Add at least 2 choices for them to tap.', 'save');
    }
    if (kind !== 'message' && WF_KIND_TYPE[kind] && !wfBotHas(WF_KIND_TYPE[kind])) add(i, 'locked', '"' + WF_KINDS[kind][1] + '" is on a bigger plan. You can keep building and see it in the preview.');
    if (kind === 'referral' && !E.steps.some((x, k) => k > i && wfTrig(E, k) === 'on_goal')) add(i, 'noreward', 'Add the reward next: a message that comes "🏆 When they reach their invite goal".');
    if (i === 0) return;
    if (t === 'on_goal' && !wfGoalBefore(E, i)) { add(i, 'unreachable', 'This reward waits for an invite goal, but there\'s no "Invite friends" step above it yet.', 'save'); return; }
    if (t === 'wait' || t === 'no_response') {
      const v = Number((s.trigger || {}).value);
      if (!Number.isInteger(v) || v < 1 || v > 999) add(i, 'waitnum', 'Pick a wait from 1 to 999 ' + (WF_UNIT[(s.trigger || {}).unit] || WF_UNIT.min)[1] + '.', 'save');
      else {
        const secs = wfSecs(s.trigger);
        if (t === 'wait') total += secs;
        if (secs > 30 * 86400) add(i, 'longwait', 'That\'s a long wait (' + wfWait(s.trigger.value, s.trigger.unit) + '). People may forget you by then; a few days usually works better.');
      }
    }
    if (t === 'on_start' && !wfStartOn(E)) { add(i, 'unreachable', 'This one waits for Start, but the welcome has no Tap Start button yet. Add one and it can arrive.', 'save'); return; }
    if (t === 'on_button') { const ow = wfOwnerOf(E, (s.trigger || {}).button); if (ow < 0 || ow >= i) { add(i, 'unreachable', 'This one waits for a button that isn\'t above it any more. Pick one of the buttons above.', 'save'); return; } }
    if (t === 'no_response' && !G[i].awaits.start && !G[i].awaits.buttons.length) { add(i, 'unreachable', 'This reminder waits for a tap, but there\'s nothing to tap above it yet. Add a button so it can arrive.', 'save'); return; }
    if (!wfPathTo(E, i).ok) add(i, 'unreachable', 'As things are, this message can\'t arrive. Check what it waits for in "When should the next message come?".');
  });
  if (total > 365 * 86400) add(E.steps.length - 1, 'total', 'All the waits add up to more than a year. Keep them under 365 days in total.', 'save');
  return out;
}
/** The builder's flow in Cas's format (cas-engine.js), for the "below / above" check. */
function wfDraftOf(E) {
  return {
    approve_mode: E.approve_mode, start_button: wfStartOn(E), start_label: wfStartLabel(E),
    steps: E.steps.map((s, i) => ({
      body: s.body || '',
      // A special step's own buttons count too ("Tap the link below" on a check step points the right way).
      buttons: wfKind(s) !== 'message' ? wfKeyRows(E, i).flat().map((b, k) => ({ id: 'zz' + i + 'x' + k, label: b.label, kind: b.kind === 'link' ? 'link' : 'reply', url: b.kind === 'link' ? 'https://t.me/x' : '' }))
        : (s.buttons || []).filter((b) => String(b.label || '').trim()).map((b) => ({ id: String(b.id), label: b.label, kind: b.kind === 'reply' ? 'reply' : 'link', url: b.url || '' })),
      trigger: i === 0 || !s.trigger ? null : { type: s.trigger.type === 'on_goal' ? 'after_previous' : s.trigger.type, seconds: s.trigger.type === 'wait' || s.trigger.type === 'no_response' ? Math.max(1, wfSecs(s.trigger)) : 0, button: s.trigger.button },
    })),
  };
}
function wfTipsSummary(tips) { return !tips.length ? 'Everything looks good ✨' : tips.length + ' small thing' + (tips.length === 1 ? '' : 's') + ' to check'; }

/** "When should the next message come?" chip, and its 5 big options when open. */
function wfConnHtml(E, i, o) {
  const t = wfTrig(E, i), T = WF_TRIG[t];
  const open = o.open === i;
  const has = o.has || (() => true);
  const ev = has('welcome_flows') || wfIsBot(E);
  const order = wfKind(E.steps[i]) !== 'message' ? ['after_previous', 'wait'] : wfTrigOrder(E, i);
  let extra = '';
  if (open && (t === 'wait' || t === 'no_response')) {
    const tr = E.steps[i].trigger || {};
    extra = '<div class="fb-wait"><span>' + (t === 'wait' ? 'Wait' : 'If they haven\'t tapped after') + '</span><input class="wf-num" type="number" min="1" max="999" inputmode="numeric" value="' + (Number(tr.value) || 1) + '" data-tv="' + i + '" aria-label="How long"><select class="wf-unit" data-tu="' + i + '" aria-label="Unit">' + wfUnitOptions(tr.value, tr.unit || 'min') + '</select></div>';
  }
  if (open && t === 'on_button') extra = wfWhichHtml(E, i);
  return '<div class="fb-conn' + (open ? ' open' : '') + '"><span class="fb-cl" aria-hidden="true"></span>' +
    '<button type="button" class="fb-chip k-' + t + '" data-conn="' + i + '" aria-expanded="' + open + '"' + (o.editable ? '' : ' disabled') + '><span class="fb-ci">' + T[0] + '</span><span class="fb-cq"><small>When should the next message come?</small><b>' + esc(wfTrigLabel(E, i)) + '</b></span>' + (o.editable ? '<span class="fb-cc">' + (open ? 'Done' : 'Change') + '</span>' : '') + '</button>' +
    (open ? '<div class="fb-pick">' + order.map((k) => { const sp = k === 'after_previous' || k === 'wait' ? wfAfterSpecial(E, wfGraph(E)[i]) : null; const lb = sp ? (k === 'after_previous' ? ['Once ' + sp[0], 'Right after ' + sp[1]] : ['After a wait', 'Some time after ' + sp[1]]) : [WF_TRIG[k][1], WF_TRIG[k][2]]; return '<button type="button" class="fb-tile' + (k === t ? ' on' : '') + '" data-tt="' + i + ':' + k + '"><span class="fb-ti">' + WF_TRIG[k][0] + '</span><b>' + esc(lb[0]) + '</b><small>' + esc(lb[1]) + '</small>' + (k !== 'after_previous' && k !== 'wait' && !ev ? wfLock('welcome_flows') : '') + '</button>'; }).join('') + '</div>' + extra : '') +
    '<span class="fb-cl" aria-hidden="true"></span></div>';
}
/** "Which button?": the buttons of the message above (the choice's message). */
function wfWhichHtml(E, i) {
  const G = wfGraph(E);
  const g = G[i].group;
  const owner = g && g.owner != null ? g.owner : wfAnchorMsg(E, i);
  const btns = owner >= 0 ? (E.steps[owner].buttons || []) : [];
  const cur = (E.steps[i].trigger || {}).button;
  return '<div class="fb-which"><span>Which button?</span><div class="fb-wb">' + (btns.length ? btns.map((b) => '<button type="button" class="chb' + (b.id === cur ? ' on' : '') + '" data-tbp="' + i + ':' + esc(b.id) + '">' + (b.kind === 'link' ? '🔗 ' : '💬 ') + esc(String(b.label || '').trim() || 'Untitled button') + '</button>').join('') : '<span class="muted">No buttons above yet. Add one and it shows here.</span>') +
    (owner >= 0 ? '<button type="button" class="chb add" data-addreply="' + owner + ':' + i + '">' + icon('plus') + 'Add a Reply button</button>' : '') + '</div></div>';
}
/** The message whose buttons a new answer would use: the closest message above that is not a reminder. */
function wfAnchorMsg(E, i) {
  const G = wfGraph(E);
  for (let k = i - 1; k >= 0; k--) { if (G[k].t === 'no_response') continue; if (G[k].group && G[i] && G[i].group === G[k].group) continue; return k; }
  return 0;
}

/* ---------- The special steps' settings (Check they joined, Ask a question, Invite friends) ---------- */
const WF_BOT_LOCK = { join_check: 'Free', lead_magnet: 'Free', menu: 'Free', broadcast: 'Starter', lead_questions: 'Starter', referral: 'Growth' };
function wfBotLock(type) { return '<span class="wf-lock" data-up="bot_' + esc(type) + '">' + icon('lock') + esc(WF_BOT_LOCK[type] || 'Upgrade') + '</span>'; }
/** "Remind them if they don't tap / answer in …" (a check or a question). */
function wfRemindHtml(i, r, text, what, dis) {
  const on = !!(r && Number(r.value) > 0);
  return '<div class="fb-rem"><label class="chkl"><input type="checkbox" data-rem="' + i + '"' + (on ? ' checked' : '') + dis + '> Remind them if they don\'t ' + what + '</label>' +
    (on ? '<div class="fb-remr"><span>after</span><input class="wf-num" type="number" min="1" max="999" inputmode="numeric" data-remv="' + i + '" value="' + (Number(r.value) || 10) + '" aria-label="How long"' + dis + '><select class="wf-unit" data-remu="' + i + '" aria-label="Unit"' + dis + '>' + wfUnitOptions(r.value, r.unit || 'min') + '</select></div>' +
      '<textarea class="inp" rows="2" maxlength="1000" data-remt="' + i + '" placeholder="Just a gentle reminder 🙂 (leave empty for our friendly default)" aria-label="Reminder text"' + dis + '>' + esc(text || '') + '</textarea>' : '') + '</div>';
}
/** The settings under a special step's message. o: { chats, joinAdmin, editable } */
function wfSpecialHtml(E, i, o) {
  const s = E.steps[i], k = wfKind(s);
  const dis = o.editable ? '' : ' disabled';
  if (k === 'check_join') {
    const c = s.check || (s.check = {});
    const chats = o.chats || [];
    const adm = c.chat_id && o.joinAdmin ? o.joinAdmin[String(c.chat_id)] : null;
    return '<div class="fb-spec">' +
      '<label class="field"><span>The channel or group they should join</span><select class="inp" data-ckchat="' + i + '"' + dis + '><option value="">' + (chats.length ? 'Pick one' : 'Connect a channel first') + '</option>' + chats.map((ch) => '<option value="' + Number(ch.id) + '"' + (String(ch.id) === String(c.chat_id) ? ' selected' : '') + '>' + esc(ch.title || ch.username || 'Untitled') + '</option>').join('') + '</select></label>' +
      (!chats.length ? '<button type="button" class="btn b-ghost sm" data-connect="channel">' + icon('plus') + 'Connect a channel</button>' : '') +
      (adm ? (adm.ok ? '<div class="wf-adm ok">' + icon('check') + '<span>Your bot is an admin there and can check who joined.</span></div>' : '<div class="wf-adm bad"><span>⚠️</span><div><b>One more step</b><p>' + esc(adm.message || '') + '</p><button type="button" class="btn b-ghost xs" data-ckrecheck="' + i + '">' + icon('refresh') + 'Check again</button></div></div>') : '') +
      '<div class="fb-two2"><label class="field"><span>Link button</span><input class="inp" data-ckopen="' + i + '" maxlength="40" value="' + esc(c.open_label || '') + '" placeholder="📣 Open the channel"' + dis + '></label>' +
      '<label class="field"><span>"I\'ve joined" button</span><input class="inp" data-ckjoin="' + i + '" maxlength="40" value="' + esc(c.join_label || '') + '" placeholder="I\'ve joined ✅"' + dis + '></label></div>' +
      wfRemindHtml(i, c.remind, c.remind_text, 'tap "I\'ve joined"', dis) +
      '<details class="wf-more"><summary>If they tap before joining</summary><input class="inp" data-cknudge="' + i + '" maxlength="180" value="' + esc(c.nudge || '') + '" placeholder="Looks like you haven\'t joined yet 🙂 Tap the link above, then tap I\'ve joined."' + dis + '><small class="fb-bh">A small popup. Nothing is sent to the chat.</small></details></div>';
  }
  if (k === 'ask') {
    const a = s.ask || (s.ask = { answer: 'text' });
    const type = a.answer || 'text';
    const ch = a.choices || (a.choices = []);
    const tname = (WF_ANSWERS.find((x) => x[0] === type) || WF_ANSWERS[0])[2];
    return '<div class="fb-spec">' +
      '<b class="fb-q">What kind of answer?</b><div class="fb-akinds" role="radiogroup">' + WF_ANSWERS.map((x) => '<button type="button" role="radio" aria-checked="' + (type === x[0]) + '" class="chb' + (type === x[0] ? ' on' : '') + '" data-akind="' + i + ':' + x[0] + '"' + dis + '>' + x[1] + ' ' + esc(x[2]) + '</button>').join('') + '</div>' +
      (type === 'choice' ? '<div class="fb-chs">' + ch.map((c, n) => '<div class="fb-ch2"><input class="inp" data-ach="' + i + ':' + n + '" maxlength="40" value="' + esc(c) + '" placeholder="Choice ' + (n + 1) + '" aria-label="Choice ' + (n + 1) + '"' + dis + '>' + (o.editable ? '<button type="button" class="x" data-achx="' + i + ':' + n + '" aria-label="Remove choice">×</button>' : '') + '</div>').join('') +
        (o.editable && ch.length < 8 ? '<button type="button" class="chb add" data-achadd="' + i + '">' + icon('plus') + 'Add a choice</button>' : '') + '</div>' : '') +
      (type === 'phone' ? '<small class="fb-bh">They get a "📱 Share my phone number" button, or they can type it.</small>' : type === 'email' ? '<small class="fb-bh">Castvoo checks it looks like an email, and asks again kindly if not.</small>' : type === 'number' ? '<small class="fb-bh">Only numbers are accepted, like 25 or 1,500.</small>' : '') +
      '<label class="field"><span>Save the answer as</span><input class="inp" data-alabel="' + i + '" maxlength="40" value="' + esc(a.label || '') + '" placeholder="' + esc(tname === 'Buttons' ? 'Choice' : tname) + '"' + dis + '><small class="fb-bh">The column name in your Leads list.</small></label>' +
      wfRemindHtml(i, a.remind, a.remind_text, 'answer', dis) +
      '<details class="wf-more"><summary>If the answer doesn\'t fit</summary><input class="inp" data-aretry="' + i + '" maxlength="300" value="' + esc(a.retry_text || '') + '" placeholder="' + esc(WF_RETRY[type]) + '"' + dis + '></details></div>';
  }
  if (k === 'referral') {
    const r = s.referral || (s.referral = { goal: 3 });
    return '<div class="fb-spec">' +
      '<label class="field fb-goal"><span>How many friends should they invite?</span><input class="inp wf-num" type="number" min="1" max="1000" inputmode="numeric" data-rgoal="' + i + '" value="' + (Number(r.goal) || 3) + '"' + dis + '></label>' +
      (o.editable ? '<div class="fb-toks"><small>Add to the text:</small><button type="button" class="chb" data-tok="' + i + ':{invite_link}">🔗 Their link</button><button type="button" class="chb" data-tok="' + i + ':{invites}">🔢 Friends so far</button><button type="button" class="chb" data-tok="' + i + ':{goal}">🎯 The goal</button></div>' : '') +
      '<small class="fb-bh">Only people new to your bot count, each once, and at most 50 a day per person. The reward is the next message: "🏆 When they reach their invite goal".</small></div>';
  }
  return '';
}

/** One message card. o: { editable, sel, has(feature), stats, ai, photoOnly, flows: [{id,name}] } */
function wfCardHtml(E, i, o) {
  const s = E.steps[i];
  const has = o.has || (() => true);
  const dis = o.editable ? '' : ' disabled';
  const first = i === 0;
  const vs = s.variants || [];
  const vi = Math.min(s.vsel || 0, vs.length);
  const cur = vi === 0 ? s : vs[vi - 1];
  const t = wfTrig(E, i);
  const st = o.stats && o.stats[i];
  const G = wfGraph(E);
  const inGroup = !!G[i].group && G[i].group.members.length > 0 && t === 'on_button';
  const startOn = first && wfStartOn(E);
  const sf = s.start_flow_id ? (o.flows || []).find((f) => String(f.id) === String(s.start_flow_id)) : null;
  const tips = (o.tips || []).filter((x) => x.i === i);
  const kind = wfKind(s);
  const special = kind !== 'message';
  const bot = wfIsBot(E);
  const btns = special ? '' : (cur.buttons || []).map((b, bi) => '<div class="fb-b ' + (b.kind === 'reply' ? 'reply' : 'link') + '">' +
    '<div class="fb-kind" role="group" aria-label="Button type"><button type="button" class="' + (b.kind === 'reply' ? '' : 'on') + '" data-bk="' + i + ':' + bi + ':link"' + dis + '>🔗 Link</button><button type="button" class="' + (b.kind === 'reply' ? 'on' : '') + '" data-bk="' + i + ':' + bi + ':reply"' + dis + '>💬 Reply' + (has('welcome_flows') || bot ? '' : ' ' + icon('lock')) + '</button></div>' +
    '<div class="fb-bf"><button type="button" class="wf-emo" data-emo="' + i + ':' + bi + '" aria-label="Add an emoji"' + dis + '>😊</button><input class="inp" data-bl="' + i + ':' + bi + '" value="' + esc(b.label) + '" maxlength="40" placeholder="' + (b.kind === 'reply' ? 'Button text, like ⭐ VIP signals' : 'Button text') + '" aria-label="Button text"' + dis + '>' +
    (b.kind === 'reply' ? '' : '<input class="inp" data-bu="' + i + ':' + bi + '" value="' + esc(b.url) + '" placeholder="https://your-link.com" inputmode="url" aria-label="Button link"' + dis + '>') +
    (o.editable ? '<button type="button" class="x" data-bx="' + i + ':' + bi + '" aria-label="Remove button">×</button>' : '') + '</div>' +
    (b.kind === 'reply' ? '<small class="fb-bh">No link needed. When they tap it, the answer you pick below arrives.</small>' : '') + '</div>').join('');
  const startHtml = startOn ? '<div class="fb-b start"><div class="fb-kind"><span class="fb-sk">👆 Tap Start</span></div><div class="fb-bf"><input class="inp" data-sl value="' + esc(E.start_label || '') + '" maxlength="40" placeholder="' + esc(wfStartLabel(E)) + '" aria-label="Tap Start button text"' + dis + '>' + (o.editable && E.approve_mode !== 'tap' ? '<button type="button" class="x" data-startx aria-label="Remove the Tap Start button">×</button>' : '') + '</div><small class="fb-bh">Opens your bot. Once they tap Start, your bot can message them any time.</small></div>' : '';
  const more = [];
  if (!first && !special && (t === 'after_previous' || t === 'wait')) more.push('<label class="wf-cond"><span>Who gets it</span><select data-cond="' + i + '"' + dis + '><option value="">Everyone</option><option value="clicked"' + (s.condition === 'clicked' ? ' selected' : '') + '>Only people who clicked a button before</option><option value="not_clicked"' + (s.condition === 'not_clicked' ? ' selected' : '') + '>Only people who did not click</option></select>' + (has('condition_clicked') ? '' : wfLock('condition_clicked')) + '</label>');
  if (first && !bot) more.push('<div class="wf-ab">' + (vs.length ? ['A'].concat(vs.map((_, k) => String.fromCharCode(66 + k))).map((l, k) => '<button type="button" class="' + (k === vi ? 'on' : '') + '" data-vt="' + i + ':' + k + '">Version ' + l + '</button>').join('') : '') +
    (o.editable ? (vs.length < 3 ? '<button type="button" class="add" data-vadd="' + i + '">' + icon('plus') + (vs.length ? 'Add a version' : 'A/B test the welcome') + (has(vs.length ? 'ab_welcome_4' : 'ab_welcome_2') ? '' : wfLock(vs.length ? 'ab_welcome_4' : 'ab_welcome_2')) + '</button>' : '') + (vs.length && vi > 0 ? '<button type="button" class="add" data-vdel="' + i + ':' + vi + '">' + icon('trash') + 'Remove this version</button>' : '') : '') + '</div>');
  const n = E.steps.length;
  return '<article class="fb-card' + (o.sel === i ? ' sel' : '') + '" data-i="' + i + '">' +
    '<div class="fb-ch"><span class="fb-no">' + (i + 1) + '</span><b>' + (special ? WF_KINDS[kind][0] + ' ' + esc(WF_KINDS[kind][1]) : first ? (bot ? 'First message' : 'Welcome message') : 'Message ' + (i + 1)) + '</b>' + (vs.length ? '<span class="pill p-blue">A/B</span>' : '') + (special && WF_KIND_TYPE[kind] && !wfBotHas(WF_KIND_TYPE[kind]) ? wfBotLock(WF_KIND_TYPE[kind]) : '') +
    (o.editable ? '<span class="wf-tools">' + (first || inGroup ? '' : '<button type="button" data-up2="' + i + '" aria-label="Move up"' + (i <= 1 ? ' disabled' : '') + '>' + icon('up') + '</button><button type="button" data-dn="' + i + '" aria-label="Move down"' + (i >= n - 1 ? ' disabled' : '') + '>' + icon('down') + '</button>') +
      (first && !(bot && E.steps.length > 1) ? '' : '<button type="button" data-dup="' + i + '" aria-label="Copy">' + icon('copy') + '</button><button type="button" data-del="' + i + '" aria-label="Delete">' + icon('trash') + '</button>') + '</span>' : '') + '</div>' +
    (inGroup ? '<label class="fb-tb"><span>Answers the button</span><select data-tb="' + i + '"' + dis + '>' + (() => { const g = G[i].group; const own = g.owner != null ? g.owner : wfAnchorMsg(E, i); return ((E.steps[own] || {}).buttons || []).map((b) => '<option value="' + esc(b.id) + '"' + (b.id === s.trigger.button ? ' selected' : '') + '>' + esc(String(b.label || '').trim() || 'Untitled button') + '</option>').join(''); })() + '</select></label>' : '') +
    (cur.media ? '<div class="nmed">' + (typeof mediaThumb === 'function' ? mediaThumb(cur.media) : '') + (o.editable ? '<button type="button" class="x" data-mx="' + i + '" aria-label="Remove photo or video">×</button>' : '') + '</div>' : '') +
    '<textarea class="inp fb-ta" rows="3" data-body="' + i + '" placeholder="' + (kind === 'check_join' ? 'Ask them to join, like: Join our channel first 👇 then tap I\'ve joined.' : kind === 'ask' ? 'Your question, like: What is your email?' : kind === 'referral' ? 'Invite {goal} friends with your link: {invite_link}' : first ? 'Say hello! {name} becomes their first name.' : 'What would you like to say here?') + '"' + dis + '>' + esc(cur.body || '') + '</textarea>' +
    '<div class="cc" data-cc="' + i + '"></div>' +
    (special ? wfSpecialHtml(E, i, o) : '') +
    (startHtml || btns ? '<div class="fb-btns">' + startHtml + btns + '</div>' : '') +
    (o.editable ? '<div class="fb-acts">' + (special ? '' : '<button type="button" class="addm" data-ba="' + i + '">🔘 Add a button</button>') + (first && !startOn && !bot ? '<button type="button" class="addm" data-starton>👆 Add a Tap Start button' + (has('tap_to_start') ? '' : ' ' + wfLock('tap_to_start')) + '</button>' : '') +
      '<button type="button" class="addm" data-ma="' + i + '">📎 ' + (cur.media ? 'Replace photo' : o.photoOnly ? 'Photo' : 'Photo or video') + '</button><button type="button" class="addm" data-nm="' + i + '">👤 Their name</button>' +
      (o.ai ? '<button type="button" class="addm aiw" data-aiw="' + i + '">✨ Write it with Cas' + (has('ai') ? '' : ' ' + wfLock('ai')) + '</button>' : '') +
      (special ? '' : '<button type="button" class="addm" data-sf="' + i + '">➡ Start another ' + (bot ? 'bot' : 'flow') + (has('start_another_flow') ? '' : ' ' + wfLock('start_another_flow')) + '</button>') + '</div><div class="nup" data-upl="' + i + '"></div>' : '') +
    (s.start_flow_id ? '<div class="fb-sf"><span>➡</span><span>Then <b>' + esc(sf ? sf.name : 'another flow') + '</b> starts for them, from its first message.</span>' + (o.editable ? '<button type="button" class="lnk" data-sfx="' + i + '">Remove</button>' : '') + '</div>' : '') +
    (more.length ? '<details class="wf-more fb-more"' + (s.condition || vs.length ? ' open' : '') + '><summary>More options</summary><div class="fb-mo">' + more.join('') + '</div></details>' : '') +
    (tips.length ? '<ul class="fb-tips">' + tips.map(wfTipLi).join('') + '</ul>' : '') +
    '<div class="fb-when"><span class="fb-wi" aria-hidden="true">' + WF_TRIG[t][0] + '</span><span class="fb-wt"><b>' + esc(wfWhen(E, i)) + '</b><small>' + esc(wfReach(E, i)) + '</small></span><button type="button" class="fb-pvb" data-pvstep="' + i + '" aria-label="Preview this step">👁<span> Preview this step</span></button></div>' +
    (st ? '<div class="stats"><span>📨 ' + fmt(st.delivered) + ' delivered</span>' + (st.buttons || []).filter((b) => b.taps).map((b) => '<span>' + (b.kind === 'reply' ? '💬 ' : '🔗 ') + esc(b.label) + ': ' + fmt(b.people) + '</span>').join('') + (st.waiting_start ? '<span>⏳ ' + fmt(st.waiting_start) + ' waiting for Start</span>' : '') + (st.awaiting ? '<span>👀 ' + fmt(st.awaiting) + ' waiting for a tap</span>' : '') + (st.cancelled ? '<span>✋ ' + fmt(st.cancelled) + ' not needed</span>' : '') + '</div>' : '') +
    '</article>';
}

/** The whole list: messages, the chips between them, and choices as tabs. */
function stepsHtml(E, o = {}) {
  const G = wfGraph(E);
  const out = [];
  E.steps.forEach((s, i) => {
    const g = G[i].group && G[i].t === 'on_button' ? G[i].group : null;
    if (g && g.members[0] !== i) return; // drawn with its choice
    if (i > 0) out.push(wfConnHtml(E, i, o));
    if (!g) { out.push(wfCardHtml(E, i, o)); return; }
    const key = String(g.owner);
    const pick = g.members.includes((o.btab || {})[key]) ? o.btab[key] : (g.members.includes(o.sel) ? o.sel : g.members[0]);
    out.push('<div class="fb-branch"><div class="fb-tabs" role="tablist" aria-label="Answers">' + g.members.map((k) => {
      const b = wfButton(E, E.steps[k].trigger.button);
      return '<button type="button" role="tab" class="fb-tab' + (k === pick ? ' on' : '') + '" data-btab="' + key + ':' + k + '"><small>If they tap</small><b>' + esc(b ? (String(b.label || '').trim() || 'Untitled button') : 'a button') + '</b></button>';
    }).join('') + (o.editable ? '<button type="button" class="fb-tab add" data-badd="' + i + '">' + icon('plus') + '<b>Another button</b></button>' : '') + '</div>' + wfCardHtml(E, pick, o) + '</div>');
  });
  if (o.editable) {
    out.push('<div class="fb-addw">' + (o.adding ? '<div class="fb-conn open adding"><span class="fb-cl" aria-hidden="true"></span><div class="fb-chip k-new"><span class="fb-ci">＋</span><span class="fb-cq"><small>New message</small><b>When should the next message come?</b></span><button type="button" class="fb-cc" data-addx>Cancel</button></div><div class="fb-pick">' +
      wfTrigOrder(E, E.steps.length).map((k) => '<button type="button" class="fb-tile" data-addt="' + k + '"><span class="fb-ti">' + WF_TRIG[k][0] + '</span><b>' + esc(WF_TRIG[k][1]) + '</b><small>' + esc(WF_TRIG[k][2]) + '</small>' + (k !== 'after_previous' && k !== 'wait' && !wfIsBot(E) && !(o.has || (() => true))('welcome_flows') ? wfLock('welcome_flows') : '') + '</button>').join('') + '</div>' +
      '<div class="fb-pickh"><small>Or add a special step</small></div><div class="fb-pick spec">' + (wfIsBot(E) ? ['check_join', 'ask', 'referral'] : ['check_join']).map((k) => '<button type="button" class="fb-tile" data-adds="' + k + '"><span class="fb-ti">' + WF_KINDS[k][0] + '</span><b>' + esc(WF_KINDS[k][1]) + '</b><small>' + esc(WF_KINDS[k][2]) + '</small>' + (wfBotHas(WF_KIND_TYPE[k]) ? '' : wfBotLock(WF_KIND_TYPE[k])) + '</button>').join('') + '</div></div>'
      : (E.steps.length <= 1 ? '<p class="fb-empty">' + (wfIsBot(E) ? 'Just one message for now, and that\'s fine. Add a step whenever you like.' : 'Just a welcome for now, and that\'s fine. Add a message whenever you like.') + '</p>' : '') + '<button type="button" class="fb-add" data-addnext>' + icon('plus') + '<span>Add the next message</span></button>') + '</div>');
  }
  return out.join('');
}

/** Older callers (and tests): blocks (messages and waits) → the same list. A wait becomes the next message's trigger. */
function wfFromBlocks(blocks, o = {}) {
  const steps = []; let wait = 0;
  for (const b of blocks || []) {
    if (b.type === 'wait') { wait += wfSecs(b); continue; }
    const [v, u] = wfSplit(wait);
    steps.push({ body: b.body || '', media: b.media || null, buttons: (b.buttons || []).map((x) => ({ id: x.id || x.code || wfId(), label: x.label || '', url: x.url || '', kind: x.kind === 'reply' ? 'reply' : 'link' })), condition: b.condition || null, variants: b.variants || [], vsel: 0,
      trigger: steps.length ? (b.trigger && b.trigger.type ? b.trigger : wait ? { type: 'wait', value: v, unit: u } : { type: 'after_previous' }) : null });
    wait = 0;
  }
  return { approve_mode: o.approve_mode || 'after_welcome', start_button: !!o.start_button, start_label: o.start_label || '', steps };
}
function blocksHtml(blocks, o = {}) { return stepsHtml(wfFromBlocks(blocks, o), o); }

/* ---------- Page ---------- */
PAGES.flows = {
  title: 'Bots', sub: 'Your bots welcome, answer and follow up for you',
  async render(el, q, alive) {
    el.innerHTML = skel(1, 120) + '<div class="wf-grid">' + skel(3, 170) + '</div>';
    if (CFG.features.welcome_flows === false || CFG.features.join_welcome === false) { el.innerHTML = emptyBox({ cas: 'think', title: 'Welcome Flows are switched off for a moment', text: 'The Castvoo team has paused them. Please check back soon.' }); return; }
    FL.data = await GET('/api/flows');
    if (!alive()) return;
    if (q.id) return wfOpen(el, +q.id, q.tab || 'build', alive);
    if (q.tpl) { FL.E = q.tpl === 'cas' && FL.pendingE ? FL.pendingE : wfNew(q.tpl === 'cas' ? 'blank' : q.tpl); FL.pendingE = null; FL.stats = null; FL.btab = {}; FL.dirty = false; FL.sel = 0; FL.tab = 'build'; FL.sim = []; FL.open = -1; FL.adding = false; FL.cas = q.tpl === 'blank'; wfResetPreview(); return wfBuilder(el, alive); }
    if (q.bot) { FL.E = wfNewBot(q.bot); FL.stats = null; FL.btab = {}; FL.dirty = false; FL.sel = 0; FL.tab = 'build'; FL.sim = []; FL.open = -1; FL.adding = false; FL.cas = false; wfResetPreview(); return wfBuilder(el, alive); }
    wfList(el, q, alive);
    if (q.new === '1' && canSend()) { history.replaceState(null, '', '#app/flows'); wfNewFlow(); }
    if (q.newbot === '1' && canSend()) { history.replaceState(null, '', '#app/flows'); wfNewBotSheet(); }
    if (q.cas && canSend()) { history.replaceState(null, '', '#app/flows'); if (typeof cbOpen === 'function') cbOpen(q.cas === '1' ? {} : { resume: +q.cas }); }
  },
};

function wfMeterHtml(m, plan) {
  if (!m) return '';
  const unl = m.limit < 0 || m.unlimited_until;
  const pct = unl ? 0 : Math.min(100, m.limit ? m.used / m.limit * 100 : 100);
  const word = plan && plan.free ? 'free joins' : 'join requests';
  let pace = '';
  if (!unl && m.used > 0 && m.used < m.limit) {
    const start = new Date(m.since).getTime(), days = Math.max(1, (Date.now() - start) / 86400000);
    const left = (m.limit - m.used) / (m.used / days);
    const runOut = new Date(Date.now() + left * 86400000);
    if (runOut < new Date(m.resets_at)) pace = 'At this pace you reach the limit around ' + fmtDate(runOut, false) + '.';
  }
  const hot = !unl && m.used >= m.limit * 0.8;
  return '<div class="box wf-meter' + (hot ? ' hot' : '') + '"><div class="wf-mh"><div><small class="muted">This month</small><b class="tnum">' + fmt(m.used) + (unl ? '' : ' <span>/ ' + fmt(m.limit) + ' ' + word + '</span>') + '</b></div>' +
    (unl ? '<span class="pill p-ok">No limit right now</span>' : '<span class="pill ' + (m.paused ? 'p-bad' : hot ? 'p-warn' : 'p-blue') + '">Resets ' + fmtDate(m.resets_at, false) + '</span>') + '</div>' +
    (unl ? '' : '<div class="prog2' + (hot ? ' hot' : '') + '"><i style="width:' + pct.toFixed(1) + '%"></i></div>') +
    (m.paused ? '<p class="wf-mw">⏸️ <b>Welcomes are paused.</b> People are still let in, but they don\'t get your message until ' + fmtDate(m.resets_at, false) + ' or until you upgrade.</p>' : '') +
    (m.no_welcome ? '<p class="wf-mw"><b>' + plural(m.no_welcome, 'person', 'people') + ' joined without your welcome</b> this month.</p>' : '') +
    (pace ? '<p class="hint">' + esc(pace) + '</p>' : '') +
    (hot || m.no_welcome ? '<button type="button" class="btn b-blue sm" data-up="join_requests">' + icon('up') + 'Get more join requests</button>' : '') + '</div>';
}

function wfSetupHtml(d) {
  const hasChat = d.chats.length > 0, hasBot = d.bots.length > 0;
  const step = (n, done, title, text, btn) => '<div class="wf-st' + (done ? ' done' : '') + '"><span class="wf-sn">' + (done ? icon('check') : n) + '</span><div><b>' + title + '</b><p class="muted">' + text + '</p></div>' + (done ? '' : btn) + '</div>';
  return '<div class="box wf-setup"><div class="bh"><h3>' + icon('tg') + 'Get ready in 3 steps</h3></div>' +
    step(1, hasChat, 'Connect your channel or group', 'Turn on "Approve new members" in its invite link, so people ask to join.', '<button type="button" class="btn b-blue xs" data-connect="channel">Connect</button>') +
    step(2, hasBot, 'Connect your own bot', 'Make one with @BotFather and paste its token. This bot sends the welcome.', '<button type="button" class="btn b-blue xs" data-connect="bot">Connect</button>') +
    step(3, false, 'Make your bot an admin of the channel', 'Turn on its "Add members" right. Castvoo checks this for you when you switch a flow on.', '') + '</div>';
}

function wfTplLocked(t) {
  const msgs = (t.steps || []).length;
  const events = (t.steps || []).some((s) => s.trigger && ['on_start', 'on_button', 'no_response'].includes(s.trigger.type));
  return (msgs > 1 && wfLimit('flow_steps') === 1) || (t.start_button && !wfHas('tap_to_start')) || (events && !wfHas('welcome_flows'));
}
function wfTemplatesHtml(d) {
  return '<div class="wf-tpls">' + d.templates.map((t) => {
    const msgs = (t.steps || []).length;
    return '<button type="button" class="wf-tpl" data-tpl="' + esc(t.key) + '"><span class="wf-te">' + esc(t.emoji) + '</span><b>' + esc(t.name) + '</b><small>' + esc(t.about) + '</small><span class="wf-tm">' + plural(msgs, 'message') + (wfTplLocked(t) ? ' · ' + wfLock(msgs > 1 ? 'welcome_flows' : 'tap_to_start') : '') + '</span></button>';
  }).join('') + '<button type="button" class="wf-tpl blank" data-tpl="blank"><span class="wf-te">✨</span><b>Tell Cas what you want</b><small>Describe it in one sentence, or start from one empty welcome.</small></button></div>';
}

/** One Chat bot in the list. */
function botCardHtml(f) {
  const live = !!f.active;
  const pill = live ? '<span class="pill p-ok"><span class="dl"></span>Live</span>' : f.paused_by_plan ? '<span class="pill p-warn">Paused by plan</span>' : '<span class="pill p-grey">Draft</span>';
  const t = WF_BOT_TYPES[f.bot_type] || WF_BOT_TYPES.custom;
  const n = (v) => fmt(v || 0);
  const third = f.bot_type === 'referral' ? [n(f.referrals), 'invited'] : f.bot_type === 'lead_questions' ? [n(f.leads), 'leads'] : [n(f.finished), 'finished'];
  return '<article class="wf-card bot' + (live ? ' live' : '') + '" data-open="' + Number(f.id) + '">' +
    '<div class="wf-ch"><span class="wf-ci">' + t[0] + '</span><div class="wf-ct"><b class="ell" title="' + esc(f.name) + '">' + esc(f.name) + '</b><small class="ell">?start=' + esc(f.start_code || '') + (f.is_default ? ' · plain Start' : '') + ' · @' + esc(f.bot_username || '') + '</small></div>' + pill + '</div>' +
    '<div class="wf-fun"><span><b class="tnum">' + n(f.started) + '</b>started</span><i></i><span><b class="tnum">' + third[0] + '</b>' + third[1] + '</span><i></i><span><b class="tnum">' + n(f.steps || 1) + '</b>steps</span></div>' +
    '<div class="wf-cf"><span class="wf-chip">' + esc(t[1]) + '</span><span class="wf-go">Open ' + icon('chev') + '</span></div></article>';
}
/** "2 of 5 bots on", with a gentle upgrade hint near the limit. */
function wfBotUsageHtml(d) {
  const b = d.plan.limits && d.plan.limits.bots; const u = d.bot_usage || {};
  if (!b) return '';
  const max = b.max_bots, live = u.live || 0;
  const full = max >= 0 && live >= max;
  return '<div class="box wf-topr bu"><small class="bu-l">Bots switched on</small><b class="tnum">' + fmt(live) + (max >= 0 ? ' <span>/ ' + fmt(max) + '</span>' : '') + '</b>' +
    '<p class="muted">' + (max >= 0 ? (full ? 'That\'s all your plan runs at once. Switch one off, or get room for more.' : 'Drafts don\'t count. Switch on the ones you need.') : 'No limit on your plan (fair use).') + '</p>' +
    (u.answers && u.answers.limit > 0 ? '<p class="bu-leads"><span>📝 Leads this month</span><span class="tnum"><strong>' + fmt(u.answers.used) + '</strong> / ' + fmt(u.answers.limit) + '</span></p>' : '') +
    '<div class="row2b">' + (canSend() ? '<button type="button" class="btn b-blue sm" data-newbot>' + icon('plus') + 'New bot</button>' : '') + (full ? '<button type="button" class="btn b-ghost sm" data-up="bots">' + icon('up') + 'More bots</button>' : '') + '</div></div>';
}
function wfOwnHtml(d) {
  return (d.ownership || []).slice(0, 2).map((w) => '<div class="pban info"><span class="pbi">💡</span><div style="flex:1;min-width:0"><p>' + esc(w.message) + '</p></div></div>').join('');
}

function wfList(el, q, alive) {
  const d = FL.data;
  const plan = d.plan;
  const flows = d.flows;
  const bots = d.chatbots || [];
  const branding = plan.branding ? '<div class="pban info"><span class="pbi">⚡</span><div style="flex:1;min-width:0"><b>Free bots end their first message with a small "by Castvoo.com" line</b><p>That is how the Free plan stays free. Remove it, and add follow-ups, from ' + esc((plan.plans || []).find((p) => p.code === 'starter') ? 'Starter' : 'a paid plan') + '.</p></div><button type="button" class="btn b-blue xs" data-up="branding">Remove it</button></div>' : '';
  const waiting = d.pending ? '<div class="pban warn"><span class="pbi">🙋</span><div style="flex:1;min-width:0"><b>' + plural(d.pending, 'person is', 'people are') + ' waiting to be let in</b><p>Open the welcome bot and use Requests to let them in or decline.</p></div>' + (flows.find((f) => f.pending) ? '<button type="button" class="btn b-blue xs" data-open="' + flows.find((f) => f.pending).id + '" data-tab="requests">See requests</button>' : '') + '</div>' : '';
  if (!flows.length && !bots.length) {
    el.innerHTML = '<div class="wf-hero"><div class="wf-hl"><span class="kick">🤖 Bots</span><h2>Your bot, working for you.</h2><p>Welcome everyone who asks to join your channel, or answer people the moment they tap Start in your bot: send a gift, check they joined, ask a few questions, or reward invites.</p>' +
      '<div class="wf-ha"><button type="button" class="btn b-blue" data-newbot>' + icon('plus') + 'Make your first bot</button>' + (typeof cbOpen === 'function' && CFG.features.cas_builder !== false && canSend() ? '<button type="button" class="btn b-ghost" data-cbnew>💬 Build it with Cas</button>' : '') + '</div></div><div class="wf-hp"><div class="phone2 wf-mini"><div class="scr">' + tgPreviewHtml({ bot: 'yourbot', chat: 'your channel', body: 'Hi {name} 👋\n\nThanks for asking to join. What would you like?', buttons: [{ label: '⭐ VIP signals', kind: 'reply', row: 0 }, { label: '📘 Free tips', kind: 'reply', row: 0 }], startLabel: '👆 Tap Start', first: true, branding: plan.branding }) + '</div></div><span class="wf-ex">Example</span></div></div>' +
      (d.chats.length && d.bots.length ? '' : wfSetupHtml(d)) +
      helperCard('fl') +
      '<div class="box"><div class="bh"><h3>' + icon('spark') + 'Start in one tap</h3><span class="hint">Pick one, change the words, switch it on.</span></div>' + wfBotKindsHtml() + '</div>' + wfMeterHtml(d.meter, plan) + branding;
  } else {
    el.innerHTML = '<div class="wf-top"><div class="wf-topl">' + wfMeterHtml(d.meter, plan) + '</div>' + wfBotUsageHtml(d) + '</div>' + waiting + branding + wfOwnHtml(d) +
      '<div class="wf-sec"><h3>👋 Welcome bots <small class="muted">When someone asks to join your channel or group</small></h3>' +
      (flows.length ? '<div class="wf-grid">' + flows.map(flowCardHtml).join('') + '</div>' : '<p class="muted wf-none">None yet. <button type="button" class="lnk" data-newkind="welcome">Make a welcome bot</button></p>') + '</div>' +
      '<div class="wf-sec"><h3>💬 Chat bots <small class="muted">When someone opens your bot and taps Start</small></h3>' +
      (bots.length ? '<div class="wf-grid">' + bots.map(botCardHtml).join('') + '</div>' : '<p class="muted wf-none">None yet. <button type="button" class="lnk" data-newkind="chat">Make a chat bot</button></p>') + '</div>' +
      (d.chats.length && d.bots.length ? '' : wfSetupHtml(d));
  }
  el.onclick = (e) => {
    const t = e.target;
    const up = t.closest('[data-up]'); if (up) { e.preventDefault(); e.stopPropagation(); wfUpgrade(up.dataset.up); return; }
    const op = t.closest('[data-open]'); if (op) { appGo('flows', { id: op.dataset.open, ...(op.dataset.tab ? { tab: op.dataset.tab } : {}) }); return; }
    if (t.closest('[data-new]') || t.closest('[data-newbot]')) { wfNewBotSheet(); return; }
    const nk = t.closest('[data-newkind]'); if (nk) { if (nk.dataset.newkind === 'welcome') wfNewFlow(); else wfNewBotSheet('chat'); return; }
    const bk = t.closest('[data-botkind]'); if (bk) { wfPickBotKind(bk.dataset.botkind); return; }
    if (t.closest('[data-cbnew]')) { cbOpen({}); return; }
    const tp = t.closest('[data-tpl]'); if (tp) { wfStartTemplate(tp.dataset.tpl); }
  };
}

/* ---------- "+ New bot": what should start it, then a ready template ---------- */
/** The two starts and the Chat bot templates as big tiles (also the empty page). */
function wfBotKindsHtml() {
  const d = FL.data;
  const tpl = (d.bot_templates || []);
  const locked = (t) => { const ty = t.key === 'custom' ? null : t.key; return ty && WF_BOT_LOCK[ty] && !wfBotHas(ty); };
  return '<div class="nb-kinds"><button type="button" class="nb-k" data-botkind="welcome"><span class="nb-e">👋</span><b>Welcome bot</b><small>When someone asks to join my channel or group</small></button>' +
    '<button type="button" class="nb-k" data-botkind="chat"><span class="nb-e">💬</span><b>Chat bot</b><small>When someone opens my bot and taps Start</small></button></div>' +
    '<p class="hint nb-or">Popular chat bots:</p><div class="wf-tpls">' + tpl.slice(0, 3).map((t) => '<button type="button" class="wf-tpl" data-botkind="t:' + esc(t.key) + '"><span class="wf-te">' + esc(t.emoji) + '</span><b>' + esc(t.name) + '</b><small>' + esc(t.about) + '</small>' + (locked(t) ? '<span class="wf-tm">' + wfBotLock(t.key) + '</span>' : '') + '</button>').join('') + '</div>';
}
function wfNewBotSheet(kind) {
  const d = FL.data;
  if (!d) { appGo('flows', { newbot: '1' }); return; }
  if (kind === 'chat') return wfChatTemplates();
  const h = sheet('New bot', '<span class="spk">🤖</span>', '<p class="muted nb-q"><b>What should start your bot?</b></p>' +
    '<div class="nb-kinds"><button type="button" class="nb-k" data-botkind="welcome"><span class="nb-e">👋</span><b>Welcome bot</b><small>When someone asks to join my channel or group</small></button>' +
    '<button type="button" class="nb-k" data-botkind="chat"><span class="nb-e">💬</span><b>Chat bot</b><small>When someone opens my bot and taps Start</small></button></div>', { wide: true });
  $('.nb-kinds', h).onclick = (e) => { const b = e.target.closest('[data-botkind]'); if (!b) return; closeModal(); wfPickBotKind(b.dataset.botkind); };
}
function wfPickBotKind(k) {
  if (k === 'welcome') { wfNewFlow(); return; }
  if (k === 'chat') { wfChatTemplates(); return; }
  if (k.startsWith('t:')) wfStartBot(k.slice(2));
}
/** Step 2 for a Chat bot: the ready templates, plus Broadcast and "Something else". */
function wfChatTemplates() {
  const d = FL.data;
  const tpls = d.bot_templates || [];
  const tile = (key, emoji, name, about, type) => '<button type="button" class="wf-tpl" data-ct="' + esc(key) + '"><span class="wf-te">' + esc(emoji) + '</span><b>' + esc(name) + '</b><small>' + esc(about) + '</small>' + (type && !wfBotHas(type) ? '<span class="wf-tm">' + wfBotLock(type) + '</span>' : '') + '</button>';
  const list = tpls.filter((t) => t.key !== 'custom').map((t) => tile(t.key, t.emoji, t.name, t.about, t.key)).join('') +
    tile('broadcast', '📣', 'Broadcast to bot subscribers', 'Send one message to everyone who started one of your chat bots.', 'broadcast') +
    (tpls.find((t) => t.key === 'custom') ? tile('custom', '✨', 'Something else', 'Start from one friendly message and build it your way.', null) : '');
  const cas = typeof cbOpen === 'function' && CFG.features.cas_builder !== false && canSend()
    ? '<button type="button" class="cbc-card pri" data-ctcas><span class="cbc-tag">⭐ Recommended</span><span class="cbc-ic">💬</span><span class="cbc-t"><b>Build it with Cas</b><small>Tell Cas what your bot should do, tap a few answers, and Cas builds it for you.</small></span><span class="cbc-go">' + icon('chev') + '</span></button>' : '';
  const h = sheet('New chat bot', '<span class="spk">💬</span>', '<p class="muted nb-q">It starts when someone opens your bot and taps <b>Start</b>. Pick a starting point; you can change every word.</p>' + (cas ? '<div class="cbc">' + cas + '</div>' : '') + '<div class="wf-tpls">' + list + '</div>', { wide: true });
  const cb = $('[data-ctcas]', h); if (cb) cb.onclick = () => { closeModal(); cbOpen({}); };
  $('.wf-tpls', h).onclick = (e) => {
    const up = e.target.closest('[data-up]'); if (up) { e.stopPropagation(); wfUpgrade(up.dataset.up); return; }
    const b = e.target.closest('[data-ct]'); if (!b) return;
    closeModal();
    if (b.dataset.ct === 'broadcast') { wfBotBroadcastSheet(); return; }
    wfStartBot(b.dataset.ct);
  };
}
function wfStartBot(key) {
  if (WF_BOT_LOCK[key] && !wfBotHas(key)) { wfUpgrade('bot_' + key); return; }
  appGo('flows', { bot: key });
}
/** "📣 Broadcast to bot subscribers": pick a Chat bot, then Send a message opens with "Started <bot>". */
function wfBotBroadcastSheet() {
  if (!wfBotHas('broadcast')) { wfUpgrade('bot_broadcast'); return; }
  const bots = (FL.data.chatbots || []);
  const h = sheet('Broadcast to bot subscribers', '<span class="spk">📣</span>', '<p class="muted nb-q">Pick a chat bot. Your message goes to everyone who started it (people who stopped or blocked your bot are never messaged).</p>' +
    (bots.length ? '<div class="fb-flows">' + bots.map((b) => '<button type="button" class="fb-flow" data-bbc="' + Number(b.id) + '"><span>' + (WF_BOT_TYPES[b.bot_type] || WF_BOT_TYPES.custom)[0] + '</span><span><b>' + esc(b.name) + '</b><small>' + plural(b.started || 0, 'person', 'people') + ' started it · @' + esc(b.bot_username || '') + '</small></span></button>').join('') + '</div>'
      : emptyBox({ plain: 1, emoji: '💬', title: 'No chat bots yet', text: 'Make a chat bot first. Everyone who starts it can get your broadcasts.' })));
  h.onclick = async (e) => {
    const b = e.target.closest('[data-bbc]'); if (!b) return;
    try { const r = await POST('/api/bots/' + b.dataset.bbc + '/audience'); closeModal(); appGo('broadcast', { conn: r.bot_id, seg: r.segment_id }); } catch (ex) { closeModal(); wfErr(ex); }
  };
}

/* "New flow": Cas Builder or the builder (app-cas-builder.js cbChooser), or the templates when Cas Builder is off. */
function wfNewFlow() {
  if (typeof cbChooser === 'function' && CFG.features.cas_builder !== false) cbChooser({ kind: 'welcome' }); else wfPickTemplate();
}
function wfPickTemplate() {
  const d = FL.data;
  const l = d.plan.limits;
  if (l.flows >= 0 && d.flows.length >= l.flows) { wfUpgrade('flows'); return; }
  const h = sheet('New welcome flow', '<span class="spk">' + icon('plus') + '</span>', '<p class="muted" style="font-size:14.5px">Pick a starting point. You can change every word before you switch it on.</p>' + wfTemplatesHtml(d), { wide: true });
  $('.wf-tpls', h).onclick = (e) => {
    const up = e.target.closest('[data-up]'); if (up) { e.stopPropagation(); wfUpgrade(up.dataset.up); return; }
    const b = e.target.closest('[data-tpl]'); if (!b) return; closeModal(); wfStartTemplate(b.dataset.tpl);
  };
}
function wfStartTemplate(key) {
  const d = FL.data;
  const l = d.plan.limits;
  if (l.flows >= 0 && d.flows.length >= l.flows) { wfUpgrade('flows'); return; }
  appGo('flows', { tpl: key });
}

/** Template / Cas / API steps → the builder's steps. */
function wfStep(s, i) {
  const tr = i === 0 ? null : (s.trigger ? { type: s.trigger.type, value: s.trigger.value != null ? s.trigger.value : (s.trigger.seconds ? wfSplit(s.trigger.seconds)[0] : undefined), unit: s.trigger.unit || (s.trigger.seconds ? wfSplit(s.trigger.seconds)[1] : undefined), button: s.trigger.button } : { type: 'after_previous' });
  const kind = WF_KINDS[s.type] ? s.type : 'message';
  const rem = (x) => (x && x.remind && Number(x.remind.value) > 0 ? { value: Number(x.remind.value), unit: x.remind.unit || 'min' } : null);
  const special = kind === 'check_join' ? { check: { chat_id: (s.check || {}).chat_id || '', open_label: (s.check || {}).open_label || '', join_label: (s.check || {}).join_label || '', link: (s.check || {}).link || '', nudge: (s.check || {}).nudge || '', remind: rem(s.check), remind_text: (s.check || {}).remind_text || '' } }
    : kind === 'ask' ? { ask: { answer: (s.ask || {}).answer || 'text', choices: ((s.ask || {}).choices || []).slice(), label: (s.ask || {}).label || '', button: (s.ask || {}).button || '', retry_text: (s.ask || {}).retry_text || '', remind: rem(s.ask), remind_text: (s.ask || {}).remind_text || '' } }
      : kind === 'referral' ? { referral: { goal: Number((s.referral || {}).goal) || 3 } } : {};
  return {
    type: kind, ...special,
    id: s.id || null, body: s.body || '', media: s.media_id ? { id: s.media_id, kind: s.media_kind || 'photo' } : (s.media || null),
    buttons: (s.buttons || []).map((b) => ({ id: b.id || wfId(), label: b.label || '', url: b.url || '', kind: b.kind === 'reply' ? 'reply' : 'link', row: b.row == null ? null : b.row, code: b.code })),
    trigger: tr, start_flow_id: s.start_flow_id || null, condition: s.condition || null, vsel: 0,
    variants: (s.variants || []).map((v) => ({ id: v.id || null, body: v.body || '', media: v.media_id ? { id: v.media_id, kind: v.media_kind || 'photo' } : null, buttons: (v.buttons || []).map((b) => ({ id: b.id || wfId(), label: b.label || '', url: b.url || '', kind: b.kind === 'reply' ? 'reply' : 'link', row: b.row == null ? null : b.row })) })),
  };
}

/** A new, unsaved flow from a template key ("blank" = one empty welcome). */
function wfNew(key) {
  const d = FL.data;
  const t = d.templates.find((x) => x.key === key);
  const chat = d.chats[0], bot = d.bots[0];
  const base = { id: null, name: t ? t.name : 'My welcome flow', chat_id: chat ? chat.id : '', bot_id: bot ? bot.id : '', approve_mode: t ? t.approve_mode : 'after_welcome', start_button: !!(t && t.start_button), start_label: (t && t.start_label) || '', invite_link: '', active: false, steps: [], started_count: 0 };
  base.steps = (t ? t.steps : [{ body: 'Hi {name} 👋 Welcome!' }]).map(wfStep);
  // On a plan that can't run it all, keep what fits and say so in the builder.
  if (!wfHas('tap_to_start')) { if (base.approve_mode === 'tap') base.approve_mode = 'after_welcome'; base.start_button = false; }
  if (!wfHas('welcome_flows') || wfLimit('flow_steps') === 1) {
    if (base.steps.length > 1) base.trimmed = true;
    base.steps = [base.steps[0]];
    base.steps[0].buttons = base.steps[0].buttons.filter((b) => b.kind !== 'reply');
  }
  return base;
}

function wfFromApi(f) {
  return { id: f.id, start_type: f.start_type || 'join_request', start_code: f.start_code || '', is_default: !!f.is_default, bot_type: f.bot_type || 'welcome', start_url: f.start_url || '', name: f.name, chat_id: f.chat_id || '', bot_id: f.bot_id, approve_mode: f.approve_mode, start_button: f.start_button, start_label: f.start_label || '', invite_link: f.invite_link || '', active: f.active, paused_by_plan: f.paused_by_plan, started_count: f.started_count || 0, steps: (f.steps || []).map(wfStep) };
}

/** A new, unsaved Chat bot from a template key (services/bots.js TEMPLATES). Trimmed to what the plan runs. */
function wfNewBot(key) {
  const d = FL.data;
  const t = (d.bot_templates || []).find((x) => x.key === key) || (d.bot_templates || []).find((x) => x.key === 'custom') || { name: 'My bot', start_code: 'hello', steps: [{ body: 'Hi {name} 👋 Thanks for tapping Start!' }] };
  const bot = d.bots[0];
  const used = new Set((d.chatbots || []).map((b) => String(b.start_code || '').toLowerCase()));
  let code = t.start_code || 'hello', n = 2;
  while (used.has(code.toLowerCase())) code = (t.start_code || 'bot') + n++;
  const E = { id: null, start_type: 'bot_start', start_code: code, is_default: !(d.chatbots || []).some((b) => b.active && b.is_default && String(b.bot_id) === String(bot && bot.id)), bot_type: t.bot_type || key, name: t.name, chat_id: '', bot_id: bot ? bot.id : '', approve_mode: 'after_welcome', start_button: false, start_label: '', invite_link: '', active: false, steps: [], started_count: 0 };
  E.steps = t.steps.map((s, i) => wfStep({ ...s, check: s.check ? { ...s.check, chat_id: s.check.chat_id || (d.chats[0] ? d.chats[0].id : '') } : undefined }, i));
  // On a plan that sends 1 message per reply, keep the first message (and a menu's answers, a check's thank-you).
  const b = wfBotLim();
  if (b && b.bot_steps >= 0) {
    let msgs = 0; const keep = [];
    E.steps.forEach((s, i) => { const k = wfKind(s); const isMsg = (k === 'message' || k === 'referral') && wfTrig(E, i) !== 'on_button'; if (isMsg) msgs++; if (!isMsg || msgs <= b.bot_steps) keep.push(s); });
    if (keep.length < E.steps.length) { E.trimmed = true; E.steps = keep; }
  }
  return E;
}

async function wfOpen(el, id, tab, alive) {
  const r = await GET('/api/flows/' + id);
  if (!alive()) return;
  FL.E = wfFromApi(r.flow); FL.dirty = false; FL.sel = 0; FL.tab = ['build', 'stats', 'requests', 'leads', 'invites'].includes(tab) ? tab : 'build'; FL.stats = null; FL.sim = []; FL.open = -1; FL.adding = false; FL.btab = {}; FL.cas = false; wfResetPreview();
  wfBuilder(el, alive);
}

/* ---------- Builder ---------- */
/* Rows for saving: Reply buttons sit two side by side; Link buttons keep the pairs they had. */
function wfSaveRows(buttons) {
  const out = []; let row = -1, inRow = 0, prev = null;
  for (const b of buttons) {
    if (!(String(b.label || '').trim() || String(b.url || '').trim())) continue;
    const pair = prev && inRow === 1 && ((b.kind === 'reply' && prev.kind === 'reply') || (b.kind !== 'reply' && prev.kind !== 'reply' && b.row != null && b.row === prev.row));
    if (pair) inRow = 2; else { row++; inRow = 1; }
    out.push({ id: b.id, label: String(b.label || '').trim(), url: b.kind === 'reply' ? '' : (typeof fixUrl === 'function' ? fixUrl(b.url) : b.url), kind: b.kind === 'reply' ? 'reply' : 'link', row });
    prev = b;
  }
  return out;
}
function wfTrigOut(E, i) {
  if (i === 0) return null;
  const t = wfTrig(E, i), tr = E.steps[i].trigger || {};
  if (t === 'on_goal') return { type: t };
  if (t === 'wait' || t === 'no_response') return { type: t, value: Number(tr.value) || 0, unit: tr.unit || 'min' };
  if (t === 'on_button') return { type: t, button: tr.button };
  return { type: t };
}
/** A special step's settings as the save API takes them (services/flows.js AI_BOT_KEYS). */
function wfSpecialOut(s) {
  const k = wfKind(s);
  const rem = (x) => (x && x.remind && Number(x.remind.value) > 0 ? { value: Number(x.remind.value), unit: x.remind.unit || 'min' } : null);
  if (k === 'check_join') { const c = s.check || {}; return { check: { chat_id: +c.chat_id || null, open_label: c.open_label || '', join_label: c.join_label || '', link: c.link || '', nudge: c.nudge || '', remind: rem(c), remind_text: c.remind_text || '' } }; }
  if (k === 'ask') { const a = s.ask || {}; return { ask: { answer: a.answer || 'text', choices: a.answer === 'choice' ? (a.choices || []).map((x) => String(x).trim()).filter(Boolean) : [], label: a.label || '', button: a.button || '', retry_text: a.retry_text || '', remind: rem(a), remind_text: a.remind_text || '' } }; }
  if (k === 'referral') return { referral: { goal: Math.max(1, Math.min(1000, parseInt((s.referral || {}).goal, 10) || 3)) } };
  return {};
}
function wfBody(E) {
  const steps = E.steps.map((s, i) => ({
    id: s.id || null, type: wfKind(s), ...wfSpecialOut(s), body: s.body, media_id: s.media ? s.media.id : null, buttons: wfKind(s) === 'message' ? wfSaveRows(s.buttons || []) : [], trigger: wfTrigOut(E, i), start_flow_id: wfKind(s) === 'message' ? s.start_flow_id || null : null, condition: s.condition || null,
    variants: (s.variants || []).map((v) => ({ id: v.id || null, body: v.body, media_id: v.media ? v.media.id : null, buttons: wfSaveRows(v.buttons || []) })),
  }));
  if (wfIsBot(E)) return { start_type: 'bot_start', name: E.name.trim(), bot_id: +E.bot_id || null, start_code: String(E.start_code || '').trim(), is_default: !!E.is_default, steps };
  return {
    name: E.name.trim(), chat_id: +E.chat_id || null, bot_id: +E.bot_id || null, approve_mode: E.approve_mode, start_button: wfStartOn(E),
    start_label: E.start_label, invite_link: E.invite_link || null, steps,
  };
}
/* The few things a save really needs (shown softly under the messages). */
function wfCheckBasics(E) {
  if (wfIsBot(E)) {
    if (!E.name.trim()) return 'Give your bot a little name first (at the very top).';
    if (!E.bot_id) return 'Pick the Telegram bot people open (just above your messages).';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(E.start_code || ''))) return 'Pick a start link code with letters, numbers, _ or - (like "gift"), just above your messages.';
    if (!E.steps.length) return 'Add a first message.';
    return '';
  }
  if (!E.name.trim()) return 'Give your flow a little name first (at the very top).';
  if (!E.chat_id) return 'Pick the channel or group people ask to join (just above your messages).';
  if (!E.bot_id) return 'Pick the bot that sends your welcome (just above your messages).';
  if (!E.steps.length) return 'Add a welcome message first.';
  return '';
}
function wfCheck(E, o = {}) {
  const basic = wfCheckBasics(E);
  if (basic) return basic;
  const G = wfGraph(E);
  let total = 0;
  for (const [i, s] of E.steps.entries()) {
    const what = i === 0 ? (wfIsBot(E) ? 'The first message' : 'The welcome') : 'Message ' + (i + 1);
    const t = wfTrig(E, i);
    if (t === 'wait' || t === 'no_response') {
      const v = Number(s.trigger.value);
      if (!Number.isInteger(v) || v < (t === 'no_response' ? 1 : 0) || v > 999) return what + ': the wait can be 1 to 999 ' + (WF_UNIT[s.trigger.unit] || WF_UNIT.min)[1] + '.';
      total += wfSecs(s.trigger);
    }
    if (t === 'on_start' && !wfStartOn(E)) return what + ' comes when they tap Start. Add the Tap Start button to the welcome.';
    if (t === 'on_button') {
      const o = wfOwnerOf(E, s.trigger.button);
      if (o < 0 || o >= i) return what + ': pick which button they tap.';
    }
    if (t === 'no_response' && !G[i].awaits.start && !G[i].awaits.buttons.length) return what + ' is a reminder, but the message above has nothing to tap. Add a button to it.';
    if (wfKind(s) === 'check_join' && !(s.check || {}).chat_id) return what + ': pick the channel or group they should join.';
    if (wfKind(s) === 'ask' && (s.ask || {}).answer === 'choice' && ((s.ask || {}).choices || []).filter((x) => String(x).trim()).length < 2) return what + ': add at least 2 choices.';
    if (t === 'on_goal' && !wfGoalBefore(E, i)) return what + ' waits for an invite goal. Add an "Invite friends" step above it.';
    for (const [k, m] of [s].concat(s.variants || []).entries()) {
      const w2 = what + ((s.variants || []).length ? ' (version ' + String.fromCharCode(65 + k) + ')' : '');
      if (!(m.body || '').trim()) return w2 + ' is empty. Write something in it.';
      const ph = wfPlaceholder(m.body);
      if (ph && !o.save) return w2 + ' still has example text: "' + ph + '". Swap it for your own words before you switch it on.';
      const lim = (m.media ? 1024 : 4096) - (FL.data.plan.branding ? 34 : 0);
      if (visibleLength(wfLenText(E, i, m.body)) > lim) return w2 + ' is too long for Telegram (' + fmt(lim) + ' characters' + (wfKind(s) === 'referral' ? ', counting their invite link' : '') + ').';
      for (const b of m.buttons || []) {
        const l = String(b.label || '').trim();
        if (!l && !(b.url || '').trim()) continue;
        if (!l) return w2 + ': a button needs some text.';
        if (b.kind !== 'reply') { const u = typeof fixUrl === 'function' ? fixUrl(b.url) : b.url; if (!u || !/^https?:\/\/[^\s.]+\.[^\s]+/.test(u)) return w2 + ': the button "' + l + '" needs a link, like https://your-shop.com'; }
      }
    }
  }
  if (total > 365 * 86400) return 'Waits can add up to 365 days at most.';
  return '';
}

function wfBuilder(el, alive) {
  const E = FL.E;
  const editable = canSend();
  const bot = wfIsBot(E);
  const tabs = bot ? [['build', 'Build']].concat(E.steps.some((s) => wfKind(s) === 'ask') ? [['leads', 'Leads']] : []).concat(E.steps.some((s) => wfKind(s) === 'referral') ? [['invites', 'Invites']] : []).concat([['stats', 'Stats']])
    : [['build', 'Build'], ['stats', 'Stats'], ['requests', 'Requests']];
  if (!tabs.some((t) => t[0] === FL.tab)) FL.tab = 'build';
  el.innerHTML = '<div class="wf-b">' +
    '<div class="wf-bhd"><button type="button" class="ib wf-back" data-back aria-label="Back to all bots">' + icon('chev') + '</button>' +
    '<span class="wf-kindp" title="' + (bot ? 'Chat bot: starts when someone taps Start in your bot' : 'Welcome bot: starts when someone asks to join') + '">' + (bot ? '💬' : '👋') + '</span>' +
    '<input class="inp ttlin wf-name" id="wfName" value="' + esc(E.name) + '" maxlength="60" aria-label="Bot name"' + (editable ? '' : ' disabled') + '>' +
    '<div class="wf-live">' + (E.id ? '<span class="muted" id="wfLiveL">' + (E.active ? 'Live' : 'Draft') + '</span>' + toggleBtn('wfLive', E.active, 'Switch this bot on or off') : '<span class="pill p-warn">Not saved</span>') + '</div></div>' +
    (E.id ? '<div class="seg2 wf-tabs" role="tablist">' + tabs.map((t) => '<button type="button" role="tab" data-tab="' + t[0] + '" class="' + (FL.tab === t[0] ? 'on' : '') + '">' + t[1] + '</button>').join('') + '</div>' : '') +
    '<div id="wfPane"></div></div>';
  const pane = $('#wfPane', el);
  const drawPane = () => {
    $$('.wf-tabs [data-tab]', el).forEach((b) => b.classList.toggle('on', b.dataset.tab === FL.tab));
    if (FL.tab === 'stats') return wfStats(pane, alive);
    if (FL.tab === 'requests') return wfRequests(pane, alive);
    if (FL.tab === 'leads') return wfLeads(pane, alive);
    if (FL.tab === 'invites') return wfInvites(pane, alive);
    return wfBuild(pane, alive, editable);
  };
  drawPane();
  $('#wfName', el).oninput = (e) => { E.name = e.target.value; wfMark(); };
  el.onclick = async (e) => {
    const t = e.target;
    if (t.closest('[data-back]')) { if (FL.dirty && !(await confirmBox('Leave without saving?', 'Your latest changes here won\'t be kept.', 'Leave'))) return; FL.dirty = false; wfResetPreview(); appGo('flows'); return; }
    const tb = t.closest('.wf-tabs [data-tab]'); if (tb) { FL.tab = tb.dataset.tab; drawPane(); return; }
    const up = t.closest('[data-up]'); if (up && !t.closest('select')) { e.preventDefault(); e.stopPropagation(); wfUpgrade(up.dataset.up); return; }
    const lv = t.closest('#wfLive'); if (lv) { wfToggle(lv, el, alive); }
  };
}

async function wfToggle(btn, el, alive, replace, looked) {
  const E = FL.E;
  if (!canSend()) return;
  if (FL.dirty && !E.active) { toast('Save your changes first, then you can switch it on 🙂', { kind: 'info' }); setToggle(btn, E.active); return; }
  const on = !E.active;
  // A calm look first: "Everything looks good ✨" or "2 small things to check".
  if (on && !looked && !replace) {
    const tips = wfTips(E, { branding: FL.data.plan.branding, joinAdmin: FL.joinAdmin });
    if (tips.length) { setToggle(btn, false); wfTipsSheet(tips, { live: true, onGo: () => wfToggle(btn, el, alive, false, true) }); return; }
  }
  btn.disabled = true;
  try {
    const r = await POST('/api/flows/' + E.id + '/toggle', { active: on, replace: replace || undefined });
    E.active = r.active; setToggle(btn, E.active); $('#wfLiveL').textContent = E.active ? 'Live' : 'Draft';
    const party = E.active && typeof aurFirstLive === 'function' && aurFirstLive();
    toast(E.active ? (looked ? '' : 'Everything looks good ✨ ') + (wfIsBot(E) ? 'You\'re live! Your bot now answers everyone who taps Start through your link.' : 'You\'re live! Your bot now welcomes everyone who asks to join.') + (r.replaced ? (wfIsBot(E) ? ' The other bot with that link is a draft now.' : ' The other flow on this channel is a draft now.') : '') : 'Switched off. No worries, it\'s kept safe as a draft.');
    if (E.active && !party) confetti();
    refreshState();
  } catch (ex) {
    if ((ex.code === 'flow_live_clash' || ex.code === 'bot_live_clash') && on && !replace) {
      btn.disabled = false;
      if (await confirmBox('Switch to this flow?', esc(ex.message) + ' The other flow becomes a draft. Nothing is deleted.', 'Use this flow')) return wfToggle(btn, el, alive, true, true);
      return;
    }
    if (ex.code === 'bot_not_admin') { FL.admin = { ok: false, message: ex.message }; wfAdminBox(); toast(ex.message, { kind: 'err' }); }
    else if (ex.code === 'bot_not_admin_check') { toast(ex.message, { kind: 'err' }); wfJoinAdminCheck(true); }
    else wfErr(ex);
    setToggle(btn, E.active);
  } finally { btn.disabled = false; }
}

const WF_BOT_CODES = { plan_bot_type: null, limit_bots: 'bots', limit_bot_steps: 'bot_steps', limit_lead_questions: 'lead_questions', limit_menu_buttons: 'bot_buttons', limit_referral_bots: 'referral_bots' };
function wfErr(ex) {
  if (['plan_feature', 'limit_flows', 'limit_flow_steps'].includes(ex.code)) { wfUpgrade(ex.code === 'plan_feature' ? ((ex.data && ex.data.feature) || 'welcome_flows') : ex.code === 'limit_flows' ? 'flows' : 'welcome_flows', ex.message); return; }
  if (ex.code in WF_BOT_CODES) { wfUpgrade(ex.code === 'plan_bot_type' ? 'bot_' + ((ex.data && ex.data.bot_type) || 'lead_questions') : WF_BOT_CODES[ex.code], ex.message); return; }
  apiErr(ex);
}

function wfCasHtml() {
  return '<section class="fb-cas" id="fbCas"><div class="fb-cash"><span class="fb-casav" data-cas="wave"></span><div><b>Tell Cas what you want</b><small>Describe your flow in one sentence. Cas builds the messages, buttons and timing. You check it, then save.</small></div>' + (FL.E.id ? '<button type="button" class="ib" data-casx aria-label="Close"><svg><use href="#i-x"/></svg></button>' : '') + '</div>' +
    '<div class="fb-casin"><textarea class="inp" id="fbCasP" rows="2" maxlength="600" placeholder="Describe your flow in one sentence"></textarea><button type="button" class="btn b-blue" id="fbCasGo">' + icon('spark') + 'Build it' + (wfHas('ai') ? '' : ' ' + wfLock('ai')) + '</button></div>' +
    '<div class="fb-casx"><small>Try:</small>' + WF_CAS_EX.map((x) => '<button type="button" class="chb" data-casex="' + esc(x) + '">' + esc(x) + '</button>').join('') + '</div>' +
    '<p class="hint">Uses 1 AI write per message Cas writes.' + (wfHas('ai') ? '' : ' Cas is on Starter and up.') + '</p></section>';
}

function wfBuild(pane, alive, editable) {
  const E = FL.E, d = FL.data, plan = d.plan;
  const dis = editable ? '' : ' disabled';
  const bot = wfIsBot(E);
  const showCas = editable && !bot && (FL.cas || (!E.id && E.steps.length <= 1));
  const mode = WF_MODES.find((m) => m[0] === E.approve_mode) || WF_MODES[0];
  pane.innerHTML = '<div class="wf-cols fb-cols"><div class="wf-main">' +
    (E.trimmed ? '<div class="note2 warn"><span>ℹ️</span><span>' + (bot ? 'This template has more messages. Your ' + esc(plan.name) + ' plan sends 1 message per reply, so we kept what fits. <button type="button" class="lnk" data-up="bot_steps">See plans with follow-ups</button>' : 'This template has more messages. Your ' + esc(plan.name) + ' plan sends the welcome only, so we kept the first message. <button type="button" class="lnk" data-up="welcome_flows">See plans with follow-ups</button>') + '</span></div>' : '') +
    (E.paused_by_plan ? '<div class="note2 warn"><span>⏸️</span><span>This ' + (bot ? 'bot' : 'flow') + ' was switched off when your plan changed. Switch it on again when you are ready.</span></div>' : '') +
    (bot ? wfBotRoomHtml(E, d) : '') +
    (E.id ? wfBcastHtml(E) : '') +
    (showCas ? wfCasHtml() : '') +
    (bot ? wfBotSetHtml(E, d, dis, editable) : '') +
    (bot ? '' : (!E.id && editable && E.steps.length <= 1 ? '<div class="fb-tplrow"><small>Or start from a template:</small><div class="fb-tplc">' + d.templates.map((t) => '<button type="button" class="chb" data-tplq="' + esc(t.key) + '">' + esc(t.emoji) + ' ' + esc(t.name) + (wfTplLocked(t) ? ' ' + icon('lock') : '') + '</button>').join('') + '</div></div>' : '') +
    '<section class="box wf-set fb-set"><div class="row2b"><div class="field"><label for="wfChat">Channel or group</label><select class="inp" id="wfChat"' + dis + '>' + (d.chats.length ? '' : '<option value="">Connect a channel first</option>') + d.chats.map((c) => '<option value="' + c.id + '"' + (String(c.id) === String(E.chat_id) ? ' selected' : '') + '>' + esc(c.title || c.username || 'Untitled') + '</option>').join('') + '</select></div>' +
    '<div class="field"><label for="wfBot">Bot that sends it</label><select class="inp" id="wfBot"' + dis + '>' + (d.bots.length ? '' : '<option value="">Connect your bot first</option>') + d.bots.map((b) => '<option value="' + b.id + '"' + (String(b.id) === String(E.bot_id) ? ' selected' : '') + '>@' + esc(b.username || b.title) + '</option>').join('') + '</select></div></div>' +
    (!d.chats.length || !d.bots.length ? '<div class="row2b">' + (!d.chats.length ? '<button type="button" class="btn b-ghost sm" data-connect="channel">' + icon('plus') + 'Connect a channel</button>' : '') + (!d.bots.length ? '<button type="button" class="btn b-ghost sm" data-connect="bot">' + icon('plus') + 'Connect your bot</button>' : '') + '</div>' : '') +
    '<div id="wfAdmin"></div>' +
    '<div class="fb-how"><b class="fb-q">How do people get in?</b><div class="fb-modes" role="radiogroup">' + WF_MODES.map((m) => {
      const locked = m[4] && !wfHas(m[4]);
      return '<button type="button" role="radio" aria-checked="' + (E.approve_mode === m[0]) + '" class="fb-mode' + (E.approve_mode === m[0] ? ' on' : '') + (locked ? ' locked' : '') + '" data-mode="' + m[0] + '"' + dis + '>' + esc(m[1]) + (m[3] ? ' <span class="pill p-blue">' + m[3] + '</span>' : '') + (locked ? ' ' + wfLock(m[4]) : '') + '</button>';
    }).join('') + '</div><p class="fb-modeh">' + esc(mode[2]) + '</p></div>' +
    '<details class="wf-more"' + (E.invite_link ? ' open' : '') + '><summary>More options</summary><div class="field"><label for="wfLink">Only for people who use this invite link <span class="hint">(optional)</span></label><div class="slnew"><input class="inp" id="wfLink" placeholder="https://t.me/+AbC123xyz" value="' + esc(E.invite_link) + '"' + dis + '>' + (E.id && editable ? '<button type="button" class="btn b-ghost sm" id="wfMkLink">Make a link</button>' : '') + '</div><small class="hint">Give each ad its own link and its own flow. Leave empty to welcome everyone who asks to join.</small></div></details>' +
    '</section>') +
    '<div class="fb-listh"><h3>Your messages</h3><div class="fb-lha">' + (!bot && editable && E.id && typeof cbOpen === 'function' && CFG.features.cas_builder !== false ? '<button type="button" class="fb-cbo" data-cbopen>💬 Open Cas Builder</button>' : '') + (!bot && editable && !showCas ? '<button type="button" class="lnk" data-casopen>' + icon('spark') + 'Let Cas build it</button>' : '') + '</div></div>' +
    '<div class="fb-tools" id="wfTools"><button type="button" class="fb-tool pri" data-playall>▶ <span>Preview the whole ' + (bot ? 'bot' : 'flow') + '</span></button><button type="button" class="fb-tool" data-tsend>📲 <span>Send a test to my Telegram</span></button><span id="wfTestPill"></span><button type="button" class="fb-tipsum" id="wfTipSum" data-tipsum></button></div>' +
    '<div class="wf-rule" id="wfRule">' + wfRuleHtml(E) + '</div>' +
    '<section class="fb-list" id="wfStack"></section>' +
    '<p class="ferr" id="wfErr" hidden></p>' +
    (editable ? '<div class="wf-bar"><span class="muted" id="wfDirty">' + (FL.dirty ? 'Not saved yet' : E.id ? 'All saved ✓' : 'Not saved yet') + '</span><div class="row2b">' + (E.id ? '<button type="button" class="btn b-ghost sm" id="wfMore" aria-label="Duplicate">' + icon('copy') + '<span class="bt">Duplicate</span></button><button type="button" class="btn b-ghost sm danger" id="wfDel" aria-label="Delete">' + icon('trash') + '<span class="bt">Delete</span></button>' : '') + '<button type="button" class="btn b-ghost sm fb-try" data-tryit>' + icon('play') + 'Try it</button><button type="button" class="btn b-blue sm" id="wfSave">' + icon('check') + (E.id ? 'Save' : 'Save as draft') + '</button></div></div>' : '<p class="hint">Your role can look at flows. Ask the workspace owner to change them.</p>') +
    '</div><aside class="wf-side"><div class="pvw fb-pv"><div class="wf-pvh" id="wfPvh"><b>Try it</b><span class="hint">Tap the buttons like they would</span></div><div class="phone2"><div class="scr" data-simhost></div></div><p class="hint wf-pvn">"Ada" stands in for their first name. Waits are skipped with ⏩.</p></div></aside></div>' +
    '';
  if (showCas) paintCas(pane);
  FL.alive = alive;
  wfDrawStack(editable);
  wfSim();
  if (!bot) wfAdminCheck();
  wfJoinAdminCheck();
  wfWire(pane, alive, editable);
  wfTestPill();
  if (editable) wfTourSoon();
}

/** All the plan's bots are on: this one can be saved and tried, but switching it on needs room. Said before they build. */
function wfBotRoomHtml(E, d) {
  const b = wfBotLim(); const u = d.bot_usage || {};
  if (E.active || !b || !(b.max_bots >= 0) || (u.live || 0) < b.max_bots) return '';
  return '<div class="note2 info wf-room"><span>💡</span><span><b>Your ' + esc(d.plan.name || '') + ' plan runs ' + plural(b.max_bots, 'bot') + ' at once, and ' + (b.max_bots === 1 ? 'it is' : 'all are') + ' on.</b> You can still build this one, save it and try it. To switch it on, switch another bot off first, or <button type="button" class="lnk" data-up="bots">get room for more</button>.</span></div>';
}
/** A Chat bot's settings: the Telegram bot, its start link, and plain Start. */
function wfBotSetHtml(E, d, dis, editable) {
  const b = d.bots.find((x) => String(x.id) === String(E.bot_id));
  const link = 'https://t.me/' + (b ? b.username : 'yourbot') + '?start=' + (E.start_code || '');
  return '<section class="box wf-set fb-set bset"><div class="field"><label for="wfBot">Telegram bot people open</label><select class="inp" id="wfBot"' + dis + '>' + (d.bots.length ? '' : '<option value="">Connect your bot first</option>') + d.bots.map((x) => '<option value="' + x.id + '"' + (String(x.id) === String(E.bot_id) ? ' selected' : '') + '>@' + esc(x.username || x.title) + '</option>').join('') + '</select></div>' +
    (!d.bots.length ? '<button type="button" class="btn b-ghost sm" data-connect="bot">' + icon('plus') + 'Connect your bot</button>' : '') +
    '<div class="field"><label for="wfCode">Start link <span class="hint">(put it in your ads and posts)</span></label><div class="bs-link"><span class="bs-pre"><span class="bs-host">t.me/' + esc(b ? b.username : 'yourbot') + '</span><span>?start=</span></span><input class="inp" id="wfCode" value="' + esc(E.start_code || '') + '" maxlength="64" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="gift" aria-label="Start link code"' + dis + '></div>' +
    '<div class="row2b bs-acts"><button type="button" class="btn b-ghost sm" data-copylink="' + esc(link) + '">' + icon('copy') + 'Copy the link</button>' + (E.id && b ? '<a class="btn b-ghost sm" href="' + esc(link) + '" target="_blank" rel="noopener">' + icon('tg') + 'Open in Telegram</a>' : '') + '</div></div>' +
    '<label class="chkl bs-def"><input type="checkbox" id="wfDefault"' + (E.is_default ? ' checked' : '') + dis + '><span><b>Also answer a plain Start</b><small>For people who open @' + esc(b ? b.username : 'yourbot') + ' without your link.</small></span></label></section>';
}

function wfBcastHtml(E) {
  const n = E.started_count || 0;
  return '<div class="fb-bc' + (n ? '' : ' none') + '"><span class="fb-bci">📣</span><div><b>' + (n ? plural(n, 'person', 'people') + ' tapped Start' : 'Nobody has tapped Start yet') + '</b><small>' + (n ? 'You can message them any time.' : 'People who tap Start show here, and you can message them any time.') + '</small></div>' +
    (n ? '<button type="button" class="btn b-blue sm" data-bcast>📣 Broadcast to these people' + (wfHas('broadcasts') ? '' : ' ' + wfLock('broadcasts')) + '</button>' : '') + '</div>';
}

function wfGrow(ta) { if (!ta || !ta.isConnected) return; ta.style.height = 'auto'; ta.style.height = Math.min(Math.max(ta.scrollHeight + 2, 92), 420) + 'px'; }
function wfDrawStack(editable) {
  const E = FL.E;
  const stats = FL.stats && FL.stats.steps ? FL.stats.steps : null;
  const st = $('#wfStack'); if (!st) return;
  const tips = wfTips(E, { branding: FL.data.plan.branding, joinAdmin: FL.joinAdmin });
  st.innerHTML = stepsHtml(E, { editable, sel: FL.sel, has: wfHas, stats, photoOnly: FL.data.plan.branding && !wfIsBot(E), ai: typeof aiOn === 'function' && aiOn(), open: FL.open, adding: FL.adding, btab: FL.btab, flows: FL.data.startable || [], tips, chats: FL.data.chats || [], joinAdmin: FL.joinAdmin || {} });
  const sum = $('#wfTipSum');
  if (sum) { sum.className = 'fb-tipsum' + (tips.length ? ' some' : ' ok'); sum.innerHTML = tips.length ? '💡 ' + esc(wfTipsSummary(tips)) : esc(wfTipsSummary(tips)); sum.disabled = !tips.length; }
  $$('#wfStack [data-cc]').forEach((c) => { const i = +c.dataset.cc; const b = E.steps[i]; const cur = b.vsel ? b.variants[b.vsel - 1] : b; c.innerHTML = counterHtml(wfLenText(E, i, cur.body || ''), !!cur.media); });
  $$('#wfStack .fb-ta').forEach(wfGrow);
  $$('#wfStack img').forEach((im) => im.addEventListener('error', () => { const v = document.createElement('video'); v.src = im.src; v.muted = true; v.playsInline = true; im.replaceWith(v); }, { once: true }));
  const rule = $('#wfRule'); if (rule) rule.innerHTML = wfRuleHtml(E);
}

/* The tappable phone (on the right; on phones in a sheet from "▶ Try it"). FL.mode: 'try' (tap it yourself), 'step' (one
   message, as they see it: FL.pvStep) or 'play' (the whole flow plays like a short movie: FL.play). */
function wfReduced() { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } }
function wfNarrow() { try { return matchMedia('(max-width: 980px)').matches; } catch (_) { return false; } }
function wfSim() {
  const E = FL.E, d = FL.data;
  if (!E || !d) return;
  const bot = d.bots.find((x) => String(x.id) === String(E.bot_id));
  const o = { bot: bot ? bot.username : '', branding: d.plan.branding };
  let html;
  if (FL.mode === 'play' && FL.play) html = wfPlayHtml(E, FL.play, o);
  else if (FL.mode === 'step' && FL.pvStep != null && FL.pvStep < E.steps.length) html = wfStepPreviewHtml(E, FL.pvStep, o);
  else { FL.mode = 'try'; html = simHtml(E, simRun(E, FL.sim), o); }
  const head = $('#wfPvh');
  if (head) head.innerHTML = FL.mode === 'play' ? '<b>Your whole ' + (wfIsBot(E) ? 'bot' : 'flow') + '</b><span class="hint">It plays by itself and stops where they\'d tap</span>'
    : FL.mode === 'step' ? '<b>' + (FL.pvStep === 0 ? (wfIsBot(E) ? 'Your first message' : 'The welcome') : 'Message ' + (FL.pvStep + 1)) + '</b><span class="hint">Just as they see it in Telegram</span>'
      : '<b>Try it</b><span class="hint">Tap the buttons like they would</span>';
  $$('[data-simhost]').forEach((h) => {
    const old = $('[data-simscroll]', h);
    const keep = old ? old.scrollTop : 0;
    h.innerHTML = html;
    h.dataset.mode = FL.mode;
    // Enter sends a typed answer (Ask a question), in "Try it" and in the movie.
    $$('[data-simanswer],[data-playanswer]', h).forEach((inp) => { inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); const b = $(inp.dataset.simanswer != null ? '[data-simsend]' : '[data-playsend]', h); if (b) wfSimClick(b); } }; });
    const sc = $('[data-simscroll]', h); if (!sc) return;
    if (FL.mode === 'step') {
      const t = $('[data-pvtarget]', sc);
      sc.style.scrollBehavior = 'auto';
      sc.scrollTop = t ? Math.max(0, t.offsetTop - 8) : sc.scrollHeight;
      sc.style.scrollBehavior = '';
    } else if (FL.mode === 'play') {
      sc.style.scrollBehavior = 'auto'; sc.scrollTop = keep; sc.style.scrollBehavior = wfReduced() ? 'auto' : '';
      requestAnimationFrame(() => { sc.scrollTop = sc.scrollHeight; });
    } else sc.scrollTop = sc.scrollHeight;
  });
}
function wfSimEvent(ev) {
  FL.sim.push(ev);
  wfSim();
  if (ev.tap) { const b = wfButton(FL.E, ev.tap); if (b && b.kind === 'link') toast('In Telegram this opens ' + (fixUrl(b.url) || 'your link') + '. It counts as a tap too.', { kind: 'info' }); }
}
/* The phone in a bottom sheet (phones). */
function wfPhoneSheet(title, emoji, hint) {
  const h = sheet(esc(title), '<span class="spk">' + emoji + '</span>', (hint ? '<p class="hint fb-shh">' + hint + '</p>' : '') + '<div class="pvw fb-pv fb-pvs"><div class="phone2"><div class="scr" data-simhost></div></div></div>',
    { wide: true, onClose: () => { wfPlayStop(); FL.mode = 'try'; FL.play = null; FL.pvStep = null; wfSim(); } });
  $('.sb', h).onclick = (e) => { wfSimClick(e.target); };
  return h;
}
function wfShowPhone() {
  // The phone on the right stays in view (sticky); only bring it back if it is off the screen.
  const side = $('.wf-side .fb-pv'); if (!side) return;
  const r = side.getBoundingClientRect();
  if (r.bottom < 80 || r.top > window.innerHeight - 80) side.scrollIntoView({ behavior: wfReduced() ? 'auto' : 'smooth', block: 'nearest' });
}
/* "👁 Preview this step": the phone jumps to message i (the taps on the way are played for you). */
function wfPreviewStep(i) {
  wfPlayStop();
  FL.mode = 'step'; FL.pvStep = i; FL.play = null;
  if (wfNarrow()) { if (!$('#modalHost [data-simhost]')) wfPhoneSheet((i === 0 ? (wfIsBot(FL.E) ? 'Your first message' : 'The welcome') : 'Message ' + (i + 1)) + ', as they see it', '👁'); }
  else wfShowPhone();
  wfSim();
}

/* "▶ Preview the whole flow": a short movie. choices: taps made for you ({ start: true, <owner>: buttonId }). */
let wfPlayT = 0;
function wfPlayStop() { clearTimeout(wfPlayT); wfPlayT = 0; }
function wfPlayStart(choices) {
  wfPlayStop();
  FL.mode = 'play'; FL.pvStep = null;
  FL.play = { events: [], shown: 0, typing: false, paused: false, choices: choices || {}, picked: {} };
  if (wfNarrow()) { if (!$('#modalHost [data-simhost]')) wfPhoneSheet('Your whole ' + (wfIsBot(FL.E) ? 'bot' : 'flow'), '▶', 'Sit back: it plays by itself, and stops where they would tap.'); }
  else wfShowPhone();
  wfSim();
  wfPlayT = setTimeout(wfPlayTick, wfReduced() ? 100 : 500);
}
function wfPlayTap(ev) {
  const P = FL.play; if (!P) return;
  const sim = simRun(FL.E, P.events);
  if (ev.tap) { const g = wfGraph(FL.E)[sim.p]; if (g && g.group) P.picked[String(g.group.owner)] = ev.tap; }
  if (ev.start) P.picked.start = true;
  if (ev.joined) P.picked.joined = true;
  if (ev.answer !== undefined && sim.hold != null && wfValidate(((FL.E.steps[sim.hold] || {}).ask || {}).answer || 'text', ev.answer, (FL.E.steps[sim.hold] || {}).ask).ok) P.picked['a' + sim.hold] = ev.answer;
  P.events.push(ev);
}
function wfPlayTick() {
  const P = FL.play;
  wfPlayT = 0;
  if (!P || FL.mode !== 'play' || P.paused || !FL.E) return;
  const E = FL.E, red = wfReduced();
  const sim = simRun(E, P.events);
  if (P.shown < sim.log.length) {
    const it = sim.log[P.shown];
    if (it.k === 'bot' && !P.typing && !red) { P.typing = true; wfSim(); wfPlayT = setTimeout(wfPlayTick, 850); return; }
    P.typing = false; P.shown++; wfSim();
    wfPlayT = setTimeout(wfPlayTick, red ? 200 : it.k === 'bot' ? 1000 : it.later ? 1400 : 650);
    return;
  }
  const nx = wfPlayNext(E, P);
  if (nx.auto) { wfPlayTap(nx.auto); wfPlayT = setTimeout(wfPlayTick, red ? 100 : 500); return; }
  wfSim(); // waiting for a tap, or the end
}
function wfPlayClick(t) {
  const P = FL.play; if (!P) return false;
  const go = () => { P.paused = false; wfPlayStop(); wfSim(); wfPlayT = setTimeout(wfPlayTick, wfReduced() ? 100 : 350); };
  if (t.closest('[data-playx]')) { if ($('#modalHost [data-simhost]')) closeModal(); else { wfPlayStop(); FL.mode = 'try'; FL.play = null; wfSim(); } return true; }
  if (t.closest('[data-playpause]')) { P.paused = !P.paused; if (P.paused) { wfPlayStop(); wfSim(); } else go(); return true; }
  if (t.closest('[data-playre]')) { wfPlayStart({}); return true; }
  const ot = t.closest('[data-playother]'); if (ot) { const [o, id] = ot.dataset.playother.split(':'); wfPlayStart({ ...P.picked, start: true, [o]: id }); return true; }
  if (t.closest('[data-playnotap]')) { wfPlayTap({ skip: true }); go(); return true; }
  const nx = wfPlayNext(FL.E, P);
  const atEnd = P.shown >= simRun(FL.E, P.events).log.length && !P.typing;
  if (t.closest('[data-sims]')) { if (atEnd && nx.pause === 'start') { wfPlayTap({ start: true }); go(); } return true; }
  const pj = t.closest('[data-simjoin],[data-playjoin]');
  if (pj) { if (atEnd && nx.pause === 'joined') { wfPlayTap({ joined: (pj.dataset.simjoin || pj.dataset.playjoin) === '1' }); go(); } return true; }
  const pa = t.closest('[data-simans],[data-playsample],[data-playsend]');
  if (pa) {
    if (!(atEnd && nx.pause === 'answer')) return true;
    // (the send button itself is .sb: look in its bar / phone, not inside the button)
    const inp = $('[data-playanswer]', pa.closest('.fb-playbar,.scr') || document);
    const v = pa.dataset.simans != null ? pa.dataset.simans : pa.dataset.playsample != null ? pa.dataset.playsample : (inp ? inp.value : '');
    if (!String(v).trim()) { if (inp) inp.focus(); return true; }
    wfPlayTap({ answer: v }); go(); return true;
  }
  const tp = t.closest('[data-simt]');
  if (tp) {
    if (atEnd && nx.pause === 'button' && nx.choices.includes(tp.dataset.simt)) { wfPlayTap({ tap: tp.dataset.simt }); go(); }
    else if (atEnd && nx.pause) toast(nx.pause === 'start' ? 'Tap the Start button to continue 👆' : 'Pick one of the glowing buttons to continue 👆', { kind: 'info' });
    return true;
  }
  return false;
}

/* "Check they joined" steps: is the bot an admin of each chosen channel? (POST /api/bots/check-join; tips and the card say how to fix it.) */
async function wfJoinAdminCheck(force) {
  const E = FL.E; if (!E || !E.bot_id) return;
  FL.joinAdmin = FL.joinAdmin || {};
  if (FL.joinAdminBot !== String(E.bot_id)) { FL.joinAdmin = {}; FL.joinAdminBot = String(E.bot_id); }
  const ids = [...new Set(E.steps.filter((s) => wfKind(s) === 'check_join' && s.check && s.check.chat_id).map((s) => String(s.check.chat_id)))];
  let changed = false;
  for (const id of ids) {
    if (FL.joinAdmin[id] && !force) continue;
    try { FL.joinAdmin[id] = await POST('/api/bots/check-join', { bot_id: +E.bot_id, chat_id: +id }); } catch (e) { FL.joinAdmin[id] = { ok: false, message: e.message }; }
    changed = true;
  }
  if (changed && FL.E === E && $('#wfStack')) wfDrawStackKeep(canSend());
}

let wfAdminSeq = 0;
async function wfAdminCheck() {
  const E = FL.E;
  const box = $('#wfAdmin'); if (!box) return;
  if (!E.chat_id || !E.bot_id) { box.innerHTML = ''; return; }
  const my = ++wfAdminSeq;
  box.innerHTML = '<div class="wf-adm"><span class="spin"></span><span class="muted">Checking your bot is an admin of the channel…</span></div>';
  try { FL.admin = await POST('/api/flows/check', { bot_id: +E.bot_id, chat_id: +E.chat_id }); } catch (e) { FL.admin = { ok: false, message: e.message }; }
  if (my === wfAdminSeq) wfAdminBox();
}
function wfAdminBox() {
  const box = $('#wfAdmin'); if (!box || !FL.admin) return;
  const a = FL.admin;
  box.innerHTML = a.ok ? '<div class="wf-adm ok">' + icon('check') + '<span>Your bot is an admin and can let people in.</span></div>'
    : '<div class="wf-adm bad"><span>⚠️</span><div><b>One more step before it can go live</b><p>' + esc(a.message || '') + '</p><button type="button" class="btn b-ghost xs" data-recheck>' + icon('refresh') + 'Check again</button></div></div>';
}

function wfMark() { FL.dirty = true; const x = $('#wfDirty'); if (x) x.textContent = 'Not saved yet'; }
/* Can one more message be added? trig: its trigger when known (a Chat bot's menu answers don't count as messages). */
function wfCanAddMessage(trig) {
  if (wfIsBot(FL.E)) {
    if (trig === 'on_button' || trig === 'pick') return true;
    const b = wfBotLim(); if (!b || b.bot_steps < 0) return true;
    const msgs = FL.E.steps.filter((s, i) => (wfKind(s) === 'message' || wfKind(s) === 'referral') && wfTrig(FL.E, i) !== 'on_button').length;
    if (msgs >= b.bot_steps) { wfUpgrade('bot_steps'); return false; }
    return true;
  }
  const lim = wfLimit('flow_steps');
  if (lim === 1 || !wfHas('welcome_flows')) { wfUpgrade('welcome_flows'); return false; }
  if (lim > 0 && FL.E.steps.length >= lim) { wfUpgrade('flow_steps'); return false; }
  return true;
}
function wfBlank(trigger) { return { id: null, body: '', media: null, buttons: [], trigger, start_flow_id: null, condition: null, variants: [], vsel: 0 }; }

/** Set message i's trigger to type k (adds what it needs: a Tap Start button, a Reply button to answer). Returns false when the plan says no. */
function wfSetTrig(i, k) {
  const E = FL.E, s = E.steps[i];
  if (['on_start', 'on_button', 'no_response'].includes(k) && !wfHas('welcome_flows') && !wfIsBot(E)) { wfUpgrade('welcome_flows'); return false; }
  const old = s.trigger || {};
  if (k === 'on_goal') { s.trigger = { type: 'on_goal' }; return true; }
  if (k === 'wait') s.trigger = { type: 'wait', value: old.type === 'wait' && old.value ? old.value : 1, unit: old.type === 'wait' && old.unit ? old.unit : 'hour' };
  else if (k === 'no_response') s.trigger = { type: 'no_response', value: old.type === 'no_response' && old.value ? old.value : 10, unit: old.type === 'no_response' && old.unit ? old.unit : 'min' };
  else if (k === 'on_button') s.trigger = { type: 'on_button', button: old.type === 'on_button' ? old.button : wfFreeButton(i) };
  else s.trigger = { type: k };
  if (k === 'on_start' && !wfStartOn(E)) {
    if (!wfHas('tap_to_start')) { wfUpgrade('tap_to_start'); s.trigger = old.type ? old : { type: 'after_previous' }; return false; }
    E.start_button = true; FL.addedStart = true;
  }
  if (k === 'no_response') { const g = wfGraph(E)[i]; if (!g.awaits.start && !g.awaits.buttons.length) { wfAddReply(wfAnchorMsg(E, i)); FL.addedReply = true; } }
  return true;
}
/** A button of the message above that no answer uses yet (adds a Reply button when there is none). */
function wfFreeButton(i) {
  const E = FL.E;
  const owner = wfAnchorMsg(E, i);
  const used = new Set(E.steps.filter((x, k) => k !== i && x.trigger && x.trigger.type === 'on_button').map((x) => x.trigger.button));
  const free = (E.steps[owner].buttons || []).find((b) => !used.has(b.id));
  if (free) return free.id;
  const b = wfAddReply(owner);
  FL.addedReply = owner + 1;
  return b.id;
}
/* Buttons per message. Chat bots: the plan's menu buttons (Free 4, Starter 8, Growth 12, Scale 12; services/flows.js
   botMaxButtons), of which at most 6 can be Link buttons (Telegram check, broadcasts.checkMessage); the rest are Reply
   (tap-to-answer) buttons. Welcome bots: 3 on Free, 6 on paid plans, as before. */
function wfMaxButtons(E) {
  if (wfIsBot(E)) { const b = wfBotLim(); const n = b ? b.menu_buttons : 12; return n == null || n < 0 ? 12 : Math.min(12, n); }
  return FL.data.plan.branding ? 3 : 6;
}
function wfLinkCount(m) { return (m.buttons || []).filter((b) => b.kind !== 'reply').length; }
/* Room for one more button on message m? Says why not (upgrade sheet or a gentle toast). */
function wfButtonRoom(E, m) {
  const max = wfMaxButtons(E);
  if ((m.buttons || []).length < max) return true;
  if (wfIsBot(E)) {
    if (max < 12) wfUpgrade('bot_buttons', 'Your ' + FL.data.plan.name + ' plan allows ' + max + ' buttons on a bot message. Bigger plans allow up to 12.');
    else toast('12 buttons is the most a bot message can have. That\'s plenty!', { kind: 'info' });
  } else if (FL.data.plan.branding) wfUpgrade('buttons'); else toast('6 buttons is the most a message can have. That\'s plenty!', { kind: 'info' });
  return false;
}
const WF_LINK_HINT = 'A message can have up to 6 link buttons. More buttons can be 💬 Reply buttons: people tap them and your bot answers.';
function wfAddReply(owner) {
  const s = FL.E.steps[owner];
  const b = { id: wfId(), label: s.buttons.filter((x) => x.kind === 'reply').length ? 'Option ' + (s.buttons.filter((x) => x.kind === 'reply').length + 1) : 'Option 1', url: '', kind: 'reply', row: null };
  s.buttons.push(b);
  return b;
}

/* A soft word after picking when a message comes ("Nice! This message goes out the moment they tap Start."). */
const WF_NICE = {
  after_previous: 'Nice! This one goes out right after the message above.',
  wait: 'Nice! It waits, then goes out by itself. You can change the time anytime.',
  on_start: 'Nice! This message goes out the moment they tap Start.',
  on_button: 'Nice! This one arrives when they tap the button you pick.',
  no_response: 'Nice! A gentle reminder, only if they haven\'t tapped yet.',
};
function wfNiceToast(k) {
  let extra = '';
  if (FL.addedStart) extra = ' We added a Tap Start button to the welcome for you.';
  else if (FL.addedReply) extra = ' We added a Reply button' + (typeof FL.addedReply === 'number' ? ' to message ' + FL.addedReply : ' above') + ': give it a name.';
  FL.addedStart = false; FL.addedReply = false;
  if (WF_NICE[k]) toast(WF_NICE[k] + extra, { kind: 'info' });
}
function wfWire(pane, alive, editable) {
  const E = FL.E;
  const st = $('#wfStack');
  const cur = (i) => { const b = E.steps[i]; return b.vsel ? b.variants[b.vsel - 1] : b; };
  const redraw = () => { wfDrawStack(editable); wfSim(); };
  let simT = 0;
  const simSoon = () => { clearTimeout(simT); simT = setTimeout(wfSim, 120); };
  pane.onchange = (e) => {
    const t = e.target;
    if (t.id === 'wfChat') { E.chat_id = t.value; wfMark(); wfAdminCheck(); }
    if (t.id === 'wfBot') { E.bot_id = t.value; wfMark(); if (wfIsBot(E)) { wfBuild(pane, alive, editable); wfMark(); } else { wfAdminCheck(); wfSim(); wfJoinAdminCheck(); } }
    if (t.id === 'wfDefault') { E.is_default = t.checked; wfMark(); }
    // Special steps (Check they joined, Ask a question, Invite friends)
    if (t.dataset.ckchat != null) { const s = E.steps[+t.dataset.ckchat]; s.check.chat_id = t.value; s.check.link = ''; wfMark(); redraw(); wfJoinAdminCheck(); }
    if (t.dataset.rem != null) { const s = E.steps[+t.dataset.rem]; const c = wfKind(s) === 'ask' ? s.ask : s.check; c.remind = t.checked ? { value: 10, unit: 'min' } : null; wfMark(); redraw(); }
    if (t.dataset.remv != null) { const s = E.steps[+t.dataset.remv]; const c = wfKind(s) === 'ask' ? s.ask : s.check; if (c.remind) c.remind.value = Math.min(999, Math.max(1, parseInt(t.value, 10) || 1)); wfMark(); redraw(); }
    if (t.dataset.remu != null) { const s = E.steps[+t.dataset.remu]; const c = wfKind(s) === 'ask' ? s.ask : s.check; if (c.remind) c.remind.unit = t.value; wfMark(); redraw(); }
    if (t.dataset.rgoal != null) { E.steps[+t.dataset.rgoal].referral.goal = Math.min(1000, Math.max(1, parseInt(t.value, 10) || 3)); wfMark(); redraw(); }
    if (t.dataset.tu != null) { E.steps[+t.dataset.tu].trigger.unit = t.value; wfMark(); redraw(); }
    if (t.dataset.tv != null) { const tr = E.steps[+t.dataset.tv].trigger; tr.value = Math.min(999, Math.max(1, parseInt(t.value, 10) || 1)); wfMark(); redraw(); }
    if (t.dataset.tb != null) { E.steps[+t.dataset.tb].trigger.button = t.value; wfMark(); redraw(); }
    // A button's text is shown on the choice tabs and in "Sends when they tap ...": redraw once it is typed.
    if (t.dataset.bl != null) { const [i, bi] = t.dataset.bl.split(':').map(Number); const b = cur(i).buttons[bi]; if (b && E.steps.some((x) => x.trigger && x.trigger.type === 'on_button' && x.trigger.button === b.id)) wfDrawStackKeep(editable); }
    if (t.dataset.cond != null) {
      if (t.value && !wfHas('condition_clicked')) { t.value = ''; wfUpgrade('condition_clicked'); return; }
      E.steps[+t.dataset.cond].condition = t.value || null; wfMark();
    }
  };
  pane.oninput = (e) => {
    const t = e.target;
    if (t.id === 'wfLink') { E.invite_link = t.value.trim(); wfMark(); }
    if (t.id === 'wfCode') { E.start_code = t.value.trim(); wfMark(); const b = FL.data.bots.find((x) => String(x.id) === String(E.bot_id)); const cp = $('[data-copylink]', pane); if (cp) cp.dataset.copylink = 'https://t.me/' + (b ? b.username : 'yourbot') + '?start=' + E.start_code; }
    const fld = (attr, set) => { if (t.dataset[attr] == null) return false; const [i, n] = t.dataset[attr].split(':').map(Number); set(E.steps[i], t.value, n); wfMark(); FL.sel = i; simSoon(); wfTipsSoon(); return true; };
    fld('ckopen', (s, v) => { s.check.open_label = v; });
    fld('ckjoin', (s, v) => { s.check.join_label = v; });
    fld('cknudge', (s, v) => { s.check.nudge = v; });
    fld('remt', (s, v) => { (wfKind(s) === 'ask' ? s.ask : s.check).remind_text = v; });
    fld('alabel', (s, v) => { s.ask.label = v; });
    fld('aretry', (s, v) => { s.ask.retry_text = v; });
    fld('ach', (s, v, n) => { s.ask.choices[n] = v; });
    if (t.dataset.sl != null) { E.start_label = t.value; wfMark(); simSoon(); }
    if (t.dataset.tv != null) { const sel = $('[data-tu="' + t.dataset.tv + '"]', st); if (sel) sel.innerHTML = wfUnitOptions(parseInt(t.value, 10) || 0, sel.value); }
    if (t.dataset.body != null) {
      const i = +t.dataset.body; const m = cur(i); m.body = t.value; wfMark(); wfGrow(t);
      const c = $('[data-cc="' + i + '"]', st); if (c) { c.innerHTML = counterHtml(wfLenText(E, i, t.value), !!m.media); c.classList.toggle('bad', visibleLength(wfLenText(E, i, t.value)) > (m.media ? 1024 : 4096)); }
      FL.sel = i; simSoon(); wfTipsSoon();
    }
    if (t.dataset.bl != null || t.dataset.bu != null) {
      const [i, bi] = (t.dataset.bl || t.dataset.bu).split(':').map(Number);
      const b = cur(i).buttons[bi]; if (!b) return;
      if (t.dataset.bl != null) b.label = t.value; else b.url = t.value;
      wfMark(); FL.sel = i; simSoon(); wfTipsSoon();
    }
  };
  // A button never selects its card on focus: selecting reflows the cards above (the old one closes), so the tap
  // would land somewhere else and the first tap on 🗑 or ↑ only selected the card. The click selects it instead.
  pane.addEventListener('focusin', (e) => { if (e.target.closest('[data-tipfix]') || e.target.closest('button')) return; /* the card moves when it opens: the tap must land on Fix it */ const blk = e.target.closest('.fb-card'); if (blk && +blk.dataset.i !== FL.sel) { FL.sel = +blk.dataset.i; $$('.fb-card', st).forEach((x) => x.classList.toggle('sel', +x.dataset.i === FL.sel)); } });
  pane.onclick = async (e) => {
    const t = e.target;
    // The phone (also in the sheet: see wfTryIt)
    if (wfSimClick(t)) return;
    if (t.closest('[data-tryit]')) { wfTryIt(); return; }
    const pv = t.closest('[data-pvstep]'); if (pv) { wfPreviewStep(+pv.dataset.pvstep); return; }
    if (t.closest('[data-playall]')) { wfPlayStart({}); return; }
    if (t.closest('[data-tsend]')) { wfTestSend(t.closest('[data-tsend]')); return; }
    if (t.closest('[data-topen]')) { wfTestSheet(); return; }
    if (t.closest('[data-tipsum]')) { wfTipsSheet(wfTips(E, { branding: FL.data.plan.branding, joinAdmin: FL.joinAdmin }), { title: null }); return; }
    if (t.closest('[data-recheck]')) { wfAdminCheck(); return; }
    const up = t.closest('[data-up]'); if (up && !t.closest('select')) { e.preventDefault(); e.stopPropagation(); wfUpgrade(up.dataset.up); return; }
    if (t.closest('[data-bcast]')) { wfBroadcast(t.closest('[data-bcast]')); return; }
    if (t.closest('[data-cbopen]')) { if (FL.dirty) { toast('Save your changes first, then Cas can carry on from there 🙂', { kind: 'info' }); return; } cbOpen({ flowId: E.id }); return; }
    if (t.closest('[data-casopen]')) { FL.cas = true; wfBuild(pane, alive, editable); const p = $('#fbCasP'); if (p) p.focus(); return; }
    if (t.closest('[data-casx]')) { FL.cas = false; wfBuild(pane, alive, editable); return; }
    const cx = t.closest('[data-casex]'); if (cx) { const p = $('#fbCasP'); p.value = cx.dataset.casex; p.focus(); return; }
    if (t.closest('#fbCasGo')) { wfCasBuild(t.closest('#fbCasGo'), pane, alive, editable); return; }
    const tq = t.closest('[data-tplq]'); if (tq) {
      const tpl = FL.data.templates.find((x) => x.key === tq.dataset.tplq);
      if (tpl && wfTplLocked(tpl)) { wfUpgrade(tpl.start_button && !wfHas('tap_to_start') ? 'tap_to_start' : 'welcome_flows'); return; }
      if (FL.dirty && !(await confirmBox('Use this template?', 'It replaces the messages you have now. You can change every word after.', 'Use it'))) return;
      const keep = { chat_id: E.chat_id, bot_id: E.bot_id };
      FL.E = Object.assign(wfNew(tq.dataset.tplq), keep); FL.sim = []; FL.open = -1; FL.adding = false; FL.cas = false; FL.dirty = true;
      wfBuild(pane, alive, editable); wfMark(); toast('Template ready! Make the words your own, then save.'); return;
    }
    const md = t.closest('button[data-mode]'); // not the preview host (data-simhost has data-mode too)
    if (md && editable) {
      const m = WF_MODES.find((x) => x[0] === md.dataset.mode);
      if (m[4] && !wfHas(m[4])) { wfUpgrade(m[4]); return; }
      const lbl = (E.start_label || '').trim();
      if (m[0] === 'tap' && (!lbl || lbl === '👆 Tap Start')) E.start_label = '✅ Tap to join';
      else if (m[0] !== 'tap' && E.approve_mode === 'tap' && lbl === '✅ Tap to join') E.start_label = '👆 Tap Start';
      E.approve_mode = m[0]; wfMark(); FL.sim = []; wfBuild(pane, alive, editable); return;
    }
    if (t.closest('#wfMkLink')) { wfMakeLink(t.closest('#wfMkLink')); return; }
    const cl = t.closest('[data-copylink]'); if (cl) { copyText(cl.dataset.copylink, 'Start link copied'); return; }
    const ckr = t.closest('[data-ckrecheck]'); if (ckr) { wfJoinAdminCheck(true); return; }
    if (!editable) return;
    const ak = t.closest('[data-akind]'); if (ak) {
      const [i, k] = ak.dataset.akind.split(':'); const a = E.steps[+i].ask;
      a.answer = k; if (k === 'choice' && !(a.choices || []).filter((x) => String(x).trim()).length) a.choices = ['Yes', 'No'];
      wfMark(); FL.sim = []; redraw(); return;
    }
    const aca = t.closest('[data-achadd]'); if (aca) { const a = E.steps[+aca.dataset.achadd].ask; if ((a.choices || []).length < 8) a.choices.push(''); wfMark(); redraw(); const ins = $$('[data-ach^="' + aca.dataset.achadd + ':"]', st); if (ins.length) ins[ins.length - 1].focus(); return; }
    const acx = t.closest('[data-achx]'); if (acx) { const [i, n] = acx.dataset.achx.split(':').map(Number); E.steps[i].ask.choices.splice(n, 1); wfMark(); FL.sim = []; redraw(); return; }
    const tk = t.closest('[data-tok]'); if (tk) { const [i, tok] = [tk.dataset.tok.split(':')[0], tk.dataset.tok.slice(tk.dataset.tok.indexOf(':') + 1)]; insertAtCaret($('[data-body="' + i + '"]', st), tok); return; }
    const ads = t.closest('[data-adds]'); if (ads) {
      const k = ads.dataset.adds;
      if (WF_KIND_TYPE[k] && !wfBotHas(WF_KIND_TYPE[k])) { wfUpgrade('bot_' + WF_KIND_TYPE[k]); return; }
      if (!wfIsBot(E) && !wfCanAddMessage()) return;
      const s = wfBlank({ type: 'after_previous' });
      s.type = k;
      if (k === 'check_join') { s.check = { chat_id: FL.data.chats[0] ? FL.data.chats[0].id : '', open_label: '', join_label: '', link: '', nudge: '', remind: null, remind_text: '' }; s.body = 'Please join our channel first 👇 Then tap "I\'ve joined".'; }
      if (k === 'ask') { s.ask = { answer: 'text', choices: [], label: '', button: '', retry_text: '', remind: null, remind_text: '' }; s.body = ''; }
      if (k === 'referral') { s.referral = { goal: 3 }; s.body = 'Invite {goal} friends and get a gift 🎁\n\nYour own link:\n{invite_link}\n\nFriends joined so far: {invites} of {goal}'; }
      E.steps.push(s);
      const i = E.steps.length - 1;
      if (k === 'referral') { const rw = wfBlank({ type: 'on_goal' }); rw.body = '🎉 You did it, {name}! Here is your reward 👇'; E.steps.push(rw); }
      FL.adding = false; FL.sel = i; FL.open = -1; FL.sim = [];
      wfMark(); redraw(); wfJoinAdminCheck();
      toast(k === 'check_join' ? 'Nice! Your bot checks they joined before going on.' : k === 'ask' ? 'Nice! Write your question, then pick the kind of answer.' : 'Nice! We added the reward message right after it, too.', { kind: 'info' });
      const ta = $('[data-body="' + i + '"]', st); if (ta) { ta.focus(); ta.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      return;
    }
    if (t.closest('[data-starton]')) { if (!wfHas('tap_to_start')) { wfUpgrade('tap_to_start'); return; } E.start_button = true; wfMark(); redraw(); return; }
    if (t.closest('[data-startx]')) {
      if (E.steps.some((s, i) => wfTrig(E, i) === 'on_start')) { toast('A message arrives "when they tap Start", so the button is needed. Change that message first, then you can remove it.', { kind: 'info' }); return; }
      E.start_button = false; wfMark(); FL.sim = []; redraw(); return;
    }
    // "When should the next message come?"
    const cn = t.closest('[data-conn]'); if (cn) { const i = +cn.dataset.conn; FL.open = FL.open === i ? -1 : i; FL.adding = false; wfDrawStack(editable); return; }
    const tt = t.closest('[data-tt]'); if (tt) {
      const [i, k] = tt.dataset.tt.split(':'); const n = +i;
      if (wfSetTrig(n, k)) { wfMark(); FL.sim = []; if (k === 'after_previous' || k === 'on_start') FL.open = -1; redraw(); wfNiceToast(k); }
      return;
    }
    const tf = t.closest('[data-tipfix]'); if (tf && typeof CasEngine !== 'undefined') {
      const i = +tf.dataset.tipfix; const m = E.steps[i]; if (!m) return;
      const before = m.body; const fixed = CasEngine.fixDirections(wfDraftOf(E), i);
      if (!fixed || fixed === before) return;
      m.body = fixed; FL.sel = i; wfMark(); redraw();
      toast('Fixed ✓ It points the right way now.', { action: { label: 'Undo', onClick: () => { E.steps[i].body = before; wfMark(); redraw(); } } });
      return;
    }
    const tbp = t.closest('[data-tbp]'); if (tbp) { const [i, id] = tbp.dataset.tbp.split(':'); E.steps[+i].trigger.button = id; wfMark(); FL.open = -1; redraw(); return; }
    const ar = t.closest('[data-addreply]'); if (ar) { const [o, i] = ar.dataset.addreply.split(':').map(Number); const b = wfAddReply(o); E.steps[i].trigger = { type: 'on_button', button: b.id }; wfMark(); redraw(); const inp = $('[data-bl="' + o + ':' + (E.steps[o].buttons.length - 1) + '"]', st); if (inp) { inp.focus(); inp.select(); } return; }
    if (t.closest('[data-addnext]')) { if (!wfCanAddMessage('pick')) return; FL.adding = true; FL.open = -1; wfDrawStack(editable); const a = $('.fb-addw', st); if (a) a.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    if (t.closest('[data-addx]')) { FL.adding = false; wfDrawStack(editable); return; }
    const at = t.closest('[data-addt]'); if (at) {
      if (!wfCanAddMessage(at.dataset.addt)) return;
      E.steps.push(wfBlank({ type: 'after_previous' }));
      const i = E.steps.length - 1;
      if (!wfSetTrig(i, at.dataset.addt)) { E.steps.pop(); return; }
      if (!FL.cas) { const cb = $('#fbCas'); if (cb) cb.remove(); }
      FL.adding = false; FL.sel = i; FL.open = ['wait', 'no_response', 'on_button'].includes(at.dataset.addt) ? i : -1; FL.sim = [];
      const g = wfGraph(E)[i].group; if (g) FL.btab[String(g.owner)] = i;
      wfMark(); redraw(); wfNiceToast(at.dataset.addt);
      const ta = $('[data-body="' + i + '"]', st); if (ta) { ta.focus(); ta.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      return;
    }
    // Choices: tabs
    const bt = t.closest('[data-btab]'); if (bt) { const [k, i] = bt.dataset.btab.split(':'); FL.btab[k] = +i; FL.sel = +i; wfDrawStack(editable); return; }
    const bad = t.closest('[data-badd]'); if (bad) {
      if (!wfCanAddMessage('on_button')) return;
      const first = +bad.dataset.badd; const g = wfGraph(E)[first].group;
      { const own = E.steps[g.owner]; const used = new Set(g.members.map((k) => E.steps[k].trigger.button)); if (own && !own.buttons.some((b) => !used.has(b.id)) && !wfButtonRoom(E, own)) return; }
      const at2 = Math.max(...g.members) + 1;
      const s = wfBlank({ type: 'on_button', button: null });
      E.steps.splice(at2, 0, s);
      s.trigger.button = (() => { const used = new Set(g.members.map((k) => E.steps[k].trigger.button)); const own = E.steps[g.owner]; const free = own && own.buttons.find((b) => !used.has(b.id)); return free ? free.id : wfAddReply(g.owner).id; })();
      FL.btab[String(g.owner)] = at2; FL.sel = at2; FL.sim = []; wfMark(); redraw();
      const ta = $('[data-body="' + at2 + '"]', st); if (ta) ta.focus();
      return;
    }
    const sel = t.closest('.fb-card');
    if (sel && !t.closest('input,select,textarea') && +sel.dataset.i !== FL.sel) { FL.sel = +sel.dataset.i; $$('.fb-card', st).forEach((x) => x.classList.toggle('sel', +x.dataset.i === FL.sel)); }
    const u2 = t.closest('[data-up2]'); if (u2) { wfMove(+u2.dataset.up2, -1); redraw(); return; }
    const dn = t.closest('[data-dn]'); if (dn) { wfMove(+dn.dataset.dn, 1); redraw(); return; }
    const du = t.closest('[data-dup]'); if (du) {
      if (!wfCanAddMessage(wfTrig(E, +du.dataset.dup) === 'on_button' ? 'after_previous' : wfTrig(E, +du.dataset.dup))) return;
      const i = +du.dataset.dup; const copy = JSON.parse(JSON.stringify(E.steps[i]));
      copy.id = null; copy.variants = []; copy.vsel = 0; copy.buttons.forEach((b) => { b.id = wfId(); delete b.code; });
      if (copy.trigger && copy.trigger.type === 'on_button') copy.trigger = { type: 'after_previous' };
      E.steps.splice(i + 1, 0, copy); FL.sel = i + 1; FL.sim = []; wfMark(); redraw(); toast('Copied! It\'s right below.'); return;
    }
    const dl = t.closest('[data-del]'); if (dl) {
      const i = +dl.dataset.del; const s = E.steps[i];
      const ids = new Set((s.buttons || []).map((b) => b.id));
      const users = E.steps.filter((x, k) => k !== i && x.trigger && x.trigger.type === 'on_button' && ids.has(x.trigger.button)).length;
      if ((s.body || '').trim() && !(await confirmBox('Delete message ' + (i + 1) + '?', users ? 'Its buttons have answers below. Those answers will come right away instead.' : 'No worries: nothing changes for real until you save.', 'Delete', true))) return;
      E.steps.forEach((x, k) => { if (k !== i && x.trigger && x.trigger.type === 'on_button' && ids.has(x.trigger.button)) x.trigger = { type: 'after_previous' }; });
      E.steps.splice(i, 1); FL.sel = Math.max(0, Math.min(FL.sel, E.steps.length - 1)); FL.open = -1; FL.sim = []; wfMark(); redraw(); return;
    }
    const vt = t.closest('[data-vt]'); if (vt) { const [i, k] = vt.dataset.vt.split(':').map(Number); E.steps[i].vsel = k; FL.sel = i; redraw(); return; }
    const va = t.closest('[data-vadd]'); if (va) {
      const i = +va.dataset.vadd; const b = E.steps[i]; const need = b.variants.length ? 'ab_welcome_4' : 'ab_welcome_2';
      if (!wfHas(need)) { wfUpgrade(need); return; }
      b.variants.push({ body: b.body, media: b.media, buttons: (b.buttons || []).map((x) => ({ ...x, code: undefined })) }); b.vsel = b.variants.length; FL.sel = i; wfMark(); redraw(); return;
    }
    const vd = t.closest('[data-vdel]'); if (vd) { const [i, k] = vd.dataset.vdel.split(':').map(Number); E.steps[i].variants.splice(k - 1, 1); E.steps[i].vsel = 0; wfMark(); redraw(); return; }
    const nm = t.closest('[data-nm]'); if (nm) { insertAtCaret($('[data-body="' + nm.dataset.nm + '"]', st), '{name}'); return; }
    const aw = t.closest('[data-aiw]'); if (aw) {
      const i = +aw.dataset.aiw;
      if (!wfHas('ai')) { wfUpgrade('ai'); return; }
      openAIWrite((text) => {
        const m = cur(i); const before = m.body; m.body = text; FL.sel = i; wfMark(); redraw();
        toast('Cas wrote it ✨ Change anything you like.', { action: { label: 'Undo', onClick: () => { cur(i).body = before; wfMark(); redraw(); } } });
      }, !!cur(i).media, { kind: i === 0 ? 'welcome' : 'followup', placeholder: i === 0 ? 'For example: Welcome new members to my fashion channel. Tell them new drops come every Friday.' : 'For example: Thank them for tapping Start and invite them to the VIP group.' });
      return;
    }
    const ba = t.closest('[data-ba]'); if (ba) {
      const i = +ba.dataset.ba; const m = cur(i);
      if (!wfButtonRoom(E, m)) return;
      // Past 6 Link buttons, a new one is a Reply button (Telegram's link limit), with a gentle word why.
      const asReply = wfIsBot(E) && wfLinkCount(m) >= WF_MAX_LINKS;
      if (asReply) toast(WF_LINK_HINT, { kind: 'info' });
      m.buttons.push({ id: wfId(), label: '', url: '', kind: asReply ? 'reply' : 'link', row: null }); FL.sel = i; wfMark(); redraw();
      const ins = $$('[data-bl^="' + i + ':"]', st); if (ins.length) ins[ins.length - 1].focus(); return;
    }
    const bk = t.closest('[data-bk]'); if (bk) {
      const [i, bi, k] = bk.dataset.bk.split(':'); const b = cur(+i).buttons[+bi];
      if (k === 'reply' && !wfHas('welcome_flows') && !wfIsBot(E)) { wfUpgrade('welcome_flows'); return; }
      if (k === 'link' && b.kind === 'reply' && wfLinkCount(cur(+i)) >= WF_MAX_LINKS) { toast(WF_LINK_HINT, { kind: 'info' }); return; }
      if (b.kind !== k) { b.kind = k; wfMark(); FL.sim = []; redraw(); }
      return;
    }
    const bx = t.closest('[data-bx]'); if (bx) {
      const [i, bi] = bx.dataset.bx.split(':').map(Number); const m = cur(i); const b = m.buttons[bi];
      const users = E.steps.filter((x) => x.trigger && x.trigger.type === 'on_button' && x.trigger.button === b.id);
      if (users.length && !(await confirmBox('Remove "' + (b.label || 'this button') + '"?', 'A message answers this button. No worries: it will simply come right away instead.', 'Remove'))) return;
      users.forEach((x) => { x.trigger = { type: 'after_previous' }; });
      m.buttons.splice(bi, 1); wfMark(); FL.sim = []; redraw(); return;
    }
    const em = t.closest('[data-emo]'); if (em) { wfEmoji(em, (x) => { const [i, bi] = em.dataset.emo.split(':').map(Number); const b = cur(i).buttons[bi]; b.label = (x + ' ' + String(b.label || '').replace(/^\S+\s/, (s) => (/^[\p{Extended_Pictographic}☀-➿]/u.test(s) ? '' : s))).trim(); wfMark(); redraw(); }); return; }
    const mx = t.closest('[data-mx]'); if (mx) { cur(+mx.dataset.mx).media = null; wfMark(); redraw(); return; }
    const ma = t.closest('[data-ma]'); if (ma) {
      const i = +ma.dataset.ma;
      const fin = document.createElement('input'); fin.type = 'file'; fin.accept = FL.data.plan.branding ? 'image/jpeg,image/png,image/webp' : 'image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime';
      fin.onchange = async () => { const f = fin.files[0]; if (!f) return; const m = await pickAndUpload(f, $('[data-upl="' + i + '"]', st)); if (m) { cur(i).media = m; wfMark(); } redraw(); };
      fin.click(); return;
    }
    const sf = t.closest('[data-sf]'); if (sf) { wfPickFlow(+sf.dataset.sf, redraw); return; }
    const sfx = t.closest('[data-sfx]'); if (sfx) { E.steps[+sfx.dataset.sfx].start_flow_id = null; wfMark(); redraw(); return; }
    if (t.closest('#wfSave')) { wfSave(t.closest('#wfSave'), alive); return; }
    if (t.closest('#wfDel')) {
      if (!(await confirmBox('Delete "' + E.name + '"?', 'It stops at once and its numbers are removed. Links people already got keep working. This can\'t be undone.', 'Delete', true))) return;
      try { await api('DELETE', '/api/flows/' + E.id); FL.dirty = false; toast('Deleted.'); refreshState(); appGo('flows'); } catch (ex) { apiErr(ex); }
      return;
    }
    if (t.closest('#wfMore')) {
      if (FL.dirty) { toast('Save your changes first, then you can copy it 🙂', { kind: 'info' }); return; }
      try { const r = await POST('/api/flows/' + E.id + '/duplicate'); toast('Copied as a draft.'); appGo('flows', { id: r.id }); } catch (ex) { wfErr(ex); }
    }
  };
}
/* Redraw after a button's text changed (tabs and "Which button?" show it), keeping the scroll place. */
function wfDrawStackKeep(editable) { const y = window.scrollY; wfDrawStack(editable); window.scrollTo(0, y); }

/* Taps on the preview phone. Returns true when it handled the click. */
function wfSimClick(t) {
  if (FL.mode === 'play' && wfPlayClick(t)) return true;
  if (FL.mode === 'step' && t.closest('[data-sims],[data-simt],[data-simskip],[data-simjoin],[data-simans],[data-simsend],[data-simref]')) {
    // Tapping in a step preview: carry on from there, like trying it yourself.
    FL.sim = wfPathTo(FL.E, FL.pvStep).events.slice(); FL.mode = 'try'; FL.pvStep = null;
  }
  if (t.closest('[data-sims]')) { wfSimEvent({ start: true }); return true; }
  const sj = t.closest('[data-simjoin]'); if (sj) { wfSimEvent({ joined: sj.dataset.simjoin === '1' }); return true; }
  const sa = t.closest('[data-simans]'); if (sa) { wfSimEvent({ answer: sa.dataset.simans }); return true; }
  if (t.closest('[data-simsend]')) { const inp = $('[data-simanswer]', t.closest('.scr') || document); const v = inp ? inp.value : ''; if (!String(v).trim()) { if (inp) inp.focus(); return true; } wfSimEvent({ answer: v }); return true; }
  if (t.closest('[data-simref]')) { wfSimEvent({ ref: true }); return true; }
  const sf = t.closest('[data-simfix]'); if (sf) { toast(sf.dataset.simfix === 'open' ? 'In Telegram this opens your channel.' : sf.dataset.simfix === 'share' ? 'In Telegram this opens the share screen with their own invite link.' : 'In Telegram this shows their invite link and how many friends joined.', { kind: 'info' }); return true; }
  const tp = t.closest('[data-simt]'); if (tp) { wfSimEvent({ tap: tp.dataset.simt }); return true; }
  if (t.closest('[data-simskip]')) { wfSimEvent({ skip: true }); return true; }
  if (t.closest('[data-simreset]')) { FL.sim = []; FL.mode = 'try'; FL.pvStep = null; wfSim(); return true; }
  return false;
}
function wfTryIt() {
  wfPlayStop(); FL.mode = 'try'; FL.play = null; FL.pvStep = null;
  wfPhoneSheet('Try your ' + (wfIsBot(FL.E) ? 'bot' : 'flow'), icon('play'), 'Tap the buttons like they would. Waits are skipped with ⏩.');
  wfSim();
}
function wfResetPreview() {
  wfPlayStop(); FL.mode = 'try'; FL.play = null; FL.pvStep = null;
  clearTimeout(FL.testT); FL.test = null;
}

/* ---------- Gentle checks on the cards (they refresh as you type) ---------- */
function wfTipLi(x) { return '<li class="' + (x.block && x.kind !== 'empty' ? 'b' : '') + '"><span aria-hidden="true">💡</span><span>' + esc(x.text) + '</span>' + (x.fix ? '<button type="button" class="fb-tipfix" data-tipfix="' + x.i + '">Fix it</button>' : '') + '</li>'; }
function wfTipSumPaint(tips) {
  const sum = $('#wfTipSum'); if (!sum) return;
  sum.className = 'fb-tipsum' + (tips.length ? ' some' : ' ok');
  sum.innerHTML = (tips.length ? '💡 ' : '') + esc(wfTipsSummary(tips));
  sum.disabled = !tips.length;
}
let wfTipsT = 0;
function wfTipsSoon() { clearTimeout(wfTipsT); wfTipsT = setTimeout(wfTipsRefresh, 450); }
function wfTipsRefresh() {
  const E = FL.E, st = $('#wfStack');
  if (!E || !st) return;
  const tips = wfTips(E, { branding: FL.data.plan.branding, joinAdmin: FL.joinAdmin });
  $$('.fb-card', st).forEach((card) => {
    const mine = tips.filter((x) => x.i === +card.dataset.i);
    let ul = $('.fb-tips', card);
    if (!mine.length) { if (ul) ul.remove(); return; }
    if (!ul) { ul = document.createElement('ul'); ul.className = 'fb-tips'; card.insertBefore(ul, $('.fb-when', card)); }
    ul.innerHTML = mine.map(wfTipLi).join('');
  });
  wfTipSumPaint(tips);
}
/* The calm summary: "Everything looks good ✨" or "2 small things to check", tap one to jump to it.
   o: { live (before switching on; onGo = switch on anyway), save (before saving) } */
function wfTipsSheet(tips, o = {}) {
  const title = tips.length ? wfTipsSummary(tips) : 'Everything looks good ✨';
  const intro = o.live ? 'Before it goes live, have a quick look. Tap one to jump straight to it.' : o.save ? 'Almost there! Sort these out and save again. Tap one to jump straight to it.' : 'Tap one to jump straight to it. You can still save a draft any time.';
  const canGo = o.live && !tips.some((x) => x.block);
  const h = sheet(esc(title), '<span class="spk">💡</span>',
    '<p class="muted fb-shh">' + esc(intro) + '</p>' +
    (tips.length ? '<div class="fb-tiplist">' + tips.map((x) => '<button type="button" class="fb-tipi" data-tipgo="' + x.i + '"><span class="fb-tn">' + (x.i + 1) + '</span><span><b>' + (x.i === 0 ? 'Welcome message' : 'Message ' + (x.i + 1)) + '</b><small>' + esc(x.text) + '</small></span>' + icon('chev') + '</button>').join('') + '</div>' : '<p>All your messages are ready to go.</p>') +
    '<div class="row2b">' + (canGo ? '<button type="button" class="btn b-ghost" data-tipany>Switch on anyway</button>' : '') + '<button type="button" class="btn b-blue" data-tipok>' + (o.live || o.save ? 'I\'ll take a look' : 'Got it') + '</button></div>');
  $('.sb', h).onclick = (e) => {
    const g = e.target.closest('[data-tipgo]'); if (g) { closeModal(); wfJump(+g.dataset.tipgo); return; }
    if (e.target.closest('[data-tipany]')) { closeModal(); if (o.onGo) o.onGo(); return; }
    if (e.target.closest('[data-tipok]')) closeModal();
  };
}
/* Jump to message i: opens its answer tab, scrolls to it, gives it a soft glow. */
function wfJump(i) {
  const E = FL.E; if (!E || !E.steps[i]) return;
  const g = wfGraph(E)[i];
  if (g.group && g.t === 'on_button') FL.btab[String(g.group.owner)] = i;
  FL.sel = i; wfDrawStack(canSend());
  const card = $('#wfStack .fb-card[data-i="' + i + '"]'); if (!card) return;
  card.scrollIntoView({ block: 'center', behavior: wfReduced() ? 'auto' : 'smooth' });
  card.classList.add('fb-flash'); setTimeout(() => card.classList.remove('fb-flash'), 1800);
  const ta = $('[data-body="' + i + '"]', card); if (ta && !wfNarrow()) setTimeout(() => ta.focus({ preventScroll: true }), 450);
}

/* ---------- 📲 Send a test to my Telegram (POST /api/flows/tests, services/flow-test.js) ---------- */
const WF_TEST_OPEN = ['need_start', 'running', 'waiting'];
async function wfTestSend(btn) {
  const E = FL.E;
  if (!E.bot_id || (!E.chat_id && !wfIsBot(E))) { toast(wfIsBot(E) ? 'Pick your Telegram bot at the top first, then send a test 🙂' : 'Pick your channel and your bot at the top first, then send a test 🙂', { kind: 'info' }); return; }
  const stop = wfTips(E, { branding: FL.data.plan.branding, joinAdmin: FL.joinAdmin }).filter((x) => x.block === 'save');
  if (stop.length) { wfTipsSheet(stop, { save: true }); return; }
  if (ME && ME.user && ME.user.tg_linked === false) { wfLinkFirst(btn); return; }
  btnBusy(btn, true, 'Sending…');
  try {
    const r = await POST('/api/flows/tests', { ...wfBody(E), flow_id: E.id || null });
    FL.test = r.test; FL.testSeen = r.test.sent;
    wfTestSheet(); wfTestPill(); wfTestPoll();
  } catch (ex) {
    if (ex.code === 'tg_not_linked') wfLinkFirst(btn);
    else if (ex.code === 'test_limit') toast(ex.message, { kind: 'info' });
    else wfErr(ex);
  } finally { btnBusy(btn, false); }
}
function wfLinkFirst(btn) {
  const h = sheet('Link your Telegram first', '<span class="spk">📲</span>', '<p class="muted fb-shh">So we know where to send your test. It takes a few seconds, and you only do it once.</p><div class="row2b"><button type="button" class="btn b-ghost" data-lkno>Not now</button><button type="button" class="btn b-blue" data-lkgo>' + icon('tg') + 'Link Telegram</button></div>');
  $('.sb', h).onclick = (e) => {
    if (e.target.closest('[data-lkno]')) closeModal();
    if (e.target.closest('[data-lkgo]')) { closeModal(); linkTelegram(() => { if (ME && ME.user) ME.user.tg_linked = true; wfTestSend(btn && document.body.contains(btn) ? btn : $('[data-tsend]') || btn); }); }
  };
}
function wfTestPoll() {
  clearTimeout(FL.testT);
  const T = FL.test;
  if (!T || !WF_TEST_OPEN.includes(T.status)) return;
  FL.testT = setTimeout(async () => {
    if (!FL.test || FL.test.id !== T.id || (FL.alive && !FL.alive())) return;
    try {
      const r = await GET('/api/flows/tests/' + T.id);
      if (!FL.test || FL.test.id !== T.id) return;
      const was = FL.test.sent;
      FL.test = r.test;
      if (!$('#wfTestBox') && r.test.status === 'done' && T.status !== 'done') toast('✨ Test done! ' + plural(r.test.sent, 'message') + ' reached your Telegram. Nothing was counted.');
      else if (!$('#wfTestBox') && r.test.sent > was && r.test.status !== 'need_start') toast('Sent message ' + r.test.sent + ' of ' + r.test.total + ' to your Telegram ✓');
      wfTestPaint(); wfTestPill();
    } catch (_) { /* try again */ }
    wfTestPoll();
  }, document.hidden ? 4000 : 1500);
}
function wfTestPill() {
  const el = $('#wfTestPill'); if (!el) return;
  const T = FL.test;
  if (!T || !(WF_TEST_OPEN.includes(T.status) || T.status === 'done')) { el.innerHTML = ''; return; }
  el.innerHTML = '<button type="button" class="fb-tpill' + (T.status === 'done' ? ' done' : '') + '" data-topen>' + (T.status === 'done' ? '✓ Test done · ' + T.sent + ' sent' : '<span class="fb-tdot"></span>' + (T.status === 'need_start' ? 'Test: tap Start in Telegram' : T.waiting_for ? 'Test: your turn in Telegram' : 'Test: ' + T.sent + ' of ' + T.total + ' sent')) + '</button>';
}
/* The test's live progress (a sheet; closing it keeps the test going, the pill reopens it). */
function wfTestSheet() {
  const h = sheet('Test on your Telegram', '<span class="spk">📲</span>', '<div id="wfTestBox"></div>', { wide: false });
  $('.sb', h).onclick = async (e) => {
    const t = e.target;
    if (t.closest('[data-tstop]')) {
      try { const r = await POST('/api/flows/tests/' + FL.test.id + '/stop'); FL.test = r.test; wfTestPaint(); wfTestPill(); toast('Test stopped. No worries, nothing was counted.'); } catch (ex) { apiErr(ex); }
      return;
    }
    if (t.closest('[data-tagain]')) { closeModal(); wfTestSend($('[data-tsend]')); return; }
    if (t.closest('[data-tclose]')) closeModal();
  };
  wfTestPaint();
}
function wfTestPaint() {
  const box = $('#wfTestBox'); const T = FL.test; const E = FL.E;
  if (!box || !T || !E) return;
  const bot = '@' + esc(T.bot || 'your bot');
  const tgLink = T.bot ? 'https://t.me/' + encodeURIComponent(T.bot) : '';
  if (T.status === 'need_start') {
    let qr = '';
    if (!wfNarrow() && typeof qrSvg === 'function' && T.start_url) { try { qr = '<div class="ft-qr"><div class="ft-qrb">' + qrSvg(T.start_url, { label: 'QR code: open your bot' }) + '</div><small>Or scan this with your phone\'s camera</small></div>'; } catch (_) { qr = ''; } }
    box.innerHTML = '<div class="ft-need"><div class="ft-step"><span class="ft-n">1</span><div><b>Open your bot and tap Start first</b><small>Telegram lets a bot message you only after you tap Start once. We\'ll notice, and your test begins by itself.</small></div></div>' +
      '<a class="btn b-blue full" href="' + esc(T.start_url || tgLink) + '" target="_blank" rel="noopener">' + icon('tg') + 'Open ' + bot + ' in Telegram</a>' + qr +
      '<div class="wait"><span class="rad"><i></i><i></i><svg><use href="#i-tg"/></svg></span><span><b>Waiting for you to tap Start…</b><small class="muted">This updates by itself.</small></span></div></div>' +
      '<div class="row2b"><button type="button" class="btn b-ghost" data-tstop>Cancel the test</button></div>';
    return;
  }
  const open = WF_TEST_OPEN.includes(T.status);
  const done = T.status === 'done';
  const pct = Math.min(100, (T.sent / Math.max(1, T.total)) * 100);
  const head = done ? '✨ All done! ' + plural(T.sent, 'message') + ' reached your Telegram.' + (Object.keys(T.answers || {}).length ? ' Test answers are never saved.' : '') : T.status === 'stopped' || T.status === 'expired' ? (T.status === 'expired' ? 'This test ended after 30 quiet minutes.' : 'The test stopped.') : 'Sent message ' + T.sent + ' of ' + T.total + ' to your Telegram ✓';
  let now = '';
  if (T.status === 'waiting' && T.waiting_for === 'start') now = '👆 Now tap <b>' + esc(T.start_label || 'Start') + '</b> in Telegram. The next message comes right after.';
  else if (T.status === 'waiting' && T.waiting_for === 'joined') now = '✅ Now tap <b>I\'ve joined</b> in Telegram. Join the channel first to see it pass, or tap it before joining to see the gentle note.';
  else if (T.status === 'waiting' && T.waiting_for === 'answer') now = '✍️ Now type your answer in Telegram, like they would. Try a wrong one too: your bot asks again kindly.';
  else if (T.status === 'waiting' && T.waiting_for === 'goal') now = '🧪 Tap <b>Pretend a friend joined</b> in Telegram to see the reward.';
  else if (T.status === 'waiting' && T.waiting_for === 'button') now = '🔘 Now tap ' + (T.waiting_buttons.length > 1 ? 'one of ' : '') + T.waiting_buttons.map((x) => '<b>' + esc(x) + '</b>').join(' or ') + ' in Telegram.';
  else if (T.status === 'running') now = '⏳ The next one arrives in a few seconds…';
  else if (done) now = T.sent < T.total ? 'That was one path. Tap another button next time to see the others.' : 'Nothing was counted, and nobody was let in.';
  else if (T.error) now = '🌱 ' + esc(T.error);
  const sent = new Set(T.sent_steps || []);
  const list = E.steps.map((s, i) => {
    const nextHere = T.status === 'running' && T.next_step === i;
    const cls = sent.has(i) ? 'sent' : nextHere ? 'next' : '';
    const flat = String((s.body || '').replace(/[*_`]/g, '')).replace(/\{name\}/g, (FL.test && FL.test.first_name) || 'Ada').replace(/\s+/g, ' ').trim();
    const words = flat.length > 48 ? flat.slice(0, 46).trimEnd() + '…' : flat;
    return '<li class="' + cls + '"><span class="ft-c">' + (sent.has(i) ? '✓' : nextHere ? '…' : i + 1) + '</span><span><b>' + (i === 0 ? 'Welcome' : 'Message ' + (i + 1)) + '</b><small>' + esc(words || 'Photo or video') + '</small></span></li>';
  }).join('');
  box.innerHTML = '<div class="ft-head"><b>' + head + '</b><small>Test mode: waits are ' + Number(T.wait_seconds || 3) + ' seconds, nothing is counted, and nobody is let in.</small></div>' +
    '<div class="prog2"><i style="width:' + pct.toFixed(1) + '%"></i></div>' + (now ? '<p class="ft-now">' + now + '</p>' : '') + '<ol class="ft-list">' + list + '</ol>' +
    (tgLink ? '<a class="ft-open" href="' + esc(tgLink) + '" target="_blank" rel="noopener">' + icon('tg') + 'Open ' + bot + ' in Telegram</a>' : '') +
    '<div class="row2b">' + (open ? '<button type="button" class="btn b-ghost" data-tstop>Stop the test</button><button type="button" class="btn b-blue" data-tclose>Keep it going</button>' : '<button type="button" class="btn b-ghost" data-tclose>Close</button><button type="button" class="btn b-blue" data-tagain>📲 Send another test</button>') + '</div>';
}

/* ---------- A 3-tip tour the first time (skippable, remembered) ---------- */
const WF_TOUR = [
  { sel: '[data-body="0"]', title: 'Write your welcome', text: 'It\'s the first thing they see. {name} becomes their first name.' },
  { sel: '#wfStack .fb-chip, #wfStack .fb-add', title: 'Add what comes next', text: 'Pick when it comes: right away, after a wait, or when they tap a button. You can change it anytime.' },
  { sel: '#wfTools', title: 'See it before they do', text: 'Preview any step, play the whole flow, or send a test to your own Telegram.' },
];
function wfTourSoon() {
  let seen = '1';
  try { seen = localStorage.getItem('cv_fb_tour'); } catch (_) { seen = '1'; }
  if (seen || FL.tourOn) return;
  FL.tourOn = true;
  setTimeout(() => { if (FL.tab === 'build' && $('#wfStack') && !$('#modalHost .sheet')) wfTour(0); else FL.tourOn = false; }, 1100);
}
function wfTourEnd(remember) {
  $$('.fb-coach,.fb-ring').forEach((x) => x.remove());
  if (FL.tourPlace) { window.removeEventListener('scroll', FL.tourPlace, true); window.removeEventListener('resize', FL.tourPlace); FL.tourPlace = null; }
  FL.tourOn = false;
  if (remember) { try { localStorage.setItem('cv_fb_tour', '1'); } catch (_) { /* fine */ } }
}
function wfTour(n) {
  wfTourEnd(false);
  const T = WF_TOUR[n];
  const el = T ? $(T.sel) : null;
  if (!el) { wfTourEnd(true); return; }
  FL.tourOn = true;
  el.scrollIntoView({ block: 'center', behavior: wfReduced() ? 'auto' : 'smooth' });
  const b = document.createElement('div');
  b.className = 'fb-coach'; b.setAttribute('role', 'dialog'); b.setAttribute('aria-label', T.title);
  b.innerHTML = '<small>' + (n + 1) + ' of ' + WF_TOUR.length + '</small><b>' + esc(T.title) + '</b><p>' + esc(T.text) + '</p><div class="fb-coachb"><button type="button" class="lnk" data-tskip>Skip the tips</button><button type="button" class="btn b-blue xs" data-tnext>' + (n === WF_TOUR.length - 1 ? 'Got it' : 'Next') + '</button></div>';
  const ring = document.createElement('div'); ring.className = 'fb-ring';
  document.body.appendChild(ring); document.body.appendChild(b);
  const place = () => {
    const r = el.getBoundingClientRect();
    const W = document.documentElement.clientWidth, H = window.innerHeight;
    Object.assign(ring.style, { left: (r.left - 6) + 'px', top: (r.top - 6) + 'px', width: (r.width + 12) + 'px', height: (r.height + 12) + 'px' });
    const bw = Math.min(320, W - 32), bh = b.offsetHeight || 150;
    const below = r.bottom + 14 + bh < H || r.top < bh + 24;
    b.style.width = bw + 'px';
    b.style.left = Math.max(16, Math.min(W - bw - 16, r.left + r.width / 2 - bw / 2)) + 'px';
    b.style.top = Math.max(12, Math.min(H - bh - 12, below ? r.bottom + 14 : r.top - bh - 14)) + 'px';
    b.dataset.side = below ? 'below' : 'above';
  };
  FL.tourPlace = place;
  window.addEventListener('scroll', place, true); window.addEventListener('resize', place);
  place(); setTimeout(place, 420);
  requestAnimationFrame(() => { b.classList.add('in'); ring.classList.add('in'); });
  b.onclick = (e) => {
    if (e.target.closest('[data-tskip]')) wfTourEnd(true);
    else if (e.target.closest('[data-tnext]')) { if (n + 1 < WF_TOUR.length) wfTour(n + 1); else wfTourEnd(true); }
  };
}
function wfMove(i, dir) {
  const E = FL.E; const j = i + dir;
  if (j < 1 || j >= E.steps.length) return;
  const [m] = E.steps.splice(i, 1); E.steps.splice(j, 0, m);
  // An answer that moved above its button's message comes right away instead.
  E.steps.forEach((s, k) => { if (s.trigger && s.trigger.type === 'on_button') { const o = wfOwnerOf(E, s.trigger.button); if (o < 0 || o >= k) s.trigger = { type: 'after_previous' }; } });
  FL.sel = j; FL.sim = []; wfMark();
}
function wfEmoji(anchor, pick) {
  const old = $('.wf-menu'); if (old) old.remove();
  const m = document.createElement('div');
  m.className = 'wf-menu emo';
  m.innerHTML = WF_EMOJI.map((x) => '<button type="button" data-e="' + x + '">' + x + '</button>').join('');
  anchor.parentElement.appendChild(m);
  const close = (ev) => { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('click', close, true); } };
  setTimeout(() => document.addEventListener('click', close, true), 0);
  m.onclick = (e) => { const b = e.target.closest('[data-e]'); if (!b) return; m.remove(); document.removeEventListener('click', close, true); pick(b.dataset.e); };
}

/* "➡ Start another flow": pick one of this bot's flows. */
function wfPickFlow(i, redraw) {
  const E = FL.E;
  if (!wfHas('start_another_flow')) { wfUpgrade('start_another_flow'); return; }
  const list = (FL.data.startable || []).filter((f) => String(f.bot_id) === String(E.bot_id) && String(f.id) !== String(E.id));
  const h = sheet('Start another flow', '<span class="spk">➡</span>', '<p class="muted" style="font-size:14.5px">After message ' + (i + 1) + ' is sent, the flow you pick starts for that person, from its first message. Each person goes through a flow once.</p>' +
    (list.length ? '<div class="fb-flows">' + list.map((f) => '<button type="button" class="fb-flow' + (String(f.id) === String(E.steps[i].start_flow_id) ? ' on' : '') + '" data-pf="' + Number(f.id) + '"><span>' + (f.trigger_type === 'join_request' ? '👋' : '📅') + '</span><span><b>' + esc(f.name) + '</b><small>' + (f.trigger_type === 'join_request' ? 'Welcome Flow' : 'Auto follow-up') + (f.active ? ' · on' : ' · switched off: it starts when you switch it on') + '</small></span></button>').join('') + '</div>'
      : emptyBox({ plain: 1, emoji: '📅', title: 'No other flows for this bot yet', text: 'Make an auto follow-up (or another Welcome Flow) with the same bot first.' })) +
    '<div class="row2b"><button type="button" class="btn b-ghost" data-pfx>Cancel</button>' + (E.steps[i].start_flow_id ? '<button type="button" class="btn b-ghost danger" data-pfn>Don\'t start a flow</button>' : '') + '</div>');
  h.onclick = (e) => {
    const p = e.target.closest('[data-pf]'); if (p) { E.steps[i].start_flow_id = +p.dataset.pf; closeModal(); wfMark(); redraw(); return; }
    if (e.target.closest('[data-pfn]')) { E.steps[i].start_flow_id = null; closeModal(); wfMark(); redraw(); return; }
    if (e.target.closest('[data-pfx]')) closeModal();
  };
}

/* "Tell Cas what you want": Cas builds the messages; the owner reviews them in the builder. */
async function wfCasBuild(btn, pane, alive, editable) {
  if (!wfHas('ai')) { wfUpgrade('ai'); return; }
  const p = $('#fbCasP');
  const prompt = p.value.trim();
  if (prompt.length < 8) { toast('Describe your flow in one sentence first.', { kind: 'info' }); p.focus(); return; }
  btnBusy(btn, true, 'Cas is building…');
  try {
    const r = await POST('/api/ai/flow', { prompt });
    if (!alive()) return;
    const E = FL.E;
    const before = JSON.parse(JSON.stringify(E));
    const f = r.flow;
    E.steps = f.steps.map(wfStep);
    if (!E.id || /^(My welcome flow|Welcome Flow)$/i.test(E.name)) E.name = f.name;
    if (f.start_button && wfHas('tap_to_start')) { E.start_button = true; if (f.start_label) E.start_label = f.start_label; }
    if (f.approve_mode && (!['tap', 'manual'].includes(f.approve_mode) || wfHas(f.approve_mode === 'tap' ? 'tap_to_start' : 'welcome_flows'))) E.approve_mode = f.approve_mode;
    FL.cas = false; FL.sim = []; FL.open = -1; FL.adding = false; FL.sel = 0; FL.btab = {};
    wfMark();
    const nm = $('#wfName'); if (nm) nm.value = E.name;
    wfBuild(pane, alive, editable); wfMark();
    const lh = $('.fb-listh'); if (lh) lh.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (APP.state && APP.state.plan && r.ai_writes_left != null) APP.state.plan.usage.ai_writes = Math.max(0, APP.state.plan.limits.ai_writes - r.ai_writes_left);
    toast('Cas built your flow. Check the words and links, then save.', { action: { label: 'Undo', onClick: () => { FL.E = before; FL.sim = []; wfBuild(pane, alive, editable); } } });
    const ph = E.steps.findIndex((s) => wfPlaceholder(s.body) || (s.buttons || []).some((b) => b.kind !== 'reply' && !(b.url || '').trim()));
    if (ph >= 0) setTimeout(() => toast('Fill in the parts in [brackets] and the button links.', { kind: 'info' }), 2500);
  } catch (ex) {
    btnBusy(btn, false);
    if (ex.code === 'ai_bad_flow') { toast(ex.message, { kind: 'err' }); return; }
    wfErr(ex);
  }
}

/* Broadcast tie-in: open Send a message with this bot and "Tapped Start in <flow>". */
async function wfBroadcast(btn) {
  if (!wfHas('broadcasts')) { wfUpgrade('broadcasts'); return; }
  btnBusy(btn, true, 'Opening…');
  try {
    const r = await POST('/api/flows/' + FL.E.id + '/audience');
    if (FL.dirty && !(await confirmBox('Leave without saving?', 'Your changes to this flow will be lost.', 'Leave'))) { btnBusy(btn, false); return; }
    FL.dirty = false;
    appGo('broadcast', { conn: r.bot_id, seg: r.segment_id });
  } catch (ex) { btnBusy(btn, false); wfErr(ex); }
}

async function wfMakeLink(btn) {
  const E = FL.E;
  btnBusy(btn, true, 'Making…');
  try { const r = await POST('/api/flows/' + E.id + '/invite-link'); E.invite_link = r.invite_link; $('#wfLink').value = r.invite_link; copyText(r.invite_link, 'Link made and copied'); }
  catch (ex) { if (ex.code === 'bot_not_admin') { FL.admin = { ok: false, message: ex.message }; wfAdminBox(); } wfErr(ex); }
  finally { btnBusy(btn, false); }
}

async function wfSave(btn, alive) {
  const E = FL.E;
  const err = $('#wfErr'); err.hidden = true;
  const basic = wfCheckBasics(E);
  if (basic) { err.textContent = basic; err.hidden = false; err.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  // The small things that stop a save: a calm list, tap one to jump to it.
  const stop = wfTips(E, { branding: FL.data.plan.branding, joinAdmin: FL.joinAdmin }).filter((x) => x.block === 'save');
  if (stop.length) { wfTipsSheet(stop, { save: true }); return; }
  const problem = wfCheck(E, { save: true });
  if (problem) { err.textContent = problem; err.hidden = false; err.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  btnBusy(btn, true, 'Saving…');
  try {
    if (E.id) {
      const r = await api('PUT', '/api/flows/' + E.id, wfBody(E));
      const keepSel = FL.sel; FL.E = wfFromApi(r.flow); FL.sel = keepSel; FL.dirty = false;
      wfPlayStop(); FL.mode = 'try'; FL.play = null; FL.pvStep = null; FL.sim = [];
      toast('Saved ✓');
      wfBuild($('#wfPane'), alive, canSend());
    } else {
      const r = await POST('/api/flows', wfBody(E));
      FL.dirty = false;
      toast('Saved as a draft. Switch it on whenever you\'re ready.');
      appGo('flows', { id: r.id });
    }
  } catch (ex) {
    btnBusy(btn, false);
    if (['plan_feature', 'limit_flows', 'limit_flow_steps'].includes(ex.code)) { wfErr(ex); return; }
    err.textContent = ex.message; err.hidden = false; apiErr(ex, { silent: true });
  }
}

/* ---------- Stats ---------- */
async function wfStats(pane, alive) {
  pane.innerHTML = skel(1, 160) + skel(1, 220);
  const r = await GET('/api/flows/' + FL.E.id + '/stats');
  if (!alive() || FL.tab !== 'stats') return;
  const s = r.stats; FL.stats = s.locked ? null : s;
  if (!s.locked && s.bot) {
    const b = s.bot, base = Math.max(1, b.started);
    const bar = (label, v) => '<div class="wf-fr"><span>' + label + '</span><div class="wf-ft"><i style="--w:' + Math.max(v ? 2 : 0, v / base * 100).toFixed(1) + '%"></i></div><b class="tnum">' + fmt(v) + '</b><small>' + Math.round(v / base * 100) + '%</small></div>';
    pane.innerHTML = '<div class="box"><div class="bh"><h3>' + icon('chart') + 'This bot so far</h3><span class="hint">Everyone who tapped Start through it</span></div><div class="wf-funnel">' +
      bar('Tapped Start', b.started) + bar('Tapped a button', b.clicked) + (FL.E.steps.some((x) => wfKind(x) === 'ask') ? bar('Answered your questions', b.leads) : '') + bar('Reached the end', b.finished) + '</div>' +
      (b.referrals ? '<p class="hint">' + plural(b.referrals, 'friend', 'friends') + ' joined through invite links.</p>' : '') + '</div>';
    return;
  }
  if (s.locked) {
    pane.innerHTML = '<div class="box wf-locked"><div style="width:84px" data-cas="think"></div><b>Stats are on Starter and up</b><p class="muted">See how many people were welcomed, let in, tapped Start and tapped each button, message by message.</p><button type="button" class="btn b-blue sm" data-up="basic_stats">' + icon('up') + 'See plans</button></div>' + wfMeterHtml(FL.data.meter, FL.data.plan);
    paintCas(pane);
    return;
  }
  const f = s.funnel;
  const base = Math.max(1, (f || s.basic).requests);
  const bar = (label, v, hint) => '<div class="wf-fr"><span>' + label + '</span><div class="wf-ft"><i style="--w:' + Math.max(v ? 2 : 0, v / base * 100).toFixed(1) + '%"></i></div><b class="tnum">' + fmt(v) + '</b><small>' + (hint || (base ? Math.round(v / base * 100) + '%' : '')) + '</small></div>';
  const funnel = f ? '<div class="box"><div class="bh"><h3>' + icon('chart') + 'From request to click</h3><span class="hint">Everyone who asked to join through this flow</span></div><div class="wf-funnel">' +
    bar('Asked to join', f.requests, '100%') + bar('Got your welcome', f.welcomed) + bar('Tapped Start', f.started) + bar('Let in', f.approved) + bar('Tapped a button', f.clicked) + '</div>' +
    (f.no_welcome ? '<p class="wf-mw"><b>' + plural(f.no_welcome, 'person', 'people') + ' joined without your welcome</b> because the month\'s join requests ran out.</p>' : '') +
    (f.pending ? '<p class="hint">' + plural(f.pending, 'person is', 'people are') + ' still waiting to be let in.</p>' : '') + '</div>'
    : '<div class="box"><div class="bh"><h3>' + icon('chart') + 'This flow so far</h3></div><div class="wf-kpis">' + [['Asked to join', s.basic.requests], ['Welcomed', s.basic.welcomed], ['Tapped Start', s.basic.started || 0]].map((k) => '<div><small>' + k[0] + '</small><b class="tnum">' + fmt(k[1]) + '</b></div>').join('') + '</div>' +
      '<div class="note2"><span>' + icon('lock') + '</span><span>The full funnel (let in, tapped a button) and A/B results are on Growth. <button type="button" class="lnk" data-up="flow_funnel_stats">See Growth</button></span></div></div>';
  const ab = s.ab ? '<div class="box"><div class="bh"><h3>' + icon('swap') + 'A/B welcome</h3><span class="hint">People are split evenly between versions</span></div><div class="wf-ab2">' + (() => { const best = Math.max(...s.ab.map((x) => x.rate)); return s.ab.map((x) => '<div class="' + (x.rate === best && best > 0 ? 'win' : '') + '"><span class="pill ' + (x.rate === best && best > 0 ? 'p-ok' : 'p-grey') + '">Version ' + esc(x.label) + (x.rate === best && best > 0 ? ' · ahead' : '') + '</span><b class="tnum">' + x.rate + '%</b><small>clicked · ' + fmt(x.clickers) + ' of ' + fmt(x.delivered) + ' people</small><div class="prog2"><i style="width:' + Math.min(100, x.rate) + '%"></i></div></div>').join(''); })() + '</div></div>' : '';
  const E = FL.E;
  const rows = s.steps.map((st, i) => {
    const when = i < E.steps.length ? (WF_TRIG[wfTrig(E, i)] || WF_TRIG.after_previous)[0] + ' ' + (i === 0 ? 'Welcome' : 'Message ' + (i + 1)) : 'Message ' + (i + 1);
    const taps = (st.buttons || []).filter((b) => b.taps).map((b) => esc(b.label) + ': ' + fmt(b.people)).join(' · ');
    return '<tr>' + td('Message', '<b>' + esc(when) + '</b>', 'first') + td('Delivered', fmt(st.delivered)) + td('Taps', taps || fmt(st.clicks)) + td('Waiting', fmt((st.waiting_start || 0) + (st.awaiting || 0))) + '</tr>';
  }).join('');
  pane.innerHTML = funnel + ab + '<div class="box"><div class="bh"><h3>' + icon('send') + 'Message by message</h3></div><div class="tw"><table class="tbl rsp"><thead><tr><th>Message</th><th>Delivered</th><th>Taps (people)</th><th>Waiting</th></tr></thead><tbody>' + rows + '</tbody></table></div><p class="hint">Telegram does not tell bots who read a message, so Castvoo shows deliveries and taps. "Waiting" = people who have not tapped Start or a button yet.</p></div>';
}

/* ---------- Leads: answers to "Ask a question" (GET /api/bots/:id/answers, CSV for the owner) ---------- */
async function wfLeads(pane, alive) {
  pane.innerHTML = skel(4, 56);
  const r = await GET('/api/bots/' + FL.E.id + '/answers');
  if (!alive() || FL.tab !== 'leads') return;
  const q = r.questions || [];
  const m = r.meter || {};
  const canCsv = r.export !== 'none';
  const head = '<div class="bh"><h3>' + icon('users') + 'Leads</h3>' + (r.people.length ? (canCsv ? (isOwner() ? '<a class="btn b-ghost sm" href="/api/bots/' + Number(FL.E.id) + '/answers.csv" download>' + icon('down') + 'Download CSV</a>' : '<span class="hint">The owner can download these.</span>') : '<button type="button" class="btn b-ghost sm" data-up="bot_lead_questions">' + icon('lock') + 'Download CSV</button>') : '') + '</div>';
  const meter = m.limit > 0 ? '<p class="hint">This month: ' + fmt(m.used) + ' of ' + fmt(m.limit) + ' answers.' + (m.over ? ' New answers are still saved. They show here next month, or right away if you upgrade.' : '') + '</p>' : '';
  if (r.restricted) {
    // Leads are personal data: only the owner and the setup helper see the answers (server: ws.leads).
    pane.innerHTML = '<div class="box"><div class="bh"><h3>' + icon('users') + 'Leads</h3></div>' + meter +
      '<div class="wf-kpis wf-kpi3"><div><small>People who answered</small><b class="tnum">' + fmt(r.total || 0) + '</b></div><div><small>Questions</small><b class="tnum">' + fmt(q.length) + '</b></div><div><small>Answers shown next month</small><b class="tnum">' + fmt(r.hidden || 0) + '</b></div></div>' +
      '<div class="note2 info wf-room"><span>🔒</span><span>Answers can include names, phone numbers and emails, so only the workspace owner and the setup helper can see them. You can see how many people answered.</span></div></div>';
    return;
  }
  const rows = r.people.map((p) => '<tr>' + td('Person', '<b>' + esc(p.first_name || 'No name') + '</b>' + (p.username ? ' <small class="muted">@' + esc(p.username) + '</small>' : ''), 'first') +
    q.map((x) => { const v = p.answers[String(x.step_id)]; return td(x.label, v === null ? '<span class="muted">🔒 Shows next month (or upgrade)</span>' : v == null ? '<span class="muted" title="Not answered yet">—</span>' : esc(v)); }).join('') + td('When', ago(p.at)) + '</tr>').join('');
  pane.innerHTML = '<div class="box">' + head + meter +
    (r.people.length ? '<div class="tw"><table class="tbl rsp"><thead><tr><th>Person</th>' + q.map((x) => '<th>' + esc(x.label) + '</th>').join('') + '<th>When</th></tr></thead><tbody>' + rows + '</tbody></table></div>' + (r.total > r.people.length ? '<p class="hint">Showing the newest ' + fmt(r.people.length) + ' of ' + fmt(r.total) + '. The CSV has everyone.</p>' : '')
      : emptyBox({ plain: 1, emoji: '📝', title: 'No answers yet', text: 'When people answer your questions, they show here. Share your start link to get your first leads.' })) + '</div>';
  pane.onclick = (e) => { const up = e.target.closest('[data-up]'); if (up) { e.preventDefault(); wfUpgrade(up.dataset.up); } };
}

/* ---------- Invites: the referral leaderboard (GET /api/bots/:id/referrals) ---------- */
const WF_NOT_COUNTED = { not_new: 'already knew your bot', daily_limit: 'over 50 in a day', bot: 'a bot account', self: 'their own link', gone: 'left' };
async function wfInvites(pane, alive) {
  pane.innerHTML = skel(4, 56);
  const r = await GET('/api/bots/' + FL.E.id + '/referrals');
  if (!alive() || FL.tab !== 'invites') return;
  const t = r.totals || {};
  pane.innerHTML = '<div class="box"><div class="bh"><h3>🏆 Top inviters</h3><span class="hint">Goal: ' + plural(r.goal || 0, 'friend', 'friends') + '</span></div>' +
    '<div class="wf-kpis wf-kpi3"><div><small>Friends joined</small><b class="tnum">' + fmt(t.counted || 0) + '</b></div><div><small>Got the reward</small><b class="tnum">' + fmt(t.reached || 0) + '</b></div><div><small>Didn\'t count</small><b class="tnum">' + fmt(t.not_counted || 0) + '</b></div></div>' +
    (r.top.length ? '<ol class="wf-lb">' + r.top.map((x, n) => '<li><span class="wf-lbn">' + (n < 3 ? ['🥇', '🥈', '🥉'][n] : n + 1) + '</span>' + ava(x.first_name || x.username || '?', 34) + '<span class="wf-lbt"><b><span class="ell">' + esc(x.first_name || 'No name') + '</span>' + (x.username ? ' <small class="ell">@' + esc(x.username) + '</small>' : '') + '</b><small class="wf-lbs">' + plural(x.invites, 'friend', 'friends') + (x.reached_at ? ' · 🎉 reward sent' : '') + (x.not_counted ? ' · ' + x.not_counted + ' didn\'t count' : '') + '</small></span></li>').join('') + '</ol>'
      : emptyBox({ plain: 1, emoji: '🔗', title: 'No invites yet', text: 'When people share their link and friends tap Start, they show here.' })) +
    ((r.not_counted || []).length ? '<p class="hint">Not counted: ' + r.not_counted.map((x) => fmt(x.n) + ' ' + esc(WF_NOT_COUNTED[x.reason] || x.reason)).join(' · ') + '. Only people new to your bot count, each once, at most ' + Number(r.per_day || 50) + ' a day per person.</p>' : '') + '</div>';
}

/* ---------- Requests (people waiting to be let in) ---------- */
async function wfRequests(pane, alive) {
  pane.innerHTML = skel(4, 56);
  const r = await GET('/api/flows/requests?flow=' + FL.E.id);
  if (!alive() || FL.tab !== 'requests') return;
  const list = r.requests;
  const editable = canSend();
  const W = { sent: ['Welcomed', 'p-ok'], failed: ['Welcome failed', 'p-bad'], skipped_limit: ['No welcome (limit)', 'p-warn'], skipped_plan: ['No welcome', 'p-grey'], skipped_off: ['No welcome', 'p-grey'], none: ['', ''] };
  pane.innerHTML = '<div class="box"><div class="bh"><h3>' + icon('users') + 'Waiting to be let in</h3>' + (list.length && editable ? '<div class="row2b wf-bulk"><label class="chkl"><input type="checkbox" id="wfAll"> All</label><button type="button" class="btn b-ghost sm danger" data-dec="decline">Decline</button><button type="button" class="btn b-blue sm" data-dec="approve">' + icon('check') + 'Let in</button></div>' : '') + '</div>' +
    (FL.E.approve_mode === 'manual' || FL.E.approve_mode === 'tap' ? '' : '<p class="hint">With "' + esc((WF_MODES.find((m) => m[0] === FL.E.approve_mode) || WF_MODES[0])[1]) + '", people are let in by themselves. Someone shows here only if Telegram refused their welcome.</p>') +
    (list.length ? '<div class="wf-reqs">' + list.map((x) => '<label class="wf-req"><input type="checkbox" data-id="' + Number(x.id) + '"' + (editable ? '' : ' disabled') + '>' + ava(x.first_name || x.username || '?', 38) + '<span class="wf-rt"><b>' + esc(x.first_name || 'No name') + (x.username ? ' <small>@' + esc(x.username) + '</small>' : '') + '</b><small>Asked ' + ago(x.requested_at) + (x.started_at ? ' · tapped Start' : '') + (x.error ? ' · ' + esc(x.error) : '') + '</small></span>' + (W[x.welcome] && W[x.welcome][0] ? '<span class="pill ' + W[x.welcome][1] + '">' + W[x.welcome][0] + '</span>' : '') + '</label>').join('') + '</div>'
      : emptyBox({ plain: 1, emoji: '🙌', title: 'Nobody is waiting', text: 'New requests show here when a flow is set to "I decide", or when someone hasn\'t tapped Start yet.' })) + '</div>';
  const all = $('#wfAll', pane); if (all) all.onchange = () => $$('[data-id]', pane).forEach((c) => { c.checked = all.checked; });
  pane.onclick = async (e) => {
    const b = e.target.closest('[data-dec]'); if (!b) return;
    const ids = $$('[data-id]:checked', pane).map((c) => +c.dataset.id);
    if (!ids.length) { toast('Tick the people first.', { kind: 'info' }); return; }
    if (b.dataset.dec === 'decline' && !(await confirmBox('Decline ' + plural(ids.length, 'person', 'people') + '?', 'They will not join. They can ask again later.', 'Decline', true))) return;
    btnBusy(b, true, b.dataset.dec === 'approve' ? 'Letting in…' : 'Declining…');
    try {
      const r2 = await POST('/api/flows/requests/decide', { ids, action: b.dataset.dec });
      const done = r2.approved + r2.declined;
      toast((done ? plural(done, 'person', 'people') + (b.dataset.dec === 'approve' ? ' let in.' : ' declined.') : 'Nothing changed.') + (r2.gone ? ' ' + plural(r2.gone, 'request was', 'requests were') + ' already gone.' : '') + (r2.failed ? ' ' + plural(r2.failed, 'one', 'some') + ' failed; try again.' : ''));
      refreshState(); wfRequests(pane, alive);
    } catch (ex) { btnBusy(b, false); apiErr(ex); }
  };
}

/* ---------- Upgrade sheet for Welcome Flows ---------- */
const WF_WHY = {
  welcome_flows: ['Add more messages', 'Messages after the welcome (right away, after a wait, when they tap Start or a button, reminders), Reply buttons and the "I decide" list are on Starter and up.'],
  flow_steps: ['Add more messages', 'Your plan has reached its messages per flow.'],
  flows: ['Make more flows', 'Your plan has reached its number of Welcome Flows.'],
  tap_to_start: ['Use the "Tap Start" button', 'The button that opens your bot (and "When they tap Start") is on Starter and up.'],
  ab_welcome_2: ['A/B test your welcome', 'Try two versions of the welcome and see which gets more clicks. On Growth and up.'],
  ab_welcome_4: ['Test up to 4 versions', 'Three or four versions of the welcome are on Scale.'],
  condition_clicked: ['Send only to clickers (or non-clickers)', 'Click conditions are on Growth and up.'],
  start_another_flow: ['Start another flow', 'A message that starts another flow for the person is on Growth and up.'],
  flow_funnel_stats: ['See the full funnel', 'Tapped Start, clicks and A/B results per flow are on Growth and up.'],
  basic_stats: ['See your flow stats', 'Stats are on Starter and up.'],
  branding: ['Remove "by Castvoo" from your welcome', 'Paid plans send your welcome without the Castvoo line.'],
  buttons: ['Add more buttons', 'The Free welcome can have 3 buttons. Paid plans allow 6.'],
  bot_buttons: ['Add more buttons', 'Bot messages can have 4 buttons on Free, 8 on Starter and 12 on Growth and Scale.'],
  join_requests: ['Welcome more people each month', 'Bigger plans include more join requests a month.'],
  ai: ['Let Cas write your messages', 'Cas, the AI helper, writes your messages and builds whole flows on Starter and up.'],
  broadcasts: ['Message the people who tapped Start', 'Broadcasts are on Starter and up.'],
  bots: ['Run more bots at once', 'Bigger plans switch on more bots at the same time. Drafts never count.'],
  bot_steps: ['Add follow-ups to your bot', 'The Free plan sends 1 message per reply (a menu can answer each button). Starter and up add follow-ups and reminders.'],
  lead_questions: ['Ask more questions', 'Your plan has reached its questions per bot.'],
  referral_bots: ['Run more referral bots', 'Your plan has reached its live referral bots.'],
  bot_join_check: ['Check they joined', 'Join-check bots are on every plan.'],
  bot_lead_questions: ['Collect leads with questions', '"Ask a question" steps, the Leads list and CSV export are on Starter and up.'],
  bot_referral: ['Reward invites', '"Invite friends" referral bots are on Growth and up.'],
  bot_broadcast: ['Broadcast to bot subscribers', 'Broadcasts to everyone who started your chat bots are on Starter and up.'],
};
const WF_NEEDS = { ai: 'ai', welcome_flows: 'welcome_flows', flow_steps: null, flows: null, tap_to_start: 'tap_to_start', ab_welcome_2: 'ab_welcome_2', ab_welcome_4: 'ab_welcome_4', condition_clicked: 'condition_clicked', start_another_flow: 'start_another_flow', flow_funnel_stats: 'flow_funnel_stats', basic_stats: 'basic_stats', branding: null, buttons: null, join_requests: null, broadcasts: 'broadcasts' };
function wfUpgrade(key, message) {
  const why = WF_WHY[key] || ['Upgrade your plan', ''];
  const plan = (FL.data && FL.data.plan) || (APP.state && APP.state.plan) || {};
  if (typeof openUpgrade === 'function') openUpgrade({ title: why[0], text: message || why[1], feature: WF_NEEDS[key] || (key === 'bot_broadcast' ? 'broadcasts' : null), limit: ['flow_steps', 'flows', 'join_requests', 'bots', 'bot_buttons'].includes(key) ? key : null, plan });
}

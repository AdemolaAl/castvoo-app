'use strict';
/*
 * cas-engine.js: Cas Builder's conversation, as a pure state machine (no network, no database, no AI).
 * The server (services/cas-builder.js) runs it for every chat turn; the static demo runs the same file in the browser.
 *
 *   start(ctx, { draft, edit })      → { state, turns }               a new chat (or one about an existing flow)
 *   reply(state, input, ctx)         → { state, turns, ai }           input { chip } or { text }
 *   aiDone(state, result, ctx)       → { state, turns }               the answer to an `ai` request (see below)
 *   undo(state, ctx)                 → { state, turns }
 *   saved(state, result, ctx)        → { state, turns }               after the flow was saved / switched on
 *   saveFailed(state, error, ctx)    → { state, turns }
 *   view(state, ctx)                 → { stage, chips, draft }        what the chat shows now
 *   applyOps(draft, ops, ctx)        → { ok, draft, done, error, ask } strict operations on a draft (AI or keyword rules)
 *   problems(draft, ctx)             → '' or the first thing that is not allowed (same rules as services/flows.js)
 *
 * CHIP TAPS NEVER NEED THE AI: every chip is handled here. Only two things ask for the AI (the `ai` field of reply()):
 *   { kind: 'write', role, purpose?, how?, index?, insert?, brief?, button? }   write or rewrite one message's text
 *   { kind: 'free', text, focus }                                              understand a free-typed instruction
 * The caller does that work and hands the result to aiDone(): { text } for a write, { ops, say } for free text, or
 * { fallback: true, reason } when the AI can't be used (Cas then writes a ready-made text, or explains kindly).
 *
 * ctx (from the caller, never stored): { plan: { name, features, flow_steps, branding }, chats: [{ id, title }],
 *   bots: [{ id, username }], flows: [{ id, name, bot_id }] (flows a message may start), profile: { business, what_you_sell, ... } }
 * The draft is the flow in the API's format (POST /api/flows): { name, chat_id, bot_id, approve_mode, start_button,
 *   start_label, steps: [{ body, buttons: [{ id, label, url, kind }], trigger: null | { type, seconds, button }, start_flow_id }] }.
 */
(function (root, factory) {
  const E = factory();
  if (typeof module === 'object' && module.exports) module.exports = E; else root.CasEngine = E;
})(typeof self !== 'undefined' ? self : this, function () {
  const QUICK = 280;            // Telegram's 5-minute window (services/flows.js QUICK_SECONDS)
  const MAX_WAIT = 365 * 86400;
  const TEXT_MAX = 4096;
  const BRAND_LEN = 34;
  const TRIGGERS = ['after_previous', 'wait', 'on_start', 'on_button', 'no_response', 'on_goal'];
  const EVENT = ['on_start', 'on_button', 'no_response'];
  const MODES = ['after_welcome', 'instant', 'tap', 'manual'];
  const UNDO_MAX = 20;
  const TURNS_MAX = 160;

  /* ---------- small helpers ---------- */
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const has = (ctx, f) => !!(ctx && ctx.plan && (ctx.plan.features || []).includes(f));
  const stepLimit = (ctx) => { const v = ctx && ctx.plan ? Number(ctx.plan.flow_steps) : -1; return Number.isFinite(v) ? v : -1; };
  const maxButtons = (ctx, d) => (isBotD(d) ? botMaxBtn(ctx) : ctx && ctx.plan && ctx.plan.branding ? 3 : 6);
  const textMax = (ctx) => TEXT_MAX - (ctx && ctx.plan && ctx.plan.branding ? BRAND_LEN : 0);
  function rid() { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; let s = 'b'; for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)]; return s; }
  const UNITS = [[86400, 'day'], [3600, 'hour'], [60, 'minute'], [1, 'second']];
  function waitText(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    if (!sec) return 'right away';
    for (const [n, w] of UNITS) if (sec % n === 0) { const v = sec / n; return v + ' ' + w + (v === 1 ? '' : 's'); }
    return sec + ' seconds';
  }
  /** "10 minutes", "10 min", "2h", "30s", "1 day", "tomorrow", "right away" → seconds (null when it isn't a time). */
  function parseDuration(t) {
    const s = String(t || '').toLowerCase().trim().replace(/[.!]+$/, '');
    if (!s) return null;
    if (/^(right away|now|immediately|straight away|at once|instantly|0)$/.test(s)) return 0;
    if (/^(tomorrow|a day|one day|next day)$/.test(s)) return 86400;
    if (/^(an|one|a) hour$/.test(s)) return 3600;
    if (/^(a|one) minute$/.test(s)) return 60;
    const m = /^(?:after |wait |in )?(\d{1,4})\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)(?: later)?$/.exec(s);
    if (!m) return null;
    const n = Number(m[1]);
    const u = m[2][0] === 's' ? 1 : m[2][0] === 'm' ? 60 : m[2][0] === 'h' ? 3600 : m[2][0] === 'd' ? 86400 : 604800;
    const v = n * u;
    return v > 0 && v <= MAX_WAIT ? v : null;
  }
  const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();
  const firstLine = (s, n = 60) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };

  /* ---------- Chat bots (services/bots.js): someone opens the bot through its link and taps Start ----------
   * A bot draft: { start_type: 'bot_start', name, bot_id, start_code, is_default, steps: [{ type, body, buttons, trigger,
   * check?, ask?, referral? }] } (the save API's format, services/flows.js AI_BOT_KEYS, with waits in seconds).
   * ctx.plan.bots (services/billing.js BOT_PLANS for the plan): { bot_types, bot_steps, menu_buttons,
   * lead_questions_per_form, max_bots, unlock: { type: plan name } }. Without it nothing is locked (the demo).
   */
  const BOT_STEP_TYPES = ['message', 'check_join', 'ask', 'referral'];
  const SPECIAL = ['check_join', 'ask', 'referral'];
  const ANSWERS = ['text', 'number', 'email', 'phone', 'choice'];
  const isBotD = (d) => !!(d && d.start_type === 'bot_start');
  const kindOf = (s) => (s && SPECIAL.includes(s.type) ? s.type : 'message');
  const botLim = (ctx) => (ctx && ctx.plan && ctx.plan.bots) || null;
  function botTypeOk(ctx, type) { const b = botLim(ctx); return !b || !Array.isArray(b.bot_types) || b.bot_types.includes(type); }
  function botMaxBtn(ctx) { const b = botLim(ctx); const n = b && b.menu_buttons != null ? Number(b.menu_buttons) : 12; return n < 0 ? 12 : Math.min(12, n); }
  function botStepLimit(ctx) { const b = botLim(ctx); return b && b.bot_steps != null ? Number(b.bot_steps) : -1; }
  function botQuestionLimit(ctx) { const b = botLim(ctx); const n = b && b.lead_questions_per_form != null ? Number(b.lead_questions_per_form) : -1; return n < 0 ? 15 : n; }
  /** Messages that count toward the plan's "messages per bot" (menu answers and check / question parts don't). */
  function botMsgs(d) { return d.steps.filter((s, i) => ['message', 'referral'].includes(kindOf(s)) && trigOf(s, i) !== 'on_button').length; }
  /** What a bot is, from its parts (services/bots.js botTypeOf). */
  function botTypeOfD(d) {
    const ks = new Set(d.steps.map(kindOf));
    if (ks.has('referral')) return 'referral';
    if (ks.has('ask')) return 'lead_questions';
    if (ks.has('check_join')) return 'join_check';
    if (d.steps.some((s, i) => trigOf(s, i) === 'on_button')) return 'menu';
    return 'lead_magnet';
  }
  const UNLOCK = { join_check: 'Free', lead_magnet: 'Free', menu: 'Free', broadcast: 'Starter', lead_questions: 'Starter', referral: 'Growth' };
  function unlockPlan(ctx, type) { const b = botLim(ctx); return (b && b.unlock && b.unlock[type]) || UNLOCK[type] || 'a bigger'; }
  const BOT_LOCK_WORDS = { join_check: 'Join-check bots are', lead_magnet: 'Free gift bots are', menu: 'Menu bots are', lead_questions: 'Bots that ask questions are', referral: 'Invite-friends bots are', broadcast: 'Sending one message to everyone who started your bots is' };
  function botLockText(ctx, type) { return BOT_LOCK_WORDS[type] + ' on the ' + unlockPlan(ctx, type) + ' plan and up.'; }

  /* ---------- safety: everything that reaches a draft passes here ---------- */
  const TAG_RX = /<\s*\/?\s*[a-z!?][^>]*>/i;
  const BAD_RX = /javascript\s*:|vbscript\s*:|data\s*:\s*text\/html|\bon[a-z]+\s*=\s*["']/i;
  // eslint-disable-next-line no-control-regex
  const CTRL_RX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
  function cleanText(v, max, what) {
    if (typeof v !== 'string') return { error: what + ' must be text.' };
    const t = v.replace(/\r\n?/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
    if (!t) return { error: what + ' is empty.' };
    if (TAG_RX.test(t) || BAD_RX.test(t)) return { error: what + ' has code in it (like <script> or javascript:), so I left it out.' };
    if (CTRL_RX.test(t)) return { error: what + ' has hidden characters in it.' };
    if ([...t].length > max) return { error: what + ' is too long (' + max + ' characters at most).' };
    return { value: t };
  }
  function cleanLabel(v) {
    const r = cleanText(typeof v === 'string' ? v.replace(/\s*\n\s*/g, ' ') : v, 40, 'The button text');
    return r;
  }
  function cleanUrl(v) {
    if (typeof v !== 'string') return { error: 'The link must be text.' };
    let u = v.trim();
    if (!u) return { error: 'The link is empty.' };
    if (/^(javascript|vbscript|data|file|about|blob|chrome)\s*:/i.test(u) || BAD_RX.test(u)) return { error: 'That link isn\'t a web page (only https:// links are allowed).' };
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) { if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(u) || /^t\.me\//i.test(u)) u = 'https://' + u; else return { error: 'That doesn\'t look like a link. It should look like https://your-site.com' }; }
    if (!/^https?:\/\/[^\s<>"'`]+\.[^\s<>"'`]+$/i.test(u) || u.length > 300) return { error: 'That doesn\'t look like a link. It should look like https://your-site.com' };
    if (/^http:\/\//i.test(u)) u = 'https://' + u.slice(7);
    return { value: u };
  }

  /* ---------- the flow's rules (services/flows.js flowGraph, on the draft) ---------- */
  function trigOf(s, i) {
    if (i === 0) return 'after_previous';
    const t = s.trigger && TRIGGERS.includes(s.trigger.type) ? s.trigger.type : 'after_previous';
    if (t === 'wait' && !(Number(s.trigger.seconds) > 0)) return 'after_previous';
    if (t === 'after_previous' && Number(s.trigger && s.trigger.seconds) > 0) return 'wait';
    return t;
  }
  function graph(d) {
    const out = [];
    const owners = new Map();
    let unit = null, group = null, started = false;
    d.steps.forEach((s, i) => {
      const t = trigOf(s, i);
      const info = { t, unit: unit ? unit.slice() : [] };
      if (t === 'on_start') started = true;
      if (i > 0 && t === 'no_response') {
        const btns = [];
        (unit || []).forEach((k) => (d.steps[k].buttons || []).forEach((b) => btns.push(b.id)));
        info.awaits = { start: !!d.start_button && !started, buttons: btns };
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
    for (const v of out) if (v.group) v.group = { owner: v.group.owner, members: v.group.members.slice() };
    return out;
  }
  const ownerOf = (d, id) => d.steps.findIndex((s) => (s.buttons || []).some((b) => b.id === id));
  const findButton = (d, id) => { for (const s of d.steps) for (const b of s.buttons || []) if (b.id === id) return b; return null; };
  /** A button by id or by its words ("VIP", "⭐ VIP signals"), among messages above `before` (all when null). */
  function resolveButton(d, ref, before) {
    if (ref == null) return null;
    const r = String(ref);
    const lim = before == null ? d.steps.length : before;
    for (let i = 0; i < lim; i++) for (const b of d.steps[i].buttons || []) if (b.id === r) return b;
    const n = norm(r);
    if (!n) return null;
    let hit = null;
    for (let i = 0; i < lim; i++) for (const b of d.steps[i].buttons || []) { const l = norm(b.label); if (l === n) return b; if (!hit && (l.includes(n) || n.includes(l)) && l) hit = b; }
    return hit;
  }

  /** The first thing that is not allowed in this draft for this plan ('' when it is fine). */
  function problems(d, ctx) {
    if (!d || !Array.isArray(d.steps)) return 'There\'s nothing here yet.';
    if (isBotD(d)) return botProblems(d, ctx);
    const n = d.steps.length;
    const lim = stepLimit(ctx);
    if (!n) return '';
    if (lim >= 0 && n > lim) return lim <= 1 ? 'Your ' + planName(ctx) + ' plan sends 1 welcome message. Follow-up messages are on Starter and up.' : 'Your ' + planName(ctx) + ' plan allows ' + lim + ' messages, and this would make ' + n + '.';
    if (!MODES.includes(d.approve_mode)) return 'Pick how people get in.';
    if (d.approve_mode === 'tap' && !has(ctx, 'tap_to_start')) return lockText('tap_to_start', ctx);
    if (d.approve_mode === 'manual' && !has(ctx, 'welcome_flows')) return lockText('welcome_flows', ctx);
    const startOn = d.approve_mode === 'tap' || !!d.start_button;
    if (startOn && !has(ctx, 'tap_to_start')) return lockText('tap_to_start', ctx);
    if (d.start_label != null && d.start_label !== '') { const r = cleanLabel(d.start_label); if (r.error) return 'The Start button: ' + r.error; }
    let waits = 0;
    const ids = new Set();
    for (const [i, s] of d.steps.entries()) {
      const what = i === 0 ? 'The welcome' : 'Message ' + (i + 1);
      const r = cleanText(s.body, textMax(ctx), what);
      if (r.error && !(s.media_id && /empty/.test(r.error))) return r.error;
      const bs = s.buttons || [];
      if (s.type != null && s.type !== 'message') {
        // A Welcome bot can check they joined after the welcome (built in the builder); the rest is for chat bots.
        if (s.type !== 'check_join') return what + ' is something only chat bots can do.';
        if (i === 0) return 'The welcome is a normal message. The join check comes right after it.';
        if (bs.length) return what + ' has its own buttons, so it can\'t have others.';
        if (!['after_previous', 'wait'].includes(trigOf(s, i))) return what + ' comes right away or after a wait.';
      }
      if (bs.length > maxButtons(ctx)) return ctx.plan && ctx.plan.branding ? 'The Free plan allows 3 buttons on the welcome.' : what + ' can have 6 buttons at most.';
      for (const b of bs) {
        if (!b.id || !/^[a-z0-9]{1,16}$/.test(b.id)) return what + ': a button has a broken id.';
        if (ids.has(b.id)) return what + ': two buttons have the same id.';
        ids.add(b.id);
        const l = cleanLabel(b.label); if (l.error) return what + ': ' + l.error;
        if (b.kind === 'reply') { if (!has(ctx, 'welcome_flows')) return lockText('reply', ctx); }
        else if (b.kind === 'link') { const u = cleanUrl(b.url); if (u.error) return what + ': "' + b.label + '": ' + u.error; }
        else return what + ': a button must be a link or a choice.';
      }
      if (s.start_flow_id != null) {
        if (!has(ctx, 'start_another_flow')) return lockText('start_another_flow', ctx);
        const f = (ctx.flows || []).find((x) => String(x.id) === String(s.start_flow_id));
        if (!f) return what + ': the welcome bot to start was not found.';
        if (d.bot_id && f.bot_id != null && String(f.bot_id) !== String(d.bot_id)) return what + ': pick one sent by the same bot.';
      }
      if (i === 0) continue;
      const t = trigOf(s, i);
      if (EVENT.includes(t) && !has(ctx, 'welcome_flows')) return lockText('welcome_flows', ctx);
      if (t === 'wait' || t === 'no_response') {
        const sec = Number(s.trigger.seconds);
        if (!Number.isInteger(sec) || sec < 1 || sec > MAX_WAIT) return what + ': the wait must be between 1 second and 365 days.';
        if (t === 'wait') waits += sec;
      }
      if (t === 'on_start' && !startOn) return what + ' comes when they tap Start, so the welcome needs its Tap Start button.';
      if (t === 'on_goal') return what + ' waits for an invite goal, which only chat bots have.';
    }
    if (waits > MAX_WAIT) return 'All the waits add up to more than 365 days.';
    const G = graph(d);
    for (let i = 1; i < n; i++) {
      const s = d.steps[i], t = G[i].t;
      if (t === 'on_button') {
        const o = ownerOf(d, s.trigger.button);
        if (o < 0 || o >= i) return 'Message ' + (i + 1) + ' answers a button that is not on a message above.';
        const same = G[i].group.members.filter((k) => d.steps[k].trigger.button === s.trigger.button);
        if (same.length > 1) return 'Two messages answer the same button.';
      }
      if (t === 'no_response' && !G[i].awaits.start && !G[i].awaits.buttons.length) return 'Message ' + (i + 1) + ' is a reminder, but the message above has nothing to tap.';
    }
    return '';
  }
  const LOCK = {
    welcome_flows: ['Messages after the welcome, buttons that send a message and "I\'ll let them in myself"', 'Starter'],
    reply: ['Buttons that send another message', 'Starter'],
    tap_to_start: ['The Tap Start button', 'Starter'],
    start_another_flow: ['Starting another welcome bot', 'Growth'],
    flow_steps: ['More messages', 'a bigger plan'],
  };
  function planName(ctx) { return (ctx && ctx.plan && ctx.plan.name) || 'current'; }
  function lockText(k) { const l = LOCK[k] || ['That', 'a bigger plan']; const one = /^(The|Starting) /.test(l[0]); return l[0] + (l[1].startsWith('a ') ? (one ? ' needs ' : ' need ') : (one ? ' is on ' : ' are on ')) + l[1] + (l[1].startsWith('a ') ? '.' : ' and up.'); }

  /** The first thing that is not allowed in a chat bot draft for this plan ('' when it is fine; services/flows.js cleanFlow + bots.js). */
  function botProblems(d, ctx) {
    const n = d.steps.length;
    if (!n) return '';
    const max = botMaxBtn(ctx);
    const ids = new Set();
    let refs = 0, waits = 0;
    for (const [i, s] of d.steps.entries()) {
      const what = i === 0 ? 'The first message' : 'Message ' + (i + 1);
      if (s.type != null && !BOT_STEP_TYPES.includes(s.type)) return what + ' is not something a bot can send.';
      const k = kindOf(s);
      const r = cleanText(s.body, textMax(ctx), what);
      if (r.error && !(k === 'message' && s.media_id && /empty/.test(r.error))) return r.error;
      const bs = s.buttons || [];
      if (k !== 'message' && bs.length) return what + ' has its own buttons, so it can\'t have others.';
      if (bs.length > max) return what + ' can have ' + max + ' buttons on your ' + planName(ctx) + ' plan.';
      for (const b of bs) {
        if (!b.id || !/^[a-z0-9]{1,16}$/.test(b.id)) return what + ': a button has a broken id.';
        if (ids.has(b.id)) return what + ': two buttons have the same id.';
        ids.add(b.id);
        const l = cleanLabel(b.label); if (l.error) return what + ': ' + l.error;
        if (b.kind === 'link') { const u = cleanUrl(b.url); if (u.error) return what + ': "' + b.label + '": ' + u.error; }
        else if (b.kind !== 'reply') return what + ': a button must be a link or a choice.';
      }
      if (s.start_flow_id != null) return what + ': starting another bot from here works in welcome bots.';
      if (k === 'check_join') {
        const c = s.check || {};
        if (c.remind != null && !(Number(c.remind.value) > 0)) return what + ': pick when the reminder comes.';
      }
      if (k === 'ask') {
        const a = s.ask || {};
        if (!ANSWERS.includes(a.answer || 'text')) return what + ': pick what kind of answer it waits for.';
        if (a.answer === 'choice') {
          const ch = (a.choices || []).map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
          if (ch.length < 2) return what + ': add at least 2 choices for them to tap.';
          if (ch.length > 8) return what + ': use 8 choices or fewer.';
          for (const c of ch) { const l = cleanLabel(c); if (l.error) return what + ': ' + l.error; }
          if (new Set(ch.map((x) => x.toLowerCase())).size !== ch.length) return what + ': two choices are the same.';
        }
        if (a.label != null && a.label !== '') { const l = cleanText(a.label, 40, 'The answer name'); if (l.error) return what + ': ' + l.error; }
      }
      if (k === 'referral') {
        refs++;
        const g = Number((s.referral || {}).goal);
        if (!Number.isInteger(g) || g < 1 || g > 1000) return what + ': pick how many friends (1 to 1,000).';
      }
      if (i === 0) continue;
      const t = trigOf(s, i);
      if (t === 'on_start') return what + ': everyone in this bot has tapped Start already, so it comes right away instead.';
      if (k !== 'message' && !['after_previous', 'wait'].includes(t)) return what + ' comes right away or after a wait.';
      if (t === 'on_goal' && !d.steps.slice(0, i).some((x) => kindOf(x) === 'referral')) return what + ' comes when they reach their invite goal, so it needs an "Invite friends" part above it.';
      if (t === 'wait' || t === 'no_response') {
        const sec = Number(s.trigger.seconds);
        if (!Number.isInteger(sec) || sec < 1 || sec > MAX_WAIT) return what + ': the wait must be between 1 second and 365 days.';
        if (t === 'wait') waits += sec;
      }
    }
    if (refs > 1) return 'A bot can have one "Invite friends" part.';
    if (waits > MAX_WAIT) return 'All the waits add up to more than 365 days.';
    const G = graph(d);
    for (let i = 1; i < n; i++) {
      const s = d.steps[i], t = G[i].t;
      if (t === 'on_button') {
        const o = ownerOf(d, s.trigger.button);
        if (o < 0 || o >= i) return 'Message ' + (i + 1) + ' answers a button that is not on a message above.';
        const same = G[i].group.members.filter((k) => d.steps[k].trigger.button === s.trigger.button);
        if (same.length > 1) return 'Two messages answer the same button.';
      }
      if (t === 'no_response' && !G[i].awaits.buttons.length) return 'Message ' + (i + 1) + ' is a reminder, but the message above has nothing to tap.';
    }
    const any = (k) => d.steps.some((s) => kindOf(s) === k);
    if (any('check_join') && !botTypeOk(ctx, 'join_check')) return botLockText(ctx, 'join_check');
    if (any('ask') && !botTypeOk(ctx, 'lead_questions')) return botLockText(ctx, 'lead_questions');
    if (any('referral') && !botTypeOk(ctx, 'referral')) return botLockText(ctx, 'referral');
    const b = botLim(ctx);
    if (b && b.lead_questions_per_form != null && Number(b.lead_questions_per_form) >= 0) {
      const q = d.steps.filter((s) => kindOf(s) === 'ask').length;
      if (q > Number(b.lead_questions_per_form)) return 'Your ' + planName(ctx) + ' plan asks up to ' + b.lead_questions_per_form + ' questions per bot, and this would make ' + q + '.';
    }
    const lim = botStepLimit(ctx);
    const m = botMsgs(d);
    if (lim >= 0 && m > lim) return lim <= 1 ? 'On your ' + planName(ctx) + ' plan a bot sends 1 message per reply (a menu can still answer each button).' : 'Your ' + planName(ctx) + ' plan allows ' + lim + ' messages per bot, and this would make ' + m + '.';
    return '';
  }

  /** Reply buttons two side by side, link buttons one a row (as the builder saves them). */
  function withRows(buttons) {
    let row = -1, inRow = 0, prev = null;
    return (buttons || []).map((b) => {
      const pair = prev && inRow === 1 && b.kind === 'reply' && prev.kind === 'reply';
      if (pair) inRow = 2; else { row++; inRow = 1; }
      prev = b;
      return { ...b, row };
    });
  }
  /** The draft as the body of POST /api/flows or PUT /api/flows/:id. */
  function toBody(d) {
    if (isBotD(d)) return botBody(d);
    return {
      name: d.name, chat_id: d.chat_id || null, bot_id: d.bot_id || null, approve_mode: d.approve_mode, start_button: d.approve_mode === 'tap' || !!d.start_button,
      start_label: d.start_label || '', invite_link: d.invite_link || null,
      steps: d.steps.map((s, i) => ({
        id: s.id || null, body: s.body, media_id: s.media_id || null, condition: s.condition || null, variants: s.variants || [],
        buttons: withRows(s.buttons || []).map((b) => ({ id: b.id, label: b.label, url: b.kind === 'reply' ? '' : b.url || '', kind: b.kind, row: b.row })),
        trigger: i === 0 ? null : (() => { const t = trigOf(s, i); return t === 'wait' || t === 'no_response' ? { type: t, seconds: Number(s.trigger.seconds) } : t === 'on_button' ? { type: t, button: s.trigger.button } : { type: t }; })(),
        start_flow_id: s.start_flow_id || null,
        ...(kindOf(s) === 'check_join' ? { type: 'check_join', check: checkOut(s.check) } : {}),
      })),
    };
  }
  const remindOut = (r) => (r && Number(r.value) > 0 ? { value: Number(r.value), unit: r.unit || 'min' } : null);
  function checkOut(c) { c = c || {}; return { chat_id: c.chat_id || null, open_label: c.open_label || '', join_label: c.join_label || '', link: c.link || '', nudge: c.nudge || '', remind: remindOut(c.remind), remind_text: c.remind_text || '' }; }
  function askOut(a) { a = a || {}; const answer = ANSWERS.includes(a.answer) ? a.answer : 'text'; return { answer, choices: answer === 'choice' ? (a.choices || []).map((x) => String(x).trim()).filter(Boolean) : [], label: a.label || '', button: a.button || '', retry_text: a.retry_text || '', remind: remindOut(a.remind), remind_text: a.remind_text || '' }; }
  function trigBody(s, i) { if (i === 0) return null; const t = trigOf(s, i); return t === 'wait' || t === 'no_response' ? { type: t, seconds: Number(s.trigger.seconds) } : t === 'on_button' ? { type: t, button: s.trigger.button } : { type: t }; }
  /** A chat bot draft as the body of POST /api/flows (start_type bot_start). */
  function botBody(d) {
    return {
      start_type: 'bot_start', name: d.name, bot_id: d.bot_id || null, start_code: d.start_code || '', is_default: !!d.is_default,
      steps: d.steps.map((s, i) => {
        const k = kindOf(s);
        const out = { id: s.id || null, type: k, body: s.body, media_id: s.media_id || null, trigger: trigBody(s, i),
          buttons: k === 'message' ? withRows(s.buttons || []).map((b) => ({ id: b.id, label: b.label, url: b.kind === 'reply' ? '' : b.url || '', kind: b.kind, row: b.row })) : [] };
        if (k === 'check_join') out.check = checkOut(s.check);
        if (k === 'ask') out.ask = askOut(s.ask);
        if (k === 'referral') out.referral = { goal: Number((s.referral || {}).goal) || 3 };
        return out;
      }),
    };
  }
  const SECS = { sec: 1, min: 60, hour: 3600, day: 86400 };
  const remindIn = (r) => (r && (Number(r.value) > 0 || Number(r.seconds) > 0) ? (Number(r.value) > 0 ? { value: Number(r.value), unit: r.unit || 'min' } : (() => { const sec = Number(r.seconds); for (const [n, u] of [[86400, 'day'], [3600, 'hour'], [60, 'min']]) if (sec % n === 0) return { value: sec / n, unit: u }; return { value: sec, unit: 'sec' }; })()) : null);
  function stepIn(s, i) {
    const k = kindOf(s);
    const out = {
      id: s.id || null, body: s.body || '', media_id: s.media_id || null, condition: s.condition || null, variants: s.variants || [],
      buttons: k === 'message' ? (s.buttons || []).map((b) => ({ id: b.id, label: b.label || '', url: b.url || '', kind: b.kind === 'reply' ? 'reply' : 'link' })) : [],
      trigger: i === 0 || !s.trigger ? null : { type: s.trigger.type, seconds: s.trigger.seconds != null ? Number(s.trigger.seconds) : (Number(s.trigger.value) || 0) * (SECS[s.trigger.unit] || 60), button: s.trigger.button || null },
      start_flow_id: s.start_flow_id || null,
    };
    if (k !== 'message') out.type = k;
    if (k === 'check_join') out.check = { ...checkOut(s.check), remind: remindIn((s.check || {}).remind) };
    if (k === 'ask') out.ask = { ...askOut(s.ask), remind: remindIn((s.ask || {}).remind) };
    if (k === 'referral') out.referral = { goal: Number((s.referral || {}).goal) || 3 };
    return out;
  }
  /** A saved flow (services/flows.js detail()) → a draft. */
  function fromFlow(f) {
    if (f && f.start_type === 'bot_start') {
      return { start_type: 'bot_start', name: f.name, bot_id: f.bot_id || null, start_code: f.start_code || '', is_default: !!f.is_default, steps: (f.steps || []).map((s, i) => { const o = stepIn(s, i); if (!o.type) o.type = 'message'; delete o.variants; delete o.condition; return o; }) };
    }
    return {
      name: f.name, chat_id: f.chat_id || null, bot_id: f.bot_id || null, approve_mode: f.approve_mode || 'after_welcome', start_button: !!f.start_button, start_label: f.start_label || '', invite_link: f.invite_link || null,
      steps: (f.steps || []).map((s, i) => ({
        id: s.id || null, body: s.body || '', media_id: s.media_id || null, condition: s.condition || null, variants: s.variants || [],
        buttons: (s.buttons || []).map((b) => ({ id: b.id, label: b.label || '', url: b.url || '', kind: b.kind === 'reply' ? 'reply' : 'link' })),
        trigger: i === 0 || !s.trigger ? null : { type: s.trigger.type, seconds: s.trigger.seconds != null ? Number(s.trigger.seconds) : (Number(s.trigger.value) || 0) * ({ sec: 1, min: 60, hour: 3600, day: 86400 }[s.trigger.unit] || 60), button: s.trigger.button || null },
        start_flow_id: s.start_flow_id || null,
        ...(kindOf(s) === 'check_join' ? { type: 'check_join', check: { ...checkOut(s.check), remind: remindIn((s.check || {}).remind) } } : {}),
      })),
    };
  }

  /* ---------- operations (from the AI's tool calls, or the demo's keyword rules) ---------- */
  const OPS = {
    add_message: ['after', 'trigger', 'text', 'buttons', 'brief'],
    update_message: ['message', 'text', 'rewrite', 'brief'],
    delete_step: ['message'],
    set_trigger: ['message', 'type', 'seconds', 'button'],
    set_wait: ['message', 'seconds'],
    add_button: ['message', 'label', 'kind', 'url'],
    remove_button: ['message', 'button'],
    update_button: ['message', 'button', 'label', 'url'],
    set_approve_mode: ['mode'],
    set_start_button: ['on', 'label'],
    reorder: ['message', 'to'],
    start_another_flow: ['message', 'flow'],
    rename_flow: ['name'],
    ask_user: ['question', 'chips'],
  };
  const OP_NAMES = Object.keys(OPS);
  const isInt = (v) => Number.isInteger(v);

  /** Where a new message goes: after `after` (a message number), else where it makes sense for its trigger. */
  function placeFor(d, trigger) {
    if (trigger && trigger.type === 'on_button') {
      const o = ownerOf(d, trigger.button);
      if (o >= 0) { let i = o + 1; while (i < d.steps.length && (trigOf(d.steps[i], i) === 'no_response' || (trigOf(d.steps[i], i) === 'on_button' && ownerOf(d, d.steps[i].trigger.button) === o))) i++; return i; }
    }
    return d.steps.length;
  }
  function normTrigger(raw, d, at, errs) {
    if (raw == null) return { type: 'after_previous' };
    if (typeof raw !== 'object' || Array.isArray(raw)) { errs.push('the "when" of a message is not right'); return null; }
    for (const k of Object.keys(raw)) if (!['type', 'seconds', 'button'].includes(k)) { errs.push('unknown field "' + String(k).slice(0, 20) + '"'); return null; }
    if (!TRIGGERS.includes(raw.type)) { errs.push('"' + String(raw.type).slice(0, 20) + '" is not a way for a message to come'); return null; }
    const out = { type: raw.type };
    if (raw.type === 'wait' || raw.type === 'no_response' || (raw.type === 'after_previous' && raw.seconds)) {
      const sec = Number(raw.seconds);
      if (!isInt(sec) || sec < (raw.type === 'after_previous' ? 0 : 1) || sec > MAX_WAIT) { errs.push('a wait must be between 1 second and 365 days'); return null; }
      out.seconds = sec;
      if (out.type === 'after_previous' && sec > 0) out.type = 'wait';
    }
    if (raw.type === 'on_button') {
      const b = resolveButton(d, raw.button, at == null ? null : at);
      if (!b) { errs.push('I couldn\'t find the button "' + firstLine(raw.button, 30) + '" on a message above'); return null; }
      out.button = b.id;
    } else if (raw.button != null && raw.type !== 'on_button') { errs.push('only "when they tap a button" names a button'); return null; }
    return out;
  }
  function msgIndex(d, v, errs, { welcomeOk = true } = {}) {
    if (!isInt(v) || v < 1 || v > d.steps.length) { errs.push('there is no message ' + firstLine(String(v), 10)); return -1; }
    if (!welcomeOk && v === 1) { errs.push('the welcome always comes first and can\'t be removed or moved'); return -1; }
    return v - 1;
  }
  /**
   * Apply operations to a COPY of the draft. All or nothing: one bad operation (unknown name or field, code in a
   * text, a javascript: link, a button that isn't there, more messages than the plan allows...) refuses them all.
   * Returns { ok, draft, done: [what changed, in plain words], error, ask: { question, chips } | null, focus }.
   */
  function applyOps(draft, ops, ctx) {
    const d = clone(draft);
    const done = [];
    const errs = [];
    let ask = null, focus = null;
    if (!Array.isArray(ops) || !ops.length) return { ok: false, error: 'I wasn\'t sure what to change.' };
    if (ops.length > 12) return { ok: false, error: 'That\'s a lot at once. Let\'s do it a bit at a time.' };
    for (const raw of ops) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errs.push('one change was empty'); break; }
      const op = raw.op;
      if (!OP_NAMES.includes(op)) { errs.push('I don\'t know how to "' + firstLine(String(op || ''), 30) + '"'); break; }
      const bad = Object.keys(raw).find((k) => k !== 'op' && !OPS[op].includes(k));
      if (bad) { errs.push('unknown field "' + String(bad).slice(0, 20) + '"'); break; }
      if (isBotD(d) && ['set_approve_mode', 'set_start_button', 'start_another_flow'].includes(op)) { errs.push('that works in welcome bots, not in this bot'); break; }
      if (op === 'add_message') {
        const at0 = raw.after == null ? null : raw.after;
        if (at0 != null && (!isInt(at0) || at0 < 1 || at0 > d.steps.length)) { errs.push('there is no message ' + firstLine(String(at0), 10)); break; }
        if (!d.steps.length) { const r = cleanText(raw.text, textMax(ctx), 'The welcome'); if (r.error) { errs.push(r.error); break; } d.steps.push({ body: r.value, buttons: [], trigger: null }); done.push('Wrote your welcome'); focus = 0; continue; }
        const tr = normTrigger(raw.trigger, d, at0 == null ? null : at0, errs); if (!tr) break;
        const r = cleanText(raw.text, textMax(ctx), 'The new message'); if (r.error) { errs.push(r.error); break; }
        const at = at0 != null ? at0 : placeFor(d, tr);
        const s = { body: r.value, buttons: [], trigger: tr, start_flow_id: null };
        if (raw.buttons != null) {
          if (!Array.isArray(raw.buttons) || raw.buttons.length > maxButtons(ctx, d)) { errs.push('the new message has too many buttons'); break; }
          for (const b of raw.buttons) { const nb = mkButton(d, b, errs); if (!nb) break; s.buttons.push(nb); }
          if (errs.length) break;
        }
        d.steps.splice(at, 0, s);
        focus = at;
        done.push('Added message ' + (at + 1) + ' (' + whenWords(d, at) + ')');
      } else if (op === 'update_message') {
        const i = msgIndex(d, raw.message, errs); if (i < 0) break;
        const r = cleanText(raw.text, textMax(ctx), i === 0 ? 'The welcome' : 'Message ' + (i + 1)); if (r.error) { errs.push(r.error); break; }
        d.steps[i].body = r.value; focus = i;
        done.push('Changed ' + (i === 0 ? 'the welcome' : 'message ' + (i + 1)));
      } else if (op === 'delete_step') {
        const i = msgIndex(d, raw.message, errs, { welcomeOk: false }); if (i < 0) break;
        const ids = new Set((d.steps[i].buttons || []).map((b) => b.id));
        d.steps.forEach((x, k) => { if (k !== i && x.trigger && x.trigger.type === 'on_button' && ids.has(x.trigger.button)) x.trigger = { type: 'after_previous' }; });
        d.steps.splice(i, 1);
        done.push('Removed message ' + (i + 1));
        focus = Math.min(i, d.steps.length - 1);
      } else if (op === 'set_trigger') {
        const i = msgIndex(d, raw.message, errs, { welcomeOk: false }); if (i < 0) break;
        const tr = normTrigger({ type: raw.type, ...(raw.seconds != null ? { seconds: raw.seconds } : {}), ...(raw.button != null ? { button: raw.button } : {}) }, d, i, errs); if (!tr) break;
        d.steps[i].trigger = tr; focus = i;
        done.push('Message ' + (i + 1) + ' now comes ' + whenWords(d, i));
      } else if (op === 'set_wait') {
        const i = msgIndex(d, raw.message, errs, { welcomeOk: false }); if (i < 0) break;
        const sec = Number(raw.seconds);
        if (!isInt(sec) || sec < 0 || sec > MAX_WAIT) { errs.push('a wait must be between 0 seconds and 365 days'); break; }
        const cur = trigOf(d.steps[i], i);
        if (cur === 'no_response') { if (sec < 1) { errs.push('a reminder needs a wait of at least 1 second'); break; } d.steps[i].trigger = { type: 'no_response', seconds: sec }; }
        else if (cur === 'on_start' || cur === 'on_button') { errs.push('message ' + (i + 1) + ' waits for a tap, not for a time. Say "send it after a wait" to change that'); break; }
        else d.steps[i].trigger = sec ? { type: 'wait', seconds: sec } : { type: 'after_previous' };
        focus = i;
        done.push('Message ' + (i + 1) + ' now comes ' + whenWords(d, i));
      } else if (op === 'add_button') {
        const i = msgIndex(d, raw.message, errs); if (i < 0) break;
        if ((d.steps[i].buttons || []).length >= maxButtons(ctx, d)) { errs.push((i === 0 ? (isBotD(d) ? 'the first message' : 'the welcome') : 'message ' + (i + 1)) + ' already has ' + maxButtons(ctx, d) + ' buttons'); break; }
        const nb = mkButton(d, { label: raw.label, kind: raw.kind, url: raw.url }, errs); if (!nb) break;
        d.steps[i].buttons = (d.steps[i].buttons || []).concat(nb); focus = i;
        done.push('Added the button "' + nb.label + '" to ' + (i === 0 ? 'the welcome' : 'message ' + (i + 1)));
      } else if (op === 'remove_button') {
        const i = msgIndex(d, raw.message, errs); if (i < 0) break;
        const b = resolveButton({ steps: [d.steps[i]] }, raw.button, null);
        if (!b) { errs.push('I couldn\'t find that button on ' + (i === 0 ? 'the welcome' : 'message ' + (i + 1))); break; }
        d.steps.forEach((x) => { if (x.trigger && x.trigger.type === 'on_button' && x.trigger.button === b.id) x.trigger = { type: 'after_previous' }; });
        d.steps[i].buttons = d.steps[i].buttons.filter((x) => x.id !== b.id); focus = i;
        done.push('Removed the button "' + b.label + '"');
      } else if (op === 'update_button') {
        const i = msgIndex(d, raw.message, errs); if (i < 0) break;
        const b = resolveButton({ steps: [d.steps[i]] }, raw.button, null);
        if (!b) { errs.push('I couldn\'t find that button on ' + (i === 0 ? 'the welcome' : 'message ' + (i + 1))); break; }
        if (raw.label == null && raw.url == null) { errs.push('say what the button should say'); break; }
        if (raw.label != null) { const l = cleanLabel(raw.label); if (l.error) { errs.push(l.error); break; } b.label = l.value; }
        if (raw.url != null) {
          if (b.kind !== 'link') { errs.push('a choice button has no link'); break; }
          const u = cleanUrl(raw.url); if (u.error) { errs.push(u.error); break; } b.url = u.value;
        }
        focus = i;
        done.push('Changed the button "' + b.label + '"');
      } else if (op === 'set_approve_mode') {
        if (!MODES.includes(raw.mode)) { errs.push('"' + firstLine(String(raw.mode), 20) + '" is not a way to let people in'); break; }
        d.approve_mode = raw.mode;
        if (raw.mode === 'tap') { d.start_button = true; if (!d.start_label || d.start_label === '👆 Tap Start') d.start_label = '✅ Tap to join'; }
        done.push('People now get in ' + MODE_WORDS[raw.mode]);
      } else if (op === 'set_start_button') {
        if (typeof raw.on !== 'boolean') { errs.push('say whether the Start button is on or off'); break; }
        if (!raw.on && d.steps.some((s, i) => trigOf(s, i) === 'on_start')) { errs.push('a message comes "when they tap Start", so the Start button is needed'); break; }
        if (!raw.on && d.approve_mode === 'tap') { errs.push('"When they tap Start" needs the Start button'); break; }
        d.start_button = raw.on;
        if (raw.label != null) { const l = cleanLabel(raw.label); if (l.error) { errs.push(l.error); break; } d.start_label = l.value; }
        else if (raw.on && !d.start_label) d.start_label = '👆 Tap Start';
        done.push(raw.on ? 'The welcome has a "' + (d.start_label || '👆 Tap Start') + '" button' : 'Removed the Tap Start button');
      } else if (op === 'reorder') {
        const i = msgIndex(d, raw.message, errs, { welcomeOk: false }); if (i < 0) break;
        if (!isInt(raw.to) || raw.to < 2 || raw.to > d.steps.length) { errs.push('a message can move to place 2 to ' + d.steps.length); break; }
        const [m] = d.steps.splice(i, 1); d.steps.splice(raw.to - 1, 0, m);
        d.steps.forEach((s, k) => { if (s.trigger && s.trigger.type === 'on_button') { const o = ownerOf(d, s.trigger.button); if (o < 0 || o >= k) s.trigger = { type: 'after_previous' }; } });
        focus = raw.to - 1;
        done.push('Moved message ' + (i + 1) + ' to place ' + raw.to);
      } else if (op === 'start_another_flow') {
        const i = msgIndex(d, raw.message, errs); if (i < 0) break;
        if (raw.flow == null) { d.steps[i].start_flow_id = null; done.push('Message ' + (i + 1) + ' no longer starts another welcome bot'); continue; }
        const f = (ctx.flows || []).find((x) => String(x.id) === String(raw.flow) || norm(x.name) === norm(raw.flow));
        if (!f) { errs.push('I couldn\'t find that one'); break; }
        d.steps[i].start_flow_id = f.id; focus = i;
        done.push('After message ' + (i + 1) + ', "' + f.name + '" starts for them');
      } else if (op === 'rename_flow') {
        const r = cleanText(raw.name, 60, 'The name'); if (r.error) { errs.push(r.error); break; }
        d.name = r.value.replace(/\s*\n\s*/g, ' ');
        done.push('Renamed it to "' + d.name + '"');
      } else if (op === 'ask_user') {
        const q = cleanText(raw.question, 300, 'The question'); if (q.error) { errs.push(q.error); break; }
        const chips = [];
        if (raw.chips != null) {
          if (!Array.isArray(raw.chips) || raw.chips.length > 5) { errs.push('too many answers to pick from'); break; }
          for (const c of raw.chips) { const l = cleanText(c, 40, 'An answer'); if (l.error) { errs.push(l.error); break; } chips.push(l.value); }
          if (errs.length) break;
        }
        ask = { question: q.value, chips };
      }
    }
    if (errs.length) return { ok: false, error: cap(String(errs[0]).replace(/[.\s]+$/, '')) + '.' };
    if (!done.length && !ask) return { ok: false, error: 'I wasn\'t sure what to change.' };
    const p = problems(d, ctx);
    if (p) return { ok: false, error: p };
    return { ok: true, draft: d, done, ask, focus };
  }
  function mkButton(d, b, errs) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) { errs.push('a button is empty'); return null; }
    for (const k of Object.keys(b)) if (!['label', 'kind', 'url', 'id'].includes(k)) { errs.push('unknown field "' + String(k).slice(0, 20) + '"'); return null; }
    const kind = b.kind == null ? (b.url ? 'link' : 'reply') : b.kind;
    if (!['link', 'reply'].includes(kind)) { errs.push('a button must be a link or a choice'); return null; }
    const l = cleanLabel(b.label); if (l.error) { errs.push(l.error); return null; }
    let url = '';
    if (kind === 'link') { const u = cleanUrl(b.url == null ? '' : b.url); if (u.error) { errs.push('"' + l.value + '": ' + u.error); return null; } url = u.value; }
    else if (b.url) { errs.push('a choice button has no link'); return null; }
    let id; do id = rid(); while (findButton(d, id));
    return { id, label: l.value, url, kind };
  }
  const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
  const MODE_WORDS = { after_welcome: 'after the welcome', instant: 'straight away', tap: 'when they tap Start', manual: 'when you let them in' };
  function whenWords(d, i) {
    if (i === 0) return isBotD(d) ? 'the moment they tap Start' : 'the moment they ask to join';
    const s = d.steps[i], t = trigOf(s, i);
    if (t === 'on_goal') return 'when they reach their invite goal';
    if (t === 'after_previous') return 'right after the message above';
    if (t === 'wait') return waitText(s.trigger.seconds) + ' after the message above';
    if (t === 'on_start') return 'when they tap Start';
    if (t === 'on_button') { const b = findButton(d, s.trigger.button); return 'when they tap "' + (b ? b.label : 'a button') + '"'; }
    return 'as a reminder if they don\'t tap in ' + waitText(s.trigger.seconds);
  }

  /* ---------- ready-made texts (used by "Just build it", when the AI is resting or unreachable, and in the demo) ---------- */
  // [key, what it matches, what they get, a tip, what the channel shares]
  const TOPICS = [
    ['trading', /(trad|forex|signal|crypto|stock|market|invest|\bfx\b|bitcoin)/, 'Daily trading signals and market updates, straight to your phone 📈', 'Always set a stop loss before you enter a trade. Small losses are part of the plan 💡', 'signals'],
    ['sports', /(sport|bet|football|soccer|match|tips|odds|league)/, 'Our best match tips, every matchday ⚽', 'Stick to a fixed stake per tip. Patience beats chasing losses 💡', 'tips'],
    ['shop', /(shop|store|fashion|product|sell|deal|drop|cloth)/, 'New drops and members-only deals land here first 🛍️', 'Turn on notifications: our best deals sell out in hours 💡', 'deals'],
    ['learn', /(lesson|learn|course|class|teach|school|tutor|study)/, 'Short, useful lessons you can use the same day 📚', 'Try today\'s lesson in the next 24 hours: that\'s how it sticks 💡', 'lessons'],
    ['community', /(community|group|chat|network|friends|club)/, 'A friendly place to ask, share and learn together 💬', 'Say hello in the group and tell us what brought you here 💡', 'updates'],
  ];
  const TOPIC_ANY = ['generic', null, 'Here you get our best updates, straight to your phone ✨', 'Turn on notifications so you never miss a post 💡', 'updates'];
  function aboutWords(st) { return String(st.about || '').replace(/^[^\p{L}\p{N}]+/u, '').trim(); }
  function topicOf(st) { const a = aboutWords(st).toLowerCase(); const t = TOPICS.find((x) => x[1].test(a)) || TOPIC_ANY; return { key: t[0], line: t[2], tip: t[3], things: t[4] }; }
  function brandOf(st) { if (st.business) return st.business; if (st.about_chip) return ''; const a = aboutWords(st); return a && a.length <= 34 ? a.replace(/^(my|our)\s+/i, '') : ''; }

  /* What the owner wants when someone joins (the first question). */
  const GOALS = {
    welcome: { chip: 'Welcome them 👋', purpose: 'thanks' },
    link: { chip: 'Send them my link 🔗', purpose: 'link', link: true, btn: '🔗 Open the link', ask: 'Paste the link you\'d like them to get 🔗', offer: 'Shall I send your link after they tap Start? 👆' },
    gift: { chip: 'Give a free gift 🎁', purpose: 'gift', link: true, btn: '🎁 Get my gift', ask: 'Paste the link to your free gift 🎁', offer: 'Shall I send the gift after they tap Start? 👆' },
    vip: { chip: 'Offer VIP 💎', purpose: 'vip', link: true, btn: '💎 Join VIP', ask: 'Paste your VIP link, the one people use to join 💎', offer: 'Shall I tell them about VIP after they tap Start? 👆' },
    other: { chip: 'Something else ✍️', purpose: 'brief' },
  };
  const GOAL_ORDER = ['welcome', 'link', 'gift', 'vip', 'other'];
  const goalOf = (st) => GOALS[st.goal] || GOALS.welcome;
  const NUDGE = {
    // Message 2 comes after the welcome, and the Tap Start button sits under the welcome: it is ABOVE this message.
    link: '👆 Tap *Start* above and I\'ll send you the link right away.',
    gift: '🎁 Your free gift is ready! Tap *Start* above to get it.',
    vip: '💎 Curious about VIP? Tap *Start* above and I\'ll show you.',
    welcome: '👆 Tap *Start* above and I\'ll send you a quick tip.',
  };
  const REMIND = {
    link: 'Still there, {name}? Your link is waiting above 👆',
    gift: 'Don\'t miss your free gift, {name} 🎁 Tap the button above to get it.',
    vip: 'VIP is open, {name} 💎 Tap the button above to join.',
  };
  function valueText(st, purpose, withButton) {
    const T = topicOf(st);
    if (!withButton && ['link', 'gift', 'vip'].includes(purpose)) return 'Thanks for tapping Start, {name}! 🎉\n\n' + T.tip;
    if (purpose === 'link') return 'Here\'s your link, {name} 👇 Tap the button below to open it.';
    if (purpose === 'gift') return 'Here\'s your free gift, {name} 🎁 Tap the button below to get it.';
    if (purpose === 'vip') return 'Our VIP members get our best ' + T.things + ' first 💎 Tap below to join us, {name}.';
    return 'Thanks for tapping Start, {name}! 🎉\n\n' + T.tip;
  }
  const PURPOSES = {
    link: ['🔗 Share a link', 'share a link (a button with the link comes next)'],
    tip: ['💡 Give a tip', 'give one short, useful tip'],
    offer: ['🎁 Share an offer', 'share the current offer'],
    thanks: ['🙏 Say thanks', 'thank them and say what comes next'],
    choice: ['🔀 Let them choose', 'ask them to pick one option (the choice buttons come next)'],
  };
  function welcomeText(st) {
    const brand = brandOf(st);
    return 'Hi {name} 👋 Welcome' + (brand ? ' to *' + brand + '*' : '') + '!\n\n' + topicOf(st).line;
  }
  function fallbackText(role, st, req) {
    req = req || {};
    if (role === 'welcome') return welcomeText(st) + (st.draft.start_button ? '\n\nTap *Start* below to get more 👇' : '');
    if (role === 'answer') return 'Great choice, {name}! ' + (req.label ? req.label + ' it is. ' : '') + 'Here\'s what\'s next 👇';
    if (role === 'reminder') return reminderText(st.draft, req.target);
    if (role === 'rewrite') {
      const cur = String(st.draft.steps[req.index] ? st.draft.steps[req.index].body : '');
      if (req.how === 'shorter') { const parts = cur.split(/\n{2,}/); return parts.length > 1 ? parts.slice(0, Math.max(1, parts.length - 1)).join('\n\n') : cur.replace(/\s*[^.!?]+[.!?]\s*$/, '').trim() || cur; }
      if (req.how === 'friendlier') return /^(hi|hey|hello)\b/i.test(cur) ? cur.replace(/^(\S+)/, '$1') + ' 😊' : 'Hi {name} 😊 ' + cur;
      return cur;
    }
    const p = req.purpose;
    if (req.value) return valueText(st, p === 'brief' ? 'thanks' : p, !!st.link);
    if (p === 'link') return 'Here\'s your link, {name} 👇';
    if (p === 'tip') return 'A quick tip for you, {name} 💡\n\n' + topicOf(st).tip;
    if (p === 'offer') return 'Something special for you, {name} 🎁\n\nOur latest offer is open for members now.';
    if (p === 'thanks') return valueText(st, 'thanks');
    if (p === 'choice') return 'Great, {name}! What would you like?';
    return 'Hi {name} 👋' + (req.brief ? '\n\n' + firstLine(req.brief, 200) : '');
  }
  function reminderText(d, target) {
    if (target === 'start') return 'Still there, {name}? 👆\n\nPlease tap the button above, then *Start*, to continue.';
    return 'Still there, {name}? 👆\n\nTap one of the buttons above to pick what you\'d like.';
  }
  function addEmoji(body) {
    const t = String(body || '');
    const first = t.split('\n')[0];
    if (/\p{Extended_Pictographic}/u.test(first)) return /\p{Extended_Pictographic}\s*$/u.test(t) ? '✨ ' + t : t + ' ✨';
    return first.replace(/([.!?])?$/, (m) => (m || '') + ' 👋') + t.slice(first.length);
  }

  /* ---------- "below" and "above": words that point at a button must point the right way ----------
   * In Telegram a message's buttons sit right under that message, and the Tap Start button sits under the welcome.
   * So a message says "below" / 👇 only for its OWN buttons, and "above" / 👆 for a button on a message higher up
   * (the Start button, for every message after the welcome). directionIssues() finds words that point the wrong way;
   * fixDirections() turns them around (used by Cas's own texts, and by the [Fix it] tip in both builders).
   */
  const DIR_RX = /👇|👆|⬇️|⬆️|\b(?:below|above)\b/giu;
  const DOWN_RX = /👇|⬇|below/i;
  const TAP_RX = /\b(tap|taps|tapping|press|click|button|buttons|link)\b/i;
  const START_RX = /\b(tap|taps|tapping|press|click)\b[^.!?\n]{0,24}\bstart\b/i;
  const startOnOf = (d) => d.approve_mode === 'tap' || !!d.start_button;
  /** The sentences of a text, as [from, to] (a new line or . ! ? and a space ends one). */
  function sentences(t) {
    const out = [];
    const rx = /([.!?])\s+|\n+/g;
    let m, s = 0;
    while ((m = rx.exec(t))) { const end = m.index + (m[1] ? 1 : 0); if (end > s) out.push([s, end]); s = m.index + m[0].length; }
    if (s < t.length) out.push([s, t.length]);
    return out;
  }
  /** Which message holds the button a sentence talks about: { at, what } or null (it doesn't name one). */
  function pointsAt(d, i, seg, G) {
    const n = ' ' + norm(seg) + ' ';
    const own = d.steps[i].buttons || [];
    const named = (b) => { const l = norm(b.label); return l.length >= 3 && n.includes(' ' + l + ' '); };
    for (const b of own) if (named(b)) return { at: i, what: 'the "' + b.label + '" button' };
    for (let k = i - 1; k >= 0; k--) for (const b of d.steps[k].buttons || []) if (named(b)) return { at: k, what: 'the "' + b.label + '" button' };
    for (let k = i + 1; k < d.steps.length; k++) for (const b of d.steps[k].buttons || []) if (named(b)) return { at: k, what: 'the "' + b.label + '" button' };
    if (startOnOf(d)) { const sl = norm(d.start_label || ''); if ((sl.length >= 3 && n.includes(' ' + sl + ' ')) || START_RX.test(seg) || /\*start\*/i.test(seg)) return { at: 0, what: 'the Start button' }; }
    if (!TAP_RX.test(seg)) return null;
    if (own.length) return { at: i, what: 'its button' };
    if (i === 0 && startOnOf(d)) return { at: 0, what: 'the Start button' };
    const g = G && G[i];
    if (g && g.t === 'no_response' && g.awaits) {
      const a = g.awaits;
      if (a.buttons.length) { const k = ownerOf(d, a.buttons[a.buttons.length - 1]); if (k >= 0) return { at: k, what: 'the button' }; }
      if (a.start) return { at: 0, what: 'the Start button' };
    }
    return null;
  }
  /** Words that point the wrong way: [{ i, word, want: 'above'|'below', what, text }] (text: the gentle tip). */
  function directionIssues(d, only) {
    const out = [];
    if (!d || !Array.isArray(d.steps)) return out;
    let G = null;
    try { G = graph(d); } catch (_) { G = null; }
    d.steps.forEach((s, i) => {
      if (only != null && only !== i) return;
      const body = String(s.body || '');
      if (!body.match(DIR_RX)) return;
      for (const [a, b] of sentences(body)) {
        const seg = body.slice(a, b);
        const words = seg.match(DIR_RX);
        if (!words) continue;
        const p = pointsAt(d, i, seg, G);
        if (!p || p.at > i) continue;
        const want = p.at < i ? 'above' : 'below';
        const wrong = words.filter((x) => (DOWN_RX.test(x) ? 'below' : 'above') !== want);
        if (!wrong.length) continue;
        const w = wrong.find((x) => /^[a-z]+$/i.test(x)) || wrong[0];
        const word = /^[a-z]+$/i.test(w) ? w.toLowerCase() : w;
        out.push({ i, word, want, what: p.what, text: 'This says “' + word + '”, but ' + p.what + ' is ' + want + '.' });
        break;
      }
    });
    return out;
  }
  const FLIP = { below: 'above', above: 'below', Below: 'Above', Above: 'Below', BELOW: 'ABOVE', ABOVE: 'BELOW', '👇': '👆', '👆': '👇', '⬇️': '⬆️', '⬆️': '⬇️' };
  /** Message i's text with the words that point the wrong way turned around (the rest is kept exactly). */
  function fixDirections(d, i) {
    const s = d && d.steps && d.steps[i];
    if (!s) return '';
    const body = String(s.body || '');
    let G = null;
    try { G = graph(d); } catch (_) { G = null; }
    let out = '', last = 0;
    for (const [a, b] of sentences(body)) {
      const seg = body.slice(a, b);
      if (!seg.match(DIR_RX)) continue;
      const p = pointsAt(d, i, seg, G);
      if (!p || p.at > i) continue;
      const want = p.at < i ? 'above' : 'below';
      out += body.slice(last, a) + seg.replace(DIR_RX, (w) => ((DOWN_RX.test(w) ? 'below' : 'above') === want ? w : FLIP[w] || w));
      last = b;
    }
    return out + body.slice(last);
  }
  /** Every message of a draft with its direction words fixed (for Cas's own texts). */
  function fixAllDirections(d) { d.steps.forEach((s, i) => { const f = fixDirections(d, i); if (f && f !== s.body) s.body = f; }); return d; }

  /* ---------- the conversation ----------
   * New bot:  goal → about → (their link) → (which channel / bot, only when there are several) → "way":
   *   ✨ Just build it for me  → a whole sensible bot at once (no AI), then "Like it?"
   *   One message at a time   → welcome → "Like this? 👍" → after Start → its button → a reminder → anything else?
   * Technical choices (who gets in when, button kinds, the Tap Start button, Telegram's 5-minute rule) are made here with
   * safe defaults and said in one gentle line, with a chip to change them. Cas never says flow, trigger, step and the like.
   */
  const MODE_SAY = { after_welcome: 'I\'ll let people in right after they get your welcome ✅', instant: 'I\'ll let people in straight away ⚡', tap: 'People get in once they tap Start 👆', manual: 'Requests will wait for you to let people in 🙋' };
  const START_NOTE = 'I added a Tap Start button to your welcome, so your bot can keep in touch 👆';
  const LINK_NOTE = 'I added a button that opens your link 🔗';
  const JB = { id: 'jb:go', label: '✨ Just build it for me' };
  const LEGACY = { tap_start: 'next', rule: 'next', rule_remind: 'next', preview: 'ready', test: 'ready', how_in_first: 'next' };

  function turn(st, from, text, extra) {
    st.seq = (st.seq || 0) + 1;
    return { id: st.seq, from, text, ...(extra || {}) };
  }
  function snap(st) {
    st.undo = (st.undo || []).concat([{ draft: clone(st.draft), stage: st.stage, pend: clone(st.pend || {}), focus: st.focus }]).slice(-UNDO_MAX);
  }
  function start(ctx, opts = {}) {
    const st = { v: 2, seq: 0, stage: 'goal', pend: {}, undo: [], focus: 0, about: '', goal: '', goal_text: '', link: '', edit: !!opts.edit, live: !!opts.live, business: (ctx.profile && ctx.profile.business) || '', named: false,
      draft: opts.draft ? clone(opts.draft) : { name: 'My welcome bot', chat_id: null, bot_id: null, approve_mode: 'after_welcome', start_button: false, start_label: '', steps: [] } };
    const turns = [];
    if (st.edit) {
      st.focus = lastMessage(st.draft);
      if (isBotD(st.draft)) { st.kind = botTypeOfD(st.draft); st.bk = { chat: (st.draft.steps.find((x) => kindOf(x) === 'check_join') || { check: {} }).check.chat_id || undefined, checked: true }; }
      else st.kind = 'welcome';
      turns.push(turn(st, 'cas', 'Hi! I\'m Cas 👋 Let\'s fine-tune *' + st.draft.name + '* together.'));
      goNext(st, ctx, turns);
    } else if (opts.kind && (KINDS[opts.kind] || opts.kind === 'welcome')) {
      turns.push(turn(st, 'cas', 'Hi! I\'m Cas 👋 I\'ll build your bot with you, and you\'ll see it on the phone.'));
      chooseKind(st, ctx, turns, opts.kind);
    } else {
      st.stage = 'kind';
      turns.push(turn(st, 'cas', 'Hi! I\'m Cas 👋 I\'ll build your bot with you, and you\'ll see it on the phone.'));
      ask(st, ctx, turns);
    }
    const out = { state: st, turns };
    if (st.stage === 'wait_check') out.check = checkReq(st);
    return out;
  }
  function lastMessage(d) { for (let i = d.steps.length - 1; i >= 0; i--) if (trigOf(d.steps[i], i) !== 'no_response') return i; return 0; }
  const chatOk = (d, ctx) => !!d.chat_id && (ctx.chats || []).some((c) => String(c.id) === String(d.chat_id));
  const botOk = (d, ctx) => !!d.bot_id && (ctx.bots || []).some((b) => String(b.id) === String(d.bot_id));

  /** The question for the current stage: { text, chips: [{ id, label, act?, lock?, pri?, hint? }], input? }. */
  function question(st, ctx) {
    const d = st.draft, P = st.pend || {};
    const stage = LEGACY[st.stage] || st.stage;
    switch (stage) {
      case 'kind': case 'kind_locked': case 'kind_other': case 'bk_chat': case 'bk_admin': case 'bk_gift': case 'bk_link': case 'bk_remind': case 'bk_follow':
      case 'bk_menu': case 'bk_menu_own': case 'bk_ans': case 'bk_qs': case 'bk_q_custom': case 'bk_thanks': case 'bk_goal': case 'bk_reward': case 'bk_broadcast': case 'wait_check':
        return botQuestion(st, ctx, stage);
      case 'goal': return { text: 'What would you like to happen when someone joins your channel?', chips: GOAL_ORDER.map((k, i) => ({ id: 'goal:' + k, label: GOALS[k].chip, ...(i === 0 ? { pri: true } : {}) })), input: 'Or tell me in a few words' };
      case 'goal_other': return { text: 'Tell me in a few words what you\'d like 🙂', chips: [{ id: 'go:tips', label: 'Share my free tips 💡' }, { id: 'go:shop', label: 'Show them my shop 🛍️' }, { id: 'go:hello', label: 'Just say hello 👋' }, typeOwn('Tell me in a few words…')], input: 'e.g. share my YouTube channel' };
      case 'about': {
        const chips = [];
        const sell = ctx.profile && (ctx.profile.what_you_sell || ctx.profile.business);
        if (sell) chips.push({ id: 'about:profile', label: firstLine(sell, 34), pri: true });
        chips.push({ id: 'about:trading', label: '📈 Trading signals' }, { id: 'about:sports', label: '⚽ Sports tips' }, { id: 'about:shop', label: '🛍️ My shop' }, { id: 'about:learn', label: '📚 Lessons and tips' }, { id: 'about:community', label: '💬 A community' }, typeOwn('Type what your channel is about…'));
        return { text: 'Lovely! What\'s your channel about?', chips, input: 'e.g. crypto signals' };
      }
      case 'link': return { text: goalOf(st).ask || 'Paste your link 🔗', chips: [JB, typeOwn('Paste your link here…'), { id: 'lk:later', label: 'I\'ll add it later' }], input: 'https://' };
      case 'link_late': return { text: 'Paste your link and I\'ll add a button that opens it 🔗', chips: [typeOwn('Paste your link here…'), { id: 'lk:skip', label: 'Skip for now' }], input: 'https://' };
      case 'chat': return { text: isBotD(d) ? 'Which channel should people join first?' : 'Which channel or group is it for?', chips: (ctx.chats || []).slice(0, 8).map((c) => ({ id: 'chat:' + c.id, label: (c.kind === 'group' ? '👥 ' : '📣 ') + firstLine(c.title || 'Untitled', 30) })) };
      case 'bot': return { text: isBotD(d) ? 'Which of your Telegram bots should people open?' : 'Which of your bots should send it?', chips: (ctx.bots || []).slice(0, 8).map((b) => ({ id: 'bot:' + b.id, label: '🤖 @' + firstLine(b.username || 'bot', 28) })) };
      case 'connect_chat': case 'connect_bot': return wayQuestion(st, ctx);
      case 'way': return wayQuestion(st, ctx);
      case 'how_in': return { text: 'When should people get in?', chips: [
        { id: 'mode:after_welcome', label: '✅ Right after the welcome', pri: true, hint: 'Best' },
        { id: 'mode:instant', label: '⚡ Straight away' },
        { id: 'mode:tap', label: '👆 Once they tap Start', ...(has(ctx, 'tap_to_start') ? {} : { lock: 'tap_to_start' }) },
        { id: 'mode:manual', label: '🙋 I\'ll let them in myself', ...(has(ctx, 'welcome_flows') ? {} : { lock: 'welcome_flows' }) }] };
      case 'review': return { text: P.q || 'Like this? 👍', chips: [
        { id: 'rv:ok', label: 'Yes, perfect', pri: true }, { id: 'rv:shorter', label: 'Shorter' }, { id: 'rv:friendlier', label: 'Friendlier' }, { id: 'rv:own', label: '✍️ Type my own', type: 'Type your message…' }] };
      case 'own': return { text: 'Type it just as you like. {name} becomes their first name.', chips: [{ id: 'own:back', label: '↩ Keep Cas\'s version' }], input: 'Type your message…' };
      case 'own_new': return { text: 'What should it say? {name} becomes their first name.', chips: [{ id: 'own:write', label: '✨ Write it for me' }], input: 'Type your message…' };
      case 'offer_start': return { text: P.q || goalOf(st).offer || 'Shall I send a little extra after they tap Start? 👆', chips: [{ id: 'os:yes', label: 'Yes please 👍', pri: true, ...(has(ctx, 'tap_to_start') ? {} : { lock: 'tap_to_start' }) }, { id: 'os:no', label: 'Just the welcome' }, { id: 'os:mode', label: 'Change when they get in' }] };
      case 'offer_remind': return { text: 'Shall I nudge them after 1 hour if they don\'t tap? 💤', chips: [{ id: 'or:yes', label: 'Yes please 👍', pri: true }, { id: 'or:day', label: 'Make it tomorrow' }, { id: 'or:no', label: 'No thanks' }] };
      case 'jb_review': return { text: 'Like it?', chips: [{ id: 'jb:ok', label: 'Yes, perfect 👍', pri: true }, { id: 'jb:edit', label: 'Change something ✏️' }].concat(isBotD(d) ? [] : [{ id: 'jb:mode', label: 'Change when they get in' }]) };
      case 'next': return d.steps.length ? nextQuestion(st, ctx) : wayQuestion(st, ctx);
      case 'timing': return { text: 'When should it arrive?', chips: [{ id: 't:0', label: '⚡ Right away', pri: true }, { id: 't:5', label: '5 seconds later' }, { id: 't:60', label: '1 minute later' }, { id: 't:3600', label: '1 hour later' }, { id: 't:86400', label: 'Tomorrow' }, { id: 't:other', label: '✍️ Type my own', type: 'For example: 10 minutes' }] };
      case 'timing_other': return { text: 'How long after the message above? For example _30 seconds_ or _2 hours_.', chips: [{ id: 't:back', label: '↩ Back' }], input: 'For example: 10 minutes' };
      case 'purpose': return { text: 'What should it say? Pick one, or tell me 🙂', chips: Object.keys(PURPOSES).filter((k) => k !== 'choice' || replyOk(d, ctx)).map((k) => ({ id: 'p:' + k, label: PURPOSES[k][0] })).concat([{ id: 'p:own', label: '✍️ Type my own', type: 'Type your message…' }], P.ruled ? [{ id: 'rule:keep', label: '⏱ Keep ' + waitText(P.ruled) }] : []), input: 'e.g. invite them to VIP' };
      case 'btn_kind': return { text: 'What happens when they tap it?', chips: [{ id: 'bk:link', label: '🔗 It opens my link', pri: true }, { id: 'bk:reply', label: '💬 They get another message', ...(replyOk(d, ctx) ? {} : { lock: 'reply' }) }] };
      case 'btn_label': return { text: 'What should the button say?', chips: (P.btn && P.btn.kind === 'reply' ? ['⭐ VIP signals', '📘 Free tips', '✅ Yes please', '🙅 Not now'] : ['⭐ Join VIP', '👉 Open', '🛍️ Shop now', '📘 Read more']).filter((l) => !(d.steps[P.btn ? P.btn.index : 0].buttons || []).some((b) => b.label === l)).map((l) => ({ id: 'bl:' + l, label: l })).concat([typeOwn('Type your button text…')]), input: 'Type your button text…' };
      case 'btn_link': return { text: 'Paste the link it should open 🔗', chips: [], input: 'https://' };
      case 'btn_more': {
        const s = d.steps[P.btn.index];
        const room = (s.buttons || []).length < maxButtons(ctx, d);
        return { text: 'Add another one?', chips: (room ? [{ id: 'bm:more', label: '➕ Another button' }] : []).concat([{ id: 'bm:done', label: 'That\'s all', pri: true }]) };
      }
      case 'branch': { const b = findButton(d, P.button); return { text: 'What should they get when they tap *' + (b ? b.label : 'that button') + '*?', chips: [{ id: 'br:write', label: '✨ Write it for me', pri: true }, { id: 'br:own', label: '✍️ Type my own', type: 'Type your message…' }, { id: 'br:skip', label: 'Nothing for now' }], input: 'Or say it in a few words' }; }
      case 'remind_what': return { text: 'Remind them if they don\'t tap…', chips: remindTargets(d, ctx).map((t) => ({ id: 'rw:' + t.k, label: t.label })) };
      case 'remind_time': return { text: 'When should I remind them?', chips: [{ id: 'rt:120', label: '2 minutes', pri: P.remind && P.remind.target === 'start' }, { id: 'rt:600', label: '10 minutes', pri: !(P.remind && P.remind.target === 'start') }, { id: 'rt:3600', label: '1 hour' }, { id: 'rt:86400', label: 'Tomorrow' }, { id: 'rt:other', label: '✍️ Type my own', type: 'For example: 15 minutes' }] };
      case 'remind_other': return { text: 'How long should I wait? For example _3 minutes_ or _2 hours_.', chips: [{ id: 'rt:back', label: '↩ Back' }], input: 'For example: 15 minutes' };
      case 'ready': return readyQuestion(st, ctx);
      case 'switch': return switchQuestion(st, ctx);
      case 'live': return { text: P.q || 'Anything else? 🙂', chips: [{ id: 'end:builder', label: '🛠 Open in builder', act: 'builder' }, { id: 'end:edit', label: '✏️ Change something' }, { id: 'end:close', label: 'Close', act: 'close', pri: true }] };
      case 'ask': return { text: P.q, chips: (P.chips || []).map((c) => ({ id: 'say:' + c, label: c })).concat((P.chips || []).length ? [typeOwn('Type your answer…')] : []), input: 'Type your answer…' };
      case 'wait_ai': return { text: '', chips: [] };
      default: return d.steps.length ? nextQuestion(st, ctx) : { text: 'What would you like to happen when someone joins your channel?', chips: [] };
    }
  }
  /** "✍️ Type my own": on every question with suggestions. The app just opens the keyboard (placeholder `type`). */
  function typeOwn(placeholder) { return { id: 'type:own', label: '✍️ Type my own', act: 'type', type: placeholder }; }
  function wayQuestion() {
    return { text: 'Shall I build it all for you, or shall we write it one message at a time?', chips: [{ ...JB, pri: true }, { id: 'way:one', label: 'One message at a time 💬' }] };
  }
  const replyOk = (d, ctx) => isBotD(d) || has(ctx, 'welcome_flows');
  function canMore(st, ctx) {
    if (isBotD(st.draft)) { const lim = botStepLimit(ctx); return lim < 0 || botMsgs(st.draft) < lim; }
    const lim = stepLimit(ctx); return has(ctx, 'welcome_flows') && (lim < 0 || st.draft.steps.length < lim);
  }
  function nextQuestion(st, ctx) {
    const d = st.draft;
    if (isBotD(d)) return botNextQuestion(st, ctx);
    const more = canMore(st, ctx);
    const lim = stepLimit(ctx);
    const chips = [];
    const fl = st.focus != null && d.steps[st.focus] ? st.focus : lastMessage(d);
    if (!has(ctx, 'welcome_flows')) {
      if ((d.steps[0].buttons || []).length < maxButtons(ctx)) chips.push({ id: 'nx:button', label: '🔘 Add a button with my link' });
      chips.push({ id: 'nx:msg', label: '➕ Add another message', lock: 'welcome_flows' });
      chips.push({ id: 'nx:done', label: '✅ I\'m done', pri: true });
      return { text: st.pend.q || 'Your ' + planName(ctx) + ' plan sends one welcome, and it\'s ready ✨ Add a button that opens a link?', chips };
    }
    if (!st.edit && !st.built && d.steps.length === 1 && more) chips.push(JB);
    chips.push(more ? { id: 'nx:msg', label: '➕ Add another message' } : { id: 'nx:msg', label: '➕ Add another message', lock: 'flow_steps' });
    if (more && !d.steps.some((s, i) => trigOf(s, i) === 'on_start')) chips.push({ id: 'nx:start', label: '👆 Add one for after they tap Start', ...(has(ctx, 'tap_to_start') ? {} : { lock: 'tap_to_start' }) });
    if (d.steps[fl] && (d.steps[fl].buttons || []).length < maxButtons(ctx, d)) chips.push({ id: 'nx:button', label: '🔘 Add a button' });
    if (more && remindTargets(d, ctx).length) chips.push({ id: 'nx:remind', label: '💤 Remind them if they don\'t tap' });
    chips.push({ id: 'nx:done', label: st.edit ? '✅ That\'s all' : '✅ I\'m done', pri: true });
    const text = st.pend.q || (st.edit ? 'What would you like to change? Tap or type 🙂' : 'Anything else? Tap or type 🙂');
    return { text: !more && lim > 0 && d.steps.length >= lim ? text + ' (Your ' + planName(ctx) + ' plan allows ' + lim + ' messages.)' : text, chips };
  }
  /** Ready: switch it on (or connect what's missing first), try it, watch it, change it. */
  function readyQuestion(st, ctx) {
    const d = st.draft, P = st.pend || {};
    if (isBotD(d)) return botReadyQuestion(st, ctx);
    const chips = [];
    let text = P.q || 'Switch it on now, or try it first? 🙂';
    if (st.live) { chips.push({ id: 'rd:save', label: '💾 Save my changes', act: 'save', pri: true }); text = P.q || 'It\'s live. Save your changes so new people get them?'; }
    else if (!chatOk(d, ctx) && (ctx.chats || []).length > 1) { chips.push({ id: 'rd:where', label: '📣 Pick your channel', pri: true }); text = P.q || 'Which channel is it for? Tap below 🙂'; }
    else if (!botOk(d, ctx) && (ctx.bots || []).length > 1) { chips.push({ id: 'rd:where', label: '🤖 Pick your bot', pri: true }); text = P.q || 'Which of your bots should send it? Tap below 🙂'; }
    else if (!chatOk(d, ctx)) { chips.push({ id: 'cc:connect', label: '🔌 Connect my channel', act: 'connect_channel', pri: true }, { id: 'cc:check', label: 'I\'ve connected it ✓' }); text = P.q || 'To switch it on, connect your channel first 🔌 It takes about a minute.'; }
    else if (!botOk(d, ctx)) { chips.push({ id: 'cb:connect', label: '🤖 Connect my bot', act: 'connect_bot', pri: true }, { id: 'cb:check', label: 'I\'ve connected it ✓' }); text = P.q || 'To switch it on, connect your own bot. It sends the welcome 🤖'; }
    else chips.push({ id: 'rd:on', label: '🚀 Switch it on', act: 'switch', pri: true });
    if (chatOk(d, ctx) && botOk(d, ctx)) chips.push({ id: 'rd:test', label: '📲 Send me a test on Telegram', act: 'test' });
    chips.push({ id: 'rd:play', label: '▶ See it play', act: 'play' });
    chips.push({ id: 'rd:edit', label: '✏️ Change something' });
    if (!st.live) chips.push({ id: 'rd:draft', label: '💾 Keep it as a draft', act: 'draft' });
    return { text, chips };
  }
  function switchQuestion(st, ctx) {
    const d = st.draft;
    if (isBotD(d)) return botSwitchQuestion(st, ctx);
    if (!chatOk(d, ctx)) return { text: 'To switch it on, connect the channel or group people ask to join 🔌', chips: [{ id: 'cc:connect', label: '🔌 Connect my channel', act: 'connect_channel', pri: true }, { id: 'cc:check', label: 'I\'ve connected it ✓' }, { id: 'sw:draft', label: '💾 Keep it as a draft', act: 'draft' }] };
    if (!botOk(d, ctx)) return { text: 'To switch it on, connect your own bot. It sends the welcome 🤖', chips: [{ id: 'cb:connect', label: '🤖 Connect my bot', act: 'connect_bot', pri: true }, { id: 'cb:check', label: 'I\'ve connected it ✓' }, { id: 'sw:draft', label: '💾 Keep it as a draft', act: 'draft' }] };
    if (st.pend && st.pend.clash) return { text: st.pend.q || 'Use this one?', chips: [{ id: 'sw:replace', label: '🔁 Use this one', act: 'switch_replace', pri: true }, { id: 'sw:draft', label: '💾 Keep it as a draft', act: 'draft' }] };
    if (st.live) return { text: st.pend.q || 'It\'s live. Save your changes so new people get them?', chips: [{ id: 'sw:save', label: '💾 Save my changes', act: 'save', pri: true }, { id: 'sw:builder', label: '🛠 Open in builder', act: 'builder' }] };
    return { text: st.pend.q || 'Ready to switch it on? I\'ll check everything first.', chips: [{ id: 'sw:on', label: '🚀 Switch it on', act: 'switch', pri: true }, { id: 'sw:builder', label: '🛠 Open in builder', act: 'builder' }, { id: 'sw:draft', label: '💾 Keep it as a draft', act: 'draft' }] };
  }
  /** What a reminder can wait for: Start (while no "when they tap Start" message is above), or the buttons of a message. */
  function remindTargets(d, ctx) {
    const out = [];
    if (!has(ctx, 'welcome_flows') || isBotD(d)) return out;
    for (let i = d.steps.length - 1; i >= 0; i--) {
      const s = d.steps[i];
      if (trigOf(s, i) === 'no_response' || !(s.buttons || []).length) continue;
      const ls = s.buttons.map((b) => b.label);
      out.push({ k: 'm' + i, i, label: '🔘 ' + firstLine(ls.slice(0, 2).join(' or ') + (ls.length > 2 ? '…' : ''), 34) });
      if (out.length >= 3) break;
    }
    if (d.start_button || d.approve_mode === 'tap') out.push({ k: 'start', label: '👆 Start' });
    return out;
  }
  function ask(st, ctx, turns) {
    const q = question(st, ctx);
    if (q.text) turns.push(turn(st, 'cas', q.text));
  }
  function view(st, ctx) {
    const q = question(st, ctx);
    return { stage: LEGACY[st.stage] || st.stage, chips: q.chips || [], input: q.input || '', draft: st.draft, can_undo: !!(st.undo && st.undo.length), focus: st.focus };
  }

  /* ---------- moving through the chat ---------- */
  function setGoal(st, ctx, turns, goal, text) {
    st.goal = GOALS[goal] ? goal : 'other';
    if (text) st.goal_text = firstLine(text, 200);
    st.stage = 'about'; st.pend = {};
    ask(st, ctx, turns);
  }
  function afterAbout(st, ctx, turns) {
    if (goalOf(st).link && !st.link && !st.link_later) { st.stage = 'link'; st.pend = {}; return ask(st, ctx, turns); }
    goSetup(st, ctx, turns);
  }
  /** The channel and the bot: picked silently when there is one, asked when there are several, left for later when none. */
  function goSetup(st, ctx, turns) {
    const d = st.draft;
    if (isBotD(d)) return botNext(st, ctx, turns);
    const chats = ctx.chats || [], bots = ctx.bots || [];
    let picked = '';
    if (!chatOk(d, ctx) && chats.length === 1) { d.chat_id = chats[0].id; picked = '*' + firstLine(chats[0].title || 'your channel', 40) + '*'; }
    if (!chatOk(d, ctx) && chats.length > 1) { st.stage = 'chat'; st.pend = {}; return ask(st, ctx, turns); }
    if (!botOk(d, ctx) && bots.length === 1) d.bot_id = bots[0].id;
    if (!botOk(d, ctx) && bots.length > 1) { st.stage = 'bot'; st.pend = {}; return ask(st, ctx, turns); }
    if (picked) turns.push(turn(st, 'cas', 'I\'ll set it up for ' + picked + ' ✓'));
    if (st.ready_back) { st.ready_back = false; return goReady(st, ctx, turns); }
    if (d.steps.length) return goNext(st, ctx, turns);
    st.stage = 'way'; st.pend = {};
    ask(st, ctx, turns);
  }
  function goNext(st, ctx, turns, o = {}) {
    st.stage = 'next'; st.pend = o.q ? { q: o.q } : {};
    ask(st, ctx, turns);
  }
  function goReview(st, ctx, turns, index, after, intro, extra = {}) {
    st.stage = 'review'; st.pend = { index, after, ...extra };
    st.focus = index;
    turns.push(turn(st, 'cas', intro, { quote: { i: index, body: st.draft.steps[index].body }, preview: true }));
    turns.push(turn(st, 'cas', 'Like this? 👍'));
  }
  function goMode(st, ctx, turns) {
    st.modeBack = { stage: st.stage, pend: clone(st.pend || {}) };
    st.stage = 'how_in'; st.pend = {};
    ask(st, ctx, turns);
  }
  function goReady(st, ctx, turns, o = {}) {
    st.stage = 'ready'; st.pend = o.q ? { q: o.q } : {};
    if (o.celebrate) turns.push(turn(st, 'cas', st.edit ? 'Your changes are ready ✨' : isBotD(st.draft) ? '🎉 Your bot is ready!' : '🎉 Your welcome bot is ready!', st.edit ? {} : { celebrate: true }));
    ask(st, ctx, turns);
  }
  function modeNote(st, turns) {
    if (st.mode_said) return;
    st.mode_said = true;
    turns.push(turn(st, 'cas', MODE_SAY[st.draft.approve_mode] || MODE_SAY.after_welcome));
  }
  function afterReview(st, ctx, turns) {
    const P = st.pend;
    const a = P.after || 'next';
    if (a === 'welcome_done') return welcomeDone(st, ctx, turns);
    if (a === 'value_done') return valueButton(st, ctx, turns, P.index);
    if (a === 'buttons_link' || a === 'buttons_reply') return goButton(st, ctx, turns, P.index, a === 'buttons_link' ? 'link' : 'reply');
    if (a === 'branches') return goBranches(st, ctx, turns, P.owner, P.skipped || []);
    return goNext(st, ctx, turns);
  }
  /** After the welcome: the default for who gets in (one line), then offer the message after Start. */
  function welcomeDone(st, ctx, turns) {
    const d = st.draft;
    if (!has(ctx, 'welcome_flows')) {
      if (st.link && !(d.steps[0].buttons || []).length) {
        const r = applyOps(d, [{ op: 'add_button', message: 1, label: goalOf(st).btn || '👉 Open', kind: 'link', url: st.link }], ctx);
        if (r.ok) { snap(st); st.draft = r.draft; turns.push(turn(st, 'cas', LINK_NOTE)); }
      }
      modeNote(st, turns);
      return goNext(st, ctx, turns);
    }
    modeNote(st, turns);
    if (!has(ctx, 'tap_to_start') || d.steps.some((s, i) => trigOf(s, i) === 'on_start')) return goNext(st, ctx, turns);
    st.stage = 'offer_start'; st.pend = {};
    ask(st, ctx, turns);
  }
  /** The message after Start gets the button its goal needs: a link they gave (said in one line), or ask for it. */
  function valueButton(st, ctx, turns, i) {
    const g = goalOf(st);
    const s = st.draft.steps[i];
    if (!s || !g.link || (s.buttons || []).length) return goNext(st, ctx, turns);
    if (!st.link) { st.stage = 'link_late'; st.pend = { index: i }; return ask(st, ctx, turns); }
    return linkButton(st, ctx, turns, i, st.link);
  }
  function linkButton(st, ctx, turns, i, url) {
    const r = applyOps(st.draft, [{ op: 'add_button', message: i + 1, label: goalOf(st).btn || '👉 Open', kind: 'link', url }], ctx);
    if (!r.ok) { turns.push(turn(st, 'cas', 'Hmm, ' + r.error.charAt(0).toLowerCase() + r.error.slice(1))); st.stage = 'link_late'; st.pend = { index: i }; return ask(st, ctx, turns); }
    snap(st); st.draft = r.draft; st.focus = i; st.link = url;
    const s = st.draft.steps[i];
    if (/^Thanks for tapping Start, \{name\}! 🎉\n\n/.test(s.body) && goalOf(st).link) s.body = valueText(st, goalOf(st).purpose, true);
    turns.push(turn(st, 'cas', LINK_NOTE, { quote: { i, body: s.body }, preview: true }));
    if (canMore(st, ctx)) { st.stage = 'offer_remind'; st.pend = { index: i }; return ask(st, ctx, turns); }
    return goNext(st, ctx, turns);
  }
  function ensureStartWords(d) {
    const w = d.steps[0];
    if (w && !/\bstart\b/i.test(w.body) && [...w.body].length < 3900) w.body = w.body.replace(/\s+$/, '') + '\n\nTap *Start* below to get more 👇';
  }
  function goButton(st, ctx, turns, index, kind) {
    const s = st.draft.steps[index];
    if (!s) return goNext(st, ctx, turns);
    if ((s.buttons || []).length >= maxButtons(ctx, st.draft)) { turns.push(turn(st, 'cas', 'That message already has ' + maxButtons(ctx, st.draft) + ' buttons, the most it can have.')); return goNext(st, ctx, turns); }
    const rOk = replyOk(st.draft, ctx);
    st.pend = { btn: { index, kind: kind === 'reply' && !rOk ? 'link' : kind || (rOk ? null : 'link') } };
    st.stage = st.pend.btn.kind ? 'btn_label' : 'btn_kind';
    ask(st, ctx, turns);
  }
  function goBranches(st, ctx, turns, owner, skipped) {
    const d = st.draft;
    const s = d.steps[owner];
    if (!s) return goNext(st, ctx, turns);
    const answered = new Set(d.steps.filter((x, k) => trigOf(x, k) === 'on_button').map((x) => x.trigger.button));
    const left = (s.buttons || []).filter((b) => b.kind === 'reply' && !answered.has(b.id) && !(skipped || []).includes(b.id));
    if (!left.length) return goNext(st, ctx, turns);
    const lim = stepLimit(ctx);
    if (!isBotD(d) && lim >= 0 && d.steps.length >= lim) { turns.push(turn(st, 'cas', 'Your ' + planName(ctx) + ' plan allows ' + lim + ' messages, so the other buttons get no answer yet.')); return goNext(st, ctx, turns); }
    st.stage = 'branch'; st.pend = { owner, button: left[0].id, skipped: skipped || [] };
    ask(st, ctx, turns);
  }
  function goSwitch(st, ctx, turns, q) {
    st.stage = 'switch'; st.pend = q ? { q } : {};
    ask(st, ctx, turns);
  }

  /** "✨ Just build it for me": a whole bot from the goal and the topic, with best-practice defaults. No AI. */
  function buildAll(st, ctx, turns) {
    const d0 = st.draft;
    if (!chatOk(d0, ctx) && (ctx.chats || []).length === 1) d0.chat_id = ctx.chats[0].id;
    if (!botOk(d0, ctx) && (ctx.bots || []).length === 1) d0.bot_id = ctx.bots[0].id;
    const g = goalOf(st);
    const goal = GOALS[st.goal] ? st.goal : 'welcome';
    const link = g.link ? st.link : '';
    const follow = has(ctx, 'welcome_flows');
    const tap = has(ctx, 'tap_to_start');
    const lim = stepLimit(ctx);
    const nd = { name: d0.name, chat_id: d0.chat_id || null, bot_id: d0.bot_id || null, approve_mode: MODES.includes(d0.approve_mode) && (d0.approve_mode !== 'manual' || follow) && (d0.approve_mode !== 'tap' || tap) ? d0.approve_mode : 'after_welcome', start_button: false, start_label: '', invite_link: d0.invite_link || null, steps: [] };
    const errs = [];
    const btn = (label) => mkButton(nd, { label, kind: 'link', url: link }, errs);
    const msg = (body, trigger, buttons) => ({ body, buttons: (buttons || []).filter(Boolean), trigger: trigger || null, start_flow_id: null });
    const notes = [];
    if (!follow) {
      // One welcome does it all.
      const extra = { link: '\n\nYour link is right below 👇', gift: '\n\nYour free gift is right below 🎁', vip: '\n\nWant VIP? Tap below to join 💎' }[goal];
      nd.steps.push(msg(welcomeText(st) + (link && extra ? extra : ''), null, link ? [btn(g.btn)] : []));
      notes.push('Your ' + planName(ctx) + ' plan sends one welcome, so I put it all in there 💙');
    } else if (tap) {
      nd.start_button = true; nd.start_label = '👆 Tap Start';
      nd.steps.push(msg(welcomeText(st), null));
      nd.steps.push(msg(NUDGE[goal] || NUDGE.welcome, { type: 'after_previous' }));
      const vb = link ? [btn(g.btn)] : [];
      nd.steps.push(msg(valueText(st, g.purpose === 'brief' ? 'thanks' : g.purpose, !!link), { type: 'on_start' }, vb));
      if (vb.length && REMIND[goal]) nd.steps.push(msg(REMIND[goal], { type: 'no_response', seconds: 3600 }));
      notes.push(MODE_SAY[nd.approve_mode]);
      if (nd.approve_mode !== 'tap') notes.push('People tap Start to get more, so your bot can keep in touch 👆');
    } else {
      const vb = link ? [btn(g.btn)] : [];
      nd.steps.push(msg(welcomeText(st), null));
      nd.steps.push(msg(valueText(st, g.purpose === 'brief' ? 'thanks' : g.purpose, !!link).replace('Thanks for tapping Start, {name}! 🎉', 'One more thing, {name} 💙'), { type: 'wait', seconds: 5 }, vb));
      notes.push(MODE_SAY[nd.approve_mode]);
    }
    if (errs.length) { turns.push(turn(st, 'cas', 'Hmm, ' + String(errs[0]).replace(/^"[^"]*": /, '').replace(/^./, (c) => c.toLowerCase()))); st.link = ''; return goNext(st, ctx, turns); }
    // Fit the plan: the reminder goes first, then the nudge.
    while (lim >= 0 && nd.steps.length > Math.max(1, lim)) {
      const r = nd.steps.findIndex((s, i) => i > 0 && trigOf(s, i) === 'no_response');
      if (r > 0) { nd.steps.splice(r, 1); continue; }
      if (nd.steps.length > 2 && trigOf(nd.steps[1], 1) === 'after_previous') { nd.steps.splice(1, 1); continue; }
      nd.steps.splice(nd.steps.length - 1, 1);
    }
    if (!nd.steps.some((s, i) => trigOf(s, i) === 'on_start') && nd.approve_mode !== 'tap') { nd.start_button = false; nd.start_label = ''; }
    const p = problems(nd, ctx);
    if (p) { turns.push(turn(st, 'cas', 'Hmm, I couldn\'t build that: ' + p)); return goNext(st, ctx, turns); }
    fixAllDirections(nd);
    snap(st);
    st.draft = nd; st.built = true; st.mode_said = true;
    st.focus = lastMessage(nd);
    if (g.link && !link) notes.push('Paste your link here any time and I\'ll add a button that opens it 🔗');
    turns.push(turn(st, 'cas', 'Here\'s your whole welcome bot ✨ Have a look on the phone.', { preview: true }));
    for (const n of notes) turns.push(turn(st, 'cas', n));
    st.stage = 'jb_review'; st.pend = {};
    ask(st, ctx, turns);
  }

  /** Timing for a new message. Telegram's 5-minute rule is handled for them, with one line (and a chip to keep their time). */
  function elapsedQuick(d) {
    let t = 0;
    for (let i = 1; i < d.steps.length; i++) {
      const tr = trigOf(d.steps[i], i);
      if (tr === 'on_start' || tr === 'on_button') return null;
      if (tr === 'wait') t += Number(d.steps[i].trigger.seconds) || 0;
    }
    return t;
  }
  function setTiming(st, ctx, turns, sec) {
    const d = st.draft;
    st.pend = { trigger: sec ? { type: 'wait', seconds: sec } : { type: 'after_previous' } };
    const el = elapsedQuick(d);
    if (!isBotD(d) && el != null && el + sec > QUICK && has(ctx, 'tap_to_start')) {
      st.pend = { trigger: { type: 'on_start' }, ruled: sec };
      turns.push(turn(st, 'cas', 'Telegram lets your bot write later only to people who tap Start, so I\'ll send this one when they tap Start 👆'));
      return goPurpose(st, ctx, turns);
    }
    turns.push(turn(st, 'cas', sec ? 'It\'ll arrive ' + waitText(sec) + ' after the message above ⏱' : 'It\'ll arrive right after the message above ⚡'));
    goPurpose(st, ctx, turns);
  }
  function goPurpose(st, ctx, turns) {
    st.stage = 'purpose';
    ask(st, ctx, turns);
  }
  function insertNew(st, ctx, body, trigger, at) {
    const d = st.draft;
    snap(st);
    const s = { body, buttons: [], trigger: d.steps.length ? trigger || { type: 'after_previous' } : null, start_flow_id: null };
    const i = at != null ? at : d.steps.length ? placeFor(d, s.trigger) : 0;
    let added = false;
    if (s.trigger && s.trigger.type === 'on_start' && !d.start_button && d.approve_mode !== 'tap') { d.start_button = true; d.start_label = d.start_label || '👆 Tap Start'; ensureStartWords(d); added = true; }
    d.steps.splice(i, 0, s);
    st.focus = i;
    st.start_added = added;
    return i;
  }
  function setRemind(st, ctx, turns, sec) {
    const d = st.draft;
    const target = st.pend.remind.target;
    if (target === 'start') {
      const el = elapsedQuick(d);
      if ((el == null ? 0 : el) + sec > QUICK) {
        sec = 120;
        turns.push(turn(st, 'cas', 'Before they tap Start, Telegram allows only 5 minutes, so I\'ll remind them after 2 minutes ⏱'));
      }
    }
    let at;
    if (target === 'start') { const fs = d.steps.findIndex((s, i) => trigOf(s, i) === 'on_start'); at = fs > 0 ? fs : d.steps.length; }
    else { const k = Number(String(target).slice(1)); at = k + 1; while (at < d.steps.length && trigOf(d.steps[at], at) === 'no_response') at++; }
    const text = target !== 'start' && REMIND[st.goal] && st.draft.steps[Number(String(target).slice(1))] && (st.draft.steps[Number(String(target).slice(1))].buttons || []).some((b) => b.kind === 'link') ? REMIND[st.goal] : reminderText(d, target);
    const i = insertNew(st, ctx, text, { type: 'no_response', seconds: sec }, at);
    const p = problems(st.draft, ctx);
    if (p) { const u = st.undo.pop(); st.draft = u.draft; turns.push(turn(st, 'cas', 'Hmm, I couldn\'t add that reminder: ' + p)); return goNext(st, ctx, turns); }
    goReview(st, ctx, turns, i, 'next', 'Here\'s a gentle reminder. It goes out only if they haven\'t tapped after ' + waitText(sec) + ' 💤');
  }

  /** The AI request for writing (the caller answers with aiDone). */
  function wantWrite(st, req) {
    st.stage = 'wait_ai';
    st.pend = { req };
    return { kind: 'write', ...req, about: st.about || '', goal: st.goal || '', goal_text: st.goal_text || '' };
  }

  function chipLabel(st, ctx, id) { const c = (question(st, ctx).chips || []).find((x) => x.id === id); return c ? c.label : null; }
  /** Free text that is just a chip in other words ("done", "yes", "10 minutes"): handled without the AI. */
  function quick(st, ctx, text) {
    const t = norm(text);
    if (!t) return null;
    const chips = question(st, ctx).chips || [];
    for (const c of chips) { if (c.act && !['play', 'test'].includes(c.act)) continue; if (norm(c.label) === t) return { chip: c.id }; }
    const YES = /^(yes|yeah|yep|yup|ok|okay|sure|good|great|perfect|looks good|nice|cool|fine|go|go ahead|do it|yes please|love it|i like it)$/;
    const NO = /^(no|nope|nah|not now|no thanks|skip|later|i ll add it later|not yet)$/;
    const DONE = /^(done|i m done|im done|that s all|thats all|finish|finished|all done|no more|nothing else)$/;
    const BUILD = /(just )?build it( for me)?|you do it|do it for me|build everything/;
    const s = LEGACY[st.stage] || st.stage;
    if (s === 'review' && YES.test(t)) return { chip: 'rv:ok' };
    if (s === 'jb_review' && YES.test(t)) return { chip: 'jb:ok' };
    if (s === 'offer_start' && YES.test(t)) return { chip: 'os:yes' };
    if (s === 'offer_start' && NO.test(t)) return { chip: 'os:no' };
    if (s === 'offer_remind' && YES.test(t)) return { chip: 'or:yes' };
    if (s === 'offer_remind' && NO.test(t)) return { chip: 'or:no' };
    if ((s === 'way' || s === 'link' || chips.some((c) => c.id === JB.id)) && BUILD.test(t)) return { chip: JB.id };
    if (s === 'bk_link' && NO.test(t)) return { chip: 'bkl:later' };
    if (s === 'bk_remind' && YES.test(t)) return { chip: 'bkr:yes' };
    if (s === 'bk_remind' && NO.test(t)) return { chip: 'bkr:no' };
    if (s === 'bk_admin' && (YES.test(t) || DONE.test(t))) return { chip: 'ba:again' };
    if (s === 'bk_admin' && NO.test(t)) return { chip: 'ba:later' };
    if ((s === 'bk_menu' || s === 'bk_qs') && DONE.test(t) && chips.some((c) => c.id === 'mb:done' || c.id === 'lq:done')) return { chip: s === 'bk_menu' ? 'mb:done' : 'lq:done' };
    if (s === 'bk_follow') { if (NO.test(t) || /^no follow/.test(t)) return { chip: 'bf:none' }; const sec = parseDuration(text); if (sec != null) return { duration: sec }; }
    if (s === 'link' && NO.test(t)) return { chip: 'lk:later' };
    if (s === 'link_late' && NO.test(t)) return { chip: 'lk:skip' };
    if (s === 'next' && DONE.test(t)) return { chip: 'nx:done' };
    if (s === 'btn_more' && (DONE.test(t) || NO.test(t))) return { chip: 'bm:done' };
    if (s === 'timing' || s === 'remind_time') { const sec = parseDuration(text); if (sec != null && (s === 'timing' || sec > 0)) return { duration: sec }; }
    return null;
  }

  /* Stages that wait for typed words (the words are the answer, not an instruction for the AI). */
  const TEXT_STAGES = ['goal', 'goal_other', 'about', 'link', 'link_late', 'own', 'own_new', 'timing_other', 'btn_label', 'btn_link', 'remind_other', 'purpose', 'branch',
    'kind', 'kind_other', 'bk_gift', 'bk_link', 'bk_menu', 'bk_menu_own', 'bk_ans', 'bk_qs', 'bk_q_custom', 'bk_thanks', 'bk_goal', 'bk_reward',
    'kind_locked', 'bk_chat', 'bk_admin', 'bk_remind', 'bk_follow', 'bk_broadcast'];
  /* Text stages where a typed "yes", "later" or a chip's words count as that chip first. */
  const QUICK_FIRST = ['purpose', 'branch', 'goal', 'goal_other', 'link', 'link_late', 'kind', 'bk_gift', 'bk_link', 'bk_menu', 'bk_ans', 'bk_qs', 'bk_thanks', 'bk_goal', 'bk_reward',
    'kind_locked', 'bk_chat', 'bk_admin', 'bk_remind', 'bk_follow', 'bk_broadcast'];
  /* A bare link pasted after "Just build it" (or later on) becomes the button their goal needs. */
  function pastedLink(st, ctx, text) {
    if (isBotD(st.draft)) {
      const B = st.bk || {};
      if (B.link_at == null || !/^\S+$/.test(text) || !['jb_review', 'next', 'ready'].includes(st.stage)) return false;
      const u = cleanUrl(text);
      const s = st.draft.steps[B.link_at];
      if (u.error || !/[./]/.test(text) || !s || kindOf(s) !== 'message' || (s.buttons || []).some((b) => b.kind === 'link')) return false;
      return { i: B.link_at, url: u.value };
    }
    if (!goalOf(st).link || !/^\S+$/.test(text) || !['jb_review', 'next', 'ready'].includes(st.stage)) return false;
    const u = cleanUrl(text);
    if (u.error || !/[./]/.test(text)) return false;
    const d = st.draft;
    let i = d.steps.findIndex((s, k) => trigOf(s, k) === 'on_start' && !(s.buttons || []).some((b) => b.kind === 'link'));
    if (i < 0 && !has(ctx, 'welcome_flows') && !(d.steps[0].buttons || []).length) i = 0;
    if (i < 0) return false;
    return { i, url: u.value };
  }

  function reply(state, input, ctx) {
    const st = clone(state);
    const turns = [];
    const out = { state: st, turns, ai: null };
    const d = st.draft;
    if (LEGACY[st.stage]) { st.stage = LEGACY[st.stage]; st.pend = {}; }
    if (!input || (input.chip == null && input.text == null)) return out;
    if (st.stage === 'wait_check') { st.stage = 'bk_admin'; st.pend = { back: (st.pend || {}).back || 'next' }; }
    if (st.stage === 'kind' && input.chip != null && /^goal:/.test(String(input.chip))) { st.kind = 'welcome'; st.stage = 'goal'; } // a goal tapped from an older screen
    if (st.stage === 'wait_ai') { st.stage = st.resume ? st.resume.stage : 'next'; st.pend = st.resume ? st.resume.pend : {}; st.resume = null; if (st.stage === 'wait_ai' || (st.stage === 'review' && !d.steps[(st.pend || {}).index])) { st.stage = 'next'; st.pend = {}; } }
    let chip = input.chip != null ? String(input.chip) : null;
    let text = input.text != null ? String(input.text).trim() : null;
    if (chip === 'type:own') return out; // "✍️ Type my own" only opens the keyboard
    if (text != null && !text) return out;
    if (text != null && [...text].length > 1500) { turns.push(turn(st, 'me', firstLine(text, 200))); turns.push(turn(st, 'cas', 'That\'s a lot of words for me 🙂 Could you say it in a shorter way?')); return out; }
    if (chip) {
      if (chip.startsWith('say:')) { text = chip.slice(4); chip = null; }
      else {
        const label = chipLabel(st, ctx, chip);
        if (label == null) { turns.push(turn(st, 'cas', 'That choice isn\'t here any more. Here\'s where we are:')); ask(st, ctx, turns); return out; }
        const c = (question(st, ctx).chips || []).find((x) => x.id === chip);
        turns.push(turn(st, 'me', label));
        if (c && c.lock) { turns.push(turn(st, 'cas', lockText(c.lock) + ' You can upgrade any time, or pick another option 🙂', { lock: c.lock })); return out; }
      }
    }
    if (text != null) {
      turns.push(turn(st, 'me', text));
      const pl = !chip && pastedLink(st, ctx, text);
      if (pl) {
        if (st.stage === 'jb_review' || st.stage === 'ready') st.back_after_link = st.stage;
        return linkPasted(st, ctx, turns, pl);
      }
      if (!TEXT_STAGES.includes(st.stage) || QUICK_FIRST.includes(st.stage)) {
        const q = quick(st, ctx, text);
        if (q && q.chip) { chip = q.chip; const c = (question(st, ctx).chips || []).find((x) => x.id === chip); if (c && c.act) out.act = c.act; }
        else if (q && q.duration != null) { if (st.stage === 'timing') { setTiming(st, ctx, turns, q.duration); return out; } if (st.stage === 'bk_follow') { setFollow(st, ctx, turns, q.duration); return finish(out); } st.pend.remind.seconds = q.duration; setRemind(st, ctx, turns, q.duration); return out; }
        else if (!TEXT_STAGES.includes(st.stage)) {
          st.resume = { stage: st.stage, pend: clone(st.pend || {}) };
          st.stage = 'wait_ai'; st.pend = { free: true };
          out.ai = { kind: 'free', text, focus: st.focus };
          return out;
        }
      }
      if (!chip) { handleText(st, ctx, turns, text, out); return finish(out); }
    }
    handleChip(st, ctx, turns, chip, out);
    return finish(out);
  }
  /** A join check to ask Telegram about (the caller answers with checkDone). */
  function finish(out) { if (out.state.stage === 'wait_check' && !out.ai) out.check = checkReq(out.state); return out; }
  function linkPasted(st, ctx, turns, pl) {
    const back = st.back_after_link; st.back_after_link = null;
    const bot = isBotD(st.draft), B = st.bk || {};
    const r = applyOps(st.draft, [{ op: 'add_button', message: pl.i + 1, label: bot ? B.link_label || '🎁 Open my gift' : goalOf(st).btn || '👉 Open', kind: 'link', url: pl.url }], ctx);
    if (!r.ok) { turns.push(turn(st, 'cas', 'Hmm, ' + r.error.charAt(0).toLowerCase() + r.error.slice(1))); ask(st, ctx, turns); return { state: st, turns, ai: null }; }
    snap(st); st.draft = r.draft; st.link = pl.url; st.focus = pl.i;
    const s = st.draft.steps[pl.i];
    if (bot) { if (B.link_swap && s.body === B.link_swap[0]) s.body = B.link_swap[1]; B.link = pl.url; B.link_at = null; }
    else if (/^Thanks for tapping Start, \{name\}! 🎉\n\n/.test(s.body)) s.body = valueText(st, goalOf(st).purpose, true);
    turns.push(turn(st, 'cas', LINK_NOTE, { quote: { i: pl.i, body: s.body }, preview: true }));
    if (back) { st.stage = back; st.pend = {}; ask(st, ctx, turns); } else goNext(st, ctx, turns);
    return { state: st, turns, ai: null };
  }

  function handleText(st, ctx, turns, text, out) {
    const d = st.draft;
    const P = st.pend || {};
    if (BOT_TEXT_STAGES.includes(st.stage)) return botText(st, ctx, turns, text, out);
    switch (st.stage) {
      case 'goal': case 'goal_other': {
        const r = cleanText(text, 200, 'That');
        if (r.error) { turns.push(turn(st, 'cas', r.error + ' Try a few plain words.')); return ask(st, ctx, turns); }
        const t = r.value.toLowerCase();
        const g = /\bvip|premium|paid group/.test(t) ? 'vip' : /\bgift|freebie|free (pdf|ebook|guide|course)/.test(t) ? 'gift' : /\blink|website|youtube|my site|my page/.test(t) ? 'link' : /^(say )?(hi|hello|welcome)( them)?$/.test(t) ? 'welcome' : 'other';
        return setGoal(st, ctx, turns, g, r.value);
      }
      case 'about': {
        const r = cleanText(text, 200, 'That');
        if (r.error) { turns.push(turn(st, 'cas', r.error + ' Try a few plain words.')); return; }
        st.about = r.value; st.about_chip = false;
        nameFromAbout(st);
        return afterAbout(st, ctx, turns);
      }
      case 'link': {
        const r = cleanUrl(text);
        if (r.error) { turns.push(turn(st, 'cas', 'Hmm, ' + r.error.charAt(0).toLowerCase() + r.error.slice(1))); return ask(st, ctx, turns); }
        st.link = r.value;
        turns.push(turn(st, 'cas', 'Got it ✓ I\'ll add a button that opens it.'));
        return goSetup(st, ctx, turns);
      }
      case 'link_late': {
        const r = cleanUrl(text);
        if (r.error) { turns.push(turn(st, 'cas', 'Hmm, ' + r.error.charAt(0).toLowerCase() + r.error.slice(1))); return ask(st, ctx, turns); }
        return linkButton(st, ctx, turns, P.index, r.value);
      }
      case 'own': {
        const r = cleanText(text, textMax(ctx), 'Your message');
        if (r.error) { turns.push(turn(st, 'cas', r.error)); return ask(st, ctx, turns); }
        snap(st);
        d.steps[P.index].body = r.value;
        turns.push(turn(st, 'cas', 'Got it ✓ I put your words in.'));
        st.focus = P.index;
        return afterReview(st, ctx, turns);
      }
      case 'own_new': {
        const r = cleanText(text, textMax(ctx), 'Your message');
        if (r.error) { turns.push(turn(st, 'cas', r.error)); return ask(st, ctx, turns); }
        const i = insertNew(st, ctx, r.value, P.trigger, P.at);
        const p = problems(d, ctx);
        if (p) { st.draft = st.undo.pop().draft; turns.push(turn(st, 'cas', 'Hmm, I couldn\'t add it: ' + p)); return goNext(st, ctx, turns); }
        turns.push(turn(st, 'cas', 'Added ✓ It comes ' + whenWords(st.draft, i) + '.'));
        if (st.start_added) { st.start_added = false; turns.push(turn(st, 'cas', START_NOTE)); }
        st.pend = { index: i, after: P.after || (P.purpose === 'link' ? 'buttons_link' : P.purpose === 'choice' ? 'buttons_reply' : 'next'), owner: P.owner, skipped: P.skipped };
        return afterReview(st, ctx, turns);
      }
      case 'timing_other': {
        const sec = parseDuration(text);
        if (sec == null) { turns.push(turn(st, 'cas', 'I didn\'t catch that time. Try something like _30 seconds_, _10 minutes_ or _2 days_.')); return ask(st, ctx, turns); }
        return setTiming(st, ctx, turns, sec);
      }
      case 'remind_other': {
        const sec = parseDuration(text);
        if (!sec) { turns.push(turn(st, 'cas', 'I didn\'t catch that time. Try something like _3 minutes_ or _2 hours_.')); return ask(st, ctx, turns); }
        return setRemind(st, ctx, turns, sec);
      }
      case 'btn_label': {
        const r = cleanLabel(text);
        if (r.error) { turns.push(turn(st, 'cas', r.error + ' Keep it short, like "⭐ Join VIP".')); return ask(st, ctx, turns); }
        return labelPicked(st, ctx, turns, r.value);
      }
      case 'btn_link': {
        const r = cleanUrl(text);
        if (r.error) { turns.push(turn(st, 'cas', 'Hmm, ' + r.error.charAt(0).toLowerCase() + r.error.slice(1))); return ask(st, ctx, turns); }
        return addBtn(st, ctx, turns, P.btn.label, 'link', r.value);
      }
      case 'purpose': {
        const r = cleanText(text, 300, 'That');
        if (r.error) { turns.push(turn(st, 'cas', r.error)); return ask(st, ctx, turns); }
        out.ai = wantWrite(st, { role: 'message', purpose: 'brief', brief: r.value, insert: { trigger: P.trigger } });
        return;
      }
      case 'branch': {
        const r = cleanText(text, 300, 'That');
        if (r.error) { turns.push(turn(st, 'cas', r.error)); return ask(st, ctx, turns); }
        const b = findButton(d, P.button);
        out.ai = wantWrite(st, { role: 'answer', label: b ? b.label : '', brief: r.value, insert: { trigger: { type: 'on_button', button: P.button } }, owner: P.owner, skipped: P.skipped });
        return;
      }
      default: ask(st, ctx, turns);
    }
  }
  function nameFromAbout(st) {
    if (st.named || st.edit) return;
    const a = aboutWords(st);
    const base = a && a.length <= 28 ? cap(a) : st.business || (a ? firstLine(cap(a), 28).replace(/…$/, '').replace(/[\s,;:.-]+\S*$/, '') : '');
    if (base) { st.draft.name = firstLine(base + ' welcome', 60).replace(/…$/, ''); st.named = true; }
  }
  function labelPicked(st, ctx, turns, label) {
    const P = st.pend;
    if (P.btn.kind === 'link') { P.btn.label = label; if (P.btn.url) return addBtn(st, ctx, turns, label, 'link', P.btn.url); st.stage = 'btn_link'; return ask(st, ctx, turns); }
    return addBtn(st, ctx, turns, label, 'reply', '');
  }
  function addBtn(st, ctx, turns, label, kind, url) {
    const P = st.pend;
    const r = applyOps(st.draft, [{ op: 'add_button', message: P.btn.index + 1, label, kind, url }], ctx);
    if (!r.ok) { turns.push(turn(st, 'cas', 'Hmm, ' + r.error.charAt(0).toLowerCase() + r.error.slice(1))); st.stage = 'btn_label'; return ask(st, ctx, turns); }
    snap(st);
    st.draft = r.draft;
    st.focus = P.btn.index;
    st.stage = 'btn_more'; st.pend = { btn: { index: P.btn.index, kind } };
    turns.push(turn(st, 'cas', 'Added *' + label + '* ✓', { preview: true }));
    ask(st, ctx, turns);
  }

  function handleChip(st, ctx, turns, chip, out) {
    const d = st.draft;
    const P = st.pend || {};
    const [k, v] = [chip.split(':')[0], chip.slice(chip.indexOf(':') + 1)];
    if (BOT_CHIPS.includes(k)) return botChip(st, ctx, turns, k, v, out);
    switch (k) {
      case 'type': return; // the app opens the keyboard; the question stays as it is
      case 'goal':
        if (v === 'other') { st.stage = 'goal_other'; st.pend = {}; return ask(st, ctx, turns); }
        return setGoal(st, ctx, turns, v);
      case 'go':
        if (v === 'hello') return setGoal(st, ctx, turns, 'welcome');
        if (v === 'shop') return setGoal(st, ctx, turns, 'link', 'show them my shop');
        return setGoal(st, ctx, turns, 'other', 'share my free tips');
      case 'about': {
        const c = question({ ...st, stage: 'about' }, ctx).chips.find((x) => x.id === chip);
        st.about = v === 'profile' ? ((ctx.profile && (ctx.profile.what_you_sell || ctx.profile.business)) || '') : c ? c.label : v;
        st.about_chip = v !== 'profile';
        nameFromAbout(st);
        return afterAbout(st, ctx, turns);
      }
      case 'lk':
        if (v === 'later') { st.link_later = true; turns.push(turn(st, 'cas', 'No problem. You can paste it here any time 🙂')); return goSetup(st, ctx, turns); }
        turns.push(turn(st, 'cas', 'Okay, no button for now. Paste your link here any time 🙂'));
        return goNext(st, ctx, turns);
      case 'chat': { const c = (ctx.chats || []).find((x) => String(x.id) === v); if (isBotD(d)) return botChat(st, ctx, turns, c); if (c) d.chat_id = c.id; return goSetup(st, ctx, turns); }
      case 'bot': { const b = (ctx.bots || []).find((x) => String(x.id) === v); if (b) d.bot_id = b.id; if (isBotD(d)) return botPicked(st, ctx, turns); return goSetup(st, ctx, turns); }
      case 'cc': case 'cb': {
        const none = k === 'cc' ? !(ctx.chats || []).length : !(ctx.bots || []).length;
        if (none) { turns.push(turn(st, 'cas', k === 'cc' ? 'I can\'t see a channel or group yet 🌱 Once it\'s connected, tap "I\'ve connected it".' : 'I can\'t see your bot yet 🌱 Once it\'s connected, tap "I\'ve connected it".')); return ask(st, ctx, turns); }
        if (isBotD(d)) return botConnected(st, ctx, turns, k);
        if (k === 'cc' && !chatOk(d, ctx) && ctx.chats.length === 1) d.chat_id = ctx.chats[0].id;
        if (k === 'cb' && !botOk(d, ctx) && ctx.bots.length === 1) d.bot_id = ctx.bots[0].id;
        if (st.stage === 'switch') return goSwitch(st, ctx, turns);
        if (st.stage === 'ready') { if ((k === 'cc' && !chatOk(d, ctx)) || (k === 'cb' && !botOk(d, ctx))) { st.ready_back = true; return goSetup(st, ctx, turns); } turns.push(turn(st, 'cas', 'Connected ✓')); return goReady(st, ctx, turns); }
        return goSetup(st, ctx, turns);
      }
      case 'way':
        turns.push(turn(st, 'cas', 'Lovely, let me write your welcome ✍️'));
        out.ai = wantWrite(st, { role: 'welcome', insert: { trigger: null, at: 0 }, after: 'welcome_done' });
        return;
      case 'jb':
        if (v === 'go') return isBotD(d) ? buildBot(st, ctx, turns) : buildAll(st, ctx, turns);
        if (v === 'ok') return goReady(st, ctx, turns, { celebrate: true });
        if (v === 'mode') return goMode(st, ctx, turns);
        return goNext(st, ctx, turns, { q: 'What would you like to change? Tap or type 🙂' });
      case 'mode': {
        snap(st);
        d.approve_mode = v;
        if (v === 'tap') { d.start_button = true; d.start_label = '✅ Tap to join'; }
        st.mode_said = true;
        turns.push(turn(st, 'cas', 'Done ✓ ' + MODE_SAY[v]));
        const back = st.modeBack || { stage: d.steps.length ? 'next' : 'way', pend: {} };
        st.modeBack = null;
        st.stage = back.stage; st.pend = back.pend || {};
        return ask(st, ctx, turns);
      }
      case 'os':
        if (v === 'mode') return goMode(st, ctx, turns);
        if (v === 'no') { turns.push(turn(st, 'cas', 'Okay, just the welcome for now.')); return goNext(st, ctx, turns); }
        out.ai = wantWrite(st, { role: 'message', purpose: goalOf(st).purpose, value: true, ...(st.goal === 'other' && st.goal_text ? { brief: st.goal_text } : {}), insert: { trigger: { type: 'on_start' } }, after: 'value_done' });
        return;
      case 'or':
        if (v === 'no') { turns.push(turn(st, 'cas', 'Okay, no reminder.')); return goNext(st, ctx, turns); }
        st.pend = { remind: { target: 'm' + P.index } };
        return setRemind(st, ctx, turns, v === 'day' ? 86400 : 3600);
      case 'rv':
        if (v === 'ok') { turns.push(turn(st, 'cas', st.pend.index === 0 ? 'Lovely, your welcome is in ✓' : 'Lovely ✓')); return afterReview(st, ctx, turns); }
        if (v === 'own') { st.stage = 'own'; return ask(st, ctx, turns); }
        out.ai = wantWrite(st, { role: 'rewrite', how: v, index: P.index, after: P.after, owner: P.owner, skipped: P.skipped });
        return;
      case 'own':
        if (v === 'back') { st.stage = 'review'; return afterReview(st, ctx, turns); }
        if (v === 'write') { out.ai = wantWrite(st, { role: P.role || 'message', purpose: P.purpose && P.purpose !== 'own' ? P.purpose : (P.trigger && P.trigger.type === 'on_start' ? 'thanks' : 'tip'), label: P.label, insert: { trigger: P.trigger, at: P.at }, after: P.after, owner: P.owner, skipped: P.skipped }); return; }
        return;
      case 'nx':
        if (v === 'done') return goReady(st, ctx, turns, { celebrate: true });
        if (v === 'msg') { st.stage = 'timing'; st.pend = {}; return ask(st, ctx, turns); }
        if (v === 'start') { st.pend = { trigger: { type: 'on_start' } }; turns.push(turn(st, 'cas', 'This one goes out the moment they tap Start 👆')); return goPurpose(st, ctx, turns); }
        if (v === 'button') return goButton(st, ctx, turns, d.steps[st.focus] && trigOf(d.steps[st.focus], st.focus) !== 'no_response' ? st.focus : lastMessage(d), null);
        if (v === 'remind') {
          const ts = remindTargets(d, ctx);
          if (ts.length === 1) { st.pend = { remind: { target: ts[0].k } }; st.stage = 'remind_time'; return ask(st, ctx, turns); }
          st.stage = 'remind_what'; st.pend = {}; return ask(st, ctx, turns);
        }
        return;
      case 't':
        if (v === 'other') { st.stage = 'timing_other'; return ask(st, ctx, turns); }
        if (v === 'back') { st.stage = 'timing'; return ask(st, ctx, turns); }
        return setTiming(st, ctx, turns, Number(v));
      case 'rule': {
        const sec = Number(P.ruled) || 0;
        st.pend = { trigger: sec ? { type: 'wait', seconds: sec } : { type: 'after_previous' } };
        turns.push(turn(st, 'cas', 'Okay, keeping ' + waitText(sec) + '. Only people who tapped Start will get it.'));
        return goPurpose(st, ctx, turns);
      }
      case 'p':
        if (v === 'own') { st.stage = 'own_new'; st.pend = { trigger: P.trigger, purpose: 'own' }; return ask(st, ctx, turns); }
        out.ai = wantWrite(st, { role: 'message', purpose: v, insert: { trigger: P.trigger } });
        return;
      case 'bk': st.pend.btn.kind = v; st.stage = 'btn_label'; return ask(st, ctx, turns);
      case 'bl': return labelPicked(st, ctx, turns, v);
      case 'bm':
        if (v === 'more') return goButton(st, ctx, turns, P.btn.index, P.btn.kind || null);
        if ((d.steps[P.btn.index].buttons || []).some((b) => b.kind === 'reply') && replyOk(d, ctx)) return goBranches(st, ctx, turns, P.btn.index, []);
        return goNext(st, ctx, turns);
      case 'br': {
        const b = findButton(d, P.button);
        if (v === 'skip') return goBranches(st, ctx, turns, P.owner, (P.skipped || []).concat(P.button));
        if (v === 'own') { st.stage = 'own_new'; st.pend = { trigger: { type: 'on_button', button: P.button }, role: 'answer', label: b ? b.label : '', after: 'branches', owner: P.owner, skipped: P.skipped }; return ask(st, ctx, turns); }
        out.ai = wantWrite(st, { role: 'answer', label: b ? b.label : '', insert: { trigger: { type: 'on_button', button: P.button } }, owner: P.owner, skipped: P.skipped });
        return;
      }
      case 'rw': st.pend = { remind: { target: v } }; st.stage = 'remind_time'; return ask(st, ctx, turns);
      case 'rt':
        if (v === 'other') { st.stage = 'remind_other'; return ask(st, ctx, turns); }
        if (v === 'back') { st.stage = 'remind_time'; return ask(st, ctx, turns); }
        return setRemind(st, ctx, turns, Number(v));
      case 'rd':
        if (v === 'play') { turns.push(turn(st, 'cas', 'Here it comes ▶ Tap the glowing button on the phone to carry on.')); return goReady(st, ctx, turns, { q: 'What next? 🙂' }); }
        if (v === 'test') { turns.push(turn(st, 'cas', 'Sending a test to your Telegram 📲 Tap Start in your bot when it opens.')); return goReady(st, ctx, turns, { q: 'What next? 🙂' }); }
        if (v === 'edit') return goNext(st, ctx, turns, { q: 'What would you like to change? Tap or type 🙂' });
        if (v === 'where') { st.ready_back = true; return isBotD(d) ? botWhere(st, ctx, turns) : goSetup(st, ctx, turns); }
        return goReady(st, ctx, turns);
      case 'sw': return goSwitch(st, ctx, turns);
      case 'end':
        if (v === 'edit') { st.edit = true; return goNext(st, ctx, turns); }
        return ask(st, ctx, turns);
      default: return ask(st, ctx, turns);
    }
  }

  /* ---------- Chat bots: the conversation ----------
   * First question: "What do you want your bot to do?" (st.kind). A welcome bot goes on as before (goal → about → …).
   * The other kinds ask only what they need, one tap at a time, each with a "Recommended" answer and "✨ Just build it
   * for me" (the rest gets the defaults). Answers live in st.bk; buildBot() makes the whole bot from them (no AI).
   * Only "✍️ Something else" may ask the AI (out.ai { kind: 'bot', text }): the caller answers with aiDone({ bot }), a
   * bot already checked against services/flows.js AI_BOT_KEYS (cleanAiBot), and it is checked here again for the plan.
   * A join check needs Telegram: out.check { bot_id, chat_id } (stage 'wait_check'); the caller answers with checkDone().
   */
  const KINDS = {
    welcome: { chip: '👋 Welcome people who ask to join my channel' },
    join_check: { chip: '✅ Make people join my channel first', name: 'Join my channel first', code: 'join', say: 'Lovely! People join your channel first, then they get what you promised ✅' },
    lead_magnet: { chip: '🎁 Give a free gift', name: 'Free gift', code: 'gift', say: 'Lovely! People tap Start from your ad or post and get your free gift 🎁' },
    menu: { chip: '📋 Show a menu', name: 'Menu', code: 'menu', say: 'Lovely! A short menu, and each button gets its own answer 📋' },
    lead_questions: { chip: '❓ Ask people questions (collect leads)', name: 'Lead questions', code: 'leads', say: 'Lovely! Your bot asks a few questions and keeps the answers for you ❓' },
    referral: { chip: '🔗 Get people to invite friends', name: 'Invite friends', code: 'invite', say: 'Lovely! Everyone gets their own invite link, and a reward when enough friends join 🔗' },
    custom: { name: 'My bot', code: 'hello', say: '' },
  };
  const KIND_ORDER = ['welcome', 'join_check', 'lead_magnet', 'menu', 'lead_questions', 'referral'];
  const KIND_GOT = { welcome: 'A welcome for people who ask to join 👋', join_check: 'People join your channel first ✅', lead_magnet: 'A free gift bot 🎁', menu: 'A menu bot 📋', lead_questions: 'A bot that asks questions ❓', referral: 'An invite-friends bot 🔗' };
  const ALT = { lead_questions: 'menu', referral: 'lead_magnet', welcome: 'join_check' };
  const ALT_CHIP = { menu: '📋 Build a menu instead', lead_magnet: '🎁 Build a free gift bot instead', join_check: '✅ Build a join-check bot instead' };
  const ALT_Q = { menu: 'Shall I build a menu people tap instead? Your plan includes it.', lead_magnet: 'Shall I build a free gift bot instead? Your plan includes it.', join_check: 'Shall I build a bot that makes people join your channel first?' };
  const TXT = {
    check: 'Hi {name} 👋 Welcome!\n\nTo get started, please join our channel first. Tap the link below, then tap *I\'ve joined*.',
    joined_gift: 'Thanks for joining, {name}! 🎉 Here\'s your free gift. Tap the button below to open it 👇',
    joined_thanks: 'Thanks for joining, {name}! 🎉 You\'re all set. Welcome to the family 💙',
    gift: 'Hi {name} 👋 Thanks for tapping Start!\n\nHere\'s your free gift 🎁 Tap the button below to open it.',
    gift_soon: 'Hi {name} 👋 Thanks for tapping Start!\n\nYour free gift is ready for you 🎁',
    gift_follow: 'Hi {name}, did you get a chance to open your free gift? 🙂 We hope you enjoy it!',
    menu: 'Hi {name} 👋 What would you like to know? Tap a button below 👇',
    lq_intro: 'Hi {name} 👋 A few quick questions so we can help you better.',
    lq_thanks: 'Thank you, {name}! 🙌 We\'ll be in touch soon.',
    lq_gift: 'Thank you, {name}! 🙌 Here\'s your free gift. Tap the button below to open it 👇',
    referral: 'Hi {name} 👋 Invite {goal} friends and get a free gift 🎁\n\nYour own link:\n{invite_link}\n\nFriends joined so far: {invites} of {goal}',
    reward_link: '🎉 You did it, {name}! Here\'s your reward. Tap the button below to get it 👇',
    reward_thanks: '🎉 You did it, {name}! Thank you so much for inviting your friends 💙',
    custom: 'Hi {name} 👋 Thanks for tapping Start!',
  };
  const MENU_PRESETS = [
    ['💰 Prices', 'Here are our prices 💰 Send us a message here and we\'ll share the latest ones with you.'],
    ['❓ How it works', 'Here\'s how it works ❓ Tell us what you need, and we\'ll guide you one simple move at a time.'],
    ['💬 Talk to us', 'We\'d love to help 💬 Send us a message here and we\'ll reply soon.'],
    ['⭐ VIP', 'Our VIP members get our best updates first ⭐ Send us a message to join.'],
    ['📘 Free tips', 'Here\'s a free tip for you 📘 Turn on notifications so you never miss our updates.'],
    ['📍 Where to find us', 'Send us a message and we\'ll tell you where to find us 📍'],
  ];
  const QUESTIONS = {
    name: { chip: '👤 Name', label: 'Name', answer: 'text', body: 'What is your full name?' },
    phone: { chip: '📱 Phone number', label: 'Phone', answer: 'phone', body: 'What is your phone number? Tap the button below, or type it with your country code.' },
    email: { chip: '📧 Email', label: 'Email', answer: 'email', body: 'What is your email address?' },
    country: { chip: '🌍 Country', label: 'Country', answer: 'text', body: 'Which country are you in?' },
  };
  const Q_ORDER = ['name', 'phone', 'email', 'country'];
  const BOT_CHIPS = ['kind', 'kl', 'bb', 'ba', 'bkc', 'bg', 'bkl', 'bkr', 'bf', 'mb', 'ma', 'lq', 'bt', 'rg', 'rr'];
  const BOT_TEXT_STAGES = ['kind', 'kind_other', 'kind_locked', 'bk_chat', 'bk_admin', 'bk_gift', 'bk_link', 'bk_remind', 'bk_follow', 'bk_menu', 'bk_menu_own', 'bk_ans', 'bk_qs', 'bk_q_custom', 'bk_thanks', 'bk_goal', 'bk_reward', 'bk_broadcast'];
  const kindLocked = (ctx, k) => k !== 'welcome' && KINDS[k] && k !== 'custom' && !botTypeOk(ctx, k);
  const bcastOk = (ctx) => botTypeOk(ctx, 'broadcast') || has(ctx, 'broadcasts');
  const botUser = (d, ctx) => { const b = (ctx.bots || []).find((x) => String(x.id) === String(d.bot_id)); return b && b.username ? b.username : ''; };
  const needsChat = (d) => d.steps.some((s) => kindOf(s) === 'check_join');
  const checkChatOk = (d, ctx) => d.steps.every((s) => kindOf(s) !== 'check_join' || ((s.check || {}).chat_id && (ctx.chats || []).some((c) => String(c.id) === String(s.check.chat_id))));
  const chatTitle = (ctx, id) => { const c = (ctx.chats || []).find((x) => String(x.id) === String(id)); return c ? firstLine(c.title || 'your channel', 40) : 'your channel'; };

  /** What a few typed words probably mean (no AI). */
  function guessKind(text) {
    const t = ' ' + String(text || '').toLowerCase() + ' ';
    if (/\b(broadcast|mass message|message (to )?(all|everyone)|send (a |one )?message to (all|everyone))\b/.test(t)) return 'broadcast';
    if (/\b(invite|invites|inviting|referral|referrals|refer|friends?)\b/.test(t)) return 'referral';
    if (/\bjoin\b.*\bfirst\b|\b(must|have to|need to|should) join\b|\bcheck (if |that )?they (have )?joined\b/.test(t)) return 'join_check';
    if (/\b(questions?|leads?|collect|survey|form|e-?mails?|phone|whatsapp|numbers?)\b/.test(t)) return 'lead_questions';
    if (/\b(menu|buttons?|options|faq)\b/.test(t)) return 'menu';
    if (/\b(gift|freebie|lead magnet|free (pdf|ebook|e-book|guide|course|book|signals?|download|lesson)|download|pdf|ebook)\b/.test(t)) return 'lead_magnet';
    if (/\b(asks? to join|join requests?|welcome (people|them|new|everyone))\b/.test(t)) return 'welcome';
    return null;
  }
  /** A start link code nobody else uses on that Telegram bot, and "also answer a plain Start" when no live bot does. */
  function setCode(st, ctx, force) {
    const d = st.draft;
    const mine = (ctx.chatbots || []).filter((b) => !d.bot_id || String(b.bot_id) === String(d.bot_id));
    const used = new Set(mine.map((b) => String(b.start_code || '').toLowerCase()));
    if (!d.start_code || force || used.has(String(d.start_code).toLowerCase())) {
      const base = (KINDS[st.kind] && KINDS[st.kind].code) || 'hello';
      let code = base, n = 2;
      while (used.has(code)) code = base + n++;
      d.start_code = code;
    }
    d.is_default = !mine.some((b) => b.active && b.is_default);
  }
  function blankBot(st) { return { start_type: 'bot_start', name: (KINDS[st.kind] || KINDS.custom).name, bot_id: st.draft && st.draft.bot_id ? st.draft.bot_id : null, start_code: '', is_default: false, steps: [] }; }
  function checkReq(st) { return { bot_id: st.draft.bot_id || null, chat_id: (st.bk || {}).chat || null }; }
  function wantCheck(st, back) { st.stage = 'wait_check'; st.pend = { back: back || 'next' }; }

  function chooseKind(st, ctx, turns, k) {
    if (k === 'welcome') {
      if (ctx.flows_full) return lockedKind(st, ctx, turns, 'welcome');
      if (isBotD(st.draft)) st.draft = { name: 'My welcome bot', chat_id: null, bot_id: null, approve_mode: 'after_welcome', start_button: false, start_label: '', steps: [] };
      st.kind = 'welcome'; st.stage = 'goal'; st.pend = {};
      return ask(st, ctx, turns);
    }
    if (!KINDS[k]) k = 'custom';
    if (kindLocked(ctx, k)) return lockedKind(st, ctx, turns, k);
    st.kind = k; st.bk = {}; st.built = false;
    st.draft = blankBot(st);
    if (KINDS[k].say) turns.push(turn(st, 'cas', KINDS[k].say));
    return botNext(st, ctx, turns);
  }
  function lockedKind(st, ctx, turns, k) {
    const alt = ALT[k] && !kindLocked(ctx, ALT[k]) ? ALT[k] : null;
    if (k === 'welcome') turns.push(turn(st, 'cas', 'Your ' + planName(ctx) + ' plan includes ' + (ctx.flows_limit || 1) + ' welcome bot' + ((ctx.flows_limit || 1) === 1 ? '' : 's') + ', and ' + ((ctx.flows_limit || 1) === 1 ? 'you have it already' : 'they\'re all in use') + ' 🙂 You can change it on the Bots page, or build another kind of bot.'));
    else turns.push(turn(st, 'cas', botLockText(ctx, k).replace(/\.$/, '') + ' 🌱 You can upgrade any time.'));
    st.stage = 'kind_locked'; st.pend = { kind: k, alt };
    return ask(st, ctx, turns);
  }
  function goBroadcast(st, ctx, turns) {
    turns.push(turn(st, 'cas', bcastOk(ctx) ? 'To send one message to everyone who started your bots, use Send a message 📣 Pick "Started <your bot>" as who gets it.' : botLockText(ctx, 'broadcast') + ' 🌱'));
    st.stage = 'bk_broadcast'; st.pend = {};
    return ask(st, ctx, turns);
  }

  /** The next thing to ask for this kind of bot (or build it when everything is known). */
  function botNext(st, ctx, turns) {
    const d = st.draft;
    const B = st.bk || (st.bk = {});
    const bots = ctx.bots || [];
    if (!botOk(d, ctx) && bots.length === 1) d.bot_id = bots[0].id;
    if (!botOk(d, ctx) && bots.length > 1) { st.stage = 'bot'; st.pend = {}; return ask(st, ctx, turns); }
    setCode(st, ctx);
    if (d.steps.length) { st.ready_back = false; return goReady(st, ctx, turns); }
    const go = (stage, pend) => { st.stage = stage; st.pend = pend || {}; return ask(st, ctx, turns); };
    const k = st.kind;
    if (k === 'join_check') {
      if (B.chat === undefined) {
        const chats = ctx.chats || [];
        if (chats.length === 1) { B.chat = chats[0].id; turns.push(turn(st, 'cas', 'People will join *' + chatTitle(ctx, B.chat) + '* first ✓')); }
        else if (chats.length > 1) return go('chat');
        else return go('bk_chat');
      }
      if (B.chat && !B.checked && !B.check_skip && botOk(d, ctx)) return wantCheck(st, 'next');
      if (B.gift === undefined) return go('bk_gift');
      if (B.gift === 'link' && B.link === undefined) return go('bk_link', { for: 'gift' });
      if (B.remind === undefined) return go('bk_remind');
    } else if (k === 'lead_magnet') {
      if (B.link === undefined) return go('bk_link', { for: 'gift' });
      if (B.follow === undefined && botStepLimit(ctx) !== 1 && botStepLimit(ctx) !== 0) return go('bk_follow');
    } else if (k === 'menu') {
      if (!B.menu_done) return go('bk_menu');
      const i = (B.menu || []).findIndex((m) => m.answer === undefined && !m.link);
      if (i >= 0) return go('bk_ans', { idx: i });
    } else if (k === 'lead_questions') {
      if (!B.qs_done) return go('bk_qs');
      if (B.thanks === undefined) return go('bk_thanks');
      if (B.thanks === 'link' && B.link === undefined) return go('bk_link', { for: 'thanks' });
    } else if (k === 'referral') {
      if (B.goal === undefined) return go('bk_goal');
      if (B.reward === undefined) return go('bk_reward');
      if (B.reward === 'link' && B.link === undefined) return go('bk_link', { for: 'reward' });
    }
    return buildBot(st, ctx, turns);
  }

  function botQuestion(st, ctx, stage) {
    const d = st.draft, P = st.pend || {}, B = st.bk || {};
    const own = (ph) => typeOwn(ph);
    switch (stage) {
      case 'kind': return { text: 'What do you want your bot to do?', chips: KIND_ORDER.map((k) => ({ id: 'kind:' + k, label: KINDS[k].chip, ...(kindLocked(ctx, k) ? { hint: unlockPlan(ctx, k) } : {}) })).concat([{ id: 'kind:other', label: '✍️ Something else (type it)', type: 'Tell me what your bot should do…' }]), input: 'Or tell me in a few words' };
      case 'kind_other': return { text: 'Tell me in a few words what your bot should do 🙂', chips: [own('Tell me what your bot should do…'), { id: 'kl:back', label: '↩ Back' }], input: 'e.g. send my free PDF to people from my ad' };
      case 'kind_locked': {
        const chips = [];
        if (P.alt) chips.push({ id: 'kl:alt', label: ALT_CHIP[P.alt], pri: true, hint: 'Recommended' });
        chips.push({ id: 'kl:plans', label: '⬆ See plans', lock: P.kind === 'welcome' ? 'flows' : 'bot_' + P.kind });
        chips.push({ id: 'kl:back', label: '↩ Pick something else' });
        return { text: P.alt ? ALT_Q[P.alt] : 'What would you like to build instead?', chips };
      }
      case 'bk_broadcast': return { text: 'Anything else I can build for you? 🙂', chips: (bcastOk(ctx) ? [{ id: 'bb:open', label: '📣 Open Send a message', act: 'broadcast', pri: true }] : [{ id: 'kl:plans', label: '⬆ See plans', lock: 'bot_broadcast' }]).concat([{ id: 'kl:back', label: '↩ Pick something else' }]) };
      case 'bk_chat': return { text: 'Which channel should people join first? Connect it, and I\'ll check it for you 🔌', chips: [{ id: 'cc:connect', label: '🔌 Connect my channel', act: 'connect_channel', pri: true }, { id: 'cc:check', label: 'I\'ve connected it ✓' }, { id: 'bkc:later', label: 'I\'ll connect it later' }, JB] };
      case 'wait_check': return { text: '', chips: [] };
      case 'bk_admin': return { text: P.q || 'Shall I check again?', chips: [{ id: 'ba:again', label: '✅ I\'ve made it an admin', pri: true }, { id: 'ba:later', label: 'I\'ll do it later' }] };
      case 'bk_gift': return { text: 'What do they get after they join?', chips: [{ id: 'bg:link', label: '🎁 A link to my free gift', pri: true, hint: 'Recommended' }, { id: 'bg:thanks', label: '💬 Just a thank-you' }, own('Type what they get…'), JB] };
      case 'bk_link': return { text: P.for === 'reward' ? 'Paste the link to their reward 🎁' : P.for === 'menu' ? 'Paste the link this button should open 🔗' : 'Paste the link to your free gift 🎁', chips: [own('Paste your link here…'), { id: 'bkl:later', label: 'I\'ll add it later' }].concat(P.for === 'menu' ? [] : [JB]), input: 'https://' };
      case 'bk_remind': return { text: 'Shall I remind them after 10 minutes if they haven\'t joined yet? 💤', chips: [{ id: 'bkr:yes', label: 'Yes please 👍', pri: true, hint: 'Recommended' }, { id: 'bkr:no', label: 'No thanks' }, JB] };
      case 'bk_follow': return { text: 'Your gift goes out right away. When should a friendly follow-up come?', chips: [{ id: 'bf:0', label: '⚡ Send right away' }, { id: 'bf:3600', label: '1 hour later' }, { id: 'bf:86400', label: 'Tomorrow', pri: true, hint: 'Recommended' }, { id: 'bf:none', label: '🙅 No follow-up' }, own('For example: 30 minutes'), JB], input: 'For example: 30 minutes' };
      case 'bk_menu': {
        const have = B.menu || [];
        const room = botMaxBtn(ctx) - have.length;
        const chips = [];
        if (!have.length && room >= 3) chips.push({ id: 'mb:rec', label: '✨ Prices, How it works, Talk to us', pri: true, hint: 'Recommended' });
        if (room > 0) {
          MENU_PRESETS.forEach((m, i) => { if (!have.some((x) => x.label === m[0])) chips.push({ id: 'mb:p' + i, label: m[0] }); });
          chips.push(own('Type your button text…'));
        }
        if (have.length) chips.push({ id: 'mb:done', label: '✅ Done', pri: true });
        chips.push(JB);
        return { text: have.length ? (room > 0 ? 'Added ✓ Add another button, or tap Done.' : 'That\'s the most your plan allows on one message. Tap Done 🙂') : 'Which buttons should your menu have? Tap to add them.', chips, input: 'Type your button text…' };
      }
      case 'bk_menu_own': return { text: 'What should the button say?', chips: [{ id: 'mb:back', label: '↩ Back' }], input: 'Type your button text…' };
      case 'bk_ans': { const m = (B.menu || [])[P.idx] || {}; return { text: 'What should *' + firstLine(m.label || 'that button', 30) + '* send?', chips: [{ id: 'ma:write', label: '✨ Write it for me', pri: true }, own('Type what it sends…'), { id: 'ma:link', label: '🔗 Open a link instead' }, JB], input: 'Type what it sends…' }; }
      case 'bk_qs': {
        const have = B.qs || [];
        const room = botQuestionLimit(ctx) - have.length;
        const chips = [];
        if (!have.length && room >= 3) chips.push({ id: 'lq:rec', label: '✨ Name, phone and email', pri: true, hint: 'Recommended' });
        if (room > 0) {
          Q_ORDER.forEach((q) => { if (!have.some((x) => x.key === q)) chips.push({ id: 'lq:' + q, label: QUESTIONS[q].chip }); });
          chips.push({ id: 'lq:custom', label: '✍️ Custom…', type: 'Type your question…' });
        }
        if (have.length) chips.push({ id: 'lq:done', label: '✅ Done', pri: true });
        chips.push(JB);
        return { text: have.length ? (room > 0 ? 'Added ✓ Add another question, or tap Done.' : 'That\'s the most your plan asks in one bot. Tap Done 🙂') : 'Which questions should your bot ask? Tap to add them.', chips, input: 'Type your question…' };
      }
      case 'bk_q_custom': return { text: 'Type your question, like _What is your budget?_', chips: [{ id: 'lq:back', label: '↩ Back' }], input: 'Type your question…' };
      case 'bk_thanks': return { text: 'What should they get after the last answer?', chips: [{ id: 'bt:thanks', label: '🙏 Just a thank-you', pri: true, hint: 'Recommended' }, { id: 'bt:link', label: '🎁 A link to my free gift' }, own('Type your thank-you…'), JB] };
      case 'bk_goal': return { text: 'How many friends should each person invite?', chips: [{ id: 'rg:1', label: '1 friend' }, { id: 'rg:3', label: '3 friends', pri: true, hint: 'Recommended' }, { id: 'rg:5', label: '5 friends' }, { id: 'rg:10', label: '10 friends' }, own('Type a number, like 4'), JB], input: 'Type a number, like 4' };
      case 'bk_reward': return { text: 'What do they get when they reach it?', chips: [{ id: 'rr:link', label: '🎁 A link to their reward', pri: true, hint: 'Recommended' }, { id: 'rr:thanks', label: '💬 A thank-you message' }, own('Type the reward message…'), JB] };
      default: return { text: '', chips: [] };
    }
  }

  function botChip(st, ctx, turns, k, v) {
    const d = st.draft, P = st.pend || {};
    const B = st.bk || (st.bk = {});
    const next = () => botNext(st, ctx, turns);
    switch (k) {
      case 'kind':
        if (v === 'other') { st.stage = 'kind_other'; st.pend = {}; return ask(st, ctx, turns); }
        return chooseKind(st, ctx, turns, v);
      case 'kl':
        if (v === 'alt' && P.alt) return chooseKind(st, ctx, turns, P.alt);
        st.stage = 'kind'; st.pend = {};
        return ask(st, ctx, turns);
      case 'bb':
        turns.push(turn(st, 'cas', 'Opening Send a message 📣'));
        return ask(st, ctx, turns);
      case 'bkc':
        B.chat = null;
        turns.push(turn(st, 'cas', 'No problem. Connect it before you switch it on, and I\'ll check it then 🙂'));
        return next();
      case 'ba':
        if (v === 'again') return wantCheck(st, P.back || 'next');
        B.check_skip = true;
        turns.push(turn(st, 'cas', 'No problem 🙂 I\'ll remind you before it goes live.'));
        return P.back === 'ready' ? goReady(st, ctx, turns) : next();
      case 'bg':
        B.gift = v === 'link' ? 'link' : 'thanks';
        return next();
      case 'bkl':
        if (P.for === 'menu') { const m = (B.menu || [])[P.idx]; if (m) m.answer = undefined; st.stage = 'bk_ans'; return ask(st, ctx, turns); }
        B.link = '';
        turns.push(turn(st, 'cas', 'No problem. Paste it here any time and I\'ll add a button that opens it 🔗'));
        return next();
      case 'bkr':
        B.remind = v === 'yes';
        return next();
      case 'bf':
        if (v === 'none') { B.follow = null; return next(); }
        return setFollow(st, ctx, turns, Number(v));
      case 'mb': {
        B.menu = B.menu || [];
        const room = botMaxBtn(ctx) - B.menu.length;
        if (v === 'rec') { MENU_PRESETS.slice(0, Math.min(3, room)).forEach((m) => B.menu.push({ label: m[0] })); B.menu_done = true; return next(); }
        if (v === 'done') { B.menu_done = true; return next(); }
        if (v === 'back') { st.stage = 'bk_menu'; return ask(st, ctx, turns); }
        const m = MENU_PRESETS[Number(String(v).slice(1))];
        if (m && room > 0) B.menu.push({ label: m[0] });
        st.stage = 'bk_menu'; st.pend = {};
        return ask(st, ctx, turns);
      }
      case 'ma': {
        const m = (B.menu || [])[P.idx];
        if (!m) return next();
        if (v === 'link') { st.stage = 'bk_link'; st.pend = { for: 'menu', idx: P.idx }; return ask(st, ctx, turns); }
        m.answer = '';
        return next();
      }
      case 'lq': {
        B.qs = B.qs || [];
        const room = botQuestionLimit(ctx) - B.qs.length;
        if (v === 'rec') { ['name', 'phone', 'email'].slice(0, Math.max(0, room)).forEach((q) => B.qs.push({ key: q, ...QUESTIONS[q] })); B.qs_done = true; return next(); }
        if (v === 'done') { B.qs_done = true; return next(); }
        if (v === 'custom') { st.stage = 'bk_q_custom'; st.pend = {}; return ask(st, ctx, turns); }
        if (v === 'back') { st.stage = 'bk_qs'; st.pend = {}; return ask(st, ctx, turns); }
        if (QUESTIONS[v] && room > 0 && !B.qs.some((x) => x.key === v)) B.qs.push({ key: v, ...QUESTIONS[v] });
        st.stage = 'bk_qs'; st.pend = {};
        return ask(st, ctx, turns);
      }
      case 'bt':
        B.thanks = v === 'link' ? 'link' : 'thanks';
        return next();
      case 'rg':
        B.goal = Math.max(1, Math.min(1000, Number(v) || 3));
        return next();
      case 'rr':
        B.reward = v === 'link' ? 'link' : 'thanks';
        return next();
      default: return ask(st, ctx, turns);
    }
  }
  function setFollow(st, ctx, turns, sec) {
    st.bk.follow = Math.max(0, Math.min(MAX_WAIT, Number(sec) || 0));
    turns.push(turn(st, 'cas', st.bk.follow ? 'The follow-up comes ' + waitText(st.bk.follow) + ' after the gift ⏱' : 'The follow-up comes right after the gift ⚡'));
    return botNext(st, ctx, turns);
  }
  /** Infer the kind of answer from the question's words (email, phone, number, yes or no). */
  function questionFrom(text) {
    const t = text.toLowerCase();
    if (/e-?mail/.test(t)) return { answer: 'email', label: 'Email' };
    if (/phone|whatsapp|mobile number|telephone/.test(t)) return { answer: 'phone', label: 'Phone' };
    if (/\b(how many|how much|how old|your age|budget|number of)\b/.test(t)) return { answer: 'number', label: firstLine(text.replace(/\?+$/, ''), 40) };
    if (/\byes or no\b|\(yes\/no\)/.test(t)) return { answer: 'choice', choices: ['Yes', 'No'], label: firstLine(text.replace(/\?+$/, ''), 40) };
    return { answer: 'text', label: firstLine(text.replace(/\?+$/, ''), 40) };
  }
  function botText(st, ctx, turns, text, out) {
    const P = st.pend || {};
    const B = st.bk || (st.bk = {});
    const again = (msg) => { turns.push(turn(st, 'cas', msg)); return ask(st, ctx, turns); };
    switch (st.stage) {
      case 'kind': case 'kind_other': {
        const r = cleanText(text, 300, 'That');
        if (r.error) return again(r.error + ' Try a few plain words.');
        const k = guessKind(r.value);
        if (k === 'broadcast') return goBroadcast(st, ctx, turns);
        if (k) { turns.push(turn(st, 'cas', 'Got it ✓ ' + KIND_GOT[k])); return chooseKind(st, ctx, turns, k); }
        st.kind = 'custom'; st.bk = { brief: r.value }; st.built = false;
        st.draft = blankBot(st);
        const bots = ctx.bots || [];
        if (bots.length === 1) st.draft.bot_id = bots[0].id;
        turns.push(turn(st, 'cas', 'Let me put that together for you ✍️'));
        st.resume = { stage: 'kind', pend: {} };
        st.stage = 'wait_ai'; st.pend = { botreq: true, text: r.value };
        out.ai = { kind: 'bot', text: r.value };
        return;
      }
      case 'bk_link': {
        const r = cleanUrl(text);
        if (r.error) return again('Hmm, ' + r.error.charAt(0).toLowerCase() + r.error.slice(1));
        if (P.for === 'menu') { const m = (B.menu || [])[P.idx]; if (m) { m.link = r.value; delete m.answer; } turns.push(turn(st, 'cas', 'Got it ✓ That button opens your link.')); return botNext(st, ctx, turns); }
        B.link = r.value;
        turns.push(turn(st, 'cas', 'Got it ✓ I\'ll add a button that opens it.'));
        return botNext(st, ctx, turns);
      }
      case 'bk_gift': case 'bk_thanks': case 'bk_reward': {
        const r = cleanText(text, textMax(ctx), 'Your message');
        if (r.error) return again(r.error);
        const u = /^\S+$/.test(r.value) && /[./]/.test(r.value) ? cleanUrl(r.value) : { error: 1 };
        const key = st.stage === 'bk_gift' ? 'gift' : st.stage === 'bk_thanks' ? 'thanks' : 'reward';
        if (!u.error) { B[key] = 'link'; B.link = u.value; turns.push(turn(st, 'cas', 'Got it ✓ I\'ll add a button that opens it.')); return botNext(st, ctx, turns); }
        B[key] = 'own'; B.own = r.value;
        turns.push(turn(st, 'cas', 'Got it ✓ I put your words in.'));
        return botNext(st, ctx, turns);
      }
      case 'bk_menu': case 'bk_menu_own': {
        const r = cleanLabel(text);
        if (r.error) return again(r.error + ' Keep it short, like "💰 Prices".');
        B.menu = B.menu || [];
        if (B.menu.length >= botMaxBtn(ctx)) return again('That\'s the most your plan allows on one message 🙂');
        if (B.menu.some((m) => norm(m.label) === norm(r.value))) return again('That button is in already 🙂');
        B.menu.push({ label: r.value });
        st.stage = 'bk_menu'; st.pend = {};
        return ask(st, ctx, turns);
      }
      case 'bk_ans': {
        const m = (B.menu || [])[P.idx];
        if (!m) return botNext(st, ctx, turns);
        const r = cleanText(text, textMax(ctx), 'Your message');
        if (r.error) return again(r.error);
        m.answer = r.value;
        turns.push(turn(st, 'cas', 'Got it ✓'));
        return botNext(st, ctx, turns);
      }
      case 'bk_qs': case 'bk_q_custom': {
        const r = cleanText(text, 300, 'Your question');
        if (r.error) return again(r.error);
        B.qs = B.qs || [];
        if (B.qs.length >= botQuestionLimit(ctx)) return again('That\'s the most your plan asks in one bot 🙂');
        const q = questionFrom(r.value);
        B.qs.push({ key: 'c' + B.qs.length, body: r.value, ...q });
        st.stage = 'bk_qs'; st.pend = {};
        return ask(st, ctx, turns);
      }
      case 'bk_goal': {
        const n = Number(String(text).replace(/[^\d]/g, ''));
        if (!Number.isInteger(n) || n < 1 || n > 1000) return again('Type a number from 1 to 1,000, like 3 🙂');
        B.goal = n;
        return botNext(st, ctx, turns);
      }
      case 'bk_follow': return again('I didn\'t catch that time. Try something like _30 minutes_ or _2 hours_.');
      default: return again('Tap one of the answers below, or tell me in a few words 🙂');
    }
  }

  /** The channel (several connected) for a join check. */
  function botChat(st, ctx, turns, c) {
    const B = st.bk || (st.bk = {});
    if (!c) return ask(st, ctx, turns);
    setBotChat(st, c.id);
    B.checked = false;
    if (st.draft.steps.length) { if (botOk(st.draft, ctx)) return wantCheck(st, 'ready'); return goReady(st, ctx, turns); }
    return botNext(st, ctx, turns);
  }
  function setBotChat(st, id) {
    const B = st.bk || (st.bk = {});
    B.chat = id; B.checked = false; B.check_skip = false;
    st.draft.steps.forEach((s) => { if (kindOf(s) === 'check_join') s.check = { ...(s.check || {}), chat_id: id }; });
  }
  function botPicked(st, ctx, turns) {
    const d = st.draft;
    setCode(st, ctx, true);
    if (st.bk) { st.bk.checked = false; st.bk.check_skip = false; }
    if (d.steps.length) {
      st.ready_back = false;
      if (needsChat(d) && checkChatOk(d, ctx)) return wantCheck(st, 'ready');
      return goReady(st, ctx, turns);
    }
    return botNext(st, ctx, turns);
  }
  function botConnected(st, ctx, turns, k) {
    const d = st.draft;
    if (k === 'cb' && !botOk(d, ctx) && ctx.bots.length === 1) { d.bot_id = ctx.bots[0].id; setCode(st, ctx, true); }
    if (k === 'cc' && (st.bk || {}).chat == null && ctx.chats.length === 1) setBotChat(st, ctx.chats[0].id);
    if (!d.steps.length) { if (k === 'cc' && ctx.chats.length > 1 && (st.bk || {}).chat == null) { st.stage = 'chat'; st.pend = {}; return ask(st, ctx, turns); } return botNext(st, ctx, turns); }
    if ((k === 'cb' && !botOk(d, ctx)) || (k === 'cc' && needsChat(d) && !checkChatOk(d, ctx))) return botWhere(st, ctx, turns);
    turns.push(turn(st, 'cas', 'Connected ✓'));
    if (needsChat(d) && botOk(d, ctx)) return wantCheck(st, 'ready');
    return st.stage === 'switch' ? goSwitch(st, ctx, turns) : goReady(st, ctx, turns);
  }
  /** "Pick your bot / channel" from the ready screen. */
  function botWhere(st, ctx, turns) {
    const d = st.draft;
    if (!botOk(d, ctx) && (ctx.bots || []).length > 1) { st.stage = 'bot'; st.pend = {}; return ask(st, ctx, turns); }
    if (needsChat(d) && !checkChatOk(d, ctx) && (ctx.chats || []).length > 1) { st.stage = 'chat'; st.pend = {}; return ask(st, ctx, turns); }
    st.ready_back = false;
    return goReady(st, ctx, turns);
  }

  /** Telegram answered the join check (bots.checkCanCheck): { ok, message }. */
  function checkDone(state, result, ctx) {
    const st = clone(state);
    const turns = [];
    const B = st.bk || (st.bk = {});
    const back = (st.pend || {}).back || 'next';
    const res = result || {};
    if (res.ok || res.skipped) {
      B.checked = !!res.ok;
      if (!res.ok) B.check_skip = true;
      if (res.ok) turns.push(turn(st, 'cas', '✓ ' + (botUser(st.draft, ctx) ? '@' + botUser(st.draft, ctx) : 'Your bot') + ' can check who joined *' + chatTitle(ctx, B.chat) + '*.'));
      if (back === 'ready') goReady(st, ctx, turns); else botNext(st, ctx, turns);
      return { state: st, turns };
    }
    B.checked = false;
    const m = String(res.message || 'Your bot needs to be an admin of your channel so it can check who joined.').replace(/\s*Then try again\.$/, '');
    turns.push(turn(st, 'cas', 'One small thing 🌱 ' + m + ' Then tap "I\'ve made it an admin".'));
    st.stage = 'bk_admin'; st.pend = { back };
    ask(st, ctx, turns);
    return { state: st, turns };
  }

  /** The whole bot from the answers so far (defaults for the rest). No AI. */
  function buildBot(st, ctx, turns, again) {
    const d0 = st.draft;
    const B = st.bk || (st.bk = {});
    const k = KINDS[st.kind] ? st.kind : 'custom';
    const bots = ctx.bots || [], chats = ctx.chats || [];
    if (!botOk(d0, ctx) && bots.length === 1) d0.bot_id = bots[0].id;
    setCode(st, ctx);
    const nd = { start_type: 'bot_start', name: d0.name || KINDS[k].name, bot_id: d0.bot_id || null, start_code: d0.start_code, is_default: !!d0.is_default, steps: [] };
    const errs = [];
    const notes = [];
    const msg = (body, trigger) => { const s = { type: 'message', body, buttons: [], trigger: trigger || null }; nd.steps.push(s); return s; };
    const linkOn = (s, label, url) => { const b = mkButton(nd, { label, kind: 'link', url }, errs); if (b) s.buttons.push(b); };
    let later = null; // a message that will get a link the owner pastes later: [index, label, text now, text with the link]
    if (k === 'join_check') {
      const chat = B.chat != null ? B.chat : chats.length === 1 ? chats[0].id : null;
      nd.steps.push({ type: 'check_join', body: TXT.check, buttons: [], trigger: null, check: { chat_id: chat, remind: B.remind === false ? null : { value: 10, unit: 'min' } } });
      const link = (B.gift === 'link' || B.gift === undefined) && B.link ? B.link : '';
      const s = msg(B.gift === 'own' && B.own ? B.own : link ? TXT.joined_gift : TXT.joined_thanks, { type: 'after_previous' });
      if (link) linkOn(s, '🎁 Open my gift', link);
      else if (B.gift !== 'own' && B.gift !== 'thanks') later = [1, '🎁 Open my gift', TXT.joined_thanks, TXT.joined_gift];
      if (!chat) notes.push('Connect the channel people should join before you switch it on 🔌');
    } else if (k === 'lead_magnet') {
      const s = msg(B.link ? TXT.gift : TXT.gift_soon);
      if (B.link) linkOn(s, '🎁 Open my gift', B.link); else later = [0, '🎁 Open my gift', TXT.gift_soon, TXT.gift];
      const f = B.follow === undefined ? 86400 : B.follow;
      const lim = botStepLimit(ctx);
      if (f !== null && (lim < 0 || lim >= 2)) msg(TXT.gift_follow, f > 0 ? { type: 'wait', seconds: f } : { type: 'after_previous' });
      else if (lim >= 0 && lim < 2) notes.push('Your ' + planName(ctx) + ' plan sends 1 message per reply, so it\'s just the gift for now 💙');
    } else if (k === 'menu') {
      const room = botMaxBtn(ctx);
      const items = (B.menu && B.menu.length ? B.menu : MENU_PRESETS.slice(0, 3).map((m) => ({ label: m[0] }))).slice(0, room);
      const first = msg(TXT.menu);
      for (const m of items) {
        const b = mkButton(nd, m.link ? { label: m.label, kind: 'link', url: m.link } : { label: m.label, kind: 'reply' }, errs);
        if (!b) break;
        first.buttons.push(b);
        if (!m.link) { const p = MENU_PRESETS.find((x) => x[0] === m.label); msg(m.answer || (p ? p[1] : 'Thanks for tapping *' + m.label + '*, {name}! We\'ll reply soon 🙂'), { type: 'on_button', button: b.id }); }
      }
    } else if (k === 'lead_questions') {
      msg(TXT.lq_intro);
      const qs = (B.qs && B.qs.length ? B.qs : ['name', 'phone', 'email'].map((q) => ({ key: q, ...QUESTIONS[q] }))).slice(0, botQuestionLimit(ctx));
      for (const q of qs) nd.steps.push({ type: 'ask', body: q.body, buttons: [], trigger: { type: 'after_previous' }, ask: { answer: q.answer, label: q.label || '', choices: q.choices || [] } });
      const link = B.thanks === 'link' && B.link ? B.link : '';
      const s = msg(B.thanks === 'own' && B.own ? B.own : link ? TXT.lq_gift : TXT.lq_thanks, { type: 'after_previous' });
      if (link) linkOn(s, '🎁 Get my gift', link);
      else if (B.thanks === 'link') later = [nd.steps.length - 1, '🎁 Get my gift', TXT.lq_thanks, TXT.lq_gift];
    } else if (k === 'referral') {
      nd.steps.push({ type: 'referral', body: TXT.referral, buttons: [], trigger: null, referral: { goal: B.goal || 3 } });
      const link = (B.reward === 'link' || B.reward === undefined) && B.link ? B.link : '';
      const s = msg(B.reward === 'own' && B.own ? B.own : link ? TXT.reward_link : TXT.reward_thanks, { type: 'on_goal' });
      if (link) linkOn(s, '🎁 Get my reward', link);
      else if (B.reward !== 'own' && B.reward !== 'thanks') later = [1, '🎁 Get my reward', TXT.reward_thanks, TXT.reward_link];
    } else msg(TXT.custom);
    if (errs.length) {
      turns.push(turn(st, 'cas', 'Hmm, ' + String(errs[0]).replace(/^"[^"]*": /, '').replace(/^./, (c) => c.toLowerCase())));
      if (again) { st.stage = 'kind'; st.pend = {}; return ask(st, ctx, turns); }
      B.link = ''; (B.menu || []).forEach((m) => { delete m.link; });
      return buildBot(st, ctx, turns, true);
    }
    // Fit the plan: an intro or a follow-up goes first.
    const lim = botStepLimit(ctx);
    while (lim >= 0 && botMsgs(nd) > Math.max(1, lim)) {
      const last = nd.steps.length - 1;
      const cut = nd.steps.findIndex((s, i) => i === 0 && kindOf(s) === 'message' && nd.steps.length > 1 && kindOf(nd.steps[1]) !== 'message');
      if (cut === 0) { nd.steps.splice(0, 1); if (later) later[0]--; continue; }
      if (last > 0 && kindOf(nd.steps[last]) === 'message' && trigOf(nd.steps[last], last) !== 'on_goal') { nd.steps.splice(last, 1); continue; }
      break;
    }
    if (nd.steps[0]) nd.steps[0].trigger = null;
    const p = problems(nd, ctx);
    if (p) { turns.push(turn(st, 'cas', 'Hmm, I couldn\'t build that: ' + p)); st.stage = 'kind'; st.pend = {}; return ask(st, ctx, turns); }
    fixAllDirections(nd);
    snap(st);
    st.draft = nd; st.built = true; st.mode_said = true; st.focus = 0;
    if (later && nd.steps[later[0]]) { B.link_at = later[0]; B.link_label = later[1]; B.link_swap = [later[2], later[3]]; notes.push('Paste your link here any time and I\'ll add a button that opens it 🔗'); } else B.link_at = null;
    turns.push(turn(st, 'cas', 'Here\'s your whole bot ✨ Have a look on the phone.', { preview: true }));
    for (const n of notes) turns.push(turn(st, 'cas', n));
    const u = botUser(nd, ctx);
    if (u) turns.push(turn(st, 'cas', 'People open it with this link: t.me/' + u + '?start=' + nd.start_code + (nd.is_default ? ' (a plain Start in @' + u + ' works too)' : '') + ' 🔗'));
    st.stage = 'jb_review'; st.pend = {};
    return ask(st, ctx, turns);
  }

  /** The AI answered "✍️ Something else": { bot } (checked by the server against AI_BOT_KEYS), or nothing useful. */
  function botAiDone(st, res, ctx, turns) {
    st.resume = null;
    const bots = ctx.bots || [], chats = ctx.chats || [];
    if (res && res.bot && Array.isArray(res.bot.steps) && res.bot.steps.length) {
      const b = res.bot;
      const nd = { start_type: 'bot_start', name: cleanText(b.name || '', 60, 'x').value || 'My bot', bot_id: st.draft.bot_id || (bots.length === 1 ? bots[0].id : null), start_code: '', is_default: false, steps: [] };
      nd.steps = b.steps.map((s, i) => {
        const o = stepIn(s, i);
        o.type = kindOf(s);
        delete o.variants; delete o.condition;
        if (o.type === 'check_join') { const id = o.check.chat_id; o.check.chat_id = id && chats.some((c) => String(c.id) === String(id)) ? id : chats.length === 1 ? chats[0].id : null; o.check.link = ''; }
        return o;
      });
      st.kind = botTypeOfD(nd);
      st.draft = nd;
      setCode(st, ctx);
      if (b.start_code && /^[A-Za-z0-9_-]{1,64}$/.test(b.start_code) && !/^(j_|cvf_|cvt|r_|cv_)/i.test(b.start_code) && !(ctx.chatbots || []).some((x) => String(x.start_code).toLowerCase() === String(b.start_code).toLowerCase() && (!nd.bot_id || String(x.bot_id) === String(nd.bot_id)))) nd.start_code = b.start_code;
      const p = problems(nd, ctx);
      if (!p) {
        fixAllDirections(nd);
        st.undo = (st.undo || []).concat([{ draft: blankBot(st), stage: 'kind', pend: {}, focus: 0 }]).slice(-UNDO_MAX);
        st.built = true; st.focus = 0; st.bk = { chat: (nd.steps.find((x) => kindOf(x) === 'check_join') || { check: {} }).check.chat_id || undefined };
        turns.push(turn(st, 'cas', 'Here\'s your bot ✨ Have a look on the phone, and change anything you like.', { preview: true }));
        if (needsChat(nd) && !checkChatOk(nd, ctx)) turns.push(turn(st, 'cas', 'Connect the channel people should join before you switch it on 🔌'));
        st.stage = 'jb_review'; st.pend = {};
        ask(st, ctx, turns);
        return { state: st, turns };
      }
      turns.push(turn(st, 'cas', 'I had an idea, but ' + p.charAt(0).toLowerCase() + p.slice(1)));
    } else if (res && res.fallback && res.reason === 'resting') turns.push(turn(st, 'cas', 'I\'m resting until tomorrow 🌙 so I can\'t read typed words now.'));
    else turns.push(turn(st, 'cas', 'Sorry, I couldn\'t put that one together just now 🌱'));
    st.kind = ''; st.draft = { ...blankBot({ kind: 'custom', draft: st.draft }), steps: [] };
    st.stage = 'kind'; st.pend = { q: 1 };
    turns.push(turn(st, 'cas', 'Pick the closest one below, and I\'ll build it for you 🙂'));
    return { state: st, turns };
  }

  function botNextQuestion(st, ctx) {
    const d = st.draft;
    const more = canMore(st, ctx);
    const chips = [];
    let fl = st.focus != null && d.steps[st.focus] && kindOf(d.steps[st.focus]) === 'message' ? st.focus : -1;
    if (fl < 0) for (let i = d.steps.length - 1; i >= 0; i--) if (kindOf(d.steps[i]) === 'message') { fl = i; break; }
    chips.push(more ? { id: 'nx:msg', label: '➕ Add a follow-up message' } : { id: 'nx:msg', label: '➕ Add a follow-up message', lock: 'flow_steps' });
    if (fl >= 0 && (d.steps[fl].buttons || []).length < botMaxBtn(ctx)) chips.push({ id: 'nx:button', label: '🔘 Add a button' });
    chips.push({ id: 'nx:done', label: st.edit ? '✅ That\'s all' : '✅ I\'m done', pri: true });
    const lim = botStepLimit(ctx);
    const text = st.pend.q || (st.edit ? 'What would you like to change? Tap or type 🙂' : 'Anything else? Tap or type 🙂');
    return { text: !more && lim > 0 ? text + ' (Your ' + planName(ctx) + ' plan allows ' + lim + ' message' + (lim === 1 ? '' : 's') + ' per bot.)' : text, chips };
  }
  function botReadyQuestion(st, ctx) {
    const d = st.draft, P = st.pend || {};
    const chips = [];
    let text = P.q || 'Switch it on now, or try it first? 🙂';
    const bots = ctx.bots || [], chats = ctx.chats || [];
    if (st.live) { chips.push({ id: 'rd:save', label: '💾 Save my changes', act: 'save', pri: true }); text = P.q || 'It\'s live. Save your changes so people get them?'; }
    else if (!botOk(d, ctx) && bots.length > 1) { chips.push({ id: 'rd:where', label: '🤖 Pick your bot', pri: true }); text = P.q || 'Which of your Telegram bots should people open? Tap below 🙂'; }
    else if (!botOk(d, ctx)) { chips.push({ id: 'cb:connect', label: '🤖 Connect my bot', act: 'connect_bot', pri: true }, { id: 'cb:check', label: 'I\'ve connected it ✓' }); text = P.q || 'To switch it on, connect your own Telegram bot. People open it to start 🤖'; }
    else if (needsChat(d) && !checkChatOk(d, ctx) && chats.length > 1) { chips.push({ id: 'rd:where', label: '📣 Pick your channel', pri: true }); text = P.q || 'Which channel should people join first? Tap below 🙂'; }
    else if (needsChat(d) && !checkChatOk(d, ctx)) { chips.push({ id: 'cc:connect', label: '🔌 Connect my channel', act: 'connect_channel', pri: true }, { id: 'cc:check', label: 'I\'ve connected it ✓' }); text = P.q || 'To switch it on, connect the channel people should join 🔌'; }
    else chips.push({ id: 'rd:on', label: '🚀 Switch it on', act: 'switch', pri: true });
    if (botOk(d, ctx)) chips.push({ id: 'rd:test', label: '📲 Send me a test on Telegram', act: 'test' });
    chips.push({ id: 'rd:play', label: '▶ See it play', act: 'play' });
    chips.push({ id: 'rd:edit', label: '✏️ Change something' });
    if (!st.live) chips.push({ id: 'rd:draft', label: '💾 Keep it as a draft', act: 'draft' });
    return { text, chips };
  }
  function botSwitchQuestion(st, ctx) {
    const d = st.draft;
    if (!botOk(d, ctx)) return { text: 'To switch it on, connect your own Telegram bot. People open it to start 🤖', chips: [{ id: 'cb:connect', label: '🤖 Connect my bot', act: 'connect_bot', pri: true }, { id: 'cb:check', label: 'I\'ve connected it ✓' }, { id: 'sw:draft', label: '💾 Keep it as a draft', act: 'draft' }] };
    if (needsChat(d) && !checkChatOk(d, ctx)) return { text: 'To switch it on, connect the channel people should join 🔌', chips: [{ id: 'cc:connect', label: '🔌 Connect my channel', act: 'connect_channel', pri: true }, { id: 'cc:check', label: 'I\'ve connected it ✓' }, { id: 'sw:draft', label: '💾 Keep it as a draft', act: 'draft' }] };
    if (st.pend && st.pend.clash) return { text: st.pend.q || 'Use this one?', chips: [{ id: 'sw:replace', label: '🔁 Use this one', act: 'switch_replace', pri: true }, { id: 'sw:draft', label: '💾 Keep it as a draft', act: 'draft' }] };
    if (st.live) return { text: st.pend.q || 'It\'s live. Save your changes so people get them?', chips: [{ id: 'sw:save', label: '💾 Save my changes', act: 'save', pri: true }, { id: 'sw:builder', label: '🛠 Open in builder', act: 'builder' }] };
    return { text: st.pend.q || 'Ready to switch it on? I\'ll check everything first.', chips: [{ id: 'sw:on', label: '🚀 Switch it on', act: 'switch', pri: true }, { id: 'sw:builder', label: '🛠 Open in builder', act: 'builder' }, { id: 'sw:draft', label: '💾 Keep it as a draft', act: 'draft' }] };
  }
  function botSaved(st, r, ctx, turns) {
    const d = st.draft;
    const u = botUser(d, ctx);
    if (r.active) {
      st.live = true;
      if (r.updated) turns.push(turn(st, 'cas', 'Saved ✓ People get the new version from now on.'));
      else turns.push(turn(st, 'cas', 'You\'re live! 🎉 ' + (u ? 'Share this link in your ads and posts: t.me/' + u + '?start=' + d.start_code : 'People who open your bot with its link get it now.')));
      if (r.replaced && !r.updated) turns.push(turn(st, 'cas', 'Your other bot with that link is switched off now 💤'));
      st.stage = 'live'; st.pend = { q: 'Anything else? You can fine-tune every word in the builder.' };
    } else {
      turns.push(turn(st, 'cas', 'Saved as a draft 💾 Switch it on whenever you\'re ready.'));
      st.stage = 'live'; st.pend = { q: 'Anything else? 🙂' };
    }
    ask(st, ctx, turns);
    return { state: st, turns };
  }

  /** The AI (or a ready-made text) answered an `ai` request. */
  function aiDone(state, result, ctx) {
    const st = clone(state);
    const turns = [];
    const P = st.pend || {};
    const res = result || {};
    if (P.botreq) return botAiDone(st, res, ctx, turns);
    if (P.free) {
      const back = st.resume || { stage: 'next', pend: {} };
      st.stage = back.stage; st.pend = back.pend; st.resume = null;
      if (st.stage === 'wait_ai' || !st.stage) { st.stage = 'next'; st.pend = {}; }
      if (res.fallback) {
        turns.push(turn(st, 'cas', res.reason === 'resting' ? 'I\'m resting until tomorrow 🌙 so I can\'t read typed words now. The buttons below still work.' : 'Sorry, I couldn\'t read that one just now 🌱 Try the buttons below, or say it another way.'));
        ask(st, ctx, turns);
        return { state: st, turns };
      }
      if (res.error) { turns.push(turn(st, 'cas', 'I couldn\'t do that one: ' + res.error + ' Nothing was changed.')); ask(st, ctx, turns); return { state: st, turns }; }
      const r = applyOps(st.draft, res.ops || [], ctx);
      if (!r.ok) { turns.push(turn(st, 'cas', 'I couldn\'t do that one: ' + r.error + ' Nothing was changed 🙂')); ask(st, ctx, turns); return { state: st, turns }; }
      if (r.done.length) { snap(st); st.draft = r.draft; if (r.focus != null && st.draft.steps[r.focus]) st.focus = r.focus; }
      if (r.done.length) turns.push(turn(st, 'cas', (res.say ? res.say + '\n\n' : '') + r.done.map((x) => '✓ ' + x).join('\n'), r.focus != null && st.draft.steps[r.focus] ? { quote: { i: r.focus, body: st.draft.steps[r.focus].body }, preview: true } : {}));
      if (r.ask) { st.stage = 'ask'; st.pend = { q: r.ask.question, chips: r.ask.chips }; ask(st, ctx, turns); return { state: st, turns }; }
      // Back where we were; a review of a message that moved or went away becomes "anything else?".
      if (['review', 'own', 'btn_more', 'btn_label', 'btn_link', 'branch', 'btn_kind', 'link_late', 'offer_remind'].includes(st.stage)) {
        const idx = st.stage === 'review' || st.stage === 'own' || st.stage === 'link_late' || st.stage === 'offer_remind' ? st.pend.index : st.pend.btn ? st.pend.btn.index : st.pend.owner;
        if (idx == null || !st.draft.steps[idx] || r.done.some((x) => /^(Removed message|Moved message)/.test(x))) { goNext(st, ctx, turns); return { state: st, turns }; }
      }
      if (st.stage === 'ask' || st.stage === 'way' && st.draft.steps.length) { goNext(st, ctx, turns); return { state: st, turns }; }
      ask(st, ctx, turns);
      return { state: st, turns };
    }
    const req = P.req;
    if (!req) { st.stage = 'next'; st.pend = {}; ask(st, ctx, turns); return { state: st, turns }; }
    let text = null;
    if (!res.fallback && res.text != null) { const r = cleanText(String(res.text), textMax(ctx), 'The text'); if (!r.error) text = r.value; }
    const resting = res.fallback && res.reason === 'resting';
    if (text == null) text = fallbackText(req.role === 'message' ? 'message' : req.role, st, req);
    const note = resting ? 'I\'m resting until tomorrow 🌙 so here\'s a ready-made one. Change anything you like.' : null;
    if (req.role === 'rewrite' && req.tweak) {
      // A quick action under a message ("Shorter", "Friendlier"): change it and carry on where we were.
      const back = req.resume || { stage: 'next', pend: {} };
      st.stage = back.stage === 'wait_ai' ? 'next' : back.stage; st.pend = back.pend || {};
      if (!st.draft.steps[req.index]) { turns.push(turn(st, 'cas', 'That message isn\'t there any more 🙂')); return { state: st, turns }; }
      snap(st);
      st.draft.steps[req.index].body = text;
      st.draft.steps[req.index].body = fixDirections(st.draft, req.index) || text;
      st.focus = req.index;
      turns.push(turn(st, 'cas', note || (req.how === 'shorter' ? 'Here\'s a shorter one ✂️' : 'Here\'s a warmer one 😊'), { quote: { i: req.index, body: st.draft.steps[req.index].body }, preview: true }));
      return { state: st, turns };
    }
    if (req.role === 'rewrite') {
      snap(st);
      st.draft.steps[req.index].body = text;
      st.draft.steps[req.index].body = fixDirections(st.draft, req.index) || text;
      goReview(st, ctx, turns, req.index, req.after, note || (req.how === 'shorter' ? 'Here\'s a shorter one ✂️' : req.how === 'friendlier' ? 'Here\'s a warmer one 😊' : 'Here it is'), { owner: req.owner, skipped: req.skipped });
      return { state: st, turns };
    }
    const ins = req.insert || {};
    const i = insertNew(st, ctx, text, ins.trigger, ins.at);
    const p = problems(st.draft, ctx);
    if (p) { st.draft = st.undo.pop().draft; turns.push(turn(st, 'cas', 'Hmm, I couldn\'t add it: ' + p)); goNext(st, ctx, turns); return { state: st, turns }; }
    st.draft.steps[i].body = fixDirections(st.draft, i) || st.draft.steps[i].body; // "below" / "above" point the right way
    const after = req.after || (req.role === 'welcome' ? 'welcome_done' : req.role === 'answer' ? 'branches' : req.purpose === 'link' ? 'buttons_link' : req.purpose === 'choice' ? 'buttons_reply' : 'next');
    const intro = note || (req.role === 'welcome' ? 'Here\'s your welcome ✍️' : req.role === 'answer' ? 'Here\'s what they get when they tap *' + (req.label || 'it') + '*:' : 'Here\'s message ' + (i + 1) + ', sent ' + whenWords(st.draft, i) + ':');
    if (st.start_added) { st.start_added = false; turns.push(turn(st, 'cas', START_NOTE)); }
    goReview(st, ctx, turns, i, after, intro, { owner: req.owner, skipped: req.skipped });
    return { state: st, turns };
  }

  /**
   * Tap-to-edit (the phone preview): new words for one message, or a button's text and link, with no AI.
   *   input { message, text } | { message, button, label, url? } | { start: true, label }
   * Checked like everything else (code, hidden characters, lengths, links); undoable. → { state, turns, error? }
   */
  function edit(state, input, ctx) {
    const st = clone(state);
    const turns = [];
    const inp = input && typeof input === 'object' ? input : {};
    const n = Number(inp.message);
    let ops, say;
    if (inp.start) {
      if (!startOnOf(st.draft)) return { state: st, turns, error: 'The welcome has no Start button yet.' };
      ops = [{ op: 'set_start_button', on: true, label: inp.label }];
      say = 'Updated the Start button ✓';
    } else if (inp.button != null) {
      ops = [{ op: 'update_button', message: n, button: String(inp.button), ...(inp.label != null ? { label: inp.label } : {}), ...(inp.url != null ? { url: inp.url } : {}) }];
    } else {
      ops = [{ op: 'update_message', message: n, text: inp.text }];
      say = 'Updated message ' + n + ' ✓';
    }
    if (st.stage === 'wait_ai') return { state: st, turns, error: 'One moment, Cas is still writing.' };
    const r = applyOps(st.draft, ops, ctx);
    if (!r.ok) return { state: st, turns, error: r.error };
    if (JSON.stringify(r.draft) === JSON.stringify(st.draft)) return { state: st, turns, same: true };
    snap(st);
    st.draft = r.draft;
    if (r.focus != null && st.draft.steps[r.focus]) st.focus = r.focus;
    if (!say) say = 'Updated the button “' + findButtonIn(st.draft, n - 1, String(inp.button)) + '” ✓';
    turns.push(turn(st, 'cas', say, { preview: true }));
    return { state: st, turns };
  }
  function findButtonIn(d, i, id) { const s = d.steps[i]; const b = s ? resolveButton({ steps: [s] }, id, null) : null; return b ? b.label : 'button'; }
  /**
   * The quick actions under a message in the chat: input { message, how: 'shorter' | 'friendlier' | 'emoji' }.
   * "emoji" needs no AI; the others ask for a rewrite (the `ai` field, answered with aiDone) and come back here.
   */
  function tweak(state, input, ctx) {
    const st = clone(state);
    const turns = [];
    const inp = input || {};
    const i = Number(inp.message) - 1;
    if (st.stage === 'wait_ai') return { state: st, turns, error: 'One moment, Cas is still writing.' };
    if (!Number.isInteger(i) || !st.draft.steps[i]) return { state: st, turns, error: 'That message isn\'t there any more.' };
    if (inp.how === 'emoji') {
      const r = applyOps(st.draft, [{ op: 'update_message', message: i + 1, text: addEmoji(st.draft.steps[i].body) }], ctx);
      if (!r.ok) return { state: st, turns, error: r.error };
      snap(st); st.draft = r.draft; st.focus = i;
      turns.push(turn(st, 'cas', 'Added an emoji ✨', { quote: { i, body: st.draft.steps[i].body }, preview: true }));
      return { state: st, turns };
    }
    if (!['shorter', 'friendlier'].includes(inp.how)) return { state: st, turns, error: 'I can make it shorter or friendlier, or add an emoji.' };
    const resume = { stage: st.stage, pend: clone(st.pend || {}) };
    const ai = wantWrite(st, { role: 'rewrite', how: inp.how, index: i, tweak: true, resume });
    return { state: st, turns, ai };
  }

  function undo(state, ctx) {
    const st = clone(state);
    const turns = [];
    const u = (st.undo || []).pop();
    if (!u) { turns.push(turn(st, 'cas', 'There\'s nothing to undo yet 🙂')); ask(st, ctx, turns); return { state: st, turns }; }
    st.draft = u.draft; st.stage = u.stage === 'wait_ai' ? 'next' : LEGACY[u.stage] || u.stage; st.pend = u.pend || {}; st.focus = u.focus;
    if (!st.draft.steps.length) { st.stage = isBotD(st.draft) ? (BOT_TEXT_STAGES.includes(st.stage) ? st.stage : 'kind') : 'way'; if (st.stage === 'way' || st.stage === 'kind') st.pend = {}; st.built = false; }
    else if (st.stage === 'review' && !st.draft.steps[st.pend.index]) { st.stage = 'next'; st.pend = {}; }
    if (st.focus == null || !st.draft.steps[st.focus]) st.focus = lastMessage(st.draft);
    turns.push(turn(st, 'cas', 'Undone ↩ It\'s back the way it was.'));
    if (st.stage === 'review') turns.push(turn(st, 'cas', 'Like this? 👍', { quote: { i: st.pend.index, body: st.draft.steps[st.pend.index].body } }));
    else ask(st, ctx, turns);
    return { state: st, turns };
  }

  function saved(state, result, ctx) {
    const st = clone(state);
    const turns = [];
    const r = result || {};
    if (isBotD(st.draft)) return botSaved(st, r, ctx, turns);
    if (r.active) {
      st.live = true;
      turns.push(turn(st, 'cas', r.updated ? 'Saved ✓ New people get the new version from now on.' : 'You\'re live! 🎉 Your bot now welcomes everyone who asks to join' + (r.chat_title ? ' *' + firstLine(r.chat_title, 40) + '*' : '') + '.'));
      if (r.replaced && !r.updated) turns.push(turn(st, 'cas', 'Your other welcome bot there is paused now 💤'));
      st.stage = 'live'; st.pend = { q: 'Anything else? You can fine-tune every word in the builder.' };
    } else {
      turns.push(turn(st, 'cas', 'Saved as a draft 💾 Switch it on whenever you\'re ready.'));
      st.stage = 'live'; st.pend = { q: 'Anything else? 🙂' };
    }
    ask(st, ctx, turns);
    return { state: st, turns };
  }
  function saveFailed(state, err, ctx) {
    const st = clone(state);
    const turns = [];
    const e = err || {};
    // The server's words, made plain for a beginner.
    const m = String(e.message || 'Something went wrong.').replace(/^(The first message|The welcome message|Message \d+): (?=.*(admin|already|plan))/, '').replace(/\bthis step\b/gi, 'this part').replace(/\bsteps\b/gi, 'parts').replace(/\bstep\b/gi, 'part').replace(/\s*Then try again\.$/, '').replace(/\bjoin requests\b/gi, 'requests to join').replace(/\bjoin request\b/gi, 'request to join').replace(/\b(Welcome )?Flows\b/g, 'welcome bots').replace(/\b(welcome )?flows\b/g, 'welcome bots').replace(/\b(Welcome )?Flow\b/g, 'Welcome bot').replace(/\b(welcome )?flow\b/g, 'welcome bot');
    if (e.code === 'flow_live_clash') {
      st.stage = 'switch';
      turns.push(turn(st, 'cas', m.replace(/ Switch to this welcome bot instead\?$/, '') + ' Use this one instead? The other one is kept as a draft.'));
      st.pend = { q: 'Use this one?', clash: true };
      return { state: st, turns };
    }
    if (e.code === 'bot_live_clash') {
      st.stage = 'switch';
      turns.push(turn(st, 'cas', m + ' Use this one instead? The other one is switched off and kept.'));
      st.pend = { q: 'Use this one?', clash: true };
      return { state: st, turns };
    }
    if (e.code === 'limit_bots' || e.code === 'limit_referral_bots') {
      turns.push(turn(st, 'cas', 'Saved as a draft 💾 It\'s switched off for now. ' + m));
      st.stage = 'live'; st.pend = { q: 'Anything else? 🙂' };
      ask(st, ctx, turns);
      return { state: st, turns };
    }
    if (e.code === 'bot_not_admin' || e.code === 'bot_not_admin_check') turns.push(turn(st, 'cas', 'One more thing before it goes live 🌱 ' + m + ' Then tap "Switch it on" again.'));
    else if (e.code === 'placeholder_text') turns.push(turn(st, 'cas', 'Almost! ' + m));
    else turns.push(turn(st, 'cas', 'Hmm, that didn\'t work yet: ' + m));
    goSwitch(st, ctx, turns, 'Shall we try again?');
    return { state: st, turns };
  }

  return {
    start, reply, aiDone, checkDone, undo, edit, tweak, saved, saveFailed, view, question, applyOps, problems, graph, trigOf, toBody, fromFlow, withRows,
    isBotD, botTypeOfD, botMsgs, guessKind, questionFrom, KINDS, KIND_ORDER, MENU_PRESETS, QUESTIONS, TXT,
    directionIssues, fixDirections, fixAllDirections,
    cleanText, cleanLabel, cleanUrl, parseDuration, waitText, whenWords, fallbackText, reminderText, addEmoji, remindTargets,
    OP_NAMES, OPS, PURPOSES, GOALS, TEXT_STAGES, QUICK, TURNS_MAX,
  };
});

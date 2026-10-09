'use strict';
/*
 * app-flows.js: "Welcome Flows" — what your bot does when someone asks to join your channel or group.
 *   #app/flows              list of flows, the join-request meter, templates (empty state)
 *   #app/flows?tpl=<key>    builder for a new flow made from a template ("blank" = from scratch)
 *   #app/flows?id=<id>      builder for a saved flow (&tab=stats | requests)
 * API: GET/POST /api/flows, GET/PUT/DELETE /api/flows/:id, POST /api/flows/:id/toggle | duplicate | invite-link,
 *      GET /api/flows/:id/stats, POST /api/flows/check, GET /api/flows/requests, POST /api/flows/requests/decide
 *
 * The render helpers flowCardHtml(), blocksHtml() and tgPreviewHtml() are pure (they only build HTML from data,
 * escaping everything) so test/e2e/welcome-flows.test.js can run them in a sandbox.
 */

const FL = { data: null, E: null, sel: 0, dirty: false, tab: 'build', admin: null, stats: null };
const WF_UNIT = { sec: ['second', 'seconds'], min: ['minute', 'minutes'], hour: ['hour', 'hours'], day: ['day', 'days'] };
const WF_SECS = { sec: 1, min: 60, hour: 3600, day: 86400 };
/* Telegram's 5-minute window after a join request: messages due this soon after the welcome reach everyone (services/flows.js QUICK_SECONDS). */
const WF_QUICK = 280;
const WF_MODES = [
  ['after_welcome', 'After the welcome', 'They get your message first, then they are let in.', 'Recommended', null],
  ['instant', 'Straight away', 'Let everyone in at once, even if the welcome can\'t be sent.', '', null],
  ['tap', 'When they tap a button', 'They tap "Tap to join", then Start in your bot. Stops most fake accounts.', '', 'tap_to_start'],
  ['manual', 'I decide', 'Requests wait in a list. You let people in or decline them.', '', 'welcome_flows'],
];
const WF_EMOJI = ['👉', '✅', '⭐', '🎁', '🔥', '📘', '💬', '🛍️', '📈', '🎉'];
const WF_LOCK_PLAN = { ai: 'Starter', tap_to_start: 'Starter', welcome_flows: 'Starter', ab_welcome_2: 'Growth', ab_welcome_4: 'Scale', condition_clicked: 'Growth', flow_funnel_stats: 'Growth', basic_stats: 'Starter' };

/* ---------- Small helpers ---------- */
function wfHas(k) { const p = FL.data && FL.data.plan; return !!(p && (p.features || []).includes(k)); }
function wfLimit(k) { const p = FL.data && FL.data.plan; return p && p.limits ? p.limits[k] : null; }
function wfWait(v, u) { v = Number(v) || 0; const n = WF_UNIT[u] || WF_UNIT.min; return v + ' ' + (v === 1 ? n[0] : n[1]); }
/* Seconds → [value, unit] in the biggest whole unit: 86400 → [1, 'day'], 45 → [45, 'sec']. */
function wfSplit(s) { s = Math.max(0, Math.round(Number(s) || 0)); if (!s) return [0, 'min']; if (s % 86400 === 0) return [s / 86400, 'day']; if (s % 3600 === 0) return [s / 3600, 'hour']; if (s % 60 === 0) return [s / 60, 'min']; return [s, 'sec']; }
function wfSecs(b) { return (Number(b.value) || 0) * (WF_SECS[b.unit] || 60); }
/* For each block: seconds after the welcome (waits added up). */
function wfTimes(blocks) { let t = 0; return blocks.map((b) => { if (b.type === 'wait') t += wfSecs(b); return t; }); }
/* Does the flow have later messages inside the first 5 minutes? */
function wfHasQuick(blocks) { const at = wfTimes(blocks); let n = 0; return blocks.some((b, i) => b.type === 'message' && ++n > 1 && at[i] <= WF_QUICK); }
/* The Telegram-rule box under "How people get in". */
function wfRuleHtml(E) {
  const quick = wfHasQuick(E.blocks || []);
  const how = !quick ? '' : E.approve_mode === 'tap' ? ' They are let in when they tap the button and press Start.'
    : E.approve_mode === 'manual' ? ' If you let someone in before those messages go out, the rest wait until they tap Start.'
      : ' Letting someone in closes that window, so Castvoo lets them in right after your last message in the first 5 minutes (still automatic).';
  return '<span>⏱️</span><p><b>Telegram\'s rule:</b> messages in the first 5 minutes reach everyone who asked to join. Later messages reach people who tapped <b>Start</b> in your bot.' + how + '</p>';
}
function wfLock(feature) { return '<span class="wf-lock" data-up="' + esc(feature) + '">' + icon('lock') + esc(WF_LOCK_PLAN[feature] || 'Upgrade') + '</span>'; }
/* API buttons [{label,url,row}] → rows [[{label,url}], ...]; buttons without a row get a row each. */
function wfRows(buttons) {
  const rows = []; let last = null;
  for (const b of buttons || []) {
    const r = b.row === undefined || b.row === null ? null : Number(b.row);
    if (r !== null && r === last && rows.length && rows[rows.length - 1].length < 2) rows[rows.length - 1].push({ label: b.label || '', url: b.url || '' });
    else rows.push([{ label: b.label || '', url: b.url || '' }]);
    last = r;
  }
  return rows;
}
function wfFlat(rows) { const out = []; rows.forEach((r, i) => r.forEach((b) => { if ((b.label || '').trim() || (b.url || '').trim()) out.push({ label: (b.label || '').trim(), url: typeof fixUrl === 'function' ? fixUrl(b.url) : b.url, row: i }); })); return out; }
function wfMsgCount(blocks) { return blocks.filter((b) => b.type === 'message').length; }

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

/** Telegram-style preview of one message. o: { bot, chat, body, media, buttons, startLabel, branding, first, delay } */
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
    (btnRows.length ? '<div class="wf-kb">' + btnRows.map((r) => '<div class="wf-kr">' + r.map((b) => '<span' + (b.start ? ' class="st"' : '') + '>' + esc(b.label) + (b.start ? '' : ' ↗') + '</span>').join('') + '</div>').join('') + '</div>' : '') +
    '</div><div class="tg-in"><span class="pc0">📎</span><span class="fld">Message</span><span class="sb">➤</span></div>';
}

/** The stack of blocks in the builder. o: { editable, sel, has(feature), stats } */
function blocksHtml(blocks, o = {}) {
  const has = o.has || (() => true);
  const dis = o.editable ? '' : ' disabled';
  let pos = 0;
  const out = [];
  const at = wfTimes(blocks);
  blocks.forEach((b, i) => {
    out.push(addHtml(i, o));
    if (b.type === 'wait') {
      out.push('<div class="wf-blk wait" data-i="' + i + '"' + (o.editable ? ' draggable="true"' : '') + '><span class="wf-hd" aria-hidden="true">⋮⋮</span><span class="wf-wi">⏳</span><b>Wait</b>' +
        '<input class="wf-num" type="number" min="0" max="999" inputmode="numeric" value="' + (Number(b.value) || 0) + '" data-wv="' + i + '" aria-label="How long to wait"' + dis + '>' +
        '<select class="wf-unit" data-wu="' + i + '" aria-label="Unit"' + dis + '>' + wfUnitOptions(b.value, b.unit) + '</select>' +
        '<span class="muted wf-wt">' + (Number(b.value) ? 'before the next message' : 'the next message goes right away') + '</span>' +
        (o.editable ? '<button type="button" class="wf-now' + (Number(b.value) ? '' : ' on') + '" data-wnow="' + i + '">⚡ Send right away</button>' : '') + (o.editable ? blkTools(i, blocks.length, false, true) : '') + '</div>');
      return;
    }
    pos++;
    const first = pos === 1;
    const quick = !first && at[i] <= WF_QUICK;
    const vs = b.variants || [];
    const vi = Math.min(b.vsel || 0, vs.length);
    const cur = vi === 0 ? b : vs[vi - 1];
    const st = o.stats && o.stats[pos - 1];
    out.push('<div class="wf-blk msg' + (o.sel === i ? ' sel' : '') + '" data-i="' + i + '"' + (o.editable ? ' draggable="true"' : '') + '>' +
      '<div class="wf-bh"><span class="wf-hd" aria-hidden="true">⋮⋮</span><span class="wf-no">' + pos + '</span><b>' + (first ? 'Welcome message' : 'Message ' + pos) + '</b>' +
      (first ? '<span class="pill p-blue">Sent at once</span>' : quick ? '<span class="pill p-blue" title="Telegram lets your bot message people for 5 minutes after they ask to join">Reaches everyone · first 5 min</span>' : '<span class="pill p-grey">Reaches people who tapped Start</span>') + (o.editable ? blkTools(i, blocks.length, first) : '') + '</div>' +
      (first ? '<div class="wf-ab">' + (vs.length ? ['A'].concat(vs.map((_, k) => String.fromCharCode(66 + k))).map((l, k) => '<button type="button" class="' + (k === vi ? 'on' : '') + '" data-vt="' + i + ':' + k + '">Version ' + l + '</button>').join('') : '') +
        (o.editable ? (vs.length < 3 ? '<button type="button" class="add" data-vadd="' + i + '">' + icon('plus') + (vs.length ? 'Add a version' : 'A/B test the welcome') + (has(vs.length ? 'ab_welcome_4' : 'ab_welcome_2') ? '' : wfLock(vs.length ? 'ab_welcome_4' : 'ab_welcome_2')) + '</button>' : '') + (vs.length && vi > 0 ? '<button type="button" class="add" data-vdel="' + i + ':' + vi + '">' + icon('trash') + 'Remove this version</button>' : '') : '') + '</div>' : '') +
      (!first ? '<label class="wf-cond"><span>Who gets it</span><select data-cond="' + i + '"' + dis + '><option value="">' + (quick ? 'Everyone' : 'Everyone who tapped Start') + '</option><option value="clicked"' + (b.condition === 'clicked' ? ' selected' : '') + '>Only people who clicked a button before</option><option value="not_clicked"' + (b.condition === 'not_clicked' ? ' selected' : '') + '>Only people who did not click</option></select>' + (has('condition_clicked') ? '' : wfLock('condition_clicked')) + '</label>' : '') +
      (cur.media ? '<div class="nmed">' + (typeof mediaThumb === 'function' ? mediaThumb(cur.media) : '') + (o.editable ? '<button type="button" class="x" data-mx="' + i + '" aria-label="Remove photo or video">×</button>' : '') + '</div>' : '') +
      '<textarea class="inp wf-ta" rows="4" data-body="' + i + '" placeholder="Write your message… Use {name} for their first name."' + dis + '>' + esc(cur.body || '') + '</textarea>' +
      '<div class="cc" data-cc="' + i + '"></div>' +
      '<div class="wf-btns" data-btns="' + i + '">' + wfRows(cur.buttons || []).map((r, ri) => '<div class="wf-brow">' + r.map((bt, bi) => '<div class="wf-bed"><button type="button" class="wf-emo" data-emo="' + i + ':' + ri + ':' + bi + '" aria-label="Add an emoji"' + dis + '>😊</button><input class="inp" data-bl="' + ri + ':' + bi + '" value="' + esc(bt.label) + '" maxlength="40" placeholder="Button text" aria-label="Button text"' + dis + '><input class="inp" data-bu="' + ri + ':' + bi + '" value="' + esc(bt.url) + '" placeholder="https://your-link.com" inputmode="url" aria-label="Button link"' + dis + '>' + (o.editable ? '<button type="button" class="x" data-bx="' + i + ':' + ri + ':' + bi + '" aria-label="Remove button">×</button>' : '') + '</div>').join('') +
        (o.editable && r.length < 2 ? '<button type="button" class="wf-bside" data-bside="' + i + ':' + ri + '">' + icon('plus') + 'Button next to it</button>' : '') + '</div>').join('') + '</div>' +
      (o.editable ? '<div class="nacts"><button type="button" class="addm" data-ma="' + i + '">📎 ' + (cur.media ? 'Replace' : 'Add') + (o.photoOnly ? ' photo' : ' photo or video') + '</button><button type="button" class="addm" data-ba="' + i + '">🔘 Add a button</button><button type="button" class="addm" data-nm="' + i + '">👤 Their name</button>' + (o.ai ? '<button type="button" class="addm aiw" data-aiw="' + i + '">✨ Write it with Cas' + (has('ai') ? '' : ' ' + wfLock('ai')) + '</button>' : '') + '</div><div class="nup" data-upl="' + i + '"></div>' : '') +
      (st ? '<div class="stats"><span>📨 ' + fmt(st.delivered) + ' delivered</span><span>🔘 ' + fmt(st.clicks) + ' clicks</span>' + (st.waiting_start ? '<span>⏳ ' + fmt(st.waiting_start) + ' waiting for Start</span>' : '') + '</div>' : '') +
      '</div>');
  });
  out.push(addHtml(blocks.length, o, true));
  return out.join('');
}
function addHtml(i, o, last) {
  if (!o.editable || i === 0) return i === 0 ? '' : '<div class="wf-line"></div>';
  return '<div class="wf-add' + (last ? ' last' : '') + '"><button type="button" class="wf-plus" data-add="' + i + '" aria-label="Add a step here">' + icon('plus') + (last ? '<span>Add step</span>' : '') + '</button></div>';
}
/* Waits have no Duplicate: two waits in a row are one longer wait, so a copy would only be merged on save. */
function blkTools(i, n, first, wait) {
  return '<span class="wf-tools">' + (first ? '' : '<button type="button" data-up2="' + i + '" aria-label="Move up"' + (i <= 1 ? ' disabled' : '') + '>' + icon('up') + '</button><button type="button" data-dn="' + i + '" aria-label="Move down"' + (i >= n - 1 ? ' disabled' : '') + '>' + icon('down') + '</button>') +
    (wait ? '' : '<button type="button" data-dup="' + i + '" aria-label="Duplicate">' + icon('copy') + '</button>') + (first ? '' : '<button type="button" data-del="' + i + '" aria-label="Delete">' + icon('trash') + '</button>') + '</span>';
}
/* "1 hour", "2 hours": the unit names follow the number. */
function wfUnitOptions(value, unit) { const one = Number(value) === 1; return Object.keys(WF_UNIT).map((u) => '<option value="' + u + '"' + (unit === u ? ' selected' : '') + '>' + WF_UNIT[u][one ? 0 : 1] + '</option>').join(''); }
/* Two waits next to each other (after a move or a delete) are joined into one, the same way saving does. Returns the merged waits' text, or ''. */
function wfMergeWaits(blocks) {
  const said = [];
  for (let k = blocks.length - 1; k > 0; k--) {
    const a = blocks[k - 1], b = blocks[k];
    if (a.type !== 'wait' || b.type !== 'wait') continue;
    const [v, u] = wfSplit(wfSecs(a) + wfSecs(b));
    blocks.splice(k - 1, 2, { type: 'wait', value: v, unit: u });
    said.push(wfWait(v, u));
  }
  return said.join(', ');
}
/* Words left over from a template, like "(Write one useful tip for your audience here.)", or Cas's [ADD DETAIL]. */
function wfPlaceholder(body) {
  const t = String(body || '');
  const m = t.match(/\((?:write|tell|add|put|replace|describe)\b[^)]*\bhere\b[^)]*\)/i) || t.match(/\[ADD[^\]]*\]/i);
  return m ? m[0] : '';
}

/* ---------- Page ---------- */
PAGES.flows = {
  title: 'Welcome Flows', sub: 'Welcome, let in and follow up everyone who asks to join',
  async render(el, q, alive) {
    el.innerHTML = skel(1, 120) + '<div class="wf-grid">' + skel(3, 170) + '</div>';
    if (CFG.features.welcome_flows === false || CFG.features.join_welcome === false) { el.innerHTML = emptyBox({ cas: 'think', title: 'Welcome Flows are switched off for a moment', text: 'The Castvoo team has paused them. Please check back soon.' }); return; }
    FL.data = await GET('/api/flows');
    if (!alive()) return;
    if (q.id) return wfOpen(el, +q.id, q.tab || 'build', alive);
    if (q.tpl) { FL.E = wfNew(q.tpl); FL.dirty = false; FL.sel = 0; FL.tab = 'build'; return wfBuilder(el, alive); }
    wfList(el, q, alive);
    if (q.new === '1' && canSend()) { history.replaceState(null, '', '#app/flows'); wfPickTemplate(); }
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

function wfTemplatesHtml(d) {
  return '<div class="wf-tpls">' + d.templates.map((t) => {
    const msgs = t.blocks.filter((b) => b.type === 'message').length;
    const locked = (msgs > 1 && (wfLimit('flow_steps') === 1)) || ((t.approve_mode === 'tap' || t.start_button) && !wfHas('tap_to_start'));
    return '<button type="button" class="wf-tpl" data-tpl="' + esc(t.key) + '"><span class="wf-te">' + esc(t.emoji) + '</span><b>' + esc(t.name) + '</b><small>' + esc(t.about) + '</small><span class="wf-tm">' + plural(msgs, 'message') + (locked ? ' · ' + wfLock(msgs > 1 ? 'welcome_flows' : 'tap_to_start') : '') + '</span></button>';
  }).join('') + '<button type="button" class="wf-tpl blank" data-tpl="blank"><span class="wf-te">✏️</span><b>Start from scratch</b><small>An empty welcome message.</small></button></div>';
}

function wfList(el, q, alive) {
  const d = FL.data;
  const plan = d.plan;
  const flows = d.flows;
  const branding = plan.branding ? '<div class="pban info"><span class="pbi">⚡</span><div style="flex:1;min-width:0"><b>Your welcome ends with "' + esc(d.branding_text) + '"</b><p>That is how the Free plan stays free. Remove it, and add follow-ups, from ' + esc((plan.plans || []).find((p) => p.code === 'starter') ? 'Starter' : 'a paid plan') + '.</p></div><button type="button" class="btn b-blue xs" data-up="branding">Remove it</button></div>' : '';
  const waiting = d.pending ? '<div class="pban warn"><span class="pbi">🙋</span><div style="flex:1;min-width:0"><b>' + plural(d.pending, 'person is', 'people are') + ' waiting to be let in</b><p>Open the flow and use Requests to let them in or decline.</p></div>' + (flows.find((f) => f.pending) ? '<button type="button" class="btn b-blue xs" data-open="' + flows.find((f) => f.pending).id + '" data-tab="requests">See requests</button>' : '') + '</div>' : '';
  if (!flows.length) {
    el.innerHTML = '<div class="wf-hero"><div class="wf-hl"><span class="kick">Welcome Flows</span><h2>Greet everyone who asks to join.</h2><p>Your bot welcomes each person the moment they ask to join your channel, lets them in, and can follow up later.</p>' +
      '<div class="wf-ha"><button type="button" class="btn b-blue" data-new>' + icon('plus') + 'Create your first welcome flow</button></div></div><div class="wf-hp"><div class="phone2 wf-mini"><div class="scr">' + tgPreviewHtml({ bot: 'yourbot', chat: 'your channel', body: 'Hi {name} 👋\n\nThanks for asking to join. You are in!', buttons: [{ label: '⭐ VIP group', url: '#', row: 0 }, { label: '🛍️ Shop', url: '#', row: 0 }], first: true, branding: plan.branding }) + '</div></div><span class="wf-ex">Example</span></div></div>' +
      (d.chats.length && d.bots.length ? '' : wfSetupHtml(d)) +
      helperCard('fl') +
      '<div class="box"><div class="bh"><h3>' + icon('spark') + 'Start from a template</h3><span class="hint">Pick one, change the words, switch it on.</span></div>' + wfTemplatesHtml(d) + '</div>' + wfMeterHtml(d.meter, plan) + branding;
  } else {
    el.innerHTML = '<div class="wf-top"><div class="wf-topl">' + wfMeterHtml(d.meter, plan) + '</div><div class="wf-topr box"><small class="muted">Your flows</small><b class="tnum">' + fmt(flows.length) + (plan.limits.flows >= 0 ? ' <span>/ ' + fmt(plan.limits.flows) + '</span>' : '') + '</b><p class="muted">' + plural(flows.filter((f) => f.active).length, 'live flow') + '. One flow can be live per channel; the others wait as drafts.</p>' +
      (canSend() ? '<button type="button" class="btn b-blue sm" data-new>' + icon('plus') + 'New flow</button>' : '') + '</div></div>' + waiting + branding +
      '<div class="wf-grid">' + flows.map(flowCardHtml).join('') + '</div>' +
      (d.chats.length && d.bots.length ? '' : wfSetupHtml(d));
  }
  el.onclick = (e) => {
    const t = e.target;
    const up = t.closest('[data-up]'); if (up) { e.preventDefault(); e.stopPropagation(); wfUpgrade(up.dataset.up); return; }
    const op = t.closest('[data-open]'); if (op) { appGo('flows', { id: op.dataset.open, ...(op.dataset.tab ? { tab: op.dataset.tab } : {}) }); return; }
    if (t.closest('[data-new]')) { wfPickTemplate(); return; }
    const tp = t.closest('[data-tpl]'); if (tp) { wfStartTemplate(tp.dataset.tpl); }
  };
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

/** A new, unsaved flow from a template key ("blank" = empty welcome). */
function wfNew(key) {
  const d = FL.data;
  const t = d.templates.find((x) => x.key === key);
  const chat = d.chats[0], bot = d.bots[0];
  const base = { id: null, name: t ? t.name : 'My welcome flow', chat_id: chat ? chat.id : '', bot_id: bot ? bot.id : '', approve_mode: t ? t.approve_mode : 'after_welcome', start_button: !!(t && t.start_button), start_label: (t && t.start_label) || '', invite_link: '', active: false, blocks: [] };
  const blocks = t ? t.blocks : [{ type: 'message', body: 'Hi {name} 👋 Welcome!' }];
  base.blocks = blocks.map((b) => (b.type === 'wait' ? { type: 'wait', value: b.value, unit: b.unit } : { type: 'message', body: b.body || '', media: null, buttons: (b.buttons || []).map((x) => ({ ...x })), condition: null, variants: [], vsel: 0 }));
  // On a plan that can't run it all, keep what fits and say so in the builder.
  if (!wfHas('tap_to_start')) { if (base.approve_mode === 'tap') base.approve_mode = 'after_welcome'; base.start_button = false; }
  if (wfLimit('flow_steps') === 1 && wfMsgCount(base.blocks) > 1) { base.blocks = [base.blocks[0]]; base.trimmed = true; }
  return base;
}

function wfFromApi(f) {
  const blocks = f.blocks.map((b) => (b.type === 'wait' ? { type: 'wait', value: b.value, unit: b.unit } : {
    type: 'message', id: b.id, body: b.body, media: b.media_id ? { id: b.media_id, kind: b.media_kind || 'photo' } : null, buttons: b.buttons || [], condition: b.condition || null, vsel: 0,
    variants: (b.variants || []).map((v) => ({ id: v.id, body: v.body, media: v.media_id ? { id: v.media_id, kind: v.media_kind || 'photo' } : null, buttons: v.buttons || [] })),
  }));
  return { id: f.id, name: f.name, chat_id: f.chat_id || '', bot_id: f.bot_id, approve_mode: f.approve_mode, start_button: f.start_button, start_label: f.start_label || '', invite_link: f.invite_link || '', active: f.active, paused_by_plan: f.paused_by_plan, blocks };
}

async function wfOpen(el, id, tab, alive) {
  const r = await GET('/api/flows/' + id);
  if (!alive()) return;
  FL.E = wfFromApi(r.flow); FL.dirty = false; FL.sel = 0; FL.tab = ['build', 'stats', 'requests'].includes(tab) ? tab : 'build'; FL.stats = null;
  wfBuilder(el, alive);
}

/* ---------- Builder ---------- */
function wfBody(E) {
  return {
    name: E.name.trim(), chat_id: +E.chat_id || null, bot_id: +E.bot_id || null, approve_mode: E.approve_mode, start_button: E.approve_mode === 'tap' || E.start_button,
    start_label: E.start_label, invite_link: E.invite_link || null,
    blocks: E.blocks.map((b) => (b.type === 'wait' ? { type: 'wait', value: Number(b.value) || 0, unit: b.unit } : {
      type: 'message', id: b.id || null, body: b.body, media_id: b.media ? b.media.id : null, buttons: wfFlat(wfRows(b.buttons)), condition: b.condition || null,
      variants: (b.variants || []).map((v) => ({ id: v.id || null, body: v.body, media_id: v.media ? v.media.id : null, buttons: wfFlat(wfRows(v.buttons)) })),
    })),
  };
}
function wfCheck(E) {
  if (!E.name.trim()) return 'Give this flow a name.';
  if (!E.chat_id) return 'Pick the channel or group people ask to join.';
  if (!E.bot_id) return 'Pick the bot that sends the welcome.';
  if (!E.blocks.length || E.blocks[0].type !== 'message') return 'A flow starts with a message. Telegram allows the welcome only in the first 5 minutes.';
  if (E.blocks[E.blocks.length - 1].type === 'wait') return 'The last wait has no message after it. Add a message or remove the wait.';
  let total = 0;
  for (const b of E.blocks) {
    if (b.type !== 'wait') continue;
    const v = Number(b.value);
    if (!Number.isInteger(v) || v < 0 || v > 999) return 'A wait can be 0 to 999 ' + (WF_UNIT[b.unit] || WF_UNIT.min)[1] + '.';
    total += wfSecs(b);
  }
  if (total > 365 * 86400) return 'Waits can add up to 365 days at most.';
  let n = 0;
  for (const b of E.blocks) {
    if (b.type !== 'message') continue;
    n++;
    for (const [k, m] of [b].concat(b.variants || []).entries()) {
      const what = (n === 1 ? 'The welcome' : 'Message ' + n) + ((b.variants || []).length ? ' (version ' + String.fromCharCode(65 + k) + ')' : '');
      if (!(m.body || '').trim()) return what + ' is empty.';
      const ph = wfPlaceholder(m.body);
      if (ph) return what + ' still has example text: "' + ph + '". Write your own words there before saving.';
      const lim = (m.media ? 1024 : 4096) - (FL.data.plan.branding ? 34 : 0);
      if (visibleLength(m.body) > lim) return what + ' is too long for Telegram (' + fmt(lim) + ' characters).';
      const bad = typeof checkButtons === 'function' ? checkButtons(wfFlat(wfRows(m.buttons))) : '';
      if (bad) return what + ': ' + bad;
    }
  }
  return '';
}

function wfBuilder(el, alive) {
  const E = FL.E, d = FL.data;
  const editable = canSend();
  const plan = d.plan;
  const tabs = [['build', 'Build'], ['stats', 'Stats'], ['requests', 'Requests']];
  el.innerHTML = '<div class="wf-b">' +
    '<div class="wf-bhd"><button type="button" class="ib wf-back" data-back aria-label="Back to all flows">' + icon('chev') + '</button>' +
    '<input class="inp ttlin wf-name" id="wfName" value="' + esc(E.name) + '" maxlength="60" aria-label="Flow name"' + (editable ? '' : ' disabled') + '>' +
    '<div class="wf-live">' + (E.id ? '<span class="muted" id="wfLiveL">' + (E.active ? 'Live' : 'Draft') + '</span>' + toggleBtn('wfLive', E.active, 'Switch this flow on or off') : '<span class="pill p-warn">Not saved</span>') + '</div></div>' +
    (E.id ? '<div class="seg2 wf-tabs" role="tablist">' + tabs.map((t) => '<button type="button" role="tab" data-tab="' + t[0] + '" class="' + (FL.tab === t[0] ? 'on' : '') + '">' + t[1] + '</button>').join('') + '</div>' : '') +
    '<div id="wfPane"></div></div>';
  const pane = $('#wfPane', el);
  const drawPane = () => {
    $$('.wf-tabs [data-tab]', el).forEach((b) => b.classList.toggle('on', b.dataset.tab === FL.tab));
    if (FL.tab === 'stats') return wfStats(pane, alive);
    if (FL.tab === 'requests') return wfRequests(pane, alive);
    return wfBuild(pane, alive, editable);
  };
  drawPane();
  $('#wfName', el).oninput = (e) => { E.name = e.target.value; FL.dirty = true; };
  el.onclick = async (e) => {
    const t = e.target;
    if (t.closest('[data-back]')) { if (FL.dirty && !(await confirmBox('Leave without saving?', 'Your changes to this flow will be lost.', 'Leave'))) return; FL.dirty = false; appGo('flows'); return; }
    const tb = t.closest('.wf-tabs [data-tab]'); if (tb) { FL.tab = tb.dataset.tab; drawPane(); return; }
    const up = t.closest('[data-up]'); if (up && !t.closest('select')) { e.preventDefault(); e.stopPropagation(); wfUpgrade(up.dataset.up); return; }
    const lv = t.closest('#wfLive'); if (lv) { wfToggle(lv, el, alive); }
  };
  void plan;
}

async function wfToggle(btn, el, alive, replace) {
  const E = FL.E;
  if (!canSend()) return;
  if (FL.dirty && !E.active) { toast('Save your changes first, then switch it on.', { kind: 'info' }); return; }
  const on = !E.active;
  btn.disabled = true;
  try {
    const r = await POST('/api/flows/' + E.id + '/toggle', { active: on, replace: replace || undefined });
    E.active = r.active; setToggle(btn, E.active); $('#wfLiveL').textContent = E.active ? 'Live' : 'Draft';
    toast(E.active ? 'Live. Your bot now welcomes everyone who asks to join.' + (r.replaced ? ' The other flow on this channel is a draft now.' : '') : 'Switched off. It is kept as a draft.');
    if (E.active) confetti();
    refreshState();
  } catch (ex) {
    if (ex.code === 'flow_live_clash' && on && !replace) {
      btn.disabled = false;
      if (await confirmBox('Switch to this flow?', esc(ex.message) + ' The other flow becomes a draft. Nothing is deleted.', 'Use this flow')) return wfToggle(btn, el, alive, true);
      return;
    }
    if (ex.code === 'bot_not_admin') { FL.admin = { ok: false, message: ex.message }; wfAdminBox(); toast(ex.message, { kind: 'err' }); }
    else wfErr(ex);
  } finally { btn.disabled = false; }
}

function wfErr(ex) {
  if (['plan_feature', 'limit_flows', 'limit_flow_steps'].includes(ex.code)) { wfUpgrade(ex.code === 'plan_feature' ? ((ex.data && ex.data.feature) || 'welcome_flows') : ex.code === 'limit_flows' ? 'flows' : 'welcome_flows', ex.message); return; }
  apiErr(ex);
}

function wfBuild(pane, alive, editable) {
  const E = FL.E, d = FL.data, plan = d.plan;
  const chat = d.chats.find((c) => String(c.id) === String(E.chat_id));
  const bot = d.bots.find((b) => String(b.id) === String(E.bot_id));
  const startOn = E.approve_mode === 'tap' || E.start_button;
  const dis = editable ? '' : ' disabled';
  pane.innerHTML = '<div class="wf-cols"><div class="wf-main">' +
    (E.trimmed ? '<div class="note2 warn"><span>ℹ️</span><span>This template has follow-up messages. Your ' + esc(plan.name) + ' plan sends the welcome only, so we kept the first message. <button type="button" class="lnk" data-up="welcome_flows">See plans with follow-ups</button></span></div>' : '') +
    (E.paused_by_plan ? '<div class="note2 warn"><span>⏸️</span><span>This flow was switched off when your plan changed. Switch it on again when you are ready (your plan runs ' + plural(plan.limits.flows < 0 ? 99 : plan.limits.flows, 'live flow') + ').</span></div>' : '') +
    '<section class="box wf-set"><div class="bh"><h3>' + icon('tg') + 'Where and who</h3></div>' +
    '<div class="row2b"><div class="field"><label for="wfChat">Channel or group</label><select class="inp" id="wfChat"' + dis + '>' + (d.chats.length ? '' : '<option value="">Connect a channel first</option>') + d.chats.map((c) => '<option value="' + c.id + '"' + (String(c.id) === String(E.chat_id) ? ' selected' : '') + '>' + esc(c.title || c.username || 'Untitled') + '</option>').join('') + '</select></div>' +
    '<div class="field"><label for="wfBot">Bot that sends it</label><select class="inp" id="wfBot"' + dis + '>' + (d.bots.length ? '' : '<option value="">Connect your bot first</option>') + d.bots.map((b) => '<option value="' + b.id + '"' + (String(b.id) === String(E.bot_id) ? ' selected' : '') + '>@' + esc(b.username || b.title) + '</option>').join('') + '</select></div></div>' +
    (!d.chats.length || !d.bots.length ? '<div class="row2b">' + (!d.chats.length ? '<button type="button" class="btn b-ghost sm" data-connect="channel">' + icon('plus') + 'Connect a channel</button>' : '') + (!d.bots.length ? '<button type="button" class="btn b-ghost sm" data-connect="bot">' + icon('plus') + 'Connect your bot</button>' : '') + '</div>' : '') +
    '<div id="wfAdmin"></div>' +
    '<div class="field"><label>How people get in</label><div class="wf-modes">' + WF_MODES.map((m) => {
      const locked = m[4] && !wfHas(m[4]);
      return '<button type="button" class="wf-mode' + (E.approve_mode === m[0] ? ' on' : '') + (locked ? ' locked' : '') + '" data-mode="' + m[0] + '"' + dis + '><span class="wf-rad"></span><span><b>' + m[1] + (m[3] ? ' <span class="pill p-blue">' + m[3] + '</span>' : '') + (locked ? ' ' + wfLock(m[4]) : '') + '</b><small>' + m[2] + '</small></span></button>';
    }).join('') + '</div></div>' +
    '<div class="wf-rule" id="wfRule">' + wfRuleHtml(E) + '</div>' +
    '<div class="tg wf-sb"><span><b>"Tap to start" button</b>' + (wfHas('tap_to_start') ? '' : ' ' + wfLock('tap_to_start')) + '<br><small class="muted">' + (E.approve_mode === 'tap' ? 'Needed for "When they tap a button". It lets them in and makes them a bot subscriber.' : 'Opens your bot so people can tap Start. Then your later messages can reach them.') + '</small></span>' + toggleBtn('wfStart', startOn, '"Tap to start" button') + '</div>' +
    (startOn ? '<div class="field"><label for="wfStartL">Button text</label><input class="inp" id="wfStartL" maxlength="40" value="' + esc(E.start_label || (E.approve_mode === 'tap' ? '✅ Tap to join' : '👉 Tap Start for more')) + '"' + dis + '></div>' : '') +
    '<details class="wf-more"' + (E.invite_link ? ' open' : '') + '><summary>More options</summary><div class="field"><label for="wfLink">Only for people who use this invite link <span class="hint">(optional)</span></label><div class="slnew"><input class="inp" id="wfLink" placeholder="https://t.me/+AbC123xyz" value="' + esc(E.invite_link) + '"' + dis + '>' + (E.id && editable ? '<button type="button" class="btn b-ghost sm" id="wfMkLink">Make a link</button>' : '') + '</div><small class="hint">Give each ad its own link and its own flow. Leave empty to welcome everyone who asks to join.</small></div></details>' +
    '</section>' +
    '<section class="wf-stack" id="wfStack"></section>' +
    '<p class="ferr" id="wfErr" hidden></p>' +
    (editable ? '<div class="wf-bar"><span class="muted" id="wfDirty">' + (E.id ? 'All changes saved' : 'Not saved yet') + '</span><div class="row2b">' + (E.id ? '<button type="button" class="btn b-ghost sm" id="wfMore">' + icon('copy') + 'Duplicate</button><button type="button" class="btn b-ghost sm danger" id="wfDel">' + icon('trash') + 'Delete</button>' : '') + '<button type="button" class="btn b-blue sm" id="wfSave">' + icon('check') + (E.id ? 'Save' : 'Save as draft') + '</button></div></div>' : '<p class="hint">Your role can look at flows. Ask the workspace owner to change them.</p>') +
    '</div><aside class="wf-side"><div class="pvw"><div class="wf-pvh"><b>Preview</b><span class="hint" id="wfPvL"></span></div><div class="phone2"><div class="scr" id="wfPv"></div></div><p class="hint wf-pvn">Example: "Ada" shows where {name} goes.</p></div></aside></div>';
  void chat; void bot;
  wfDrawStack(editable);
  wfPreview();
  wfAdminCheck();
  wfWire(pane, alive, editable);
}

function wfDrawStack(editable) {
  const E = FL.E;
  const has = (k) => wfHas(k);
  const stats = FL.stats && FL.stats.steps ? FL.stats.steps : null;
  $('#wfStack').innerHTML = blocksHtml(E.blocks, { editable, sel: FL.sel, has, stats, photoOnly: FL.data.plan.branding, ai: typeof aiOn === 'function' && aiOn() });
  $$('#wfStack [data-cc]').forEach((c) => { const i = +c.dataset.cc; const b = E.blocks[i]; const cur = b.vsel ? b.variants[b.vsel - 1] : b; c.innerHTML = counterHtml(cur.body || '', !!cur.media); });
  $$('#wfStack img').forEach((im) => im.addEventListener('error', () => { const v = document.createElement('video'); v.src = im.src; v.muted = true; v.playsInline = true; im.replaceWith(v); }, { once: true }));
}

function wfPreview() {
  const E = FL.E, d = FL.data;
  const idx = E.blocks[FL.sel] && E.blocks[FL.sel].type === 'message' ? FL.sel : 0;
  const b = E.blocks[idx];
  if (!b) return;
  const cur = b.vsel ? b.variants[b.vsel - 1] : b;
  const first = idx === 0;
  let wait = 0;
  for (let k = idx - 1; k >= 0 && E.blocks[k].type === 'wait'; k--) wait += wfSecs(E.blocks[k]);
  const [wv, wu] = wfSplit(wait);
  const chat = d.chats.find((c) => String(c.id) === String(E.chat_id));
  const bot = d.bots.find((x) => String(x.id) === String(E.bot_id));
  const startOn = (E.approve_mode === 'tap' || E.start_button) && wfHas('tap_to_start');
  $('#wfPv').innerHTML = tgPreviewHtml({ bot: bot ? bot.username : '', chat: chat ? chat.title : '', body: cur.body, media: cur.media, buttons: cur.buttons, startLabel: first && startOn ? (E.start_label || (E.approve_mode === 'tap' ? '✅ Tap to join' : '👉 Tap Start for more')) : '', branding: first && d.plan.branding, first, delay: !first && wait ? wfWait(wv, wu) : '' });
  const rule = $('#wfRule'); if (rule) rule.innerHTML = wfRuleHtml(E);
  $('#wfPvL').textContent = first ? 'Welcome message' + (b.variants && b.variants.length ? ' · version ' + String.fromCharCode(65 + (b.vsel || 0)) : '') : 'Message ' + E.blocks.slice(0, idx + 1).filter((x) => x.type === 'message').length;
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

function wfMark() { FL.dirty = true; const x = $('#wfDirty'); if (x) x.textContent = 'Unsaved changes'; }

function wfWire(pane, alive, editable) {
  const E = FL.E;
  const st = $('#wfStack');
  const cur = (i) => { const b = E.blocks[i]; return b.vsel ? b.variants[b.vsel - 1] : b; };
  const redraw = () => {
    const merged = wfMergeWaits(E.blocks);
    if (merged) { if (FL.sel >= E.blocks.length || (E.blocks[FL.sel] || {}).type !== 'message') FL.sel = 0; toast('Two waits in a row were joined into one: ' + merged + '.', { kind: 'info' }); }
    wfDrawStack(editable); wfPreview();
  };
  pane.onchange = (e) => {
    const t = e.target;
    if (t.id === 'wfChat') { E.chat_id = t.value; wfMark(); wfAdminCheck(); wfPreview(); }
    if (t.id === 'wfBot') { E.bot_id = t.value; wfMark(); wfAdminCheck(); wfPreview(); }
    if (t.dataset.wu != null) { E.blocks[+t.dataset.wu].unit = t.value; wfMark(); wfDrawStack(editable); wfPreview(); }
    if (t.dataset.wv != null) { const w = E.blocks[+t.dataset.wv]; w.value = Math.min(999, Math.max(0, parseInt(t.value, 10) || 0)); wfMark(); wfDrawStack(editable); wfPreview(); }
    if (t.dataset.cond != null) {
      if (t.value && !wfHas('condition_clicked')) { t.value = ''; wfUpgrade('condition_clicked'); return; }
      E.blocks[+t.dataset.cond].condition = t.value || null; wfMark();
    }
  };
  pane.oninput = (e) => {
    const t = e.target;
    if (t.id === 'wfStartL') { E.start_label = t.value; wfMark(); wfPreview(); }
    if (t.id === 'wfLink') { E.invite_link = t.value.trim(); wfMark(); }
    if (t.dataset.wv != null) { const sel = $('[data-wu="' + t.dataset.wv + '"]', st); if (sel) sel.innerHTML = wfUnitOptions(parseInt(t.value, 10) || 0, sel.value); }
    if (t.dataset.body != null) {
      const i = +t.dataset.body; const m = cur(i); m.body = t.value; wfMark();
      const c = $('[data-cc="' + i + '"]', st); c.innerHTML = counterHtml(t.value, !!m.media); c.classList.toggle('bad', visibleLength(t.value) > (m.media ? 1024 : 4096));
      FL.sel = i; wfPreview();
    }
    const bl = t.closest('[data-btns]');
    if (bl && (t.dataset.bl != null || t.dataset.bu != null)) {
      const i = +bl.dataset.btns; const rows = wfRows(cur(i).buttons);
      const [ri, bi] = (t.dataset.bl || t.dataset.bu).split(':').map(Number);
      if (t.dataset.bl != null) rows[ri][bi].label = t.value; else rows[ri][bi].url = t.value;
      cur(i).buttons = wfFlat2(rows); wfMark(); FL.sel = i; wfPreview();
    }
  };
  pane.addEventListener('focusin', (e) => { const blk = e.target.closest('.wf-blk.msg'); if (blk && +blk.dataset.i !== FL.sel) { FL.sel = +blk.dataset.i; $$('.wf-blk.msg', st).forEach((x) => x.classList.toggle('sel', +x.dataset.i === FL.sel)); wfPreview(); } });
  pane.onclick = async (e) => {
    const t = e.target;
    if (t.closest('[data-recheck]')) { wfAdminCheck(); return; }
    const up = t.closest('[data-up]'); if (up && !t.closest('select')) { e.preventDefault(); e.stopPropagation(); wfUpgrade(up.dataset.up); return; }
    const md = t.closest('[data-mode]');
    if (md && editable) {
      const m = WF_MODES.find((x) => x[0] === md.dataset.mode);
      if (m[4] && !wfHas(m[4])) { wfUpgrade(m[4]); return; }
      // In tap mode this button is the only way in, so swap the default "Tap Start for more" text for "Tap to join" (and back).
      const lbl = (E.start_label || '').trim();
      if (m[0] === 'tap' && (!lbl || lbl === '👉 Tap Start for more')) E.start_label = '✅ Tap to join';
      else if (m[0] !== 'tap' && E.approve_mode === 'tap' && lbl === '✅ Tap to join') E.start_label = '👉 Tap Start for more';
      E.approve_mode = m[0]; wfMark(); wfBuild(pane, alive, editable); return;
    }
    const sb = t.closest('#wfStart');
    if (sb && editable) {
      if (E.approve_mode === 'tap') { toast('"When they tap a button" needs this button. Pick another way in to turn it off.', { kind: 'info' }); return; }
      if (!wfHas('tap_to_start')) { wfUpgrade('tap_to_start'); return; }
      E.start_button = !E.start_button; wfMark(); wfBuild(pane, alive, editable); return;
    }
    if (t.closest('#wfMkLink')) { wfMakeLink(t.closest('#wfMkLink')); return; }
    const blk = t.closest('.wf-blk.msg');
    if (blk && !t.closest('button,input,select,textarea') && +blk.dataset.i !== FL.sel) { FL.sel = +blk.dataset.i; $$('.wf-blk.msg', st).forEach((x) => x.classList.toggle('sel', +x.dataset.i === FL.sel)); wfPreview(); }
    if (!editable) { if (t.closest('#wfSave')) return; }
    const now = t.closest('[data-wnow]'); if (now) { const w = E.blocks[+now.dataset.wnow]; w.value = 0; w.unit = 'sec'; wfMark(); redraw(); return; }
    const add = t.closest('[data-add]'); if (add) { wfAddMenu(+add.dataset.add, add, redraw); return; }
    const u2 = t.closest('[data-up2]'); if (u2) { wfMove(+u2.dataset.up2, -1); redraw(); return; }
    const dn = t.closest('[data-dn]'); if (dn) { wfMove(+dn.dataset.dn, 1); redraw(); return; }
    const du = t.closest('[data-dup]'); if (du) {
      const i = +du.dataset.dup; const b = E.blocks[i];
      if (b.type === 'message' && !wfCanAddMessage()) return;
      const copy = JSON.parse(JSON.stringify(b)); delete copy.id; copy.condition = b.type === 'message' && i === 0 ? null : copy.condition; copy.variants = []; copy.vsel = 0; (copy.buttons || []).forEach((x) => { delete x.code; });
      E.blocks.splice(i + 1, 0, i === 0 && b.type === 'message' ? { type: 'wait', value: 1, unit: 'day' } : null, copy); E.blocks = E.blocks.filter(Boolean);
      wfMark(); redraw(); toast('Step copied.'); return;
    }
    const dl = t.closest('[data-del]'); if (dl) { const i = +dl.dataset.del; E.blocks.splice(i, 1); if (FL.sel >= E.blocks.length || (E.blocks[FL.sel] || {}).type !== 'message') FL.sel = 0; wfMark(); redraw(); return; }
    const vt = t.closest('[data-vt]'); if (vt) { const [i, k] = vt.dataset.vt.split(':').map(Number); E.blocks[i].vsel = k; FL.sel = i; redraw(); return; }
    const va = t.closest('[data-vadd]'); if (va) {
      const i = +va.dataset.vadd; const b = E.blocks[i]; const need = b.variants.length ? 'ab_welcome_4' : 'ab_welcome_2';
      if (!wfHas(need)) { wfUpgrade(need); return; }
      b.variants.push({ body: b.body, media: b.media, buttons: (b.buttons || []).map((x) => ({ label: x.label, url: x.url, row: x.row })) }); b.vsel = b.variants.length; FL.sel = i; wfMark(); redraw(); return;
    }
    const vd = t.closest('[data-vdel]'); if (vd) { const [i, k] = vd.dataset.vdel.split(':').map(Number); E.blocks[i].variants.splice(k - 1, 1); E.blocks[i].vsel = 0; wfMark(); redraw(); return; }
    const nm = t.closest('[data-nm]'); if (nm) {
      insertAtCaret($('[data-body="' + nm.dataset.nm + '"]', st), '{name}'); return;
    }
    const aw = t.closest('[data-aiw]'); if (aw) {
      const i = +aw.dataset.aiw;
      if (!wfHas('ai')) { wfUpgrade('ai'); return; }
      const first = E.blocks.findIndex((x) => x.type === 'message') === i;
      openAIWrite((text) => {
        const m = cur(i); const before = m.body; m.body = text; FL.sel = i; wfMark(); redraw();
        toast('Cas wrote it. Change anything you like.', { action: { label: 'Undo', onClick: () => { cur(i).body = before; wfMark(); redraw(); } } });
      }, !!cur(i).media, { kind: first ? 'welcome' : 'followup', placeholder: first ? 'For example: Welcome new members to my fashion channel. Tell them new drops come every Friday.' : 'For example: Day 3. Remind them about my free guide and invite them to the VIP group.' });
      return;
    }
    const ba = t.closest('[data-ba]'); if (ba) {
      const i = +ba.dataset.ba; const m = cur(i); const rows = wfRows(m.buttons);
      const total = rows.reduce((n, r) => n + r.length, 0);
      if (total >= (FL.data.plan.branding ? 3 : 6)) { if (FL.data.plan.branding) wfUpgrade('buttons'); else toast('Use 6 buttons or fewer.', { kind: 'info' }); return; }
      rows.push([{ label: '', url: '' }]); m.buttons = wfFlat2(rows); FL.sel = i; wfMark(); redraw(); const ins = $$('[data-btns="' + i + '"] [data-bl]', st); if (ins.length) ins[ins.length - 1].focus(); return;
    }
    const bs = t.closest('[data-bside]'); if (bs) {
      const [i, ri] = bs.dataset.bside.split(':').map(Number); const m = cur(i); const rows = wfRows(m.buttons);
      const total = rows.reduce((n, r) => n + r.length, 0);
      if (total >= (FL.data.plan.branding ? 3 : 6)) { if (FL.data.plan.branding) wfUpgrade('buttons'); else toast('Use 6 buttons or fewer.', { kind: 'info' }); return; }
      rows[ri].push({ label: '', url: '' }); m.buttons = wfFlat2(rows); wfMark(); redraw(); return;
    }
    const bx = t.closest('[data-bx]'); if (bx) { const [i, ri, bi] = bx.dataset.bx.split(':').map(Number); const m = cur(i); const rows = wfRows(m.buttons); rows[ri].splice(bi, 1); m.buttons = wfFlat2(rows.filter((r) => r.length)); wfMark(); redraw(); return; }
    const em = t.closest('[data-emo]'); if (em) { wfEmoji(em, (x) => { const [i, ri, bi] = em.dataset.emo.split(':').map(Number); const m = cur(i); const rows = wfRows(m.buttons); rows[ri][bi].label = (x + ' ' + rows[ri][bi].label.replace(/^\S+\s/, (s) => (/^[\p{Extended_Pictographic}☀-➿]/u.test(s) ? '' : s))).trim(); m.buttons = wfFlat2(rows); wfMark(); redraw(); }); return; }
    const mx = t.closest('[data-mx]'); if (mx) { cur(+mx.dataset.mx).media = null; wfMark(); redraw(); return; }
    const ma = t.closest('[data-ma]'); if (ma) {
      const i = +ma.dataset.ma;
      const fin = document.createElement('input'); fin.type = 'file'; fin.accept = FL.data.plan.branding ? 'image/jpeg,image/png,image/webp' : 'image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime';
      fin.onchange = async () => { const f = fin.files[0]; if (!f) return; const m = await pickAndUpload(f, $('[data-upl="' + i + '"]', st)); if (m) { cur(i).media = m; wfMark(); } redraw(); };
      fin.click(); return;
    }
    if (t.closest('#wfSave')) { wfSave(t.closest('#wfSave'), alive); return; }
    if (t.closest('#wfDel')) {
      if (!(await confirmBox('Delete "' + E.name + '"?', 'It stops at once and its numbers are removed. Links people already got keep working. This can\'t be undone.', 'Delete', true))) return;
      try { await api('DELETE', '/api/flows/' + E.id); FL.dirty = false; toast('Deleted.'); refreshState(); appGo('flows'); } catch (ex) { apiErr(ex); }
      return;
    }
    if (t.closest('#wfMore')) {
      if (FL.dirty) { toast('Save your changes first.', { kind: 'info' }); return; }
      try { const r = await POST('/api/flows/' + E.id + '/duplicate'); toast('Copied as a draft.'); appGo('flows', { id: r.id }); } catch (ex) { wfErr(ex); }
    }
  };
  // Drag to reorder (desktop). Up/down buttons do the same on phones.
  let dragFrom = null;
  st.addEventListener('dragstart', (e) => { const b = e.target.closest('.wf-blk'); if (!b || +b.dataset.i === 0) { e.preventDefault(); return; } dragFrom = +b.dataset.i; b.classList.add('drag'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(dragFrom)); } catch (_) { /* old browsers */ } });
  st.addEventListener('dragend', () => { dragFrom = null; $$('.wf-blk', st).forEach((x) => x.classList.remove('drag', 'over')); });
  st.addEventListener('dragover', (e) => { const b = e.target.closest('.wf-blk'); if (dragFrom == null || !b) return; e.preventDefault(); $$('.wf-blk', st).forEach((x) => x.classList.toggle('over', x === b)); });
  st.addEventListener('drop', (e) => {
    const b = e.target.closest('.wf-blk'); if (dragFrom == null || !b) return; e.preventDefault();
    const to = Math.max(1, +b.dataset.i);
    if (to !== dragFrom) { const [m] = E.blocks.splice(dragFrom, 1); E.blocks.splice(to, 0, m); FL.sel = 0; wfMark(); redraw(); }
  });
}
/* Rows → API-style buttons (keeps half-typed buttons while editing). */
function wfFlat2(rows) { const out = []; rows.forEach((r, i) => r.forEach((b) => out.push({ label: b.label || '', url: b.url || '', row: i }))); return out; }
function wfMove(i, dir) { const E = FL.E; const j = i + dir; if (j < 1 || j >= E.blocks.length) return; const [m] = E.blocks.splice(i, 1); E.blocks.splice(j, 0, m); FL.sel = 0; wfMark(); }
function wfCanAddMessage() {
  const lim = wfLimit('flow_steps');
  if (lim === 1 || !wfHas('welcome_flows')) { wfUpgrade('welcome_flows'); return false; }
  if (lim > 0 && wfMsgCount(FL.E.blocks) >= lim) { wfUpgrade('flow_steps'); return false; }
  return true;
}
function wfAddMenu(at, anchor, redraw) {
  const E = FL.E;
  const old = $('.wf-menu'); if (old) old.remove();
  const m = document.createElement('div');
  m.className = 'wf-menu';
  m.innerHTML = '<button type="button" data-k="message">✉️ <span><b>Message</b><small>Text, photo and buttons</small></span></button><button type="button" data-k="wait">⏳ <span><b>Wait</b><small>Pause before the next message</small></span></button>';
  anchor.parentElement.appendChild(m);
  const close = (ev) => { if (!m.contains(ev.target) && ev.target !== anchor) { m.remove(); document.removeEventListener('click', close, true); } };
  setTimeout(() => document.addEventListener('click', close, true), 0);
  m.onclick = (e) => {
    const b = e.target.closest('[data-k]'); if (!b) return;
    m.remove(); document.removeEventListener('click', close, true);
    if (b.dataset.k === 'message') {
      if (!wfCanAddMessage()) return;
      const prev = E.blocks[at - 1];
      const ins = prev && prev.type === 'wait' ? [{ type: 'message', body: '', media: null, buttons: [], condition: null, variants: [], vsel: 0 }] : [{ type: 'wait', value: 1, unit: 'day' }, { type: 'message', body: '', media: null, buttons: [], condition: null, variants: [], vsel: 0 }];
      E.blocks.splice(at, 0, ...ins); FL.sel = at + ins.length - 1;
    } else {
      if (!wfHas('welcome_flows')) { wfUpgrade('welcome_flows'); return; }
      E.blocks.splice(at, 0, { type: 'wait', value: 1, unit: 'hour' });
    }
    wfMark(); redraw();
    const ta = $('[data-body="' + FL.sel + '"]'); if (ta && b.dataset.k === 'message') ta.focus();
  };
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
  const problem = wfCheck(E);
  if (problem) { err.textContent = problem; err.hidden = false; err.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  btnBusy(btn, true, 'Saving…');
  try {
    if (E.id) {
      const r = await api('PUT', '/api/flows/' + E.id, wfBody(E));
      const keepSel = FL.sel; FL.E = wfFromApi(r.flow); FL.sel = keepSel; FL.dirty = false;
      toast('Saved.');
      wfBuild($('#wfPane'), alive, canSend());
    } else {
      const r = await POST('/api/flows', wfBody(E));
      FL.dirty = false;
      toast('Saved as a draft. Switch it on when you are ready.');
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
  if (s.locked) {
    pane.innerHTML = '<div class="box wf-locked"><div style="width:84px" data-cas="think"></div><b>Stats are on Starter and up</b><p class="muted">See how many people were welcomed, let in and clicked, step by step.</p><button type="button" class="btn b-blue sm" data-up="basic_stats">' + icon('up') + 'See plans</button></div>' + wfMeterHtml(FL.data.meter, FL.data.plan);
    paintCas(pane);
    return;
  }
  const f = s.funnel;
  const base = Math.max(1, (f || s.basic).requests);
  const bar = (label, v, hint) => '<div class="wf-fr"><span>' + label + '</span><div class="wf-ft"><i style="--w:' + Math.max(v ? 2 : 0, v / base * 100).toFixed(1) + '%"></i></div><b class="tnum">' + fmt(v) + '</b><small>' + (hint || (base ? Math.round(v / base * 100) + '%' : '')) + '</small></div>';
  const funnel = f ? '<div class="box"><div class="bh"><h3>' + icon('chart') + 'From request to click</h3><span class="hint">Everyone who asked to join through this flow</span></div><div class="wf-funnel">' +
    bar('Asked to join', f.requests, '100%') + bar('Got your welcome', f.welcomed) + bar('Tapped Start', f.started) + bar('Let in', f.approved) + bar('Clicked a button', f.clicked) + '</div>' +
    (f.no_welcome ? '<p class="wf-mw"><b>' + plural(f.no_welcome, 'person', 'people') + ' joined without your welcome</b> because the month\'s join requests ran out.</p>' : '') +
    (f.pending ? '<p class="hint">' + plural(f.pending, 'person is', 'people are') + ' still waiting to be let in.</p>' : '') + '</div>'
    : '<div class="box"><div class="bh"><h3>' + icon('chart') + 'This flow so far</h3></div><div class="wf-kpis">' + [['Asked to join', s.basic.requests], ['Welcomed', s.basic.welcomed], ['Let in', s.basic.approved]].map((k) => '<div><small>' + k[0] + '</small><b class="tnum">' + fmt(k[1]) + '</b></div>').join('') + '</div>' +
      '<div class="note2"><span>' + icon('lock') + '</span><span>The full funnel (tapped Start, clicked) and A/B results are on Growth. <button type="button" class="lnk" data-up="flow_funnel_stats">See Growth</button></span></div></div>';
  const ab = s.ab ? '<div class="box"><div class="bh"><h3>' + icon('swap') + 'A/B welcome</h3><span class="hint">People are split evenly between versions</span></div><div class="wf-ab2">' + (() => { const best = Math.max(...s.ab.map((x) => x.rate)); return s.ab.map((x) => '<div class="' + (x.rate === best && best > 0 ? 'win' : '') + '"><span class="pill ' + (x.rate === best && best > 0 ? 'p-ok' : 'p-grey') + '">Version ' + esc(x.label) + (x.rate === best && best > 0 ? ' · ahead' : '') + '</span><b class="tnum">' + x.rate + '%</b><small>clicked · ' + fmt(x.clickers) + ' of ' + fmt(x.delivered) + ' people</small><div class="prog2"><i style="width:' + Math.min(100, x.rate) + '%"></i></div></div>').join(''); })() + '</div></div>' : '';
  let pos = 0;
  const rows = s.steps.map((st) => { pos++; return '<tr>' + td('Step', '<b>' + (pos === 1 ? 'Welcome' : 'Message ' + pos) + '</b>', 'first') + td('Delivered', fmt(st.delivered)) + td('Clicks', fmt(st.clicks)) + td('People who clicked', fmt(st.clickers)) + td('Waiting for Start', fmt(st.waiting_start)) + '</tr>'; }).join('');
  pane.innerHTML = funnel + ab + '<div class="box"><div class="bh"><h3>' + icon('send') + 'Step by step</h3></div><div class="tw"><table class="tbl rsp"><thead><tr><th>Step</th><th>Delivered</th><th>Clicks</th><th>People who clicked</th><th>Waiting for Start</th></tr></thead><tbody>' + rows + '</tbody></table></div><p class="hint">Telegram does not tell bots who read a message, so Castvoo shows deliveries and clicks.</p></div>';
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
      : emptyBox({ plain: 1, emoji: '🙌', title: 'Nobody is waiting', text: 'New requests show here when a flow is set to "I decide", or when someone hasn\'t tapped the button yet.' })) + '</div>';
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
  welcome_flows: ['Add follow-up messages', 'Follow-up steps, waits and the "I decide" list are on Starter and up.'],
  flow_steps: ['Add more steps', 'Your plan has reached its messages per flow.'],
  flows: ['Make more flows', 'Your plan has reached its number of Welcome Flows.'],
  tap_to_start: ['Use the "Tap to start" button', 'The button that opens your bot (and "When they tap a button") is on Starter and up.'],
  ab_welcome_2: ['A/B test your welcome', 'Try two versions of the welcome and see which gets more clicks. On Growth and up.'],
  ab_welcome_4: ['Test up to 4 versions', 'Three or four versions of the welcome are on Scale.'],
  condition_clicked: ['Send only to clickers (or non-clickers)', 'Click conditions are on Growth and up.'],
  flow_funnel_stats: ['See the full funnel', 'Tapped Start, clicks and A/B results per flow are on Growth and up.'],
  basic_stats: ['See your flow stats', 'Stats are on Starter and up.'],
  branding: ['Remove "by Castvoo" from your welcome', 'Paid plans send your welcome without the Castvoo line.'],
  buttons: ['Add more buttons', 'The Free welcome can have 3 buttons. Paid plans allow 6.'],
  join_requests: ['Welcome more people each month', 'Bigger plans include more join requests a month.'],
  ai: ['Let Cas write your messages', 'Cas, the AI helper, writes and rewrites your messages on Starter and up.'],
};
const WF_NEEDS = { ai: 'ai', welcome_flows: 'welcome_flows', flow_steps: null, flows: null, tap_to_start: 'tap_to_start', ab_welcome_2: 'ab_welcome_2', ab_welcome_4: 'ab_welcome_4', condition_clicked: 'condition_clicked', flow_funnel_stats: 'flow_funnel_stats', basic_stats: 'basic_stats', branding: null, buttons: null, join_requests: null };
function wfUpgrade(key, message) {
  const why = WF_WHY[key] || ['Upgrade your plan', ''];
  const plan = (FL.data && FL.data.plan) || (APP.state && APP.state.plan) || {};
  if (typeof openUpgrade === 'function') openUpgrade({ title: why[0], text: message || why[1], feature: WF_NEEDS[key] || null, limit: ['flow_steps', 'flows', 'join_requests'].includes(key) ? key : null, plan });
}

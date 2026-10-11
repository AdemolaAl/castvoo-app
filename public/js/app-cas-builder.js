'use strict';
/*
 * app-cas-builder.js: Cas Builder, a chat with Cas that builds any bot: a Welcome bot (join requests) or a Chat bot
 * (join-check, free gift, menu, lead questions, invite friends; server: routes/cas-builder.js, services/cas-builder.js;
 * the conversation itself is public/js/cas-engine.js). Cas's first question is "What do you want your bot to do?".
 *   cbChooser({ kind })    "How would you like to build your bot?": 💬 Cas Builder (⭐ Recommended) or 🧩 Build it myself
 *   cbOpen({ flowId, kind }) open the chat (a new bot, the draft to resume, or an existing bot; kind skips the first question)
 * The phone preview shows Chat bots too (app-flows.js wfKeyRows draws the special parts' own buttons; a small pill under
 * them says what they do). Their own buttons ("I've joined", choices, "Share my link") are not tap-to-edit: the words
 * of the message are.
 * The panel: a full-screen sheet on phones (chat, with a collapsible live phone preview at the top) and chat left /
 * phone right on computers. Cas asks one question at a time with answers to tap; typing works any time. The phone shows
 * the whole flow as it is built (new messages pop in) and plays the builder's whole-flow movie (wfPlayHtml).
 * Uses the builder's helpers from app-flows.js: wfStep, wfKeyRows, wfArrive, wfTrig, wfTips, wfPlay*, wfTestSend, wfUpgrade.
 * Changing words without the AI: tap any message (or button) on the phone to edit it in place (cbEditMsg / cbEditBtn,
 * POST …/edit), and the quick actions under every message Cas shows in the chat (✏️ Edit · Shorter · Friendlier ·
 * Add emoji, POST …/tweak). "✍️ Type my own" chips just open the keyboard. Words that point the wrong way ("below" for
 * a button that is above) get a gentle tip with [Fix it] (CasEngine.directionIssues / fixDirections).
 */

const CB = { s: null, host: null, busy: false, pv: false, mode: 'flow', sig: [], flowId: null, from: null, vv: null, queue: Promise.resolve(), local: [], tips: new Set(), typePh: '', ed: null };
const CB_LOCK = { reply: 'welcome_flows', flow_steps: 'flow_steps' };

/* ---------- Entry: how would you like to build it? ---------- */
async function cbStatus() { try { return await GET('/api/cas-builder'); } catch (_) { return null; } }
function cbBuildsLine(st) {
  if (!st || !st.builds) return '';
  const b = st.builds;
  if (b.left === -1) return 'Unlimited on your plan';
  if (b.period === 'lifetime') return b.left > 0 ? 'Your first flow with Cas is free' : b.credits ? plural(b.credits, 'Cas credit') + ' left' : 'You\'ve used your free build';
  return (b.left > 0 ? plural(b.left, 'build') + ' left this month' : 'No builds left this month') + (b.credits ? ' · ' + plural(b.credits, 'credit') : '');
}
/* Small "▶ Watch how" links under the chooser (the guide videos, app-guides.js). Outside the cards: no button in a button. */
function cbWatchHow(on) {
  if (typeof VGUIDES === 'undefined') return '';
  const one = (id, label) => { const g = VGUIDES.find((x) => x.id === id); return g ? '<button type="button" class="cbc-vg" data-vguide="' + id + '">' + icon('play') + '<span>' + label + '</span><small>' + vgTime(g.dur) + '</small></button>' : ''; };
  return '<div class="cbc-vgs"><span>▶ Watch how:</span>' + (on ? one('cas-builder', 'With Cas') : '') + one('welcome-flow', 'Build it myself') + '</div>';
}
async function cbChooser(o = {}) {
  // (A full Welcome Flow allowance doesn't stop Cas: Cas offers the other kinds of bot and says which plan has more.)
  const st = await cbStatus();
  const on = !st || st.on !== false;
  const h = sheet('How would you like to build your bot?', '<span class="spk">' + icon('plus') + '</span>',
    '<div class="cbc">' +
    (on ? '<button type="button" class="cbc-card pri" data-cbgo><span class="cbc-tag">⭐ Recommended</span><span class="cbc-ic"><span class="cbc-av" data-cas="wave"></span></span><span class="cbc-t"><b>💬 Cas Builder</b><small>Chat with Cas: tell Cas what you want and Cas builds it for you.</small><em>' + esc(st && st.resting ? 'Cas is resting until tomorrow 🌙' : cbBuildsLine(st)) + '</em></span><span class="cbc-go">' + icon('chev') + '</span></button>' : '') +
    (on && st && st.draft ? '<button type="button" class="cbc-res" data-cbres="' + Number(st.draft.id) + '"><span>↩</span><span><b>Continue your draft with Cas</b><small>' + esc(st.draft.name || 'Your bot') + ' · ' + plural(st.draft.steps, 'message') + ' · ' + esc(ago(st.draft.updated_at)) + '</small></span>' + icon('chev') + '</button>' : '') +
    '<button type="button" class="cbc-card" data-cbself><span class="cbc-ic self">🧩</span><span class="cbc-t"><b>🧩 Build it myself</b><small>Use the builder, step by step, or start from a template.</small></span><span class="cbc-go">' + icon('chev') + '</span></button>' +
    '</div>' + cbWatchHow(on), { wide: true });
  paintCas(h);
  $('.sb', h).onclick = (e) => {
    if (e.target.closest('[data-cbgo]')) { closeModal(); cbOpen({ status: st, kind: o.kind }); return; }
    const r = e.target.closest('[data-cbres]'); if (r) { closeModal(); cbOpen({ resume: +r.dataset.cbres }); return; }
    if (e.target.closest('[data-cbself]')) { closeModal(); if (o.kind === 'welcome' || typeof wfNewBotSheet !== 'function') wfPickTemplate(); else wfNewBotSheet(); }
  };
}

/** Out of builds: the builder (free), upgrade, or Cas credits from the wallet. */
function cbOutSheet(ex) {
  const data = ex.data || {};
  const pack = data.pack;
  const h = sheet('Your Cas builds are used up', '<span class="spk">💬</span>',
    '<div class="cbo"><div class="cbo-av" data-cas="think"></div><p class="muted">' + esc(ex.message) + '</p></div>' +
    '<div class="cbc">' +
    '<button type="button" class="cbc-card" data-cbself><span class="cbc-ic self">🧩</span><span class="cbc-t"><b>Use the builder (free)</b><small>Build it step by step. Everything works the same.</small></span><span class="cbc-go">' + icon('chev') + '</span></button>' +
    (pack ? '<button type="button" class="cbc-card pri" data-cbbuy><span class="cbc-ic">💳</span><span class="cbc-t"><b>Buy Cas credits: ' + plural(pack.builds, 'build') + ' for ' + usd(pack.price) + '</b><small>Paid from your wallet. Credits never expire.</small></span><span class="cbc-go">' + icon('chev') + '</span></button>' : '') +
    '<button type="button" class="cbc-card" data-cbup><span class="cbc-ic">⬆️</span><span class="cbc-t"><b>Upgrade</b><small>Bigger plans include more builds every month.</small></span><span class="cbc-go">' + icon('chev') + '</span></button>' +
    '</div>');
  paintCas(h);
  $('.sb', h).onclick = async (e) => {
    if (e.target.closest('[data-cbself]')) { closeModal(); wfPickTemplate(); return; }
    if (e.target.closest('[data-cbup]')) { closeModal(); if (typeof openUpgrade === 'function') openUpgrade({ title: 'Build more flows with Cas', text: 'Bigger plans include more Cas Builder builds every month.', plan: (FL.data && FL.data.plan) || (APP.state && APP.state.plan) || {} }); return; }
    const b = e.target.closest('[data-cbbuy]');
    if (b) {
      btnBusy(b, true, 'Adding…');
      try {
        const r = await POST('/api/cas-builder/credits', {});
        closeModal(); toast(plural(r.builds, 'Cas build') + ' added ✨ Let\'s build.'); refreshState();
        cbOpen({});
      } catch (ex2) {
        btnBusy(b, false);
        if (ex2.code === 'wallet_short') { closeModal(); toast(ex2.message, { kind: 'err', action: { label: 'Top up', onClick: () => openTopup((ex2.data && ex2.data.needed) || undefined) } }); return; }
        apiErr(ex2);
      }
    }
  };
}
function cbRestingSheet(msg) {
  const h = sheet('Cas is resting until tomorrow', '<span class="spk">🌙</span>', '<div class="cbo"><div class="cbo-av" data-cas="think"></div><p class="muted">' + esc(msg || 'Cas has had a busy day. You can build your flow in the builder (it\'s free), and Cas will be back in the morning.') + '</p></div><div class="row2b"><button type="button" class="btn b-ghost" data-shx2>Later</button><button type="button" class="btn b-blue" data-cbself>🧩 Use the builder</button></div>');
  paintCas(h);
  $('.sb', h).onclick = (e) => { if (e.target.closest('[data-shx2]')) closeModal(); if (e.target.closest('[data-cbself]')) { closeModal(); wfPickTemplate(); } };
}

/* ---------- Open the panel ---------- */
async function cbOpen(o = {}) {
  if (CB.host) return;
  if (!canSend()) { toast('Your role can look at bots. Ask the workspace owner to build one.', { kind: 'info' }); return; }
  if (!FL.data) { try { FL.data = await GET('/api/flows'); } catch (ex) { apiErr(ex); return; } }
  CB.from = o.flowId ? { id: o.flowId } : null;
  cbMount();
  cbTyping(true);
  try {
    let r;
    if (o.resume) r = await GET('/api/cas-builder/sessions/' + Number(o.resume));
    else r = await POST('/api/cas-builder/sessions', o.flowId ? { flow_id: o.flowId } : o.kind ? { kind: o.kind } : {});
    CB.s = r.session; CB.flowId = r.session.flow_id;
    cbTyping(false);
    const fresh = !o.resume && !o.flowId;
    CB.sig = [];
    cbPaintPhone(true);
    if (fresh || o.flowId) await cbPlayTurns(r.session.turns, { first: true });
    else { cbAddTurns(r.session.turns, { instant: true }); cbNote('↩ Welcome back! Your draft was saved.'); }
    cbPaintDock();
    cbDirTips();
  } catch (ex) {
    cbUnmount();
    if (ex.code === 'cas_builds_out') { cbOutSheet(ex); return; }
    if (ex.code === 'cas_resting') { cbRestingSheet(ex.message); return; }
    if (['limit_flows', 'plan_feature'].includes(ex.code)) { wfErr(ex); return; }
    apiErr(ex);
  }
}

function cbMount() {
  const host = document.createElement('div');
  host.id = 'cbHost';
  host.className = 'cb-ov';
  host.innerHTML = '<div class="cb-win" role="dialog" aria-modal="true" aria-label="Cas Builder">' +
    '<header class="cb-hd"><span class="cb-av" data-cas="happy" aria-hidden="true"></span><div class="cb-ht"><b>Cas Builder</b><small id="cbSub">Let\'s build your bot</small></div>' +
    (typeof VGUIDES !== 'undefined' ? '<button type="button" class="cb-ib cb-vg" data-vguide="bots-with-cas" aria-label="Watch the guide: Build any bot with Cas" title="Watch the guide">' + icon('play') + '<span>Watch the guide</span></button>' : '') +
    '<button type="button" class="cb-ib" data-cbundo aria-label="Undo the last change" title="Undo" disabled><svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg><span>Undo</span></button>' +
    '<button type="button" class="cb-ib x" data-cbx aria-label="Close Cas Builder" title="Close"><svg><use href="#i-x"/></svg></button></header>' +
    '<button type="button" class="cb-pvbar" data-cbpv aria-expanded="false" aria-controls="cbSide"><span class="cb-pvi">📱</span><span class="cb-pvt" id="cbPvT">Live preview</span><span class="cb-pvn" id="cbPvN"></span><span class="cb-pvc">' + icon('chev') + '</span></button>' +
    '<div class="cb-body"><section class="cb-chat"><div class="cb-log" id="cbLog" aria-live="polite"></div>' +
    '<div class="cb-dock"><div class="cb-chips" id="cbChips"></div><form class="cb-in" id="cbIn" autocomplete="off"><textarea id="cbTx" rows="1" maxlength="1500" placeholder="Type a message, or tap an answer" aria-label="Message to Cas" enterkeyhint="send"></textarea><button type="submit" class="cb-send" aria-label="Send" disabled><svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6"/></svg></button></form></div></section>' +
    '<aside class="cb-side" id="cbSide"><div class="cb-phone pvw fb-pv"><div class="phone2"><div class="scr" id="cbScr"></div></div><div class="cb-pvact"><button type="button" class="cb-mini" data-cbplay>▶ See it play</button><span class="cb-edhint" id="cbEdHint">✏️ Tap any message to change it</span></div></div></aside></div></div>';
  document.body.appendChild(host);
  document.body.classList.add('noscroll', 'cb-open');
  CB.host = host; CB.pv = false; CB.pvShut = false; CB.mode = 'flow'; CB.local = []; CB.tips = new Set(); CB.typePh = ''; CB.ed = null;
  paintCas(host);
  requestAnimationFrame(() => host.classList.add('in'));
  cbWire(host);
  cbViewport(true);
}
function cbUnmount() {
  if (!CB.host) return;
  cbStopPlay(true);
  cbViewport(false);
  const h = CB.host; CB.host = null; CB.s = null;
  h.classList.remove('in'); h.classList.add('out');
  document.body.classList.remove('noscroll', 'cb-open');
  setTimeout(() => h.remove(), wfReduced() ? 0 : 260);
}
/* iPhone keyboard: keep the panel inside the visible area (visualViewport). */
function cbViewport(on) {
  const vv = window.visualViewport;
  if (!vv) return;
  if (!on) { if (CB.vv) { vv.removeEventListener('resize', CB.vv); vv.removeEventListener('scroll', CB.vv); CB.vv = null; } return; }
  CB.vv = () => {
    if (!CB.host) return;
    CB.host.style.setProperty('--cb-h', vv.height + 'px');
    CB.host.style.setProperty('--cb-top', vv.offsetTop + 'px');
    CB.host.classList.toggle('kb', window.innerHeight - vv.height > 120);
    cbScrollLog();
  };
  vv.addEventListener('resize', CB.vv); vv.addEventListener('scroll', CB.vv);
  CB.vv();
}

/* ---------- The chat ---------- */
function cbTurnHtml(t) {
  if (t.from === 'me') return '<div class="cb-m me" data-t="' + Number(t.id) + '"><div class="cb-b">' + esc(t.text) + '</div></div>';
  const qi = t.quote ? Number(t.quote.i) : -1;
  const bot = !!(CB.s && CB.s.view && CB.s.view.draft && CB.s.view.draft.start_type === 'bot_start');
  const q = t.quote && t.quote.body != null ? '<div class="cb-q"><span class="cb-qn">' + (qi === 0 ? (bot ? 'First message' : 'Welcome message') : 'Message ' + (qi + 1)) + '</span><div class="cb-qb">' + fmtMsg(t.quote.body) + '</div></div>' +
    '<div class="cb-qa" role="group" aria-label="Change ' + (qi === 0 ? 'the welcome' : 'message ' + (qi + 1)) + '"><button type="button" data-cbqa="edit" data-qi="' + qi + '">✏️ Edit</button><button type="button" data-cbqa="shorter" data-qi="' + qi + '">Shorter</button><button type="button" data-cbqa="friendlier" data-qi="' + qi + '">Friendlier</button><button type="button" data-cbqa="emoji" data-qi="' + qi + '">Add emoji</button></div>' : '';
  return '<div class="cb-m cas" data-t="' + Number(t.id || 0) + '"><span class="cb-mav" data-cas="mini" aria-hidden="true"></span><div class="cb-b">' + fmtMsg(t.text) + q + (t.lock ? '<button type="button" class="cb-up" data-cblock="' + esc(t.lock) + '">⬆ See plans</button>' : '') + '</div></div>';
}
function cbAddTurns(turns, o = {}) {
  const log = $('#cbLog'); if (!log) return;
  const frag = document.createElement('div');
  frag.innerHTML = turns.map(cbTurnHtml).join('');
  [...frag.children].forEach((n) => { if (o.instant) n.classList.add('still'); log.appendChild(n); });
  cbGroup(log);
  paintCas(log);
  cbScrollLog(!o.instant);
}
/* Consecutive messages from Cas share one avatar (the last one). */
function cbGroup(log) {
  const ms = $$('.cb-m', log);
  ms.forEach((m, i) => { const nx = ms[i + 1]; m.classList.toggle('cont', !!nx && nx.classList.contains('cas') === m.classList.contains('cas') && !nx.classList.contains('note')); });
}
function cbNote(text) { const log = $('#cbLog'); if (!log) return; const d = document.createElement('div'); d.className = 'cb-note'; d.textContent = text; log.appendChild(d); cbScrollLog(); }
function cbScrollLog(smooth) { const log = $('#cbLog'); if (!log) return; requestAnimationFrame(() => { log.scrollTo({ top: log.scrollHeight, behavior: smooth && !wfReduced() ? 'smooth' : 'auto' }); }); }
function cbTyping(on) {
  const log = $('#cbLog'); if (!log) return;
  const old = $('.cb-typing', log);
  if (!on) { if (old) old.remove(); return; }
  if (old) return;
  const d = document.createElement('div');
  d.className = 'cb-m cas cb-typing';
  d.innerHTML = '<span class="cb-mav" data-cas="mini" aria-hidden="true"></span><div class="cb-b"><span class="tg-typing in"><i></i><i></i><i></i></span></div>';
  log.appendChild(d); paintCas(d); cbScrollLog(true);
}
const cbSleep = (ms) => new Promise((r) => setTimeout(r, wfReduced() ? Math.min(ms, 60) : ms));
/** Cas's messages arrive one by one with a short, natural "typing" pause; the user's own words show at once. */
async function cbPlayTurns(turns, o = {}) {
  const cas = turns.filter((t) => t.from === 'cas');
  for (const [k, t] of turns.entries()) {
    if (!CB.host) return;
    if (t.from === 'me') { if (!o.skipMe) cbAddTurns([t]); continue; }
    const n = cas.indexOf(t);
    cbTyping(true);
    await cbSleep(Math.min(900, (o.first && n === 0 ? 500 : 260) + String(t.text || '').length * 6));
    cbTyping(false);
    cbAddTurns([t]);
    if (t.quote || t.preview) cbPaintPhone();
    // Show, don't ask: a new or changed message opens the phone on small screens (once; closing it is respected).
    if (t.preview && cbNarrow() && !CB.pv && !CB.pvShut && CB.mode !== 'play') cbTogglePv(true);
    // The celebration: confetti, and on phones the chat comes back into view so they see it.
    if (t.celebrate) { cbPaintPhone(); if (cbNarrow() && CB.pv) cbTogglePv(false); confetti(); }
    void k;
  }
}

/* ---------- Answers (chips) and the input ---------- */
function cbPaintDock() {
  const box = $('#cbChips'); if (!box || !CB.s) return;
  const v = CB.s.view;
  const chips = CB.local.length ? CB.local : v.chips || [];
  box.innerHTML = chips.map((c, i) => '<button type="button" class="cb-chip' + (c.pri ? ' pri' : '') + (c.lock ? ' lock' : '') + '" data-cbc="' + i + '" style="--d:' + (i * 40) + 'ms">' + esc(c.label) + (c.hint ? '<small>' + esc(c.hint) + '</small>' : '') + (c.lock ? ' ' + icon('lock') : '') + '</button>').join('');
  box.classList.toggle('none', !chips.length);
  box.scrollLeft = 0;
  const tx = $('#cbTx'); if (tx) tx.placeholder = CB.typePh || v.input || (chips.length ? 'Or type a message…' : 'Type a message…');
  const inb = $('#cbIn'); if (inb) inb.classList.toggle('own', !!CB.typePh);
  const u = $('[data-cbundo]'); if (u) u.disabled = !v.can_undo || CB.busy;
  const sub = $('#cbSub'); if (sub) sub.textContent = (CB.s.kind === 'edit' ? 'Changing ' : '') + (v.draft.steps && v.draft.steps.length ? v.draft.name || 'Your bot' : 'Your bot') + (CB.s.flow_id ? (CB.s.live ? ' · live' : ' · saved') : ' · draft saved');
  cbBusy(CB.busy);
}
function cbBusy(on) {
  CB.busy = on;
  if (!CB.host) return;
  CB.host.classList.toggle('busy', on);
  $$('.cb-chip, .cb-qa button, .cb-fix:not(.done)', CB.host).forEach((b) => { b.disabled = on; });
  const send = $('.cb-send', CB.host); const tx = $('#cbTx');
  if (send) send.disabled = on || !(tx && tx.value.trim());
}
/** Send a chip or words; Cas's answer plays in. */
async function cbSend(input, o = {}) {
  if (CB.busy || !CB.s) return null;
  CB.local = [];
  CB.typePh = '';
  cbBusy(true);
  if (input.text != null) cbAddTurns([{ id: 0, from: 'me', text: input.text }]);
  else if (o.label) cbAddTurns([{ id: 0, from: 'me', text: o.label }]);
  const box = $('#cbChips'); if (box) box.classList.add('none');
  const t0 = Date.now();
  cbTyping(true);
  try {
    const r = await POST('/api/cas-builder/sessions/' + CB.s.id + '/' + (o.path || 'reply'), o.body || input);
    if (!CB.host) return null;
    await cbSleep(Math.max(0, 380 - (Date.now() - t0)));
    cbTyping(false);
    CB.s = { ...CB.s, ...r, turns: (CB.s.turns || []).concat(r.turns || []) };
    CB.flowId = r.flow_id || CB.flowId;
    await cbPlayTurns(r.turns || [], { skipMe: true });
    cbPaintPhone();
    cbDirTips();
    if (r.act === 'play') cbPlay();
    if (r.act === 'test') cbTest();
    return r;
  } catch (ex) {
    cbTyping(false);
    if (o.onErr && ex.status === 400) { o.onErr(ex); return null; }
    if (ex.code === 'cas_builds_out') { cbOutSheet(ex); return null; }
    if (['limit_flows', 'plan_feature', 'limit_flow_steps', 'plan_bot_type', 'limit_bots'].includes(ex.code)) { wfErr(ex); return null; }
    if (ex.code === 'cas_busy') { cbNote('One moment, Cas is still answering…'); return null; }
    cbAddTurns([{ id: 0, from: 'cas', text: (ex.status === 0 || ex.status >= 500 ? 'Hmm, I lost the connection for a second 🌱 ' : '') + ex.message }]);
    return null;
  } finally {
    cbBusy(false);
    cbPaintDock();
  }
}

/* ---------- Actions behind some answers ---------- */
async function cbChip(c) {
  if (CB.busy) return;
  if (c.lock) { wfUpgrade(CB_LOCK[c.lock] || c.lock); return; }
  if (c.local) { c.local(); return; }
  if (c.type) cbTypeOwn(c.type);
  if (c.act === 'type') return;
  switch (c.act) {
    case 'play': await cbSend({ chip: c.id }, { label: c.label }); cbPlay(); return;
    case 'test': { const r = await cbSend({ chip: c.id }, { label: c.label }); if (r) cbTest(); return; }
    case 'connect_channel': case 'connect_bot':
      openConnect(c.act === 'connect_channel' ? 'channel' : 'bot', { onConnected: async () => { await cbRefreshData(); cbSend({ chip: c.act === 'connect_channel' ? 'cc:check' : 'cb:check' }); } });
      return;
    case 'switch': return cbSwitch(false, c);
    case 'switch_replace': return cbSave({ active: true, replace: true }, c.label);
    case 'save': return cbSave({ active: false }, c.label);
    case 'draft': return cbSave({ active: false }, c.label);
    case 'builder': return cbBuilder();
    case 'broadcast': await cbSend({ chip: c.id }, { label: c.label }); if (typeof wfBotBroadcastSheet === 'function') wfBotBroadcastSheet(); return;
    case 'close': return cbClose();
    default: cbSend({ chip: c.id }, { label: c.label });
  }
}
/** "✍️ Type my own": open the keyboard with a helpful placeholder (inside the tap, so iPhone shows the keyboard). */
function cbTypeOwn(ph) {
  const tx = $('#cbTx'); if (!tx) return;
  CB.typePh = ph || 'Type it here…';
  tx.placeholder = CB.typePh;
  const inb = $('#cbIn'); if (inb) { inb.classList.add('own'); inb.classList.remove('nudge'); void inb.offsetWidth; inb.classList.add('nudge'); }
  tx.focus({ preventScroll: true });
  try { const n = tx.value.length; tx.setSelectionRange(n, n); } catch (_) { /* fine */ }
}
async function cbRefreshData() { try { FL.data = await GET('/api/flows'); } catch (_) { /* keep */ } }
/** "🚀 Switch it on": a calm look first (the builder's gentle tips), then save and switch on. */
function cbSwitch(force, c) {
  const E = cbE();
  const tips = wfTips(E, { branding: FL.data.plan.branding });
  if (tips.length && !force) {
    cbAddTurns([{ id: 0, from: 'me', text: c ? c.label : 'Switch it on' }, { id: 0, from: 'cas', text: 'Before it goes live, ' + (tips.length === 1 ? 'one small thing' : plural(tips.length, 'small thing')) + ' to look at:\n' + tips.slice(0, 4).map((x) => '• ' + (x.i === 0 ? 'Welcome' : 'Message ' + (x.i + 1)) + ': ' + x.text).join('\n') + '\n\nTell me what to change, or switch it on as it is.' }]);
    CB.local = (tips.some((x) => x.block) ? [] : [{ id: 'local:any', label: '🚀 Switch it on anyway', pri: true, local: () => { CB.local = []; cbSave({ active: true }, '🚀 Switch it on anyway'); } }])
      .concat([{ id: 'local:builder', label: '🛠 Fix it in the builder', local: () => cbBuilder() }]);
    cbPaintDock();
    return;
  }
  return cbSave({ active: true }, c ? c.label : '🚀 Switch it on');
}
async function cbSave(body, label) {
  const r = await cbSend({}, { path: 'save', body, label });
  if (!r) return;
  if (r.error && ['plan_feature', 'limit_flows', 'limit_flow_steps', 'plan_bot_type', 'limit_bots', 'limit_referral_bots'].includes(r.error.code)) wfErr({ code: r.error.code, message: r.error.message, data: r.error.data });
  if (r.saved) { CB.flowId = r.saved.flow_id; refreshState(); if (r.saved.active && body.active && !(typeof aurFirstLive === 'function' && aurFirstLive())) confetti(); }
}
async function cbBuilder() {
  let id = CB.flowId;
  if (!id) {
    const r = await cbSend({}, { path: 'save', body: { active: false }, label: '🛠 Open in builder' });
    if (r && r.saved) id = r.saved.flow_id;
  }
  if (id) { cbUnmount(); appGo('flows', { id }); return; }
  // Not savable yet (no channel or bot connected): open the builder with the draft, unsaved.
  FL.pendingE = cbE(); cbUnmount(); appGo('flows', { tpl: 'cas' });
}
function cbClose() {
  const saved = CB.flowId;
  const wasEdit = CB.s && CB.s.kind === 'edit';
  cbUnmount();
  if (saved || wasEdit) appGo('flows', saved ? { id: saved } : {});
  else toast('Your draft is saved. Continue it any time with Build with Cas 💙', { kind: 'info' });
}

/* ---------- The live phone ---------- */
/** The draft as the builder's flow object (app-flows.js format), for the phone, the tips, the movie and the test. */
function cbE() {
  const d = CB.s.view.draft;
  if (d.start_type === 'bot_start') return { id: CB.flowId || null, start_type: 'bot_start', start_code: d.start_code || '', is_default: !!d.is_default, name: d.name || 'My bot', chat_id: '', bot_id: d.bot_id || '', approve_mode: 'after_welcome', start_button: false, start_label: '', invite_link: '', active: !!CB.s.live, steps: d.steps.map(wfStep), started_count: 0 };
  return { id: CB.flowId || null, name: d.name || 'My welcome flow', chat_id: d.chat_id || '', bot_id: d.bot_id || '', approve_mode: d.approve_mode, start_button: !!d.start_button, start_label: d.start_label || '', invite_link: d.invite_link || '', active: !!CB.s.live, steps: d.steps.map(wfStep), started_count: 0 };
}
function cbWhen(E, i) {
  if (i === 0) return wfIsBot(E) ? '👆 The moment they tap Start' : '👋 The moment they ask to join';
  return WF_TRIG[wfTrig(E, i)][0] + ' ' + wfArrive(E, i).replace(/^Arrives /, '').replace(/^./, (x) => x.toUpperCase());
}
function cbPhoneHtml(E, fresh) {
  const tgBot = (FL.data.bots || []).find((b) => String(b.id) === String(E.bot_id));
  const o = { bot: tgBot ? tgBot.username : '' };
  const bot = wfIsBot(E);
  if (!E.steps.length) return wfTgTop(o) + '<div class="tg-bg wf-tgbg fb-chat cb-flowv"><div class="cb-empty"><span data-cas="think"></span><b>Your bot appears here</b><small>Answer Cas, and watch it build itself.</small></div></div>';
  const body = E.steps.map((s, i) => {
    const kb = wfKeyRows(E, i);
    const k = wfKind(s);
    // A special part's own buttons ("I've joined", choices, "Share my link") are shown, not edited; its words are.
    const own = (b) => b.join || b.ans != null || b.fixed;
    const text = k === 'referral' ? wfFillInvite(s.body, 't.me/' + (o.bot || 'yourbot') + '?start=r_ada', 0, Number((s.referral || {}).goal) || 3) : s.body;
    const pill = cbPartPill(E, s);
    return '<div class="cb-pm' + (fresh.has(i) ? ' pop' : '') + (CB.s.view.focus === i ? ' focus' : '') + '" data-pm="' + i + '"><div class="cb-when"><span>' + esc(cbWhen(E, i)) + '</span></div>' +
      '<div class="tm in cb-edit" data-ed="' + i + '" role="button" tabindex="0" aria-label="Change ' + (i === 0 ? (bot ? 'the first message' : 'the welcome') : 'message ' + (i + 1)) + '">' + (s.media && typeof mediaPreview === 'function' ? mediaPreview(s.media) : '') + '<span class="px">' + fmtMsg(text || '', { name: 'Ada' }) + '</span>' + (i === 0 && FL.data.plan.branding ? '<span class="px"><span class="wf-brand">⚡ <u>' + (bot ? 'Free bot by Castvoo.com' : 'Free welcome bot by Castvoo.com') + '</u></span></span>' : '') + '<span class="ti">' + (i + 1) + '</span><span class="cb-pen" aria-hidden="true">✏️</span></div>' +
      (kb.length ? '<div class="wf-kb fb-kb">' + kb.map((r) => '<div class="wf-kr">' + r.map((b) => own(b) ? '<span class="' + (b.kind === 'link' ? 'lk' : '') + '">' + esc(b.label) + (b.kind === 'link' ? ' ↗' : '') + '</span>'
        : '<span role="button" tabindex="0" class="cb-edit ' + (b.start ? 'st' : b.kind === 'link' ? 'lk' : '') + '" ' + (b.start ? 'data-es' : 'data-eb="' + i + ':' + esc(b.id) + '"') + ' aria-label="Change the button ' + esc(b.label) + '">' + esc(b.label) + (b.kind === 'link' ? ' ↗' : '') + '</span>').join('') + '</div>').join('') + '</div>' : '') +
      (pill ? '<div class="cb-when"><span>' + esc(pill) + '</span></div>' : '') + '</div>';
  }).join('');
  return wfTgTop(o) + '<div class="tg-bg wf-tgbg fb-chat cb-flowv" data-cbscroll>' + body + '</div>';
}
/** One plain line under a special part: what it does. */
function cbPartPill(E, s) {
  const k = wfKind(s);
  if (k === 'check_join') { const c = s.check || {}; const ch = (FL.data.chats || []).find((x) => String(x.id) === String(c.chat_id)); return '✅ Goes on once they join ' + (ch ? ch.title || 'your channel' : 'your channel') + (c.remind ? ' · reminder after ' + wfWait(c.remind.value, c.remind.unit) : ''); }
  if (k === 'ask') { const a = s.ask || {}; return '❓ Waits for their answer: ' + ({ text: 'a typed answer', number: 'a number', email: 'an email', phone: 'a phone number', choice: 'a tap on a button' }[a.answer] || 'a typed answer') + (a.label ? ' (saved as ' + a.label + ')' : ''); }
  if (k === 'referral') return '🔗 Their own invite link · goal ' + (Number((s.referral || {}).goal) || 3) + ' friends';
  return '';
}
/** Repaint the phone; messages that are new or changed pop in, and the phone scrolls to them. */
function cbPaintPhone(first) {
  if (!CB.host || !CB.s || CB.mode === 'play') return;
  const scr = $('#cbScr'); if (!scr) return;
  const E = cbE();
  const sig = E.steps.map((s, i) => JSON.stringify([s.body, s.buttons.map((b) => b.label + b.kind), wfTrig(E, i), E.start_button && i === 0, s.type, s.check, s.ask, s.referral]));
  const fresh = new Set();
  if (!first) sig.forEach((x, i) => { if (CB.sig[i] !== x && !CB.sig.includes(x)) fresh.add(i); });
  const added = E.steps.length > CB.sig.length && !first;
  CB.sig = sig;
  const old = $('[data-cbscroll]', scr); const keep = old ? old.scrollTop : 0;
  scr.innerHTML = cbPhoneHtml(E, fresh);
  paintCas(scr);
  const sc = $('[data-cbscroll]', scr);
  if (sc) {
    sc.scrollTop = keep;
    const target = fresh.size ? $('[data-pm="' + Math.max(...fresh) + '"]', sc) : null;
    requestAnimationFrame(() => { if (target) sc.scrollTo({ top: Math.max(0, target.offsetTop - 40), behavior: wfReduced() ? 'auto' : 'smooth' }); else if (first) sc.scrollTop = sc.scrollHeight; });
  }
  const n = E.steps.length;
  const t = $('#cbPvT'); if (t) t.textContent = n ? 'Preview · ' + plural(n, 'message') : 'Live preview';
  const nb = $('#cbPvN');
  if (nb && fresh.size && !CB.pv) { nb.textContent = added ? '✨ Message ' + (Math.max(...fresh) + 1) + ' added' : '✨ Updated'; nb.classList.remove('on'); void nb.offsetWidth; nb.classList.add('on'); }
  const play = $('[data-cbplay]', CB.host); if (play) play.disabled = !n;
  const hint = $('#cbEdHint'); if (hint) hint.hidden = !n;
}

/* The whole-flow movie (app-flows.js wfPlayHtml / wfPlayTick), played on this phone. */
function cbPlay() {
  if (!CB.host || !CB.s || !CB.s.view.draft.steps.length) return;
  FL.E = cbE();
  const scr = $('#cbScr'); if (!scr) return;
  if (!CB.pv && cbNarrow()) cbTogglePv(true);
  wfPlayStop();
  CB.mode = 'play';
  scr.setAttribute('data-simhost', '');
  CB.host.classList.add('playing');
  FL.mode = 'play'; FL.pvStep = null;
  FL.play = { events: [], shown: 0, typing: false, paused: false, choices: {}, picked: {} };
  wfSim();
  wfPlayT = setTimeout(wfPlayTick, wfReduced() ? 100 : 500);
}
function cbStopPlay(quiet) {
  if (CB.mode !== 'play') return;
  wfPlayStop();
  FL.mode = 'try'; FL.play = null;
  CB.mode = 'flow';
  const scr = $('#cbScr'); if (scr) scr.removeAttribute('data-simhost');
  if (CB.host) CB.host.classList.remove('playing');
  if (!quiet) { CB.sig = []; cbPaintPhone(true); }
}
function cbTest() {
  if (!CB.s) return;
  FL.E = cbE();
  wfTestSend($('[data-cbplay]') || document.body);
}

const cbNarrow = () => { try { return matchMedia('(max-width: 900px)').matches; } catch (_) { return false; } };
function cbTogglePv(on) {
  CB.pv = on == null ? !CB.pv : on;
  if (!CB.host) return;
  CB.host.classList.toggle('pvopen', CB.pv);
  const b = $('[data-cbpv]', CB.host); if (b) b.setAttribute('aria-expanded', String(CB.pv));
  const nb = $('#cbPvN'); if (nb && CB.pv) nb.classList.remove('on');
  if (!CB.pv && CB.mode === 'play') cbStopPlay();
}

function cbWire(host) {
  const tx = $('#cbTx', host);
  const fit = () => { tx.style.height = 'auto'; tx.style.height = Math.min(120, tx.scrollHeight) + 'px'; const s = $('.cb-send', host); if (s) s.disabled = CB.busy || !tx.value.trim(); };
  tx.addEventListener('input', fit);
  tx.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#cbIn', host).requestSubmit ? $('#cbIn', host).requestSubmit() : $('#cbIn', host).dispatchEvent(new Event('submit', { cancelable: true })); } });
  tx.addEventListener('focus', () => { if (cbNarrow() && CB.pv) cbTogglePv(false); setTimeout(cbScrollLog, 250); });
  $('#cbIn', host).addEventListener('submit', (e) => {
    e.preventDefault();
    const v = tx.value.trim(); if (!v || CB.busy) return;
    tx.value = ''; fit();
    cbSend({ text: v });
  });
  host.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('[data-cbx]')) { cbClose(); return; }
    if (t.closest('[data-cbundo]')) { if (!CB.busy) cbSend({}, { path: 'undo', body: {}, label: '↩ Undo' }); return; }
    if (t.closest('[data-cbpv]')) { cbTogglePv(); if (!CB.pv) CB.pvShut = true; return; }
    const lk = t.closest('[data-cblock]'); if (lk) { wfUpgrade(CB_LOCK[lk.dataset.cblock] || lk.dataset.cblock); return; }
    const ch = t.closest('[data-cbc]');
    if (ch) { const list = CB.local.length ? CB.local : (CB.s ? CB.s.view.chips : []); const c = list[+ch.dataset.cbc]; if (c) cbChip(c); return; }
    if (t.closest('[data-cbplay]')) { if (CB.mode === 'play') cbStopPlay(); else cbPlay(); return; }
    if (CB.mode === 'play' && t.closest('#cbScr')) {
      if (t.closest('[data-playx]')) { cbStopPlay(); return; }
      if (t.closest('[data-playre]')) { cbPlay(); return; }
      wfSimClick(t);
      return;
    }
    if (t.closest('.cb-ed')) return;
    if (cbEditTap(t)) return;
    const qa = t.closest('[data-cbqa]'); if (qa) { cbQuick(qa.dataset.cbqa, +qa.dataset.qi); return; }
    const fx = t.closest('[data-cbfix]'); if (fx) { cbFix(+fx.dataset.cbfix, fx); }
  });
  host.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (CB.ed) { cbEdClose(); return; } if (!$('#modalHost .sheet')) cbClose(); return; }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('#cbScr .cb-edit') && CB.mode !== 'play') { e.preventDefault(); cbEditTap(e.target); }
  });
}

/* ---------- Tap to edit (the phone preview) ---------- */
/** A tap on a message or a button of the phone opens its editor. Returns true when it did. */
function cbEditTap(t) {
  if (!CB.s || CB.mode === 'play' || !t.closest('#cbScr')) return false;
  const b = t.closest('[data-eb]'); if (b) { const k = b.dataset.eb.indexOf(':'); cbEditBtn(+b.dataset.eb.slice(0, k), b.dataset.eb.slice(k + 1)); return true; }
  if (t.closest('[data-es]')) { cbEditStart(); return true; }
  const m = t.closest('[data-ed]'); if (m) { cbEditMsg(+m.dataset.ed); return true; }
  return false;
}
const cbTextMax = () => 4096 - (FL.data && FL.data.plan && FL.data.plan.branding ? 34 : 0);
const cbLen = (s) => (typeof visibleLength === 'function' ? visibleLength(s) : [...String(s || '')].length);
/** The editor sheet (a bottom sheet on phones, a small card on computers), inside the Cas Builder window. */
function cbEdOpen(title, sub, body, onSave) {
  cbEdClose(true);
  const win = $('.cb-win', CB.host); if (!win) return null;
  const el = document.createElement('div');
  el.className = 'cb-ed';
  el.innerHTML = '<div class="cb-edbg" data-edx></div><form class="cb-eds" role="dialog" aria-modal="true" aria-label="' + esc(title) + '" novalidate>' +
    '<div class="cb-edh"><span class="cb-edgrab" aria-hidden="true"></span><div><b>' + esc(title) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div><button type="button" class="cb-ib x" data-edx aria-label="Cancel"><svg><use href="#i-x"/></svg></button></div>' +
    body + '<p class="cb-ederr" role="alert" hidden></p>' +
    '<div class="cb-edb"><button type="button" class="btn b-ghost" data-edx>Cancel</button><button type="submit" class="btn b-blue" data-edok>Save</button></div></form>';
  win.appendChild(el);
  CB.ed = { el, onSave, back: document.activeElement };
  requestAnimationFrame(() => el.classList.add('in'));
  el.addEventListener('click', (e) => { if (e.target.closest('[data-edx]')) cbEdClose(); });
  $('form', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    if (CB.busy) return;
    const ok = $('[data-edok]', el);
    btnBusy(ok, true, 'Saving…');
    const done = await onSave((msg) => cbEdErr(msg));
    if (CB.ed && CB.ed.el === el) { btnBusy(ok, false); if (done) cbEdClose(); }
  });
  return el;
}
function cbEdErr(msg) { const p = CB.ed && $('.cb-ederr', CB.ed.el); if (!p) return; p.textContent = msg || ''; p.hidden = !msg; }
function cbEdClose(quick) {
  if (!CB.ed) return;
  const { el, back } = CB.ed; CB.ed = null;
  el.classList.remove('in');
  setTimeout(() => el.remove(), quick || wfReduced() ? 0 : 220);
  if (back && back.focus && document.contains(back) && !cbNarrow()) { try { back.focus({ preventScroll: true }); } catch (_) { /* fine */ } }
}
/** Save through POST …/edit: Cas says "Updated message 2 ✓" in the chat; a refusal shows in the sheet. */
async function cbEdSave(body, err) {
  let bad = null;
  const r = await cbSend({}, { path: 'edit', body, onErr: (ex) => { bad = ex.message; } });
  if (bad) { err(bad); return false; }
  return !!r;
}
function cbEditMsg(i) {
  if (CB.busy || !CB.s) return;
  const d = CB.s.view.draft; const s = d.steps[i]; if (!s) return;
  const E = cbE();
  const max = cbTextMax();
  const el = cbEdOpen(i === 0 ? (wfIsBot(E) ? 'Change the first message' : 'Change the welcome') : 'Change message ' + (i + 1), cbWhen(E, i),
    '<label class="cb-edl"><span class="sr">Message text</span><textarea class="cb-edta" rows="6" maxlength="' + (max + 400) + '" data-edtx>' + esc(s.body || '') + '</textarea></label>' +
    '<div class="cb-edtools"><button type="button" class="cb-edname" data-edname>👤 Add their name</button><small class="cb-edhelp">{name} becomes their first name</small><span class="cb-edc" data-edc></span></div>',
    async (err) => {
      const v = tx.value.trim();
      if (!v) { err('Write a few words first, so it doesn\'t arrive empty 🙂'); return false; }
      if (cbLen(v) > max) { err('That\'s a little long for Telegram. Trim it to ' + fmt(max) + ' characters.'); return false; }
      if (v === String(s.body || '').trim()) return true;
      return cbEdSave({ message: i + 1, text: v }, err);
    });
  if (!el) return;
  const tx = $('[data-edtx]', el), cnt = $('[data-edc]', el);
  const count = () => { const n = cbLen(tx.value); cnt.textContent = fmt(n) + ' / ' + fmt(max); cnt.classList.toggle('over', n > max); cbEdErr(''); };
  tx.addEventListener('input', count); count();
  $('[data-edname]', el).onclick = () => { insertAtCaret(tx, '{name}'); count(); tx.focus(); };
  tx.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('form', el).requestSubmit ? $('form', el).requestSubmit() : $('[data-edok]', el).click(); } });
  tx.focus({ preventScroll: true });
  const n = tx.value.length; try { tx.setSelectionRange(n, n); } catch (_) { /* fine */ }
  tx.scrollTop = tx.scrollHeight;
}
/** A button: its text, and its link (or what happens when it's tapped). */
function cbEditBtn(i, id) {
  if (CB.busy || !CB.s) return;
  const d = CB.s.view.draft; const s = d.steps[i]; if (!s) return;
  const b = (s.buttons || []).find((x) => x.id === id); if (!b) return;
  const link = b.kind !== 'reply';
  const ans = link ? -1 : d.steps.findIndex((x, k) => k > i && x.trigger && x.trigger.type === 'on_button' && x.trigger.button === b.id);
  const el = cbEdOpen('Change the button', link ? 'It opens a link' : 'They tap it and get a message',
    '<label class="cb-edf"><span>Button text</span><input class="inp" data-edlb maxlength="40" value="' + esc(b.label) + '" autocomplete="off"><small class="cb-edc" data-edc></small></label>' +
    (link ? '<label class="cb-edf"><span>The link it opens</span><input class="inp" data-edurl inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://your-link.com" value="' + esc(b.url || '') + '"></label>'
      : '<div class="cb-edwhat"><span>When they tap it</span>' + (ans > 0 ? '<p>Message ' + (ans + 1) + ' arrives: “' + esc(firstWords(d.steps[ans].body, 70)) + '”</p><button type="button" class="cb-edname" data-edgo="' + ans + '">✏️ Change message ' + (ans + 1) + '</button>' : '<p>Nothing yet. Tell Cas in the chat what they should get 🙂</p>') + '</div>'),
    async (err) => {
      const label = lb.value.trim();
      if (!label) { err('A button needs a little text, like "👉 Open".'); return false; }
      const body = { message: i + 1, button: b.id };
      if (label !== b.label) body.label = label;
      if (link) { const u = $('[data-edurl]', el).value.trim(); if (!u) { err('Paste the link it should open, like https://your-site.com'); return false; } if (u !== b.url) body.url = u; }
      if (body.label == null && body.url == null) return true;
      return cbEdSave(body, err);
    });
  if (!el) return;
  const lb = $('[data-edlb]', el), cnt = $('[data-edc]', el);
  const count = () => { cnt.textContent = [...lb.value].length + ' / 40'; cbEdErr(''); };
  lb.addEventListener('input', count); count();
  const go = $('[data-edgo]', el); if (go) go.onclick = () => cbEditMsg(+go.dataset.edgo);
  lb.focus({ preventScroll: true }); try { lb.setSelectionRange(lb.value.length, lb.value.length); } catch (_) { /* fine */ }
}
function cbEditStart() {
  if (CB.busy || !CB.s) return;
  const d = CB.s.view.draft;
  const cur = d.start_label || (d.approve_mode === 'tap' ? '✅ Tap to join' : '👆 Tap Start');
  const next = d.steps.findIndex((x, k) => k > 0 && x.trigger && x.trigger.type === 'on_start');
  const el = cbEdOpen('Change the Start button', 'It opens your bot',
    '<label class="cb-edf"><span>Button text</span><input class="inp" data-edlb maxlength="40" value="' + esc(cur) + '" autocomplete="off"><small class="cb-edc" data-edc></small></label>' +
    '<div class="cb-edwhat"><span>When they tap it</span><p>Your bot opens. Once they tap Start, your bot can message them any time.' + (next > 0 ? ' Message ' + (next + 1) + ' arrives right then.' : '') + '</p>' + (next > 0 ? '<button type="button" class="cb-edname" data-edgo="' + next + '">✏️ Change message ' + (next + 1) + '</button>' : '') + '</div>',
    async (err) => {
      const label = lb.value.trim();
      if (!label) { err('A button needs a little text, like "👆 Tap Start".'); return false; }
      if (label === cur) return true;
      return cbEdSave({ start: true, label }, err);
    });
  if (!el) return;
  const lb = $('[data-edlb]', el), cnt = $('[data-edc]', el);
  const count = () => { cnt.textContent = [...lb.value].length + ' / 40'; cbEdErr(''); };
  lb.addEventListener('input', count); count();
  const go = $('[data-edgo]', el); if (go) go.onclick = () => cbEditMsg(+go.dataset.edgo);
  lb.focus({ preventScroll: true });
}
function firstWords(s, n) { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; }

/* ---------- Quick actions under a message Cas shows ---------- */
async function cbQuick(how, i) {
  if (CB.busy || !CB.s) return;
  if (!CB.s.view.draft.steps[i]) { cbNote('That message isn\'t there any more.'); return; }
  if (how === 'edit') { cbEditMsg(i); return; }
  const label = { shorter: 'Make message ' + (i + 1) + ' shorter', friendlier: 'Make message ' + (i + 1) + ' friendlier', emoji: 'Add an emoji to message ' + (i + 1) }[how];
  if (!label) return;
  const bot = CB.s.view.draft.start_type === 'bot_start';
  await cbSend({}, { path: 'tweak', body: { message: i + 1, how }, label: i === 0 ? label.replace('message 1', bot ? 'the first message' : 'the welcome') : label });
}

/* ---------- "below" that should be "above": a gentle tip with [Fix it] ---------- */
function cbDirTips() {
  if (typeof CasEngine === 'undefined' || !CB.s || !CB.host) return;
  const d = CB.s.view.draft;
  for (const x of CasEngine.directionIssues(d)) {
    const key = x.i + '|' + d.steps[x.i].body;
    if (CB.tips.has(key)) continue;
    CB.tips.add(key);
    const log = $('#cbLog'); if (!log) return;
    const n = document.createElement('div');
    n.className = 'cb-m cas cb-tipm';
    n.innerHTML = '<span class="cb-mav" data-cas="mini" aria-hidden="true"></span><div class="cb-b"><span class="cb-tipt">💡 ' + (x.i === 0 ? 'Your welcome' : 'Message ' + (x.i + 1)) + ': ' + esc(x.text) + '</span><button type="button" class="cb-fix" data-cbfix="' + x.i + '">Fix it</button></div>';
    log.appendChild(n); cbGroup(log); paintCas(n); cbScrollLog(true);
  }
}
async function cbFix(i, btn) {
  if (CB.busy || !CB.s || typeof CasEngine === 'undefined') return;
  const d = CB.s.view.draft;
  if (!d.steps[i] || !CasEngine.directionIssues(d, i).length) { btn.disabled = true; btn.textContent = 'All good ✓'; return; }
  const text = CasEngine.fixDirections(d, i);
  let bad = null;
  const r = await cbSend({}, { path: 'edit', body: { message: i + 1, text }, label: '💡 Fix it', onErr: (ex) => { bad = ex.message; } });
  if (bad) { cbNote(bad); return; }
  if (r) { btn.disabled = true; btn.textContent = 'Fixed ✓'; btn.classList.add('done'); }
}

'use strict';
/*
 * app.js: the dashboard shell (sidebar, top bar, bottom dock, page switching) and shared UI bits.
 *
 * HOW TO ADD A DASHBOARD PAGE
 *   1. In a page file (for example app-people.js) add:
 *        PAGES.mypage = { title: 'My page', sub: 'One line about it', render: async (el, q, alive) => { ... } };
 *      el    = where to draw.  q = query (#app/mypage?x=1 gives { x: '1' }).
 *      alive = function: after every await, `if (!alive()) return;` (the user may have left the page).
 *   2. Add a sidebar button in index.html:  <button type="button" class="si" data-v="mypage">...</button>
 *   3. Link to it from anywhere with  data-go="mypage"  or  appGo('mypage').
 *   Timers: use every(ms, fn) / later(ms, fn). They stop by themselves when the user leaves the page.
 */

const PAGES = {};
const APP = { booted: false, state: null, page: null, q: {}, gen: 0, timers: [], loading: null };

/* ---------- Page timers ---------- */
function every(ms, fn) { const id = setInterval(fn, ms); APP.timers.push(() => clearInterval(id)); return id; }
function later(ms, fn) { const id = setTimeout(fn, ms); APP.timers.push(() => clearTimeout(id)); return id; }
function clearPageTimers() { APP.timers.forEach((f) => f()); APP.timers = []; GUIDES.page.forEach((g) => g.stop()); GUIDES.page = []; }

/* ---------- Navigation ---------- */
function appGo(page, q) {
  const qs = q ? '?' + new URLSearchParams(q).toString() : '';
  const h = '#app' + (page && page !== 'overview' ? '/' + page : '') + qs;
  if (location.hash === h) renderPage(page || 'overview', q || {});
  else location.hash = h;
}
function onLoggedOut() {
  if (!ME.user) return;
  ME = { user: null, workspaces: [] };
  APP.booted = false; APP.state = null;
  clearPageTimers();
  if (typeof closeVideoGuide === 'function') closeVideoGuide(true);
  if (location.hash.startsWith('#app')) store.sset('cv_back', location.hash);
  closeModal();
  toast('Please log in again.', { kind: 'info' });
  location.hash = '#login';
}

/* A setup helper the owner removed: forget that workspace and open their own. */
let accessGone = false;
async function onAccessRemoved(msg) {
  if (accessGone) return;
  accessGone = true;
  WS.set(null);
  closeModal();
  toast(msg || 'The owner removed your access to this workspace.', { kind: 'info' });
  await loadMe();
  APP.booted = false;
  accessGone = false;
  if (location.hash.startsWith('#app')) appRoute('overview', {});
}

/* Called by main.js for #app and #app/<page>?query */
async function appRoute(sub, q) {
  if (!ME.user) { store.sset('cv_back', location.hash || '#app'); location.replace('#login'); return; }
  if (!APP.booted) {
    const ok = await bootApp();
    if (!ok) return;
  }
  renderPage(sub || 'overview', q);
  if (typeof avatarPromptMaybe === 'function') avatarPromptMaybe();
}

async function bootApp() {
  if (APP.loading) return APP.loading;
  APP.loading = (async () => {
    $('#pg').innerHTML = '<div class="pgload"><div style="width:110px" data-cas="think"></div><span class="spin"></span><span class="muted">Loading your dashboard…</span></div>';
    paintCas($('#pg'));
    try {
      APP.state = await GET('/api/app/state');
      APP.booted = true;
      shellUI();
      return true;
    } catch (e) {
      if (e.status === 401) return false;
      $('#pg').innerHTML = errorBox(e, 'bootRetry');
      $('[data-retry="bootRetry"]').onclick = () => { APP.loading = null; appRoute(APP.page || '', APP.q); };
      return false;
    } finally { APP.loading = null; }
  })();
  return APP.loading;
}

async function refreshState() {
  try { APP.state = await GET('/api/app/state'); shellUI(); } catch (e) { /* keep the old numbers */ }
  return APP.state;
}

/* Write HTML only when it changed: polls (refreshState every few seconds) must not rebuild what the person is looking at. */
function putHtml(el, h) { if (!el || el._cvHtml === h) return false; el._cvHtml = h; el.innerHTML = h; return true; }

/* opts.keepScroll: redraw the page where it is (closing a video, refreshing after an action) instead of jumping to the
   top. A page change (another page or the same page tapped in the menu) still starts at the top. */
async function renderPage(name, q, opts) {
  const keepY = opts && opts.keepScroll && APP.page === name ? (window.scrollY || document.documentElement.scrollTop || 0) : null;
  clearPageTimers();
  if (typeof closeVideoGuide === 'function') closeVideoGuide(true);
  const g = ++APP.gen;
  if (!PAGES[name]) name = 'overview';
  APP.page = name; APP.q = q || {};
  const p = PAGES[name];
  $$('#snav .si, #dock [data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === name));
  $('#pgTitle').textContent = p.title; $('#pgSub').textContent = p.sub || '';
  document.title = p.title + ' · Castvoo';
  const pg = $('#pg');
  pg.innerHTML = '<div class="pgt"><h2>' + esc(p.title) + '</h2><span class="muted">' + esc(p.sub || '') + '</span></div><div class="pgb"></div>';
  const el = $('.pgb', pg);
  closeDrawer();
  if (keepY === null) window.scrollTo(0, 0);
  const alive = () => g === APP.gen && !$('#v-app').hidden;
  try {
    await p.render(el, APP.q, alive);
    if (keepY !== null && alive()) window.scrollTo(0, Math.min(keepY, document.documentElement.scrollHeight - innerHeight));
  } catch (e) {
    if (!alive()) return;
    if (e.status === 401) return;
    el.innerHTML = errorBox(e, 'pgRetry');
    const r = $('[data-retry="pgRetry"]', el); if (r) r.onclick = () => renderPage(name, q);
  }
  if (alive()) { paintAll(pg); applyFeatures(pg); guideLinksOn(name, el); }
}

/* "Watch the guide" links at the top of pages that have a video guide (app-guides.js). Not inside the flow builder. */
function guideLinksOn(name, el) {
  if (typeof guideLinksFor !== 'function' || name === 'guides' || $('.vgls', el)) return;
  if (name === 'flows' && (APP.q.id || APP.q.tpl)) return;
  const html = guideLinksFor(name);
  if (html) el.insertAdjacentHTML('afterbegin', html);
}

/* ---------- Shell ---------- */
function shellUI() {
  const s = APP.state;
  if (!s) return;
  const u = ME.user || {};
  $$('.walBal').forEach((e) => { e.textContent = money(s.wallet.total); });
  $$('.walBonus').forEach((e) => { const b = Number(s.wallet.bonus) || 0; e.hidden = !(b > 0); e.textContent = b > 0 ? 'incl. ' + money(b) + ' bonus credit' : ''; });
  const nConn = s.connections.length;
  const multi = (ME.workspaces || []).length > 1;
  $('#wsBox').innerHTML = '<' + (multi ? 'button type="button" data-ws-switch' : 'div') + ' class="ws' + (multi ? ' sw' : '') + '"><span class="wi">' + esc((s.workspace.name || 'W')[0].toUpperCase()) + '</span><div style="min-width:0;flex:1"><b class="ell" style="font-size:14.5px;display:block">' + esc(s.workspace.name) + (isHelper() ? ' <span class="pill p-tg hb">Helper</span>' : '') + '</b><small>' + TG.replace('class="tgi"', 'class="tgi" style="width:14px;height:14px"') + (nConn ? plural(nConn, 'Telegram connection') : 'Nothing connected yet') + '</small></div>' + (multi ? '<svg class="chv2"><use href="#i-swap"/></svg>' : '') + '</' + (multi ? 'button' : 'div') + '>';
  $('#meRow').innerHTML = '<button type="button" class="me-av" data-avatar-edit aria-label="Edit your avatar">' + myAva(42) + '</button><div style="min-width:0;flex:1"><b class="ell" style="font-size:14.5px;display:block">' + esc(u.nickname || u.name || 'You') + '</b><small class="ell" style="display:block">' + esc(u.email || (u.tg_username ? '@' + u.tg_username : roleName(s.workspace.role))) + '</small></div><button type="button" class="ib" data-logout aria-label="Log out" title="Log out"><svg><use href="#i-out"/></svg></button>';
  $('#topAva').innerHTML = myAva(40, 'top');
  $('#navHelp').hidden = !(s.support_unread > 0);
  $('#dockDot').hidden = !(s.support_unread > 0);
  const ref = CFG.referral && CFG.referral.rates ? CFG.referral.rates[0] + '%+' : '';
  $('#navEarn').textContent = ref; $('#navEarn').hidden = !ref;
  appBanners();
  applyFeatures(document);
  // Referral earnings belong to each person's own workspace, so the helper does not see Earn here.
  $$('#snav [data-v="earn"]').forEach((e) => { if (isHelper()) e.hidden = true; });
  if (typeof vgNavTag === 'function') vgNavTag();
}
function roleName(r) { return { owner: 'Owner', sender: 'Can send', drafter: 'Drafts only', helper: 'Setup helper' }[r] || r || ''; }
const isOwner = () => APP.state && APP.state.workspace.role === 'owner';
const canSend = () => APP.state && APP.state.workspace.role !== 'drafter' && !(APP.state.workspace.role === 'helper' && APP.state.helper && APP.state.helper.send === false);
/* Setup helper (server/permissions.js WS_PERMS): sets up the workspace like the owner, without the owner's account, team or earnings. */
const isHelper = () => APP.state && APP.state.workspace.role === 'helper';
const canSetup = () => isOwner() || isHelper();
const canBilling = () => isOwner() || (isHelper() && !!(APP.state.helper && APP.state.helper.billing));
const OWNER_ONLY = 'Only the owner can do this.';
/* The owner's "invite a setup helper" card (Home checklist, Welcome Flows, Help), with a "Watch the guide" link to the
 * setup-helper video (app-guides.js). Empty when it does not apply. */
function helperCard(where) {
  const s = APP.state;
  if (!isOwner() || !s.helper || s.helper.active) return '';
  const pend = s.helper.pending;
  return '<div class="hlpc' + (where ? ' ' + where : '') + '"><span class="hlpi" aria-hidden="true">' + icon('users') + '</span><div class="hlpt"><b>' + (pend ? 'Your setup helper is invited' : 'Get help setting up') + '</b><small>' + (pend ? 'Waiting for them to accept. You can copy the invite link again in Settings → Team.' : 'Invite your media buyer or a friend to set everything up with their own login. No password sharing, free on every plan, remove them any time.') + '</small></div><div class="hlpb"><button type="button" class="btn ' + (pend ? 'b-ghost' : 'b-blue') + ' sm" data-helper-invite>' + (pend ? 'See invite' : icon('plus') + 'Invite a setup helper') + '</button>' + (typeof VGUIDES !== 'undefined' ? '<button type="button" class="hlpv" data-vguide="setup-helper">' + icon('play') + 'Watch the guide</button>' : '') + '</div></div>';
}

function appBanners() {
  const s = APP.state, b = [];
  if (s && isHelper()) b.push('<div class="abn hlp"><span>🤝</span><span>You\'re helping <b>' + esc(s.workspace.name) + '</b> as setup helper.</span><button type="button" class="btn b-ghost xs" data-helper-leave>Leave</button></div>');
  if (s && isOwner() && s.helper && s.helper.notice) b.push('<div class="abn ok"><span>🎉</span><span><b>' + esc(s.helper.notice.name) + '</b> joined as your setup helper. See what they do in Settings → Team.</span><button type="button" class="btn b-blue xs" data-helper-seen>Got it</button></div>');
  if (CFG.features.maintenance) b.push('<div class="abn warn"><span>🔧</span><span>' + esc(CFG.content.maintenance_message || 'Castvoo is getting an upgrade. Sending is paused for a few minutes.') + '</span></div>');
  if (s && s.plan.join && s.plan.join.paused) b.push('<div class="abn warn"><span>⏸️</span><span><b>Welcomes are paused for this month.</b> People who ask to join are still let in, but they don\'t get your welcome.</span><button type="button" class="btn b-blue xs" data-go="flows">See why</button></div>');
  if (s && s.plan.status === 'paused') b.push('<div class="abn bad"><span>⏸️</span><span><b>Sending is paused.</b> Your wallet did not cover the plan. Top up to restart; nothing was deleted.</span><button type="button" class="btn b-blue xs" data-topup>Top up</button></div>');
  putHtml($('#appBanners'), b.join(''));
}
function applyFeatures(root) {
  $$('[data-feat]', root).forEach((e) => { e.hidden = CFG.features[e.dataset.feat] === false; });
}

function openDrawer() { $('#app').classList.add('drawer'); $('#sideOv').classList.add('show'); }
function closeDrawer() { $('#app').classList.remove('drawer'); $('#sideOv').classList.remove('show'); }

async function logout() {
  let r = null;
  try { r = await POST('/api/auth/logout'); } catch (_) { /* ignore */ }
  // Signed in with VooSquare: end that session too, then VooSquare sends the person back here.
  if (r && r.voosquare_logout_url) { location.href = r.voosquare_logout_url; return; }
  ME = { user: null, workspaces: [] };
  APP.booted = false; APP.state = null;
  clearPageTimers();
  siteAuthUI();
  location.hash = '#top';
  toast('You are logged out.');
}

function switchWorkspace() {
  const cur = APP.state.workspace.id;
  const h = sheet('Switch workspace', '<span class="spk">' + icon('swap') + '</span>', '<div class="ckl">' + (ME.workspaces || []).map((w) => '<button type="button" class="ckc" data-w="' + w.id + '" style="--c:var(--blue)"><span class="ci" style="background:var(--blue-s);font-size:20px;font-weight:800;color:var(--blue-t)">' + esc((w.name || 'W')[0].toUpperCase()) + '</span><span class="ct"><b>' + esc(w.name) + (w.role === 'helper' ? ' <span class="pill p-tg">Helper</span>' : '') + (String(w.id) === String(cur) ? ' <span class="pill p-ok">Open now</span>' : '') + '</b><small>' + esc(w.role === 'helper' ? 'You\'re the setup helper' : roleName(w.role)) + '</small></span><svg class="chv"><use href="#i-chev"/></svg></button>').join('') + '</div>');
  $('.ckl', h).onclick = async (e) => {
    const b = e.target.closest('[data-w]'); if (!b) return;
    WS.set(b.dataset.w); closeModal();
    APP.booted = false;
    await appRoute(APP.page, APP.q);
    toast('Switched to ' + APP.state.workspace.name);
  };
}

/* Create sheet (the big + on phones) */
function openCreate() {
  const O = [['go:flows', '👋', '#EAF0FF', '#2F6BFF', 'New welcome flow', 'Greet and let in everyone who asks to join your channel.'], ['go:broadcast', '📨', '#FFF1E6', '#F76707', 'Send a message', 'Write once, send to a channel, group or the people who started your bot.'], ['connect:channel', '📣', '#EAF0FF', '#2F6BFF', 'Add a channel', 'Post to everyone who follows your channel.'], ['connect:group', '👥', '#E2F6EE', '#0E9F6E', 'Add a group', 'Send messages into a group chat.'], ['connect:bot', '🤖', '#F1ECFF', '#7048E8', 'Add a bot', 'Message people one-to-one and run follow-ups.'], ['go:drips', '🔁', '#E6FCF5', '#0CA678', 'New auto follow-up', 'Messages that send themselves after someone joins.']];
  const h = sheet('What do you want to do?', '<span class="spk">' + icon('plus') + '</span>', '<div class="ckl">' + O.map((o) => '<button type="button" class="ckc" style="--c:' + o[3] + '" data-act="' + o[0] + '"><span class="ci" style="background:' + o[2] + '">' + o[1] + '</span><span class="ct"><b>' + o[4] + '</b><small>' + o[5] + '</small></span><svg class="chv"><use href="#i-chev"/></svg></button>').join('') + '</div>');
  $('.ckl', h).onclick = (e) => { const b = e.target.closest('[data-act]'); if (!b) return; const [t, v] = b.dataset.act.split(':'); if (t === 'go') { closeModal(); appGo(v, v === 'drips' || v === 'flows' ? { new: '1' } : null); } else openConnect(v); };
}

/* ---------- Shared UI pieces ---------- */
function errorBox(err, retryId) {
  return '<div class="box emptyb"><div style="width:90px" data-cas="think"></div><b>That didn\'t load</b><p class="muted">' + esc(err && err.message ? err.message : 'Something went wrong.') + '</p>' + (retryId ? '<button type="button" class="btn b-blue sm" data-retry="' + retryId + '">' + icon('refresh') + 'Try again</button>' : '') + '</div>';
}
/* emptyBox({ cas, emoji, title, text, action }) */
function emptyBox(o) {
  return '<div class="emptyb' + (o.plain ? '' : ' box') + '">' + (o.cas ? '<div style="width:' + (o.size || 96) + 'px" data-cas="' + o.cas + '"></div>' : o.emoji ? '<span class="eemo">' + o.emoji + '</span>' : '') + '<b>' + o.title + '</b>' + (o.text ? '<p class="muted">' + o.text + '</p>' : '') + (o.action || '') + '</div>';
}
function skel(n, h) { return Array.from({ length: n || 3 }, () => '<div class="skel" style="height:' + (h || 64) + 'px"></div>').join(''); }
function loadingBox(text) { return '<div class="box pgload sm"><span class="spin"></span><span class="muted">' + esc(text || 'Loading…') + '</span></div>'; }

const KIND = { channel: { e: '📣', b: '#EAF0FF', c: '#2F6BFF', w: 'subscribers', n: 'Channel' }, group: { e: '👥', b: '#E2F6EE', c: '#0E9F6E', w: 'members', n: 'Group' }, bot: { e: '🤖', b: '#F1ECFF', c: '#7048E8', w: 'subscribers', n: 'Bot' } };
function kIcon(kind, cls) { const k = KIND[kind] || KIND.bot; return '<span class="' + (cls || 'ki2') + '" style="background:' + k.b + '">' + k.e + '<span class="tb"><svg><use href="#i-tg"/></svg></span></span>'; }
function connName(c) { return c.kind === 'bot' ? '@' + (c.username || c.title) : (c.title || (c.username ? '@' + c.username : 'Untitled')); }

const B_STATUS = {
  draft: ['Draft', 'p-grey'], scheduled: ['Scheduled', 'p-warn'], pending_approval: ['Waiting for approval', 'p-tg'], sending: ['Sending', 'p-blue'],
  sent: ['Sent', 'p-ok'], cancelled: ['Cancelled', 'p-grey'], failed: ['Failed', 'p-bad'], paused: ['Paused', 'p-warn'],
};
function bPill(st) { const s = B_STATUS[st] || [st, 'p-grey']; return '<span class="pill ' + s[1] + '">' + (st === 'sending' ? '<span class="dl" style="background:var(--blue)"></span>' : '') + esc(s[0]) + '</span>'; }

function td(l, v, cls) { return '<td data-l="' + esc(l) + '"' + (cls ? ' class="' + cls + '"' : '') + '>' + v + '</td>'; }
function toggleBtn(id, on, label) { return '<button type="button" class="tgl' + (on ? ' on' : '') + '" id="' + id + '" role="switch" aria-checked="' + !!on + '" aria-label="' + esc(label) + '"><span></span></button>'; }
function setToggle(b, on) { b.classList.toggle('on', !!on); b.setAttribute('aria-checked', String(!!on)); }
function btnBusy(b, on, text) {
  if (!b) return;
  if (on) { b.dataset.html = b.innerHTML; b.disabled = true; b.innerHTML = '<span class="spin' + (/b-blue|b-ink|b-bad/.test(b.className) ? ' wh' : '') + '"></span>' + esc(text || 'Working…'); }
  else { b.disabled = false; if (b.dataset.html) b.innerHTML = b.dataset.html; }
}
/* Run an async job with a loading button and always put the button back afterwards (success or error).
   Pass the button ELEMENT, never e.currentTarget after an await: the browser sets currentTarget to null once
   the click handler has returned, so it must be read before the first await. Usage:
     $('#x').onclick = (e) => busy(e.currentTarget, 'Saving…', async () => { ... });
   Returns what fn returns. Errors are re-thrown so callers can show them. */
async function busy(b, text, fn) {
  if (b && b.disabled && b.dataset.busy) return undefined; // already running: ignore double taps
  if (b) b.dataset.busy = '1';
  btnBusy(b, true, text);
  try { return await fn(); }
  finally { if (b) { delete b.dataset.busy; btnBusy(b, false); } }
}

/* 14-day line chart (this period vs previous). Values come from the API. */
function lineChart(host, labels, a, b, opts = {}) {
  const W = 640, H = 230, L = 46, R = 14, T = 16, B = 30;
  const top = Math.max(4, ...a, ...(b || []));
  const step = niceStep(top / 4); const mx = step * 4;
  const x = (i) => L + i * (W - L - R) / Math.max(1, a.length - 1), y = (v) => T + (1 - v / mx) * (H - T - B);
  const path = (arr) => arr.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ');
  let g = '';
  for (let v = 0; v <= mx; v += step) g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="#E9EEF9"/><text x="' + (L - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end" font-size="11" fill="#929BB2" font-weight="700">' + shortNum(v) + '</text>';
  labels.forEach((l, i) => { if (i % 2 === 0 || i === labels.length - 1) g += '<text x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="11" fill="#929BB2" font-weight="700">' + esc(l) + '</text>'; });
  const li = a.length - 1;
  host.innerHTML = '<div class="chsc"><svg viewBox="0 0 ' + W + ' ' + H + '" class="chart" font-family="Plus Jakarta Sans,sans-serif" role="img" aria-label="' + esc(opts.label || 'Chart') + '"><defs><linearGradient id="cg' + (opts.id || '') + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2F6BFF" stop-opacity=".26"/><stop offset="1" stop-color="#2F6BFF" stop-opacity="0"/></linearGradient></defs>' + g +
    '<path d="' + path(a) + ' L' + x(li) + ' ' + y(0) + ' L' + x(0) + ' ' + y(0) + 'Z" fill="url(#cg' + (opts.id || '') + ')"/>' +
    (b ? '<path class="ln" d="' + path(b) + '" fill="none" stroke="#6EC3FF" stroke-width="2.5" stroke-dasharray="5 5" stroke-linejoin="round"/>' : '') +
    '<path class="ln" d="' + path(a) + '" fill="none" stroke="#2F6BFF" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>' +
    '<circle cx="' + x(li) + '" cy="' + y(a[li]) + '" r="6" fill="#fff" stroke="#2F6BFF" stroke-width="3"/></svg></div>';
}
function niceStep(v) { if (v <= 1) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; }
function shortNum(v) { return v >= 1e6 ? (v / 1e6).toFixed(v % 1e6 ? 1 : 0) + 'm' : v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k' : String(Math.round(v * 10) / 10); }
function dayLabel(iso) { const d = new Date(iso + 'T12:00:00'); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }

/* ---------- One-time wiring ---------- */
function appInit() {
  $('#snav').onclick = (e) => { const b = e.target.closest('[data-v]'); if (b) appGo(b.dataset.v); };
  $('#dock').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; if (b.hasAttribute('data-menu')) openDrawer(); else if (b.hasAttribute('data-create')) openCreate(); else appGo(b.dataset.v); };
  $('#ham').onclick = openDrawer; $('#sideX').onclick = closeDrawer; $('#sideOv').onclick = closeDrawer;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDrawer(); closeModal(); $('#mnav').classList.remove('open'); const hc = $('.helpc'); if (hc) hc.remove(); } });
  document.addEventListener('click', (e) => {
    if ($('#v-app').hidden && !e.target.closest('#modalHost')) return;
    const t = e.target;
    const lo = t.closest('[data-logout]'); if (lo) { e.preventDefault(); logout(); return; }
    if (t.closest('[data-avatar-edit]')) { e.preventDefault(); closeDrawer(); openAvatarBuilder({ onSaved: () => renderPage(APP.page || 'overview', APP.q || {}) }); return; }
    const tp = t.closest('[data-topup]'); if (tp) { e.preventDefault(); e.stopPropagation(); closeDrawer(); openTopup(); return; }
    const g = t.closest('[data-go]'); if (g) { e.preventDefault(); closeModal(); appGo(g.dataset.go, g.dataset.q ? parseQuery(g.dataset.q) : null); return; }
    const cn = t.closest('[data-connect]'); if (cn) { e.preventDefault(); closeDrawer(); openConnect(cn.dataset.connect || ''); return; }
    const cr = t.closest('[data-create]'); if (cr && !cr.closest('#dock')) { e.preventDefault(); openCreate(); return; }
    const gd = t.closest('[data-guide]'); if (gd) { e.preventDefault(); openGuide(+gd.dataset.guide || 0); return; }
    const ws = t.closest('[data-ws-switch]'); if (ws) { e.preventDefault(); closeDrawer(); switchWorkspace(); return; }
    const cp = t.closest('[data-copy]'); if (cp) { e.preventDefault(); copyText(cp.dataset.copy, cp.dataset.msg || 'Copied'); }
    if (t.closest('[data-helper-invite]')) { e.preventDefault(); closeModal(); openHelperInvite(); return; }
    if (t.closest('[data-helper-leave]')) { e.preventDefault(); leaveAsHelper(); return; }
    if (t.closest('[data-helper-seen]')) { e.preventDefault(); if (APP.state.helper) APP.state.helper.notice = null; appBanners(); POST('/api/app/team/helper/seen').catch(() => {}); return; }
  });
  paintAll($('#app'));
}

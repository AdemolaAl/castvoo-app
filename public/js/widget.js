'use strict';
/*
 * widget.js: the floating support widget (bottom-right launcher + chat panel), on the website and in the dashboard.
 *
 * Logged in   → the SAME support thread as Help (GET/POST /api/support, image uploads to /api/support/attachments):
 *               the account-aware AI support team with tools, and the human team when needed.
 * Logged out  → the website pre-sales chat (POST /api/public/chat): product answers only, no account tools, no images.
 *               Without the website chat: a short "log in or email us" card.
 *
 * Closed: GET /api/support/unread every 25 s (visible tab only) shows a badge when the AI or the team replied.
 * Opening the chat marks it seen (GET /api/support). Hidden on the Help page itself, during sign-up, while the
 * VooSquare widget is in use on the website, and on small screens while the keyboard is up for another field.
 * Phones: the panel is a full-screen sheet; the page behind is locked without jumping to the top.
 * Desktop: a 380×600 panel. Esc closes, Tab stays inside the panel, focus returns to the launcher.
 */

const SW = {
  el: null, open: false, view: null, mode: null,
  d: null, site: { msgs: [], busy: false },
  pend: [], unread: 0, busy: false, fastUntil: 0, lastKey: '', pollT: null, unreadT: null, greetT: null,
  scrollY: 0, locked: false, lastFocus: null,
};

const swSmall = () => window.matchMedia('(max-width:600px)').matches;
const swFine = () => window.matchMedia('(pointer:fine)').matches;
const swIn = () => !!(ME && ME.user && (ME.workspaces || []).length);
/* The faces on the launcher and header: the live team from the site config, else the first agent, else Cas. */
function swTeam() {
  const t = (CFG.support_team || []).filter((p) => p && p.avatar);
  if (t.length) return t;
  return CFG.site_chat && CFG.site_chat.agent && CFG.site_chat.agent.avatar ? [CFG.site_chat.agent] : [];
}
function swFaces(n, size) {
  const t = swTeam().slice(0, n);
  if (!t.length) return '<span class="sw-cas" data-cas="mini"></span>';
  return t.map((p) => '<img src="' + esc(p.avatar) + '" alt="" width="' + size + '" height="' + size + '">').join('');
}
const swAgentFace = (url, name) => (url ? '<img class="sw-av" src="' + esc(url) + '" alt="" width="30" height="30" loading="lazy">' : '<span class="sw-av team" aria-hidden="true">' + esc(String(name || 'C')[0]) + '</span>');

/* ---------- mount / show / hide ---------- */
function swMount() {
  if (SW.el) return SW.el;
  const w = document.createElement('div');
  w.className = 'swg'; w.id = 'sw';
  w.innerHTML = '<div class="sw-greet" id="swG" hidden></div>' +
    '<button type="button" class="sw-l" id="swL" aria-expanded="false" aria-controls="swP" aria-label="Open support chat"><span class="sw-fc" id="swLF"></span><span class="sw-ic" aria-hidden="true"><svg class="i1"><use href="#i-chat"/></svg><svg class="i2"><use href="#i-x"/></svg></span><span class="sw-bd" id="swB" hidden></span></button>' +
    '<div class="sw-p" id="swP" role="dialog" aria-modal="true" aria-labelledby="swT" hidden></div>';
  document.body.appendChild(w);
  SW.el = w;
  $('#swL').onclick = () => (SW.open ? swClose() : swOpen());
  w.addEventListener('keydown', swKeys);
  // Small screens: get out of the way while the keyboard is up for a field on the page (the composer, a form).
  document.addEventListener('focusin', (e) => { const t = e.target; if (window.innerWidth <= 980 && t && !t.closest('#sw') && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) && !/^(checkbox|radio|button|submit|file)$/.test(t.type || '')) w.classList.add('kb'); });
  document.addEventListener('focusout', () => setTimeout(() => { const a = document.activeElement; if (!a || !(/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable) || a.closest('#sw')) w.classList.remove('kb'); }, 60));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) swUnreadTick(); });
  if (window.visualViewport) { visualViewport.addEventListener('resize', swFit); visualViewport.addEventListener('scroll', swFit); }
  return w;
}

/* Called by renderHelp(view) on every view change and when the config or login state arrives. */
function swSync(view) {
  if (view !== undefined) SW.view = view;
  const w = swMount();
  const helpPage = SW.view === 'app' && /^#app\/help\b/.test(location.hash);
  const off = !SW.view || SW.view === 'signup' || helpPage || CFG.features.support_chat === false && !CFG.site_chat && !swIn();
  if (off && SW.open) swClose(true);
  w.hidden = off;
  w.classList.toggle('in-app', SW.view === 'app');
  w.classList.toggle('in-site', SW.view === 'site');
  const mode = swIn() && CFG.features.support_chat !== false ? 'acct' : CFG.site_chat ? 'site' : 'contact';
  if (mode !== SW.mode) { SW.mode = mode; SW.d = null; SW.lastKey = ''; if (SW.open) swRenderPanel(); }
  $('#swLF').innerHTML = swFaces(3, 30) + '<span class="sdot sw-on" aria-hidden="true"></span>';
  paintCas($('#swLF'));
  swBadge();
  if (!off) { swUnreadLoop(); swGreetLater(); }
}

/* ---------- greeting bubble (website only, once) ---------- */
function swGreetLater() {
  if (SW.greetT || SW.view !== 'site' || store.get('cv_sw_greet')) return;
  SW.greetT = setTimeout(() => {
    if (SW.view !== 'site' || SW.open || store.get('cv_sw_greet') || SW.el.hidden) return;
    store.set('cv_sw_greet', '1');
    const a = swTeam()[0];
    const name = a ? a.name : 'the Castvoo team';
    const g = $('#swG');
    g.innerHTML = '<button type="button" class="sw-gx" aria-label="Dismiss">' + icon('x') + '</button><button type="button" class="sw-gb">' + (a ? '<img src="' + esc(a.avatar) + '" alt="" width="36" height="36">' : '') + '<span><b>Hi 👋 I\'m ' + esc(name) + (a ? ' from Castvoo' : '') + '.</b> Questions about welcome bots?</span></button>';
    g.hidden = false;
    $('.sw-gx', g).onclick = () => { g.hidden = true; };
    $('.sw-gb', g).onclick = () => { g.hidden = true; swOpen(); };
  }, 20000);
}

/* ---------- unread badge (closed, logged in) ---------- */
function swBadge() {
  const b = $('#swB'); if (!b) return;
  const n = SW.open ? 0 : SW.unread;
  b.hidden = !n; b.textContent = n > 9 ? '9+' : String(n);
  $('#swL').setAttribute('aria-label', SW.open ? 'Close support chat' : 'Open support chat' + (n ? ' (' + plural(n, 'new reply', 'new replies') + ')' : ''));
}
function swUnreadLoop() {
  if (SW.unreadT) return;
  SW.unreadT = setInterval(swUnreadTick, 25000);
  setTimeout(swUnreadTick, 1500);
}
async function swUnreadTick() {
  if (SW.open || document.hidden || SW.mode !== 'acct' || !SW.el || SW.el.hidden) return;
  try { const r = await GET('/api/support/unread'); SW.unread = Number(r.unread) || 0; swBadge(); } catch (_) { /* try later */ }
}

/* ---------- open / close ---------- */
function swLock() {
  if (SW.locked || !swSmall()) return;
  SW.locked = true;
  SW.scrollY = window.scrollY || document.documentElement.scrollTop || 0;
  const b = document.body.style;
  b.position = 'fixed'; b.top = -SW.scrollY + 'px'; b.left = '0'; b.right = '0'; b.width = '100%';
  document.documentElement.classList.add('sw-lock');
}
function swUnlock() {
  if (!SW.locked) return;
  SW.locked = false;
  const b = document.body.style;
  b.position = ''; b.top = ''; b.left = ''; b.right = ''; b.width = '';
  document.documentElement.classList.remove('sw-lock');
  // Back to the same place, instantly (the page has smooth scrolling on, which would visibly scroll).
  const h = document.documentElement, prev = h.style.scrollBehavior;
  h.style.scrollBehavior = 'auto'; window.scrollTo(0, SW.scrollY); h.style.scrollBehavior = prev;
}
/* Phones: keep the panel the size of what is visible above the keyboard. */
function swFit() {
  const p = $('#swP');
  if (!p || !SW.open || !swSmall() || !window.visualViewport) { if (p) { p.style.height = ''; p.style.transform = ''; } return; }
  p.style.height = Math.round(visualViewport.height) + 'px';
  p.style.transform = 'translateY(' + Math.round(visualViewport.offsetTop) + 'px)';
}

function swOpen() {
  swMount();
  if (SW.open) return;
  SW.open = true;
  SW.lastFocus = document.activeElement;
  $('#swG').hidden = true;
  store.set('cv_sw_greet', '1');
  SW.el.classList.add('open');
  $('#swL').setAttribute('aria-expanded', 'true');
  swLock();
  const p = $('#swP'); p.hidden = false;
  swRenderPanel();
  swFit();
  SW.unread = 0; swBadge();
  requestAnimationFrame(() => p.classList.add('in'));
  setTimeout(() => { const i = $('#swQ'); if (i && swFine()) i.focus({ preventScroll: true }); else { const x = $('#swX'); if (x) x.focus({ preventScroll: true }); } }, 60);
  if (SW.mode === 'acct') swRefresh(true);
  clearInterval(SW.pollT);
  let tick = 0;
  SW.pollT = setInterval(() => { tick++; if (SW.mode === 'acct' && !document.hidden && (Date.now() < SW.fastUntil || tick % 6 === 0)) swRefresh(); }, 1500);
}
function swClose(quiet) {
  if (!SW.open) return;
  SW.open = false;
  clearInterval(SW.pollT);
  const p = $('#swP');
  p.classList.remove('in');
  SW.el.classList.remove('open');
  $('#swL').setAttribute('aria-expanded', 'false');
  swUnlock();
  p.style.height = ''; p.style.transform = '';
  setTimeout(() => { if (!SW.open) p.hidden = true; }, quiet ? 0 : 220);
  swBadge();
  if (!quiet) { const f = SW.lastFocus && document.contains(SW.lastFocus) && SW.lastFocus !== document.body && SW.lastFocus.offsetParent !== null && !SW.lastFocus.closest('.sw-greet') ? SW.lastFocus : $('#swL'); try { f.focus({ preventScroll: true }); } catch (_) { /* gone */ } }
}
function swKeys(e) {
  if (!SW.open) return;
  if (e.key === 'Escape') { e.preventDefault(); const lb = $('.lbx'); if (lb) return; swClose(); return; }
  if (e.key !== 'Tab') return;
  const p = $('#swP');
  const f = $$('button:not([disabled]),[href],input:not([type=file]):not([disabled]),textarea:not([disabled]),label.sw-att,[tabindex]:not([tabindex="-1"])', p).filter((x) => x.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && (document.activeElement === first || !p.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (document.activeElement === last || !p.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
}

/* ---------- the panel ---------- */
const swStatus = (human) => '<span class="sdot' + (human ? ' h' : '') + '"></span><span>' + (human ? 'A teammate is on this chat<span class="sw-l2">24/7 customer support</span>' : '24/7 customer support<span class="sw-l2">Replies in seconds</span>') + '</span>';
function swRenderPanel() {
  const p = $('#swP');
  const opt = (SW.d && SW.d.chat) || {};
  const powered = SW.mode === 'acct' ? opt.powered_by : CFG.site_chat && CFG.site_chat.powered_by;
  const imgs = SW.mode === 'acct' ? opt.images !== false : false;
  const human = SW.mode === 'acct' && SW.d && SW.d.thread && SW.d.thread.with_human;
  p.innerHTML = '<div class="sw-h"><span class="sw-hf" aria-hidden="true">' + swFaces(3, 38) + '</span><div class="sw-ht"><b id="swT">Castvoo support</b><small id="swSt">' + swStatus(human) + '</small></div>' +
    '<button type="button" class="sw-x" id="swX" aria-label="Close support chat">' + icon('x') + '</button></div>' +
    '<div class="sw-m" id="swM" aria-live="polite" aria-relevant="additions"></div>' +
    '<div class="sw-acts" id="swA"></div>' +
    (SW.mode === 'contact' ? '' :
      '<form class="sw-f" id="swF"><div class="sw-pics" id="swPics" hidden></div><div class="sw-row">' +
      (imgs ? '<label class="sw-att" tabindex="0" role="button" aria-label="Attach a photo or screenshot"><input type="file" id="swFile" accept="image/*" multiple hidden>' + icon('image') + '</label>'
        : SW.mode === 'site' ? '<button type="button" class="sw-att off" id="swNoImg" aria-label="Log in to send screenshots" title="Log in to send screenshots">' + icon('image') + '</button>' : '') +
      '<textarea id="swQ" rows="1" maxlength="' + (SW.mode === 'acct' ? 4000 : 1000) + '" placeholder="' + (SW.mode === 'acct' ? 'Write a message…' : 'Ask about Castvoo…') + '" aria-label="Your message" enterkeyhint="send"></textarea>' +
      '<button type="submit" class="sw-send" aria-label="Send">' + icon('send') + '</button></div><p class="sw-tip" id="swTip" hidden></p></form>') +
    (powered ? '<div class="sw-pw">' + poweredBy(powered) + '</div>' : '') +
    (imgs ? '<div class="sw-drop" id="swDrop" hidden><span>' + icon('image') + 'Drop your screenshot to attach it</span></div>' : '');
  paintCas(p);
  $('#swX').onclick = () => swClose();
  $('#swM').onclick = (e) => { const b = e.target.closest('[data-lb]'); if (b) openLightbox(b.dataset.lb); if (e.target.closest('a[href^="#"]')) swClose(true); };
  swActs();
  swDraw(true);
  const f = $('#swF');
  if (!f) return;
  const q = $('#swQ');
  const grow = () => { q.style.height = 'auto'; q.style.height = Math.min(q.scrollHeight, 120) + 'px'; };
  q.addEventListener('input', grow);
  q.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && swFine()) { e.preventDefault(); f.requestSubmit(); } };
  f.onsubmit = (e) => { e.preventDefault(); swSend(); };
  const no = $('#swNoImg'); if (no) no.onclick = () => swTip('<a href="#login">Log in</a> to send screenshots. Here you can ask about Castvoo in words.');
  if (imgs) swWireImages();
  swDrawPend();
}
function swTip(h) { const t = $('#swTip'); if (!t) return; t.innerHTML = h; t.hidden = false; clearTimeout(swTip.t); swTip.t = setTimeout(() => { t.hidden = true; }, 6000); }

/* Quick actions under the chat: starter questions on the website chat. */
function swActs() {
  const A = $('#swA'); if (!A) return;
  const s = CFG.support || {};
  let h = '';
  if (SW.mode === 'site' && !SW.site.msgs.length) h += ['What does Castvoo do?', 'How much does it cost?', 'How do I pay from Nigeria?'].map((t) => '<button type="button" class="sw-chip" data-q>' + esc(t) + '</button>').join('');
  if (SW.mode === 'contact') h = '<a class="btn b-blue sm" href="#login">Log in to chat</a><a class="btn b-ghost sm" href="mailto:' + esc(s.email) + '">' + icon('mail') + 'Email us</a>';
  A.innerHTML = h;
  A.onclick = (e) => {
    const q = e.target.closest('[data-q]'); if (q) { swSiteAsk(q.textContent); return; }
    if (e.target.closest('a[href^="#"]')) swClose(true);
  };
}

/* ---------- messages ---------- */
function swMine(size) { return typeof myAva === 'function' ? myAva(size, 'sw-me') : ''; }
function swDraw(force) {
  const L = $('#swM'); if (!L) return;
  let h = '';
  const team = swTeam();
  const a0 = team[0];
  if (SW.mode === 'acct') {
    const d = SW.d;
    if (!d) { L.innerHTML = '<div class="sw-load"><span class="spin"></span></div>'; return; }
    const key = d.messages.map((m) => m.id + ':' + (m.attachments || []).length).join(',') + '|' + (d.typing ? d.typing.name : '') + '|' + !!(d.thread && d.thread.with_human);
    if (!force && key === SW.lastKey) return;
    SW.lastKey = key;
    const ms = d.messages;
    const tm = (d.ai && d.ai.team) || [];
    const first = tm[0] || a0;
    if (!ms.length) h += swBubble({ mine: false, first: true, last: true, face: first ? swAgentFace(first.avatar, first.name) : '<span class="sw-av team">C</span>', name: first ? first.name : 'Castvoo', html: 'Hi' + (ME.user && typeof greetName === 'function' && greetName() ? ' ' + esc(greetName()) : '') + '! 👋 I\'m ' + esc(first ? first.name : 'from Castvoo') + '. Ask me anything about setup, sending, payments or your bot. I can check your account for you' + ((d.chat || {}).images !== false ? ', and you can send me a screenshot' : '') + '.' });
    ms.forEach((m, i) => {
      const mine = m.author_type === 'user';
      const same = (x) => x && (x.author_type === 'user') === mine && (mine || x.author_name === m.author_name);
      const fst = !same(ms[i - 1]);
      const lst = !same(ms[i + 1]) && !(d.typing && !mine && i === ms.length - 1 && d.typing.name === m.author_name);
      const pics = (m.attachments || []).length ? '<span class="cpics n' + Math.min(m.attachments.length, 3) + '">' + m.attachments.map((x) => '<button type="button" class="cpic" data-lb="' + esc(x.url) + '" aria-label="Open image"><img src="' + esc(x.url) + '" alt="Image"></button>').join('') + '</span>' : '';
      h += swBubble({ mine, first: fst, last: lst, face: mine ? swMine(30) : swAgentFace(m.avatar, m.author_name), name: m.author_name || 'Castvoo team', staff: m.author_type === 'staff', html: pics + (m.body ? esc(m.body).replace(/\n/g, '<br>') : ''), time: lst ? (m.sending ? 'Sending…' : fmtDate(m.created_at)) : '' });
    });
    if (d.typing) h += swTyping(d.typing.avatar, d.typing.name);
  } else if (SW.mode === 'site') {
    const ag = (CFG.site_chat && CFG.site_chat.agent) || a0 || { name: 'Castvoo', avatar: null };
    const face = swAgentFace(ag.avatar, ag.name);
    h += swBubble({ mine: false, first: true, last: !SW.site.msgs.length || SW.site.msgs[0].role === 'user', face, name: ag.name, html: 'Hi! 👋 I\'m ' + esc(ag.name) + '. Ask me anything about Castvoo: what it does, prices, payments or setup.' });
    SW.site.msgs.forEach((m, i) => {
      const mine = m.role === 'user';
      const nx = SW.site.msgs[i + 1], pv = i ? SW.site.msgs[i - 1] : { role: 'assistant' };
      const lst = !(nx && nx.role === m.role) && !(SW.site.busy && !mine && i === SW.site.msgs.length - 1);
      h += swBubble({ mine, first: pv.role !== m.role, last: lst, face: mine ? '' : face, name: ag.name, html: m.html || esc(m.content).replace(/\n/g, '<br>') });
    });
    if (SW.site.busy) h += swTyping(ag.avatar, ag.name);
  } else {
    h += swBubble({ mine: false, first: true, last: true, face: a0 ? swAgentFace(a0.avatar, a0.name) : '<span class="sw-av team">C</span>', name: a0 ? a0.name : 'Castvoo', html: 'Hi! 👋 Log in and our 24/7 support team answers right here, with the human team on call. You can also email <a href="mailto:' + esc((CFG.support || {}).email) + '">' + esc((CFG.support || {}).email) + '</a>.' });
  }
  const atBottom = L.scrollHeight - L.scrollTop - L.clientHeight < 90;
  L.innerHTML = h;
  paintCas(L);
  if (atBottom || force) {
    L.scrollTop = L.scrollHeight;
    $$('img', L).forEach((im) => { if (!im.complete) im.addEventListener('load', () => { L.scrollTop = L.scrollHeight; }, { once: true }); });
  }
}
function swBubble(o) {
  const ava = o.last ? (o.face || '') : '<span class="sw-av sp" aria-hidden="true"></span>';
  const nm = !o.mine && o.first ? '<small class="sw-n">' + esc(o.name) + (o.staff ? ' <span class="steam-tag">Team</span>' : '') + '</small>' : '';
  return '<div class="sw-msg ' + (o.mine ? 'u' : 'a') + (o.first ? ' first' : '') + (o.last ? ' last' : '') + '">' + (o.mine && !o.face ? '' : ava) + '<div class="sw-b">' + nm + o.html + (o.time ? '<small class="sw-tm">' + esc(o.time) + '</small>' : '') + '</div></div>';
}
function swTyping(url, name) {
  return '<div class="sw-msg a typing first last">' + swAgentFace(url, name) + '<div class="sw-b"><span class="tg-typing in"><i></i><i></i><i></i></span></div><span class="sw-tl">' + esc(name) + ' is typing…</span></div>';
}

async function swRefresh(force) {
  if (SW.busy || SW.mode !== 'acct') return;
  SW.busy = true;
  try {
    const was = SW.d;
    const n = await GET('/api/support');
    const pending = (was && was.messages || []).filter((m) => String(m.id).startsWith('tmp') && !n.messages.some((x) => x.author_type === 'user' && x.body === m.body));
    SW.d = { ...n, messages: n.messages.concat(pending) };
    if (n.typing) SW.fastUntil = Math.max(SW.fastUntil, Date.now() + 15000);
    if (!SW.open) { SW.busy = false; return; }
    const human = SW.d.thread && SW.d.thread.with_human;
    const st = $('#swSt'); if (st) st.innerHTML = swStatus(human);
    // The first answer brings the chat options (images on or off, the footer): draw the full panel once.
    if (!was || !!(was.chat && was.chat.images !== false) !== !!(n.chat && n.chat.images !== false)) { const q = $('#swQ'); const keep = q ? q.value : ''; swRenderPanel(); const q2 = $('#swQ'); if (q2 && keep) q2.value = keep; }
    else { swDraw(force); swActs(); }
    if (typeof APP !== 'undefined' && APP.state && APP.state.support_unread) { APP.state.support_unread = 0; if (typeof shellUI === 'function') shellUI(); }
  } catch (ex) {
    if (ex && ex.status === 401) { SW.mode = null; swSync(); }
  }
  SW.busy = false;
}

/* ---------- sending ---------- */
async function swSend() {
  const q = $('#swQ'); if (!q) return;
  const t = q.value.trim();
  if (SW.mode === 'site') { if (t) { q.value = ''; q.style.height = ''; swSiteAsk(t); } return; }
  if (SW.pend.some((x) => x.st === 'up')) { swTip('Wait a second, your image is still uploading.'); return; }
  const ready = SW.pend.filter((x) => x.st === 'ok');
  if (!t && !ready.length) return;
  const b = $('.sw-send'); btnBusy(b, true, '');
  try {
    await POST('/api/support', { body: t, attachments: ready.map((x) => x.att.id) });
    q.value = ''; q.style.height = '';
    if (!SW.d) SW.d = { messages: [] };
    SW.d.messages = SW.d.messages.concat([{ id: 'tmp' + Date.now(), author_type: 'user', body: t, created_at: new Date().toISOString(), sending: true, attachments: ready.map((x) => ({ id: x.att.id, url: x.att.url })) }]);
    SW.pend = []; swDrawPend();
    swDraw(true);
    SW.fastUntil = Date.now() + 90000;
    setTimeout(() => swRefresh(), 600);
  } catch (ex) { apiErr(ex); }
  btnBusy(b, false);
  if (swFine()) q.focus();
}
async function swSiteAsk(text) {
  const t = String(text || '').trim();
  const S = SW.site;
  if (!t || S.busy) return;
  const history = S.msgs.filter((m) => !m.html).slice(-10).map((m) => ({ role: m.role, content: m.content }));
  S.msgs.push({ role: 'user', content: t });
  S.busy = true; swDraw(true); swActs();
  try {
    const r = await POST('/api/public/chat', { message: t, history });
    S.busy = false;
    for (const [i, b] of r.bubbles.entries()) {
      if (i) { S.busy = true; swDraw(true); await new Promise((ok) => setTimeout(ok, Math.min(1800, 500 + b.length * 12))); S.busy = false; }
      S.msgs.push({ role: 'assistant', content: b }); swDraw(true);
    }
  } catch (ex) {
    S.busy = false;
    S.msgs.push({ role: 'assistant', content: (ex && ex.message) || 'Sorry, chat is busy. Email us and we\'ll help.' });
    swDraw(true);
  }
}

/* ---------- images (logged in) ---------- */
function swDrawPend() {
  const P = $('#swPics'); if (!P) return;
  P.hidden = !SW.pend.length;
  P.innerHTML = SW.pend.map((x) => '<span class="cmp-pic ' + x.st + '"><img src="' + esc(x.url) + '" alt="">' + (x.st === 'up' ? '<i class="spin"></i>' : x.st === 'err' ? '<b title="' + esc(x.err || '') + '">!</b>' : '') + '<button type="button" class="cmp-x" data-rmp="' + x.k + '" aria-label="Remove image">' + icon('x') + '</button></span>').join('');
}
function swAddFiles(files) {
  const opt = (SW.d && SW.d.chat) || {};
  const max = opt.max_images || 3, mb = opt.max_mb || 10;
  for (const f of [...(files || [])]) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) { swTip('Send a JPG, PNG or WEBP image. On iPhone, screenshots and most photos work.'); continue; }
    if (f.size > mb * 1048576) { swTip('Images can be up to ' + mb + ' MB. Send a smaller screenshot.'); continue; }
    if (SW.pend.length >= max) { swTip('Send up to ' + max + ' images in one message.'); break; }
    const x = { k: Math.random().toString(36).slice(2), url: URL.createObjectURL(f), st: 'up' };
    SW.pend.push(x);
    uploadTo('/api/support/attachments', 'attachment', f).then((att) => { x.att = att; x.st = 'ok'; swDrawPend(); }).catch((ex) => { x.st = 'err'; x.err = ex.message; swDrawPend(); swTip(esc(ex.message)); });
  }
  swDrawPend();
}
function swWireImages() {
  const inp = $('#swFile'), lab = $('.sw-att');
  inp.onchange = (e) => { swAddFiles(e.target.files); e.target.value = ''; };
  lab.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inp.click(); } };
  $('#swQ').addEventListener('paste', (e) => { const fs = [...((e.clipboardData && e.clipboardData.files) || [])].filter((f) => f.type.startsWith('image/')); if (fs.length) { e.preventDefault(); swAddFiles(fs); } });
  const p = $('#swP'), dz = $('#swDrop');
  let depth = 0;
  p.ondragenter = (e) => { if ([...(e.dataTransfer.types || [])].includes('Files')) { depth++; dz.hidden = false; e.preventDefault(); } };
  p.ondragover = (e) => { if ([...(e.dataTransfer.types || [])].includes('Files')) e.preventDefault(); };
  p.ondragleave = () => { depth = Math.max(0, depth - 1); if (!depth) dz.hidden = true; };
  p.ondrop = (e) => { e.preventDefault(); depth = 0; dz.hidden = true; swAddFiles(e.dataTransfer.files); };
  $('#swPics').onclick = (e) => { const b = e.target.closest('[data-rmp]'); if (!b) return; const x = SW.pend.find((y) => y.k === b.dataset.rmp); if (x) URL.revokeObjectURL(x.url); SW.pend = SW.pend.filter((y) => y.k !== b.dataset.rmp); swDrawPend(); };
}

addEventListener('hashchange', () => { if (SW.el) swSync(); });

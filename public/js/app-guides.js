'use strict';
/*
 * app-guides.js: the "Guides" page (voiced video tutorials), the video player pop-up and the
 * "Watch the guide" links on other pages.
 *   #app/guides            all guides, with "watched" ticks (kept in this browser only)
 *   #app/guides?play=<id>  opens one guide in the player
 * Anywhere: <button data-vguide="<id>"> opens that guide (guideLink(id) builds one).
 * Add data-vset="<set>" to limit the player's list and "Next" to one set (VG_SETS): the public homepage uses "site",
 * so logged-out visitors only see its 4 videos and the last one ends with "Start free" instead of "See all guides".
 * Files: public/videos/<id>.mp4 (H.264 + AAC), <id>.vtt (captions), <id>.jpg (poster). The server answers Range requests.
 * To change a video: replace its 3 files and bump GUIDE_V so browsers fetch the new ones.
 */

const GUIDE_V = 1;
const VGUIDES = [
  { id: 'connect-bot', title: 'Connect your Telegram bot', text: 'Make a bot with @BotFather and connect it in a minute.', dur: 75, pages: ['bots'] },
  { id: 'add-channel', title: 'Add a channel or group', text: 'Link your Telegram, then connect a channel or group in one tap.', dur: 74, pages: ['bots'] },
  { id: 'welcome-flow', title: 'Build a Welcome Flow', text: 'Welcome, let in and follow up everyone who asks to join.', dur: 104, pages: ['flows'] },
  { id: 'send-broadcast', title: 'Send a broadcast', text: 'A personal message with {name}, buttons and scheduling.', dur: 79, pages: ['broadcast', 'calendar'] },
  { id: 'auto-follow-ups', title: 'Auto follow-ups', text: 'Messages your bot sends by itself, on a timer.', dur: 72, pages: ['drips'] },
  { id: 'audiences-start-links', title: 'Audiences & start links', text: 'See which ad brought each subscriber, then message just them.', dur: 71, pages: ['audiences', 'subscribers', 'clicks'] },
  { id: 'wallet-plans', title: 'Wallet, plans & the Free plan', text: 'Top up, pick a plan, and what happens on Free.', dur: 84, pages: ['wallet'] },
  { id: 'referrals-help', title: 'Earn with referrals & get help', text: 'Share your link, earn monthly, and chat with support 24/7.', dur: 85, pages: ['earn', 'help'] },
];
/* Smaller sets of guides for places outside the dashboard. */
const VG_SETS = { site: ['welcome-flow', 'connect-bot', 'send-broadcast', 'wallet-plans'] };
const vgSrc = (id, ext) => '/videos/' + id + '.' + ext + '?v=' + GUIDE_V;
const vgTime = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

/* Watched ticks live in this browser only (localStorage through store, which never throws). */
function vgSeen() { try { const v = JSON.parse(store.get('cv_guides_seen') || '{}'); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; } }
function vgMarkSeen(id) { const s = vgSeen(); if (s[id]) return; s[id] = Date.now(); store.set('cv_guides_seen', JSON.stringify(s)); vgNavTag(); }
function vgNavTag() {
  const t = $('#navGuides'); if (!t) return;
  const left = VGUIDES.filter((g) => !vgSeen()[g.id]).length;
  t.textContent = left ? String(left) : '✓'; t.title = left ? left + ' not watched yet' : 'All watched';
}

/* A small "Watch the guide" button for a page. */
function guideLink(id, label) {
  const g = VGUIDES.find((x) => x.id === id); if (!g) return '';
  const seen = vgSeen()[id];
  return '<button type="button" class="vgl' + (seen ? ' seen' : '') + '" data-vguide="' + esc(id) + '"><span class="vgl-p">' + icon(seen ? 'check' : 'play') + '</span><span><b>' + esc(label || 'Watch the guide') + '</b><small>' + (label === g.title ? (seen ? 'Watched' : 'Video guide') : esc(g.title)) + ' · ' + vgTime(g.dur) + '</small></span></button>';
}
/* Every guide for a dashboard page, as a row of links (or ''). */
function guideLinksFor(page) { const l = VGUIDES.filter((g) => g.pages.includes(page)); return l.length ? '<div class="vgls">' + l.map((g) => guideLink(g.id, l.length > 1 ? g.title : 'Watch the guide')).join('') + '</div>' : ''; }

function vgCard(g, i, seen) {
  return '<button type="button" class="vgc' + (seen ? ' seen' : '') + '" data-vguide="' + esc(g.id) + '"><span class="vgc-th"><img src="' + vgSrc(g.id, 'jpg') + '" alt="" loading="lazy" width="640" height="360"><span class="vgc-pl">' + icon('play') + '</span><span class="vgc-d">' + vgTime(g.dur) + '</span>' + (seen ? '<span class="vgc-ok">' + icon('check') + 'Watched</span>' : '') + '</span>' +
    '<span class="vgc-b"><span class="vgc-n">' + String(i + 1).padStart(2, '0') + '</span><span><b>' + esc(g.title) + '</b><small>' + esc(g.text) + '</small></span></span></button>';
}

PAGES.guides = {
  title: 'Guides', sub: 'Short video tutorials, with voice and captions',
  async render(el, q) {
    const seen = vgSeen();
    const n = VGUIDES.filter((g) => seen[g.id]).length;
    const total = VGUIDES.reduce((a, g) => a + g.dur, 0);
    const next = VGUIDES.find((g) => !seen[g.id]) || VGUIDES[0];
    el.innerHTML = '<div class="box vgh"><div class="vgh-l"><span class="kick" style="color:#CFE0FF">Training</span><h2>Learn Castvoo in ' + VGUIDES.length + ' short videos.</h2><p>Each guide shows the real dashboard, step by step, in about a minute. About ' + Math.round(total / 60) + ' minutes in all.</p>' +
      '<div class="vgh-a"><button type="button" class="btn b-w" data-vguide="' + esc(next.id) + '">' + icon('play') + (n ? 'Continue: ' + esc(next.title) : 'Start with guide 1') + '</button></div></div>' +
      '<div class="vgh-r"><div class="vgring" style="--p:' + Math.round(n / VGUIDES.length * 100) + '"><b class="tnum"><span>' + n + '<small>/' + VGUIDES.length + '</small></span></b></div><small>watched</small></div></div>' +
      '<div class="vgg">' + VGUIDES.map((g, i) => vgCard(g, i, seen[g.id])).join('') + '</div>' +
      '<p class="hint" style="text-align:center">Ticks are saved in this browser. Questions after watching? <a href="#app/help">Chat with us</a>.</p>';
    if (q.play) { history.replaceState(null, '', '#app/guides'); openVideoGuide(q.play); }
  },
};

/* ---------- The player ---------- */
const VG_SPEEDS = [1, 1.25, 1.5, 1.75, 0.75];
const VG_ICON = {
  cc: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10.5 10.2a2.3 2.3 0 1 0 0 3.6M17 10.2a2.3 2.3 0 1 0 0 3.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  fs: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  vol: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  mute: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M16 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  replay: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v3.8h3.8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
let VG = null; // the open player: { id, v, root, cleanup() }

function vgCaptionsOn() { return store.get('cv_guides_cc') !== '0'; }

function openVideoGuide(id, set) {
  const g = VGUIDES.find((x) => x.id === id); if (!g) return;
  const list = (set && VG_SETS[set] ? VG_SETS[set].map((k) => VGUIDES.find((x) => x.id === k)).filter(Boolean) : VGUIDES);
  if (!list.includes(g)) set = null;
  const L = set ? list : VGUIDES;
  closeVideoGuide(true);
  closeModal();
  const i = L.indexOf(g);
  const nextG = L[i + 1];
  const host = document.createElement('div');
  host.className = 'vg-ov';
  host.innerHTML = '<div class="vg" role="dialog" aria-modal="true" aria-label="' + esc(g.title) + ' (video guide)">' +
    '<div class="vg-hd"><span class="vg-no">' + String(i + 1).padStart(2, '0') + '</span><div style="min-width:0;flex:1"><b class="ell">' + esc(g.title) + '</b><small class="ell">' + esc(g.text) + '</small></div><button type="button" class="vg-x" data-vx aria-label="Close video">' + icon('x') + '</button></div>' +
    '<div class="vg-st" tabindex="-1">' +
      '<video class="vg-v" playsinline preload="metadata" poster="' + vgSrc(g.id, 'jpg') + '"><source src="' + vgSrc(g.id, 'mp4') + '" type="video/mp4"><track kind="captions" srclang="en" label="English" src="' + vgSrc(g.id, 'vtt') + '" default></video>' +
      '<div class="vg-cap" aria-hidden="true"></div>' +
      '<button type="button" class="vg-big" data-vplay aria-label="Play">' + icon('play') + '</button>' +
      '<div class="vg-end" hidden><span class="vg-done">' + icon('check') + 'Watched</span>' + (nextG ? '<button type="button" class="btn b-blue sm" data-vnext>' + icon('play') + 'Next: ' + esc(nextG.title) + '</button>' : (set ? '<a class="btn b-blue sm" href="#signup" data-vsignup>Start free' + icon('arrow') + '</a>' : '<button type="button" class="btn b-blue sm" data-vall>See all guides</button>')) + '<button type="button" class="vg-rep" data-vrep>' + VG_ICON.replay + 'Watch again</button></div>' +
      '<div class="vg-ctl">' +
        '<div class="vg-bar" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="' + g.dur + '" aria-valuenow="0"><span class="vg-buf"></span><span class="vg-fill"></span><span class="vg-knob"></span><span class="vg-tip" hidden></span></div>' +
        '<div class="vg-row"><button type="button" class="vg-b" data-vplay aria-label="Play">' + icon('play') + '</button>' +
          '<button type="button" class="vg-b hide-xs" data-vmute aria-label="Mute">' + VG_ICON.vol + '</button>' +
          '<span class="vg-t tnum"><span data-vcur>0:00</span> / <span data-vdur>' + vgTime(g.dur) + '</span></span><span style="flex:1"></span>' +
          '<button type="button" class="vg-b vg-sp" data-vspeed aria-label="Playback speed">1×</button>' +
          '<button type="button" class="vg-b" data-vcc aria-label="Captions" aria-pressed="false">' + VG_ICON.cc + '</button>' +
          '<button type="button" class="vg-b" data-vfs aria-label="Full screen">' + VG_ICON.fs + '</button></div>' +
      '</div>' +
    '</div>' +
    '<div class="vg-list">' + L.map((x, k) => '<button type="button" class="vg-li' + (x.id === id ? ' on' : '') + (vgSeen()[x.id] ? ' seen' : '') + '" data-vgo="' + esc(x.id) + '"><span>' + (vgSeen()[x.id] ? icon('check') : String(k + 1)) + '</span>' + esc(x.title) + '</button>').join('') + '</div>' +
  '</div>';
  document.body.appendChild(host);
  document.body.classList.add('noscroll');
  const root = $('.vg', host), st = $('.vg-st', host), v = $('video', host), bar = $('.vg-bar', host), cap = $('.vg-cap', host);
  const playBtns = $$('[data-vplay]', host);
  let hideT = null, dragging = false, ccOn = vgCaptionsOn(), speedI = 0;
  const showCtl = () => { st.classList.remove('idle'); clearTimeout(hideT); if (!v.paused) hideT = setTimeout(() => { if (!dragging) st.classList.add('idle'); }, 2600); };
  const setPlayIcons = () => {
    const p = !v.paused && !v.ended;
    st.classList.toggle('playing', p);
    playBtns.forEach((b) => { b.setAttribute('aria-label', p ? 'Pause' : 'Play'); if (!b.classList.contains('vg-big')) b.innerHTML = icon(p ? 'pause' : 'play'); });
  };
  const toggle = () => { if (v.paused || v.ended) { const r = v.play(); if (r && r.catch) r.catch(() => {}); } else v.pause(); };
  const dur = () => (Number.isFinite(v.duration) && v.duration > 0 ? v.duration : g.dur);
  const paint = () => {
    const d = dur(), p = Math.min(1, (v.currentTime || 0) / d);
    bar.style.setProperty('--p', (p * 100).toFixed(3) + '%');
    bar.setAttribute('aria-valuenow', String(Math.round(v.currentTime || 0)));
    bar.setAttribute('aria-valuetext', vgTime(v.currentTime) + ' of ' + vgTime(d));
    $('[data-vcur]', host).textContent = vgTime(v.currentTime);
    try { if (v.buffered.length) bar.style.setProperty('--b', (Math.min(1, v.buffered.end(v.buffered.length - 1) / d) * 100).toFixed(2) + '%'); } catch (_) { /* not ready */ }
    if (p > 0.9) vgMarkSeen(g.id);
  };
  const setCC = (on) => { ccOn = on; store.set('cv_guides_cc', on ? '1' : '0'); $('[data-vcc]', host).setAttribute('aria-pressed', String(on)); $('[data-vcc]', host).classList.toggle('on', on); cap.hidden = !on; };
  setCC(ccOn);
  // Captions: we draw them ourselves (they stay above our controls and work in full screen).
  const wireTrack = () => {
    const t = v.textTracks && v.textTracks[0]; if (!t) return;
    t.mode = 'hidden';
    t.oncuechange = () => { const c = t.activeCues && t.activeCues[0]; cap.innerHTML = c ? '<span>' + esc(c.text) + '</span>' : ''; };
  };
  wireTrack();
  if (v.textTracks) v.textTracks.onaddtrack = wireTrack;
  const seekTo = (x) => { const r = bar.getBoundingClientRect(); const f = Math.max(0, Math.min(1, (x - r.left) / r.width)); v.currentTime = f * dur(); paint(); return f; };
  bar.addEventListener('pointerdown', (e) => { dragging = true; bar.setPointerCapture(e.pointerId); seekTo(e.clientX); st.classList.add('drag'); });
  bar.addEventListener('pointermove', (e) => {
    const r = bar.getBoundingClientRect(); const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const tip = $('.vg-tip', bar); tip.hidden = false; tip.textContent = vgTime(f * dur()); tip.style.left = (f * 100) + '%';
    if (dragging) seekTo(e.clientX);
  });
  bar.addEventListener('pointerleave', () => { $('.vg-tip', bar).hidden = true; });
  const endDrag = () => { dragging = false; st.classList.remove('drag'); showCtl(); };
  bar.addEventListener('pointerup', endDrag); bar.addEventListener('pointercancel', endDrag);
  bar.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); v.currentTime = Math.max(0, Math.min(dur(), v.currentTime + (e.key === 'ArrowRight' ? 5 : -5))); paint(); } });
  v.addEventListener('timeupdate', paint);
  v.addEventListener('progress', paint);
  v.addEventListener('loadedmetadata', () => { $('[data-vdur]', host).textContent = vgTime(v.duration); bar.setAttribute('aria-valuemax', String(Math.round(v.duration))); paint(); });
  v.addEventListener('play', () => { $('.vg-end', host).hidden = true; st.classList.add('started'); setPlayIcons(); showCtl(); });
  v.addEventListener('pause', () => { setPlayIcons(); showCtl(); });
  v.addEventListener('ended', () => { vgMarkSeen(g.id); setPlayIcons(); $('.vg-end', host).hidden = false; showCtl(); });
  v.addEventListener('volumechange', () => { const b = $('[data-vmute]', host); b.innerHTML = v.muted ? VG_ICON.mute : VG_ICON.vol; b.setAttribute('aria-label', v.muted ? 'Unmute' : 'Mute'); });
  v.addEventListener('error', () => { cap.hidden = false; cap.innerHTML = '<span>This video could not load. Check your connection and try again.</span>'; });
  st.addEventListener('pointermove', showCtl);
  st.addEventListener('click', (e) => { if (e.target === v || e.target === cap) toggle(); });
  host.addEventListener('click', (e) => {
    const t = e.target;
    if (t === host || t.closest('[data-vx]')) { closeVideoGuide(); return; }
    if (t.closest('[data-vplay]')) { toggle(); return; }
    if (t.closest('[data-vmute]')) { v.muted = !v.muted; return; }
    if (t.closest('[data-vcc]')) { setCC(!ccOn); return; }
    const sp = t.closest('[data-vspeed]'); if (sp) { speedI = (speedI + 1) % VG_SPEEDS.length; v.playbackRate = VG_SPEEDS[speedI]; sp.textContent = VG_SPEEDS[speedI] + '×'; return; }
    if (t.closest('[data-vfs]')) { vgFullscreen(st, v); return; }
    if (t.closest('[data-vrep]')) { v.currentTime = 0; toggle(); return; }
    if (t.closest('[data-vnext]') && nextG) { openVideoGuide(nextG.id, set); return; }
    if (t.closest('[data-vall]')) { closeVideoGuide(true); appGo('guides'); return; }
    // "Start free" at the end of the homepage set: the player's history entry becomes #signup (Back returns to the site).
    if (t.closest('[data-vsignup]')) { e.preventDefault(); closeVideoGuide(true); location.replace('#signup'); return; }
    const go = t.closest('[data-vgo]'); if (go && go.dataset.vgo !== g.id) openVideoGuide(go.dataset.vgo, set);
  });
  const onKey = (e) => {
    if (!VG || VG.host !== host) return;
    if (e.target.closest && e.target.closest('input,textarea,select')) return;
    const k = e.key;
    if (k === 'Escape') { if (!document.fullscreenElement) { e.stopImmediatePropagation(); closeVideoGuide(); } return; }
    if (k === ' ' || k === 'k' || k === 'K') { if (e.target.closest && e.target.closest('button') && k === ' ') return; e.preventDefault(); toggle(); }
    else if (k === 'ArrowRight' || k === 'ArrowLeft') { if (e.target === bar) return; e.preventDefault(); v.currentTime = Math.max(0, Math.min(dur(), v.currentTime + (k === 'ArrowRight' ? 5 : -5))); paint(); showCtl(); }
    else if (k === 'c' || k === 'C') setCC(!ccOn);
    else if (k === 'f' || k === 'F') vgFullscreen(st, v);
    else if (k === 'm' || k === 'M') v.muted = !v.muted;
  };
  document.addEventListener('keydown', onKey, true);
  VG = { id, host, v, cleanup: () => document.removeEventListener('keydown', onKey, true) };
  // Phone Back button closes the player instead of leaving the page: one history entry while it is open.
  try { if (!(history.state && history.state.vg)) history.pushState({ ...(history.state || {}), vg: 1 }, '', location.href); } catch (_) { /* ignore */ }
  setTimeout(() => { $('[data-vx]', host).focus({ preventScroll: true }); host.classList.add('in'); }, 10);
  const r = v.play(); if (r && r.catch) r.catch(() => { setPlayIcons(); }); // autoplay can be refused: the big button stays
  setPlayIcons();
}

function vgFullscreen(st, v) {
  try {
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    if (st.requestFullscreen) { st.requestFullscreen().catch(() => {}); return; }
    if (st.webkitRequestFullscreen) { st.webkitRequestFullscreen(); return; }
    if (v.webkitEnterFullscreen) v.webkitEnterFullscreen(); // iPhone: the system player
  } catch (_) { /* not allowed here */ }
}

/* quiet = called while leaving the page (route change, log out): just close, don't redraw the Guides page. */
function closeVideoGuide(quiet, fromBack) {
  if (!VG) return;
  const { host, v, cleanup } = VG;
  VG = null;
  cleanup();
  if (!fromBack && !quiet && history.state && history.state.vg) { try { history.back(); } catch (_) { /* ignore */ } }
  try { v.pause(); v.removeAttribute('src'); } catch (_) { /* ignore */ }
  if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (_) { /* ignore */ } }
  host.remove();
  if (!$('#modalHost').innerHTML) document.body.classList.remove('noscroll');
  if (quiet) return;
  if (APP.page === 'guides' && !$('#v-app').hidden) renderPage('guides', {});
  else $$('[data-vguide]').forEach((b) => { const s = vgSeen()[b.dataset.vguide]; if (s && b.classList.contains('vgl')) { b.classList.add('seen'); const p = $('.vgl-p', b); if (p) p.innerHTML = icon('check'); } });
}

if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('popstate', () => { if (VG && !(history.state && history.state.vg)) closeVideoGuide(false, true); });

/* Any [data-vguide] anywhere opens the player. */
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-vguide]');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  openVideoGuide(b.dataset.vguide, b.dataset.vset);
}, true);

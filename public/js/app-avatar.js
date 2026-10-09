'use strict';
/*
 * app-avatar.js: the customer's cartoon avatar and nickname.
 *   myAva(size, cls)        the logged-in person's avatar (or their initials) as HTML
 *   userAva(u, size, cls)   anyone's: { avatar, name, nickname, email }
 *   greetName()             nickname > first name > email prefix (AV.greetName)
 *   openAvatarBuilder()     the builder: live preview, every option, Randomize, 24 presets, Save (+ a confetti burst)
 *   avatarPromptMaybe()     the one-time "Make your Castvoo avatar" after onboarding (skippable, remembered on the server)
 * Drawing and the option lists: avatar.js (AV), shared with the server, which only stores known options.
 * API: POST /api/me { avatar, nickname } and { avatar_prompt_done: true }.
 */

function userAva(u, size, cls) {
  u = u || {};
  const s = size || 36;
  if (u.avatar && typeof AV !== 'undefined') return '<span class="uav' + (cls ? ' ' + cls : '') + '" style="width:' + s + 'px;height:' + s + 'px">' + AV.render(u.avatar, { size: s, label: (u.nickname || u.name || 'Avatar') + '\'s avatar' }) + '</span>';
  return ava(u.nickname || u.name || u.email || '?', s);
}
function myAva(size, cls) { return userAva(ME && ME.user, size, cls); }
function greetName() { return typeof AV !== 'undefined' ? AV.greetName(ME && ME.user) : ((ME && ME.user && ME.user.name) || '').split(' ')[0]; }

/* A small celebratory burst from a point on screen (canvas, no library). Skipped with reduced motion. */
function avBurst(x, y) {
  if (RM) return;
  const c = document.createElement('canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.className = 'avburst'; c.width = innerWidth * dpr; c.height = innerHeight * dpr;
  document.body.appendChild(c);
  const g = c.getContext('2d'); g.scale(dpr, dpr);
  const cols = ['#2F6BFF', '#6EC3FF', '#0F33A8', '#33C08A', '#F5B935', '#FFFFFF'];
  const ps = Array.from({ length: 90 }, (_, i) => { const a = Math.random() * Math.PI * 2, v = 4 + Math.random() * 7; return { x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 4, r: 3 + Math.random() * 4, c: cols[i % cols.length], rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, sq: i % 3 }; });
  const t0 = performance.now();
  const step = (t) => {
    const k = (t - t0) / 1400;
    g.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of ps) {
      p.vy += 0.28; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      g.save(); g.globalAlpha = Math.max(0, 1 - k); g.translate(p.x, p.y); g.rotate(p.rot); g.fillStyle = p.c;
      if (p.sq) g.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); else { g.beginPath(); g.arc(0, 0, p.r * 0.7, 0, Math.PI * 2); g.fill(); }
      g.restore();
    }
    if (k < 1) requestAnimationFrame(step); else c.remove();
  };
  requestAnimationFrame(step);
}

/* The builder's sections: [key, tab label, kind]. kind: 'pick' (avatar thumbnails), 'swatch' (colours), 'multi'. */
const AVB_TABS = [
  ['presets', 'Presets'], ['face', 'Face'], ['skin', 'Skin', 'swatch'], ['hair', 'Hair'], ['hairColor', 'Hair colour', 'swatch'],
  ['eyes', 'Eyes'], ['brows', 'Brows'], ['mouth', 'Mouth'], ['facial', 'Facial hair'], ['glasses', 'Glasses'],
  ['acc', 'Extras', 'multi'], ['outfit', 'Outfit'], ['outfitColor', 'Outfit colour', 'swatch'], ['bg', 'Background'],
];
const AVB_SW = {
  skin: ['#F8DCC8', '#F2C7A2', '#EDC3A0', '#E2AD80', '#D49A63', '#C88C5E', '#B87A50', '#8A5536', '#6F4127', '#4E2E1C'],
  hairColor: ['#17110E', '#2E1D16', '#5A3824', '#7A4A2A', '#8A3B1E', '#C2602E', '#D9AE5F', '#E6DAC3', '#9A9AA3', '#2F6BFF', '#6E56CF'],
  outfitColor: ['#2F6BFF', '#0B1640', '#6EA8FF', '#F4F7FF', '#16171D', '#12B886', '#E5484D', '#F5B935', '#6E56CF', '#8C93A6', '#FF7A59', '#5F7A3A'],
};

/*
 * opts: { start (a config to begin with), title, onSaved(me) }
 */
function openAvatarBuilder(opts = {}) {
  const u = ME.user || {};
  let cfg = AV.clean(opts.start || u.avatar || AV.random(), false);
  let tab = opts.tab || 'presets';
  const h = sheet(esc(opts.title || 'Your avatar'), '<span class="spk">' + icon('users') + '</span>',
    '<div class="avb">' +
      '<div class="avb-stage"><div class="avb-pv" id="avbPv" aria-live="polite"></div>' +
        '<div class="avb-side"><div class="field"><label for="avbNick">Nickname <span class="hint">(optional)</span></label><input class="inp" id="avbNick" aria-label="Nickname" maxlength="24" autocomplete="nickname" placeholder="What should we call you?" value="' + esc(u.nickname || '') + '"><small class="hint">Shown when we greet you, like "Good morning, ' + esc(u.nickname || 'Dchessking') + ' 👋".</small></div>' +
        '<div class="avb-btns"><button type="button" class="btn b-ghost sm" id="avbRnd"><span aria-hidden="true">🎲</span>Randomize</button><button type="button" class="btn b-ghost sm" id="avbPre">' + icon('spark') + 'Presets</button></div></div></div>' +
      '<div class="avb-tabs" role="tablist" aria-label="Avatar parts" id="avbTabs">' + AVB_TABS.map(([k, l]) => '<button type="button" role="tab" data-tab="' + k + '" aria-selected="' + (k === tab) + '">' + esc(l) + '</button>').join('') + '</div>' +
      '<div class="avb-grid" id="avbGrid" role="tabpanel"></div>' +
      '<p class="ferr" id="avbErr" hidden></p>' +
      '<div class="avb-foot"><button type="button" class="btn b-ghost" data-shx>Cancel</button><button type="button" class="btn b-blue" id="avbSave">' + icon('check') + 'Save avatar</button></div>' +
    '</div>', { wide: true });
  $('.sheet', h).classList.add('avbs');
  const pv = () => { $('#avbPv', h).innerHTML = AV.render(cfg, { size: 168, live: true, label: 'Your avatar preview' }); };
  const grid = () => {
    const G = $('#avbGrid', h);
    const t = AVB_TABS.find((x) => x[0] === tab) || AVB_TABS[0];
    $$('#avbTabs [data-tab]', h).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    if (tab === 'presets') {
      G.className = 'avb-grid pre';
      G.innerHTML = AV.PRESETS.map((p, i) => '<button type="button" class="avb-o" data-pre="' + i + '" aria-label="Preset ' + (i + 1) + '">' + AV.render(p, { size: 72, label: 'Preset ' + (i + 1) }) + '</button>').join('');
      return;
    }
    const list = AV.OPTIONS[tab] || [];
    if (t[2] === 'swatch') {
      G.className = 'avb-grid swt';
      G.innerHTML = list.map(([k, l], i) => '<button type="button" class="avb-s' + (cfg[tab] === k ? ' on' : '') + '" data-k="' + esc(k) + '" aria-pressed="' + (cfg[tab] === k) + '" aria-label="' + esc(l) + '" title="' + esc(l) + '"><i style="background:' + AVB_SW[tab][i] + '"></i></button>').join('');
      return;
    }
    G.className = 'avb-grid';
    G.innerHTML = list.map(([k, l]) => {
      const on = t[2] === 'multi' ? cfg.acc.includes(k) : cfg[tab] === k;
      const c = t[2] === 'multi' ? { ...cfg, acc: on ? cfg.acc : cfg.acc.concat(k) } : { ...cfg, [tab]: k };
      return '<button type="button" class="avb-o' + (on ? ' on' : '') + '" data-k="' + esc(k) + '" aria-pressed="' + on + '">' + AV.render(c, { size: 64, label: l }) + '<span>' + esc(l) + '</span></button>';
    }).join('') + (t[2] === 'multi' ? '<p class="hint avb-note">Pick as many as you like.</p>' : '');
  };
  pv(); grid();
  const bump = () => { const p = $('#avbPv svg', h); if (p && !RM) { p.classList.remove('pop'); void p.getBoundingClientRect(); p.classList.add('pop'); } };
  $('#avbTabs', h).onclick = (e) => { const b = e.target.closest('[data-tab]'); if (!b) return; tab = b.dataset.tab; grid(); b.scrollIntoView({ block: 'nearest', inline: 'center', behavior: RM ? 'auto' : 'smooth' }); };
  $('#avbGrid', h).onclick = (e) => {
    const pre = e.target.closest('[data-pre]');
    if (pre) { cfg = AV.clean(AV.PRESETS[+pre.dataset.pre], false); pv(); bump(); return; }
    const b = e.target.closest('[data-k]'); if (!b) return;
    const k = b.dataset.k;
    if (tab === 'acc') cfg = { ...cfg, acc: cfg.acc.includes(k) ? cfg.acc.filter((x) => x !== k) : cfg.acc.concat(k) };
    else cfg = { ...cfg, [tab]: k };
    pv(); grid(); bump();
  };
  $('#avbRnd', h).onclick = () => { cfg = AV.random(); pv(); grid(); bump(); };
  $('#avbPre', h).onclick = () => { tab = 'presets'; grid(); };
  $('#avbSave', h).onclick = async (e) => {
    const err = $('#avbErr', h); err.hidden = true;
    const nickname = $('#avbNick', h).value.trim();
    const btn = e.currentTarget;
    btnBusy(btn, true, 'Saving…');
    try {
      ME = await POST('/api/me', { avatar: cfg, nickname });
      store.set('cv_avp', '1');
      const r = $('#avbPv', h).getBoundingClientRect();
      avBurst(r.left + r.width / 2, r.top + r.height / 2);
      if (typeof shellUI === 'function') shellUI();
      btnBusy(btn, false);
      btn.innerHTML = icon('check') + 'Saved';
      setTimeout(() => { closeModal(); toast('Looking good' + (greetName() ? ', ' + greetName() : '') + '! Your avatar is saved.'); if (opts.onSaved) opts.onSaved(ME); else if (typeof VIEW !== 'undefined' && VIEW === 'app' && APP.booted) renderPage(APP.page || 'overview', APP.q || {}); }, 750);
    } catch (ex) { btnBusy(btn, false); err.textContent = ex.message; err.hidden = false; }
  };
  return h;
}

/* After onboarding (first visit to the dashboard): a delightful, skippable one-step prompt with a random starter. */
let avPromptShown = false;
function avatarPromptMaybe() {
  const u = ME && ME.user;
  if (avPromptShown || !u || !u.avatar_prompt || store.get('cv_avp') || typeof AV === 'undefined') return;
  setTimeout(() => {
    if (avPromptShown || VIEW !== 'app' || $('#modalHost').innerHTML || !ME.user || !ME.user.avatar_prompt) return;
    avPromptShown = true;
    // Start from (and shuffle through) the curated presets: every one looks good straight away.
    let pi = Math.floor(Math.random() * AV.PRESETS.length);
    let cfg = AV.PRESETS[pi];
    const h = sheet('Make your Castvoo avatar', '<span class="spk">' + icon('spark') + '</span>',
      '<div class="avp"><div class="avp-pv" id="avpPv"></div><button type="button" class="btn b-ghost sm avp-rnd" id="avpRnd"><span aria-hidden="true">🎲</span>Shuffle</button>' +
      '<p class="muted">Pick a face for your account. It shows on your dashboard, your team list and in support chats. You can change it any time in Settings.</p>' +
      '<div class="field"><label for="avpNick">What should we call you? <span class="hint">(optional)</span></label><input class="inp" id="avpNick" maxlength="24" autocomplete="nickname" placeholder="A nickname, like Dchessking" value="' + esc(u.nickname || '') + '"></div>' +
      '<p class="ferr" id="avpErr" hidden></p>' +
      '<div class="row2b"><button type="button" class="btn b-ghost" id="avpCus">' + icon('pencil') + 'Customize</button><button type="button" class="btn b-blue" id="avpOk">' + icon('check') + 'Use this</button></div>' +
      '<button type="button" class="avp-skip" id="avpSkip">Skip for now</button></div>',
      { onClose: () => { store.set('cv_avp', '1'); if (ME.user && ME.user.avatar_prompt) POST('/api/me', { avatar_prompt_done: true }).then((m) => { ME = m; }).catch(() => {}); } });
    const pv = () => { $('#avpPv', h).innerHTML = AV.render(cfg, { size: 150, live: true, label: 'Your new avatar' }); };
    pv();
    $('#avpRnd', h).onclick = () => { pi = (pi + 1 + Math.floor(Math.random() * (AV.PRESETS.length - 1))) % AV.PRESETS.length; cfg = AV.PRESETS[pi]; pv(); const s = $('#avpPv svg', h); if (s && !RM) s.classList.add('pop'); };
    $('#avpCus', h).onclick = () => { const nick = $('#avpNick', h).value; closeModal(); openAvatarBuilder({ start: cfg, tab: 'hair', title: 'Make your Castvoo avatar' }); const n = $('#avbNick'); if (n && nick) n.value = nick; };
    $('#avpSkip', h).onclick = () => closeModal();
    $('#avpOk', h).onclick = async (e) => {
      const btn = e.currentTarget; btnBusy(btn, true, 'Saving…');
      try {
        ME = await POST('/api/me', { avatar: cfg, nickname: $('#avpNick', h).value.trim() });
        store.set('cv_avp', '1');
        const r = $('#avpPv', h).getBoundingClientRect(); avBurst(r.left + r.width / 2, r.top + r.height / 2);
        if (typeof shellUI === 'function') shellUI();
        setTimeout(() => { onModalClose = null; closeModal(); toast('Welcome' + (greetName() ? ', ' + greetName() : '') + '! Your avatar is ready.'); if (APP.page === 'overview') renderPage('overview', {}); }, 700);
      } catch (ex) { btnBusy(btn, false); const er = $('#avpErr', h); er.textContent = ex.message; er.hidden = false; }
    };
  }, 1600);
}

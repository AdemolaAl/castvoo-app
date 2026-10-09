'use strict';
/*
 * signup.js: sign-up and log-in (they are the same: the server creates the account if it's new).
 * Routes:  #signup  #login  #signup/country  #signup/connect  #signup/plan   (#signup?error=... shows an error)
 * Steps:   1 account  ->  2 country  ->  3 connect Telegram  ->  4 plan  ->  #app
 */

const SU = { mode: 'signup', email: '', codeSent: false, busy: false, guide: null, country: null, plan: null, cycle: 'month' };

function suProgress(n) { $$('#suProg i').forEach((p, i) => p.classList.toggle('on', i < n)); $('#suProg').hidden = SU.mode === 'login' && n === 1; }
function suStopGuide() { if (SU.guide) { SU.guide.stop(); SU.guide = null; } }

/* Called by main.js for every #signup... / #login route. */
async function signupRoute(sub, q) {
  suStopGuide();
  const logged = !!(ME && ME.user);
  if (!sub || sub === 'login') {
    if (logged) { location.replace('#app'); return; }
    SU.mode = sub === 'login' ? 'login' : 'signup';
    suAccount(q.error || '');
    return;
  }
  if (!logged) { store.sset('cv_back', '#signup/' + sub); location.replace('#login'); return; }
  if (sub === 'country') return suCountry();
  if (sub === 'connect') return suConnect();
  if (sub === 'plan') return suPlan();
  location.replace('#app');
}

/* Where to go after a successful log-in. */
async function afterLogin(created) {
  await loadMe();
  siteAuthUI();
  const join = store.sget('cv_join');
  if (join) { location.hash = '#join/' + join; return; }
  const back = store.sget('cv_back'); store.sset('cv_back', null);
  if (created) { location.hash = '#signup/country'; return; }
  location.hash = back && back.startsWith('#app') ? back : '#app';
}

/* ---------- Step 1: account ---------- */
function suAccount(error) {
  const L = CFG.login || {};
  const signup = SU.mode === 'signup';
  const off = signup && (CFG.features.signups === false || CFG.features.maintenance);
  const anySso = L.telegram || L.voosquare;
  suProgress(1);
  SU.codeSent = false;
  $('#suBody').innerHTML = '<div class="su-step">' +
    '<div class="su-hd"><div style="width:76px" data-cas="wave"></div>' + (signup ? '<span class="pill p-blue">' + fmt(CFG.trial.days) + ' days free · no card</span>' : '') + '</div>' +
    '<div><h1>' + (signup ? 'Create your Castvoo account' : 'Welcome back') + '</h1><p class="muted" style="margin-top:6px">' + (signup ? 'Every feature free for ' + fmt(CFG.trial.days) + ' days. Takes under a minute.' : 'Log in to your Castvoo dashboard.') + '</p></div>' +
    (error ? '<div class="errbox" role="alert">' + icon('stop') + '<span>' + esc(error) + '</span></div>' : '') +
    (off ? '<div class="note2"><span>⏸️</span><span><b>New sign-ups are paused for a moment.</b> ' + esc(CFG.features.maintenance ? (CFG.content.maintenance_message || '') : 'Please try again a little later.') + ' Existing accounts can still log in.</span></div>' : '') +
    '<div id="suPick" class="su-pick">' +
      (L.telegram ? '<button type="button" class="sso tgb" id="suTg">' + icon('tg') + 'Continue with Telegram<span class="rec">Fastest</span></button>' : '') +
      (L.voosquare ? '<button type="button" class="sso" id="suVq"><span class="vq">V</span>Continue with Voo ID</button>' : '') +
      (anySso && L.email ? '<div class="or">or use email</div>' : '') +
      (L.email ? '<form id="suEmF" class="su-pick" novalidate><div class="field"><label for="suEmail">Email</label><input class="inp" id="suEmail" type="email" placeholder="you@company.com" autocomplete="email" value="' + esc(SU.email) + '" required></div><p class="ferr" id="suErr" hidden></p><button class="btn b-blue full" type="submit" id="suN1">Email me a code</button></form>' : '') +
      (!anySso && !L.email ? '<div class="note2"><span>🔧</span><span>Log-in is being switched on. Please check back in a few minutes.</span></div>' : '') +
    '</div>' +
    '<form id="suCodeBox" class="su-pick" hidden novalidate>' +
      '<div class="okbox" style="background:var(--blue-s);border-color:#D6E1FA">' + icon('mail') + '<span>We sent a 6-digit code to <b id="suEm"></b>. It works for 10 minutes.</span></div>' +
      '<div class="field"><label for="suCode">Enter the code</label><input class="inp codein" id="suCode" inputmode="numeric" maxlength="6" placeholder="······" autocomplete="one-time-code" required></div>' +
      (signup ? '<div class="field"><label for="suName">Your first name <span class="hint">(optional)</span></label><input class="inp" id="suName" autocomplete="given-name" maxlength="80" placeholder="So Cas can greet you"></div>' : '') +
      '<p class="ferr" id="suCErr" hidden></p>' +
      '<button class="btn b-blue full" type="submit" id="suVer">Verify and continue</button>' +
      '<div class="row2b"><button class="btn b-ghost sm" type="button" id="suResend">Send a new code</button><button class="btn b-ghost sm" type="button" id="suBack">Use another email</button></div>' +
      '<p class="hint" style="text-align:center">No email? Check your spam folder.</p>' +
    '</form>' +
    '<div id="suWait" hidden class="okbox" style="background:var(--blue-s);border-color:#D6E1FA"><span class="spin"></span><span id="suWaitT">Signing you in…</span></div>' +
    '<p class="hint su-sw">' + (signup ? 'Have an account? <a href="#login">Log in</a>' : 'New to Castvoo? <a href="#signup">Create a free account</a>') + '</p>' +
    (L.voosquare ? '<div class="vsq"><span class="vq">V</span><span>Secured by <b style="color:var(--ink)">VooSquare</b> · one login for all Zedapex tools</span></div>' : '<div class="vsq">' + icon('lock') + '<span>Your data is encrypted and never sold.</span></div>') +
    '<p class="hint" style="text-align:center;font-size:12px">By continuing you agree to the <a href="/legal/terms" target="_blank" rel="noopener">Terms</a> and <a href="/legal/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</p>' +
    '</div>';
  paintAll($('#suBody'));
  window.scrollTo(0, 0);

  const wait = (t) => { $('#suPick').hidden = true; $('#suCodeBox').hidden = true; $('#suWaitT').textContent = t; $('#suWait').hidden = false; };
  const unwait = (codeView) => { $('#suWait').hidden = true; $('#suPick').hidden = !!codeView; $('#suCodeBox').hidden = !codeView; };
  const tg = $('#suTg'), vq = $('#suVq');
  if (vq) vq.onclick = () => {
    wait('Opening VooSquare…');
    // "Start free" opens VooSquare's sign-up view; the affiliate click (if any) rides along from the voo_attr cookie.
    const back = store.sget('cv_back');
    let url = '/auth/voosquare?' + (SU.mode === 'signup' ? 'signup=1&' : '') + 'return_to=' + encodeURIComponent(back && back.startsWith('#app') ? '/' + back : '/#app');
    if (window.VooConnect && window.VooConnect.decorate) url = window.VooConnect.decorate(url);
    location.href = url;
  };
  if (tg) tg.onclick = async () => {
    wait('Opening Telegram… approve the log-in in the window that pops up.');
    try {
      await loadScript('https://telegram.org/js/telegram-widget.js?22');
      if (!window.Telegram || !window.Telegram.Login) throw new Error('no widget');
      window.Telegram.Login.auth({ bot_id: CFG.bot_id, request_access: 'write' }, async (user) => {
        if (!user) { unwait(false); toast('Telegram log-in was cancelled.', { kind: 'info' }); return; }
        wait('Signing you in with Telegram…');
        try {
          const r = await POST('/api/auth/telegram', { ...user, country: SU.country || undefined, ref: refCode() || undefined });
          afterLogin(r.created);
        } catch (e) { unwait(false); suShowErr(e.message); }
      });
    } catch (_) { unwait(false); suShowErr('Telegram could not open. Check your connection, or use another way to log in.'); }
  };
  const emF = $('#suEmF');
  if (emF) emF.onsubmit = async (e) => {
    e.preventDefault();
    const em = $('#suEmail').value.trim(), err = $('#suErr');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { err.textContent = 'Enter a valid email, like you@company.com.'; err.hidden = false; $('#suEmail').setAttribute('aria-invalid', 'true'); $('#suEmail').focus(); return; }
    $('#suEmail').removeAttribute('aria-invalid'); err.hidden = true;
    const b = $('#suN1'); b.disabled = true; b.innerHTML = '<span class="spin wh"></span>Sending…';
    try {
      await POST('/api/auth/email/start', { email: em });
      SU.email = em; SU.codeSent = true;
      $('#suEm').textContent = em; unwait(true); setTimeout(() => $('#suCode').focus(), 50);
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    b.disabled = false; b.textContent = 'Email me a code';
  };
  $('#suCode').oninput = (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); $('#suCErr').hidden = true; if (e.target.value.length === 6 && !SU.busy) $('#suCodeBox').requestSubmit(); };
  $('#suBack').onclick = () => { unwait(false); setTimeout(() => $('#suEmail') && $('#suEmail').focus(), 50); };
  $('#suResend').onclick = async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try { await POST('/api/auth/email/start', { email: SU.email }); toast('A new code is on its way.'); } catch (ex) { $('#suCErr').textContent = ex.message; $('#suCErr').hidden = false; }
    setTimeout(() => { b.disabled = false; }, 15000);
  };
  $('#suCodeBox').onsubmit = async (e) => {
    e.preventDefault();
    const code = $('#suCode').value, ce = $('#suCErr');
    if (code.length !== 6) { ce.textContent = 'Enter all 6 digits from the email.'; ce.hidden = false; return; }
    SU.busy = true;
    const b = $('#suVer'); b.disabled = true; b.innerHTML = '<span class="spin wh"></span>Checking…';
    try {
      const nm = $('#suName') ? $('#suName').value.trim() : '';
      const r = await POST('/api/auth/email/verify', { email: SU.email, code, name: nm || undefined, ref: refCode() || undefined, country: SU.country || undefined });
      wait(r.created ? 'Creating your account…' : 'Logging you in…');
      afterLogin(r.created);
    } catch (ex) { ce.textContent = ex.message; ce.hidden = false; b.disabled = false; b.textContent = 'Verify and continue'; }
    SU.busy = false;
  };
}
function suShowErr(msg) {
  const p = $('#suPick'); if (!p) return;
  let e = $('.errbox', $('#suBody'));
  if (!e) { e = document.createElement('div'); e.className = 'errbox'; e.setAttribute('role', 'alert'); p.parentNode.insertBefore(e, p); }
  e.innerHTML = icon('stop') + '<span>' + esc(msg) + '</span>';
}

/* ---------- Step 2: country ---------- */
/* The customer picks their own country: nothing is guessed (no time zone, IP or VooSquare default). The field starts
   empty ("Select your country"), the list is searchable and has flags, and Continue needs a pick. */
function suCountry() {
  suProgress(2);
  const list = CFG.countries || [];
  if (!list.length) { location.replace('#signup/connect'); return; }
  // Only a country this person already picked themselves (earlier in this sign-up, or saved from this step) shows.
  SU.country = SU.country || (ME.user && ME.user.country) || null;
  if (SU.country && !list.some((c) => c.code === SU.country)) SU.country = null;
  $('#suBody').innerHTML = '<div class="su-step"><div><h1>Where are you based?</h1><p class="muted" style="margin-top:6px">Select your country. We\'ll show the payment methods that work there.</p></div>' +
    '<div class="field"><label for="suCtQ" id="suCtLb">Country</label>' + countryPickerHtml('suCt') + '</div>' +
    '<p class="ferr" id="suCtErr" role="alert" hidden></p>' +
    '<div class="pmprev"><b style="font-size:14px">You\'ll be able to pay with</b><div class="chips" id="suPmv"><p class="hint" style="margin:0">Select your country to see them.</p></div><small class="muted">You can change your country later in Settings.</small></div>' +
    '<button class="btn b-blue full" type="button" id="suNc">Continue</button></div>';
  const err = $('#suCtErr');
  countryPicker('suCt', list, SU.country, (code) => {
    SU.country = code;
    if (code) { err.hidden = true; $('#suCtQ').removeAttribute('aria-invalid'); suMethods(code); }
    else $('#suPmv').innerHTML = '<p class="hint" style="margin:0">Select your country to see them.</p>';
  });
  $('#suNc').onclick = async () => {
    if (!SU.country) {
      err.textContent = 'Please select your country to continue.'; err.hidden = false;
      $('#suCtQ').setAttribute('aria-invalid', 'true'); $('#suCtQ').setAttribute('aria-describedby', 'suCtErr');
      return;
    }
    const b = $('#suNc'); b.disabled = true;
    try { ME = await POST('/api/me', { country: SU.country }); location.hash = '#signup/connect'; } catch (e) { err.textContent = e.message; err.hidden = false; }
    b.disabled = false;
  };
  window.scrollTo(0, 0);
}

/* A searchable country list with flags (combobox). id is the prefix: <id>Q input, <id>L list, <id>F flag. */
function countryPickerHtml(id) {
  return '<div class="cpk" id="' + id + 'P"><div class="cpk-in"><span class="cpk-fl" id="' + id + 'F" aria-hidden="true">' + icon('globe') + '</span>' +
    '<input class="inp" id="' + id + 'Q" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="' + id + 'L" placeholder="Select your country" autocomplete="off" autocapitalize="words" spellcheck="false" enterkeyhint="done">' +
    '<button type="button" class="cpk-x" id="' + id + 'X" aria-label="Clear" hidden>' + icon('x') + '</button><span class="cpk-cv" aria-hidden="true">' + icon('chev') + '</span></div>' +
    '<div class="cpk-l" id="' + id + 'L" role="listbox" aria-label="Countries" hidden></div></div>';
}
function countryPicker(id, list, value, onPick) {
  const q = $('#' + id + 'Q'), box = $('#' + id + 'L'), fl = $('#' + id + 'F'), x = $('#' + id + 'X'), wrap = $('#' + id + 'P');
  const norm = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim();
  const byName = (a, b) => (a.code === 'XX') - (b.code === 'XX') || a.name.localeCompare(b.name);
  const featured = list.filter((c) => c.featured && c.code !== 'XX');
  const all = list.slice().sort(byName);
  let cur = value || null, act = -1;
  const show = (c) => {
    q.value = c ? c.name : '';
    fl.innerHTML = c ? esc(c.flag || '🌍') : icon('globe');
    fl.classList.toggle('on', !!c);
    x.hidden = !c && !q.value;
  };
  const opt = (c) => '<button type="button" role="option" tabindex="-1" data-c="' + esc(c.code) + '" aria-selected="' + (c.code === cur) + '"' + (c.code === cur ? ' class="on"' : '') + '><span class="fl">' + esc(c.flag || '🌍') + '</span><span class="nm">' + esc(c.name) + '</span>' + (c.code === cur ? icon('check') : '') + '</button>';
  const draw = () => {
    const t = norm(q.value === ((list.find((c) => c.code === cur) || {}).name) ? '' : q.value);
    let h;
    if (!t) h = (featured.length ? '<div class="cpk-g">Popular</div>' + featured.map(opt).join('') + '<div class="cpk-g">All countries</div>' : '') + all.map(opt).join('');
    else {
      const hit = all.filter((c) => norm(c.name).includes(t) || norm(c.code) === t).sort((a, b) => (norm(b.name).startsWith(t)) - (norm(a.name).startsWith(t)));
      h = hit.length ? hit.map(opt).join('') : '<p class="cpk-no">No country matches "' + esc(q.value.trim()) + '". Try another spelling, or pick "Another country".</p>';
    }
    box.innerHTML = h; act = -1;
  };
  const open = () => { if (!box.hidden) return; draw(); box.hidden = false; q.setAttribute('aria-expanded', 'true'); wrap.classList.add('open'); const on = $('[aria-selected=true]', box); if (on) box.scrollTop = Math.max(0, on.offsetTop - 60); };
  const close = () => { box.hidden = true; q.setAttribute('aria-expanded', 'false'); wrap.classList.remove('open'); q.removeAttribute('aria-activedescendant'); };
  const pick = (code) => {
    const c = list.find((k) => k.code === code) || null;
    cur = c ? c.code : null; show(c); close(); onPick(cur);
  };
  const move = (d) => {
    const o = $$('[role=option]', box); if (!o.length) return;
    act = (act + d + o.length) % o.length;
    o.forEach((b, i) => b.classList.toggle('act', i === act));
    o[act].scrollIntoView({ block: 'nearest' });
  };
  show(list.find((c) => c.code === cur) || null);
  q.addEventListener('focus', open);
  q.addEventListener('click', open);
  q.addEventListener('input', () => {
    if (cur) { cur = null; fl.innerHTML = icon('globe'); fl.classList.remove('on'); onPick(null); }
    x.hidden = !q.value; box.hidden ? open() : draw();
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); open(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); const o = $$('[role=option]', box); const b = o[act] || (norm(q.value) && o[0]); if (b) { pick(b.dataset.c); q.blur(); } }
    else if (e.key === 'Escape') { close(); }
  });
  // Tap or click an option (mousedown keeps the focus in the field so the list does not close first).
  box.addEventListener('mousedown', (e) => e.preventDefault());
  box.addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (b) { pick(b.dataset.c); q.blur(); } });
  x.onclick = () => { cur = null; show(null); onPick(null); q.focus(); open(); draw(); };
  q.addEventListener('blur', () => setTimeout(() => {
    if (wrap.contains(document.activeElement)) return;
    close();
    // Typed the exact name and left the field: that counts as a pick. Anything else that is not a pick is cleared.
    if (!cur) { const t = norm(q.value); const c = t && list.find((k) => norm(k.name) === t); if (c) pick(c.code); else show(null); }
  }, 120));
  return { set: (code) => pick(code), get: () => cur };
}
async function suMethods(code) {
  const box = $('#suPmv'); if (!box || !code) return;
  box.innerHTML = '<span class="spin"></span>';
  let m = [];
  try { m = (await GET('/api/public/methods?country=' + encodeURIComponent(code))).methods || []; } catch (_) { m = []; }
  if (SU.country !== code || !$('#suPmv')) return;
  box.innerHTML = m.length ? m.map((p, i) => '<span style="animation-delay:' + (i * 0.08) + 's"><i style="background:' + esc(p.color || '#0B1430') + '">' + esc(p.icon || '•') + '</i>' + esc(p.label) + '<small class="muted">' + esc(p.detail || '') + '</small></span>').join('') + (m.some((x) => x.gatevoo) ? '<div style="width:100%">' + gatevooBadge(true) + '</div>' : '')
    : '<p class="hint" style="margin:0">Card and crypto options appear here once payments are switched on.</p>';
}

/* ---------- Step 3: connect Telegram ---------- */
function suConnect() {
  suProgress(3);
  $('#suBody').innerHTML = '<div class="su-step"><div><h1>Connect your Telegram bot</h1><p class="muted" style="margin-top:6px">Watch the steps, then paste your bot token below. You can also do this later.</p></div>' +
    (ME.user && ME.user.tg_linked ? '<div class="tglk">' + icon('tg') + '<span>Your Telegram is linked, so channels and groups connect in one tap.</span></div>' : '') +
    '<div id="suGuide"></div>' +
    '<form id="suTokF" class="su-pick" novalidate><div class="field"><label for="suTok">Bot token from @BotFather</label><input class="inp mono" id="suTok" placeholder="123456789:AAH…" autocomplete="off" spellcheck="false" style="font-size:14px"></div>' +
    '<div class="note2"><span>ℹ️</span><span>If this bot already runs another service, connecting it here takes over its updates. Use a bot just for Castvoo if you are not sure.</span></div>' +
    '<p class="ferr" id="suTokErr" hidden></p><div id="suOk"></div>' +
    '<button class="btn b-blue full" type="submit" id="suN2">Check and connect</button></form>' +
    '<button class="btn b-ghost full" type="button" id="suChan">' + icon('tg') + 'Add a channel or group instead</button>' +
    '<button class="btn b-ghost full" type="button" id="suSkip">I\'ll do this later</button></div>';
  SU.guide = guide($('#suGuide'), { compact: true });
  $('#suTokF').onsubmit = async (e) => {
    e.preventDefault();
    const b = $('#suN2');
    if (b.dataset.ok) { location.hash = '#signup/plan'; return; }
    const v = $('#suTok').value.trim(), err = $('#suTokErr');
    if (!/^\d{5,}:[\w-]{20,}$/.test(v)) { err.textContent = 'That doesn\'t look like a bot token. It looks like 123456789:AAH… Copy it again from @BotFather.'; err.hidden = false; return; }
    err.hidden = true; b.disabled = true; b.innerHTML = '<span class="spin wh"></span>Checking your bot with Telegram…';
    try {
      const r = await POST('/api/connections/bot', { token: v });
      $('#suOk').innerHTML = '<div class="okbox">' + icon('tg') + '<div><b>@' + esc(r.connection.username) + ' connected</b><br><small class="muted">Ready to send messages</small></div></div>';
      b.dataset.ok = '1'; b.textContent = 'Continue'; confetti();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; b.textContent = 'Check and connect'; }
    b.disabled = false;
  };
  $('#suChan').onclick = () => openConnect('', { onConnected: () => { location.hash = '#signup/plan'; } });
  $('#suSkip').onclick = () => { location.hash = '#signup/plan'; };
  window.scrollTo(0, 0);
}

/* ---------- Step 4: plan ---------- */
function suPlan() {
  suProgress(4);
  const plans = CFG.plans || [];
  if (!SU.plan) SU.plan = (plans.find((p) => p.code === CFG.trial.plan) || plans.find((p) => p.popular) || plans[0] || {}).code;
  const trialName = (plans.find((p) => p.code === CFG.trial.plan) || {}).name || 'Growth';
  const draw = () => {
    $('#suBody').innerHTML = '<div class="su-step"><div style="width:80px" data-cas="happy"></div><div><h1>Choose a plan</h1><p class="muted" style="margin-top:6px">Your ' + fmt(CFG.trial.days) + '-day free trial of ' + esc(trialName) + ' is running. The plan you pick starts when the trial ends and is paid from your wallet. Change it any time.</p></div>' +
      '<div class="seg2" id="suCy"><button type="button" data-c="month" class="' + (SU.cycle === 'month' ? 'on' : '') + '">Monthly</button><button type="button" data-c="year" class="' + (SU.cycle === 'year' ? 'on' : '') + '">Yearly' + (yearSaveText() ? ' · ' + yearSaveText() : '') + '</button></div>' +
      '<div style="display:grid;gap:10px" id="pp">' + plans.map((p) => '<button type="button" class="pp ' + (p.code === SU.plan ? 'on' : '') + '" data-p="' + esc(p.code) + '" aria-pressed="' + (p.code === SU.plan) + '"><div><b>' + esc(p.name) + (p.popular ? ' <span class="pill p-blue">Popular</span>' : '') + '</b><small>' + esc(suPlanLine(p)) + '</small></div><span class="pr">' + usd(SU.cycle === 'year' ? p.price_year : p.price_month) + '<small>/' + (SU.cycle === 'year' ? 'yr' : 'mo') + '</small></span></button>').join('') + '</div>' +
      '<p class="ferr" id="suPlErr" hidden></p>' +
      '<button class="btn b-blue full" type="button" id="suN3">Open my dashboard' + icon('arrow') + '</button>' +
      '<button class="btn b-ghost full" type="button" id="suLater">Decide later</button></div>';
    paintAll($('#suBody'));
    $('#pp').onclick = (e) => { const b = e.target.closest('[data-p]'); if (b) { SU.plan = b.dataset.p; draw(); } };
    $('#suCy').onclick = (e) => { const b = e.target.closest('[data-c]'); if (b) { SU.cycle = b.dataset.c; draw(); } };
    $('#suLater').onclick = () => finishSignup();
    $('#suN3').onclick = async () => {
      const b = $('#suN3'); b.disabled = true;
      try { const r = await POST('/api/app/plan', { plan: SU.plan, cycle: SU.cycle }); finishSignup(r.message); } catch (e) { $('#suPlErr').textContent = e.message; $('#suPlErr').hidden = false; b.disabled = false; }
    };
  };
  draw();
  window.scrollTo(0, 0);
}
function finishSignup(msg) {
  location.hash = '#app';
  setTimeout(() => { confetti(); toast(msg ? 'Welcome to Castvoo. ' + msg : 'Welcome to Castvoo. Your free trial is live.'); }, 300);
}

function signupInit() {
  $('#suCards').innerHTML = [['tunde', 'Welcome every new subscriber', 'Sent the moment they start your bot'], ['wanjiku', 'Follow up on day 1, 3 and 7', 'Auto follow-ups do it for you'], ['zainab', 'See who tapped your buttons', 'Every button link is tracked']].map((c) => '<div class="su-c">' + mav(c[0]) + '<div><b>' + c[1] + '</b><small>' + c[2] + '</small></div></div>').join('');
  paintAll($('#v-signup'));
}

/* One line under each plan in the picker. Free gives a welcome bot, not subscribers or AI writes, so it says that. */
function suPlanLine(p) {
  if (!Number(p.price_month) && !Number(p.price_year)) {
    const jr = Number(p.join_requests);
    const n = Number(p.connections) || 1;
    return 'Welcome bot for ' + (n === 1 ? '1 channel or group' : fmt(n) + ' channels or groups') + ' · ' + (jr < 0 ? 'unlimited' : fmt(jr || 500)) + ' join requests a month · no card needed';
  }
  return plural(p.connections, 'connection') + ' · ' + fmt(p.subscribers) + ' subscribers · ' + fmt(p.ai_writes) + ' AI writes';
}

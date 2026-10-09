'use strict';
/*
 * main.js: starts everything and decides which view to show from the address bar.
 *   #anything-else       -> website (anchors like #pricing just scroll)
 *   #signup, #login      -> sign-up / log-in (signup.js)
 *   #signup/country ...  -> later sign-up steps
 *   #app, #app/<page>    -> dashboard (app.js + app-*.js)
 *   #join/<token>        -> accept a team invite
 * Loaded last, so every other file is ready.
 */

let VIEW = null;

function parseHash() {
  const raw = decodeURIComponent(location.hash.replace(/^#/, ''));
  const [path, qs] = raw.split('?');
  const parts = path.split('/');
  return { head: parts[0] || '', sub: parts.slice(1).join('/'), q: parseQuery(qs || '') };
}

function showView(v) {
  if (VIEW !== v) {
    $('#v-site').hidden = v !== 'site';
    $('#v-signup').hidden = v !== 'signup';
    $('#v-app').hidden = v !== 'app';
    if (v !== 'site') window.scrollTo(0, 0);
    if (v !== 'app') clearPageTimers();
    if (v !== 'signup') suStopGuide();
    VIEW = v;
  }
  renderHelp(v);
  if (v === 'site') document.title = 'Castvoo · Telegram broadcasts and auto follow-ups';
  if (v === 'signup') document.title = (SU.mode === 'login' ? 'Log in' : 'Sign up') + ' · Castvoo';
}

async function route() {
  const { head, sub, q } = parseHash();
  closeModal();
  if (typeof closeVideoGuide === 'function') closeVideoGuide(true);
  const hc = $('.helpc'); if (hc) hc.remove();
  if (head === 'signup' || head === 'login') {
    await ready();
    showView('signup');
    signupRoute(head === 'login' ? 'login' : sub, q);
    document.title = (SU.mode === 'login' && !sub ? 'Log in' : 'Sign up') + ' · Castvoo';
    return;
  }
  if (head === 'app') {
    await ready();
    showView('app');
    appRoute(sub, q);
    return;
  }
  if (head === 'join') {
    await ready();
    return acceptInvite(sub);
  }
  showView('site');
}

let mePromise = null, cfgPromise = null;
function meReady() { if (!mePromise) mePromise = loadMe(); return mePromise; }
function cfgReady() { if (!cfgPromise) cfgPromise = loadConfig(); return cfgPromise; }
/* Wait for both the site config and "who is logged in" (used before showing sign-up or the dashboard). */
function ready() { return Promise.all([cfgReady(), meReady()]); }

async function acceptInvite(token) {
  if (!token) { location.replace('#app'); return; }
  if (!ME.user) {
    store.sset('cv_join', token);
    showView('signup');
    SU.mode = 'login';
    signupRoute('login', {});
    const b = $('#suBody .su-step > div:nth-child(2) p'); if (b) b.textContent = 'Log in or create a free account to open your invite. You\'ll use your own login, nobody shares a password.';
    return;
  }
  store.sset('cv_join', null);
  showView('app');
  $('#pg').innerHTML = '<div class="pgload"><span class="spin"></span><span class="muted">Opening your invite…</span></div>';
  let inv = null;
  try { inv = await GET('/api/invites/' + encodeURIComponent(token)); } catch (e) {
    location.replace('#app');
    setTimeout(() => toast(e.status === 404 ? 'That invite has expired or was already used. Ask for a new one.' : e.message, { kind: 'err' }), 400);
    return;
  }
  if (inv.role === 'helper') return helperConsent(token, inv);
  $('#pg').innerHTML = '<div class="pgload"><span class="spin"></span><span class="muted">Joining the workspace…</span></div>';
  try {
    const r = await POST('/api/invites/accept', { token });
    WS.set(r.workspace_id);
    await loadMe();
    APP.booted = false;
    location.replace('#app');
    setTimeout(() => { confetti(); toast('You joined ' + ((APP.state && APP.state.workspace.name) || 'the workspace') + '.'); }, 600);
  } catch (e) {
    location.replace('#app');
    setTimeout(() => toast(e.status === 404 ? 'That invite has expired or was already used. Ask for a new one.' : e.message, { kind: 'err' }), 400);
  }
}

/* The setup helper's consent screen: who invites them, what they can and can't do, Accept / Decline. */
function helperConsent(token, inv) {
  const pg = $('#pg');
  document.title = 'Setup helper invite · Castvoo';
  pg.innerHTML = '<div class="hcons box"><span class="hcb">' + icon('users') + '</span><span class="kick">Setup helper invite</span>' +
    '<h2>' + esc(inv.owner_name) + '\'s workspace <em>"' + esc(inv.workspace_name) + '"</em> invites you as setup helper</h2>' +
    '<p class="muted">You\'ll set things up with <b>your own login</b>. Nobody shares a password, and ' + esc(inv.owner_name) + ' can remove you at any time.</p>' +
    helperLists(inv.can, inv.cannot, 'You') +
    (inv.already_member ? '<div class="note2"><span>ℹ️</span><span>You are already in this workspace.</span></div>' : '') +
    '<p class="ferr" id="hcE" hidden></p><div class="row2b"><button type="button" class="btn b-ghost" id="hcNo">Decline</button><button type="button" class="btn b-blue" id="hcYes"' + (inv.already_member ? ' disabled' : '') + '>' + icon('check') + 'Accept</button></div>' +
    '<small class="muted">Expires ' + esc(fmtDate(inv.expires_at, false)) + '. ' + (inv.kind === 'link' ? 'This link works once.' : 'This invite is for your email only.') + '</small></div>';
  $('#hcYes').onclick = async (e) => {
    await busy(e.currentTarget, 'Joining…', async () => {
      try {
        const r = await POST('/api/invites/accept', { token, consent: true });
        WS.set(r.workspace_id); await loadMe(); APP.booted = false;
        location.replace('#app');
        setTimeout(() => { confetti(); toast('You\'re now helping ' + inv.workspace_name + '. Let\'s set it up!'); }, 600);
      } catch (ex) { const er = $('#hcE'); er.textContent = ex.status === 404 ? 'That invite has expired or was already used. Ask for a new one.' : ex.message; er.hidden = false; }
    });
  };
  $('#hcNo').onclick = async (e) => {
    await busy(e.currentTarget, 'Declining…', async () => {
      try { await POST('/api/invites/decline', { token }); } catch (_) { /* gone already */ }
      location.replace('#app');
      setTimeout(() => toast('Invite declined. Nothing changed.'), 400);
    });
  };
}

function boot() {
  refCode();
  siteInit();
  signupInit();
  appInit();
  addEventListener('hashchange', route);
  route();
  ready().then(() => {
    siteApplyConfig();
    siteAuthUI();
    renderHelp(VIEW);
    if (APP.booted) appBanners();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

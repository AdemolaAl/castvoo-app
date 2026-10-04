'use strict';
/* Castvoo Admin — start-up: login gate, shell (menu, top bar, user menu), global handlers. */
(() => {
  const { html, icon, $, put, get, post, toast } = CV;

  function showGate(h) {
    $('#boot').hidden = true;
    $('#app').hidden = true;
    $('#gate').hidden = false;
    put($('#gate-card'), h);
  }

  /** Email → 6-digit code → logged in. */
  CV.showLogin = (msg) => {
    CV.me = null;
    let email = '';
    const step1 = () => {
      showGate(html`<svg class="lm"><use href="#logo"/></svg><div><h1>Castvoo Admin</h1><p>${msg || 'Log in with the email you use for Castvoo. We send you a 6-digit code.'}</p></div>
        <form class="stack" id="lf1"><div class="f"><label for="le">Email</label><input id="le" name="email" type="email" autocomplete="email" required placeholder="you@example.com" value="${email}"></div>
        <div class="ferr" hidden></div><button class="btn" type="submit">Send me a code ${icon('chev')}</button></form>
        <a class="small mut" href="/">← Back to castvoo.com</a>`);
      const f = $('#lf1');
      f.email.focus();
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('button', f); const err = $('.ferr', f);
        email = f.email.value.trim();
        if (!email) return;
        btn.classList.add('busy'); btn.disabled = true; err.hidden = true;
        try { await post('/api/auth/email/start', { email }); step2(); }
        catch (ex) { err.hidden = false; err.textContent = ex.message; btn.classList.remove('busy'); btn.disabled = false; }
      });
    };
    const step2 = () => {
      showGate(html`<svg class="lm"><use href="#logo"/></svg><div><h1>Check your email</h1><p>We sent a 6-digit code to <b>${email}</b>. Type it below.</p></div>
        <form class="stack" id="lf2"><div class="f"><label for="lc">Code</label><input id="lc" class="code-in" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required placeholder="••••••"></div>
        <div class="ferr" hidden></div><button class="btn" type="submit">Log in</button></form>
        <button class="btn ghost sm" id="lback" type="button">${icon('back')} Use another email</button>`);
      const f = $('#lf2');
      f.code.focus();
      $('#lback').addEventListener('click', step1);
      f.code.addEventListener('input', () => { f.code.value = f.code.value.replace(/\D/g, '').slice(0, 6); if (f.code.value.length === 6) f.requestSubmit(); });
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('button[type=submit]', f); const err = $('.ferr', f);
        if (btn.disabled) return;
        btn.classList.add('busy'); btn.disabled = true; err.hidden = true;
        try { await post('/api/auth/email/verify', { email, code: f.code.value }); location.reload(); }
        catch (ex) { err.hidden = false; err.textContent = ex.message; btn.classList.remove('busy'); btn.disabled = false; f.code.select(); }
      });
    };
    step1();
  };

  async function logout() {
    try { await post('/api/auth/logout'); } catch { /* ignore */ }
    location.href = '/admin';
  }

  function notStaff() {
    showGate(html`<svg class="lm"><use href="#logo"/></svg><div><h1>This area is for the Castvoo team</h1><p>You are logged in, but your account is not on the team. Ask the owner to add you in Admin → Team.</p></div>
      <a class="btn" href="/#app">Open my dashboard</a><button class="btn sec" id="lo" type="button">${icon('logout')} Log out</button>`);
    $('#lo').addEventListener('click', logout);
  }

  function shell() {
    const me = CV.me;
    const u = me.user;
    const roleName = me.role ? me.role.name : u.role;
    put($('#side-me'), html`<span class="av">${CV.initials(u.name, u.email)}</span><div style="min-width:0"><b>${u.name || u.email}</b><small>${roleName} · rank ${me.role ? me.role.rank : ''}</small></div>`);
    $('#rolebadge').textContent = roleName;
    $('#rolebadge').className = 'rolebadge bd role-' + u.role;
    $('#um-av').textContent = CV.initials(u.name, u.email);
    put($('#um-menu'), html`<div class="who"><b>${u.name || 'You'}</b><small>${u.email || ''}</small><div style="margin-top:6px">${CV.roleBadge(u.role, roleName)}</div></div>
      <a href="/#app" role="menuitem">${icon('dash')} Open dashboard</a>
      <a href="/" target="_blank" rel="noopener" role="menuitem">${icon('ext')} View website</a>
      <button type="button" role="menuitem" id="um-out">${icon('logout')} Log out</button>`);
    const btn = $('#um-btn'), menu = $('#um-menu');
    const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden)); });
    document.addEventListener('click', (e) => { if (!menu.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); CV.closeDrawer(); $('#tsearch').classList.remove('open'); } });
    $('#um-out').addEventListener('click', logout);

    // Slide menu
    $('#ham').addEventListener('click', CV.openDrawer);
    $('#side-x').addEventListener('click', CV.closeDrawer);
    $('#ov').addEventListener('click', CV.closeDrawer);

    // Search users from anywhere
    const ts = $('#tsearch');
    if (!CV.can('users.view')) { ts.remove(); $('#tsearch-btn').remove(); }
    else {
      ts.addEventListener('submit', (e) => { e.preventDefault(); const q = $('#tsearch-q').value.trim(); ts.classList.remove('open'); CV.go('users' + (q ? '?q=' + encodeURIComponent(q) : '')); $('#tsearch-q').value = ''; });
      $('#tsearch-btn').addEventListener('click', () => { ts.classList.toggle('open'); if (ts.classList.contains('open')) $('#tsearch-q').focus(); });
    }

    $('#boot').hidden = true;
    $('#gate').hidden = true;
    $('#app').hidden = false;
  }

  // Copy buttons anywhere: <button data-copy="text">
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    e.preventDefault();
    const text = b.dataset.copy;
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch { /* ignore */ } ta.remove();
    }
    toast(text.length > 40 ? 'Copied.' : `Copied ${text}`);
  });

  async function start() {
    try {
      CV.me = await get('/api/admin/me');
    } catch (e) {
      if (e.status === 401) return CV.showLogin();
      if (e.status === 403) return notStaff();
      showGate(html`<svg class="lm"><use href="#logo"/></svg><div><h1>Castvoo is not answering</h1><p>${e.message}</p></div><button class="btn" id="rt" type="button">${icon('refresh')} Try again</button>`);
      $('#rt').addEventListener('click', () => location.reload());
      return;
    }
    shell();
    window.addEventListener('hashchange', () => CV.route());
    await CV.route();
    if (CV.current !== 'overview' || !CV.counts.hasOwnProperty('support')) CV.refreshCounts();
    setInterval(() => { if (!document.hidden) CV.refreshCounts(); }, 60000);
  }

  start();
})();

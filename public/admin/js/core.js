'use strict';
/*
 * Castvoo Admin — core: safe HTML templates, API calls, toasts, dialogs, router, permissions.
 * Every page file registers itself with CV.page('key', { render(el, args, query) {...} }).
 */
(() => {
  const CV = (window.CV = { pages: {}, me: null, counts: {} });

  /* ---------- safe HTML ---------- */
  class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
  const raw = (s) => new Raw(String(s == null ? '' : s));
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const val = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(val).join('') : v === false || v == null ? '' : esc(v));
  /** html`<b>${text}</b>` — every value is escaped unless it is itself html`` or raw(). */
  function html(strings, ...vals) {
    let out = strings[0];
    for (let i = 0; i < vals.length; i++) out += val(vals[i]) + strings[i + 1];
    return new Raw(out);
  }
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const icon = (id, cls = '') => raw(`<svg class="i ${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`);
  /** Put html into an element. */
  const put = (el, h) => { el.innerHTML = val(h); return el; };
  /** Delegated events: on(root, 'click', '[data-x]', (e, target) => ...) */
  function on(root, type, sel, fn) {
    root.addEventListener(type, (e) => {
      const t = e.target.closest(sel);
      if (t && root.contains(t)) fn(e, t);
    });
  }

  /* ---------- formatting ---------- */
  const num = (n) => (Number(n) || 0).toLocaleString('en-US');
  function usd(d, { cents = false } = {}) {
    const v = Number(d) || 0;
    const whole = Math.abs(v - Math.round(v)) < 0.005;
    return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: whole && !cents ? 0 : 2, maximumFractionDigits: 2 });
  }
  const usdc = (c, o) => usd((Number(c) || 0) / 100, o);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function date(d) { if (!d) return '—'; const x = new Date(d); if (Number.isNaN(x.getTime())) return '—'; return `${x.getDate()} ${MON[x.getMonth()]} ${x.getFullYear()}`; }
  function time(d) { const x = new Date(d); return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`; }
  function dt(d) { if (!d) return '—'; const x = new Date(d); if (Number.isNaN(x.getTime())) return '—'; const sameYear = x.getFullYear() === new Date().getFullYear(); return `${x.getDate()} ${MON[x.getMonth()]}${sameYear ? '' : ' ' + x.getFullYear()}, ${time(x)}`; }
  function ago(d) {
    if (!d) return '—';
    const s = (Date.now() - new Date(d).getTime()) / 1000;
    if (s < 0) { const f = -s; if (f < 3600) return `in ${Math.max(1, Math.round(f / 60))} min`; if (f < 86400) return `in ${Math.round(f / 3600)} h`; return `in ${Math.round(f / 86400)} days`; }
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
    return date(d);
  }
  const isoDay = (d) => { if (!d) return ''; const x = new Date(d); if (Number.isNaN(x.getTime())) return ''; return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  const initials = (name, email) => { const s = (name || email || '?').trim(); const p = s.split(/[\s@._-]+/).filter(Boolean); return ((p[0] || '?')[0] + (p[1] ? p[1][0] : '')).toUpperCase(); };
  const plural = (n, w, ws) => `${num(n)} ${Number(n) === 1 ? w : ws || w + 's'}`;
  const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

  /* ---------- API ---------- */
  class ApiError extends Error { constructor(msg, status, code) { super(msg); this.status = status; this.code = code; } }
  async function api(method, url, body) {
    const opt = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (method !== 'GET') { opt.headers['Content-Type'] = 'application/json'; opt.headers['x-cv'] = '1'; opt.body = JSON.stringify(body || {}); }
    let res;
    try { res = await fetch(url, opt); } catch { throw new ApiError('Could not reach Castvoo. Check your internet and try again.', 0, 'network'); }
    let data = {};
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      if (res.status === 401 && CV.me) CV.showLogin('Your login has ended. Please log in again.');
      let msg = data.error || `Something went wrong (${res.status}).`;
      if (res.status === 403 && data.code === 'forbidden') msg = "Your role doesn't allow this.";
      throw new ApiError(msg, res.status, data.code);
    }
    return data;
  }
  const get = (u) => api('GET', u);
  const post = (u, b) => api('POST', u, b);
  const putj = (u, b) => api('PUT', u, b);
  const del = (u) => api('DELETE', u);

  /* ---------- toasts ---------- */
  function toast(msg, type = 'ok') {
    const box = $('#toasts');
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.setAttribute('role', type === 'bad' ? 'alert' : 'status');
    put(t, html`${icon(type === 'bad' ? 'warn' : type === 'info' ? 'info' : 'check')}<span>${msg}</span>`);
    box.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, type === 'bad' ? 6000 : 3200);
  }

  /** Run an action: shows a spinner on `btn`, a toast on success or error. Returns the result or undefined. */
  async function act(btn, fn, okMsg) {
    if (btn && btn.classList.contains('busy')) return undefined;
    if (btn) { btn.classList.add('busy'); btn.disabled = true; }
    try {
      const r = await fn();
      if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
      return r === undefined ? true : r;
    } catch (e) {
      toast(e.message || 'Something went wrong.', 'bad');
      return undefined;
    } finally {
      if (btn && btn.isConnected) { btn.classList.remove('busy'); btn.disabled = false; }
    }
  }

  /* ---------- dialogs ---------- */
  function field(f) {
    const id = 'f_' + f.name;
    const req = f.required ? raw(' required') : '';
    if (f.type === 'checkbox') return html`<label class="check"><input type="checkbox" name="${f.name}" ${f.value ? raw('checked') : ''}> ${f.label}</label>${f.hint ? html`<div class="hint">${f.hint}</div>` : ''}`;
    let input;
    if (f.type === 'select') input = html`<select id="${id}" name="${f.name}"${req}>${f.options.map((o) => html`<option value="${o.value}" ${String(o.value) === String(f.value ?? '') ? raw('selected') : ''}>${o.label}</option>`)}</select>`;
    else if (f.type === 'textarea') input = html`<textarea id="${id}" name="${f.name}" rows="${f.rows || 4}" placeholder="${f.placeholder || ''}"${req}${f.mono ? raw(' class="code"') : ''}>${f.value ?? ''}</textarea>`;
    else {
      const inp = html`<input id="${id}" name="${f.name}" type="${f.type || 'text'}" value="${f.value ?? ''}" placeholder="${f.placeholder || ''}"${req}${f.step ? html` step="${f.step}"` : ''}${f.min !== undefined ? html` min="${f.min}"` : ''}${f.max !== undefined ? html` max="${f.max}"` : ''} autocomplete="off">`;
      input = f.prefix ? html`<div class="pre"><span>${f.prefix}</span>${inp}</div>` : inp;
    }
    return html`<div class="f"><label for="${id}">${f.label}</label>${input}${f.hint ? html`<div class="hint">${f.hint}</div>` : ''}</div>`;
  }
  function formValues(form) {
    const out = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else out[el.name] = el.value;
    }
    return out;
  }

  /**
   * Open a dialog. Options: title, text, icon, danger, wide, body (html), fields (list), okText, cancelText,
   * onSubmit(values, dlg) async → return false to keep open. Resolves with values (or true) or null if cancelled.
   */
  function dialog(o) {
    return new Promise((resolve) => {
      const root = $('#modal-root');
      const wrap = document.createElement('div');
      wrap.className = 'mb';
      const prevFocus = document.activeElement;
      put(wrap, html`<form class="dlg${o.wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="dlg-t" novalidate>
        <div class="dlg-h"><div class="dic${o.danger ? ' bad' : ''}">${icon(o.icon || (o.danger ? 'warn' : 'info'))}</div><div><h3 id="dlg-t">${o.title}</h3>${o.text ? html`<p>${o.text}</p>` : ''}</div></div>
        ${o.body || (o.fields && o.fields.length) ? html`<div class="dlg-b">${o.body || ''}${(o.fields || []).map(field)}<div class="ferr" hidden></div></div>` : html`<div class="ferr" hidden style="padding:0 20px"></div>`}
        <div class="dlg-f">${o.cancelText === false ? '' : html`<button type="button" class="btn sec" data-cancel>${o.cancelText || 'Cancel'}</button>`}<button type="submit" class="btn${o.danger ? ' danger' : ''}">${o.okText || 'OK'}</button></div>
      </form>`);
      root.appendChild(wrap);
      const form = $('form', wrap);
      const err = $('.ferr', wrap);
      const close = (v) => { document.removeEventListener('keydown', onKey); wrap.remove(); if (prevFocus && prevFocus.focus) prevFocus.focus(); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') close(null); };
      document.addEventListener('keydown', onKey);
      wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(null); });
      $('[data-cancel]', wrap)?.addEventListener('click', () => close(null));
      if (o.onOpen) o.onOpen(form);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const values = formValues(form);
        for (const f of o.fields || []) {
          if (f.required && f.type !== 'checkbox' && !String(values[f.name] || '').trim()) { err.hidden = false; err.textContent = `Please fill in “${f.label}”.`; form.elements[f.name]?.focus(); return; }
        }
        if (!o.onSubmit) return close(Object.keys(values).length ? values : true);
        const btn = $('button[type=submit]', form);
        btn.classList.add('busy'); btn.disabled = true; err.hidden = true;
        try {
          const r = await o.onSubmit(values, form);
          if (r === false) { btn.classList.remove('busy'); btn.disabled = false; return; }
          close(r === undefined ? values : r);
        } catch (ex) {
          err.hidden = false; err.textContent = ex.message || 'Something went wrong.';
          btn.classList.remove('busy'); btn.disabled = false;
        }
      });
      setTimeout(() => { (form.querySelector('input:not([type=checkbox]),textarea,select') || $('button[type=submit]', form)).focus(); }, 30);
    });
  }
  const confirmBox = (title, text, opt = {}) => dialog({ title, text, danger: opt.danger, okText: opt.okText || 'Yes, do it', icon: opt.icon, body: opt.body }).then((v) => !!v);

  /* ---------- permissions ---------- */
  const can = (p) => !!(CV.me && CV.me.perms.includes(p));
  const role = () => (CV.me ? CV.me.user.role : null);
  const rank = (r) => { const x = CV.me && CV.me.roles.find((y) => y.key === r); return x ? x.rank : 0; };

  /* ---------- navigation ---------- */
  // perm = needed to see the page. Colors are the icon tiles in the menu.
  const NAV = [
    { group: null, items: [{ key: 'overview', label: 'Overview', icon: 'home', c: '#2F6BFF', perm: 'overview.view', desc: 'How Castvoo is doing today.' }] },
    { group: 'People', items: [
      { key: 'users', label: 'Users', icon: 'users', c: '#29A9EB', perm: 'users.view', desc: 'Find anyone and help them.' },
      { key: 'support', label: 'Support', icon: 'chat', c: '#7B5CF5', perm: 'support.view', desc: 'Answer customer messages.', badge: 'support' },
    ] },
    { group: 'Money', items: [
      { key: 'payments', label: 'Payments', icon: 'card', c: '#0E9F6E', perm: 'payments.view', desc: 'Top-ups and crypto checks.', badge: 'crypto' },
      { key: 'withdrawals', label: 'Withdrawals', icon: 'out', c: '#14B8A6', perm: 'payments.view', desc: 'Referral payouts to send.', badge: 'withdrawals' },
    ] },
    { group: 'Store', items: [
      { key: 'pricing', label: 'Pricing', icon: 'tag', c: '#F59E0B', perm: 'users.view', desc: 'Plans, prices and limits.' },
      { key: 'offers', label: 'Offers', icon: 'gift', c: '#EC4899', perm: 'users.view', desc: 'Bonuses, coupons, banners.' },
      { key: 'countries', label: 'Countries & payments', icon: 'globe', c: '#0EA5E9', perm: 'users.view', desc: 'Who can pay, and how.' },
    ] },
    { group: 'Website', items: [
      { key: 'content', label: 'Website text', icon: 'text', c: '#6366F1', perm: 'overview.view', desc: 'Words on castvoo.com.' },
      { key: 'emails', label: 'Emails', icon: 'mail', c: '#F97316', perm: 'overview.view', desc: 'Every email we send.' },
    ] },
    { group: 'Cas AI', items: [
      { key: 'knowledge', label: 'Knowledge', icon: 'book', c: '#8B5CF6', perm: 'overview.view', desc: 'What Cas knows.' },
      { key: 'ai', label: 'AI settings', icon: 'spark', c: '#A855F7', perm: 'overview.view', desc: 'How Cas writes.' },
    ] },
    { group: 'Platform', items: [
      { key: 'features', label: 'Features', icon: 'toggle', c: '#10B981', perm: 'overview.view', desc: 'Turn things on and off.' },
      { key: 'settings', label: 'Settings & connections', icon: 'plug', c: '#64748B', perm: 'overview.view', desc: 'Keys, company, money rules.' },
      { key: 'team', label: 'Team', icon: 'shield', c: '#111827', perm: 'overview.view', desc: 'Who can do what.' },
      { key: 'audit', label: 'Audit log', icon: 'list', c: '#475569', perm: 'audit.view', desc: 'Every change, who and when.' },
      { key: 'system', label: 'System', icon: 'cpu', c: '#334155', perm: 'system.view', desc: 'Queues and health.' },
    ] },
  ];
  const navItem = (key) => { for (const g of NAV) for (const i of g.items) if (i.key === key) return i; return null; };
  const allowed = (key) => { const n = navItem(key); return !!n && can(n.perm); };

  function renderNav() {
    const cur = CV.current;
    const badge = (b) => {
      const n = b === 'support' ? CV.counts.support : b === 'crypto' ? CV.counts.crypto : b === 'withdrawals' ? CV.counts.withdrawals : 0;
      return n ? html`<span class="b${b === 'withdrawals' ? ' blue' : ''}" title="${n} waiting">${n > 99 ? '99+' : n}</span>` : '';
    };
    put($('#nav'), NAV.map((g) => {
      const items = g.items.filter((i) => can(i.perm));
      if (!items.length) return '';
      return html`${g.group ? html`<div class="grp">${g.group}</div>` : ''}${items.map((i) => html`<a class="ni${cur === i.key ? ' on' : ''}" href="#${i.key}" style="--c:${i.c}" ${cur === i.key ? raw('aria-current="page"') : ''}>
        <span class="t">${icon(i.icon)}</span><span class="l">${i.label}<span class="d">${i.desc}</span></span>${i.badge ? badge(i.badge) : ''}</a>`)}`;
    }));
    const on_ = $('#nav .ni.on');
    if (on_ && on_.scrollIntoView) on_.scrollIntoView({ block: 'nearest' });
  }

  /* ---------- router ---------- */
  let token = 0;
  let leaveFns = [];
  CV.page = (key, def) => { CV.pages[key] = def; };
  /** Register cleanup for the current page (timers etc.). */
  CV.onLeave = (fn) => leaveFns.push(fn);
  CV.every = (ms, fn) => { const id = setInterval(fn, ms); leaveFns.push(() => clearInterval(id)); };
  CV.alive = (t) => t === token;
  CV.go = (hash) => { if (location.hash === '#' + hash) route(); else location.hash = hash; };
  CV.reload = () => route({ keepScroll: true });

  function parseHash() {
    const h = decodeURIComponent(location.hash.replace(/^#/, '')) || 'overview';
    const [path, qs] = h.split('?');
    const parts = path.split('/').filter(Boolean);
    return { key: parts[0] || 'overview', args: parts.slice(1), query: new URLSearchParams(qs || '') };
  }

  function skeleton() {
    return html`<div class="skp"><div class="sk a"></div><div class="kpis">${[1, 2, 3, 4].map(() => html`<div class="sk b"></div>`)}</div><div class="sk c"></div></div>`;
  }

  async function route(opts = {}) {
    if (!CV.me) return;
    let { key, args, query } = parseHash();
    if (!CV.pages[key] || !allowed(key)) {
      if (CV.pages[key] && navItem(key)) toast("Your role doesn't allow that page.", 'bad');
      key = 'overview'; args = []; query = new URLSearchParams();
      if (location.hash && location.hash !== '#overview') history.replaceState(null, '', '#overview');
    }
    leaveFns.forEach((f) => { try { f(); } catch { /* ignore */ } }); leaveFns = [];
    const my = ++token;
    const changed = CV.current !== key;
    CV.current = key;
    const n = navItem(key);
    $('#ttl').textContent = n.label;
    $('#ttl-sub').textContent = n.desc;
    document.title = n.label + ' · Castvoo Admin';
    renderNav();
    closeDrawer();
    const view = $('#view');
    const page = CV.pages[key];
    if (changed || !opts.keepScroll) { put(view, skeleton()); window.scrollTo(0, 0); }
    try {
      const out = await page.render({ args, query, token: my, alive: () => my === token });
      if (my !== token) return;
      put(view, html`${page.intro ? html`<div class="intro">${icon('info')}<span>${typeof page.intro === 'function' ? page.intro() : page.intro}</span></div>` : ''}<div class="page-body" id="pb"></div>`);
      const body = $('#pb');
      body.style.display = 'contents';
      if (out && out.html) put(body, out.html);
      if (out && out.mount) out.mount(body);
    } catch (e) {
      if (my !== token) return;
      put(view, html`<div class="card"><div class="empty"><div class="eic">${icon('warn')}</div><b>This page could not load</b><p>${e.message || 'Something went wrong.'}</p><button class="btn sec" id="retry">${icon('refresh')} Try again</button></div></div>`);
      $('#retry')?.addEventListener('click', () => route());
    }
  }

  /* ---------- drawer ---------- */
  function openDrawer() { $('#app').classList.add('drawer'); $('#ham').setAttribute('aria-expanded', 'true'); }
  function closeDrawer() { $('#app').classList.remove('drawer'); $('#ham')?.setAttribute('aria-expanded', 'false'); }

  /* ---------- counts in the menu ---------- */
  async function refreshCounts(ov) {
    try {
      const o = ov || await get('/api/admin/overview');
      CV.counts = {
        support: can('support.view') ? o.support.unread : 0,
        crypto: can('payments.view') ? o.money.crypto_to_check : 0,
        withdrawals: can('payments.view') ? o.money.withdrawals_waiting : 0,
      };
      renderNav();
      return o;
    } catch {
      // Overview failed: ask the smaller lists instead, so the menu badges still work.
      const [s, p, w] = await Promise.all([
        can('support.view') ? get('/api/admin/support?status=open').catch(() => null) : null,
        can('payments.view') ? get('/api/admin/payments?check=1').catch(() => null) : null,
        can('payments.view') ? get('/api/admin/withdrawals?status=requested').catch(() => null) : null,
      ]);
      CV.counts = { support: s ? s.counts.unread : 0, crypto: p ? p.totals.to_check : 0, withdrawals: w ? w.withdrawals.length : 0 };
      renderNav();
      return null;
    }
  }

  Object.assign(CV, {
    Raw, raw, esc, html, $, $$, icon, put, on, num, usd, usdc, date, dt, ago, time, isoDay, initials, plural, cap,
    api, get, post, put_: putj, putj, del, toast, act, dialog, confirm: confirmBox, field, formValues,
    can, role, rank, NAV, navItem, allowed, renderNav, route, openDrawer, closeDrawer, refreshCounts, ApiError,
  });
})();

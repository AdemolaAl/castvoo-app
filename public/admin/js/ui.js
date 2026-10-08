'use strict';
/* Castvoo Admin — small shared widgets: switches, badges, empty states, charts, copy buttons, explorer links. */
(() => {
  const { html, raw, icon, num, usd, date } = CV;

  /** A switch button. data attributes are passed as an object. */
  function sw(checked, data = {}, { lg = false, disabled = false, label = '' } = {}) {
    const attrs = Object.entries(data).map(([k, v]) => html` data-${k}="${v}"`);
    return html`<button type="button" class="sw${lg ? ' lg' : ''}" role="switch" aria-checked="${checked ? 'true' : 'false'}" aria-label="${label || 'Switch'}"${attrs}${disabled ? raw(' disabled') : ''}></button>`;
  }
  function setSw(el, v) { el.setAttribute('aria-checked', v ? 'true' : 'false'); }

  function empty(ic, title, text, action = '') {
    return html`<div class="empty"><div class="eic">${icon(ic)}</div><b>${title}</b>${text ? html`<p>${text}</p>` : ''}${action}</div>`;
  }

  const PLAN_STATUS = { trial: ['Free trial', 'blue'], active: ['Paying', 'ok'], paused: ['Paused', 'warn'], cancelled: ['Cancelled', 'bad'] };
  // free = the workspace is on the Free plan (its status is 'active' but it pays nothing), so it is not "Paying".
  const planBadge = (s, free) => { const x = free && s === 'active' ? ['Free plan', 'blue'] : PLAN_STATUS[s]; return x ? html`<span class="bd ${x[1]}"><span class="dot"></span>${x[0]}</span>` : html`<span class="bd">${s || 'No plan'}</span>`; };
  const PAY_STATUS = { pending: ['Waiting', 'warn'], paid: ['Paid', 'ok'], failed: ['Failed', 'bad'], rejected: ['Rejected', 'bad'], requested: ['Waiting', 'warn'] };
  const payBadge = (s) => { const x = PAY_STATUS[s] || [s, '']; return html`<span class="bd ${x[1]}">${x[0]}</span>`; };
  const roleBadge = (r, name) => r ? html`<span class="bd role-${r}">${name || CV.cap(r)}</span>` : '';
  const yes = (b, y = 'Yes', n = 'No') => (b ? html`<span class="bd ok">${y}</span>` : html`<span class="bd">${n}</span>`);

  /* ---------- crypto explorers ---------- */
  const isBtc = (coin) => String(coin || '').toUpperCase() === 'BTC';
  const txUrl = (coin, txid) => (isBtc(coin) ? 'https://mempool.space/tx/' : 'https://tronscan.org/#/transaction/') + encodeURIComponent(txid);
  const addrUrl = (coin, a) => (isBtc(coin) ? 'https://mempool.space/address/' : 'https://tronscan.org/#/address/') + encodeURIComponent(a);
  const explorerName = (coin) => (isBtc(coin) ? 'mempool.space' : 'Tronscan');

  /** A value with a copy button. */
  const copyField = (text, label = 'Copy') => html`<div class="cp"><code>${text}</code><button type="button" class="ib" data-copy="${text}" aria-label="${label}" title="${label}">${icon('copy')}</button></div>`;
  const copyBtn = (text, label = 'Copy') => html`<button type="button" class="ib sm" data-copy="${text}" aria-label="${label}" title="${label}">${icon('copy')}</button>`;

  /* ---------- bar chart (hand-drawn SVG) ---------- */
  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
  }
  /**
   * points: [{label, short, value}] → a clean bar chart with hover tooltips.
   * Drawn at the real width of its box (so text stays readable on phones) and redrawn on resize.
   */
  const charts = new Map();
  let chartId = 0;
  function barChart(points, { fmt = num, name = 'value' } = {}) {
    const id = 'c' + (++chartId);
    charts.set(id, { points, fmt });
    return html`<div class="chart" data-chart="${id}" role="img" aria-label="${name} per day, last ${points.length} days"><div class="sk" style="height:190px"></div></div>`;
  }
  function drawChart(ch) {
    const c = charts.get(ch.dataset.chart);
    if (!c) return;
    const { points, fmt } = c;
    const W = Math.max(260, Math.round(ch.clientWidth || 600)), H = 190, L = 46, R = 4, T = 10, B = 24;
    const max = niceMax(Math.max(0, ...points.map((p) => p.value)));
    const n = points.length || 1;
    const slot = (W - L - R) / n;
    const bw = Math.max(2, slot - Math.max(1.5, Math.min(6, slot * 0.28)));
    const y = (v) => T + (H - T - B) * (1 - v / max);
    const e = CV.esc;
    let s = '';
    for (const f of [0, 0.5, 1]) { const v = max * f; s += `<line class="gl" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L - 8}" y="${y(v) + 3.5}" text-anchor="end">${e(fmt(v))}</text>`; }
    s += `<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="#D3DAE8"/>`;
    points.forEach((p, i) => {
      const x = L + i * slot + (slot - bw) / 2;
      const top = y(p.value), base = y(0);
      const hgt = Math.max(0, base - top);
      const r = Math.min(4, bw / 2, hgt);
      if (hgt > 0.5) s += `<path class="bar" data-b="${i}" d="M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${base} Z"/>`;
      s += `<rect class="hit" x="${L + i * slot}" y="${T}" width="${slot}" height="${H - T - B}" fill="transparent" data-i="${i}" data-tip="${e(fmt(p.value))}" data-sub="${e(p.label)}"/>`;
    });
    const idx = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i);
    for (const i of idx) {
      const x = L + i * slot + slot / 2;
      s += `<text class="ax" x="${i === 0 ? L : i === n - 1 ? W - R : x}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${e(points[i] ? points[i].short || points[i].label : '')}</text>`;
    }
    ch.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${s}</svg><div class="tip" hidden></div>`;
  }
  function mountCharts(root) {
    CV.$$('.chart[data-chart]', root).forEach((ch) => {
      drawChart(ch);
      let w = ch.clientWidth;
      if (window.ResizeObserver) {
        const ro = new ResizeObserver(() => { if (Math.abs(ch.clientWidth - w) > 4) { w = ch.clientWidth; drawChart(ch); } });
        ro.observe(ch);
        CV.onLeave(() => ro.disconnect());
      }
      let last = null;
      ch.addEventListener('mousemove', (e) => {
        const t = e.target.closest('.hit');
        const tip = CV.$('.tip', ch);
        if (!t) { tip.hidden = true; if (last) last.classList.remove('hov'); return; }
        const box = ch.getBoundingClientRect();
        const r = t.getBoundingClientRect();
        if (last) last.classList.remove('hov');
        last = CV.$(`[data-b="${t.dataset.i}"]`, ch);
        if (last) last.classList.add('hov');
        CV.put(tip, html`${t.dataset.tip}<small>${t.dataset.sub}</small>`);
        tip.hidden = false;
        let left = r.left - box.left + r.width / 2;
        left = Math.max(50, Math.min(box.width - 50, left));
        tip.style.left = left + 'px';
        tip.style.top = (e.clientY - box.top) + 'px';
      });
      ch.addEventListener('mouseleave', () => { const tip = CV.$('.tip', ch); if (tip) tip.hidden = true; if (last) last.classList.remove('hov'); });
    });
  }
  const dayPoints = (rows, key) => rows.map((r) => {
    const d = new Date(r.day + 'T00:00:00');
    return { label: date(d), short: `${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]}`, value: Number(r[key]) || 0 };
  });

  /** Plans list, cached for a minute (used by several pages). */
  let plansCache = null, plansAt = 0;
  async function plans(force) {
    if (!force && plansCache && Date.now() - plansAt < 60000) return plansCache;
    plansCache = (await CV.get('/api/admin/plans')).plans; plansAt = Date.now();
    return plansCache;
  }
  const bustPlans = () => { plansCache = null; };

  /** Friendly names for integrations. */
  const INTEG = {
    telegram: 'Telegram bot', email: 'Email (Resend)', ai: 'Cas AI', paystack: 'Paystack', flutterwave: 'Flutterwave',
    gatevoo: 'Gatevoo', voosquare_login: 'VooSquare login', voosquare_api: 'VooSquare API',
  };

  function pager(page, pages, total) {
    if (pages <= 1) return '';
    return html`<div class="row between" style="padding:12px 16px;border-top:1px solid var(--line)"><span class="mut small">Page ${page} of ${pages} · ${num(total)} in total</span><div class="row">
      <button class="btn sec sm" data-page="${page - 1}" ${page <= 1 ? raw('disabled') : ''}>${icon('back')} Back</button>
      <button class="btn sec sm" data-page="${page + 1}" ${page >= pages ? raw('disabled') : ''}>Next ${icon('chev')}</button></div></div>`;
  }

  Object.assign(CV, { sw, setSw, empty, planBadge, payBadge, roleBadge, yes, txUrl, addrUrl, explorerName, copyField, copyBtn, barChart, mountCharts, dayPoints, plans, bustPlans, INTEG, pager, usdFmt: usd });
})();

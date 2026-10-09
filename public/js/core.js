'use strict';
/*
 * core.js: small helpers used everywhere (site, sign-up and dashboard).
 *   $ / $$          find elements
 *   esc()           make text safe to put inside HTML
 *   fmt(), money()  numbers and dollars
 *   toast()         the little message at the bottom of the screen
 *   cas()           draws Cas, the mascot.  moji() draws the illustrated people used in examples.
 *   ava()           initials avatar for real people (we never invent faces for real subscribers)
 *   guide()         the animated "connect Telegram in 40 seconds" player
 *   sheet(), modal(), closeModal()  pop-up windows
 */

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd = (n) => { const v = Number(n) || 0; return '$' + (Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })); };
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const icon = (n, cls) => '<svg' + (cls ? ' class="' + cls + '"' : '') + ' aria-hidden="true"><use href="#i-' + n + '"/></svg>';
const TG = '<svg class="tgi" aria-hidden="true"><use href="#i-tg"/></svg>';
const VF = '<svg class="vf" aria-hidden="true"><use href="#i-vf"/></svg>';

/* Telegram-style formatting: *bold* and _italic_. Same rules as the server (services/telegram.js). */
/* {name} = each person's first name (see server/services/telegram.js). {name|friend} sets the word used when there's no name. */
const NAME_TAG = /\{(?:name|first_?name)(?:\|([^{}\n]{0,30}))?\}/gi;
const hasNameTag = (s) => { NAME_TAG.lastIndex = 0; const r = NAME_TAG.test(String(s || '')); NAME_TAG.lastIndex = 0; return r; };
/* Telegram-style formatting for previews.
 * {name}: no opts → shown as a "👤 name" chip; opts.name → that sample name; opts.name === null → the fallback word. */
function fmtMsg(s, opts) {
  const names = [];
  const raw = String(s || '').replace(NAME_TAG, (m, fb) => { names.push(!opts ? '👤 name' : opts.name ? opts.name : (fb && fb.trim()) || 'there'); return '\u0001'; });
  let h = esc(raw).replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/gm, '$1<i>$2</i>');
  let i = 0;
  h = h.replace(/\u0001/g, () => '<span class="nmtag">' + esc(names[i++] || '') + '</span>');
  return h;
}
/* Characters as Telegram counts them (format marks don't count; {name} counts as 20). Same as the server. */
function visibleLength(text) {
  const t = String(text || '').replace(NAME_TAG, (m, fb) => 'x'.repeat(Math.max(20, fb ? [...fb.trim()].length : 5)));
  return [...t.replace(/\*([^*\n]+)\*/g, '$1').replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/gm, '$1$2')].length;
}

/* Dates */
function toDate(v) { const d = v instanceof Date ? v : new Date(v); return Number.isNaN(d.getTime()) ? null : d; }
function fmtDate(v, withTime = true) {
  const d = toDate(v); if (!d) return '';
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
  return withTime ? day + ', ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : day;
}
function ago(v) {
  const d = toDate(v); if (!d) return '';
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 0) return 'in ' + until(d);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 172800) return 'yesterday';
  if (s < 604800) return Math.floor(s / 86400) + ' days ago';
  return fmtDate(d, false);
}
function until(v) {
  const d = toDate(v); if (!d) return '';
  const s = (d.getTime() - Date.now()) / 1000;
  if (s <= 60) return 'a moment';
  if (s < 3600) return Math.round(s / 60) + ' min';
  if (s < 86400) return Math.round(s / 3600) + ' hours';
  const days = Math.ceil(s / 86400);
  return days + (days === 1 ? ' day' : ' days');
}
const plural = (n, one, many) => fmt(n) + ' ' + (Number(n) === 1 ? one : (many || one + 's'));

/* Storage that never throws (private windows can block it). */
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) { /* ignore */ } },
  sget(k) { try { return sessionStorage.getItem(k); } catch (_) { return null; } },
  sset(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (_) { /* ignore */ } },
};

/* Toast. opts: { kind: 'ok' | 'err' | 'info', action: { label, onClick } , ms } */
/* iPhone: a field that still has focus when its screen goes away keeps the keyboard up (and Safari's focus zoom) on
   the next screen. Called after log-in and on every sign-up step and view change. */
function dropFocus() {
  try {
    const a = document.activeElement;
    if (a && a !== document.body && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable) && a.blur) a.blur();
  } catch (_) { /* nothing focused */ }
}

function toast(text, opts = {}) {
  $$('.toast').forEach((x) => x.remove());
  const d = document.createElement('div');
  d.className = 'toast' + (opts.kind === 'err' ? ' err' : '');
  d.setAttribute('role', opts.kind === 'err' ? 'alert' : 'status');
  const ic = opts.kind === 'err' ? '<span class="tic">!</span>' : opts.kind === 'info' ? '<span class="tic i">i</span>' : '<svg width="16" height="16" style="color:#7CF0B8;flex:none" aria-hidden="true"><use href="#i-check"/></svg>';
  d.innerHTML = ic + '<span class="tt">' + esc(text) + '</span>';
  if (opts.action) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'tact'; b.textContent = opts.action.label;
    b.onclick = () => { d.remove(); opts.action.onClick(); };
    d.appendChild(b);
  }
  const x = document.createElement('button');
  x.type = 'button'; x.className = 'tx'; x.setAttribute('aria-label', 'Close'); x.innerHTML = '×';
  x.onclick = () => d.remove();
  d.appendChild(x);
  document.body.appendChild(d);
  const ms = opts.ms || (opts.kind === 'err' || opts.action ? 7000 : 3200);
  setTimeout(() => d.remove(), ms);
}

function confetti() {
  if (RM) return;
  const c = document.createElement('div'); c.className = 'confetti';
  const cols = ['#2F6BFF', '#6EC3FF', '#0F33A8', '#33C08A', '#F5B935'];
  for (let i = 0; i < 80; i++) {
    const p = document.createElement('i');
    p.style.left = Math.random() * 100 + '%'; p.style.background = cols[i % 5];
    p.style.animationDuration = (1.6 + Math.random() * 1.6) + 's'; p.style.animationDelay = (Math.random() * 0.4) + 's';
    c.appendChild(p);
  }
  document.body.appendChild(c);
  setTimeout(() => c.remove(), 3600);
}

function countTo(el, to, dur, f) {
  if (!el) return;
  f = f || fmt;
  if (RM || !to) { el.textContent = f(to || 0); return; }
  const t0 = performance.now();
  (function step(t) { const k = Math.min(1, (t - t0) / (dur || 1000)); el.textContent = f(to * (1 - Math.pow(1 - k, 3))); if (k < 1 && el.isConnected) requestAnimationFrame(step); })(t0);
}

function copyText(t, msg) {
  const done = () => toast(msg || 'Copied');
  try {
    if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(t).then(done, () => fallbackCopy(t, done)); return; }
  } catch (_) { /* fall through */ }
  fallbackCopy(t, done);
}
function fallbackCopy(t, done) {
  const a = document.createElement('textarea'); a.value = t; a.setAttribute('readonly', ''); a.style.position = 'fixed'; a.style.opacity = '0';
  document.body.appendChild(a); a.select();
  try { document.execCommand('copy'); done(); } catch (_) { toast(t, { kind: 'info' }); }
  a.remove();
}

/* ===== Illustrated people (marketing examples only) ===== */
const P = {
  tunde: { n: 'Tunde', skin: '#8D5524', hair: '#1E1611', st: 'short', shirt: '#2F6BFF', bg: '#E3ECFF' },
  wanjiku: { n: 'Wanjiku', skin: '#6B4226', hair: '#1E1611', st: 'puff', shirt: '#12B886', bg: '#E2F6EE' },
  kwame: { n: 'Kwame', skin: '#5C3A21', hair: '#1E1611', st: 'short', beard: 1, shirt: '#F59F00', bg: '#FCF2DE' },
  thandi: { n: 'Thandi', skin: '#A0693F', hair: '#2B1B12', st: 'long', shirt: '#E64980', bg: '#FDECEC' },
  zainab: { n: 'Zainab', skin: '#C68642', hair: '#1E1611', st: 'long', glasses: 1, shirt: '#7950F2', bg: '#EFEBFF' },
  ejiro: { n: 'Ejiro', skin: '#8D5524', hair: '#1E1611', st: 'short', glasses: 1, shirt: '#0B1430', bg: '#DCE6FF' },
  sipho: { n: 'Sipho', skin: '#6B4226', hair: '#1E1611', st: 'bald', beard: 1, shirt: '#15AABF', bg: '#E5F4FC' },
  fatou: { n: 'Fatou', skin: '#5C3A21', hair: '#1E1611', st: 'puff', glasses: 1, shirt: '#FA5252', bg: '#FDECEC' },
  emeka: { n: 'Emeka', skin: '#7A4B2A', hair: '#1E1611', st: 'short', shirt: '#2F9E44', bg: '#E2F6EE' },
  ama: { n: 'Ama', skin: '#8D5524', hair: '#2B1B12', st: 'long', shirt: '#F08C00', bg: '#FCF2DE' },
};
function mojiParts(o, opt) {
  opt = opt || {};
  const sk = o.skin, hr = o.hair || '#1E1611';
  let back = '', front = '';
  if (o.st === 'long') { back = '<path d="M27 66c0-26 15-41 33-41s33 15 33 41v28c0 6-4 9-9 9H36c-5 0-9-3-9-9z" fill="' + hr + '"/>'; front = '<path d="M33 55c3-16 14-25 27-25s24 9 27 25c-10-3-20-9-26-17-6 8-17 14-28 17z" fill="' + hr + '"/>'; }
  else if (o.st === 'puff') { back = '<circle cx="60" cy="42" r="31" fill="' + hr + '"/><circle cx="36" cy="54" r="15" fill="' + hr + '"/><circle cx="84" cy="54" r="15" fill="' + hr + '"/>'; front = '<path d="M34 54c4-12 14-19 26-19s22 7 26 19c-8-4-17-6-26-6s-18 2-26 6z" fill="' + hr + '"/>'; }
  else if (o.st === 'short') { front = '<path d="M31 59c0-21 13-32 29-32s29 11 29 32c-4-8-9-12-15-13-9 4-20 4-29 0-6 1-11 5-14 13z" fill="' + hr + '"/>'; }
  // Eyes and mouth: normal, asleep (opt.sleep), worn out (opt.tired) or blissed out (opt.bliss).
  const eyes = opt.sleep ? '<path d="M44 67q5 4 10 0M66 67q5 4 10 0" stroke="#1B1B24" stroke-width="3" fill="none" stroke-linecap="round"/>'
    : opt.tired ? '<path d="M44.6 66a4.4 4.4 0 0 0 8.8 0zM66.6 66a4.4 4.4 0 0 0 8.8 0z" fill="#1B1B24"/><path d="M43 65.5h12M65 65.5h12" stroke="#1B1B24" stroke-width="2.8" stroke-linecap="round"/><path d="M44 73q5 3 10 0M66 73q5 3 10 0" stroke="#4A2A1A" stroke-width="2" fill="none" stroke-linecap="round" opacity=".45"/>'
    : opt.bliss ? '<path d="M44 68q5-6 10 0M66 68q5-6 10 0" stroke="#1B1B24" stroke-width="3" fill="none" stroke-linecap="round"/>'
    : '<g class="blk"><circle cx="49" cy="66" r="3.7" fill="#1B1B24"/><circle cx="71" cy="66" r="3.7" fill="#1B1B24"/></g>';
  const mouth = opt.sleep ? '<path d="M55 80q5 3 10 0" stroke="#1B1B24" stroke-width="2.6" fill="none" stroke-linecap="round"/>'
    : opt.tired ? '<path d="M53 82q2.3-2 4.6 0t4.6 0t4.6 0" stroke="#1B1B24" stroke-width="2.6" fill="none" stroke-linecap="round"/>'
    : opt.bliss ? '<path d="M53 79q7 5 14 0" stroke="#1B1B24" stroke-width="2.8" fill="none" stroke-linecap="round"/>'
    : '<path d="M51 78q9 8 18 0" stroke="#1B1B24" stroke-width="3" fill="#fff" stroke-linecap="round"/>';
  return back + '<rect x="53" y="84" width="14" height="14" rx="5" fill="' + sk + '"/><circle cx="31" cy="66" r="6" fill="' + sk + '"/><circle cx="89" cy="66" r="6" fill="' + sk + '"/><circle cx="60" cy="64" r="29" fill="' + sk + '"/>' + front +
    (o.beard ? '<path d="M37 74c3 13 12 20 23 20s20-7 23-20c-6 5-14 7-23 7s-17-2-23-7z" fill="' + hr + '" opacity=".9"/>' : '') + eyes +
    '<path d="M43 58q6-3 11 0M66 58q6-3 11 0" stroke="' + hr + '" stroke-width="2.6" fill="none" stroke-linecap="round"/>' + mouth +
    '<circle cx="41" cy="76" r="5" fill="#FF7A7A" opacity=".28"/><circle cx="79" cy="76" r="5" fill="#FF7A7A" opacity=".28"/>' +
    (o.glasses ? '<rect x="39" y="59" width="19" height="14" rx="6" fill="none" stroke="#1B1B24" stroke-width="2.6"/><rect x="62" y="59" width="19" height="14" rx="6" fill="none" stroke="#1B1B24" stroke-width="2.6"/><path d="M58 65h4" stroke="#1B1B24" stroke-width="2.6"/>' : '') +
    (opt.phones ? '<path d="M28 66a32 34 0 0 1 64 0" stroke="#0B1430" stroke-width="5" fill="none"/><rect x="22" y="58" width="11" height="20" rx="5" fill="#0B1430"/><rect x="87" y="58" width="11" height="20" rx="5" fill="#0B1430"/>' : '');
}
function moji(k, opt) {
  const o = P[k] || P.tunde; opt = opt || {};
  return '<svg viewBox="0 0 120 120" aria-hidden="true">' + (opt.nobg ? '' : '<rect width="120" height="120" fill="' + o.bg + '"/>') + '<path d="M20 124c3-18 18-27 40-27s37 9 40 27z" fill="' + o.shirt + '"/>' + mojiParts(o, opt) +
    (opt.wave ? '<g class="wvl"><path d="M98 122c8-10 12-22 10-36" stroke="' + o.skin + '" stroke-width="10" fill="none" stroke-linecap="round"/><circle cx="108" cy="84" r="7" fill="' + o.skin + '"/></g>' : '') + '</svg>';
}
function mav(k, size) { return '<span class="mav"' + (size ? ' style="width:' + size + 'px;height:' + size + 'px"' : '') + '>' + moji(k) + '</span>'; }

/* Initials avatar for real people. Colour comes from the name so it stays the same. */
const AVC = [['#E3ECFF', '#1D4FD8'], ['#E2F6EE', '#0E7A55'], ['#FCF2DE', '#9A6408'], ['#FDECEC', '#C2353A'], ['#EFEBFF', '#5B3DF5'], ['#E5F4FC', '#0A6C9E'], ['#FFF1E6', '#C4520A']];
function ava(name, size) {
  const n = String(name || '?').trim() || '?';
  const parts = n.replace(/^@/, '').split(/\s+/).filter(Boolean);
  const ini = ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  let h = 0; for (const ch of n) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const c = AVC[h % AVC.length];
  const s = size || 36;
  return '<span class="mav ini" style="width:' + s + 'px;height:' + s + 'px;background:' + c[0] + ';color:' + c[1] + ';font-size:' + Math.round(s * 0.38) + 'px">' + esc(ini) + '</span>';
}

/* ===== Cas, the mascot ===== */
function cas(mode) {
  const happy = mode === 'happy', think = mode === 'think', mini = mode === 'mini';
  const eyes = happy ? '<path d="M76 98q8-9 16 0M108 98q8-9 16 0" stroke="#0B1430" stroke-width="5.5" fill="none" stroke-linecap="round"/>' :
    '<g class="blk"><ellipse cx="84" cy="97" rx="13" ry="15" fill="#fff"/><ellipse cx="116" cy="97" rx="13" ry="15" fill="#fff"/></g><g class="' + (think ? '' : 'lk') + '"' + (think ? ' transform="translate(2 -4)"' : '') + '><circle cx="86" cy="99" r="7.5" fill="#0B1430"/><circle cx="118" cy="99" r="7.5" fill="#0B1430"/><circle cx="88.5" cy="96" r="2.6" fill="#fff"/><circle cx="120.5" cy="96" r="2.6" fill="#fff"/></g>';
  const mouth = happy ? '<path d="M86 120q14 16 28 0z" fill="#0B1430"/><path d="M93 126q7 5 14 0" fill="#FF7A9A"/>' : (think ? '<path d="M94 124q6-3 12 0" stroke="#0B1430" stroke-width="4" fill="none" stroke-linecap="round"/>' : '<path d="M88 119q12 12 24 0" stroke="#0B1430" stroke-width="4.5" fill="none" stroke-linecap="round"/>');
  if (mini) return '<svg viewBox="40 40 120 120" aria-hidden="true"><circle cx="100" cy="104" r="56" fill="url(#casG)"/><ellipse cx="84" cy="97" rx="12" ry="14" fill="#fff"/><ellipse cx="116" cy="97" rx="12" ry="14" fill="#fff"/><circle cx="86" cy="99" r="7" fill="#0B1430"/><circle cx="118" cy="99" r="7" fill="#0B1430"/><path d="M88 119q12 12 24 0" stroke="#0B1430" stroke-width="5" fill="none" stroke-linecap="round"/></svg>';
  const right = think ? '<g><ellipse cx="156" cy="128" rx="11" ry="9" fill="url(#casA)" transform="rotate(-30 156 128)"/></g><g class="gl"><circle cx="160" cy="62" r="5" fill="#CFE0FF"/><circle cx="172" cy="44" r="8" fill="#CFE0FF"/><circle cx="150" cy="22" r="15" fill="#fff" stroke="#DCE6FF" stroke-width="2"/><path d="M150 14l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" fill="#2F6BFF"/></g>' :
    '<g class="wv"><ellipse cx="160" cy="112" rx="11" ry="9" fill="url(#casA)" transform="rotate(-50 160 112)"/><g transform="translate(160 82) rotate(-18)"><path d="M0 12 L24 2 L24 32 L0 22z" fill="#fff" stroke="#0B1430" stroke-width="3.2" stroke-linejoin="round"/><path d="M7 9l0 16" stroke="#2F6BFF" stroke-width="3"/><rect x="-7" y="11" width="9" height="12" rx="3" fill="#0B1430"/><path d="M31 8q7 9 0 18M38 3q13 14 0 28" stroke="#6EC3FF" stroke-width="3.2" fill="none" stroke-linecap="round" class="gl"/></g></g>';
  const left = happy ? '<g class="wvl"><ellipse cx="44" cy="104" rx="11" ry="9" fill="url(#casA)" transform="rotate(50 44 104)"/></g>' : '<ellipse cx="44" cy="130" rx="11" ry="9" fill="url(#casA)" transform="rotate(30 44 130)"/>';
  return '<svg viewBox="0 0 200 200" role="img" aria-label="Cas, the Castvoo helper"><ellipse cx="100" cy="188" rx="44" ry="7" fill="#0B1430" opacity=".14"/><g class="fl">' +
    '<g transform="translate(100 30)"><circle r="9" fill="none" stroke="#6EC3FF" stroke-width="2.6" class="rg"/><circle r="9" fill="none" stroke="#6EC3FF" stroke-width="2.6" class="rg rg2"/><circle r="9" fill="none" stroke="#6EC3FF" stroke-width="2.6" class="rg rg3"/></g>' +
    '<path d="M100 50V36" stroke="#1638B8" stroke-width="4.5" stroke-linecap="round"/><circle cx="100" cy="30" r="7" fill="#6EC3FF"/><circle cx="98" cy="28" r="2.4" fill="#fff"/>' + left +
    '<circle cx="100" cy="106" r="58" fill="url(#casG)"/><ellipse cx="80" cy="74" rx="22" ry="12" fill="#fff" opacity=".35" transform="rotate(-25 80 74)"/><circle cx="68" cy="86" r="4" fill="#fff" opacity=".6"/>' +
    '<ellipse cx="74" cy="118" rx="8" ry="5" fill="#FF8FB1" opacity=".55"/><ellipse cx="126" cy="118" rx="8" ry="5" fill="#FF8FB1" opacity=".55"/>' + eyes + mouth + right + '</g></svg>';
}
function paintCas(root) { $$('[data-cas]:not([data-ok])', root).forEach((e) => { e.innerHTML = cas(e.dataset.cas); e.setAttribute('data-ok', ''); }); }
function paintMoji(root) { $$('[data-moji]:not([data-ok])', root).forEach((e) => { e.innerHTML = moji(e.dataset.moji); e.setAttribute('data-ok', ''); }); }

/* Falling bills and coins (decoration). */
function paintMoney(root) {
  if (RM) return;
  $$('[data-money]:not([data-ok])', root).forEach((e) => {
    const n = +e.dataset.money || 10, h = e.dataset.h || e.offsetHeight || 320;
    let s = '';
    for (let i = 0; i < n; i++) {
      const bill = i % 3 !== 2;
      s += '<i class="' + (bill ? 'bill' : 'coin') + '" style="left:' + (4 + Math.random() * 90) + '%;--h:' + (+h + 80) + 'px;--r:' + (Math.random() > 0.5 ? '' : '-') + (200 + Math.random() * 300) + 'deg;animation-duration:' + (5 + Math.random() * 6) + 's;animation-delay:-' + (Math.random() * 9) + 's">$</i>';
    }
    e.innerHTML = s; e.setAttribute('data-ok', ''); e.setAttribute('aria-hidden', 'true'); // decoration: no stray "$" for screen readers
  });
}

/* Night scene: someone asleep while Castvoo works. */
function sleeper() {
  const o = P.zainab;
  return '<svg class="nsv" viewBox="0 0 440 360" role="img" aria-label="A person asleep at a laptop while Castvoo sends messages"><defs><radialGradient id="glw" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#6EC3FF" stop-opacity=".45"/><stop offset="1" stop-color="#6EC3FF" stop-opacity="0"/></radialGradient><linearGradient id="hood" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4B80FF"/><stop offset="1" stop-color="#1F4FE0"/></linearGradient></defs>' +
    '<g>' + Array.from({ length: 16 }, (_, i) => '<circle cx="' + (20 + ((i * 67) % 400)) + '" cy="' + (14 + ((i * 41) % 120)) + '" r="' + (i % 3 ? 1.2 : 1.8) + '" fill="#fff" style="animation:tw ' + (2 + i % 4) + 's ease-in-out infinite ' + (i * 0.3) + 's"/>').join('') + '</g>' +
    '<g transform="translate(372 46)"><circle r="22" fill="#FFE8A3"/><circle cx="-9" cy="-6" r="20" fill="#0D1640"/></g>' +
    '<ellipse cx="220" cy="190" rx="200" ry="70" fill="none" stroke="rgba(255,255,255,.12)" stroke-dasharray="4 7"/>' +
    '<g style="animation:orbit 28s linear infinite;transform-origin:220px 190px"><g transform="translate(20 190)"><g style="animation:orbitR 28s linear infinite;transform-box:fill-box;transform-origin:center"><circle r="18" fill="#fff"/><use href="#i-tg" x="-13" y="-13" width="26" height="26"/></g></g><g transform="translate(420 190)"><g style="animation:orbitR 28s linear infinite;transform-box:fill-box;transform-origin:center"><circle r="18" fill="#2F6BFF"/><use href="#logo" x="-13" y="-13" width="26" height="26"/></g></g></g>' +
    '<ellipse cx="220" cy="200" rx="120" ry="90" fill="url(#glw)"/>' +
    '<g style="animation:breathe 4.5s ease-in-out infinite;transform-origin:220px 260px">' +
    '<path d="M138 272C138 214 172 186 220 186s82 28 82 86z" fill="url(#hood)"/><path d="M206 190q14 18 28 0" stroke="#1638B8" stroke-width="3" fill="none"/><path d="M208 196v18M232 196v18" stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity=".8"/>' +
    '<g transform="translate(150 70) scale(1.17)">' + mojiParts(o, { sleep: 1, phones: 1 }) + '</g>' +
    '</g>' +
    '<g style="font:800 18px Plus Jakarta Sans,sans-serif" fill="#CFE0FF"><text x="262" y="96" style="animation:zz 3s ease-out infinite">z</text><text x="270" y="86" style="animation:zz 3s ease-out infinite 1s;font-size:22px">z</text><text x="280" y="76" style="animation:zz 3s ease-out infinite 2s;font-size:26px">Z</text></g>' +
    '<path d="M150 214h140a8 8 0 0 1 8 8v52H142v-52a8 8 0 0 1 8-8z" fill="#DCE4F7"/><path d="M152 216h136a6 6 0 0 1 6 6v50H146v-50a6 6 0 0 1 6-6z" fill="#E9EEFA"/><use href="#logo" x="204" y="230" width="32" height="32"/>' +
    '<path d="M126 274h188l-10 12H136z" fill="#B9C5E3"/>' +
    '<rect x="30" y="286" width="380" height="14" rx="7" fill="#1A2763"/><rect x="60" y="300" width="10" height="50" rx="4" fill="#121C4A"/><rect x="370" y="300" width="10" height="50" rx="4" fill="#121C4A"/>' +
    '<g transform="translate(66 228)"><g style="animation:sway 5s ease-in-out infinite;transform-origin:20px 30px"><path d="M20 30C6 18 4 2 10-6c10 8 14 22 10 36z" fill="#33C08A"/><path d="M20 30c10-16 26-22 34-18-4 12-18 20-34 18z" fill="#26A776"/><path d="M20 30C14 14 22 0 30-4c4 12-2 26-10 34z" fill="#4FD39E"/></g><rect x="4" y="28" width="32" height="30" rx="7" fill="#3B4A8F"/></g>' +
    '<g transform="translate(330 252)"><rect width="26" height="32" rx="7" fill="#F5F7FC"/><path d="M26 8q10 0 10 9t-10 9" stroke="#F5F7FC" stroke-width="4" fill="none"/><path d="M8 -6q-4-6 0-12M16 -6q-4-6 0-12" stroke="#CFE0FF" stroke-width="2.4" fill="none" stroke-linecap="round" style="animation:steam 2.6s ease-in infinite"/></g>' +
    '</svg>';
}
function walletArt() {
  return '<svg viewBox="0 0 200 170" aria-hidden="true"><ellipse cx="96" cy="160" rx="70" ry="7" fill="#000" opacity=".18"/>' +
    '<g class="bills"><rect x="44" y="18" width="92" height="52" rx="7" fill="#26A776" transform="rotate(-10 90 44)"/><rect x="54" y="12" width="92" height="52" rx="7" fill="#33C08A" stroke="#8EE8C2" stroke-width="2.5" transform="rotate(6 100 38)"/><circle cx="100" cy="38" r="12" fill="none" stroke="#8EE8C2" stroke-width="2.5" transform="rotate(6 100 38)"/><text x="100" y="44" text-anchor="middle" font-family="Plus Jakarta Sans,sans-serif" font-weight="800" font-size="16" fill="#0B5E3E" transform="rotate(6 100 38)">$</text></g>' +
    '<rect x="22" y="56" width="150" height="96" rx="20" fill="#0B1430"/><rect x="22" y="56" width="150" height="34" rx="16" fill="#18234A"/><rect x="118" y="84" width="62" height="36" rx="12" fill="#2F6BFF"/><circle cx="138" cy="102" r="7" fill="#fff"/><path d="M40 132h60" stroke="#26315E" stroke-width="5" stroke-linecap="round"/>' +
    '<g class="c1"><circle cx="176" cy="40" r="15" fill="#F5B935" stroke="#FFE08A" stroke-width="3"/><text x="176" y="46" text-anchor="middle" font-family="Plus Jakarta Sans,sans-serif" font-weight="800" font-size="14" fill="#7A4D00">$</text></g>' +
    '<g class="c2"><circle cx="20" cy="40" r="11" fill="#F5B935" stroke="#FFE08A" stroke-width="2.5"/><text x="20" y="45" text-anchor="middle" font-family="Plus Jakarta Sans,sans-serif" font-weight="800" font-size="11" fill="#7A4D00">₮</text></g>' +
    '<g class="c3"><circle cx="186" cy="132" r="10" fill="#F5B935" stroke="#FFE08A" stroke-width="2.5"/></g></svg>';
}
/* Illustrations by name: <div data-art="sleeper"></div>. Other files can add more (see site-story.js). */
const ART = { sleeper: () => sleeper(), wallet: () => walletArt() };
function paintArt(root) { $$('[data-art]:not([data-ok])', root).forEach((e) => { e.innerHTML = (ART[e.dataset.art] || ART.wallet)(); e.setAttribute('data-ok', ''); if (ART[e.dataset.art + 'Init']) ART[e.dataset.art + 'Init'](e); }); }
function paintAll(root) { paintCas(root); paintMoji(root); paintArt(root); paintMoney(root); }

/* Gatevoo brand badge: "Crypto checkout by Gatevoo". */
function gatevooBadge(small) {
  return '<span class="gvb' + (small ? ' sm' : '') + '"><span class="gvt">Crypto checkout by</span><span class="gvl"><span class="gvm" aria-hidden="true">G</span><span class="gvw">Gate<i>voo</i></span></span></span>';
}

/* ===== Pop-ups: sheet (slides up on phones) and modal ===== */
let onModalClose = null;
function closeModal() {
  const h = $('#modalHost');
  if (h && h.innerHTML) {
    h.innerHTML = '';
    if (typeof GUIDES !== 'undefined') GUIDES.modal.forEach((g) => g.stop());
    GUIDES.modal = [];
    document.body.classList.remove('noscroll');
    const f = onModalClose; onModalClose = null;
    if (f) f();
  }
}
/* sheet(title, iconHtml, bodyHtml, { onClose, wide }) -> the host element. */
function sheet(title, iconHtml, body, opts = {}) {
  const h = $('#modalHost');
  if (h.innerHTML) { GUIDES.modal.forEach((g) => g.stop()); GUIDES.modal = []; }
  onModalClose = null;
  h.innerHTML = '<div class="sheet-ov"><div class="sheet' + (opts.wide ? ' wide' : '') + '" role="dialog" aria-modal="true" aria-labelledby="shT"><span class="grab"></span><div class="sh">' + (iconHtml || '') + '<h3 id="shT">' + title + '</h3><button type="button" class="ib" data-shx aria-label="Close"><svg><use href="#i-x"/></svg></button></div><div class="sb">' + body + '</div></div></div>';
  paintAll(h);
  document.body.classList.add('noscroll');
  onModalClose = opts.onClose || null;
  $$('[data-shx]', h).forEach((b) => { b.onclick = closeModal; });
  $('.sheet-ov', h).addEventListener('mousedown', (e) => { if (e.target.classList.contains('sheet-ov') && !opts.sticky) closeModal(); });
  return h;
}
/* Ask the user to confirm something. Resolves true / false. */
function confirmBox(title, text, okLabel, danger) {
  return new Promise((resolve) => {
    const h = sheet(esc(title), '<span class="spk"' + (danger ? ' style="background:var(--bad)"' : '') + '>' + icon(danger ? 'trash' : 'check') + '</span>',
      '<p class="muted" style="font-size:15px">' + text + '</p><div class="row2b"><button type="button" class="btn b-ghost" data-no>Cancel</button><button type="button" class="btn ' + (danger ? 'b-bad' : 'b-blue') + '" data-yes>' + esc(okLabel || 'Yes') + '</button></div>',
      { onClose: () => resolve(false) });
    $('[data-no]', h).onclick = () => { closeModal(); };
    $('[data-yes]', h).onclick = () => { onModalClose = null; closeModal(); resolve(true); };
  });
}

/* ===== The setup guide player (Telegram screens, animated) ===== */
const GUIDES = { modal: [], page: [] };
const GUIDE_TOKEN = '7284419012:AAH-k2Pq9xYvB3mNcQ81sLwe0Ztr';
const GUIDE_CH = [
  { t: 0, n: 'Open @BotFather', d: 'Open Telegram and search for @BotFather, the official bot for making bots.' },
  { t: 8000, n: 'Create your bot', d: 'Send /newbot, pick a name and a username ending in "bot". BotFather replies with your token.' },
  { t: 20000, n: 'Paste in Castvoo', d: 'Paste the token into Castvoo and tap Connect. It checks with Telegram in seconds.' },
  { t: 29000, n: 'Add a channel', d: 'Posting to a channel? Tap "Add a channel" in Castvoo. Telegram opens with our bot ready: pick your channel and confirm.' },
];
const GUIDE_TOTAL = 41500;
const platformBot = () => ((typeof CFG !== 'undefined' && CFG.bot_username) || 'CastvooBot');
function bfAva() { return '<span class="tg-ava" style="background:linear-gradient(145deg,#5AC8FA,#1E96E8)"><svg viewBox="0 0 32 32"><rect x="8" y="10" width="16" height="13" rx="5" fill="#fff"/><circle cx="13" cy="16" r="1.8" fill="#1E96E8"/><circle cx="19" cy="16" r="1.8" fill="#1E96E8"/><path d="M12 20.5q4 2.5 8 0" stroke="#1E96E8" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M16 10V7" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><circle cx="16" cy="6" r="1.6" fill="#fff"/></svg></span>'; }
function guideActions() {
  const A = [];
  const at = (t, f) => A.push({ t, f });
  const type = (t0, key, txt, step) => { for (let i = 1; i <= txt.length; i++) at(t0 + i * step, (s) => { s[key] = txt.slice(0, i); }); };
  at(0, (s) => { Object.assign(s, { scr: 'list', search: '', res: false, msgs: [], input: '', typing: false, start: false, toast: '', tap: '', cvTok: '', cvSt: 'idle', cvFoc: false, paste: false, perms: [false, false, false], added: false, sel: false }); });
  at(900, (s) => { s.tap = 'srch'; }); type(1200, 'search', 'BotFather', 150);
  at(2800, (s) => { s.res = true; }); at(3900, (s) => { s.tap = 'res'; });
  at(4500, (s) => { s.scr = 'chat'; s.start = true; }); at(5700, (s) => { s.tap = 'start'; });
  at(6100, (s) => { s.start = false; s.msgs.push({ o: 1, t: '/start' }); }); at(6600, (s) => { s.typing = true; });
  at(7400, (s) => { s.typing = false; s.msgs.push({ t: 'Hi! I can help you create and manage Telegram bots. Send /newbot to make a new one.' }); });
  type(8300, 'input', '/newbot', 130); at(9400, (s) => { s.tap = 'send'; }); at(9600, (s) => { s.msgs.push({ o: 1, t: s.input }); s.input = ''; });
  at(10000, (s) => { s.typing = true; }); at(10800, (s) => { s.typing = false; s.msgs.push({ t: 'Alright, a new bot. What should we call it?' }); });
  type(11400, 'input', 'Zed Sales', 110); at(12600, (s) => { s.tap = 'send'; }); at(12800, (s) => { s.msgs.push({ o: 1, t: s.input }); s.input = ''; });
  at(13200, (s) => { s.typing = true; }); at(13900, (s) => { s.typing = false; s.msgs.push({ t: 'Nice. Now choose a username. It has to end in "bot", like zedsales_bot.' }); });
  type(14500, 'input', 'zedsales_bot', 100); at(15900, (s) => { s.tap = 'send'; }); at(16100, (s) => { s.msgs.push({ o: 1, t: s.input }); s.input = ''; });
  at(16500, (s) => { s.typing = true; }); at(17300, (s) => { s.typing = false; s.msgs.push({ t: 'Done! Your new bot is ready. Use this token to connect it:', tok: 1 }); });
  at(18300, (s) => { s.tap = 'tok'; s.sel = true; }); at(18700, (s) => { s.toast = 'Token copied'; }); at(19700, (s) => { s.toast = ''; s.sel = false; });
  at(20000, (s) => { s.scr = 'cv'; }); at(21000, (s) => { s.tap = 'cvf'; s.cvFoc = true; }); at(21500, (s) => { s.paste = true; }); at(22200, (s) => { s.tap = 'paste'; }); at(22400, (s) => { s.paste = false; s.cvTok = GUIDE_TOKEN; });
  at(23400, (s) => { s.tap = 'cvb'; }); at(23600, (s) => { s.cvSt = 'busy'; }); at(25600, (s) => { s.cvSt = 'ok'; });
  at(29000, (s) => { s.scr = 'pick'; s.pick = ''; }); at(29800, (s) => { s.pick = 'Brand Updates'; }); at(31000, (s) => { s.tap = 'pb'; });
  at(31800, (s) => { s.scr = 'perms'; s.perms = [false, false, false]; }); at(32600, (s) => { s.perms = [true, false, false]; }); at(33300, (s) => { s.perms = [true, true, false]; }); at(34000, (s) => { s.perms = [true, true, true]; }); at(35000, (s) => { s.tap = 'done'; });
  at(35600, (s) => { s.scr = 'admins'; s.added = true; s.toast = 'Castvoo can now post here'; }); at(39500, (s) => { s.toast = ''; });
  return A.sort((a, b) => a.t - b.t);
}
function guideScreen(s) {
  const top = (title, sub, avaHtml, back) => '<div class="tg-top"><span class="bk">' + (back === false ? '' : '‹') + '</span><div class="tt"><b>' + title + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</div>' + (avaHtml || '<span style="width:32px"></span>') + '</div>';
  const cvAva = '<span class="tg-ava" style="background:var(--grad)"><svg viewBox="0 0 40 40"><use href="#logo"/></svg></span>';
  if (s.scr === 'list') {
    const rows = [['Saved Messages', '#5AC8FA', '🔖', 'Voice note'], ['Team chat', '#2F6BFF', 'T', 'Done ✅'], ['Brand Updates', '#7950F2', 'B', 'New post is live'], ['Family', '#33C08A', 'F', 'Call me later'], ['Market news', '#F59F00', 'M', 'Today\'s summary']];
    return top('Chats', '', null, false) + '<div class="tg-list"><div class="tg-srch' + (s.search ? ' has' : '') + '" data-t="srch">🔍 ' + (s.search ? esc(s.search) + '<span class="caret"></span>' : 'Search') + '</div>' +
      (s.res ? '<div class="tg-gs">GLOBAL SEARCH</div><div class="tg-row hl" data-t="res">' + bfAva() + '<div class="tx"><b>BotFather ' + VF + '</b><small>@BotFather · bot</small></div></div>' :
        rows.map((r, i) => '<div class="tg-row"><span class="tg-ava" style="background:' + r[1] + '">' + r[2] + '</span><div class="tx"><b>' + r[0] + '</b><small>' + r[3] + '</small></div><span class="tm2">09:4' + i + '</span></div>').join('')) + '</div>';
  }
  if (s.scr === 'chat') {
    let m = s.msgs.map((x, i) => '<div class="tm ' + (x.o ? 'out' : 'in') + '">' + esc(x.t) + (x.tok ? '<span class="tok' + (s.sel ? ' sel' : '') + '" data-t="tok">' + GUIDE_TOKEN + '</span>' : '') + '<span class="ti">09:4' + (i % 10) + (x.o ? ' ✓✓' : '') + '</span></div>').join('');
    if (s.typing) m += '<div class="tg-typing"><i></i><i></i><i></i></div>';
    return top('BotFather ' + VF, 'bot', bfAva()) + '<div class="tg-bg">' + m + '</div>' + (s.start ? '<div class="tg-start" data-t="start">START</div>' : '<div class="tg-in"><span class="pc0">📎</span><span class="fld' + (s.input ? ' has' : '') + '">' + (s.input ? esc(s.input) : 'Message') + '</span><span class="sb" data-t="send">➤</span></div>');
  }
  if (s.scr === 'cv') {
    return '<div class="cv-scr"><div style="display:flex;align-items:center;gap:8px"><svg width="28" height="28"><use href="#logo"/></svg><b style="font-size:15px;letter-spacing:-.04em">Cast<span style="color:var(--blue)">voo</span></b></div><div class="t">Connect your Telegram bot</div><div style="font-size:11px;color:var(--mut)">Paste the token BotFather gave you.</div><div class="f' + (s.cvTok ? ' has' : '') + (s.cvFoc ? ' foc' : '') + '" data-t="cvf">' + (s.paste ? '<span class="paste" data-t="paste">Paste</span>' : '') + (s.cvTok || '123456:ABC-…') + '</div>' +
      (s.cvSt === 'ok' ? '<div class="cv-ok"><svg width="34" height="34" style="flex:none"><use href="#i-tg"/></svg><div><b>@zedsales_bot connected</b><small>Ready to send messages</small></div></div><div style="width:90px;align-self:center">' + cas('happy') + '</div>' : '<div class="cb2" data-t="cvb">' + (s.cvSt === 'busy' ? '<span class="spin" style="width:14px;height:14px;border-color:rgba(255,255,255,.35);border-top-color:#fff"></span>Checking with Telegram…' : 'Connect') + '</div>') + '</div>';
  }
  if (s.scr === 'pick') {
    return top('Choose a channel', '@' + esc(platformBot()), cvAva) + '<div class="tg-list"><div class="tg-note">Pick the channel Castvoo should post to</div>' +
      [['Brand Updates', '#7950F2', 'B', '9,640 subscribers'], ['Daily Tips', '#F59F00', 'D', '1,206 subscribers']].map((r) => '<div class="tg-row' + (s.pick === r[0] ? ' hl' : '') + '"' + (r[0] === 'Brand Updates' ? ' data-t="pb"' : '') + '><span class="tg-ava" style="background:' + r[1] + '">' + r[2] + '</span><div class="tx"><b>' + r[0] + '</b><small>' + r[3] + '</small></div></div>').join('') + '</div>';
  }
  if (s.scr === 'perms') {
    const L = ['Post messages', 'Edit messages of others', 'Delete messages of others'];
    return top('Admin Rights', '', null) + '<div class="tg-sec"><div class="tg-chhd" style="padding:12px 0">' + cvAva.replace('tg-ava"', 'tg-ava" data-big') + '<b style="font-size:13px">Castvoo</b><small style="color:#8A93A6;font-size:11px">@' + esc(platformBot()) + '</small></div><div class="tg-cap">WHAT CAN THIS ADMIN DO?</div><div class="tg-grp">' + L.map((l, i) => '<div class="tg-it"><span class="tx">' + l + '</span><span class="tsw' + (s.perms[i] ? ' on' : '') + '"><i></i></span></div>').join('') + '</div><div class="tg-grp"><div class="tg-it blue" data-t="done" style="justify-content:center">Add as admin</div></div></div>';
  }
  if (s.scr === 'admins') {
    return top('Administrators', 'Brand Updates', null) + '<div class="tg-sec"><div class="tg-grp"><div class="tg-it"><span class="tg-ava" style="width:28px;height:28px;background:#2F6BFF">Y</span><span class="tx"><b>You</b><br><small style="color:#8A93A6">Owner</small></span></div>' + (s.added ? '<div class="tg-it hl" style="animation:pop .4s var(--ease)"><span class="tg-ava" style="width:28px;height:28px;background:var(--grad)"><svg viewBox="0 0 40 40"><use href="#logo"/></svg></span><span class="tx"><b>Castvoo</b><br><small style="color:#34C759">bot · can post messages</small></span><span style="color:#34C759;font-weight:800">✓</span></div>' : '') + '</div></div>';
  }
  return '';
}
/* guide(hostElement, { compact, start }) -> { stop() } */
function guide(host, opt) {
  opt = opt || {};
  host.innerHTML = '<div class="gp' + (opt.compact ? ' compact' : '') + '"><div class="gp-ph"><div class="notch"></div><div class="scr"><div class="sl"></div></div><span class="gp-ex">Example</span></div><div class="gp-side">' + (opt.compact ? '' : '<span class="gp-live"><i></i>Setup guide · 0:41</span><h3 class="h3">From @BotFather to connected, every tap.</h3>') + '<div class="gp-ch">' + GUIDE_CH.map((c, i) => '<button type="button" class="gp-c" data-c="' + i + '"><span class="n">' + (i + 1) + '</span><span><b>' + c.n + '</b><small>' + c.d + '</small></span><span class="bar"></span></button>').join('') + '</div><div class="gp-ctl"><button type="button" class="gp-pl" aria-label="Pause"><svg><use href="#i-pause"/></svg></button><div class="gp-seg">' + GUIDE_CH.map((c, i) => '<i data-c="' + i + '"><b></b></i>').join('') + '</div><span class="gp-tm">0:00 / 0:41</span></div></div></div>';
  const S = {}, A = guideActions(), scr = $('.scr', host), stage = $('.sl', host);
  let t = 0, ai = 0, playing = !RM, last = 0, raf = 0, lastScr = '', dead = false;
  function render() {
    const html = guideScreen(S);
    if (S.scr !== lastScr) { stage.style.animation = 'none'; void stage.offsetWidth; stage.style.animation = ''; lastScr = S.scr; }
    stage.innerHTML = html + (S.toast ? '<div class="tg-toast">' + esc(S.toast) + '</div>' : '');
    const bg = $('.tg-bg', stage); if (bg) bg.scrollTop = bg.scrollHeight;
    if (S.tap) {
      const el = $('[data-t="' + S.tap + '"]', stage);
      if (el) { const r = el.getBoundingClientRect(), p = scr.getBoundingClientRect(); const d = document.createElement('span'); d.className = 'touch'; d.style.left = (r.left - p.left + r.width / 2) + 'px'; d.style.top = (r.top - p.top + r.height / 2) + 'px'; scr.appendChild(d); setTimeout(() => d.remove(), 700); }
      S.tap = '';
    }
  }
  function seek(ms) { t = ms; ai = 0; while (ai < A.length && A[ai].t <= t) { A[ai].f(S); ai++; } S.tap = ''; lastScr = ''; render(); ui(); }
  function ui() {
    const ci = GUIDE_CH.reduce((a, c, i) => (t >= c.t ? i : a), 0);
    const endOf = (i) => (i < GUIDE_CH.length - 1 ? GUIDE_CH[i + 1].t : GUIDE_TOTAL);
    $$('.gp-c', host).forEach((b, i) => { b.classList.toggle('on', i === ci); b.classList.toggle('done', i < ci); const p = Math.max(0, Math.min(1, (t - GUIDE_CH[i].t) / (endOf(i) - GUIDE_CH[i].t))); $('.bar', b).style.width = (i === ci ? p * 100 : 0) + '%'; });
    $$('.gp-seg i', host).forEach((s, i) => { s.firstChild.style.width = Math.max(0, Math.min(1, (t - GUIDE_CH[i].t) / (endOf(i) - GUIDE_CH[i].t))) * 100 + '%'; });
    const sec = (x) => Math.floor(x / 60000) + ':' + String(Math.floor(x / 1000) % 60).padStart(2, '0');
    $('.gp-tm', host).textContent = sec(Math.min(t, GUIDE_TOTAL)) + ' / ' + sec(GUIDE_TOTAL);
    const pl = $('.gp-pl', host); pl.innerHTML = '<svg><use href="#i-' + (playing ? 'pause' : 'play') + '"/></svg>'; pl.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }
  function loop(now) {
    if (dead) return;
    raf = requestAnimationFrame(loop);
    if (!playing || document.hidden || !host.isConnected || host.offsetParent === null) { last = now; return; }
    const dt = Math.min(100, now - (last || now)); last = now; t += dt;
    let ch = false;
    while (ai < A.length && A[ai].t <= t) { A[ai].f(S); ai++; ch = true; }
    if (ch) render();
    if (t >= GUIDE_TOTAL + 1500) seek(0);
    ui();
  }
  $('.gp-pl', host).onclick = () => { playing = !playing; if (playing && t >= GUIDE_TOTAL) seek(0); ui(); };
  host.addEventListener('click', (e) => { const c = e.target.closest('[data-c]'); if (c) { seek(GUIDE_CH[+c.dataset.c].t + 1); playing = true; ui(); } });
  seek(RM ? GUIDE_CH[3].t + 7000 : (opt.start ? GUIDE_CH[opt.start].t + 1 : 0));
  raf = requestAnimationFrame(loop);
  return { stop() { dead = true; cancelAnimationFrame(raf); } };
}
/* The guide in a pop-up. */
function openGuide(chapter, back) {
  const h = sheet('Connect Telegram', '<svg width="36" height="36" style="flex:none"><use href="#i-tg"/></svg>', '<p class="muted" style="font-size:14px;margin-top:-8px">40-second walkthrough · tap a step to jump</p><div data-guide-host></div>', { wide: true, onClose: back });
  GUIDES.modal.push(guide($('[data-guide-host]', h), { start: chapter || 0, compact: innerWidth < 700 }));
}

/* Load an outside script once (Telegram login, Gatevoo checkout). */
const loadedScripts = {};
function loadScript(src) {
  if (loadedScripts[src]) return loadedScripts[src];
  loadedScripts[src] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { delete loadedScripts[src]; reject(new Error('Could not load ' + src)); };
    document.head.appendChild(s);
  });
  return loadedScripts[src];
}

/* Read "?a=1&b=2" style params from a string. */
function parseQuery(s) {
  const out = {};
  new URLSearchParams(String(s || '').replace(/^\?/, '')).forEach((v, k) => { out[k] = v; });
  return out;
}

/* Tiny sparkline (used in dashboard KPIs). */
function spark(vals, color) {
  const v = (vals && vals.length > 1) ? vals : [0, 0];
  const w = 200, h = 36, mx = Math.max(...v), mn = Math.min(...v);
  const pts = v.map((x, i) => [i / (v.length - 1) * w, h - 4 - (x - mn) / (mx - mn || 1) * (h - 10)]);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const l = pts[pts.length - 1];
  return '<svg class="sp" viewBox="0 0 200 36" preserveAspectRatio="none" aria-hidden="true"><path d="' + d + ' L200 36 L0 36Z" fill="' + color + '" opacity=".1"/><path class="ln" d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2.2" vector-effect="non-scaling-stroke"/><circle cx="' + l[0] + '" cy="' + l[1] + '" r="3.2" fill="' + color + '"/></svg>';
}

/* ---------- Support chat helpers (Help page and the website chat) ---------- */
/* The small "Powered by Replyvoo" line (Admin → Support AI). Replyvoo is Zedapex's AI support product. */
function poweredBy(text) {
  return text ? '<a class="pwr" href="https://replyvoo.com" target="_blank" rel="noopener"><span class="pwr-b" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M9.2 1.5 3.6 9h3.6l-.9 5.5L12.4 7H8.6z"/></svg></span>' + esc(text) + '</a>' : '';
}
/* Tap a chat image to see it big. Esc, tap or the close button closes it. */
function openLightbox(src) {
  const d = document.createElement('div');
  d.className = 'lbx'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Image');
  d.innerHTML = '<button type="button" class="ib lbx-x" aria-label="Close">' + icon('x') + '</button><img src="' + esc(src) + '" alt="Image">';
  const close = () => { d.remove(); document.removeEventListener('keydown', key); };
  const key = (e) => { if (e.key === 'Escape') close(); };
  d.onclick = (e) => { if (e.target.tagName !== 'IMG') close(); };
  document.addEventListener('keydown', key);
  document.body.appendChild(d);
  $('.lbx-x', d).focus();
}

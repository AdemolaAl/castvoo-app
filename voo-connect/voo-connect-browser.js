/*!
 * Voo Connect for landing pages (no dependencies, any browser).
 * Keeps the affiliate click (ref, vclick, coupon) a visitor arrives with, in sessionStorage and a first-party cookie
 * (voo_attr, 60 days, the same cookie the Voo Connect server middleware reads), and adds it to your "Start free" and
 * "Log in" links, so VooSquare can credit the right affiliate when the Voo ID is created.
 *
 *   <script src="/voo-connect-browser.js" defer></script>
 *
 * Options (attributes on the script tag, all optional):
 *   data-domain=".joinvoo.com"   share the cookie with every subdomain (www, app). Default: this host only.
 *   data-links="a.start"         CSS selector of the links to decorate. Default: links to /auth/voosquare, links to
 *                                .../oauth/authorize and any link with the data-voo-start attribute.
 *   data-off                     do nothing (Affleego, which is not in the affiliate program).
 * In code: window.VooConnect.params() → { ref, vclick, coupon }, .decorate(url) → url with them, .refresh(), .clear().
 */
(function (w, d) {
  'use strict';
  if (!w || !d || w.VooConnect) return;
  var KEYS = ['ref', 'vclick', 'coupon'];
  var RX = { ref: /^[A-Za-z0-9_-]{3,24}$/, vclick: /^[A-Za-z0-9_-]{6,40}$/, coupon: /^[A-Za-z0-9_-]{3,24}$/ };
  var NAME = 'voo_attr';
  var DAYS = 60;
  var script = d.currentScript || null;
  var opt = function (k) { return script && script.getAttribute ? script.getAttribute(k) : null; };
  var off = opt('data-off') !== null;
  var domain = opt('data-domain') || '';
  var selector = opt('data-links') || 'a[data-voo-start], a[href*="/auth/voosquare"], a[href*="/oauth/authorize"]';

  function clean(o) {
    var out = {};
    if (!o) return out;
    for (var i = 0; i < KEYS.length; i++) {
      var k = KEYS[i]; var v = o[k] == null ? '' : String(o[k]).replace(/^\s+|\s+$/g, '');
      if (v && RX[k].test(v)) out[k] = v;
    }
    return out;
  }
  function parse(qs) {
    var o = {};
    String(qs || '').replace(/^\?/, '').split('&').forEach(function (p) {
      if (!p) return;
      var i = p.indexOf('='); var k = i < 0 ? p : p.slice(0, i); var v = i < 0 ? '' : p.slice(i + 1);
      try { k = decodeURIComponent(k.replace(/\+/g, ' ')); v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { return; }
      if (!(k in o)) o[k] = v;
    });
    return o;
  }
  function encode(o) {
    var parts = [];
    for (var i = 0; i < KEYS.length; i++) if (o[KEYS[i]]) parts.push(KEYS[i] + '=' + encodeURIComponent(o[KEYS[i]]));
    if (o.t) parts.push('t=' + o.t);
    return parts.join('&');
  }
  function readCookie() {
    var all = String(d.cookie || '').split(';');
    for (var i = 0; i < all.length; i++) {
      var c = all[i].replace(/^\s+/, '');
      if (c.indexOf(NAME + '=') === 0) { try { return decodeURIComponent(c.slice(NAME.length + 1)); } catch (e) { return ''; } }
    }
    return '';
  }
  function writeCookie(val, maxAge) {
    try {
      d.cookie = NAME + '=' + encodeURIComponent(val) + '; Path=/; Max-Age=' + maxAge + '; SameSite=Lax' +
        (domain ? '; Domain=' + domain : '') + (w.location && w.location.protocol === 'https:' ? '; Secure' : '');
    } catch (e) { /* cookies blocked: sessionStorage still works for this tab */ }
  }
  function readSession() { try { return w.sessionStorage ? w.sessionStorage.getItem(NAME) || '' : ''; } catch (e) { return ''; } }
  function writeSession(val) { try { if (w.sessionStorage) { if (val) w.sessionStorage.setItem(NAME, val); else w.sessionStorage.removeItem(NAME); } } catch (e) { /* private mode */ } }

  function kept() {
    var s = parse(readSession()); var c = parse(readCookie());
    var a = clean(s); var b = clean(c);
    // The newer of the two wins (a tab that saw a newer click keeps it).
    return (Number(s.t) || 0) >= (Number(c.t) || 0) && Object.keys(a).length ? withT(a, s.t) : withT(b, c.t);
  }
  function withT(o, t) { if (Number(t) > 0) o.t = Number(t); return o; }
  /* Last click wins (the same rule as the server kit's mergeAttribution): a new vclick replaces everything; ?ref= alone of
   * the SAME affiliate keeps the kept vclick and coupon (a tool carrying ?ref= onto its own links); ?ref= of another
   * affiliate replaces everything; a coupon on its own is added to the kept click. */
  function sameRef(a, b) { return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase(); }
  function capture() {
    var fresh = clean(parse(w.location && w.location.search));
    var old = kept(); var o = clean(old); var next = null;
    if (fresh.vclick) next = withT(fresh, Date.now());
    else if (fresh.ref && sameRef(fresh.ref, o.ref)) { next = o; if (fresh.coupon) next.coupon = fresh.coupon; next.t = Number(old.t) || Date.now(); }
    else if (fresh.ref) next = withT(fresh, Date.now());
    else if (fresh.coupon) { next = o; next.coupon = fresh.coupon; next.t = Date.now(); }
    if (next) { var v = encode(next); writeSession(v); writeCookie(v, DAYS * 86400); }
  }
  function params() { var o = clean(kept()); return o; }
  function decorate(url) {
    var p = params();
    if (!url || !Object.keys(p).length) return url;
    var hash = ''; var h = url.indexOf('#');
    if (h >= 0) { hash = url.slice(h); url = url.slice(0, h); }
    var q = url.indexOf('?'); var have = q < 0 ? {} : parse(url.slice(q + 1));
    var add = [];
    for (var i = 0; i < KEYS.length; i++) { var k = KEYS[i]; if (p[k] && !have[k]) add.push(k + '=' + encodeURIComponent(p[k])); }
    if (!add.length) return url + hash;
    return url + (q < 0 ? '?' : (url.charAt(url.length - 1) === '?' || url.charAt(url.length - 1) === '&' ? '' : '&')) + add.join('&') + hash;
  }
  function refresh(root) {
    if (off) return;
    var links = (root || d).querySelectorAll ? (root || d).querySelectorAll(selector) : [];
    for (var i = 0; i < links.length; i++) {
      var a = links[i]; var href = a.getAttribute ? a.getAttribute('href') : a.href;
      if (href) { var n = decorate(href); if (n !== href) { if (a.setAttribute) a.setAttribute('href', n); else a.href = n; } }
    }
  }
  function clear() { writeSession(''); writeCookie('', 0); }

  if (!off) {
    capture();
    if (d.readyState === 'loading' && d.addEventListener) d.addEventListener('DOMContentLoaded', function () { refresh(); });
    else refresh();
    // Links added later (single-page apps): decorate at click time too.
    if (d.addEventListener) d.addEventListener('click', function (e) {
      var el = e.target;
      while (el && el.tagName !== 'A') el = el.parentNode;
      if (el && el.matches && el.matches(selector)) refresh(el.parentNode || d);
    }, true);
  }
  w.VooConnect = { params: params, decorate: decorate, refresh: refresh, clear: clear, version: '1.1.0' };
})(typeof window !== 'undefined' ? window : null, typeof document !== 'undefined' ? document : null);

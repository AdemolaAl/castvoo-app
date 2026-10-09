'use strict';
/*
 * blog.js: small extras for the server-rendered blog pages. Everything still works without it.
 *   - "Copy link" share button      - the phone menu closes on outside tap / Escape
 *   - reading progress bar           - the table of contents follows the section you are reading
 */
(function () {
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // Copy link
  $$('[data-copy]').forEach(function (b) {
    if (!navigator.clipboard) return;
    b.hidden = false;
    b.addEventListener('click', function () {
      var label = b.querySelector('span');
      navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function () {
        b.classList.add('ok');
        if (label) label.textContent = 'Copied';
        setTimeout(function () { b.classList.remove('ok'); if (label) label.textContent = 'Copy link'; }, 1800);
      }, function () { /* clipboard refused: nothing to do */ });
    });
  });

  // Phone menu (a <details>): close on outside tap, Escape, or following a link.
  var menu = document.querySelector('.bm');
  if (menu) {
    document.addEventListener('click', function (e) { if (menu.open && !menu.contains(e.target)) menu.open = false; });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && menu.open) { menu.open = false; menu.querySelector('summary').focus(); } });
    $$('a', menu).forEach(function (a) { a.addEventListener('click', function () { menu.open = false; }); });
  }
  // Mobile table of contents closes after a pick.
  $$('.toc-m a').forEach(function (a) { a.addEventListener('click', function () { var d = a.closest('details'); if (d) d.open = false; }); });

  var article = document.getElementById('article');
  if (!article) return;

  // Reading progress
  var bar = document.createElement('div');
  bar.className = 'prog';
  bar.setAttribute('aria-hidden', 'true');
  document.body.appendChild(bar);
  var ticking = false;
  function progress() {
    ticking = false;
    var r = article.getBoundingClientRect();
    var total = r.height - window.innerHeight * 0.6;
    var p = total > 0 ? Math.min(1, Math.max(0, -r.top / total)) : 0;
    bar.style.transform = 'scaleX(' + p.toFixed(4) + ')';
  }
  window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(progress); } }, { passive: true });
  progress();

  // Table of contents: highlight the section on screen.
  var links = $$('.toc a');
  if (!links.length || !('IntersectionObserver' in window)) return;
  var byId = {};
  links.forEach(function (a) { byId[decodeURIComponent(a.getAttribute('href').slice(1))] = a; });
  var heads = Object.keys(byId).map(function (id) { return document.getElementById(id); }).filter(Boolean);
  var current = null;
  function set(id) {
    if (id === current) return;
    current = id;
    links.forEach(function (a) { a.classList.toggle('on', a === byId[id]); });
  }
  var io = new IntersectionObserver(function () {
    var top = null;
    for (var i = 0; i < heads.length; i++) { if (heads[i].getBoundingClientRect().top < window.innerHeight * 0.3) top = heads[i].id; }
    set(top || (heads[0] && heads[0].id));
  }, { rootMargin: '0px 0px -60% 0px', threshold: [0, 1] });
  heads.forEach(function (h) { io.observe(h); });
}());

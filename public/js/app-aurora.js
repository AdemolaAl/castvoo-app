'use strict';
/*
 * app-aurora.js: small runtime helpers for the dashboard's "Aurora" look (css/aurora.css).
 *   - html.cv-aur while the dashboard is showing, so sheets, Cas Builder and toasts (outside #v-app) pick up the look
 *     and the public website never does.
 *   - html.au-paused while the tab is hidden, and .au-off on the Home welcome card while it is off screen, so the moving
 *     light stops when nobody can see it.
 *   - aurFirstLive(): the small "Your first bot is live 🎉" moment, once per workspace (kept in this browser).
 */

(function () {
  const root = document.documentElement;
  function sync() { const v = document.getElementById('v-app'); root.classList.toggle('cv-aur', !!v && !v.hidden); }
  function start() {
    const v = document.getElementById('v-app');
    if (!v) return;
    sync();
    new MutationObserver(sync).observe(v, { attributes: true, attributeFilter: ['hidden'] });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  document.addEventListener('visibilitychange', () => root.classList.toggle('au-paused', document.hidden));
})();

/* Pause the welcome card's moving light while it is scrolled out of view. Called by the Home page after it draws. */
let AU_IO = null;
function aurWatch(el) {
  if (!('IntersectionObserver' in window)) return;
  if (AU_IO) AU_IO.disconnect();
  AU_IO = new IntersectionObserver((list) => list.forEach((e) => e.target.classList.toggle('au-off', !e.isIntersecting)));
  $$('.hello', el || document).forEach((h) => AU_IO.observe(h));
}

/* "Your first bot is live 🎉": shown the first time a bot or welcome flow is switched on in this workspace. Returns true
 * when it showed (callers then skip their own confetti). A workspace that already had a welcome flow live before the
 * switch (APP.state, not yet refreshed) only gets the flag set quietly. */
function aurFirstLive() {
  const s = APP.state;
  if (!s || !s.workspace) return false;
  const key = 'cv_aur_live_' + s.workspace.id;
  try { if (localStorage.getItem(key)) return false; localStorage.setItem(key, '1'); } catch (_) { return false; }
  if (s.flows && s.flows.live) return false; // a welcome flow was already live before this switch
  $$('.au-party').forEach((x) => x.remove());
  const w = document.createElement('div');
  w.className = 'au-party';
  w.setAttribute('role', 'status');
  w.innerHTML = '<div class="au-pt"><span class="au-pe" aria-hidden="true">🎉</span><span><b>Your first bot is live</b><small>It answers people on Telegram from now on.</small></span></div>';
  if (!RM) {
    const cols = ['#2F6BFF', '#7C5CFF', '#0EA5E9', '#A68BFF', '#12B886', '#F59F00'];
    for (let i = 0; i < 30; i++) {
      const c = document.createElement('i');
      const a = Math.random() * Math.PI * 2, d = 70 + Math.random() * 140;
      c.style.background = cols[i % cols.length];
      c.style.setProperty('--x', Math.round(Math.cos(a) * d * 1.4) + 'px');
      c.style.setProperty('--y', Math.round(Math.sin(a) * d * 0.8 + 24) + 'px');
      c.style.setProperty('--r', Math.round(Math.random() * 720 - 360) + 'deg');
      c.style.animationDelay = (Math.random() * 0.15).toFixed(2) + 's';
      if (i % 3 === 0) c.className = 'dot';
      w.appendChild(c);
    }
  }
  document.body.appendChild(w);
  const bots = $('#snav [data-v="flows"]');
  if (bots && !RM) { bots.classList.remove('au-bump'); void bots.offsetWidth; bots.classList.add('au-bump'); }
  setTimeout(() => w.classList.add('out'), 3200);
  setTimeout(() => w.remove(), 3700);
  return true;
}

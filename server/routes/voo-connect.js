'use strict';
/*
 * Voo Connect: "Continue with Voo ID" (VooSquare login), the affiliate hand-off and "log out everywhere".
 * Contract: VooSquare docs/VOO_CONNECT.md (Castvoo sheet). The kit is ./voo-connect, wrapped by server/lib/voo.js.
 *
 *   GET /auth/voosquare?return_to=/#app&signup=1   start login (signup=1 opens VooSquare's sign-up view: prompt=signup)
 *   POST /api/auth/voosquare/link                   "Connect your VooSquare account" for someone already logged in
 *   GET /auth/voosquare/callback                    VooSquare comes back here (register this exact address in VooSquare)
 *   GET /logout                                     end our session, then VooSquare's, then back to our home page
 *   GET /dashboard                                  VooSquare's launcher opens /auth/voosquare?return_to=/dashboard
 *   GET /voo-connect-browser.js                     the kit's landing-page snippet (keeps ref / vclick / coupon)
 *   GET /api/auth/voosquare/start                   older address of the login button: sends to /auth/voosquare
 *
 * The affiliate click itself (ref, vclick, coupon on any landing URL) is kept by the kit's captureAttribution() in
 * server/app.js, for every page, in the first-party cookie voo_attr (60 days). startLogin() replays it to VooSquare.
 */

const fs = require('node:fs');
const config = require('../config');
const auth = require('../services/auth');
const settings = require('../services/settings');
const log = require('../lib/log');
const voo = require('../lib/voo');
const { escHtml, hmac, safeEqual } = require('../lib/util');

/*
 * "Connect your VooSquare account" (Settings): linking a Voo ID to the account that is logged in here happens ONLY
 * when the login was started from that button by this same session (cookie cv_voolink, HttpOnly, 10 minutes, bound
 * to the session). Any other Voo ID login while someone is logged in (VooSquare's launcher on a shared computer, for
 * example) switches account instead of silently linking two different people.
 */
const LINK_COOKIE = 'cv_voolink';
const linkTag = (s) => `${s.user.id}.${hmac(config.appSecret, 'voolink:' + s.user.id + ':' + s.tokenHash)}`;

const SNIPPET = (() => { try { return fs.readFileSync(require.resolve('../../voo-connect/voo-connect-browser.js')); } catch { return Buffer.from(''); } })();

function page(ctx, status, title, body) {
  ctx.html(status, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)} · Castvoo</title><link rel="icon" href="/img/favicon.svg"></head>
<body style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#F6F8FC;color:#0B1430;padding:24px;box-sizing:border-box">
<main style="max-width:440px;width:100%;background:#fff;border:1px solid #E3E8F2;border-radius:20px;padding:32px 28px;text-align:center;box-shadow:0 18px 40px -24px rgba(11,20,48,.35)">${body}</main></body></html>`);
}

const loginOn = async () => config.vooConnectOn() && (await settings.feature('login_voosquare'));

/** What the kit wrote (state cookie, cleared hand-off cookie) plus our own session cookie, in one response. */
function kitRes(ctx) { return voo.resShim(ctx); }

module.exports = (r) => {
  r.get('/auth/voosquare', async (ctx) => {
    if (!(await loginOn())) return ctx.redirect('/#login');
    const res = kitRes(ctx);
    voo.kit().startLogin(ctx.req, res, {
      // The hub's launcher asks for /dashboard; our dashboard lives at /#app.
      returnTo: ctx.query.return_to === '/dashboard' ? '/#app' : undefined,
    });
    ctx.redirect(res.headers.location);
  }, { rate: [300, 600] });

  /*
   * "Connect your VooSquare account" (Settings). A POST with our x-cv header (so another website cannot start it in
   * the background: that would let an attacker who logged the victim's browser into the attacker's own VooSquare
   * account attach it to the victim's Castvoo account). Gives the address to open next.
   */
  r.post('/api/auth/voosquare/link', async (ctx) => {
    if (!(await loginOn())) throw require('../lib/util').httpError(403, 'VooSquare login is switched off.', 'off');
    if (ctx.user.voo_id) throw require('../lib/util').httpError(409, 'Your account is already linked to VooSquare.', 'already_linked');
    const s = await auth.loadSession(ctx);
    ctx.setCookie(LINK_COOKIE, linkTag(s), { httpOnly: true, sameSite: 'Lax', secure: config.appUrl.startsWith('https://'), maxAge: 600, path: '/auth/voosquare' });
    return { url: '/auth/voosquare?return_to=' + encodeURIComponent('/#app/settings') };
  }, { auth: 'user', rate: [20, 600] });

  r.get('/auth/voosquare/callback', async (ctx) => {
    if (!(await loginOn())) return ctx.redirect('/#login');
    const res = kitRes(ctx);
    let result;
    try {
      result = await voo.kit().handleCallback(ctx.req, res);
    } catch (e) {
      log.warn('voo login did not finish', { code: e.code, err: e.message });
      const msg = e.code === 'access_denied' ? 'You cancelled the VooSquare login.' : e.message;
      return page(ctx, 400, 'Login did not finish', `<h1 style="font-size:22px;margin:0 0 10px">Login did not finish</h1><p style="color:#5B6782;line-height:1.5">${escHtml(msg)}</p>
<p style="margin:22px 0 0"><a href="/auth/voosquare" style="display:inline-block;background:#2F6BFF;color:#fff;border-radius:12px;padding:12px 20px;text-decoration:none;font-weight:600">Try again</a></p><p><a href="/" style="color:#5B6782">Back to Castvoo</a></p>`);
    }
    const { user: vu, returnTo } = result;
    try {
      const s = await auth.loadSession(ctx);
      const wantLink = !!(s && ctx.cookies[LINK_COOKIE] && safeEqual(ctx.cookies[LINK_COOKIE], linkTag(s)));
      if (ctx.cookies[LINK_COOKIE]) ctx.setCookie(LINK_COOKIE, '', { httpOnly: true, sameSite: 'Lax', maxAge: 0, path: '/auth/voosquare' });
      const current = wantLink ? s.user : null;
      const { user, created, linked } = await auth.loginWithVoo(vu, { current, ref: ctx.cookies.cv_ref || null });
      if (!current) {
        if (s && String(s.user.id) !== String(user.id)) await auth.destroySession(ctx); // someone else was logged in here
        if (!s || String(s.user.id) !== String(user.id)) await auth.createSession(ctx, user, { created });
      }
      log.info('voo login', { user: user.id, created, linked });
      if (created) return ctx.redirect('/#signup/country');
      if (current && linked) return ctx.redirect(returnTo.startsWith('/#app') ? returnTo : '/#app/settings');
      return ctx.redirect(returnTo);
    } catch (e) {
      const msg = e.status && e.status < 500 ? e.message : 'Something went wrong on our side. Please try again.';
      if (!e.status || e.status >= 500) log.error('voo login failed', { err: e });
      return page(ctx, e.status && e.status < 500 ? e.status : 500, 'Login did not finish', `<h1 style="font-size:22px;margin:0 0 10px">Login did not finish</h1><p style="color:#5B6782;line-height:1.5">${escHtml(msg)}</p>
<p style="margin:22px 0 0"><a href="/auth/voosquare" style="display:inline-block;background:#2F6BFF;color:#fff;border-radius:12px;padding:12px 20px;text-decoration:none;font-weight:600">Try again</a></p><p><a href="/" style="color:#5B6782">Back to Castvoo</a></p>`);
    }
  });

  /** Log out everywhere: our session, then VooSquare's (people who use a Voo ID), then back to our home page. */
  // SEC-13: another website must not be able to log people out with a hidden link or image. A GET from another
  // site (Sec-Fetch-Site: cross-site / same-site) gets a small "Log out?" page whose button POSTs here; our own pages,
  // typed addresses and VooSquare's launcher (no or same-origin / none Sec-Fetch-Site) log out straight away.
  const logout = async (ctx) => {
    const s = await auth.loadSession(ctx);
    const vooUser = !!(s && s.user.voo_id);
    await auth.destroySession(ctx);
    const k = voo.kit();
    ctx.redirect(vooUser && k && config.vooConnectOn() ? k.logoutUrl(voo.homeUrl()) : '/');
  };
  r.get('/logout', async (ctx) => {
    const site = String(ctx.req.headers['sec-fetch-site'] || '');
    if (site && site !== 'same-origin' && site !== 'none') {
      return ctx.html(200, '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Log out · Castvoo</title>'
        + '<body style="font-family:system-ui;padding:40px;text-align:center;color:#0B1430"><h2>Log out of Castvoo?</h2>'
        + '<form method="post" action="/logout"><button type="submit" style="font:inherit;padding:10px 22px;border-radius:10px;border:0;background:#2F6BFF;color:#fff;cursor:pointer">Log out</button></form>'
        + '<p><a href="/#app" style="color:#2F6BFF">Back to Castvoo</a></p>');
    }
    return logout(ctx);
  });
  // The form above. A cross-site POST carries no session cookie (SameSite=Lax), so it can't log anyone out.
  r.post('/logout', logout);

  r.get('/dashboard', async (ctx) => ctx.redirect('/#app'));

  r.get('/voo-connect-browser.js', async (ctx) => {
    // Off: an empty script, so pages that include it keep working.
    const body = config.vooConnectOn() ? SNIPPET : Buffer.from('/* Voo Connect is off */');
    ctx.send(200, body, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
  });

  r.get('/api/auth/voosquare/start', async (ctx) => {
    const q = new URLSearchParams();
    if (ctx.query.signup === '1') q.set('signup', '1');
    if (ctx.query.return_to) q.set('return_to', String(ctx.query.return_to));
    ctx.redirect('/auth/voosquare' + (q.toString() ? '?' + q : ''));
  });
  // VooSquare used to come back here; a stale login link just starts again.
  r.get('/api/auth/voosquare/callback', async (ctx) => ctx.redirect('/auth/voosquare'));
};

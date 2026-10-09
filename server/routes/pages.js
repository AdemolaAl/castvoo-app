'use strict';
/* Server-made pages: legal pages, referral links, tracked link clicks, email unsubscribe. (Blog, robots and sitemap: routes/blog.js.) */

const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const config = require('../config');
const settings = require('../services/settings');
const { fill, escHtml, checkSig, notFound } = require('../lib/util');
const LEGAL = require('../legal/index.js');

const LEGAL_DIR = path.join(__dirname, '..', 'legal');
const shell = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<title>${escHtml(title)} · Castvoo</title><link rel="icon" href="/img/favicon.svg"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap"><link rel="stylesheet" href="/css/legal.css"></head>
<body><header class="lh"><a class="lg" href="/"><span class="lm">C</span><b>Cast<i>voo</i></b></a><a class="bk" href="/">Back to Castvoo</a></header><main class="lw">${body}</main>
<footer class="lf"><nav>${LEGAL.map((l) => `<a href="/legal/${l.slug}">${escHtml(l.title)}</a>`).join('')}<a href="/blog">Blog</a></nav><p>Castvoo is not affiliated with Telegram.${config.vooConnectOn() ? ` <a href="${escHtml(config.voosquare.base)}/app" target="_blank" rel="noopener">Part of VooSquare</a>` : ''}</p></footer><script src="/voo-connect-browser.js" defer></script></body></html>`;

// Hosts tracked links may always go to straight away.
const SAFE_HOSTS = ['t.me', 'telegram.me', 'telegram.org', 'telegram.dog'];
async function needsInterstitial(link) {
  if (!config.linkWarnNewDays) return false;
  let u;
  try { u = new URL(link.url); } catch { return true; }
  if (u.protocol === 'tg:') return false;
  const host = u.hostname.toLowerCase();
  const own = [config.appUrl, config.voosquare.base].map((x) => { try { return new URL(x).hostname.toLowerCase(); } catch { return ''; } }).filter(Boolean);
  if ([...SAFE_HOSTS, ...own].some((h) => host === h || host.endsWith('.' + h))) return false;
  const ws = await db.one('select created_at, paid_ever from workspaces where id = $1', [link.workspace_id]);
  return !!(ws && !ws.paid_ever && new Date(ws.created_at) > new Date(Date.now() - config.linkWarnNewDays * 86400000));
}

module.exports = (r) => {
  r.get('/legal', async (ctx) => ctx.redirect('/legal/terms'));
  r.get('/legal/:slug', async (ctx) => {
    const page = LEGAL.find((l) => l.slug === ctx.params.slug);
    if (!page) throw notFound('That page');
    const raw = fs.readFileSync(path.join(LEGAL_DIR, page.slug + '.html'), 'utf8');
    // Values from admin settings are escaped before they go into the page (SEC-19).
    const vars = Object.fromEntries(Object.entries(await settings.publicVars()).map(([k, v]) => [k, escHtml(v)]));
    ctx.html(200, shell(page.title, fill(raw, vars)));
  });

  /** Referral link: remember who sent the visitor, then open sign-up. */
  r.get('/r/:code', async (ctx) => {
    const code = String(ctx.params.code).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
    const days = (await settings.get('referral')).cookie_days || 60;
    if (code && (await db.one("select 1 from users where ref_code = $1 and status = 'active'", [code]))) {
      ctx.setCookie('cv_ref', code, { maxAge: days * 86400, sameSite: 'Lax', secure: config.appUrl.startsWith('https://'), httpOnly: true });
    }
    // cvref, not ref: ?ref= on a landing page is VooSquare's affiliate hand-off (Voo Connect).
    ctx.redirect('/?cvref=' + encodeURIComponent(code) + '#signup');
  });

  /** Tracked button link: log the click, then go to the real address. */
  r.get('/l/:code', async (ctx) => {
    const link = await db.one('select * from links where code = $1', [ctx.params.code]);
    if (!link) throw notFound('That link');
    let sid = null;
    if (ctx.query.s) {
      const [id, sig] = String(ctx.query.s).split('.');
      if (/^\d+$/.test(id) && checkSig(`click:${link.code}:${id}`, sig, 10)) sid = Number(id);
    }
    // Switched off by the team (phishing or abuse): no redirect (SEC-7).
    if (link.disabled_at) return ctx.html(410, shell('Link switched off', '<h1>This link was switched off</h1><p>The Castvoo team switched this link off because it may not be safe. If you were sent here by someone you know, ask them for a new link.</p>'));
    db.query('insert into clicks(code, workspace_id, subscriber_id) values ($1,$2,$3)', [link.code, link.workspace_id, sid]).catch(() => {});
    if (sid) db.query('update subscribers set last_seen_at = now() where id = $1', [sid]).catch(() => {});
    // Links from new accounts that have never paid, to sites outside Telegram and Castvoo, get a "you are leaving
    // Castvoo" page first, so castvoo.com links can't be used as a free, trusted-looking bounce to phishing (SEC-7).
    if (await needsInterstitial(link)) {
      let host = '';
      try { host = new URL(link.url).host; } catch { /* not a URL: shown as is */ }
      return ctx.html(200, shell('Leaving Castvoo', `<h1>You are leaving Castvoo</h1><p>This link was added by a Castvoo customer and goes to <b>${escHtml(host || link.url)}</b>. Castvoo did not write or check that page.</p><p>Never type your Castvoo login code or password on another site.</p><p><a href="${escHtml(link.url)}" rel="nofollow noopener noreferrer">Continue to ${escHtml(host || 'the link')}</a></p><p><a href="/">Back to Castvoo</a></p>`));
    }
    ctx.redirect(link.url);
  });

  r.get('/email/unsubscribe', async (ctx) => {
    const id = Number(ctx.query.u);
    if (!id || !checkSig('unsub:' + id, ctx.query.s)) throw notFound('That unsubscribe link');
    await db.query('update users set marketing_opt_out = true where id = $1', [id]);
    ctx.html(200, shell('Unsubscribed', `<h1>You're unsubscribed</h1><p>You won't get tips and offers from Castvoo any more. You'll still get important account emails like receipts and login codes.</p><p><a href="/#app">Open my dashboard</a></p>`));
  });

  // /robots.txt and /sitemap.xml are in routes/blog.js (the sitemap lists the blog too).
};

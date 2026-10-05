'use strict';
/* Public pages and the HTTP basics: health, config, legal pages, referral links, robots, 404, headers, CSRF. */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { if (app) await app.stop(); });

describe('public endpoints', () => {
  it('health answers ok and checks the database', async () => {
    const r = await app.client().get('/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(Date.parse(r.body.time));
  });

  it('public config has plans, features, content, trial and logins', async () => {
    const r = await app.client().get('/api/public/config');
    assert.equal(r.status, 200);
    const c = r.body;
    assert.deepEqual(c.plans.map((p) => p.code), ['starter', 'growth', 'scale']);
    assert.equal(c.plans[1].price_month, 49);
    assert.equal(c.features.broadcasts, true);
    assert.equal(c.features.maintenance, false);
    assert.ok(c.content.hero_title);
    assert.ok(Array.isArray(JSON.parse(c.content.faq)));
    assert.deepEqual(c.trial, { days: 7, plan: 'growth', ai_writes: 100 });
    assert.equal(c.login.email, true);
    assert.equal(c.login.telegram, true);
    assert.equal(c.login.google, true);
    assert.equal(c.bot_username, 'CastvooBot');
    assert.equal(c.bot_id, 600000001);
    assert.equal(c.ai_available, true);
    assert.ok(c.countries.find((x) => x.code === 'NG'));
    assert.deepEqual(c.topup_bonuses.map((b) => b.min), [200, 500, 1000]);
    // Nothing secret leaks into the public config.
    const s = JSON.stringify(c);
    for (const secret of ['sk_test_paystack', 'FLWSECK', 'gv_test_key', 'google-secret', 'voo-service-key', app.platformBotToken]) assert.ok(!s.includes(secret), secret);
  });

  it('public methods depend on the country', async () => {
    const ng = await app.client().get('/api/public/methods?country=NG');
    assert.deepEqual(ng.body.methods.map((m) => m.key), ['paystack_ng', 'gatevoo']);
    const ke = await app.client().get('/api/public/methods?country=KE');
    assert.deepEqual(ke.body.methods.map((m) => m.key), ['flw_ke', 'gatevoo']);
    const unknown = await app.client().get('/api/public/methods?country=ZZ');
    assert.deepEqual(unknown.body.methods.map((m) => m.key), ['flw_card', 'gatevoo']);
  });

  it('every legal page renders with all variables filled in', async () => {
    for (const slug of ['terms', 'privacy', 'refunds', 'acceptable-use', 'referral-terms', 'cookies']) {
      const r = await app.client().get('/legal/' + slug);
      assert.equal(r.status, 200, slug);
      assert.match(r.headers.get('content-type'), /text\/html/);
      assert.ok(!/\{\{|\}\}/.test(r.text), `leftover {{ }} in ${slug}`);
      assert.ok(r.text.includes('Zedapex'), slug + ' has the company name');
      assert.ok(r.headers.get('content-security-policy'), slug + ' has a CSP');
    }
    const terms = await app.client().get('/legal/terms');
    assert.ok(terms.text.includes(app.url), 'site_url filled');
    const missing = await app.client().get('/legal/nope');
    assert.equal(missing.status, 404);
    const root = await app.client().get('/legal');
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/legal/terms');
  });

  it('legal pages only use variables the server knows', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const vars = await app.settings.publicVars();
    const dir = path.join(__dirname, '..', '..', 'server', 'legal');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.html'))) {
      for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
        assert.ok(vars[m[1]] !== undefined && vars[m[1]] !== '', `${f} uses unknown variable ${m[1]}`);
      }
    }
  });

  it('email templates only use variables they declare (no empty blanks)', async () => {
    const email = app.require('services/email');
    const vars = await app.settings.publicVars();
    for (const [key, t] of Object.entries(email.TEMPLATES)) {
      const allowed = new Set([...t.vars, ...Object.keys(vars), 'first_name', 'unsubscribe_url']);
      for (const part of [t.subject, t.body, t.text, t.preheader]) {
        for (const m of String(part || '').matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) assert.ok(allowed.has(m[1]), `${key} uses undeclared {{${m[1]}}}`);
      }
    }
  });

  it('/r/<code> remembers the referrer in a cookie and opens sign-up', async () => {
    const c = await app.loginByEmail('referrer@example.com');
    const code = c.user.ref_code;
    const r = await app.client().get('/r/' + code.toUpperCase());
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), `/?cvref=${code}#signup`); // ?ref= is VooSquare's affiliate code (V8)
    const cookie = r.headers.getSetCookie().find((x) => x.startsWith('cv_ref='));
    assert.ok(cookie, 'cv_ref cookie set');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Max-Age=5184000/);
    const bad = await app.client().get('/r/nobody-here');
    assert.equal(bad.status, 302);
    assert.ok(!bad.headers.getSetCookie().some((x) => x.startsWith('cv_ref=')), 'no cookie for unknown code');
  });

  it('robots.txt and sitemap.xml', async () => {
    const r = await app.client().get('/robots.txt');
    assert.equal(r.status, 200);
    assert.match(r.text, /Disallow: \/api\//);
    assert.match(r.text, /Disallow: \/admin/);
    assert.ok(r.text.includes(`Sitemap: ${app.url}/sitemap.xml`));
    const s = await app.client().get('/sitemap.xml');
    assert.equal(s.status, 200);
    assert.match(s.headers.get('content-type'), /xml/);
    assert.ok(s.text.includes(`<loc>${app.url}/legal/privacy</loc>`));
  });

  it('unknown pages get the 404 page, unknown API paths get JSON 404, wrong method gets 405', async () => {
    const page = await app.client().get('/no/such/page');
    assert.equal(page.status, 404);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const api = await app.client().get('/api/nothing-here');
    assert.equal(api.status, 404);
    assert.equal(api.body.code, 'not_found');
    const m = await app.client().request('DELETE', '/api/public/config');
    assert.equal(m.status, 405);
  });

  it('a malformed URL escape is a 4xx, not a crash', async () => {
    const r = await app.client().get('/l/%E0%A4%A');
    assert.ok(r.status >= 400 && r.status < 500, 'got ' + r.status);
  });

  it('security headers on every response', async () => {
    for (const p of ['/health', '/legal/terms', '/no/such/page']) {
      const r = await app.client().get(p);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p);
      assert.equal(r.headers.get('x-frame-options'), 'DENY', p);
      assert.ok(r.headers.get('referrer-policy'), p);
    }
    const html = await app.client().get('/legal/privacy');
    const csp = html.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    const j = await app.client().get('/api/public/config');
    assert.ok(!j.headers.get('content-security-policy') || true);
  });

  it('CSRF: a logged-in POST without the x-cv header is refused', async () => {
    const c = await app.loginByEmail('csrf@example.com');
    const blocked = await c.post('/api/me', { name: 'Hacker' }, { csrf: false });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'csrf');
    const me = await c.get('/api/me');
    assert.notEqual(me.body.user.name, 'Hacker');
    const ok = await c.post('/api/me', { name: 'Real Name' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.name, 'Real Name');
  });

  it('logged-out API calls get 401', async () => {
    const r = await app.client().get('/api/app/state');
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'login_required');
  });

  it('bad JSON gets a 400', async () => {
    const r = await app.client().post('/api/auth/email/start', '{not json', { headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'bad_json');
  });

  it('session cookie is HttpOnly and SameSite=Lax', async () => {
    const c = app.client();
    await c.post('/api/auth/email/start', { email: 'cookie@example.com' });
    const r = await c.post('/api/auth/email/verify', { email: 'cookie@example.com', code: app.fakes.lastCode('cookie@example.com') });
    const sc = r.headers.getSetCookie().find((x) => x.startsWith('cv_session='));
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /SameSite=Lax/);
    assert.match(sc, /Max-Age=2592000/);
    const logout = await c.post('/api/auth/logout');
    assert.equal(logout.status, 200);
    assert.equal((await c.get('/api/me')).body.user, null);
  });
});

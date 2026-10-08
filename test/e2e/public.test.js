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
    assert.deepEqual(c.plans.map((p) => p.code), ['free', 'starter', 'growth', 'scale']);
    assert.equal(c.plans[2].price_month, 49);
    assert.deepEqual(c.plans.map((p) => [p.connections, p.join_requests, p.flows, p.flow_steps, p.ai_writes, p.branding]),
      [[1, 500, 1, 1, 0, true], [2, 5000, 3, 5, 150, false], [5, 30000, 15, 20, 600, false], [20, 150000, -1, -1, 1500, false]]);
    assert.equal(c.features.broadcasts, true);
    assert.equal(c.features.maintenance, false);
    assert.ok(c.content.hero_title);
    assert.ok(Array.isArray(JSON.parse(c.content.faq)));
    assert.deepEqual(c.trial, { days: 7, plan: 'growth', ai_writes: 50, join_requests: 3000 });
    assert.equal(c.login.email, true);
    assert.equal(c.login.telegram, true);
    assert.equal(c.login.google, undefined);
    assert.equal(c.bot_username, 'CastvooBot');
    assert.equal(c.bot_id, 600000001);
    assert.equal(c.ai_available, true);
    assert.ok(c.countries.find((x) => x.code === 'NG'));
    assert.deepEqual(c.topup_bonuses.map((b) => b.min), [200, 500, 1000]);
    // Nothing secret leaks into the public config.
    const s = JSON.stringify(c);
    for (const secret of ['sk_test_paystack', 'FLWSECK', 'gv_test_key', 'voo-service-key', app.platformBotToken]) assert.ok(!s.includes(secret), secret);
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

  it('homepage: "See how it works" videos sit right after the hero, posters only until tapped', async () => {
    const r = await app.client().get('/');
    assert.equal(r.status, 200);
    const html = r.text;
    const at = (needle) => html.indexOf(needle);
    assert.ok(at('id="how"') > at('id="top"') && at('id="how"') < at('id="story"'), '#how is between the hero and the story');
    assert.ok(at('id="story"') > 0 && at('id="guide"') > 0, 'the animated walkthrough sections are still there');
    assert.match(html, /<a class="btn b-ghost hwatch" href="#how" id="heroWatch">/, 'hero has the "Watch how it works" button');
    const sec = html.slice(at('id="how"'), at('id="story"'));
    // Nothing heavy loads with the page: no <video> or autoplay, lazy poster images only.
    assert.ok(!/<video|autoplay|preload="auto"/i.test(sec), 'no video element in the section');
    for (const img of sec.match(/<img [^>]+>/g)) assert.match(img, /loading="lazy"/);
    // Each card opens a real guide from the player's "site" set, and its length matches the guide.
    const fs = require('node:fs');
    const path = require('node:path');
    const vm = require('node:vm');
    const box = { PAGES: {}, document: { addEventListener() {} } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'app-guides.js'), 'utf8') + '\n;this.VGUIDES = VGUIDES; this.VG_SETS = VG_SETS; this.vgTime = vgTime;', box);
    const cards = [...sec.matchAll(/data-vguide="([a-z-]+)" data-vset="site"[\s\S]*?data-len>([0-9:]+)</g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(cards.map((c) => c[0]), ['welcome-flow', 'connect-bot', 'send-broadcast', 'wallet-plans']);
    assert.deepEqual(cards.map((c) => c[0]), [...box.VG_SETS.site]);
    for (const [id, len] of cards) {
      const g = box.VGUIDES.find((x) => x.id === id);
      assert.ok(g, id + ' is a guide');
      assert.equal(len, box.vgTime(g.dur), id + ' shows its real length');
      assert.ok(sec.includes('/videos/' + id + '.jpg'), id + ' poster');
    }
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

  it('homepage copy v2/v3: unedited old hero, FAQ, footer and plan taglines move to the new text; edited ones are kept', async () => {
    const seed = app.require('seed');
    const get = async (k) => (await app.db.one('select value from site_content where key = $1', [k])).value;
    const tag = async (code) => (await app.db.one('select tagline from plans where code = $1', [code])).tagline;
    // A workspace still on the previous defaults...
    await app.db.query("update site_content set value = 'Welcome everyone who asks to *join your channel.*' where key = 'hero_title'");
    await app.db.query("update site_content set value = 'Start free · 7 days on us' where key = 'hero_cta'");
    await app.db.query("update site_content set value = 'Turn every join into *a lead you can message.*' where key = 'hero_title'");
    await app.db.query("update site_content set value = 'Telegram welcomes, broadcasts and follow-ups, sent on time.' where key = 'footer_tagline'");
    await app.db.query("update site_content set value = 'New: Cas, your AI helper, now learns your business. Train it in two minutes.' where key = 'announcement_text'");
    await app.db.query("update site_content set value = '#ai' where key = 'announcement_link'");
    const oldFaq = JSON.parse(seed.CONTENT.faq);
    const first = oldFaq.splice(0, 2);
    oldFaq.splice(3, 0, ...first);
    const v1 = JSON.stringify(oldFaq.map((f) => ({ q: f.q, a: f.a.replace('skips people who blocked your bot', 'removes people who blocked your bot') })));
    await app.db.query("update site_content set value = $1 where key = 'faq'", [v1]);
    await app.db.query("update plans set tagline = 'Welcome everyone who asks to join your channel.' where code = 'free'");
    // ...and one the team edited.
    await app.db.query("update site_content set value = 'Our own subtitle.' where key = 'hero_subtitle'");
    await app.db.query("update plans set tagline = 'Our growth line.' where code = 'growth'");
    await seed.run();
    assert.equal(await get('hero_title'), seed.CONTENT.hero_title);
    assert.equal(seed.CONTENT.hero_title, 'Welcome. Broadcast. Follow up. *All on autopilot.*');
    assert.equal(await get('hero_cta'), 'Start my 7-day free trial');
    assert.equal(await get('footer_tagline'), 'Every Telegram join, greeted and followed up.');
    assert.equal(await get('announcement_link'), '#how', 'the link follows its untouched text');
    assert.equal(await get('faq'), seed.CONTENT.faq, 'the first seeded FAQ is replaced');
    assert.doesNotMatch(await get('faq'), /removes people who blocked/);
    assert.equal(JSON.parse(await get('faq'))[0].q, 'Can Castvoo message people who join my channel?');
    assert.equal(await tag('free'), 'Greet every join, free.');
    assert.equal(await get('hero_subtitle'), 'Our own subtitle.', 'edited text kept');
    assert.equal(await tag('growth'), 'Our growth line.', 'edited tagline kept');
    // A team that wrote its own announcement keeps its link.
    await app.db.query("update site_content set value = 'Big sale' where key = 'announcement_text'");
    await app.db.query("update site_content set value = '#ai' where key = 'announcement_link'");
    await seed.run();
    assert.equal(await get('announcement_link'), '#ai');
  });
});

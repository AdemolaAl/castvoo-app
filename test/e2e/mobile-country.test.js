'use strict';
/* Mobile fixes (9 Oct 2026): no zoom on focus on phones, and customers confirm their own country at sign-up
   (the detected country is only pre-selected in the browser: test/e2e/geoip.test.js). */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp } = require('../helpers/app');

const PUB = path.join(__dirname, '../../public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');

let app;
before(async () => { app = await startApp(); });
after(async () => { if (app) await app.stop(); });
beforeEach(() => { app.rl._reset(); });

describe('country: the customer confirms it; the server never saves a guess', () => {
  it('an email sign-up without a country gets no country (no server default)', async () => {
    const c = await app.loginByEmail('nocountry@example.com', { name: 'No Country' });
    assert.equal(c.created, true);
    assert.equal(c.user.country, null);
    const me = (await c.get('/api/me')).body.user;
    assert.equal(me.country, null);
    // Picking one in the country step saves it; an unknown one is refused.
    assert.equal((await c.post('/api/me', { country: 'ZZ' })).status, 400);
    assert.equal((await c.post('/api/me', { country: 'GH' })).body.user.country, 'GH');
  });

  it('the public config does not guess a country for the visitor', async () => {
    const r = await app.client().get('/api/public/config', { headers: { 'cf-ipcountry': 'NG', 'x-vercel-ip-country': 'NG' } });
    assert.equal(r.status, 200);
    for (const k of ['country', 'geo', 'ip_country', 'detected_country', 'suggested_country']) assert.equal(r.body[k], undefined, k);
    assert.ok(!r.body.countries.some((c) => c.selected || c.default), 'no country flagged as selected/default');
  });

  it('the sign-up country step has no time-zone guess and has the searchable picker (empty when nothing is detected)', () => {
    const s = read('js/signup.js');
    assert.doesNotMatch(s, /TZ_COUNTRY|resolvedOptions\(\)\.timeZone/, 'no time-zone to country guess');
    assert.match(s, /placeholder="Select your country"/);
    assert.match(s, /role="combobox"/);
    assert.match(s, /Please select your country to continue\./);
  });
});

describe('phones: no zoom when a field gets focus (iOS zooms into fields under 16px)', () => {
  it('castvoo.css and admin.css set every field to 16px on phones and touch screens', () => {
    for (const f of ['css/castvoo.css', 'admin/admin.css']) {
      const css = read(f);
      const m = /@media \(max-width:760px\),\(pointer:coarse\)\{([\s\S]*?)\n\}/.exec(css);
      assert.ok(m, f + ': phone/touch block');
      assert.match(m[1], /:where\(select,textarea,\[contenteditable\]:not\(\[contenteditable=false\]\)\)\{font-size:16px!important\}/, f);
      assert.match(m[1], /:where\(input:not\(\[type=checkbox\]\)/, f);
      assert.match(css, /@supports \(overflow:clip\)\{html,body\{overflow-x:clip\}\}/, f + ': no sideways drift');
    }
  });

  it('the viewport stops iPhone focus zoom (maximum-scale=1) but never blocks pinch-zoom (no user-scalable=no)', () => {
    // iOS Safari ignores maximum-scale for pinch-zoom (since iOS 10) but honours it for the automatic zoom into a
    // focused field, which otherwise stays after log-in ("the page is zoomed in").
    const want = 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover';
    for (const f of ['index.html', 'admin/index.html', '404.html']) {
      const v = /<meta name="viewport" content="([^"]+)"/.exec(read(f))[1];
      assert.equal(v, want, f);
      assert.doesNotMatch(v, /user-scalable/, f);
    }
    const ROOT = path.join(__dirname, '..', '..');
    for (const f of ['server/services/blog-pages.js', 'server/routes/pages.js', 'server/routes/auth.js', 'server/routes/voo-connect.js', 'server/app.js']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const all = [...src.matchAll(/<meta name="?viewport"? content="([^"]+)"/g)].map((m) => m[1]);
      assert.ok(all.length, f);
      for (const v of all) assert.equal(v, want, f);
    }
  });

  it('after log-in and on each sign-up step the focused field lets go (iPhone keeps its keyboard and zoom otherwise)', () => {
    const core = read('js/core.js'), su = read('js/signup.js'), main = read('js/main.js');
    assert.match(core, /function dropFocus\(\)/);
    assert.match(su, /async function afterLogin\(created\) \{\n  dropFocus\(\);/);
    assert.match(su, /async function signupRoute\(sub, q\) \{\n  suStopGuide\(\);\n  dropFocus\(\);/);
    assert.match(su, /function finishSignup\(msg\) \{\n  dropFocus\(\);/);
    assert.match(main, /if \(VIEW !== v\) \{\n    dropFocus\(\);/);
  });

  it('the menu drawer never squashes its items (wallet card keeps its height)', () => {
    const css = read('css/castvoo.css');
    assert.match(css, /\.side>\*\{flex-shrink:0\}/);
    assert.match(css, /\.wcard\{[^}]*flex:none;min-height:128px/);
    const html = read('index.html');
    assert.match(html, /<div class="wcard">.*class="tnum walBal".*class="wc-bn walBonus" hidden.*data-topup/);
  });
});

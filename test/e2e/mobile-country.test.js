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

  it('the viewport still lets people pinch-zoom (no maximum-scale / user-scalable=no)', () => {
    for (const f of ['index.html', 'admin/index.html']) {
      const v = /<meta name="viewport" content="([^"]+)"/.exec(read(f))[1];
      assert.match(v, /width=device-width/);
      assert.doesNotMatch(v, /maximum-scale|user-scalable/, f);
    }
  });
});

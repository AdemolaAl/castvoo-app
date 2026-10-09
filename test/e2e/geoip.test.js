'use strict';
/*
 * Country from the IP address (lib/geoip.js), sign-up only: the DB-IP CSV loader (IPv4 as uint32, IPv6 as two
 * 64-bit halves, binary search), edge ranges, Cloudflare's CF-IPCountry header first, private and unknown addresses,
 * the monthly download (current month, else the previous one; checked, swapped atomically, a bad file never replaces
 * a good one), GET /api/public/geo for the sign-up page, and the website language from the browser only.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const http = require('node:http');
const vm = require('node:vm');
const { startApp } = require('../helpers/app');

const FIXTURE = fs.readFileSync(path.join(__dirname, '../fixtures/dbip-country-lite-sample.csv'), 'utf8');

/* A stand-in for download.db-ip.com: routes[path] = { status, body }. */
const routes = {};
const hits = [];
const dl = http.createServer((req, res) => {
  hits.push(req.url);
  const r = routes[req.url];
  if (!r) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(r.status || 200, { 'content-type': 'application/gzip' });
  res.end(r.body);
});

let app, geo;
before(async () => {
  await new Promise((r) => dl.listen(0, '127.0.0.1', r));
  app = await startApp({ env: { GEOIP_DOWNLOAD_BASE: `http://127.0.0.1:${dl.address().port}`, GEOIP_AUTO_DOWNLOAD: 'false' } });
  geo = app.require('lib/geoip');
});
after(async () => { if (app) await app.stop(); await new Promise((r) => dl.close(r)); });
beforeEach(() => { app.rl._reset(); });

const putFile = (text) => {
  const dir = path.join(app.uploadDir, 'geo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dbip-country-lite.csv.gz'), zlib.gzipSync(text));
};

describe('the DB-IP country database', () => {
  it('looks up IPv4 addresses, including the first and last address of a range and the gaps between', () => {
    const t = geo.parse(FIXTURE);
    assert.equal(t.rows4, 11);
    assert.equal(t.rows6, 5);
    const L = (ip) => geo.lookup(ip, t);
    assert.equal(L('41.58.0.0'), 'NG', 'first address');
    assert.equal(L('41.58.255.255'), 'NG', 'last address');
    assert.equal(L('41.58.128.7'), 'NG');
    assert.equal(L('41.57.255.255'), null, 'just before a range');
    assert.equal(L('41.59.0.0'), null, 'just after a range');
    assert.equal(L('102.89.63.255'), 'NG');
    assert.equal(L('102.89.64.0'), null);
    assert.equal(L('154.160.3.3'), 'GH');
    assert.equal(L('196.0.0.1'), 'ZA');
    assert.equal(L('1.0.0.0'), 'AU', 'low range');
    assert.equal(L('0.0.0.1'), null, 'ZZ (reserved) counts as unknown');
    assert.equal(L('10.1.2.3'), null, 'private');
    assert.equal(L('255.255.255.255'), 'US', 'the very last IPv4 address');
    assert.equal(L('::ffff:41.58.1.1'), 'NG', 'IPv4-mapped IPv6 (Node socket addresses)');
  });

  it('looks up IPv6 addresses (compressed forms, range ends, the top of the address space)', () => {
    const t = geo.parse(FIXTURE);
    const L = (ip) => geo.lookup(ip, t);
    assert.equal(L('2c0f:f5c0::1'), 'NG');
    assert.equal(L('2c0f:f5c0:ffff:ffff:ffff:ffff:ffff:ffff'), 'NG', 'last address');
    assert.equal(L('2c0f:f5c1::'), null, 'just after');
    assert.equal(L('2c0f:f5bf:ffff:ffff:ffff:ffff:ffff:ffff'), null, 'just before');
    assert.equal(L('2001:4860:4860::8888'), 'US');
    assert.equal(L('2A00:1450:4001:82A::200E'), 'IE', 'upper case');
    assert.equal(L('ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'), 'FR', 'the very last IPv6 address');
    assert.equal(L('::1'), null, 'loopback is ZZ');
    assert.equal(L('fe80::1%eth0'), null, 'zone ids are ignored');
  });

  it('refuses junk and sorts an unsorted file', () => {
    const t = geo.parse(FIXTURE);
    for (const bad of ['', 'not an ip', '999.1.1.1', '1.2.3', '1.2.3.4.5', '2c0f:::1', null, undefined]) assert.equal(geo.lookup(bad, t), null, String(bad));
    assert.throws(() => geo.parse('1.0.0.0,1.0.0.255,NIGERIA'), /bad country code/);
    assert.throws(() => geo.parse('1.0.0.9,1.0.0.1,NG'), /ends before it starts/);
    assert.throws(() => geo.parse('1.0.0.0,1.0.0.255'), /expected start,end,country/);
    const shuffled = FIXTURE.trim().split('\n').reverse().join('\n') + '\n"5.5.5.0","5.5.5.255","de"\n';
    const t2 = geo.parse(shuffled);
    assert.equal(geo.lookup('41.58.9.9', t2), 'NG');
    assert.equal(geo.lookup('5.5.5.5', t2), 'DE', 'quotes and lower case are fine');
    assert.equal(geo.lookup('2c0f:f5c0::9', t2), 'NG');
    assert.throws(() => geo.validate(t2, { minRows4: 1000 }), /IPv4 ranges/);
  });

  it('loads the gzip file from the uploads volume, and without one nothing is detected', () => {
    geo.unload();
    assert.equal(geo.lookup('41.58.1.1'), null);
    assert.equal(geo.status().loaded, false);
    putFile(FIXTURE);
    assert.equal(geo.load(), true);
    assert.equal(geo.lookup('41.58.1.1'), 'NG');
    assert.equal(geo.status().ipv4, 11);
  });

  it('flags and English names', () => {
    assert.equal(geo.flag('NG'), '🇳🇬');
    assert.equal(geo.flag('ke'), '🌍');
    assert.equal(geo.countryName('CI'), 'Côte d’Ivoire');
    assert.equal(geo.countryName('NG'), 'Nigeria');
  });
});

describe('sources: Cloudflare first, then the database', () => {
  before(() => { putFile(FIXTURE); geo.load(); });
  const ctx = (ip, headers = {}) => ({ ip, req: { headers } });
  it('CF-IPCountry wins when present (XX and T1 are ignored)', () => {
    assert.equal(geo.countryOf(ctx('41.58.1.1', { 'cf-ipcountry': 'gh' })), 'GH');
    assert.equal(geo.countryOf(ctx('41.58.1.1', { 'cf-ipcountry': 'XX' })), 'NG');
    assert.equal(geo.countryOf(ctx('41.58.1.1', { 'cf-ipcountry': 'T1' })), 'NG');
    assert.equal(geo.countryOf(ctx('41.58.1.1', { 'cf-ipcountry': 'Nigeria' })), 'NG');
    assert.equal(geo.countryOf(ctx('10.0.0.1')), null);
  });
});

describe('GET /api/public/geo (the sign-up country step)', () => {
  before(() => { putFile(FIXTURE); geo.load(); });

  it('gives the detected country with its flag, not cached, from the address the proxy added', async () => {
    const r = await app.client({ ip: '41.58.77.1' }).get('/api/public/geo');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.country, { code: 'NG', name: 'Nigeria', flag: '🇳🇬' });
    assert.match(r.headers.get('cache-control'), /no-store/);
    assert.match(r.headers.get('cache-control'), /private/);
    // TRUST_PROXY: the LAST X-Forwarded-For address (Railway's) counts, not one the visitor typed in front of it.
    const spoof = await app.client().get('/api/public/geo', { headers: { 'x-forwarded-for': '41.58.1.1, 10.9.9.9' }, ip: '41.58.1.1, 10.9.9.9' });
    assert.equal(spoof.body.country, null);
  });

  it('uses the CF-IPCountry header when Castvoo is behind Cloudflare', async () => {
    const r = await app.client({ ip: '10.1.1.1' }).get('/api/public/geo', { headers: { 'cf-ipcountry': 'KE' } });
    assert.equal(r.body.country.code, 'KE');
    assert.equal(r.body.country.name, 'Kenya');
  });

  it('null when unknown, private, or not one of the countries Castvoo offers', async () => {
    assert.equal((await app.client({ ip: '10.2.3.4' }).get('/api/public/geo')).body.country, null);
    assert.equal((await app.client({ ip: '2a00:1450::1' }).get('/api/public/geo')).body.country, null, 'Ireland is not in the country list');
    assert.equal((await app.client({ ip: '2c0f:f5c0::5' }).get('/api/public/geo')).body.country.code, 'NG', 'IPv6');
    await app.db.query("update countries set active = false where code = 'GH'");
    app.settings.bust();
    assert.equal((await app.client({ ip: '154.160.3.3' }).get('/api/public/geo')).body.country, null, 'inactive country');
    await app.db.query("update countries set active = true where code = 'GH'");
    app.settings.bust();
  });

  it('stores nothing: no address, no country, until the person presses Continue', async () => {
    const c = await app.loginByEmail('geo.signup@example.com', {}, app.client({ ip: '41.58.5.5' }));
    assert.equal(c.created, true);
    assert.equal((await c.get('/api/public/geo')).body.country.code, 'NG');
    assert.equal(c.user.country, null, 'the account has no country until the country step is confirmed');
    assert.equal((await c.post('/api/me', { country: 'NG' })).body.user.country, 'NG');
    const ses = await app.db.one('select ip from sessions where user_id = $1', [c.user.id]);
    assert.equal(ses.ip, null);
  });

  it('the public (cached) config never carries a visitor country', async () => {
    const r = await app.client({ ip: '41.58.5.5' }).get('/api/public/config', { headers: { 'cf-ipcountry': 'NG' } });
    for (const k of ['country', 'geo', 'ip_country', 'detected_country']) assert.equal(r.body[k], undefined, k);
  });
});

describe('the monthly download', () => {
  const gz = (text) => zlib.gzipSync(text);
  const now = new Date(Date.UTC(2026, 9, 9)); // 9 Oct 2026
  beforeEach(() => { for (const k of Object.keys(routes)) delete routes[k]; hits.length = 0; geo._resetTimers(); fs.rmSync(path.join(app.uploadDir, 'geo'), { recursive: true, force: true }); geo.unload(); });

  it('is off unless GEOIP_AUTO_DOWNLOAD is on (off in tests, on by default in production)', async () => {
    assert.deepEqual(await geo.refresh({ now }), { skipped: 'off' });
    assert.equal(hits.length, 0);
    assert.deepEqual(geo.monthsToTry(now), ['2026-10', '2026-09']);
    assert.deepEqual(geo.monthsToTry(new Date(Date.UTC(2026, 0, 3))), ['2026-01', '2025-12']);
  });

  it('tries the current month, falls back to the previous one, checks it and swaps it in', async () => {
    routes['/free/dbip-country-lite-2026-09.csv.gz'] = { body: gz(FIXTURE) };
    const r = await geo.refresh({ now, force: true, minRows4: 5, minRows6: 2 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.month, '2026-09');
    assert.deepEqual(hits, ['/free/dbip-country-lite-2026-10.csv.gz', '/free/dbip-country-lite-2026-09.csv.gz']);
    assert.equal(geo.lookup('197.210.1.1'), 'NG', 'in use at once');
    assert.ok(fs.existsSync(geo.file()), 'saved on the volume');
    assert.ok(!fs.readdirSync(path.dirname(geo.file())).some((f) => f.endsWith('.tmp')), 'no temp file left');
    assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(geo.file()), 'dbip-country-lite.json'), 'utf8')).month, '2026-09');
    // Another start loads it from the volume.
    geo.unload(); assert.equal(geo.load(), true); assert.equal(geo.lookup('41.58.1.1'), 'NG');
  });

  it('a broken or too small file never replaces the one in use', async () => {
    putFile(FIXTURE); geo.load();
    routes['/free/dbip-country-lite-2026-10.csv.gz'] = { body: gz('1.0.0.0,1.0.0.255,AU\n') }; // far too few rows
    routes['/free/dbip-country-lite-2026-09.csv.gz'] = { body: Buffer.from('<html>not gzip</html>') };
    const r = await geo.refresh({ now, force: true, minRows4: 5, minRows6: 2 });
    assert.equal(r.ok, false);
    assert.match(r.error, /2026-10: only 1 IPv4 ranges/);
    assert.match(r.error, /2026-09: not a gzip file/);
    assert.equal(geo.lookup('41.58.1.1'), 'NG', 'the old table stays');
    assert.equal(zlib.gunzipSync(fs.readFileSync(geo.file())).toString(), FIXTURE, 'the old file stays');
  });

  it('a server error is reported, and nothing changes', async () => {
    routes['/free/dbip-country-lite-2026-10.csv.gz'] = { status: 500, body: 'oops' };
    const r = await geo.refresh({ now, force: true, minRows4: 5, minRows6: 2 });
    assert.equal(r.ok, false);
    assert.match(r.error, /HTTP 500/);
    assert.equal(geo.status().loaded, false);
  });
});

describe('the website language comes from the browser only', () => {
  // The pure function from public/js/site.js.
  const src = fs.readFileSync(path.join(__dirname, '../../public/js/site.js'), 'utf8');
  const fn = /function browserLang\(langs, supported\) \{[\s\S]*?\n\}/.exec(src)[0];
  const browserLang = vm.runInNewContext(`(${fn})`);
  const LANGS = { en: 1, fr: 1, pt: 1, es: 1, ru: 1 };

  it('picks the first supported language by its main part, else English', () => {
    assert.equal(browserLang(['fr-FR', 'en-US'], LANGS), 'fr');
    assert.equal(browserLang(['pt-BR'], LANGS), 'pt');
    assert.equal(browserLang(['de-DE', 'es-419', 'fr'], LANGS), 'es', 'first supported, in the visitor\'s order');
    assert.equal(browserLang(['ru_RU'], LANGS), 'ru');
    assert.equal(browserLang(['EN-gb'], LANGS), 'en');
    assert.equal(browserLang(['yo-NG', 'ha'], LANGS), 'en', 'nothing supported: English');
    assert.equal(browserLang([], LANGS), 'en');
    assert.equal(browserLang(undefined, LANGS), 'en');
    assert.equal(browserLang('fr-CA', LANGS), 'fr', 'a single string (navigator.language)');
    assert.equal(browserLang(['', null, 'toString', 'pt'], LANGS), 'pt', 'junk and prototype names are skipped');
  });

  it('a saved choice wins, html lang follows, and nothing looks at the country or IP', () => {
    assert.match(src, /siteLang = LANGS\[s\] \? s : browserLang\(navLangs\(\), LANGS\)/);
    assert.match(src, /document\.documentElement\.lang = siteLang/);
    assert.match(src, /store\.set\('cv_lang', siteLang\)/, 'only a manual pick is saved');
    const core = fs.readFileSync(path.join(__dirname, '../../public/js/core.js'), 'utf8');
    assert.match(core, /get\(k\) \{ try \{ return localStorage\.getItem\(k\); \} catch/, 'storage reads never throw');
    assert.doesNotMatch(src, /api\/public\/geo|CFG\.country|ip_country/, 'the language never uses the country');
  });

  it('the sign-up step shows the detected country pre-selected, with Change, and keeps no time-zone guess', () => {
    const s = fs.readFileSync(path.join(__dirname, '../../public/js/signup.js'), 'utf8');
    assert.match(s, /GET\('\/api\/public\/geo'\)/);
    assert.match(s, /Detected from your connection/);
    assert.match(s, />Change<\/button>/);
    assert.match(s, /placeholder="Select your country"/);
    assert.doesNotMatch(s, /TZ_COUNTRY|resolvedOptions\(\)\.timeZone/);
  });
});

'use strict';
/* The voiced training videos (public/videos): every guide's files exist, the server serves them with the right
 * types, answers Range requests (206) so players can seek, refuses bad ranges (416), and the CSP lets them play. */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers/app');

const PUB = path.join(__dirname, '..', '..', 'public');
let app;
before(async () => { app = await startApp(); });
after(async () => { if (app) await app.stop(); });

/** The guide list from public/js/app-guides.js (read in a sandbox, like the flows render test). */
function guides() {
  const src = fs.readFileSync(path.join(PUB, 'js', 'app-guides.js'), 'utf8');
  const box = { PAGES: {}, document: { addEventListener() {} } };
  vm.runInNewContext(src + '\n;this.VGUIDES = VGUIDES; this.GUIDE_V = GUIDE_V;', box);
  return box;
}

describe('training videos', () => {
  it('every guide has an mp4, captions and a poster, and the set stays small', () => {
    const { VGUIDES } = guides();
    assert.ok(VGUIDES.length >= 8);
    let total = 0;
    for (const g of VGUIDES) {
      for (const ext of ['mp4', 'vtt', 'jpg']) assert.ok(fs.existsSync(path.join(PUB, 'videos', g.id + '.' + ext)), g.id + '.' + ext);
      const size = fs.statSync(path.join(PUB, 'videos', g.id + '.mp4')).size;
      assert.ok(size < 15e6, g.id + ' is under 15 MB');
      total += size;
      const vtt = fs.readFileSync(path.join(PUB, 'videos', g.id + '.vtt'), 'utf8');
      assert.match(vtt, /^WEBVTT\n/);
      assert.ok((vtt.match(/-->/g) || []).length >= 5, g.id + ' has captions');
      assert.ok(g.dur > 20 && g.dur < 180, g.id + ' duration');
    }
    assert.ok(total < 80e6, 'all videos together under 80 MB');
  });

  it('serves mp4 with its type, length and Accept-Ranges', async () => {
    const f = path.join(PUB, 'videos', 'connect-bot.mp4');
    const size = fs.statSync(f).size;
    const r = await fetch(app.url + '/videos/connect-bot.mp4');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'video/mp4');
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
    assert.equal(Number(r.headers.get('content-length')), size);
    assert.match(r.headers.get('cache-control'), /max-age=86400/);
    assert.equal((await r.arrayBuffer()).byteLength, size);
    const v = await fetch(app.url + '/videos/connect-bot.mp4?v=1', { method: 'HEAD' });
    assert.match(v.headers.get('cache-control'), /immutable/);
  });

  it('answers Range requests with 206 and the exact bytes', async () => {
    const f = path.join(PUB, 'videos', 'connect-bot.mp4');
    const buf = fs.readFileSync(f), size = buf.length;
    const a = await fetch(app.url + '/videos/connect-bot.mp4', { headers: { range: 'bytes=0-99' } });
    assert.equal(a.status, 206);
    assert.equal(a.headers.get('content-range'), `bytes 0-99/${size}`);
    assert.equal(Number(a.headers.get('content-length')), 100);
    assert.deepEqual(Buffer.from(await a.arrayBuffer()), buf.subarray(0, 100));
    const b = await fetch(app.url + '/videos/connect-bot.mp4', { headers: { range: 'bytes=1000-' } });
    assert.equal(b.status, 206);
    assert.equal(b.headers.get('content-range'), `bytes 1000-${size - 1}/${size}`);
    assert.deepEqual(Buffer.from(await b.arrayBuffer()), buf.subarray(1000));
    const c = await fetch(app.url + '/videos/connect-bot.mp4', { headers: { range: 'bytes=-500' } });
    assert.equal(c.status, 206);
    assert.deepEqual(Buffer.from(await c.arrayBuffer()), buf.subarray(size - 500));
    const d = await fetch(app.url + '/videos/connect-bot.mp4', { headers: { range: `bytes=${size}-` } });
    assert.equal(d.status, 416);
    assert.equal(d.headers.get('content-range'), `bytes */${size}`);
    await d.arrayBuffer();
    const e = await fetch(app.url + '/videos/connect-bot.mp4', { headers: { range: `bytes=${size - 10}-${size + 5000}` } });
    assert.equal(e.status, 206, 'an end past the file is clipped');
    assert.equal(Number(e.headers.get('content-length')), 10);
    await e.arrayBuffer();
  });

  it('range parser edge cases', () => {
    const { parseRange } = app.require('app'); // after startApp, so config sees the test settings
    assert.equal(parseRange(undefined, 100), null);
    assert.equal(parseRange('bytes=0-1,5-6', 100), null, 'several ranges: whole file');
    assert.equal(parseRange('items=0-1', 100), null);
    assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19 });
    assert.deepEqual(parseRange('bytes=-1000', 100), { start: 0, end: 99 });
    assert.equal(parseRange('bytes=20-10', 100), 'bad');
    assert.equal(parseRange('bytes=-0', 100), 'bad');
  });

  it('captions and posters have their types; the CSP lets the dashboard play them', async () => {
    const t = await fetch(app.url + '/videos/connect-bot.vtt');
    assert.equal(t.status, 200);
    assert.equal(t.headers.get('content-type'), 'text/vtt; charset=utf-8');
    assert.match(await t.text(), /^WEBVTT/);
    const p = await fetch(app.url + '/videos/connect-bot.jpg');
    assert.equal(p.headers.get('content-type'), 'image/jpeg');
    await p.arrayBuffer();
    const html = await fetch(app.url + '/');
    const csp = html.headers.get('content-security-policy');
    assert.match(csp, /media-src 'self'/);
    assert.match(csp, /img-src 'self'/);
    const page = await html.text();
    assert.match(page, /\/js\/app-guides\.js\?v=/, 'the guides script is loaded');
    assert.match(page, /data-v="guides"/, 'Guides is in the menu');
  });

  it('a missing video is a 404, and paths cannot leave public/', async () => {
    const r = await fetch(app.url + '/videos/nope.mp4');
    assert.equal(r.status, 404);
    await r.arrayBuffer();
    const x = await fetch(app.url + '/videos/..%2f..%2fpackage.json');
    assert.notEqual(x.status, 200);
    await x.arrayBuffer();
  });
});

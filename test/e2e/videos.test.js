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
      assert.ok(size < 5e6, g.id + ' is under 5 MB (mobile encode, see app-guides.js)');
      total += size;
      const vtt = fs.readFileSync(path.join(PUB, 'videos', g.id + '.vtt'), 'utf8');
      assert.match(vtt, /^WEBVTT\n/);
      assert.ok((vtt.match(/-->/g) || []).length >= 5, g.id + ' has captions');
      assert.ok(g.dur > 20 && g.dur < 180, g.id + ' duration');
    }
    assert.ok(total < 35e6, 'all videos together under 35 MB, so the whole app fits in one zip');
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

  it('iPhone probe: Range bytes=0-1 is a 206 with 2 bytes and the full size; HEAD works with and without a range', async () => {
    const f = path.join(PUB, 'videos', 'welcome-flow.mp4');
    const buf = fs.readFileSync(f), size = buf.length;
    const a = await fetch(app.url + '/videos/welcome-flow.mp4?v=2', { headers: { range: 'bytes=0-1', 'accept-encoding': 'gzip, deflate, br' } });
    assert.equal(a.status, 206);
    assert.equal(a.headers.get('content-type'), 'video/mp4');
    assert.equal(a.headers.get('content-range'), `bytes 0-1/${size}`);
    assert.equal(a.headers.get('content-length'), '2');
    assert.equal(a.headers.get('accept-ranges'), 'bytes');
    assert.equal(a.headers.get('content-encoding'), null, 'media is never compressed');
    assert.match(a.headers.get('cache-control'), /immutable/);
    assert.ok(a.headers.get('etag'));
    assert.deepEqual(Buffer.from(await a.arrayBuffer()), buf.subarray(0, 2));
    // the rest of the file, as Safari asks for it next
    const b = await fetch(app.url + '/videos/welcome-flow.mp4?v=2', { headers: { range: 'bytes=2-' } });
    assert.equal(b.status, 206);
    assert.equal(b.headers.get('content-range'), `bytes 2-${size - 1}/${size}`);
    assert.equal(Number(b.headers.get('content-length')), size - 2);
    assert.deepEqual(Buffer.from(await b.arrayBuffer()), buf.subarray(2));
    const h = await fetch(app.url + '/videos/welcome-flow.mp4', { method: 'HEAD' });
    assert.equal(h.status, 200);
    assert.equal(Number(h.headers.get('content-length')), size);
    assert.equal(h.headers.get('content-type'), 'video/mp4');
    assert.equal(h.headers.get('accept-ranges'), 'bytes');
    assert.equal((await h.arrayBuffer()).byteLength, 0);
    const hr = await fetch(app.url + '/videos/welcome-flow.mp4', { method: 'HEAD', headers: { range: 'bytes=0-1' } });
    assert.equal(hr.status, 206);
    assert.equal(hr.headers.get('content-range'), `bytes 0-1/${size}`);
    assert.equal(hr.headers.get('content-length'), '2');
    // If-Range: a range only while the file is the same one
    const same = await fetch(app.url + '/videos/welcome-flow.mp4', { headers: { range: 'bytes=0-1', 'if-range': a.headers.get('etag') } });
    assert.equal(same.status, 206); await same.arrayBuffer();
    const changed = await fetch(app.url + '/videos/welcome-flow.mp4', { headers: { range: 'bytes=0-1', 'if-range': '"old"' } });
    assert.equal(changed.status, 200, 'a changed file is sent whole');
    assert.equal(Number(changed.headers.get('content-length')), size);
    await changed.arrayBuffer();
  });

  it('every guide mp4 is encoded for phones (faststart, H.264 Main 3.1) and the start-up check finds none missing', () => {
    const gv = app.require('lib/guide-videos');
    const list = gv.guides();
    assert.deepEqual(list.map((g) => g.id), Array.from(guides().VGUIDES, (g) => g.id));
    for (const g of list) {
      const i = gv.inspectMp4(path.join(PUB, 'videos', g.id + '.mp4'));
      assert.ok(i.faststart, g.id + ': moov before mdat');
      assert.deepEqual(i.avc, { profile: 77, level: 31 }, g.id + ': H.264 Main 3.1');
    }
    assert.deepEqual(gv.missing(), []);
    const lines = [];
    assert.deepEqual(gv.warnIfMissing({ warn: (m, d) => lines.push([m, d]) }), []);
    assert.equal(lines.length, 0);
  });

  it('a deploy without the videos is caught: warning at start-up, and npm run check fails', () => {
    const os = require('node:os');
    const gv = app.require('lib/guide-videos');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-pub-'));
    fs.mkdirSync(path.join(tmp, 'js')); fs.mkdirSync(path.join(tmp, 'videos'));
    fs.copyFileSync(path.join(PUB, 'js', 'app-guides.js'), path.join(tmp, 'js', 'app-guides.js'));
    for (const ext of ['mp4', 'vtt', 'jpg']) fs.copyFileSync(path.join(PUB, 'videos', 'setup-helper.' + ext), path.join(tmp, 'videos', 'setup-helper.' + ext));
    fs.writeFileSync(path.join(tmp, 'videos', 'connect-bot.mp4'), '');
    try {
      const m = gv.missing(tmp);
      assert.ok(m.some((x) => x.file === path.join('public', 'videos', 'welcome-flow.mp4') && x.why === 'missing'));
      assert.ok(m.some((x) => x.file === path.join('public', 'videos', 'connect-bot.mp4') && x.why === 'empty'));
      assert.ok(!m.some((x) => x.id === 'setup-helper'));
      const lines = [];
      gv.warnIfMissing({ warn: (msg, d) => lines.push({ msg, d }) }, tmp);
      assert.equal(lines.length, 1);
      assert.match(lines[0].msg, /guide videos missing/);
      assert.ok(lines[0].d.missing.includes(path.join('public', 'videos', 'add-channel.mp4')));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    const check = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'check.js'), 'utf8');
    assert.match(check, /require\('\.\.\/server\/lib\/guide-videos'\)/);
    assert.match(check, /fail\('videos'/);
  });

  it('the player: inline on iPhone, metadata only, starts from a tap, and shows a retry when a video fails', () => {
    const src = fs.readFileSync(path.join(PUB, 'js', 'app-guides.js'), 'utf8');
    assert.match(src, /<video class="vg-v" playsinline webkit-playsinline preload="metadata"/);
    assert.match(src, /<source src="' \+ vgSrc\(g\.id, 'mp4'\) \+ '" type="video\/mp4">/);
    assert.doesNotMatch(src, /autoplay/);
    assert.match(src, /This video couldn\\'t load — check your connection and try again/);
    assert.match(src, /srcEl\.addEventListener\('error'/, 'errors on <source> are caught');
    assert.match(src, /addEventListener\('stalled'/);
    assert.match(src, /data-vretry/);
  });

  it('range parser edge cases', () => {
    const { parseRange } = app.require('app'); // after startApp, so config sees the test settings
    assert.equal(parseRange(undefined, 100), null);
    assert.equal(parseRange('bytes=0-1,5-6', 100), null, 'several ranges: whole file');
    assert.equal(parseRange('items=0-1', 100), null);
    assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19 });
    assert.deepEqual(parseRange('bytes=0-1', 100), { start: 0, end: 1 });
    assert.deepEqual(parseRange('bytes=0-', 100), { start: 0, end: 99 });
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

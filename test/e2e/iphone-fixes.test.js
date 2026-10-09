'use strict';
/*
 * iPhone reports (Oct 2026): guide videos without sound, empty-state buttons spilling out of their pill, the page
 * jumping up and down while browsing. These tests read the browser files, like qa-ui-fixes.test.js.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const PUB = path.join(__dirname, '..', '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
const css = read('css/castvoo.css');
const appJs = read('js/app.js');
const guides = read('js/app-guides.js');
const VIDEOS = [...guides.matchAll(/\{ id: '([a-z-]+)', title:/g)].map((m) => m[1]);

describe('guide videos play with sound', () => {
  it('every video has an AAC audio track', () => {
    assert.equal(VIDEOS.length, 9);
    for (const id of VIDEOS) {
      const buf = fs.readFileSync(path.join(PUB, 'videos', id + '.mp4'));
      assert.ok(buf.includes(Buffer.from('soun')), id + ' has a sound track');
      assert.ok(buf.includes(Buffer.from('mp4a')), id + ' audio is AAC (mp4a)');
    }
  });

  it('the narration is loud enough everywhere (ffmpeg, when installed)', (t) => {
    if (spawnSync('ffmpeg', ['-version']).status !== 0) { t.skip('ffmpeg not installed'); return; }
    for (const id of VIDEOS) {
      const r = spawnSync('ffmpeg', ['-nostats', '-i', path.join(PUB, 'videos', id + '.mp4'), '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
      const mean = Number((/mean_volume: (-?[\d.]+) dB/.exec(r.stderr) || [])[1]);
      const max = Number((/max_volume: (-?[\d.]+) dB/.exec(r.stderr) || [])[1]);
      assert.ok(mean > -30, `${id} mean volume ${mean} dB`);
      assert.ok(max > -6 && max <= 0, `${id} peak ${max} dB`);
    }
  });

  it('tapping Play turns sound on in the tap, the mute button shows on phones, and mute is never saved', () => {
    assert.doesNotMatch(guides, /hide-xs" data-vmute/, 'mute button is not hidden on phones');
    assert.match(guides, /data-vmute aria-label="Mute" aria-pressed="false"/);
    const play = /const play = \(\) => \{[\s\S]*?\n {2}\};/.exec(guides)[0];
    assert.ok(play.indexOf('withSound()') > -1 && play.indexOf('withSound()') < play.indexOf('v.play()'), 'sound is switched on before play(), inside the tap');
    assert.match(guides, /v\.defaultMuted = false; v\.removeAttribute\('muted'\); v\.muted = false; v\.volume = 1;/);
    assert.match(guides, /navigator\.audioSession\.type = 'playback'/, 'iPhone silent switch does not mute the voice');
    assert.match(guides, /NotAllowedError[\s\S]{0,80}v\.muted = true/, 'a refused unmuted play falls back to muted + "Tap for sound"');
    assert.match(guides, /data-vsnd hidden>/);
    assert.doesNotMatch(guides, /store\.set\([^)]*(mute|volume)/i, 'mute is not remembered between videos or visits');
    assert.doesNotMatch(guides, /<video[^>]*\smuted/, 'the video element never starts muted');
    assert.doesNotMatch(read('js/core.js') + appJs + guides, /AudioContext/, 'no Web Audio (the silent switch mutes it)');
  });
});

describe('empty-state buttons never spill out', () => {
  it('no nowrap in empty-state rows; they wrap, and stack full width at 430px and below', () => {
    assert.doesNotMatch(css, /\.emptyb \.row2b \.btn\{white-space:nowrap/);
    assert.match(css, /\.emptyb \.row2b\{width:100%;display:flex;flex-wrap:wrap/);
    assert.match(css, /\.emptyb \.row2b>\.btn\{flex:1 1 auto;min-width:0;max-width:100%;white-space:normal/);
    assert.match(css, /@media \(max-width:430px\)\{\s*\.emptyb \.row2b\{flex-direction:column;align-items:stretch\}/);
  });
});

describe('the page does not jump on iPhones', () => {
  it('page heights use svh, not dvh (dvh changes while Safari\'s bar shrinks during a scroll)', () => {
    assert.doesNotMatch(css, /\.app\{[^}]*min-height:100dvh/);
    assert.doesNotMatch(css, /\.su\{[^}]*min-height:100dvh/);
    assert.match(css, /\.app\{min-height:100vh;min-height:100svh\}/);
  });

  it('putHtml writes only when the HTML changed (polls do not rebuild the page)', () => {
    const src = /function putHtml\(el, h\) \{[^\n]+\}/.exec(appJs)[0];
    const box = {}; vm.runInNewContext(src + '\nthis.putHtml = putHtml;', box);
    let writes = 0; let html = '';
    const el = { get innerHTML() { return html; }, set innerHTML(v) { writes++; html = v; } };
    assert.equal(box.putHtml(el, '<b>1 sending</b>'), true);
    for (let i = 0; i < 20; i++) box.putHtml(el, '<b>1 sending</b>');
    assert.equal(writes, 1, 'twenty identical polls, one write');
    box.putHtml(el, '<b>2 sending</b>');
    assert.equal(writes, 2);
  });

  it('the pollers patch in place: banners and the Home "sending" box use putHtml', () => {
    assert.match(appJs, /putHtml\(\$\('#appBanners'\), b\.join\(''\)\)/);
    assert.match(read('js/app-home.js'), /every\(5000[\s\S]{0,200}putHtml\(\$\('#ovSend'\), sendingBox\(ns\.sending\)\)/);
  });

  it('redraws after an action or closing a video keep the scroll position; only page changes go to the top', () => {
    assert.match(appJs, /async function renderPage\(name, q, opts\)/);
    assert.match(appJs, /if \(keepY === null\) window\.scrollTo\(0, 0\);/);
    assert.match(guides, /renderPage\('guides', \{\}, \{ keepScroll: true \}\)/);
    assert.match(read('js/app-home.js'), /renderPage\('overview', \{\}, \{ keepScroll: true \}\)/);
  });

  it('the homepage animation does not keep running behind the dashboard', () => {
    const site = read('js/site.js');
    assert.doesNotMatch(site, /else hjT\.push\(setTimeout\(heroJoin, 2000\)\)/);
    assert.match(site, /const again = \(\) => \{ if \(siteOn\(\)\) heroJoin\(\); else hjT\.push\(setTimeout\(again, 2000\)\); \};/);
  });
});

'use strict';
/*
 * The voiced guide videos listed in public/js/app-guides.js (VGUIDES) must all be in public/videos (mp4, captions,
 * poster). A deploy that left them out plays nothing: the server warns at start-up and `npm run check` fails.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUB = path.join(__dirname, '..', '..', 'public');

/** The guide list, read from the browser file in a sandbox (nothing in it runs against the server). */
function guides(pub = PUB) {
  const src = fs.readFileSync(path.join(pub, 'js', 'app-guides.js'), 'utf8');
  const box = { PAGES: {}, document: { addEventListener() {} } };
  vm.runInNewContext(src + '\n;this.VGUIDES = VGUIDES;', box, { timeout: 1000 });
  return Array.from(box.VGUIDES || [], (g) => ({ id: String(g.id), title: String(g.title), dur: Number(g.dur) }));
}

/** [{ id, file, why }] for every guide file that is missing or empty. */
function missing(pub = PUB) {
  const out = [];
  for (const g of guides(pub)) {
    for (const ext of ['mp4', 'vtt', 'jpg']) {
      const file = path.join('public', 'videos', g.id + '.' + ext);
      let st = null;
      try { st = fs.statSync(path.join(pub, 'videos', g.id + '.' + ext)); } catch { /* missing */ }
      if (!st || !st.isFile()) out.push({ id: g.id, file, why: 'missing' });
      else if (!st.size) out.push({ id: g.id, file, why: 'empty' });
    }
  }
  return out;
}

/**
 * A quick look inside an mp4 (no ffprobe needed): the top-level boxes in order, and the H.264 profile and level from
 * the avcC box. Phones start playing straight away only when "moov" comes before "mdat" (ffmpeg -movflags +faststart).
 */
function inspectMp4(file) {
  const buf = fs.readFileSync(file);
  const boxes = [];
  let i = 0;
  while (i + 8 <= buf.length && boxes.length < 64) {
    let size = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    if (size === 1 && i + 16 <= buf.length) size = Number(buf.readBigUInt64BE(i + 8));
    else if (size === 0) size = buf.length - i;
    if (size < 8) break;
    boxes.push(type);
    i += size;
  }
  const a = buf.indexOf('avcC', 0, 'latin1');
  const avc = a > 0 && a + 8 < buf.length ? { profile: buf[a + 5], level: buf[a + 7] } : null;
  return { size: buf.length, boxes, faststart: boxes.indexOf('moov') >= 0 && (boxes.indexOf('mdat') < 0 || boxes.indexOf('moov') < boxes.indexOf('mdat')), avc };
}

/** Start-up check: one clear warning line when guide videos are missing (the site still starts). */
function warnIfMissing(log, pub = PUB) {
  let m;
  try { m = missing(pub); } catch (e) { log.warn('guide videos could not be checked', { err: e }); return []; }
  if (m.length) {
    log.warn('guide videos missing: the Guides page cannot play them. Deploy public/videos with the app (npm run check lists them).', {
      missing: m.map((x) => x.file + (x.why === 'empty' ? ' (empty)' : '')),
    });
  }
  return m;
}

module.exports = { guides, missing, warnIfMissing, inspectMp4 };

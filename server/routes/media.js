'use strict';
/*
 * Photo, video, voice note and round video uploads. The browser sends the file as the raw request body
 * (Content-Type = the file type, X-Filename = its name). ?as=voice or ?as=video_note says what a recording is for
 * (an MP4 can be a normal video or a round video). Files are saved in UPLOAD_DIR (a Railway volume). Telegram gets the
 * file once per bot; after that we reuse its file_id. Voice notes and round videos are converted with ffmpeg
 * (services/media-convert.js).
 */

const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const config = require('../config');
const settings = require('../services/settings');
const convert = require('../services/media-convert');
const { randomToken, httpError, badRequest, notFound, int } = require('../lib/util');

const ftyp = (b) => b.slice(4, 8).toString() === 'ftyp';
const TYPES = {
  'image/jpeg': { kind: 'photo', ext: '.jpg', max: 10 * 1024 * 1024, magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  'image/png': { kind: 'photo', ext: '.png', max: 10 * 1024 * 1024, magic: (b) => b.slice(0, 4).toString('hex') === '89504e47' },
  'image/webp': { kind: 'photo', ext: '.webp', max: 10 * 1024 * 1024, magic: (b) => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' },
  'image/gif': { kind: 'animation', ext: '.gif', max: 10 * 1024 * 1024, magic: (b) => b.slice(0, 3).toString() === 'GIF' },
  'video/mp4': { kind: 'video', ext: '.mp4', max: 50 * 1024 * 1024, magic: ftyp },
  'video/quicktime': { kind: 'video', ext: '.mov', max: 50 * 1024 * 1024, magic: (b) => ftyp(b) || b.slice(4, 8).toString() === 'moov' || b.slice(4, 8).toString() === 'wide' },
};
const webm = (b) => b.slice(0, 4).toString('hex') === '1a45dfa3';
const ogg = (b) => b.slice(0, 4).toString() === 'OggS';
const mp3 = (b) => b.slice(0, 3).toString() === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
const aac = (b) => b[0] === 0xff && (b[1] & 0xf6) === 0xf0;
const wav = (b) => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WAVE';
/** Voice notes: any common audio file (recorded in the browser or uploaded), converted to OGG/Opus. */
const VOICE_TYPES = {
  'audio/ogg': { ext: '.ogg', magic: ogg }, 'audio/opus': { ext: '.opus', magic: ogg }, 'application/ogg': { ext: '.ogg', magic: ogg },
  'audio/mpeg': { ext: '.mp3', magic: mp3 }, 'audio/mp3': { ext: '.mp3', magic: mp3 },
  'audio/mp4': { ext: '.m4a', magic: ftyp }, 'audio/x-m4a': { ext: '.m4a', magic: ftyp }, 'audio/m4a': { ext: '.m4a', magic: ftyp },
  'audio/aac': { ext: '.aac', magic: (b) => aac(b) || ftyp(b) }, 'audio/x-aac': { ext: '.aac', magic: (b) => aac(b) || ftyp(b) },
  'audio/wav': { ext: '.wav', magic: wav }, 'audio/x-wav': { ext: '.wav', magic: wav }, 'audio/wave': { ext: '.wav', magic: wav },
  'audio/webm': { ext: '.webm', magic: webm },
  // Some browsers label an audio-only recording as video (Safari: video/mp4; Firefox/Chrome: video/webm).
  'video/webm': { ext: '.webm', magic: webm }, 'video/mp4': { ext: '.m4a', magic: ftyp },
};
/** Round videos: MP4, MOV or WEBM (a camera recording), converted to a square H.264 MP4 of 60 seconds or less. */
const ROUND_TYPES = {
  'video/mp4': { ext: '.mp4', magic: ftyp }, 'video/quicktime': { ext: '.mov', magic: TYPES['video/quicktime'].magic }, 'video/webm': { ext: '.webm', magic: webm },
};
const VOICE_MAX = 20 * 1024 * 1024;
const ROUND_MAX = 50 * 1024 * 1024;

/** What an upload is: { kind, ext, max, magic } from its type and ?as=. */
function typeOf(mime, as) {
  if (as === 'voice' || (!as && (VOICE_TYPES[mime] && mime.startsWith('audio/')))) {
    const t = VOICE_TYPES[mime];
    if (!t) throw badRequest('Use an OGG, OPUS, MP3, M4A, AAC, WAV or WEBM audio file for a voice note.');
    return { kind: 'voice', ext: t.ext, max: VOICE_MAX, magic: t.magic };
  }
  if (as === 'video_note') {
    const t = ROUND_TYPES[mime];
    if (!t) throw badRequest('Use an MP4, MOV or WEBM video for a round video.');
    return { kind: 'video_note', ext: t.ext, max: ROUND_MAX, magic: t.magic };
  }
  const t = TYPES[mime];
  if (!t) throw badRequest('Use a JPG, PNG, WEBP, GIF, MP4 or MOV file (or an audio file for a voice note).');
  return t;
}
const tooBig = (kind) => ({ voice: 'Voice notes can be up to 20 MB.', video_note: 'Round videos can be up to 50 MB (they are cut to 60 seconds).', video: 'Videos can be up to 50 MB.' }[kind] || 'Photos can be up to 10 MB.');

/** Per-workspace storage for uploads (the Railway volume is shared by everyone). */
const STORAGE = { bytes: 2 * 1024 * 1024 * 1024, files: 1000 };

module.exports = (r) => {
  r.post('/api/media', async (ctx) => {
    await settings.requireFeature('media');
    const mime = String(ctx.req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const as = ctx.query.as ? String(ctx.query.as) : '';
    if (as && !['voice', 'video_note'].includes(as)) throw badRequest('Unknown kind of file.');
    const t = typeOf(mime, as);
    const declared = Number(ctx.req.headers['content-length'] || 0);
    if (declared > t.max) throw httpError(413, tooBig(t.kind), 'too_large');
    // Storage per workspace: without a cap one account could fill the disk (60 uploads × 50 MB every 10 minutes).
    // Files no message uses are removed after a few days (workers/jobs.js cleanupTick), so the cap rarely bites.
    const used = await db.one('select count(*)::int n, coalesce(sum(size_bytes), 0)::bigint bytes from media where workspace_id = $1', [ctx.workspace.id]);
    if (used.n >= STORAGE.files || Number(used.bytes) + Math.max(declared, 0) > STORAGE.bytes) {
      throw httpError(413, 'Your workspace has no room for more photos and videos right now. Files you have not used in a message are cleared after 3 days; try again then, or reuse a file you already uploaded.', 'storage_full');
    }
    const name = String(ctx.req.headers['x-filename'] || 'file').replace(/[^\w.\- ]/g, '').slice(0, 80) || 'file';
    const dir = path.join(config.uploadDir, String(ctx.workspace.id));
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, randomToken(12) + t.ext);

    let size = 0, head = Buffer.alloc(0);
    const out = fs.createWriteStream(file);
    try {
      await new Promise((resolve, reject) => {
        ctx.req.on('data', (c) => {
          size += c.length;
          if (head.length < 16) head = Buffer.concat([head, c]).slice(0, 16);
          if (size > t.max) { reject(httpError(413, tooBig(t.kind), 'too_large')); ctx.req.destroy(); return; }
          if (!out.write(c)) { ctx.req.pause(); out.once('drain', () => ctx.req.resume()); }
        });
        ctx.req.on('end', resolve);
        ctx.req.on('error', reject);
      });
      await new Promise((resolve) => out.end(resolve));
      if (!size) throw badRequest('The file is empty.');
      if (!t.magic(head)) throw badRequest(t.kind === 'voice' ? 'That file does not match its type. Record it again, or export it as MP3, M4A or OGG.' : 'That file does not match its type. Export it again as JPG, PNG or MP4.');
    } catch (e) {
      out.destroy();
      await fs.promises.unlink(file).catch(() => {});
      throw e;
    }
    // Voice notes and round videos: converted for Telegram (or accepted as they are when already right and ffmpeg is missing).
    let saved = { path: file, mime, size, duration_sec: null };
    if (t.kind === 'voice' || t.kind === 'video_note') {
      let ready;
      try { ready = await convert.prepare(t.kind, file, head, ctx.workspace.id); } catch (e) { await fs.promises.unlink(file).catch(() => {}); throw e; }
      if (ready.path !== file) await fs.promises.unlink(file).catch(() => {});
      saved = { path: ready.path, mime: ready.mime, size: ready.size, duration_sec: ready.duration_sec };
    }
    // SEC-18: the quota is checked again with the real size, under a per-workspace lock, so many uploads at the same
    // moment can't all pass a nearly full quota (the first check above only used the declared length).
    const row = await db.tx(async (c) => {
      await c.query('select pg_advisory_xact_lock(7101, $1::int)', [ctx.workspace.id]);
      const now = (await c.query('select count(*)::int n, coalesce(sum(size_bytes), 0)::bigint bytes from media where workspace_id = $1', [ctx.workspace.id])).rows[0];
      if (now.n >= STORAGE.files || Number(now.bytes) + saved.size > STORAGE.bytes) return null;
      return (await c.query('insert into media(workspace_id, kind, filename, mime, size_bytes, path, duration_sec) values ($1,$2,$3,$4,$5,$6,$7) returning id, kind, filename, size_bytes, duration_sec',
        [ctx.workspace.id, t.kind, name, saved.mime, saved.size, saved.path, saved.duration_sec])).rows[0];
    });
    if (!row) {
      await fs.promises.unlink(saved.path).catch(() => {});
      throw httpError(413, 'Your workspace has no room for more photos and videos right now. Files you have not used in a message are cleared after 3 days; try again then, or reuse a file you already uploaded.', 'storage_full');
    }
    return { media: row };
  }, { auth: 'workspace', stream: true, rate: [60, 600] });

  r.get('/api/media/:id', async (ctx) => {
    const m = await db.one('select * from media where id = $1 and workspace_id = $2', [int(ctx.params.id, 'File'), ctx.workspace.id]);
    if (!m) throw notFound('That file');
    let st;
    try { st = await fs.promises.stat(m.path); } catch { throw notFound('That file'); }
    // Byte ranges (206): iPhone Safari only plays audio and video previews from a server that answers them.
    const { parseRange, sendFile } = require('../app');
    const range = parseRange(ctx.req.headers.range, st.size);
    const base = { 'Content-Type': m.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400' };
    if (range === 'bad') {
      ctx.res.writeHead(416, { ...base, 'Content-Range': `bytes */${st.size}` });
      ctx.res.end(); ctx.sent = true; return;
    }
    const head = ctx.req.method === 'HEAD';
    if (range) {
      ctx.res.writeHead(206, { ...base, 'Content-Range': `bytes ${range.start}-${range.end}/${st.size}`, 'Content-Length': range.end - range.start + 1 });
      if (head) ctx.res.end(); else sendFile(m.path, ctx.res, range);
    } else {
      ctx.res.writeHead(200, { ...base, 'Content-Length': st.size });
      if (head) ctx.res.end(); else sendFile(m.path, ctx.res); // ENG-1: pipeline closes the file on abort
    }
    ctx.sent = true;
  }, { auth: 'workspace' });
};

module.exports.STORAGE = STORAGE;
module.exports.TYPES = TYPES;
module.exports.VOICE_TYPES = VOICE_TYPES;
module.exports.ROUND_TYPES = ROUND_TYPES;

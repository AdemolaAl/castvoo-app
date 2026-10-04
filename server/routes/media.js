'use strict';
/*
 * Photo and video uploads. The browser sends the file as the raw request body
 * (Content-Type = the file type, X-Filename = its name). Files are saved in UPLOAD_DIR
 * (a Railway volume). Telegram gets the file once per bot; after that we reuse its file_id.
 */

const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const config = require('../config');
const settings = require('../services/settings');
const { randomToken, httpError, badRequest, notFound, int } = require('../lib/util');

const TYPES = {
  'image/jpeg': { kind: 'photo', ext: '.jpg', max: 10 * 1024 * 1024, magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  'image/png': { kind: 'photo', ext: '.png', max: 10 * 1024 * 1024, magic: (b) => b.slice(0, 4).toString('hex') === '89504e47' },
  'image/webp': { kind: 'photo', ext: '.webp', max: 10 * 1024 * 1024, magic: (b) => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' },
  'image/gif': { kind: 'animation', ext: '.gif', max: 10 * 1024 * 1024, magic: (b) => b.slice(0, 3).toString() === 'GIF' },
  'video/mp4': { kind: 'video', ext: '.mp4', max: 50 * 1024 * 1024, magic: (b) => b.slice(4, 8).toString() === 'ftyp' },
  'video/quicktime': { kind: 'video', ext: '.mov', max: 50 * 1024 * 1024, magic: (b) => b.slice(4, 8).toString() === 'ftyp' || b.slice(4, 8).toString() === 'moov' || b.slice(4, 8).toString() === 'wide' },
};

module.exports = (r) => {
  r.post('/api/media', async (ctx) => {
    await settings.requireFeature('media');
    const mime = String(ctx.req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const t = TYPES[mime];
    if (!t) throw badRequest('Use a JPG, PNG, WEBP, GIF, MP4 or MOV file.');
    const declared = Number(ctx.req.headers['content-length'] || 0);
    if (declared > t.max) throw httpError(413, t.kind === 'video' ? 'Videos can be up to 50 MB.' : 'Photos can be up to 10 MB.', 'too_large');
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
          if (size > t.max) { reject(httpError(413, t.kind === 'video' ? 'Videos can be up to 50 MB.' : 'Photos can be up to 10 MB.', 'too_large')); ctx.req.destroy(); return; }
          if (!out.write(c)) { ctx.req.pause(); out.once('drain', () => ctx.req.resume()); }
        });
        ctx.req.on('end', resolve);
        ctx.req.on('error', reject);
      });
      await new Promise((resolve) => out.end(resolve));
      if (!size) throw badRequest('The file is empty.');
      if (!t.magic(head)) throw badRequest('That file does not match its type. Export it again as JPG, PNG or MP4.');
    } catch (e) {
      out.destroy();
      await fs.promises.unlink(file).catch(() => {});
      throw e;
    }
    const row = await db.one('insert into media(workspace_id, kind, filename, mime, size_bytes, path) values ($1,$2,$3,$4,$5,$6) returning id, kind, filename, size_bytes',
      [ctx.workspace.id, t.kind, name, mime, size, file]);
    return { media: row };
  }, { auth: 'workspace', stream: true, rate: [60, 600] });

  r.get('/api/media/:id', async (ctx) => {
    const m = await db.one('select * from media where id = $1 and workspace_id = $2', [int(ctx.params.id, 'File'), ctx.workspace.id]);
    if (!m) throw notFound('That file');
    let st;
    try { st = await fs.promises.stat(m.path); } catch { throw notFound('That file'); }
    ctx.res.writeHead(200, { 'Content-Type': m.mime, 'Content-Length': st.size, 'Cache-Control': 'private, max-age=86400' });
    fs.createReadStream(m.path).pipe(ctx.res);
    ctx.sent = true;
  }, { auth: 'workspace' });
};

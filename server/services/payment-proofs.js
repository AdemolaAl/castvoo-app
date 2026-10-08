'use strict';
/*
 * Screenshots customers send as proof for a manual top-up (bank transfer, mobile money...).
 * Same rules as photo uploads (routes/media.js): JPG, PNG or WEBP, up to 10 MB, checked by file signature.
 * They are kept apart from media (UPLOAD_DIR/proofs/<workspace>/), so the clean-up of unused photos never
 * touches them. They are deleted with the workspace (media-files.removeFiles).
 */

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { TYPES } = require('../routes/media');
const { randomToken, httpError, badRequest } = require('../lib/util');

const MAX = 10 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const root = () => path.resolve(config.uploadDir, 'proofs') + path.sep;

/** Save the request body as a proof image. Returns { path, mime, size }. */
async function save(ctx, workspaceId) {
  const mime = String(ctx.req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!IMAGE_TYPES.includes(mime)) throw badRequest('Send the screenshot as a JPG, PNG or WEBP image.');
  const t = TYPES[mime];
  if (Number(ctx.req.headers['content-length'] || 0) > MAX) throw httpError(413, 'Screenshots can be up to 10 MB.', 'too_large');
  const dir = path.join(config.uploadDir, 'proofs', String(Number(workspaceId)));
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, randomToken(12) + t.ext);
  let size = 0, head = Buffer.alloc(0);
  const out = fs.createWriteStream(file);
  try {
    await new Promise((resolve, reject) => {
      ctx.req.on('data', (c) => {
        size += c.length;
        if (head.length < 16) head = Buffer.concat([head, c]).slice(0, 16);
        if (size > MAX) { reject(httpError(413, 'Screenshots can be up to 10 MB.', 'too_large')); ctx.req.destroy(); return; }
        if (!out.write(c)) { ctx.req.pause(); out.once('drain', () => ctx.req.resume()); }
      });
      ctx.req.on('end', resolve);
      ctx.req.on('error', reject);
    });
    await new Promise((resolve) => out.end(resolve));
    if (!size) throw badRequest('The file is empty.');
    if (!t.magic(head)) throw badRequest('That file does not match its type. Take the screenshot again and save it as JPG or PNG.');
  } catch (e) {
    out.destroy();
    await fs.promises.unlink(file).catch(() => {});
    throw e;
  }
  return { path: file, mime, size };
}

/** Delete proof files (only ever inside the proofs folder). */
async function remove(paths) {
  let n = 0;
  for (const p of paths) {
    if (!p) continue;
    const abs = path.resolve(p);
    if (!abs.startsWith(root())) continue;
    try { await fs.promises.unlink(abs); n++; } catch { /* already gone */ }
  }
  return n;
}

/** Send a stored proof image back (admin review). */
async function stream(ctx, p) {
  const abs = path.resolve(p.proof_path || '');
  if (!p.proof_path || !abs.startsWith(root())) return false;
  let st;
  try { st = await fs.promises.stat(abs); } catch { return false; }
  ctx.res.writeHead(200, { 'Content-Type': IMAGE_TYPES.includes(p.proof_mime) ? p.proof_mime : 'application/octet-stream', 'Content-Length': st.size,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline; filename="proof' + path.extname(abs) + '"' });
  // ENG-1: pipeline closes the file when the reviewer's browser aborts, and a read error can't crash the process.
  require('../app').sendFile(abs, ctx.res);
  ctx.sent = true;
  return true;
}

module.exports = { save, remove, stream, MAX, IMAGE_TYPES };

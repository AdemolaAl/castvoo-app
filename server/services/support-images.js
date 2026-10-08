'use strict';
/*
 * Images in the support chat (dashboard → Help, and the team's replies in Admin → Support).
 * Customers and staff only: the logged-out website chat never takes images.
 *
 *   upload    the browser sends the file as the raw request body (Content-Type = its type), one image per request.
 *             JPG, PNG or WEBP, up to 10 MB, checked by file signature (like photo uploads and payment proofs).
 *             Metadata is removed before the file is saved: EXIF/XMP/comments in JPG (only the rotation is kept),
 *             text and time chunks in PNG, EXIF/XMP in WEBP. So a phone photo never leaks its GPS position.
 *   storage   UPLOAD_DIR/support/<workspace>/<random>.<ext>. The path is never sent to anyone.
 *   access    GET /api/support/attachments/:id        the customer of that conversation (not internal notes)
 *             GET /api/admin/support/attachments/:id  staff with support.view
 *   the AI    up to MAX_AI_IMAGES recent images go to the model as image blocks (llm.js turns them into the provider's
 *             format). There is no image library in plain Node, so images are sent as they are when they fit the
 *             providers' limit (AI_MAX bytes, at most 8,000 px a side); bigger ones are described in text and the
 *             agent asks for a smaller screenshot. The team still sees every image.
 * A message carries at most MAX_PER_MESSAGE images. Uploads not sent within a day are removed (cleanup worker).
 */

const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const config = require('../config');
const { TYPES } = require('../routes/media');
const { randomToken, httpError, badRequest } = require('../lib/util');

const MAX = 10 * 1024 * 1024;
const MAX_PER_MESSAGE = 3;
// Claude's limit is 5 MB per image after base64 (4/3 bigger), so 3.75 MB of file. OpenAI/OpenRouter accept more.
const AI_MAX = Math.floor(3.75 * 1024 * 1024);
const AI_MAX_SIDE = 8000;
const MAX_AI_IMAGES = 4;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const root = () => path.resolve(config.uploadDir, 'support') + path.sep;
const inside = (p) => !!p && path.resolve(p).startsWith(root());

/* ---------------- metadata ---------------- */
function exifOrientation(tiff) {
  try {
    const le = tiff.slice(0, 2).toString('latin1') === 'II';
    const u16 = (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
    const u32 = (o) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
    const ifd = u32(4);
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : 1; }
    }
  } catch { /* broken EXIF: no rotation */ }
  return 1;
}
/** A tiny EXIF block holding only the rotation, so phone photos still show the right way up. */
function orientationSegment(o) {
  const b = Buffer.alloc(36);
  b.writeUInt16BE(0xffe1, 0); b.writeUInt16BE(34, 2);
  b.write('Exif\0\0', 4, 'latin1'); b.write('MM', 10, 'latin1'); b.writeUInt16BE(42, 12); b.writeUInt32BE(8, 14);
  b.writeUInt16BE(1, 18); b.writeUInt16BE(0x0112, 20); b.writeUInt16BE(3, 22); b.writeUInt32BE(1, 24); b.writeUInt16BE(o, 28);
  b.writeUInt32BE(0, 32);
  return b;
}
function stripJpeg(b) {
  const out = [b.subarray(0, 2)];
  let i = 2, orientation = 1, insertAt = 1;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xda || m === 0xd9) { out.push(b.subarray(i)); i = b.length; break; } // image data: copied as it is
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { out.push(b.subarray(i, i + 2)); i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return null;
    const seg = b.subarray(i, i + 2 + len);
    const id = seg.subarray(4, 16).toString('latin1');
    if (m === 0xe1 && id.startsWith('Exif\0\0')) orientation = exifOrientation(seg.subarray(10));
    // Kept: JFIF (APP0), the colour profile (APP2 ICC_PROFILE), Adobe (APP14) and everything that is not APPn/COM.
    const drop = m === 0xfe || (m >= 0xe1 && m <= 0xef && m !== 0xee && !(m === 0xe2 && id === 'ICC_PROFILE\0'));
    if (!drop) { out.push(seg); if (m === 0xe0) insertAt = out.length; }
    i += 2 + len;
  }
  if (i < b.length) return null;
  if (orientation > 1) out.splice(insertAt, 0, orientationSegment(orientation));
  return Buffer.concat(out);
}
function stripPng(b) {
  if (b.length < 33 || b.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  const out = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.subarray(i + 4, i + 8).toString('latin1');
    const end = i + 12 + len;
    if (end > b.length) return null;
    if (!['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'].includes(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(out);
}
function stripWebp(b) {
  const out = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = b.subarray(i, i + 4).toString('latin1');
    const len = b.readUInt32LE(i + 4);
    const end = i + 8 + len + (len % 2);
    if (i + 8 + len > b.length) return null;
    if (type === 'EXIF' || type === 'XMP ') { i = end; continue; }
    let chunk = Buffer.from(b.subarray(i, Math.min(end, b.length)));
    if (type === 'VP8X' && chunk.length > 8) chunk[8] &= ~(0x08 | 0x04); // no EXIF / XMP flags
    out.push(chunk);
    i = end;
  }
  const body = Buffer.concat(out);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length + 4, 4); head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}
/** Remove metadata. Returns null when the file is not a well-formed image of its type. */
function strip(buf, mime) {
  try {
    if (mime === 'image/jpeg') return stripJpeg(buf);
    if (mime === 'image/png') return stripPng(buf);
    if (mime === 'image/webp') return stripWebp(buf);
  } catch { return null; }
  return null;
}

/** Width and height from the file header (no image library needed). */
function dimensions(b, mime) {
  try {
    if (mime === 'image/png') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const m = b[i + 1];
        if (m === 0xff) { i++; continue; }
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        if (m === 0xda) return null;
        i += 2 + b.readUInt16BE(i + 2);
      }
      return null;
    }
    if (mime === 'image/webp') {
      let i = 12;
      while (i + 8 <= b.length) {
        const type = b.subarray(i, i + 4).toString('latin1');
        const len = b.readUInt32LE(i + 4);
        const d = i + 8;
        if (type === 'VP8X') return { width: 1 + b.readUIntLE(d + 4, 3), height: 1 + b.readUIntLE(d + 7, 3) };
        if (type === 'VP8 ') return { width: b.readUInt16LE(d + 6) & 0x3fff, height: b.readUInt16LE(d + 8) & 0x3fff };
        if (type === 'VP8L') { const bits = b.readUInt32LE(d + 1); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
        i = d + len + (len % 2);
      }
    }
  } catch { /* unknown */ }
  return null;
}

/* ---------------- saving ---------------- */
/**
 * Save one image from the request body. who = { threadId, workspaceId, userId, type: 'user' | 'staff' }.
 * Returns the public row (no path).
 */
async function save(ctx, who) {
  const mime = String(ctx.req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!IMAGE_TYPES.includes(mime)) throw badRequest('Send a JPG, PNG or WEBP image (a screenshot works best).');
  if (Number(ctx.req.headers['content-length'] || 0) > MAX) throw httpError(413, 'Images can be up to 10 MB. Send a smaller screenshot.', 'too_large');
  const chunks = [];
  let size = 0;
  await new Promise((resolve, reject) => {
    ctx.req.on('data', (c) => {
      size += c.length;
      if (size > MAX) { reject(httpError(413, 'Images can be up to 10 MB. Send a smaller screenshot.', 'too_large')); ctx.req.destroy(); return; }
      chunks.push(c);
    });
    ctx.req.on('end', resolve);
    ctx.req.on('error', reject);
  });
  const raw = Buffer.concat(chunks);
  if (!raw.length) throw badRequest('The file is empty.');
  if (!TYPES[mime].magic(raw.subarray(0, 16))) throw badRequest('That file does not match its type. Take the screenshot again and save it as JPG or PNG.');
  const clean = strip(raw, mime);
  if (!clean) throw badRequest('That image looks damaged. Take the screenshot again and send it as JPG or PNG.');
  const dim = dimensions(clean, mime);
  if (!dim || !(dim.width > 0) || !(dim.height > 0) || dim.width > 30000 || dim.height > 30000) throw badRequest('That image looks damaged. Take the screenshot again and send it as JPG or PNG.');
  const name = String(ctx.req.headers['x-filename'] || 'image').replace(/[^\w.\- ]/g, '').slice(0, 80) || 'image';
  const dir = path.join(root(), String(Number(who.workspaceId) || 0));
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, randomToken(12) + TYPES[mime].ext);
  await fs.promises.writeFile(file, clean);
  const row = await db.one(`insert into support_attachments(thread_id, workspace_id, uploader_user_id, uploader_type, path, mime, size_bytes, width, height, name)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`, [who.threadId || null, who.workspaceId || null, who.userId || null, who.type, file, mime, clean.length, dim.width || null, dim.height || null, name]);
  return row;
}

const aiReadable = (a) => Number(a.size_bytes) <= AI_MAX && (!a.width || (a.width <= AI_MAX_SIDE && a.height <= AI_MAX_SIDE));
/** What the browser may see about an attachment (never the path). */
function publicRow(a, base) {
  return { id: Number(a.id), url: `${base}/${a.id}`, mime: a.mime, width: a.width, height: a.height, size: Number(a.size_bytes), name: a.name, ai_readable: aiReadable(a) };
}

/**
 * Claim uploads for a new message. Only unsent uploads of this person (and, for staff, of this conversation).
 * Throws a friendly 400 for anything else. Returns the rows.
 */
async function check(ids, { userId, type, threadId }) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if ((Array.isArray(ids) ? ids.length : 0) > MAX_PER_MESSAGE || list.length > MAX_PER_MESSAGE) throw badRequest(`Send up to ${MAX_PER_MESSAGE} images in one message.`);
  if (!list.length) return [];
  const rows = await db.many(`select * from support_attachments where id = any($1::bigint[]) and message_id is null and uploader_user_id = $2 and uploader_type = $3
    ${type === 'staff' ? 'and thread_id = $4' : ''} order by id`, type === 'staff' ? [list, userId, type, threadId] : [list, userId, type]);
  if (rows.length !== list.length) throw badRequest('One of the images is no longer available. Attach it again.');
  return rows;
}
async function attach(rows, { messageId, threadId }) {
  if (!rows.length) return;
  await db.query('update support_attachments set message_id = $2, thread_id = $3 where id = any($1::bigint[]) and message_id is null', [rows.map((r) => r.id), messageId, threadId]);
}

/** Attachments of these messages, grouped by message id. */
async function forMessages(messageIds) {
  const ids = [...new Set(messageIds.map(Number).filter(Boolean))];
  const map = new Map();
  if (!ids.length) return map;
  const rows = await db.many('select * from support_attachments where message_id = any($1::bigint[]) order by id', [ids]);
  for (const r of rows) { const k = Number(r.message_id); if (!map.has(k)) map.set(k, []); map.get(k).push(r); }
  return map;
}

/** May this customer see this image? Their own unsent upload, or an image in their own conversation (not an internal note). */
async function forCustomer(id, userId) {
  return db.one(`select a.* from support_attachments a
      left join support_messages m on m.id = a.message_id
      left join support_threads t on t.id = coalesce(m.thread_id, a.thread_id)
    where a.id = $1 and (
      (a.message_id is null and a.uploader_type = 'user' and a.uploader_user_id = $2)
      or (m.id is not null and not m.internal and m.visible_at <= now() and t.user_id = $2))`, [id, userId]);
}

async function stream(ctx, a) {
  if (!a || !inside(a.path) || !IMAGE_TYPES.includes(a.mime)) return false;
  let st;
  try { st = await fs.promises.stat(a.path); } catch { return false; }
  ctx.res.writeHead(200, { 'Content-Type': a.mime, 'Content-Length': st.size, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename="image-${a.id}${path.extname(a.path)}"`, 'Content-Security-Policy': "default-src 'none'" });
  // pipeline closes the file when the browser goes away and catches read errors (ENG-1: .pipe() leaked a descriptor).
  require('../app').sendFile(a.path, ctx.res);
  ctx.sent = true;
  return true;
}

/** Image parts for the model (neutral format, see llm.js), or a note when it is too big to send. */
async function modelPart(a) {
  if (!aiReadable(a) || !inside(a.path)) return { type: 'text', text: `[The customer attached an image the assistant cannot open (${(Number(a.size_bytes) / 1048576).toFixed(1)} MB${a.width ? `, ${a.width}×${a.height} px` : ''}). Ask for a smaller screenshot, or a cropped one; the team can still see it.]` };
  try { return { type: 'image', mime: a.mime, data: (await fs.promises.readFile(a.path)).toString('base64') }; } catch { return { type: 'text', text: '[An image the customer sent could not be opened.]' }; }
}

/** Copy an attachment onto another message (e.g. the internal handoff note), as a separate file. */
async function copyTo(a, { messageId, threadId }) {
  if (!inside(a.path)) return null;
  const file = path.join(path.dirname(a.path), randomToken(12) + path.extname(a.path));
  await fs.promises.copyFile(a.path, file);
  return db.one(`insert into support_attachments(thread_id, message_id, workspace_id, uploader_user_id, uploader_type, path, mime, size_bytes, width, height, name, payment_id)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`, [threadId, messageId, a.workspace_id, a.uploader_user_id, a.uploader_type, file, a.mime, a.size_bytes, a.width, a.height, a.name, a.payment_id || null]);
}

/**
 * The customer's screenshot becomes the proof of THEIR OWN pending manual top-up, if it has none yet and the method
 * takes screenshots. Nothing else about the payment changes (Finance still approves or rejects it).
 */
async function linkAsProof(a, { reference, workspaceId }) {
  if (!a || !inside(a.path) || a.uploader_type !== 'user' || Number(a.workspace_id) !== Number(workspaceId)) return false;
  const p = await db.one(`select p.*, pm.proof_image from payments p left join payment_methods pm on pm.key = p.method_key
    where p.reference = $1 and p.workspace_id = $2 and p.status = 'pending' and p.provider in ('manual', 'manual_crypto')`, [reference, workspaceId]);
  if (!p || p.proof_path || p.proof_image === 'off') return false;
  const dir = path.join(config.uploadDir, 'proofs', String(Number(workspaceId)));
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, randomToken(12) + path.extname(a.path));
  await fs.promises.copyFile(a.path, file);
  const row = await db.one("update payments set proof_path = $2, proof_mime = $3 where id = $1 and status = 'pending' and proof_path is null returning id", [p.id, file, a.mime]);
  if (!row) { await fs.promises.unlink(file).catch(() => {}); return false; }
  await db.query('update support_attachments set payment_id = $2 where id = $1', [a.id, p.id]);
  return true;
}

async function removeRows(rows) {
  for (const r of rows) if (inside(r.path)) await fs.promises.unlink(r.path).catch(() => {});
  if (rows.length) await db.query('delete from support_attachments where id = any($1::bigint[])', [rows.map((r) => r.id)]);
  return rows.length;
}
/** Uploads never sent in a message (cleanup worker). */
async function removeUnsent(hours = 24, limit = 500) {
  return removeRows(await db.many('select id, path from support_attachments where message_id is null and created_at < now() - make_interval(hours => $1) order by id limit $2', [hours, limit]));
}
/** Files of these workspaces' conversations (account deletion, data purge). Call before the rows are deleted. */
async function removeForWorkspaces(ids) {
  if (!ids.length) return 0;
  return removeRows(await db.many('select id, path from support_attachments where workspace_id = any($1::bigint[])', [ids]));
}

module.exports = {
  MAX, MAX_PER_MESSAGE, AI_MAX, MAX_AI_IMAGES, IMAGE_TYPES, save, check, attach, forMessages, forCustomer, stream, publicRow, aiReadable,
  modelPart, copyTo, linkAsProof, removeUnsent, removeForWorkspaces, strip, dimensions,
};

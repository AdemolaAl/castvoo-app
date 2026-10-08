'use strict';
/*
 * ENG-23 / N-1: is the uploads folder the real, persistent volume?
 *
 * A marker file (.castvoo-volume) is written on the volume the first time Castvoo starts on it. On every start:
 *   - marker there                                  -> fine.
 *   - marker missing, folder already holds files    -> an existing volume from before the marker existed (upgrade):
 *                                                      write the marker, log a warning, start.
 *   - marker missing, folder empty, database lists
 *     no saved files                                -> a fresh volume: write the marker, start.
 *   - marker missing, folder empty, database lists
 *     saved files                                   -> the volume was replaced or is not attached: refuse to start in
 *                                                      production (unless ALLOW_NO_VOLUME=true), so proofs are never
 *                                                      silently missing.
 * index.js runs this BEFORE the migrations, so a refused start never leaves a half-upgraded database behind.
 * The database may still be on an old schema (or empty) at that point: each count is tried on its own and a missing
 * table or column counts as 0.
 */

const fs = require('node:fs');
const path = require('node:path');

const MARKER = '.castvoo-volume';

/** True when `dir` (or a sub-folder) holds at least one regular file, ignoring dot-files in the top folder. */
function hasFiles(dir) {
  const stack = [{ d: dir, top: true }];
  while (stack.length) {
    const { d, top } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (top && e.name.startsWith('.')) continue; // .castvoo-volume, .write-test, lost+found-like dot entries
      if (e.isFile()) return true;
      if (e.isDirectory()) stack.push({ d: path.join(d, e.name), top: false });
    }
  }
  return false;
}

/** How many uploaded files the database points at (media, payment proofs, support chat images). */
async function countStored(one) {
  const qs = [
    'select count(*)::int as n from media',
    'select count(*)::int as n from payments where proof_path is not null',
    'select count(*)::int as n from support_attachments',
  ];
  let n = 0;
  for (const q of qs) {
    try { const r = await one(q); n += Number((r && r.n) || 0); } catch (e) {
      // 42P01 undefined table, 42703 undefined column: an older schema, nothing stored there yet.
      // Anything else (database down...) is a real error: do not guess, and never write the marker on a guess.
      if (e && (e.code === '42P01' || e.code === '42703')) continue;
      throw e;
    }
  }
  return n;
}

/**
 * Returns { ok: true, action } or { ok: false, problem }.
 * action: 'marker_present' | 'upgrade_existing_files' | 'fresh'.
 */
async function checkVolume({ uploadDir, isProd, allowNoVolume, one, log }) {
  const marker = path.join(uploadDir, MARKER);
  if (fs.existsSync(marker)) return { ok: true, action: 'marker_present' };
  const write = () => fs.writeFileSync(marker, new Date().toISOString());
  if (hasFiles(uploadDir)) {
    write();
    if (log) log.warn('uploads volume marker was missing; existing files found, marker written', { uploadDir });
    return { ok: true, action: 'upgrade_existing_files' };
  }
  const stored = await countStored(one);
  if (stored > 0 && isProd && !allowNoVolume) {
    return {
      ok: false,
      problem: `The uploads folder (${uploadDir}) is empty but the database lists ${stored} saved files (photos, payment proofs or support images): the volume was replaced or is not attached. Re-attach the volume at /data (or set ALLOW_NO_VOLUME=true to accept the missing files).`,
    };
  }
  if (stored > 0 && log) log.warn('uploads folder is empty but the database lists saved files; starting anyway', { uploadDir, stored });
  write();
  return { ok: true, action: 'fresh' };
}

module.exports = { checkVolume, hasFiles, countStored, MARKER };

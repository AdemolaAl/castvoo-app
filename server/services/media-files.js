'use strict';
/*
 * Deleting uploaded photos and videos from disk.
 * Call this BEFORE deleting the media rows (it reads their paths), when a workspace's data
 * is purged after the retention period or an account is deleted. Without it the files stayed
 * on the volume forever after the rows were gone.
 */

const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const config = require('../config');

async function removeFiles(workspaceIds) {
  if (!workspaceIds.length) return 0;
  const rows = await db.many('select path from media where workspace_id = any($1::bigint[])', [workspaceIds]);
  const root = path.resolve(config.uploadDir) + path.sep;
  let n = 0;
  for (const r of rows) {
    const p = path.resolve(r.path);
    if (!p.startsWith(root)) continue; // never delete anything outside the upload folder
    try { await fs.promises.unlink(p); n++; } catch { /* already gone */ }
  }
  return n;
}

/**
 * Uploads that no message, draft or follow-up uses, older than `days`: delete the file and the row.
 * (Uploading and then not sending used to keep the file forever.) Returns how many were removed.
 */
async function removeUnused(days = 3, limit = 500) {
  const rows = await db.many(`select m.id, m.path from media m where m.created_at < now() - make_interval(days => $1)
      and not exists (select 1 from broadcasts b where b.media_id = m.id)
      and not exists (select 1 from sequence_steps s where s.media_id = m.id)
    order by m.id limit $2`, [days, limit]);
  const root = path.resolve(config.uploadDir) + path.sep;
  for (const r of rows) {
    const p = path.resolve(r.path);
    if (p.startsWith(root)) await fs.promises.unlink(p).catch(() => {});
  }
  if (rows.length) await db.query('delete from media where id = any($1::bigint[])', [rows.map((r) => r.id)]);
  return rows.length;
}

module.exports = { removeFiles, removeUnused };

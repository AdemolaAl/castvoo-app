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

module.exports = { removeFiles };

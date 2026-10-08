'use strict';
/*
 * N-1: the uploads-volume check at start-up (server/lib/volume-check.js, called from server/index.js before the
 * migrations). These tests start the real `server/index.js` as a child process in production mode, on Railway
 * with a volume, against a throwaway PostgreSQL.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startPgServer } = require('../helpers/pgserver');
const { createPool } = require('../../server/lib/pg');

const ROOT = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

let pg, tmp, dbSeq = 0;

before(async () => {
  pg = await startPgServer();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-vol-'));
});
after(async () => {
  if (pg) await pg.stop();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

async function newDb() {
  const name = `cv_vol_${++dbSeq}`;
  const admin = createPool({ connectionString: pg.url, max: 1 });
  await admin.query(`create database ${name}`);
  await admin.end();
  return pg.url.replace('/postgres?', `/${name}?`);
}

async function withDb(url, fn) {
  const p = createPool({ connectionString: url, max: 1 });
  try { return await fn(p); } finally { await p.end(); }
}

/** A fresh "volume" folder (the Railway mount) with uploads/ inside. */
function newVolume() {
  const vol = fs.mkdtempSync(path.join(tmp, 'vol-'));
  const uploads = path.join(vol, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });
  return { vol, uploads, marker: path.join(uploads, '.castvoo-volume') };
}

/** Start server/index.js; resolves when /health answers (then stops it) or when the process exits. */
async function start(env) {
  const port = await freePort();
  const out = [];
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      NODE_ENV: 'production', RAILWAY_ENVIRONMENT: 'production', APP_URL: 'https://castvoo.example',
      APP_SECRET: 'a'.repeat(64), PORT: String(port), RUN_WORKERS: 'false', QUIET_LOGS: '',
      ...env,
    },
  });
  child.stdout.on('data', (d) => out.push(d.toString()));
  child.stderr.on('data', (d) => out.push(d.toString()));
  let exitCode = null;
  const exited = new Promise((r) => child.on('exit', (code) => { exitCode = code; r(); }));
  for (let i = 0; i < 200 && exitCode === null; i++) {
    await sleep(100);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) {
        child.kill('SIGTERM');
        await exited;
        return { healthy: true, log: out.join('') };
      }
    } catch { /* not up yet */ }
  }
  if (exitCode === null) { child.kill('SIGKILL'); await exited; return { healthy: false, timeout: true, log: out.join('') }; }
  return { healthy: false, code: exitCode, log: out.join('') };
}

/** One media row in a migrated database (a user, a workspace, the row). */
async function addMedia(url, filePath) {
  await withDb(url, async (p) => {
    const tag = Math.random().toString(36).slice(2, 10);
    const u = (await p.query(`insert into users(email, name, ref_code) values ($1, 'Vol', $2) returning id`, [`${tag}@x.com`, tag])).rows[0];
    const w = (await p.query(`insert into workspaces(name, owner_user_id, plan_code) values ('W', $1, 'free') returning id`, [u.id])).rows[0];
    await p.query(`insert into media(workspace_id, kind, filename, mime, size_bytes, path) values ($1,'photo','a.jpg','image/jpeg',3,$2)`, [w.id, filePath]);
  });
}

async function tableExists(url, name) {
  return withDb(url, async (p) => (await p.query('select to_regclass($1) as t', [name])).rows[0].t !== null);
}

describe('uploads volume marker at start-up (N-1)', () => {
  it('fresh database and empty volume: starts and writes the marker', async () => {
    const url = await newDb();
    const v = newVolume();
    const r = await start({ DATABASE_URL: url, UPLOAD_DIR: v.uploads, RAILWAY_VOLUME_MOUNT_PATH: v.vol });
    assert.equal(r.healthy, true, r.log);
    assert.ok(fs.existsSync(v.marker), 'marker written');
    assert.doesNotMatch(r.log, /setup problem/);
  });

  it('upgrade: existing volume with files but no marker starts, writes the marker and logs a warning', async () => {
    const url = await newDb();
    const v = newVolume();
    // First start makes the schema (and a marker); then pretend this volume came from a version without markers.
    assert.equal((await start({ DATABASE_URL: url, UPLOAD_DIR: v.uploads, RAILWAY_VOLUME_MOUNT_PATH: v.vol })).healthy, true);
    fs.unlinkSync(v.marker);
    fs.mkdirSync(path.join(v.uploads, '7'), { recursive: true });
    const photo = path.join(v.uploads, '7', 'old.jpg');
    fs.writeFileSync(photo, 'jpg');
    await addMedia(url, photo);
    const r = await start({ DATABASE_URL: url, UPLOAD_DIR: v.uploads, RAILWAY_VOLUME_MOUNT_PATH: v.vol });
    assert.equal(r.healthy, true, r.log);
    assert.ok(fs.existsSync(v.marker), 'marker written');
    assert.match(r.log, /marker was missing; existing files found/);
    assert.ok(fs.existsSync(photo), 'existing file untouched');
  });

  it('upgrade with only payment proofs on the volume also starts', async () => {
    const url = await newDb();
    const v = newVolume();
    fs.mkdirSync(path.join(v.uploads, 'proofs', '3'), { recursive: true });
    fs.writeFileSync(path.join(v.uploads, 'proofs', '3', 'p.png'), 'png');
    const r = await start({ DATABASE_URL: url, UPLOAD_DIR: v.uploads, RAILWAY_VOLUME_MOUNT_PATH: v.vol });
    assert.equal(r.healthy, true, r.log);
    assert.ok(fs.existsSync(v.marker));
  });

  it('database lists saved files but the volume is empty: refuses with a clear message, before any migration', async () => {
    const url = await newDb();
    // An older schema: just a media table with one row (no schema_migrations yet, no payments.proof_path).
    await withDb(url, async (p) => {
      await p.query('create table media (id bigserial primary key, path text not null)');
      await p.query(`insert into media(path) values ('/data/uploads/1/a.jpg')`);
    });
    const v = newVolume();
    const r = await start({ DATABASE_URL: url, UPLOAD_DIR: v.uploads, RAILWAY_VOLUME_MOUNT_PATH: v.vol });
    assert.equal(r.healthy, false);
    assert.equal(r.code, 1, r.log);
    assert.match(r.log, /setup problem/);
    assert.match(r.log, /is empty but the database lists 1 saved files/);
    assert.match(r.log, /Re-attach the volume/);
    assert.equal(fs.existsSync(v.marker), false, 'no marker written on a refused start');
    assert.equal(await tableExists(url, 'schema_migrations'), false, 'migrations did not run');
  });

  it('ALLOW_NO_VOLUME=true on a real (migrated) database with a missing volume starts', async () => {
    const url = await newDb();
    const v = newVolume();
    assert.equal((await start({ DATABASE_URL: url, UPLOAD_DIR: v.uploads, RAILWAY_VOLUME_MOUNT_PATH: v.vol })).healthy, true);
    await addMedia(url, '/gone/a.jpg');
    const empty = newVolume();
    const refused = await start({ DATABASE_URL: url, UPLOAD_DIR: empty.uploads, RAILWAY_VOLUME_MOUNT_PATH: empty.vol });
    assert.equal(refused.code, 1, refused.log);
    assert.match(refused.log, /is empty but the database lists 1 saved files/);
    assert.equal(fs.existsSync(empty.marker), false);
    const ok = await start({ DATABASE_URL: url, UPLOAD_DIR: empty.uploads, RAILWAY_VOLUME_MOUNT_PATH: empty.vol, ALLOW_NO_VOLUME: 'true' });
    assert.equal(ok.healthy, true, ok.log);
    assert.match(ok.log, /starting anyway/);
    assert.ok(fs.existsSync(empty.marker));
  });
});

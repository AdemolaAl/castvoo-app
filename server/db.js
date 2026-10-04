'use strict';
/*
 * The database connection, migrations and a few helpers.
 *
 *   const db = require('./db');
 *   const rows = await db.many('select * from plans where active = $1', [true]);
 *   const plan = await db.one('select * from plans where code = $1', ['growth']);   // null if none
 *   await db.query('update ...', [...]);                                             // { rows, rowCount }
 *   await db.tx(async (c) => { await c.query(...); });                               // transaction
 *
 * Migrations: put a new file in server/migrations named 00X_what_it_does.sql.
 * It runs once, automatically, the next time the server starts.
 */

const fs = require('node:fs');
const path = require('node:path');
const { createPool } = require('./lib/pg');
const config = require('./config');
const log = require('./lib/log');

let pool = null;

function init(url = config.databaseUrl) {
  if (pool) return pool;
  if (!url) throw new Error('DATABASE_URL is not set.');
  pool = createPool({ connectionString: url, max: config.dbPoolMax, application_name: 'castvoo', statementTimeoutMs: 30000 });
  pool.on('error', (e) => log.warn('db idle connection error', { err: e }));
  return pool;
}
const p = () => { if (!pool) init(); return pool; };

const query = (text, params) => p().query(text, params);
const many = async (text, params) => (await p().query(text, params)).rows;
const one = async (text, params) => (await p().query(text, params)).rows[0] || null;
const tx = (fn) => p().tx(fn);
const end = async () => { if (pool) { const x = pool; pool = null; await x.end(); } };

async function migrate() {
  const dir = path.join(__dirname, 'migrations');
  await p().simple('create table if not exists schema_migrations (name text primary key, ran_at timestamptz not null default now())');
  // Only one server instance migrates at a time.
  return tx(async (c) => {
    await c.query('select pg_advisory_xact_lock(424242)');
    const done = new Set((await c.query('select name from schema_migrations')).rows.map((r) => r.name));
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const ran = [];
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      log.info('running migration', { file: f });
      for (const stmt of splitSql(sql)) await c.query(stmt);
      await c.query('insert into schema_migrations(name) values ($1)', [f]);
      ran.push(f);
    }
    return ran;
  });
}

/** Split a .sql file into statements (handles quotes, comments and $$ blocks). */
function splitSql(sql) {
  const out = [];
  let cur = '', i = 0, inS = false, inDollar = null;
  while (i < sql.length) {
    const ch = sql[i];
    if (!inS && !inDollar && ch === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
    if (!inS && ch === '$') {
      const m = /^\$[a-zA-Z_]*\$/.exec(sql.slice(i));
      if (m) {
        if (!inDollar) inDollar = m[0]; else if (inDollar === m[0]) inDollar = null;
        cur += m[0]; i += m[0].length; continue;
      }
    }
    if (!inDollar && ch === "'") inS = !inS;
    if (!inS && !inDollar && ch === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

module.exports = { init, query, many, one, tx, end, migrate, splitSql, pool: () => p() };

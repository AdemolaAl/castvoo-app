'use strict';
/*
 * Run Castvoo on your computer with a throwaway database:
 *   npm run dev
 * Needs PostgreSQL 16 installed (set PG_BIN if it isn't in /usr/lib/postgresql/16/bin).
 * If you already have a database, skip this and run:  DATABASE_URL=... APP_SECRET=... npm start
 * Emails are printed in the terminal instead of being sent.
 */
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { startPgServer } = require('../test/helpers/pgserver');

(async () => {
  const pg = await startPgServer({ ssl: false });
  console.log('Database ready:', pg.url.replace(/:[^:@]+@/, ':***@'));
  const env = {
    ...process.env,
    DATABASE_URL: pg.url,
    APP_SECRET: process.env.APP_SECRET || crypto.randomBytes(32).toString('hex'),
    APP_URL: process.env.APP_URL || 'http://localhost:3000',
    OWNER_EMAIL: process.env.OWNER_EMAIL || 'owner@example.com',
    PORT: process.env.PORT || '3000',
  };
  const child = spawn(process.execPath, ['server/index.js'], { env, stdio: 'inherit' });
  const stop = async () => { child.kill('SIGTERM'); await pg.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', async (code) => { await pg.stop(); process.exit(code || 0); });
  console.log(`\nOpen ${env.APP_URL}  (owner login: ${env.OWNER_EMAIL}, the login code is printed below)\n`);
})().catch((e) => { console.error(e); process.exit(1); });

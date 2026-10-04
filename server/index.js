'use strict';
/*
 * Start here. `npm start` runs this file. It:
 *   1. checks the settings,  2. updates the database,  3. starts the website,
 *   4. starts the background workers (sending, follow-ups, billing, emails).
 */

const config = require('./config');
const log = require('./lib/log');
const db = require('./db');

async function main() {
  const problems = config.problems();
  if (problems.length) {
    for (const p of problems) log.error('setup problem', { problem: p });
    process.exit(1);
  }
  // Uploads folder must be writable (on Railway: a volume mounted at /data).
  try {
    const fs = require('node:fs');
    fs.mkdirSync(config.uploadDir, { recursive: true });
    const probe = require('node:path').join(config.uploadDir, '.write-test');
    fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
  } catch (e) {
    log.error('setup problem', { problem: `Cannot save files in UPLOAD_DIR (${config.uploadDir}): ${e.code || e.message}. Mount a Railway volume at /data.` });
    process.exit(1);
  }
  db.init();
  const ran = await db.migrate();
  if (ran.length) log.info('migrations applied', { ran });
  await require('./seed').run();

  const { createServer } = require('./app');
  const server = createServer();
  await new Promise((resolve) => server.listen(config.port, resolve));
  log.info('Castvoo is running', { url: config.appUrl, port: config.port, integrations: config.integrations() });

  const workers = config.runWorkers ? require('./workers').start() : null;
  if (config.telegram.botToken) require('./services/platform-bot').ensureWebhook().catch((e) => log.warn('platform webhook setup failed', { err: e }));

  let stopping = false;
  async function stop(sig) {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { sig });
    server.close();
    if (workers) await workers.stop();
    setTimeout(() => process.exit(0), 8000).unref();
    await db.end().catch(() => {});
    process.exit(0);
  }
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

process.on('unhandledRejection', (e) => log.error('unhandled promise rejection', { err: e }));

main().catch((e) => { log.error('failed to start', { err: e }); process.exit(1); });

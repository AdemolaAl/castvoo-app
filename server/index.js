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
  // ENG-23: in production on Railway the uploads must live on a volume (the image's own /data/uploads is wiped by deploys).
  if (config.isProd && process.env.RAILWAY_ENVIRONMENT && !config.allowNoVolume) {
    const path = require('node:path');
    const mount = config.volumeMount ? path.resolve(config.volumeMount) : '';
    const up = path.resolve(config.uploadDir);
    if (!mount || !(up === mount || up.startsWith(mount + path.sep))) {
      log.error('setup problem', { problem: `UPLOAD_DIR (${up}) is not on a Railway volume${mount ? ` (the volume is mounted at ${mount})` : ' (no volume attached)'}. Attach a volume at /data, or set ALLOW_NO_VOLUME=true to accept losing uploads on every deploy.` });
      process.exit(1);
    }
  }
  db.init();
  // ENG-23 / N-1: check the uploads volume BEFORE the migrations, so a refused start never leaves a migrated database
  // behind. An existing volume without the marker (older versions never wrote it) is accepted when it holds files.
  {
    const v = await require('./lib/volume-check').checkVolume({
      uploadDir: config.uploadDir, isProd: config.isProd, allowNoVolume: config.allowNoVolume, one: db.one, log,
    });
    if (!v.ok) {
      log.error('setup problem', { problem: v.problem });
      await db.end().catch(() => {});
      process.exit(1);
    }
  }
  const ran = await db.migrate();
  if (ran.length) log.info('migrations applied', { ran });
  await require('./seed').run();
  // IP-to-country file on the volume (sign-up country pre-select, Active devices, new-login alerts). Optional.
  require('./lib/geoip').init();
  // The Guides page videos must be deployed with the app (they are large, so a partial upload can leave them out).
  require('./lib/guide-videos').warnIfMissing(log);

  const { createServer } = require('./app');
  const server = createServer();
  await new Promise((resolve) => server.listen(config.port, resolve));
  log.info('Castvoo is running', { url: config.appUrl, port: config.port, integrations: config.integrations() });

  const workers = config.runWorkers ? require('./workers').start() : null;
  // @CastvooBot: set the webhook, then check it (and the bot's real username). The workers check again every 10 minutes.
  if (config.telegram.botToken) {
    const pb = require('./services/platform-bot');
    pb.ensureWebhook().catch((e) => log.warn('platform webhook setup failed', { err: e, description: e.description })).then(() => pb.selfHeal());
  }

  let stopping = false;
  async function stop(sig) {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { sig });
    // ENG-11: arm the safety exit first (Railway kills the process after drainingSeconds: 15), then stop the work.
    setTimeout(() => process.exit(0), 12000).unref();
    server.close();
    if (workers) await Promise.race([workers.stop(), new Promise((r) => setTimeout(r, 8000))]);
    await require('./services/bot-updates').idle(3000).catch(() => {}); // join requests already acknowledged to Telegram
    await db.end().catch(() => {});
    process.exit(0);
  }
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

process.on('unhandledRejection', (e) => log.error('unhandled promise rejection', { err: e }));

main().catch((e) => { log.error('failed to start', { err: e }); process.exit(1); });

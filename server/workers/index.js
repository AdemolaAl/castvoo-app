'use strict';
/*
 * Starts the background loops. Each loop waits for the previous run to finish
 * before starting again, so slow runs never pile up.
 *   sender        every 0.5 s   sends queued messages
 *   broadcasts    every 5 s     starts scheduled sends, closes finished ones
 *   drips         every 10 s    queues follow-up steps that are due (short waits fire on time: workers/soon.js)
 *   outbox        every 10 s    sends events to VooSquare
 *   support AI    every 1 s     AI support replies (services/support-ai.js)
 *   billing       every 5 min   trials, renewals, reminders
 *   sales emails  every 15 min  trial follow-up emails
 *   cleanup       every hour    tidy old rows, refresh channel member counts
 *   blog          every 30 s    publishes scheduled blog posts when their time comes
 *   geoip         every 6 h     downloads the new monthly IP-to-country file (GEOIP_AUTO_DOWNLOAD, lib/geoip.js)
 *   platform-bot  every 10 min  checks @CastvooBot's webhook (getWebhookInfo) and puts it back if another program took it
 */

const log = require('../lib/log');
const sender = require('./sender');
const jobs = require('./jobs');
const soon = require('./soon');
const voosquare = require('../services/voosquare');

function loop(name, fn, everyMs, firstDelayMs = 1000) {
  let timer = null, stopped = false, running = null;
  const run = async () => {
    if (stopped) return;
    running = (async () => { try { await fn(); } catch (e) { log.error('worker error', { worker: name, err: e }); } })();
    await running;
    running = null;
    if (!stopped) timer = setTimeout(run, everyMs);
  };
  timer = setTimeout(run, firstDelayMs);
  return { stop: async () => { stopped = true; clearTimeout(timer); if (running) await running; } };
}

function start() {
  const loops = [
    loop('sender', sender.tick, 500, 500),
    loop('broadcasts', jobs.broadcastsTick, 5000),
    loop('drips', jobs.dripsTick, 10000),
    loop('outbox', voosquare.flush, 10000),
    // Claims due conversations and answers several at once in the background (does not wait for the answers).
    loop('support-ai', () => require('../services/support-ai').tick({ wait: false }), 1000, 1500),
    loop('billing', jobs.billingTick, 5 * 60000, 20000),
    loop('sales', jobs.salesTick, 15 * 60000, 60000),
    loop('cleanup', jobs.cleanupTick, 60 * 60000, 120000),
    loop('blog', () => require('../services/blog').publishDue({ force: true }), 30000, 5000),
    loop('geoip', jobs.geoipTick, 6 * 3600000, 90000),
    loop('platform-bot', () => require('../services/platform-bot').selfHeal(), 10 * 60000, 10 * 60000),
  ];
  // Steps due in the next minute ("Wait 2 seconds") fire at their time instead of the next 10-second poll.
  soon.start(jobs.dripsTick);
  log.info('workers started');
  // Support-AI turns in progress stop at their next round and go back to the queue for the next instance (ENG-11).
  return { stop: async () => { await soon.stop(); await Promise.all([...loops.map((l) => l.stop()), require('../services/support-ai').stop()]); await sender.stop(); } };
}

module.exports = { start };

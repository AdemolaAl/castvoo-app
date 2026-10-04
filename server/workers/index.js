'use strict';
/*
 * Starts the background loops. Each loop waits for the previous run to finish
 * before starting again, so slow runs never pile up.
 *   sender        every 0.5 s   sends queued messages
 *   broadcasts    every 5 s     starts scheduled sends, closes finished ones
 *   drips         every 10 s    queues follow-up steps that are due
 *   outbox        every 10 s    sends events to VooSquare
 *   billing       every 5 min   trials, renewals, reminders
 *   sales emails  every 15 min  trial follow-up emails
 *   cleanup       every hour    tidy old rows, refresh channel member counts
 */

const log = require('../lib/log');
const sender = require('./sender');
const jobs = require('./jobs');
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
    loop('billing', jobs.billingTick, 5 * 60000, 20000),
    loop('sales', jobs.salesTick, 15 * 60000, 60000),
    loop('cleanup', jobs.cleanupTick, 60 * 60000, 120000),
  ];
  log.info('workers started');
  return { stop: async () => { await Promise.all(loops.map((l) => l.stop())); await sender.stop(); } };
}

module.exports = { start };

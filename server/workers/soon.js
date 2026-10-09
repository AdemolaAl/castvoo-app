'use strict';
/*
 * The fast path for short waits ("Wait 2 seconds", "Send right away").
 *
 * The follow-ups job (jobs.dripsTick) polls every 10 s. A step due sooner than that would wait for the next poll, so
 * whoever sets a due time in the next 60 s calls soon.at(dueAt): one in-process timer fires the job at the earliest
 * of those times. The job itself claims the due runs with FOR UPDATE SKIP LOCKED, so a timer on two servers (or a
 * timer and the poll at once) never sends a step twice; the 10-second poll stays as the fallback (a restart, a run
 * made on another server).
 *
 *   soon.start(fn)    fn = the job to run (workers/index.js passes jobs.dripsTick). Until then at() does nothing.
 *   soon.at(date)     run the job at that time (if it is within the next 60 s); earlier calls win.
 *   soon.stop()
 */

const log = require('../lib/log');

const HORIZON_MS = 60000;
const MARGIN_MS = 15; // fire just after the due time, so the database's now() has reached it
let job = null;
let timer = null;
let timerAt = 0;
let running = null;
let again = 0; // a time asked for while the job was running

function fire() {
  timer = null; timerAt = 0;
  if (!job) return;
  if (running) { again = again ? Math.min(again, Date.now()) : Date.now(); return; }
  running = (async () => { try { await job(); } catch (e) { log.error('worker error', { worker: 'drips-soon', err: e }); } })();
  running.finally(() => {
    running = null;
    if (again) { const t = again; again = 0; at(t); }
  });
}

/** Run the job at `when` (Date, ms or ISO string). Times in the past mean "now". Ignored beyond 60 s (the poll covers those). */
function at(when) {
  if (!job) return;
  const t = Math.max(Date.now(), when instanceof Date ? when.getTime() : typeof when === 'number' ? when : new Date(when).getTime());
  if (!Number.isFinite(t) || t - Date.now() > HORIZON_MS) return;
  if (running) { again = again ? Math.min(again, t) : t; return; }
  if (timer && timerAt <= t) return;
  if (timer) clearTimeout(timer);
  timerAt = t;
  timer = setTimeout(fire, Math.max(0, t - Date.now() + MARGIN_MS));
  if (timer.unref) timer.unref();
}

function start(fn) { job = fn; }
async function stop() {
  job = null;
  if (timer) clearTimeout(timer);
  timer = null; timerAt = 0; again = 0;
  if (running) await running.catch(() => {});
}

module.exports = { start, stop, at, HORIZON_MS, active: () => !!job };

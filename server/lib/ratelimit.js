'use strict';
/*
 * Rate limiters.
 *
 *   hit(key, max, perSeconds)              in memory, per server instance. Fine for abuse that costs nothing.
 *   await hitShared(key, max, perSeconds)  in PostgreSQL (table rate_buckets), shared by every instance. Use it for
 *                                          limits that protect money or AI cost: login codes, AI calls, the support
 *                                          chat, the website chat, payment rechecks. Returns { ok, retryAfter }.
 *
 * Keys look like 'login:1.2.3.4'. hitShared uses fixed windows: the bucket is floor(now / perSeconds), so two
 * instances (Railway runs two during every deploy) count into the same row with one atomic upsert.
 * If the database cannot be reached the shared limiter falls back to the in-memory one for that call, so a
 * database hiccup never opens the gate completely and never blocks everyone either.
 *
 *   if (!rl.hit('login:' + ip, 10, 3600)) throw tooMany();
 *   const r = await rl.hitShared('support-min:' + userId, 8, 60); if (!r.ok) throw tooMany(r.retryAfter);
 */
const buckets = new Map();
// Tests call _reset() between cases. Shared counters can't be wiped synchronously, so a reset moves every key into
// a new "generation" (a prefix) and the old rows are simply ignored until they expire.
let gen = 0;

function hit(key, max, perSeconds) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset <= now) { b = { count: 0, reset: now + perSeconds * 1000 }; buckets.set(key, b); }
  b.count++;
  return b.count <= max;
}
function retryAfter(key) { const b = buckets.get(key); return b ? Math.max(1, Math.ceil((b.reset - Date.now()) / 1000)) : 1; }

let lastSweep = 0;
async function hitShared(key, max, perSeconds) {
  const per = Math.max(1, Math.floor(perSeconds));
  const nowSec = Date.now() / 1000;
  const win = Math.floor(nowSec / per);
  const retry = Math.max(1, Math.ceil((win + 1) * per - nowSec));
  const k = (gen ? gen + ':' : '') + String(key).slice(0, 200);
  try {
    const db = require('../db');
    const r = await db.one(`insert into rate_buckets(key, win, n, expires_at) values ($1, $2, 1, to_timestamp($3))
      on conflict (key, win) do update set n = rate_buckets.n + 1 returning n`, [k, win, (win + 1) * per]);
    // Old windows are removed now and then (at most once a minute per instance).
    if (Date.now() - lastSweep > 60000) { lastSweep = Date.now(); db.query('delete from rate_buckets where expires_at < now()').catch(() => {}); }
    return { ok: Number(r.n) <= max, retryAfter: retry, count: Number(r.n) };
  } catch {
    const ok = hit('fallback:' + k, max, per);
    return { ok, retryAfter: retryAfter('fallback:' + k), count: null };
  }
}

/** How many hits a shared key has in the current window (without counting one). */
async function peekShared(key, perSeconds) {
  const per = Math.max(1, Math.floor(perSeconds));
  const win = Math.floor(Date.now() / 1000 / per);
  const k = (gen ? gen + ':' : '') + String(key).slice(0, 200);
  try { const r = await require('../db').one('select n from rate_buckets where key = $1 and win = $2', [k, win]); return r ? Number(r.n) : 0; } catch { return 0; }
}

// Clean up old in-memory buckets every minute so memory stays flat.
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k); }, 60000).unref();

module.exports = { hit, retryAfter, hitShared, peekShared, _reset: () => { buckets.clear(); gen++; } };

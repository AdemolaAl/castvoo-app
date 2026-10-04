'use strict';
/*
 * In-memory rate limiter (per server instance). Good enough to stop abuse of
 * login codes and AI calls. Keys look like 'login:1.2.3.4'.
 *   if (!hit('login:' + ip, 10, 3600)) throw tooMany();
 */
const buckets = new Map();

function hit(key, max, perSeconds) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset <= now) { b = { count: 0, reset: now + perSeconds * 1000 }; buckets.set(key, b); }
  b.count++;
  return b.count <= max;
}
function retryAfter(key) { const b = buckets.get(key); return b ? Math.max(1, Math.ceil((b.reset - Date.now()) / 1000)) : 1; }

// Clean up old buckets every minute so memory stays flat.
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k); }, 60000).unref();

module.exports = { hit, retryAfter, _reset: () => buckets.clear() };

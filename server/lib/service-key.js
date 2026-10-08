'use strict';
/*
 * Service keys for server-to-server calls from VooSquare (routes with { auth: 'service' }; the router checks them).
 *   VOO_API_KEY      the key Castvoo also sends to VooSquare on outgoing calls; accepted for the support desk and summary
 *   VOO_SERVICE_KEY  an inbound-only key. Routes with { inboundOnly: true } (staff sync, which can grant admin rights)
 *                    accept ONLY this key, so a leak of the outgoing key cannot create staff (SEC-15).
 */
const config = require('../config');
const { safeEqual, httpError } = require('./util');

function requireKey(ctx, { inboundOnly = false } = {}) {
  const h = String(ctx.req.headers.authorization || '');
  const key = h.startsWith('Bearer ') ? h.slice(7) : '';
  const keys = inboundOnly ? [config.voosquare.serviceKey] : [config.voosquare.apiKey, config.voosquare.serviceKey];
  const ok = key && keys.some((k) => k && safeEqual(key, k));
  if (!ok) throw httpError(401, inboundOnly && !config.voosquare.serviceKey ? 'Staff sync needs VOO_SERVICE_KEY on this server.' : 'Bad or missing service key.', 'unauthorized');
}

module.exports = { requireKey };

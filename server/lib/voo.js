'use strict';
/*
 * The one place Castvoo creates the Voo Connect kit (../../voo-connect, copied unchanged from VooSquare's
 * sdk/voo-connect; never edit the kit, copy a new version over it instead).
 *
 *   const voo = require('./lib/voo');
 *   voo.kit()          the kit, or null when Voo Connect is off (VOO_CONNECT=off or no credentials)
 *   voo.K              the kit module (normalizeEvent, EventsClient, verifyHmac, ...)
 *   voo.redirectUri()  <APP_URL>/auth/voosquare/callback (register it exactly in VooSquare)
 *   voo.resShim(ctx)   a tiny `res` for kit handlers that writes cookies into ctx.cookieOut
 *
 * Events are NOT queued in the kit's memory/file outbox: Castvoo keeps them in its own `outbox` table
 * (written in the same database transaction as the payment) and services/voosquare.js hands them to the
 * kit's EventsClient for sending. So nothing is lost on a restart and every server instance shares one queue.
 */

const K = require('../../voo-connect');
const config = require('../config');
const log = require('./log');

let cached = null;
let cachedKey = '';

const redirectUri = () => `${config.appUrl}/auth/voosquare/callback`;
const homeUrl = () => `${config.appUrl}/`;

function kit() {
  const v = config.voosquare;
  if (!config.vooConnectOn() && !config.vooEventsOn()) return null;
  const key = [v.base, v.clientId, v.clientSecret, v.apiKey, v.signalSecret, v.serverBase, config.appUrl].join('|');
  if (cached && cachedKey === key) return cached;
  cached = K.createVooConnect({
    base: v.base,
    serverBase: v.serverBase || undefined,
    clientId: v.clientId,
    clientSecret: v.clientSecret,
    apiKey: v.apiKey,
    signalSecret: v.signalSecret || undefined,
    redirectUri: redirectUri(),
    eventPrefix: 'cv',
    toolName: 'castvoo',
    defaultReturnTo: '/#app',
    // Our own cookies are Secure on https; behind Railway's proxy the socket itself is plain http.
    secureCookies: config.appUrl.startsWith('https://'),
    store: K.memoryStore(), // unused: see the note above
    onError: (e) => log.warn('voo-connect', { err: e.message }),
    onRejected: (ev, error) => log.warn('VooSquare refused an event', { event_id: ev.event_id, error }),
  });
  cachedKey = key;
  return cached;
}

/** A minimal `res` for the kit: Set-Cookie goes into ctx.cookieOut (so our own session cookie is not lost), redirects are captured. */
function resShim(ctx) {
  const headers = {};
  return {
    statusCode: 200,
    headers,
    getHeader(k) { return String(k).toLowerCase() === 'set-cookie' ? ctx.cookieOut.slice() : headers[String(k).toLowerCase()]; },
    setHeader(k, v) {
      if (String(k).toLowerCase() === 'set-cookie') { ctx.cookieOut.length = 0; ctx.cookieOut.push(...[].concat(v)); return; }
      headers[String(k).toLowerCase()] = v;
    },
    end() { this.ended = true; },
  };
}

/** Our hash of a fraud hint (payment fingerprint, paying wallet), or undefined when the kit is off. */
function hashSignal(value) {
  const k = kit();
  if (!k || value === undefined || value === null || value === '') return undefined;
  try { return k.hashSignal(value); } catch { return undefined; }
}

/** Stable event id with the Castvoo prefix: id('pay', 184) → "cv_pay_184". Same as the kit's events.id(). */
function eventId(...parts) {
  const k = kit();
  if (k) return k.events.id(...parts);
  return ['cv', ...parts].join('_').replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 80);
}

module.exports = { K, kit, redirectUri, homeUrl, resShim, hashSignal, eventId, _reset: () => { cached = null; cachedKey = ''; } };

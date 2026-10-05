'use strict';
/*
 * Voo Connect: the drop-in kit that connects a Zedapex tool (Joinvoo, Spyvoo, Vooads, Replyvoo, Castvoo, Landvoo,
 * Gatevoo, Affleego, ...) to VooSquare, the same way in every tool.
 *
 *   Zero dependencies. Node 18 or newer (uses the built-in fetch and crypto). CommonJS here, ESM in index.mjs,
 *   types in index.d.ts. The contract it follows is docs/INTEGRATION.md; the setup sheets are docs/VOO_CONNECT.md.
 *
 *   const { createVooConnect } = require('./voo-connect');
 *   const voo = createVooConnect({ base: process.env.VOO_BASE, clientId: process.env.VOO_CLIENT_ID,
 *     clientSecret: process.env.VOO_CLIENT_SECRET, apiKey: process.env.VOO_API_KEY,
 *     redirectUri: 'https://joinvoo.com/auth/voosquare/callback', eventPrefix: 'jv' });
 *
 * What is inside:
 *   1. Login ("Continue with VooSquare", OAuth 2.0 authorization code): authorizeUrl, startLogin, handleCallback,
 *      exchangeCode, verifyIdToken, userinfo, logoutUrl.
 *   2. Affiliate hand-off: captureAttribution() middleware keeps ref / vclick / coupon from landing URLs in the tool's own
 *      first-party cookie and replays them on /oauth/authorize, so VooSquare can attribute the new Voo ID.
 *   3. Events: voo.events.spend(), refund(), chargeback(), planStarted(), planRenewed(), planCancelled(), walletTopup(),
 *      activity(); batches of at most 100, stable event_id, retries with backoff, resends what VooSquare lists in
 *      `rejected` when it asks for a resend, reports the rest.
 *   4. Support API client: voo.support.send(), voo.support.thread().
 *   5. Calls from VooSquare to the tool: summaryHandler(), supportWebhook(), isFromVooSquare(); plus verifyHmac() for
 *      HMAC-signed webhooks (Gatevoo's X-Gatevoo-Signature).
 *
 * Framework agnostic: every handler is (req, res[, next]) and uses only the plain Node http API, so it works with
 * node:http, Express, Connect, Polka, Fastify's raw req/res and Next.js API routes.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VERSION = '1.1.0';
const MAX_BATCH = 100;
const ATTR_COOKIE = 'voo_attr';
const STATE_COOKIE = 'voo_state';
const ATTR_DAYS = 60;
const STATE_MAX_AGE_SEC = 600;
/* Same shapes VooSquare accepts (a little wider, so the kit never drops something a newer VooSquare would take). */
const ATTR_RX = { ref: /^[A-Za-z0-9_-]{3,24}$/, vclick: /^[A-Za-z0-9_-]{6,40}$/, coupon: /^[A-Za-z0-9_-]{3,24}$/ };
const ATTR_KEYS = ['ref', 'vclick', 'coupon'];
const EVENT_ID_RX = /^[A-Za-z0-9_.:-]{1,80}$/;
const TYPE_RX = /^[a-z][a-z0-9_]{1,39}$/;
/* Event types that carry money: they need a stable event_id, a voo_id and a value_usd above zero. The same six types
 * VooSquare's Events API treats as money (src/routes/integrations.js MONEY_EVENTS); plan events also need a plan name. */
const PLAN_TYPES = ['plan_started', 'plan_renewed'];
const MONEY_TYPES = ['spend', 'refund', 'chargeback', 'wallet_topup', ...PLAN_TYPES];
/* Never send end-customer personal data (docs/INTEGRATION.md, section 2). These keys are refused outright. */
const PII_KEYS = ['email', 'phone', 'telegram_id', 'telegram_username', 'name', 'first_name', 'last_name', 'address', 'card', 'card_number', 'ip'];
const SIGNAL_KEYS = ['payment_fingerprint', 'telegram_id_hash', 'phone_hash', 'device_hash', 'payment_country'];
const EMAIL_RX = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const DAY_MS = 86400_000;
const MAX_AGE_MS = 400 * DAY_MS;

/* ------------------------------------------------------------------ errors */
class VooError extends Error {
  /** @param {string} code short machine code, e.g. invalid_grant, state_mismatch, invalid_event @param {string} message @param {object} [extra] */
  constructor(code, message, extra = {}) {
    super(message || code);
    this.name = 'VooError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/* ------------------------------------------------------------------ small helpers */
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const hmacRaw = (key, data) => crypto.createHmac('sha256', String(key)).update(data).digest();
function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? '')); const y = Buffer.from(String(b ?? ''));
  if (!x.length || x.length !== y.length) return false; // lengths of HMACs and keys are not secret
  return crypto.timingSafeEqual(x, y);
}
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });
const trimSlash = (s) => String(s || '').replace(/\/+$/, '');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue; // the first one wins, as in browsers (most specific path first)
    let v = part.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}
function cookieString(name, value, { maxAge, httpOnly = true, secure = false, domain = '', sameSite = 'Lax', path: p = '/' } = {}) {
  let s = `${name}=${encodeURIComponent(value)}; Path=${p}; SameSite=${sameSite}`;
  if (maxAge !== undefined) s += `; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
  if (maxAge === 0) s += '; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
  if (domain) s += `; Domain=${domain}`;
  if (httpOnly) s += '; HttpOnly';
  if (secure) s += '; Secure';
  return s;
}
/** Adds a Set-Cookie header without dropping the ones already set (by the tool's own session code, for example). */
function appendCookie(res, str) {
  const prev = res.getHeader ? res.getHeader('Set-Cookie') : undefined;
  const list = prev === undefined ? [] : Array.isArray(prev) ? prev : [String(prev)];
  // Replace an earlier cookie of the same name set during this same response.
  const name = str.slice(0, str.indexOf('='));
  res.setHeader('Set-Cookie', [...list.filter((c) => !String(c).startsWith(name + '=')), str]);
}
function redirect(res, url, status = 302) {
  res.statusCode = status;
  res.setHeader('Location', url);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}
function requestUrl(req) {
  return new URL(req.originalUrl || req.url || '/', 'http://voo-connect.invalid');
}
function isHttps(req, forced) {
  if (forced !== undefined) return !!forced;
  if (req.socket && req.socket.encrypted) return true;
  const xf = String((req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim();
  return xf === 'https';
}
/** A return path must stay on this site: one leading slash, never //host or /\host. */
function safeReturnTo(v, fallback = '/') {
  const s = String(v || '');
  if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\') || /[\u0000-\u001F]/.test(s) || s.length > 512) return fallback;
  return s;
}
/** Reads the body of a request (raw string). Uses req.body when a framework already read it. */
async function readBody(req, limit = 64 * 1024) {
  if (req.rawBody !== undefined) return Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : String(req.rawBody);
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (typeof req.body === 'string') return req.body;
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body); // already parsed by a JSON middleware
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new VooError('body_too_large', 'Request body is too large.')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ attribution (ref / vclick / coupon) */
/** Keeps only valid ref / vclick / coupon values. */
function cleanAttribution(obj) {
  const out = {};
  if (!obj) return out;
  for (const k of ATTR_KEYS) { const v = obj[k] == null ? '' : String(obj[k]).trim(); if (v && ATTR_RX[k].test(v)) out[k] = v; }
  return out;
}
function encodeAttribution(a) {
  const q = new URLSearchParams();
  for (const k of ATTR_KEYS) if (a[k]) q.set(k, a[k]);
  if (a.t) q.set('t', String(a.t));
  return q.toString();
}
function decodeAttribution(s) {
  if (!s) return {};
  try { const q = new URLSearchParams(s); const out = cleanAttribution(Object.fromEntries(q)); const t = Number(q.get('t')); if (t > 0) out.t = t; return out; } catch { return {}; }
}
/** Affiliate codes are compared the way VooSquare stores them (lower case). */
const sameRef = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
/**
 * Merges what a landing URL carries into what was kept before. Last click wins, the way VooSquare attributes:
 *  - a URL with a vclick (a new tracked click) replaces the whole set; an older coupon from another affiliate must not ride along;
 *  - a URL with ?ref= (and no vclick) of the SAME affiliate as the kept click (a tool carrying ?ref= onto its own links)
 *    keeps the kept vclick and coupon, so sub1…sub5 and the external click id are not lost; the click time stays the click's own;
 *  - a URL with only ?ref= of ANOTHER affiliate (or when the kept set has no ref to compare) is a new click: it replaces the set;
 *  - a URL with only a coupon keeps the click and adds the coupon.
 */
function mergeAttribution(kept, fresh, at = Date.now()) {
  fresh = cleanAttribution(fresh);
  const old = cleanAttribution(kept);
  if (fresh.vclick) return { ...fresh, t: at };
  if (fresh.ref) {
    if (sameRef(fresh.ref, old.ref)) return { ...old, ...(fresh.coupon ? { coupon: fresh.coupon } : {}), ...(kept && kept.t ? { t: kept.t } : { t: at }) };
    return { ...fresh, t: at };
  }
  if (fresh.coupon) return { ...old, coupon: fresh.coupon, t: at };
  return Object.keys(old).length ? { ...old, ...(kept.t ? { t: kept.t } : {}) } : {};
}

/* ------------------------------------------------------------------ id_token (HS256, signed with the client secret) */
function verifyJwtHS256(token, secret, { audience, issuer, clockToleranceSec = 60, now = Date.now() } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new VooError('invalid_id_token', 'id_token is not a JWT.');
  let head; let claims;
  try { head = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { throw new VooError('invalid_id_token', 'id_token cannot be read.'); }
  if (!head || head.alg !== 'HS256') throw new VooError('invalid_id_token', 'id_token must be signed with HS256.');
  const want = b64u(hmacRaw(secret, `${parts[0]}.${parts[1]}`));
  if (!safeEqual(want, parts[2])) throw new VooError('invalid_id_token', 'id_token signature is not valid (wrong client secret?).');
  const t = Math.floor(now / 1000);
  if (audience !== undefined && claims.aud !== audience) throw new VooError('invalid_id_token', 'id_token was issued for another app (aud).');
  if (issuer !== undefined && trimSlash(claims.iss) !== trimSlash(issuer)) throw new VooError('invalid_id_token', `id_token issuer is ${claims.iss}, expected ${issuer}.`);
  if (typeof claims.exp !== 'number' || claims.exp < t - clockToleranceSec) throw new VooError('invalid_id_token', 'id_token has expired.');
  if (typeof claims.iat === 'number' && claims.iat > t + clockToleranceSec) throw new VooError('invalid_id_token', 'id_token is issued in the future (check the server clock).');
  if (!claims.sub) throw new VooError('invalid_id_token', 'id_token has no sub.');
  return claims;
}

/* ------------------------------------------------------------------ HTTP to VooSquare */
function makeHttp({ serverBase, fetchImpl, timeoutMs, userAgent }) {
  return async function call(method, p, { body, form, headers = {}, auth, timeout = timeoutMs } = {}) {
    const h = { 'user-agent': userAgent, accept: 'application/json', ...headers };
    if (auth) h.authorization = auth;
    let payload;
    if (form) { payload = new URLSearchParams(form).toString(); h['content-type'] = 'application/x-www-form-urlencoded'; }
    else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    let res;
    try {
      res = await fetchImpl(serverBase + p, { method, headers: h, body: payload, redirect: 'manual', signal: ctl.signal });
    } catch (e) {
      throw new VooError('network', `Could not reach VooSquare (${e && e.name === 'AbortError' ? 'timed out' : (e && e.message) || 'network error'}).`, { retryable: true, cause: e });
    } finally { clearTimeout(timer); }
    const text = await res.text().catch(() => '');
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const err = (data && data.error) || `HTTP ${res.status}`;
      throw new VooError(typeof err === 'string' ? err : `http_${res.status}`, `VooSquare answered ${res.status}: ${typeof err === 'string' ? err : JSON.stringify(err)}`, {
        status: res.status, data, retryable: res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500, retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0,
      });
    }
    return { status: res.status, data, headers: res.headers };
  };
}

/* ------------------------------------------------------------------ outbox stores */
/** Keeps the queue in memory (lost on restart). Fine for tests; use fileStore() or your own database in production. */
function memoryStore() { let items = []; return { load: () => items.slice(), save: (list) => { items = list.slice(); } }; }
/** Keeps the queue in a JSON file (written atomically), so events survive a restart or deploy. */
function fileStore(file) {
  return {
    load() { try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; } },
    save(list) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(list));
      fs.renameSync(tmp, file);
    },
  };
}

/* ------------------------------------------------------------------ events */
function isoTime(v, label) {
  if (v === undefined || v === null || v === '') return new Date().toISOString();
  const d = v instanceof Date ? v : new Date(typeof v === 'number' ? v : String(v));
  if (Number.isNaN(d.getTime())) throw new VooError('invalid_event', `${label}: occurred_at is not a date.`);
  return d.toISOString();
}
/** Checks one event and returns it in the wire format VooSquare reads. Throws VooError('invalid_event') with a plain reason. */
function normalizeEvent(e, { now = Date.now() } = {}) {
  if (!e || typeof e !== 'object') throw new VooError('invalid_event', 'An event must be an object.');
  const id = String(e.event_id ?? '');
  const label = `event ${id || '(no event_id)'}`;
  if (!EVENT_ID_RX.test(id)) throw new VooError('invalid_event', `${label}: event_id is required, at most 80 characters, letters, digits and _ . : - only. Make it stable (the same payment always gives the same id).`);
  const type = String(e.type ?? '');
  if (!TYPE_RX.test(type)) throw new VooError('invalid_event', `${label}: type is required (for example spend, refund, chargeback, plan_started).`);
  for (const k of PII_KEYS) if (e[k] !== undefined) throw new VooError('invalid_event', `${label}: never send customers' personal data (field "${k}"). Send hashes in signals instead.`);
  const out = { event_id: id, type };
  if (e.voo_id !== undefined && e.voo_id !== null && e.voo_id !== '') {
    const v = String(e.voo_id);
    if (v.length > 64 || /\s/.test(v)) throw new VooError('invalid_event', `${label}: voo_id is not valid.`);
    out.voo_id = v;
  }
  const money = MONEY_TYPES.includes(type);
  if ((money || PLAN_TYPES.includes(type)) && !out.voo_id) throw new VooError('invalid_event', `${label}: ${type} needs the customer's voo_id.`);
  if (e.value_usd !== undefined && e.value_usd !== null) {
    const n = Number(e.value_usd);
    if (!Number.isFinite(n)) throw new VooError('invalid_event', `${label}: value_usd must be a number in US dollars.`);
    if (n < 0) throw new VooError('invalid_event', `${label}: value_usd can never be negative. A refund or chargeback is its own event pointing at the spend with original_event_id.`);
    if (n > 1e9) throw new VooError('invalid_event', `${label}: value_usd is too large.`);
    out.value_usd = Math.round(n * 100) / 100;
  }
  if ((money || PLAN_TYPES.includes(type)) && !(out.value_usd >= 0.01)) throw new VooError('invalid_event', `${label}: ${type} needs value_usd of at least 0.01 (amounts are counted in cents).`);
  if (PLAN_TYPES.includes(type) && !e.plan) throw new VooError('invalid_event', `${label}: ${type} needs the plan name in plan.`);
  if (type === 'chargeback' && !e.original_event_id) throw new VooError('invalid_event', `${label}: a chargeback needs original_event_id (the event_id of the spend it reverses).`);
  if (e.original_event_id !== undefined && e.original_event_id !== null && e.original_event_id !== '') {
    if (!EVENT_ID_RX.test(String(e.original_event_id))) throw new VooError('invalid_event', `${label}: original_event_id is not a valid event_id.`);
    out.original_event_id = String(e.original_event_id);
  }
  if (e.label !== undefined && e.label !== null) {
    const l = String(e.label).replace(/[\u0000-\u001F]/g, ' ').trim();
    if (EMAIL_RX.test(l)) throw new VooError('invalid_event', `${label}: the label contains an email address. Labels name the source, never the person.`);
    if (l) out.label = l.slice(0, 140);
  }
  if (e.plan) out.plan = String(e.plan).trim().slice(0, 60);
  if (e.country) {
    const c = String(e.country).trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(c)) throw new VooError('invalid_event', `${label}: country must be a 2-letter ISO code.`);
    out.country = c;
  }
  out.occurred_at = isoTime(e.occurred_at, label);
  if (Date.parse(out.occurred_at) < now - MAX_AGE_MS + 60_000) throw new VooError('invalid_event', `${label}: occurred_at is more than 400 days ago; VooSquare refuses it.`);
  if (e.signals) {
    if (typeof e.signals !== 'object') throw new VooError('invalid_event', `${label}: signals must be an object.`);
    const s = {};
    for (const [k, v] of Object.entries(e.signals)) {
      if (!SIGNAL_KEYS.includes(k)) throw new VooError('invalid_event', `${label}: unknown signal "${k}". Allowed: ${SIGNAL_KEYS.join(', ')}.`);
      const val = String(v ?? '').trim();
      if (!val) continue;
      if (k === 'payment_country') { if (!/^[A-Za-z]{2}$/.test(val)) throw new VooError('invalid_event', `${label}: payment_country must be a 2-letter ISO code.`); s[k] = val.toUpperCase(); continue; }
      if (!/^[A-Fa-f0-9]{16,128}$/.test(val)) throw new VooError('invalid_event', `${label}: signal "${k}" must be your own hash (hex), never the raw value. Use voo.hashSignal(value).`);
      s[k] = val.toLowerCase();
    }
    if (Object.keys(s).length) out.signals = s;
  }
  return out;
}
/* A rejection VooSquare wants us to resend (today: "more than 100 events in one call; send this one again in the next call"). */
const RESEND_RX = /send (this|it) (one )?again|resend|try again|retry|later|more than 100/i;

class EventsClient {
  constructor(opts) {
    this.http = opts.http;
    this.apiKey = opts.apiKey;
    this.prefix = opts.prefix || '';
    this.batchSize = Math.max(1, Math.min(MAX_BATCH, Number(opts.batchSize) || MAX_BATCH));
    // Test hook only (conformance test): send oversized calls to prove resend of `rejected`. Never set this in a tool.
    if (opts._unsafeBatchSize) this.batchSize = Number(opts._unsafeBatchSize);
    this.maxAttempts = Math.max(1, Number(opts.maxAttempts) || 12);
    this.backoffMs = Math.max(1, Number(opts.backoffMs) || 1000);
    this.maxBackoffMs = Math.max(this.backoffMs, Number(opts.maxBackoffMs) || 10 * 60_000);
    this.store = opts.store || memoryStore();
    this.onRejected = opts.onRejected || ((ev, error) => console.warn(`[voo-connect] VooSquare refused event ${ev.event_id}: ${error}`));
    this.onError = opts.onError || ((err) => console.warn(`[voo-connect] events: ${err.message}`));
    this.queue = (this.store.load() || []).filter((x) => x && x.event && x.event.event_id);
    this.failed = [];
    this._flushing = null;
    this._timer = null;
    this.stats = { calls: 0, stored: 0, resent: 0, retries: 0, rejected: 0 };
  }
  _save() { try { this.store.save(this.queue); } catch (e) { this.onError(new VooError('store', `Could not save the event outbox: ${e.message}`)); } }
  /** A stable event id from parts, with the tool prefix: id('pay', 184) → "jv_pay_184". Same input, same id, every time. */
  id(...parts) {
    const s = [this.prefix, ...parts].filter((x) => x !== undefined && x !== null && x !== '').map((x) => (x instanceof Date ? x.toISOString().slice(0, 10) : String(x))).join('_').replace(/[^A-Za-z0-9_.:-]/g, '-');
    if (s.length <= 80) return s;
    return s.slice(0, 63) + '_' + crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
  }
  /** Queues any event (wire format: event_id, voo_id, type, value_usd, label, occurred_at, plan, country, original_event_id, signals). */
  track(event) {
    const ev = normalizeEvent(event);
    if (this.queue.some((x) => x.event.event_id === ev.event_id)) return ev; // already waiting: VooSquare would ignore the repeat anyway
    this.queue.push({ event: ev, attempts: 0, next: 0, queued_at: Date.now() });
    this._save();
    return ev;
  }
  _money(type, o) {
    if (!o || typeof o !== 'object') throw new VooError('invalid_event', `${type}: pass an object.`);
    return this.track({
      event_id: o.eventId || o.event_id, voo_id: o.vooId || o.voo_id, type, value_usd: o.valueUsd ?? o.value_usd, label: o.label, plan: o.plan,
      country: o.country, occurred_at: o.occurredAt ?? o.occurred_at, original_event_id: o.originalEventId || o.original_event_id, signals: o.signals,
    });
  }
  /** The customer paid for something used: a plan payment or renewal, an overage, a one-time purchase, or wallet credits as they are consumed. Commissionable. */
  spend(o) { return this._money('spend', o); }
  /** Money returned to the customer. Logged only: never reverses affiliate commission. Point it at the spend with originalEventId. */
  refund(o) { return this._money('refund', o); }
  /** The payment was disputed and charged back. Reverses the commission of the spend named in originalEventId (required). */
  chargeback(o) { return this._money('chargeback', o); }
  /** A paid plan started (price in valueUsd, name in plan). Not commissionable: syncs plan names and prices. Send the spend too. */
  planStarted(o) { return this._money('plan_started', o); }
  /** A plan renewed (price in valueUsd). Not commissionable. Send the spend for the money too. */
  planRenewed(o) { return this._money('plan_renewed', o); }
  /** A plan was cancelled. */
  planCancelled(o) { return this._money('plan_cancelled', o); }
  /** Money added to a prepaid wallet or credit balance. Not commissionable: send spend later, as the credits are used. */
  walletTopup(o) { return this._money('wallet_topup', o); }
  /** Any activity event (join, lead, ftd, search_run, chat_answered, broadcast_sent, ...). */
  activity(type, o = {}) { return this._money(type, o); }

  pending() { return this.queue.map((x) => ({ ...x.event })); }
  /** Events VooSquare refused for good (for example occurred_at older than 400 days), or that failed too many times. */
  failures() { return this.failed.slice(); }

  _backoff(attempts, hint) {
    const exp = Math.min(this.maxBackoffMs, this.backoffMs * 2 ** Math.max(0, attempts - 1));
    return Math.max(hint || 0, Math.round(exp * (0.75 + Math.random() * 0.5)));
  }
  /** Sends every event that is due now, in calls of at most 100. Resolves with what happened. Never throws for network trouble. */
  flush() {
    if (this._flushing) return this._flushing;
    this._flushing = this._flush().finally(() => { this._flushing = null; });
    return this._flushing;
  }
  async _flush() {
    const out = { calls: 0, stored: 0, resent: 0, rejected: [], retrying: 0, pending: 0 };
    for (let guard = 0; guard < 1000; guard++) {
      const t = Date.now();
      const due = this.queue.filter((x) => x.next <= t);
      if (!due.length) break;
      const batch = due.slice(0, this.batchSize);
      out.calls++; this.stats.calls++;
      let res;
      try {
        res = await this.http('POST', '/api/v1/events', { auth: 'Bearer ' + this.apiKey, body: { events: batch.map((x) => x.event) } });
      } catch (err) {
        if (err.retryable) {
          for (const x of batch) {
            x.attempts++;
            if (x.attempts >= this.maxAttempts) { this._fail(x, `gave up after ${x.attempts} tries: ${err.message}`); continue; }
            x.next = Date.now() + this._backoff(x.attempts, err.retryAfterMs);
            out.retrying++; this.stats.retries++;
          }
          this._save();
          this.onError(err);
          break; // VooSquare or the network is unwell: wait for the backoff instead of hammering it
        }
        // 400 / 401 / 403: retrying the same call cannot help (bad key, bad body). Keep the events and report loudly.
        for (const x of batch) { x.attempts++; x.next = Date.now() + this._backoff(x.attempts, 60_000); }
        this._save();
        this.onError(err.status === 401 ? new VooError('unauthorized', 'VooSquare refused the API key (401). Check VOO_API_KEY in Admin → Products → <tool> → Credentials. Events are kept and retried.', { status: 401 }) : err);
        break;
      }
      const sent = new Set(batch.map((x) => x.event.event_id));
      const data = res.data || {};
      out.stored += Number(data.stored) || 0; this.stats.stored += Number(data.stored) || 0;
      const again = new Set();
      for (const r of Array.isArray(data.rejected) ? data.rejected : []) {
        const id = r && String(r.event_id || '');
        const item = batch.find((x) => x.event.event_id === id);
        if (!item) continue;
        if (RESEND_RX.test(String(r.error || ''))) { again.add(id); out.resent++; this.stats.resent++; continue; }
        this._fail(item, String(r.error || 'rejected'));
        out.rejected.push({ event_id: id, error: String(r.error || 'rejected') });
        sent.delete(id);
      }
      // Everything sent leaves the queue except what VooSquare asked us to resend (it stays, due now).
      this.queue = this.queue.filter((x) => !sent.has(x.event.event_id) || again.has(x.event.event_id));
      for (const x of this.queue) if (again.has(x.event.event_id)) { x.next = 0; x.resends = (x.resends || 0) + 1; if (x.resends > 20) this._fail(x, 'VooSquare kept asking for a resend'); }
      this.queue = this.queue.filter((x) => !x._dead);
      this._save();
    }
    out.pending = this.queue.length;
    return out;
  }
  _fail(item, error) {
    item._dead = true;
    this.queue = this.queue.filter((x) => x !== item);
    this.failed.push({ ...item.event, error });
    this.stats.rejected++;
    try { this.onRejected(item.event, error); } catch { /* the tool's handler must not break the loop */ }
  }
  /** Flushes until the queue is empty or the time is up (waits through backoff). For shutdown hooks and tests. */
  async drain({ timeoutMs = 30_000 } = {}) {
    const end = Date.now() + timeoutMs;
    let last = null;
    while (this.queue.length && Date.now() < end) {
      last = await this.flush();
      if (!this.queue.length) break;
      const wait = Math.min(...this.queue.map((x) => x.next)) - Date.now();
      await sleep(Math.max(5, Math.min(wait, end - Date.now(), 1000)));
    }
    return { pending: this.queue.length, failed: this.failed.length, last };
  }
  /** Sends in the background every intervalMs (default 5 s). The timer never keeps the process alive. */
  start(intervalMs = 5000) {
    if (this._timer) return this;
    this._timer = setInterval(() => { this.flush().catch((e) => this.onError(e)); }, Math.max(20, intervalMs));
    if (this._timer.unref) this._timer.unref();
    return this;
  }
  stop() { if (this._timer) clearInterval(this._timer); this._timer = null; return this; }
}

/* ------------------------------------------------------------------ the kit */
function createVooConnect(options = {}) {
  const o = { ...options };
  const base = trimSlash(o.base || o.baseUrl || process.env.VOO_BASE || '');
  if (!/^https?:\/\//.test(base)) throw new VooError('config', 'Voo Connect: set base (VOO_BASE), for example https://voosquare.com');
  const serverBase = trimSlash(o.serverBase || process.env.VOO_SERVER_BASE || base);
  const clientId = o.clientId || process.env.VOO_CLIENT_ID || '';
  const clientSecret = o.clientSecret || process.env.VOO_CLIENT_SECRET || '';
  const apiKey = o.apiKey || process.env.VOO_API_KEY || '';
  const redirectUri = o.redirectUri || process.env.VOO_REDIRECT_URI || '';
  const issuer = trimSlash(o.issuer || base);
  const affiliate = o.affiliate !== false; // Affleego: false (not in the affiliate program, no ref/vclick/coupon hand-off)
  const cookieSecret = o.cookieSecret || (clientSecret ? b64u(hmacRaw(clientSecret, 'voo-connect|cookie')) : '');
  const signalSecret = o.signalSecret || process.env.VOO_SIGNAL_SECRET || (clientSecret ? b64u(hmacRaw(clientSecret, 'voo-connect|signals')) : '');
  const fetchImpl = o.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new VooError('config', 'Voo Connect needs Node 18 or newer (global fetch), or pass options.fetch.');
  const http = makeHttp({ serverBase, fetchImpl, timeoutMs: Number(o.timeoutMs) || 10_000, userAgent: `voo-connect/${VERSION} (${o.toolName || clientId || 'tool'})` });
  const cookieOpts = (req) => ({ secure: isHttps(req, o.secureCookies), domain: o.cookieDomain || '' });
  const need = (v, name) => { if (!v) throw new VooError('config', `Voo Connect: ${name} is not set.`); return v; };

  /* ---------- attribution ---------- */
  function readAttribution(req) {
    const kept = decodeAttribution(parseCookies(req.headers && req.headers.cookie)[ATTR_COOKIE]);
    let fresh = {};
    try { fresh = Object.fromEntries(requestUrl(req).searchParams); } catch { /* ignore */ }
    const merged = mergeAttribution(kept, fresh);
    delete merged.t;
    return merged;
  }
  /** Middleware: keeps ref / vclick / coupon from any landing URL in the first-party cookie voo_attr (60 days). */
  function captureAttribution() {
    return function vooCaptureAttribution(req, res, next) {
      try {
        if (affiliate) {
          const q = requestUrl(req).searchParams;
          if (ATTR_KEYS.some((k) => q.has(k))) {
            const kept = decodeAttribution(parseCookies(req.headers.cookie)[ATTR_COOKIE]);
            const merged = mergeAttribution(kept, Object.fromEntries(q));
            if (Object.keys(cleanAttribution(merged)).length) {
              appendCookie(res, cookieString(ATTR_COOKIE, encodeAttribution(merged), { maxAge: ATTR_DAYS * 86400, httpOnly: false, ...cookieOpts(req) }));
              req.vooAttribution = cleanAttribution(merged);
            }
          }
        }
      } catch (e) { /* attribution must never break a landing page */ }
      if (typeof next === 'function') next();
    };
  }
  function clearAttribution(res, req) { appendCookie(res, cookieString(ATTR_COOKIE, '', { maxAge: 0, httpOnly: false, ...cookieOpts(req || { headers: {} }) })); }

  /* ---------- login ---------- */
  /** The /oauth/authorize URL. Pass state (required), prompt: 'signup' for "Start free", and ref / vclick / coupon. */
  function authorizeUrl({ state, prompt, ref, vclick, coupon, redirectUri: ru } = {}) {
    need(clientId, 'clientId (VOO_CLIENT_ID)');
    if (!state) throw new VooError('config', 'authorizeUrl needs a state value (random, checked at the callback).');
    const u = new URL(base + '/oauth/authorize');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', need(ru || redirectUri, 'redirectUri (VOO_REDIRECT_URI)'));
    u.searchParams.set('state', state);
    if (prompt === 'signup') u.searchParams.set('prompt', 'signup');
    if (affiliate) { const a = cleanAttribution({ ref, vclick, coupon }); for (const k of ATTR_KEYS) if (a[k]) u.searchParams.set(k, a[k]); }
    return u.toString();
  }
  function signState(obj) {
    const body = b64u(JSON.stringify(obj));
    return `${body}.${b64u(hmacRaw(need(cookieSecret, 'cookieSecret or clientSecret'), 'state|' + body))}`;
  }
  function readState(v) {
    const [body, sig] = String(v || '').split('.');
    if (!body || !sig || !safeEqual(sig, b64u(hmacRaw(cookieSecret, 'state|' + body)))) return null;
    try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  }
  /**
   * Starts login: sets a short-lived signed state cookie and redirects to VooSquare. Mount it at /auth/voosquare.
   * Reads ?return_to=/path (default /dashboard) and ?signup=1 or ?prompt=signup ("Start free"). Carries ref/vclick/coupon.
   */
  function startLogin(req, res, opts = {}) {
    const q = requestUrl(req).searchParams;
    const returnTo = safeReturnTo(opts.returnTo || q.get('return_to'), o.defaultReturnTo || '/dashboard');
    const signup = opts.signup !== undefined ? !!opts.signup : q.get('signup') === '1' || q.get('prompt') === 'signup';
    const state = b64u(crypto.randomBytes(24));
    appendCookie(res, cookieString(STATE_COOKIE, signState({ s: state, r: returnTo, t: Date.now() }), { maxAge: STATE_MAX_AGE_SEC, httpOnly: true, ...cookieOpts(req) }));
    const url = authorizeUrl({ state, prompt: signup ? 'signup' : undefined, ...(affiliate ? readAttribution(req) : {}), redirectUri: opts.redirectUri });
    redirect(res, url);
    return url;
  }
  /** POST /oauth/token. Resolves { access_token, token_type, expires_in, id_token, user }. */
  async function exchangeCode(code, { redirectUri: ru } = {}) {
    if (!code) throw new VooError('invalid_request', 'No code in the callback.');
    const r = await http('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code: String(code), redirect_uri: need(ru || redirectUri, 'redirectUri'), client_id: need(clientId, 'clientId'), client_secret: need(clientSecret, 'clientSecret') } });
    return r.data;
  }
  /** Checks the id_token (HS256 with the client secret, aud = client id, iss = VooSquare, not expired). Returns its claims. */
  function verifyIdToken(token, opts = {}) {
    return verifyJwtHS256(token, need(clientSecret, 'clientSecret'), { audience: clientId, issuer, clockToleranceSec: opts.clockToleranceSec ?? 60, now: opts.now });
  }
  /** GET /oauth/userinfo with the access token. */
  async function userinfo(accessToken) { return (await http('GET', '/oauth/userinfo', { auth: 'Bearer ' + accessToken })).data; }
  /**
   * The callback (mount at /auth/voosquare/callback). Checks state, exchanges the code, verifies the id_token and resolves
   * { user, claims, tokens, returnTo }. Find or create YOUR user by user.voo_id (never by email), then set your session.
   * Throws VooError: access_denied, state_missing, state_mismatch, state_expired, invalid_grant, invalid_id_token.
   */
  async function handleCallback(req, res, opts = {}) {
    const q = requestUrl(req).searchParams;
    const st = readState(parseCookies(req.headers.cookie)[STATE_COOKIE]);
    if (res) appendCookie(res, cookieString(STATE_COOKIE, '', { maxAge: 0, httpOnly: true, ...cookieOpts(req) }));
    if (q.get('error')) throw new VooError('access_denied', `Login was not completed (${q.get('error')}).`);
    if (!st) throw new VooError('state_missing', 'The login session expired or cookies are blocked. Start the login again.');
    if (!q.get('state') || !safeEqual(q.get('state'), st.s)) throw new VooError('state_mismatch', 'The login answer does not match this browser. Start the login again.');
    if (Date.now() - Number(st.t) > STATE_MAX_AGE_SEC * 1000) throw new VooError('state_expired', 'The login took too long. Start the login again.');
    const tokens = await exchangeCode(q.get('code'), opts);
    const claims = verifyIdToken(tokens.id_token);
    const u = tokens.user || {};
    if (u.sub && u.sub !== claims.sub) throw new VooError('invalid_id_token', 'id_token and user do not match.');
    const user = {
      voo_id: claims.voo_id || claims.sub, sub: claims.sub, email: u.email ?? claims.email, email_verified: !!(u.email_verified ?? claims.email_verified),
      name: u.name ?? claims.name ?? '', country: u.country ?? claims.country ?? '', voo_ref: u.voo_ref ?? claims.voo_ref ?? '', premium: !!(u.premium ?? claims.premium), picture: u.picture ?? claims.picture ?? '',
    };
    if (res && affiliate) clearAttribution(res, req); // VooSquare has decided attribution: the hand-off is done
    return { user, claims, tokens, returnTo: safeReturnTo(st.r, o.defaultReturnTo || '/dashboard') };
  }
  /** Where to send the browser after clearing your own session: VooSquare logs out too, then comes back to returnTo. */
  function logoutUrl(returnTo) {
    const u = new URL(base + '/oauth/logout');
    if (returnTo) u.searchParams.set('redirect_uri', returnTo);
    return u.toString();
  }

  /* ---------- server to server ---------- */
  const apiAuth = () => 'Bearer ' + need(apiKey, 'apiKey (VOO_API_KEY)');
  const users = { async get(vooId) { return (await http('GET', '/api/v1/users/' + encodeURIComponent(vooId), { auth: apiAuth() })).data; } };
  const support = {
    /** Forwards a message into the one VooSquare inbox. Same externalRef (or email while open) = same conversation. */
    async send({ email, name, subject, body, externalRef, external_ref, vooId, voo_id } = {}) {
      if (!body) throw new VooError('invalid_request', 'support.send needs a body.');
      return (await http('POST', '/api/v1/support/messages', { auth: apiAuth(), body: { email, name, subject, body, external_ref: externalRef || external_ref, voo_id: vooId || voo_id } })).data;
    },
    /** Reads a conversation: { ticket, messages }. */
    async thread(ticketId) { return (await http('GET', `/api/v1/support/tickets/${encodeURIComponent(ticketId)}/messages`, { auth: apiAuth() })).data; },
  };

  /* ---------- calls from VooSquare to the tool ---------- */
  /** True when the request carries Authorization: Bearer <VOO_API_KEY> (how VooSquare calls your summary URL and support webhook). */
  function isFromVooSquare(req) {
    const h = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
    return h.startsWith('Bearer ') && safeEqual(h.slice(7).trim(), need(apiKey, 'apiKey'));
  }
  /**
   * GET summary URL handler. fn(vooId, period) returns { status, metrics: [{ key, label, value, unit, change_pct }], open_url }
   * or null for an unknown user ({ linked: false }). Answers within 1.5 s (VooSquare's limit).
   */
  function summaryHandler(fn, { timeoutMs = 1400 } = {}) {
    return async function vooSummary(req, res) {
      if (!isFromVooSquare(req)) return sendJson(res, 401, { error: 'Unknown API key.' });
      const q = requestUrl(req).searchParams;
      const vooId = String(q.get('voo_id') || '');
      const period = ['1d', '7d', '30d'].includes(q.get('period')) ? q.get('period') : '1d';
      if (!vooId) return sendJson(res, 400, { error: 'voo_id is required' });
      let timer;
      try {
        const out = await Promise.race([Promise.resolve().then(() => fn(vooId, period)), new Promise((_, rej) => { timer = setTimeout(() => rej(new VooError('timeout', 'summary took too long')), timeoutMs); })]);
        if (!out) return sendJson(res, 200, { linked: false });
        return sendJson(res, 200, { linked: true, status: out.status || 'active', metrics: Array.isArray(out.metrics) ? out.metrics.slice(0, 6) : [], ...(out.open_url ? { open_url: out.open_url } : {}) });
      } catch (e) {
        return sendJson(res, e.code === 'timeout' ? 504 : 500, { error: e.code === 'timeout' ? 'timeout' : 'summary failed' });
      } finally { clearTimeout(timer); }
    };
  }
  /** POST support webhook handler: checks the key, parses { type: 'support.reply', ticket_id, external_ref, email, body, agent, created_at } and calls fn(reply). */
  function supportWebhook(fn) {
    return async function vooSupportWebhook(req, res) {
      if (!isFromVooSquare(req)) return sendJson(res, 401, { error: 'Unknown API key.' });
      let payload;
      try { payload = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'Body must be JSON.' }); }
      if (!payload || typeof payload !== 'object') return sendJson(res, 400, { error: 'Body must be JSON.' });
      try { if (payload.type === 'support.reply') await fn(payload); } catch (e) { return sendJson(res, 500, { error: 'handler failed' }); }
      return sendJson(res, 200, { ok: true });
    };
  }
  /** Your own hash of a fraud-hint value (payment fingerprint, Telegram ID, phone, device). Never send raw values. */
  function hashSignal(value) { return crypto.createHmac('sha256', need(signalSecret, 'signalSecret (VOO_SIGNAL_SECRET)')).update(String(value).trim().toLowerCase()).digest('hex'); }

  const events = new EventsClient({ http, apiKey, prefix: o.eventPrefix || '', batchSize: o.batchSize, _unsafeBatchSize: o._unsafeBatchSize, maxAttempts: o.maxAttempts, backoffMs: o.backoffMs, maxBackoffMs: o.maxBackoffMs, store: o.store || (o.outboxFile ? fileStore(o.outboxFile) : undefined), onRejected: o.onRejected, onError: o.onError });
  // Lazy: a tool without an API key can still use login.
  Object.defineProperty(events, 'apiKey', { get: () => need(apiKey, 'apiKey (VOO_API_KEY)'), configurable: true });

  return {
    version: VERSION, base, serverBase, clientId, redirectUri, affiliate,
    authorizeUrl, startLogin, handleCallback, exchangeCode, verifyIdToken, userinfo, logoutUrl,
    captureAttribution, readAttribution, clearAttribution,
    events, support, users, isFromVooSquare, summaryHandler, supportWebhook, hashSignal,
    http,
  };
}

/** Constant-time check of an HMAC-SHA256 hex signature over the exact raw body (Gatevoo: X-Gatevoo-Signature). */
function verifyHmac(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  const want = crypto.createHmac('sha256', String(secret)).update(Buffer.isBuffer(rawBody) ? rawBody : String(rawBody ?? '')).digest('hex');
  return safeEqual(want, String(signature).trim().toLowerCase().replace(/^sha256=/, ''));
}
function signHmac(rawBody, secret) { return crypto.createHmac('sha256', String(secret)).update(Buffer.isBuffer(rawBody) ? rawBody : String(rawBody ?? '')).digest('hex'); }

module.exports = {
  VERSION, createVooConnect, VooError, EventsClient, normalizeEvent, verifyJwtHS256, verifyHmac, verifyGatevooSignature: verifyHmac, signHmac,
  memoryStore, fileStore, parseCookies, cookieString, appendCookie, safeReturnTo, readBody, mergeAttribution, cleanAttribution, encodeAttribution, decodeAttribution,
  MAX_BATCH, ATTR_COOKIE, STATE_COOKIE, MONEY_TYPES, SIGNAL_KEYS,
};

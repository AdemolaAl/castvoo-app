'use strict';
/* Small helpers used everywhere: errors, ids, crypto, money, validation. */

const crypto = require('node:crypto');
const config = require('../config');

/** Throw this from any route to answer with an error the user can read. */
class HttpError extends Error {
  constructor(status, message, code, extra) {
    super(message);
    this.status = status;
    this.code = code || 'error';
    this.extra = extra;
  }
}
const httpError = (status, message, code, extra) => new HttpError(status, message, code, extra);
const badRequest = (message, code = 'bad_request') => new HttpError(400, message, code);
const notFound = (what = 'That item') => new HttpError(404, `${what} was not found.`, 'not_found');
const forbidden = (message = 'You do not have permission to do that.') => new HttpError(403, message, 'forbidden');

function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
function randomCode(len = 8) {
  // No 0/O/1/I/L to avoid confusion when people type codes.
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  const buf = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) s += abc[buf[i] % abc.length];
  return s;
}
function randomDigits(len = 6) {
  let s = '';
  while (s.length < len) s += crypto.randomInt(0, 10);
  return s;
}
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const hmac = (key, data, alg = 'sha256', enc = 'hex') => crypto.createHmac(alg, key).update(data).digest(enc);

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/* AES-256-GCM encryption for secrets at rest (bot tokens). Key derived from APP_SECRET. */
function key32() { return crypto.createHash('sha256').update('castvoo-enc:' + config.appSecret).digest(); }
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key32(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}
function decrypt(blob) {
  const [v, iv, tag, data] = String(blob).split('.');
  if (v !== 'v1') throw new Error('Unknown encryption version');
  const d = crypto.createDecipheriv('aes-256-gcm', key32(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}

/* Signed short values (used in tracked links and unsubscribe links). */
function sign(value, len = 16) { return hmac(config.appSecret, 'sig:' + value).slice(0, len); }
function checkSig(value, sig, len = 16) { return typeof sig === 'string' && safeEqual(sign(value, len), sig); }

/* Money: everything is stored in cents. */
const cents = (dollars) => Math.round(Number(dollars) * 100);
const dollars = (c) => Math.round(Number(c)) / 100;
const fmtUSD = (c) => '$' + (Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* Validation helpers. They throw a friendly 400 error. */
function str(v, name, { min = 0, max = 500, required = true, trim = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required && min > 0) throw badRequest(`${name} is required.`);
    if (required && min === 0) return '';
    return v === '' ? '' : null;
  }
  if (typeof v !== 'string' && typeof v !== 'number') throw badRequest(`${name} must be text.`);
  let s = String(v);
  if (trim) s = s.trim();
  if (s.length < min) throw badRequest(min === 1 ? `${name} is required.` : `${name} must be at least ${min} characters.`);
  if (s.length > max) throw badRequest(`${name} must be ${max} characters or fewer.`);
  return s;
}
function int(v, name, { min = -Infinity, max = Infinity, required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`${name} is required.`);
    return null;
  }
  const n = Number(v);
  if (!Number.isInteger(n)) throw badRequest(`${name} must be a whole number.`);
  if (n < min || n > max) throw badRequest(`${name} must be between ${min} and ${max}.`);
  return n;
}
function oneOf(v, name, list) {
  if (!list.includes(v)) throw badRequest(`${name} must be one of: ${list.join(', ')}.`);
  return v;
}
function email(v, name = 'Email') {
  const s = str(v, name, { min: 3, max: 254 }).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) throw badRequest('Enter a valid email, like you@company.com.');
  return s;
}
function url(v, name = 'Link') {
  const s = str(v, name, { min: 4, max: 2000 });
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { throw badRequest(`${name} is not a valid web address.`); }
  if (!['http:', 'https:', 'tg:'].includes(u.protocol)) throw badRequest(`${name} must start with https://`);
  return u.toString();
}
function bool(v) { return v === true || v === 'true' || v === 1 || v === '1' || v === 'on'; }

/** Replace {{var}} in a template string. Unknown vars become ''. */
function fill(tpl, vars) {
  return String(tpl).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
}
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addDays = (d, n) => new Date(new Date(d).getTime() + n * 86400000);
const fmtDate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

module.exports = {
  HttpError, httpError, badRequest, notFound, forbidden,
  randomToken, randomCode, randomDigits, sha256, hmac, safeEqual, encrypt, decrypt, sign, checkSig,
  cents, dollars, fmtUSD, str, int, oneOf, email, url, bool, fill, escHtml, sleep, addDays, fmtDate,
};

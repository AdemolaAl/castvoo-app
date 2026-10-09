'use strict';
/*
 * Country from an IP address, offline. Used for: the sign-up country pre-select (GET /api/public/geo), the country
 * of each login in Settings → Security (Active devices) and new-login alerts. Never for the language of the website.
 *
 * Where the country comes from, in order:
 *   1. the CF-IPCountry header, when Castvoo runs behind Cloudflare (two letters; XX and T1 are ignored)
 *   2. the free DB-IP "IP to Country Lite" database (CC BY 4.0, attribution on the privacy page), a CSV file
 *      "start_ip,end_ip,country_code" for IPv4 and IPv6, read from UPLOAD_DIR/geo/dbip-country-lite.csv.gz
 * The address is ctx.ip (server/app.js: the last X-Forwarded-For address when TRUST_PROXY is on, i.e. the one
 * Railway's proxy added; otherwise the socket address). Only the two-letter code is used; the address is not kept.
 *
 * In memory: IPv4 ranges as Uint32Array (start, end), IPv6 ranges as BigUint64Array pairs (high and low 64 bits),
 * and a Uint16Array of country indexes. A lookup is a binary search over the sorted starts.
 *
 * refresh() (jobs worker, GEOIP_AUTO_DOWNLOAD, on by default in production) downloads
 * https://download.db-ip.com/free/dbip-country-lite-YYYY-MM.csv.gz for the current month (else the previous one),
 * checks it (it must parse, have enough IPv4 and IPv6 rows and only two-letter codes), writes it next to the old
 * file and renames it over it (atomic on the same disk), then swaps the tables in memory.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const net = require('node:net');
const config = require('../config');
const log = require('./log');

const NAME = 'dbip-country-lite.csv.gz';
const dir = () => path.join(config.uploadDir, 'geo');
const file = () => path.join(dir(), NAME);
const metaFile = () => path.join(dir(), 'dbip-country-lite.json');
const MASK64 = (1n << 64n) - 1n;

let T = null;          // { v4: { s, e, c }, v6: { sh, sl, eh, el, c }, codes, rows4, rows6, loadedAt, mtime, month }
let checkedAt = 0;     // last time the file's mtime was compared (other instances pick up a new file)
let lastTry = 0;       // last download attempt (failures are retried after a few hours)

/* ---------- Addresses ---------- */

/** "41.58.1.2" -> 0x293A0102 (unsigned), or null. */
function ip4(s) {
  const p = String(s).split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) {
    if (!/^\d{1,3}$/.test(x)) return null;
    const v = Number(x);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

/** "2c0f:f5c0::1" -> [high 64 bits, low 64 bits] as BigInt, or null. Accepts "::ffff:1.2.3.4" forms. */
function ip6(s) {
  let a = String(s).trim().toLowerCase();
  const pct = a.indexOf('%'); if (pct >= 0) a = a.slice(0, pct);
  if (!net.isIPv6(a)) return null;
  // A dotted IPv4 tail becomes two groups.
  const m = /(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (m) {
    const v = ip4(m[1]); if (v == null) return null;
    a = a.slice(0, -m[1].length) + ((v >>> 16).toString(16)) + ':' + ((v & 0xffff).toString(16));
  }
  let groups;
  if (a.includes('::')) {
    const [l, r] = a.split('::');
    const L = l ? l.split(':') : [], R = r ? r.split(':') : [];
    groups = [...L, ...Array(8 - L.length - R.length).fill('0'), ...R];
  } else groups = a.split(':');
  if (groups.length !== 8) return null;
  let hi = 0n, lo = 0n;
  for (let i = 0; i < 8; i++) {
    const g = BigInt(parseInt(groups[i] || '0', 16));
    if (i < 4) hi = (hi << 16n) | g; else lo = (lo << 16n) | g;
  }
  return [hi & MASK64, lo & MASK64];
}

/** The IPv4 address inside an IPv4-mapped IPv6 address ("::ffff:1.2.3.4"), else null. */
function mapped4(s) {
  const p = ip6(s);
  if (!p || p[0] !== 0n || (p[1] >> 32n) !== 0xffffn) return null;
  return Number(p[1] & 0xffffffffn) >>> 0;
}

/* ---------- Parsing the CSV ---------- */

/**
 * Parse DB-IP CSV text into lookup tables. Lines: start,end,CC (quotes allowed, blank lines skipped).
 * Throws on a line it can't read. Ranges are sorted by start if the file was not.
 */
function parse(text) {
  const lines = String(text).split('\n');
  const codes = [], codeIdx = new Map();
  const idx = (cc) => { let i = codeIdx.get(cc); if (i === undefined) { i = codes.length; codes.push(cc); codeIdx.set(cc, i); } return i; };
  const n = lines.length;
  const s4 = new Uint32Array(n), e4 = new Uint32Array(n), c4 = new Uint16Array(n);
  const sh = new BigUint64Array(n), sl = new BigUint64Array(n), eh = new BigUint64Array(n), el = new BigUint64Array(n), c6 = new Uint16Array(n);
  let k4 = 0, k6 = 0;
  for (let li = 0; li < n; li++) {
    const line = lines[li].trim();
    if (!line) continue;
    const parts = line.split(',').map((x) => x.trim().replace(/^"|"$/g, ''));
    if (parts.length < 3) throw new Error(`line ${li + 1}: expected start,end,country`);
    const [a, b, cc0] = parts;
    const cc = cc0.toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc)) throw new Error(`line ${li + 1}: bad country code "${cc0}"`);
    if (a.includes(':')) {
      const x = ip6(a), y = ip6(b);
      if (!x || !y) throw new Error(`line ${li + 1}: bad IPv6 range`);
      if (x[0] > y[0] || (x[0] === y[0] && x[1] > y[1])) throw new Error(`line ${li + 1}: range ends before it starts`);
      sh[k6] = x[0]; sl[k6] = x[1]; eh[k6] = y[0]; el[k6] = y[1]; c6[k6] = idx(cc); k6++;
    } else {
      const x = ip4(a), y = ip4(b);
      if (x == null || y == null) throw new Error(`line ${li + 1}: bad IPv4 range`);
      if (x > y) throw new Error(`line ${li + 1}: range ends before it starts`);
      s4[k4] = x; e4[k4] = y; c4[k4] = idx(cc); k4++;
    }
  }
  let v4 = { s: s4.slice(0, k4), e: e4.slice(0, k4), c: c4.slice(0, k4) };
  let v6 = { sh: sh.slice(0, k6), sl: sl.slice(0, k6), eh: eh.slice(0, k6), el: el.slice(0, k6), c: c6.slice(0, k6) };
  // DB-IP files are sorted; sort anyway if one is not (binary search needs it).
  let sorted4 = true; for (let i = 1; i < k4; i++) if (v4.s[i] < v4.s[i - 1]) { sorted4 = false; break; }
  if (!sorted4) {
    const o = [...Array(k4).keys()].sort((x, y) => v4.s[x] - v4.s[y]);
    v4 = { s: Uint32Array.from(o, (i) => v4.s[i]), e: Uint32Array.from(o, (i) => v4.e[i]), c: Uint16Array.from(o, (i) => v4.c[i]) };
  }
  let sorted6 = true;
  for (let i = 1; i < k6; i++) if (v6.sh[i] < v6.sh[i - 1] || (v6.sh[i] === v6.sh[i - 1] && v6.sl[i] < v6.sl[i - 1])) { sorted6 = false; break; }
  if (!sorted6) {
    const o = [...Array(k6).keys()].sort((x, y) => (v6.sh[x] < v6.sh[y] ? -1 : v6.sh[x] > v6.sh[y] ? 1 : v6.sl[x] < v6.sl[y] ? -1 : v6.sl[x] > v6.sl[y] ? 1 : 0));
    const pick = (arr) => BigUint64Array.from(o, (i) => arr[i]);
    v6 = { sh: pick(v6.sh), sl: pick(v6.sl), eh: pick(v6.eh), el: pick(v6.el), c: Uint16Array.from(o, (i) => v6.c[i]) };
  }
  return { v4, v6, codes, rows4: k4, rows6: k6 };
}

/** Check a parsed table before it replaces the one in use. */
function validate(t, { minRows4 = 1, minRows6 = 0 } = {}) {
  if (!t || t.rows4 < minRows4) throw new Error(`only ${t ? t.rows4 : 0} IPv4 ranges (need ${minRows4})`);
  if (t.rows6 < minRows6) throw new Error(`only ${t.rows6} IPv6 ranges (need ${minRows6})`);
  if (!t.codes.length || t.codes.some((c) => !/^[A-Z]{2}$/.test(c))) throw new Error('bad country codes');
  return t;
}

/* ---------- Lookup ---------- */

function find4(t, n) {
  const { s, e, c } = t.v4;
  let lo = 0, hi = s.length - 1, at = -1;
  while (lo <= hi) { const mid = (lo + hi) >>> 1; if (s[mid] <= n) { at = mid; lo = mid + 1; } else hi = mid - 1; }
  return at >= 0 && n <= e[at] ? t.codes[c[at]] : null;
}
function find6(t, [h, l]) {
  const { sh, sl, eh, el, c } = t.v6;
  const le = (ah, al, bh, bl) => ah < bh || (ah === bh && al <= bl);
  let lo = 0, hi = sh.length - 1, at = -1;
  while (lo <= hi) { const mid = (lo + hi) >>> 1; if (le(sh[mid], sl[mid], h, l)) { at = mid; lo = mid + 1; } else hi = mid - 1; }
  return at >= 0 && le(h, l, eh[at], el[at]) ? t.codes[c[at]] : null;
}

/** Two-letter country code for an address, or null (unknown, private/reserved "ZZ", or no database loaded). */
function lookup(ip, table = T) {
  maybeReload();
  if (!table || !ip) return null;
  const s = String(ip).trim();
  let cc = null;
  const v4 = net.isIPv4(s) ? ip4(s) : mapped4(s);
  if (v4 != null) cc = find4(table, v4);
  else { const p = ip6(s); if (p) cc = find6(table, p); }
  return cc && cc !== 'ZZ' ? cc : null;
}

/** The country of the person making this request: Cloudflare's header, else the database. Null when unknown. */
function countryOf(ctx) {
  const cf = String((ctx.req && ctx.req.headers['cf-ipcountry']) || '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(cf) && cf !== 'XX' && cf !== 'T1') return cf;
  return lookup(ctx.ip);
}

/* ---------- Loading and swapping ---------- */

function readTable(f) {
  const raw = fs.readFileSync(f);
  const text = (raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw).toString('utf8');
  return parse(text);
}
function readMeta() { try { return JSON.parse(fs.readFileSync(metaFile(), 'utf8')); } catch { return {}; } }

/** Load the file from the volume if it is there (at start, and when another instance replaced it). Never throws. */
function load(f = file()) {
  try {
    const st = fs.statSync(f);
    const t = validate(readTable(f));
    T = { ...t, loadedAt: new Date(), mtime: st.mtimeMs, file: f, month: readMeta().month || null };
    checkedAt = Date.now();
    log.info('ip country database loaded', { ipv4: t.rows4, ipv6: t.rows6, month: T.month });
    return true;
  } catch (e) {
    if (e.code !== 'ENOENT') log.warn('ip country database not loaded', { err: e.message });
    checkedAt = Date.now();
    return false;
  }
}
const init = () => load();
/** Forget the table (tests). */
function unload() { T = null; }

/** At most once an hour: if the file on the volume changed (another instance downloaded a new one), load it. */
function maybeReload() {
  if (Date.now() - checkedAt < 3600000) return;
  checkedAt = Date.now();
  fs.stat(file(), (err, st) => { if (!err && (!T || st.mtimeMs !== T.mtime)) load(); });
}

/* ---------- The monthly download ---------- */

const monthOf = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
function monthsToTry(now = new Date()) {
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return [monthOf(now), monthOf(prev)];
}

/**
 * Download the newest monthly file when ours is older than this month. Options (tests): now, force, minRows4,
 * minRows6, retryMs. Returns { ok, month } | { skipped: reason } | { ok: false, error }.
 */
async function refresh({ now = new Date(), force = false, minRows4 = 100000, minRows6 = 50000, retryMs = 6 * 3600000 } = {}) {
  if (!config.geoip.autoDownload && !force) return { skipped: 'off' };
  const meta = readMeta();
  const [cur] = monthsToTry(now);
  if (!force && meta.month === cur && fs.existsSync(file())) return { skipped: 'current' };
  if (!force && Date.now() - lastTry < retryMs) return { skipped: 'retry_later' };
  lastTry = Date.now();
  const errors = [];
  for (const month of monthsToTry(now)) {
    if (!force && meta.month === month && fs.existsSync(file())) return { skipped: 'newest_available', month };
    const url = `${config.geoip.downloadBase}/free/dbip-country-lite-${month}.csv.gz`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(180000) });
      if (r.status === 404) { errors.push(`${month}: not published yet`); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const len = Number(r.headers.get('content-length') || 0);
      if (len > 80 * 1048576) throw new Error('file too large');
      const gz = Buffer.from(await r.arrayBuffer());
      if (gz.length > 80 * 1048576) throw new Error('file too large');
      if (!(gz[0] === 0x1f && gz[1] === 0x8b)) throw new Error('not a gzip file');
      const t = validate(parse(zlib.gunzipSync(gz).toString('utf8')), { minRows4, minRows6 });
      fs.mkdirSync(dir(), { recursive: true });
      const tmp = path.join(dir(), `.${NAME}.${process.pid}.${Date.now()}.tmp`);
      fs.writeFileSync(tmp, gz);
      fs.renameSync(tmp, file()); // atomic replace on the same disk: readers see the old file or the new one
      fs.writeFileSync(metaFile(), JSON.stringify({ month, rows4: t.rows4, rows6: t.rows6, downloaded_at: new Date().toISOString(), source: 'DB-IP IP to Country Lite (CC BY 4.0)' }));
      T = { ...t, loadedAt: new Date(), mtime: fs.statSync(file()).mtimeMs, file: file(), month };
      log.info('ip country database updated', { month, ipv4: t.rows4, ipv6: t.rows6 });
      return { ok: true, month, rows4: t.rows4, rows6: t.rows6 };
    } catch (e) {
      errors.push(`${month}: ${e.message}`);
      log.warn('ip country download failed', { month, err: e.message });
    }
  }
  return { ok: false, error: errors.join('; ') };
}

function status() {
  return T ? { loaded: true, ipv4: T.rows4, ipv6: T.rows6, month: T.month, loaded_at: T.loadedAt } : { loaded: false };
}
function _resetTimers() { lastTry = 0; checkedAt = Date.now(); }

/* ---------- Country names and flags ---------- */

/** "NG" -> "🇳🇬" (regional indicator letters). */
function flag(cc) {
  if (!/^[A-Z]{2}$/.test(String(cc || ''))) return '🌍';
  return String.fromCodePoint(...[...cc].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}
let names = null;
/** "NG" -> "Nigeria" (English), or the code when unknown. */
function countryName(cc) {
  if (!cc) return '';
  try { names = names || new Intl.DisplayNames(['en'], { type: 'region' }); return names.of(cc) || cc; } catch { return cc; }
}

module.exports = { init, load, unload, parse, validate, lookup, countryOf, refresh, status, monthsToTry, ip4, ip6, flag, countryName, file, _resetTimers, NAME };

'use strict';
/*
 * Talking to the Telegram Bot API.
 *   const tg = require('./telegram');
 *   const me = await tg.call(token, 'getMe');
 *   await tg.call(token, 'sendMessage', { chat_id, text });
 *   await tg.call(token, 'sendPhoto', { chat_id, caption }, { field: 'photo', path: '/data/x.jpg', filename: 'x.jpg', mime: 'image/jpeg' });
 *
 * Errors throw TelegramError with .code (HTTP-like code from Telegram), .description and .retryAfter.
 */

const fs = require('node:fs');
const config = require('../config');

class TelegramError extends Error {
  constructor(code, description, params = {}) {
    super(`Telegram ${code}: ${description}`);
    this.code = code;
    this.description = description;
    this.retryAfter = params.retry_after || 0;
    this.migrateTo = params.migrate_to_chat_id || null;
  }
  get blocked() { return this.code === 403; }
}

async function call(token, method, params = {}, file = null) {
  if (!token) throw new TelegramError(401, 'No bot token');
  const url = `${config.telegram.apiBase}/bot${token}/${method}`;
  let body, headers = {};
  if (file) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    const buf = await fs.promises.readFile(file.path);
    fd.append(file.field, new Blob([buf], { type: file.mime }), file.filename);
    body = fd;
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(params);
  }
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(file ? 120000 : 20000) });
  } catch (e) {
    throw new TelegramError(599, 'Network error talking to Telegram: ' + e.message);
  }
  const j = await r.json().catch(() => ({ ok: false, error_code: r.status, description: 'Bad response from Telegram' }));
  if (!j.ok) throw new TelegramError(j.error_code || r.status, j.description || 'Unknown error', j.parameters || {});
  return j.result;
}

/** Bot token format check before calling Telegram. */
const tokenLooksValid = (t) => /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/.test(String(t || '').trim());

/** Turn our simple formatting (*bold*, _italic_) into Telegram HTML, escaping everything else. */
function toHtml(text) {
  const esc = String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/gm, '$1<i>$2</i>');
}
/*
 * Personal messages: {name} becomes each person's first name.
 *   "Hi {name}!"          → "Hi Tunde!"   (no name known, or a channel/group post → "Hi there!")
 *   "Hi {name|friend}!"   → "Hi Tunde!" / "Hi friend!"   (your own word when there's no name)
 * {first_name} works too. Names are cut to NAME_MAX characters so the length check stays true.
 */
const NAME_RE = /\{(?:name|first_?name)(?:\|([^{}\n]{0,30}))?\}/gi;
const NAME_MAX = 20;
const NAME_DEFAULT = 'there';
function cleanName(n) {
  const s = String(n || '').replace(/[\u0000-\u001f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();
  return [...s].slice(0, NAME_MAX).join('').trim();
}
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Fill in {name} in text that toHtml() already made (so the fallback word is already escaped). */
function personalize(html, firstName) {
  const n = cleanName(firstName);
  return String(html || '').replace(NAME_RE, (m, fb) => (n ? escHtml(n) : (fb !== undefined && fb.trim() ? fb.trim() : NAME_DEFAULT)));
}
const hasName = (text) => { NAME_RE.lastIndex = 0; const r = NAME_RE.test(String(text || '')); NAME_RE.lastIndex = 0; return r; };

/** Length as Telegram counts it (after formatting marks are removed). {name} counts as the longest name we send. */
function visibleLength(text) {
  const t = String(text || '').replace(NAME_RE, (m, fb) => 'x'.repeat(Math.max(NAME_MAX, fb ? [...fb.trim()].length : NAME_DEFAULT.length)));
  return [...t.replace(/\*([^*\n]+)\*/g, '$1').replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/gm, '$1$2')].length;
}

const LIMITS = { text: 4096, caption: 1024, photoBytes: 10 * 1024 * 1024, videoBytes: 50 * 1024 * 1024 };

/** Platform bot (@CastvooBot) helpers. */
const platform = (method, params, file) => call(config.telegram.botToken, method, params, file);

module.exports = { call, platform, TelegramError, tokenLooksValid, toHtml, visibleLength, personalize, hasName, cleanName, LIMITS, NAME_MAX };

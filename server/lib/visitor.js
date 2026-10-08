'use strict';
/*
 * A signed "this browser loaded a Castvoo page" cookie (cv_vis), set on every HTML page the site serves.
 * The website chat (services/support-ai.js siteChat) uses it to tell real visitors from scripts that only call the
 * API: when the day's chat budget runs low, people whose cookie is older than a few minutes keep getting answers
 * and everyone else is asked to email. It holds no personal data: issue time, a random id and a signature.
 */
const { randomToken, sign, checkSig } = require('./util');
const config = require('../config');

const NAME = 'cv_vis';
const MAX_AGE = 90 * 86400;

function parse(v) {
  const m = /^(\d{9,11})\.([A-Za-z0-9_-]{8,24})\.([a-f0-9]{16})$/.exec(String(v || ''));
  if (!m || !checkSig(`vis:${m[1]}:${m[2]}`, m[3])) return null;
  const age = Math.floor(Date.now() / 1000) - Number(m[1]);
  if (age < -60 || age > MAX_AGE) return null;
  return { id: m[2], issued: Number(m[1]), ageSec: Math.max(0, age) };
}
/** The visitor (or null) for this request. */
const read = (ctx) => parse(ctx.cookies && ctx.cookies[NAME]);
/** Give the browser a cookie when it has no valid one yet. */
function ensure(ctx) {
  if (read(ctx)) return;
  const ts = Math.floor(Date.now() / 1000), id = randomToken(9);
  ctx.setCookie(NAME, `${ts}.${id}.${sign(`vis:${ts}:${id}`)}`, { maxAge: MAX_AGE, httpOnly: true, sameSite: 'Lax', secure: config.appUrl.startsWith('https://') });
}

module.exports = { read, ensure, parse, NAME };

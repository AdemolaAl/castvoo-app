'use strict';
/*
 * Customer cartoon avatars and nicknames (Settings → Profile → Your avatar).
 * The option lists live in ONE place, public/js/avatar.js, which the browser uses to draw and we use to check.
 *   check(cfg)     the cleaned config, or a 400 for any unknown key, unknown value or wrong type
 *   nickname(v)    the cleaned nickname (1–24 characters), null to remove it, or a 400
 */
const AV = require('../../public/js/avatar.js');
const { badRequest, cleanName, LOOKS_LIKE_URL } = require('./util');

function check(cfg) {
  if (JSON.stringify(cfg || null).length > 1500) throw badRequest('That avatar is too big. Make it again.');
  try { return AV.clean(cfg, true); } catch (e) { throw badRequest(e.message || 'That avatar could not be saved.'); }
}

// Letters (any language), numbers, emoji, spaces and . _ - ' only: no <, >, &, quotes, slashes or links.
const NICK_OK = /^[\p{L}\p{M}\p{N}\p{Extended_Pictographic}‍️ ._'-]+$/u;
function nickname(v) {
  if (v === null) return null;
  if (typeof v !== 'string') throw badRequest('Your nickname must be text.');
  const n = cleanName(v, 60);
  if (!n) return null;
  if ([...n].length > AV.NICK_MAX) throw badRequest(`Keep your nickname to ${AV.NICK_MAX} characters.`);
  if (!NICK_OK.test(n) || LOOKS_LIKE_URL.test(n)) throw badRequest('Use letters, numbers, emoji, spaces and . _ - \' in your nickname.');
  return n;
}

module.exports = { check, nickname, AV };

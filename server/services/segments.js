'use strict';
/*
 * Audiences: saved filters over a bot's subscribers.
 * A rule is { field, value }. Fields:
 *   source      start link tag equals value
 *   tag         has this tag
 *   lang        Telegram language starts with value (e.g. "fr")
 *   joined_days joined in the last N days
 *   clicked_days clicked any tracked link in the last N days
 *   quiet_days  did NOT click anything in the last N days
 * All rules must match (AND).
 */

const { badRequest } = require('../lib/util');

const FIELDS = {
  source: { label: 'Came from start link', type: 'text' },
  tag: { label: 'Has tag', type: 'text' },
  lang: { label: 'Telegram language', type: 'text' },
  joined_days: { label: 'Joined in the last (days)', type: 'number' },
  clicked_days: { label: 'Clicked in the last (days)', type: 'number' },
  quiet_days: { label: 'No clicks in the last (days)', type: 'number' },
};

function cleanRules(rules) {
  if (!Array.isArray(rules)) throw badRequest('Rules must be a list.');
  if (rules.length > 6) throw badRequest('Use 6 rules or fewer.');
  return rules.map((r) => {
    if (!r || !FIELDS[r.field]) throw badRequest('Unknown rule.');
    if (FIELDS[r.field].type === 'number') {
      const n = Number(r.value);
      if (!Number.isInteger(n) || n < 1 || n > 365) throw badRequest('Days must be between 1 and 365.');
      return { field: r.field, value: n };
    }
    const v = String(r.value || '').trim().slice(0, 64);
    if (!v) throw badRequest(`Fill in "${FIELDS[r.field].label}".`);
    return { field: r.field, value: v };
  });
}

/** SQL WHERE fragment for subscribers aliased `s`, starting at parameter number `start`. */
function toSql(rules, start) {
  const where = [], params = [];
  let i = start;
  for (const r of rules || []) {
    switch (r.field) {
      case 'source': where.push(`s.source = $${i++}`); params.push(r.value); break;
      case 'tag': where.push(`$${i++} = any(s.tags)`); params.push(r.value); break;
      case 'lang': where.push(`s.lang ilike $${i++}`); params.push(r.value.replace(/[%_]/g, '') + '%'); break;
      case 'joined_days': where.push(`s.joined_at > now() - make_interval(days => $${i++})`); params.push(r.value); break;
      case 'clicked_days': where.push(`exists (select 1 from clicks k where k.subscriber_id = s.id and k.created_at > now() - make_interval(days => $${i++}))`); params.push(r.value); break;
      case 'quiet_days': where.push(`not exists (select 1 from clicks k where k.subscriber_id = s.id and k.created_at > now() - make_interval(days => $${i++}))`); params.push(r.value); break;
      default: break;
    }
  }
  return { sql: where.length ? ' and ' + where.join(' and ') : '', params };
}

function describe(rules) {
  if (!rules || !rules.length) return ['All active subscribers'];
  return rules.map((r) => {
    if (r.field === 'source') return `Came from start link ${r.value}`;
    if (r.field === 'tag') return `Tag is ${r.value}`;
    if (r.field === 'lang') return `Language is ${r.value.toUpperCase()}`;
    if (r.field === 'joined_days') return `Joined in the last ${r.value} days`;
    if (r.field === 'clicked_days') return `Clicked in the last ${r.value} days`;
    if (r.field === 'quiet_days') return `No clicks in ${r.value} days`;
    return r.field;
  });
}

module.exports = { FIELDS, cleanRules, toSql, describe };

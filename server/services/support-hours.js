'use strict';
/*
 * AUD-10: the human reply time we promise when the AI support team hands a chat to a person. It depends on the plan
 * (Free, paid, priority plans such as Scale) and on the team's hours (support_ai.team_hours, default 8am to 10pm
 * West Africa Time). Outside those hours the promise says when the team is back, instead of promising a reply
 * "within 4 hours" at 3am.
 *
 *   etaText(cfg, { tier: 'free' | 'paid' | 'priority' }, now)  →  "within 4 business hours (8am to 10pm WAT)"
 *       or, after hours: "within 4 business hours (8am to 10pm WAT), counted from 8am WAT when the team is back"
 * Settings (Admin → Support AI): handoff_eta.free / .paid / .priority (the words), handoff_eta.<plan code> (one plan's
 * own words, optional), team_hours { start, end, tz, label }.
 */

const DEFAULT_HOURS = { start: 8, end: 22, tz: 'Africa/Lagos', label: '8am to 10pm WAT' };

/** The hour (0-23) in a time zone. */
function hourIn(tz, now = new Date()) {
  try {
    const h = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(now);
    return Number(h) % 24;
  } catch { return now.getUTCHours() + 1; } // WAT = UTC+1
}

function teamHours(cfg) { return { ...DEFAULT_HOURS, ...((cfg && cfg.team_hours) || {}) }; }

/** Is the human team working right now? */
function teamOnline(cfg, now = new Date()) {
  const t = teamHours(cfg);
  const h = hourIn(t.tz, now);
  return t.start <= t.end ? h >= t.start && h < t.end : h >= t.start || h < t.end;
}

function fmtHour(h) { const x = Number(h) % 24; return x === 0 ? '12am' : x === 12 ? '12pm' : x < 12 ? `${x}am` : `${x - 12}pm`; }

/**
 * The words for one handoff. `tier`: free | paid | priority. `planCode` (optional) picks handoff_eta[planCode] first.
 */
function etaText(cfg, { tier = 'paid', planCode = null } = {}, now = new Date()) {
  const eta = (cfg && cfg.handoff_eta) || {};
  const words = (planCode && eta[planCode]) || eta[tier] || eta.paid || 'within one business day';
  // Free's promise (24 hours) already spans the night; paid and priority promises count business hours only.
  if (tier === 'free' || teamOnline(cfg, now)) return words;
  const t = teamHours(cfg);
  const tzWord = /WAT/.test(t.label || '') ? 'WAT' : t.tz;
  return `${words}, counted from ${fmtHour(t.start)} ${tzWord} when the team is back`;
}

module.exports = { etaText, teamOnline, teamHours, hourIn, DEFAULT_HOURS };

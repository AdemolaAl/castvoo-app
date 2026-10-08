'use strict';
/*
 * Staff roles and what each one can do in the admin panel.
 * Higher rank = more power. You can only manage people ranked below you.
 *
 * To give a role a new power: add the role name to that permission's list.
 * To add a new power: add a line here, then use { staff: 'your.permission' } on the route.
 */

const ROLES = {
  owner:     { rank: 100, name: 'Owner',     about: 'Everything, including the team and money settings.' },
  admin:     { rank: 80,  name: 'Admin',     about: 'Runs the platform: users, pricing, features, content, support.' },
  finance:   { rank: 60,  name: 'Finance',   about: 'Payments, crypto checks, withdrawals, wallet corrections.' },
  support:   { rank: 50,  name: 'Support',   about: 'Answers customers, sees users, edits the help knowledge. Other pages are read-only; no payments or audit log.' },
  marketing: { rank: 50,  name: 'Marketing', about: 'Offers, coupons, website text and emails.' },
  viewer:    { rank: 10,  name: 'Viewer',    about: 'Read-only: can look at the overview, users, support and the setup pages (pricing, content, features, settings, team). Cannot change anything, and cannot see payments or the audit log.' },
};

const ALL = Object.keys(ROLES);
const PERMS = {
  'overview.view':     ALL,
  'users.view':        ALL,
  'users.edit':        ['owner', 'admin'],
  'wallet.adjust':     ['owner', 'admin', 'finance'],
  'support.view':      ['owner', 'admin', 'support', 'viewer'],
  'support.reply':     ['owner', 'admin', 'support'],
  'payments.view':     ['owner', 'admin', 'finance'],
  'payments.review':   ['owner', 'admin', 'finance'],
  'withdrawals.review':['owner', 'admin', 'finance'],
  'pricing.edit':      ['owner', 'admin'],
  'offers.edit':       ['owner', 'admin', 'marketing'],
  'countries.edit':    ['owner', 'admin', 'finance'],
  'content.edit':      ['owner', 'admin', 'marketing'],
  'emails.edit':       ['owner', 'admin', 'marketing'],
  'knowledge.edit':    ['owner', 'admin', 'support', 'marketing'],
  'ai.edit':           ['owner', 'admin'],
  'support_ai.edit':   ['owner', 'admin'],
  'support_ai.test':   ['owner', 'admin', 'support'],
  'features.edit':     ['owner', 'admin'],
  'settings.edit':     ['owner', 'admin'],
  // Saving any setting (the router's check); the handler then narrows it per key: billing for finance too,
  // referral rates and payout rules for owner/admin only, crypto addresses for owner only (SEC-14).
  'settings.save':     ['owner', 'admin', 'finance'],
  'money_settings.edit': ['owner', 'admin'],
  'team.manage':       ['owner', 'admin'],
  'audit.view':        ['owner', 'admin'],
  'system.view':       ['owner', 'admin'],
};

function can(role, perm) { return !!role && !!PERMS[perm] && PERMS[perm].includes(role); }
function rank(role) { return (ROLES[role] || { rank: 0 }).rank; }
/** Can `actorRole` give `targetRole` to someone who currently has `currentRole`? */
function canAssign(actorRole, targetRole, currentRole) {
  if (!can(actorRole, 'team.manage')) return false;
  if (actorRole === 'owner') return true;
  return rank(targetRole) < rank(actorRole) && (currentRole == null || rank(currentRole) < rank(actorRole));
}
function permsFor(role) { return Object.keys(PERMS).filter((p) => can(role, p)); }

module.exports = { ROLES, PERMS, can, rank, canAssign, permsFor };

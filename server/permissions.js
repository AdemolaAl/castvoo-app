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
  marketing: { rank: 50,  name: 'Marketing', about: 'Offers, coupons, website text, emails and the blog.' },
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
  // Blog (Admin → Blog): write and edit posts, authors and categories / publish, schedule, unpublish and delete posts.
  'blog.edit':         ['owner', 'admin', 'marketing'],
  'blog.publish':      ['owner', 'admin', 'marketing'],
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

/* ======================================================================================================
 * Workspace roles (customers' teams). This is THE list of what each role may do in a workspace: server/app.js
 * checks it for every { auth: 'workspace' } route before the handler runs, and `npm run check` fails when a
 * workspace route is missing here. Handlers still narrow some actions further (drafters can't send, "Approve
 * before sending", the helper's "Can send broadcasts" switch).
 *
 * To add a workspace route: add its 'METHOD /pattern' to WS_ROUTES with one of the WS_PERMS below.
 * test/e2e/setup-helper.test.js calls every route as a setup helper and checks it against this map.
 * ====================================================================================================== */
const WS_ROLES = {
  owner:   { name: 'Owner',        about: 'Everything, including billing, the team and the account itself.' },
  sender:  { name: 'Can send',     about: 'Writes and sends messages and follow-ups. Uses a team seat.' },
  drafter: { name: 'Drafts only',  about: 'Writes drafts; the owner sends. Uses a team seat.' },
  helper:  { name: 'Setup helper', about: 'Sets up and runs the workspace with their own login, no password sharing. One per workspace, free on every plan.' },
};
const ALL_WS = Object.keys(WS_ROLES);
const WS_PERMS = {
  'ws.view':    ALL_WS,                          // see the workspace: connections, subscribers, messages, flows, wallet balance
  'ws.run':     ALL_WS,                          // messages, Welcome Flows, follow-ups, audiences, tags, start links, Cas, uploads
  'ws.setup':   ['owner', 'helper'],             // connect / remove bots, channels and groups; workspace settings
  'ws.approve': ['owner'],                       // approve messages waiting for the owner
  'ws.wallet':  ALL_WS,                          // top up the wallet (with the person's own payment method) and follow a payment
  'ws.support': ALL_WS,                          // the Help chat, written as that person, about this workspace
  'ws.billing': ['owner'],                       // change the plan, use a coupon (+ helper when the owner allows it, see HELPER_SWITCH)
  'ws.cancel':  ['owner'],                       // cancel or resume the plan's renewal
  'ws.team':    ['owner'],                       // invite, remove, change roles, the helper's switches
  'ws.leave':   ['sender', 'drafter', 'helper'], // leave a workspace you were invited to
  'ws.export':  ['owner'],                       // download every subscriber as a CSV file
  'ws.earnings':['owner', 'sender', 'drafter'],  // referral earnings: see, move into a wallet, withdraw (never the helper)
};
// A permission the owner can switch on for the helper: the workspace column that turns it on.
const HELPER_SWITCH = { 'ws.billing': 'helper_billing' };

const WS_ROUTES = {
  'GET /api/app/state': 'ws.view',
  'POST /api/app/settings': 'ws.setup',
  'GET /api/app/team': 'ws.view',
  'POST /api/app/team/invite': 'ws.team',
  'POST /api/app/team/remove': 'ws.team',
  'POST /api/app/team/role': 'ws.team',
  'POST /api/app/team/helper-link': 'ws.team',
  'POST /api/app/team/helper/settings': 'ws.team',
  'POST /api/app/team/helper/cancel-invite': 'ws.team',
  'POST /api/app/team/helper/seen': 'ws.team',
  'POST /api/app/team/leave': 'ws.leave',
  'GET /api/app/plan': 'ws.view',
  'POST /api/app/plan': 'ws.billing',
  'POST /api/app/plan/cancel': 'ws.cancel',
  'POST /api/app/coupon': 'ws.billing',
  'GET /api/app/ai-profile': 'ws.view',
  'POST /api/app/ai-profile': 'ws.run',
  'GET /api/connections': 'ws.view',
  'POST /api/connections/bot': 'ws.setup',
  'POST /api/connections/request': 'ws.setup',
  'DELETE /api/connections/:id': 'ws.setup',
  'GET /api/connections/:id/start-links': 'ws.view',
  'POST /api/connections/:id/start-links': 'ws.run',
  'DELETE /api/connections/:id/start-links/:tag': 'ws.run',
  'GET /api/subscribers': 'ws.view',
  'POST /api/subscribers/tag': 'ws.run',
  'GET /api/subscribers/export.csv': 'ws.export',
  'GET /api/segments': 'ws.view',
  'POST /api/segments/preview': 'ws.view',
  'POST /api/segments': 'ws.run',
  'DELETE /api/segments/:id': 'ws.run',
  'POST /api/media': 'ws.run',
  'GET /api/media/:id': 'ws.view',
  'GET /api/broadcasts': 'ws.view',
  'GET /api/links': 'ws.view',
  'GET /api/broadcasts/estimate': 'ws.view',
  'GET /api/broadcasts/:id': 'ws.view',
  'POST /api/broadcasts': 'ws.run',
  'POST /api/broadcasts/:id/approve': 'ws.approve',
  'POST /api/broadcasts/:id/send': 'ws.run',
  'POST /api/broadcasts/:id/cancel': 'ws.run',
  'POST /api/broadcasts/:id/edit': 'ws.run',
  'POST /api/broadcasts/:id/pin': 'ws.run',
  'POST /api/broadcasts/:id/delete': 'ws.run',
  'POST /api/broadcasts/test': 'ws.run',
  'GET /api/drips': 'ws.view',
  'POST /api/drips': 'ws.run',
  'PUT /api/drips/:id': 'ws.run',
  'POST /api/drips/:id/toggle': 'ws.run',
  'DELETE /api/drips/:id': 'ws.run',
  'GET /api/flows': 'ws.view',
  'POST /api/flows': 'ws.run',
  'POST /api/flows/check': 'ws.view',
  'GET /api/flows/requests': 'ws.view',
  'POST /api/flows/requests/decide': 'ws.run',
  'GET /api/flows/:id': 'ws.view',
  'GET /api/flows/:id/stats': 'ws.view',
  'PUT /api/flows/:id': 'ws.run',
  'POST /api/flows/:id/toggle': 'ws.run',
  'POST /api/flows/:id/duplicate': 'ws.run',
  'DELETE /api/flows/:id': 'ws.run',
  'POST /api/flows/:id/invite-link': 'ws.run',
  'POST /api/ai/write': 'ws.run',
  'POST /api/ai/rewrite': 'ws.run',
  'POST /api/ai/translate': 'ws.run',
  'POST /api/ai/sequence': 'ws.run',
  'POST /api/ai/ask': 'ws.view',
  'GET /api/ai/my-examples': 'ws.view',
  'GET /api/wallet': 'ws.view',
  'POST /api/wallet/topup': 'ws.wallet',
  'POST /api/wallet/crypto-txid': 'ws.wallet',
  'GET /api/wallet/manual/:ref': 'ws.wallet',
  'POST /api/wallet/manual/:ref/screenshot': 'ws.wallet',
  'POST /api/wallet/manual/:ref/submit': 'ws.wallet',
  'POST /api/wallet/check': 'ws.wallet',
  'GET /api/referrals': 'ws.earnings',
  'POST /api/referrals/use': 'ws.earnings',
  'POST /api/referrals/withdraw': 'ws.earnings',
  'GET /api/support': 'ws.support',
  'POST /api/support': 'ws.support',
  'POST /api/support/attachments': 'ws.support',
};

/** May `role` use workspace permission `perm` in workspace `ws`? */
function wsCan(role, perm, ws) {
  if (!role || !WS_PERMS[perm]) return false;
  if (WS_PERMS[perm].includes(role)) return true;
  return role === 'helper' && !!HELPER_SWITCH[perm] && !!(ws && ws[HELPER_SWITCH[perm]]);
}
/** The permission a workspace route needs, or null when the route is not in the map (then only the owner may use it). */
function wsRoutePerm(method, pattern) { return WS_ROUTES[`${method} ${pattern}`] || null; }
function wsRouteAllowed(method, pattern, role, ws) {
  const perm = wsRoutePerm(method, pattern);
  return perm ? wsCan(role, perm, ws) : role === 'owner';
}
function wsRoleName(role) { return (WS_ROLES[role] || { name: role || '' }).name; }

module.exports = { ROLES, PERMS, can, rank, canAssign, permsFor, WS_ROLES, WS_PERMS, WS_ROUTES, HELPER_SWITCH, wsCan, wsRoutePerm, wsRouteAllowed, wsRoleName };

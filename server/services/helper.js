'use strict';
/*
 * Setup helper: one person the owner invites to set up and run the workspace with their own login (no password
 * sharing). The rules for what a helper may do live in server/permissions.js (WS_PERMS / WS_ROUTES); this file has
 * the words shown on the consent screen, the helper card and in emails, and small lookups.
 */

const db = require('../db');
const one = async (c, sql, params) => (c.one ? c.one(sql, params) : (await c.query(sql, params)).rows[0] || null);

// Shown on the consent screen, in Settings → Team and in the knowledge article. Keep them true to WS_PERMS.
const CAN = [
  'Connect bots, channels and groups',
  'Build Welcome Flows, follow-ups, audiences and start links',
  'Write, schedule and send broadcasts',
  'See subscribers and add tags',
  'Train Cas and use the AI writing tools',
  'Change workspace settings',
  'Top up the wallet with your own payment method, if you want to',
  'Chat with Castvoo support about this workspace',
];
const CANNOT = [
  "See or change the owner's login, email or Telegram link",
  'Delete the workspace or the account, or export all data',
  'Invite, remove or change teammates',
  'Change or cancel the plan (unless the owner allows billing)',
  'See, move or withdraw referral earnings or payout details',
  'Ask for refunds',
];

/** The active helper of a workspace (or null). */
function current(wsId, c = db) {
  return one(c, `select u.id, u.name, u.email, u.tg_username, m.created_at as joined_at, m.last_active_at, m.owner_seen
    from members m join users u on u.id = m.user_id where m.workspace_id = $1 and m.role = 'helper'`, [wsId]);
}
/** A helper invite that can still be accepted (or null). */
function pendingInvite(wsId, c = db) {
  return one(c, `select token, kind, email, expires_at, created_at from invites where workspace_id = $1 and role = 'helper'
    and accepted_at is null and declined_at is null and expires_at > now() order by created_at desc limit 1`, [wsId]);
}
/** Unused helper invites stop working (a new one replaces them, or the owner cancels). */
function expirePending(wsId, c = db) {
  return c.query("update invites set expires_at = now() where workspace_id = $1 and role = 'helper' and accepted_at is null and declined_at is null and expires_at > now()", [wsId]);
}

module.exports = { CAN, CANNOT, current, pendingInvite, expirePending };

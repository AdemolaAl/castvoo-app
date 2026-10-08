'use strict';
/*
 * Deleting a workspace's personal data: used by account deletion (routes/auth.js POST /api/me/delete) and by the
 * retention purge (workers/jobs.js). One list, so the two paths can't drift apart (SEC-8, SEC-9).
 *
 * Removed: people who asked to join and their welcome records (join_requests), follow-up progress (sequence_runs,
 * via subscribers), tracked links and their clicks, replies, the support AI's tool log for the workspace, and every
 * (account deletion only) teammates' memberships, so former teammates can't keep opening a deleted workspace.
 * Kept on purpose (and said so in the privacy policy): payments and wallet history (accounting law), AI cost rows
 * (no message text; the person is unlinked), the audit log.
 */
// Files (media, support screenshots) are removed first by services/media-files.js removeFiles().

/** Rows, inside the caller's transaction c. */
async function purgeRows(c, wsIds, { userId = null, members = false } = {}) {
  if (!wsIds.length && !userId) return;
  const q = (sql) => c.query(sql, [wsIds]);
  await q('delete from join_requests where workspace_id = any($1)');
  await q('delete from sequence_runs where subscriber_id in (select s.id from subscribers s join connections k on k.id = s.connection_id where k.workspace_id = any($1))');
  await q('delete from clicks where workspace_id = any($1)');
  await q('delete from links where workspace_id = any($1)');
  await q('delete from replies where workspace_id = any($1)');
  await q('delete from support_ai_tool_log where workspace_id = any($1)');
  // Account deletion only: the retention purge keeps the owner's (and team's) access to the emptied workspace.
  if (members) { await q('delete from members where workspace_id = any($1)'); await q('delete from invites where workspace_id = any($1)'); }
  await q('update ai_usage set user_id = null where workspace_id = any($1)');
  if (userId) await c.query('update ai_usage set user_id = null where user_id = $1', [userId]);
}

module.exports = { purgeRows };

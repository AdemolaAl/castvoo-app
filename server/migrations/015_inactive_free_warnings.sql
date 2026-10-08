-- Integration of the review fixes (AUD-6 follow-up). Additive; never edits older migrations.

-- A dashboard visit counts as use of the workspace (sessions slide, so an active owner may not log in again for a
-- long time). Written at most once a day by services/auth.js loadSession.
alter table users add column if not exists last_seen_at timestamptz;
update users u set last_seen_at = s.seen from (select user_id, max(expires_at) - interval '30 days' as seen from sessions group by user_id) s
  where s.user_id = u.id and u.last_seen_at is null and s.seen > coalesce(u.last_login_at, u.created_at);

-- Inactive Free workspaces are warned by email 30 and 7 days before their content is deleted (workers/jobs.js
-- inactiveFreeTick). A warning sent before the owner's last activity no longer counts.
alter table workspaces add column if not exists inactive_warn1_at timestamptz;
alter table workspaces add column if not exists inactive_warn2_at timestamptz;

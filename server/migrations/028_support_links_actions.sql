-- Support agent: link cards and confirm-before-action (Oct 2026).
--   support_messages.links   link cards on an AI bubble (services/support-links.js): [{ key, kind, label, sub, href, guide, text }].
--                            Every card was checked against the whitelist on the server before it was saved.
--   support_ai_actions       a small fix the AI proposed (re-point a webhook, switch a bot on or off, resend the
--                            verification email). It runs only when the customer's NEXT message says yes
--                            (services/support-tools.js run(): the code checks it, not the model). Expires after 30 minutes.

alter table support_messages add column if not exists links jsonb;

create table if not exists support_ai_actions (
  id bigserial primary key,
  thread_id bigint not null references support_threads(id) on delete cascade,
  workspace_id bigint references workspaces(id) on delete cascade,
  tool text not null,
  input_key text not null,
  summary text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes',
  used_at timestamptz
);
create index if not exists support_ai_actions_thread on support_ai_actions(thread_id, tool, created_at desc);

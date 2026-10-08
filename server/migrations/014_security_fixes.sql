-- Security review and support-AI fixes (FIX-SEC). Additive; never edits older migrations.

-- Shared rate-limit counters (lib/ratelimit.js hitShared): one row per key and fixed time window, so limits that
-- protect cost (login codes, AI, support chat, website chat, payment rechecks) hold across several instances.
create table if not exists rate_buckets (
  key text not null,
  win bigint not null,
  n int not null default 0,
  expires_at timestamptz not null,
  primary key (key, win)
);
create index if not exists rate_buckets_expires on rate_buckets(expires_at);

-- Support-AI job lease (ENG-7): the instance that claimed a job owns it through `lease` and keeps it alive with
-- heartbeat_at before every model round. A job is only taken over when its heartbeat is stale, and a worker whose
-- lease was taken never posts.
alter table support_ai_jobs add column if not exists lease text;
alter table support_ai_jobs add column if not exists heartbeat_at timestamptz;

-- ENG-15: open conversations a teammate has already answered stay with the team after the AI was switched on.
update support_threads t set ai_paused = true, ai_paused_reason = 'staff_reply'
  where t.status <> 'closed' and not t.ai_paused
    and exists (select 1 from support_messages m where m.thread_id = t.id and m.author_type = 'staff' and not m.internal);

-- ENG-16 / SEC-1: a support conversation belongs to one person in one workspace.
create index if not exists support_threads_user_ws on support_threads(user_id, workspace_id, id desc);

-- AI resolution rate (Admin → Support AI): which conversations the AI answered, and which a person had to answer.
create index if not exists support_messages_author on support_messages(thread_id, author_type);

-- SEC-7: staff can switch off a tracked link (phishing, abuse). Disabled links show a notice instead of redirecting.
alter table links add column if not exists disabled_at timestamptz;
alter table links add column if not exists disabled_reason text;

-- SEC-10: a Telegram link remembers which Telegram account confirmed it, so that person can undo it from Telegram.
alter table tg_link_tokens add column if not exists tg_user_id bigint;
alter table tg_link_tokens add column if not exists created_at timestamptz not null default now();

-- SEC-18: media storage is reserved under a per-workspace lock; nothing to migrate.

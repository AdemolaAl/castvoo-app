-- 24/7 AI support team: personas, per-thread AI state, the reply queue, the AI's tool log, and knowledge that
-- keeps the team's edits when the defaults in server/knowledge-defaults.js change.
-- (010 is reserved for other work; this file never edits older migrations.)

-- Messages can now be written by the AI support agent. visible_at lets a reply "type" for a few seconds:
-- the customer only sees a bubble once visible_at has passed (until then the dashboard shows "Mia is typing…").
alter table support_messages drop constraint if exists support_messages_author_type_check;
alter table support_messages add constraint support_messages_author_type_check check (author_type in ('user','staff','system','ai'));
alter table support_messages add column if not exists visible_at timestamptz not null default now();
alter table support_messages add column if not exists persona_id int;
create index if not exists support_messages_visible on support_messages(thread_id, visible_at);

-- Named agents with faces. First names only. photo_path is an uploaded image; without one a tasteful initials avatar is drawn.
create table if not exists support_personas (
  id serial primary key,
  name text not null,
  role text not null default '',
  bio text not null default '',
  photo_path text,
  photo_mime text,
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Per-thread AI state.
--   ai_enabled   staff switch "AI on/off" for this conversation
--   ai_paused    the AI stops replying (handoff, staff took over, or staff replied) until staff hands back
--   needs_human  shows in Admin → Support → "Needs human"
alter table support_threads add column if not exists ai_enabled boolean not null default true;
alter table support_threads add column if not exists ai_paused boolean not null default false;
alter table support_threads add column if not exists ai_paused_reason text;
alter table support_threads add column if not exists ai_persona_id int references support_personas(id) on delete set null;
alter table support_threads add column if not exists needs_human boolean not null default false;
alter table support_threads add column if not exists priority text not null default 'normal';
alter table support_threads add column if not exists queue text not null default 'support';
alter table support_threads add column if not exists handoff_reason text;
alter table support_threads add column if not exists handoff_at timestamptz;
alter table support_threads add column if not exists ai_summary text;
alter table support_threads add column if not exists ai_failures int not null default 0;
alter table support_threads add column if not exists ai_replies int not null default 0;
alter table support_threads add constraint support_threads_priority_check check (priority in ('low','normal','high','urgent'));
alter table support_threads add constraint support_threads_queue_check check (queue in ('support','finance','tech','privacy'));
create index if not exists support_threads_needs_human on support_threads(needs_human, last_message_at desc) where needs_human;

-- One queued AI job per conversation at a time (new customer messages join the waiting job).
create table if not exists support_ai_jobs (
  id bigserial primary key,
  thread_id bigint not null references support_threads(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued','running','done','failed','skipped')),
  due_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  note text,
  created_at timestamptz not null default now()
);
create unique index if not exists support_ai_jobs_one_open on support_ai_jobs(thread_id) where status in ('queued','running');
create index if not exists support_ai_jobs_due on support_ai_jobs(due_at) where status = 'queued';

-- Which tools the AI used on each conversation (staff see it; customers never do). Inputs and outputs are redacted.
create table if not exists support_ai_tool_log (
  id bigserial primary key,
  thread_id bigint references support_threads(id) on delete cascade,
  workspace_id bigint,
  tool text not null,
  input jsonb not null default '{}',
  output jsonb not null default '{}',
  ok boolean not null default true,
  ms int not null default 0,
  sandbox boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists support_ai_tool_log_thread on support_ai_tool_log(thread_id, id);

-- AI support conversations are counted per thread (Free plan allowance) and cost is tagged like Cas.
alter table ai_usage add column if not exists thread_id bigint;
create index if not exists ai_usage_kind_ws on ai_usage(kind, workspace_id, created_at);

-- Knowledge defaults that update safely: rows from knowledge-defaults.js carry a key. A row the team edited
-- (edited = true) is never overwritten; a default the team deleted is remembered and never comes back.
alter table knowledge add column if not exists key text;
alter table knowledge add column if not exists edited boolean not null default false;
alter table knowledge add column if not exists default_hash text;
create unique index if not exists knowledge_key on knowledge(key) where key is not null;
-- Articles the team already changed before this migration count as edited.
update knowledge set edited = true where updated_by is not null;
create table if not exists knowledge_removed (
  key text primary key,
  removed_at timestamptz not null default now()
);

-- Repeating messages, rotating versions, voice notes and round videos, auto-delete and auto-pin (Oct 2026).
--   media.kind                    + 'voice' (Telegram sendVoice, OGG/Opus) and 'video_note' (sendVideoNote, round video).
--   media.duration_sec            length of a voice note or round video when known (after conversion).
--   repeat_series                 "Repeat this message": a schedule (every day / weekdays / chosen days / every week at a
--                                 time of day in the workspace time zone), an end (never / on a date / after N sends),
--                                 rotation (in order / random without repeat), auto-delete and auto-pin options.
--                                 The scheduler (workers/jobs.js repeatsTick) turns each run into a normal broadcast.
--   repeat_versions               the message versions of a series (1 to 30), each with its own text, media and buttons.
--   broadcasts.series_id/run_date one broadcast per series and run date (unique): a restarted worker never sends a run twice.
--   broadcasts.delete_after_hours "Delete this message after…" (1 to 47 hours: Telegram lets bots delete for 48 hours).
--   broadcasts.pin/pin_notify/unpin_after_hours  "Pin it" (in the channel or group, or in each person's bot chat).
--   deliveries.action             + 'unpin'. deliveries.message_id2: the text sent right after a round video (Telegram
--                                 gives round videos no caption), so edit, pin and delete reach both messages.
-- Safe to run more than once.

alter table media drop constraint if exists media_kind_check;
alter table media add constraint media_kind_check check (kind in ('photo','video','animation','voice','video_note'));
alter table media add column if not exists duration_sec int;

create table if not exists repeat_series (
  id bigserial primary key,
  workspace_id bigint not null references workspaces(id) on delete cascade,
  connection_id bigint not null references connections(id) on delete cascade,
  segment_id bigint references segments(id) on delete set null,
  title text not null default '',
  include_stop boolean not null default true,
  freq text not null check (freq in ('daily','weekdays','days','weekly')),
  days int[] not null default '{}',
  time_of_day text not null,
  end_mode text not null default 'never' check (end_mode in ('never','date','count')),
  end_date date,
  end_count int,
  rotation text not null default 'order' check (rotation in ('order','random')),
  next_version int not null default 0,
  used_versions int[] not null default '{}',
  status text not null default 'active' check (status in ('active','paused','stopped','ended','pending_approval')),
  next_run_at timestamptz,
  runs int not null default 0,
  last_run_at timestamptz,
  last_skip_at timestamptz,
  last_error text,
  delete_after_hours int,
  pin boolean not null default false,
  pin_notify boolean not null default false,
  unpin_after_hours int,
  created_by bigint references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists repeat_series_due on repeat_series(next_run_at) where status = 'active';
create index if not exists repeat_series_ws on repeat_series(workspace_id);

create table if not exists repeat_versions (
  id bigserial primary key,
  series_id bigint not null references repeat_series(id) on delete cascade,
  position int not null,
  body text not null default '',
  media_id bigint references media(id) on delete set null,
  buttons jsonb not null default '[]',
  unique (series_id, position)
);

alter table broadcasts add column if not exists series_id bigint references repeat_series(id) on delete set null;
alter table broadcasts add column if not exists run_date date;
alter table broadcasts add column if not exists version_pos int;
alter table broadcasts add column if not exists delete_after_hours int;
alter table broadcasts add column if not exists pin boolean not null default false;
alter table broadcasts add column if not exists pin_notify boolean not null default false;
alter table broadcasts add column if not exists unpin_after_hours int;
create unique index if not exists broadcasts_series_run on broadcasts(series_id, run_date) where series_id is not null;

alter table deliveries drop constraint if exists deliveries_action_check;
alter table deliveries add constraint deliveries_action_check check (action in ('send','edit','delete','pin','unpin'));
alter table deliveries add column if not exists message_id2 bigint;
-- One automatic delete / pin / unpin per sent message (the sender queues them after each send, marked extra.auto; a
-- retried send must not add another). Manual Pin and Delete from the message list are not limited by this.
create unique index if not exists deliveries_auto_once on deliveries(broadcast_id, action, chat_id, message_id) where (extra->>'auto') is not null and broadcast_id is not null and message_id is not null;

-- Voice / round video conversions that failed (or were refused because ffmpeg is missing): support and Admin → System.
create table if not exists media_conversions (
  id bigserial primary key,
  workspace_id bigint not null references workspaces(id) on delete cascade,
  kind text not null,
  ok boolean not null default false,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists media_conversions_ws on media_conversions(workspace_id, created_at desc);

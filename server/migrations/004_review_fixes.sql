-- Fixes from the pre-launch review.

-- Buttons keep their order (they used to sort by a random code when saved together).
alter table links add column position int not null default 0;
create index if not exists links_step on links(step_id, position);
create index if not exists links_broadcast on links(broadcast_id, position);

-- A channel or group can be connected to only one Castvoo workspace at a time.
-- (Two workspaces would both post into it and both count its members.)
create unique index if not exists connections_one_live_chat on connections(tg_chat_id) where kind <> 'bot' and status <> 'removed';

-- Member counts refresh in turns (oldest first) instead of always the first 200.
alter table connections add column counts_at timestamptz;

-- When each country's exchange rate was last changed, so the admin can see stale rates.
alter table countries add column rate_updated_at timestamptz not null default now();

-- The hourly clean-up deletes old deliveries by date.
create index if not exists deliveries_created on deliveries(created_at);

-- Jobs that must run on one server at a time (for example the sales emails).
create table if not exists job_locks (
  name text primary key,
  locked_until timestamptz not null default now()
);

-- "📲 Send a test to my Telegram" in the Welcome Flow builder (services/flow-test.js).
-- A test plays a flow to the owner's own Telegram through the flow's own bot, with every wait shortened to 3 seconds.
-- It lives only in this table: it never makes subscribers, runs, deliveries, clicks, replies, join requests or meter
-- counts, so it can never touch real people's runs, the stats or the plan's meters.
--   code      random; in the test's Start link (t.me/<bot>?start=cvt_<code>), its Reply buttons (cvt:<code>:<button id>)
--             and its Link buttons (/lt/<code>/<button id>)
--   flow      what was tested (the builder's steps as checked by services/flows.js cleanFlow, version A of the welcome)
--   state     where the test is (services/flow-test.js run())
--   status    need_start  waiting for them to open the bot and tap Start (Telegram: a bot can't message someone first)
--             running     playing (due_at: the next 3-second wait or reminder)
--             waiting     waiting for them to tap Start or a button in Telegram
--             done | stopped | expired (30 minutes without anything happening)

create table if not exists flow_tests (
  id bigserial primary key,
  code text not null unique,
  workspace_id bigint not null references workspaces(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  connection_id bigint not null references connections(id) on delete cascade,
  sequence_id bigint references sequences(id) on delete set null,
  tg_user_id bigint not null,
  first_name text,
  flow jsonb not null,
  state jsonb not null default '{}'::jsonb,
  status text not null default 'need_start' check (status in ('need_start','running','waiting','done','stopped','expired')),
  due_at timestamptz,
  sent int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists flow_tests_due on flow_tests(due_at) where status = 'running';
create index if not exists flow_tests_user on flow_tests(user_id, created_at);
create index if not exists flow_tests_open on flow_tests(connection_id, tg_user_id) where status in ('need_start','running','waiting');

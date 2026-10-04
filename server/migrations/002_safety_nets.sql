-- Safety nets found by the end-to-end tests (see docs/CHANGES-FROM-TESTS.md).

-- A bot can be live in only ONE workspace. Two workspaces pasting the same token at the same
-- moment used to both succeed, and then fight over the bot's webhook.
create unique index connections_one_live_bot on connections(tg_chat_id) where kind = 'bot' and status <> 'removed';

-- A subscriber gets each broadcast at most once, even if the broadcast is queued twice
-- (for example by two servers at the same moment). The queue inserts use "on conflict do nothing".
create unique index deliveries_once_per_broadcast on deliveries(broadcast_id, subscriber_id)
  where action = 'send' and broadcast_id is not null and subscriber_id is not null;

-- Who used which coupon. Before this, "already used" was checked on workspaces.coupon_id,
-- which is cleared when the discount runs out, so the same code could be used again.
create table coupon_redemptions (
  offer_id int not null references offers(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  workspace_id bigint references workspaces(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (offer_id, user_id)
);

-- The sender now marks a message 'sending' while it is in flight (claimed with FOR UPDATE SKIP LOCKED).
-- Before, two servers whose lease overlapped (slow batch, long 429 pause) could both pick the same
-- queued rows and send them twice. sent_at holds the claim time while the status is 'sending'.
alter table deliveries drop constraint deliveries_status_check;
alter table deliveries add constraint deliveries_status_check check (status in ('queued','sending','sent','failed','blocked','skipped'));
create index deliveries_sending on deliveries(sent_at) where status = 'sending';

-- Missing indexes on hot paths (measured: with 200k delivery rows, the daily-cap check for 2,000
-- subscribers took 22 s instead of 50 ms, and deleting 1,000 subscribers took 17 s instead of 0.2 s,
-- because every foreign-key check scanned the whole deliveries table).
create index deliveries_subscriber on deliveries(subscriber_id);                      -- daily cap, FK "on delete set null"
create index deliveries_step on deliveries(step_id) where step_id is not null;        -- follow-up stats, FK when steps are deleted
create index deliveries_due on deliveries(due_at) where status = 'queued';            -- sender.tick: only rows that are due
create index sequence_runs_subscriber on sequence_runs(subscriber_id);                -- stop follow-ups on block/stop, FK cascade
create index clicks_subscriber on clicks(subscriber_id, created_at) where subscriber_id is not null; -- "clicked / no clicks in N days" audiences
create index links_broadcast on links(broadcast_id) where broadcast_id is not null;   -- FK cascade, broadcast reports
create index links_step on links(step_id) where step_id is not null;                  -- FK cascade, follow-up buttons

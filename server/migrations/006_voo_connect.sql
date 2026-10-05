-- Voo Connect (VooSquare login, affiliate hand-off, money events). See docs/INTEGRATIONS.md → VooSquare.

-- VooSquare's referral code for the person (saved once at the first Voo ID login, never changed).
alter table users add column if not exists voo_ref text;
alter table users add column if not exists voo_linked_at timestamptz;

-- Events now have stable ids (cv_pay_<wallet_tx id>, ...): the same event is queued once, however often the code runs.
-- Rows from before this migration had random ids, so they never collide.
create unique index if not exists outbox_event_id on outbox((payload->>'event_id')) where kind = 'voosquare';
-- Events VooSquare refused for good (or that the kit found invalid) are kept for the team to look at, not retried.
alter table outbox add column if not exists failed_at timestamptz;
drop index if exists outbox_due;
create index outbox_due on outbox(next_at) where sent_at is null and failed_at is null;

-- A disputed (charged back) top-up: when it was recorded, so a repeated webhook never reverses commission twice.
alter table payments add column if not exists disputed_at timestamptz;
alter table payments add column if not exists dispute_ref text;

-- The hourly "follow-up messages sent" activity event reads sent follow-up deliveries by time.
create index if not exists deliveries_steps_sent on deliveries(sent_at) where status = 'sent' and step_id is not null;

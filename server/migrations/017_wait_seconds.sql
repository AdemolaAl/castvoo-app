-- Wait timers in seconds (Welcome Flows and auto follow-ups): "Send right away", "Wait 2 seconds" ... "Wait 30 days".
--   sequence_steps.delay_seconds   the wait before this step, in seconds (all code reads and writes this).
--   sequence_steps.delay_minutes   kept for older code and exports: whole minutes of the same wait (rounded down).
-- A row written with only delay_minutes (older code, a hand-made insert) gets delay_seconds = delay_minutes * 60.
--
-- Telegram's 5-minute window after a join request (see services/flows.js):
--   join_requests.hold_position   "let them in after this step": the last message inside the window, so approving the
--                                 request (which ends the window) waits until the quick messages are sent.
--   join_requests.approve_at      when the held request is let in at the latest (the sender brings it forward).
--   deliveries.join_request_id    a quick step sent to someone who asked to join but has not tapped Start yet.
--   deliveries.then_approve       let the held request in once this delivery is done (sent or failed).

alter table sequence_steps add column if not exists delay_seconds integer;
update sequence_steps set delay_seconds = delay_minutes * 60 where delay_seconds is null;

create or replace function sequence_steps_delay_sync() returns trigger language plpgsql as $$
begin
  if new.delay_seconds is null then
    new.delay_seconds := coalesce(new.delay_minutes, 0) * 60;
  elsif tg_op = 'UPDATE' and new.delay_seconds is not distinct from old.delay_seconds and new.delay_minutes is distinct from old.delay_minutes then
    -- Older code changed only the minutes.
    new.delay_seconds := coalesce(new.delay_minutes, 0) * 60;
  end if;
  new.delay_minutes := new.delay_seconds / 60;
  return new;
end $$;

drop trigger if exists sequence_steps_delay_sync on sequence_steps;
create trigger sequence_steps_delay_sync before insert or update on sequence_steps
  for each row execute function sequence_steps_delay_sync();

alter table sequence_steps alter column delay_seconds set not null;
alter table sequence_steps drop constraint if exists sequence_steps_delay_seconds_check;
alter table sequence_steps add constraint sequence_steps_delay_seconds_check check (delay_seconds >= 0 and delay_seconds <= 31536000);

alter table join_requests add column if not exists hold_position int;
alter table join_requests add column if not exists approve_at timestamptz;
create index if not exists join_requests_held on join_requests(approve_at) where status = 'pending' and approve_at is not null;

alter table deliveries add column if not exists join_request_id bigint;
alter table deliveries add column if not exists then_approve boolean not null default false;

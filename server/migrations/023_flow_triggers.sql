-- The simplest flow builder: every message says WHEN it comes (services/flows.js "Triggers").
--   sequence_steps.trigger_type    after_previous  right after the message above (was: no wait)
--                                  wait            after a wait (sequence_steps.delay_seconds, as before)
--                                  on_start        the moment they tap Start in the bot
--                                  on_button       when they tap a button of a message above (trigger_button)
--                                  no_response     a reminder if they have not tapped Start / a button of the message above
--                                                  within delay_seconds
--   sequence_steps.trigger_button  the stable id of the button (links.button_id) an on_button step answers
--   sequence_steps.action_start_flow_id  after this message is sent, the person also starts that flow (same bot)
--   links.kind       link (a web link, tracked through /l/<code>) | reply (a Telegram callback button, no URL)
--   links.button_id  stable id of a button inside its flow (kept when the text or the order changes)
--   flow_step_runs   one row per (person's run, step) for the steps that do not follow the run's pointer: no-response
--                    timers and button answers. The unique key makes a double tap send the answer once.
-- Old flows keep working: a step with a wait is 'wait', one without is 'after_previous'.

alter table sequence_steps add column if not exists trigger_type text not null default 'after_previous';
alter table sequence_steps drop constraint if exists sequence_steps_trigger_type_check;
alter table sequence_steps add constraint sequence_steps_trigger_type_check check (trigger_type in ('after_previous','wait','on_start','on_button','no_response'));
update sequence_steps set trigger_type = case when delay_seconds > 0 then 'wait' else 'after_previous' end where trigger_type = 'after_previous' and delay_seconds > 0;
alter table sequence_steps add column if not exists trigger_button text;
alter table sequence_steps add column if not exists action_start_flow_id bigint references sequences(id) on delete set null;
create index if not exists sequence_steps_start_flow on sequence_steps(action_start_flow_id) where action_start_flow_id is not null;

alter table links add column if not exists kind text not null default 'link';
alter table links drop constraint if exists links_kind_check;
alter table links add constraint links_kind_check check (kind in ('link','reply'));
alter table links add column if not exists button_id text;
update links set button_id = code where button_id is null;

-- Runs waiting for something the person does (tap Start, tap a button) are 'awaiting'.
alter table sequence_runs drop constraint if exists sequence_runs_status_check;
alter table sequence_runs add constraint sequence_runs_status_check check (status in ('active','waiting','awaiting','done','stopped'));
create index if not exists sequence_runs_awaiting on sequence_runs(subscriber_id) where status = 'awaiting';

create table if not exists flow_step_runs (
  id bigserial primary key,
  run_id bigint not null references sequence_runs(id) on delete cascade,
  step_id bigint not null references sequence_steps(id) on delete cascade,
  status text not null default 'scheduled' check (status in ('scheduled','waiting_start','sent','skipped','cancelled')),
  due_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  done_at timestamptz,
  armed_active boolean not null default false,  -- a reminder: the person had already tapped Start when it was set (so Start does not cancel it)
  unique (run_id, step_id)
);
create index if not exists flow_step_runs_due on flow_step_runs(due_at) where status = 'scheduled';
create index if not exists flow_step_runs_step on flow_step_runs(step_id, status);

-- "Start another flow" is on Growth and up (plans that have click conditions get it).
update plans set features = features || '["start_another_flow"]'::jsonb
  where features @> '["condition_clicked"]'::jsonb and not features @> '["start_another_flow"]'::jsonb;

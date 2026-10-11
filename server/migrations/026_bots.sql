-- Bots (docs/BOTS.md): one "🤖 Bots" section for Welcome bots (join requests, the Welcome Flows made before) and
-- Chat bots (someone opens the customer's own bot and taps Start). Same tables and the same builder as Welcome Flows.
--   sequences.trigger_type 'bot_start'  a Chat bot: starts when someone opens t.me/<bot>?start=<trigger_value>
--                                       (and, when is_default, a plain /start with no code)
--   sequences.is_default    this Chat bot also answers a plain Start on its Telegram bot (one live per Telegram bot)
--   sequences.bot_type      what the bot was made as (welcome, join_check, lead_magnet, menu, lead_questions, referral,
--                           custom): shown in the list; plan gating looks at the steps themselves
--   sequence_steps.step_type  message (as before) | check_join (channel link + "I've joined ✅", checked with
--                           getChatMember) | ask (asks a question, waits for the typed answer) | referral (their own
--                           invite link and progress)
--   sequence_steps.config   the step type's settings (services/bots.js cleanStepConfig)
--   sequence_steps.trigger_type 'on_goal'  the reward: comes when they reach their invite goal (a referral step above)
--   sequence_runs.sent_position  the check / question this run already sent and now waits on (never sent twice)
--   bot_answers             answers to "Ask a question" steps, one per (bot, step, person); hidden = over the plan's
--                           monthly answers (+10% grace): kept, shown again next month or after an upgrade
--   bot_invites             each person's own invite code per referral bot (t.me/<bot>?start=r_<code>)
--   bot_referrals           who invited whom; counted = new to that Telegram bot, not a bot, not themselves, at most
--                           50 counted per inviter a day (reason says why one did not count)
--   deliveries.extra        what kind of bot message a queued row is (reminder, branding, ...)

alter table sequences drop constraint if exists sequences_trigger_type_check;
alter table sequences add constraint sequences_trigger_type_check check (trigger_type in ('start','start_tag','join_request','tag','bot_start'));
alter table sequences add column if not exists is_default boolean not null default false;
alter table sequences add column if not exists bot_type text;
update sequences set bot_type = 'welcome' where trigger_type = 'join_request' and bot_type is null;
create unique index if not exists sequences_one_live_bot_code on sequences(connection_id, lower(trigger_value))
  where trigger_type = 'bot_start' and active;
create unique index if not exists sequences_one_live_default_bot on sequences(connection_id)
  where trigger_type = 'bot_start' and active and is_default;
create index if not exists sequences_bot_start on sequences(connection_id, trigger_type) where trigger_type = 'bot_start';

alter table sequence_steps add column if not exists step_type text not null default 'message';
alter table sequence_steps drop constraint if exists sequence_steps_step_type_check;
alter table sequence_steps add constraint sequence_steps_step_type_check check (step_type in ('message','check_join','ask','referral'));
alter table sequence_steps add column if not exists config jsonb not null default '{}'::jsonb;
alter table sequence_steps drop constraint if exists sequence_steps_trigger_type_check;
alter table sequence_steps add constraint sequence_steps_trigger_type_check check (trigger_type in ('after_previous','wait','on_start','on_button','no_response','on_goal'));

alter table sequence_runs add column if not exists sent_position int;

create table if not exists bot_answers (
  id bigserial primary key,
  workspace_id bigint not null references workspaces(id) on delete cascade,
  sequence_id bigint not null references sequences(id) on delete cascade,
  step_id bigint references sequence_steps(id) on delete set null,
  subscriber_id bigint not null references subscribers(id) on delete cascade,
  question text not null default '',
  label text not null default '',
  answer_type text not null default 'text' check (answer_type in ('text','number','email','phone','choice')),
  answer text not null,
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists bot_answers_one on bot_answers(sequence_id, step_id, subscriber_id) where step_id is not null;
create index if not exists bot_answers_ws_month on bot_answers(workspace_id, created_at);
create index if not exists bot_answers_seq on bot_answers(sequence_id, created_at desc);

create table if not exists bot_invites (
  code text primary key,
  workspace_id bigint not null references workspaces(id) on delete cascade,
  sequence_id bigint not null references sequences(id) on delete cascade,
  subscriber_id bigint not null references subscribers(id) on delete cascade,
  reached_at timestamptz,
  created_at timestamptz not null default now(),
  unique (sequence_id, subscriber_id)
);

create table if not exists bot_referrals (
  id bigserial primary key,
  workspace_id bigint not null references workspaces(id) on delete cascade,
  sequence_id bigint not null references sequences(id) on delete cascade,
  connection_id bigint not null references connections(id) on delete cascade,
  referrer_id bigint not null references subscribers(id) on delete cascade,
  referred_id bigint references subscribers(id) on delete cascade,
  referred_tg_user_id bigint not null,
  counted boolean not null default false,
  reason text,
  created_at timestamptz not null default now(),
  unique (sequence_id, referred_tg_user_id)
);
create index if not exists bot_referrals_referrer on bot_referrals(referrer_id, created_at) where counted;
create index if not exists bot_referrals_seq on bot_referrals(sequence_id, created_at desc);

alter table deliveries add column if not exists extra jsonb;

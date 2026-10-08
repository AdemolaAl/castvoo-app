-- Welcome Flows, the Free plan and the new prices (pricing recommendation of 8 Oct 2026).
-- Welcome Flows are built on the existing follow-up tables: a flow is a sequence with trigger_type 'join_request'.
-- Old join-request follow-ups keep working and simply show up as Welcome Flows.

-- ---------- Plans: new limits and features ----------
alter table plans drop constraint if exists plans_subscribers_check;
alter table plans add constraint plans_subscribers_check check (subscribers >= 0);
alter table plans add column if not exists join_requests int not null default 5000 check (join_requests >= -1);  -- per calendar month, -1 = unlimited
alter table plans add column if not exists flows int not null default 3 check (flows >= -1);                       -- Welcome Flows, -1 = unlimited
alter table plans add column if not exists flow_steps int not null default 5 check (flow_steps >= -1);             -- messages per flow, -1 = unlimited
alter table plans add column if not exists branding boolean not null default false;                                -- "Free welcome bot by Castvoo.com" line
alter table plans add column if not exists features jsonb not null default '[]';

-- Grandfathering: people paying today keep their AI writes while they stay on the same plan,
-- and the new join-request meter only starts for them after the period they already paid for.
alter table workspaces add column if not exists legacy_plan_code text;
alter table workspaces add column if not exists legacy_ai_writes int;
alter table workspaces add column if not exists legacy_until timestamptz;
update workspaces w set legacy_plan_code = w.plan_code, legacy_ai_writes = p.ai_writes, legacy_until = w.period_end
  from plans p where p.code = w.plan_code and w.paid_ever and w.plan_status = 'active';

-- When a plan ends for lack of money the workspace drops to Free (not paused). We remember the plan it had,
-- so a top-up that covers it starts it again by itself (like a paused plan did before).
alter table workspaces add column if not exists dropped_from text;
alter table workspaces add column if not exists dropped_cycle text;
alter table workspaces add column if not exists dropped_at timestamptz;
-- Join-request meter emails (80% and 100%), at most once each per month: 'YYYY-MM:80'.
alter table workspaces add column if not exists join_alert text;

insert into plans(code, name, tagline, price_month_cents, price_year_cents, connections, subscribers, ai_writes, seats, bullets, popular, sort, join_requests, flows, flow_steps, branding, features)
values ('free', 'Free', 'Welcome everyone who asks to join your channel.', 0, 0, 1, 0, 0, 1,
  '["1 channel or group + your welcome bot", "500 join requests a month", "1 welcome message", "Auto-approve join requests"]', false, 0, 500, 1, 1, true,
  '["auto_approve","welcome_message"]')
on conflict (code) do nothing;

update plans set join_requests = 5000, flows = 3, flow_steps = 5, branding = false,
  features = '["auto_approve","welcome_message","welcome_flows","tap_to_start","broadcasts","schedule","drips","tracked_buttons","basic_stats","ai"]'
  where code = 'starter' and features = '[]';
update plans set join_requests = 30000, flows = 15, flow_steps = 20, branding = false,
  features = '["auto_approve","welcome_message","welcome_flows","tap_to_start","broadcasts","schedule","drips","tracked_buttons","basic_stats","ai","ab_welcome_2","condition_clicked","audiences","start_links","flow_funnel_stats"]'
  where code = 'growth' and features = '[]';
update plans set join_requests = 150000, flows = -1, flow_steps = -1, branding = false,
  features = '["auto_approve","welcome_message","welcome_flows","tap_to_start","broadcasts","schedule","drips","tracked_buttons","basic_stats","ai","ab_welcome_2","condition_clicked","audiences","start_links","flow_funnel_stats","ab_welcome_4","tag_branching","csv_export","onboarding_call"]'
  where code = 'scale' and features = '[]';
-- Any other plan the team made gets the Growth features (it was sold with "everything").
update plans set features = '["auto_approve","welcome_message","welcome_flows","tap_to_start","broadcasts","schedule","drips","tracked_buttons","basic_stats","ai","ab_welcome_2","condition_clicked","audiences","start_links","flow_funnel_stats"]'
  where features = '[]';

-- New limits, only where the team has not changed the seeded numbers.
update plans set connections = 2 where code = 'starter' and connections = 1;
update plans set ai_writes = 150 where code = 'starter' and ai_writes = 300;
update plans set ai_writes = 600 where code = 'growth' and ai_writes = 2000;
update plans set ai_writes = 1500 where code = 'scale' and ai_writes = 5000;
update plans set bullets = '["2 bots, channels or groups", "5,000 bot subscribers", "5,000 join requests a month", "3 Welcome Flows, 5 steps each", "Broadcasts and auto follow-ups", "150 AI writes a month"]'
  where code = 'starter' and bullets = '["1 bot, channel or group", "5,000 subscribers", "Unlimited broadcasts", "Auto follow-ups", "300 AI writes a month", "Tracked clicks"]'::jsonb;
update plans set bullets = '["5 bots, channels or groups", "25,000 bot subscribers", "30,000 join requests a month", "15 Welcome Flows, 20 steps each", "A/B welcome and click conditions", "600 AI writes a month"]'
  where code = 'growth' and bullets = '["5 bots, channels or groups", "25,000 subscribers", "Everything in Starter", "Audiences and start links", "2,000 AI writes a month", "3 team seats"]'::jsonb;
update plans set bullets = '["20 bots, channels or groups", "100,000 bot subscribers", "150,000 join requests a month", "Unlimited Welcome Flows and steps", "A/B welcome with 4 versions", "1,500 AI writes a month"]'
  where code = 'scale' and bullets = '["20 bots, channels or groups", "100,000 subscribers", "Everything in Growth", "5,000 AI writes a month", "10 team seats", "Priority support"]'::jsonb;

-- Trial: 7 days of Growth, 50 AI writes, 3,000 join requests, then Free.
update settings set value = value || '{"ai_writes": 50, "join_requests": 3000, "on_end": "free"}'::jsonb
  where key = 'trial' and (value->>'ai_writes')::int = 100;
update settings set value = value || '{"join_requests": 3000, "on_end": "free"}'::jsonb
  where key = 'trial' and (value->'join_requests') is null;
update settings set value = value || '{"limit_grace_pct": 10}'::jsonb where key = 'billing' and (value->'limit_grace_pct') is null;

-- The Terms and Refund Policy describe the Free plan now.
update settings set value = '"8 October 2026"'::jsonb where key = 'legal_updated' and value = '"3 October 2026"'::jsonb;

-- Top-up bonus at $1,000: +$100 → +$60.
update offers set bonus_cents = 6000, title = 'Top up $1,000, get $60 extra'
  where kind = 'topup_bonus' and min_topup_cents = 100000 and bonus_cents = 10000;

-- FAQ numbers (only the seeded sentence; edited FAQs are left alone).
update site_content set value = replace(value, '300 on Starter, 2,000 on Growth and 5,000 on Scale', '150 on Starter, 600 on Growth and 1,500 on Scale. The Free plan has no AI writes')
  where key = 'faq';

update site_content set value = 'Start free with a welcome bot for your channel. Paid plans add follow-ups, broadcasts, tracked clicks and Cas the AI helper. No add-on fees.'
  where key = 'pricing_subtitle' and value = 'Every plan has unlimited broadcasts, auto follow-ups, tracked clicks and Cas the AI helper. No add-on fees.';

update site_content set value = 'Simple prices. *Start free.*' where key = 'pricing_title' and value = 'Simple prices. Everything included.';

-- ---------- Welcome Flows ----------
-- How people are let in: at once, after the welcome (default), after they tap Start in the bot, or by hand.
alter table sequences add column if not exists approve_mode text not null default 'after_welcome';
alter table sequences add constraint sequences_approve_mode_check check (approve_mode in ('instant','after_welcome','tap','manual'));
update sequences set approve_mode = case when approve_join then 'after_welcome' else 'manual' end where trigger_type = 'join_request';
-- A "Tap to start" button on the welcome (opens the bot, so later steps can reach them).
alter table sequences add column if not exists start_button boolean not null default false;
alter table sequences add column if not exists start_label text not null default '';
-- Optional: the flow's own invite link (people who join through it get this flow).
alter table sequences add column if not exists invite_link text;
-- Switched off because the plan got smaller (the owner picks what runs again).
alter table sequences add column if not exists paused_by_plan boolean not null default false;
alter table sequences add column if not exists updated_at timestamptz not null default now();

-- One live flow per channel (and per invite link). Older duplicates are switched off (kept as drafts).
update sequences q set active = false where q.trigger_type = 'join_request' and q.active and exists (
  select 1 from sequences o where o.trigger_type = 'join_request' and o.active and o.trigger_value = q.trigger_value
    and coalesce(o.invite_link, '') = coalesce(q.invite_link, '') and o.id < q.id);
create unique index if not exists sequences_one_live_flow on sequences(trigger_value, coalesce(invite_link, ''))
  where trigger_type = 'join_request' and active;

-- Steps: A/B versions of the first message (variant 0 = A, 1 = B ...), and a click condition.
alter table sequence_steps add column if not exists variant int not null default 0 check (variant between 0 and 3);
alter table sequence_steps add column if not exists condition text check (condition in ('clicked','not_clicked'));
alter table sequence_steps drop constraint if exists sequence_steps_sequence_id_position_key;
create unique index if not exists sequence_steps_pos_variant on sequence_steps(sequence_id, position, variant);

-- Buttons: two per row in Welcome Flows (null = one per row, as before).
alter table links add column if not exists row int;

-- Runs that wait for the person to tap Start (Telegram's 5-minute rule) are 'waiting', not retried every hour.
alter table sequence_runs drop constraint if exists sequence_runs_status_check;
alter table sequence_runs add constraint sequence_runs_status_check check (status in ('active','waiting','done','stopped'));
alter table sequence_runs add column if not exists variant int not null default 0;
create index if not exists sequence_runs_waiting on sequence_runs(subscriber_id) where status = 'waiting';

-- Every join request a flow handled: the meter, the funnel and the manual approval list.
create table if not exists join_requests (
  id bigserial primary key,
  workspace_id bigint not null references workspaces(id) on delete cascade,
  sequence_id bigint references sequences(id) on delete set null,
  connection_id bigint not null references connections(id) on delete cascade,   -- the bot that got it
  chat_id bigint not null,
  tg_user_id bigint not null,
  user_chat_id bigint,
  subscriber_id bigint references subscribers(id) on delete set null,
  first_name text not null default '',
  username text,
  invite_link text,
  step_id bigint references sequence_steps(id) on delete set null,
  variant int not null default 0,
  start_code text unique,
  status text not null default 'pending' check (status in ('pending','approved','declined','gone')),
  welcome text not null default 'none' check (welcome in ('none','sent','failed','skipped_limit','skipped_plan','skipped_off')),
  error text,
  requested_at timestamptz not null default now(),
  welcomed_at timestamptz,
  started_at timestamptz,
  decided_at timestamptz
);
-- The same person asking again while their request is still open is the same request (Telegram can resend updates).
create unique index if not exists join_requests_open on join_requests(chat_id, tg_user_id) where status = 'pending';
create index if not exists join_requests_ws on join_requests(workspace_id, requested_at);
create index if not exists join_requests_flow on join_requests(sequence_id, status);
create index if not exists join_requests_person on join_requests(connection_id, tg_user_id);

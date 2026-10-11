-- Cas Builder: build a Welcome Flow by chatting with Cas (services/cas-builder.js, public/js/cas-engine.js).
--   plans.cas_builds        new flows built with Cas Builder per calendar month (UTC); -1 = unlimited (fair use, see
--                           settings cas_builder.fair_use_monthly). On the Free plan the number is for the life of the
--                           workspace ("your first flow"). Editing an existing flow by chat never counts.
--   workspaces.cas_credits  extra builds bought from the wallet (Cas credits); used after the plan's builds.
--   cas_sessions            one row per chat with Cas Builder: the conversation, the draft flow (saved as you go, so it
--                           can be resumed), and whether it counted as a build (counted_at, paid_by plan | credit).
--   ai_usage.session_id     which Cas Builder session an AI call belongs to (kind 'cas_builder'), for cost per build.
--   wallet_tx kind 'cas_credits'  a Cas credits purchase (cash only; bonus credit is for plans).

alter table plans add column if not exists cas_builds int not null default 0;
update plans set cas_builds = 1 where code = 'free' and cas_builds = 0;
update plans set cas_builds = 10 where code = 'starter' and cas_builds = 0;
update plans set cas_builds = 50 where code = 'growth' and cas_builds = 0;
update plans set cas_builds = -1 where code = 'scale' and cas_builds = 0;

alter table workspaces add column if not exists cas_credits int not null default 0;

create table if not exists cas_sessions (
  id bigserial primary key,
  workspace_id bigint not null references workspaces(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  kind text not null default 'new' check (kind in ('new','edit')),
  flow_id bigint references sequences(id) on delete set null,
  status text not null default 'open' check (status in ('open','saved','closed')),
  state jsonb not null default '{}'::jsonb,
  turns jsonb not null default '[]'::jsonb,
  counted_at timestamptz,
  paid_by text check (paid_by in ('plan','credit')),
  rev int not null default 0,
  ai_calls int not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cas_sessions_ws on cas_sessions(workspace_id, created_at desc);
create index if not exists cas_sessions_counted on cas_sessions(workspace_id, counted_at) where counted_at is not null;
create index if not exists cas_sessions_open on cas_sessions(user_id, updated_at desc) where status = 'open';

alter table ai_usage add column if not exists session_id bigint;
create index if not exists ai_usage_session on ai_usage(session_id) where session_id is not null;

alter table wallet_tx drop constraint if exists wallet_tx_kind_check;
alter table wallet_tx add constraint wallet_tx_kind_check check (kind in ('topup','bonus','plan','refund','referral_credit','adjustment','chargeback','cas_credits'));

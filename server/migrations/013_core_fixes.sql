-- Engineering, billing and audit fixes (ENG-2/3/6/9/15/18/19, AUD-1/5/8, SEC-2/3/11). Engineer C uses 014.
-- Never edits older migrations.

-- ENG-2: the join-request dedupe query can use an index, and the meter is one counter row per workspace and
-- period (incremented in the same statement that decides whether welcomes are paused, ENG-26).
create index if not exists join_requests_recent on join_requests(chat_id, tg_user_id, requested_at desc);
create table if not exists join_meter (
  workspace_id bigint not null references workspaces(id) on delete cascade,
  since timestamptz not null,
  used int not null default 0,
  primary key (workspace_id, since)
);
-- ENG-3: Telegram's own `date` of the request, so a redelivery (same date) is told apart from a new request.
alter table join_requests add column if not exists tg_date bigint;

-- ENG-6: one live flow per chat (and invite link) per workspace. The old index was global, so a flow left live by a
-- workspace that removed the channel blocked (and was shown to) the next workspace that connected it.
update sequences q set active = false, paused_by_plan = false
  where q.trigger_type = 'join_request' and q.active and not exists (
    select 1 from connections c where c.workspace_id = q.workspace_id and c.kind <> 'bot' and c.status <> 'removed' and c.tg_chat_id::text = q.trigger_value);
drop index if exists sequences_one_live_flow;
create unique index if not exists sequences_one_live_flow_ws on sequences(workspace_id, trigger_value, coalesce(invite_link, ''))
  where trigger_type = 'join_request' and active;

-- ENG-15: open threads a person on the team already answered stay with the team after the AI goes live.
update support_threads t set ai_paused = true, ai_paused_reason = 'staff_reply'
  where t.status <> 'closed' and not t.ai_paused and exists (
    select 1 from support_messages m where m.thread_id = t.id and m.author_type = 'staff' and not m.internal);

-- ENG-18: a rejected (or failed) top-up's bank reference can be sent again on a new top-up.
drop index if exists payments_proof_ref;
create unique index if not exists payments_proof_ref_open on payments(method_key, lower(proof_ref))
  where proof_ref is not null and status in ('pending','paid');

-- AUD-5: a chargeback takes the disputed money out of the wallet, so the wallet can go below zero.
alter table workspaces drop constraint if exists workspaces_wallet_cents_check;
alter table wallet_tx drop constraint if exists wallet_tx_kind_check;
alter table wallet_tx add constraint wallet_tx_kind_check check (kind in ('topup','bonus','plan','refund','referral_credit','adjustment','chargeback'));
alter table payments add column if not exists chargeback_cents bigint;
alter table payments add column if not exists dispute_won_at timestamptz;

-- AUD-1: one commission per payment. Who got the commission for each plan payment (castvoo_referral | voosquare | none),
-- and on what base (cash minus the processor fee when known). Processor fees per top-up when the provider reports them.
alter table wallet_tx add column if not exists commission_to text;
alter table wallet_tx add column if not exists commission_base_cents bigint;
alter table payments add column if not exists fee_cents bigint;
alter table payments add column if not exists payer_fp text;   -- SEC-2: hashed payer fingerprint (card signature / account)
create index if not exists payments_payer_fp on payments(payer_fp) where payer_fp is not null;
-- When the Castvoo referral was recorded (first attribution wins against a later VooSquare affiliate link).
alter table users add column if not exists referred_at timestamptz;
update users set referred_at = created_at where referred_by is not null and referred_at is null;

-- SEC-2: self-referral signals. Earnings that look like a self-referral are held for review instead of paid.
alter table referral_ledger add column if not exists held boolean not null default false;
alter table referral_ledger add column if not exists hold_reason text;
alter table referral_ledger add column if not exists cancelled_at timestamptz;  -- a held earning Finance cancelled (stays held, never counts)
create table if not exists user_ips (
  user_id bigint not null references users(id) on delete cascade,
  ip text not null,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (user_id, ip)
);
create index if not exists user_ips_ip on user_ips(ip);
insert into user_ips(user_id, ip, first_seen, last_seen)
  select user_id, ip, min(created_at), max(created_at) from sessions where ip is not null and ip <> '' group by user_id, ip
  on conflict do nothing;

-- AUD-8: the flows the owner picked to keep live after a move to a smaller plan.
alter table workspaces add column if not exists keep_flow_ids bigint[];

-- Money settings with safe defaults (AUD-1, AUD-6). Admin → Settings can change them.
update settings set value = value || '{"commission_cap_pct": 50, "yearly_cap_pct": 35, "first_attribution": true, "net_of_fees": true}'::jsonb
  where key = 'referral' and (value->'commission_cap_pct') is null;
update settings set value = value || '{"inactive_free_days": 365}'::jsonb
  where key = 'billing' and (value->'inactive_free_days') is null;

-- AUD-10: human reply times depend on the plan and on the team's hours (8am to 10pm WAT).
update settings set value = jsonb_set(jsonb_set(jsonb_set(value,
    '{handoff_eta,free}', '"within 24 hours"'),
    '{handoff_eta,paid}', '"within one business day (8am to 10pm WAT)"'),
    '{handoff_eta,priority}', '"within 4 business hours (8am to 10pm WAT)"')
  where key = 'support_ai' and value->'handoff_eta'->>'priority' = 'within about an hour';
update settings set value = value || '{"team_hours": {"start": 8, "end": 22, "tz": "Africa/Lagos", "label": "8am to 10pm WAT"}}'::jsonb
  where key = 'support_ai' and (value->'team_hours') is null;

-- AUD-3: there is no tag branching, and CSV export is on every plan: neither is a Scale feature.
update plans set features = (select coalesce(jsonb_agg(f), '[]'::jsonb) from jsonb_array_elements(features) f where f #>> '{}' not in ('tag_branching','csv_export'))
  where features @> '["tag_branching"]'::jsonb or features @> '["csv_export"]'::jsonb;

-- ENG-19: workspaces paused or cancelled under the old rules move to the Free plan (the new rule: a plan that
-- ends drops to Free). Same switch-offs as billing.dropToFree: the first live Welcome Flow keeps running.
-- Deleted accounts ("Deleted workspace", owner deleted) and purged workspaces stay as they are.
create temporary table _to_free on commit drop as
  select w.id, w.plan_status, w.plan_code, w.billing_cycle from workspaces w join users u on u.id = w.owner_user_id
  where exists (select 1 from plans where code = 'free') and w.purged_at is null and u.status = 'active'
    and (w.plan_status = 'paused' or (w.plan_status = 'cancelled' and coalesce(w.period_end, now()) <= now()));
update workspaces w set plan_code = 'free', plan_status = 'active', billing_cycle = 'month', period_end = null, trial_ends_at = null,
    cancel_at_period_end = false, pending_plan_code = null, pending_cycle = null, ai_used = 0, ai_period_start = now(), reminded_at = null,
    dropped_from = case when t.plan_status = 'paused' and t.plan_code <> 'free' then t.plan_code else null end,
    dropped_cycle = case when t.plan_status = 'paused' then t.billing_cycle else null end, dropped_at = now()
  from _to_free t where t.id = w.id;
update sequences q set active = false, paused_by_plan = true
  where q.workspace_id in (select id from _to_free) and q.active and (q.trigger_type <> 'join_request' or q.id <> (
    select min(x.id) from sequences x where x.workspace_id = q.workspace_id and x.trigger_type = 'join_request' and x.active));
update broadcasts set status = 'draft' where workspace_id in (select id from _to_free) and status in ('scheduled','pending_approval');

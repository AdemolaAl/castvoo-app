-- Castvoo database, version 1.
-- Money is always stored in US cents (bigint). $49.00 = 4900.
-- Every table has created_at. Times are timestamptz (UTC).

create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table feature_flags (
  key text primary key,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table site_content (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create table plans (
  id serial primary key,
  code text not null unique,
  name text not null,
  tagline text not null default '',
  price_month_cents bigint not null check (price_month_cents >= 0),
  price_year_cents bigint not null check (price_year_cents >= 0),
  connections int not null check (connections > 0),
  subscribers int not null check (subscribers > 0),
  ai_writes int not null check (ai_writes >= 0),
  seats int not null check (seats > 0),
  bullets jsonb not null default '[]',
  popular boolean not null default false,
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create table payment_methods (
  key text primary key,
  provider text not null check (provider in ('paystack','flutterwave','crypto')),
  label text not null,
  detail text not null default '',
  color text not null default '#2F6BFF',
  icon text not null default '$',
  coin text,
  active boolean not null default true,
  sort int not null default 0
);

create table countries (
  code text primary key,
  name text not null,
  flag text not null default '🌍',
  currency text not null default 'USD',
  usd_rate numeric not null default 1 check (usd_rate > 0),
  methods jsonb not null default '[]',
  featured boolean not null default false,
  active boolean not null default true,
  sort int not null default 100
);

create table offers (
  id serial primary key,
  kind text not null check (kind in ('topup_bonus','coupon','banner')),
  title text not null,
  description text not null default '',
  code text unique,
  percent int check (percent between 1 and 100),
  min_topup_cents bigint,
  bonus_cents bigint,
  months int not null default 1,
  max_uses int,
  uses int not null default 0,
  link_url text,
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table users (
  id bigserial primary key,
  email text unique,
  email_verified boolean not null default false,
  name text not null default '',
  tg_user_id bigint unique,
  tg_username text,
  google_sub text unique,
  voo_id text unique,
  country text references countries(code),
  staff_role text check (staff_role in ('owner','admin','finance','support','marketing','viewer')),
  status text not null default 'active' check (status in ('active','suspended','deleted')),
  ref_code text not null unique,
  referred_by bigint references users(id),
  marketing_opt_out boolean not null default false,
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);
create index users_referred_by on users(referred_by);
create index users_created on users(created_at);

create table sessions (
  token_hash text primary key,
  user_id bigint not null references users(id) on delete cascade,
  ip text,
  user_agent text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index sessions_user on sessions(user_id);

create table login_codes (
  id bigserial primary key,
  email text not null,
  code_hash text not null,
  attempts int not null default 0,
  used boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index login_codes_email on login_codes(email, created_at desc);

create table oauth_states (
  state text primary key,
  provider text not null,
  verifier text not null,
  data jsonb not null default '{}',
  expires_at timestamptz not null
);

create table workspaces (
  id bigserial primary key,
  name text not null,
  owner_user_id bigint not null references users(id),
  plan_code text not null references plans(code),
  billing_cycle text not null default 'month' check (billing_cycle in ('month','year')),
  plan_status text not null default 'trial' check (plan_status in ('trial','active','paused','cancelled')),
  trial_ends_at timestamptz,
  period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  pending_plan_code text references plans(code),
  pending_cycle text check (pending_cycle in ('month','year')),
  reminded_at timestamptz,
  coupon_id int references offers(id),
  coupon_months_left int not null default 0,
  timezone text not null default 'Africa/Lagos',
  wallet_cents bigint not null default 0 check (wallet_cents >= 0),
  bonus_cents bigint not null default 0 check (bonus_cents >= 0),
  ai_used int not null default 0,
  ai_period_start timestamptz not null default now(),
  daily_cap int not null default 0,
  require_approval boolean not null default false,
  ai_profile jsonb not null default '{}',
  paid_ever boolean not null default false,
  purged_at timestamptz,
  created_at timestamptz not null default now()
);
create index workspaces_owner on workspaces(owner_user_id);
create index workspaces_billing on workspaces(plan_status, period_end);

create table members (
  workspace_id bigint not null references workspaces(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  role text not null check (role in ('owner','sender','drafter')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index members_user on members(user_id);

create table invites (
  token text primary key,
  workspace_id bigint not null references workspaces(id) on delete cascade,
  email text not null,
  role text not null check (role in ('sender','drafter')),
  created_by bigint references users(id),
  accepted_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table connections (
  id bigserial primary key,
  workspace_id bigint not null references workspaces(id) on delete cascade,
  kind text not null check (kind in ('bot','channel','group')),
  tg_chat_id bigint not null,
  username text,
  title text not null default '',
  token_enc text,
  webhook_secret text,
  member_count int not null default 0,
  status text not null default 'active' check (status in ('active','error','removed')),
  last_error text,
  created_at timestamptz not null default now()
);
create unique index connections_unique_live on connections(workspace_id, kind, tg_chat_id) where status <> 'removed';
create index connections_chat on connections(tg_chat_id);

create table subscribers (
  id bigserial primary key,
  connection_id bigint not null references connections(id) on delete cascade,
  tg_user_id bigint not null,
  first_name text not null default '',
  username text,
  lang text,
  tz text,
  country text,
  source text,
  tags text[] not null default '{}',
  status text not null default 'active' check (status in ('active','blocked','stopped','joinreq')),
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (connection_id, tg_user_id)
);
create index subscribers_conn_status on subscribers(connection_id, status);
create index subscribers_source on subscribers(connection_id, source);

create table segments (
  id bigserial primary key,
  workspace_id bigint not null references workspaces(id) on delete cascade,
  name text not null,
  rules jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table media (
  id bigserial primary key,
  workspace_id bigint not null references workspaces(id) on delete cascade,
  kind text not null check (kind in ('photo','video','animation')),
  filename text not null,
  mime text not null,
  size_bytes bigint not null,
  path text not null,
  created_at timestamptz not null default now()
);

create table media_file_ids (
  media_id bigint not null references media(id) on delete cascade,
  bot_key text not null,
  file_id text not null,
  primary key (media_id, bot_key)
);

create table broadcasts (
  id bigserial primary key,
  workspace_id bigint not null references workspaces(id) on delete cascade,
  connection_id bigint not null references connections(id),
  segment_id bigint references segments(id) on delete set null,
  title text not null default '',
  body text not null,
  media_id bigint references media(id) on delete set null,
  buttons jsonb not null default '[]',
  include_stop boolean not null default true,
  send_mode text not null default 'now' check (send_mode in ('now','at','local9')),
  send_at timestamptz,
  status text not null default 'draft' check (status in ('draft','pending_approval','scheduled','sending','sent','cancelled','failed')),
  total int not null default 0,
  sent int not null default 0,
  failed int not null default 0,
  created_by bigint references users(id),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
create index broadcasts_ws on broadcasts(workspace_id, created_at desc);
create index broadcasts_due on broadcasts(status, send_at);

create table sequences (
  id bigserial primary key,
  workspace_id bigint not null references workspaces(id) on delete cascade,
  connection_id bigint not null references connections(id),
  name text not null,
  trigger_type text not null check (trigger_type in ('start','start_tag','join_request','tag')),
  trigger_value text,
  approve_join boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index sequences_ws on sequences(workspace_id);

create table sequence_steps (
  id bigserial primary key,
  sequence_id bigint not null references sequences(id) on delete cascade,
  position int not null,
  delay_minutes int not null default 0 check (delay_minutes >= 0),
  body text not null,
  media_id bigint references media(id) on delete set null,
  buttons jsonb not null default '[]',
  unique (sequence_id, position)
);

create table sequence_runs (
  id bigserial primary key,
  sequence_id bigint not null references sequences(id) on delete cascade,
  subscriber_id bigint not null references subscribers(id) on delete cascade,
  next_position int not null default 1,
  due_at timestamptz not null,
  status text not null default 'active' check (status in ('active','done','stopped')),
  created_at timestamptz not null default now(),
  unique (sequence_id, subscriber_id)
);
create index sequence_runs_due on sequence_runs(status, due_at);

-- One row per message to send. The sender worker drains this table.
create table deliveries (
  id bigserial primary key,
  workspace_id bigint not null,
  sender_key text not null,          -- 'bot:<connection id>' or 'platform'
  action text not null default 'send' check (action in ('send','edit','delete','pin')),
  broadcast_id bigint references broadcasts(id) on delete cascade,
  step_id bigint references sequence_steps(id) on delete set null,
  subscriber_id bigint references subscribers(id) on delete set null,
  chat_id bigint not null,
  priority int not null default 5,
  due_at timestamptz not null default now(),
  status text not null default 'queued' check (status in ('queued','sent','failed','blocked','skipped')),
  attempts int not null default 0,
  message_id bigint,
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index deliveries_queue on deliveries(sender_key, priority, due_at) where status = 'queued';
create index deliveries_broadcast on deliveries(broadcast_id, status);
create index deliveries_ws_sent on deliveries(workspace_id, sent_at) where status = 'sent';

create table sender_leases (
  sender_key text primary key,
  owner text not null,
  expires_at timestamptz not null
);

create table links (
  code text primary key,
  workspace_id bigint not null references workspaces(id) on delete cascade,
  broadcast_id bigint references broadcasts(id) on delete cascade,
  step_id bigint references sequence_steps(id) on delete cascade,
  label text not null default '',
  url text not null,
  created_at timestamptz not null default now()
);
create index links_ws on links(workspace_id, created_at desc);

create table clicks (
  id bigserial primary key,
  code text not null references links(code) on delete cascade,
  workspace_id bigint not null,
  subscriber_id bigint,
  created_at timestamptz not null default now()
);
create index clicks_code on clicks(code);
create index clicks_ws on clicks(workspace_id, created_at);

create table start_links (
  id bigserial primary key,
  connection_id bigint not null references connections(id) on delete cascade,
  tag text not null,
  created_at timestamptz not null default now(),
  unique (connection_id, tag)
);

create table replies (
  id bigserial primary key,
  workspace_id bigint not null,
  connection_id bigint not null,
  subscriber_id bigint,
  created_at timestamptz not null default now()
);
create index replies_ws on replies(workspace_id, created_at);

create table wallet_tx (
  id bigserial primary key,
  workspace_id bigint not null references workspaces(id) on delete cascade,
  kind text not null check (kind in ('topup','bonus','plan','refund','referral_credit','adjustment')),
  amount_cents bigint not null,
  cash_cents bigint not null default 0,
  bonus_part_cents bigint not null default 0,
  method text,
  ref text,
  note text not null default '',
  created_by bigint references users(id),
  created_at timestamptz not null default now()
);
create index wallet_tx_ws on wallet_tx(workspace_id, created_at desc);

create table payments (
  id bigserial primary key,
  workspace_id bigint not null references workspaces(id) on delete cascade,
  user_id bigint not null references users(id),
  provider text not null,
  method_key text not null,
  reference text not null unique,
  external_id text,
  checkout_url text,
  amount_cents bigint not null check (amount_cents > 0),
  bonus_cents bigint not null default 0,
  currency text not null default 'USD',
  amount_local numeric,
  coin text,
  txid text,
  status text not null default 'pending' check (status in ('pending','paid','failed','rejected')),
  reason text,
  reviewed_by bigint references users(id),
  paid_at timestamptz,
  created_at timestamptz not null default now()
);
create index payments_status on payments(status, created_at desc);
create unique index payments_txid on payments(coin, txid) where txid is not null;

create table referral_ledger (
  id bigserial primary key,
  user_id bigint not null references users(id),
  kind text not null check (kind in ('earning','use','withdrawal','reversal')),
  amount_cents bigint not null,
  from_workspace_id bigint references workspaces(id) on delete set null,
  rate int,
  settles_at timestamptz not null default now(),
  ref text,
  created_at timestamptz not null default now()
);
create index referral_ledger_user on referral_ledger(user_id);

create table withdrawals (
  id bigserial primary key,
  user_id bigint not null references users(id),
  amount_cents bigint not null check (amount_cents > 0),
  coin text not null check (coin in ('USDT','BTC')),
  address text not null,
  status text not null default 'requested' check (status in ('requested','paid','rejected')),
  txid text,
  reason text,
  processed_by bigint references users(id),
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

create table ai_usage (
  id bigserial primary key,
  workspace_id bigint not null,
  user_id bigint,
  kind text not null,
  writes int not null default 1,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  created_at timestamptz not null default now()
);
create index ai_usage_created on ai_usage(created_at);

create table knowledge (
  id serial primary key,
  title text not null,
  body text not null,
  active boolean not null default true,
  updated_by bigint references users(id),
  updated_at timestamptz not null default now()
);

create table support_threads (
  id bigserial primary key,
  workspace_id bigint references workspaces(id) on delete set null,
  user_id bigint not null references users(id),
  subject text not null default '',
  status text not null default 'open' check (status in ('open','pending','closed')),
  assigned_to bigint references users(id),
  unread_staff boolean not null default true,
  unread_user boolean not null default false,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index support_threads_status on support_threads(status, last_message_at desc);
create index support_threads_user on support_threads(user_id);

create table support_messages (
  id bigserial primary key,
  thread_id bigint not null references support_threads(id) on delete cascade,
  author_type text not null check (author_type in ('user','staff','system')),
  author_user_id bigint references users(id),
  author_name text not null default '',
  body text not null,
  internal boolean not null default false,
  via text not null default 'castvoo' check (via in ('castvoo','voosquare','email')),
  created_at timestamptz not null default now()
);
create index support_messages_thread on support_messages(thread_id, id);

create table email_templates (
  key text primary key,
  subject text not null,
  preheader text not null default '',
  body text not null,
  text_body text not null default '',
  updated_by bigint references users(id),
  updated_at timestamptz not null default now()
);

create table email_log (
  id bigserial primary key,
  user_id bigint references users(id) on delete set null,
  template text not null,
  to_email text not null,
  status text not null check (status in ('sent','failed','skipped')),
  provider_id text,
  error text,
  created_at timestamptz not null default now()
);
create index email_log_user_tpl on email_log(user_id, template);

create table audit_log (
  id bigserial primary key,
  actor_user_id bigint references users(id),
  action text not null,
  target text not null default '',
  data jsonb not null default '{}',
  ip text,
  created_at timestamptz not null default now()
);
create index audit_log_created on audit_log(created_at desc);

create table outbox (
  id bigserial primary key,
  kind text not null,
  payload jsonb not null,
  attempts int not null default 0,
  next_at timestamptz not null default now(),
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
create index outbox_due on outbox(next_at) where sent_at is null;

create table exports (
  token text primary key,
  user_id bigint not null references users(id) on delete cascade,
  data jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- "Add @CastvooBot to my channel": remembers which workspace asked, for 30 minutes.
create table connect_requests (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  workspace_id bigint not null references workspaces(id) on delete cascade,
  kind text not null check (kind in ('channel','group')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index connect_requests_user on connect_requests(user_id, expires_at);

-- "Link my Telegram": one-time tokens used with t.me/CastvooBot?start=link_<token>.
create table tg_link_tokens (
  token text primary key,
  user_id bigint not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz
);

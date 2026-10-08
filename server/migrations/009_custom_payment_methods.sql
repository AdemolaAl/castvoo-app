-- The team can add its own payment methods in Admin → Countries & payments: a bank account, a mobile money number,
-- a crypto wallet or anything else. These are "manual" methods: the customer sees the team's instructions and an
-- exact amount, pays, sends a reference and/or a screenshot, and Finance approves it by hand in Admin → Payments.

alter table payment_methods drop constraint if exists payment_methods_provider_check;
alter table payment_methods add constraint payment_methods_provider_check check (provider in ('paystack','flutterwave','crypto','manual'));

alter table payment_methods add column if not exists kind text not null default 'other';
alter table payment_methods add constraint payment_methods_kind_check check (kind in ('bank','mobile_money','crypto_wallet','other'));
alter table payment_methods add column if not exists instructions text not null default '';
-- The currency the customer pays in (null = US dollars) and local money per 1 US dollar
-- (null = use the rate of the customer's country when it has the same currency).
alter table payment_methods add column if not exists currency text;
alter table payment_methods add column if not exists usd_rate numeric check (usd_rate is null or usd_rate > 0);
alter table payment_methods add column if not exists min_cents bigint;
alter table payment_methods add column if not exists max_cents bigint;
-- What the customer sends as proof: 'off', 'optional' or 'required'.
alter table payment_methods add column if not exists proof_ref text not null default 'required' check (proof_ref in ('off','optional','required'));
alter table payment_methods add column if not exists proof_image text not null default 'optional' check (proof_image in ('off','optional','required'));
-- Where a manual method is offered: every country, or only the listed country codes.
alter table payment_methods add column if not exists all_countries boolean not null default false;
alter table payment_methods add column if not exists countries jsonb not null default '[]';
alter table payment_methods add column if not exists created_at timestamptz not null default now();
-- A manual method that old payments still point to is hidden instead of deleted, so their history keeps its name.
alter table payment_methods add column if not exists deleted_at timestamptz;

-- Proof sent by the customer for a manual payment, and when they pressed "I've paid".
alter table payments add column if not exists proof_ref text;
alter table payments add column if not exists proof_path text;
alter table payments add column if not exists proof_mime text;
alter table payments add column if not exists submitted_at timestamptz;
-- The same bank or wallet reference can't be used for two top-ups with the same method.
create unique index if not exists payments_proof_ref on payments(method_key, lower(proof_ref)) where proof_ref is not null;
create index if not exists payments_pending_method on payments(method_key, created_at) where status = 'pending';

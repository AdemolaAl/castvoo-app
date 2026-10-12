-- Subscriber packs for the Scale plan (Oct 2026): +50,000 bot subscribers for $29 a month each, up to 8 (500,000 in all).
--   workspaces.subscriber_packs          packs paid for this period (bought prorated from the wallet, renewed with the plan).
--   workspaces.pending_subscriber_packs  a lower number the owner asked for: it starts at the next renewal (like seats).
--   workspaces.custom_subscriber_limit   a custom deal set by the team in Admin → Users: the bot subscriber limit of the
--                                        workspace, whatever the plan and packs say (null = none). Not on the Free plan.
--   settings 'billing'                   sub_pack_size 50000, sub_pack_price_cents 2900 (0 = not sold), sub_pack_max 8.
--                                        Keys already saved are kept.
-- Safe to run more than once.

alter table workspaces add column if not exists subscriber_packs int not null default 0;
alter table workspaces add column if not exists pending_subscriber_packs int;
alter table workspaces add column if not exists custom_subscriber_limit int;

update settings set value = jsonb_build_object('sub_pack_size', 50000, 'sub_pack_price_cents', 2900, 'sub_pack_max', 8) || value
  where key = 'billing';

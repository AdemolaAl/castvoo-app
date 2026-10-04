-- When the team raises a plan's price, people already on that plan keep their old price
-- for 30 more days and get an email first (promised in the Terms).
alter table workspaces add column locked_price_cents bigint;
alter table workspaces add column locked_cycle text;
alter table workspaces add column locked_until timestamptz;

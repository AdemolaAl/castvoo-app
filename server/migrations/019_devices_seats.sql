-- Active devices, new-login alerts and extra team seats (9 Oct 2026).
--   sessions.id              a public id for one login (the token hash is never sent to the browser)
--   sessions.ip_hash         keyed hash of the address the login came from (the raw address is not kept)
--   sessions.ip_country      country code of that address (offline lookup, lib/geoip.js), or null
--   sessions.device_key      "os|browser" from the user agent ("ios|safari"), for new-device alerts
--   sessions.last_seen_at    last request with this login (written at most every 5 minutes)
--   user_devices             device + country pairs each account logged in from (for new-login alerts, 90 days)
--   users.login_alert_tg     send new-login alerts to the linked Telegram account too (email always goes)
--   workspaces.extra_seats   team seats bought on top of the plan's seats (paid with the plan from the wallet)
--   workspaces.pending_extra_seats  a lower number the owner asked for; it applies at the next renewal

alter table sessions add column if not exists id bigserial;
create unique index if not exists sessions_id on sessions(id);
alter table sessions add column if not exists ip_hash text;
alter table sessions add column if not exists ip_country text;
alter table sessions add column if not exists device_key text;
alter table sessions add column if not exists last_seen_at timestamptz not null default now();
-- Sessions no longer keep the raw address (user_ips keeps it for the self-referral check, see 013).
update sessions set ip = null where ip is not null;

create table if not exists user_devices (
  user_id bigint not null references users(id) on delete cascade,
  device_key text not null,
  country text not null default '',
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (user_id, device_key, country)
);

alter table users add column if not exists login_alert_tg boolean not null default true;

alter table workspaces add column if not exists extra_seats int not null default 0;
alter table workspaces add column if not exists pending_extra_seats int;
alter table workspaces drop constraint if exists workspaces_extra_seats_check;
alter table workspaces add constraint workspaces_extra_seats_check check (extra_seats >= 0 and extra_seats <= 500 and (pending_extra_seats is null or (pending_extra_seats >= 0 and pending_extra_seats <= 500)));

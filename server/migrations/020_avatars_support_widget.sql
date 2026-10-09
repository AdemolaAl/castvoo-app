-- Floating support widget, 16 support agents, customer cartoon avatars and nicknames. Never edits older migrations.

-- Customer avatar ("bitmoji"-style): the builder's choices as JSON, checked against a strict list of options on the
-- server (public/js/avatar.js clean()). Nickname: shown in greetings instead of the email-derived name.
-- avatar_prompted_at: when the "Make your Castvoo avatar" prompt was answered or skipped (shown once).
alter table users add column if not exists avatar jsonb;
alter table users add column if not exists nickname text;
alter table users add column if not exists avatar_prompted_at timestamptz;
alter table users drop constraint if exists users_nickname_len;
alter table users add constraint users_nickname_len check (nickname is null or char_length(nickname) between 1 and 24);
alter table users drop constraint if exists users_avatar_size;
alter table users add constraint users_avatar_size check (avatar is null or (jsonb_typeof(avatar) = 'object' and length(avatar::text) <= 2000));

-- When the customer last looked at their support chat (Help page or the floating widget). Drives the unread badge.
alter table support_threads add column if not exists user_seen_at timestamptz;

-- Twelve more named support agents (16 in all), each with an illustrated face in public/img/agents/<face>.svg.
-- Only agents whose name AND face are both unused are added: renamed, edited or re-faced agents are never touched,
-- and this runs once, so an agent the team deletes later never comes back. On a new database the four starting
-- agents come from server/seed.js PERSONAS, which also lists all 16.
insert into support_personas(name, role, bio, sort, face)
select v.name, v.role, v.bio, v.sort, v.face from (values
  ('Aisha', 'Customer support', 'Welcome Flows, join requests and getting people let in.', 5, 'aisha'),
  ('Kenji', 'Technical support', 'Bots, webhooks, start links and anything technical.', 6, 'kenji'),
  ('Sofia', 'Customer success', 'Helps you get more replies and clicks from your messages.', 7, 'sofia'),
  ('Tunde', 'Billing and payments', 'Local payments, bank transfers, receipts and top-ups.', 8, 'tunde'),
  ('Zara', 'Onboarding', 'First channel, first Welcome Flow, first broadcast.', 9, 'zara'),
  ('Marcus', 'Technical support', 'Delivery problems, blocked bots and Telegram limits.', 10, 'marcus'),
  ('Nadia', 'Customer support', 'Sending, scheduling and audiences.', 11, 'nadia'),
  ('Emeka', 'Billing and payments', 'Plans, renewals, wallet and payment checks.', 12, 'emeka'),
  ('Lucas', 'Customer success', 'Follow-up flows that keep people engaged.', 13, 'lucas'),
  ('Priya', 'Technical support', 'Groups, channels, admin rights and connections.', 14, 'priya'),
  ('Kofi', 'Customer support', 'Account, team, setup helper and settings.', 15, 'kofi'),
  ('Elena', 'Onboarding', 'Moving over from another tool, step by step.', 16, 'elena')
) as v(name, role, bio, sort, face)
where exists (select 1 from support_personas)
  and not exists (select 1 from support_personas p where lower(p.name) = lower(v.name) or p.face = v.face);

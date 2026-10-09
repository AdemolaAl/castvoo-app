-- Setup helper: the owner invites one person (a media buyer, a freelancer, a friend) to set up and run the workspace
-- without sharing a password. The helper logs in with their own Castvoo account.
--   members.role 'helper'          the setup helper (at most one per workspace, does not use a team seat)
--   members.last_active_at         when the person last used this workspace (shown on the owner's helper card)
--   members.owner_seen             false until the owner has seen the "your helper joined" notice
--   invites.kind                   'email' (only that email can accept) or 'link' (one-time link, the first person
--                                  who accepts it gets it, then it is used up)
--   invites.declined_at            the invited person said no (the invite can't be used any more)
--   invites.accepted_by            who accepted it
--   workspaces.helper_billing      the helper may change the plan and use coupons (off unless the owner turns it on)
--   workspaces.helper_send         the helper may send broadcasts; when off their messages wait for the owner's approval
--   workspace_activity             what the helper did, in plain words, for the owner's Activity list

alter table members drop constraint if exists members_role_check;
alter table members add constraint members_role_check check (role in ('owner','sender','drafter','helper'));
alter table members add column if not exists last_active_at timestamptz;
alter table members add column if not exists owner_seen boolean not null default true;

alter table invites drop constraint if exists invites_role_check;
alter table invites add constraint invites_role_check check (role in ('sender','drafter','helper'));
alter table invites alter column email drop not null;
alter table invites add column if not exists kind text not null default 'email';
alter table invites drop constraint if exists invites_kind_check;
alter table invites add constraint invites_kind_check check (kind in ('email','link'));
alter table invites add column if not exists declined_at timestamptz;
alter table invites add column if not exists accepted_by bigint references users(id) on delete set null;
create index if not exists invites_workspace on invites(workspace_id);

alter table workspaces add column if not exists helper_billing boolean not null default false;
alter table workspaces add column if not exists helper_send boolean not null default true;

-- One setup helper per workspace, enforced by the database too.
create unique index if not exists members_one_helper on members(workspace_id) where role = 'helper';

create table if not exists workspace_activity (
  id bigserial primary key,
  workspace_id bigint not null references workspaces(id) on delete cascade,
  actor_user_id bigint references users(id) on delete set null,
  role text not null default 'helper',
  action text not null,
  line text not null,
  created_at timestamptz not null default now()
);
create index if not exists workspace_activity_ws on workspace_activity(workspace_id, created_at desc);

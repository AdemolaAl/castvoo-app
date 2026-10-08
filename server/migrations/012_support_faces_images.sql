-- Support agents get illustrated faces (public/img/agents/<face>.svg), and the support chat takes images.
-- Never edits older migrations.

-- A built-in face per agent. An uploaded photo (photo_path) still wins; without either, the initials avatar is drawn.
alter table support_personas add column if not exists face text;
-- The four starting agents get their own face. Only rows without a face are touched, and photos are never changed.
update support_personas set face = lower(name), updated_at = now()
  where face is null and lower(name) in ('mia', 'daniel', 'amara', 'leo', 'aisha', 'kenji', 'sofia', 'tunde');

-- Images in the support chat (customers and staff; never the logged-out website chat).
-- Files live in UPLOAD_DIR/support/<workspace>/ and are only served to the thread's customer and to staff
-- with support permission (routes/support.js, routes/admin/comms.js). message_id is null between the upload and
-- the message that carries it; unused uploads are removed by the hourly clean-up.
create table if not exists support_attachments (
  id bigserial primary key,
  thread_id bigint references support_threads(id) on delete cascade,
  message_id bigint references support_messages(id) on delete cascade,
  workspace_id bigint,
  uploader_user_id bigint references users(id) on delete set null,
  uploader_type text not null check (uploader_type in ('user', 'staff')),
  path text not null,
  mime text not null,
  size_bytes int not null,
  width int,
  height int,
  name text not null default 'image',
  -- Set when the support AI linked this screenshot to the customer's own pending manual payment as proof.
  payment_id bigint references payments(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists support_attachments_message on support_attachments(message_id);
create index if not exists support_attachments_thread on support_attachments(thread_id, id);
create index if not exists support_attachments_unsent on support_attachments(created_at) where message_id is null;
create index if not exists support_attachments_ws on support_attachments(workspace_id);

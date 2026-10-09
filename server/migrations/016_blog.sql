-- The SEO blog (/blog) and its admin CMS (Admin → Blog). See docs/BLOG.md and server/services/blog.js.

create table if not exists blog_authors (
  id serial primary key,
  slug text not null unique,
  name text not null,
  full_name text not null default '',
  role text not null default '',
  bio text not null default '',
  same_as jsonb not null default '[]',
  avatar_path text,
  avatar_mime text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists blog_categories (
  id serial primary key,
  slug text not null unique,
  name text not null unique,
  description text not null default '',
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists blog_posts (
  id serial primary key,
  slug text not null unique,
  title text not null,
  seo_title text not null default '',
  description text not null default '',
  focus_keyword text not null default '',
  body text not null default '',
  category_id int references blog_categories(id) on delete set null,
  author_id int references blog_authors(id) on delete set null,
  tags text[] not null default '{}',
  tag_slugs text[] not null default '{}',
  cover_url text not null default '',
  cover_alt text not null default '',
  featured boolean not null default false,
  takeaways jsonb not null default '[]',
  itemlist jsonb not null default '[]',
  faq jsonb not null default '[]',
  -- draft: only in the admin (and signed preview links); scheduled: goes live at publish_at; published: live.
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'published')),
  publish_at timestamptz,
  published_at timestamptz,
  -- "Updated" date shown on the article and used as dateModified / lastmod.
  modified_at timestamptz not null default now(),
  seeded boolean not null default false,
  created_by bigint references users(id) on delete set null,
  updated_by bigint references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists blog_posts_live on blog_posts (status, published_at desc);
create index if not exists blog_posts_category on blog_posts (category_id);
create index if not exists blog_posts_author on blog_posts (author_id);
create index if not exists blog_posts_tags on blog_posts using gin (tag_slugs);

-- Old addresses of a post: /blog/<old_slug> answers 301 to the current address.
create table if not exists blog_slug_history (
  old_slug text primary key,
  post_id int not null references blog_posts(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- The last 10 saved versions of each post (Admin → Blog → History → Restore).
create table if not exists blog_revisions (
  id bigserial primary key,
  post_id int not null references blog_posts(id) on delete cascade,
  data jsonb not null,
  note text not null default '',
  created_by bigint references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists blog_revisions_post on blog_revisions (post_id, id desc);

-- Every slug the seed loader (server/blog-seed/*.md) ever inserted or saw taken. A slug listed here is never seeded
-- again, so the loader never overwrites the team's edits and never brings back a post the team deleted.
create table if not exists blog_seeded (
  slug text primary key,
  seeded_at timestamptz not null default now()
);

-- Images uploaded in the blog editor (served at /blog/media/<id>-<name>).
create table if not exists blog_images (
  id serial primary key,
  path text not null,
  mime text not null,
  size_bytes int not null,
  width int,
  height int,
  alt text not null default '',
  created_by bigint references users(id) on delete set null,
  created_at timestamptz not null default now()
);

insert into blog_categories(slug, name, description, sort) values
  ('guides', 'Guides', 'Step-by-step guides to growing and automating your Telegram channel, group and bot.', 1),
  ('comparisons', 'Comparisons', 'Honest side-by-side comparisons of Telegram tools, bots and ways of working.', 2),
  ('growth', 'Growth', 'Ideas and playbooks to get more members, more clicks and more sales from Telegram.', 3),
  ('media-buying', 'Media Buying', 'Paid traffic to Telegram: ads, tracking, funnels and what the numbers mean.', 4),
  ('product', 'Product', 'What is new in Castvoo and how to get the most from it.', 5)
on conflict do nothing;

insert into blog_authors(slug, name, full_name, role, bio) values
  ('dchessking', 'Dchessking', 'Ejiro Segbuyota', 'Founder, Zedapex · Media buyer',
   'Dchessking (Ejiro Segbuyota) is the founder of Zedapex and the media buyer behind The Traffic Banker. A former economics and mathematics teacher, he has won several media buying awards and contests and runs paid traffic for affiliate offers across Africa. He builds Castvoo and the Voo tools for media buyers.'),
  ('castvoo-team', 'Castvoo Team', '', 'Product & Growth',
   'The Castvoo product and growth team writes practical guides on welcoming, broadcasting to and following up Telegram audiences, based on what works for the media buyers and channel owners who use Castvoo every day.')
on conflict do nothing;

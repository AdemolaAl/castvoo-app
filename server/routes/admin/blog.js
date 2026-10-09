'use strict';
/*
 * Admin → Blog: posts (draft / scheduled / published), the editor's live preview and SEO checks, revisions,
 * categories, authors and image uploads. Reading needs overview.view; writing needs blog.edit; going live
 * (publish, schedule, unpublish, delete) needs blog.publish. Every change is in the audit log.
 */

const db = require('../../db');
const config = require('../../config');
const blog = require('../../services/blog');
const pages = require('../../services/blog-pages');
const md = require('../../lib/markdown');
const { audit } = require('../../services/audit');
const { str, int, badRequest, notFound } = require('../../lib/util');

const changed = async (ctx, action, target, data) => { blog.bustCache(); await audit(ctx, action, target, data); return { ok: true }; };

function row(p) {
  return {
    id: p.id, title: p.title, slug: p.slug, seo_title: p.seo_title, description: p.description, focus_keyword: p.focus_keyword, body: p.body,
    category_id: p.category_id, category: p.category_name || null, author_id: p.author_id, author: p.author_name || null,
    tags: p.tags || [], cover_url: p.cover_url, cover_alt: p.cover_alt, featured: p.featured, takeaways: p.takeaways || [], itemlist: p.itemlist || [], faq: p.faq || [],
    status: p.status === 'scheduled' && p.publish_at && new Date(p.publish_at) <= new Date() ? 'published' : p.status,
    publish_at: p.publish_at, published_at: p.published_at || (p.status === 'scheduled' ? null : p.published_at), modified_at: p.modified_at,
    created_at: p.created_at, updated_at: p.updated_at, seeded: p.seeded, url: '/blog/' + p.slug,
  };
}
const authorRow = (a) => ({ id: a.id, slug: a.slug, name: a.name, full_name: a.full_name, role: a.role, bio: a.bio, same_as: a.same_as || [], has_photo: !!a.avatar_path, avatar_url: blog.avatarUrl(a), posts: a.posts ?? undefined });

function sameAs(v) {
  if (v === undefined || v === null || v === '') return [];
  const list = Array.isArray(v) ? v : String(v).split(/\s*[\n,]\s*/);
  const out = list.map((x) => String(x).trim()).filter(Boolean);
  if (out.length > 10) throw badRequest('Profile links: 10 at most.');
  for (const u of out) if (!/^https:\/\/[^\s]+\.[^\s]+$/i.test(u) || u.length > 300) throw badRequest(`Profile link "${u.slice(0, 60)}" must be a full https:// address.`);
  return out;
}

module.exports = (r) => {
  /** Posts list: ?q= (title, slug, keyword), status, category, author. Also the categories and authors for filters. */
  r.get('/api/admin/blog/posts', async (ctx) => {
    await blog.publishDue();
    const where = ['true'];
    const params = [];
    if (ctx.query.q) { params.push('%' + String(ctx.query.q).slice(0, 100).replace(/[%_\\]/g, '\\$&') + '%'); where.push(`(p.title ilike $${params.length} or p.slug ilike $${params.length} or p.focus_keyword ilike $${params.length})`); }
    if (['draft', 'scheduled', 'published'].includes(ctx.query.status)) { params.push(ctx.query.status); where.push(`p.status = $${params.length}`); }
    if (ctx.query.category) { params.push(Number(ctx.query.category) || 0); where.push(`p.category_id = $${params.length}`); }
    if (ctx.query.author) { params.push(Number(ctx.query.author) || 0); where.push(`p.author_id = $${params.length}`); }
    const posts = await db.many(`select p.id, p.title, p.slug, p.status, p.publish_at, p.published_at, p.modified_at, p.updated_at, p.featured, p.focus_keyword, p.seeded,
        c.name as category, a.name as author, a.slug as author_slug, a.updated_at as author_updated_at, length(p.body) as body_len
      from blog_posts p left join blog_categories c on c.id = p.category_id left join blog_authors a on a.id = p.author_id
      where ${where.join(' and ')} order by (p.status = 'draft') desc, coalesce(p.publish_at, p.published_at, p.updated_at) desc, p.id desc limit 500`, params);
    const counts = await db.one("select count(*)::int all, count(*) filter (where status = 'draft')::int draft, count(*) filter (where status = 'scheduled')::int scheduled, count(*) filter (where status = 'published')::int published from blog_posts");
    const [categories, authors] = await Promise.all([blog.categories(), blog.authors()]);
    return {
      posts: posts.map((p) => ({ ...p, url: '/blog/' + p.slug, avatar_url: p.author_slug ? blog.avatarUrl(p) : null })),
      counts, categories: categories.map((c) => ({ id: c.id, slug: c.slug, name: c.name, description: c.description, posts: c.posts })),
      authors: authors.map(authorRow),
    };
  }, { staff: 'overview.view' });

  r.get('/api/admin/blog/posts/:id', async (ctx) => {
    const p = await blog.byId(int(ctx.params.id, 'Post'));
    if (!p) throw notFound('That post');
    const revisions = await db.many(`select r.id, r.note, r.created_at, u.name as by_name, u.email as by_email from blog_revisions r left join users u on u.id = r.created_by
      where r.post_id = $1 order by r.id desc limit 10`, [p.id]);
    const history = await db.many('select old_slug from blog_slug_history where post_id = $1 order by created_at desc', [p.id]);
    return { post: row(p), seo: blog.analyze(p), revisions, old_slugs: history.map((h) => h.old_slug) };
  }, { staff: 'overview.view' });

  /** Is a slug free? ?slug=&id= (the post being edited). Returns the cleaned slug too. */
  r.get('/api/admin/blog/slug', async (ctx) => {
    let slug;
    try { slug = blog.checkSlug(String(ctx.query.slug || '')); } catch (e) { return { ok: false, slug: '', error: e.message }; }
    const free = await blog.slugFree(slug, Number(ctx.query.id) || 0);
    return { ok: free, slug, error: free ? null : 'Another post already uses that address.' };
  }, { staff: 'overview.view' });

  r.post('/api/admin/blog/posts', async (ctx) => {
    const f = await blog.fields(ctx.body, null);
    const id = await blog.create(f, ctx.user.id);
    await audit(ctx, 'blog.post_create', 'post:' + id, { title: f.title, slug: f.slug });
    return { post: row(await blog.byId(id)) };
  }, { staff: 'blog.edit' });

  r.put('/api/admin/blog/posts/:id', async (ctx) => {
    const id = int(ctx.params.id, 'Post');
    const cur = await blog.byId(id);
    if (!cur) throw notFound('That post');
    const f = await blog.fields(ctx.body, cur);
    const out = await db.tx((c) => blog.writePost(c, id, f, ctx.user.id, 'Saved'));
    await audit(ctx, 'blog.post_save', 'post:' + id, { title: f.title, slug: f.slug, ...(out.slug_changed ? { old_slug: out.old_slug } : {}) });
    const p = await blog.byId(id);
    return { post: row(p), seo: blog.analyze(p), slug_changed: out.slug_changed };
  }, { staff: 'blog.edit' });

  /** Publish now ({}), or schedule ({ at: ISO date in the future }). */
  r.post('/api/admin/blog/posts/:id/publish', async (ctx) => {
    const id = int(ctx.params.id, 'Post');
    const p = await blog.publish(id, ctx.body.at || null, ctx.user.id);
    await audit(ctx, p.status === 'scheduled' ? 'blog.post_schedule' : 'blog.post_publish', 'post:' + id, { slug: p.slug, ...(p.status === 'scheduled' ? { at: p.publish_at } : {}) });
    return { post: row(p) };
  }, { staff: 'blog.publish' });

  r.post('/api/admin/blog/posts/:id/unpublish', async (ctx) => {
    const id = int(ctx.params.id, 'Post');
    await blog.unpublish(id, ctx.user.id);
    await audit(ctx, 'blog.post_unpublish', 'post:' + id, {});
    return { post: row(await blog.byId(id)) };
  }, { staff: 'blog.publish' });

  r.delete('/api/admin/blog/posts/:id', async (ctx) => {
    const id = int(ctx.params.id, 'Post');
    const gone = await blog.remove(id);
    return changed(ctx, 'blog.post_delete', 'post:' + id, { slug: gone.slug });
  }, { staff: 'blog.publish' });

  /** A signed link that shows the post as it will look, for 7 days (drafts too). Search engines never index it. */
  r.get('/api/admin/blog/posts/:id/preview-link', async (ctx) => {
    const id = int(ctx.params.id, 'Post');
    if (!(await db.one('select 1 from blog_posts where id = $1', [id]))) throw notFound('That post');
    const link = blog.previewLink(id);
    return { url: link, full_url: config.appUrl + link, expires_days: 7 };
  }, { staff: 'blog.edit' });

  r.post('/api/admin/blog/posts/:id/revisions/:rev/restore', async (ctx) => {
    const id = int(ctx.params.id, 'Post');
    const rev = int(ctx.params.rev, 'Version');
    await blog.restoreRevision(id, rev, ctx.user.id);
    await audit(ctx, 'blog.post_restore', 'post:' + id, { revision: rev });
    const p = await blog.byId(id);
    return { post: row(p), seo: blog.analyze(p) };
  }, { staff: 'blog.edit' });

  /** The editor's live preview: the body as the article will show it, the table of contents and the SEO checks. */
  r.post('/api/admin/blog/preview', async (ctx) => {
    const b = ctx.body || {};
    const body = str(b.body, 'Body', { max: 200000, trim: false }) || '';
    const out = md.render(body, { appUrl: config.appUrl, cta: pages.ctaHtml });
    const seo = blog.analyze({ title: String(b.title || ''), seo_title: String(b.seo_title || ''), description: String(b.description || ''), slug: String(b.slug || ''), body, focus_keyword: String(b.focus_keyword || ''), cover_url: String(b.cover_url || ''), cover_alt: String(b.cover_alt || '') });
    return { html: out.html, toc: out.toc, seo };
  }, { staff: 'overview.view', limit: 512 * 1024, rate: [240, 60] });

  /** Upload an image for a post (raw body: JPG, PNG, WEBP or GIF up to 5 MB; ?alt= the alt text). */
  r.post('/api/admin/blog/images', async (ctx) => {
    const out = await blog.saveImage(ctx, ctx.user.id);
    await audit(ctx, 'blog.image_upload', 'blog_image:' + out.id, { size: out.size });
    return out;
  }, { staff: 'blog.edit', stream: true, rate: [60, 600] });

  /* ---------- categories ---------- */
  r.get('/api/admin/blog/categories', async () => ({ categories: await blog.categories() }), { staff: 'overview.view' });
  const catFields = async (b, cur) => {
    const name = str(b.name !== undefined ? b.name : cur && cur.name, 'Name', { min: 1, max: 60 });
    const slug = blog.slugify(b.slug !== undefined && b.slug !== '' ? b.slug : cur && b.slug === undefined ? cur.slug : name);
    if (!slug) throw badRequest('The address (slug) needs at least one letter or number.');
    const description = str(b.description !== undefined ? b.description : cur ? cur.description : '', 'Description', { max: 300 }) || '';
    const taken = await db.one('select 1 from blog_categories where (slug = $1 or lower(name) = lower($2)) and id <> $3', [slug, name, cur ? cur.id : 0]);
    if (taken) throw badRequest('Another category already has that name or address.');
    return { name, slug, description, sort: b.sort !== undefined ? int(b.sort, 'Order', { min: 0, max: 999 }) : cur ? cur.sort : 50 };
  };
  r.post('/api/admin/blog/categories', async (ctx) => {
    const f = await catFields(ctx.body, null);
    const c = await db.one('insert into blog_categories(name, slug, description, sort) values ($1,$2,$3,$4) returning *', [f.name, f.slug, f.description, f.sort]);
    await changed(ctx, 'blog.category_create', 'blog_category:' + c.id, f);
    return { category: c };
  }, { staff: 'blog.edit' });
  r.put('/api/admin/blog/categories/:id', async (ctx) => {
    const cur = await db.one('select * from blog_categories where id = $1', [int(ctx.params.id, 'Category')]);
    if (!cur) throw notFound('That category');
    const f = await catFields(ctx.body, cur);
    const c = await db.one('update blog_categories set name=$2, slug=$3, description=$4, sort=$5 where id = $1 returning *', [cur.id, f.name, f.slug, f.description, f.sort]);
    await changed(ctx, 'blog.category_save', 'blog_category:' + c.id, { before: { name: cur.name, slug: cur.slug }, after: f });
    return { category: c };
  }, { staff: 'blog.edit' });
  r.delete('/api/admin/blog/categories/:id', async (ctx) => {
    const id = int(ctx.params.id, 'Category');
    const used = await db.one('select count(*)::int n from blog_posts where category_id = $1', [id]);
    if (used.n) throw badRequest(`${used.n} post(s) use this category. Move them to another category first.`);
    const c = await db.one('delete from blog_categories where id = $1 returning name', [id]);
    if (!c) throw notFound('That category');
    return changed(ctx, 'blog.category_delete', 'blog_category:' + id, { name: c.name });
  }, { staff: 'blog.edit' });

  /* ---------- authors ---------- */
  r.get('/api/admin/blog/authors', async () => ({ authors: (await blog.authors()).map(authorRow) }), { staff: 'overview.view' });
  const authorFields = async (b, cur) => {
    const v = (k) => (b[k] !== undefined ? b[k] : cur ? cur[k] : undefined);
    const name = str(v('name'), 'Name', { min: 1, max: 80 });
    const slug = blog.slugify(b.slug !== undefined && b.slug !== '' ? b.slug : cur ? cur.slug : name);
    if (!slug) throw badRequest('The address (slug) needs at least one letter or number.');
    if (await db.one('select 1 from blog_authors where slug = $1 and id <> $2', [slug, cur ? cur.id : 0])) throw badRequest('Another author already has that address.');
    return {
      name, slug,
      full_name: str(v('full_name'), 'Full name', { max: 120 }) || '',
      role: str(v('role'), 'Role', { max: 120 }) || '',
      bio: str(v('bio'), 'Bio', { max: 1200 }) || '',
      same_as: sameAs(v('same_as')),
    };
  };
  r.post('/api/admin/blog/authors', async (ctx) => {
    const f = await authorFields(ctx.body, null);
    const a = await db.one('insert into blog_authors(name, slug, full_name, role, bio, same_as) values ($1,$2,$3,$4,$5,$6) returning *', [f.name, f.slug, f.full_name, f.role, f.bio, JSON.stringify(f.same_as)]);
    await changed(ctx, 'blog.author_create', 'blog_author:' + a.id, { name: f.name, slug: f.slug });
    return { author: authorRow(a) };
  }, { staff: 'blog.edit' });
  r.put('/api/admin/blog/authors/:id', async (ctx) => {
    const cur = await db.one('select * from blog_authors where id = $1', [int(ctx.params.id, 'Author')]);
    if (!cur) throw notFound('That author');
    const f = await authorFields(ctx.body, cur);
    const a = await db.one('update blog_authors set name=$2, slug=$3, full_name=$4, role=$5, bio=$6, same_as=$7, updated_at=now() where id = $1 returning *', [cur.id, f.name, f.slug, f.full_name, f.role, f.bio, JSON.stringify(f.same_as)]);
    await changed(ctx, 'blog.author_save', 'blog_author:' + a.id, { name: f.name, slug: f.slug, same_as: f.same_as.length });
    return { author: authorRow(a) };
  }, { staff: 'blog.edit' });
  r.delete('/api/admin/blog/authors/:id', async (ctx) => {
    const id = int(ctx.params.id, 'Author');
    const used = await db.one('select count(*)::int n from blog_posts where author_id = $1', [id]);
    if (used.n) throw badRequest(`${used.n} post(s) are by this author. Give them another author first.`);
    const a = await db.one('select * from blog_authors where id = $1', [id]);
    if (!a) throw notFound('That author');
    await blog.removeAvatar(id).catch(() => {});
    await db.query('delete from blog_authors where id = $1', [id]);
    return changed(ctx, 'blog.author_delete', 'blog_author:' + id, { name: a.name });
  }, { staff: 'blog.edit' });
  r.post('/api/admin/blog/authors/:id/photo', async (ctx) => {
    const id = int(ctx.params.id, 'Author');
    const out = await blog.saveAvatar(ctx, id);
    await audit(ctx, 'blog.author_photo', 'blog_author:' + id, { size: out.size });
    return out;
  }, { staff: 'blog.edit', stream: true, rate: [30, 600] });
  r.delete('/api/admin/blog/authors/:id/photo', async (ctx) => {
    const id = int(ctx.params.id, 'Author');
    await blog.removeAvatar(id);
    return changed(ctx, 'blog.author_photo_remove', 'blog_author:' + id, {});
  }, { staff: 'blog.edit' });
};

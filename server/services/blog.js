'use strict';
/*
 * The blog: posts, categories, authors, scheduled publishing, SEO checks, revisions, slug history,
 * the seed loader (server/blog-seed/*.md), sitemap and RSS data. Pages are drawn by services/blog-pages.js,
 * routes are in routes/blog.js (public) and routes/admin/blog.js (Admin → Blog). Guide: docs/BLOG.md.
 *
 * A post is live when status = 'published', or status = 'scheduled' and publish_at has passed (publishDue() then
 * turns it into 'published'; the worker and every public blog request call it, at most every few seconds).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('../db');
const config = require('../config');
const md = require('../lib/markdown');
const frontmatter = require('../lib/frontmatter');
const { badRequest, notFound, httpError, sign, checkSig, randomToken, str } = require('../lib/util');

const SEED_DIR = path.join(__dirname, '..', 'blog-seed');
const PER_PAGE = 9;
const LIMITS = { title: 200, seo_title: 70, description: 300, keyword: 80, body: 200000, slug: 90, tags: 12, tag: 40, faq: 20, takeaways: 10, itemlist: 50 };
const LIVE = "(p.status = 'published' or (p.status = 'scheduled' and p.publish_at <= now()))";
const SELECT = `select p.*, coalesce(p.published_at, p.publish_at) as live_at,
    c.slug as category_slug, c.name as category_name,
    a.slug as author_slug, a.name as author_name, a.full_name as author_full_name, a.role as author_role, a.bio as author_bio,
    a.same_as as author_same_as, a.updated_at as author_updated_at, (a.avatar_path is not null) as author_has_photo
  from blog_posts p left join blog_categories c on c.id = p.category_id left join blog_authors a on a.id = p.author_id`;

const slugify = (s) => md.slugify(s, LIMITS.slug);
const readingTime = (words) => Math.max(1, Math.round((Number(words) || 0) / 230));

/* ---------------- scheduled publishing ---------------- */
let dueAt = 0;
/** Turn scheduled posts whose time has come into published ones. `force` skips the few-seconds throttle. */
async function publishDue({ force = false } = {}) {
  if (!force && Date.now() - dueAt < 5000) return 0;
  dueAt = Date.now();
  const r = await db.query(`update blog_posts set status = 'published', published_at = coalesce(publish_at, now()), publish_at = null, updated_at = now()
    where status = 'scheduled' and publish_at <= now()`);
  if (r.rowCount) bustCache();
  return r.rowCount;
}

/* ---------------- rendering cache (markdown → html, by post and version) ---------------- */
const renderCache = new Map();
let cacheGen = 0;
function bustCache() { renderCache.clear(); cacheGen++; }
function rendered(post, cta) {
  const key = `${post.id}:${new Date(post.updated_at).getTime()}:${cacheGen}`;
  let r = renderCache.get(key);
  if (!r) {
    r = md.render(post.body, { appUrl: config.appUrl, cta });
    if (renderCache.size > 300) renderCache.delete(renderCache.keys().next().value);
    renderCache.set(key, r);
  }
  return r;
}

/* ---------------- reading ---------------- */
const avatarUrl = (a) => `/blog/avatars/${encodeURIComponent(a.author_slug || a.slug)}?v=${new Date(a.author_updated_at || a.updated_at || 0).getTime().toString(36)}`;

async function listLive({ page = 1, perPage = PER_PAGE, categoryId, authorId, tag, excludeId, featuredFirst = false } = {}) {
  const where = [LIVE];
  const params = [];
  if (categoryId) { params.push(categoryId); where.push(`p.category_id = $${params.length}`); }
  if (authorId) { params.push(authorId); where.push(`p.author_id = $${params.length}`); }
  if (tag) { params.push(tag); where.push(`$${params.length} = any(p.tag_slugs)`); }
  if (excludeId) { params.push(excludeId); where.push(`p.id <> $${params.length}`); }
  const w = where.join(' and ');
  const total = (await db.one(`select count(*)::int n from blog_posts p where ${w}`, params)).n;
  const pages = Math.max(1, Math.ceil(total / perPage));
  params.push(perPage, (Math.max(1, page) - 1) * perPage);
  const posts = await db.many(`${SELECT} where ${w} order by ${featuredFirst ? 'p.featured desc, ' : ''}live_at desc, p.id desc limit $${params.length - 1} offset $${params.length}`, params);
  return { posts, total, pages, page };
}

async function bySlug(slug, { live = true } = {}) {
  return db.one(`${SELECT} where p.slug = $1${live ? ' and ' + LIVE : ''}`, [String(slug).toLowerCase()]);
}
async function byId(id) { return db.one(`${SELECT} where p.id = $1`, [Number(id) || 0]); }
/** The current slug for an old one (301 redirects), only when that post is live. */
async function redirectFor(oldSlug) {
  const r = await db.one(`select p.slug from blog_slug_history h join blog_posts p on p.id = h.post_id where h.old_slug = $1 and ${LIVE}`, [String(oldSlug).toLowerCase()]);
  return r ? r.slug : null;
}

/** Up to n live posts sharing the category or tags, best matches first, then the newest. */
async function related(post, n = 3) {
  return db.many(`${SELECT} where ${LIVE} and p.id <> $1
    order by ((case when p.category_id = $2 then 2 else 0 end) + cardinality(array(select unnest(p.tag_slugs) intersect select unnest($3::text[])))) desc,
    live_at desc limit $4`, [post.id, post.category_id, post.tag_slugs || [], n]);
}

async function latest(n = 3) {
  return db.many(`${SELECT} where ${LIVE} order by live_at desc, p.id desc limit $1`, [n]);
}
async function featured() {
  return db.one(`${SELECT} where ${LIVE} and p.featured order by live_at desc limit 1`);
}

async function categories({ withCounts = true } = {}) {
  return db.many(`select c.*, ${withCounts ? `(select count(*)::int from blog_posts p where p.category_id = c.id and ${LIVE})` : '0'} as posts,
    (select max(greatest(p.modified_at, coalesce(p.published_at, p.publish_at))) from blog_posts p where p.category_id = c.id and ${LIVE}) as last_mod
    from blog_categories c order by c.sort, c.name`);
}
async function category(slug) { return db.one('select * from blog_categories where slug = $1', [String(slug).toLowerCase()]); }
async function authors() {
  return db.many(`select a.*, (select count(*)::int from blog_posts p where p.author_id = a.id and ${LIVE}) as posts,
    (select max(greatest(p.modified_at, coalesce(p.published_at, p.publish_at))) from blog_posts p where p.author_id = a.id and ${LIVE}) as last_mod
    from blog_authors a order by a.id`);
}
async function author(slug) { return db.one('select * from blog_authors where slug = $1', [String(slug).toLowerCase()]); }
/** A tag's display name from its slug (the first live post that uses it). */
async function tagName(slug) {
  const r = await db.one(`select t.name from blog_posts p, unnest(p.tags, p.tag_slugs) as t(name, slug) where t.slug = $1 and ${LIVE} limit 1`, [slug]);
  return r ? r.name : null;
}
async function lastModified() {
  const r = await db.one(`select max(greatest(p.modified_at, p.updated_at, coalesce(p.published_at, p.publish_at))) as m from blog_posts p where ${LIVE}`);
  return r && r.m ? new Date(r.m) : null;
}

/* ---------------- SEO checks (Admin → Blog editor) ---------------- */
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function analyze(p) {
  const r = md.render(p.body || '', { appUrl: config.appUrl, autoCta: false });
  const kw = norm(p.focus_keyword);
  const has = (t) => !!kw && ` ${norm(t)} `.includes(` ${kw} `);
  const title = p.seo_title || p.title || '';
  const first100 = r.text.split(' ').slice(0, 100).join(' ');
  const missingAlt = r.images.filter((i) => !i.alt).length + (p.cover_url && !String(p.cover_alt || '').trim() ? 1 : 0);
  const imgCount = r.images.length + (p.cover_url ? 1 : 0);
  const kwSlug = slugify(p.focus_keyword || '');
  const checks = [
    { key: 'kw_title', label: 'Focus keyword in the SEO title', ok: has(title), tip: 'Put the keyword near the start of the title.' },
    { key: 'kw_h1', label: 'Focus keyword in the headline (H1)', ok: has(p.title), tip: 'The headline is the H1 of the page.' },
    { key: 'kw_intro', label: 'Focus keyword in the first 100 words', ok: has(first100), tip: 'Say what the post is about in the first paragraph.' },
    { key: 'kw_desc', label: 'Focus keyword in the meta description', ok: has(p.description), tip: 'Google bolds the words people searched for.' },
    { key: 'kw_slug', label: 'Focus keyword in the address (slug)', ok: !!kwSlug && String(p.slug || '').includes(kwSlug), tip: 'Short slugs with the keyword work best.' },
    { key: 'h2', label: 'At least one H2 subheading', ok: r.h2 > 0, tip: 'Use ## for sections; they also build the table of contents.' },
    { key: 'title_len', label: 'SEO title is 60 characters or fewer', ok: title.length > 0 && title.length <= 60, tip: `It is ${title.length} now; longer titles get cut in Google.` },
    { key: 'desc_len', label: 'Meta description is 70 to 155 characters', ok: (p.description || '').length >= 70 && (p.description || '').length <= 155, tip: `It is ${(p.description || '').length} now.` },
    { key: 'words', label: 'At least 600 words', ok: r.words >= 600, tip: `${r.words} words now. Thorough posts rank better.` },
    { key: 'internal', label: 'At least one internal link', ok: r.links.internal > 0, tip: 'Link to another post or a Castvoo page with a relative link like /blog/… or /#pricing.' },
    { key: 'alt', label: 'Every image has alt text', ok: missingAlt === 0, tip: imgCount ? `${missingAlt} image(s) without alt text.` : 'No images yet: a cover image helps sharing.' },
  ];
  if (!kw) for (const c of checks) if (c.key.startsWith('kw_')) { c.ok = false; c.tip = 'Set a focus keyword first.'; }
  const passed = checks.filter((c) => c.ok).length;
  return {
    score: Math.round((passed / checks.length) * 100), checks, words: r.words, reading_time: readingTime(r.words),
    internal_links: r.links.internal, external_links: r.links.external, h2: r.h2, images: imgCount, images_missing_alt: missingAlt, toc: r.toc,
  };
}

/* ---------------- validation (admin and seed) ---------------- */
function cleanList(v, name, max, maxLen) {
  if (v === undefined || v === null || v === '') return [];
  if (!Array.isArray(v)) throw badRequest(`${name} must be a list.`);
  const out = v.map((x) => String(x ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (out.length > max) throw badRequest(`${name}: ${max} at most.`);
  for (const x of out) if (x.length > maxLen) throw badRequest(`${name}: each one can be up to ${maxLen} characters.`);
  return out;
}
function cleanFaq(v) {
  if (v === undefined || v === null || v === '') return [];
  if (!Array.isArray(v)) throw badRequest('FAQ must be a list.');
  const out = v.map((x) => ({ q: String((x && x.q) ?? '').trim(), a: String((x && x.a) ?? '').trim() })).filter((x) => x.q || x.a);
  if (out.length > LIMITS.faq) throw badRequest(`FAQ: ${LIMITS.faq} questions at most.`);
  for (const x of out) {
    if (!x.q || !x.a) throw badRequest('Every FAQ question needs an answer.');
    if (x.q.length > 300 || x.a.length > 3000) throw badRequest('FAQ: questions up to 300 characters, answers up to 3,000.');
  }
  return out;
}
function cleanImageUrl(v, name) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (s.length > 1000) throw badRequest(`${name} is too long.`);
  if (!md.safeUrl(s, { image: true }) || !(/^https?:\/\//i.test(s) || s.startsWith('/'))) throw badRequest(`${name} must be an https:// address or an uploaded image.`);
  return s;
}
function checkSlug(s) {
  const slug = slugify(s);
  if (!slug) throw badRequest('The address (slug) needs at least one letter or number.');
  if (['category', 'author', 'tag', 'rss', 'og', 'media', 'avatars', 'preview', 'page'].includes(slug)) throw badRequest('That address is used by the blog itself. Pick another.');
  return slug;
}

/** Validate the editable fields of a post. `cur` = the saved post: fields left out keep their value. */
async function fields(b, cur) {
  const v = (k) => (b[k] !== undefined ? b[k] : cur ? cur[k] : undefined);
  const title = str(v('title'), 'Title', { min: 1, max: LIMITS.title });
  const slug = checkSlug(v('slug') || title);
  const f = {
    title, slug,
    seo_title: str(v('seo_title'), 'SEO title', { max: LIMITS.seo_title }) || '',
    description: (str(v('description'), 'Meta description', { max: LIMITS.description }) || '').replace(/\s+/g, ' '),
    focus_keyword: str(v('focus_keyword'), 'Focus keyword', { max: LIMITS.keyword }) || '',
    body: str(v('body'), 'Body', { max: LIMITS.body, trim: false }) || '',
    tags: cleanList(v('tags'), 'Tags', LIMITS.tags, LIMITS.tag),
    cover_url: cleanImageUrl(v('cover_url'), 'Cover image'),
    cover_alt: str(v('cover_alt'), 'Cover image alt text', { max: 200 }) || '',
    featured: v('featured') === true || v('featured') === 'true',
    takeaways: cleanList(v('takeaways'), 'Key takeaways', LIMITS.takeaways, 300),
    itemlist: cleanList(v('itemlist'), 'List items', LIMITS.itemlist, 200),
    faq: cleanFaq(v('faq')),
  };
  f.tags = [...new Map(f.tags.map((t) => [slugify(t), t])).entries()].filter(([s]) => s).map(([, t]) => t);
  const cat = v('category_id');
  f.category_id = cat === null || cat === '' || cat === undefined ? null : Number(cat);
  if (f.category_id !== null && !(await db.one('select 1 from blog_categories where id = $1', [f.category_id || 0]))) throw badRequest('Pick a category from the list.');
  const au = v('author_id');
  f.author_id = au === null || au === '' || au === undefined ? null : Number(au);
  if (f.author_id !== null && !(await db.one('select 1 from blog_authors where id = $1', [f.author_id || 0]))) throw badRequest('Pick an author from the list.');
  if (f.cover_url && !f.cover_alt) throw badRequest('Describe the cover image in a few words (alt text) for Google and screen readers.');
  return f;
}

/** Is this slug free for post `id`? Old slugs of other posts are free (they are handed over). */
async function slugFree(slug, id = 0) {
  const r = await db.one('select id from blog_posts where slug = $1 and id <> $2', [slug, Number(id) || 0]);
  return !r;
}

const SNAP_KEYS = ['title', 'slug', 'seo_title', 'description', 'focus_keyword', 'body', 'category_id', 'author_id', 'tags', 'cover_url', 'cover_alt', 'featured', 'takeaways', 'itemlist', 'faq'];
const CONTENT_KEYS = ['title', 'description', 'body', 'takeaways', 'faq', 'itemlist', 'cover_url'];
const snap = (p) => Object.fromEntries(SNAP_KEYS.map((k) => [k, p[k]]));

async function saveRevision(c, postId, userId, note) {
  const p = (await c.query('select * from blog_posts where id = $1', [postId])).rows[0];
  await c.query('insert into blog_revisions(post_id, data, note, created_by) values ($1,$2,$3,$4)', [postId, JSON.stringify(snap(p)), note || '', userId || null]);
  await c.query('delete from blog_revisions where post_id = $1 and id not in (select id from blog_revisions where post_id = $1 order by id desc limit 10)', [postId]);
}

/** Write fields to a post inside a transaction: slug history, "Updated" date, revision. */
async function writePost(c, id, f, userId, note) {
  const cur = (await c.query('select * from blog_posts where id = $1 for update', [id])).rows[0];
  if (!cur) throw notFound('That post');
  if (f.slug !== cur.slug) {
    if ((await c.query('select 1 from blog_posts where slug = $1 and id <> $2', [f.slug, id])).rows[0]) throw badRequest('Another post already uses that address. Change the slug.');
    await c.query('delete from blog_slug_history where old_slug = $1', [f.slug]);
    await c.query('insert into blog_slug_history(old_slug, post_id) values ($1,$2) on conflict (old_slug) do update set post_id = excluded.post_id', [cur.slug, id]);
  }
  const contentChanged = CONTENT_KEYS.some((k) => JSON.stringify(cur[k]) !== JSON.stringify(f[k]));
  const live = cur.status === 'published';
  await c.query(`update blog_posts set title=$2, slug=$3, seo_title=$4, description=$5, focus_keyword=$6, body=$7, category_id=$8, author_id=$9,
      tags=$10, tag_slugs=$11, cover_url=$12, cover_alt=$13, featured=$14, takeaways=$15, itemlist=$16, faq=$17,
      modified_at = case when $18 then now() else modified_at end, updated_by=$19, updated_at=now() where id = $1`,
  [id, f.title, f.slug, f.seo_title, f.description, f.focus_keyword, f.body, f.category_id, f.author_id, f.tags, f.tags.map(slugify),
    f.cover_url, f.cover_alt, f.featured, JSON.stringify(f.takeaways), JSON.stringify(f.itemlist), JSON.stringify(f.faq), live && contentChanged, userId || null]);
  await saveRevision(c, id, userId, note);
  bustCache();
  return { slug_changed: f.slug !== cur.slug, old_slug: cur.slug };
}

async function create(f, userId) {
  return db.tx(async (c) => {
    if ((await c.query('select 1 from blog_posts where slug = $1', [f.slug])).rows[0]) throw badRequest('Another post already uses that address. Change the slug.');
    await c.query('delete from blog_slug_history where old_slug = $1', [f.slug]);
    const row = (await c.query(`insert into blog_posts(title, slug, seo_title, description, focus_keyword, body, category_id, author_id, tags, tag_slugs,
        cover_url, cover_alt, featured, takeaways, itemlist, faq, created_by, updated_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17) returning id`,
    [f.title, f.slug, f.seo_title, f.description, f.focus_keyword, f.body, f.category_id, f.author_id, f.tags, f.tags.map(slugify),
      f.cover_url, f.cover_alt, f.featured, JSON.stringify(f.takeaways), JSON.stringify(f.itemlist), JSON.stringify(f.faq), userId || null])).rows[0];
    await saveRevision(c, row.id, userId, 'Created');
    bustCache();
    return row.id;
  });
}

/** Publish now, or schedule for `at` (a future date). Checks the post is complete first. */
async function publish(id, at, userId) {
  const p = await byId(id);
  if (!p) throw notFound('That post');
  const missing = [];
  if (!p.description) missing.push('a meta description');
  if (!p.body.trim()) missing.push('the body');
  if (!p.category_id) missing.push('a category');
  if (!p.author_id) missing.push('an author');
  if (missing.length) throw badRequest(`Before publishing, add ${missing.join(', ')}.`);
  let when = null;
  if (at) {
    when = new Date(at);
    if (Number.isNaN(when.getTime())) throw badRequest('Pick a valid date and time to publish.');
    if (when.getTime() > Date.now() + 5 * 365 * 86400000) throw badRequest('Pick a date in the next 5 years.');
  }
  if (when && when.getTime() > Date.now() + 30000) {
    await db.query("update blog_posts set status = 'scheduled', publish_at = $2, updated_by = $3, updated_at = now() where id = $1", [id, when, userId || null]);
  } else {
    await db.query(`update blog_posts set status = 'published', published_at = coalesce(published_at, now()), publish_at = null,
      modified_at = case when published_at is null then now() else modified_at end, updated_by = $2, updated_at = now() where id = $1`, [id, userId || null]);
  }
  bustCache();
  return byId(id);
}
async function unpublish(id, userId) {
  const r = await db.query("update blog_posts set status = 'draft', publish_at = null, updated_by = $2, updated_at = now() where id = $1", [id, userId || null]);
  if (!r.rowCount) throw notFound('That post');
  bustCache();
}
async function remove(id) {
  const r = await db.query('delete from blog_posts where id = $1 returning slug', [id]);
  if (!r.rowCount) throw notFound('That post');
  bustCache();
  return r.rows[0];
}
async function restoreRevision(postId, revId, userId) {
  const rev = await db.one('select * from blog_revisions where id = $1 and post_id = $2', [revId, postId]);
  if (!rev) throw notFound('That version');
  const cur = await byId(postId);
  const f = await fields({ ...rev.data }, cur);
  if (!(await slugFree(f.slug, postId))) f.slug = cur.slug;
  return db.tx((c) => writePost(c, postId, f, userId, `Restored the version from ${new Date(rev.created_at).toISOString().slice(0, 16).replace('T', ' ')} UTC`));
}

/* ---------------- preview links for drafts ---------------- */
function previewLink(id, days = 7) {
  const e = Math.floor(Date.now() / 1000) + days * 86400;
  return `/blog/preview/${id}?e=${e}&t=${sign(`blogpreview:${id}:${e}`, 32)}`;
}
function checkPreview(id, e, t) {
  const exp = Number(e);
  if (!Number.isInteger(exp) || exp < Date.now() / 1000) return false;
  return checkSig(`blogpreview:${id}:${exp}`, String(t || ''), 32);
}

/* ---------------- images (editor uploads, author photos) ---------------- */
const IMG_TYPES = {
  'image/jpeg': { ext: '.jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  'image/png': { ext: '.png', magic: (b) => b.slice(0, 8).toString('hex') === '89504e470d0a1a0a' },
  'image/webp': { ext: '.webp', magic: (b) => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' },
  'image/gif': { ext: '.gif', magic: (b) => b.slice(0, 3).toString() === 'GIF' },
};
const IMG_MAX = 5 * 1024 * 1024;
const blogRoot = () => path.resolve(config.uploadDir, 'blog') + path.sep;

/** Width and height read from the file header (PNG, GIF, WEBP, JPEG), or null. */
function imageSize(buf, mime) {
  try {
    if (mime === 'image/png' && buf.length > 24) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (mime === 'image/gif' && buf.length > 10) return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if (mime === 'image/webp' && buf.length > 30) {
      const kind = buf.slice(12, 16).toString();
      if (kind === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') { const b = buf.readUInt32LE(21); return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }; }
      if (kind === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch { /* not readable */ }
  return null;
}

async function readUpload(ctx, max = IMG_MAX) {
  const mime = String(ctx.req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const t = IMG_TYPES[mime];
  if (!t) throw badRequest('Use a JPG, PNG, WEBP or GIF image.');
  if (Number(ctx.req.headers['content-length'] || 0) > max) throw httpError(413, 'Images can be up to 5 MB.', 'too_large');
  const chunks = [];
  let size = 0;
  await new Promise((resolve, reject) => {
    ctx.req.on('data', (c) => { size += c.length; if (size > max) { reject(httpError(413, 'Images can be up to 5 MB.', 'too_large')); ctx.req.destroy(); return; } chunks.push(c); });
    ctx.req.on('end', resolve); ctx.req.on('error', reject);
  });
  const buf = Buffer.concat(chunks);
  if (!buf.length) throw badRequest('The file is empty.');
  if (!t.magic(buf.slice(0, 16))) throw badRequest('That file does not match its type. Export it again as JPG or PNG.');
  return { buf, mime, ext: t.ext };
}

async function saveImage(ctx, userId) {
  const { buf, mime, ext } = await readUpload(ctx);
  await fs.promises.mkdir(blogRoot(), { recursive: true });
  const file = path.join(blogRoot(), randomToken(12) + ext);
  await fs.promises.writeFile(file, buf);
  const dim = imageSize(buf, mime) || {};
  const alt = String(ctx.query.alt || '').slice(0, 200);
  const row = await db.one('insert into blog_images(path, mime, size_bytes, width, height, alt, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id',
    [file, mime, buf.length, dim.w || null, dim.h || null, alt, userId || null]);
  return { id: row.id, url: `/blog/media/${row.id}${ext}`, width: dim.w || null, height: dim.h || null, size: buf.length };
}
async function imageFile(idWithExt) {
  const m = /^(\d+)\.(jpg|png|webp|gif)$/.exec(String(idWithExt));
  if (!m) return null;
  const r = await db.one('select * from blog_images where id = $1', [Number(m[1])]);
  if (!r || IMG_TYPES[r.mime].ext !== '.' + m[2]) return null;
  const abs = path.resolve(r.path);
  return abs.startsWith(blogRoot()) ? { path: abs, mime: r.mime } : null;
}

async function saveAvatar(ctx, authorId) {
  const a = await db.one('select * from blog_authors where id = $1', [authorId]);
  if (!a) throw notFound('That author');
  const { buf, mime, ext } = await readUpload(ctx);
  const dir = path.join(blogRoot(), 'avatars');
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `a${a.id}-${randomToken(8)}${ext}`);
  await fs.promises.writeFile(file, buf);
  await db.query('update blog_authors set avatar_path = $2, avatar_mime = $3, updated_at = now() where id = $1', [a.id, file, mime]);
  if (a.avatar_path && path.resolve(a.avatar_path).startsWith(blogRoot())) await fs.promises.unlink(a.avatar_path).catch(() => {});
  bustCache();
  return { ok: true, size: buf.length };
}
async function removeAvatar(authorId) {
  const a = await db.one('select * from blog_authors where id = $1', [authorId]);
  if (!a) throw notFound('That author');
  if (a.avatar_path && path.resolve(a.avatar_path).startsWith(blogRoot())) await fs.promises.unlink(a.avatar_path).catch(() => {});
  await db.query('update blog_authors set avatar_path = null, avatar_mime = null, updated_at = now() where id = $1', [a.id]);
  bustCache();
}

/* ---------------- seed loader: server/blog-seed/*.md ---------------- */
const CATS = ['Guides', 'Comparisons', 'Growth', 'Media Buying', 'Product'];
/**
 * Insert every seed post whose slug was NEVER seeded and is not taken. A slug is remembered in blog_seeded for good,
 * so a post the team edited is never overwritten and a post the team deleted never comes back. Safe to run on every start.
 */
async function syncSeed({ dir = SEED_DIR } = {}) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { return { inserted: [], skipped: [] }; }
  const inserted = [], skipped = [];
  await db.tx(async (c) => {
    await c.query('select pg_advisory_xact_lock(424243)');
    const seeded = new Set((await c.query('select slug from blog_seeded')).rows.map((r) => r.slug));
    for (const file of files) {
      let doc;
      try { doc = frontmatter.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { skipped.push(file); continue; }
      const d = doc.data;
      const slug = slugify(d.slug || file.replace(/\.md$/, ''));
      if (!slug || !d.title || seeded.has(slug)) { skipped.push(slug || file); continue; }
      const taken = (await c.query('select 1 from blog_posts where slug = $1 union all select 1 from blog_slug_history where old_slug = $1', [slug])).rows[0];
      if (taken) { await c.query('insert into blog_seeded(slug) values ($1) on conflict do nothing', [slug]); seeded.add(slug); skipped.push(slug); continue; }
      const catName = CATS.find((x) => x.toLowerCase() === String(d.category || '').toLowerCase()) || String(d.category || 'Guides');
      let cat = (await c.query('select id from blog_categories where lower(name) = lower($1) or slug = $2', [catName, slugify(catName)])).rows[0];
      if (!cat) cat = (await c.query('insert into blog_categories(slug, name, sort) values ($1,$2,99) returning id', [slugify(catName), catName.slice(0, 60)])).rows[0];
      const au = (await c.query("select id from blog_authors where slug = $1 union all (select id from blog_authors where slug = 'castvoo-team') union all (select id from blog_authors order by id limit 1)", [slugify(d.author || '')])).rows[0];
      const day = (s) => { const x = /^\d{4}-\d{2}-\d{2}/.test(String(s || '')) ? new Date(String(s).slice(0, 10) + 'T06:00:00Z') : null; return x && !Number.isNaN(x.getTime()) ? x : null; };
      const date = day(d.date) || new Date();
      const updated = day(d.updated);
      let modified = new Date((updated && updated > date ? updated : date).getTime());
      const list = (v, n, len) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, n).map((x) => x.slice(0, len)) : []);
      const tags = list(d.tags, LIMITS.tags, LIMITS.tag);
      const faq = (Array.isArray(d.faq) ? d.faq : []).filter((x) => x && x.q && x.a).slice(0, LIMITS.faq).map((x) => ({ q: String(x.q).slice(0, 300), a: String(x.a).slice(0, 3000) }));
      // A date up to a day ahead is "today" somewhere (writers date posts in their own time zone): published now.
      const future = date.getTime() > Date.now() + 86400000;
      if (!future && date.getTime() > Date.now()) date.setTime(Date.now());
      if (modified.getTime() > Date.now() && !future) modified = new Date(date.getTime());
      if (modified < date) modified = new Date(date.getTime());
      const row = (await c.query(`insert into blog_posts(title, slug, seo_title, description, focus_keyword, body, category_id, author_id, tags, tag_slugs,
          featured, takeaways, itemlist, faq, status, publish_at, published_at, modified_at, seeded, created_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,true,$19) returning id`,
      [String(d.title).slice(0, LIMITS.title), slug, String(d.seo_title || '').slice(0, LIMITS.seo_title), String(d.description || '').replace(/\s+/g, ' ').slice(0, LIMITS.description),
        String(d.focus_keyword || '').slice(0, LIMITS.keyword), doc.body.slice(0, LIMITS.body), cat.id, au ? au.id : null, tags, tags.map(slugify),
        d.featured === true, JSON.stringify(list(d.takeaways, LIMITS.takeaways, 300)), JSON.stringify(list(d.itemlist, LIMITS.itemlist, 200)), JSON.stringify(faq),
        future ? 'scheduled' : 'published', future ? date : null, future ? null : date, modified, date])).rows[0];
      await saveRevision(c, row.id, null, 'Imported from server/blog-seed/' + file);
      await c.query('insert into blog_seeded(slug) values ($1) on conflict do nothing', [slug]);
      seeded.add(slug);
      inserted.push(slug);
    }
  });
  if (inserted.length) bustCache();
  return { inserted, skipped };
}

/* ---------------- generated images (SVG) ---------------- */
const xmlEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
function wrap(text, max, lines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const out = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max && cur) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) out.push(cur);
  if (out.length > lines) { const keep = out.slice(0, lines); keep[lines - 1] = keep[lines - 1].replace(/[\s,.:;-]*$/, '') + '…'; return keep; }
  return out;
}
const PALETTE = {
  guides: ['#2F6BFF', '#6EC3FF'], comparisons: ['#5B3DF5', '#9DBDFF'], growth: ['#0E9F6E', '#6EE7B7'], 'media-buying': ['#F59E0B', '#FCD34D'], product: ['#EC4899', '#F9A8D4'],
};
const FONT = "'Plus Jakarta Sans','Segoe UI',Helvetica,Arial,sans-serif";
/** The share/cover picture of a post: 1200×630, title in big type on the Castvoo night-blue. */
function ogSvg(p) {
  const [c1, c2] = PALETTE[p.category_slug] || PALETTE.guides;
  const lines = wrap(p.title, 26, 4);
  const size = lines.length > 3 ? 62 : 70;
  const top = 250 - (lines.length - 1) * size * 0.45;
  const id = 'g' + crypto.createHash('md5').update(String(p.slug)).digest('hex').slice(0, 6);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${xmlEsc(p.title)}">
<defs><linearGradient id="${id}b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#060C26"/><stop offset="1" stop-color="#13205C"/></linearGradient>
<radialGradient id="${id}r" cx=".85" cy=".1" r=".8"><stop offset="0" stop-color="${c1}" stop-opacity=".75"/><stop offset="1" stop-color="${c1}" stop-opacity="0"/></radialGradient>
<radialGradient id="${id}s" cx=".05" cy="1" r=".6"><stop offset="0" stop-color="${c2}" stop-opacity=".35"/><stop offset="1" stop-color="${c2}" stop-opacity="0"/></radialGradient>
<linearGradient id="${id}l" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5A8CFF"/><stop offset=".5" stop-color="#2F6BFF"/><stop offset="1" stop-color="#1846DB"/></linearGradient>
<pattern id="${id}p" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#fff" stroke-opacity=".05"/></pattern></defs>
<rect width="1200" height="630" fill="url(#${id}b)"/><rect width="1200" height="630" fill="url(#${id}p)"/><rect width="1200" height="630" fill="url(#${id}r)"/><rect width="1200" height="630" fill="url(#${id}s)"/>
<g transform="translate(72 64)"><rect width="56" height="56" rx="17" fill="url(#${id}l)"/><path d="M34.4 19A12.6 12.6 0 1 0 34.4 37" fill="none" stroke="#fff" stroke-width="6.4" stroke-linecap="round" transform="translate(0 0)"/><circle cx="40.6" cy="28" r="4.6" fill="#fff"/>
<text x="76" y="38" font-family="${FONT}" font-size="30" font-weight="800" fill="#fff" letter-spacing="-1">Cast<tspan fill="#8FB0FF">voo</tspan></text>
<text x="178" y="38" font-family="${FONT}" font-size="22" font-weight="600" fill="#A7B3D9">  ·  Blog</text></g>
<g transform="translate(72 ${Math.round(top - 70)})"><rect width="${Math.max(120, String(p.category_name || 'Guides').length * 15 + 44)}" height="42" rx="21" fill="${c1}" fill-opacity=".18" stroke="${c1}" stroke-opacity=".6"/>
<text x="22" y="28" font-family="${FONT}" font-size="19" font-weight="800" fill="${c2}" letter-spacing="2">${xmlEsc(String(p.category_name || 'Guides').toUpperCase())}</text></g>
${lines.map((l, i) => `<text x="72" y="${Math.round(top + i * size * 1.12)}" font-family="${FONT}" font-size="${size}" font-weight="800" fill="#fff" letter-spacing="-2">${xmlEsc(l)}</text>`).join('\n')}
<text x="72" y="566" font-family="${FONT}" font-size="24" font-weight="600" fill="#A7B3D9">${xmlEsc(p.author_name || 'Castvoo')}  ·  ${xmlEsc(hostOf(config.appUrl))}</text>
<rect x="72" y="590" width="120" height="6" rx="3" fill="${c1}"/></svg>`;
}
function hostOf(u) { try { return new URL(u).host; } catch { return 'castvoo.com'; } }

/** The picture on post cards: no title (the card shows it), a chat motif in the category colour, different per post. */
function cardSvg(p) {
  const [c1, c2] = PALETTE[p.category_slug] || PALETTE.guides;
  const h = crypto.createHash('md5').update(String(p.slug)).digest();
  const id = 'c' + h.toString('hex').slice(0, 6);
  const w = (i, min, max) => Math.round(min + (h[i] / 255) * (max - min));
  const x0 = 640 + w(1, -40, 60);
  const icons = {
    guides: '<path d="M-26-30h40l14 14v46h-54z" fill="none" stroke="#fff" stroke-width="6" stroke-linejoin="round"/><path d="M-12 0h24M-12 14h16" stroke="#fff" stroke-width="6" stroke-linecap="round"/>',
    comparisons: '<path d="M-30-24h24v48h-24zM6-24h24v48H6z" fill="none" stroke="#fff" stroke-width="6" stroke-linejoin="round"/>',
    growth: '<path d="M-30 24l20-22 14 12 26-30M14-16h16v16" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>',
    'media-buying': '<circle r="28" fill="none" stroke="#fff" stroke-width="6"/><circle r="12" fill="none" stroke="#fff" stroke-width="6"/><circle r="3" fill="#fff"/>',
    product: '<path d="M0-30l8 20 22 2-17 14 5 22L0 16l-18 12 5-22-17-14 22-2z" fill="none" stroke="#fff" stroke-width="6" stroke-linejoin="round"/>',
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" aria-hidden="true">
<defs><linearGradient id="${id}b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#060C26"/><stop offset="1" stop-color="#16236A"/></linearGradient>
<radialGradient id="${id}r" cx="${(0.6 + h[2] / 900).toFixed(2)}" cy=".2" r=".75"><stop offset="0" stop-color="${c1}" stop-opacity=".8"/><stop offset="1" stop-color="${c1}" stop-opacity="0"/></radialGradient>
<radialGradient id="${id}s" cx=".1" cy=".95" r=".55"><stop offset="0" stop-color="${c2}" stop-opacity=".35"/><stop offset="1" stop-color="${c2}" stop-opacity="0"/></radialGradient>
<linearGradient id="${id}k" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c2}"/><stop offset="1" stop-color="${c1}"/></linearGradient>
<pattern id="${id}p" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="#fff" stroke-opacity=".05" stroke-width="2"/></pattern></defs>
<rect width="1200" height="630" fill="url(#${id}b)"/><rect width="1200" height="630" fill="url(#${id}p)"/><rect width="1200" height="630" fill="url(#${id}r)"/><rect width="1200" height="630" fill="url(#${id}s)"/>
<g transform="translate(230 315)"><circle r="150" fill="#fff" fill-opacity=".04"/><circle r="104" fill="#fff" fill-opacity=".06"/><rect x="-64" y="-64" width="128" height="128" rx="38" fill="url(#${id}k)"/>${icons[p.category_slug] || icons.guides}</g>
<g transform="translate(${x0} 130)">
<rect width="${w(3, 300, 420)}" height="92" rx="30" fill="#fff" fill-opacity=".95"/><rect x="28" y="28" width="${w(4, 160, 280)}" height="14" rx="7" fill="#0B1430" fill-opacity=".8"/><rect x="28" y="54" width="${w(5, 90, 200)}" height="12" rx="6" fill="#59647E" fill-opacity=".5"/>
<rect y="112" width="${w(6, 220, 340)}" height="58" rx="22" fill="url(#${id}k)"/><rect x="28" y="134" width="${w(7, 100, 170)}" height="14" rx="7" fill="#fff"/>
<rect x="${w(8, 60, 120)}" y="194" width="${w(9, 260, 380)}" height="78" rx="28" fill="#fff" fill-opacity=".14" stroke="#fff" stroke-opacity=".18"/><rect x="${w(8, 60, 120) + 28}" y="222" width="${w(10, 140, 240)}" height="14" rx="7" fill="#fff" fill-opacity=".75"/>
<rect y="296" width="${w(11, 240, 360)}" height="70" rx="26" fill="#fff" fill-opacity=".9"/><rect x="28" y="322" width="${w(12, 120, 230)}" height="14" rx="7" fill="#0B1430" fill-opacity=".7"/></g>
</svg>`;
}

/** Monogram avatar for an author without a photo. */
function avatarSvg(a) {
  const parts = String(a.name || a.full_name || '?').split(/\s+/).filter(Boolean);
  const ini = ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  const id = 'a' + crypto.createHash('md5').update(String(a.slug)).digest('hex').slice(0, 6);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5A8CFF"/><stop offset=".55" stop-color="#2F6BFF"/><stop offset="1" stop-color="#0F33A8"/></linearGradient>
<radialGradient id="${id}h" cx=".3" cy=".2" r=".8"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>
<rect width="256" height="256" rx="128" fill="url(#${id})"/><rect width="256" height="256" rx="128" fill="url(#${id}h)"/><circle cx="128" cy="128" r="112" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width="3"/>
<text x="128" y="${ini.length > 1 ? 152 : 158}" text-anchor="middle" font-family="${FONT}" font-size="${ini.length > 1 ? 92 : 112}" font-weight="800" fill="#fff" letter-spacing="-4">${xmlEsc(ini)}</text></svg>`;
}
async function avatarFile(slug) {
  const a = await db.one('select * from blog_authors where slug = $1', [String(slug).toLowerCase()]);
  if (!a) return null;
  const abs = a.avatar_path ? path.resolve(a.avatar_path) : '';
  if (abs && abs.startsWith(blogRoot()) && IMG_TYPES[a.avatar_mime] && fs.existsSync(abs)) return { path: abs, mime: a.avatar_mime };
  return { svg: avatarSvg(a) };
}

/* ---------------- sitemap ---------------- */
let SITEMAP_CHUNK = 1000;
async function sitemapPosts() {
  return db.many(`select p.slug, greatest(p.modified_at, coalesce(p.published_at, p.publish_at)) as lastmod from blog_posts p where ${LIVE} order by coalesce(p.published_at, p.publish_at) desc, p.id desc`);
}

module.exports = {
  PER_PAGE, LIVE, SEED_DIR, slugify, readingTime, publishDue, rendered, bustCache, avatarUrl,
  listLive, bySlug, byId, redirectFor, related, latest, featured, categories, category, authors, author, tagName, lastModified,
  analyze, fields, slugFree, checkSlug, create, writePost, publish, unpublish, remove, restoreRevision, saveRevision,
  previewLink, checkPreview, saveImage, imageFile, saveAvatar, removeAvatar, avatarFile, imageSize,
  syncSeed, ogSvg, cardSvg, avatarSvg, sitemapPosts,
  get SITEMAP_CHUNK() { return SITEMAP_CHUNK; }, _setSitemapChunk(n) { SITEMAP_CHUNK = n; },
  _resetDue() { dueAt = 0; },
};

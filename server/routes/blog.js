'use strict';
/*
 * The public blog (server-rendered, no JavaScript needed to read it) and the files search engines read:
 *   /blog, /blog?page=2, /blog/<slug>, /blog/category/<slug>, /blog/author/<slug>, /blog/tag/<slug>
 *   /blog/rss.xml, /blog/og/<slug>.svg, /blog/media/<id>.<ext>, /blog/avatars/<author>, /blog/preview/<id>?e=&t=
 *   /robots.txt, /sitemap.xml (a sitemap index with /sitemap/<part>.xml once there are more than 1,000 posts)
 *   /api/public/blog/latest   the 3 newest posts for the homepage "From the blog" section
 * Pages carry ETag + Last-Modified (304 when unchanged) and are gzipped when the browser accepts it.
 */

const fs = require('node:fs');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const db = require('../db');
const config = require('../config');
const settings = require('../services/settings');
const blog = require('../services/blog');
const pages = require('../services/blog-pages');
const LEGAL = require('../legal/index.js');
const { notFound } = require('../lib/util');

const blogOn = () => settings.feature('blog');
const company = async () => { const c = await settings.get('company'); return (c && c.name) || 'Zedapex'; };

/** Same policy as the rest of the site, but blog images may come from any https address (covers, screenshots). */
function csp() {
  return require('../app').cspHeader().replace(/img-src [^;]*/, "img-src 'self' data: https:");
}

/** Send a page or file with ETag / Last-Modified (answering 304 when the browser's copy is current) and gzip. */
function send(ctx, status, body, { type = 'text/html; charset=utf-8', lastModified = null, cache = 'public, max-age=60, stale-while-revalidate=600', extra = {} } = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const etag = 'W/"' + crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 22) + '"';
  const h = { 'Content-Type': type, 'Cache-Control': cache, ETag: etag, Vary: 'Accept-Encoding', ...extra };
  if (type.startsWith('text/html')) h['Content-Security-Policy'] = csp();
  if (lastModified) h['Last-Modified'] = new Date(Math.floor(new Date(lastModified).getTime() / 1000) * 1000).toUTCString();
  if (status === 200) {
    const inm = ctx.req.headers['if-none-match'];
    const ims = ctx.req.headers['if-modified-since'];
    const fresh = inm ? inm.split(',').map((s) => s.trim()).includes(etag)
      : !!(ims && lastModified && Math.floor(new Date(lastModified).getTime() / 1000) <= Math.floor(new Date(ims).getTime() / 1000));
    if (fresh) { delete h['Content-Type']; return ctx.send(304, '', h); }
  }
  let out = buf;
  if (buf.length > 1024 && /\bgzip\b/.test(String(ctx.req.headers['accept-encoding'] || ''))) { out = zlib.gzipSync(buf, { level: 6 }); h['Content-Encoding'] = 'gzip'; }
  h['Content-Length'] = out.length;
  ctx.send(status, ctx.method === 'HEAD' ? '' : out, h);
}

async function lastMod() {
  const r = await db.one(`select greatest(
      (select max(greatest(p.modified_at, p.updated_at, coalesce(p.published_at, p.publish_at))) from blog_posts p where ${blog.LIVE}),
      (select max(updated_at) from blog_authors)) as m`);
  return r && r.m ? new Date(r.m) : new Date(0);
}

async function notFoundPage(ctx, what) {
  const [cats, latest] = await Promise.all([blog.categories(), blog.latest(3)]);
  send(ctx, 404, pages.notFoundPage({ cats, latest, what }), { cache: 'no-store' });
}

/** ?page=N → a page number; null when it must redirect (?page=1 or junk) */
function pageOf(ctx) {
  if (ctx.query.page === undefined) return 1;
  const n = Number(ctx.query.page);
  return Number.isInteger(n) && n >= 2 && n <= 10000 ? n : null;
}

const xml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const day = (d) => new Date(d).toISOString().slice(0, 10);

async function sitemapParts() {
  const on = await blogOn();
  const pagesList = [{ loc: '/', changefreq: 'weekly', priority: '1.0' }, ...LEGAL.map((l) => ({ loc: '/legal/' + l.slug, changefreq: 'yearly', priority: '0.3' }))];
  let posts = [];
  if (on) {
    await blog.publishDue();
    const [cats, authors, ps] = await Promise.all([blog.categories(), blog.authors(), blog.sitemapPosts()]);
    posts = ps;
    pagesList.push({ loc: '/blog', lastmod: ps[0] ? ps.reduce((a, p) => (p.lastmod > a ? p.lastmod : a), ps[0].lastmod) : null, changefreq: 'daily', priority: '0.8' });
    for (const c of cats.filter((x) => x.posts > 0)) pagesList.push({ loc: '/blog/category/' + c.slug, lastmod: c.last_mod, changefreq: 'weekly', priority: '0.5' });
    for (const a of authors.filter((x) => x.posts > 0)) pagesList.push({ loc: '/blog/author/' + a.slug, lastmod: a.last_mod, changefreq: 'weekly', priority: '0.4' });
  }
  return { pagesList, posts: posts.map((p) => ({ loc: '/blog/' + p.slug, lastmod: p.lastmod, changefreq: 'monthly', priority: '0.7' })) };
}
const urlset = (urls) => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${xml(config.appUrl + u.loc)}</loc>${u.lastmod ? `<lastmod>${day(u.lastmod)}</lastmod>` : ''}${u.changefreq ? `<changefreq>${u.changefreq}</changefreq>` : ''}${u.priority ? `<priority>${u.priority}</priority>` : ''}</url>`).join('\n')}\n</urlset>\n`;
const XML = 'application/xml; charset=utf-8';

module.exports = (r) => {
  r.get('/robots.txt', async (ctx) => send(ctx, 200,
    `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin\nDisallow: /#app\nDisallow: /blog/preview/\n\nSitemap: ${config.appUrl}/sitemap.xml\n`,
    { type: 'text/plain; charset=utf-8', cache: 'public, max-age=3600' }));

  r.get('/sitemap.xml', async (ctx) => {
    const { pagesList, posts } = await sitemapParts();
    const chunk = blog.SITEMAP_CHUNK;
    if (pagesList.length + posts.length <= chunk) return send(ctx, 200, urlset([...pagesList, ...posts]), { type: XML, cache: 'public, max-age=600' });
    const parts = ['pages', ...Array.from({ length: Math.ceil(posts.length / chunk) }, (_, i) => `posts-${i + 1}`)];
    const newest = posts.reduce((a, p) => (!a || p.lastmod > a ? p.lastmod : a), null);
    send(ctx, 200, `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${parts.map((p) => `<sitemap><loc>${xml(`${config.appUrl}/sitemap/${p}.xml`)}</loc>${newest ? `<lastmod>${day(newest)}</lastmod>` : ''}</sitemap>`).join('\n')}\n</sitemapindex>\n`, { type: XML, cache: 'public, max-age=600' });
  });
  r.get('/sitemap/:file', async (ctx) => {
    const m = /^(pages|posts-(\d{1,5}))\.xml$/.exec(ctx.params.file);
    if (!m) throw notFound('That sitemap');
    const { pagesList, posts } = await sitemapParts();
    if (m[1] === 'pages') return send(ctx, 200, urlset(pagesList), { type: XML, cache: 'public, max-age=600' });
    const n = Number(m[2]), chunk = blog.SITEMAP_CHUNK;
    const part = posts.slice((n - 1) * chunk, n * chunk);
    if (!part.length) throw notFound('That sitemap');
    send(ctx, 200, urlset(part), { type: XML, cache: 'public, max-age=600' });
  });

  /** The 3 newest posts for the homepage. */
  r.get('/api/public/blog/latest', async (ctx) => {
    let posts = [];
    if (await blogOn()) {
      await blog.publishDue();
      const n = Math.min(6, Math.max(1, Number(ctx.query.n) || 3));
      posts = (await blog.latest(n)).map((p) => ({
        title: p.title, url: '/blog/' + p.slug, description: pages.cut(p.description, 150), category: p.category_name || null,
        category_url: p.category_slug ? '/blog/category/' + p.category_slug : null, date: p.live_at, reading_time: blog.readingTime(blog.rendered(p, pages.ctaHtml).words),
        image: p.cover_url || `/blog/og/${p.slug}.svg?style=card`, image_alt: p.cover_url ? p.cover_alt : '', author: p.author_name || null,
      }));
    }
    send(ctx, 200, JSON.stringify({ posts }), { type: 'application/json; charset=utf-8', cache: 'public, max-age=120' });
  });

  r.get('/blog', async (ctx) => {
    if (!(await blogOn())) throw notFound('That page');
    await blog.publishDue();
    const page = pageOf(ctx);
    if (page === null) return ctx.redirect('/blog', 301);
    const [list, feat, cats, co, lm] = await Promise.all([blog.listLive({ page }), page === 1 ? blog.featured() : null, blog.categories(), company(), lastMod()]);
    if (page > list.pages) return notFoundPage(ctx, 'page');
    let featured = feat;
    if (page === 1 && !featured && list.posts.length > 3) featured = list.posts[0];
    send(ctx, 200, pages.indexPage({ list, feat: featured, cats, company: co, page }), { lastModified: lm });
  });

  r.get('/blog/rss.xml', async (ctx) => {
    if (!(await blogOn())) throw notFound('That page');
    await blog.publishDue();
    const { posts } = await blog.listLive({ page: 1, perPage: 20 });
    const lm = await lastMod();
    const items = posts.map((p) => `<item><title>${xml(p.title)}</title><link>${xml(config.appUrl + '/blog/' + p.slug)}</link><guid isPermaLink="true">${xml(config.appUrl + '/blog/' + p.slug)}</guid><pubDate>${new Date(p.live_at).toUTCString()}</pubDate>${p.author_name ? `<dc:creator>${xml(p.author_full_name || p.author_name)}</dc:creator>` : ''}${p.category_name ? `<category>${xml(p.category_name)}</category>` : ''}${(p.tags || []).map((t) => `<category>${xml(t)}</category>`).join('')}<description>${xml(p.description)}</description></item>`).join('\n');
    send(ctx, 200, `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
<title>Castvoo Blog</title>
<link>${xml(config.appUrl + '/blog')}</link>
<description>Guides, comparisons and media buying playbooks to grow and automate Telegram channels, groups and bots.</description>
<language>en</language>
<lastBuildDate>${lm.toUTCString()}</lastBuildDate>
<atom:link href="${xml(config.appUrl + '/blog/rss.xml')}" rel="self" type="application/rss+xml"/>
<image><url>${xml(config.appUrl + pages.LOGO)}</url><title>Castvoo Blog</title><link>${xml(config.appUrl + '/blog')}</link></image>
${items}
</channel>
</rss>
`, { type: 'application/rss+xml; charset=utf-8', lastModified: lm, cache: 'public, max-age=600' });
  });

  r.get('/blog/og/:file', async (ctx) => {
    const m = /^([a-z0-9-]+)\.svg$/.exec(ctx.params.file);
    const p = m && (await blogOn()) ? await blog.bySlug(m[1]) : null;
    if (!p) throw notFound('That image');
    send(ctx, 200, ctx.query.style === 'card' ? blog.cardSvg(p) : blog.ogSvg(p), { type: 'image/svg+xml', lastModified: p.updated_at, cache: 'public, max-age=86400', extra: { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Content-Type-Options': 'nosniff' } });
  });

  r.get('/blog/media/:file', async (ctx) => {
    const f = await blog.imageFile(ctx.params.file);
    if (!f) throw notFound('That image');
    const st = await fs.promises.stat(f.path).catch(() => null);
    if (!st) throw notFound('That image');
    ctx.res.writeHead(200, { 'Content-Type': f.mime, 'Content-Length': st.size, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
    if (ctx.method === 'HEAD') { ctx.res.end(); ctx.sent = true; return; }
    require('../app').sendFile(f.path, ctx.res);
    ctx.sent = true;
  });

  r.get('/blog/avatars/:slug', async (ctx) => {
    const f = await blog.avatarFile(ctx.params.slug);
    if (!f) throw notFound('That picture');
    const cache = ctx.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
    if (f.svg) return send(ctx, 200, f.svg, { type: 'image/svg+xml', cache, extra: { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Content-Type-Options': 'nosniff' } });
    const st = await fs.promises.stat(f.path);
    ctx.res.writeHead(200, { 'Content-Type': f.mime, 'Content-Length': st.size, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
    if (ctx.method === 'HEAD') { ctx.res.end(); ctx.sent = true; return; }
    require('../app').sendFile(f.path, ctx.res);
    ctx.sent = true;
  });

  /** A signed preview link from the admin (drafts and scheduled posts). Never indexed or cached. */
  r.get('/blog/preview/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || !blog.checkPreview(id, ctx.query.e, ctx.query.t)) throw notFound('That preview link');
    const p = await blog.byId(id);
    if (!p) throw notFound('That post');
    const [related, cats, co] = await Promise.all([blog.related(p), blog.categories(), company()]);
    send(ctx, 200, pages.articlePage({ p, related, cats, company: co, preview: true }), { cache: 'private, no-store', extra: { 'X-Robots-Tag': 'noindex, nofollow' } });
  });

  for (const kind of ['category', 'tag', 'author']) {
    r.get(`/blog/${kind}/:slug`, async (ctx) => {
      if (!(await blogOn())) throw notFound('That page');
      await blog.publishDue();
      const slug = String(ctx.params.slug).toLowerCase();
      const page = pageOf(ctx);
      if (page === null) return ctx.redirect(`/blog/${kind}/${encodeURIComponent(slug)}`, 301);
      const [cats, lm] = await Promise.all([blog.categories(), lastMod()]);
      if (kind === 'author') {
        const a = await blog.author(slug);
        if (!a) return notFoundPage(ctx, 'author');
        const list = await blog.listLive({ page, authorId: a.id });
        if (page > list.pages) return notFoundPage(ctx, 'page');
        return send(ctx, 200, pages.authorPage({ a, list, cats, page }), { lastModified: lm });
      }
      let name, description, list;
      if (kind === 'category') {
        const c = await blog.category(slug);
        if (!c) return notFoundPage(ctx, 'topic');
        name = c.name; description = c.description;
        list = await blog.listLive({ page, categoryId: c.id });
      } else {
        name = await blog.tagName(slug);
        if (!name) return notFoundPage(ctx, 'tag');
        list = await blog.listLive({ page, tag: slug });
      }
      if (page > list.pages) return notFoundPage(ctx, 'page');
      // A tag with only one or two posts is a thin page: kept out of search results, links still followed.
      const robots = kind === 'tag' && list.total < 3 ? 'noindex,follow' : undefined;
      send(ctx, 200, pages.listingPage({ kind, name, description, slug, list, cats, page, robots }), { lastModified: lm });
    });
  }

  r.get('/blog/:slug', async (ctx) => {
    if (!(await blogOn())) throw notFound('That page');
    await blog.publishDue();
    const raw = String(ctx.params.slug);
    const slug = raw.toLowerCase();
    let p = await blog.bySlug(slug);
    if (p && raw !== slug) return ctx.redirect('/blog/' + slug, 301);
    if (!p) {
      const to = await blog.redirectFor(slug);
      if (to) return ctx.redirect('/blog/' + to, 301);
      return notFoundPage(ctx, 'post');
    }
    const [related, cats, co] = await Promise.all([blog.related(p), blog.categories(), company()]);
    send(ctx, 200, pages.articlePage({ p, related, cats, company: co }), { lastModified: new Date(Math.max(new Date(p.updated_at), new Date(p.author_updated_at || 0))) });
  });
};

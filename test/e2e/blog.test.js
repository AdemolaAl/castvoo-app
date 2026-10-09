'use strict';
/* The SEO blog: server-rendered pages, SEO tags and JSON-LD, drafts, scheduling, slug redirects, sitemap / robots / RSS,
 * markdown safety, the admin CMS and its permissions, the seed loader and the homepage JSON. */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startApp, FILES } = require('../helpers/app');

let app, owner, marketing, support, viewer, cat, author;
before(async () => {
  app = await startApp();
  owner = await app.owner();
  marketing = await app.staff('marketing', 'blog-mkt@castvoo.test');
  support = await app.staff('support', 'blog-sup@castvoo.test');
  viewer = await app.staff('viewer', 'blog-view@castvoo.test');
  cat = await app.db.one("select * from blog_categories where slug = 'guides'");
  author = await app.db.one("select * from blog_authors where slug = 'dchessking'");
});
after(async () => { if (app) await app.stop(); });
beforeEach(() => { app.rl._reset(); app.require('services/blog')._resetDue(); });

const BODY = (extra = '') => `Welcome bots greet every **new member** of your Telegram channel. This guide shows how a telegram welcome bot works.

## Why welcome people

Most people who ask to join never hear from you. See [our pricing](/#pricing) and [Telegram](https://telegram.org).

### The 5-minute window

- One
- Two
  - Nested

| Tool | Free |
|---|---|
| Castvoo | Yes |

## How to set it up

1. Connect the bot
2. Switch on a flow

> A quote

${extra}`;

let seq = 0;
async function makePost(client = owner, over = {}) {
  seq++;
  const r = await client.post('/api/admin/blog/posts', {
    title: over.title || `Telegram welcome bot guide ${seq}`, slug: over.slug, description: 'How a telegram welcome bot greets, lets in and follows up everyone who asks to join your Telegram channel, step by step.',
    focus_keyword: 'telegram welcome bot', body: over.body ?? BODY(), category_id: cat.id, author_id: author.id, tags: ['Telegram bots', 'Join requests'],
    takeaways: ['Welcome first, then approve.'], faq: [{ q: 'Is it free?', a: 'Yes, the **Free plan** covers [one channel](/#pricing).' }], itemlist: over.itemlist || [], ...over,
  });
  assert.equal(r.status, 200, r.text);
  return r.body.post;
}
const publish = async (id, client = owner, body = {}) => { const r = await client.post(`/api/admin/blog/posts/${id}/publish`, body); assert.equal(r.status, 200, r.text); return r.body.post; };
const ldBlocks = (text) => [...text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const ldTypes = (text) => ldBlocks(text).map((x) => x['@type']);
const meta = (text, name) => { const m = new RegExp(`<meta (?:name|property)="${name}" content="([^"]*)"`).exec(text); return m ? m[1] : null; };

/** A tiny XML well-formedness check: tags nest and close, entities are escaped, one root. */
function wellFormed(xml) {
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, '');
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/.test(body), 'unescaped &');
  const stack = [];
  let roots = 0;
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w:.-]*)([^>]*?)(\/?)>/g)) {
    const [, close, name, , self] = m;
    if (self) { if (!stack.length) roots++; continue; }
    if (close) { assert.equal(stack.pop(), name, 'tag nesting'); continue; }
    if (!stack.length) roots++;
    stack.push(name);
  }
  assert.equal(stack.length, 0, 'unclosed tags: ' + stack.join(','));
  assert.equal(roots, 1, 'one root element');
}

describe('public pages (server-rendered)', () => {
  it('the index lists live posts with title, description, canonical and Blog JSON-LD', async () => {
    const p = await makePost(owner, { title: 'Index page post' });
    await publish(p.id);
    const r = await app.client().get('/blog');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.ok(r.text.includes('Index page post'), 'post title in the HTML without JS');
    assert.ok(r.text.includes(`href="/blog/${p.slug}"`));
    const title = /<title>([^<]*)<\/title>/.exec(r.text)[1];
    assert.ok(title.length <= 60);
    assert.ok(meta(r.text, 'description').length <= 155);
    assert.ok(r.text.includes(`<link rel="canonical" href="${app.url}/blog">`));
    assert.ok(r.text.includes('application/rss+xml'));
    assert.ok(ldTypes(r.text).includes('Blog'));
    assert.ok(ldTypes(r.text).includes('BreadcrumbList'));
    assert.ok(!/<script>(?!\s*<\/script>)/.test(r.text), 'no inline scripts');
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  });

  it('an article has H1, author card, TOC, takeaways, FAQ accordion, CTA, share links and full JSON-LD', async () => {
    const p = await publish((await makePost(owner, { title: 'Article page post', seo_title: 'Article page post (SEO title)', itemlist: ['Why welcome people', 'How to set it up'] })).id);
    const r = await app.client().get('/blog/' + p.slug);
    assert.equal(r.status, 200);
    const t = r.text;
    assert.ok(t.includes('<title>Article page post (SEO title)</title>'));
    assert.ok(t.includes(`<link rel="canonical" href="${app.url}/blog/${p.slug}">`));
    assert.equal(meta(t, 'og:type'), 'article');
    assert.equal(meta(t, 'og:image'), `${app.url}/img/og-blog.png`);
    assert.equal(meta(t, 'twitter:card'), 'summary_large_image');
    assert.match(meta(t, 'robots'), /^index,follow/);
    assert.equal((t.match(/<h1[\s>]/g) || []).length, 1, 'exactly one H1');
    assert.ok(t.includes('<h2 id="why-welcome-people">'));
    assert.ok(t.includes('href="#why-welcome-people"'), 'table of contents');
    assert.ok(t.includes('class="keys"') && t.includes('Welcome first, then approve.'));
    assert.ok(/<details[^>]*><summary><span>Is it free\?<\/span>/.test(t), 'FAQ accordion');
    assert.ok(t.includes('<strong>Free plan</strong>'));
    assert.ok((t.match(/class="cta-block"/g) || []).length >= 2, 'CTA at ~40% and at the end');
    assert.ok(t.includes('Start free — welcome bot for your Telegram channel'));
    assert.ok(t.includes('class="tbl-wrap"'), 'tables scroll on phones');
    assert.ok(t.includes('href="https://telegram.org" rel="noopener" target="_blank"'));
    assert.ok(t.includes('href="/#pricing">our pricing'), 'internal links stay in the tab');
    for (const s of ['t.me/share/url', 'x.com/intent/post', 'wa.me/?text', 'linkedin.com/sharing']) assert.ok(t.includes(s), s);
    assert.ok(t.includes('data-copy="' + app.url + '/blog/' + p.slug + '"'));
    assert.ok(t.includes('href="/blog/author/dchessking"') && t.includes('Ejiro Segbuyota'));
    assert.ok(/\d+ min read/.test(t));
    const ld = ldBlocks(t);
    const post = ld.find((x) => x['@type'] === 'BlogPosting');
    assert.equal(post.headline, 'Article page post');
    assert.equal(post.mainEntityOfPage['@id'], `${app.url}/blog/${p.slug}`);
    assert.equal(post.author['@type'], 'Person');
    assert.equal(post.author.url, `${app.url}/blog/author/dchessking`);
    assert.equal(post.publisher['@type'], 'Organization');
    assert.ok(post.publisher.logo.url.endsWith('/img/castvoo-logo.png'));
    assert.ok(post.datePublished && post.dateModified && post.image.length);
    const crumbs = ld.find((x) => x['@type'] === 'BreadcrumbList');
    assert.deepEqual(crumbs.itemListElement.map((x) => x.name), ['Home', 'Blog', 'Guides', 'Article page post']);
    const faq = ld.find((x) => x['@type'] === 'FAQPage');
    assert.equal(faq.mainEntity[0].name, 'Is it free?');
    assert.equal(faq.mainEntity[0].acceptedAnswer.text, 'Yes, the Free plan covers one channel.');
    const list = ld.find((x) => x['@type'] === 'ItemList');
    assert.deepEqual(list.itemListElement.map((x) => x.name), ['Why welcome people', 'How to set it up']);
    assert.equal(list.itemListElement[0].url, `${app.url}/blog/${p.slug}#why-welcome-people`);
  });

  it('category, tag and author pages render with their own titles, canonical and JSON-LD', async () => {
    const p = await publish((await makePost(owner, { title: 'Listing page post', tags: ['Unique tag zz'] })).id);
    const c = await app.client().get('/blog/category/guides');
    assert.equal(c.status, 200);
    assert.ok(c.text.includes('Listing page post'));
    assert.ok(c.text.includes(`<link rel="canonical" href="${app.url}/blog/category/guides">`));
    assert.ok(ldTypes(c.text).includes('CollectionPage'));
    const tg = await app.client().get('/blog/tag/unique-tag-zz');
    assert.equal(tg.status, 200);
    assert.ok(tg.text.includes('#Unique tag zz'));
    assert.match(meta(tg.text, 'robots'), /noindex,follow/, 'thin tag page is not indexed');
    const a = await app.client().get('/blog/author/dchessking');
    assert.equal(a.status, 200);
    assert.ok(a.text.includes('Dchessking') && a.text.includes('former economics and mathematics teacher'));
    const person = ldBlocks(a.text).find((x) => x['@type'] === 'Person');
    assert.equal(person.name, 'Ejiro Segbuyota');
    assert.equal(person.alternateName, 'Dchessking');
    assert.ok(ldTypes(a.text).includes('ProfilePage'));
    const av = await app.client().get('/blog/avatars/dchessking');
    assert.equal(av.status, 200);
    assert.match(av.headers.get('content-type'), /svg/);
    const og = await app.client().get(`/blog/og/${p.slug}.svg`);
    assert.equal(og.status, 200);
    assert.ok(og.text.startsWith('<svg') && og.text.includes('Listing page post'));
  });

  it('missing posts, categories, authors and pages get a real 404 page with links', async () => {
    for (const u of ['/blog/no-such-post', '/blog/category/nope', '/blog/author/nope', '/blog/tag/nope', '/blog?page=999']) {
      const r = await app.client().get(u);
      assert.equal(r.status, 404, u);
      assert.match(r.headers.get('content-type'), /text\/html/);
      assert.ok(r.text.includes('href="/blog"') && r.text.includes('noindex'), u);
    }
    const one = await app.client().get('/blog?page=1');
    assert.equal(one.status, 301);
    assert.equal(one.headers.get('location'), '/blog');
  });

  it('pagination: ?page=2 has its own canonical and prev/next links', async () => {
    const blog = app.require('services/blog');
    const live = (await blog.listLive({ page: 1 })).total;
    for (let i = live; i < blog.PER_PAGE + 2; i++) await publish((await makePost(owner, { title: `Pagination filler ${i}` })).id);
    const r1 = await app.client().get('/blog');
    assert.ok(r1.text.includes(`<link rel="next" href="${app.url}/blog?page=2">`));
    const r2 = await app.client().get('/blog?page=2');
    assert.equal(r2.status, 200);
    assert.ok(r2.text.includes(`<link rel="canonical" href="${app.url}/blog?page=2">`));
    assert.ok(r2.text.includes(`<link rel="prev" href="${app.url}/blog">`));
  });

  it('pages carry ETag and Last-Modified, answer 304 when unchanged, and are gzipped', async () => {
    const r = await app.client().get('/blog');
    const etag = r.headers.get('etag');
    assert.ok(etag && r.headers.get('last-modified'));
    const again = await app.client().get('/blog', { headers: { 'if-none-match': etag } });
    assert.equal(again.status, 304);
    const res = await fetch(app.url + '/blog', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(res.headers.get('content-encoding'), 'gzip');
    assert.ok((await res.text()).includes('<html'), 'fetch unzips it');
  });
});

describe('drafts, scheduling and old addresses', () => {
  it('drafts are hidden everywhere, but a signed preview link shows them (noindex)', async () => {
    const p = await makePost(owner, { title: 'Secret draft post' });
    assert.equal((await app.client().get('/blog/' + p.slug)).status, 404);
    assert.ok(!(await app.client().get('/blog')).text.includes('Secret draft post'));
    assert.ok(!(await app.client().get('/sitemap.xml')).text.includes(p.slug));
    assert.ok(!(await app.client().get('/blog/rss.xml')).text.includes(p.slug));
    assert.ok(!JSON.stringify((await app.client().get('/api/public/blog/latest?n=6')).body).includes(p.slug));
    assert.equal((await app.client().get(`/blog/og/${p.slug}.svg`)).status, 404);
    const link = await owner.get(`/api/admin/blog/posts/${p.id}/preview-link`);
    assert.equal(link.status, 200);
    const pv = await app.client().get(link.body.url);
    assert.equal(pv.status, 200);
    assert.ok(pv.text.includes('Secret draft post'));
    assert.match(meta(pv.text, 'robots'), /noindex/);
    assert.match(pv.headers.get('x-robots-tag'), /noindex/);
    const bad = link.body.url.replace(/t=[^&]+/, 't=' + 'a'.repeat(32));
    assert.equal((await app.client().get(bad)).status, 404);
    const other = link.body.url.replace(`/preview/${p.id}?`, `/preview/${p.id + 1000}?`);
    assert.equal((await app.client().get(other)).status, 404, 'a link only opens its own post');
  });

  it('a scheduled post goes live by itself when its time comes', async () => {
    const p = await makePost(owner, { title: 'Scheduled post' });
    const at = new Date(Date.now() + 3600000).toISOString();
    const s = await publish(p.id, owner, { at });
    assert.equal(s.status, 'scheduled');
    assert.equal((await app.client().get('/blog/' + p.slug)).status, 404);
    await app.db.query("update blog_posts set publish_at = now() - interval '1 minute' where id = $1", [p.id]);
    app.require('services/blog')._resetDue();
    const r = await app.client().get('/blog/' + p.slug);
    assert.equal(r.status, 200);
    const row = await app.db.one('select status, published_at from blog_posts where id = $1', [p.id]);
    assert.equal(row.status, 'published', 'publishDue turned it into a published post');
    assert.ok(row.published_at);
    // Unpublish takes it off the site.
    assert.equal((await owner.post(`/api/admin/blog/posts/${p.id}/unpublish`)).status, 200);
    assert.equal((await app.client().get('/blog/' + p.slug)).status, 404);
  });

  it('a changed slug answers 301 from the old address, and a slug can be taken back', async () => {
    const p = await publish((await makePost(owner, { title: 'Old address post', slug: 'old-address-post' })).id);
    const r = await owner.put('/api/admin/blog/posts/' + p.id, { slug: 'new-address-post' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.slug_changed, true);
    const old = await app.client().get('/blog/old-address-post');
    assert.equal(old.status, 301);
    assert.equal(old.headers.get('location'), '/blog/new-address-post');
    assert.equal((await app.client().get('/blog/new-address-post')).status, 200);
    assert.equal((await app.client().get('/blog/New-Address-Post')).status, 301, 'one canonical case');
    // Another post may take the old slug: it then stops redirecting.
    const q = await publish((await makePost(owner, { title: 'Takes the old slug', slug: 'old-address-post' })).id);
    assert.equal((await app.client().get('/blog/old-address-post')).status, 200);
    assert.ok((await app.client().get('/blog/old-address-post')).text.includes('Takes the old slug'));
    // Two posts can't share a current slug.
    assert.equal((await owner.put('/api/admin/blog/posts/' + q.id, { slug: 'new-address-post' })).status, 400);
    const chk = await owner.get(`/api/admin/blog/slug?slug=new-address-post&id=${q.id}`);
    assert.equal(chk.body.ok, false);
    assert.equal((await owner.get(`/api/admin/blog/slug?slug=New Address Post&id=${p.id}`)).body.slug, 'new-address-post');
  });
});

describe('sitemap, robots and RSS', () => {
  it('robots.txt allows all, blocks the API and admin, and names the sitemap', async () => {
    const r = await app.client().get('/robots.txt');
    assert.equal(r.status, 200);
    for (const l of ['User-agent: *', 'Allow: /', 'Disallow: /api/', 'Disallow: /admin', 'Disallow: /#app', `Sitemap: ${app.url}/sitemap.xml`]) assert.ok(r.text.includes(l), l);
  });

  it('sitemap.xml is valid XML with the home, legal, blog, categories, authors and every live post with lastmod', async () => {
    const p = await publish((await makePost(owner, { title: 'Sitemap post' })).id);
    const r = await app.client().get('/sitemap.xml');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /xml/);
    wellFormed(r.text);
    for (const u of ['/', '/legal/privacy', '/blog', '/blog/category/guides', '/blog/author/dchessking']) assert.ok(r.text.includes(`<loc>${app.url}${u}</loc>`), u);
    assert.match(r.text, new RegExp(`<loc>${app.url}/blog/${p.slug}</loc><lastmod>\\d{4}-\\d{2}-\\d{2}</lastmod>`));
  });

  it('becomes a sitemap index when there are more URLs than fit in one file', async () => {
    const blog = app.require('services/blog');
    blog._setSitemapChunk(3);
    try {
      const r = await app.client().get('/sitemap.xml');
      wellFormed(r.text);
      assert.ok(r.text.includes('<sitemapindex'));
      assert.ok(r.text.includes(`<loc>${app.url}/sitemap/pages.xml</loc>`));
      const pages = await app.client().get('/sitemap/pages.xml');
      wellFormed(pages.text);
      assert.ok(pages.text.includes(`<loc>${app.url}/blog</loc>`));
      const posts = await app.client().get('/sitemap/posts-1.xml');
      wellFormed(posts.text);
      assert.equal((posts.text.match(/<url>/g) || []).length, 3);
      assert.equal((await app.client().get('/sitemap/posts-999.xml')).status, 404);
    } finally { blog._setSitemapChunk(1000); }
  });

  it('rss.xml is valid RSS 2.0 with the newest live posts', async () => {
    const p = await publish((await makePost(owner, { title: 'RSS post & friends' })).id);
    const r = await app.client().get('/blog/rss.xml');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /rss\+xml/);
    wellFormed(r.text);
    assert.ok(r.text.includes('<rss version="2.0"'));
    assert.ok(r.text.includes('<title>RSS post &amp; friends</title>'));
    assert.ok(r.text.includes(`<link>${app.url}/blog/${p.slug}</link>`));
    assert.ok(r.text.includes('rel="self"'));
  });
});

describe('markdown safety', () => {
  it('HTML, javascript: links and onerror attributes in a post are shown as text, never run', async () => {
    const evil = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(2)>',
      '[click](javascript:alert(3))',
      '[click2](JaVaScRiPt:alert(4))',
      '[data](data:text/html;base64,PHNjcmlwdD4=)',
      '![x" onerror="alert(5)](https://example.com/a.png)',
      '![y](javascript:alert(6))',
      '<a href="javascript:alert(7)">a</a>',
      '<iframe src="https://evil.example"></iframe>',
      '## Heading <svg onload=alert(8)>',
    ].join('\n\n');
    const p = await publish((await makePost(owner, { title: 'XSS <b>title</b>', body: evil, faq: [{ q: 'Q <script>x</script>', a: '[a](javascript:alert(9)) <img onerror=1>' }], takeaways: ['<script>t</script>'] })).id);
    const r = await app.client().get('/blog/' + p.slug);
    assert.equal(r.status, 200);
    const main = r.text.slice(r.text.indexOf('<main'), r.text.indexOf('</main>'));
    assert.ok(!/<script/i.test(main), 'no script tags');
    const tagsOnly = main.replace(/="[^"]*"/g, '=""'); // attribute values are text, not attributes
    assert.ok(!/<[a-z]+\b[^>]*\son\w+=/i.test(tagsOnly), 'no event handler attributes');
    assert.ok(!/href="\s*(javascript|data):/i.test(main) && !/src="\s*(javascript|data):/i.test(main), 'no javascript:/data: urls');
    assert.ok(!/<iframe/i.test(main));
    assert.ok(main.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(main.includes('XSS &lt;b&gt;title&lt;/b&gt;'));
    assert.ok(main.includes('alt="x&quot; onerror=&quot;alert(5)"'), 'quotes in alt text stay inside the attribute');
    const head = r.text.slice(0, r.text.indexOf('</head>'));
    for (const block of ldBlocks(head)) assert.ok(block); // JSON-LD still parses
    assert.ok(!/<\/script><script>/i.test(head.replace(/<script (type="application\/ld\+json"|src=)[^>]*>/g, '')), 'JSON-LD cannot break out of its tag');
    // The renderer on its own:
    const md = app.require('lib/markdown');
    assert.equal(md.safeUrl('java\nscript:alert(1)'), null);
    assert.equal(md.safeUrl('vbscript:x'), null);
    assert.equal(md.safeUrl('mailto:hi@castvoo.com'), 'mailto:hi@castvoo.com');
    assert.equal(md.safeUrl('/blog/x'), '/blog/x');
    assert.equal(md.safeUrl('#faq'), '#faq');
    assert.equal(md.safeUrl('mailto:x', { image: true }), null);
  });

  it('the admin cannot set a javascript: cover image', async () => {
    const r = await owner.post('/api/admin/blog/posts', { title: 'Bad cover', cover_url: 'javascript:alert(1)', cover_alt: 'x' });
    assert.equal(r.status, 400);
  });
});

describe('admin CMS', () => {
  it('Marketing writes, saves, publishes and deletes; every change is in the audit log', async () => {
    const p = await makePost(marketing, { title: 'Marketing post' });
    assert.equal(p.status, 'draft');
    const s = await marketing.put('/api/admin/blog/posts/' + p.id, { title: 'Marketing post v2', body: BODY('More text.') });
    assert.equal(s.status, 200, s.text);
    assert.equal(s.body.post.title, 'Marketing post v2');
    assert.ok(s.body.seo.checks.length >= 10);
    await publish(p.id, marketing);
    const list = await marketing.get('/api/admin/blog/posts?q=Marketing%20post&status=published');
    assert.ok(list.body.posts.some((x) => x.id === p.id));
    assert.ok(list.body.categories.length && list.body.authors.length);
    assert.equal((await marketing.get(`/api/admin/blog/posts?category=${cat.id}&author=${author.id}`)).status, 200);
    assert.equal((await marketing.del('/api/admin/blog/posts/' + p.id)).status, 200);
    assert.equal((await app.client().get('/blog/' + p.slug)).status, 404);
    const audit = await app.db.many("select action from audit_log where target = $1 order by id", ['post:' + p.id]);
    assert.deepEqual(audit.map((a) => a.action), ['blog.post_create', 'blog.post_save', 'blog.post_publish', 'blog.post_delete']);
  });

  it('Support and Viewer can read but not edit or publish', async () => {
    const p = await makePost(owner, { title: 'Read only post' });
    for (const c of [support, viewer]) {
      assert.equal((await c.get('/api/admin/blog/posts')).status, 200);
      assert.equal((await c.get('/api/admin/blog/posts/' + p.id)).status, 200);
      assert.equal((await c.post('/api/admin/blog/preview', { body: '## Hi' })).status, 200);
      assert.equal((await c.post('/api/admin/blog/posts', { title: 'Nope' })).status, 403);
      assert.equal((await c.put('/api/admin/blog/posts/' + p.id, { title: 'Nope' })).status, 403);
      assert.equal((await c.post(`/api/admin/blog/posts/${p.id}/publish`)).status, 403);
      assert.equal((await c.del('/api/admin/blog/posts/' + p.id)).status, 403);
      assert.equal((await c.post('/api/admin/blog/authors', { name: 'X' })).status, 403);
      assert.equal((await c.post('/api/admin/blog/categories', { name: 'X' })).status, 403);
    }
    const cust = await app.loginByEmail('blog-customer@example.com');
    assert.equal((await cust.get('/api/admin/blog/posts')).status, 403);
    assert.equal((await app.client().get('/api/admin/blog/posts')).status, 401);
  });

  it('publishing needs a description, body, category and author', async () => {
    const r = await owner.post('/api/admin/blog/posts', { title: 'Incomplete post' });
    assert.equal(r.status, 200);
    const pub = await owner.post(`/api/admin/blog/posts/${r.body.post.id}/publish`);
    assert.equal(pub.status, 400);
    assert.match(pub.body.error, /meta description/);
  });

  it('keeps the last 10 versions and restores one', async () => {
    const p = await makePost(owner, { title: 'Version 0' });
    for (let i = 1; i <= 11; i++) assert.equal((await owner.put('/api/admin/blog/posts/' + p.id, { title: 'Version ' + i })).status, 200);
    const d = await owner.get('/api/admin/blog/posts/' + p.id);
    assert.equal(d.body.revisions.length, 10);
    const target = d.body.revisions[3]; // Version 8
    const r = await owner.post(`/api/admin/blog/posts/${p.id}/revisions/${target.id}/restore`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.post.title, 'Version 8');
    assert.equal((await app.db.one('select count(*)::int n from blog_revisions where post_id = $1', [p.id])).n, 10);
  });

  it('the preview endpoint renders like the blog and scores SEO', async () => {
    const r = await owner.post('/api/admin/blog/preview', { title: 'Telegram welcome bot', slug: 'telegram-welcome-bot-x', description: 'A telegram welcome bot that greets everyone.', focus_keyword: 'telegram welcome bot', body: BODY() });
    assert.equal(r.status, 200);
    assert.ok(r.body.html.includes('<h2 id="why-welcome-people">'));
    const by = Object.fromEntries(r.body.seo.checks.map((c) => [c.key, c.ok]));
    assert.equal(by.kw_title, true);
    assert.equal(by.kw_h1, true);
    assert.equal(by.kw_intro, true);
    assert.equal(by.kw_desc, true);
    assert.equal(by.kw_slug, true);
    assert.equal(by.h2, true);
    assert.equal(by.internal, true);
    assert.equal(by.words, false);
    assert.ok(r.body.seo.score > 0 && r.body.seo.score < 100);
    assert.ok(r.body.seo.reading_time >= 1);
  });

  it('categories and authors: create, edit, photo, refuse deleting one in use', async () => {
    const c = await owner.post('/api/admin/blog/categories', { name: 'Case Studies', description: 'Real results.' });
    assert.equal(c.status, 200, c.text);
    assert.equal(c.body.category.slug, 'case-studies');
    assert.equal((await owner.post('/api/admin/blog/categories', { name: 'case studies' })).status, 400, 'no duplicates');
    assert.equal((await owner.put('/api/admin/blog/categories/' + c.body.category.id, { description: 'Changed.' })).status, 200);
    const a = await owner.post('/api/admin/blog/authors', { name: 'Ada Writer', role: 'Editor', bio: 'Writes.', same_as: 'https://www.linkedin.com/in/ada\nhttps://x.com/ada' });
    assert.equal(a.status, 200, a.text);
    assert.deepEqual(a.body.author.same_as, ['https://www.linkedin.com/in/ada', 'https://x.com/ada']);
    assert.equal((await owner.post('/api/admin/blog/authors', { name: 'Bad', same_as: 'javascript:alert(1)' })).status, 400);
    const ph = await owner.post(`/api/admin/blog/authors/${a.body.author.id}/photo`, FILES.png(), { headers: { 'content-type': 'image/png' } });
    assert.equal(ph.status, 200, ph.text);
    const img = await app.client().get('/blog/avatars/ada-writer');
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    const p = await makePost(owner, { title: 'Uses the new ones', category_id: c.body.category.id, author_id: a.body.author.id });
    assert.equal((await owner.del('/api/admin/blog/categories/' + c.body.category.id)).status, 400);
    assert.equal((await owner.del('/api/admin/blog/authors/' + a.body.author.id)).status, 400);
    await owner.del('/api/admin/blog/posts/' + p.id);
    assert.equal((await owner.del('/api/admin/blog/categories/' + c.body.category.id)).status, 200);
    assert.equal((await owner.del('/api/admin/blog/authors/' + a.body.author.id)).status, 200);
  });

  it('uploads images (checked by signature), serves them, and reads their size', async () => {
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from([0, 0, 4, 176, 0, 0, 2, 118]), Buffer.alloc(200)]);
    const r = await owner.post('/api/admin/blog/images?alt=Diagram', png, { headers: { 'content-type': 'image/png' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.width, 1200);
    assert.equal(r.body.height, 630);
    const f = await app.client().get(r.body.url);
    assert.equal(f.status, 200);
    assert.equal(f.headers.get('content-type'), 'image/png');
    const fake = await owner.post('/api/admin/blog/images', Buffer.from('<svg onload=alert(1)>'), { headers: { 'content-type': 'image/png' } });
    assert.equal(fake.status, 400);
    assert.equal((await marketing.post('/api/admin/blog/images', png, { headers: { 'content-type': 'image/png' } })).status, 200);
    assert.equal((await viewer.post('/api/admin/blog/images', png, { headers: { 'content-type': 'image/png' } })).status, 403);
  });
});

describe('seed loader (server/blog-seed)', () => {
  const md = (slug, title, extra = '') => `---
title: "${title}"
slug: "${slug}"
description: "A seeded post about telegram broadcasts, for the loader test."
seo_title: "${title}"
focus_keyword: "telegram broadcast"
category: "Media Buying"
tags: ["telegram broadcast", "seed test"]
author: "castvoo-team"
date: "2026-01-05"
updated: "2026-02-01"
featured: false
takeaways: ["First point", "Second point"]
itemlist: ["Item 1", "Item 2"]
faq:
  - q: "Does it work?"
    a: "Yes, it does."
  - q: "Second question?"
    a: "Second answer."
${extra}---
## Intro

Body of ${title}.
`;

  it('inserts new seed posts once, never overwrites edits and never brings back deleted posts', async () => {
    const blog = app.require('services/blog');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-seed-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.md'), md('seed-test-a', 'Seed test A'));
      fs.writeFileSync(path.join(dir, 'b.md'), md('seed-test-b', 'Seed test B'));
      fs.writeFileSync(path.join(dir, 'notes.md'), '# Not a post (no front matter)');
      const first = await blog.syncSeed({ dir });
      assert.deepEqual(first.inserted.sort(), ['seed-test-a', 'seed-test-b']);
      const a = await app.db.one("select p.*, c.name as cat, au.slug as au from blog_posts p join blog_categories c on c.id = p.category_id join blog_authors au on au.id = p.author_id where p.slug = 'seed-test-a'");
      assert.equal(a.status, 'published');
      assert.equal(a.cat, 'Media Buying');
      assert.equal(a.au, 'castvoo-team');
      assert.deepEqual(a.tags, ['telegram broadcast', 'seed test']);
      assert.deepEqual(a.faq, [{ q: 'Does it work?', a: 'Yes, it does.' }, { q: 'Second question?', a: 'Second answer.' }]);
      assert.deepEqual(a.takeaways, ['First point', 'Second point']);
      assert.deepEqual(a.itemlist, ['Item 1', 'Item 2']);
      assert.equal(new Date(a.published_at).toISOString().slice(0, 10), '2026-01-05');
      assert.equal(new Date(a.modified_at).toISOString().slice(0, 10), '2026-02-01');
      assert.equal((await app.client().get('/blog/seed-test-a')).status, 200);

      // The team edits A and deletes B. The files change too. Nothing comes back or is overwritten.
      assert.equal((await owner.put('/api/admin/blog/posts/' + a.id, { title: 'Edited by the team' })).status, 200);
      const b = await app.db.one("select id from blog_posts where slug = 'seed-test-b'");
      assert.equal((await owner.del('/api/admin/blog/posts/' + b.id)).status, 200);
      fs.writeFileSync(path.join(dir, 'a.md'), md('seed-test-a', 'Seed test A, new text from the writer'));
      const again = await blog.syncSeed({ dir });
      assert.deepEqual(again.inserted, []);
      assert.equal((await app.db.one("select title from blog_posts where slug = 'seed-test-a'")).title, 'Edited by the team');
      assert.equal(await app.db.one("select 1 from blog_posts where slug = 'seed-test-b'"), null);

      // A new file is still picked up; a slug the team already uses is left alone.
      fs.writeFileSync(path.join(dir, 'c.md'), md('seed-test-c', 'Seed test C'));
      await makePost(owner, { title: 'Team took this slug', slug: 'seed-test-d' });
      fs.writeFileSync(path.join(dir, 'd.md'), md('seed-test-d', 'Seed test D'));
      const third = await blog.syncSeed({ dir });
      assert.deepEqual(third.inserted, ['seed-test-c']);
      assert.equal((await app.db.one("select title from blog_posts where slug = 'seed-test-d'")).title, 'Team took this slug');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('a post dated in the future is scheduled, not published', async () => {
    const blog = app.require('services/blog');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-seed-'));
    try {
      fs.writeFileSync(path.join(dir, 'f.md'), md('seed-test-future', 'Future seed').replace('date: "2026-01-05"', 'date: "2099-01-01"'));
      await blog.syncSeed({ dir });
      const r = await app.db.one("select status, publish_at from blog_posts where slug = 'seed-test-future'");
      assert.equal(r.status, 'scheduled');
      assert.equal((await app.client().get('/blog/seed-test-future')).status, 404);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('the shipped seed files parse and load on start', async () => {
    const fm = app.require('lib/frontmatter');
    const dir = app.require('services/blog').SEED_DIR;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      const { data, body } = fm.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      assert.ok(data.title && data.slug && data.description && body.length > 200, f);
      assert.ok(String(data.description).length <= 155, f + ' description ≤ 155');
      if (data.seo_title) assert.ok(String(data.seo_title).length <= 60, f + ' seo_title ≤ 60');
      assert.ok(await app.db.one('select 1 from blog_posts where slug = $1', [data.slug]), f + ' was seeded');
    }
  });
});

describe('homepage and switches', () => {
  it('/api/public/blog/latest gives the 3 newest live posts with crawlable links', async () => {
    const p = await publish((await makePost(owner, { title: 'Newest for the homepage' })).id);
    const r = await app.client().get('/api/public/blog/latest');
    assert.equal(r.status, 200);
    assert.equal(r.body.posts.length, 3);
    assert.equal(r.body.posts[0].title, 'Newest for the homepage');
    assert.equal(r.body.posts[0].url, '/blog/' + p.slug);
    assert.ok(r.body.posts[0].reading_time >= 1 && r.body.posts[0].image);
    const home = await app.client().get('/');
    assert.ok(home.text.includes('href="/blog"'), 'Blog link in the homepage HTML');
    assert.ok(home.text.includes('id="fromBlog"'));
  });

  it('the Blog switch in Admin → Features turns the public blog off', async () => {
    await app.setFeature('blog', false);
    try {
      assert.equal((await app.client().get('/blog')).status, 404);
      assert.deepEqual((await app.client().get('/api/public/blog/latest')).body.posts, []);
      assert.ok(!(await app.client().get('/sitemap.xml')).text.includes('/blog'));
      assert.equal((await owner.get('/api/admin/blog/posts')).status, 200, 'the admin still works');
    } finally { await app.setFeature('blog', true); }
  });

  it('legal pages link to the blog in their footer', async () => {
    const r = await app.client().get('/legal/terms');
    assert.ok(r.text.includes('<a href="/blog">Blog</a>'));
  });
});

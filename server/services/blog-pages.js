'use strict';
/*
 * The blog's server-rendered HTML pages (crawlers get the full content without JavaScript):
 * index, article, category, tag, author, preview and 404. Styles: public/css/blog.css; the only script is
 * public/js/blog.js (copy-link button and closing the phone menu). Data comes from services/blog.js.
 * Everything that comes from the database is escaped here; post bodies come out of lib/markdown.js already safe.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const blog = require('./blog');
const md = require('../lib/markdown');
const { escHtml: e } = require('../lib/util');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const V = (() => {
  const h = crypto.createHash('sha1');
  for (const f of ['css/blog.css', 'js/blog.js']) { try { h.update(fs.readFileSync(path.join(PUBLIC, f))); } catch { /* missing in some tests */ } }
  return h.digest('hex').slice(0, 10);
})();
const OG_DEFAULT = '/img/og-blog.png';
const LOGO = '/img/castvoo-logo.png';

const abs = (u) => (/^https?:\/\//i.test(u) ? u : config.appUrl + (u.startsWith('/') ? u : '/' + u));
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const d = (x) => new Date(x);
const shortDate = (x) => `${d(x).getUTCDate()} ${MON[d(x).getUTCMonth()]} ${d(x).getUTCFullYear()}`;
const longDate = (x) => `${d(x).getUTCDate()} ${MONTHS[d(x).getUTCMonth()]} ${d(x).getUTCFullYear()}`;
const iso = (x) => d(x).toISOString();
const isoDay = (x) => d(x).toISOString().slice(0, 10);
/** Cut text to n characters on a word boundary. */
function cut(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  const c = s.slice(0, n - 1);
  return (c.slice(0, Math.max(c.lastIndexOf(' '), n * 0.6)).replace(/[\s,.:;–—-]+$/, '')) + '…';
}
const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}</script>`;
const postUrl = (p) => `/blog/${p.slug}`;
const imageOf = (p) => (p.cover_url ? p.cover_url : `/blog/og/${p.slug}.svg?style=card&v=${new Date(p.updated_at || 0).getTime().toString(36)}`);
const ogImageOf = (p) => (p.cover_url ? abs(p.cover_url) : abs(OG_DEFAULT));

/* ---------------- icons (inline SVG, no sprite needed) ---------------- */
const I = {
  logo: '<svg class="lm" viewBox="0 0 40 40" aria-hidden="true"><defs><linearGradient id="blgB" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5A8CFF"/><stop offset=".5" stop-color="#2F6BFF"/><stop offset="1" stop-color="#1846DB"/></linearGradient></defs><rect width="40" height="40" rx="12" fill="url(#blgB)"/><rect x="1" y="1" width="38" height="19" rx="11" fill="#fff" opacity=".1"/><path d="M24.6 13.6A9 9 0 1 0 24.6 26.4" fill="none" stroke="#fff" stroke-width="4.6" stroke-linecap="round"/><circle cx="29" cy="20" r="3.3" fill="#fff"/><circle cx="34.6" cy="20" r="1.8" fill="#fff" opacity=".7"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  chev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  login: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 7V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-2M3 12h11M10 8l4 4-4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  mail: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="m4 7 8 6 8-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  rss: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="6" cy="18" r="1.8" fill="currentColor"/></svg>',
  tg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.5 4.2 2.9 11.4c-1.3.5-1.2 1.2-.2 1.5l4.8 1.5 1.8 5.6c.2.6.4.8.9.8.4 0 .6-.2.9-.4l2.3-2.2 4.7 3.5c.9.5 1.5.2 1.7-.8l3.1-14.6c.3-1.3-.5-1.8-1.4-1.4zM9.6 14.6l8.5-7.6c.4-.3-.1-.5-.6-.2L7.8 13" fill="currentColor"/></svg>',
  xlogo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.8 3h3.1l-6.8 7.7L22 21h-6.2l-4.9-6.4L5.3 21H2.2l7.2-8.3L1.8 3h6.4l4.4 5.8zm-1.1 16.2h1.7L7.4 4.7H5.6z" fill="currentColor"/></svg>',
  wa: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.4.1-.2 0-.3 0-.5l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.7a2.7 2.7 0 0 0 1.8-1.3 2.2 2.2 0 0 0 .2-1.3c-.1-.1-.3-.2-.5-.3z" fill="currentColor"/></svg>',
  li: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM3 9.5h4v11H3zM9.5 9.5h3.8v1.6h.1c.5-1 1.8-2 3.8-2 4 0 4.8 2.6 4.8 6v5.4h-4v-4.8c0-1.2 0-2.6-1.6-2.6s-1.9 1.3-1.9 2.5v4.9h-4z" fill="currentColor"/></svg>',
  link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  spark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" fill="currentColor"/></svg>',
  join: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9.5" cy="8" r="3.6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 20c.6-3.6 3.3-5.6 6.5-5.6 1.4 0 2.7.4 3.8 1.1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M15.5 17.2l2.3 2.3 4-4.4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ext: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

/* ---------------- shared pieces ---------------- */
const NAV = [['/#features', 'Features'], ['/#guide', 'Setup guide'], ['/#ai', 'AI'], ['/#pricing', 'Pricing'], ['/blog', 'Blog'], ['/#faq', 'FAQ']];
function header() {
  const links = NAV.map(([h, t]) => `<a href="${h}"${h === '/blog' ? ' class="on" aria-current="page"' : ''}>${t}</a>`).join('');
  return `<a class="skip" href="#main">Skip to content</a>
<header class="bh"><div class="bw bh-in">
  <a class="logo" href="/" aria-label="Castvoo home">${I.logo}<span class="wm">Cast<b>voo</b></span></a>
  <nav class="bnav" aria-label="Main">${links}</nav>
  <div class="bh-r">
    <a class="login" href="/#login">${I.login}<span>Log in</span></a>
    <a class="btn b-blue sm hstart" href="/#signup">Start free</a>
    <details class="bm"><summary aria-label="Open menu">${I.menu}</summary>
      <div class="bm-pn"><nav aria-label="Menu">${NAV.map(([h, t]) => `<a href="${h}"${h === '/blog' ? ' class="on"' : ''}>${t}${I.chev}</a>`).join('')}</nav>
      <div class="bm-cta"><a class="btn b-blue" href="/#signup">Start free trial</a><a class="btn b-ghost" href="/#login">Log in</a></div></div>
    </details>
  </div>
</div></header>`;
}
function footer(cats) {
  return `<footer class="bf"><div class="bw bf-in">
  <div class="bf-c"><a class="logo" href="/">${I.logo}<span class="wm">Cast<b>voo</b></span></a><p>Every Telegram join, greeted and followed up.</p>
    <p><a class="fmail" href="mailto:support@castvoo.com">${I.mail}<span>support@castvoo.com</span></a></p></div>
  <nav aria-label="Product"><b>Product</b><a href="/#features">Features</a><a href="/#guide">Setup guide</a><a href="/#pricing">Pricing</a><a href="/#faq">FAQ</a><a href="/blog">Blog</a><a href="/#login">Log in</a></nav>
  <nav aria-label="Blog topics"><b>Blog</b>${(cats || []).filter((c) => c.posts > 0).map((c) => `<a href="/blog/category/${e(c.slug)}">${e(c.name)}</a>`).join('')}<a href="/blog/rss.xml">RSS feed</a></nav>
  <nav aria-label="Legal"><b>Legal</b><a href="/legal/terms">Terms</a><a href="/legal/privacy">Privacy</a><a href="/legal/refunds">Refunds</a><a href="/legal/acceptable-use">Acceptable use</a><a href="/legal/cookies">Cookies</a></nav>
</div><div class="bw bf-b"><span>© ${new Date().getUTCFullYear()} Zedapex</span><span>Castvoo is not affiliated with Telegram.</span></div></footer>`;
}

function layout(o) {
  const title = cut(o.title, 60);
  const desc = cut(o.description, 155);
  const canonical = o.canonical ? abs(o.canonical) : null;
  const img = o.ogImage || abs(OG_DEFAULT);
  const imgW = o.ogImage && !o.ogImage.endsWith(OG_DEFAULT) ? '' : '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${e(title)}</title>
<meta name="description" content="${e(desc)}">
<meta name="robots" content="${o.robots || 'index,follow,max-image-preview:large'}">
${canonical ? `<link rel="canonical" href="${e(canonical)}">` : ''}
${o.prev ? `<link rel="prev" href="${e(abs(o.prev))}">` : ''}${o.next ? `<link rel="next" href="${e(abs(o.next))}">` : ''}
<link rel="alternate" type="application/rss+xml" title="Castvoo Blog" href="${e(abs('/blog/rss.xml'))}">
<meta name="theme-color" content="#2F6BFF">
<link rel="icon" href="/img/favicon.svg" type="image/svg+xml">
<meta property="og:site_name" content="Castvoo">
<meta property="og:locale" content="en_US">
<meta property="og:type" content="${o.ogType || 'website'}">
<meta property="og:title" content="${e(o.ogTitle || title)}">
<meta property="og:description" content="${e(desc)}">
${canonical ? `<meta property="og:url" content="${e(canonical)}">` : ''}
<meta property="og:image" content="${e(img)}">${imgW}
<meta property="og:image:alt" content="${e(o.ogImageAlt || o.ogTitle || title)}">
${o.article ? `<meta property="article:published_time" content="${iso(o.article.published)}"><meta property="article:modified_time" content="${iso(o.article.modified)}">${o.article.section ? `<meta property="article:section" content="${e(o.article.section)}">` : ''}${(o.article.tags || []).map((t) => `<meta property="article:tag" content="${e(t)}">`).join('')}` : ''}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${e(o.ogTitle || title)}">
<meta name="twitter:description" content="${e(desc)}">
<meta name="twitter:image" content="${e(img)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Instrument+Serif:ital@1&family=JetBrains+Mono:wght@500;600&display=swap">
<link rel="stylesheet" href="/css/blog.css?v=${V}">
<script src="/js/blog.js?v=${V}" defer></script>
${(o.jsonld || []).map(ld).join('\n')}
</head>
<body class="${o.bodyClass || ''}">
${o.banner || ''}${header()}
${o.body}
${footer(o.cats)}
</body>
</html>`;
}

/* ---------------- building blocks ---------------- */
const avatar = (p, size = 32, cls = 'av') => `<img class="${cls}" src="${e(blog.avatarUrl(p))}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async">`;
const catPill = (p) => (p.category_slug ? `<a class="pill" href="/blog/category/${e(p.category_slug)}">${e(p.category_name)}</a>` : '');
const readMin = (p) => blog.readingTime(blog.rendered(p, ctaHtml).words);

function card(p, { eager = false } = {}) {
  const live = p.live_at || p.published_at || p.created_at;
  return `<article class="pc">
  <a class="pc-img" href="${postUrl(p)}" tabindex="-1" aria-hidden="true"><img src="${e(imageOf(p))}" alt="" width="1200" height="630" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async"></a>
  <div class="pc-b">${catPill(p)}
    <h3><a href="${postUrl(p)}">${e(p.title)}</a></h3>
    <p>${e(cut(p.description, 150))}</p>
    <div class="meta">${p.author_slug ? `${avatar(p, 26)}<span class="mn">${e(p.author_name)}</span><span class="dot" aria-hidden="true"></span>` : ''}<time datetime="${isoDay(live)}">${shortDate(live)}</time><span class="dot" aria-hidden="true"></span><span>${readMin(p)} min read</span></div>
  </div>
</article>`;
}
function featuredCard(p) {
  const live = p.live_at || p.published_at;
  return `<article class="feat">
  <a class="feat-img" href="${postUrl(p)}" tabindex="-1" aria-hidden="true"><img src="${e(imageOf(p))}" alt="" width="1200" height="630" fetchpriority="high" decoding="async"></a>
  <div class="feat-b"><div class="feat-k"><span class="fk">${I.spark}Featured</span>${catPill(p)}</div>
    <h2><a href="${postUrl(p)}">${e(p.title)}</a></h2>
    <p>${e(cut(p.description, 200))}</p>
    <div class="meta">${p.author_slug ? `${avatar(p, 30)}<span class="mn">${e(p.author_name)}</span><span class="dot" aria-hidden="true"></span>` : ''}<time datetime="${isoDay(live)}">${shortDate(live)}</time><span class="dot" aria-hidden="true"></span><span>${readMin(p)} min read</span></div>
    <a class="btn b-ink sm" href="${postUrl(p)}">Read the guide ${I.arrow}</a>
  </div>
</article>`;
}
function pager(base, page, pages) {
  if (pages <= 1) return '';
  const href = (n) => (n <= 1 ? base : `${base}?page=${n}`);
  const nums = [];
  for (let n = 1; n <= pages; n++) {
    if (n === 1 || n === pages || Math.abs(n - page) <= 1) nums.push(n);
    else if (nums[nums.length - 1] !== '…') nums.push('…');
  }
  return `<nav class="pager" aria-label="Pages">
  ${page > 1 ? `<a class="pg-a" href="${href(page - 1)}" rel="prev">${I.back}<span>Newer</span></a>` : '<span class="pg-a off" aria-hidden="true">' + I.back + '<span>Newer</span></span>'}
  <span class="pg-n">${nums.map((n) => (n === '…' ? '<span class="gap">…</span>' : n === page ? `<span class="cur" aria-current="page">${n}</span>` : `<a href="${href(n)}">${n}</a>`)).join('')}</span>
  ${page < pages ? `<a class="pg-a" href="${href(page + 1)}" rel="next"><span>Older</span>${I.arrow}</a>` : '<span class="pg-a off" aria-hidden="true"><span>Older</span>' + I.arrow + '</span>'}
</nav>`;
}
function catNav(cats, active) {
  return `<nav class="cats" aria-label="Blog categories"><a href="/blog"${!active ? ' class="on" aria-current="page"' : ''}>All posts</a>${cats.filter((c) => c.posts > 0 || c.slug === active).map((c) => `<a href="/blog/category/${e(c.slug)}"${c.slug === active ? ' class="on" aria-current="page"' : ''}>${e(c.name)}<small>${c.posts}</small></a>`).join('')}</nav>`;
}
/** The "Start free" box: placed in the article at about 40% (or where [[cta]] is) and again at the end. */
function ctaHtml(text) {
  return `<aside class="cta-block" aria-label="Start free with Castvoo"><span class="cta-ic">${I.join}</span><div class="cta-t"><b>${e(text || 'Start free — welcome bot for your Telegram channel')}</b><span>Greet and follow up everyone who asks to join, on autopilot. Free plan, no card.</span></div><a class="btn b-blue sm" href="/#signup">Start free ${I.arrow}</a></aside>`;
}
function ctaBand() {
  return `<section class="band" aria-label="Try Castvoo"><div class="bw"><div class="band-in"><div class="band-glow" aria-hidden="true"></div>
  <div class="band-t"><span class="kick sky">Castvoo</span><h2>Your ads keep bringing people. <em>Greet every one.</em></h2><p>Connect your Telegram channel, switch on a Welcome Flow, and your next join request gets a hello in seconds.</p></div>
  <div class="band-c"><a class="btn b-blue" href="/#signup">Start free — no card ${I.arrow}</a><a class="band-l" href="/#pricing">See pricing</a></div></div></div></section>`;
}
function shareLinks(url, title) {
  const u = encodeURIComponent(url), t = encodeURIComponent(title);
  return `<div class="share" aria-label="Share this post"><span class="share-l">Share</span>
  <a href="https://t.me/share/url?url=${u}&amp;text=${t}" target="_blank" rel="noopener" aria-label="Share on Telegram" class="s-tg">${I.tg}</a>
  <a href="https://x.com/intent/post?url=${u}&amp;text=${t}" target="_blank" rel="noopener" aria-label="Share on X" class="s-x">${I.xlogo}</a>
  <a href="https://wa.me/?text=${t}%20${u}" target="_blank" rel="noopener" aria-label="Share on WhatsApp" class="s-wa">${I.wa}</a>
  <a href="https://www.linkedin.com/sharing/share-offsite/?url=${u}" target="_blank" rel="noopener" aria-label="Share on LinkedIn" class="s-li">${I.li}</a>
  <button type="button" class="s-copy" data-copy="${e(url)}" hidden>${I.link}<span>Copy link</span></button>
</div>`;
}
function tocList(toc) {
  return `<ol>${toc.map((t) => `<li class="l${t.level}"><a href="#${e(t.id)}">${e(t.text)}</a></li>`).join('')}</ol>`;
}

/* ---------------- JSON-LD ---------------- */
function org(company) {
  return {
    '@type': 'Organization', '@id': abs('/#organization'), name: 'Castvoo', url: abs('/'),
    logo: { '@type': 'ImageObject', url: abs(LOGO), width: 512, height: 512 },
    parentOrganization: { '@type': 'Organization', name: company || 'Zedapex' },
  };
}
function person(a) {
  const slug = a.author_slug || a.slug;
  const name = a.author_name || a.name;
  const full = a.author_full_name ?? a.full_name;
  const sameAs = (a.author_same_as || a.same_as || []).filter((x) => /^https?:\/\//.test(x));
  const p = { '@type': 'Person', '@id': abs(`/blog/author/${slug}#person`), name: full || name, url: abs(`/blog/author/${slug}`), image: abs(blog.avatarUrl(a)) };
  if (full && full !== name) p.alternateName = name;
  const role = a.author_role ?? a.role;
  if (role) p.jobTitle = role;
  const bio = a.author_bio ?? a.bio;
  if (bio) p.description = cut(bio, 300);
  if (sameAs.length) p.sameAs = sameAs;
  return p;
}
const crumbsLd = (items) => ({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items.map(([name, url], i) => ({ '@type': 'ListItem', position: i + 1, name, ...(url ? { item: abs(url) } : {}) })) });
function crumbs(items) {
  return `<nav class="crumbs" aria-label="Breadcrumb"><ol>${items.map(([name, url], i) => (i === items.length - 1 ? `<li><span aria-current="page">${e(cut(name, 60))}</span></li>` : `<li><a href="${e(url)}">${e(name)}</a></li>`)).join('')}</ol></nav>`;
}

/* ---------------- pages ---------------- */
function indexPage({ list, feat, cats, company, page }) {
  const base = '/blog';
  const posts = list.posts.filter((p) => !feat || p.id !== feat.id);
  const body = `<main id="main">
<section class="bhero"><div class="bw">
  <span class="kick">Castvoo blog</span>
  <h1 class="bh1">Grow your Telegram, <em>on autopilot.</em></h1>
  <p class="lead">Guides, honest comparisons and media buying playbooks for channel owners, community managers and media buyers who run on Telegram.</p>
  ${catNav(cats)}
</div></section>
${feat ? `<section class="bw sec-f" aria-label="Featured post">${featuredCard(feat)}</section>` : ''}
<section class="bw sec-l" aria-labelledby="latestH">
  <div class="sh"><h2 id="latestH">${page > 1 ? `Older posts · page ${page}` : 'Latest posts'}</h2><a class="rss" href="/blog/rss.xml">${I.rss}<span>RSS</span></a></div>
  ${posts.length ? `<div class="pgrid">${posts.map((p, i) => card(p, { eager: !feat && i === 0 })).join('')}</div>` : `<div class="empty"><b>The first posts are on their way.</b><p>Guides on welcoming, broadcasting to and following up your Telegram audience are coming soon.</p><a class="btn b-blue sm" href="/#signup">Start free meanwhile ${I.arrow}</a></div>`}
  ${pager(base, page, list.pages)}
</section>
${ctaBand()}
</main>`;
  const blogLd = {
    '@context': 'https://schema.org', '@type': 'Blog', '@id': abs('/blog#blog'), name: 'Castvoo Blog', url: abs('/blog'), inLanguage: 'en',
    description: 'Guides, comparisons and media buying playbooks for growing and automating Telegram channels, groups and bots.',
    publisher: org(company),
    blogPost: list.posts.map((p) => ({ '@type': 'BlogPosting', headline: cut(p.title, 110), url: abs(postUrl(p)), datePublished: iso(p.live_at), dateModified: iso(maxDate(p.modified_at, p.live_at)), image: ogImageOf(p), author: { '@type': 'Person', name: p.author_full_name || p.author_name, url: abs(`/blog/author/${p.author_slug}`) } })),
  };
  return layout({
    title: page > 1 ? `Castvoo Blog · Page ${page}` : 'Castvoo Blog: Telegram growth guides and playbooks',
    description: page > 1 ? `Older guides and playbooks from the Castvoo blog, page ${page}: Telegram welcome bots, broadcasts, follow-ups and media buying.` : 'Guides, comparisons and media buying playbooks to grow and automate your Telegram channel, group and bot: welcome bots, broadcasts and follow-ups.',
    canonical: page > 1 ? `${base}?page=${page}` : base,
    prev: page > 1 ? (page === 2 ? base : `${base}?page=${page - 1}`) : null,
    next: page < list.pages ? `${base}?page=${page + 1}` : null,
    jsonld: [blogLd, crumbsLd([['Home', '/'], ['Blog', '/blog']])],
    body, cats,
  });
}

function listingPage({ kind, name, description, slug, list, cats, page, robots }) {
  const base = `/blog/${kind}/${slug}`;
  const label = kind === 'tag' ? `#${name}` : name;
  const body = `<main id="main">
<section class="bhero sm"><div class="bw">
  ${crumbs([['Home', '/'], ['Blog', '/blog'], [label, base]])}
  <span class="kick">${kind === 'tag' ? 'Tag' : 'Category'}</span>
  <h1 class="bh1">${e(label)}</h1>
  ${description ? `<p class="lead">${e(description)}</p>` : ''}
  ${kind === 'category' ? catNav(cats, slug) : ''}
</div></section>
<section class="bw sec-l" aria-label="Posts">
  ${list.posts.length ? `<div class="pgrid">${list.posts.map((p, i) => card(p, { eager: i === 0 })).join('')}</div>` : '<div class="empty"><b>No posts here yet.</b><p>New posts are on their way.</p><a class="btn b-ink sm" href="/blog">See all posts</a></div>'}
  ${pager(base, page, list.pages)}
</section>
${ctaBand()}
</main>`;
  const title = kind === 'tag' ? `${name}: posts tagged · Castvoo Blog` : `${name} · Castvoo Blog`;
  return layout({
    title: page > 1 ? `${cut(label, 36)} · page ${page} · Castvoo Blog` : title,
    description: description || `Castvoo blog posts tagged ${name}: practical guides on Telegram welcome bots, broadcasts and follow-ups.`,
    canonical: page > 1 ? `${base}?page=${page}` : base,
    prev: page > 1 ? (page === 2 ? base : `${base}?page=${page - 1}`) : null,
    next: page < list.pages ? `${base}?page=${page + 1}` : null,
    robots,
    jsonld: [
      { '@context': 'https://schema.org', '@type': 'CollectionPage', name: label, url: abs(base), isPartOf: { '@id': abs('/blog#blog') }, mainEntity: { '@type': 'ItemList', itemListElement: list.posts.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: abs(postUrl(p)), name: p.title })) } },
      crumbsLd([['Home', '/'], ['Blog', '/blog'], [label, base]]),
    ],
    body, cats,
  });
}

function authorPage({ a, list, cats, page }) {
  const base = `/blog/author/${a.slug}`;
  const same = (a.same_as || []).filter((x) => /^https?:\/\//.test(x));
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  const body = `<main id="main">
<section class="bhero sm"><div class="bw">
  ${crumbs([['Home', '/'], ['Blog', '/blog'], [a.name, base]])}
  <div class="ahero">
    <img class="av-xl" src="${e(blog.avatarUrl(a))}" alt="${e(a.name)}" width="120" height="120">
    <div><span class="kick">Author</span><h1 class="bh1">${e(a.name)}</h1>
    ${a.full_name && a.full_name !== a.name ? `<p class="aname">${e(a.full_name)}${a.role ? ` · ${e(a.role)}` : ''}</p>` : a.role ? `<p class="aname">${e(a.role)}</p>` : ''}
    ${a.bio ? `<p class="lead">${e(a.bio)}</p>` : ''}
    ${same.length ? `<p class="same">${same.map((u) => `<a href="${e(u)}" rel="noopener me" target="_blank">${I.ext}${e(host(u))}</a>`).join('')}</p>` : ''}</div>
  </div>
</div></section>
<section class="bw sec-l" aria-labelledby="byH">
  <div class="sh"><h2 id="byH">Posts by ${e(a.name)}</h2></div>
  ${list.posts.length ? `<div class="pgrid">${list.posts.map((p) => card(p)).join('')}</div>` : '<div class="empty"><b>No posts yet.</b></div>'}
  ${pager(base, page, list.pages)}
</section>
${ctaBand()}
</main>`;
  return layout({
    title: `${a.name}${a.full_name && a.full_name !== a.name ? ` (${a.full_name})` : ''} · Castvoo Blog`,
    description: a.bio || `Posts by ${a.name} on the Castvoo blog.`,
    canonical: page > 1 ? `${base}?page=${page}` : base,
    ogType: 'profile', ogImage: abs(blog.avatarUrl(a)).replace(/\?.*$/, ''),
    jsonld: [
      { '@context': 'https://schema.org', '@type': 'ProfilePage', url: abs(base), mainEntity: person(a) },
      { '@context': 'https://schema.org', ...person(a) },
      crumbsLd([['Home', '/'], ['Blog', '/blog'], [a.name, base]]),
    ],
    body, cats,
  });
}

const maxDate = (...xs) => xs.filter(Boolean).map((x) => new Date(x)).reduce((a, b) => (b > a ? b : a));

function articlePage({ p, related, cats, company, preview = false }) {
  const r = blog.rendered(p, ctaHtml);
  const url = abs(postUrl(p));
  const live = p.live_at || p.published_at || p.publish_at || p.created_at;
  const modified = maxDate(p.modified_at, live);
  const showUpdated = isoDay(modified) !== isoDay(live);
  const mins = blog.readingTime(r.words);
  const toc = [...r.toc];
  if (p.faq && p.faq.length) toc.push({ level: 2, id: 'faq', text: 'FAQ' });
  const crumb = [['Home', '/'], ['Blog', '/blog'], ...(p.category_slug ? [[p.category_name, `/blog/category/${p.category_slug}`]] : []), [p.title, postUrl(p)]];
  const faqHtml = p.faq && p.faq.length ? `<section class="faq" aria-labelledby="faq"><h2 id="faq">Frequently asked questions</h2>${p.faq.map((f, i) => `<details${i === 0 ? ' open' : ''}><summary><span>${e(f.q)}</span><i aria-hidden="true"></i></summary><div class="faq-a"><p>${md.renderInline(f.a, { appUrl: config.appUrl })}</p></div></details>`).join('')}</section>` : '';
  const takeaways = p.takeaways && p.takeaways.length ? `<aside class="keys" aria-label="Key takeaways"><b class="keys-t">${I.spark}Key takeaways</b><ul>${p.takeaways.map((t) => `<li>${I.check}<span>${md.renderInline(t, { appUrl: config.appUrl })}</span></li>`).join('')}</ul></aside>` : '';
  const tags = (p.tags || []).map((t, i) => `<a href="/blog/tag/${e((p.tag_slugs || [])[i] || blog.slugify(t))}">#${e(t)}</a>`).join('');
  const authorCard = p.author_slug ? `<section class="acard" aria-label="About the author"><a href="/blog/author/${e(p.author_slug)}" tabindex="-1" aria-hidden="true">${avatar(p, 72, 'av-l')}</a><div><span class="kick">Written by</span><h2><a href="/blog/author/${e(p.author_slug)}">${e(p.author_name)}</a>${p.author_full_name && p.author_full_name !== p.author_name ? ` <small>${e(p.author_full_name)}</small>` : ''}</h2>${p.author_role ? `<p class="ar">${e(p.author_role)}</p>` : ''}${p.author_bio ? `<p>${e(p.author_bio)}</p>` : ''}<a class="more" href="/blog/author/${e(p.author_slug)}">More from ${e(p.author_name)} ${I.arrow}</a></div></section>` : '';
  const body = `<main id="main" class="art">
<div class="bw">
  ${crumbs(crumb)}
  <header class="ah">
    ${catPill(p)}
    <h1>${e(p.title)}</h1>
    ${p.description ? `<p class="lead">${e(p.description)}</p>` : ''}
    <div class="byline">
      ${p.author_slug ? `<a class="by-av" href="/blog/author/${e(p.author_slug)}" tabindex="-1" aria-hidden="true">${avatar(p, 46, 'av-m')}</a><div class="by-w"><a class="by-n" href="/blog/author/${e(p.author_slug)}" rel="author">${e(p.author_name)}</a>${p.author_role ? `<span class="by-r">${e(p.author_role)}</span>` : ''}</div>` : ''}
      <div class="by-m"><span><time datetime="${iso(live)}">${longDate(live)}</time></span><span class="dot" aria-hidden="true"></span><span>${I.clock}${mins} min read</span>${showUpdated ? `<span class="dot" aria-hidden="true"></span><span class="upd">Updated <time datetime="${iso(modified)}">${longDate(modified)}</time></span>` : ''}</div>
    </div>
  </header>
  ${p.cover_url ? `<figure class="cover"><img src="${e(p.cover_url)}" alt="${e(p.cover_alt)}" width="1200" height="630" fetchpriority="high" decoding="async"></figure>` : ''}
  <div class="alay">
    <article class="prose" id="article">
      ${toc.length >= 2 ? `<details class="toc-m"><summary>On this page <small>${toc.length} sections</small><i aria-hidden="true"></i></summary><nav aria-label="On this page">${tocList(toc)}</nav></details>` : ''}
      ${takeaways}
      ${r.html}
      ${faqHtml}
      ${ctaHtml('Start free — welcome bot for your Telegram channel')}
      ${tags ? `<div class="tags" aria-label="Tags">${tags}</div>` : ''}
      ${shareLinks(url, p.title)}
      ${authorCard}
    </article>
    <aside class="aside">${toc.length >= 2 ? `<nav class="toc" aria-label="Table of contents"><b>On this page</b>${tocList(toc)}</nav>` : ''}
      <div class="mini"><b>Welcome every new member</b><p>Castvoo greets, lets in and follows up everyone who asks to join your Telegram channel.</p><a class="btn b-blue sm" href="/#signup">Start free</a></div></aside>
  </div>
</div>
${related.length ? `<section class="rel" aria-labelledby="relH"><div class="bw"><div class="sh"><h2 id="relH">Keep reading</h2><a class="more" href="/blog">All posts ${I.arrow}</a></div><div class="pgrid">${related.map((x) => card(x)).join('')}</div></div></section>` : ''}
</main>`;
  const image = ogImageOf(p);
  const ldPost = {
    '@context': 'https://schema.org', '@type': 'BlogPosting', '@id': url + '#article', mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    headline: cut(p.title, 110), description: cut(p.description, 300), image: [image], url,
    datePublished: iso(live), dateModified: iso(modified), inLanguage: 'en', wordCount: r.words,
    ...(p.category_name ? { articleSection: p.category_name } : {}), ...(p.tags && p.tags.length ? { keywords: p.tags.join(', ') } : {}),
    ...(p.author_slug ? { author: person(p) } : {}), publisher: org(company), isPartOf: { '@type': 'Blog', '@id': abs('/blog#blog'), name: 'Castvoo Blog' },
  };
  const jsonld = [ldPost, crumbsLd(crumb)];
  if (p.faq && p.faq.length) jsonld.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: p.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: md.stripTags(md.renderInline(f.a, { appUrl: config.appUrl })) } })) });
  if (p.itemlist && p.itemlist.length) {
    const n = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    jsonld.push({
      '@context': 'https://schema.org', '@type': 'ItemList', name: p.title, numberOfItems: p.itemlist.length,
      itemListElement: p.itemlist.map((name, i) => {
        const h = r.toc.find((t) => n(t.text).includes(n(name)));
        return { '@type': 'ListItem', position: i + 1, name, ...(h ? { url: `${url}#${h.id}` } : {}) };
      }),
    });
  }
  return layout({
    title: p.seo_title || ((p.title.length + 10 <= 60) ? `${p.title} · Castvoo` : p.title),
    description: p.description,
    ogTitle: p.title,
    canonical: postUrl(p),
    robots: preview ? 'noindex,nofollow' : undefined,
    ogType: 'article', ogImage: image, ogImageAlt: p.cover_url ? p.cover_alt : p.title,
    article: { published: live, modified, section: p.category_name, tags: p.tags },
    banner: preview ? `<div class="pv-bar" role="status"><b>Preview</b><span>${p.status === 'scheduled' ? `Scheduled for ${e(longDate(p.publish_at))}` : p.status === 'published' ? 'This post is live' : 'Draft: only people with this link can see it'}. Search engines don't index previews.</span></div>` : '',
    jsonld: preview ? [] : jsonld,
    body, cats,
  });
}

function notFoundPage({ cats, latest, what = 'post' }) {
  const body = `<main id="main">
<section class="bhero nf"><div class="bw">
  <span class="kick">Error 404</span>
  <h1 class="bh1">We couldn't find that ${e(what)}. <em>Try these instead.</em></h1>
  <p class="lead">The address may be mistyped, or the post was moved or taken down. Here are the newest posts and every topic.</p>
  <div class="nf-a"><a class="btn b-blue" href="/blog">Go to the blog ${I.arrow}</a><a class="btn b-ghost" href="/">Castvoo home</a></div>
  ${catNav(cats)}
</div></section>
${latest.length ? `<section class="bw sec-l" aria-labelledby="nfH"><div class="sh"><h2 id="nfH">Latest posts</h2></div><div class="pgrid">${latest.map((p) => card(p)).join('')}</div></section>` : ''}
</main>`;
  return layout({ title: 'Page not found · Castvoo Blog', description: 'This blog page does not exist. See the latest Castvoo guides and topics.', robots: 'noindex,follow', body, cats });
}

module.exports = { indexPage, listingPage, authorPage, articlePage, notFoundPage, ctaHtml, cut, abs, OG_DEFAULT, LOGO, postUrl, ogImageOf };

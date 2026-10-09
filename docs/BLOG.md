# The Castvoo blog

`castvoo.com/blog` is a server-rendered, SEO-first blog. Pages are plain HTML made by the server, so Google, Bing
and social previews see every word without running JavaScript. Posts are written in **Admin → Blog**.

| Address | What it is |
|---|---|
| `/blog`, `/blog?page=2` | All posts: featured post, categories, latest posts, pages of 9 |
| `/blog/<slug>` | A post |
| `/blog/category/<slug>` | A category (Guides, Comparisons, Growth, Media Buying, Product…) |
| `/blog/author/<slug>` | An author page (`/blog/author/dchessking`, `/blog/author/castvoo-team`) |
| `/blog/tag/<slug>` | Posts with a tag (tags with fewer than 3 posts are `noindex`) |
| `/blog/rss.xml` | RSS feed (newest 20 posts) |
| `/sitemap.xml` | Sitemap: home, legal pages, blog, categories, authors, every live post with `lastmod` |
| `/robots.txt` | Allows everything except `/api/`, `/admin`, `/#app` and preview links; names the sitemap |
| `/blog/preview/<id>?e=…&t=…` | Signed preview link for drafts (7 days, never indexed) |
| `/api/public/blog/latest` | The 3 newest posts for the homepage "From the blog" section |

Code: `server/services/blog.js` (data, scheduling, SEO checks, seed loader, generated images),
`server/services/blog-pages.js` (the HTML), `server/routes/blog.js` (public), `server/routes/admin/blog.js` (admin),
`server/lib/markdown.js` (safe Markdown), `server/lib/frontmatter.js` (seed files), `public/css/blog.css`,
`public/js/blog.js`, `public/admin/js/blog.js`. Switch: **Admin → Features → Blog**. Tests: `test/e2e/blog.test.js`.

## Who can do what

| Role | Read posts in the admin | Write and save, authors, categories, images | Publish, schedule, unpublish, delete |
|---|---|---|---|
| Owner, Admin, Marketing | yes | yes (`blog.edit`) | yes (`blog.publish`) |
| Support, Finance, Viewer | yes | no | no |

Every change is in **Admin → Audit log** (`blog.post_create`, `blog.post_save`, `blog.post_publish`, …).

## Writing a post

1. **Admin → Blog → New post.** Type the headline; the address (slug) is made from it. Keep the slug short and
   include the focus keyword (`telegram-welcome-bot`, not `the-complete-2026-guide-to-...`).
2. Write the body in Markdown (toolbar helps):
   - `## Section` and `### Subsection` build the table of contents. Use one `##` per main idea.
   - `**bold**`, `*italic*`, `[link text](/blog/other-post)`, `- bullets`, `1. steps`, `> quote`.
   - Tables: `| A | B |` then `|---|---|`. They scroll sideways on phones; the first column stays put.
   - Images: the toolbar uploads them and asks for alt text. `![alt](url =1200x630 "caption")`.
   - `[[cta]]` places the "Start free" box. Without it, one is added at about 40% of the post. Another is always at the end.
   - `[[note]] … [[/note]]` (also `[[tip]]`, `[[warning]]`, `[[info]]`) makes a callout box.
   - **No HTML.** Anything like `<script>` or `<img onerror>` shows as text. Links only go to `https://`, `mailto:`,
     `/relative` addresses or `#anchors`.
3. Fill the side panel: focus keyword, SEO title (≤ 60 characters, optional), meta description (70–155), category,
   author, tags, cover image + alt text (1200 × 630; without one, a branded picture is used).
4. Add **Key takeaways** (3–5 points), an **FAQ** (real questions people search; 1–3 sentence answers) and, for
   "best of" / "top 10" posts, the **list items** (one per H2/H3; "Fill from the headings" does it for you).
5. **Save** (Ctrl/⌘+S). The last 10 saves are kept in **History** and can be restored.
6. **Preview link** to share a draft. **Publish now**, or **Schedule** for a date and time (it goes live by itself).

Changing the slug of a live post is safe: the old address answers `301` to the new one.

## SEO checklist (the editor's score checks most of it)

- [ ] One focus keyword per post, in the SEO title, the headline, the first 100 words, the meta description and the slug.
- [ ] SEO title ≤ 60 characters; meta description 70–155 characters and written to earn the click.
- [ ] At least one `##`; sections answer the questions people ask (look at Google's "People also ask").
- [ ] 600+ words for guides; 1,500+ for comparisons and "best of" lists.
- [ ] At least 2 internal links (other posts, `/#pricing`, `/#guide`) and 1–3 links to sources (Telegram docs).
- [ ] Every image has alt text; the cover is 1200 × 630.
- [ ] Key takeaways and an FAQ (they show as rich results / AI answers).
- [ ] Only promise what works: check claims against `docs/PRODUCT-FACTS.md`. No fake numbers, no "guaranteed".
- [ ] After publishing: link to the new post from 1–2 older posts.

What the pages send search engines automatically: unique `<title>` and description, canonical URL (from `APP_URL`),
Open Graph and Twitter cards, JSON-LD (`BlogPosting` with author `Person` + publisher `Organization`, `BreadcrumbList`,
`Blog`, `FAQPage`, `ItemList` for list posts, `ProfilePage`/`Person` on author pages), `rel=prev/next` on pages,
`ETag` / `Last-Modified` (304 when unchanged), gzip, lazy images with sizes (no layout shift).

## Submitting to Google and Bing (once, after launch)

**Google Search Console**
1. Open [search.google.com/search-console](https://search.google.com/search-console) → **Add property** →
   **Domain** → `castvoo.com`. Add the TXT record it shows at your DNS provider and press **Verify**.
2. **Sitemaps** (left menu) → enter `sitemap.xml` → **Submit**. Status should become "Success".
3. For a new important post: **URL inspection** → paste the post URL → **Request indexing**.
4. Check **Pages** and **Enhancements** (FAQ, Breadcrumbs) every week or two for errors.

**Bing Webmaster Tools** (also feeds DuckDuckGo, Yahoo and ChatGPT search)
1. Open [bing.com/webmasters](https://www.bing.com/webmasters) → **Import from Google Search Console** (fastest),
   or add `https://castvoo.com` and verify with the DNS record.
2. **Sitemaps** → **Submit sitemap** → `https://castvoo.com/sitemap.xml`.
3. Optional: **URL Submission** for new posts.

The sitemap updates itself; there is nothing to resubmit when you publish.

## Publishing cadence

- **Launch:** the starter posts (server/blog-seed) go live on the first start.
- **Months 1–3:** 2 posts a week (one guide, one comparison or playbook), all in the welcome / join-request /
  broadcast clusters, each linking to the pillar post (`/blog/telegram-welcome-bot`).
- **After that:** 1 post a week, plus updating 1–2 older posts a month (new screenshots, prices, Telegram changes).
  Updating a live post sets its "Updated" date, which Google reads as freshness.
- Prefer fewer, more useful posts over many thin ones. Measure in Search Console after 8–12 weeks.

## Starter posts (seed files)

Files in `server/blog-seed/*.md` are added on start **only if that slug was never seeded and is not taken**
(`blog_seeded` remembers every slug). So the team's edits are never overwritten, and a post the team deleted never
comes back. To ship a new starter post, add a file and deploy. Format:

```
---
title: "…"
slug: "…"
description: "…"            # ≤ 155
seo_title: "…"               # optional, ≤ 60
focus_keyword: "…"
category: "Guides"           # Guides, Comparisons, Growth, Media Buying, Product
tags: ["telegram broadcast", "…"]
author: "dchessking"         # or "castvoo-team"
date: "2026-10-09"           # in the future (more than a day) = scheduled
updated: "2026-10-09"
featured: true
takeaways: ["…", "…"]
itemlist: ["Item 1", "…"]    # optional, for list posts
faq:
  - q: "…"
    a: "…"
---
Markdown body
```

## Authors

**Admin → Blog → Authors.** Name, full name, role, bio, photo (JPG/PNG/WEBP up to 5 MB; without one a monogram is
drawn) and profile links (`sameAs`: LinkedIn, X, personal site). Fill the profile links: they help Google connect the
author to their other work (E-E-A-T).

'use strict';
/*
 * Castvoo Admin — Blog: posts list, the post editor (markdown + live preview, SEO checks, Google snippet,
 * FAQ, key takeaways, list items, cover, publish / schedule / unpublish, preview link, history), authors and categories.
 *   #blog                 posts           #blog/new         new post        #blog/edit/<id>   edit a post
 *   #blog/authors         authors         #blog/categories  categories
 * Server: server/routes/admin/blog.js. Writing needs blog.edit; publishing needs blog.publish.
 */
(() => {
  const { html, raw, icon, $, $$, on, put, num, date, dt, ago, get, post, putj, del, act, dialog, confirm, can, toast, esc } = CV;

  const STATUS = { draft: ['Draft', ''], scheduled: ['Scheduled', 'warn'], published: ['Published', 'ok'] };
  const badge = (s) => { const x = STATUS[s] || [s, '']; return html`<span class="bd ${x[1]}"><span class="dot"></span>${x[0]}</span>`; };
  const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90).replace(/-+$/, '');
  const host = () => location.host.replace(/^www\./, '');
  const sub = (active) => html`<div class="tabs bl-tabs">
    <a class="tab${active === 'posts' ? ' on' : ''}" href="#blog">${icon('note')} Posts</a>
    <a class="tab${active === 'authors' ? ' on' : ''}" href="#blog/authors">${icon('user')} Authors</a>
    <a class="tab${active === 'categories' ? ' on' : ''}" href="#blog/categories">${icon('tag')} Categories</a>
    <a class="tab" href="/blog" target="_blank" rel="noopener">${icon('ext')} View blog</a></div>`;

  /** Raw upload (images, author photos): the file is the request body. */
  async function upload(url, file) {
    const res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'x-cv': '1', 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name || 'image') }, body: file });
    let d = {};
    try { d = await res.json(); } catch { /* not json */ }
    if (!res.ok) throw new Error(d.error || `Upload failed (${res.status}).`);
    return d;
  }
  const pickFile = (accept = 'image/jpeg,image/png,image/webp,image/gif') => new Promise((resolve) => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = accept;
    i.onchange = () => resolve(i.files && i.files[0] ? i.files[0] : null);
    i.click();
  });

  CV.page('blog', {
    intro: () => {
      const a = (location.hash.split('/')[1] || '').split('?')[0];
      if (a === 'new' || a === 'edit') return 'Write in Markdown on the left; the preview and the SEO checks update as you type. Save often: the last 10 saves are kept in History.';
      if (a === 'authors') return 'Who writes the posts. Their name, photo, bio and profile links show on every post and on their author page (and tell Google who wrote it).';
      if (a === 'categories') return 'Topics for posts. Each one gets its own page on the blog, like /blog/category/guides.';
      return 'Posts on castvoo.com/blog. Drafts are private; scheduled posts go live by themselves at their time.';
    },
    async render({ args, query }) {
      if (args[0] === 'new') return editor(null);
      if (args[0] === 'edit' && args[1]) return editor(Number(args[1]));
      if (args[0] === 'authors') return authorsPage();
      if (args[0] === 'categories') return categoriesPage();
      return listPage(query);
    },
  });

  /* =================== POSTS LIST =================== */
  async function listPage(query) {
    const qs = new URLSearchParams();
    for (const k of ['q', 'status', 'category', 'author']) if (query.get(k)) qs.set(k, query.get(k));
    const d = await get('/api/admin/blog/posts?' + qs);
    const st = query.get('status') || '';
    const link = (patch) => { const n = new URLSearchParams(qs); for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); } const s = n.toString(); return '#blog' + (s ? '?' + s : ''); };
    const when = (p) => (p.status === 'scheduled' ? html`<span title="${dt(p.publish_at)}">${icon('clock')} ${dt(p.publish_at)}</span>` : p.status === 'published' ? html`<span>${date(p.published_at)}</span>` : html`<span class="mut">Edited ${ago(p.updated_at)}</span>`);
    const page = html`${sub('posts')}
      <div class="card bl-filters">
        <div class="row between">
          <div class="chips">${[['', 'All', d.counts.all], ['draft', 'Drafts', d.counts.draft], ['scheduled', 'Scheduled', d.counts.scheduled], ['published', 'Published', d.counts.published]].map(([k, l, n]) => html`<a class="chip${st === k ? ' on' : ''}" href="${link({ status: k })}">${l} <span class="n">${num(n)}</span></a>`)}</div>
          ${can('blog.edit') ? html`<a class="btn sm" href="#blog/new">${icon('plus')} New post</a>` : html`<span class="bd">${icon('lock')} Read only for your role</span>`}
        </div>
        <form class="bl-fr" id="blf">
          <div class="f"><label for="blq">Search</label><input id="blq" name="q" type="search" value="${query.get('q') || ''}" placeholder="Title, address or keyword" autocomplete="off"></div>
          <div class="f"><label for="blc">Category</label><select id="blc" name="category"><option value="">All categories</option>${d.categories.map((c) => html`<option value="${c.id}" ${String(c.id) === query.get('category') ? raw('selected') : ''}>${c.name}</option>`)}</select></div>
          <div class="f"><label for="bla">Author</label><select id="bla" name="author"><option value="">All authors</option>${d.authors.map((a) => html`<option value="${a.id}" ${String(a.id) === query.get('author') ? raw('selected') : ''}>${a.name}</option>`)}</select></div>
        </form>
      </div>
      <div class="card flat">${d.posts.length ? html`<div class="bl-list">${d.posts.map((p) => html`<a class="bl-row" href="#blog/edit/${p.id}">
          <span class="bl-t"><b>${p.title}</b><small class="mono">/blog/${p.slug}</small></span>
          <span class="bl-m">${badge(p.status)}${p.featured ? html`<span class="bd vio">Featured</span>` : ''}${p.category ? html`<span class="bd blue">${p.category}</span>` : html`<span class="bd warn">No category</span>`}</span>
          <span class="bl-a">${p.avatar_url ? html`<img src="${p.avatar_url}" alt="" width="22" height="22">` : ''}${p.author || '—'}</span>
          <span class="bl-d">${when(p)}</span>
          <span class="bl-x">${icon('chev', 'chev')}</span></a>`)}</div>` : CV.empty('note', qs.toString() ? 'No posts match' : 'No posts yet', qs.toString() ? 'Try another search or filter.' : 'Write the first one: guides and comparisons bring people from Google every day.', can('blog.edit') && !qs.toString() ? html`<a class="btn" href="#blog/new">${icon('plus')} Write a post</a>` : '')}</div>`;
    return {
      html: page,
      mount(el) {
        const f = $('#blf', el);
        let t;
        const go = () => { const v = CV.formValues(f); location.hash = link({ q: v.q.trim(), category: v.category, author: v.author }).slice(1); };
        f.addEventListener('change', go);
        f.addEventListener('submit', (e) => { e.preventDefault(); go(); });
        $('#blq', el).addEventListener('input', () => { clearTimeout(t); t = setTimeout(go, 500); });
        CV.onLeave(() => clearTimeout(t));
      },
    };
  }

  /* =================== EDITOR =================== */
  async function editor(id) {
    const [cats, aus, d] = await Promise.all([get('/api/admin/blog/categories'), get('/api/admin/blog/authors'), id ? get('/api/admin/blog/posts/' + id) : null]);
    const meta = { categories: cats.categories, authors: aus.authors };
    const p = d ? d.post : { title: '', slug: '', seo_title: '', description: '', focus_keyword: '', body: '', category_id: (meta.categories[0] || {}).id || null, author_id: (meta.authors[0] || {}).id || null, tags: [], cover_url: '', cover_alt: '', featured: false, takeaways: [], itemlist: [], faq: [], status: 'draft' };
    const ed = can('blog.edit'), pub = can('blog.publish');
    const dis = ed ? '' : raw(' disabled');
    const tool = (k, label, title) => html`<button type="button" class="tb" data-md="${k}" title="${title}" aria-label="${title}"${dis}>${label}</button>`;
    const svg = (path) => raw(`<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">${path}</svg>`);
    const listRow = (v, ph) => html`<div class="bl-li"><input class="in" value="${v}" placeholder="${ph}"${dis}>${ed ? html`<button type="button" class="ib sm" data-rmrow aria-label="Remove">${icon('trash')}</button>` : ''}</div>`;
    const faqRow = (x) => html`<div class="bl-faq"><div class="stack"><input class="in" name="q" value="${x.q}" placeholder="Question people ask" aria-label="Question"${dis}><textarea class="in" name="a" rows="2" placeholder="A short, direct answer (links allowed: [text](/blog/...))" aria-label="Answer"${dis}>${x.a}</textarea></div>${ed ? html`<button type="button" class="ib sm" data-rmrow aria-label="Remove question">${icon('trash')}</button>` : ''}</div>`;
    const localDT = (v) => { if (!v) return ''; const x = new Date(v); const z = (n) => String(n).padStart(2, '0'); return `${x.getFullYear()}-${z(x.getMonth() + 1)}-${z(x.getDate())}T${z(x.getHours())}:${z(x.getMinutes())}`; };
    const page = html`
      <div class="card bl-head"><div class="uhead"><a class="ib" href="#blog" aria-label="Back to posts">${icon('back')}</a>
        <div style="min-width:0;flex:1"><h2 style="font-size:18px" id="blHT">${p.title || 'New post'}</h2><div class="meta" id="blMeta">${id ? badge(p.status) : html`<span class="bd">Not saved yet</span>`}${p.status === 'scheduled' ? html`<span class="bd warn">${icon('clock')} ${dt(p.publish_at)}</span>` : ''}${p.status === 'published' ? html`<span class="bd">Live since ${date(p.published_at)}</span>` : ''}<span class="bd" id="blDirty" hidden>Unsaved changes</span></div></div>
        <div class="acts">${id && p.status === 'published' ? html`<a class="btn sec sm" href="/blog/${p.slug}" target="_blank" rel="noopener">${icon('ext')} View</a>` : ''}${id && ed ? html`<button class="btn sec sm" data-act="preview">${icon('eye')} Preview link</button>` : ''}${ed ? html`<button class="btn sm" data-act="save">${icon('check')} ${id ? 'Save' : 'Save draft'}</button>` : ''}</div></div></div>
      <form class="bl-ed" id="blF" autocomplete="off" novalidate>
        <div class="bl-main">
          <div class="card">
            <div class="f"><label for="bTitle">Headline (H1)</label><input id="bTitle" name="title" class="bl-title" value="${p.title}" placeholder="How to welcome every new Telegram member" maxlength="200"${dis}></div>
            <div class="f"><label for="bSlug">Address</label><div class="bl-slug"><span><i class="hostp">${host()}</i>/blog/</span><input id="bSlug" name="slug" value="${p.slug}" placeholder="auto-from-the-title" maxlength="90"${dis}></div><span class="hint" id="bSlugH">${id ? 'Changing it later is fine: the old address redirects here (301).' : 'Made from the headline. Short, with the focus keyword.'}</span>${d && d.old_slugs.length ? html`<span class="hint">Old addresses that redirect here: ${d.old_slugs.map((s) => html`<span class="mono">/blog/${s}</span> `)}</span>` : ''}</div>
          </div>
          <div class="card bl-mdc">
            <div class="bl-bar">
              <div class="bl-tools" role="toolbar" aria-label="Formatting">
                ${tool('h2', 'H2', 'Section heading (H2)')}${tool('h3', 'H3', 'Subheading (H3)')}<span class="tsep"></span>
                ${tool('bold', raw('<b>B</b>'), 'Bold')}${tool('italic', raw('<i>I</i>'), 'Italic')}${tool('link', svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'), 'Link')}<span class="tsep"></span>
                ${tool('ul', svg('<path d="M9 6h11M9 12h11M9 18h11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="4.5" cy="6" r="1.5" fill="currentColor"/><circle cx="4.5" cy="12" r="1.5" fill="currentColor"/><circle cx="4.5" cy="18" r="1.5" fill="currentColor"/>'), 'Bullet list')}${tool('ol', svg('<path d="M10 6h10M10 12h10M10 18h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><text x="2" y="9" font-size="7" font-weight="700" fill="currentColor">1</text><text x="2" y="15" font-size="7" font-weight="700" fill="currentColor">2</text><text x="2" y="21" font-size="7" font-weight="700" fill="currentColor">3</text>'), 'Numbered list')}${tool('quote', svg('<path d="M7 7h4v4c0 3-1.5 5-4 6M15 7h4v4c0 3-1.5 5-4 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'), 'Quote')}${tool('table', svg('<rect x="3" y="4" width="18" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 10h18M3 15h18M10 4v16" stroke="currentColor" stroke-width="2"/>'), 'Table')}${tool('image', svg('<rect x="3" y="4" width="18" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="10" r="2" fill="currentColor"/><path d="m4 18 5-5 4 4 3-3 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'), 'Upload an image')}<span class="tsep"></span>
                ${tool('cta', 'CTA', 'Start-free box ([[cta]])')}${tool('note', 'Note', 'Callout box ([[note]]…[[/note]])')}
              </div>
              <div class="seg bl-view" role="tablist" aria-label="Editor view"><button type="button" data-view="write" class="on">Write</button><button type="button" data-view="preview">Preview</button><button type="button" data-view="split" class="bl-split">Split</button></div>
            </div>
            <div class="bl-panes" data-mode="write">
              <textarea id="bBody" name="body" class="bl-body" spellcheck="true" placeholder="Start with a short intro that says what the reader gets (use the focus keyword in it).&#10;&#10;## First section&#10;&#10;Write in plain sentences. Use - for bullet lists, 1. for steps, | for tables."${dis}>${p.body}</textarea>
              <div class="bl-pv prose-a" id="bPv" aria-live="polite"></div>
            </div>
            <div class="bl-foot"><span id="bWords">—</span><span class="mut">Markdown · no HTML · [[cta]] and [[note]]…[[/note]] boxes · an extra Start-free box is added at about 40% when you don't place one</span></div>
          </div>
          <div class="card">
            <div class="ch"><h3>${icon('check')} Key takeaways</h3><p>3 to 5 short points shown in a box at the top of the post.</p></div>
            <div class="bl-rows" id="bKeys">${(p.takeaways || []).map((t) => listRow(t, 'One clear point'))}</div>
            ${ed ? html`<div><button type="button" class="btn sec sm" data-add="keys">${icon('plus')} Add a point</button></div>` : ''}
          </div>
          <div class="card">
            <div class="ch"><h3>${icon('chat')} FAQ</h3><p>Shown as an accordion at the end, and sent to Google as FAQ data. Answer in 1 to 3 sentences.</p></div>
            <div class="bl-rows" id="bFaq">${(p.faq || []).map(faqRow)}</div>
            ${ed ? html`<div><button type="button" class="btn sec sm" data-add="faq">${icon('plus')} Add a question</button></div>` : ''}
          </div>
          <div class="card">
            <div class="ch"><h3>${icon('list')} List post</h3><p>For "best of" and "top 10" posts: the names of the items, in order. Google gets them as an ItemList. Each name should match an H2 or H3 in the post.</p></div>
            <label class="check"><input type="checkbox" id="bIsList" ${(p.itemlist || []).length ? raw('checked') : ''}${dis}> This post is a list (listicle)</label>
            <div id="bListBox" ${(p.itemlist || []).length ? '' : raw('hidden')}>
              <div class="bl-rows" id="bItems">${(p.itemlist || []).map((t) => listRow(t, 'Item name'))}</div>
              ${ed ? html`<div class="row" style="margin-top:10px"><button type="button" class="btn sec sm" data-add="items">${icon('plus')} Add an item</button><button type="button" class="btn ghost sm" data-act="itemsFromH">${icon('refresh')} Fill from the headings</button></div>` : ''}
            </div>
          </div>
        </div>
        <aside class="bl-side">
          ${id ? html`<div class="card"><div class="ch"><h3>${icon('send')} Publishing</h3></div>
            ${!pub ? html`<p class="hint">Your role can write and save. Publishing needs Owner, Admin or Marketing.</p>` : p.status === 'published'
              ? html`<p class="hint">Live at <a href="/blog/${p.slug}" target="_blank" rel="noopener">/blog/${p.slug}</a>. Saving updates it straight away.</p><div class="row"><button type="button" class="btn sec sm" data-act="unpublish">${icon('eye')} Unpublish</button></div>`
              : html`<div class="row"><button type="button" class="btn ok sm" data-act="publish">${icon('send')} Publish now</button></div>
                <div class="f"><label for="bAt">Or schedule for</label><div class="row" style="flex-wrap:nowrap"><input id="bAt" type="datetime-local" value="${localDT(p.publish_at)}" class="in"><button type="button" class="btn sec sm" data-act="schedule">${icon('clock')} ${p.status === 'scheduled' ? 'Reschedule' : 'Schedule'}</button></div><span class="hint">${p.status === 'scheduled' ? html`Goes live by itself on ${dt(p.publish_at)}.` : 'Your local time. It goes live by itself.'}</span></div>
                ${p.status === 'scheduled' ? html`<div><button type="button" class="btn ghost sm" data-act="unpublish">Cancel the schedule</button></div>` : ''}`}
            ${pub ? html`<div class="bl-danger"><button type="button" class="btn danger sec sm" data-act="delete">${icon('trash')} Delete post</button></div>` : ''}
          </div>` : ''}
          <div class="card bl-seo"><div class="ch"><h3>${icon('spark')} SEO score</h3></div>
            <div class="bl-score"><div class="ring" id="bRing" style="--p:0"><b id="bScore">–</b></div><div><b id="bScoreT">Checking…</b><span class="hint" id="bScoreS"></span></div></div>
            <div class="f"><label for="bKw">Focus keyword</label><input id="bKw" name="focus_keyword" value="${p.focus_keyword}" placeholder="telegram welcome bot" maxlength="80"${dis}></div>
            <ul class="bl-checks" id="bChecks"></ul>
          </div>
          <div class="card"><div class="ch"><h3>${icon('search')} Google preview</h3></div>
            <div class="serp" id="bSerp"></div>
            <div class="f"><label for="bSeoT">SEO title <span class="cnt" data-cnt="bSeoT" data-max="60"></span></label><input id="bSeoT" name="seo_title" value="${p.seo_title}" placeholder="Leave empty to use the headline" maxlength="70"${dis}></div>
            <div class="f"><label for="bDesc">Meta description and excerpt <span class="cnt" data-cnt="bDesc" data-max="155"></span></label><textarea id="bDesc" name="description" rows="3" maxlength="300" placeholder="One or two sentences: what the reader learns. Shown in Google and on post cards."${dis}>${p.description}</textarea></div>
          </div>
          <div class="card"><div class="ch"><h3>${icon('tag')} Organise</h3></div>
            <div class="f"><label for="bCat">Category <a href="#blog/categories" class="hint">Manage</a></label><select id="bCat" name="category_id"${dis}><option value="">No category</option>${meta.categories.map((c) => html`<option value="${c.id}" ${c.id === p.category_id ? raw('selected') : ''}>${c.name}</option>`)}</select></div>
            <div class="f"><label for="bAu">Author <a href="#blog/authors" class="hint">Manage</a></label><select id="bAu" name="author_id"${dis}><option value="">No author</option>${meta.authors.map((a) => html`<option value="${a.id}" ${a.id === p.author_id ? raw('selected') : ''}>${a.name}${a.role ? ' · ' + a.role : ''}</option>`)}</select></div>
            <div class="f"><label for="bTags">Tags</label><input id="bTags" name="tags" value="${(p.tags || []).join(', ')}" placeholder="telegram bot, join requests"${dis}><span class="hint">Separate with commas. Up to 12.</span></div>
            <label class="check"><input type="checkbox" name="featured" ${p.featured ? raw('checked') : ''}${dis}> Feature at the top of the blog</label>
          </div>
          <div class="card"><div class="ch"><h3>${icon('image')} Cover image</h3><p>1200 × 630 works best. Used for sharing; without one, a branded picture is made for you.</p></div>
            <div class="bl-cover" id="bCov">${p.cover_url ? html`<img src="${p.cover_url}" alt="">` : html`<img src="${id ? `/blog/og/${p.slug}.svg?style=card` : '/img/og-blog.png'}" alt="" class="auto">`}</div>
            <div class="f"><label for="bCovU">Image address</label><div class="row" style="flex-wrap:nowrap"><input id="bCovU" name="cover_url" value="${p.cover_url}" placeholder="https://… or upload" class="in"${dis}>${ed ? html`<button type="button" class="btn sec sm" data-act="cover">${icon('image')} Upload</button>` : ''}</div></div>
            <div class="f"><label for="bCovA">Alt text</label><input id="bCovA" name="cover_alt" value="${p.cover_alt}" placeholder="What the picture shows" maxlength="200"${dis}></div>
          </div>
          ${d && d.revisions.length ? html`<div class="card"><div class="ch"><h3>${icon('clock')} History</h3><p>The last ${d.revisions.length} saves.</p></div>
            <div class="bl-revs">${d.revisions.map((r, i) => html`<div class="bl-rev"><span><b>${dt(r.created_at)}</b><small>${r.note || 'Saved'}${r.by_name || r.by_email ? ' · ' + (r.by_name || r.by_email) : ''}</small></span>${i > 0 && ed ? html`<button type="button" class="btn ghost xs" data-restore="${r.id}">Restore</button>` : i === 0 ? html`<span class="bd">Current</span>` : ''}</div>`)}</div></div>` : ''}
        </aside>
      </form>`;

    return {
      html: page,
      mount(el) {
        const f = $('#blF', el);
        const body = $('#bBody', el);
        const pv = $('#bPv', el);
        let slugTouched = !!(id && p.slug);
        let dirty = false;
        const setDirty = (v) => { dirty = v; $('#blDirty', el).hidden = !v; };
        const beforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
        window.addEventListener('beforeunload', beforeUnload);
        CV.onLeave(() => window.removeEventListener('beforeunload', beforeUnload));

        const rows = (sel) => $$(sel + ' input', el).map((i) => i.value.trim()).filter(Boolean);
        const values = () => {
          const v = CV.formValues(f);
          return {
            title: v.title, slug: v.slug || slugify(v.title), seo_title: v.seo_title, description: v.description, focus_keyword: v.focus_keyword,
            body: body.value, category_id: v.category_id || null, author_id: v.author_id || null,
            tags: String(v.tags || '').split(',').map((t) => t.trim()).filter(Boolean), cover_url: v.cover_url.trim(), cover_alt: v.cover_alt,
            featured: !!v.featured, takeaways: rows('#bKeys'),
            itemlist: $('#bIsList', el).checked ? rows('#bItems') : [],
            faq: $$('#bFaq .bl-faq', el).map((r) => ({ q: $('[name=q]', r).value.trim(), a: $('[name=a]', r).value.trim() })).filter((x) => x.q || x.a),
          };
        };

        /* counters + Google snippet */
        const counters = () => $$('[data-cnt]', el).forEach((c) => {
          const inp = $('#' + c.dataset.cnt, el), max = Number(c.dataset.max), n = inp.value.length;
          c.textContent = `${n} / ${max}`;
          c.className = 'cnt ' + (n === 0 ? '' : n > max ? 'bad' : n < max * 0.45 ? 'warn' : 'ok');
        });
        const cut = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + ' …' : s);
        const serp = () => {
          const v = values();
          const t = v.seo_title || (v.title && v.title.length + 10 <= 60 ? `${v.title} · Castvoo` : v.title) || 'Your headline';
          put($('#bSerp', el), html`<div class="serp-s"><span class="serp-f">${raw('<svg viewBox="0 0 40 40" width="18" height="18"><rect width="40" height="40" rx="12" fill="#2F6BFF"/><path d="M24.6 13.6A9 9 0 1 0 24.6 26.4" fill="none" stroke="#fff" stroke-width="4.6" stroke-linecap="round"/><circle cx="29" cy="20" r="3.3" fill="#fff"/></svg>')}</span><span><b>Castvoo</b><small>${host()} › blog › ${v.slug || 'your-post'}</small></span></div>
            <div class="serp-t">${cut(t, 60)}</div><div class="serp-d">${cut(v.description || 'Add a meta description: one or two sentences that make people click.', 158)}</div>`);
        };

        /* live preview + SEO checks (the server renders it exactly like the blog does) */
        let pt, seq = 0;
        const refresh = () => {
          clearTimeout(pt);
          pt = setTimeout(async () => {
            const my = ++seq;
            try {
              const r = await post('/api/admin/blog/preview', values());
              if (my !== seq || !pv.isConnected) return;
              pv.innerHTML = (values().takeaways.length ? '<aside class="keys"><b class="keys-t">Key takeaways</b><ul>' + values().takeaways.map((t) => '<li>' + esc(t) + '</li>').join('') + '</ul></aside>' : '') + (r.html || '<p class="mut">Nothing to preview yet.</p>');
              seo(r.seo);
            } catch (e) { if (my === seq) toast(e.message, 'bad'); }
          }, 450);
        };
        const seo = (s) => {
          $('#bScore', el).textContent = s.score;
          $('#bRing', el).style.setProperty('--p', s.score);
          $('#bRing', el).className = 'ring ' + (s.score >= 80 ? 'ok' : s.score >= 50 ? 'warn' : 'bad');
          $('#bScoreT', el).textContent = s.score >= 80 ? 'Ready to rank' : s.score >= 50 ? 'Getting there' : 'Needs work';
          $('#bScoreS', el).textContent = `${num(s.words)} words · ${s.reading_time} min read · ${s.internal_links} internal link${s.internal_links === 1 ? '' : 's'} · ${s.h2} H2`;
          $('#bWords', el).textContent = `${num(s.words)} words · ${s.reading_time} min read`;
          put($('#bChecks', el), s.checks.map((c) => html`<li class="${c.ok ? 'ok' : 'no'}">${icon(c.ok ? 'check' : 'warn')}<span>${c.label}${c.ok ? '' : html`<small>${c.tip}</small>`}</span></li>`));
        };

        /* slug: from the headline until someone types one; checked for clashes */
        let st;
        const checkSlug = () => {
          clearTimeout(st);
          st = setTimeout(async () => {
            const s = $('#bSlug', el).value.trim() || slugify($('#bTitle', el).value);
            if (!s) return;
            const r = await get(`/api/admin/blog/slug?slug=${encodeURIComponent(s)}&id=${id || 0}`).catch(() => null);
            const h = $('#bSlugH', el);
            if (!r || !h) return;
            h.className = 'hint' + (r.ok ? '' : ' bad');
            h.textContent = r.ok ? (r.slug !== s ? `Will be saved as ${r.slug}.` : id ? 'Changing it later is fine: the old address redirects here (301).' : 'Available.') : r.error;
          }, 350);
        };
        $('#bTitle', el).addEventListener('input', (e) => {
          if (!slugTouched) $('#bSlug', el).value = slugify(e.target.value);
          $('#blHT', el).textContent = e.target.value || 'New post';
          checkSlug();
        });
        $('#bSlug', el).addEventListener('input', () => { slugTouched = true; checkSlug(); });
        $('#bSlug', el).addEventListener('blur', (e) => { e.target.value = slugify(e.target.value); serp(); });

        f.addEventListener('input', () => { setDirty(true); counters(); serp(); refresh(); });
        f.addEventListener('change', () => { setDirty(true); refresh(); });
        f.addEventListener('submit', (e) => e.preventDefault());
        counters(); serp(); if (ed) refresh();

        /* view: write / preview / split */
        on(el, 'click', '[data-view]', (e, b) => {
          $$('[data-view]', el).forEach((x) => x.classList.toggle('on', x === b));
          $('.bl-panes', el).dataset.mode = b.dataset.view;
          if (b.dataset.view !== 'write') refresh();
        });

        if (!ed && d) {
          // Read-only roles: the checks computed on load, and the preview drawn from the saved post.
          seo(d.seo);
          post('/api/admin/blog/preview', values()).then((r) => { pv.innerHTML = r.html; }).catch(() => { $('.bl-panes', el).dataset.mode = 'write'; });
          $('[data-view=preview]', el).click();
        }

        /* toolbar */
        const wrapSel = (before, after = before, ph = 'text') => {
          const s = body.selectionStart, e2 = body.selectionEnd, sel = body.value.slice(s, e2) || ph;
          body.setRangeText(before + sel + after, s, e2, 'end');
          if (sel === ph) { body.selectionStart = s + before.length; body.selectionEnd = s + before.length + ph.length; }
          body.focus(); body.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const lines = (prefix) => {
          const s = body.value.lastIndexOf('\n', body.selectionStart - 1) + 1;
          let e2 = body.value.indexOf('\n', body.selectionEnd); if (e2 < 0) e2 = body.value.length;
          const block = body.value.slice(s, e2) || 'Item';
          const out = block.split('\n').map((l, i) => (typeof prefix === 'function' ? prefix(i) : prefix) + l.replace(/^(#{1,6} |[-*] |\d+\. |> )/, '')).join('\n');
          body.setRangeText(out, s, e2, 'end'); body.focus(); body.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const block = (text) => {
          const s = body.selectionStart;
          const pre = s && body.value[s - 1] !== '\n' ? '\n\n' : (s && body.value[s - 2] !== '\n' ? '\n' : '');
          body.setRangeText(pre + text + '\n\n', s, body.selectionEnd, 'end'); body.focus(); body.dispatchEvent(new Event('input', { bubbles: true }));
        };
        on(el, 'click', '[data-md]', async (e, b) => {
          const k = b.dataset.md;
          if (k === 'h2') return lines('## ');
          if (k === 'h3') return lines('### ');
          if (k === 'bold') return wrapSel('**');
          if (k === 'italic') return wrapSel('*');
          if (k === 'ul') return lines('- ');
          if (k === 'ol') return lines((i) => `${i + 1}. `);
          if (k === 'quote') return lines('> ');
          if (k === 'cta') return block('[[cta]]');
          if (k === 'note') return block('[[note]]\nSomething the reader must not miss.\n[[/note]]');
          if (k === 'table') return block('| Feature | Castvoo | Other tool |\n|---|---|---|\n| Welcome DM | Yes | No |\n| Free plan | Yes | Yes |');
          if (k === 'link') {
            const s = body.selectionStart, e2 = body.selectionEnd;
            const r = await dialog({ title: 'Add a link', icon: 'ext', fields: [{ name: 'text', label: 'Text', value: body.value.slice(s, e2), required: true }, { name: 'url', label: 'Address', placeholder: '/blog/other-post or https://…', required: true, hint: 'Start with / for Castvoo pages (internal links help SEO). Other sites open in a new tab.' }], okText: 'Insert link' });
            if (!r) return;
            body.focus(); body.setRangeText(`[${r.text}](${r.url.trim()})`, s, e2, 'end'); body.dispatchEvent(new Event('input', { bubbles: true }));
            return;
          }
          if (k === 'image') {
            const file = await pickFile();
            if (!file) return;
            const r = await dialog({ title: 'Describe the image', icon: 'image', text: 'Alt text tells Google and screen-reader users what the image shows.', fields: [{ name: 'alt', label: 'Alt text', required: true, placeholder: 'Castvoo welcome flow builder with 3 steps' }, { name: 'cap', label: 'Caption (optional)' }], okText: 'Upload' });
            if (!r) return;
            const pos = body.selectionStart;
            const out = await act(b, () => upload('/api/admin/blog/images?alt=' + encodeURIComponent(r.alt), file), 'Image uploaded');
            if (!out) return;
            body.selectionStart = body.selectionEnd = pos;
            block(`![${r.alt.replace(/[[\]]/g, '')}](${out.url}${out.width && out.height ? ` =${out.width}x${out.height}` : ''}${r.cap ? ` "${r.cap.replace(/"/g, "'")}"` : ''})`);
          }
        });
        body.addEventListener('keydown', (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); wrapSel('**'); }
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); wrapSel('*'); }
        });
        const onKey = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save($('[data-act=save]', el)); } };
        document.addEventListener('keydown', onKey);
        CV.onLeave(() => document.removeEventListener('keydown', onKey));

        /* rows: takeaways, FAQ, list items */
        const addRow = (box, h) => { const t = document.createElement('div'); put(t, h); const n = t.firstElementChild; $(box, el).appendChild(n); $('input,textarea', n).focus(); setDirty(true); };
        on(el, 'click', '[data-add]', (e, b) => {
          if (b.dataset.add === 'keys') addRow('#bKeys', listRow('', 'One clear point'));
          if (b.dataset.add === 'faq') addRow('#bFaq', faqRow({ q: '', a: '' }));
          if (b.dataset.add === 'items') addRow('#bItems', listRow('', 'Item name'));
        });
        on(el, 'click', '[data-rmrow]', (e, b) => { b.parentElement.closest('.bl-li,.bl-faq').remove(); setDirty(true); refresh(); });
        $('#bIsList', el).addEventListener('change', (e) => { $('#bListBox', el).hidden = !e.target.checked; });

        /* cover */
        const coverPv = () => { const u = $('#bCovU', el).value.trim(); if (u) put($('#bCov', el), html`<img src="${u}" alt="">`); };
        $('#bCovU', el).addEventListener('change', coverPv);

        /* save, publish, ... */
        async function save(btn) {
          const v = values();
          if (!v.title.trim()) { toast('Write a headline first.', 'bad'); $('#bTitle', el).focus(); return null; }
          const r = await act(btn, () => (id ? putj('/api/admin/blog/posts/' + id, v) : post('/api/admin/blog/posts', v)), id ? 'Saved' : 'Draft saved');
          if (!r) return null;
          setDirty(false);
          if (!id) { location.hash = 'blog/edit/' + r.post.id; return r; }
          if (r.slug_changed) toast('Address changed. The old one now redirects here.', 'info');
          CV.reload();
          return r;
        }
        on(el, 'click', '[data-act]', async (e, b) => {
          const a = b.dataset.act;
          if (a === 'save') return save(b);
          if (a === 'publish' || a === 'schedule') {
            let at = null;
            if (a === 'schedule') {
              const v = $('#bAt', el).value;
              if (!v) { toast('Pick a date and time first.', 'bad'); return; }
              at = new Date(v);
              if (at.getTime() < Date.now() + 60000) { toast('Pick a time in the future (or press Publish now).', 'bad'); return; }
            }
            if (dirty && !(await save(null))) return;
            if (a === 'publish' && !(await confirm('Publish this post now?', 'It goes live on the blog, in the sitemap and in the RSS feed straight away.', { okText: 'Publish' }))) return;
            const r = await act(b, () => post(`/api/admin/blog/posts/${id}/publish`, at ? { at: at.toISOString() } : {}), a === 'schedule' ? `Scheduled for ${dt(at)}` : 'Published. It is live now.');
            if (r) { setDirty(false); CV.reload(); }
            return;
          }
          if (a === 'unpublish') {
            if (!(await confirm(p.status === 'scheduled' ? 'Cancel the schedule?' : 'Unpublish this post?', p.status === 'scheduled' ? 'It goes back to drafts.' : 'It leaves the blog and goes back to drafts. Its address will show "not found" until you publish it again.', { danger: p.status !== 'scheduled', okText: p.status === 'scheduled' ? 'Cancel schedule' : 'Unpublish' }))) return;
            if (await act(b, () => post(`/api/admin/blog/posts/${id}/unpublish`), 'Moved back to drafts')) CV.reload();
            return;
          }
          if (a === 'delete') {
            if (!(await confirm('Delete this post for good?', 'This cannot be undone. Its history goes too. (A post from the starter set never comes back by itself.)', { danger: true, okText: 'Delete post' }))) return;
            if (await act(b, () => del('/api/admin/blog/posts/' + id), 'Post deleted')) { setDirty(false); location.hash = 'blog'; }
            return;
          }
          if (a === 'preview') {
            if (dirty && !(await save(null))) return;
            const r = await act(b, () => get(`/api/admin/blog/posts/${id}/preview-link`));
            if (!r) return;
            await dialog({ title: 'Preview link', icon: 'eye', text: `Anyone with this link can see the post as it is now, for ${r.expires_days} days. Search engines never index it.`, body: html`${CV.copyField(r.full_url)}<p style="margin-top:10px"><a class="btn sec sm" href="${r.url}" target="_blank" rel="noopener">${icon('ext')} Open preview</a></p>`, okText: 'Done', cancelText: false });
            return;
          }
          if (a === 'cover') {
            const file = await pickFile();
            if (!file) return;
            const out = await act(b, () => upload('/api/admin/blog/images?alt=' + encodeURIComponent($('#bCovA', el).value || ''), file), 'Cover uploaded. Save to keep it.');
            if (out) { $('#bCovU', el).value = out.url; coverPv(); setDirty(true); if (!$('#bCovA', el).value) $('#bCovA', el).focus(); }
            return;
          }
          if (a === 'itemsFromH') {
            const hs = body.value.split('\n').filter((l) => /^#{2,3}\s/.test(l)).map((l) => l.replace(/^#+\s*/, '').replace(/^\d+[.)]\s*/, '').trim());
            if (!hs.length) { toast('Add ## headings for each item first.', 'info'); return; }
            put($('#bItems', el), hs.slice(0, 50).map((t) => listRow(t, 'Item name')));
            setDirty(true);
          }
        });
        on(el, 'click', '[data-copy]', (e, b) => { navigator.clipboard?.writeText(b.dataset.copy).then(() => toast('Copied')); });
        on(el, 'click', '[data-restore]', async (e, b) => {
          if (dirty && !(await confirm('Discard your unsaved changes?', 'Restoring replaces what is in the editor.', { danger: true, okText: 'Restore anyway' }))) return;
          if (await act(b, () => post(`/api/admin/blog/posts/${id}/revisions/${b.dataset.restore}/restore`), 'Version restored')) { setDirty(false); CV.reload(); }
        });
      },
    };
  }

  /* =================== AUTHORS =================== */
  async function authorsPage() {
    const { authors } = await get('/api/admin/blog/authors');
    const ed = can('blog.edit');
    const page = html`${sub('authors')}
      <div class="row between"><span class="mut">${authors.length} author${authors.length === 1 ? '' : 's'}</span>${ed ? html`<button class="btn sm" data-add>${icon('plus')} Add an author</button>` : ''}</div>
      <div class="grid g2">${authors.map((a) => html`<div class="card bl-au">
        <div class="bl-au-h"><img src="${a.avatar_url}" alt="" width="64" height="64"><div style="min-width:0"><h3>${a.name}</h3><p class="mut">${a.full_name ? a.full_name + ' · ' : ''}${a.role || 'No role yet'}</p><p class="hint mono">/blog/author/${a.slug} · ${a.posts} live post${a.posts === 1 ? '' : 's'}</p></div></div>
        <p class="bl-bio">${a.bio || html`<span class="mut">No bio yet. A short bio builds trust with readers and Google.</span>`}</p>
        ${a.same_as.length ? html`<div class="chips">${a.same_as.map((u) => html`<a class="chip" href="${u}" target="_blank" rel="noopener">${icon('ext')} ${u.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]}</a>`)}</div>` : html`<p class="hint">No profile links (LinkedIn, X, website). Add them so Google can connect this author to their profiles.</p>`}
        ${ed ? html`<div class="row"><button class="btn sec sm" data-edit="${a.id}">${icon('edit')} Edit</button><button class="btn sec sm" data-photo="${a.id}">${icon('image')} ${a.has_photo ? 'Change photo' : 'Upload photo'}</button>${a.has_photo ? html`<button class="btn ghost sm" data-nophoto="${a.id}">Remove photo</button>` : ''}<button class="btn danger sec sm" data-del="${a.id}" aria-label="Delete ${a.name}">${icon('trash')}</button></div>` : ''}
      </div>`)}</div>`;
    const form = (a = {}) => [
      { name: 'name', label: 'Display name', value: a.name, required: true, placeholder: 'Dchessking' },
      { name: 'full_name', label: 'Full name (optional)', value: a.full_name, placeholder: 'Ejiro Segbuyota' },
      { name: 'slug', label: 'Address', value: a.slug, placeholder: 'made from the name', hint: 'castvoo.com/blog/author/<this>' },
      { name: 'role', label: 'Role', value: a.role, placeholder: 'Founder · Media buyer' },
      { name: 'bio', label: 'Bio', type: 'textarea', rows: 4, value: a.bio, placeholder: 'Two or three sentences: who they are and why readers can trust them.' },
      { name: 'same_as', label: 'Profile links (one per line)', type: 'textarea', rows: 3, value: (a.same_as || []).join('\n'), placeholder: 'https://www.linkedin.com/in/…\nhttps://x.com/…', hint: 'Full https:// links. Used as sameAs for Google.' },
    ];
    return {
      html: page,
      mount(el) {
        const byId = (id) => authors.find((a) => String(a.id) === String(id));
        on(el, 'click', '[data-add]', async () => { if (await dialog({ title: 'Add an author', icon: 'user', fields: form(), okText: 'Add author', wide: true, onSubmit: (v) => post('/api/admin/blog/authors', v) })) { toast('Author added'); CV.reload(); } });
        on(el, 'click', '[data-edit]', async (e, b) => { const a = byId(b.dataset.edit); if (await dialog({ title: 'Edit ' + a.name, icon: 'user', fields: form(a), okText: 'Save', wide: true, onSubmit: (v) => putj('/api/admin/blog/authors/' + a.id, v) })) { toast('Saved'); CV.reload(); } });
        on(el, 'click', '[data-photo]', async (e, b) => { const file = await pickFile('image/jpeg,image/png,image/webp'); if (file && (await act(b, () => upload(`/api/admin/blog/authors/${b.dataset.photo}/photo`, file), 'Photo saved'))) CV.reload(); });
        on(el, 'click', '[data-nophoto]', async (e, b) => { if (await act(b, () => del(`/api/admin/blog/authors/${b.dataset.nophoto}/photo`), 'Photo removed')) CV.reload(); });
        on(el, 'click', '[data-del]', async (e, b) => { const a = byId(b.dataset.del); if (!(await confirm('Delete ' + a.name + '?', 'Only possible when no post uses this author.', { danger: true, okText: 'Delete' }))) return; if (await act(b, () => del('/api/admin/blog/authors/' + a.id), 'Author deleted')) CV.reload(); });
      },
    };
  }

  /* =================== CATEGORIES =================== */
  async function categoriesPage() {
    const { categories } = await get('/api/admin/blog/categories');
    const ed = can('blog.edit');
    const page = html`${sub('categories')}
      <div class="row between"><span class="mut">${categories.length} categor${categories.length === 1 ? 'y' : 'ies'}</span>${ed ? html`<button class="btn sm" data-add>${icon('plus')} Add a category</button>` : ''}</div>
      <div class="card flat"><div class="bl-list">${categories.map((c) => html`<div class="bl-row static">
        <span class="bl-t"><b>${c.name}</b><small class="mono">/blog/category/${c.slug}</small></span>
        <span class="bl-desc mut">${c.description || '—'}</span>
        <span class="bl-m"><span class="bd">${c.posts} live</span></span>
        ${ed ? html`<span class="bl-x row"><button class="btn sec xs" data-edit="${c.id}">${icon('edit')} Edit</button><button class="btn danger sec xs" data-del="${c.id}" aria-label="Delete ${c.name}">${icon('trash')}</button></span>` : ''}
      </div>`)}</div></div>`;
    const form = (c = {}) => [
      { name: 'name', label: 'Name', value: c.name, required: true },
      { name: 'slug', label: 'Address', value: c.slug, placeholder: 'made from the name', hint: 'castvoo.com/blog/category/<this>' },
      { name: 'description', label: 'Description', type: 'textarea', rows: 3, value: c.description, hint: 'Shown at the top of the category page and as its Google description (up to 155 characters is best).' },
      { name: 'sort', label: 'Order', type: 'number', value: c.sort ?? 50, min: 0, max: 999 },
    ];
    return {
      html: page,
      mount(el) {
        const byId = (id) => categories.find((c) => String(c.id) === String(id));
        on(el, 'click', '[data-add]', async () => { if (await dialog({ title: 'Add a category', icon: 'tag', fields: form(), okText: 'Add', onSubmit: (v) => post('/api/admin/blog/categories', v) })) { toast('Category added'); CV.reload(); } });
        on(el, 'click', '[data-edit]', async (e, b) => { const c = byId(b.dataset.edit); if (await dialog({ title: 'Edit ' + c.name, icon: 'tag', fields: form(c), okText: 'Save', onSubmit: (v) => putj('/api/admin/blog/categories/' + c.id, v) })) { toast('Saved'); CV.reload(); } });
        on(el, 'click', '[data-del]', async (e, b) => { const c = byId(b.dataset.del); if (!(await confirm('Delete ' + c.name + '?', 'Only possible when no post uses it.', { danger: true, okText: 'Delete' }))) return; if (await act(b, () => del('/api/admin/blog/categories/' + c.id), 'Category deleted')) CV.reload(); });
      },
    };
  }
})();

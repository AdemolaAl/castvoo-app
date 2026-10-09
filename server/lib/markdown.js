'use strict';
/*
 * A small, safe Markdown renderer for blog posts. No packages.
 *
 * Safety first: posts may NOT contain HTML. Every character of text is escaped, so "<script>", "<img onerror=…>"
 * and friends show up as text. Links may only go to http(s), mailto, a relative address or a #anchor
 * (javascript:, data:, vbscript:… are refused and shown as plain text). Images only from http(s) or relative addresses.
 *
 * Supports: # headings (with ids for the table of contents), paragraphs, **bold**, *italic*, ~~strike~~, `code`,
 * [links](url "title"), ![images](url =1200x630 "caption"), nested - / 1. lists, > blockquotes, | tables |, ---,
 * ``` code blocks, and the blog shortcodes:
 *   [[cta]] or [[cta Your own headline]]      a "Start free" block (also added by itself at about 40% of the post)
 *   [[note]] … [[/note]]                      a callout box; also [[tip]], [[warning]], [[info]]
 *
 * render(md, { appUrl, cta(text) → html, autoCta }) →
 *   { html, toc: [{ level, id, text }], words, images: [{ src, alt }], links: { internal, external }, h2, text }
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function slugify(s, max = 80) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&[a-z]+;|&#\d+;/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
}

/** A link or image address we are willing to put in href/src, or null. */
function safeUrl(u, { image = false } = {}) {
  const s = String(u || '').replace(/[\u0000- \u007F]+/g, '');
  if (!s) return null;
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(s);
  if (m) {
    const scheme = m[1].toLowerCase();
    const ok = image ? ['http', 'https'] : ['http', 'https', 'mailto'];
    if (!ok.includes(scheme)) return null;
  }
  return s;
}
function hostOf(u) { try { return new URL(u).host.toLowerCase(); } catch { return ''; } }
function isExternal(url, appUrl) {
  if (/^\/\//.test(url)) return true;
  if (!/^https?:/i.test(url)) return false;
  return hostOf(url) !== hostOf(appUrl || 'http://localhost');
}

const LIST_RE = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const LIST_EMPTY_RE = /^( *)([-*+]|\d{1,9}[.)])[ \t]*$/;
const HEAD_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([\w+#.-]*)[^`]*$/;
const HR_RE = /^ {0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/;
const QUOTE_RE = /^ {0,3}>[ \t]?(.*)$/;
const CTA_RE = /^\s*\[\[cta(?:[ \t]+([^\]]*?))?\]\]\s*$/i;
const CALLOUT_OPEN = /^\s*\[\[(note|tip|warning|info)\]\](.*)$/i;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const indent = (l) => l.length - l.replace(/^ +/, '').length;

function isBlockStart(l) {
  return HEAD_RE.test(l) || FENCE_RE.test(l) || HR_RE.test(l) || QUOTE_RE.test(l) || LIST_RE.test(l) || CTA_RE.test(l) || CALLOUT_OPEN.test(l);
}

/* ---------------- inline ---------------- */
function inline(src, st, { noLinks = false } = {}) {
  const tokens = [];
  const hold = (h) => `\u0000${tokens.push(h) - 1}\u0000`;
  let s = String(src).replace(/\u0000/g, '');
  // code spans first: nothing inside them is formatted
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => hold(`<code>${esc(code.trim())}</code>`));
  // backslash escapes
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, (_, c) => hold(esc(c)));
  // images
  s = s.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+=(\d{1,5})x(\d{1,5}))?(?:\s+"([^"]*)")?\s*\)/g, (all, alt, url, w, h, title) => {
    const src2 = safeUrl(url, { image: true });
    if (!src2) return hold(esc(alt));
    st.images.push({ src: src2, alt: alt.trim() });
    return hold(imgTag(src2, alt, w, h, title));
  });
  if (!noLinks) {
    // [text](url "title")
    s = s.replace(/\[((?:[^\][]|\[[^\][]*\])+)\]\(\s*<?([^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)/g, (all, text, url, title) => {
      const href = safeUrl(url);
      const inner = inline(text, st, { noLinks: true });
      if (!href) return hold(inner);
      const ext = isExternal(href, st.appUrl);
      if (/^mailto:/i.test(href)) st.links.mailto++;
      else if (ext) st.links.external++;
      else if (!href.startsWith('#')) st.links.internal++;
      return hold(`<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ''}${ext ? ' rel="noopener" target="_blank"' : ''}>${inner}</a>`);
    });
    // <https://autolinks>
    s = s.replace(/<(https?:\/\/[^\s<>]+)>/g, (all, url) => {
      const href = safeUrl(url);
      if (!href) return all;
      const ext = isExternal(href, st.appUrl);
      if (ext) st.links.external++; else st.links.internal++;
      return hold(`<a href="${esc(href)}"${ext ? ' rel="noopener" target="_blank"' : ''}>${esc(url)}</a>`);
    });
  }
  // hard line breaks: two spaces or a backslash at the end of a line
  s = s.replace(/( {2,}|\\)\n/g, () => hold('<br>'));
  let h = esc(s);
  h = h.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>');
  h = h.replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>');
  h = h.replace(/(^|[^*\w])\*(?=[^\s*])([^*])\*(?![*\w])/g, '$1<em>$2</em>');
  h = h.replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_]|[^\s_])_(?!\w)/g, '$1<em>$2</em>');
  h = h.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  for (let i = 0; i < 6 && h.includes('\u0000'); i++) h = h.replace(/\u0000(\d+)\u0000/g, (_, n) => tokens[Number(n)]);
  return h;
}

function imgTag(src, alt, w, h, title) {
  const W = Number(w) || 1200, H = Number(h) || 675;
  return `<img src="${esc(src)}" alt="${esc(alt.trim())}" width="${W}" height="${H}" loading="lazy" decoding="async"${title ? ` title="${esc(title)}"` : ''}>`;
}

const stripTags = (h) => String(h).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/* ---------------- blocks ---------------- */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '', inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') { cur += '\\|'; i++; continue; }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

const CALLOUT_LABEL = { note: 'Note', tip: 'Tip', warning: 'Watch out', info: 'Good to know' };
const CALLOUT_ICON = {
  note: '<path d="M5 3h10l4 4v14H5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 12h6M9 16h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  tip: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1.1 2.2h5c.1-1 .5-1.7 1.1-2.2A6 6 0 0 0 12 3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>',
  warning: '<path d="M12 3 2 20h20z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17" r="1.2" fill="currentColor"/>',
  info: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 11v6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="7.6" r="1.3" fill="currentColor"/>',
};

function parseBlocks(lines, st, depth = 0) {
  const out = []; // [{ type, html, text }]
  let i = 0;
  const push = (type, html, extra = {}) => out.push({ type, html, ...extra });
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    // fenced code
    let m = FENCE_RE.exec(line);
    if (m) {
      const fence = m[1], lang = m[2];
      const code = [];
      i++;
      while (i < lines.length && !new RegExp('^ {0,3}' + fence[0] + '{' + fence.length + ',}\\s*$').test(lines[i])) code.push(lines[i++]);
      i++;
      push('code', `<pre><code${lang ? ` class="language-${esc(lang.toLowerCase())}"` : ''}>${esc(code.join('\n'))}</code></pre>`, { len: code.join(' ').length });
      continue;
    }
    // CTA shortcode
    m = CTA_RE.exec(line);
    if (m) { st.cta++; push('cta', st.cta_fn(m[1] ? m[1].trim() : '')); i++; continue; }
    // callouts
    m = CALLOUT_OPEN.exec(line);
    if (m) {
      const kind = m[1].toLowerCase();
      const inner = [];
      let rest = m[2];
      const close = new RegExp('\\[\\[\\/' + kind + '\\]\\]', 'i');
      if (close.test(rest)) { inner.push(rest.replace(close, '')); i++; } else {
        if (rest.trim()) inner.push(rest);
        i++;
        while (i < lines.length && !close.test(lines[i])) inner.push(lines[i++]);
        if (i < lines.length) { const tail = lines[i].replace(close, ''); if (tail.trim()) inner.push(tail); i++; }
      }
      const body = parseBlocks(inner, st, depth + 1).map((b) => b.html).join('\n');
      push('callout', `<aside class="callout callout-${kind}"><span class="callout-i" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20">${CALLOUT_ICON[kind]}</svg></span><div class="callout-b"><b class="callout-t">${CALLOUT_LABEL[kind]}</b>${body}</div></aside>`, { len: inner.join(' ').length });
      continue;
    }
    // heading
    m = HEAD_RE.exec(line);
    if (m) {
      let level = Math.max(2, m[1].length); // the page has the only H1
      let text = m[2];
      let id = '';
      const idm = /\s*\{#([A-Za-z][\w-]*)\}\s*$/.exec(text);
      if (idm) { id = slugify(idm[1]); text = text.slice(0, idm.index); }
      const h = inline(text, st);
      const plain = stripTags(h).trim();
      id = id || slugify(plain) || 'section';
      if (depth === 0) {
        let n = 2, base = id;
        while (st.ids.has(id)) id = `${base}-${n++}`;
        st.ids.add(id);
        if (level <= 3) st.toc.push({ level, id, text: plain });
        if (level === 2) st.h2++;
        push('heading', `<h${level} id="${id}">${h}</h${level}>`, { level, len: plain.length });
      } else {
        level = Math.min(6, level + 1);
        push('heading', `<h${level}>${h}</h${level}>`, { level, len: plain.length });
      }
      i++;
      continue;
    }
    if (HR_RE.test(line)) { push('hr', '<hr>'); i++; continue; }
    // blockquote
    if (QUOTE_RE.test(line)) {
      const q = [];
      while (i < lines.length && lines[i].trim() && (QUOTE_RE.test(lines[i]) || !isBlockStart(lines[i]))) {
        const qm = QUOTE_RE.exec(lines[i]);
        q.push(qm ? qm[1] : lines[i]);
        i++;
      }
      push('quote', `<blockquote>${parseBlocks(q, st, depth + 1).map((b) => b.html).join('\n')}</blockquote>`, { len: q.join(' ').length });
      continue;
    }
    // lists
    if (LIST_RE.test(line) || LIST_EMPTY_RE.test(line)) {
      const r = parseList(lines, i, st, depth);
      push('list', r.html, { len: r.len });
      i = r.next;
      continue;
    }
    // table
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : /^:-+/.test(c) ? 'left' : ''));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
      const al = (k) => (aligns[k] ? ` style="text-align:${aligns[k]}"` : '');
      const th = head.map((c, k) => `<th scope="col"${al(k)}>${inline(c, st)}</th>`).join('');
      const tb = rows.map((r) => `<tr>${head.map((_, k) => (k === 0 ? `<th scope="row"${al(k)}>${inline(r[k] || '', st)}</th>` : `<td${al(k)}>${inline(r[k] || '', st)}</td>`)).join('')}</tr>`).join('');
      const len = [head, ...rows].flat().join(' ').length;
      push('table', `<div class="tbl-wrap" role="region" aria-label="${esc(stripTags(inline(head.join(' vs '), st)).slice(0, 120))}" tabindex="0"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`, { len });
      continue;
    }
    // paragraph
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-'))) para.push(lines[i++]);
    const text = para.map((l) => l.replace(/^ +/, '')).join('\n');
    const onlyImg = /^!\[[^\]]*\]\([^)]*\)$/.test(text.trim());
    if (onlyImg) {
      const capm = /\s"([^"]*)"\s*\)$/.exec(text.trim());
      const h = inline(text.trim(), st);
      push('figure', `<figure>${h}${capm && capm[1] ? `<figcaption>${esc(capm[1])}</figcaption>` : ''}</figure>`, { len: 40 });
    } else {
      const h = inline(text, st);
      push('p', `<p>${h}</p>`, { len: text.length });
    }
  }
  return out;
}

function parseList(lines, start, st, depth) {
  const first = LIST_RE.exec(lines[start]) || LIST_EMPTY_RE.exec(lines[start]);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let i = start, loose = false, len = 0;
  while (i < lines.length) {
    const m = LIST_RE.exec(lines[i]) || LIST_EMPTY_RE.exec(lines[i]);
    if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered) break;
    const contentIndent = m[1].length + m[2].length + 1;
    const item = [m[3] || ''];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && indent(lines[j]) > base) { item.push(''); i++; continue; }
        break;
      }
      if (indent(l) > base) { item.push(l.slice(Math.min(contentIndent, indent(l)))); i++; continue; }
      if (!isBlockStart(l)) { item.push(l); i++; continue; } // lazy continuation of the item's text
      break;
    }
    // skip blank lines between items of the same list
    let j = i;
    while (j < lines.length && !lines[j].trim()) j++;
    if (j > i && j < lines.length) {
      const nm = LIST_RE.exec(lines[j]);
      if (nm && nm[1].length === base && /\d/.test(nm[2]) === ordered) { loose = true; i = j; }
    }
    items.push(item);
  }
  const lis = items.map((it) => {
    len += it.join(' ').length;
    const blocks = parseBlocks(it, st, depth + 1);
    const inner = blocks.map((b, k) => (!loose && b.type === 'p' && (k === 0 || blocks[k - 1].type !== 'p') ? b.html.replace(/^<p>([\s\S]*)<\/p>$/, '$1') : b.html)).join('\n');
    return `<li>${inner}</li>`;
  }).join('\n');
  const tag = ordered ? 'ol' : 'ul';
  return { html: `<${tag}${ordered && startNum !== 1 ? ` start="${startNum}"` : ''}>\n${lis}\n</${tag}>`, next: i, len };
}

const defaultCta = (text) => `<div class="cta-block"><p>${esc(text || 'Start free: a welcome bot for your Telegram channel.')}</p><a href="/#signup">Start free</a></div>`;

function render(md, opts = {}) {
  const st = {
    appUrl: opts.appUrl || '', toc: [], ids: new Set(), h2: 0, images: [], links: { internal: 0, external: 0, mailto: 0 }, cta: 0,
    cta_fn: opts.cta || defaultCta,
  };
  const lines = String(md || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const blocks = parseBlocks(lines, st, 0);
  // One CTA at about 40% of the post, before the nearest H2 after that point, unless the writer placed [[cta]].
  if (opts.autoCta !== false && !st.cta && blocks.length >= 4) {
    const total = blocks.reduce((a, b) => a + (b.len || 0), 0);
    let cum = 0, at = -1;
    for (let k = 0; k < blocks.length; k++) { cum += blocks[k].len || 0; if (cum >= total * 0.4) { at = k + 1; break; } }
    if (at > 0 && at < blocks.length) {
      for (let k = at; k < Math.min(blocks.length, at + 4); k++) if (blocks[k].type === 'heading' && blocks[k].level === 2) { at = k; break; }
      if (blocks[at - 1] && blocks[at - 1].type !== 'heading') blocks.splice(at, 0, { type: 'cta', html: st.cta_fn(''), auto: true });
    }
  }
  const html = blocks.map((b) => b.html).join('\n');
  const text = stripTags(blocks.filter((b) => b.type !== 'cta').map((b) => b.html).join('\n')).replace(/\s+/g, ' ').trim();
  const words = text ? text.split(' ').filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0;
  return { html, toc: st.toc, words, images: st.images, links: st.links, h2: st.h2, text, ctas: blocks.filter((b) => b.type === 'cta').length };
}

/** Inline markdown only (FAQ answers, takeaways): bold, italic, code, links. */
function renderInline(md, opts = {}) {
  const st = { appUrl: opts.appUrl || '', images: [], links: { internal: 0, external: 0, mailto: 0 } };
  return inline(String(md || '').replace(/\r\n?/g, '\n'), st);
}

module.exports = { render, renderInline, slugify, safeUrl, esc, stripTags };

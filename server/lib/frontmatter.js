'use strict';
/*
 * A small YAML front-matter reader for the blog seed files (server/blog-seed/*.md). No packages.
 * It understands exactly what the seed format uses:
 *
 *   ---
 *   title: "Text"                 strings, "double" or 'single' quoted, or bare
 *   featured: true                booleans (true/false/yes/no)
 *   tags: ["a", "b"]              inline arrays of strings
 *   faq:                          a list of maps (- q: "…" then   a: "…")
 *     - q: "Question"
 *       a: "Answer"
 *   takeaways:                    or a block list of strings
 *     - "First"
 *   ---
 *   Markdown body…
 *
 * `# comments` after a value are ignored (outside quotes). parse(text) → { data, body }.
 */

function unquote(s) {
  s = s.trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/\\(["\\nt/])/g, (_, c) => ({ n: '\n', t: '\t' }[c] || c));
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

/** Remove a trailing "# comment" that is outside quotes. */
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '\\' && q === '"') { i++; continue; }
      if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") q = ch;
    else if (ch === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s;
}

/** Split "a", "b, c", 'd' (the inside of [ ... ]) on commas outside quotes. */
function splitList(s) {
  const out = [];
  let cur = '', q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      cur += ch;
      if (ch === '\\' && q === '"' && i + 1 < s.length) { cur += s[++i]; continue; }
      if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") { q = ch; cur += ch; } else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => unquote(x)).filter((x) => x !== '');
}

function scalar(raw) {
  const s = stripComment(raw).trim();
  if (s === '') return '';
  if (s.startsWith('[') && s.endsWith(']')) return splitList(s.slice(1, -1));
  if (/^(true|yes)$/i.test(s)) return true;
  if (/^(false|no)$/i.test(s)) return false;
  if (/^(null|~)$/i.test(s)) return null;
  if (s[0] !== '"' && s[0] !== "'" && /^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return unquote(s);
}

const indentOf = (l) => l.length - l.trimStart().length;
const KEY = /^([A-Za-z_][\w-]*)\s*:(.*)$/;

function parseYaml(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const data = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line) || indentOf(line) > 0) continue;
    const m = KEY.exec(line);
    if (!m) continue;
    const key = m[1];
    const rest = stripComment(m[2]).trim();
    if (rest !== '' && rest !== '|' && rest !== '>') { data[key] = scalar(m[2]); continue; }
    // A block: the indented lines that follow.
    const block = [];
    while (i + 1 < lines.length && (lines[i + 1].trim() === '' || indentOf(lines[i + 1]) > 0)) block.push(lines[++i]);
    if (rest === '|' || rest === '>') {
      const ind = Math.min(...block.filter((l) => l.trim()).map(indentOf));
      const body = block.map((l) => l.slice(ind)).join('\n').replace(/\n+$/, '');
      data[key] = rest === '>' ? body.replace(/\n(?!\n)/g, ' ') : body;
      continue;
    }
    const items = [];
    let cur = null;
    let itemIndent = -1;
    for (const bl of block) {
      if (!bl.trim() || /^\s*#/.test(bl)) continue;
      const t = bl.trim();
      if (t.startsWith('- ') || t === '-') {
        itemIndent = indentOf(bl);
        const inner = t.slice(1).trim();
        const km = KEY.exec(inner);
        if (km && !/^["']/.test(inner)) { cur = { [km[1]]: scalar(km[2]) }; items.push(cur); } else { cur = null; items.push(scalar(inner)); }
      } else if (cur && indentOf(bl) > itemIndent) {
        const km = KEY.exec(t);
        if (km) cur[km[1]] = scalar(km[2]);
        else {
          // A long value continued on the next line: join it to the last key.
          const last = Object.keys(cur).pop();
          if (last && typeof cur[last] === 'string') cur[last] = (cur[last] + ' ' + unquote(t)).trim();
        }
      }
    }
    data[key] = items;
  }
  return data;
}

function parse(text) {
  const src = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(\n|$)/.exec(src);
  if (!m) return { data: {}, body: src };
  return { data: parseYaml(m[1]), body: src.slice(m[0].length).replace(/^\n+/, '') };
}

module.exports = { parse, parseYaml };

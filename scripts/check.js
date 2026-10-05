'use strict';
/*
 * The pre-launch checker:  npm run check
 * Runs without a database. It checks:
 *   1. every JavaScript file parses
 *   2. no unfinished or fake-looking words in anything customers see
 *   3. prices, AI writes, referral rates and limits say the same thing everywhere
 *   4. email templates and legal pages only use variables that exist
 *   5. every environment variable the server reads is documented in .env.example
 *   6. every API route is protected (admin routes need a staff permission, app routes need a login)
 *   7. links and files referenced by the website exist
 *   8. feature switches used by the website exist on the server
 *   9. migrations split into valid statements
 * Exit code 1 if anything fails, so it can run before every deploy.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const rel = (p) => path.relative(ROOT, p);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const problems = [];
const passed = [];
const fail = (area, msg) => problems.push(`[${area}] ${msg}`);
function walk(dir, ext, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['node_modules', 'out', '.git', 'data'].includes(e.name)) walk(p, ext, out); } else if (ext.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

// Dummy env so modules can be loaded without a real database.
process.env.APP_SECRET = process.env.APP_SECRET || 'x'.repeat(40);
process.env.QUIET_LOGS = '1';

/* 1. Syntax */
{
  let n = 0;
  for (const f of [...walk('server', ['.js']), ...walk('public', ['.js']), ...walk('scripts', ['.js']), ...walk('test', ['.js']), ...walk('voo-connect', ['.js'])]) {
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' }); n++; } catch (e) { fail('syntax', `${f}: ${String(e.stderr).split('\n').slice(0, 4).join(' ')}`); }
  }
  passed.push(`syntax: ${n} JavaScript files parse`);
}

/* 2. Words customers must never see */
{
  const files = [
    'public/index.html', 'public/404.html', ...walk('public/js', ['.js']),
    ...walk('server/legal', ['.html']), 'server/emails/templates.js', 'server/seed.js', 'server/knowledge-defaults.js',
  ];
  const BAD = [
    [/\bTODO\b|\bFIXME\b|\bTBD\b/, 'unfinished marker'],
    [/lorem ipsum/i, 'lorem ipsum'],
    [/\[(insert|your|company|name|date|address)[^\]]*\]/i, 'blank to fill in'],
    [/consult (a|your) (lawyer|attorney)|lawyer (needs|should) (to )?(read|review)|not legal advice|this is a (sample|template) (policy|document)/i, 'legal-draft wording'],
    [/\b(read rate|open rate|read by \d|seen by \d)/i, 'read-receipt claim (Telegram gives bots none)'],
    [/guaranteed (profit|income|results|returns)/i, 'guaranteed-results claim'],
    [/\$5 (for|per) 500|extra (ai )?packs?|per extra seat|\$1 per (extra )?1[,.]?000 subscribers/i, 'old add-on fee'],
    [/20% off with joinvoo|joinvoo discount/i, 'old Joinvoo discount'],
  ];
  let n = 0;
  for (const f of files) {
    const text = read(f);
    for (const [re, what] of BAD) {
      const m = text.match(re);
      if (!m) continue;
      if (what === 'blank to fill in' && f.endsWith('.js') && f.startsWith('public')) continue; // JS code like PAGES[name] is not copy
      if (!/must not|never|no (honest )?tool|\bnot\b|\bno\b|doesn't|don't|cannot|can't/i.test(text.slice(Math.max(0, m.index - 120), m.index))) fail('copy', `${f}: ${what}: "${m[0]}"`);
    }
    n++;
  }
  passed.push(`copy: ${n} customer-facing files scanned`);
}

/* 3. Prices and numbers agree everywhere */
{
  const { PLANS, SETTINGS, CONTENT } = require('../server/seed');
  const facts = read('docs/PRODUCT-FACTS.md');
  const kb = require('../server/knowledge-defaults').map((k) => k.body).join('\n');
  const faq = JSON.parse(CONTENT.faq).map((x) => x.a).join('\n');
  const fmt = (n) => n.toLocaleString('en-US');
  for (const p of PLANS) {
    const row = facts.split('\n').find((l) => l.startsWith(`| ${p.name} |`));
    if (!row) { fail('pricing', `PRODUCT-FACTS.md has no row for ${p.name}`); continue; }
    const want = [`$${p.price_month_cents / 100}`, `| ${p.connections} |`, `${fmt(p.subscribers)}`, `${fmt(p.ai_writes)}`, `| ${p.seats} |`];
    for (const w of want) if (!row.includes(w)) fail('pricing', `${p.name}: PRODUCT-FACTS row "${row.trim()}" is missing ${w}`);
    if (p.price_year_cents !== p.price_month_cents * 10) fail('pricing', `${p.name}: yearly price should be 10 × monthly (2 months free)`);
    if (!faq.includes(`${fmt(p.ai_writes)} on ${p.name}`)) fail('pricing', `FAQ "What is an AI write?" does not say ${fmt(p.ai_writes)} on ${p.name}`);
    if (!p.bullets.some((b) => b.includes(fmt(p.subscribers)))) fail('pricing', `${p.name} bullets don't mention ${fmt(p.subscribers)} subscribers`);
    if (!p.bullets.some((b) => b.includes(fmt(p.ai_writes)))) fail('pricing', `${p.name} bullets don't mention ${fmt(p.ai_writes)} AI writes`);
  }
  const r = SETTINGS.referral;
  const rateText = `${r.rates[0]}%`;
  for (const [name, text] of [['FACTS', facts], ['knowledge', kb]]) {
    for (const x of r.rates) if (!text.includes(`${x}%`)) fail('referral', `${name} does not mention the ${x}% rate`);
    if (!text.includes(`$${r.min_withdraw_cents / 100}`)) fail('referral', `${name} does not mention the $${r.min_withdraw_cents / 100} minimum withdrawal`);
  }
  if (r.min_withdraw_cents !== 30000) fail('referral', 'minimum withdrawal must be $300 (owner\'s rule)');
  if (!kb.includes(`${SETTINGS.trial.ai_writes} AI writes`)) fail('pricing', `knowledge does not mention the ${SETTINGS.trial.ai_writes} trial AI writes`);
  void rateText;
  // Plans must be affordable and profitable: AI cost at full use stays under 20% of the price (Haiku ≈ $0.003 a write).
  for (const p of PLANS) { const aiCost = p.ai_writes * 0.003 * 100; if (aiCost > p.price_month_cents * 0.2) fail('pricing', `${p.name}: AI writes could cost $${(aiCost / 100).toFixed(2)}, over 20% of the price`); }
  passed.push(`pricing: ${PLANS.length} plans, referral rates and limits agree across seed, FAQ, knowledge and PRODUCT-FACTS`);
}

/* 4. Email and legal variables */
{
  const T = require('../server/emails/templates');
  const GLOBAL = ['first_name', 'app_url', 'site_url', 'support_email', 'company_name', 'company_address', 'unsubscribe_url', 'billing_email', 'privacy_email', 'data_retention_days'];
  for (const [key, t] of Object.entries(T)) {
    for (const f of ['category', 'name', 'when', 'subject', 'preheader', 'body', 'text', 'vars']) if (t[f] === undefined) fail('emails', `${key}: missing ${f}`);
    const used = new Set([...(t.subject + t.preheader + t.body + t.text).matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)].map((m) => m[1]));
    for (const v of used) if (!t.vars.includes(v) && !GLOBAL.includes(v)) fail('emails', `${key}: uses {{${v}}} that is not declared`);
    for (const v of t.vars) if (!used.has(v)) fail('emails', `${key}: declares ${v} but never uses it`);
  }
  const LEGAL_VARS = ['company_name', 'company_address', 'support_email', 'privacy_email', 'billing_email', 'site_url', 'legal_updated', 'trial_days', 'refund_days', 'ref_settle_days', 'ref_min_withdraw', 'ref_rate_1', 'ref_rate_2', 'ref_rate_3', 'ref_tier2_min', 'ref_tier3_min', 'data_retention_days', 'referral_cookie_days', 'renew_reminder_days'];
  const legal = require('../server/legal/index.js');
  for (const l of legal) {
    const html = read(`server/legal/${l.slug}.html`);
    for (const m of html.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)) if (!LEGAL_VARS.includes(m[1])) fail('legal', `${l.slug}: unknown variable {{${m[1]}}}`);
    if (!/<h1>/.test(html)) fail('legal', `${l.slug}: no title`);
  }
  // The server's publicVars() must provide every legal variable.
  const src = read('server/services/settings.js');
  for (const v of LEGAL_VARS) if (!new RegExp(`\\b${v}\\b`).test(src)) fail('legal', `settings.publicVars() does not provide ${v}`);
  passed.push(`emails: ${Object.keys(T).length} templates; legal: ${legal.length} pages; all variables exist`);
}

/* 5. Environment variables documented */
{
  const cfg = read('server/config.js');
  const ex = fs.existsSync(path.join(ROOT, '.env.example')) ? read('.env.example') : '';
  if (!ex) fail('env', '.env.example is missing');
  const vars = [...new Set([...cfg.matchAll(/env\.([A-Z0-9_]+)/g)].map((m) => m[1]))].filter((v) => !['NODE_ENV'].includes(v));
  for (const v of vars) if (!new RegExp(`^#?\\s*${v}=`, 'm').test(ex)) fail('env', `${v} is read by server/config.js but not documented in .env.example`);
  passed.push(`env: ${vars.length} variables documented`);
}

/* 6. Every route is protected the right way */
{
  const { buildRouter } = require('../server/app');
  const r = buildRouter();
  const PUBLIC_API = ['/api/public/', '/api/auth/', '/api/voosquare/'];
  let n = 0;
  for (const rt of r.routes) {
    n++;
    const o = rt.opts || {};
    if (rt.pattern.startsWith('/api/admin') && !o.staff) fail('routes', `${rt.method} ${rt.pattern} has no staff permission`);
    if (rt.pattern.startsWith('/api/') && !rt.pattern.startsWith('/api/admin') && !PUBLIC_API.some((p) => rt.pattern.startsWith(p)) && !['user', 'workspace'].includes(o.auth) && rt.pattern !== '/api/me') fail('routes', `${rt.method} ${rt.pattern} is not behind a login`);
    if (o.staff && !require('../server/permissions').PERMS[o.staff]) fail('routes', `${rt.pattern} uses unknown permission ${o.staff}`);
  }
  const vs = read('server/routes/voosquare.js');
  if ((vs.match(/requireKey\(ctx\)/g) || []).length < 5) fail('routes', 'every VooSquare route must call requireKey(ctx)');
  passed.push(`routes: ${n} routes checked for login / permission`);
}

/* 7. Website links and files */
{
  const html = read('public/index.html');
  const legalSlugs = require('../server/legal/index.js').map((l) => l.slug);
  for (const m of html.matchAll(/(?:href|src)="(\/[^"#?]*)/g)) {
    const p = m[1];
    if (p === '/' || p.startsWith('/api/') || p === '/admin' || p === '/voo-connect-browser.js') continue; // served by routes/voo-connect.js
    if (p.startsWith('/legal/')) { if (!legalSlugs.includes(p.slice(7))) fail('links', `index.html links to unknown legal page ${p}`); continue; }
    if (!fs.existsSync(path.join(ROOT, 'public', p))) fail('links', `index.html references missing file ${p}`);
  }
  const admin = read('public/admin/index.html');
  for (const m of admin.matchAll(/(?:href|src)="(\/[^"#?]*)/g)) if (!m[1].startsWith('/api') && m[1] !== '/' && m[1] !== '/admin' && !fs.existsSync(path.join(ROOT, 'public', m[1]))) fail('links', `admin/index.html references missing file ${m[1]}`);
  if (/<script>(?!\s*<\/script>)/.test(html) || /\son(click|load|error|submit)=/i.test(html)) fail('csp', 'index.html has inline scripts or inline event handlers (blocked by the Content-Security-Policy)');
  if (/<script>(?!\s*<\/script>)/.test(admin) || /\son(click|load|error|submit)=/i.test(admin)) fail('csp', 'admin/index.html has inline scripts or inline event handlers');
  passed.push('links: website and admin files and legal links exist; no inline scripts');
}

/* 8. Feature switches used by the website exist */
{
  const { FEATURES } = require('../server/features');
  const keys = new Set(FEATURES.map((f) => f.key));
  const js = walk('public/js', ['.js']).map((f) => read(f)).join('\n');
  for (const m of js.matchAll(/CFG\.features\.([a-z_]+)/g)) if (!keys.has(m[1])) fail('features', `website uses features.${m[1]} which does not exist`);
  passed.push(`features: ${keys.size} switches; website only uses known ones`);
}

/* 9. Migrations */
{
  const { splitSql } = require('../server/db');
  let n = 0;
  for (const f of fs.readdirSync(path.join(ROOT, 'server/migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    const stmts = splitSql(read('server/migrations/' + f));
    if (!stmts.length) fail('migrations', `${f} has no statements`);
    n += stmts.length;
  }
  passed.push(`migrations: ${n} statements`);
}

console.log('\nCastvoo pre-launch check\n');
for (const p of passed) console.log('  ✓ ' + p);
if (problems.length) {
  console.log(`\n  ✗ ${problems.length} problem(s):`);
  for (const p of problems) console.log('    - ' + p);
  process.exit(1);
}
console.log('\n  All checks passed.\n');
process.exit(0);

#!/usr/bin/env node
'use strict';
/*
 * Voo Connect self-test: checks a tool's VooSquare settings from the tool developer's computer or server, and prints a
 * pass / fail checklist. It changes nothing (no events stored, no tickets, no users).
 *
 *   node sdk/voo-connect/check.js --base https://voosquare.com --client-id vsc_... --client-secret vss_... \
 *     --api-key vsk_... --redirect-uri https://joinvoo.com/auth/voosquare/callback --logout-uri https://joinvoo.com/
 *
 * Every flag can come from the environment instead: VOO_BASE, VOO_CLIENT_ID, VOO_CLIENT_SECRET, VOO_API_KEY,
 * VOO_REDIRECT_URI (comma separated for several), VOO_LOGOUT_URI, VOO_SUMMARY_URL, VOO_TEST_VOO_ID.
 * Optional: --summary-url <your summary URL> (calls it like VooSquare does), --voo-id <a real Voo ID> (proves the API key
 * and the client ID belong to the same product), --json (machine-readable), --timeout <ms>.
 * Exit code 0 = no failures, 1 = at least one failure, 2 = wrong usage.
 */
const crypto = require('node:crypto');

const HELP = `Voo Connect check: test a tool's VooSquare connection.

  node check.js --base https://voosquare.com --client-id <id> --client-secret <secret> --api-key <key> \\
                --redirect-uri <callback URL> [--redirect-uri <another>] [--logout-uri <home page>] \\
                [--summary-url <your summary URL>] [--voo-id <a real Voo ID>] [--json] [--timeout 8000]

Environment instead of flags: VOO_BASE, VOO_CLIENT_ID, VOO_CLIENT_SECRET, VOO_API_KEY, VOO_REDIRECT_URI,
VOO_LOGOUT_URI, VOO_SUMMARY_URL, VOO_TEST_VOO_ID.`;

function parseArgs(argv, env = process.env) {
  const o = { redirectUris: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const val = () => (inline !== undefined ? inline : argv[++i]);
    switch (flag) {
      case '--base': o.base = val(); break;
      case '--client-id': o.clientId = val(); break;
      case '--client-secret': o.clientSecret = val(); break;
      case '--api-key': o.apiKey = val(); break;
      case '--redirect-uri': o.redirectUris.push(val()); break;
      case '--logout-uri': o.logoutUri = val(); break;
      case '--summary-url': o.summaryUrl = val(); break;
      case '--voo-id': o.vooId = val(); break;
      case '--timeout': o.timeoutMs = Number(val()); break;
      case '--json': o.json = true; break;
      case '-h': case '--help': o.help = true; break;
      default: o.unknown = (o.unknown || []).concat(a);
    }
  }
  o.base = String(o.base || env.VOO_BASE || '').replace(/\/+$/, '');
  o.clientId = o.clientId || env.VOO_CLIENT_ID || '';
  o.clientSecret = o.clientSecret || env.VOO_CLIENT_SECRET || '';
  o.apiKey = o.apiKey || env.VOO_API_KEY || '';
  if (!o.redirectUris.length && env.VOO_REDIRECT_URI) o.redirectUris = env.VOO_REDIRECT_URI.split(',').map((s) => s.trim()).filter(Boolean);
  o.logoutUri = o.logoutUri || env.VOO_LOGOUT_URI || '';
  o.summaryUrl = o.summaryUrl || env.VOO_SUMMARY_URL || '';
  o.vooId = o.vooId || env.VOO_TEST_VOO_ID || '';
  o.timeoutMs = o.timeoutMs > 0 ? o.timeoutMs : 8000;
  return o;
}

const isLocal = (u) => { try { const h = new URL(u).hostname; return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h.endsWith('.localhost') || h.endsWith('.test'); } catch { return false; } };
const mask = (s) => (s ? String(s).slice(0, 6) + '…' : '(missing)');

async function req(url, { method = 'GET', headers = {}, body, timeoutMs }) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { method, headers: { 'user-agent': 'voo-connect-check/1.0', ...headers }, body, redirect: 'manual', signal: ctl.signal });
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, headers: res.headers, text, data, ms: Date.now() - started };
  } catch (e) {
    return { status: 0, error: e.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : e.cause ? `${e.message} (${e.cause.code || e.cause.message})` : e.message, ms: Date.now() - started };
  } finally { clearTimeout(t); }
}
/* VooSquare's /oauth/authorize answers errors as a small HTML page; its <h1> says what is wrong. */
const pageTitle = (html) => { const m = /<h1>([^<]*)<\/h1>/i.exec(String(html || '')); return m ? m[1].replace(/&#39;|&rsquo;|’/g, "'").trim() : ''; };

/** Runs every check. Resolves { results: [{ status: 'pass'|'warn'|'fail'|'skip', name, detail }], ok }. */
async function runChecks(opts) {
  const o = { ...opts };
  const results = [];
  const add = (status, name, detail = '') => { results.push({ status, name, detail }); return status; };
  const T = o.timeoutMs || 8000;

  // 0. Inputs
  if (!/^https?:\/\//.test(o.base || '')) { add('fail', 'VooSquare address (--base)', 'Missing or not a URL, e.g. https://voosquare.com'); return { results, ok: false }; }
  if (!o.base.startsWith('https://') && !isLocal(o.base)) add('fail', 'VooSquare address uses https', `${o.base} is plain http. Use https://voosquare.com (or your staging https address).`);

  // 1. Reachable
  const hz = await req(o.base + '/healthz', { timeoutMs: T });
  if (hz.status === 200 && hz.data && hz.data.ok) add('pass', 'VooSquare is reachable', `${o.base}/healthz answered in ${hz.ms} ms`);
  else { add('fail', 'VooSquare is reachable', hz.error ? `Could not connect: ${hz.error}` : `/healthz answered ${hz.status}. Is --base the VooSquare address?`); return { results, ok: false }; }

  // 2. Clock
  const date = Date.parse(hz.headers.get('date') || '');
  if (Number.isFinite(date)) {
    const skew = Math.round((Date.now() - hz.ms / 2 - date) / 1000);
    const abs = Math.abs(skew);
    if (abs <= 30) add('pass', 'Clock in sync with VooSquare', `difference ${skew} s`);
    else if (abs <= 300) add('warn', 'Clock in sync with VooSquare', `difference ${skew} s. Turn on NTP time sync: login tokens allow 60 s, event times more than 10 minutes ahead are replaced.`);
    else add('fail', 'Clock in sync with VooSquare', `difference ${skew} s. Fix the server clock (NTP): id_tokens will look expired and event times will be wrong.`);
  } else add('warn', 'Clock in sync with VooSquare', 'VooSquare sent no Date header; could not compare.');

  // 3. Client ID, SSO switch and every redirect URI
  if (!o.clientId) add('fail', 'Client ID (--client-id)', 'Missing. Admin → Products → <tool> → Credentials.');
  else if (!o.redirectUris.length) add('fail', 'Redirect URI (--redirect-uri)', 'Pass your callback URL, e.g. https://joinvoo.com/auth/voosquare/callback');
  else {
    let first = true;
    for (const uri of o.redirectUris) {
      if (!/^https?:\/\//.test(uri)) { add('fail', `Redirect URI ${uri}`, 'Not a full URL.'); continue; }
      const u = new URL(o.base + '/oauth/authorize');
      u.searchParams.set('client_id', o.clientId); u.searchParams.set('redirect_uri', uri); u.searchParams.set('state', 'voo-connect-check'); u.searchParams.set('prompt', 'signup');
      const r = await req(u.toString(), { timeoutMs: T });
      const loc = r.headers ? r.headers.get('location') || '' : '';
      const title = pageTitle(r.text);
      if (first) {
        if (r.status === 400 && /unknown app/i.test(title)) { add('fail', 'Client ID is known to VooSquare', `${mask(o.clientId)} is not a product's client ID on ${o.base}. Copy it again from Admin → Products → <tool> → Credentials (staging and production have different credentials).`); break; }
        if (r.status === 400 && /not switched on/i.test(title)) { add('fail', 'VooSquare login (SSO) is switched on', 'Admin → Products → <tool>: turn "SSO" on and save.'); break; }
        if (r.status === 302 || r.status === 400) { add('pass', 'Client ID is known to VooSquare', mask(o.clientId)); add('pass', 'VooSquare login (SSO) is switched on'); }
        first = false;
      }
      if (r.status === 302 && /\/login\?product=[^&]+&mode=signup/.test(loc)) add('pass', `Redirect URI registered: ${uri}`, '"Start free" (prompt=signup) opens the sign-up view');
      else if (r.status === 302) add('pass', `Redirect URI registered: ${uri}`);
      else if (r.status === 400 && /redirect/i.test(title)) add('fail', `Redirect URI registered: ${uri}`, 'Not on the allowed list. Admin → Products → <tool> → Redirect URIs: add this exact address (scheme, host, port, path).');
      else add('fail', `Redirect URI registered: ${uri}`, r.error || `Unexpected answer ${r.status} ${title}`);
      if (!uri.startsWith('https://') && !isLocal(uri)) add('warn', `Redirect URI uses https: ${uri}`, 'Use https in production.');
    }
  }

  // 4. Client secret (exchange a code that cannot exist: invalid_grant proves the secret, invalid_client refutes it)
  if (!o.clientSecret) add('fail', 'Client secret (--client-secret)', 'Missing. Admin → Products → <tool> → Credentials.');
  else if (o.clientId) {
    const body = new URLSearchParams({ grant_type: 'authorization_code', code: 'voo-connect-check-' + crypto.randomBytes(9).toString('hex'), redirect_uri: o.redirectUris[0] || o.base, client_id: o.clientId, client_secret: o.clientSecret }).toString();
    const r = await req(o.base + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, timeoutMs: T });
    if (r.status === 400 && r.data && r.data.error === 'invalid_grant') add('pass', 'Client secret is valid', 'the token endpoint accepted the credentials');
    else if (r.status === 401) add('fail', 'Client secret is valid', 'VooSquare refused the client ID / secret pair (invalid_client). Copy the secret again; it changes when someone presses Rotate.');
    else add('fail', 'Client secret is valid', r.error || `Unexpected answer ${r.status} ${r.text ? r.text.slice(0, 120) : ''}`);
  }

  // 5. API key and the events endpoint (an empty batch stores nothing)
  if (!o.apiKey) add('fail', 'API key (--api-key)', 'Missing. Admin → Products → <tool> → Credentials.');
  else {
    const r = await req(o.base + '/api/v1/events', { method: 'POST', headers: { authorization: 'Bearer ' + o.apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ events: [] }), timeoutMs: T });
    if (r.status === 200 && r.data && r.data.ok) add('pass', 'Events endpoint reachable, API key valid', `POST /api/v1/events answered in ${r.ms} ms`);
    else if (r.status === 401) add('fail', 'Events endpoint reachable, API key valid', 'VooSquare refused the API key (401). Copy it again from Admin → Products → <tool> → Credentials.');
    else if (r.status === 429) add('warn', 'Events endpoint reachable, API key valid', 'Rate limited (429): slow down, the key itself is fine.');
    else add('fail', 'Events endpoint reachable, API key valid', r.error || `Unexpected answer ${r.status}`);
    const s = await req(o.base + '/api/v1/support/tickets/0/messages', { headers: { authorization: 'Bearer ' + o.apiKey }, timeoutMs: T });
    if (s.status === 404) add('pass', 'Support API reachable');
    else if (s.status === 401) add('fail', 'Support API reachable', 'API key refused (401).');
    else add('warn', 'Support API reachable', s.error || `Unexpected answer ${s.status}`);
    if (o.vooId) {
      const u = await req(o.base + '/api/v1/users/' + encodeURIComponent(o.vooId), { headers: { authorization: 'Bearer ' + o.apiKey }, timeoutMs: T });
      if (u.status === 200 && u.data && u.data.aud === o.clientId) add('pass', 'API key and client ID belong to the same product');
      else if (u.status === 200) add('fail', 'API key and client ID belong to the same product', 'The API key belongs to another product (maybe VooSquare\'s own hub key, whose spend is ignored). Use this tool\'s key.');
      else if (u.status === 404) add('warn', 'API key and client ID belong to the same product', `Voo ID ${o.vooId} not found on ${o.base}; pass a real one with --voo-id.`);
      else add('fail', 'API key and client ID belong to the same product', u.error || `Unexpected answer ${u.status}`);
    } else add('skip', 'API key and client ID belong to the same product', 'Pass --voo-id <any real Voo ID, e.g. yours> to check.');
  }

  // 6. Logout lands back on the tool
  if (o.logoutUri) {
    const r = await req(`${o.base}/oauth/logout?redirect_uri=${encodeURIComponent(o.logoutUri)}`, { timeoutMs: T });
    const loc = r.headers ? r.headers.get('location') || '' : '';
    if (r.status === 302 && loc === o.logoutUri) add('pass', `Logout comes back to ${o.logoutUri}`);
    else if (r.status === 302) add('fail', `Logout comes back to ${o.logoutUri}`, `VooSquare sends people to ${loc || '/'} instead. Use a page on the product's own site (the origin of its URL in the admin), or add ${o.logoutUri} to the product's Redirect URIs (exact address).`);
    else add('fail', `Logout comes back to ${o.logoutUri}`, r.error || `Unexpected answer ${r.status}`);
  } else add('skip', 'Logout comes back to your site', 'Pass --logout-uri <your home page> to check.');

  // 7. Summary URL (called the way VooSquare calls it)
  if (o.summaryUrl) {
    const url = o.summaryUrl + (o.summaryUrl.includes('?') ? '&' : '?') + 'voo_id=vs_voo_connect_check&period=1d';
    const r = await req(url, { headers: { authorization: 'Bearer ' + o.apiKey }, timeoutMs: T });
    if (r.status === 200 && r.data && r.data.linked === false && r.ms <= 1500) add('pass', 'Summary URL answers an unknown Voo ID with {"linked": false}', `${r.ms} ms`);
    else if (r.status === 200 && r.ms > 1500) add('fail', 'Summary URL answers within 1.5 s', `${r.ms} ms: VooSquare stops waiting at 1.5 s.`);
    else add('fail', 'Summary URL answers an unknown Voo ID with {"linked": false}', r.error || `Answered ${r.status} ${r.text ? r.text.slice(0, 120) : ''}`);
    const n = await req(o.summaryUrl + (o.summaryUrl.includes('?') ? '&' : '?') + 'voo_id=vs_voo_connect_check', { timeoutMs: T });
    if (n.status === 401 || n.status === 403) add('pass', 'Summary URL refuses calls without the API key');
    else add('fail', 'Summary URL refuses calls without the API key', `Answered ${n.status || n.error}. Check Authorization: Bearer <VOO_API_KEY> (voo.summaryHandler does this).`);
    if (!o.summaryUrl.startsWith('https://') && !isLocal(o.summaryUrl)) add('warn', 'Summary URL uses https', 'VooSquare only calls public https addresses in production.');
  } else add('skip', 'Summary URL', 'Optional. Pass --summary-url <your summary URL> to check it.');

  return { results, ok: !results.some((r) => r.status === 'fail') };
}

function print({ results, ok }, o, out = process.stdout) {
  const tag = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', skip: 'SKIP' };
  out.write(`\nVoo Connect check · ${o.base || '(no base)'} · client ${mask(o.clientId)}\n\n`);
  for (const r of results) out.write(`  ${tag[r.status]}  ${r.name}${r.detail ? `\n        ${r.detail}` : ''}\n`);
  const n = (s) => results.filter((r) => r.status === s).length;
  out.write(`\n${ok ? 'All good' : 'Fix the FAIL lines, then run this again'}: ${n('pass')} passed, ${n('fail')} failed, ${n('warn')} warnings, ${n('skip')} skipped.\n`);
}

module.exports = { runChecks, parseArgs, print };

if (require.main === module) {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); process.exit(0); }
  if (o.unknown) { console.error(`Unknown option: ${o.unknown.join(' ')}\n\n${HELP}`); process.exit(2); }
  runChecks(o).then((r) => {
    if (o.json) process.stdout.write(JSON.stringify(r, null, 2) + '\n'); else print(r, o);
    process.exit(r.ok ? 0 : 1);
  }, (e) => { console.error('check crashed:', e); process.exit(1); });
}

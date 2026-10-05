'use strict';
/*
 * The web server: turns every HTTP request into a call to one route handler.
 * Routes live in server/routes/*.js. Each file exports function (r) { r.get(...); ... }.
 * To add a new group of routes, create a file there and add it to ROUTE_FILES below.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const log = require('./lib/log');
const { create, readBody, parseCookies, securityHeaders, sendJson } = require('./lib/router');
const { HttpError } = require('./lib/util');
const rl = require('./lib/ratelimit');
const auth = require('./services/auth');
const perms = require('./permissions');
const voo = require('./lib/voo');

const ROUTE_FILES = [
  'public', 'auth', 'workspace', 'connections', 'subscribers', 'segments', 'media', 'broadcasts', 'drips',
  'ai', 'wallet', 'referrals', 'support', 'telegram-webhooks', 'payment-webhooks', 'voosquare', 'voo-connect', 'pages',
  'admin/index',
];

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.xml': 'application/xml',
};

function cspHeader() {
  const gv = config.gatevoo.url ? ' ' + config.gatevoo.url : '';
  // VooSquare's support widget (public website only) loads from VOO_BASE and talks to it.
  const vs = config.vooConnectOn() && config.voosquare.widget ? ' ' + originOf(config.voosquare.base) : '';
  return [
    "default-src 'self'",
    `script-src 'self' https://telegram.org${gv}${vs}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https://t.me https://telegram.org https://*.telegram.org https://lh3.googleusercontent.com",
    "media-src 'self' blob:",
    `frame-src https://oauth.telegram.org${gv}`,
    `connect-src 'self'${gv}${vs}`,
    "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'", "object-src 'none'",
  ].join('; ');
}

function originOf(u) { try { return new URL(u).origin; } catch { return ''; } }

function buildRouter() {
  const r = create();
  for (const f of ROUTE_FILES) require('./routes/' + f)(r);
  return r;
}

function makeCtx(req, res) {
  const u = new URL(req.url, 'http://x');
  // Use the LAST address in X-Forwarded-For: that is the one our proxy (Railway) added.
  // The first one is whatever the visitor typed, so trusting it would let anyone dodge the rate limits.
  const fwd = config.trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean).pop() || '' : '';
  const ctx = {
    req, res, method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams),
    ip: fwd || req.socket.remoteAddress || '', cookies: parseCookies(req.headers.cookie), params: {},
    body: {}, rawBody: Buffer.alloc(0), user: null, workspace: null, cookieOut: [],
    setCookie(name, value, o = {}) {
      let c = `${name}=${encodeURIComponent(value)}; Path=${o.path || '/'}`;
      if (o.maxAge !== undefined) c += `; Max-Age=${o.maxAge}`;
      if (o.httpOnly) c += '; HttpOnly';
      if (o.secure) c += '; Secure';
      c += `; SameSite=${o.sameSite || 'Lax'}`;
      this.cookieOut.push(c);
    },
    send(status, body, headers = {}) {
      if (this.cookieOut.length) headers['Set-Cookie'] = this.cookieOut;
      res.writeHead(status, headers); res.end(body);
      this.sent = true;
    },
    redirect(to, status = 302) { this.send(status, '', { Location: to, 'Cache-Control': 'no-store' }); },
    html(status, body) { this.send(status, body, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': cspHeader() }); },
  };
  return ctx;
}

/*
 * Asset version: a fingerprint of every file in public/. HTML pages get it in place of "?v=1" on
 * their css/js links, so browsers cache assets for a year but always fetch new ones after a deploy.
 */
const ASSET_VERSION = (() => {
  const h = require('node:crypto').createHash('sha1');
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else h.update(e.name).update(fs.readFileSync(p)); } };
  try { walk(PUBLIC_DIR); } catch { /* no public dir in some tests */ }
  return h.digest('hex').slice(0, 10);
})();
const htmlCache = new Map();

async function serveStatic(ctx) {
  let p = ctx.path;
  if (p === '/') p = '/index.html';
  if (p === '/admin' || p === '/admin/') p = '/admin/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return false;
  let st;
  try { st = await fs.promises.stat(file); } catch { return false; }
  if (!st.isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html') {
    let body = htmlCache.get(file);
    if (!body) { body = Buffer.from(fs.readFileSync(file, 'utf8').replace(/\?v=\d+"/g, `?v=${ASSET_VERSION}"`)); htmlCache.set(file, body); }
    const h = { 'Content-Type': MIME[ext], 'Content-Length': body.length, 'Cache-Control': 'no-cache', 'Content-Security-Policy': cspHeader() };
    if (ctx.cookieOut.length) h['Set-Cookie'] = ctx.cookieOut;
    ctx.res.writeHead(200, h);
    ctx.res.end(ctx.method === 'HEAD' ? undefined : body);
    return true;
  }
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size };
  if (ext === '.html') { headers['Cache-Control'] = 'no-cache'; headers['Content-Security-Policy'] = cspHeader(); }
  else headers['Cache-Control'] = ctx.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=300';
  if (ctx.cookieOut.length) headers['Set-Cookie'] = ctx.cookieOut;
  ctx.res.writeHead(200, headers);
  if (ctx.method === 'HEAD') { ctx.res.end(); return true; }
  fs.createReadStream(file).pipe(ctx.res);
  return true;
}

function createServer() {
  const router = buildRouter();
  const kit = config.vooConnectOn() ? voo.kit() : null;
  const attr = kit ? kit.captureAttribution() : null;

  async function handle(req, res) {
    const ctx = makeCtx(req, res);
    securityHeaders(res, config.appUrl.startsWith('https://'));
    try {
      const m = router.match(req.method, ctx.path);
      // Voo Connect: an affiliate click (?ref= &vclick= &coupon=) on any page is kept in the first-party cookie voo_attr.
      if (attr && (req.method === 'GET' || req.method === 'HEAD') && /[?&](ref|vclick|coupon)=/.test(req.url)) attr(req, voo.resShim(ctx));
      if (!m) {
        if ((req.method === 'GET' || req.method === 'HEAD') && (await serveStatic(ctx))) return;
        if (ctx.path.startsWith('/api/')) throw new HttpError(404, 'Not found.', 'not_found');
        // Unknown page: send the app shell (it shows a friendly 404 itself).
        return ctx.html(404, fs.readFileSync(path.join(PUBLIC_DIR, '404.html'), 'utf8'));
      }
      if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed.', 'method');
      const { route, params } = m;
      const o = route.opts;
      ctx.params = params;

      // Rate limits. Logged-in routes count per account (many people in Africa share one mobile IP,
      // so counting per IP would block innocent customers); public routes count per IP.
      const needsLogin = o.auth === 'user' || o.auth === 'workspace' || !!o.staff;
      const limit = (who) => {
        const key = `${route.method}:${route.pattern}:${who}`;
        if (!rl.hit(key, o.rate[0], o.rate[1])) throw new HttpError(429, 'Too many tries. Please wait a little and try again.', 'rate_limited', { retry_after: rl.retryAfter(key) });
      };
      if (o.rate && !needsLogin) limit(ctx.ip);

      // Body
      if (!['GET', 'HEAD'].includes(req.method) && !o.stream) {
        ctx.rawBody = await readBody(req, o.limit || 1024 * 1024);
        if (!o.raw && ctx.rawBody.length) {
          const type = String(req.headers['content-type'] || '');
          if (type.includes('application/json')) {
            try { ctx.body = JSON.parse(ctx.rawBody.toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON.', 'bad_json'); }
          } else if (type.includes('application/x-www-form-urlencoded')) {
            ctx.body = Object.fromEntries(new URLSearchParams(ctx.rawBody.toString('utf8')));
          }
          if (ctx.body === null || typeof ctx.body !== 'object') ctx.body = {};
        }
      }

      // Login routes: a hidden form on another site must not be able to log the visitor into the
      // attacker's account ("login CSRF"). Our own pages always send x-cv; a cross-site form cannot.
      if (o.csrf && req.headers['x-cv'] !== '1') throw new HttpError(403, 'Request blocked. Please refresh the page and try again.', 'csrf');

      // Who is asking
      const needUser = o.auth === 'user' || o.auth === 'workspace' || o.staff;
      if (needUser || o.auth === 'optional') {
        const s = await auth.loadSession(ctx);
        if (s) ctx.user = s.user;
        if (needUser && !ctx.user) throw new HttpError(401, 'Please log in first.', 'login_required');
        // CSRF: browsers can't add this header cross-site without our permission.
        if (ctx.user && !['GET', 'HEAD'].includes(req.method) && req.headers['x-cv'] !== '1') throw new HttpError(403, 'Request blocked. Please refresh the page and try again.', 'csrf');
      }
      if (o.staff) {
        if (!perms.can(ctx.user.staff_role, o.staff)) throw new HttpError(403, 'Your team role does not allow this.', 'forbidden');
      }
      if (o.auth === 'workspace') {
        ctx.workspace = await auth.currentWorkspace(ctx.user, req.headers['x-ws'] || ctx.query.ws);
        if (!ctx.workspace) throw new HttpError(403, 'You are not part of a workspace yet.', 'no_workspace');
        ctx.member = { role: ctx.workspace.member_role };
      }

      if (o.rate && needsLogin) limit('u' + ctx.user.id);

      const out = await route.handler(ctx);
      if (ctx.sent || res.headersSent) return;
      if (ctx.cookieOut.length) res.setHeader('Set-Cookie', ctx.cookieOut);
      sendJson(res, 200, out === undefined ? { ok: true } : out);
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      if (ctx.cookieOut.length) res.setHeader('Set-Cookie', ctx.cookieOut);
      if (err instanceof HttpError) {
        if (err.extra && err.extra.retry_after) res.setHeader('Retry-After', err.extra.retry_after);
        if (!ctx.path.startsWith('/api/') && req.method === 'GET' && err.status !== 401) {
          return ctx.html(err.status, `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Castvoo</title><body style="font-family:system-ui;padding:40px;text-align:center;color:#0B1430"><h2>${err.message}</h2><p><a href="/" style="color:#2F6BFF">Back to Castvoo</a></p>`);
        }
        return sendJson(res, err.status, { error: err.message, code: err.code, ...(err.extra || {}) });
      }
      // A number or id the database cannot read ("abc", 1e20 for a bigint): the request was bad, not the server.
      if (err && (err.code === '22P02' || err.code === '22003')) {
        return sendJson(res, 400, { error: 'One of the values sent is not valid. Check it and try again.', code: 'bad_value' });
      }
      log.error('unhandled error', { path: ctx.path, method: req.method, err });
      sendJson(res, 500, { error: 'Something went wrong on our side. Please try again.', code: 'server_error' });
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = 180000;
  return server;
}

module.exports = { createServer, buildRouter };

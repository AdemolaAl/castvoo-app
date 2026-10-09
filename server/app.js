'use strict';
/*
 * The web server: turns every HTTP request into a call to one route handler.
 * Routes live in server/routes/*.js. Each file exports function (r) { r.get(...); ... }.
 * To add a new group of routes, create a file there and add it to ROUTE_FILES below.
 */

const http = require('node:http');
const { pipeline } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const log = require('./lib/log');
const { create, readBody, parseCookies, securityHeaders, sendJson } = require('./lib/router');
const { HttpError, escHtml } = require('./lib/util');
const rl = require('./lib/ratelimit');
const auth = require('./services/auth');
const perms = require('./permissions');
const activity = require('./services/activity');
const voo = require('./lib/voo');

const ROUTE_FILES = [
  'public', 'auth', 'workspace', 'connections', 'subscribers', 'segments', 'media', 'broadcasts', 'drips', 'flows',
  'ai', 'wallet', 'referrals', 'support', 'telegram-webhooks', 'payment-webhooks', 'voosquare', 'voo-connect', 'blog', 'pages',
  'admin/index',
];

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.xml': 'application/xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.vtt': 'text/vtt; charset=utf-8',
};
// Big media (the training videos): fingerprinted by name and size only, and served in pieces (Range) so players can seek.
const MEDIA_EXT = new Set(['.mp4', '.webm']);

function cspHeader() {
  const gv = config.gatevoo.url ? ' ' + config.gatevoo.url : '';
  // VooSquare's support widget (public website only) loads from VOO_BASE and talks to it.
  const vs = config.vooConnectOn() && config.voosquare.widget ? ' ' + originOf(config.voosquare.base) : '';
  return [
    "default-src 'self'",
    `script-src 'self' https://telegram.org${gv}${vs}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https://t.me https://telegram.org https://*.telegram.org",
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
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (MEDIA_EXT.has(path.extname(e.name).toLowerCase())) h.update(e.name + ':' + fs.statSync(p).size); else h.update(e.name).update(fs.readFileSync(p)); } };
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
    require('./lib/visitor').ensure(ctx); // website chat: proves a real page load (lib/visitor.js)
    const h = { 'Content-Type': MIME[ext], 'Content-Length': body.length, 'Cache-Control': 'no-cache', 'Content-Security-Policy': cspHeader() };
    if (ctx.cookieOut.length) h['Set-Cookie'] = ctx.cookieOut;
    ctx.res.writeHead(200, h);
    ctx.res.end(ctx.method === 'HEAD' ? undefined : body);
    return true;
  }
  // Never compressed (no Content-Encoding): Content-Length and the Range byte offsets are those of the file itself.
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Last-Modified': st.mtime.toUTCString(), ETag: etag };
  if (ctx.query.v) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  else headers['Cache-Control'] = MEDIA_EXT.has(ext) ? 'public, max-age=86400' : 'public, max-age=300';
  if (ctx.cookieOut.length) headers['Set-Cookie'] = ctx.cookieOut;
  // Range requests ("bytes=0-1023", "bytes=500-", "bytes=-500"): one range, as video players ask for. 206 or 416.
  // iPhones first ask for "bytes=0-1" and only play when that comes back as a 206 with the file's full size.
  // If-Range (a player resuming a download): a range only while the file is unchanged, else the whole new file.
  const ifRange = ctx.req.headers['if-range'];
  const sameFile = !ifRange || ifRange === etag || ifRange === headers['Last-Modified'];
  const range = sameFile ? parseRange(ctx.req.headers.range, st.size) : null;
  if (range === 'bad') {
    ctx.res.writeHead(416, { 'Content-Range': `bytes */${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Type': 'text/plain; charset=utf-8' });
    ctx.res.end();
    return true;
  }
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${st.size}`;
    headers['Content-Length'] = range.end - range.start + 1;
    ctx.res.writeHead(206, headers);
    if (ctx.method === 'HEAD') { ctx.res.end(); return true; }
    sendFile(file, ctx.res, { start: range.start, end: range.end });
    return true;
  }
  ctx.res.writeHead(200, headers);
  if (ctx.method === 'HEAD') { ctx.res.end(); return true; }
  sendFile(file, ctx.res);
  return true;
}

/**
 * ENG-1: stream a file to the response. pipeline() closes the file when the visitor aborts (video players abort Range
 * requests all the time) and handles a read error (file replaced during a deploy) instead of crashing the process.
 */
function sendFile(file, res, range) {
  pipeline(fs.createReadStream(file, range), res, (err) => {
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE' && !res.headersSent) { try { res.writeHead(500); res.end(); } catch { /* gone */ } }
    else if (err && !res.destroyed) res.destroy();
  });
}

/** "bytes=a-b" -> { start, end } (inclusive), null when there is no usable Range header, 'bad' when it can't be served. */
function parseRange(h, size) {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(h).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null; // several ranges or junk: send the whole file
  let start, end;
  if (m[1] === '') { const n = Number(m[2]); if (!n) return 'bad'; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return 'bad';
  return { start, end };
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
      // shared: true keeps the counter in PostgreSQL, so it holds across instances (routes that cost money or AI).
      const limit = async (who) => {
        const key = `${route.method}:${route.pattern}:${who}`;
        if (o.shared) {
          const r = await rl.hitShared(key, o.rate[0], o.rate[1]);
          if (!r.ok) throw new HttpError(429, 'Too many tries. Please wait a little and try again.', 'rate_limited', { retry_after: r.retryAfter });
          return;
        }
        if (!rl.hit(key, o.rate[0], o.rate[1])) throw new HttpError(429, 'Too many tries. Please wait a little and try again.', 'rate_limited', { retry_after: rl.retryAfter(key) });
      };
      if (o.rate && !needsLogin) await limit(ctx.ip);
      // Server-to-server routes (VooSquare): the router checks the service key itself (SEC-14).
      if (o.auth === 'service') require('./lib/service-key').requireKey(ctx, { inboundOnly: !!o.inboundOnly });

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
        if (s) { ctx.user = s.user; ctx.session = s; }
        if (needUser && !ctx.user) throw new HttpError(401, 'Please log in first.', 'login_required');
        // CSRF: browsers can't add this header cross-site without our permission.
        if (ctx.user && !['GET', 'HEAD'].includes(req.method) && req.headers['x-cv'] !== '1') throw new HttpError(403, 'Request blocked. Please refresh the page and try again.', 'csrf');
      }
      if (o.staff) {
        if (!perms.can(ctx.user.staff_role, o.staff)) throw new HttpError(403, 'Your team role does not allow this.', 'forbidden');
      }
      if (o.auth === 'workspace') {
        const wanted = req.headers['x-ws'] || ctx.query.ws;
        ctx.workspace = await auth.currentWorkspace(ctx.user, wanted);
        if (!ctx.workspace) throw new HttpError(403, 'You are not part of a workspace yet.', 'no_workspace');
        // A setup helper the owner just removed: their open tabs still ask for that workspace. Say so plainly
        // (instead of quietly showing their own workspace), so the dashboard can switch them back.
        if (wanted && String(ctx.workspace.id) !== String(Number(wanted)) && (await activity.wasRemoved(Number(wanted), ctx.user.id))) {
          throw new HttpError(403, 'The owner removed your access to this workspace.', 'access_removed');
        }
        ctx.member = { role: ctx.workspace.member_role };
        // The workspace role map (server/permissions.js WS_ROUTES) decides who may use this route, for every role.
        // A route missing from the map is for the owner only (npm run check fails on it).
        if (!perms.wsRouteAllowed(route.method, route.pattern, ctx.member.role, ctx.workspace)) {
          if (ctx.member.role === 'helper') throw new HttpError(403, 'Only the workspace owner can do this. You are the setup helper here.', 'owner_only');
          throw new HttpError(403, 'Only the workspace owner can do that.', 'forbidden');
        }
        if (ctx.member.role === 'helper') activity.seen(ctx.workspace.id, ctx.user.id);
      }

      if (o.rate && needsLogin) await limit('u' + ctx.user.id);

      // The setup helper's changes are written to the owner's Activity list.
      const track = ctx.member && ctx.member.role === 'helper' && route.method !== 'GET' ? `${route.method} ${route.pattern}` : null;
      const trackName = track ? await activity.before(ctx, track) : null;
      const out = await route.handler(ctx);
      if (track) await activity.after(ctx, track, trackName, out);
      if (ctx.sent || res.headersSent) return;
      if (ctx.cookieOut.length) res.setHeader('Set-Cookie', ctx.cookieOut);
      sendJson(res, 200, out === undefined ? { ok: true } : out);
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      if (ctx.cookieOut.length) res.setHeader('Set-Cookie', ctx.cookieOut);
      if (err instanceof HttpError) {
        if (err.extra && err.extra.retry_after) res.setHeader('Retry-After', err.extra.retry_after);
        if (!ctx.path.startsWith('/api/') && req.method === 'GET' && err.status !== 401) {
          return ctx.html(err.status, `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover"><title>Castvoo</title><body style="font-family:system-ui;padding:40px;text-align:center;color:#0B1430"><h2>${escHtml(err.message)}</h2><p><a href="/" style="color:#2F6BFF">Back to Castvoo</a></p>`);
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

module.exports = { createServer, buildRouter, parseRange, sendFile, cspHeader };

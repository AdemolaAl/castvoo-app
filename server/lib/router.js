'use strict';
/*
 * A tiny web router (no Express needed).
 *
 *   const r = require('./lib/router').create();
 *   r.get('/api/plans', async (ctx) => ({ plans: [...] }));            // returned object is sent as JSON
 *   r.post('/api/broadcasts', handler, { auth: 'workspace' });           // must be logged in with a workspace
 *   r.post('/api/admin/plans/:id', handler, { staff: 'pricing.edit' });  // staff with that permission
 *
 * Route options:
 *   auth:  'public' (default) | 'user' | 'workspace'
 *   staff: a permission name from server/permissions.js (implies a logged-in staff user)
 *   raw:   true  -> don't parse the body (webhooks read ctx.rawBody, uploads read ctx.req)
 *   limit: max body bytes (default 1 MB)
 *   rate:  [max, perSeconds] requests per IP for this route (e.g. [10, 60])
 *   csrf:  true -> require the `x-cv: 1` header even when nobody is logged in (login routes)
 *
 * ctx has: req, res, method, path, params, query, body, rawBody, ip, user, session,
 *          workspace, member, setCookie(name, value, opts), redirect(url), send(status, body, headers)
 */

const { HttpError } = require('./util');
const log = require('./log');

class Router {
  constructor() { this.routes = []; this.before = []; }
  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }).replace(/\*$/, '(.*)') + '/?$');
    this.routes.push({ method, pattern, re, keys, handler, opts });
  }
  get(p, h, o) { this.add('GET', p, h, o); }
  post(p, h, o) { this.add('POST', p, h, o); }
  put(p, h, o) { this.add('PUT', p, h, o); }
  patch(p, h, o) { this.add('PATCH', p, h, o); }
  delete(p, h, o) { this.add('DELETE', p, h, o); }
  match(method, path) {
    let allowed = false;
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      allowed = true;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const params = {};
      // A broken escape like "%E0%A4" makes decodeURIComponent throw; answer 400 instead of crashing with a 500.
      try { r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); } catch { throw new HttpError(400, 'That address is not valid.', 'bad_url'); }
      return { route: r, params };
    }
    return allowed ? { methodNotAllowed: true } : null;
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'That request is too large.', 'too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

function securityHeaders(res, isHttps) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (isHttps) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

module.exports = { create: () => new Router(), readBody, parseCookies, securityHeaders, sendJson, log };

'use strict';
/*
 * "Sign in with Google" (OpenID Connect). VooSquare login uses the Voo Connect kit instead (routes/voo-connect.js).
 * Flow: start() → redirect to provider → provider redirects to our callback → finish().
 * We use PKCE + a one-time state stored in the database, then ask the provider's
 * userinfo endpoint who the person is.
 */

const crypto = require('node:crypto');
const db = require('../db');
const config = require('../config');
const { randomToken, httpError } = require('./util');

const discoveryCache = new Map();

function providerConfig(name) {
  if (name === 'google') return { issuer: config.google.issuer, clientId: config.google.clientId, clientSecret: config.google.clientSecret, scope: 'openid email profile' };
  throw httpError(404, 'Unknown login provider.');
}

async function discover(issuer) {
  const hit = discoveryCache.get(issuer);
  if (hit && Date.now() - hit.at < 3600000) return hit.doc;
  const r = await fetch(issuer + '/.well-known/openid-configuration', { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw httpError(502, 'Could not reach the login provider. Please try again.', 'oidc_discovery');
  const doc = await r.json();
  discoveryCache.set(issuer, { doc, at: Date.now() });
  return doc;
}

const redirectUri = (name) => `${config.appUrl}/api/auth/${name}/callback`;

async function start(name, data = {}) {
  const p = providerConfig(name);
  if (!p.clientId) throw httpError(503, 'This login method is not set up yet.', 'not_configured');
  const doc = await discover(p.issuer);
  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  await db.query("insert into oauth_states(state, provider, verifier, data, expires_at) values ($1,$2,$3,$4, now() + interval '15 minutes')",
    [state, name, verifier, JSON.stringify(data)]);
  const u = new URL(doc.authorization_endpoint);
  const q = { response_type: 'code', client_id: p.clientId, redirect_uri: redirectUri(name), state, code_challenge: challenge, code_challenge_method: 'S256' };
  if (p.scope) q.scope = p.scope;
  if (name === 'google') q.prompt = 'select_account';
  u.search = new URLSearchParams(q).toString();
  return u.toString();
}

async function finish(name, query) {
  if (query.error) throw httpError(400, 'Login was cancelled.', 'oidc_cancelled');
  const row = await db.one('delete from oauth_states where state = $1 and provider = $2 and expires_at > now() returning *', [String(query.state || ''), name]);
  if (!row) throw httpError(400, 'This login link expired. Please try again.', 'oidc_state');
  const p = providerConfig(name);
  const doc = await discover(p.issuer);
  const tr = await fetch(doc.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: String(query.code || ''), redirect_uri: redirectUri(name), client_id: p.clientId, client_secret: p.clientSecret, code_verifier: row.verifier }),
    signal: AbortSignal.timeout(15000),
  });
  const tok = await tr.json().catch(() => ({}));
  if (!tr.ok || !tok.access_token) throw httpError(400, 'The login provider did not accept the sign-in. Please try again.', 'oidc_token');
  // VooSquare returns the person in the token reply (`user`); Google needs the userinfo call.
  let info = tok.user && typeof tok.user === 'object' ? tok.user : null;
  if (!info) {
    const ur = await fetch(doc.userinfo_endpoint, { headers: { Authorization: 'Bearer ' + tok.access_token }, signal: AbortSignal.timeout(10000) });
    info = await ur.json().catch(() => ({}));
    if (!ur.ok) info = {};
    if (info && info.user && typeof info.user === 'object') info = info.user;
  }
  const sub = info.sub || info.voo_id || info.id;
  if (!sub) throw httpError(400, 'Could not read your account from the login provider.', 'oidc_userinfo');
  // An email is only used (to join an existing account, or to match OWNER_EMAIL) when the provider
  // says it is verified. Google must say so explicitly; VooSquare verifies every email at sign-up,
  // so its emails count unless it says "false".
  const verified = name === 'google' ? (info.email_verified === true || info.email_verified === 'true') : info.email_verified !== false && info.email_verified !== 'false';
  return {
    sub: String(sub),
    country: info.country ? String(info.country).toUpperCase().slice(0, 2) : null,
    email: info.email && verified ? String(info.email).toLowerCase() : null,
    name: info.name || info.given_name || '',
    data: row.data || {},
  };
}

module.exports = { start, finish, redirectUri };

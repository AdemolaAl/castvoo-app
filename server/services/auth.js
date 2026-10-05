'use strict';
/*
 * Accounts, sessions and workspaces.
 * A session is a random token in the HttpOnly cookie `cv_session`; the database
 * only stores its SHA-256 hash, so a database leak can't be used to log in.
 */

const db = require('../db');
const config = require('../config');
const settings = require('./settings');
const email = require('./email');
const { randomToken, randomCode, sha256, addDays, fmtDate, httpError } = require('../lib/util');

const COOKIE = 'cv_session';
const SESSION_DAYS = 30;

function cookieOpts(maxAgeSec) {
  return { httpOnly: true, sameSite: 'Lax', secure: config.appUrl.startsWith('https://'), path: '/', maxAge: maxAgeSec };
}

async function createSession(ctx, user) {
  const token = randomToken(32);
  await db.query('insert into sessions(token_hash, user_id, ip, user_agent, expires_at) values ($1,$2,$3,$4,$5)',
    [sha256(token), user.id, ctx.ip, String(ctx.req.headers['user-agent'] || '').slice(0, 300), addDays(new Date(), SESSION_DAYS)]);
  await db.query('update users set last_login_at = now() where id = $1', [user.id]);
  ctx.setCookie(COOKIE, token, cookieOpts(SESSION_DAYS * 86400));
}

async function loadSession(ctx) {
  const token = ctx.cookies[COOKIE];
  if (!token || token.length > 100) return null;
  const row = await db.one(`select s.token_hash, s.expires_at, u.* from sessions s join users u on u.id = s.user_id
    where s.token_hash = $1 and s.expires_at > now()`, [sha256(token)]);
  if (!row || row.status !== 'active') return null;
  // Slide the expiry forward when less than half is left.
  if (new Date(row.expires_at).getTime() - Date.now() < (SESSION_DAYS / 2) * 86400000) {
    await db.query('update sessions set expires_at = $2 where token_hash = $1', [row.token_hash, addDays(new Date(), SESSION_DAYS)]);
  }
  const { token_hash, expires_at, ...user } = row;
  return { user, tokenHash: token_hash };
}

async function destroySession(ctx) {
  const token = ctx.cookies[COOKIE];
  if (token) await db.query('delete from sessions where token_hash = $1', [sha256(token)]);
  ctx.setCookie(COOKIE, '', cookieOpts(0));
}

async function uniqueRefCode(base) {
  const clean = String(base || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  for (let i = 0; i < 6; i++) {
    const code = clean.length >= 3 && i === 0 ? clean : (clean.slice(0, 8) || 'cv') + randomCode(4);
    if (!(await db.one('select 1 from users where ref_code = $1', [code]))) return code;
  }
  return randomCode(10);
}

/**
 * Find the user for a login identity, or create them (with a workspace and trial).
 * identity: { email } | { tg_user_id, tg_username } | { google_sub, email } | { voo_id, email }
 * extra:    { name, country, ref, linkTo (logged-in user to link this identity to) }
 * Returns { user, created }.
 */
async function loginWith(identity, extra = {}) {
  const field = identity.tg_user_id ? 'tg_user_id' : identity.google_sub ? 'google_sub' : identity.voo_id ? 'voo_id' : 'email';
  const value = identity[field];

  if (extra.linkTo) {
    const other = await db.one(`select id from users where ${field} = $1 and id <> $2 and status <> 'deleted'`, [value, extra.linkTo.id]);
    if (other) throw httpError(409, 'That account is already linked to another Castvoo login.', 'already_linked');
    await db.query(`update users set ${field} = $2${identity.tg_username !== undefined ? ', tg_username = $3' : ''} where id = $1`,
      identity.tg_username !== undefined ? [extra.linkTo.id, value, identity.tg_username] : [extra.linkTo.id, value]);
    return { user: await db.one('select * from users where id = $1', [extra.linkTo.id]), created: false };
  }

  let user = await db.one(`select * from users where ${field} = $1`, [value]);
  // Google/VooSquare logins with a verified email join an existing email account.
  if (!user && identity.email && field !== 'email') {
    user = await db.one('select * from users where email = $1', [identity.email]);
    if (user) await db.query(`update users set ${field} = $2, email_verified = true where id = $1`, [user.id, value]);
  }
  if (user) {
    if (user.status === 'suspended') throw httpError(403, 'This account is suspended. Contact support@castvoo.com.', 'suspended');
    if (user.status === 'deleted') throw httpError(403, 'This account was deleted.', 'deleted');
    if (identity.tg_username !== undefined && identity.tg_user_id) await db.query('update users set tg_username = $2 where id = $1', [user.id, identity.tg_username]);
    // Logging in with an emailed code proves the email (team members added by an admin started unverified).
    if (field === 'email' && !user.email_verified) { await db.query('update users set email_verified = true where id = $1', [user.id]); user.email_verified = true; }
    if (user.email && config.ownerEmail && user.email === config.ownerEmail && user.staff_role !== 'owner') {
      await db.query("update users set staff_role = 'owner' where id = $1", [user.id]);
      user.staff_role = 'owner';
    }
    return { user, created: false };
  }

  if (!(await settings.feature('signups'))) throw httpError(403, 'New sign-ups are paused right now. Please try again later.', 'signups_off');
  if ((await settings.features()).maintenance) throw httpError(503, 'Castvoo is under maintenance. Please try again in a few minutes.', 'maintenance');

  const name = String(extra.name || identity.name || (identity.email ? identity.email.split('@')[0] : '') || 'Friend').slice(0, 80);
  let referredBy = null;
  if (extra.ref) {
    const r = await db.one("select id from users where ref_code = $1 and status = 'active'", [String(extra.ref).toLowerCase().slice(0, 40)]);
    if (r) referredBy = r.id;
  }
  const country = extra.country && (await db.one('select code from countries where code = $1 and active', [extra.country])) ? extra.country : null;
  const isOwner = !!(identity.email && config.ownerEmail && identity.email === config.ownerEmail);

  user = await db.tx(async (c) => {
    const u = (await c.query(`insert into users(email, email_verified, name, tg_user_id, tg_username, google_sub, voo_id, country, staff_role, ref_code, referred_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [identity.email || null, !!identity.email, name, identity.tg_user_id || null, identity.tg_username || null, identity.google_sub || null, identity.voo_id || null,
      country, isOwner ? 'owner' : null, await uniqueRefCode(name), referredBy])).rows[0];
    await createWorkspace(c, u);
    return u;
  });

  const ws = await db.one('select * from workspaces where owner_user_id = $1 order by id limit 1', [user.id]);
  await email.send('welcome', user, { trial_end_date: fmtDate(ws.trial_ends_at), guide_url: config.appUrl + '/#guide' });
  return { user, created: true };
}

/**
 * "Continue with Voo ID" (VooSquare login through the Voo Connect kit). `vu` is the kit's verified user:
 * { voo_id, email, email_verified, name, country, voo_ref }.
 *   1. Somebody is already logged in to Castvoo ("Connect your VooSquare account"): link the Voo ID to THAT account.
 *   2. A Castvoo account already has this voo_id: log it in.
 *   3. Owner's rule: an existing Castvoo account whose email is verified on BOTH sides (VooSquare says
 *      email_verified, and Castvoo verified it with a code or a provider) and that has no Voo ID yet is linked.
 *      An unverified email is never used to join accounts.
 *   4. Otherwise create a new account (free trial, workspace), with country and VooSquare's referral code.
 * Returns { user, created, linked }.
 */
async function loginWithVoo(vu, { current = null, ref = null } = {}) {
  const vooId = String(vu.voo_id || '').slice(0, 120);
  if (!vooId) throw httpError(400, 'VooSquare did not send your account.', 'voo_no_id');
  const vooRef = vu.voo_ref ? String(vu.voo_ref).slice(0, 40) : null;
  const mail = vu.email && vu.email_verified ? String(vu.email).trim().toLowerCase().slice(0, 254) : null;
  const usable = (u) => {
    if (u.status === 'suspended') throw httpError(403, 'This account is suspended. Contact support@castvoo.com.', 'suspended');
    if (u.status === 'deleted') throw httpError(403, 'This account was deleted.', 'deleted');
  };
  const promoteOwner = async (u) => {
    if (u.email && config.ownerEmail && u.email === config.ownerEmail && u.staff_role !== 'owner') {
      await db.query("update users set staff_role = 'owner' where id = $1", [u.id]);
      u.staff_role = 'owner';
    }
    return u;
  };
  const link = async (u) => {
    // "where voo_id is null" makes two logins at the same moment safe; the unique index refuses a second account.
    try {
      await db.query('update users set voo_id = $2, voo_ref = coalesce(voo_ref, $3), voo_linked_at = now() where id = $1 and (voo_id is null or voo_id = $2)', [u.id, vooId, vooRef]);
    } catch (e) {
      if (e.code === '23505') throw httpError(409, 'That VooSquare account is already linked to another Castvoo login.', 'already_linked');
      throw e;
    }
    return db.one('select * from users where id = $1', [u.id]);
  };

  const byVoo = await db.one('select * from users where voo_id = $1', [vooId]);
  if (current) {
    if (byVoo && String(byVoo.id) !== String(current.id)) throw httpError(409, 'That VooSquare account is already linked to another Castvoo login.', 'already_linked');
    if (current.voo_id && current.voo_id !== vooId) throw httpError(409, 'Your Castvoo account is already linked to a different VooSquare account.', 'already_linked');
    return { user: await link(current), created: false, linked: !byVoo };
  }
  if (byVoo) { usable(byVoo); return { user: await promoteOwner(byVoo), created: false, linked: false }; }

  let mailFree = !!mail;
  if (mail) {
    const byMail = await db.one('select * from users where email = $1', [mail]);
    if (byMail) {
      mailFree = false;
      if (byMail.email_verified && !byMail.voo_id && byMail.status === 'active') {
        const u = await link(byMail);
        return { user: await promoteOwner(u), created: false, linked: true };
      }
      if (byMail.status !== 'active') usable(byMail);
      // Verified elsewhere but not here, or already linked to another Voo ID: a new account without that email.
    }
  }
  const { user, created } = await loginWith({ voo_id: vooId, ...(mailFree ? { email: mail } : {}) }, { name: vu.name || '', country: vu.country ? String(vu.country).toUpperCase().slice(0, 2) : null, ref });
  if (created) await db.query('update users set voo_ref = $2, voo_linked_at = now() where id = $1', [user.id, vooRef]);
  return { user: await db.one('select * from users where id = $1', [user.id]), created, linked: false };
}

async function createWorkspace(c, user) {
  const trial = await settings.get('trial');
  const tz = user.country ? (TZ_BY_COUNTRY[user.country] || 'UTC') : 'Africa/Lagos';
  const first = (user.name || 'My').split(/\s+/)[0];
  const ws = (await c.query(`insert into workspaces(name, owner_user_id, plan_code, plan_status, trial_ends_at, timezone)
    values ($1,$2,$3,'trial',$4,$5) returning *`, [`${first}'s workspace`, user.id, trial.plan, addDays(new Date(), trial.days), tz])).rows[0];
  await c.query("insert into members(workspace_id, user_id, role) values ($1,$2,'owner')", [ws.id, user.id]);
  return ws;
}

const TZ_BY_COUNTRY = {
  NG: 'Africa/Lagos', GH: 'Africa/Accra', KE: 'Africa/Nairobi', ZA: 'Africa/Johannesburg', CM: 'Africa/Douala', UG: 'Africa/Kampala',
  TZ: 'Africa/Dar_es_Salaam', RW: 'Africa/Kigali', ZM: 'Africa/Lusaka', ET: 'Africa/Addis_Ababa', EG: 'Africa/Cairo', MA: 'Africa/Casablanca',
  CI: 'Africa/Abidjan', SN: 'Africa/Dakar', BJ: 'Africa/Porto-Novo', TG: 'Africa/Lome', SL: 'Africa/Freetown', LR: 'Africa/Monrovia',
  ZW: 'Africa/Harare', BW: 'Africa/Gaborone', US: 'America/New_York', GB: 'Europe/London', CA: 'America/Toronto', AE: 'Asia/Dubai',
  SA: 'Asia/Riyadh', IN: 'Asia/Kolkata', PK: 'Asia/Karachi', BD: 'Asia/Dhaka', ID: 'Asia/Jakarta', PH: 'Asia/Manila', MY: 'Asia/Kuala_Lumpur',
  VN: 'Asia/Ho_Chi_Minh', TR: 'Europe/Istanbul', BR: 'America/Sao_Paulo', MX: 'America/Mexico_City', CO: 'America/Bogota',
  AR: 'America/Argentina/Buenos_Aires', FR: 'Europe/Paris', DE: 'Europe/Berlin', ES: 'Europe/Madrid', IT: 'Europe/Rome',
  NL: 'Europe/Amsterdam', PT: 'Europe/Lisbon', UA: 'Europe/Kyiv', AU: 'Australia/Sydney',
};

/** Which workspace a request is about: the x-ws header if the user is a member, else their first one. */
async function currentWorkspace(user, wanted) {
  const rows = await db.many(`select w.*, m.role as member_role from workspaces w join members m on m.workspace_id = w.id
    where m.user_id = $1 order by (w.id = $2) desc, (m.role = 'owner') desc, w.id limit 1`, [user.id, Number(wanted) || 0]);
  return rows[0] || null;
}

module.exports = { COOKIE, createSession, loadSession, destroySession, loginWith, loginWithVoo, createWorkspace, currentWorkspace, TZ_BY_COUNTRY };

'use strict';
/* Logging in and out: email code, Telegram, Google, VooSquare. Plus "me" (the logged-in person). */

const crypto = require('node:crypto');
const db = require('../db');
const config = require('../config');
const auth = require('../services/auth');
const settings = require('../services/settings');
const email = require('../services/email');
const oidc = require('../lib/oidc');
const rl = require('../lib/ratelimit');
const perms = require('../permissions');
const { str, email: vEmail, randomDigits, sha256, safeEqual, httpError, badRequest, randomToken, addDays } = require('../lib/util');

const codeHash = (mail, code) => sha256(`${config.appSecret}:${mail}:${code}`);

async function sendCode(ctx, mail, purpose) {
  if (!rl.hit('code-mail:' + mail, 5, 3600)) throw httpError(429, 'Too many codes for this email. Please wait an hour or use another way to log in.', 'rate_limited');
  const code = randomDigits(6);
  await db.query("insert into login_codes(email, code_hash, expires_at) values ($1,$2, now() + interval '10 minutes')", [mail, codeHash(mail, code)]);
  const existing = await db.one('select * from users where email = $1', [mail]);
  await email.send('login_code', existing || { email: mail, name: '' }, { code });
  return { ok: true, purpose };
}

async function checkCode(mail, code) {
  const row = await db.one('select * from login_codes where email = $1 and used = false and expires_at > now() order by id desc limit 1', [mail]);
  if (!row) throw httpError(400, 'That code expired. Tap "Send a new code".', 'code_expired');
  // Count this try BEFORE checking the code, in one atomic step. If we counted after a wrong guess,
  // many guesses sent at the same moment would all read "0 tries" and get past the 5-try limit.
  const counted = await db.one('update login_codes set attempts = attempts + 1 where id = $1 and attempts < 5 and used = false returning id', [row.id]);
  if (!counted) throw httpError(400, 'Too many wrong tries. Tap "Send a new code".', 'code_locked');
  if (!safeEqual(row.code_hash, codeHash(mail, String(code || '').replace(/\D/g, '')))) {
    throw httpError(400, 'That code is not right. Check the email and try again.', 'code_wrong');
  }
  // Mark it used atomically too, so the same code can't log in twice at the same moment.
  const used = await db.one('update login_codes set used = true where id = $1 and used = false returning id', [row.id]);
  if (!used) throw httpError(400, 'That code expired. Tap "Send a new code".', 'code_expired');
}

/** Verify data from the Telegram Login Widget (https://core.telegram.org/widgets/login#checking-authorization). */
function verifyTelegram(d) {
  if (!config.telegram.botToken) throw httpError(503, 'Telegram login is not set up yet.', 'not_configured');
  const fields = ['id', 'first_name', 'last_name', 'username', 'photo_url', 'auth_date'];
  const check = fields.filter((k) => d[k] !== undefined && d[k] !== null && d[k] !== '').sort().map((k) => `${k}=${d[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(config.telegram.botToken).digest();
  const hash = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (!safeEqual(hash, String(d.hash || ''))) throw httpError(400, 'Telegram login could not be verified. Please try again.', 'tg_hash');
  if (Date.now() / 1000 - Number(d.auth_date) > 86400) throw httpError(400, 'Telegram login expired. Please try again.', 'tg_old');
  return { tg_user_id: Number(d.id), tg_username: d.username || null, name: [d.first_name, d.last_name].filter(Boolean).join(' ') };
}

async function meResponse(ctx) {
  if (!ctx.user) return { user: null };
  const u = ctx.user;
  const workspaces = await db.many(`select w.id, w.name, m.role from workspaces w join members m on m.workspace_id = w.id where m.user_id = $1 order by w.id`, [u.id]);
  return {
    user: {
      id: u.id, name: u.name, email: u.email, email_verified: u.email_verified, country: u.country, tg_linked: !!u.tg_user_id, tg_username: u.tg_username,
      google_linked: !!u.google_sub, ref_code: u.ref_code, staff_role: u.staff_role, marketing_opt_out: u.marketing_opt_out,
      perms: u.staff_role ? perms.permsFor(u.staff_role) : [],
    },
    workspaces,
  };
}

module.exports = (r) => {
  r.post('/api/auth/email/start', async (ctx) => {
    if (!(await settings.feature('login_email'))) throw httpError(403, 'Email login is switched off. Use Telegram or Google.', 'off');
    return sendCode(ctx, vEmail(ctx.body.email), 'login');
  }, { rate: [150, 600], csrf: true }); // per IP: mobile networks put many people behind one IP; the per-email limit stops spam

  r.post('/api/auth/email/verify', async (ctx) => {
    const mail = vEmail(ctx.body.email);
    await checkCode(mail, ctx.body.code);
    const { user, created } = await auth.loginWith({ email: mail }, { name: str(ctx.body.name, 'Name', { max: 80, required: false }) || '', country: ctx.body.country, ref: ctx.body.ref || ctx.cookies.cv_ref });
    await auth.createSession(ctx, user);
    return { ok: true, created };
  }, { rate: [300, 600], csrf: true });

  r.post('/api/auth/telegram', async (ctx) => {
    if (!(await settings.feature('login_telegram'))) throw httpError(403, 'Telegram login is switched off.', 'off');
    const t = verifyTelegram(ctx.body);
    const { user, created } = await auth.loginWith({ tg_user_id: t.tg_user_id, tg_username: t.tg_username }, { name: t.name, country: ctx.body.country, ref: ctx.body.ref || ctx.cookies.cv_ref });
    await auth.createSession(ctx, user);
    return { ok: true, created };
  }, { rate: [300, 600], csrf: true });

  for (const provider of ['google', 'voosquare']) {
    r.get(`/api/auth/${provider}/start`, async (ctx) => {
      const flag = provider === 'google' ? 'login_google' : 'login_voosquare';
      if (!(await settings.feature(flag))) throw httpError(403, 'This login method is switched off.', 'off');
      const url = await oidc.start(provider, { ref: ctx.query.ref || ctx.cookies.cv_ref || null, country: ctx.query.country || null, signup: ctx.query.signup === '1' });
      // Tie the login to THIS browser: the callback must come back with the same state in a cookie.
      // Otherwise a callback link made in an attacker's browser could log a victim into the attacker's account.
      ctx.setCookie('cv_oauth', new URL(url).searchParams.get('state'), { httpOnly: true, sameSite: 'Lax', secure: config.appUrl.startsWith('https://'), maxAge: 15 * 60, path: '/api/auth/' });
      ctx.redirect(url);
    }, { rate: [300, 600] });

    r.get(`/api/auth/${provider}/callback`, async (ctx) => {
      try {
        const mine = ctx.cookies.cv_oauth;
        ctx.setCookie('cv_oauth', '', { httpOnly: true, sameSite: 'Lax', maxAge: 0, path: '/api/auth/' });
        if (!mine || !safeEqual(mine, String(ctx.query.state || ''))) throw httpError(400, 'This login link expired. Please try again.', 'oidc_state');
        const info = await oidc.finish(provider, ctx.query);
        const identity = provider === 'google' ? { google_sub: info.sub, email: info.email } : { voo_id: info.sub, email: info.email };
        const { user, created } = await auth.loginWith(identity, { name: info.name, country: info.data.country || info.country, ref: info.data.ref });
        await auth.createSession(ctx, user);
        ctx.redirect(created ? '/#signup/country' : '/#app');
      } catch (e) {
        ctx.redirect('/#signup?error=' + encodeURIComponent(e.message || 'Login failed'));
      }
    });
  }

  /** Log out. People who signed in with VooSquare also get VooSquare's logout address, so one logout ends both. */
  r.post('/api/auth/logout', async (ctx) => {
    const vooUser = !!(ctx.user && ctx.user.voo_id && config.voosquare.base);
    await auth.destroySession(ctx);
    return { ok: true, voosquare_logout_url: vooUser ? `${config.voosquare.base}/oauth/logout?redirect_uri=${encodeURIComponent(config.appUrl + '/')}` : null };
  }, { auth: 'optional' });

  r.get('/api/me', async (ctx) => meResponse(ctx), { auth: 'optional' });

  r.post('/api/me', async (ctx) => {
    const name = ctx.body.name !== undefined ? str(ctx.body.name, 'Name', { min: 1, max: 80 }) : ctx.user.name;
    let country = ctx.user.country;
    if (ctx.body.country !== undefined) {
      const c = await db.one('select code from countries where code = $1 and active', [String(ctx.body.country)]);
      if (!c) throw badRequest('Pick a country from the list.');
      country = c.code;
    }
    const optOut = ctx.body.marketing_opt_out !== undefined ? !!ctx.body.marketing_opt_out : ctx.user.marketing_opt_out;
    await db.query('update users set name = $2, country = $3, marketing_opt_out = $4 where id = $1', [ctx.user.id, name, country, optOut]);
    if (ctx.body.country !== undefined) {
      const tz = auth.TZ_BY_COUNTRY[country];
      if (tz) await db.query("update workspaces set timezone = $2 where owner_user_id = $1 and created_at > now() - interval '1 day'", [ctx.user.id, tz]);
    }
    ctx.user = await db.one('select * from users where id = $1', [ctx.user.id]);
    return meResponse(ctx);
  }, { auth: 'user' });

  r.post('/api/me/email/start', async (ctx) => {
    const mail = vEmail(ctx.body.email);
    const other = await db.one('select id from users where email = $1 and id <> $2', [mail, ctx.user.id]);
    if (other) throw httpError(409, 'That email already belongs to another Castvoo account.', 'email_taken');
    return sendCode(ctx, mail, 'add_email');
  }, { auth: 'user', rate: [10, 600] });

  r.post('/api/me/email/verify', async (ctx) => {
    const mail = vEmail(ctx.body.email);
    await checkCode(mail, ctx.body.code);
    try {
      await db.query('update users set email = $2, email_verified = true where id = $1', [ctx.user.id, mail]);
    } catch (e) {
      // 23505 = another account took this email a moment ago (it was a 500 before).
      if (e.code === '23505') throw httpError(409, 'That email already belongs to another Castvoo account.', 'email_taken');
      throw e;
    }
    ctx.user = await db.one('select * from users where id = $1', [ctx.user.id]);
    if (config.ownerEmail && mail === config.ownerEmail) await db.query("update users set staff_role = 'owner' where id = $1", [ctx.user.id]);
    return meResponse(ctx);
  }, { auth: 'user', rate: [20, 600] });

  r.post('/api/me/telegram', async (ctx) => {
    const t = verifyTelegram(ctx.body);
    await auth.loginWith({ tg_user_id: t.tg_user_id, tg_username: t.tg_username }, { linkTo: ctx.user });
    ctx.user = await db.one('select * from users where id = $1', [ctx.user.id]);
    return meResponse(ctx);
  }, { auth: 'user' });

  /** Download everything we hold about you, as JSON. */
  r.get('/api/me/export', async (ctx) => {
    const u = ctx.user;
    const ws = await db.many('select w.* from workspaces w where w.owner_user_id = $1', [u.id]);
    const ids = ws.map((w) => w.id);
    const data = {
      exported_at: new Date().toISOString(),
      account: { id: u.id, name: u.name, email: u.email, country: u.country, telegram_username: u.tg_username, created_at: u.created_at, referral_code: u.ref_code },
      workspaces: ws.map(({ ai_profile, ...w }) => ({ ...w, ai_training: ai_profile })),
      connections: await db.many('select id, workspace_id, kind, username, title, member_count, status, created_at from connections where workspace_id = any($1)', [ids]),
      subscribers: await db.many('select s.connection_id, s.tg_user_id, s.first_name, s.username, s.lang, s.source, s.tags, s.status, s.joined_at from subscribers s join connections c on c.id = s.connection_id where c.workspace_id = any($1)', [ids]),
      broadcasts: await db.many('select id, title, body, buttons, status, total, sent, failed, created_at from broadcasts where workspace_id = any($1)', [ids]),
      sequences: await db.many('select q.*, (select json_agg(s order by s.position) from sequence_steps s where s.sequence_id = q.id) steps from sequences q where workspace_id = any($1)', [ids]),
      wallet: await db.many('select kind, amount_cents, method, note, created_at from wallet_tx where workspace_id = any($1) order by id', [ids]),
      payments: await db.many('select provider, reference, amount_cents, status, created_at from payments where user_id = $1', [u.id]),
      referrals: await db.many('select kind, amount_cents, rate, settles_at, created_at from referral_ledger where user_id = $1', [u.id]),
      support: await db.many('select t.subject, m.author_type, m.body, m.created_at from support_threads t join support_messages m on m.thread_id = t.id where t.user_id = $1 and not m.internal order by m.id', [u.id]),
    };
    ctx.send(200, JSON.stringify(data, null, 2), { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="castvoo-data.json"', 'Cache-Control': 'no-store' });
  }, { auth: 'user', rate: [5, 3600] });

  /** Delete the account. Payment records are kept (the law requires it) but unlinked from personal details. */
  r.post('/api/me/delete', async (ctx) => {
    if (String(ctx.body.confirm || '').trim().toUpperCase() !== 'DELETE') throw badRequest('Type DELETE to confirm.');
    if (ctx.user.staff_role === 'owner') {
      const owners = await db.one("select count(*)::int n from users where staff_role = 'owner' and status = 'active'");
      if (owners.n <= 1) throw badRequest('You are the only platform owner. Make someone else an owner in the admin panel first.');
    }
    const u = ctx.user;
    const conns = await db.many(`select c.* from connections c join workspaces w on w.id = c.workspace_id where w.owner_user_id = $1 and c.kind = 'bot' and c.status <> 'removed'`, [u.id]);
    for (const c of conns) await require('../services/connections').removeWebhook(c).catch(() => {});
    await email.send('account_deleted', u, {});
    const ownedIds = (await db.many('select id from workspaces where owner_user_id = $1', [u.id])).map((x) => x.id);
    await require('../services/media-files').removeFiles(ownedIds); // the uploaded files themselves, not just their rows
    await db.tx(async (c) => {
      const wsIds = (await c.query('select id from workspaces where owner_user_id = $1', [u.id])).rows.map((x) => x.id);
      await c.query("update connections set status = 'removed', token_enc = null where workspace_id = any($1)", [wsIds]);
      await c.query('delete from subscribers where connection_id in (select id from connections where workspace_id = any($1))', [wsIds]);
      await c.query('delete from deliveries where workspace_id = any($1)', [wsIds]);
      await c.query('delete from broadcasts where workspace_id = any($1)', [wsIds]);
      await c.query('delete from sequences where workspace_id = any($1)', [wsIds]);
      await c.query('delete from segments where workspace_id = any($1)', [wsIds]);
      await c.query('delete from media where workspace_id = any($1)', [wsIds]);
      await c.query("update workspaces set name = 'Deleted workspace', ai_profile = '{}', plan_status = 'cancelled' where id = any($1)", [wsIds]);
      await c.query('delete from support_threads where user_id = $1', [u.id]);
      await c.query('delete from members where user_id = $1', [u.id]);
      await c.query('delete from sessions where user_id = $1', [u.id]);
      await c.query(`update users set status = 'deleted', email = null, name = 'Deleted user', tg_user_id = null, tg_username = null, google_sub = null, voo_id = null, staff_role = null, marketing_opt_out = true where id = $1`, [u.id]);
    });
    ctx.setCookie(auth.COOKIE, '', { path: '/', maxAge: 0, httpOnly: true });
    return { ok: true };
  }, { auth: 'user', rate: [5, 3600] });
};

module.exports.verifyTelegram = verifyTelegram;

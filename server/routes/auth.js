'use strict';
/* Logging in and out: email code, Telegram, VooSquare. Plus "me" (the logged-in person). */

const crypto = require('node:crypto');
const db = require('../db');
const config = require('../config');
const auth = require('../services/auth');
const settings = require('../services/settings');
const email = require('../services/email');
const rl = require('../lib/ratelimit');
const perms = require('../permissions');
const security = require('../services/security');
const { audit } = require('../services/audit');
const avatars = require('../lib/avatar');
const { str, email: vEmail, randomDigits, sha256, safeEqual, httpError, badRequest, randomToken, addDays, cleanName, escHtml } = require('../lib/util');

const codeHash = (mail, code) => sha256(`${config.appSecret}:${mail}:${code}`);

async function sendCode(ctx, mail, purpose) {
  // Shared by every instance (SEC-17): with two servers an attacker no longer gets 2 × 5 codes an hour per email.
  const lim = await rl.hitShared('code-mail:' + mail, 5, 3600);
  if (!lim.ok) throw httpError(429, 'Too many codes for this email. Please wait an hour or use another way to log in.', 'rate_limited', { retry_after: lim.retryAfter });
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
      voo_linked: !!u.voo_id, ref_code: u.ref_code, staff_role: u.staff_role, marketing_opt_out: u.marketing_opt_out,
      login_alert_tg: u.login_alert_tg !== false,
      // Cartoon avatar + nickname (Settings → Profile → Your avatar). avatar_prompt: show the one-time "Make your avatar".
      nickname: u.nickname || null, avatar: u.avatar || null, avatar_prompt: !u.avatar && !u.avatar_prompted_at,
      perms: u.staff_role ? perms.permsFor(u.staff_role) : [],
    },
    workspaces,
  };
}

module.exports = (r) => {
  r.post('/api/auth/email/start', async (ctx) => {
    if (!(await settings.feature('login_email'))) throw httpError(403, 'Email login is switched off. Use Telegram or VooSquare.', 'off');
    return sendCode(ctx, vEmail(ctx.body.email), 'login');
  }, { rate: [150, 600], shared: true, csrf: true }); // per IP: mobile networks put many people behind one IP; the per-email limit stops spam

  r.post('/api/auth/email/verify', async (ctx) => {
    const mail = vEmail(ctx.body.email);
    await checkCode(mail, ctx.body.code);
    const { user, created } = await auth.loginWith({ email: mail }, { name: cleanName(str(ctx.body.name, 'Name', { max: 200, required: false }) || ''), country: ctx.body.country, ref: ctx.body.ref || ctx.cookies.cv_ref });
    await auth.createSession(ctx, user, { created });
    return { ok: true, created };
  }, { rate: [300, 600], shared: true, csrf: true });

  r.post('/api/auth/telegram', async (ctx) => {
    if (!(await settings.feature('login_telegram'))) throw httpError(403, 'Telegram login is switched off.', 'off');
    const t = verifyTelegram(ctx.body);
    const { user, created } = await auth.loginWith({ tg_user_id: t.tg_user_id, tg_username: t.tg_username }, { name: t.name, country: ctx.body.country, ref: ctx.body.ref || ctx.cookies.cv_ref });
    await auth.createSession(ctx, user, { created });
    return { ok: true, created };
  }, { rate: [300, 600], csrf: true });

  // VooSquare ("Continue with Voo ID") is in routes/voo-connect.js, through the Voo Connect kit.

  /** Log out. People who signed in with VooSquare also get VooSquare's logout address, so one logout ends both. */
  r.post('/api/auth/logout', async (ctx) => {
    const k = config.vooConnectOn() ? require('../lib/voo').kit() : null;
    const vooUser = !!(ctx.user && ctx.user.voo_id && k);
    await auth.destroySession(ctx);
    return { ok: true, voosquare_logout_url: vooUser ? k.logoutUrl(require('../lib/voo').homeUrl()) : null };
  }, { auth: 'optional' });

  r.get('/api/me', async (ctx) => meResponse(ctx), { auth: 'optional' });

  r.post('/api/me', async (ctx) => {
    // SEC-4: no newlines, control characters or odd spaces in names (they reach emails and the support AI's prompt).
    let name = ctx.user.name;
    if (ctx.body.name !== undefined) {
      name = cleanName(str(ctx.body.name, 'Name', { min: 1, max: 200 }), 200);
      if (!name) throw badRequest('Name is required.');
      if (name.length > 80) throw badRequest('Name must be 80 characters or fewer.');
    }
    let country = ctx.user.country;
    if (ctx.body.country !== undefined) {
      const c = await db.one('select code from countries where code = $1 and active', [String(ctx.body.country)]);
      if (!c) throw badRequest('Pick a country from the list.');
      country = c.code;
    }
    const optOut = ctx.body.marketing_opt_out !== undefined ? !!ctx.body.marketing_opt_out : ctx.user.marketing_opt_out;
    // New-login alerts by Telegram can be switched off; the email alert always goes.
    const tgAlerts = ctx.body.login_alert_tg !== undefined ? !!ctx.body.login_alert_tg : ctx.user.login_alert_tg !== false;
    await db.query('update users set name = $2, country = $3, marketing_opt_out = $4, login_alert_tg = $5 where id = $1', [ctx.user.id, name, country, optOut, tgAlerts]);
    // Nickname and cartoon avatar: only known options are stored (lib/avatar.js), anything else is refused.
    if (ctx.body.nickname !== undefined) await db.query('update users set nickname = $2 where id = $1', [ctx.user.id, avatars.nickname(ctx.body.nickname)]);
    if (ctx.body.avatar !== undefined) {
      const av = ctx.body.avatar === null ? null : avatars.check(ctx.body.avatar);
      await db.query('update users set avatar = $2, avatar_prompted_at = coalesce(avatar_prompted_at, now()) where id = $1', [ctx.user.id, av ? JSON.stringify(av) : null]);
    }
    if (ctx.body.avatar_prompt_done === true) await db.query('update users set avatar_prompted_at = coalesce(avatar_prompted_at, now()) where id = $1', [ctx.user.id]);
    if (ctx.body.login_alert_tg !== undefined && tgAlerts !== (ctx.user.login_alert_tg !== false)) await audit(ctx, tgAlerts ? 'security.tg_alerts_on' : 'security.tg_alerts_off', 'user:' + ctx.user.id);
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
  }, { auth: 'user', rate: [10, 600], shared: true });

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
  }, { auth: 'user', rate: [20, 600], shared: true });

  r.post('/api/me/telegram', async (ctx) => {
    const t = verifyTelegram(ctx.body);
    await auth.loginWith({ tg_user_id: t.tg_user_id, tg_username: t.tg_username }, { linkTo: ctx.user });
    ctx.user = await db.one('select * from users where id = $1', [ctx.user.id]);
    return meResponse(ctx);
  }, { auth: 'user' });

  /* ---------- Settings → Security: Active devices ---------- */
  r.get('/api/me/sessions', async (ctx) => ({ sessions: await security.list(ctx.user.id, ctx.session && ctx.session.tokenHash) }), { auth: 'user' });

  /** Log out one device. Its next request answers 401 (the session row is gone). */
  r.post('/api/me/sessions/:id/revoke', async (ctx) => {
    const id = String(ctx.params.id || '');
    if (!/^\d{1,18}$/.test(id)) throw badRequest('That device was not found.');
    const r2 = await security.revoke(ctx.user.id, id, ctx.session && ctx.session.tokenHash);
    if (!r2.removed) throw httpError(404, 'That device is already logged out.', 'not_found');
    await audit(ctx, 'security.session_revoked', 'user:' + ctx.user.id, { session: id, current: r2.current });
    if (r2.current) ctx.setCookie(auth.COOKIE, '', { path: '/', maxAge: 0, httpOnly: true, sameSite: 'Lax' });
    return { ok: true, current: r2.current };
  }, { auth: 'user', rate: [60, 600] });

  /** Log out every other device; this one stays logged in. */
  r.post('/api/me/sessions/revoke-others', async (ctx) => {
    const r2 = await security.revokeOthers(ctx.user.id, ctx.session && ctx.session.tokenHash);
    await audit(ctx, 'security.sessions_revoked', 'user:' + ctx.user.id, { removed: r2.removed });
    return { ok: true, removed: r2.removed };
  }, { auth: 'user', rate: [20, 600] });

  /*
   * "If this wasn't you, log out all devices" (new-login email and Telegram alert). The link is signed and works for
   * 7 days. Opening it shows one button (email scanners open links on their own, so a plain visit changes nothing);
   * pressing it logs out EVERY device of the account, this browser too, and asks the person to log in again.
   */
  const secPage = (ctx, status, title, body) => ctx.html(status, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover"><title>${escHtml(title)} · Castvoo</title><link rel="icon" href="/img/favicon.svg"></head>
<body style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#F6F8FC;color:#0B1430;padding:16px;box-sizing:border-box">
<main style="max-width:440px;width:100%;background:#fff;border:1px solid #E3E8F2;border-radius:20px;padding:30px 24px;text-align:center;box-shadow:0 18px 40px -24px rgba(11,20,48,.35)">${body}</main></body></html>`);
  const btn = 'display:inline-block;border:0;border-radius:12px;padding:14px 20px;font:600 16px system-ui,sans-serif;cursor:pointer;text-decoration:none';
  const linkProblem = (ctx, e) => secPage(ctx, 400, 'Link expired', `<div style="font-size:38px">⏳</div><h1 style="font-size:22px;margin:10px 0">${e.message === 'expired' ? 'This link has expired' : 'This link is not valid'}</h1><p style="color:#5B6787;line-height:1.5">You can still log out other devices yourself: log in, then open <b>Settings → Security</b>.</p><p><a href="/#login" style="${btn};background:#2F6BFF;color:#fff">Log in</a></p>`);

  r.get('/security/logout-all', async (ctx) => {
    try { security.checkLogoutAll(ctx.query); } catch (e) { return linkProblem(ctx, e); }
    const q = ctx.query;
    return secPage(ctx, 200, 'Log out all devices', `<div style="font-size:38px">🔐</div><h1 style="font-size:22px;margin:10px 0">Log out all devices?</h1>
<p style="color:#5B6787;line-height:1.5">Every phone and computer logged in to your Castvoo account is logged out, this one too. Then log in again with your email code or Telegram.</p>
<form method="post" action="/security/logout-all" style="margin:20px 0 8px"><input type="hidden" name="u" value="${escHtml(q.u)}"><input type="hidden" name="e" value="${escHtml(q.e)}"><input type="hidden" name="s" value="${escHtml(q.s)}">
<button type="submit" style="${btn};background:#E5484D;color:#fff;width:100%">Log out all devices</button></form>
<p style="color:#5B6787;font-size:14px;line-height:1.5">Tip: never share your login. Invite teammates or a setup helper in Settings → Team instead.</p>`);
  }, { rate: [60, 600] });

  r.post('/security/logout-all', async (ctx) => {
    let uid;
    try { uid = security.checkLogoutAll(ctx.body || {}); } catch (e) { return linkProblem(ctx, e); }
    const r2 = await security.revokeAll(uid);
    await audit({ user: { id: uid }, ip: null }, 'security.logout_all_link', 'user:' + uid, { removed: r2.removed });
    ctx.setCookie(auth.COOKIE, '', { path: '/', maxAge: 0, httpOnly: true, sameSite: 'Lax' });
    return secPage(ctx, 200, 'All devices logged out', `<div style="font-size:38px">✅</div><h1 style="font-size:22px;margin:10px 0">All devices are logged out</h1>
<p style="color:#5B6787;line-height:1.5">Nobody is logged in to your account now. Log in again to keep working. If you think someone knows how to get into your email or Telegram, secure those first.</p>
<p><a href="/#login" style="${btn};background:#2F6BFF;color:#fff">Log in again</a></p>`);
  }, { rate: [30, 600] });

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
      // Join requests, links, clicks, replies, the AI tool log and every teammate's access (SEC-8, SEC-9).
      await require('../services/purge').purgeRows(c, wsIds, { userId: u.id, members: true });
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
module.exports.sendCode = sendCode;

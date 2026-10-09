'use strict';
/*
 * Account security: the Active devices list (Settings → Security), logging out one device or all the others, and
 * new-login alerts.
 *
 * New-login alert: a login whose device (lib/device.js key: OS + browser) and country pair was not seen for this
 * account in the last 90 days (table user_devices) gets an email (template new_login) and, when the account linked
 * Telegram and kept "Telegram alerts" on, a message from @CastvooBot. No alert for the first login of a new account,
 * or the first login recorded for an older account (nothing to compare with yet). At most 3 alerts an hour and 10 a
 * day per account (shared by every server). The alert has a signed link (7 days) that logs out EVERY device of the
 * account, so the person can log in again and lock out whoever else has the login.
 *
 * The goal is gentle: people sharing one login see these alerts and the device list, real teams use seats or the
 * setup helper. Nothing is blocked.
 */

const db = require('../db');
const config = require('../config');
const log = require('../lib/log');
const rl = require('../lib/ratelimit');
const geoip = require('../lib/geoip');
const device = require('../lib/device');
const { hmac, safeEqual, escHtml } = require('../lib/util');

const SEEN_DAYS = 90;
const LINK_DAYS = 7;
const SEEN_WRITE_MS = 5 * 60000;

const ipHash = (ip) => (ip ? hmac(config.appSecret, 'ip:' + String(ip)).slice(0, 32) : null);

/** "9 October 2026, 14:05 UTC" */
function fmtTime(d) {
  const x = new Date(d);
  return `${x.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}, ${x.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' })} UTC`;
}
const countryText = (cc) => (cc ? `${geoip.countryName(cc)}` : 'Unknown country');

/** One session row as the browser sees it. */
function view(s, currentHash) {
  const d = device.parse(s.user_agent);
  return {
    id: String(s.id), device: d.label, os: d.os, browser: d.browser, mobile: d.mobile,
    country: s.ip_country || null, country_name: s.ip_country ? geoip.countryName(s.ip_country) : null, flag: s.ip_country ? geoip.flag(s.ip_country) : null,
    created_at: s.created_at, last_seen_at: s.last_seen_at || s.created_at, current: !!currentHash && s.token_hash === currentHash,
  };
}

/** Every logged-in session of a user, this device first, then the most recently used. */
async function list(userId, currentHash) {
  const rows = await db.many(`select id, token_hash, user_agent, ip_country, created_at, last_seen_at from sessions
    where user_id = $1 and expires_at > now() order by (token_hash = $2) desc, last_seen_at desc, id desc limit 50`, [userId, currentHash || '']);
  return rows.map((r) => view(r, currentHash));
}

/** Log out one session of this user. Returns { removed, current }. Takes effect on that device's next request. */
async function revoke(userId, sessionId, currentHash) {
  const row = await db.one('delete from sessions where id = $1 and user_id = $2 returning token_hash', [sessionId, userId]);
  return { removed: !!row, current: !!row && row.token_hash === currentHash };
}
/** Log out every other session of this user (this device stays logged in). */
async function revokeOthers(userId, currentHash) {
  const r = await db.query('delete from sessions where user_id = $1 and token_hash <> $2', [userId, currentHash || '']);
  return { removed: r.rowCount || 0 };
}
/** Log out every session of this user (the alert's link). */
async function revokeAll(userId) {
  const r = await db.query('delete from sessions where user_id = $1', [userId]);
  return { removed: r.rowCount || 0 };
}

/** Record that a session was used, at most every 5 minutes (called by auth.loadSession). */
async function touch(sessionId, lastSeen) {
  if (lastSeen && Date.now() - new Date(lastSeen).getTime() < SEEN_WRITE_MS) return;
  await db.query('update sessions set last_seen_at = now() where id = $1', [sessionId]).catch(() => {});
}

/* ---------- The signed "log out all devices" link ---------- */

const sigOf = (uid, exp) => hmac(config.appSecret, `logout-all:${uid}:${exp}`).slice(0, 40);
function logoutAllUrl(userId, now = Date.now()) {
  const exp = Math.floor(now / 1000) + LINK_DAYS * 86400;
  return `${config.appUrl}/security/logout-all?u=${encodeURIComponent(userId)}&e=${exp}&s=${sigOf(userId, exp)}`;
}
/** The user id the link is for, or throws a reason ('bad' | 'expired'). */
function checkLogoutAll(q) {
  const uid = String(q.u || ''), exp = Number(q.e || 0), sig = String(q.s || '');
  if (!/^\d{1,18}$/.test(uid) || !Number.isFinite(exp) || !safeEqual(sigOf(uid, exp), sig)) throw new Error('bad');
  if (exp * 1000 < Date.now()) throw new Error('expired');
  return uid;
}

/* ---------- New-login alerts ---------- */

/**
 * After a login (auth.createSession). `created` = the account was just made. Records the device + country pair and
 * sends an alert when the pair is new for this account. Never throws (a login never fails because of an alert).
 */
async function onLogin(ctx, user, { created = false, dev, country } = {}) {
  try {
    const key = dev.key, cc = country || '';
    const had = await db.one('select count(*)::int n from user_devices where user_id = $1', [user.id]);
    const seen = await db.one(`select 1 from user_devices where user_id = $1 and device_key = $2 and country = $3 and last_seen > now() - make_interval(days => $4)`, [user.id, key, cc, SEEN_DAYS]);
    await db.query(`insert into user_devices(user_id, device_key, country) values ($1,$2,$3)
      on conflict (user_id, device_key, country) do update set last_seen = now()`, [user.id, key, cc]);
    if (created || !had.n || seen) return { alerted: false, reason: created ? 'new_account' : !had.n ? 'first_login' : 'known' };
    const a = await rl.hitShared('login-alert-h:' + user.id, 3, 3600);
    const b = a.ok ? await rl.hitShared('login-alert-d:' + user.id, 10, 86400) : { ok: false };
    if (!a.ok || !b.ok) { log.info('new-login alert skipped (rate limit)', { user: user.id }); return { alerted: false, reason: 'rate_limited' }; }
    const vars = {
      device: dev.label, country: countryText(country), login_time: fmtTime(new Date()),
      logout_all_url: logoutAllUrl(user.id), devices_url: `${config.appUrl}/#app/settings?tab=security`,
    };
    await require('./email').send('new_login', user, vars);
    let telegram = false;
    if (user.tg_user_id && user.login_alert_tg !== false && config.telegram.botToken) {
      const flag = country ? geoip.flag(country) + ' ' : '';
      const text = `🔐 <b>New login to your Castvoo account</b>\n\n${escHtml(dev.label)}\n${flag}${escHtml(vars.country)}\n${escHtml(vars.login_time)}\n\n`
        + 'If this was you, there is nothing to do.\nIf it wasn\'t, log out every device now, then log in again.\n\n'
        + '<i>Tip: never share your login. Invite teammates or a setup helper in Settings → Team instead.</i>';
      telegram = await require('./telegram').platform('sendMessage', {
        chat_id: user.tg_user_id, text, parse_mode: 'HTML', disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [[{ text: 'Not me: log out all devices', url: vars.logout_all_url }], [{ text: 'See my devices', url: vars.devices_url }]] },
      }).then(() => true).catch(() => false);
    }
    await require('./audit').audit({ user, ip: null }, 'security.new_login_alert', 'user:' + user.id, { device: dev.label, country: cc || null, telegram });
    return { alerted: true, telegram };
  } catch (e) {
    log.warn('new-login check failed', { user: user && user.id, err: e.message });
    return { alerted: false, reason: 'error' };
  }
}

module.exports = { list, revoke, revokeOthers, revokeAll, touch, onLogin, logoutAllUrl, checkLogoutAll, ipHash, fmtTime, view, SEEN_DAYS };

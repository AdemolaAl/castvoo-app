'use strict';
/*
 * Settings → Security: the Active devices list (device from the user agent, country from the IP, first seen, last
 * active, "This device"), logging out one device or all the others (refused on the very next request), no raw IP
 * kept, and new-login alerts (email + Telegram, only for a new device + country, not for the first login, rate
 * limited) with the signed, expiring "log out all devices" link.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { startApp } = require('../helpers/app');

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
};
const IP = { ng: '41.58.10.20', ng2: '197.210.5.5', us: '8.8.8.8', ke: '41.90.1.1', gh: '154.160.3.3' };

let app, security;
before(async () => {
  app = await startApp();
  security = app.require('services/security');
  // The tiny DB-IP fixture stands in for the real file on the volume.
  const dir = path.join(app.uploadDir, 'geo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dbip-country-lite.csv.gz'), zlib.gzipSync(fs.readFileSync(path.join(__dirname, '../fixtures/dbip-country-lite-sample.csv'))));
  assert.equal(app.require('lib/geoip').load(), true);
});
after(async () => { if (app) await app.stop(); });
beforeEach(() => { app.rl._reset(); });

/** Log in by email code with a given browser (user agent) and address. Returns a client that keeps sending both. */
async function login(email, ua, ip, extra = {}) {
  const base = app.client({ ip });
  const h = (o = {}) => ({ ...o, headers: { 'user-agent': ua, ...(o.headers || {}) } });
  const c = {
    get: (p, o) => base.get(p, h(o)), post: (p, b, o) => base.post(p, b, h(o)), request: (m, p, b, o) => base.request(m, p, b, h(o)), jar: base.jar,
  };
  assert.equal((await c.post('/api/auth/email/start', { email })).status, 200);
  const v = await c.post('/api/auth/email/verify', { email, code: app.fakes.lastCode(email), ...extra });
  assert.equal(v.status, 200, v.text);
  c.created = v.body.created;
  c.user = (await c.get('/api/me')).body.user;
  return c;
}
const alerts = (email) => app.fakes.emailsTo(email).filter((e) => /New login to your Castvoo account/.test(e.subject));
const tgAlerts = (chatId) => app.fakes.tgCalls('sendMessage', app.platformBotToken).filter((c) => String(c.params.chat_id) === String(chatId) && /New login/.test(c.params.text || ''));
let n = 0;
const mail = (p) => `${p}${++n}.dev@example.com`;

describe('Active devices', () => {
  it('lists every session with device, country, first seen, last active and "This device"', async () => {
    const email = mail('list');
    const a = await login(email, UA.iphone, IP.ng);
    const b = await login(email, UA.windows, IP.us);
    const r = await a.get('/api/me/sessions');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.sessions.length, 2);
    const [me, other] = r.body.sessions;
    assert.equal(me.current, true, 'this device first');
    assert.equal(me.device, 'iPhone · Safari');
    assert.equal(me.country, 'NG');
    assert.equal(me.country_name, 'Nigeria');
    assert.equal(me.flag, '🇳🇬');
    assert.equal(me.mobile, true);
    assert.ok(me.created_at && me.last_seen_at);
    assert.equal(other.current, false);
    assert.equal(other.device, 'Windows · Chrome');
    assert.equal(other.country, 'US');
    assert.ok(!r.text.includes('token_hash') && !r.text.includes(IP.ng), 'no token hash or address sent');
    // The other browser sees itself as "This device".
    const rb = await b.get('/api/me/sessions');
    assert.equal(rb.body.sessions.find((s) => s.current).device, 'Windows · Chrome');
  });

  it('keeps a hashed address and the country, never the raw IP', async () => {
    const email = mail('noip');
    const a = await login(email, UA.android, IP.ke);
    const rows = await app.db.many('select ip, ip_hash, ip_country, device_key from sessions where user_id = $1', [a.user.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ip, null);
    assert.match(rows[0].ip_hash, /^[0-9a-f]{32}$/);
    assert.notEqual(rows[0].ip_hash, IP.ke);
    assert.equal(rows[0].ip_country, 'KE');
    assert.equal(rows[0].device_key, 'android|samsung internet');
  });

  it('an unknown or private address shows no country', async () => {
    const a = await login(mail('priv'), UA.mac, '10.20.30.40');
    const s = (await a.get('/api/me/sessions')).body.sessions[0];
    assert.equal(s.country, null);
    assert.equal(s.device, 'Mac · Safari');
  });

  it('"Log out" ends that device at once: its next request is refused', async () => {
    const email = mail('revoke');
    const a = await login(email, UA.iphone, IP.ng);
    const b = await login(email, UA.windows, IP.ng);
    assert.equal((await b.get('/api/app/state')).status, 200);
    const other = (await a.get('/api/me/sessions')).body.sessions.find((s) => !s.current);
    const r = await a.post(`/api/me/sessions/${other.id}/revoke`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.current, false);
    const after = await b.get('/api/app/state');
    assert.equal(after.status, 401, 'revoked session fails immediately');
    assert.equal((await b.get('/api/me')).body.user, null);
    assert.equal((await a.get('/api/app/state')).status, 200, 'this device stays logged in');
    assert.equal((await a.get('/api/me/sessions')).body.sessions.length, 1);
    // Again: already gone.
    assert.equal((await a.post(`/api/me/sessions/${other.id}/revoke`)).status, 404);
    const log = await app.db.one("select * from audit_log where action = 'security.session_revoked' and actor_user_id = $1", [a.user.id]);
    assert.ok(log, 'written to the audit log');
  });

  it("can't log out someone else's session", async () => {
    const x = await login(mail('mine'), UA.iphone, IP.ng);
    const y = await login(mail('theirs'), UA.windows, IP.us);
    const theirs = (await y.get('/api/me/sessions')).body.sessions[0];
    assert.equal((await x.post(`/api/me/sessions/${theirs.id}/revoke`)).status, 404);
    assert.equal((await x.post('/api/me/sessions/abc/revoke')).status, 400);
    assert.equal((await y.get('/api/app/state')).status, 200);
  });

  it('"Log out all other devices" ends every other session and keeps this one', async () => {
    const email = mail('others');
    const a = await login(email, UA.iphone, IP.ng);
    const b = await login(email, UA.windows, IP.ng);
    const c = await login(email, UA.android, IP.ng);
    const r = await a.post('/api/me/sessions/revoke-others');
    assert.equal(r.status, 200);
    assert.equal(r.body.removed, 2);
    assert.equal((await b.get('/api/app/state')).status, 401);
    assert.equal((await c.get('/api/app/state')).status, 401);
    assert.equal((await a.get('/api/app/state')).status, 200);
  });

  it('logging out this device from the list clears its cookie', async () => {
    const a = await login(mail('self'), UA.iphone, IP.ng);
    const me = (await a.get('/api/me/sessions')).body.sessions[0];
    const r = await a.post(`/api/me/sessions/${me.id}/revoke`);
    assert.equal(r.body.current, true);
    assert.equal((await a.get('/api/app/state')).status, 401);
  });

  it('last active is written at most every 5 minutes', async () => {
    const a = await login(mail('seen'), UA.iphone, IP.ng);
    const id = (await app.db.one('select id from sessions where user_id = $1', [a.user.id])).id;
    await app.db.query("update sessions set last_seen_at = now() - interval '10 minutes' where id = $1", [id]);
    await a.get('/api/app/state');
    const t1 = (await app.db.one('select last_seen_at from sessions where id = $1', [id])).last_seen_at;
    assert.ok(Date.now() - new Date(t1).getTime() < 60000, 'updated after 10 minutes');
    await app.db.query("update sessions set last_seen_at = now() - interval '2 minutes' where id = $1", [id]);
    const before = (await app.db.one('select last_seen_at from sessions where id = $1', [id])).last_seen_at;
    await a.get('/api/app/state');
    const t2 = (await app.db.one('select last_seen_at from sessions where id = $1', [id])).last_seen_at;
    assert.equal(new Date(t2).getTime(), new Date(before).getTime(), 'not written again within 5 minutes');
  });

  it('needs a login', async () => {
    assert.equal((await app.client().get('/api/me/sessions')).status, 401);
    assert.equal((await app.client().post('/api/me/sessions/revoke-others')).status, 401);
  });
});

describe('new-login alerts', () => {
  it('no alert for the first login after sign-up, nor for the same device and country again', async () => {
    const email = mail('first');
    const a = await login(email, UA.iphone, IP.ng);
    assert.equal(a.created, true);
    assert.equal(alerts(email).length, 0, 'sign-up: no alert');
    await login(email, UA.iphone, IP.ng2); // same device, same country (another Nigerian address)
    assert.equal(alerts(email).length, 0, 'known device + country: no alert');
  });

  it('a new device sends an email with device, country, time and a security tip, and a Telegram message', async () => {
    const email = mail('newdev');
    const a = await login(email, UA.iphone, IP.ng);
    await app.db.query('update users set tg_user_id = $2 where id = $1', [a.user.id, 880000000 + n]);
    await login(email, UA.windows, IP.ng);
    const m = alerts(email);
    assert.equal(m.length, 1);
    assert.match(m[0].text, /Device: Windows · Chrome/);
    assert.match(m[0].text, /Country: Nigeria/);
    assert.match(m[0].text, /Time: \d{1,2} \w+ \d{4}, \d{2}:\d{2} UTC/);
    assert.match(m[0].text, /never share your login/i, 'security tip');
    assert.match(m[0].text, /\/security\/logout-all\?u=\d+&e=\d+&s=[0-9a-f]{40}/);
    assert.match(m[0].html, /Log out all devices/);
    const t = tgAlerts(880000000 + n);
    assert.equal(t.length, 1, 'Telegram alert from @CastvooBot');
    assert.match(t[0].params.text, /Windows · Chrome/);
    assert.match(t[0].params.text, /🇳🇬 Nigeria/);
    assert.match(t[0].params.reply_markup.inline_keyboard[0][0].url, /\/security\/logout-all\?/);
  });

  it('a known device in a new country is a new login too', async () => {
    const email = mail('newctry');
    await login(email, UA.iphone, IP.ng);
    await login(email, UA.iphone, IP.gh);
    const m = alerts(email);
    assert.equal(m.length, 1);
    assert.match(m[0].text, /Country: Ghana/);
  });

  it('a pair last seen more than 90 days ago alerts again', async () => {
    const email = mail('old');
    const a = await login(email, UA.iphone, IP.ng);
    await login(email, UA.windows, IP.ng);
    assert.equal(alerts(email).length, 1);
    await app.db.query("update user_devices set last_seen = now() - interval '91 days' where user_id = $1 and device_key = 'windows|chrome'", [a.user.id]);
    await login(email, UA.windows, IP.ng);
    assert.equal(alerts(email).length, 2);
  });

  it('Telegram alerts can be switched off; the email still goes', async () => {
    const email = mail('tgoff');
    const a = await login(email, UA.iphone, IP.ng);
    const chat = 890000000 + n;
    await app.db.query('update users set tg_user_id = $2 where id = $1', [a.user.id, chat]);
    const off = await a.post('/api/me', { login_alert_tg: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.user.login_alert_tg, false);
    await login(email, UA.android, IP.ke);
    assert.equal(alerts(email).length, 1, 'email always');
    assert.equal(tgAlerts(chat).length, 0, 'no Telegram message');
    assert.equal((await a.post('/api/me', { login_alert_tg: true })).body.user.login_alert_tg, true);
  });

  it('an older account with no device history is not alerted on its first recorded login', async () => {
    const email = mail('legacy');
    const a = await login(email, UA.iphone, IP.ng);
    await app.db.query('delete from user_devices where user_id = $1', [a.user.id]); // like an account from before this feature
    await login(email, UA.windows, IP.us);
    assert.equal(alerts(email).length, 0);
    assert.equal((await app.db.one('select count(*)::int n from user_devices where user_id = $1', [a.user.id])).n, 1);
  });

  it('is rate limited: at most 3 alerts an hour', async () => {
    const email = mail('rate');
    await login(email, UA.iphone, IP.ng);
    for (const [ua, ip] of [[UA.windows, IP.ng], [UA.android, IP.ng], [UA.mac, IP.ng], [UA.windows, IP.us]]) await login(email, ua, ip);
    assert.equal(alerts(email).length, 3);
    // The pairs are still remembered, so they don't alert later either.
    assert.equal((await app.db.one("select count(*)::int n from user_devices where user_id = (select id from users where email = $1)", [email])).n, 5);
  });

  it('the signed link logs out every device after one press, and asks to log in again', async () => {
    const email = mail('link');
    const a = await login(email, UA.iphone, IP.ng);
    const b = await login(email, UA.windows, IP.us);
    const url = new URL(/(http\S+\/security\/logout-all\?\S+)/.exec(alerts(email)[0].text)[1]);
    // Opening the link (an email scanner, or the person) changes nothing: it shows one button.
    const g = await app.client().get(url.pathname + url.search);
    assert.equal(g.status, 200);
    assert.match(g.text, /<form method="post" action="\/security\/logout-all"/);
    assert.doesNotMatch(g.text, /<script/);
    assert.equal((await a.get('/api/app/state')).status, 200);
    // Pressing the button logs out every device.
    const q = url.searchParams;
    const p = await app.client().post('/security/logout-all', `u=${q.get('u')}&e=${q.get('e')}&s=${q.get('s')}`, { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(p.status, 200, p.text);
    assert.match(p.text, /All devices are logged out/);
    assert.match(p.text, /Log in again/);
    assert.equal((await a.get('/api/app/state')).status, 401);
    assert.equal((await b.get('/api/app/state')).status, 401);
    assert.equal((await app.db.one('select count(*)::int n from sessions where user_id = $1', [a.user.id])).n, 0);
    assert.ok(await app.db.one("select 1 from audit_log where action = 'security.logout_all_link' and target = $1", ['user:' + a.user.id]));
  });

  it('a changed or expired link does nothing', async () => {
    const email = mail('badlink');
    const a = await login(email, UA.iphone, IP.ng);
    const good = new URL(security.logoutAllUrl(a.user.id));
    const q = good.searchParams;
    const post = (u, e, s) => app.client().post('/security/logout-all', `u=${u}&e=${e}&s=${s}`, { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    // Someone else's id with this signature, or a longer expiry: refused.
    assert.equal((await post(Number(q.get('u')) + 1, q.get('e'), q.get('s'))).status, 400);
    assert.equal((await post(q.get('u'), Number(q.get('e')) + 86400, q.get('s'))).status, 400);
    const exp = new URL(security.logoutAllUrl(a.user.id, Date.now() - 8 * 86400000));
    const r = await post(exp.searchParams.get('u'), exp.searchParams.get('e'), exp.searchParams.get('s'));
    assert.equal(r.status, 400);
    assert.match(r.text, /expired/);
    const g = await app.client().get(exp.pathname + exp.search);
    assert.equal(g.status, 400);
    assert.equal((await a.get('/api/app/state')).status, 200, 'still logged in');
    // The link works for 7 days.
    assert.ok(Number(q.get('e')) * 1000 - Date.now() > 6.9 * 86400000);
  });
});

describe('device names from user agents', () => {
  it('reads common phones, computers and in-app browsers', () => {
    const d = app.require('lib/device');
    assert.equal(d.parse(UA.iphone).label, 'iPhone · Safari');
    assert.equal(d.parse(UA.windows).label, 'Windows · Chrome');
    assert.equal(d.parse(UA.android).label, 'Android · Samsung Internet');
    assert.equal(d.parse(UA.mac).label, 'Mac · Safari');
    assert.equal(d.parse('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0').label, 'Windows · Edge');
    assert.equal(d.parse('Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0').label, 'Linux · Firefox');
    assert.equal(d.parse('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Telegram-iOS/10.0').label, 'iPhone · Telegram');
    assert.equal(d.parse('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1').label, 'iPhone · Chrome');
    assert.equal(d.parse('').label, 'Unknown device');
  });
});

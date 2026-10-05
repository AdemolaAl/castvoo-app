'use strict';
/* Logging in: email code, Telegram widget, Google (OIDC), profile, adding an email, linking Telegram. */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, telegramLoginHash } = require('../helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { if (app) await app.stop(); });
beforeEach(() => app.rl._reset());

const startCode = async (c, email) => {
  const r = await c.post('/api/auth/email/start', { email });
  assert.equal(r.status, 200, r.text);
  return app.fakes.lastCode(email);
};
const wrongCode = (code) => String((Number(code) + 1) % 1000000).padStart(6, '0');

describe('email login', () => {
  it('a new user gets an account, a workspace, a 7-day Growth trial and a welcome email', async () => {
    const c = await app.loginByEmail('newbie@example.com', { name: 'Ada Lovelace', country: 'KE' });
    assert.equal(c.created, true);
    assert.equal(c.user.email, 'newbie@example.com');
    assert.equal(c.user.name, 'Ada Lovelace');
    assert.equal(c.user.country, 'KE');
    assert.equal(c.user.staff_role, null);
    assert.equal(c.workspaces.length, 1);
    assert.equal(c.workspaces[0].role, 'owner');
    const ws = await app.ws(c);
    assert.equal(ws.plan_code, 'growth');
    assert.equal(ws.plan_status, 'trial');
    assert.equal(ws.timezone, 'Africa/Nairobi');
    const days = (new Date(ws.trial_ends_at) - Date.now()) / 86400000;
    assert.ok(days > 6.9 && days <= 7.01, 'trial is 7 days: ' + days);
    const welcome = app.fakes.lastEmail('newbie@example.com', /Welcome to Castvoo/);
    assert.ok(welcome, 'welcome email sent');
    assert.ok(welcome.subject.includes('Ada'));
    const state = await c.get('/api/app/state');
    assert.equal(state.status, 200);
    assert.equal(state.body.plan.status, 'trial');
    assert.equal(state.body.plan.limits.ai_writes, 100);

    // Logging in again does not create anything new.
    const again = await app.loginByEmail('newbie@example.com');
    assert.equal(again.created, false);
    assert.equal((await app.db.one('select count(*)::int n from workspaces where owner_user_id = $1', [c.user.id])).n, 1);
  });

  it('5 wrong tries lock the code, even the right code then fails', async () => {
    const c = app.client();
    const code = await startCode(c, 'locked@example.com');
    for (let i = 0; i < 5; i++) {
      const r = await c.post('/api/auth/email/verify', { email: 'locked@example.com', code: wrongCode(code) });
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 'code_wrong');
    }
    const r = await c.post('/api/auth/email/verify', { email: 'locked@example.com', code });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'code_locked');
    // A fresh code works.
    const code2 = await startCode(c, 'locked@example.com');
    const ok = await c.post('/api/auth/email/verify', { email: 'locked@example.com', code: code2 });
    assert.equal(ok.status, 200);
  });

  it('parallel guessing cannot get more than 5 tries on one code', async () => {
    const c = app.client();
    const code = await startCode(c, 'brute@example.com');
    // Each guess comes from a different address, as an attacker with many IPs would do.
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => app.client().post('/api/auth/email/verify', { email: 'brute@example.com', code: wrongCode(code) }, { ip: '172.16.0.' + i })));
    const wrong = results.filter((r) => r.body.code === 'code_wrong').length;
    assert.ok(wrong <= 5, `only 5 guesses may be checked, got ${wrong}`);
    const attempts = (await app.db.one("select attempts from login_codes where email = 'brute@example.com' order by id desc limit 1")).attempts;
    assert.ok(attempts >= 5);
    const right = await c.post('/api/auth/email/verify', { email: 'brute@example.com', code });
    assert.equal(right.body.code, 'code_locked');
  });

  it('a code works only once, and an expired code is refused', async () => {
    const c = app.client();
    const code = await startCode(c, 'once@example.com');
    assert.equal((await c.post('/api/auth/email/verify', { email: 'once@example.com', code })).status, 200);
    const reuse = await app.client().post('/api/auth/email/verify', { email: 'once@example.com', code });
    assert.equal(reuse.body.code, 'code_expired');

    const code2 = await startCode(app.client(), 'expired@example.com');
    await app.db.query("update login_codes set expires_at = now() - interval '1 second' where email = 'expired@example.com'");
    const r = await app.client().post('/api/auth/email/verify', { email: 'expired@example.com', code: code2 });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'code_expired');
  });

  it('rate limits: 5 codes per email per hour, 150 starts per IP per 10 minutes (many people share mobile IPs)', async () => {
    const c = app.client();
    for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/auth/email/start', { email: 'spam@example.com' }, { ip: '192.168.9.' + i })).status, 200);
    const sixth = await c.post('/api/auth/email/start', { email: 'spam@example.com' }, { ip: '192.168.9.99' });
    assert.equal(sixth.status, 429);
    app.rl._reset();
    const one = app.client({ ip: '203.0.113.7' });
    for (let i = 0; i < 150; i++) assert.equal((await one.post('/api/auth/email/start', { email: `ip${i}@example.com` })).status, 200);
    const eleventh = await one.post('/api/auth/email/start', { email: 'ip151@example.com' });
    assert.equal(eleventh.status, 429);
    assert.equal(eleventh.body.code, 'rate_limited');
    assert.ok(Number(eleventh.headers.get('retry-after')) > 0);
    // A fake X-Forwarded-For added in front of the proxy's address does not dodge the limit.
    const spoof = await one.post('/api/auth/email/start', { email: 'ip12@example.com' }, { ip: '1.2.3.4, 203.0.113.7' });
    assert.equal(spoof.status, 429);
  });

  it('login routes refuse requests without the x-cv header (a form on another site can\'t log you in)', async () => {
    const c = app.client();
    const code = await startCode(c, 'formcsrf@example.com');
    const form = await c.post('/api/auth/email/verify', `email=formcsrf%40example.com&code=${code}`, { csrf: false, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(form.status, 403);
    assert.equal(form.body.code, 'csrf');
    assert.equal((await c.post('/api/auth/email/start', { email: 'formcsrf@example.com' }, { csrf: false })).status, 403);
    assert.equal((await c.post('/api/auth/telegram', { id: 1 }, { csrf: false })).status, 403);
    assert.equal((await c.post('/api/auth/email/verify', { email: 'formcsrf@example.com', code })).status, 200);
  });

  it('a bad email address is refused', async () => {
    const r = await app.client().post('/api/auth/email/start', { email: 'not-an-email' });
    assert.equal(r.status, 400);
  });

  it('OWNER_EMAIL becomes the platform owner', async () => {
    const o = await app.loginByEmail('Owner@Castvoo.test'.toLowerCase());
    assert.equal(o.user.staff_role, 'owner');
    assert.ok(o.user.perms.includes('team.manage'));
    const adm = await o.get('/api/admin/me');
    assert.equal(adm.status, 200);
    assert.equal(adm.body.user.role, 'owner');
  });

  it('referral: the ref code (body or cookie) is saved on the new user', async () => {
    const ref = await app.loginByEmail('boss@example.com');
    const a = await app.loginByEmail('friend1@example.com', { ref: ref.user.ref_code });
    const rowA = await app.db.one('select referred_by from users where id = $1', [a.user.id]);
    assert.equal(rowA.referred_by, ref.user.id);

    const b = app.client();
    await b.get('/r/' + ref.user.ref_code);
    await app.loginByEmail('friend2@example.com', {}, b);
    const rowB = await app.db.one("select referred_by from users where email = 'friend2@example.com'");
    assert.equal(rowB.referred_by, ref.user.id);

    const unknown = await app.loginByEmail('friend3@example.com', { ref: 'doesnotexist' });
    assert.equal((await app.db.one('select referred_by from users where id = $1', [unknown.user.id])).referred_by, null);
  });

  it('sign-ups switched off: new people are refused, existing people can still log in', async () => {
    await app.setFeature('signups', false);
    try {
      const c = app.client();
      const code = await startCode(c, 'late@example.com');
      const r = await c.post('/api/auth/email/verify', { email: 'late@example.com', code });
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 'signups_off');
      const old = await app.loginByEmail('newbie@example.com');
      assert.equal(old.created, false);
    } finally { await app.setFeature('signups', true); }
  });

  it('maintenance mode pauses sign-ups', async () => {
    await app.setFeature('maintenance', true);
    try {
      const c = app.client();
      const code = await startCode(c, 'maint@example.com');
      const r = await c.post('/api/auth/email/verify', { email: 'maint@example.com', code });
      assert.equal(r.status, 503);
      assert.equal(r.body.code, 'maintenance');
    } finally { await app.setFeature('maintenance', false); }
  });

  it('email login switched off', async () => {
    await app.setFeature('login_email', false);
    try {
      const r = await app.client().post('/api/auth/email/start', { email: 'x@example.com' });
      assert.equal(r.status, 403);
    } finally { await app.setFeature('login_email', true); }
  });

  it('a suspended user cannot log in and loses their sessions', async () => {
    const u = await app.loginByEmail('naughty@example.com');
    const owner = await app.owner();
    const s = await owner.post(`/api/admin/users/${u.user.id}/status`, { status: 'suspended', reason: 'spam' });
    assert.equal(s.status, 200);
    assert.equal((await u.get('/api/me')).body.user, null);
    const c = app.client();
    const code = await startCode(c, 'naughty@example.com');
    const r = await c.post('/api/auth/email/verify', { email: 'naughty@example.com', code });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'suspended');
  });
});

describe('Telegram login', () => {
  const widget = (fields) => ({ ...fields, hash: telegramLoginHash(app.platformBotToken, fields) });

  it('a valid widget login creates the account', async () => {
    const c = app.client();
    const data = widget({ id: 4242, first_name: 'Tunde', last_name: 'Bello', username: 'tunde', auth_date: Math.floor(Date.now() / 1000) });
    const r = await c.post('/api/auth/telegram', data);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.created, true);
    const me = await c.get('/api/me');
    assert.equal(me.body.user.tg_linked, true);
    assert.equal(me.body.user.tg_username, 'tunde');
    assert.equal(me.body.user.name, 'Tunde Bello');
    assert.equal(me.body.user.email, null);
    const again = await app.client().post('/api/auth/telegram', widget({ id: 4242, first_name: 'Tunde', username: 'tunde2', auth_date: Math.floor(Date.now() / 1000) }));
    assert.equal(again.body.created, false);
    assert.equal((await app.db.one('select tg_username from users where tg_user_id = 4242')).tg_username, 'tunde2');
  });

  it('a wrong hash is refused', async () => {
    const data = widget({ id: 4343, first_name: 'Eve', auth_date: Math.floor(Date.now() / 1000) });
    data.id = 1; // changed after signing
    const r = await app.client().post('/api/auth/telegram', data);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'tg_hash');
    const wrongKey = { id: 4343, first_name: 'Eve', auth_date: Math.floor(Date.now() / 1000) };
    wrongKey.hash = telegramLoginHash('123:other-bot-token', wrongKey);
    assert.equal((await app.client().post('/api/auth/telegram', wrongKey)).body.code, 'tg_hash');
  });

  it('an old login (more than a day) is refused', async () => {
    const r = await app.client().post('/api/auth/telegram', widget({ id: 4444, first_name: 'Old', auth_date: Math.floor(Date.now() / 1000) - 2 * 86400 }));
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'tg_old');
  });
});

describe('Google login (OIDC)', () => {
  async function googleLogin(client, user) {
    app.fakes.oidc.nextUser = user;
    const s = await client.get('/api/auth/google/start?ref=&country=GH');
    assert.equal(s.status, 302, s.text);
    const auth = s.headers.get('location');
    assert.ok(auth.startsWith(app.fakes.base + '/oidc/authorize'));
    const u = new URL(auth);
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('redirect_uri'), app.url + '/api/auth/google/callback');
    const back = await fetch(auth, { redirect: 'manual' });
    const cb = new URL(back.headers.get('location'));
    return client.get(cb.pathname + cb.search);
  }

  it('first login creates the account, the second just logs in', async () => {
    const c = app.client();
    const r = await googleLogin(c, { sub: 'g-100', email: 'GUser@Example.com', email_verified: true, name: 'Goo User' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/#signup/country');
    const me = await c.get('/api/me');
    assert.equal(me.body.user.email, 'guser@example.com');
    assert.equal(me.body.user.google_linked, true);
    assert.equal(me.body.user.country, 'GH');
    const c2 = app.client();
    const r2 = await googleLogin(c2, { sub: 'g-100', email: 'guser@example.com', email_verified: true, name: 'Goo User' });
    assert.equal(r2.headers.get('location'), '/#app');
  });

  it('a verified Google email joins the existing email account', async () => {
    const e = await app.loginByEmail('joiner@example.com');
    const c = app.client();
    const r = await googleLogin(c, { sub: 'g-200', email: 'joiner@example.com', email_verified: true, name: 'J' });
    assert.equal(r.headers.get('location'), '/#app');
    const me = await c.get('/api/me');
    assert.equal(me.body.user.id, e.user.id);
    assert.equal(me.body.user.google_linked, true);
  });

  it('an unverified Google email does not take over an email account', async () => {
    const e = await app.loginByEmail('victim@example.com');
    const c = app.client();
    await googleLogin(c, { sub: 'g-300', email: 'victim@example.com', email_verified: false, name: 'Mallory' });
    const me = await c.get('/api/me');
    assert.notEqual(me.body.user.id, e.user.id);
    assert.equal(me.body.user.email, null);
    // Google must say "verified" explicitly: a missing flag counts as not verified.
    const c2 = app.client();
    await googleLogin(c2, { sub: 'g-301', email: 'victim@example.com', name: 'Mallory 2' });
    const me2 = await c2.get('/api/me');
    assert.notEqual(me2.body.user.id, e.user.id);
    assert.equal(me2.body.user.email, null);
  });

  it('a callback link opened in another browser does not log that browser in (login CSRF)', async () => {
    const attacker = app.client();
    app.fakes.oidc.nextUser = { sub: 'g-attacker', email: 'attacker@example.com', email_verified: true, name: 'Attacker' };
    const s = await attacker.get('/api/auth/google/start');
    const back = await fetch(s.headers.get('location'), { redirect: 'manual' });
    const cb = new URL(back.headers.get('location'));
    const victim = app.client();
    const r = await victim.get(cb.pathname + cb.search);
    assert.match(r.headers.get('location'), /^\/#signup\?error=/);
    assert.equal((await victim.get('/api/me')).body.user, null, 'victim not logged in as the attacker');
    assert.equal(await app.db.one("select 1 from users where google_sub = 'g-attacker'"), null);
  });

  it('a forged or reused state is refused', async () => {
    const c = app.client();
    const r = await c.get('/api/auth/google/callback?code=abc&state=forged');
    assert.equal(r.status, 302);
    assert.match(r.headers.get('location'), /^\/#signup\?error=/);
    assert.equal((await c.get('/api/me')).body.user, null);
  });
});

describe('profile', () => {
  it('update name and country; bad values refused; country sets the new workspace time zone', async () => {
    const c = await app.loginByEmail('profile@example.com');
    const r = await c.post('/api/me', { name: 'Kofi', country: 'GH', marketing_opt_out: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.name, 'Kofi');
    assert.equal(r.body.user.country, 'GH');
    assert.equal(r.body.user.marketing_opt_out, true);
    assert.equal((await app.ws(c)).timezone, 'Africa/Accra');
    assert.equal((await c.post('/api/me', { country: 'ZZ' })).status, 400);
    assert.equal((await c.post('/api/me', { name: '' })).status, 400);
    assert.equal((await c.post('/api/me', { name: 'x'.repeat(81) })).status, 400);
  });

  it('a Telegram-only user adds an email with a code', async () => {
    const c = app.client();
    const f = { id: 5151, first_name: 'Tg', auth_date: Math.floor(Date.now() / 1000) };
    await c.post('/api/auth/telegram', { ...f, hash: telegramLoginHash(app.platformBotToken, f) });
    assert.equal((await c.post('/api/me/email/start', { email: 'newbie@example.com' })).status, 409, 'email of another account');
    assert.equal((await c.post('/api/me/email/start', { email: 'tgmail@example.com' })).status, 200);
    const code = app.fakes.lastCode('tgmail@example.com');
    const bad = await c.post('/api/me/email/verify', { email: 'tgmail@example.com', code: wrongCode(code) });
    assert.equal(bad.status, 400);
    const ok = await c.post('/api/me/email/verify', { email: 'tgmail@example.com', code });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.email, 'tgmail@example.com');
    assert.equal(ok.body.user.email_verified, true);
  });

  it('link Telegram through @CastvooBot: /start link_<token> then the Yes button', async () => {
    const c = await app.loginByEmail('linker@example.com');
    const r = await c.post('/api/me/telegram-link');
    assert.equal(r.status, 200);
    const token = /start=link_([A-Za-z0-9_-]+)$/.exec(r.body.url)[1];
    assert.ok(r.body.url.startsWith('https://t.me/CastvooBot?start=link_'));
    app.fakes.reset();
    const from = { id: 777001, is_bot: false, first_name: 'Linker', username: 'linker_tg' };
    await app.platformUpdate({ message: { message_id: 1, chat: { id: from.id, type: 'private' }, from, text: '/start link_' + token } });
    const dm = app.fakes.tgCalls('sendMessage', app.platformBotToken).pop();
    assert.ok(dm, 'bot asked to confirm');
    assert.equal(dm.params.chat_id, from.id);
    assert.match(dm.params.text, /l•••@example\.com/);
    assert.equal(dm.params.reply_markup.inline_keyboard[0][0].callback_data, 'link:' + token);
    assert.equal((await c.get('/api/me')).body.user.tg_linked, false, 'not linked before Yes');

    await app.platformUpdate({ callback_query: { id: 'cb1', from, data: 'link:' + token } });
    const me = await c.get('/api/me');
    assert.equal(me.body.user.tg_linked, true);
    assert.equal(me.body.user.tg_username, 'linker_tg');
    const ans = app.fakes.tgCalls('answerCallbackQuery').pop();
    assert.match(ans.params.text, /Linked/);

    // The token works once.
    await app.platformUpdate({ callback_query: { id: 'cb2', from, data: 'link:' + token } });
    assert.match(app.fakes.tgCalls('answerCallbackQuery').pop().params.text, /expired/);

    // The same Telegram account can't be linked to a second Castvoo login.
    const other = await app.loginByEmail('linker2@example.com');
    const t2 = /link_(.+)$/.exec((await other.post('/api/me/telegram-link')).body.url)[1];
    await app.platformUpdate({ callback_query: { id: 'cb3', from, data: 'link:' + t2 } });
    assert.match(app.fakes.tgCalls('answerCallbackQuery').pop().params.text, /already linked/);
    assert.equal((await other.get('/api/me')).body.user.tg_linked, false);
  });

  it('platform webhook needs the secret header', async () => {
    const r = await app.platformUpdate({ message: { chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '/start' } }, { secret: 'wrong' });
    assert.equal(r.status, 401);
  });

  it('link Telegram with the widget; already-linked accounts are refused', async () => {
    const c = await app.loginByEmail('widgetlink@example.com');
    const f = { id: 8080, first_name: 'W', username: 'wl', auth_date: Math.floor(Date.now() / 1000) };
    const r = await c.post('/api/me/telegram', { ...f, hash: telegramLoginHash(app.platformBotToken, f) });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.tg_linked, true);
    const d = await app.loginByEmail('widgetlink2@example.com');
    const r2 = await d.post('/api/me/telegram', { ...f, hash: telegramLoginHash(app.platformBotToken, f) });
    assert.equal(r2.status, 409);
  });
});

describe('VooSquare login (Voo Connect kit)', () => {
  it('signs up through VooSquare with prompt=signup and a verified id_token, with the country it sends, and logs out of both', async () => {
    const c = app.client();
    app.fakes.voo.nextUser = { voo_id: 'vs_login1', email: 'VSLogin@Example.com', name: 'Vee Ess', country: 'KE' };
    const s = await c.get('/auth/voosquare?signup=1');
    assert.equal(s.status, 302, s.text);
    const to = new URL(s.headers.get('location'));
    assert.equal(to.origin + to.pathname, app.fakes.base + '/voo/oauth/authorize');
    assert.equal(to.searchParams.get('client_id'), 'cv-client');
    assert.equal(to.searchParams.get('prompt'), 'signup');
    assert.equal(to.searchParams.get('redirect_uri'), app.url + '/auth/voosquare/callback');
    const back = await fetch(to, { redirect: 'manual' });
    const cb = new URL(back.headers.get('location'));
    const r = await c.get(cb.pathname + cb.search);
    assert.equal(r.headers.get('location'), '/#signup/country');
    const me = (await c.get('/api/me')).body.user;
    assert.equal(me.email, 'vslogin@example.com');
    assert.equal(me.country, 'KE');
    assert.equal(me.voo_linked, true);
    assert.equal((await app.db.one("select voo_id from users where id = $1", [me.id])).voo_id, 'vs_login1');
    const out = await c.post('/api/auth/logout');
    assert.match(out.body.voosquare_logout_url, /\/voo\/oauth\/logout\?redirect_uri=/);
  });

  it('the old button address still works (it sends to /auth/voosquare)', async () => {
    const r = await app.client().get('/api/auth/voosquare/start?signup=1');
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/auth/voosquare?signup=1');
  });
});

describe('rate limits for logged-in people', () => {
  it('count per account, so customers sharing one mobile IP do not block each other', async () => {
    app.rl._reset();
    const a = await app.loginByEmail('nat-a@example.com', {});
    const b = await app.loginByEmail('nat-b@example.com', {});
    for (let i = 0; i < 20; i++) await a.post('/api/app/coupon', { code: 'NOPE' + i }, { ip: '100.64.1.1' });
    assert.equal((await a.post('/api/app/coupon', { code: 'NOPE' }, { ip: '100.64.1.1' })).status, 429);
    assert.equal((await b.post('/api/app/coupon', { code: 'NOPE' }, { ip: '100.64.1.1' })).status, 400, 'B is not blocked by A');
  });
});

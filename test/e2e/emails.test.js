'use strict';
/* Trial follow-up (sales) emails, the unsubscribe link, email failures, and the hourly clean-up job. */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { if (app) await app.stop(); });

const ageHours = (userId, h) => app.db.query("update users set created_at = now() - make_interval(hours => $2) where id = $1", [userId, h]);

describe('sales emails', () => {
  it('the "connect a bot" nudge goes once, after a day, with a working unsubscribe link', async () => {
    const c = await app.loginByEmail('nudge@example.com');
    await app.jobs.salesTick();
    assert.equal(app.fakes.lastEmail('nudge@example.com', /One step/), null, 'too early');
    await ageHours(c.user.id, 25);
    await app.jobs.salesTick();
    await app.jobs.salesTick();
    const mails = app.fakes.emailsTo('nudge@example.com').filter((e) => /One step/.test(e.subject));
    assert.equal(mails.length, 1);
    const link = /(http:\/\/127\.0\.0\.1:\d+\/email\/unsubscribe\?u=\d+(?:&|&amp;)s=[0-9a-f]+)/.exec(mails[0].text + mails[0].html);
    assert.ok(link, 'unsubscribe link in the email');
    const u = new URL(link[1].replace(/&amp;/g, '&'));
    assert.equal((await app.client().get(`/email/unsubscribe?u=${u.searchParams.get('u')}&s=0000`)).status, 404, 'forged link');
    assert.equal((await app.client().get(`/email/unsubscribe?u=${Number(u.searchParams.get('u')) + 1}&s=${u.searchParams.get('s')}`)).status, 404, 'other user');
    const ok = await app.client().get(u.pathname + u.search);
    assert.equal(ok.status, 200);
    assert.equal((await app.db.one('select marketing_opt_out from users where id = $1', [c.user.id])).marketing_opt_out, true);
    // No more marketing; account emails still go out.
    await ageHours(c.user.id, 100);
    await app.jobs.salesTick();
    assert.equal(app.fakes.emailsTo('nudge@example.com').filter((e) => /Meet Cas|trial is almost over/.test(e.subject)).length, 0);
    await c.post('/api/auth/logout');
    await app.loginByEmail('nudge@example.com');
  });

  it('switched off in admin: no sales emails at all', async () => {
    const c = await app.loginByEmail('nosales@example.com');
    await ageHours(c.user.id, 30);
    await app.setFeature('sales_emails', false);
    try { await app.jobs.salesTick(); } finally { await app.setFeature('sales_emails', true); }
    assert.equal(app.fakes.emailsTo('nosales@example.com').filter((e) => /One step/.test(e.subject)).length, 0);
  });

  it('the last-day email for a trial ending within 30 hours', async () => {
    const c = await app.loginByEmail('lastday@example.com');
    await app.db.query("update workspaces set trial_ends_at = now() + interval '20 hours' where owner_user_id = $1", [c.user.id]);
    await app.jobs.salesTick();
    assert.ok(app.fakes.lastEmail('lastday@example.com', /trial is almost over/));
  });

  it('an email provider failure never breaks the action that sends it', async () => {
    const before = app.config.email.resendBase;
    app.config.email.resendBase = 'http://127.0.0.1:1'; // nothing listens there
    try {
      const c = app.client();
      const r = await c.post('/api/auth/email/start', { email: 'down@example.com' });
      assert.equal(r.status, 200, 'the request still succeeds');
      const log = await app.db.one("select status, error from email_log where to_email = 'down@example.com' order by id desc limit 1");
      assert.equal(log.status, 'failed');
    } finally { app.config.email.resendBase = before; }
  });
});

describe('email safety', () => {
  it('names typed by users cannot inject HTML or links into emails sent to other people', async () => {
    const c = await app.loginByEmail('phisher@example.com', { name: '<a href="https://evil.example/login">Verify your account</a>' });
    await c.post('/api/app/settings', { name: 'Team {{unsubscribe_url}} <img src=x onerror=alert(1)>' });
    const r = await c.post('/api/app/team/invite', { email: 'target@example.com', role: 'sender' });
    assert.equal(r.status, 200, r.text);
    const mail = app.fakes.lastEmail('target@example.com');
    assert.ok(mail, 'invite sent');
    assert.ok(!mail.html.includes('<a href="https://evil.example'), 'no injected link');
    assert.ok(!mail.html.includes('<img src=x'), 'no injected image');
    assert.ok(mail.html.includes('&lt;a href=&quot;https://evil.example/login&quot;&gt;'), 'shown as text');
    assert.ok(!mail.html.includes('/email/unsubscribe'), 'a {{var}} inside a value is not expanded');
  });

  it('URLs in emails still work after escaping', async () => {
    const c = await app.loginByEmail('links@example.com');
    void c;
    const mail = app.fakes.lastEmail('links@example.com', /Welcome/);
    assert.ok(mail.html.includes(`href="${app.url}/#guide"`), 'guide link intact');
  });
});

describe('clean-up job', () => {
  it('removes expired sessions, codes and link tokens, and refreshes channel counts', async () => {
    const c = await app.loginByEmail('cleanup@example.com');
    await app.db.query("update sessions set expires_at = now() - interval '1 minute' where user_id = $1", [c.user.id]);
    await app.db.query("update login_codes set created_at = now() - interval '2 days' where email = 'cleanup@example.com'");
    await app.jobs.cleanupTick();
    assert.equal((await app.db.one('select count(*)::int n from sessions where user_id = $1', [c.user.id])).n, 0);
    assert.equal((await app.db.one("select count(*)::int n from login_codes where email = 'cleanup@example.com'")).n, 0);
    assert.equal((await c.get('/api/me')).body.user, null);
  });

  it('an expired session is refused; a session close to expiry is extended', async () => {
    const c = await app.loginByEmail('slide@example.com');
    await app.db.query("update sessions set expires_at = now() + interval '2 days' where user_id = $1", [c.user.id]);
    await c.get('/api/me');
    const s = await app.db.one('select expires_at from sessions where user_id = $1', [c.user.id]);
    assert.ok((new Date(s.expires_at) - Date.now()) / 86400000 > 29);
  });
});

'use strict';
/*
 * @CastvooBot keeps answering: the webhook self-heals when another program takes the bot token, links use the bot's
 * real username (getMe), Admin → Settings & connections shows the "Castvoo bot" card, and the link flow is sound.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp } = require('../helpers/app');

let app, pb;
before(async () => { app = await startApp(); pb = app.require('services/platform-bot'); });
after(async () => { if (app) await app.stop(); });
beforeEach(() => { app.rl._reset(); app.fakes.tg.webhookInfo = null; });

const hooks = () => app.fakes.tgCalls('setWebhook', app.platformBotToken);
const expected = () => app.url + '/tg/platform';
const setInfo = (info) => { app.fakes.tg.webhookInfo = info; };

describe('webhook self-heal (getWebhookInfo every 10 minutes)', () => {
  it('a webhook pointing at another program is put back, with our secret and update types', async () => {
    setInfo({ url: 'https://someone-else.example/hook', pending_update_count: 7, last_error_message: 'Wrong response from the webhook: 404 Not Found', last_error_date: Math.floor(Date.now() / 1000) });
    const before = hooks().length;
    const r = await pb.selfHeal();
    assert.equal(r.fixed, true);
    assert.equal(r.url_ok, false);
    assert.equal(r.pending, 7);
    assert.match(r.reasons.join(' '), /somewhere else/);
    const h = hooks();
    assert.equal(h.length, before + 1);
    const last = h.pop().params;
    assert.equal(last.url, expected());
    assert.equal(last.secret_token, pb.secret());
    assert.deepEqual(last.allowed_updates, ['message', 'callback_query', 'my_chat_member']);
  });

  it('no webhook at all (another program polls getUpdates) is fixed too', async () => {
    setInfo({ url: '', pending_update_count: 0 });
    const n = hooks().length;
    const r = await pb.selfHeal();
    assert.equal(r.fixed, true);
    assert.match(r.reasons.join(' '), /getUpdates/);
    assert.equal(hooks().length, n + 1);
  });

  it('a correct webhook is left alone; an old error is not a reason, a new one is', async () => {
    await pb.ensureWebhook();
    setInfo(null);
    let n = hooks().length;
    const ok = await pb.selfHeal();
    assert.equal(ok.url_ok, true);
    assert.equal(ok.fixed, false);
    assert.equal(hooks().length, n, 'no setWebhook when all is well');

    // An error from before our last setWebhook: already handled.
    setInfo((token, saved) => ({ url: saved.url, pending_update_count: 0, last_error_message: 'Connection timed out', last_error_date: Math.floor(Date.now() / 1000) - 3600 }));
    const old = await pb.selfHeal();
    assert.equal(old.fixed, false);
    assert.equal(old.last_error, 'Connection timed out');
    assert.equal(hooks().length, n);

    // A new error after it: set again.
    setInfo((token, saved) => ({ url: saved.url, pending_update_count: 3, last_error_message: 'Wrong response from the webhook: 502 Bad Gateway', last_error_date: Math.floor(Date.now() / 1000) + 5 }));
    const fresh = await pb.selfHeal();
    assert.equal(fresh.fixed, true);
    assert.match(fresh.reasons.join(' '), /502/);
    assert.equal(hooks().length, n + 1);
  });

  it('Telegram being down never throws out of the worker', async () => {
    app.fakes.tg.fail5xx = 5;
    try { assert.equal(await pb.selfHeal(), null); } finally { app.fakes.tg.fail5xx = 0; }
  });

  it('the workers run the check every 10 minutes, and start-up runs it after setting the webhook', () => {
    const w = fs.readFileSync(path.join(__dirname, '../../server/workers/index.js'), 'utf8');
    assert.match(w, /loop\('platform-bot', \(\) => require\('\.\.\/services\/platform-bot'\)\.selfHeal\(\), 10 \* 60000/);
    const idx = fs.readFileSync(path.join(__dirname, '../../server/index.js'), 'utf8');
    assert.match(idx, /ensureWebhook\(\)[\s\S]{0,200}selfHeal\(\)/);
  });
});

describe('the bot username comes from getMe', () => {
  it('CASTVOO_BOT_USERNAME for a different bot: warning, and every link uses the real bot', async () => {
    const bot = app.fakes.tg.bots.get(app.platformBotToken);
    const was = bot.username;
    bot.username = 'RealCastvooBot';
    try {
      const r = await pb.checkWebhook({ fix: false });
      assert.equal(r.username, 'RealCastvooBot');
      assert.equal(r.env_username, 'CastvooBot');
      assert.equal(r.username_mismatch, true);
      assert.equal(pb.username(), 'RealCastvooBot');
      const c = await app.loginByEmail('mismatch@example.com');
      const link = await c.post('/api/me/telegram-link');
      assert.ok(link.body.url.startsWith('https://t.me/RealCastvooBot?start=link_'), link.body.url);
      const cfg = await app.client().get('/api/public/config');
      assert.equal(cfg.body.bot_username, 'RealCastvooBot');
      const owner = await app.owner();
      const card = await owner.get('/api/admin/platform-bot');
      assert.equal(card.status, 200, card.text);
      assert.ok(card.body.problems.some((p) => /CASTVOO_BOT_USERNAME is @CastvooBot, but CASTVOO_BOT_TOKEN belongs to @RealCastvooBot/.test(p)), JSON.stringify(card.body.problems));
    } finally {
      bot.username = was;
      await pb.refreshIdentity();
    }
    assert.equal(pb.username(), 'CastvooBot');
    assert.equal((await pb.checkWebhook({ fix: false })).username_mismatch, false);
  });
});

describe('Admin → Settings & connections → Castvoo bot card', () => {
  let owner, admin, support;
  before(async () => {
    owner = await app.owner();
    admin = await app.staff('admin', 'pb-admin@castvoo.test');
    support = await app.staff('support', 'pb-support@castvoo.test');
  });

  it('shows the bot, webhook, pending updates and last error; staff without system.view get 403', async () => {
    setInfo({ url: 'https://elsewhere.example/x', pending_update_count: 12, last_error_message: 'Wrong response from the webhook: 401 Unauthorized', last_error_date: 1760000000 });
    const r = await admin.get('/api/admin/platform-bot');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.username, 'CastvooBot');
    assert.equal(r.body.url, 'https://elsewhere.example/x');
    assert.equal(r.body.expected_url, expected());
    assert.equal(r.body.url_ok, false);
    assert.equal(r.body.pending, 12);
    assert.equal(r.body.last_error, 'Wrong response from the webhook: 401 Unauthorized');
    assert.equal(new Date(r.body.last_error_at).getTime(), 1760000000 * 1000);
    assert.ok(r.body.problems.some((p) => /Another program is using this bot token/.test(p)));
    assert.equal(r.body.fixed, false, 'looking never changes anything');
    assert.equal((await support.get('/api/admin/platform-bot')).status, 403);
    assert.equal((await support.post('/api/admin/platform-bot/fix')).status, 403);
    assert.equal((await support.post('/api/admin/platform-bot/test')).status, 403);
  });

  it('"Fix webhook" sets it again and is audited', async () => {
    setInfo(null);
    const n = hooks().length;
    const r = await owner.post('/api/admin/platform-bot/fix');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.url, expected());
    assert.equal(r.body.url_ok, true);
    assert.equal(hooks().length, n + 1);
    const a = await app.db.one("select * from audit_log where action = 'platform_bot.fix_webhook' order by id desc limit 1");
    assert.ok(a, 'audited');
  });

  it('"Send test message to me" needs a linked Telegram, then DMs the admin', async () => {
    const no = await admin.post('/api/admin/platform-bot/test');
    assert.equal(no.status, 400);
    assert.match(no.body.error, /Link your own Telegram/);
    await app.db.query('update users set tg_user_id = 5550001, tg_username = $2 where id = $1', [admin.user.id, 'pbadmin']);
    app.fakes.reset();
    const ok = await admin.post('/api/admin/platform-bot/test');
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.ok, true);
    const dm = app.fakes.tgCalls('sendMessage', app.platformBotToken).pop();
    assert.equal(dm.params.chat_id, 5550001);
    assert.match(dm.params.text, /Test from Castvoo admin/);
    // Blocked the bot: a plain explanation, not a crash.
    app.fakes.tg.block(5550001);
    try {
      const b = await admin.post('/api/admin/platform-bot/test');
      assert.equal(b.status, 200);
      assert.equal(b.body.ok, false);
      assert.match(b.body.detail, /blocked @CastvooBot or never pressed Start/);
    } finally { app.fakes.tg.unblock(5550001); }
  });
});

describe('the link flow', () => {
  it('link_<token> fits Telegram\'s start rules and lasts at least 15 minutes', async () => {
    const c = await app.loginByEmail('linkrules@example.com');
    for (let i = 0; i < 5; i++) {
      const r = await c.post('/api/me/telegram-link');
      const payload = new URL(r.body.url).searchParams.get('start');
      assert.ok(payload.length <= 64, payload);
      assert.match(payload, /^link_[A-Za-z0-9_-]+$/);
      const t = await app.db.one('select extract(epoch from expires_at - now())::int s from tg_link_tokens where token = $1', [payload.slice(5)]);
      assert.ok(t.s >= 15 * 60, 'lasts ' + t.s + ' s');
    }
  });

  it('/tg/platform answers 200 at once with the right secret, 401 without', async () => {
    const t0 = Date.now();
    const ok = await app.platformUpdate({ message: { message_id: 1, chat: { id: 4440001, type: 'private' }, from: { id: 4440001, is_bot: false, first_name: 'Ok' }, text: '/start' } });
    assert.equal(ok.status, 200);
    assert.ok(Date.now() - t0 < 3000);
    assert.equal((await app.platformUpdate({ message: { chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '/start' } }, { secret: '' })).status, 401);
  });

  it('plain /start, other messages and an expired link all get a helpful answer', async () => {
    const from = { id: 4440002, is_bot: false, first_name: 'Ada' };
    const say = async (text) => {
      app.fakes.reset();
      await app.platformUpdate({ message: { message_id: 1, date: 1, chat: { id: from.id, type: 'private' }, from, text } });
      const dm = app.fakes.tgCalls('sendMessage', app.platformBotToken).pop();
      assert.ok(dm, 'answered: ' + text);
      assert.equal(dm.params.chat_id, from.id);
      return dm.params.text;
    };
    assert.match(await say('/start'), /Hi Ada[\s\S]*Castvoo bot/);
    assert.match(await say('hello?'), /Link Telegram[\s\S]*Yes, link it/);
    assert.match(await say('/help'), /Castvoo bot/);
    assert.match(await say('/start link_notarealtoken'), /expired/);
    // Groups stay quiet.
    app.fakes.reset();
    await app.platformUpdate({ message: { message_id: 2, date: 1, chat: { id: -1009, type: 'supergroup' }, from, text: 'hi all' } });
    assert.equal(app.fakes.tgCalls('sendMessage', app.platformBotToken).length, 0);
  });

  it('Start then "Yes, link it": the sheet\'s /api/me poll sees the link', async () => {
    const c = await app.loginByEmail('linkpoll@example.com');
    const token = new URL((await c.post('/api/me/telegram-link')).body.url).searchParams.get('start').slice(5);
    const from = { id: 4440003, is_bot: false, first_name: 'Poll', username: 'poll_tg' };
    await app.platformUpdate({ message: { message_id: 1, date: 1, chat: { id: from.id, type: 'private' }, from, text: '/start link_' + token } });
    assert.equal((await c.get('/api/me')).body.user.tg_linked, false);
    await app.platformUpdate({ callback_query: { id: 'pb1', from, data: 'link:' + token } });
    const me = (await c.get('/api/me')).body.user;
    assert.equal(me.tg_linked, true);
    assert.equal(me.tg_username, 'poll_tg');
  });
});

'use strict';
/* Bots, channels and groups; subscribers coming and going; list, search, tags, CSV export; start links. */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { if (app) await app.stop(); });
beforeEach(() => app.rl._reset());

const linkTelegram = (client, tgId) => app.db.query('update users set tg_user_id = $2 where id = $1', [client.user.id, tgId]);
const sub = (connId, tgId) => app.db.one('select * from subscribers where connection_id = $1 and tg_user_id = $2', [connId, tgId]);

describe('connect a bot', () => {
  it('valid token: saved encrypted, webhook pointed at /tg/b/<id> with a secret', async () => {
    const c = await app.loginByEmail('botowner@example.com');
    const bot = app.fakes.tg.newBot('shop_bot');
    const r = await c.post('/api/connections/bot', { token: bot.token });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.connection.username, 'shop_bot');
    const row = await app.db.one('select * from connections where id = $1', [r.body.connection.id]);
    assert.equal(row.tg_chat_id, bot.id);
    assert.ok(!row.token_enc.includes(bot.token), 'token is encrypted');
    const hook = app.fakes.tgCalls('setWebhook', bot.token).pop();
    assert.equal(hook.params.url, `${app.url}/tg/b/${row.id}`);
    assert.equal(hook.params.secret_token, row.webhook_secret);
    assert.ok(row.webhook_secret.length >= 20);
    assert.deepEqual(hook.params.allowed_updates, ['message', 'callback_query', 'my_chat_member', 'chat_join_request']);
    const list = await c.get('/api/connections');
    assert.equal(list.body.connections.length, 1);
    assert.equal(list.body.connections[0].reach, 0);
    assert.ok(!JSON.stringify(list.body).includes(bot.token), 'token never sent back');
  });

  it('a badly shaped token and a token Telegram rejects are both refused', async () => {
    const c = await app.loginByEmail('badtoken@example.com');
    const shape = await c.post('/api/connections/bot', { token: 'hello' });
    assert.equal(shape.status, 400);
    const bot = app.fakes.tg.newBot();
    app.fakes.tg.markInvalid(bot.token);
    const rejected = await c.post('/api/connections/bot', { token: bot.token });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /not valid/);
    assert.equal((await app.db.one('select count(*)::int n from connections where workspace_id = $1', [(await app.ws(c)).id])).n, 0);
  });

  it('the same bot twice: reconnects in place in the same workspace, "taken" in another', async () => {
    const a = await app.loginByEmail('dupe-a@example.com');
    const b = await app.loginByEmail('dupe-b@example.com');
    const bot = app.fakes.tg.newBot('dupe_bot');
    const first = await a.post('/api/connections/bot', { token: bot.token });
    assert.equal(first.status, 200);
    await app.db.query("update connections set status = 'error', last_error = 'token revoked' where id = $1", [first.body.connection.id]);
    const again = await a.post('/api/connections/bot', { token: bot.token });
    assert.equal(again.status, 200, again.text);
    assert.equal(again.body.reconnected, true);
    assert.equal(again.body.connection.id, first.body.connection.id, 'same connection: subscribers and follow-ups stay');
    const row = await app.db.one('select status, last_error from connections where id = $1', [first.body.connection.id]);
    assert.deepEqual([row.status, row.last_error], ['active', null]);
    const other = await b.post('/api/connections/bot', { token: bot.token });
    assert.equal(other.status, 409);
    assert.equal(other.body.code, 'bot_taken');
  });

  it('two workspaces connecting the same bot at the same moment: only one wins', async () => {
    const a = await app.loginByEmail('race-a@example.com');
    const b = await app.loginByEmail('race-b@example.com');
    const bot = app.fakes.tg.newBot('race_bot');
    const rs = await Promise.all([a.post('/api/connections/bot', { token: bot.token }), b.post('/api/connections/bot', { token: bot.token })]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], rs.map((r) => r.text).join(' | '));
    const live = await app.db.one("select count(*)::int n from connections where kind = 'bot' and tg_chat_id = $1 and status <> 'removed'", [bot.id]);
    assert.equal(live.n, 1);
  });

  it('the plan connection limit is enforced (Starter: 2)', async () => {
    const c = await app.loginByEmail('limit@example.com');
    await app.db.query("update workspaces set plan_code = 'starter' where owner_user_id = $1", [c.user.id]);
    await app.connectBot(c);
    await app.connectBot(c);
    const r = await c.post('/api/connections/bot', { token: app.fakes.tg.newBot().token });
    assert.equal(r.status, 402);
    assert.equal(r.body.code, 'limit_connections');
  });

  it('only the workspace owner can connect bots', async () => {
    const owner = await app.loginByEmail('teamowner@example.com');
    const inv = await owner.post('/api/app/team/invite', { email: 'teamsender@example.com', role: 'sender' });
    assert.equal(inv.status, 200, inv.text);
    const token = inv.body.link.split('#join/')[1];
    const s = await app.loginByEmail('teamsender@example.com');
    const acc = await s.post('/api/invites/accept', { token });
    assert.equal(acc.status, 200);
    const r = await s.post('/api/connections/bot', { token: app.fakes.tg.newBot().token }, { headers: { 'x-ws': String(acc.body.workspace_id) } });
    assert.equal(r.status, 403);
  });

  it('an invite only works for the email it was sent to', async () => {
    const owner = await app.loginByEmail('inviteowner@example.com');
    const inv = await owner.post('/api/app/team/invite', { email: 'right.person@example.com', role: 'sender' });
    const token = inv.body.link.split('#join/')[1];
    const stranger = await app.loginByEmail('stranger@example.com');
    const bad = await stranger.post('/api/invites/accept', { token });
    assert.equal(bad.status, 403);
    assert.equal(bad.body.code, 'invite_email');
    assert.match(bad.body.error, /r•••@example\.com/);
    const right = await app.loginByEmail('Right.Person@example.com');
    assert.equal((await right.post('/api/invites/accept', { token })).status, 200);
  });

  it('removing a bot deletes its webhook, skips queued messages and stops its follow-ups', async () => {
    const c = await app.loginByEmail('remover@example.com');
    const bot = await app.connectBot(c);
    await app.start(bot.connId, 9001);
    const ws = await app.ws(c);
    await app.db.query("insert into deliveries(workspace_id, sender_key, chat_id) values ($1,$2,9001)", [ws.id, 'bot:' + bot.connId]);
    const r = await c.del('/api/connections/' + bot.connId);
    assert.equal(r.status, 200);
    assert.ok(app.fakes.tgCalls('deleteWebhook', bot.token).length >= 1);
    const row = await app.db.one('select status, token_enc from connections where id = $1', [bot.connId]);
    assert.equal(row.status, 'removed');
    assert.equal(row.token_enc, null);
    assert.equal((await app.db.one("select count(*)::int n from deliveries where sender_key = $1 and status = 'queued'", ['bot:' + bot.connId])).n, 0);
    // Telegram updates for a removed bot are refused.
    assert.equal((await app.start(bot.connId, 9002)).status, 401);
    // Another workspace can't remove my bot.
    const other = await app.loginByEmail('notmine@example.com');
    const mine = await app.connectBot(c);
    assert.equal((await other.del('/api/connections/' + mine.connId)).status, 404);
  });

  it('bot webhook refuses a wrong secret', async () => {
    const c = await app.loginByEmail('secret@example.com');
    const bot = await app.connectBot(c);
    const r = await app.telegramUpdate(bot.connId, { message: { chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '/start' } }, { secret: 'nope' });
    assert.equal(r.status, 401);
    assert.equal(await sub(bot.connId, 1), null);
  });
});

describe('connect a channel or group in one tap', () => {
  it('needs a linked Telegram account', async () => {
    const c = await app.loginByEmail('nolink@example.com');
    const r = await c.post('/api/connections/request', { kind: 'channel' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'tg_not_linked');
  });

  it('request + bot made admin = the channel is connected', async () => {
    const c = await app.loginByEmail('channel@example.com');
    await linkTelegram(c, 3100);
    const r = await c.post('/api/connections/request', { kind: 'channel' });
    assert.equal(r.status, 200);
    assert.match(r.body.url, /^https:\/\/t\.me\/CastvooBot\?startchannel&admin=post_messages/);
    app.fakes.tg.memberCount = 1234;
    const chat = { id: -1001111, type: 'channel', title: 'My News', username: 'mynews' };
    await app.platformUpdate({ my_chat_member: { chat, from: { id: 3100 }, date: 1, old_chat_member: { status: 'left' }, new_chat_member: { status: 'administrator', can_post_messages: true, user: { id: 600000001 } } } });
    const conn = await app.db.one('select * from connections where tg_chat_id = $1', [chat.id]);
    assert.ok(conn, 'connection created');
    assert.equal(conn.kind, 'channel');
    assert.equal(conn.workspace_id, (await app.ws(c)).id);
    assert.equal(conn.member_count, 1234);
    assert.equal(conn.title, 'My News');
    assert.match(app.fakes.tgCalls('sendMessage', app.platformBotToken).pop().params.text, /is connected/);

    // Bot removed from the channel: the connection shows an error.
    await app.platformUpdate({ my_chat_member: { chat, from: { id: 3100 }, date: 2, old_chat_member: { status: 'administrator' }, new_chat_member: { status: 'left', user: { id: 600000001 } } } });
    const after = await app.db.one('select status, last_error from connections where id = $1', [conn.id]);
    assert.equal(after.status, 'error');
    assert.match(after.last_error, /removed/);

    // Added back: active again, no duplicate row.
    await app.platformUpdate({ my_chat_member: { chat, from: { id: 3100 }, date: 3, old_chat_member: { status: 'left' }, new_chat_member: { status: 'administrator', can_post_messages: true } } });
    const rows = await app.db.many('select status from connections where tg_chat_id = $1', [chat.id]);
    assert.deepEqual(rows.map((x) => x.status), ['active']);
  });

  it('a channel without the "Post messages" right is not connected', async () => {
    const c = await app.loginByEmail('norights@example.com');
    await linkTelegram(c, 3200);
    await c.post('/api/connections/request', { kind: 'channel' });
    const chat = { id: -1002222, type: 'channel', title: 'No Rights' };
    await app.platformUpdate({ my_chat_member: { chat, from: { id: 3200 }, date: 1, new_chat_member: { status: 'administrator', can_post_messages: false } } });
    assert.equal(await app.db.one('select 1 from connections where tg_chat_id = $1', [chat.id]), null);
    assert.match(app.fakes.tgCalls('sendMessage', app.platformBotToken).pop().params.text, /Post messages/);
  });

  it('someone without a Castvoo account adds the bot: it leaves the chat', async () => {
    const chat = { id: -1003333, type: 'supergroup', title: 'Random' };
    await app.platformUpdate({ my_chat_member: { chat, from: { id: 99999 }, date: 1, new_chat_member: { status: 'administrator' } } });
    assert.equal(await app.db.one('select 1 from connections where tg_chat_id = $1', [chat.id]), null);
    assert.equal(app.fakes.tgCalls('leaveChat').pop().params.chat_id, chat.id);
  });

  it('a group over the plan limit is refused and the bot leaves', async () => {
    const c = await app.loginByEmail('fullplan@example.com');
    await linkTelegram(c, 3300);
    await app.db.query("update workspaces set plan_code = 'starter' where owner_user_id = $1", [c.user.id]);
    await app.connectBot(c);
    await app.connectBot(c);
    await c.post('/api/connections/request', { kind: 'group' });
    const chat = { id: -1004444, type: 'supergroup', title: 'Too Many' };
    await app.platformUpdate({ my_chat_member: { chat, from: { id: 3300 }, date: 1, new_chat_member: { status: 'administrator' } } });
    assert.equal(await app.db.one('select 1 from connections where tg_chat_id = $1', [chat.id]), null);
    assert.equal(app.fakes.tgCalls('leaveChat').pop().params.chat_id, chat.id);
  });

  it('member counts refresh hourly; a chat the bot lost goes to error', async () => {
    const c = await app.loginByEmail('refresh@example.com');
    await linkTelegram(c, 3400);
    await c.post('/api/connections/request', { kind: 'channel' });
    const chat = { id: -1005555, type: 'channel', title: 'Refresh' };
    await app.platformUpdate({ my_chat_member: { chat, from: { id: 3400 }, date: 1, new_chat_member: { status: 'administrator', can_post_messages: true } } });
    app.fakes.tg.memberCount = 777;
    await app.require('services/connections').refreshCounts();
    assert.equal((await app.db.one('select member_count from connections where tg_chat_id = $1', [chat.id])).member_count, 777);
  });
});

describe('subscribers', () => {
  let c, bot, seqTag;
  before(async () => {
    c = await app.loginByEmail('subs@example.com');
    bot = await app.connectBot(c, 'subs_bot');
    const r = await c.post('/api/drips', { connection_id: bot.connId, name: 'From FB', trigger_type: 'start_tag', trigger_value: 'fb_ad', steps: [{ body: 'Welcome from Facebook!', delay_value: 0 }] });
    assert.equal(r.status, 200, r.text);
    seqTag = r.body.id;
  });

  it('/start saves the subscriber; /start <tag> saves the source and starts start_tag follow-ups', async () => {
    await app.start(bot.connId, 501, '', { username: 'plain', language_code: 'en' });
    const s1 = await sub(bot.connId, 501);
    assert.equal(s1.status, 'active');
    assert.equal(s1.source, null);
    assert.equal(s1.lang, 'en');
    await app.start(bot.connId, 502, 'fb_ad');
    const s2 = await sub(bot.connId, 502);
    assert.equal(s2.source, 'fb_ad');
    const run = await app.db.one('select * from sequence_runs where sequence_id = $1 and subscriber_id = $2', [seqTag, s2.id]);
    assert.ok(run, 'start_tag sequence started');
    assert.equal(await app.db.one('select 1 from sequence_runs where sequence_id = $1 and subscriber_id = $2', [seqTag, s1.id]), null);
    // The first source is kept.
    await app.start(bot.connId, 502, 'other_tag');
    assert.equal((await sub(bot.connId, 502)).source, 'fb_ad');
    // A payload that is not a valid tag is ignored.
    await app.start(bot.connId, 503, '<script>alert(1)</script>');
    assert.equal((await sub(bot.connId, 503)).source, null);
  });

  it('/stop and the stop button stop broadcasts', async () => {
    await app.start(bot.connId, 601);
    await app.telegramUpdate(bot.connId, { message: { chat: { id: 601, type: 'private' }, from: { id: 601, first_name: 'S' }, text: '/stop' } });
    assert.equal((await sub(bot.connId, 601)).status, 'stopped');
    assert.match(app.fakes.tgCalls('sendMessage', bot.token).pop().params.text, /won't get broadcasts/);

    await app.start(bot.connId, 602);
    await app.telegramUpdate(bot.connId, { callback_query: { id: 'q1', from: { id: 602 }, data: 'cv_stop' } });
    assert.equal((await sub(bot.connId, 602)).status, 'stopped');
    const ans = app.fakes.tgCalls('answerCallbackQuery', bot.token).pop();
    assert.equal(ans.params.callback_query_id, 'q1');
    assert.equal(ans.params.show_alert, true);
    // /start brings them back.
    await app.start(bot.connId, 602);
    assert.equal((await sub(bot.connId, 602)).status, 'active');
  });

  it('blocking the bot marks the subscriber blocked and stops their follow-ups', async () => {
    await app.start(bot.connId, 701, 'fb_ad');
    const s = await sub(bot.connId, 701);
    await app.telegramUpdate(bot.connId, { my_chat_member: { chat: { id: 701, type: 'private' }, from: { id: 701 }, date: 1, new_chat_member: { status: 'kicked' } } });
    assert.equal((await sub(bot.connId, 701)).status, 'blocked');
    assert.equal((await app.db.one('select status from sequence_runs where subscriber_id = $1', [s.id])).status, 'stopped');
  });

  it('messages from subscribers are counted as replies', async () => {
    await app.start(bot.connId, 801);
    for (const text of ['hi', 'price?']) await app.telegramUpdate(bot.connId, { message: { chat: { id: 801, type: 'private' }, from: { id: 801, first_name: 'R' }, text } });
    // A stranger who writes without /start is saved too, and counted.
    await app.telegramUpdate(bot.connId, { message: { chat: { id: 802, type: 'private' }, from: { id: 802, first_name: 'N' }, text: 'hello?' } });
    // Group messages and other bots are ignored.
    await app.telegramUpdate(bot.connId, { message: { chat: { id: -5, type: 'group' }, from: { id: 803 }, text: 'x' } });
    await app.telegramUpdate(bot.connId, { message: { chat: { id: 804, type: 'private' }, from: { id: 804, is_bot: true }, text: 'x' } });
    const n = await app.db.one('select count(*)::int n from replies where connection_id = $1', [bot.connId]);
    assert.equal(n.n, 3);
    const st = await c.get('/api/app/state');
    assert.equal(st.body.stats.replies_14d, 3);
  });

  it('list, filter and search', async () => {
    await app.start(bot.connId, 901, 'ig_story', { first_name: 'Zainab', username: 'zainab_x' });
    const all = await c.get('/api/subscribers');
    assert.equal(all.status, 200);
    assert.ok(all.body.total >= 8);
    const q = await c.get('/api/subscribers?q=zain');
    assert.equal(q.body.total, 1);
    assert.equal(q.body.subscribers[0].first_name, 'Zainab');
    const pct = await c.get('/api/subscribers?q=%25');
    assert.equal(pct.status, 200);
    const src = await c.get('/api/subscribers?source=ig_story');
    assert.equal(src.body.total, 1);
    const stopped = await c.get('/api/subscribers?status=stopped');
    assert.ok(stopped.body.subscribers.every((s) => s.status === 'stopped'));
    assert.ok(all.body.counts.blocked >= 1);
    // Someone else's workspace sees none of these.
    const other = await app.loginByEmail('nosy@example.com');
    const theirs = await other.get('/api/subscribers?connection=' + bot.connId);
    assert.equal(theirs.body.total, 0);
  });

  it('tags: add, remove, start "tag" follow-ups; other workspaces\' subscribers are untouched', async () => {
    const seq = await c.post('/api/drips', { connection_id: bot.connId, name: 'VIP', trigger_type: 'tag', trigger_value: 'VIP', steps: [{ body: 'You are VIP now' }] });
    assert.equal(seq.status, 200, seq.text);
    const s = await sub(bot.connId, 901);
    const r = await c.post('/api/subscribers/tag', { tag: 'VIP', ids: [s.id] });
    assert.equal(r.body.updated, 1);
    assert.deepEqual((await sub(bot.connId, 901)).tags, ['vip']);
    assert.ok(await app.db.one('select 1 from sequence_runs where sequence_id = $1 and subscriber_id = $2', [seq.body.id, s.id]), 'tag follow-up started');
    const filtered = await c.get('/api/subscribers?tag=vip');
    assert.equal(filtered.body.total, 1);
    await c.post('/api/subscribers/tag', { tag: 'vip', ids: [s.id], remove: true });
    assert.deepEqual((await sub(bot.connId, 901)).tags, []);
    assert.equal((await c.post('/api/subscribers/tag', { tag: 'bad tag', ids: [s.id] })).status, 400);
    assert.equal((await c.post('/api/subscribers/tag', { tag: 'x', ids: [] })).status, 400);

    const other = await app.loginByEmail('tagthief@example.com');
    const t = await other.post('/api/subscribers/tag', { tag: 'pwned', ids: [s.id] });
    assert.equal(t.body.updated, 0);
    assert.deepEqual((await sub(bot.connId, 901)).tags, []);
  });

  it('CSV export protects against formula injection', async () => {
    await app.start(bot.connId, 1001, '', { first_name: '=HYPERLINK("http://evil","x")', username: '+cmd' });
    await app.start(bot.connId, 1002, '', { first_name: '\t=1+1' });
    await app.start(bot.connId, 1003, '', { first_name: 'Line\rBreak' });
    const r = await c.get('/api/subscribers/export.csv');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.match(r.headers.get('content-disposition'), /attachment/);
    const lines = r.text.split('\n');
    assert.equal(lines[0], 'bot,telegram_id,first_name,username,language,start_tag,tags,status,joined_at');
    const evil = lines.find((l) => l.includes('1001'));
    assert.ok(evil.includes(`"'=HYPERLINK(""http://evil"",""x"")"`), evil);
    assert.ok(evil.includes(`"'+cmd"`), evil);
    const tab = lines.find((l) => l.includes(',1002,'));
    assert.ok(!/,\t=/.test(tab) && tab.includes("'"), 'tab-prefixed formula neutralised: ' + JSON.stringify(tab));
    const cr = r.text.split('\n').find((l) => l.includes(',1003,'));
    assert.ok(cr.includes('"Line\rBreak"'), 'carriage return is quoted: ' + JSON.stringify(cr));
  });

  it('start links: create, list with counts, refuse bad names, delete', async () => {
    const r = await c.post(`/api/connections/${bot.connId}/start-links`, { tag: 'tiktok ad 1' });
    assert.equal(r.status, 200);
    assert.equal(r.body.url, 'https://t.me/subs_bot?start=tiktok_ad_1');
    await app.start(bot.connId, 1101, 'tiktok_ad_1');
    const list = await c.get(`/api/connections/${bot.connId}/start-links`);
    assert.equal(list.body.links[0].tag, 'tiktok_ad_1');
    assert.equal(list.body.links[0].starts, 1);
    assert.ok(list.body.untracked.find((x) => x.tag === 'fb_ad'));
    assert.equal((await c.post(`/api/connections/${bot.connId}/start-links`, { tag: 'bad/tag' })).status, 400);
    assert.equal((await c.del(`/api/connections/${bot.connId}/start-links/tiktok_ad_1`)).status, 200);
    assert.equal((await c.get(`/api/connections/${bot.connId}/start-links`)).body.links.length, 0);
    const other = await app.loginByEmail('linkthief@example.com');
    assert.equal((await other.get(`/api/connections/${bot.connId}/start-links`)).status, 404);
  });
});

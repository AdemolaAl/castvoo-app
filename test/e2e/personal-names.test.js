'use strict';
/* {name}: each bot subscriber sees their own first name. */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { if (app) await app.stop(); });
beforeEach(() => { app.rl._reset(); });

const sentTo = (token, chat) => app.fakes.tgCalls(null, token).filter((c) => /^send/.test(c.method) && c.params.chat_id === chat).map((c) => c.params.text || c.params.caption);

describe('personal messages', () => {
  it('the helpers: fill in, escape, fall back, count', () => {
    const tg = app.require('services/telegram');
    assert.equal(tg.personalize(tg.toHtml('Hi {name}!'), 'Tunde'), 'Hi Tunde!');
    assert.equal(tg.personalize(tg.toHtml('Hi {first_name}!'), 'Ada'), 'Hi Ada!');
    assert.equal(tg.personalize(tg.toHtml('Hi {NAME}!'), ''), 'Hi there!');
    assert.equal(tg.personalize(tg.toHtml('Hi {name|friend}!'), null), 'Hi friend!');
    assert.equal(tg.personalize(tg.toHtml('Hi {name}'), '<b>Bob & co</b>'), 'Hi &lt;b&gt;Bob &amp; co&lt;/b&gt;', 'names are escaped');
    assert.equal(tg.personalize(tg.toHtml('{name}'), 'A'.repeat(50)), 'A'.repeat(20), 'cut to 20');
    assert.equal(tg.personalize(tg.toHtml('*{name}*, hi'), 'Kemi'), '<b>Kemi</b>, hi', 'works inside bold');
    assert.equal(tg.personalize(tg.toHtml('{nam} {name'), 'X'), '{nam} {name', 'only the real tag');
    assert.equal(tg.visibleLength('Hi {name}'), 3 + 20, '{name} counts as the longest name');
  });

  it('a bot broadcast greets each person by their own name', async () => {
    const c = await app.loginByEmail('names@example.com');
    const bot = await app.connectBot(c);
    await app.start(bot.connId, 91001, '', { first_name: 'Tunde' });
    await app.start(bot.connId, 91002, '', { first_name: '<Ada>' });
    await app.start(bot.connId, 91003, '', { first_name: 'Nobody' });
    await app.db.query("update subscribers set first_name = '' where connection_id = $1 and tg_user_id = 91003", [bot.connId]);
    const r = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Hi {name}! *New drop* today.' });
    assert.equal(r.status, 200, r.text);
    await app.drain();
    assert.ok(sentTo(bot.token, 91001).includes('Hi Tunde! <b>New drop</b> today.'));
    assert.ok(sentTo(bot.token, 91002).includes('Hi &lt;Ada&gt;! <b>New drop</b> today.'));
    assert.ok(sentTo(bot.token, 91003).includes('Hi there! <b>New drop</b> today.'));
  });

  it('follow-ups use the name too; channel posts use the fallback word', async () => {
    const c = await app.loginByEmail('names2@example.com');
    const bot = await app.connectBot(c);
    const d = await c.post('/api/drips', { connection_id: bot.connId, name: 'Hello', trigger_type: 'start', steps: [{ body: 'Welcome {name} 👋', delay_value: 0, delay_unit: 'min' }] });
    assert.equal(d.status, 200, d.text);
    await app.start(bot.connId, 92001, '', { first_name: 'Wanjiku' });
    await app.jobs.dripsTick(); await app.drain();
    assert.ok(sentTo(bot.token, 92001).includes('Welcome Wanjiku 👋'), JSON.stringify(sentTo(bot.token, 92001)));

    const ws = await app.ws(c);
    const ch = await app.db.one("insert into connections(workspace_id, kind, tg_chat_id, title, member_count) values ($1,'channel',-100929292,'News',10) returning id", [ws.id]);
    const r = await c.post('/api/broadcasts', { connection_id: ch.id, body: 'Morning {name|everyone}!' });
    assert.equal(r.status, 200, r.text);
    await app.drain();
    assert.ok(sentTo(app.platformBotToken, -100929292).includes('Morning everyone!'));
  });

  it('the length check leaves room for long names', async () => {
    const c = await app.loginByEmail('names3@example.com');
    const bot = await app.connectBot(c);
    const tooLong = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'x'.repeat(4080) + ' {name}', draft: true });
    assert.equal(tooLong.status, 400);
    const ok = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'x'.repeat(4070) + ' {name}', draft: true });
    assert.equal(ok.status, 200, ok.text);
  });
});

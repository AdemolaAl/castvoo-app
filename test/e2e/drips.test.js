'use strict';
/* Auto follow-ups: triggers, timing, stopping, the join-request welcome, editing and switching off. */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { if (app) await app.stop(); });
beforeEach(() => { app.rl._reset(); app.fakes.tg.chatMember = null; });

const subOf = (connId, tg) => app.db.one('select * from subscribers where connection_id = $1 and tg_user_id = $2', [connId, tg]);
const runOf = (seq, subId) => app.db.one('select * from sequence_runs where sequence_id = $1 and subscriber_id = $2', [seq, subId]);
const dueNow = (seq) => app.db.query('update sequence_runs set due_at = now() where sequence_id = $1', [seq]);
const textsTo = (token, chat) => app.fakes.tgCalls(null, token).filter((c) => /^send/.test(c.method) && c.params.chat_id === chat).map((c) => c.params.text || c.params.caption);
async function tickAndSend() { await app.jobs.dripsTick(); await app.drain(); }

const THREE = [
  { body: 'Welcome!', delay_value: 0, delay_unit: 'min', buttons: [{ label: 'Start here', url: 'https://example.com/start' }] },
  { body: 'Hour later', delay_value: 1, delay_unit: 'hour' },
  { body: 'Two days later', delay_value: 2, delay_unit: 'day' },
];

describe('follow-ups', () => {
  let c, bot, seqId;
  before(async () => {
    c = await app.loginByEmail('drips@example.com');
    bot = await app.connectBot(c);
    const r = await c.post('/api/drips', { connection_id: bot.connId, name: 'Welcome series', trigger_type: 'start', steps: THREE });
    assert.equal(r.status, 200, r.text);
    seqId = r.body.id;
  });

  it('start trigger: each step goes out when due, in order, then the run is done', async () => {
    await app.start(bot.connId, 60001);
    const s = await subOf(bot.connId, 60001);
    let run = await runOf(seqId, s.id);
    assert.equal(run.next_position, 1);
    await tickAndSend();
    assert.deepEqual(textsTo(bot.token, 60001), ['Welcome!']);
    const first = app.fakes.tgCalls('sendMessage', bot.token).find((x) => x.params.chat_id === 60001);
    const kb = first.params.reply_markup.inline_keyboard;
    assert.match(kb[0][0].url, new RegExp(`/l/[a-z0-9]{7}\\?s=${s.id}\\.`));
    assert.equal(kb[1][0].callback_data, 'cv_stop');
    run = await runOf(seqId, s.id);
    assert.equal(run.next_position, 2);
    const wait = (new Date(run.due_at) - Date.now()) / 60000;
    assert.ok(wait > 58 && wait <= 60.1, 'next step in 1 hour, got ' + wait);
    // Not due yet: nothing happens.
    await tickAndSend();
    assert.equal(textsTo(bot.token, 60001).length, 1);
    await dueNow(seqId);
    await tickAndSend();
    run = await runOf(seqId, s.id);
    assert.ok((new Date(run.due_at) - Date.now()) / 86400000 > 1.99, 'third step two days after the second');
    await dueNow(seqId);
    await tickAndSend();
    assert.deepEqual(textsTo(bot.token, 60001), ['Welcome!', 'Hour later', 'Two days later']);
    assert.equal((await runOf(seqId, s.id)).status, 'done');
    // A second /start does not start it again.
    await app.start(bot.connId, 60001);
    await dueNow(seqId);
    await tickAndSend();
    assert.equal(textsTo(bot.token, 60001).length, 3);
    const list = await c.get('/api/drips');
    const seq = list.body.sequences.find((q) => q.id === seqId);
    assert.equal(seq.steps[0].sent, 1);
    assert.equal(seq.people, 1);
  });

  it('blocking the bot or /stop stops the follow-up', async () => {
    await app.start(bot.connId, 60002);
    await app.start(bot.connId, 60003);
    await tickAndSend();
    await app.telegramUpdate(bot.connId, { my_chat_member: { chat: { id: 60002, type: 'private' }, from: { id: 60002 }, date: 1, new_chat_member: { status: 'kicked' } } });
    await app.telegramUpdate(bot.connId, { message: { chat: { id: 60003, type: 'private' }, from: { id: 60003, first_name: 'X' }, text: '/stop' } });
    await dueNow(seqId);
    await tickAndSend();
    assert.equal(textsTo(bot.token, 60002).length, 1);
    assert.equal(textsTo(bot.token, 60003).filter((t) => t === 'Hour later').length, 0);
    assert.equal((await runOf(seqId, (await subOf(bot.connId, 60002)).id)).status, 'stopped');
  });

  it('a 403 while sending a step marks the person blocked and stops the run', async () => {
    await app.start(bot.connId, 60004);
    app.fakes.tg.block(60004);
    await tickAndSend();
    const s = await subOf(bot.connId, 60004);
    assert.equal(s.status, 'blocked');
    assert.equal((await runOf(seqId, s.id)).status, 'stopped');
  });

  it('switching a follow-up off pauses it; on again resumes it', async () => {
    await app.start(bot.connId, 60005);
    await tickAndSend();
    assert.equal((await c.post(`/api/drips/${seqId}/toggle`, { active: false })).body.active, false);
    await dueNow(seqId);
    await tickAndSend();
    assert.equal(textsTo(bot.token, 60005).length, 1, 'paused');
    // New people are not added while it is off.
    await app.start(bot.connId, 60006);
    assert.equal(await runOf(seqId, (await subOf(bot.connId, 60006)).id), null);
    await c.post(`/api/drips/${seqId}/toggle`, { active: true });
    await dueNow(seqId);
    await tickAndSend();
    assert.deepEqual(textsTo(bot.token, 60005), ['Welcome!', 'Hour later']);
    const other = await app.loginByEmail('drip-other@example.com');
    assert.equal((await other.post(`/api/drips/${seqId}/toggle`, { active: false })).status, 404);
  });

  it('editing keeps people where they are and their stats; removed steps finish their run', async () => {
    await app.start(bot.connId, 60007);
    await tickAndSend(); // step 1 sent, now waiting for step 2
    const s7 = await subOf(bot.connId, 60007);
    const stepsBefore = await app.db.many('select id, position from sequence_steps where sequence_id = $1 order by position', [seqId]);
    // Someone waiting for step 3:
    await app.start(bot.connId, 60008);
    await tickAndSend();
    const s8 = await subOf(bot.connId, 60008);
    await app.db.query('update sequence_runs set next_position = 3 where subscriber_id = $1', [s8.id]);
    const r = await c.put('/api/drips/' + seqId, { name: 'Welcome v2', trigger_type: 'start', steps: [THREE[0], { body: 'Hour later (new text)', delay_value: 1, delay_unit: 'hour' }] });
    assert.equal(r.status, 200, r.text);
    const stepsAfter = await app.db.many('select id, position from sequence_steps where sequence_id = $1 order by position', [seqId]);
    assert.deepEqual(stepsAfter.map((x) => x.id), stepsBefore.slice(0, 2).map((x) => x.id), 'step rows kept');
    assert.equal((await runOf(seqId, s7.id)).status, 'active');
    assert.equal((await runOf(seqId, s8.id)).status, 'done');
    await dueNow(seqId);
    await tickAndSend();
    assert.deepEqual(textsTo(bot.token, 60007), ['Welcome!', 'Hour later (new text)']);
    const list = await c.get('/api/drips');
    assert.equal(list.body.sequences.find((q) => q.id === seqId).steps[0].buttons.length, 1);
  });

  it('a paused plan holds follow-ups back', async () => {
    const ws = await app.ws(c);
    await app.start(bot.connId, 60009);
    await app.db.query("update workspaces set plan_status = 'paused' where id = $1", [ws.id]);
    try {
      await tickAndSend();
      assert.equal(textsTo(bot.token, 60009).length, 0);
      assert.ok(new Date((await runOf(seqId, (await subOf(bot.connId, 60009)).id)).due_at) > new Date());
    } finally { await app.db.query("update workspaces set plan_status = 'trial' where id = $1", [ws.id]); }
  });

  it('validation, roles and the feature switch', async () => {
    assert.equal((await c.post('/api/drips', { connection_id: bot.connId, name: 'x', trigger_type: 'start', steps: [] })).status, 400);
    assert.equal((await c.post('/api/drips', { connection_id: bot.connId, name: 'x', trigger_type: 'start', steps: Array(21).fill({ body: 'a' }) })).status, 400);
    assert.equal((await c.post('/api/drips', { connection_id: bot.connId, name: 'x', trigger_type: 'start', steps: [{ body: 'a', delay_unit: 'week' }] })).status, 400);
    assert.equal((await c.post('/api/drips', { connection_id: bot.connId, name: 'x', trigger_type: 'nope', steps: [{ body: 'a' }] })).status, 400);
    assert.equal((await c.post('/api/drips', { connection_id: bot.connId, name: 'x', trigger_type: 'start_tag', trigger_value: 'bad tag', steps: [{ body: 'a' }] })).status, 400);
    const other = await app.loginByEmail('drip-thief@example.com');
    assert.equal((await other.post('/api/drips', { connection_id: bot.connId, name: 'x', trigger_type: 'start', steps: [{ body: 'a' }] })).status, 400, 'someone else\'s bot');
    assert.equal((await other.put('/api/drips/' + seqId, { name: 'x', trigger_type: 'start', steps: [{ body: 'a' }] })).status, 404);
    assert.equal((await other.del('/api/drips/' + seqId)).status, 404);
    await app.setFeature('drips', false);
    try {
      assert.equal((await c.post('/api/drips', { connection_id: bot.connId, name: 'x', trigger_type: 'start', steps: [{ body: 'a' }] })).status, 403);
      await app.start(bot.connId, 60010);
      assert.equal(await runOf(seqId, (await subOf(bot.connId, 60010)).id), null, 'no new runs while off');
    } finally { await app.setFeature('drips', true); }
  });

  it('deleting a follow-up removes its runs', async () => {
    const r = await c.post('/api/drips', { connection_id: bot.connId, name: 'Temp', trigger_type: 'start', steps: [{ body: 'temp' }] });
    await app.start(bot.connId, 60011);
    assert.ok(await runOf(r.body.id, (await subOf(bot.connId, 60011)).id));
    assert.equal((await c.del('/api/drips/' + r.body.id)).status, 200);
    assert.equal((await app.db.one('select count(*)::int n from sequence_runs where sequence_id = $1', [r.body.id])).n, 0);
  });
});

describe('join-request welcome', () => {
  let c, bot, chanId, seqId;
  const CHAT = -1009900;
  before(async () => {
    c = await app.loginByEmail('joins@example.com');
    bot = await app.connectBot(c);
    const ws = await app.ws(c);
    chanId = (await app.db.one("insert into connections(workspace_id, kind, tg_chat_id, title) values ($1,'channel',$2,'VIP Channel') returning id", [ws.id, CHAT])).id;
  });

  it('the bot must be an admin of the channel with the invite right', async () => {
    app.fakes.tg.chatMember = { status: 'member' };
    const r = await c.post('/api/drips', { connection_id: bot.connId, name: 'Join', trigger_type: 'join_request', join_connection_id: chanId, steps: [{ body: 'Hi' }] });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'bot_not_admin');
    app.fakes.tg.chatMember = { status: 'administrator', can_invite_users: false };
    assert.equal((await c.post('/api/drips', { connection_id: bot.connId, name: 'Join', trigger_type: 'join_request', join_connection_id: chanId, steps: [{ body: 'Hi' }] })).status, 409);
    app.fakes.tg.chatMember = null;
    const call = app.fakes.tgCalls('getChatMember', bot.token).pop();
    assert.equal(call.params.chat_id, CHAT);
    assert.equal(call.params.user_id, bot.id);
  });

  it('welcome at once to user_chat_id, approve, and later steps wait for Start', async () => {
    const r = await c.post('/api/drips', {
      connection_id: bot.connId, name: 'Join', trigger_type: 'join_request', join_connection_id: chanId,
      steps: [{ body: 'Thanks for asking to join! Tap Start to get more.' }, { body: 'Day 1 tip', delay_value: 1, delay_unit: 'day' }],
    });
    assert.equal(r.status, 200, r.text);
    seqId = r.body.id;
    const list = await c.get('/api/drips');
    assert.equal(list.body.sequences.find((q) => q.id === seqId).join_chat.title, 'VIP Channel');

    await app.telegramUpdate(bot.connId, { chat_join_request: { chat: { id: CHAT, type: 'channel', title: 'VIP Channel' }, from: { id: 61001, first_name: 'Joiner' }, user_chat_id: 61001, date: Math.floor(Date.now() / 1000) } });
    assert.deepEqual(textsTo(bot.token, 61001), ['Thanks for asking to join! Tap Start to get more.']);
    const welcome = app.fakes.tgCalls('sendMessage', bot.token).find((x) => x.params.chat_id === 61001);
    assert.equal(welcome.params.reply_markup, undefined, 'no stop button on a join welcome');
    const approve = app.fakes.tgCalls('approveChatJoinRequest', bot.token).pop();
    assert.deepEqual([approve.params.chat_id, approve.params.user_id], [CHAT, 61001]);
    const s = await subOf(bot.connId, 61001);
    assert.equal(s.status, 'joinreq');
    assert.ok(await app.db.one("select 1 from deliveries where subscriber_id = $1 and status = 'sent'", [s.id]), 'welcome recorded');

    // Step 2 is due, but they have not pressed Start: it waits.
    await dueNow(seqId);
    await tickAndSend();
    assert.equal(textsTo(bot.token, 61001).length, 1);
    assert.ok(new Date((await runOf(seqId, s.id)).due_at) > new Date());
    // A broadcast does not reach join-request people either.
    const b = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Broadcast' });
    assert.equal(b.body.queued, 0);

    await app.start(bot.connId, 61001);
    assert.equal((await subOf(bot.connId, 61001)).status, 'active');
    await dueNow(seqId);
    await tickAndSend();
    assert.deepEqual(textsTo(bot.token, 61001), ['Thanks for asking to join! Tap Start to get more.', 'Day 1 tip']);
  });

  it('approve_join off: welcome only, no approval; requests for other chats are ignored', async () => {
    await c.put('/api/drips/' + seqId, { name: 'Join', trigger_type: 'join_request', join_connection_id: chanId, approve_join: false, steps: [{ body: 'Welcome (manual approval)' }] });
    const before = app.fakes.tgCalls('approveChatJoinRequest', bot.token).length;
    await app.telegramUpdate(bot.connId, { chat_join_request: { chat: { id: CHAT, type: 'channel' }, from: { id: 61002, first_name: 'J2' }, user_chat_id: 61002, date: 1 } });
    assert.deepEqual(textsTo(bot.token, 61002), ['Welcome (manual approval)']);
    assert.equal(app.fakes.tgCalls('approveChatJoinRequest', bot.token).length, before);
    await app.telegramUpdate(bot.connId, { chat_join_request: { chat: { id: -1000001, type: 'channel' }, from: { id: 61003, first_name: 'J3' }, user_chat_id: 61003, date: 1 } });
    assert.equal(textsTo(bot.token, 61003).length, 0);
  });

  it('join welcome switched off, or a paused plan: no welcome', async () => {
    await app.setFeature('join_welcome', false);
    try {
      await app.telegramUpdate(bot.connId, { chat_join_request: { chat: { id: CHAT, type: 'channel' }, from: { id: 61004, first_name: 'J4' }, user_chat_id: 61004, date: 1 } });
      assert.equal(textsTo(bot.token, 61004).length, 0);
    } finally { await app.setFeature('join_welcome', true); }
    const ws = await app.ws(c);
    await app.db.query("update workspaces set plan_status = 'paused' where id = $1", [ws.id]);
    try {
      await app.telegramUpdate(bot.connId, { chat_join_request: { chat: { id: CHAT, type: 'channel' }, from: { id: 61005, first_name: 'J5' }, user_chat_id: 61005, date: 1 } });
      assert.equal(textsTo(bot.token, 61005).length, 0);
    } finally { await app.db.query("update workspaces set plan_status = 'trial' where id = $1", [ws.id]); }
    await app.db.query("update workspaces set trial_ends_at = now() - interval '1 hour' where id = $1", [ws.id]);
    try {
      await app.telegramUpdate(bot.connId, { chat_join_request: { chat: { id: CHAT, type: 'channel' }, from: { id: 61006, first_name: 'J6' }, user_chat_id: 61006, date: 1 } });
      assert.equal(textsTo(bot.token, 61006).length, 0, 'trial over');
    } finally { await app.db.query("update workspaces set trial_ends_at = now() + interval '5 days' where id = $1", [ws.id]); }
  });
});

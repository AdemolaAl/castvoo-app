'use strict';
/* Support chat (customer and staff side), the VooSquare server API, and signed events to VooSquare. */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startApp } = require('../helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { if (app) await app.stop(); });
beforeEach(() => app.rl._reset());

const voo = (path, { method = 'GET', body, key = 'voo-service-key-123' } = {}) => fetch(app.url + path, {
  method, body: body ? JSON.stringify(body) : undefined,
  headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

describe('support chat', () => {
  let user, support, viewer, threadId;
  before(async () => {
    user = await app.loginByEmail('helpme@example.com', { name: 'Chidi Okafor' });
    support = await app.staff('support');
    viewer = await app.staff('viewer');
  });

  it('a customer writes; the team sees it as unread', async () => {
    const r = await user.post('/api/support', { body: 'My bot is not sending' });
    assert.equal(r.status, 200);
    threadId = r.body.thread_id;
    await user.post('/api/support', { body: 'Hello?' });
    const mine = await user.get('/api/support');
    assert.equal(mine.body.thread.id, threadId);
    assert.deepEqual(mine.body.messages.map((m) => m.body), ['My bot is not sending', 'Hello?']);
    const inbox = await support.get('/api/admin/support');
    const t = inbox.body.threads.find((x) => x.id === threadId);
    assert.equal(t.unread_staff, true);
    assert.equal(t.subject, 'My bot is not sending');
    assert.equal(t.last_message, 'Hello?');
    assert.ok(inbox.body.counts.unread >= 1);
    assert.equal((await user.post('/api/support', { body: '' })).status, 400);
  });

  it('staff reply is emailed; internal notes stay internal', async () => {
    const note = await support.post(`/api/admin/support/${threadId}/reply`, { body: 'Customer is on trial, check the webhook', internal: true });
    assert.equal(note.status, 200);
    const before = app.fakes.emailsTo('helpme@example.com').length;
    const r = await support.post(`/api/admin/support/${threadId}/reply`, { body: 'Hi Chidi, we fixed your webhook. Try again now!' });
    assert.equal(r.status, 200);
    const mails = app.fakes.emailsTo('helpme@example.com');
    assert.equal(mails.length, before + 1, 'only the real reply is emailed');
    assert.match(mails[mails.length - 1].subject, /replied to your support message/);
    assert.match(mails[mails.length - 1].text, /we fixed your webhook/);
    const st = await user.get('/api/app/state');
    assert.equal(st.body.support_unread, 1);
    const mine = await user.get('/api/support');
    assert.ok(!mine.body.messages.some((m) => /check the webhook/.test(m.body)), 'internal note hidden');
    assert.equal(mine.body.messages.pop().author_type, 'staff');
    assert.equal((await user.get('/api/app/state')).body.support_unread, 0, 'read now');
    const staffView = await support.get('/api/admin/support/' + threadId);
    assert.ok(staffView.body.messages.some((m) => m.internal && /check the webhook/.test(m.body)));
    assert.equal(staffView.body.thread.user_email, 'helpme@example.com');
    const exp = await user.get('/api/me/export');
    assert.ok(!exp.text.includes('check the webhook'), 'not in the data export either');
  });

  it('status and assignment', async () => {
    assert.equal((await support.post(`/api/admin/support/${threadId}/status`, { status: 'closed' })).status, 200);
    assert.equal((await support.post(`/api/admin/support/${threadId}/status`, { status: 'weird' })).status, 400);
    const ownerC = await app.owner();
    assert.equal((await support.post(`/api/admin/support/${threadId}/assign`, { user_id: ownerC.user.id })).status, 200);
    assert.equal((await support.post(`/api/admin/support/${threadId}/assign`, { user_id: user.user.id })).status, 400, 'not on the team');
    // A new message from the customer opens a new conversation after "closed".
    const again = await user.post('/api/support', { body: 'One more thing' });
    assert.notEqual(again.body.thread_id, threadId);
  });

  it('AI suggestion drafts a reply from the conversation', async () => {
    app.fakes.ai.text = 'Hi Chidi, here is what to do...';
    const r = await support.post(`/api/admin/support/${threadId}/suggest`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.text, 'Hi Chidi, here is what to do...');
    const call = app.fakes.ai.calls[app.fakes.ai.calls.length - 1];
    assert.match(call.messages[0].content, /Customer: My bot is not sending/);
    assert.ok(!call.messages[0].content.includes('check the webhook'), 'internal notes are not sent to the AI');
  });

  it('roles: viewer reads but cannot reply; marketing cannot read', async () => {
    assert.equal((await viewer.get('/api/admin/support')).status, 200);
    assert.equal((await viewer.post(`/api/admin/support/${threadId}/reply`, { body: 'x' })).status, 403);
    const marketing = await app.staff('marketing');
    assert.equal((await marketing.get('/api/admin/support')).status, 403);
    assert.equal((await user.get('/api/admin/support')).status, 403, 'customers are not staff');
  });

  it('support chat switched off', async () => {
    await app.setFeature('support_chat', false);
    try { assert.equal((await user.post('/api/support', { body: 'x' })).status, 403); } finally { await app.setFeature('support_chat', true); }
  });
});

describe('VooSquare API', () => {
  let vooUser, threadId;
  before(async () => {
    vooUser = await app.loginByEmail('voo@example.com', { name: 'Voo Person' });
    await app.db.query("update users set voo_id = 'voo_123' where id = $1", [vooUser.user.id]);
    const bot = await app.connectBot(vooUser);
    await app.start(bot.connId, 81001);
    await vooUser.post('/api/broadcasts', { connection_id: bot.connId, body: 'hi' });
    await app.flush();
    threadId = (await vooUser.post('/api/support', { body: 'Question from VooSquare user' })).body.thread_id;
  });

  it('needs the service key', async () => {
    assert.equal((await voo('/api/voosquare/summary?voo_id=voo_123', { key: null })).status, 401);
    assert.equal((await voo('/api/voosquare/summary?voo_id=voo_123', { key: 'wrong' })).status, 401);
    assert.equal((await voo('/api/voosquare/support/threads', { key: 'voo-service-key-12' })).status, 401);
  });

  it('summary: unknown voo_id is not linked; a linked user gets metrics', async () => {
    assert.deepEqual((await voo('/api/voosquare/summary?voo_id=nobody')).body, { tool: 'castvoo', linked: false });
    const r = await voo('/api/voosquare/summary?voo_id=voo_123&period=7d');
    assert.equal(r.status, 200);
    assert.equal(r.body.linked, true);
    assert.equal(r.body.status, 'trial');
    assert.equal(r.body.period, '7d');
    const m = Object.fromEntries(r.body.metrics.map((x) => [x.key, x]));
    assert.equal(m.messages_sent.value, 1);
    assert.equal(m.broadcasts.value, 1);
    assert.equal(m.subscribers.value, 1);
    for (const period of ['constructor', '__proto__', 'toString', 'x']) {
      const odd = await voo('/api/voosquare/summary?voo_id=voo_123&period=' + period);
      assert.equal(odd.status, 200, period);
      assert.equal(odd.body.period, '1d');
    }
  });

  it('threads: list, read (with internal notes), reply as VooSquare, status', async () => {
    const list = await voo('/api/voosquare/support/threads?status=all&q=voo@');
    assert.ok(list.body.threads.some((t) => t.id === threadId));
    assert.equal(list.body.threads.find((t) => t.id === threadId).voo_id, 'voo_123');
    assert.equal((await voo('/api/voosquare/support/threads?before=not-a-date')).status, 400);
    const one = await voo('/api/voosquare/support/threads/' + threadId);
    assert.equal(one.body.thread.id, threadId);
    const rep = await voo(`/api/voosquare/support/threads/${threadId}/reply`, { method: 'POST', body: { body: 'Answered from VooSquare', staff_name: 'Ada (VooSquare)' } });
    assert.equal(rep.status, 200);
    const msg = await app.db.one('select * from support_messages where thread_id = $1 order by id desc limit 1', [threadId]);
    assert.equal(msg.via, 'voosquare');
    assert.equal(msg.author_name, 'Ada (VooSquare)');
    assert.ok(app.fakes.lastEmail('voo@example.com', /Ada replied/));
    assert.equal((await voo(`/api/voosquare/support/threads/${threadId}/status`, { method: 'POST', body: { status: 'pending' } })).status, 200);
    assert.equal((await voo('/api/voosquare/support/threads/999999')).status, 404);
  });
});

describe('VooSquare events', () => {
  it('outbox events go to <VOO_BASE>/api/v1/events in one batch through the kit, with the API key, retries, stable ids and no customer details', async () => {
    await app.voosquare.flush(); // send what earlier tests queued
    const u = await app.loginByEmail('events@example.com');
    await app.db.query("update users set voo_id = 'voo_evt' where id = $1", [u.user.id]);
    await app.connectBot(u);
    await app.waitFor(async () => (await app.db.one("select count(*)::int n from outbox where payload->>'voo_id' = 'voo_evt'")).n === 1);
    app.fakes.voo.failNext = 1;
    await app.voosquare.flush();
    const failed = await app.db.many("select * from outbox where payload->>'voo_id' = 'voo_evt' order by id");
    assert.equal(failed.length, 1);
    assert.ok(failed.every((f) => f.attempts === 1 && f.sent_at === null), 'the batch is retried later');
    await app.db.query('update outbox set next_at = now() where sent_at is null');
    await app.voosquare.flush();
    const evs = app.fakes.voo.events.filter((e) => e.body.voo_id === 'voo_evt');
    assert.deepEqual(evs.map((e) => e.body.type).sort(), ['channel_connected']);
    for (const e of evs) {
      assert.match(e.body.event_id, /^cv_conn_\d+$/);
      assert.deepEqual(Object.keys(e.body).sort(), ['event_id', 'label', 'occurred_at', 'type', 'voo_id']);
      assert.ok(!e.raw.includes('events@example.com'));
    }
    assert.equal((await app.db.one("select count(*)::int n from outbox where payload->>'voo_id' = 'voo_evt' and sent_at is null")).n, 0);
    const plain = await app.loginByEmail('novoo@example.com');
    await app.connectBot(plain);
    assert.equal((await app.db.one("select count(*)::int n from outbox where kind = 'voosquare' and payload->>'voo_id' is null")).n, 0, 'nothing for people without a Voo ID');
  });
});

describe('VooSquare support link', () => {
  let user, threadId;
  before(async () => {
    user = await app.loginByEmail('hq@example.com', { name: 'Halima Quadri' });
    threadId = (await user.post('/api/support', { body: 'Can you help me connect my channel?' })).body.thread_id;
    await app.voosquare.flush();
  });

  it('a customer message is copied into the VooSquare HQ inbox with a stable reference', async () => {
    const m = app.fakes.voo.support.find((x) => x.external_ref === 'castvoo-' + threadId);
    assert.ok(m, 'forwarded');
    assert.equal(m.email, 'hq@example.com');
    assert.equal(m.body, 'Can you help me connect my channel?');
    await user.post('/api/support', { body: 'Second message' });
    await app.voosquare.flush();
    assert.equal(app.fakes.voo.support.filter((x) => x.external_ref === 'castvoo-' + threadId).length, 2, 'same conversation');
  });

  it('a reply written in VooSquare lands in the Castvoo conversation (VooSquare emails the customer itself)', async () => {
    const before = app.fakes.emails.length;
    assert.equal((await voo('/api/voosquare/support/webhook', { method: 'POST', key: 'wrong', body: {} })).status, 401);
    const r = await voo('/api/voosquare/support/webhook', { method: 'POST', key: 'voo-api-key-456', body: { type: 'support.reply', ticket_id: 't_1', external_ref: 'castvoo-' + threadId, email: 'hq@example.com', body: 'Tap Channels & bots, then Add a channel.', agent: 'Zara' } });
    assert.equal(r.status, 200);
    const msg = await app.db.one('select * from support_messages where thread_id = $1 order by id desc limit 1', [threadId]);
    assert.deepEqual([msg.author_type, msg.author_name, msg.via, msg.body], ['staff', 'Zara', 'voosquare', 'Tap Channels & bots, then Add a channel.']);
    assert.equal(app.fakes.emails.length, before, 'no second email');
    const mine = await user.get('/api/support');
    assert.ok(mine.body.messages.some((x) => x.author_name === 'Zara'));
    assert.equal((await voo('/api/voosquare/support/webhook', { method: 'POST', key: 'voo-api-key-456', body: { type: 'something.else' } })).body.ignored, true);
  });

  it('two-way desk: boxes, tickets, read, reply as a synced staff member, update, staff sync', async () => {
    const add = await voo('/api/voosquare/staff', { method: 'POST', body: { voo_id: 'vs_staff1', email: 'agent@zedapex.com', name: 'Agent Ade', role: 'support' } });
    assert.equal(add.status, 200);
    assert.equal(add.body.role, 'support');
    assert.equal((await app.db.one("select staff_role from users where voo_id = 'vs_staff1'")).staff_role, 'support');
    assert.equal((await voo('/api/voosquare/staff', { method: 'POST', body: { voo_id: 'vs_x', email: 'x@zedapex.com', role: 'owner' } })).status, 400, 'owner cannot be pushed');
    const ownerVoo = await app.db.one("update users set voo_id = 'vs_owner' where email = 'owner@castvoo.test' returning id");
    if (ownerVoo) assert.equal((await voo('/api/voosquare/staff', { method: 'POST', body: { voo_id: 'vs_owner', role: 'viewer' } })).status, 403);
    assert.ok((await voo('/api/voosquare/staff')).body.staff.some((s) => s.voo_id === 'vs_staff1'));
    assert.equal((await voo('/api/voosquare/support/boxes')).body.boxes[0].id, 'general');
    const list = await voo('/api/voosquare/support/tickets?status=active&q=hq@');
    const t = list.body.tickets.find((x) => x.ref === String(threadId));
    assert.ok(t && t.url.endsWith('/admin#support/' + threadId));
    const one = await voo('/api/voosquare/support/tickets/' + threadId);
    assert.ok(one.body.messages.length >= 3);
    const rep = await voo(`/api/voosquare/support/tickets/${threadId}/reply`, { method: 'POST', body: { voo_id: 'vs_staff1', text: 'Done for you.' } });
    assert.equal(rep.status, 200);
    const msg = await app.db.one('select * from support_messages where thread_id = $1 order by id desc limit 1', [threadId]);
    assert.deepEqual([msg.author_name, msg.via, msg.internal], ['Agent Ade', 'voosquare', false]);
    await voo(`/api/voosquare/support/tickets/${threadId}/reply`, { method: 'POST', body: { voo_id: 'vs_staff1', text: 'Internal: checked logs', note: true } });
    assert.equal((await user.get('/api/support')).body.messages.some((x) => /Internal/.test(x.body)), false, 'notes stay hidden from the customer');
    assert.equal((await voo(`/api/voosquare/support/tickets/${threadId}/update`, { method: 'POST', body: { status: 'solved', assignee_voo_id: 'vs_staff1' } })).status, 200);
    const th = await app.db.one('select t.status, u.voo_id from support_threads t left join users u on u.id = t.assigned_to where t.id = $1', [threadId]);
    assert.deepEqual([th.status, th.voo_id], ['closed', 'vs_staff1']);
    const mine = await voo('/api/voosquare/support/tickets?status=all&view=mine&voo_id=vs_staff1');
    assert.ok(mine.body.tickets.some((x) => x.ref === String(threadId)));
    assert.equal((await voo('/api/voosquare/staff', { method: 'POST', body: { voo_id: 'vs_staff1', active: false } })).body.removed, true);
    assert.equal((await app.db.one("select staff_role from users where voo_id = 'vs_staff1'")).staff_role, null);
  });
});

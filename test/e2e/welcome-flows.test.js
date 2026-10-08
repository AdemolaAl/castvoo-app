'use strict';
/*
 * Welcome Flows: templates, the builder API, plan limits and gating, the join-request runtime (welcome inside
 * Telegram's 5-minute window, the four approve modes, tap-to-start capture, later steps, conditions, A/B),
 * the Free plan's branding line, the join-request meter, trial → Free, idempotency, permissions and isolation.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { startApp } = require('../helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { if (app) await app.stop(); });
beforeEach(() => { app.rl._reset(); app.fakes.tg.chatMember = null; app.fakes.tg.joinError = null; });

let chatSeq = -1007700000;
let userSeq = 880000;
const nextUser = () => ++userSeq;

/** A logged-in customer with a connected bot and channel. plan: 'trial' (Growth) | 'free' | 'starter' | 'growth' | 'scale' */
async function setup(email, plan = 'trial') {
  const c = await app.loginByEmail(email);
  const bot = await app.connectBot(c);
  const ws = await app.ws(c);
  const chat = --chatSeq;
  const chanId = (await app.db.one("insert into connections(workspace_id, kind, tg_chat_id, title) values ($1,'channel',$2,'Promo Channel') returning id", [ws.id, chat])).id;
  if (plan !== 'trial') await setPlan(ws.id, plan);
  return { c, bot, ws, chat, chanId };
}
async function setPlan(wsId, code) {
  await app.db.query("update workspaces set plan_code = $2, plan_status = 'active', trial_ends_at = null, period_end = case when $2 = 'free' then null else now() + interval '20 days' end where id = $1", [wsId, code]);
}
const msg = (body, extra = {}) => ({ type: 'message', body, ...extra });
const wait = (value, unit = 'min') => ({ type: 'wait', value, unit });
const flowBody = (s, extra = {}) => ({ name: 'My flow', chat_id: s.chanId, bot_id: s.bot.connId, approve_mode: 'after_welcome', blocks: [msg('Hi {name}, welcome!')], ...extra });
async function joinRequest(s, userId, extra = {}) {
  return app.telegramUpdate(s.bot.connId, { chat_join_request: { chat: { id: s.chat, type: 'channel', title: 'Promo Channel' }, from: { id: userId, first_name: 'Ada', is_bot: false }, user_chat_id: userId, date: Math.floor(Date.now() / 1000), ...extra } });
}
const sendsTo = (token, chat) => app.fakes.tgCalls(null, token).filter((x) => /^send/.test(x.method) && x.params.chat_id === chat);
const textsTo = (token, chat) => sendsTo(token, chat).map((x) => x.params.text || x.params.caption);
const callsFor = (token, method, user) => app.fakes.tgCalls(method, token).filter((x) => x.params.user_id === user);
const jrOf = (userId) => app.db.one('select * from join_requests where tg_user_id = $1 order by id desc limit 1', [userId]);
async function live(s, body) {
  const r = await s.c.post('/api/flows', { ...body, active: true });
  assert.equal(r.status, 200, r.text);
  return r.body.id;
}
async function tickAndSend() { await app.jobs.dripsTick(); await app.drain(); }

describe('templates and the builder', () => {
  let s;
  before(async () => { s = await setup('wf-builder@example.com'); });

  it('lists templates and the plan, and creates a draft from a template', async () => {
    const list = await s.c.get('/api/flows');
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(list.body.templates.map((t) => t.key), ['simple', 'vip', 'tap', 'followup', 'gift']);
    assert.equal(list.body.flows.length, 0);
    assert.equal(list.body.chats[0].id, s.chanId);
    assert.ok(list.body.meter.limit > 0);
    for (const t of list.body.templates) for (const b of t.blocks) if (b.body) assert.doesNotMatch(b.body, /\d+%|guaranteed/i, 'no fake numbers in templates');
    const r = await s.c.post('/api/flows', { template: 'followup', chat_id: s.chanId, bot_id: s.bot.connId });
    assert.equal(r.status, 200, r.text);
    const f = (await s.c.get('/api/flows/' + r.body.id)).body.flow;
    assert.equal(f.active, false, 'templates start as drafts');
    assert.equal(f.name, 'Welcome + 3-day follow-up');
    assert.deepEqual(f.blocks.map((b) => b.type), ['message', 'wait', 'message', 'wait', 'message']);
    assert.deepEqual([f.blocks[1].value, f.blocks[1].unit, f.blocks[3].value, f.blocks[3].unit], [1, 'day', 2, 'day']);
    assert.equal(f.start_button, true);
    const vip = await s.c.post('/api/flows', { template: 'vip', chat_id: s.chanId, bot_id: s.bot.connId });
    assert.equal(vip.status, 200, 'a template button without a link yet is left out: ' + vip.text);
  });

  it('adds, reorders and deletes steps; step rows (and their stats) follow their content', async () => {
    const id = (await s.c.post('/api/flows', flowBody(s, { name: 'Steps', blocks: [msg('One'), wait(10), msg('Two'), wait(2, 'hour'), msg('Three')] }))).body.id;
    let f = (await s.c.get('/api/flows/' + id)).body.flow;
    const ids = Object.fromEntries(f.blocks.filter((b) => b.type === 'message').map((b) => [b.body, b.id]));
    const steps = await app.db.many('select position, delay_minutes, body from sequence_steps where sequence_id = $1 order by position', [id]);
    assert.deepEqual(steps.map((x) => [x.position, x.delay_minutes, x.body]), [[1, 0, 'One'], [2, 10, 'Two'], [3, 120, 'Three']]);
    // Reorder: Three before Two; delete nothing yet.
    let r = await s.c.put('/api/flows/' + id, flowBody(s, { name: 'Steps', blocks: [msg('One', { id: ids.One }), wait(1, 'day'), msg('Three', { id: ids.Three }), wait(5), msg('Two', { id: ids.Two })] }));
    assert.equal(r.status, 200, r.text);
    f = r.body.flow;
    assert.deepEqual(f.blocks.filter((b) => b.type === 'message').map((b) => [b.body, b.id]), [['One', ids.One], ['Three', ids.Three], ['Two', ids.Two]]);
    // Delete "Three" and add a new last step.
    r = await s.c.put('/api/flows/' + id, flowBody(s, { name: 'Steps', blocks: [msg('One', { id: ids.One }), wait(5), msg('Two', { id: ids.Two }), wait(1, 'hour'), msg('Four')] }));
    assert.equal(r.status, 200, r.text);
    const rows = await app.db.many('select id, position, body from sequence_steps where sequence_id = $1 order by position', [id]);
    assert.deepEqual(rows.map((x) => x.body), ['One', 'Two', 'Four']);
    assert.equal(rows.find((x) => x.body === 'Two').id, ids.Two);
    assert.equal(await app.db.one('select 1 from sequence_steps where id = $1', [ids.Three]), null);
    // Duplicate makes a draft copy with new rows.
    const d = await s.c.post(`/api/flows/${id}/duplicate`);
    assert.equal(d.status, 200, d.text);
    const copy = (await s.c.get('/api/flows/' + d.body.id)).body.flow;
    assert.equal(copy.name, 'Steps (copy)');
    assert.equal(copy.blocks.filter((b) => b.type === 'message').length, 3);
    assert.notEqual(copy.blocks[0].id, ids.One);
    assert.equal((await s.c.del('/api/flows/' + d.body.id)).status, 200);
  });

  it('validates blocks: starts with a message, no trailing wait, buttons 2 per row', async () => {
    const bad = async (blocks) => (await s.c.post('/api/flows', flowBody(s, { blocks }))).status;
    assert.equal(await bad([wait(5), msg('x')]), 400);
    assert.equal(await bad([msg('x'), wait(5)]), 400);
    assert.equal(await bad([]), 400);
    assert.equal(await bad([msg('')]), 400);
    assert.equal(await bad([msg('x', { buttons: [{ label: 'A', url: 'https://a.example', row: 0 }, { label: 'B', url: 'https://b.example', row: 0 }, { label: 'C', url: 'https://c.example', row: 0 }] })]), 400);
    assert.equal(await bad([msg('x', { condition: 'clicked' })]), 400, 'no condition on the welcome');
    const ok = await s.c.post('/api/flows', flowBody(s, { name: 'Rows', blocks: [msg('x', { buttons: [{ label: '🔥 A', url: 'https://a.example', row: 0 }, { label: 'B', url: 'https://b.example', row: 0 }, { label: 'C', url: 'https://c.example', row: 1 }] })] }));
    assert.equal(ok.status, 200, ok.text);
    const btns = (await s.c.get('/api/flows/' + ok.body.id)).body.flow.blocks[0].buttons;
    assert.deepEqual(btns.map((b) => [b.label, b.row]), [['🔥 A', 0], ['B', 0], ['C', 1]]);
    assert.ok(btns.every((b) => /^[a-z0-9]{7}$/.test(b.code)), 'tracked links');
  });

  it('the bot must be an admin with the invite right before a flow goes live', async () => {
    const id = (await s.c.post('/api/flows', flowBody(s, { name: 'Needs admin' }))).body.id;
    app.fakes.tg.chatMember = { status: 'member' };
    let r = await s.c.post(`/api/flows/${id}/toggle`, { active: true });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'bot_not_admin');
    assert.match(r.body.error, /Add members/);
    const chk = await s.c.post('/api/flows/check', { bot_id: s.bot.connId, chat_id: s.chanId });
    assert.equal(chk.body.ok, false);
    app.fakes.tg.chatMember = { status: 'administrator', can_invite_users: false };
    assert.equal((await s.c.post(`/api/flows/${id}/toggle`, { active: true })).status, 409);
    app.fakes.tg.chatMember = null;
    assert.equal((await s.c.post('/api/flows/check', { bot_id: s.bot.connId, chat_id: s.chanId })).body.ok, true);
    r = await s.c.post(`/api/flows/${id}/toggle`, { active: true });
    assert.equal(r.status, 200, r.text);
    // Only one live flow per channel: switching another one on asks first, then replaces.
    const other = (await s.c.post('/api/flows', flowBody(s, { name: 'Other' }))).body.id;
    r = await s.c.post(`/api/flows/${other}/toggle`, { active: true });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'flow_live_clash');
    r = await s.c.post(`/api/flows/${other}/toggle`, { active: true, replace: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.replaced, id);
    assert.equal((await app.db.one('select active from sequences where id = $1', [id])).active, false);
    await s.c.post(`/api/flows/${other}/toggle`, { active: false });
  });

  it('makes the flow\'s own invite link', async () => {
    const id = (await s.c.post('/api/flows', flowBody(s, { name: 'Link' }))).body.id;
    const r = await s.c.post(`/api/flows/${id}/invite-link`);
    assert.equal(r.status, 200, r.text);
    assert.match(r.body.invite_link, /^https:\/\/t\.me\/\+/);
    const call = app.fakes.tgCalls('createChatInviteLink', s.bot.token).pop();
    assert.equal(call.params.creates_join_request, true);
    assert.equal(call.params.chat_id, s.chat);
  });
});

describe('plan limits and gating', () => {
  it('Starter: 3 flows, 5 steps, no A/B or conditions', async () => {
    const s = await setup('wf-starter@example.com', 'starter');
    for (let i = 0; i < 3; i++) assert.equal((await s.c.post('/api/flows', flowBody(s, { name: 'F' + i }))).status, 200);
    const fourth = await s.c.post('/api/flows', flowBody(s, { name: 'F4' }));
    assert.equal(fourth.status, 402);
    assert.equal(fourth.body.code, 'limit_flows');
    const id = (await s.c.get('/api/flows')).body.flows[0].id;
    const six = [msg('1'), msg('2'), msg('3'), msg('4'), msg('5'), msg('6')];
    const r = await s.c.put('/api/flows/' + id, flowBody(s, { blocks: six }));
    assert.equal(r.status, 402);
    assert.equal(r.body.code, 'limit_flow_steps');
    assert.equal((await s.c.put('/api/flows/' + id, flowBody(s, { blocks: six.slice(0, 5) }))).status, 200);
    const ab = await s.c.put('/api/flows/' + id, flowBody(s, { blocks: [msg('A', { variants: [{ body: 'B' }] })] }));
    assert.equal(ab.status, 402);
    assert.equal(ab.body.code, 'plan_feature');
    assert.equal(ab.body.plan, 'growth');
    const cond = await s.c.put('/api/flows/' + id, flowBody(s, { blocks: [msg('A'), msg('B', { condition: 'not_clicked' })] }));
    assert.equal(cond.status, 402);
    assert.equal((await s.c.put('/api/flows/' + id, flowBody(s, { approve_mode: 'tap', blocks: [msg('A')] }))).status, 200, 'tap-to-join is on Starter');
  });

  it('Free: 1 flow with 1 message (photo or text, 3 buttons), auto-approve only, no broadcasts or Cas', async () => {
    const s = await setup('wf-free@example.com', 'free');
    const two = await s.c.post('/api/flows', flowBody(s, { blocks: [msg('Hi'), wait(1, 'day'), msg('Day 1')] }));
    assert.equal(two.status, 402);
    assert.equal(two.body.code, 'limit_flow_steps');
    assert.match(two.body.error, /1 welcome message/);
    const tap = await s.c.post('/api/flows', flowBody(s, { approve_mode: 'tap' }));
    assert.equal(tap.status, 402);
    assert.equal(tap.body.code, 'plan_feature');
    assert.equal((await s.c.post('/api/flows', flowBody(s, { start_button: true }))).status, 402);
    assert.equal((await s.c.post('/api/flows', flowBody(s, { approve_mode: 'manual' }))).status, 402);
    const four = [1, 2, 3, 4].map((i) => ({ label: 'B' + i, url: 'https://x.example/' + i }));
    assert.equal((await s.c.post('/api/flows', flowBody(s, { blocks: [msg('Hi', { buttons: four })] }))).status, 402);
    assert.equal((await s.c.post('/api/flows', flowBody(s, { blocks: [msg('x'.repeat(4080))] }))).status, 400, 'room for the Castvoo line');
    const ok = await s.c.post('/api/flows', flowBody(s, { blocks: [msg('Hi {name}', { buttons: four.slice(0, 3) })] }));
    assert.equal(ok.status, 200, ok.text);
    assert.equal((await s.c.post('/api/flows', flowBody(s, { name: 'second' }))).body.code, 'limit_flows');
    assert.equal((await s.c.post('/api/broadcasts', { connection_id: s.bot.connId, body: 'Hello' })).body.code, 'plan_feature');
    assert.equal((await s.c.post('/api/ai/write', { goal: 'a welcome' })).body.code, 'plan_feature');
    assert.equal((await s.c.post('/api/drips', { connection_id: s.bot.connId, name: 'x', trigger_type: 'start', steps: [{ body: 'a' }] })).body.code, 'plan_feature');
    // Free = 1 channel or group + its welcome bot.
    const extraBot = app.fakes.tg.newBot();
    const r = await s.c.post('/api/connections/bot', { token: extraBot.token });
    assert.equal(r.status, 402);
    assert.equal(r.body.code, 'limit_connections');
    const plan = (await s.c.get('/api/app/plan')).body;
    assert.equal(plan.free, true);
    assert.equal(plan.limits.join_requests, 500);
    assert.equal(plan.limits.flow_steps, 1);
  });

  it('Growth: A/B with 2 versions and conditions; 3 versions needs Scale', async () => {
    const s = await setup('wf-growth@example.com', 'growth');
    assert.equal((await s.c.post('/api/flows', flowBody(s, { blocks: [msg('A', { variants: [{ body: 'B' }] }), msg('C', { condition: 'clicked' })] }))).status, 200);
    const three = await s.c.post('/api/flows', flowBody(s, { blocks: [msg('A', { variants: [{ body: 'B' }, { body: 'C' }] })] }));
    assert.equal(three.status, 402);
    assert.equal(three.body.plan, 'scale');
    await setPlan(s.ws.id, 'scale');
    assert.equal((await s.c.post('/api/flows', flowBody(s, { blocks: [msg('A', { variants: [{ body: 'B' }, { body: 'C' }, { body: 'D' }] })] }))).status, 200);
    assert.equal((await s.c.post('/api/flows', flowBody(s, { blocks: [msg('A', { variants: [{ body: 'B' }, { body: 'C' }, { body: 'D' }, { body: 'E' }] })] }))).status, 400);
  });
});

describe('the join-request runtime', () => {
  let s;
  before(async () => { s = await setup('wf-runtime@example.com', 'growth'); });
  const use = async (extra) => {
    await app.db.query("update sequences set active = false where workspace_id = $1 and trigger_type = 'join_request'", [s.ws.id]);
    return live(s, flowBody(s, extra));
  };

  it('after the welcome (default): welcome to user_chat_id at once, then approve; no branding on paid plans', async () => {
    await use({ name: 'Default', blocks: [msg('Hi {name}, welcome!', { buttons: [{ label: 'Shop', url: 'https://shop.example', row: 0 }, { label: 'VIP', url: 'https://vip.example', row: 0 }] })] });
    const u = nextUser();
    const before = app.fakes.calls.length;
    await joinRequest(s, u);
    const mine = app.fakes.calls.slice(before).filter((x) => x.service === 'telegram' && (x.params.chat_id === u || x.params.user_id === u));
    assert.deepEqual(mine.map((x) => x.method), ['sendMessage', 'approveChatJoinRequest'], 'welcome first, then approve');
    assert.equal(mine[0].params.text, 'Hi Ada, welcome!');
    assert.doesNotMatch(mine[0].params.text, /Castvoo/);
    const kb = mine[0].params.reply_markup.inline_keyboard;
    assert.equal(kb.length, 1, 'two buttons side by side');
    assert.equal(kb[0].length, 2);
    assert.match(kb[0][0].url, /\/l\/[a-z0-9]{7}\?s=\d+\./);
    const jr = await jrOf(u);
    assert.deepEqual([jr.status, jr.welcome], ['approved', 'sent']);
    assert.ok(new Date(jr.welcomed_at) - new Date(jr.requested_at) < 60000, 'inside the 5-minute window');
  });

  it('after the welcome: if Telegram refuses the welcome they wait for the owner; instant lets them in anyway', async () => {
    const u = nextUser();
    app.fakes.tg.block(u);
    await joinRequest(s, u);
    let jr = await jrOf(u);
    assert.deepEqual([jr.status, jr.welcome], ['pending', 'failed']);
    assert.equal(callsFor(s.bot.token, 'approveChatJoinRequest', u).length, 0);
    await use({ name: 'Instant', approve_mode: 'instant' });
    const u2 = nextUser();
    app.fakes.tg.block(u2);
    await joinRequest(s, u2);
    jr = await jrOf(u2);
    assert.deepEqual([jr.status, jr.welcome], ['approved', 'failed']);
    const u3 = nextUser();
    await joinRequest(s, u3);
    assert.deepEqual([(await jrOf(u3)).status, (await jrOf(u3)).welcome], ['approved', 'sent']);
  });

  it('tap to join: the welcome has the Start button; pressing Start lets them in and captures them as a subscriber', async () => {
    await use({ name: 'Tap', approve_mode: 'tap', start_label: '✅ Tap to join' });
    const u = nextUser();
    await joinRequest(s, u);
    const w = sendsTo(s.bot.token, u)[0];
    const btn = w.params.reply_markup.inline_keyboard[0][0];
    assert.equal(btn.text, '✅ Tap to join');
    const code = new URL(btn.url).searchParams.get('start');
    assert.match(btn.url, new RegExp(`^https://t\\.me/${s.bot.username}\\?start=j_`));
    assert.equal(callsFor(s.bot.token, 'approveChatJoinRequest', u).length, 0, 'not yet');
    assert.equal((await jrOf(u)).status, 'pending');
    // Someone else can't use this person's code.
    await app.start(s.bot.connId, nextUser(), code);
    assert.equal((await jrOf(u)).status, 'pending');
    await app.start(s.bot.connId, u, code);
    const jr = await jrOf(u);
    assert.equal(jr.status, 'approved');
    assert.ok(jr.started_at);
    assert.equal(callsFor(s.bot.token, 'approveChatJoinRequest', u).length, 1);
    assert.match(textsTo(s.bot.token, u).pop(), /You're in/);
    const sub = await app.db.one('select status, source from subscribers where connection_id = $1 and tg_user_id = $2', [s.bot.connId, u]);
    assert.deepEqual([sub.status, sub.source], ['active', null], 'a subscriber now; the code is not saved as an ad tag');
  });

  it('manual: requests wait; the owner approves or declines in bulk', async () => {
    const id = await use({ name: 'Manual', approve_mode: 'manual' });
    const us = [nextUser(), nextUser(), nextUser()];
    for (const u of us) await joinRequest(s, u);
    for (const u of us) assert.equal(textsTo(s.bot.token, u).length, 1, 'welcome still sent');
    const list = await s.c.get('/api/flows/requests?flow=' + id);
    assert.equal(list.status, 200, list.text);
    assert.equal(list.body.requests.length, 3);
    const ids = list.body.requests.map((x) => x.id);
    let r = await s.c.post('/api/flows/requests/decide', { ids: ids.slice(0, 2), action: 'approve' });
    assert.deepEqual([r.body.approved, r.body.failed], [2, 0]);
    app.fakes.tg.joinError = 'Bad Request: HIDE_REQUESTER_MISSING';
    r = await s.c.post('/api/flows/requests/decide', { ids: [ids[2]], action: 'decline' });
    assert.equal(r.body.gone, 1, 'already gone on Telegram\'s side');
    app.fakes.tg.joinError = null;
    assert.equal((await s.c.get('/api/flows/requests?flow=' + id)).body.requests.length, 0);
    const u4 = nextUser();
    await joinRequest(s, u4);
    r = await s.c.post('/api/flows/requests/decide', { ids: [(await jrOf(u4)).id], action: 'decline' });
    assert.equal(r.body.declined, 1);
    assert.equal(callsFor(s.bot.token, 'declineChatJoinRequest', u4).length, 1);
    assert.equal((await jrOf(u4)).status, 'declined');
  });

  it('tap-to-start capture: later steps wait for Start, then go out on time', async () => {
    const id = await use({ name: 'Follow', start_button: true, start_label: '👉 Get tips', blocks: [msg('Welcome!'), wait(1, 'day'), msg('Day 1 tip'), wait(2, 'day'), msg('Day 3 offer')] });
    const u = nextUser();
    await joinRequest(s, u);
    const w = sendsTo(s.bot.token, u)[0];
    assert.equal(w.params.reply_markup.inline_keyboard[0][0].text, '👉 Get tips');
    const sub = await app.db.one('select * from subscribers where connection_id = $1 and tg_user_id = $2', [s.bot.connId, u]);
    let run = await app.db.one('select * from sequence_runs where sequence_id = $1 and subscriber_id = $2', [id, sub.id]);
    assert.equal(run.status, 'waiting', 'not reachable yet');
    assert.ok((new Date(run.due_at) - Date.now()) / 3600000 > 23, 'step 2 is a day later');
    // Due, but they never pressed Start: nothing is sent.
    await app.db.query('update sequence_runs set due_at = now() where id = $1', [run.id]);
    await tickAndSend();
    assert.equal(textsTo(s.bot.token, u).length, 1);
    // They press Start through the button: captured, and the waiting step goes out at the next tick.
    await app.start(s.bot.connId, u, new URL(w.params.reply_markup.inline_keyboard[0][0].url).searchParams.get('start'));
    run = await app.db.one('select * from sequence_runs where id = $1', [run.id]);
    assert.equal(run.status, 'active');
    await tickAndSend();
    assert.deepEqual(textsTo(s.bot.token, u), ['Welcome!', 'Day 1 tip']);
    run = await app.db.one('select * from sequence_runs where id = $1', [run.id]);
    assert.ok((new Date(run.due_at) - Date.now()) / 86400000 > 1.99, 'the third step two days later');
    await app.db.query('update sequence_runs set due_at = now() where id = $1', [run.id]);
    await tickAndSend();
    assert.deepEqual(textsTo(s.bot.token, u), ['Welcome!', 'Day 1 tip', 'Day 3 offer']);
    // Someone who never presses Start stops waiting after 7 days.
    const u2 = nextUser();
    await joinRequest(s, u2);
    await app.db.query("update sequence_runs set created_at = now() - interval '8 days' where subscriber_id = (select id from subscribers where connection_id = $1 and tg_user_id = $2)", [s.bot.connId, u2]);
    await tickAndSend();
    assert.equal((await app.db.one('select r.status from sequence_runs r join subscribers x on x.id = r.subscriber_id where x.tg_user_id = $1', [u2])).status, 'stopped');
    const st = (await s.c.get(`/api/flows/${id}/stats`)).body.stats;
    assert.equal(st.funnel.requests, 2);
    assert.equal(st.funnel.started, 1);
    assert.deepEqual(st.steps.map((x) => x.delivered), [2, 1, 1]);
  });

  it('click conditions: "only if they clicked" and "only if they didn\'t click"', async () => {
    const id = await use({ name: 'Cond', blocks: [msg('Pick', { buttons: [{ label: 'Go', url: 'https://go.example' }] }), msg('You clicked', { condition: 'clicked' }), msg('You did not click', { condition: 'not_clicked' })] });
    const [a, b] = [nextUser(), nextUser()];
    for (const u of [a, b]) { await joinRequest(s, u); await app.start(s.bot.connId, u); }
    const url = sendsTo(s.bot.token, a)[0].params.reply_markup.inline_keyboard[0][0].url;
    const res = await fetch(url, { redirect: 'manual' });
    assert.equal(res.status, 302);
    for (let i = 0; i < 2; i++) { await app.db.query('update sequence_runs set due_at = now() where sequence_id = $1', [id]); await tickAndSend(); }
    assert.deepEqual(textsTo(s.bot.token, a), ['Pick', 'You clicked']);
    assert.deepEqual(textsTo(s.bot.token, b), ['Pick', 'You did not click']);
    const st = (await s.c.get(`/api/flows/${id}/stats`)).body.stats;
    assert.equal(st.funnel.clicked, 1);
    assert.equal(st.steps[0].clickers, 1);
  });

  it('A/B welcome: people are split between versions, with stats per version', async () => {
    const id = await use({ name: 'AB', blocks: [msg('Version A', { variants: [{ body: 'Version B' }] })] });
    const users = [nextUser(), nextUser(), nextUser(), nextUser()];
    for (const u of users) await joinRequest(s, u);
    const got = users.map((u) => textsTo(s.bot.token, u)[0]);
    assert.deepEqual(got, users.map((u) => (u % 2 ? 'Version B' : 'Version A')));
    const st = (await s.c.get(`/api/flows/${id}/stats`)).body.stats;
    assert.deepEqual(st.ab.map((x) => [x.label, x.delivered]), [['A', 2], ['B', 2]]);
  });

  it('the same join request twice is handled once', async () => {
    await use({ name: 'Once' });
    const u = nextUser();
    await joinRequest(s, u);
    await joinRequest(s, u);
    assert.equal(textsTo(s.bot.token, u).length, 1);
    assert.equal(callsFor(s.bot.token, 'approveChatJoinRequest', u).length, 1);
    assert.equal((await app.db.one('select count(*)::int n from join_requests where tg_user_id = $1', [u])).n, 1);
    // While still open (manual), a repeat is the same request too.
    await use({ name: 'Once manual', approve_mode: 'manual' });
    const u2 = nextUser();
    await Promise.all([joinRequest(s, u2), joinRequest(s, u2)]);
    assert.equal(textsTo(s.bot.token, u2).length, 1);
    assert.equal((await app.db.one('select count(*)::int n from join_requests where tg_user_id = $1', [u2])).n, 1);
  });

  it('a flow for a specific invite link wins over the channel\'s default flow', async () => {
    await use({ name: 'Default flow', blocks: [msg('Default welcome')] });
    const linkFlow = (await s.c.post('/api/flows', flowBody(s, { name: 'Ad flow', blocks: [msg('Ad welcome')], invite_link: 'https://t.me/+AdLink123' }))).body.id;
    assert.equal((await s.c.post(`/api/flows/${linkFlow}/toggle`, { active: true })).status, 200);
    const [a, b] = [nextUser(), nextUser()];
    await joinRequest(s, a, { invite_link: { invite_link: 'https://t.me/+AdLink123', creates_join_request: true } });
    await joinRequest(s, b);
    assert.deepEqual([textsTo(s.bot.token, a)[0], textsTo(s.bot.token, b)[0]], ['Ad welcome', 'Default welcome']);
    await s.c.post(`/api/flows/${linkFlow}/toggle`, { active: false });
  });

  it('switched off in admin: nothing happens', async () => {
    await use({ name: 'Off' });
    await app.setFeature('welcome_flows', false);
    try {
      const u = nextUser();
      await joinRequest(s, u);
      assert.equal(textsTo(s.bot.token, u).length, 0);
      assert.equal(await jrOf(u), null);
      assert.equal((await s.c.post('/api/flows', flowBody(s))).status, 403);
    } finally { await app.setFeature('welcome_flows', true); }
  });
});

describe('Free plan, the meter and trial end', () => {
  it('Free welcomes end with the Castvoo line linking to the owner\'s referral link; paid plans do not', async () => {
    const s = await setup('wf-brand@example.com', 'free');
    await live(s, flowBody(s, { blocks: [msg('Welcome {name}!')] }));
    const u = nextUser();
    await joinRequest(s, u);
    const t = textsTo(s.bot.token, u)[0];
    assert.match(t, /^Welcome Ada!\n\n⚡ <a href="[^"]+\/r\/[a-z0-9]+">Free welcome bot by Castvoo\.com<\/a>$/);
    assert.ok(t.includes(`/r/${s.c.user.ref_code}`));
    assert.equal((await jrOf(u)).status, 'approved', 'auto-approve');
    assert.equal(await app.db.one('select 1 from sequence_runs r join subscribers x on x.id = r.subscriber_id where x.tg_user_id = $1', [u]), null, 'no follow-ups on Free');
    await setPlan(s.ws.id, 'starter');
    app.settings.bust();
    const u2 = nextUser();
    await joinRequest(s, u2);
    assert.equal(textsTo(s.bot.token, u2)[0], 'Welcome Ada!');
    const stats = (await s.c.get('/api/flows')).body;
    assert.equal(stats.flows[0].welcomed, 2);
  });

  it('over the month\'s join requests (+10% grace): people are still let in, welcomes pause, emails at 80% and 100%', async () => {
    const s = await setup('wf-meter@example.com', 'free');
    await app.db.query("insert into plans(code, name, price_month_cents, price_year_cents, connections, subscribers, ai_writes, seats, join_requests, flows, flow_steps, branding, features, active) values ('tinyfree','Tiny',0,0,1,0,0,1,10,1,1,true,'[\"auto_approve\",\"welcome_message\"]',false) on conflict do nothing");
    await app.db.query("update workspaces set plan_code = 'tinyfree' where id = $1", [s.ws.id]);
    app.settings.bust();
    await live(s, flowBody(s, { blocks: [msg('Hello')] }));
    const users = Array.from({ length: 13 }, nextUser);
    for (const u of users) await joinRequest(s, u);
    // 10 included + 1 grace (10%) = 11 welcomed; the 12th and 13th are let in without a welcome.
    assert.deepEqual(users.map((u) => textsTo(s.bot.token, u).length), [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0]);
    for (const u of users) assert.equal(callsFor(s.bot.token, 'approveChatJoinRequest', u).length, 1, 'auto-approve keeps working');
    const m = (await s.c.get('/api/flows')).body.meter;
    assert.deepEqual([m.used, m.limit, m.no_welcome, m.paused], [13, 10, 2, true]);
    const mails = app.fakes.emailsTo('wf-meter@example.com').map((e) => e.subject);
    assert.equal(mails.filter((x) => /used 8 of 10 join requests/.test(x)).length, 1);
    assert.equal(mails.filter((x) => /reached 10 join requests/.test(x)).length, 1);
  });

  it('trial ends unpaid: the workspace drops to Free, keeps its first live flow\'s welcome, pauses the rest', async () => {
    const s = await setup('wf-trial@example.com');
    const ws = s.ws;
    const chat2 = --chatSeq;
    const chan2 = (await app.db.one("insert into connections(workspace_id, kind, tg_chat_id, title) values ($1,'group',$2,'Second') returning id", [ws.id, chat2])).id;
    const first = await live(s, flowBody(s, { name: 'First', blocks: [msg('First welcome'), wait(1, 'day'), msg('Later')] }));
    const second = await live(s, { ...flowBody(s, { name: 'Second' }), chat_id: chan2 });
    const drip = (await s.c.post('/api/drips', { connection_id: s.bot.connId, name: 'Drip', trigger_type: 'start', steps: [{ body: 'drip' }] })).body.id;
    await app.db.query("update workspaces set trial_ends_at = now() - interval '1 minute' where id = $1", [ws.id]);
    await app.jobs.billingTick();
    const w = await app.db.one('select * from workspaces where id = $1', [ws.id]);
    assert.deepEqual([w.plan_code, w.plan_status], ['free', 'active'], 'Free, not paused');
    const flows = await app.db.many('select id, active, paused_by_plan from sequences where workspace_id = $1 order by id', [ws.id]);
    assert.deepEqual(flows.map((f) => [f.id, f.active, f.paused_by_plan]), [[first, true, false], [second, false, true], [drip, false, true]]);
    assert.ok(app.fakes.lastEmail('wf-trial@example.com', /trial has ended/i), 'trial_dropped_to_free email');
    const u = nextUser();
    await joinRequest(s, u);
    assert.match(textsTo(s.bot.token, u)[0], /^First welcome\n\n⚡ .*Free welcome bot by Castvoo\.com/);
    assert.equal((await jrOf(u)).status, 'approved');
    assert.equal(await app.db.one('select 1 from sequence_runs where sequence_id = $1', [first]), null, 'step 2 does not run on Free');
    const plan = (await s.c.get('/api/app/plan')).body;
    assert.deepEqual([plan.plan_code, plan.free, plan.welcome_only], ['free', true, true]);
    // Picking a plan from Free starts it now, paid from the wallet.
    await app.db.query('update workspaces set wallet_cents = 5000 where id = $1', [ws.id]);
    const up = await s.c.post('/api/app/plan', { plan: 'starter', cycle: 'month' });
    assert.equal(up.status, 200, up.text);
    const w2 = await app.db.one('select plan_code, plan_status, wallet_cents from workspaces where id = $1', [ws.id]);
    assert.deepEqual([w2.plan_code, w2.plan_status, Number(w2.wallet_cents)], ['starter', 'active', 3100]);
  });

  it('a renewal the wallet cannot cover drops to Free; a top-up that covers it restarts the plan', async () => {
    const s = await setup('wf-renew@example.com', 'growth');
    await app.db.query("update workspaces set period_end = now() - interval '1 minute', billing_cycle = 'month', paid_ever = true where id = $1", [s.ws.id]);
    await app.jobs.billingTick();
    let w = await app.db.one('select * from workspaces where id = $1', [s.ws.id]);
    assert.deepEqual([w.plan_code, w.plan_status, w.dropped_from], ['free', 'active', 'growth']);
    assert.ok(app.fakes.lastEmail('wf-renew@example.com', /could not renew/i));
    await app.db.query("insert into payments(workspace_id, user_id, provider, method_key, reference, amount_cents) values ($1,$2,'paystack','paystack_ng','wf-renew-1',6000)", [s.ws.id, s.c.user.id]);
    await app.require('payments').credit('wf-renew-1');
    w = await app.db.one('select * from workspaces where id = $1', [s.ws.id]);
    assert.deepEqual([w.plan_code, w.plan_status, w.dropped_from, Number(w.wallet_cents)], ['growth', 'active', null, 6000 - 4900]);
  });
});

describe('permissions and isolation', () => {
  let s, other, flowId;
  before(async () => {
    s = await setup('wf-owner@example.com');
    other = await setup('wf-other@example.com');
    flowId = await live(s, flowBody(s, { name: 'Private', approve_mode: 'manual' }));
    await joinRequest(s, nextUser());
  });

  it('another workspace cannot read, edit, toggle, copy, delete or decide on my flow', async () => {
    const o = other.c;
    assert.equal((await o.get('/api/flows/' + flowId)).status, 404);
    assert.equal((await o.get(`/api/flows/${flowId}/stats`)).status, 404);
    assert.equal((await o.get('/api/flows/requests?flow=' + flowId)).status, 404);
    assert.equal((await o.put('/api/flows/' + flowId, flowBody(other))).status, 404);
    assert.equal((await o.post(`/api/flows/${flowId}/toggle`, { active: false })).status, 404);
    assert.equal((await o.post(`/api/flows/${flowId}/duplicate`)).status, 404);
    assert.equal((await o.del('/api/flows/' + flowId)).status, 404);
    assert.equal((await o.get('/api/flows')).body.flows.length, 0);
    // Using my channel or bot from another workspace fails too.
    assert.equal((await o.post('/api/flows', flowBody(s))).status, 400);
    assert.equal((await o.post('/api/flows/check', { bot_id: s.bot.connId, chat_id: s.chanId })).status, 404);
    const ids = (await s.c.get('/api/flows/requests?flow=' + flowId)).body.requests.map((x) => x.id);
    const d = await o.post('/api/flows/requests/decide', { ids, action: 'approve' });
    assert.deepEqual([d.body.approved, d.body.declined], [0, 0]);
    assert.equal((await app.db.one('select status from join_requests where id = $1', [ids[0]])).status, 'pending');
    assert.equal((await app.db.one('select active from sequences where id = $1', [flowId])).active, true);
  });

  it('drafters can look but not change', async () => {
    const inv = await s.c.post('/api/app/team/invite', { email: 'wf-drafter@example.com', role: 'drafter' });
    const d = await app.loginByEmail('wf-drafter@example.com');
    const acc = await d.post('/api/invites/accept', { token: inv.body.link.split('#join/')[1] });
    const as = { headers: { 'x-ws': String(acc.body.workspace_id) } };
    assert.equal((await d.get('/api/flows', as)).status, 200);
    assert.equal((await d.post('/api/flows', flowBody(s), as)).status, 403);
    assert.equal((await d.put('/api/flows/' + flowId, flowBody(s), as)).status, 403);
    assert.equal((await d.post(`/api/flows/${flowId}/toggle`, { active: false }, as)).status, 403);
    assert.equal((await d.post('/api/flows/requests/decide', { ids: [1], action: 'approve' }, as)).status, 403);
    assert.equal((await d.del('/api/flows/' + flowId, as)).status, 403);
  });

  it('flow names and text come back as data; the dashboard escapes them', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const r = await s.c.post('/api/flows', flowBody(s, { name: evil, blocks: [msg(`Hi ${evil} *bold*`, { buttons: [{ label: '"><script>x()</script>', url: 'https://ok.example' }] })] }));
    assert.equal(r.status, 200, r.text);
    const list = (await s.c.get('/api/flows')).body.flows;
    const f = list.find((x) => x.id === r.body.id);
    assert.equal(f.name, evil, 'stored as typed, JSON-encoded');
    const detail = (await s.c.get('/api/flows/' + r.body.id)).body.flow;
    // Run the dashboard's render functions (public/js) in a sandbox and check nothing unescaped gets through.
    const ui = loadUi();
    const card = ui.flowCardHtml({ ...f, chat_title: evil, bot_username: evil });
    const stack = ui.blocksHtml(detail.blocks, { editable: true });
    const prev = ui.tgPreviewHtml({ bot: evil, chat: evil, body: detail.blocks[0].body, buttons: detail.blocks[0].buttons, startLabel: evil, branding: true });
    for (const html of [card, stack, prev]) {
      assert.doesNotMatch(html, /<img src=x/i);
      assert.doesNotMatch(html, /<script>/i);
    }
    assert.match(card, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(prev, /<b>bold<\/b>/, 'formatting still works');
  });
});

/** Load core.js + app-flows.js from public/js into a sandbox with tiny browser stubs. */
function loadUi() {
  const root = path.join(__dirname, '..', '..', 'public', 'js');
  const ctx = {
    console, URLSearchParams, URL, Date, Math, JSON, Intl, setTimeout, clearTimeout,
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    document: { querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} }), documentElement: {}, body: {} },
    window: {}, location: { hash: '' }, localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {} },
    navigator: {}, history: {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  const src = ['core.js', 'app-flows.js'].map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n;\n');
  vm.runInContext('var PAGES = {}; var APP = { state: null }; var CFG = { features: {} };\n' + src + '\n;this.__ui = { flowCardHtml, blocksHtml, tgPreviewHtml };', ctx);
  return ctx.__ui;
}

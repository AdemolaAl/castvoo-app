'use strict';
/*
 * The simplest flow builder: every message says when it comes.
 *   ⚡ right away · ⏱ after a wait · 👆 when they tap Start · 🔘 when they tap a button (Reply buttons = Telegram
 *   callbacks, Link buttons = tracked /l/ links), branches per button · 💤 reminder if they don't respond ·
 *   ➡ start another flow. Plus: idempotent double taps, old flows, plan gating, Cas builds a flow (strict JSON),
 *   the broadcast tie-in ("Tapped Start in <flow>") and escaping in the builder.
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
beforeEach(() => { app.rl._reset(); app.fakes.tg.chatMember = null; app.fakes.tg.joinError = null; app.fakes.ai.script = null; });

let chatSeq = -1006600000;
let userSeq = 770000;
let emailSeq = 0;
const nextUser = () => ++userSeq;

async function setup(plan = 'growth') {
  const c = await app.loginByEmail(`ft-${++emailSeq}@example.com`);
  const bot = await app.connectBot(c);
  const ws = await app.ws(c);
  const chat = --chatSeq;
  const chanId = (await app.db.one("insert into connections(workspace_id, kind, tg_chat_id, title) values ($1,'channel',$2,'Signals Channel') returning id", [ws.id, chat])).id;
  if (plan !== 'trial') await setPlan(ws.id, plan);
  return { c, bot, ws, chat, chanId };
}
async function setPlan(wsId, code) {
  await app.db.query("update workspaces set plan_code = $2, plan_status = 'active', trial_ends_at = null, period_end = case when $2 = 'free' then null else now() + interval '20 days' end where id = $1", [wsId, code]);
  app.settings.bust();
}
const m = (body, extra = {}) => ({ body, ...extra });
const flow = (s, steps, extra = {}) => ({ name: 'Trigger flow', chat_id: s.chanId, bot_id: s.bot.connId, approve_mode: 'after_welcome', start_button: true, start_label: '👆 Tap Start', steps, ...extra });
async function live(s, body) {
  await app.db.query("update sequences set active = false where workspace_id = $1 and trigger_type = 'join_request'", [s.ws.id]);
  const r = await s.c.post('/api/flows', { ...body, active: true });
  assert.equal(r.status, 200, r.text);
  return r.body.id;
}
async function joinRequest(s, userId) {
  return app.telegramUpdate(s.bot.connId, { chat_join_request: { chat: { id: s.chat, type: 'channel', title: 'Signals Channel' }, from: { id: userId, first_name: 'Ada', is_bot: false }, user_chat_id: userId, date: Math.floor(Date.now() / 1000) } });
}
let cq = 1;
async function tap(s, userId, data) {
  return app.telegramUpdate(s.bot.connId, { callback_query: { id: 'cq' + (cq++), from: { id: userId, is_bot: false, first_name: 'Ada' }, chat_instance: 'x', data, message: { message_id: 1, chat: { id: userId, type: 'private' } } } });
}
const sendsTo = (token, chat) => app.fakes.tgCalls(null, token).filter((x) => /^send/.test(x.method) && x.params.chat_id === chat);
const textsTo = (token, chat) => sendsTo(token, chat).map((x) => x.params.text || x.params.caption);
const keyboardOf = (token, chat, text) => { const x = sendsTo(token, chat).find((y) => (y.params.text || '').includes(text)); return x ? x.params.reply_markup.inline_keyboard : null; };
const approvals = (token, user) => app.fakes.tgCalls('approveChatJoinRequest', token).filter((x) => x.params.user_id === user);
const subOf = (s, u) => app.db.one('select * from subscribers where connection_id = $1 and tg_user_id = $2', [s.bot.connId, u]);
const runOf = async (seqId, s, u) => app.db.one('select * from sequence_runs where sequence_id = $1 and subscriber_id = $2', [seqId, (await subOf(s, u)).id]);
async function tickAndSend() { await app.jobs.dripsTick(); await app.drain(); }

/* The owner's example, word for word. */
const OWNER_EXAMPLE = () => [
  m('Hi {name} 👋 Welcome to Signals!'),
  m('Please tap the button above 👆', { trigger: { type: 'after_previous' } }),
  m('You are in! What do you want?', { buttons: [{ id: 'vip', label: '⭐ VIP signals', kind: 'reply', row: 0 }, { id: 'free', label: '📘 Free tips', kind: 'reply', row: 0 }], trigger: { type: 'on_start' } }),
  m('VIP: here is how to join ⭐', { trigger: { type: 'on_button', button: 'vip' } }),
  m('Free tips: start with this one 📘', { trigger: { type: 'on_button', button: 'free' } }),
  m('An hour later: how are you finding it?', { trigger: { type: 'wait', value: 1, unit: 'hour' } }),
];

describe('every trigger, end to end with fake Telegram', () => {
  let s, id;
  before(async () => { s = await setup('growth'); id = await live(s, flow(s, OWNER_EXAMPLE())); });

  it('saves the triggers and gives them back in the builder\'s format (and the older blocks format)', async () => {
    const f = (await s.c.get('/api/flows/' + id)).body.flow;
    assert.deepEqual(f.steps.map((x) => x.trigger && x.trigger.type), [null, 'after_previous', 'on_start', 'on_button', 'on_button', 'wait']);
    assert.deepEqual(f.steps[2].buttons.map((b) => [b.id, b.kind, b.url]), [['vip', 'reply', ''], ['free', 'reply', '']]);
    assert.equal(f.steps[3].trigger.button, 'vip');
    assert.deepEqual([f.steps[5].trigger.value, f.steps[5].trigger.unit], [1, 'hour']);
    assert.deepEqual(f.blocks.map((b) => b.type), ['message', 'message', 'message', 'message', 'message', 'wait', 'message']);
    assert.equal(f.blocks[2].trigger.type, 'on_start');
  });

  it('the owner\'s example: welcome with Tap Start, "please tap" right away, Start → message with buttons at once, a tap → its answer, then a pause', async () => {
    const u = nextUser();
    await joinRequest(s, u);
    const w = sendsTo(s.bot.token, u)[0];
    assert.equal(w.params.text, 'Hi Ada 👋 Welcome to Signals!');
    const startBtn = w.params.reply_markup.inline_keyboard[0][0];
    assert.equal(startBtn.text, '👆 Tap Start');
    assert.match(startBtn.url, new RegExp(`^https://t\\.me/${s.bot.username}\\?start=j_`));
    assert.equal(approvals(s.bot.token, u).length, 0, 'held for the quick message');
    await tickAndSend();
    assert.deepEqual(textsTo(s.bot.token, u), ['Hi Ada 👋 Welcome to Signals!', 'Please tap the button above 👆'], 'message 2 with no trigger: right away, through the join request');
    assert.equal(approvals(s.bot.token, u).length, 1, 'let in right after it');
    // Nothing more until they tap Start.
    await tickAndSend();
    assert.equal(textsTo(s.bot.token, u).length, 2);
    assert.ok(['waiting', 'awaiting'].includes((await runOf(id, s, u)).status), 'waits for them: the window is closed and they never pressed Start');
    // Tap Start → the next message at once (no wait to fast-forward).
    await app.start(s.bot.connId, u, new URL(startBtn.url).searchParams.get('start'));
    await tickAndSend();
    assert.equal(textsTo(s.bot.token, u)[2], 'You are in! What do you want?');
    const kb = keyboardOf(s.bot.token, u, 'What do you want');
    assert.equal(kb[0].length, 2, 'two Reply buttons side by side');
    assert.equal(kb[0][0].text, '⭐ VIP signals');
    assert.match(kb[0][0].callback_data, /^cvb:[a-z0-9]{7}$/);
    assert.ok(Buffer.byteLength(kb[0][0].callback_data) <= 64);
    assert.equal(kb[0][0].url, undefined, 'a Reply button has no URL');
    assert.equal((await runOf(id, s, u)).status, 'awaiting', 'waiting for a tap');
    // Tap "VIP signals" → Telegram gets its answer at once, then the VIP answer comes.
    await tap(s, u, kb[0][0].callback_data);
    assert.ok(app.fakes.tgCalls('answerCallbackQuery', s.bot.token).length > 0);
    await tickAndSend();
    assert.deepEqual(textsTo(s.bot.token, u).slice(3), ['VIP: here is how to join ⭐']);
    const run = await runOf(id, s, u);
    assert.equal(run.next_position, 6);
    assert.ok((new Date(run.due_at) - Date.now()) / 60000 > 59, 'some steps come after a pause');
    await app.db.query('update sequence_runs set due_at = now() where id = $1', [run.id]);
    await tickAndSend();
    assert.deepEqual(textsTo(s.bot.token, u).slice(3), ['VIP: here is how to join ⭐', 'An hour later: how are you finding it?']);
    assert.equal((await runOf(id, s, u)).status, 'done');
  });

  it('branching by two Reply buttons: each choice gets its own answer; a later tap on the other button gets that answer too; stats count each branch', async () => {
    const [a, b] = [nextUser(), nextUser()];
    for (const u of [a, b]) { await joinRequest(s, u); await tickAndSend(); await app.start(s.bot.connId, u); }
    await tickAndSend();
    const kbA = keyboardOf(s.bot.token, a, 'What do you want');
    const kbB = keyboardOf(s.bot.token, b, 'What do you want');
    await tap(s, a, kbA[0][0].callback_data); // VIP
    await tap(s, b, kbB[0][1].callback_data); // Free
    await tickAndSend();
    assert.equal(textsTo(s.bot.token, a)[3], 'VIP: here is how to join ⭐');
    assert.equal(textsTo(s.bot.token, b)[3], 'Free tips: start with this one 📘');
    assert.ok(!textsTo(s.bot.token, a).includes('Free tips: start with this one 📘'));
    // A taps the other button later: that answer comes too (once).
    await tap(s, a, kbA[0][1].callback_data);
    await tickAndSend();
    assert.equal(textsTo(s.bot.token, a).filter((t) => t.startsWith('Free tips')).length, 1);
    const st = (await s.c.get(`/api/flows/${id}/stats`)).body.stats;
    const choice = st.steps.find((x) => x.position === 3);
    const taps = Object.fromEntries(choice.buttons.map((x) => [x.id, x.people]));
    assert.ok(taps.vip >= 2 && taps.free >= 2, JSON.stringify(taps));
    assert.ok(st.steps.find((x) => x.position === 4).delivered >= 2);
    assert.equal(st.steps.find((x) => x.position === 4).trigger, 'on_button');
  });

  it('double taps (and a repeated callback) send the answer once', async () => {
    const u = nextUser();
    await joinRequest(s, u); await tickAndSend(); await app.start(s.bot.connId, u); await tickAndSend();
    const kb = keyboardOf(s.bot.token, u, 'What do you want');
    await Promise.all([tap(s, u, kb[0][0].callback_data), tap(s, u, kb[0][0].callback_data), tap(s, u, kb[0][0].callback_data)]);
    await tickAndSend();
    await tap(s, u, kb[0][0].callback_data);
    await tickAndSend();
    assert.equal(textsTo(s.bot.token, u).filter((t) => t.startsWith('VIP:')).length, 1);
    assert.equal((await app.db.one("select count(*)::int n from deliveries d join sequence_steps st on st.id = d.step_id where st.sequence_id = $1 and st.position = 4 and d.subscriber_id = $2", [id, (await subOf(s, u)).id])).n, 1);
  });

  it('a callback on an unknown or removed button is answered (it stops spinning) and ignored', async () => {
    const u = nextUser();
    await joinRequest(s, u);
    const before = app.fakes.tgCalls('answerCallbackQuery', s.bot.token).length;
    await tap(s, u, 'cvb:zzzzzzz');
    await tap(s, u, 'cvb:<script>');
    await tap(s, u, 'cv:unknown');
    assert.equal(app.fakes.tgCalls('answerCallbackQuery', s.bot.token).length, before + 3);
  });
});

describe('Reply buttons and the 5-minute window', () => {
  it('a tap from someone the bot can\'t message any more waits for Start; inside the window ("I decide") the answer reaches them at once', async () => {
    const s = await setup('starter');
    const steps = [m('Welcome! Pick one:', { buttons: [{ id: 'yes', label: '✅ Yes', kind: 'reply' }] }), m('You said yes!', { trigger: { type: 'on_button', button: 'yes' } })];
    await live(s, flow(s, steps));
    const u = nextUser();
    await joinRequest(s, u);
    assert.equal(approvals(s.bot.token, u).length, 1, 'let in after the welcome: the window is closed');
    await tap(s, u, keyboardOf(s.bot.token, u, 'Pick one')[1][0].callback_data);
    await tickAndSend();
    assert.deepEqual(textsTo(s.bot.token, u), ['Welcome! Pick one:'], 'the bot may not message them now');
    await app.start(s.bot.connId, u);
    await tickAndSend();
    assert.deepEqual(textsTo(s.bot.token, u), ['Welcome! Pick one:', 'You said yes!'], 'their tap is answered once they press Start');
    await live(s, flow(s, steps, { name: 'Manual', approve_mode: 'manual' }));
    const v = nextUser();
    await joinRequest(s, v);
    await tap(s, v, keyboardOf(s.bot.token, v, 'Pick one')[1][0].callback_data);
    await tickAndSend();
    assert.deepEqual(textsTo(s.bot.token, v), ['Welcome! Pick one:', 'You said yes!'], 'request still open: through the join request');
    assert.equal(sendsTo(s.bot.token, v)[1].params.chat_id, v);
  });
});

describe('Link buttons, reminders and Start another flow', () => {
  it('a tracked Link button also counts as a tap: opening it sends its answer', async () => {
    const s = await setup('starter');
    const id = await live(s, flow(s, [
      m('Welcome!'),
      m('Pick one', { buttons: [{ id: 'shop', label: '🛍️ Shop', url: 'https://shop.example', kind: 'link' }], trigger: { type: 'on_start' } }),
      m('Thanks for visiting the shop!', { trigger: { type: 'on_button', button: 'shop' } }),
    ]));
    const u = nextUser();
    await joinRequest(s, u);
    await app.start(s.bot.connId, u);
    await tickAndSend();
    const url = keyboardOf(s.bot.token, u, 'Pick one')[0][0].url;
    assert.match(url, /\/l\/[a-z0-9]{7}\?s=\d+\./);
    const res = await fetch(url, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://shop.example/');
    await tickAndSend();
    assert.deepEqual(textsTo(s.bot.token, u), ['Welcome!', 'Pick one', 'Thanks for visiting the shop!']);
    await fetch(url, { redirect: 'manual' });
    await tickAndSend();
    assert.equal(textsTo(s.bot.token, u).length, 3, 'once');
    void id;
  });

  it('💤 a reminder fires when they don\'t tap Start (through the join request, then they are let in) and is cancelled when they do', async () => {
    const s = await setup('starter');
    const id = await live(s, flow(s, [
      m('Welcome! Tap Start below for your gift.'),
      m('Please tap Start 👆', { trigger: { type: 'no_response', value: 2, unit: 'min' } }),
      m('Thanks! Here is your gift 🎁', { trigger: { type: 'on_start' } }),
    ]));
    const [c, d] = [nextUser(), nextUser()];
    await joinRequest(s, c); await joinRequest(s, d);
    await tickAndSend();
    for (const u of [c, d]) assert.equal(approvals(s.bot.token, u).length, 0, 'held: the reminder is inside the first 5 minutes');
    const timer = async (u) => app.db.one('select f.* from flow_step_runs f join sequence_runs r on r.id = f.run_id where r.sequence_id = $1 and r.subscriber_id = $2', [id, (await subOf(s, u)).id]);
    const tc = await timer(c);
    assert.equal(tc.status, 'scheduled');
    assert.ok((new Date(tc.due_at) - Date.now()) / 1000 > 100);
    // D taps Start before the reminder: cancelled at once, the gift comes, and D is let in.
    await app.start(s.bot.connId, d);
    assert.equal((await timer(d)).status, 'cancelled');
    assert.equal(approvals(s.bot.token, d).length, 1, 'tapped Start: no need to hold them');
    await tickAndSend();
    assert.deepEqual(textsTo(s.bot.token, d), ['Welcome! Tap Start below for your gift.', 'Thanks! Here is your gift 🎁']);
    // C never taps: when the time comes the reminder goes out (through the open join request), then C is let in.
    await app.db.query("update flow_step_runs set due_at = now() where status = 'scheduled' and run_id in (select id from sequence_runs where sequence_id = $1)", [id]);
    await tickAndSend();
    assert.deepEqual(textsTo(s.bot.token, c), ['Welcome! Tap Start below for your gift.', 'Please tap Start 👆']);
    assert.equal(approvals(s.bot.token, c).length, 1);
    assert.equal((await timer(c)).status, 'sent');
    assert.equal(textsTo(s.bot.token, d).filter((t) => t.startsWith('Please tap')).length, 0, 'never sent to D');
    const st = (await s.c.get(`/api/flows/${id}/stats`)).body.stats;
    assert.equal(st.steps[1].cancelled, 1);
    assert.equal(st.steps[1].delivered, 1);
  });

  it('a reminder on a message\'s buttons is cancelled by a tap on one of them', async () => {
    const s = await setup('starter');
    const id = await live(s, flow(s, [
      m('Welcome!'),
      m('Which one?', { buttons: [{ id: 'a', label: 'A', kind: 'reply' }, { id: 'b', label: 'B', kind: 'reply' }], trigger: { type: 'on_start' } }),
      m('Still there? Pick A or B 👆', { trigger: { type: 'no_response', value: 1, unit: 'day' } }),
      m('You picked A', { trigger: { type: 'on_button', button: 'a' } }),
    ]));
    const [x, y] = [nextUser(), nextUser()];
    for (const u of [x, y]) { await joinRequest(s, u); await app.start(s.bot.connId, u); }
    await tickAndSend();
    const t = async (u) => app.db.one('select f.* from flow_step_runs f join sequence_runs r on r.id = f.run_id join sequence_steps st on st.id = f.step_id where r.sequence_id = $1 and r.subscriber_id = $2 and st.position = 3', [id, (await subOf(s, u)).id]);
    assert.equal((await t(x)).status, 'scheduled');
    assert.equal((await t(x)).armed_active, true, 'they had tapped Start already: Start does not cancel this one');
    await tap(s, x, keyboardOf(s.bot.token, x, 'Which one?')[0][0].callback_data);
    assert.equal((await t(x)).status, 'cancelled');
    await app.db.query("update flow_step_runs set due_at = now() where status = 'scheduled'");
    await tickAndSend();
    assert.deepEqual(textsTo(s.bot.token, x), ['Welcome!', 'Which one?', 'You picked A']);
    assert.deepEqual(textsTo(s.bot.token, y), ['Welcome!', 'Which one?', 'Still there? Pick A or B 👆']);
  });

  it('➡ a message can start another flow (an auto follow-up on the same bot) for that person, from its first step, once', async () => {
    const s = await setup('growth');
    const drip = await s.c.post('/api/drips', { connection_id: s.bot.connId, name: 'VIP drip', trigger_type: 'tag', trigger_value: 'vipdrip', steps: [{ body: 'Drip 1: welcome to VIP', delay_value: 0 }, { body: 'Drip 2: day two', delay_value: 1, delay_unit: 'day' }] });
    assert.equal(drip.status, 200, drip.text);
    const id = await live(s, flow(s, [
      m('Welcome!'),
      m('Want VIP?', { buttons: [{ id: 'yes', label: 'Yes', kind: 'reply' }], trigger: { type: 'on_start' } }),
      m('Great, VIP it is.', { trigger: { type: 'on_button', button: 'yes' }, start_flow_id: drip.body.id }),
    ]));
    const f = (await s.c.get('/api/flows/' + id)).body.flow;
    assert.equal(f.steps[2].start_flow_id, drip.body.id);
    const u = nextUser();
    await joinRequest(s, u); await app.start(s.bot.connId, u); await tickAndSend();
    await tap(s, u, keyboardOf(s.bot.token, u, 'Want VIP?')[0][0].callback_data);
    await tickAndSend();
    await tickAndSend();
    assert.deepEqual(textsTo(s.bot.token, u), ['Welcome!', 'Want VIP?', 'Great, VIP it is.', 'Drip 1: welcome to VIP']);
    const run = await app.db.one('select * from sequence_runs where sequence_id = $1 and subscriber_id = $2', [drip.body.id, (await subOf(s, u)).id]);
    assert.equal(run.next_position, 2);
    // A flow can't start itself, and only flows of the same bot.
    const self = await s.c.put('/api/flows/' + id, flow(s, [m('Welcome!', { start_flow_id: id })]));
    assert.equal(self.status, 400);
    const bot2 = await app.connectBot(s.c);
    const other = await s.c.post('/api/drips', { connection_id: bot2.connId, name: 'Other bot', trigger_type: 'tag', trigger_value: 'zz', steps: [{ body: 'x', delay_value: 0 }] });
    assert.equal((await s.c.put('/api/flows/' + id, flow(s, [m('Welcome!', { start_flow_id: other.body.id })]))).status, 400);
  });
});

describe('rules, old flows and plans', () => {
  it('checks that triggers make sense', async () => {
    const s = await setup('growth');
    const bad = async (steps, extra) => (await s.c.post('/api/flows', flow(s, steps, extra))).body;
    let r = await bad([m('Hi'), m('x', { trigger: { type: 'on_button', button: 'nope' } })]);
    assert.match(r.error, /not on a message above/);
    r = await bad([m('Hi'), m('x', { trigger: { type: 'no_response', value: 1, unit: 'hour' } })], { start_button: false });
    assert.match(r.error, /nothing to tap/);
    r = await bad([m('Hi'), m('x', { trigger: { type: 'on_start' } })], { start_button: false });
    assert.match(r.error, /Tap Start/);
    r = await bad([m('Hi', { buttons: [{ id: 'a', label: 'A', kind: 'reply' }] }), m('one', { trigger: { type: 'on_button', button: 'a' } }), m('two', { trigger: { type: 'on_button', button: 'a' } })]);
    assert.match(r.error, /same button/);
    r = await bad([m('Hi'), m('x', { trigger: { type: 'teleport' } })]);
    assert.match(r.error, /When it comes must be one of/);
    r = await bad([m('Hi'), m('x', { trigger: { type: 'no_response', value: 0, unit: 'min' } })]);
    assert.match(r.error, /how long to wait/);
    r = await bad([m('Hi', { buttons: [{ id: 'a', label: 'A', kind: 'reply' }, { id: 'a', label: 'B', kind: 'reply' }] })]);
    assert.match(r.error, /same id/);
    r = await bad([m('Hi', { buttons: [{ label: 'A', kind: 'teleport' }] })]);
    assert.match(r.error, /Button type/);
    r = await bad([m('Hi'), m('x', { condition: 'clicked', trigger: { type: 'on_start' } })]);
    assert.match(r.error, /Right away/);
    const ok = await s.c.post('/api/flows', flow(s, [m('Hi', { buttons: [{ label: 'Pick me', kind: 'reply' }] })]));
    assert.equal(ok.status, 200, ok.text);
    const b = (await s.c.get('/api/flows/' + ok.body.id)).body.flow.steps[0].buttons[0];
    assert.match(b.id, /^[a-z0-9]{2,16}$/, 'a missing button id is made');
    assert.equal(b.kind, 'reply');
  });

  it('button ids keep their tracked links when buttons are reordered or renamed', async () => {
    const s = await setup('growth');
    const id = (await s.c.post('/api/flows', flow(s, [m('Hi', { buttons: [{ id: 'one', label: '1', url: 'https://1.example' }, { id: 'two', label: '2', url: 'https://2.example' }] })]))).body.id;
    const before = (await s.c.get('/api/flows/' + id)).body.flow.steps[0].buttons;
    await s.c.put('/api/flows/' + id, flow(s, [m('Hi', { id: (await s.c.get('/api/flows/' + id)).body.flow.steps[0].id, buttons: [{ id: 'two', label: 'Two!', url: 'https://2.example' }, { id: 'one', label: '1', url: 'https://1.example' }] })]));
    const now = (await s.c.get('/api/flows/' + id)).body.flow.steps[0].buttons;
    assert.equal(now[0].code, before[1].code);
    assert.equal(now[1].code, before[0].code);
    assert.equal(now[0].label, 'Two!');
  });

  it('old flows (made before triggers: waits only) still run, and old rows with a wait but no trigger wait', async () => {
    const s = await setup('growth');
    const r = await s.c.post('/api/flows', { name: 'Old', chat_id: s.chanId, bot_id: s.bot.connId, approve_mode: 'after_welcome', start_button: true, blocks: [{ type: 'message', body: 'Old welcome' }, { type: 'wait', value: 1, unit: 'day' }, { type: 'message', body: 'Old day 1' }], active: true });
    assert.equal(r.status, 200, r.text);
    // A row as older code wrote it: trigger left at its default, the wait in delay_seconds.
    await app.db.query("update sequence_steps set trigger_type = 'after_previous' where sequence_id = $1", [r.body.id]);
    const u = nextUser();
    await joinRequest(s, u);
    await app.start(s.bot.connId, u);
    await tickAndSend();
    assert.deepEqual(textsTo(s.bot.token, u), ['Old welcome'], 'still waits a day');
    const run = await runOf(r.body.id, s, u);
    assert.ok((new Date(run.due_at) - Date.now()) / 3600000 > 23);
    await app.db.query('update sequence_runs set due_at = now() where id = $1', [run.id]);
    await tickAndSend();
    assert.deepEqual(textsTo(s.bot.token, u), ['Old welcome', 'Old day 1']);
    const f = (await s.c.get('/api/flows/' + r.body.id)).body.flow;
    assert.equal(f.steps[1].trigger.type, 'wait');
  });

  it('plans: Free = 1 welcome only (no Reply buttons); Starter has every trigger; Start another flow is Growth and up', async () => {
    const free = await setup('free');
    let r = await free.c.post('/api/flows', flow(free, [m('Hi'), m('x', { trigger: { type: 'on_start' } })], { start_button: false }));
    assert.equal(r.status, 402);
    r = await free.c.post('/api/flows', flow(free, [m('Hi', { buttons: [{ label: 'A', kind: 'reply' }] })], { start_button: false }));
    assert.equal(r.status, 402);
    assert.equal(r.body.code, 'plan_feature');
    const st = await setup('starter');
    r = await st.c.post('/api/flows', flow(st, OWNER_EXAMPLE().slice(0, 5)));
    assert.equal(r.status, 200, r.text);
    const drip = await app.db.one("insert into sequences(workspace_id, connection_id, name, trigger_type, trigger_value, active) values ($1,$2,'d','tag','x',true) returning id", [st.ws.id, st.bot.connId]);
    r = await st.c.post('/api/flows', flow(st, [m('Hi', { start_flow_id: drip.id })]));
    assert.equal(r.status, 402);
    assert.equal(r.body.code, 'plan_feature');
    assert.equal(r.body.plan, 'growth');
    // A flow saved on Growth that later drops to Starter: the message is still sent, the other flow is not started.
    const g = await setup('growth');
    const drip2 = await g.c.post('/api/drips', { connection_id: g.bot.connId, name: 'D2', trigger_type: 'tag', trigger_value: 'dd', steps: [{ body: 'Second flow', delay_value: 0 }] });
    await live(g, flow(g, [m('Hi'), m('Thanks', { trigger: { type: 'on_start' }, start_flow_id: drip2.body.id })]));
    await setPlan(g.ws.id, 'starter');
    const u = nextUser();
    await joinRequest(g, u); await app.start(g.bot.connId, u); await tickAndSend(); await tickAndSend();
    assert.deepEqual(textsTo(g.bot.token, u), ['Hi', 'Thanks']);
  });
});

describe('Tell Cas what you want', () => {
  const flows = () => app.require('services/flows');
  const good = {
    name: 'VIP or free', approve_mode: 'after_welcome', start_button: true, start_label: '👆 Tap Start',
    messages: [
      { body: 'Hi {name}! Tap Start 👇', buttons: [] },
      { body: 'Pick one', buttons: [{ id: 'vip', label: '⭐ VIP', kind: 'reply' }, { id: 'free', label: '📘 Free', kind: 'reply' }], trigger: { type: 'on_start' } },
      { body: 'VIP!', trigger: { type: 'on_button', button: 'vip' } },
      { body: 'Free!', trigger: { type: 'on_button', button: 'free' } },
    ],
  };

  it('checks Cas\'s JSON strictly: bad JSON, unknown fields, bad triggers and too many messages are refused', () => {
    const F = flows();
    const ok = F.cleanAiFlow('Sure! ' + JSON.stringify(good));
    assert.equal(ok.steps.length, 4);
    assert.deepEqual(ok.steps.map((x) => x.trigger && x.trigger.type), [null, 'on_start', 'on_button', 'on_button']);
    const bad = (o, re) => assert.throws(() => F.cleanAiFlow(typeof o === 'string' ? o : JSON.stringify(o)), (e) => e.code === 'ai_bad_flow' && re.test(e.message));
    bad('not json at all', /not JSON/);
    bad({ ...good, evil: 1 }, /unknown field "evil"/);
    bad({ ...good, messages: [{ ...good.messages[0], html: '<b>' }] }, /unknown field "html"/);
    bad({ ...good, messages: [good.messages[0], { body: 'x', buttons: [{ id: 'a', label: 'A', kind: 'reply', onclick: 'x' }] }] }, /unknown field "onclick"/);
    bad({ ...good, messages: [good.messages[0], { body: 'x', trigger: { type: 'on_button', button: 'missing' } }] }, /button trigger/);
    bad({ ...good, messages: [good.messages[0], { body: 'x', trigger: { type: 'rocket' } }] }, /trigger type/);
    bad({ ...good, messages: [good.messages[0], { body: 'x', trigger: { type: 'wait' } }] }, /needs seconds/);
    bad({ ...good, messages: [good.messages[0], { body: 'x', buttons: [{ label: 'L', kind: 'link', url: 'javascript:alert(1)' }] }] }, /button url/);
    bad({ ...good, messages: [] }, /no messages/);
    assert.throws(() => F.cleanAiFlow(JSON.stringify(good), { maxMessages: 3 }), /more than 3 messages/);
  });

  it('POST /api/ai/flow: builds a draft (not saved), one AI write per message; a refused answer costs one write', async () => {
    const s = await setup('growth');
    const used = async () => (await app.db.one('select ai_used from workspaces where id = $1', [s.ws.id])).ai_used;
    const before = await used();
    app.fakes.ai.script = [{ text: JSON.stringify(good) }];
    const r = await s.c.post('/api/ai/flow', { prompt: 'Welcome, tap start, then VIP or free tips' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.flow.steps.length, 4);
    assert.equal(r.body.flow.start_button, true);
    assert.equal(await used(), before + 4, 'one write per message');
    assert.equal((await app.db.one("select writes from ai_usage where workspace_id = $1 and kind = 'flow' order by id desc limit 1", [s.ws.id])).writes, 4);
    assert.equal((await s.c.get('/api/flows')).body.flows.length, 0, 'nothing saved');
    const prompt = JSON.stringify(app.fakes.ai.calls[app.fakes.ai.calls.length - 1].messages);
    assert.match(prompt, /ONLY one JSON object/);
    // The draft saves as it is.
    const save = await s.c.post('/api/flows', { ...r.body.flow, chat_id: s.chanId, bot_id: s.bot.connId });
    assert.equal(save.status, 200, save.text);
    app.fakes.ai.script = [{ text: JSON.stringify({ ...good, extra: true }) }];
    const b = await s.c.post('/api/ai/flow', { prompt: 'Something that makes Cas drift' });
    assert.equal(b.status, 422);
    assert.equal(b.body.code, 'ai_bad_flow');
    assert.equal(await used(), before + 5);
    // Free: no Cas.
    const f = await setup('free');
    assert.equal((await f.c.post('/api/ai/flow', { prompt: 'Welcome and a reminder' })).body.code, 'plan_feature');
  });
});

describe('broadcast tie-in', () => {
  it('"N people tapped Start": an audience "Tapped Start in <flow>" that Starter can broadcast to (only those people)', async () => {
    const s = await setup('starter');
    const id = await live(s, flow(s, [m('Welcome!'), m('Thanks for tapping Start', { trigger: { type: 'on_start' } })], { name: 'Promo flow' }));
    const [a, b, c] = [nextUser(), nextUser(), nextUser()];
    for (const u of [a, b, c]) await joinRequest(s, u);
    await app.start(s.bot.connId, a); await app.start(s.bot.connId, b);
    await app.start(s.bot.connId, nextUser()); // started the bot, not through this flow
    assert.equal((await s.c.get('/api/flows/' + id)).body.flow.started_count, 2);
    const aud = await s.c.post(`/api/flows/${id}/audience`);
    assert.equal(aud.status, 200, aud.text);
    assert.equal(aud.body.name, 'Tapped Start in Promo flow');
    assert.equal(aud.body.count, 2);
    assert.equal(aud.body.bot_id, s.bot.connId);
    assert.equal((await s.c.post(`/api/flows/${id}/audience`)).body.segment_id, aud.body.segment_id, 'made once');
    const segs = (await s.c.get('/api/segments')).body.segments;
    assert.deepEqual(segs.find((x) => x.id === aud.body.segment_id).describe, ['Tapped Start in Promo flow']);
    const est = await s.c.get(`/api/broadcasts/estimate?connection_id=${s.bot.connId}&segment_id=${aud.body.segment_id}`);
    assert.equal(est.body.audience, 2);
    const bc = await s.c.post('/api/broadcasts', { connection_id: s.bot.connId, segment_id: aud.body.segment_id, body: 'Hello starters' });
    assert.equal(bc.status, 200, bc.text);
    await app.flush();
    for (const u of [a, b]) assert.ok(textsTo(s.bot.token, u).includes('Hello starters'));
    assert.ok(!textsTo(s.bot.token, c).includes('Hello starters'));
    // Free (no broadcasts) can't; other workspaces can't touch it.
    const o = await setup('starter');
    assert.equal((await o.c.post(`/api/flows/${id}/audience`)).status, 404);
    assert.equal((await o.c.post('/api/broadcasts', { connection_id: o.bot.connId, segment_id: aud.body.segment_id, body: 'x' })).status, 400);
  });
});

describe('the builder (public/js/app-flows.js)', () => {
  it('plain sentences, the interactive preview, and everything escaped', () => {
    const ui = loadUi();
    const J = (x) => JSON.parse(JSON.stringify(x)); // arrays made inside the sandbox
    const evil = '<img src=x onerror=alert(1)>';
    const E = { approve_mode: 'after_welcome', start_button: true, start_label: evil, steps: [
      { body: 'Hi ' + evil, buttons: [], trigger: null },
      { body: 'Please tap the button above 👆', buttons: [], trigger: { type: 'after_previous' } },
      { body: 'Pick', buttons: [{ id: 'vip', label: evil, kind: 'reply' }, { id: 'free', label: '"><script>x()</script>', kind: 'reply' }], trigger: { type: 'on_start' } },
      { body: 'Reminder', buttons: [], trigger: { type: 'no_response', value: 10, unit: 'min' } },
      { body: 'VIP', buttons: [], trigger: { type: 'on_button', button: 'vip' } },
      { body: 'Free', buttons: [], trigger: { type: 'on_button', button: 'free' } },
      { body: 'Later', buttons: [{ id: 'shop', label: 'Shop', url: 'https://shop.example', kind: 'link' }], trigger: { type: 'wait', value: 2, unit: 'hour' } },
    ] };
    assert.equal(ui.wfWhen(E, 0), 'Sends the moment they ask to join');
    assert.equal(ui.wfWhen(E, 1), 'Sends right after the welcome');
    assert.equal(ui.wfWhen(E, 2), 'Sends the moment they tap Start');
    assert.equal(ui.wfWhen(E, 3), 'Sends if they haven\'t tapped a button after 10 minutes', 'they tapped Start already, so only the buttons count');
    assert.match(ui.wfWhen(E, 4), /^Sends when they tap "<img/, 'plain text: the HTML escapes it');
    assert.equal(ui.wfWhen(E, 6), 'Sends 2 hours after the message above');
    assert.equal(ui.wfWhen({ ...E, steps: [E.steps[0], { body: 'r', buttons: [], trigger: { type: 'no_response', value: 10, unit: 'min' } }] }, 1), 'Sends if they haven\'t tapped Start after 10 minutes');
    const html = ui.stepsHtml(E, { editable: true, has: () => true });
    for (const h of [html, ui.simHtml(E, ui.simRun(E, [{ start: true }]), { bot: evil })]) {
      assert.doesNotMatch(h, /<img src=x/i);
      assert.doesNotMatch(h, /<script>/i);
    }
    assert.equal((html.match(/When should the next message come\?/g) || []).length, 5, 'one chip between messages (a choice has one)');
    assert.equal((html.match(/class="fb-tab( on)?" data-btab/g) || []).length, 2, 'the two answers are tabs');
    assert.match(html, /Add the next message/);
    // The interactive preview follows the triggers: Start, then a button, then waits are skipped forward.
    let sim = ui.simRun(E, []);
    assert.deepEqual(J(sim.sent.map((x) => x.i)), [0, 1], 'welcome and "please tap" right away');
    assert.equal(sim.waitingFor, 'start');
    sim = ui.simRun(E, [{ start: true }]);
    assert.deepEqual(J(sim.sent.map((x) => x.i)), [0, 1, 2]);
    assert.equal(sim.waitingFor, 'button');
    assert.deepEqual(J(sim.timers.map((x) => x.kind)), ['reminder']);
    assert.deepEqual(J(ui.simRun(E, [{ start: true }, { skip: true }]).sent.map((x) => x.i)), [0, 1, 2, 3], 'no tap: the reminder comes');
    sim = ui.simRun(E, [{ start: true }, { tap: 'free' }]);
    assert.deepEqual(J(sim.sent.map((x) => x.i)), [0, 1, 2, 5]);
    assert.deepEqual(J(sim.timers.map((x) => x.kind)), ['wait'], 'the reminder was answered; the 2-hour wait can be skipped');
    sim = ui.simRun(E, [{ start: true }, { tap: 'free' }, { skip: true }, { tap: 'vip' }]);
    assert.deepEqual(J(sim.sent.map((x) => x.i)), [0, 1, 2, 5, 6, 4], 'a later tap on the other button gets its answer too');
    assert.equal(sim.waitingFor, null);
  });
});

/** Load core.js + app-flows.js into a sandbox with tiny browser stubs. */
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
  vm.runInContext('var PAGES = {}; var APP = { state: null }; var CFG = { features: {} };\n' + src + '\n;this.__ui = { stepsHtml, simRun, simHtml, wfWhen };', ctx);
  return ctx.__ui;
}

'use strict';
/*
 * "📲 Send a test to my Telegram" (services/flow-test.js) and the builder's new helpers (public/js/app-flows.js):
 *   - the test plays the builder's flow to the person's own Telegram, waits shortened to 3 seconds,
 *   - Start, Reply buttons and Link buttons work for real (fake Telegram), branches and reminders too,
 *   - nothing real is touched: no subscriber, run, delivery, click, reply, join request, approval or meter,
 *   - not linked → Link Telegram; bot never started → "open your bot and tap Start" then it begins by itself,
 *   - 10 tests an hour,
 *   - the builder: preview any step (the taps it takes to get there), the gentle checks (a step that can never come).
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
beforeEach(() => { app.rl._reset(); });

let chatSeq = -1007700000;
let tgSeq = 880000;
let emailSeq = 0;

async function setup(plan = 'growth', { linked = true } = {}) {
  const c = await app.loginByEmail(`fts-${++emailSeq}@example.com`, { name: 'Ejiro Tester' });
  const bot = await app.connectBot(c);
  const ws = await app.ws(c);
  const chat = --chatSeq;
  const chanId = (await app.db.one("insert into connections(workspace_id, kind, tg_chat_id, title) values ($1,'channel',$2,'Signals Channel') returning id", [ws.id, chat])).id;
  await app.db.query("update workspaces set plan_code = $2, plan_status = 'active', trial_ends_at = null, period_end = case when $2 = 'free' then null else now() + interval '20 days' end where id = $1", [ws.id, plan]);
  app.settings.bust();
  const tgId = ++tgSeq;
  if (linked) await app.db.query('update users set tg_user_id = $2 where id = $1', [c.user.id, tgId]);
  return { c, bot, ws, chat, chanId, tgId };
}
const m = (body, extra = {}) => ({ body, ...extra });
const flow = (s, steps, extra = {}) => ({ name: 'Test me', chat_id: s.chanId, bot_id: s.bot.connId, approve_mode: 'after_welcome', start_button: true, start_label: '👆 Tap Start', steps, ...extra });
const BRANCHES = () => [
  m('Hi {name} 👋 Welcome!'),
  m('Please tap Start above 👆', { trigger: { type: 'after_previous' } }),
  m('What would you like?', { buttons: [{ id: 'vip', label: '⭐ VIP signals', kind: 'reply', row: 0 }, { id: 'free', label: '📘 Free tips', kind: 'reply', row: 0 }], trigger: { type: 'on_start' } }),
  m('VIP it is ⭐', { buttons: [{ id: 'join', label: 'Join VIP', url: 'https://vip.example/join', kind: 'link' }], trigger: { type: 'on_button', button: 'vip' } }),
  m('Free tips 📘', { trigger: { type: 'on_button', button: 'free' } }),
  m('A day later: how is it going?', { trigger: { type: 'wait', value: 1, unit: 'day' } }),
];
const sends = (s) => app.fakes.tgCalls(null, s.bot.token).filter((x) => /^send(Message|Photo|Video|Animation)$/.test(x.method) && Number(x.params.chat_id) === s.tgId);
const texts = (s) => sends(s).map((x) => x.params.text || x.params.caption);
const kb = (s, text) => { const x = sends(s).find((y) => (y.params.text || '').includes(text)); return x && x.params.reply_markup ? x.params.reply_markup.inline_keyboard : null; };
let cq = 1;
const tap = (s, data) => app.telegramUpdate(s.bot.connId, { callback_query: { id: 'ft' + (cq++), from: { id: s.tgId, is_bot: false, first_name: 'Ejiro' }, chat_instance: 'x', data, message: { message_id: 1, chat: { id: s.tgId, type: 'private' } } } });
const testRow = (id) => app.db.one('select * from flow_tests where id = $1', [id]);
const tick = () => app.require('services/flow-test').tick();
const dueNow = (id) => app.db.query("update flow_tests set due_at = now() - interval '1 second' where id = $1", [id]);
async function counts(s) {
  const one = async (q) => (await app.db.one(q, [s.ws.id])).n;
  return {
    subs: await one('select count(*)::int n from subscribers x join connections c on c.id = x.connection_id where c.workspace_id = $1'),
    runs: await one('select count(*)::int n from sequence_runs r join sequences q on q.id = r.sequence_id where q.workspace_id = $1'),
    steps: await one('select count(*)::int n from flow_step_runs f join sequence_runs r on r.id = f.run_id join sequences q on q.id = r.sequence_id where q.workspace_id = $1'),
    deliveries: await one('select count(*)::int n from deliveries where workspace_id = $1'),
    clicks: await one('select count(*)::int n from clicks where workspace_id = $1'),
    replies: await one('select count(*)::int n from replies where workspace_id = $1'),
    joins: await one('select count(*)::int n from join_requests where workspace_id = $1'),
    meter: await one('select coalesce(sum(used), 0)::int n from join_meter where workspace_id = $1'),
    approvals: app.fakes.tgCalls('approveChatJoinRequest', s.bot.token).length + app.fakes.tgCalls('declineChatJoinRequest', s.bot.token).length,
  };
}

describe('send a test to my Telegram', () => {
  it('plays the flow for real: Start, a Reply button, its answer, a 3-second wait, then the end', async () => {
    const s = await setup();
    const before0 = await counts(s);
    const r = await s.c.post('/api/flows/tests', flow(s, BRANCHES()));
    assert.equal(r.status, 200, r.text);
    const t = r.body.test;
    assert.equal(t.total, 6);
    assert.equal(t.wait_seconds, 3);
    assert.equal(t.status, 'waiting', 'waits for them to tap Start');
    assert.equal(t.waiting_for, 'start');
    assert.equal(t.sent, 2);
    const tx = texts(s);
    assert.match(tx[0], /^🧪 Test of "Test me"/, 'a short note first');
    assert.equal(tx[1], 'Hi Ejiro 👋 Welcome!', '{name} is their own first name');
    assert.equal(tx[2], 'Please tap Start above 👆');
    const start = kb(s, 'Hi Ejiro')[0][0];
    const code = (await testRow(t.id)).code;
    assert.equal(start.url, `https://t.me/${s.bot.username}?start=cvt_${code}`, 'the test\'s own Start link');
    // Tap Start in Telegram → the message with the choices.
    await app.start(s.bot.connId, s.tgId, 'cvt_' + code, { first_name: 'Ejiro' });
    assert.equal(texts(s)[3], 'What would you like?');
    const choice = kb(s, 'What would you like?');
    assert.deepEqual(choice[0].map((b) => b.callback_data), [`cvt:${code}:vip`, `cvt:${code}:free`], 'test buttons, never cvb: (real taps)');
    let g = (await s.c.get('/api/flows/tests/' + t.id)).body.test;
    assert.equal(g.waiting_for, 'button');
    assert.deepEqual(g.waiting_buttons, ['⭐ VIP signals', '📘 Free tips']);
    // Tap "VIP signals" → its answer, then the 1-day wait is 3 seconds.
    await tap(s, choice[0][0].callback_data);
    assert.equal(texts(s)[4], 'VIP it is ⭐');
    assert.match(kb(s, 'VIP it is')[0][0].url, new RegExp(`/lt/${code}/join$`), 'a Link button goes through the test link');
    const row = await testRow(t.id);
    assert.equal(row.status, 'running');
    const inMs = new Date(row.due_at).getTime() - Date.now();
    assert.ok(inMs > 2000 && inMs <= 3100, 'the 1-day wait is 3 seconds (' + inMs + ' ms)');
    await tick();
    assert.equal(texts(s).length, 5, 'not before the 3 seconds');
    await app.sleep(Math.max(0, inMs) + 150);
    await tick();
    assert.equal(texts(s)[5], 'A day later: how is it going?');
    assert.match(texts(s)[6], /^✅ That's the whole flow!/);
    g = (await s.c.get('/api/flows/tests/' + t.id)).body.test;
    assert.equal(g.status, 'done');
    assert.equal(g.sent, 5, 'one path of the choice: 5 of 6 messages');
    assert.deepEqual(g.log.filter((x) => x.k !== 'sent').map((x) => x.k), ['start', 'tap']);
    // Nothing real happened.
    assert.deepEqual(await counts(s), before0);
    assert.equal(await app.db.one('select 1 from subscribers where connection_id = $1 and tg_user_id = $2', [s.bot.connId, s.tgId]), null, 'the test\'s Start is not a real Start');
  });

  it('a Link button counts as their tap (then opens the real address); double taps and old links are harmless', async () => {
    const s = await setup();
    const steps = [
      m('Welcome'),
      m('Pick one', { buttons: [{ id: 'shop', label: '🛍️ Shop', url: 'https://shop.example/x', kind: 'link' }] }),
      m('Thanks for looking 🛍️', { trigger: { type: 'on_button', button: 'shop' } }),
    ];
    const t = (await s.c.post('/api/flows/tests', flow(s, steps, { start_button: false }))).body.test;
    assert.equal(t.waiting_for, 'button');
    const url = kb(s, 'Pick one')[0][0].url;
    const p = new URL(url).pathname;
    const res = await fetch(app.url + p, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://shop.example/x');
    assert.equal(texts(s).slice(-2)[0], 'Thanks for looking 🛍️');
    await fetch(app.url + p, { redirect: 'manual' });
    assert.equal(texts(s).filter((x) => x === 'Thanks for looking 🛍️').length, 1, 'a second tap sends nothing twice');
    assert.equal((await testRow(t.id)).status, 'done');
    assert.equal((await fetch(app.url + p.replace(/\/shop$/, '/nope'), { redirect: 'manual' })).status, 404);
    assert.equal((await app.db.one('select count(*)::int n from clicks where workspace_id = $1', [s.ws.id])).n, 0);
    // A Reply button of an ended test: Telegram gets a friendly answer, nothing is sent.
    const before1 = texts(s).length;
    await tap(s, `cvt:${(await testRow(t.id)).code}:shop`);
    assert.equal(texts(s).length, before1);
    assert.ok(app.fakes.tgCalls('answerCallbackQuery', s.bot.token).some((x) => /ended/.test(x.params.text || '')));
  });

  it('reminders take 3 seconds too, and tapping Start in time cancels them', async () => {
    const s = await setup();
    const steps = [m('Welcome'), m('Still there? Tap Start 👆', { trigger: { type: 'no_response', value: 10, unit: 'min' } }), m('Thanks for tapping Start', { trigger: { type: 'on_start' } })];
    // 1. No tap: the reminder comes after 3 s.
    let t = (await s.c.post('/api/flows/tests', flow(s, steps))).body.test;
    assert.equal(t.status, 'running');
    assert.ok(t.next_in > 2000 && t.next_in <= 3100);
    await dueNow(t.id); await tick();
    assert.equal(texts(s).slice(-1)[0], 'Still there? Tap Start 👆');
    assert.equal((await testRow(t.id)).status, 'waiting');
    // 2. Tap Start in time: no reminder, the Start message comes.
    t = (await s.c.post('/api/flows/tests', flow(s, steps))).body.test;
    const n = texts(s).length;
    await app.start(s.bot.connId, s.tgId, ''); // a plain /start counts while the test waits for Start
    assert.equal(texts(s).slice(n).join('|'), 'Thanks for tapping Start|' + texts(s).slice(-1)[0]);
    await dueNow(t.id); await tick();
    assert.ok(!texts(s).slice(n).includes('Still there? Tap Start 👆'), 'the reminder was cancelled');
    assert.equal((await testRow(t.id)).status, 'done');
    assert.equal(await app.db.one('select 1 from subscribers where connection_id = $1 and tg_user_id = $2', [s.bot.connId, s.tgId]), null);
  });

  it('never touches a live flow\'s real people: their runs, deliveries, stats and meters stay the same', async () => {
    const s = await setup();
    const live = await s.c.post('/api/flows', { ...flow(s, BRANCHES()), active: true });
    assert.equal(live.status, 200, live.text);
    // A real person asks to join and taps Start.
    const real = 991001;
    await app.telegramUpdate(s.bot.connId, { chat_join_request: { chat: { id: s.chat, type: 'channel', title: 'Signals Channel' }, from: { id: real, first_name: 'Ada', is_bot: false }, user_chat_id: real, date: Math.floor(Date.now() / 1000) } });
    await app.jobs.dripsTick(); await app.drain();
    const run0 = await app.db.one('select r.* from sequence_runs r join subscribers x on x.id = r.subscriber_id where r.sequence_id = $1 and x.tg_user_id = $2', [live.body.id, real]);
    const before0 = await counts(s);
    const stats0 = (await s.c.get(`/api/flows/${live.body.id}/stats`)).body.stats;
    // The owner tests the same flow: Start, a tap, the wait, typing a message.
    const t = (await s.c.post('/api/flows/tests', { ...flow(s, BRANCHES()), flow_id: live.body.id })).body.test;
    const code = (await testRow(t.id)).code;
    await app.start(s.bot.connId, s.tgId, 'cvt_' + code);
    await tap(s, `cvt:${code}:free`);
    await app.telegramUpdate(s.bot.connId, { message: { message_id: 5, date: Math.floor(Date.now() / 1000), chat: { id: s.tgId, type: 'private' }, from: { id: s.tgId, is_bot: false, first_name: 'Ejiro' }, text: 'hello?' } });
    await dueNow(t.id); await tick();
    await app.jobs.dripsTick(); await app.drain();
    assert.equal((await testRow(t.id)).status, 'done');
    assert.deepEqual(await counts(s), before0, 'no subscriber, run, delivery, click, reply, join request, approval or meter');
    assert.deepEqual((await s.c.get(`/api/flows/${live.body.id}/stats`)).body.stats, stats0);
    const run1 = await app.db.one('select * from sequence_runs where id = $1', [run0.id]);
    assert.deepEqual([run1.status, run1.next_position], [run0.status, run0.next_position], 'the real person\'s run did not move');
    assert.ok(!app.fakes.tgCalls(null, s.bot.token).some((x) => Number(x.params.chat_id) === real && /Free tips/.test(x.params.text || '')), 'the real person got nothing from the test');
  });

  it('bot never started: "open your bot and tap Start", then the test begins by itself', async () => {
    const s = await setup();
    app.fakes.tg.block(s.tgId);
    const r = await s.c.post('/api/flows/tests', flow(s, BRANCHES()));
    assert.equal(r.status, 200, r.text);
    const t = r.body.test;
    assert.equal(t.status, 'need_start');
    const code = (await testRow(t.id)).code;
    assert.equal(t.start_url, `https://t.me/${s.bot.username}?start=cvt_${code}`);
    assert.equal(texts(s).length, 0);
    app.fakes.tg.unblock(s.tgId);
    await app.start(s.bot.connId, s.tgId, 'cvt_' + code, { first_name: 'Oghene' });
    const g = (await s.c.get('/api/flows/tests/' + t.id)).body.test;
    assert.equal(g.status, 'waiting');
    assert.equal(g.sent, 2);
    assert.equal(texts(s)[1], 'Hi Oghene 👋 Welcome!', 'the name from Telegram');
    assert.equal(await app.db.one('select 1 from subscribers where connection_id = $1 and tg_user_id = $2', [s.bot.connId, s.tgId]), null);
    // Stop: nothing more comes.
    assert.equal((await s.c.post(`/api/flows/tests/${t.id}/stop`)).body.test.status, 'stopped');
    const n = texts(s).length;
    await app.start(s.bot.connId, s.tgId, 'cvt_' + code);
    assert.match(texts(s).slice(n)[0], /This test has ended/);
  });

  it('not linked: Link Telegram first; the Free welcome keeps its branding line; 10 tests an hour', async () => {
    const n = await setup('growth', { linked: false });
    const r = await n.c.post('/api/flows/tests', flow(n, BRANCHES()));
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'tg_not_linked');
    assert.match(r.body.error, /Link your Telegram/);

    const f = await setup('free');
    const t = (await f.c.post('/api/flows/tests', flow(f, [m('Hi {name}!', { buttons: [{ id: 'site', label: 'Website', url: 'https://site.example', kind: 'link' }] })], { start_button: false }))).body.test;
    assert.equal(t.status, 'done');
    const w = sends(f).find((x) => /Hi Ejiro!/.test(x.params.text || ''));
    assert.match(w.params.text, /Free welcome bot by Castvoo\.com/, 'same as real people get');

    const s = await setup();
    for (let i = 0; i < 9; i++) assert.equal((await s.c.post('/api/flows/tests', flow(s, [m('Hello')], { start_button: false }))).status, 200);
    const tenth = await s.c.post('/api/flows/tests', flow(s, [m('Hello')], { start_button: false }));
    assert.equal(tenth.status, 200);
    const over = await s.c.post('/api/flows/tests', flow(s, [m('Hello')], { start_button: false }));
    assert.equal(over.status, 429);
    assert.equal(over.body.code, 'test_limit');
    assert.match(over.body.error, /10 tests this hour/);
    // Someone else's test is not mine.
    const other = await setup();
    assert.equal((await other.c.get('/api/flows/tests/' + tenth.body.test.id)).status, 404);
  });

  it('a new test stops the older one; the engine is pure and follows branches', () => {
    const ft = app.require('services/flow-test');
    const F = { start_button: true, steps: [
      { position: 1, trigger_type: 'after_previous', delay_seconds: 0, buttons: [] },
      { position: 2, trigger_type: 'on_start', delay_seconds: 0, buttons: [{ id: 'a' }, { id: 'b' }] },
      { position: 3, trigger_type: 'on_button', trigger_button: 'a', delay_seconds: 0, buttons: [] },
      { position: 4, trigger_type: 'on_button', trigger_button: 'b', delay_seconds: 0, buttons: [] },
      { position: 5, trigger_type: 'wait', delay_seconds: 86400 * 30, buttons: [] },
    ] };
    const st = ft.newState();
    let r = ft.run(F, st, 1000);
    assert.deepEqual(r.send, [0]); assert.equal(r.waitingFor, 'start');
    r = ft.run(F, st, 2000, { tap: 'a' });
    assert.ok(r.ignored, 'a button they have not seen yet');
    r = ft.run(F, st, 2000, { start: true });
    assert.deepEqual(r.send, [1]); assert.equal(r.waitingFor, 'button');
    r = ft.run(F, st, 3000, { tap: 'b' });
    assert.deepEqual(r.send, [3]); assert.equal(r.next, 6000, 'a 30-day wait is 3 seconds');
    assert.deepEqual(ft.run(F, st, 5999).send, []);
    r = ft.run(F, st, 6000);
    assert.deepEqual(r.send, [4]); assert.ok(r.done);
    r = ft.run(F, st, 7000, { tap: 'a' });
    assert.deepEqual(r.send, [2], 'the other button later still gets its answer');
  });
});

describe('the builder helpers (public/js/app-flows.js)', () => {
  const ui = loadUi();
  const J = (x) => JSON.parse(JSON.stringify(x));
  const E = { approve_mode: 'after_welcome', start_button: true, start_label: '', steps: [
    { body: 'Hi', buttons: [], trigger: null },
    { body: 'Tap Start please', buttons: [], trigger: { type: 'no_response', value: 10, unit: 'min' } },
    { body: 'Pick', buttons: [{ id: 'vip', label: 'VIP signals', kind: 'reply' }, { id: 'free', label: 'Free tips', kind: 'reply' }], trigger: { type: 'on_start' } },
    { body: 'VIP', buttons: [], trigger: { type: 'on_button', button: 'vip' } },
    { body: 'Free', buttons: [], trigger: { type: 'on_button', button: 'free' } },
    { body: 'Later', buttons: [], trigger: { type: 'wait', value: 1, unit: 'day' } },
  ] };

  it('preview a step: the taps it takes to get there (Start, then the right button of a choice)', () => {
    const p4 = ui.wfPathTo(E, 4);
    assert.ok(p4.ok);
    assert.deepEqual(J(p4.events), [{ start: true }, { tap: 'free' }], 'Start, then "Free tips" (not VIP)');
    assert.ok(ui.simRun(E, p4.events).sent.some((x) => x.i === 4));
    const p3 = ui.wfPathTo(E, 3);
    assert.deepEqual(J(p3.events), [{ start: true }, { tap: 'vip' }]);
    const p5 = ui.wfPathTo(E, 5);
    assert.ok(p5.ok && J(p5.events).some((x) => x.skip), 'the wait is skipped');
    assert.deepEqual(J(ui.wfPathTo(E, 1).events), [{ skip: true }], 'the reminder: they don\'t tap, time passes');
    assert.deepEqual(J(ui.wfPathTo(E, 0).events), []);
    assert.equal(ui.wfArrive(E, 0), 'Arrives the moment they ask to join');
    assert.equal(ui.wfArrive(E, 1), 'Arrives if they haven\'t tapped Start after 10 minutes');
    assert.equal(ui.wfArrive(E, 2), 'Arrives the moment they tap Start');
    assert.equal(ui.wfArrive(E, 3), 'Arrives when they tap \'VIP signals\'');
    assert.equal(ui.wfArrive(E, 5), 'Arrives 1 day after the last message');
    assert.equal(ui.wfArrive({ ...E, steps: [E.steps[0], { body: 'x', buttons: [], trigger: { type: 'after_previous' } }] }, 1), 'Arrives right after the welcome');
    // The step preview shows the auto taps as small system bubbles and the arrival line.
    const html = ui.wfStepPreviewHtml(E, 4, { bot: 'mybot', name: 'Ada' });
    assert.match(html, /You tapped Start ✓/);
    assert.match(html, /You tapped Free tips ✓/);
    assert.match(html, /Arrives when they tap &#39;Free tips&#39;|Arrives when they tap 'Free tips'/);
  });

  it('gentle checks: empty message, a button with no link, a step that can never come, a very long wait', () => {
    const bad = { approve_mode: 'after_welcome', start_button: false, start_label: '', steps: [
      { body: 'Hi', buttons: [{ id: 'l1', label: 'Shop', url: '', kind: 'link' }], trigger: null },
      { body: '', buttons: [], trigger: { type: 'after_previous' } },
      { body: 'Never', buttons: [], trigger: { type: 'on_button', button: 'gone' } },
      { body: 'Start one', buttons: [], trigger: { type: 'on_start' } },
      { body: 'Much later', buttons: [], trigger: { type: 'wait', value: 120, unit: 'day' } },
    ] };
    const tips = J(ui.wfTips(bad));
    const kinds = tips.map((x) => x.i + ':' + x.kind);
    assert.ok(kinds.includes('0:nolink'), kinds.join(','));
    assert.ok(kinds.includes('1:empty'));
    assert.ok(kinds.includes('2:unreachable'));
    assert.ok(kinds.includes('3:unreachable'), 'waits for Start, but there is no Start button');
    assert.ok(kinds.includes('4:longwait'));
    for (const t of tips) assert.doesNotMatch(t.text, /error|invalid|must/i, 'soft words: ' + t.text);
    assert.deepEqual(J(ui.wfTips(E)), [], 'a good flow: everything looks good');
    // A reminder that can never come: they always tapped already (nothing to wait for).
    const rem = { approve_mode: 'after_welcome', start_button: false, steps: [{ body: 'Hi', buttons: [], trigger: null }, { body: 'R', buttons: [], trigger: { type: 'no_response', value: 5, unit: 'min' } }] };
    assert.ok(J(ui.wfTips(rem)).some((x) => x.i === 1 && x.kind === 'unreachable'));
    assert.equal(ui.wfTipsSummary([]), 'Everything looks good ✨');
    assert.equal(ui.wfTipsSummary([{}, {}]), '2 small things to check');
    assert.equal(ui.wfTipsSummary([{}]), '1 small thing to check');
  });

  it('the whole-flow movie: plays in order, waits are a soft divider, pauses at Start and at a choice', () => {
    let v = ui.wfPlayNext(E, { events: [], choices: {} });
    assert.equal(v.pause, 'start', 'welcome, then they need to tap Start');
    v = ui.wfPlayNext(E, { events: [{ start: true }], choices: {} });
    assert.equal(v.pause, 'button');
    assert.deepEqual(J(v.choices), ['vip', 'free']);
    v = ui.wfPlayNext(E, { events: [{ start: true }, { tap: 'vip' }], choices: {} });
    assert.ok(v.auto && v.auto.skip, 'the 1-day wait is skipped by itself');
    v = ui.wfPlayNext(E, { events: [{ start: true }, { tap: 'vip' }, { skip: true }], choices: {} });
    assert.ok(v.done);
    assert.deepEqual(J(v.other), [{ owner: 2, id: 'free', label: 'Free tips' }], '"Watch the other path"');
    const html = ui.wfPlayHtml(E, { events: [{ start: true }, { tap: 'vip' }, { skip: true }], shown: 99, choices: {} }, { bot: 'b' });
    assert.match(html, /… 1 day later …/);
    assert.match(html, /That's the whole flow · 4 of 6 messages/);
    assert.match(ui.wfPlayHtml(E, { events: [{ start: true }], shown: 5, choices: {} }, {}), /Message 2 of 6/, 'progress while it plays');
  });
});

function loadUi() {
  const root = path.join(__dirname, '..', '..', 'public', 'js');
  const ctx = {
    console, URLSearchParams, URL, Date, Math, JSON, Intl, setTimeout, clearTimeout,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    document: { querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} }), documentElement: {}, body: {} },
    window: {}, location: { hash: '' }, localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {} },
    navigator: {}, history: {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  const src = ['core.js', 'app-flows.js'].map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n;\n');
  vm.runInContext('var PAGES = {}; var APP = { state: null }; var CFG = { features: {} };\n' + src + '\n;this.__ui = { simRun, wfPathTo, wfArrive, wfStepPreviewHtml, wfTips, wfTipsSummary, wfPlayNext, wfPlayHtml };', ctx);
  return ctx.__ui;
}

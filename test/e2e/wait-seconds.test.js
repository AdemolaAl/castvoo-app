'use strict';
/*
 * Wait timers in seconds ("Send right away", "Wait 2 seconds" ... "Wait 30 days") for Welcome Flows and auto
 * follow-ups, and Telegram's 5-minute window after a join request:
 *  - migration 017: delay_seconds backfilled from delay_minutes, the two kept in step by a trigger
 *  - validation: units sec/min/hour/day (and their long names), 0–999 seconds, 365 days in all; old fields still work
 *  - timing: short waits fire on time (workers/soon.js), not at the next 10-second poll
 *  - quick steps: messages in the first 5 minutes reach people who never tapped Start; letting them in waits for
 *    those messages in "After the welcome" and "Straight away" ("Tap to join" and "I decide" keep the request open)
 *  - the builder's labels and hint text
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
beforeEach(() => { app.rl._reset(); app.fakes.tg.joinError = null; app.fakes.ai.script = null; });

let chatSeq = -1008800000;
let userSeq = 990000;
let emailSeq = 0;
const nextUser = () => ++userSeq;

async function setup(plan = 'growth') {
  const c = await app.loginByEmail(`ws-${++emailSeq}@example.com`);
  const bot = await app.connectBot(c);
  const ws = await app.ws(c);
  const chat = --chatSeq;
  const chanId = (await app.db.one("insert into connections(workspace_id, kind, tg_chat_id, title) values ($1,'channel',$2,'Fast Channel') returning id", [ws.id, chat])).id;
  if (plan !== 'trial') {
    await app.db.query("update workspaces set plan_code = $2, plan_status = 'active', trial_ends_at = null, period_end = case when $2 = 'free' then null else now() + interval '20 days' end where id = $1", [ws.id, plan]);
  }
  return { c, bot, ws, chat, chanId };
}
const msg = (body, extra = {}) => ({ type: 'message', body, ...extra });
const wait = (value, unit = 'sec') => ({ type: 'wait', value, unit });
const flowBody = (s, extra = {}) => ({ name: 'Fast flow', chat_id: s.chanId, bot_id: s.bot.connId, approve_mode: 'after_welcome', blocks: [msg('Welcome!')], ...extra });
async function live(s, extra) {
  const r = await s.c.post('/api/flows', { ...flowBody(s, extra), active: true });
  assert.equal(r.status, 200, r.text);
  return r.body.id;
}
async function joinRequest(s, userId, extra = {}) {
  return app.telegramUpdate(s.bot.connId, { chat_join_request: { chat: { id: s.chat, type: 'channel', title: 'Fast Channel' }, from: { id: userId, first_name: 'Ada', is_bot: false }, user_chat_id: userId, date: Math.floor(Date.now() / 1000), ...extra } });
}
const sendsTo = (token, chat) => app.fakes.tgCalls(null, token).filter((x) => /^send/.test(x.method) && x.params.chat_id === chat);
const textsTo = (token, chat) => sendsTo(token, chat).map((x) => x.params.text || x.params.caption);
const approvals = (token, user) => app.fakes.tgCalls('approveChatJoinRequest', token).filter((x) => x.params.user_id === user);
const jrOf = (userId) => app.db.one('select * from join_requests where tg_user_id = $1 order by id desc limit 1', [userId]);
const runOf = (seqId) => app.db.one('select * from sequence_runs where sequence_id = $1 order by id desc limit 1', [seqId]);
const subOf = (s, u) => app.db.one('select * from subscribers where connection_id = $1 and tg_user_id = $2', [s.bot.connId, u]);
async function tickAndSend() { await app.jobs.dripsTick(); await app.drain(); }
const dueNow = (seqId) => app.db.query('update sequence_runs set due_at = now() where sequence_id = $1', [seqId]);

describe('migration 017 and the delay_seconds column', () => {
  it('backfills delay_seconds from delay_minutes, and keeps the two in step', async () => {
    const s = await setup();
    const seq = (await app.db.one("insert into sequences(workspace_id, connection_id, name, trigger_type) values ($1,$2,'Old','start') returning id", [s.ws.id, s.bot.connId])).id;
    // Run the real migration file again over a row made before it (no delay_seconds yet), inside a transaction we roll back.
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'migrations', '017_wait_seconds.sql'), 'utf8');
    let got = null;
    await app.db.tx(async (c) => {
      await c.query('alter table sequence_steps disable trigger sequence_steps_delay_sync');
      await c.query('alter table sequence_steps alter column delay_seconds drop not null');
      const id = (await c.query("insert into sequence_steps(sequence_id, position, delay_minutes, delay_seconds, body) values ($1, 1, 7, null, 'Old step') returning id", [seq])).rows[0].id;
      await c.query('alter table sequence_steps enable trigger sequence_steps_delay_sync');
      for (const stmt of app.db.splitSql(sql)) await c.query(stmt);
      const row = (await c.query('select delay_minutes, delay_seconds from sequence_steps where id = $1', [id])).rows[0];
      const notNull = (await c.query("select is_nullable from information_schema.columns where table_name = 'sequence_steps' and column_name = 'delay_seconds'")).rows[0].is_nullable;
      got = { row, notNull };
      throw new Error('roll back the test row');
    }).catch((e) => { if (e.message !== 'roll back the test row') throw e; });
    assert.deepEqual([got.row.delay_minutes, got.row.delay_seconds], [7, 420], '7 minutes = 420 seconds');
    assert.equal(got.notNull, 'NO');
    // Older code that writes only minutes still works; new code writes seconds and the minutes follow (rounded down).
    const a = await app.db.one("insert into sequence_steps(sequence_id, position, delay_minutes, body) values ($1, 2, 3, 'Minutes only') returning id, delay_seconds", [seq]);
    assert.equal(a.delay_seconds, 180);
    let r = await app.db.one('update sequence_steps set delay_minutes = 10 where id = $1 returning delay_seconds, delay_minutes', [a.id]);
    assert.deepEqual([r.delay_seconds, r.delay_minutes], [600, 10]);
    r = await app.db.one('update sequence_steps set delay_seconds = 95 where id = $1 returning delay_seconds, delay_minutes', [a.id]);
    assert.deepEqual([r.delay_seconds, r.delay_minutes], [95, 1]);
    await assert.rejects(app.db.query('update sequence_steps set delay_seconds = -1 where id = $1', [a.id]));
    // The migration ran exactly once on this database.
    assert.ok(await app.db.one("select 1 from schema_migrations where name = '017_wait_seconds.sql'"));
  });
});

describe('validation and labels', () => {
  let s;
  before(async () => { s = await setup(); });

  it('Welcome Flows: seconds, long unit names, "right away" and the limits', async () => {
    const r = await s.c.post('/api/flows', flowBody(s, { blocks: [msg('One'), wait(2), msg('Two'), wait(90, 'seconds'), msg('Three'), wait(2, 'minutes'), msg('Four')] }));
    assert.equal(r.status, 200, r.text);
    const steps = await app.db.many('select position, delay_seconds, delay_minutes from sequence_steps where sequence_id = $1 order by position', [r.body.id]);
    assert.deepEqual(steps.map((x) => [x.position, x.delay_seconds]), [[1, 0], [2, 2], [3, 90], [4, 120]]);
    assert.deepEqual(steps.map((x) => x.delay_minutes), [0, 0, 1, 2], 'minutes kept for older readers');
    const f = (await s.c.get('/api/flows/' + r.body.id)).body.flow;
    assert.deepEqual(f.blocks.filter((b) => b.type === 'wait').map((b) => [b.value, b.unit]), [[2, 'sec'], [90, 'sec'], [2, 'min']]);
    // "Send right away" = a wait of 0: the next message follows at once (no wait block when it is read back).
    const now = await s.c.post('/api/flows', flowBody(s, { name: 'Now', blocks: [msg('One'), wait(0), msg('Two')] }));
    assert.equal(now.status, 200, now.text);
    assert.deepEqual((await s.c.get('/api/flows/' + now.body.id)).body.flow.blocks.map((b) => b.type), ['message', 'message']);
    const bad = async (blocks) => (await s.c.post('/api/flows', flowBody(s, { blocks }))).status;
    assert.equal(await bad([msg('a'), wait(1000), msg('b')]), 400, 'seconds: 0 to 999');
    assert.equal(await bad([msg('a'), wait(-1), msg('b')]), 400);
    assert.equal(await bad([msg('a'), wait(2, 'weeks'), msg('b')]), 400, 'unknown unit');
    assert.equal(await bad([msg('a'), wait(365, 'day'), wait(1), msg('b')]), 400, '365 days in all');
    assert.equal(await bad([msg('a'), wait(365, 'day'), msg('b')]), 200);
  });

  it('auto follow-ups: delay_unit "sec", the older delay_minutes field, and the list shows delay_seconds', async () => {
    const r = await s.c.post('/api/drips', { name: 'Fast', connection_id: s.bot.connId, trigger_type: 'start', steps: [
      { delay_value: 0, delay_unit: 'sec', body: 'Right away' }, { delay_value: 5, delay_unit: 'sec', body: 'Five seconds' }, { delay_minutes: 2, body: 'Old field' }, { delay_seconds: 45, body: 'Seconds field' }] });
    assert.equal(r.status, 200, r.text);
    const q = (await s.c.get('/api/drips')).body.sequences.find((x) => x.id === r.body.id);
    assert.deepEqual(q.steps.map((x) => x.delay_seconds), [0, 5, 120, 45]);
    assert.equal((await s.c.post('/api/drips', { name: 'Bad', connection_id: s.bot.connId, trigger_type: 'start', steps: [{ delay_value: 1000, delay_unit: 'sec', body: 'x' }] })).status, 400);
    assert.equal((await s.c.post('/api/drips', { name: 'Bad', connection_id: s.bot.connId, trigger_type: 'start', steps: [{ delay_value: 365, delay_unit: 'day', body: 'x' }, { delay_value: 1, delay_unit: 'day', body: 'y' }] })).status, 400);
    const put = await s.c.put('/api/drips/' + r.body.id, { name: 'Fast', trigger_type: 'start', steps: [{ delay_value: 0, delay_unit: 'min', body: 'Hi' }, { delay_value: 3, delay_unit: 'seconds', body: 'Three' }] });
    assert.equal(put.status, 200, put.text);
    assert.deepEqual((await app.db.many('select delay_seconds from sequence_steps where sequence_id = $1 order by position', [r.body.id])).map((x) => x.delay_seconds), [0, 3]);
    await s.c.del('/api/drips/' + r.body.id);
  });

  it('Cas sequence writer: "sec" is a unit too', async () => {
    app.fakes.ai.script = [{ text: '[{"delay_value":0,"delay_unit":"min","body":"Hi"},{"delay_value":5,"delay_unit":"sec","body":"Quick tip"},{"delay_value":2,"delay_unit":"seconds","body":"And another"},{"delay_value":1,"delay_unit":"weeks","body":"Later"}]' }];
    const r = await s.c.post('/api/ai/sequence', { goal: 'Welcome and two quick tips', steps: 4 });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.steps.map((x) => [x.delay_value, x.delay_unit]), [[0, 'min'], [5, 'sec'], [2, 'sec'], [1, 'day']]);
    assert.match(app.fakes.ai.calls[app.fakes.ai.calls.length - 1].messages[0].content, /"sec", "min", "hour", "day"/);
  });

  it('labels: "1 second" / "2 seconds", and the builder explains the 5-minute window', async () => {
    const flows = app.require('services/flows');
    assert.deepEqual([flows.waitText(1), flows.waitText(2), flows.waitText(0), flows.waitText(60), flows.waitText(7200), flows.waitText(86400)], ['1 second', '2 seconds', 'right away', '1 minute', '2 hours', '1 day']);
    const ui = loadFlowsUi();
    assert.match(ui.wfUnitOptions(1, 'sec'), /value="sec" selected>second</);
    assert.match(ui.wfUnitOptions(2, 'sec'), /value="sec" selected>seconds</);
    assert.equal(ui.wfWait(1, 'sec'), '1 second');
    const blocks = [msg('Hi', { buttons: [], variants: [] }), wait(30), msg('Quick', { buttons: [], variants: [] }), wait(10, 'min'), msg('Later', { buttons: [], variants: [] })];
    const html = ui.blocksHtml(blocks, { editable: true });
    assert.equal((html.match(/Reaches everyone · first 5 min/g) || []).length, 1);
    assert.equal((html.match(/Reaches people who tapped Start/g) || []).length, 1);
    assert.match(html, /data-wnow="1">⚡ Send right away/);
    assert.match(html, /max="999"/);
    const two = [msg('a'), wait(30), wait(30), msg('b')];
    assert.equal(ui.wfMergeWaits(two), '1 minute');
    const rule = ui.wfRuleHtml({ approve_mode: 'after_welcome', blocks });
    assert.match(rule, /messages in the first 5 minutes reach everyone who asked to join\. Later messages reach people who tapped <b>Start<\/b>/);
    assert.match(rule, /lets them in right after your last message in the first 5 minutes/);
    assert.match(ui.wfRuleHtml({ approve_mode: 'manual', blocks }), /If you let someone in before those messages go out/);
    assert.doesNotMatch(ui.wfRuleHtml({ approve_mode: 'after_welcome', blocks: [msg('a'), wait(1, 'day'), msg('b')] }), /right after your last message/);
    // Cas and the support agents know it too (keyed knowledge defaults, synced on start).
    const kb = async (key) => (await app.db.one('select body from knowledge where key = $1', [key])).body;
    assert.match(await kb('five-minute-rule'), /Messages in the first 5 minutes reach everyone who asked to join/);
    assert.match(await kb('drips'), /1 to 999 seconds, minutes, hours or days/);
    assert.match(await kb('welcome-flows'), /Wait 2 seconds/);
  });
});

describe('quick steps and Telegram\'s 5-minute window', () => {
  it('short waits fire on time (within ~1.5 s), reach people who did not tap Start, then they are let in', async () => {
    const s = await setup();
    await live(s, { blocks: [msg('Welcome!'), wait(2), msg('Two seconds later'), wait(1), msg('One more second')] });
    const soon = app.require('workers/soon');
    soon.start(app.jobs.dripsTick);
    let stop = false;
    const senderLoop = (async () => { while (!stop) { await app.sender.tick(); await new Promise((r) => setTimeout(r, 500)); } })(); // the real sender loop: every 0.5 s
    try {
      const u = nextUser();
      await joinRequest(s, u);
      assert.equal(approvals(s.bot.token, u).length, 0, 'held: letting them in would end the window');
      const jr = await jrOf(u);
      assert.equal(jr.status, 'pending');
      assert.equal(jr.hold_position, 3);
      await app.waitFor(() => textsTo(s.bot.token, u).length === 3 && approvals(s.bot.token, u).length === 1, { timeout: 9000, message: 'quick steps and approval' });
      const [w, a, b] = sendsTo(s.bot.token, u);
      assert.deepEqual([w, a, b].map((x) => x.params.text), ['Welcome!', 'Two seconds later', 'One more second']);
      const gap1 = a.at - w.at, gap2 = b.at - a.at;
      assert.ok(gap1 >= 1900 && gap1 <= 3600, `2-second wait took ${gap1} ms`);
      assert.ok(gap2 >= 900 && gap2 <= 2600, `1-second wait took ${gap2} ms`);
      assert.ok(approvals(s.bot.token, u)[0].at >= b.at, 'let in after the last quick message');
      const after = await jrOf(u);
      assert.deepEqual([after.status, after.approve_at], ['approved', null]);
      assert.equal((await subOf(s, u)).status, 'joinreq', 'still not a bot subscriber (they never tapped Start)');
      const ds = await app.db.many('select status, join_request_id, priority from deliveries where subscriber_id = $1 and join_request_id is not null order by id', [(await subOf(s, u)).id]);
      assert.deepEqual(ds.map((d) => [d.status, d.join_request_id, d.priority]), [['sent', jr.id, 1], ['sent', jr.id, 1]]);
    } finally {
      stop = true; await senderLoop; await soon.stop();
    }
  });

  it('"after the welcome": a quick step goes to user_chat_id, they are let in after it, later steps wait for Start', async () => {
    const s = await setup();
    const id = await live(s, { blocks: [msg('Welcome!'), wait(30), msg('Quick tip'), wait(10, 'min'), msg('Later offer')] });
    const u = nextUser(), uc = u + 5000000;
    await joinRequest(s, u, { user_chat_id: uc });
    assert.deepEqual(textsTo(s.bot.token, uc), ['Welcome!']);
    let jr = await jrOf(u);
    assert.deepEqual([jr.status, jr.hold_position], ['pending', 2]);
    const holdFor = (new Date(jr.approve_at) - Date.now()) / 1000;
    assert.ok(holdFor > 40 && holdFor < 60, `held about 30 s + 20 s (${holdFor})`);
    let run = await runOf(id);
    assert.equal(run.status, 'active', 'the next message is quick, so the run is active (not waiting for Start)');
    assert.ok((new Date(run.due_at) - Date.now()) / 1000 > 25);
    await tickAndSend();
    assert.deepEqual(textsTo(s.bot.token, uc), ['Welcome!'], 'not due yet');
    await dueNow(id);
    await tickAndSend();
    assert.deepEqual(textsTo(s.bot.token, uc), ['Welcome!', 'Quick tip'], 'sent through the join request\'s user_chat_id');
    assert.equal(approvals(s.bot.token, u).length, 1);
    jr = await jrOf(u);
    assert.equal(jr.status, 'approved');
    run = await runOf(id);
    assert.ok((new Date(run.due_at) - Date.now()) / 60000 > 9.5, 'the next one is 10 minutes later');
    await dueNow(id);
    await tickAndSend();
    assert.equal((await runOf(id)).status, 'waiting', 'after the window: waits for Start');
    assert.equal(textsTo(s.bot.token, uc).length + textsTo(s.bot.token, u).length, 2);
    await app.start(s.bot.connId, u);
    await tickAndSend();
    assert.deepEqual(textsTo(s.bot.token, u), ['Later offer'], 'after Start it goes to their own chat');
  });

  it('"straight away" also waits for the quick messages; a skipped quick step still lets them in', async () => {
    const s = await setup();
    const id = await live(s, { approve_mode: 'instant', blocks: [msg('Welcome!', { buttons: [{ label: 'Go', url: 'https://go.example' }] }), wait(5), msg('Only if clicked', { condition: 'clicked' })] });
    const u = nextUser();
    await joinRequest(s, u);
    assert.equal(approvals(s.bot.token, u).length, 0);
    await dueNow(id);
    await tickAndSend();
    assert.deepEqual(textsTo(s.bot.token, u), ['Welcome!'], 'they did not click: skipped');
    assert.equal(approvals(s.bot.token, u).length, 1, 'let in anyway, at once');
    assert.equal((await jrOf(u)).status, 'approved');
  });

  it('"I decide" and "Tap to join": quick steps reach them and the request stays open for the owner / the tap', async () => {
    const s = await setup();
    let id = await live(s, { name: 'Manual', approve_mode: 'manual', blocks: [msg('Welcome!'), wait(10), msg('While you wait')] });
    const u = nextUser();
    await joinRequest(s, u);
    await dueNow(id);
    await tickAndSend();
    assert.deepEqual(textsTo(s.bot.token, u), ['Welcome!', 'While you wait']);
    let jr = await jrOf(u);
    assert.deepEqual([jr.status, jr.hold_position, approvals(s.bot.token, u).length], ['pending', null, 0]);
    await s.c.post(`/api/flows/${id}/toggle`, { active: false });
    id = await live(s, { name: 'Tap', approve_mode: 'tap', blocks: [msg('Tap below to get in'), wait(20), msg('Reminder: tap the button above')] });
    const v = nextUser();
    await joinRequest(s, v);
    await dueNow(id);
    await tickAndSend();
    assert.deepEqual(textsTo(s.bot.token, v), ['Tap below to get in', 'Reminder: tap the button above']);
    jr = await jrOf(v);
    assert.equal(jr.status, 'pending', 'they get in by tapping');
    await app.start(s.bot.connId, v, jr.start_code);
    assert.equal((await jrOf(v)).status, 'approved');
  });

  it('the window: no quick send after 5 minutes, held requests are let in when their time is up, a 403 is not a block', async () => {
    const s = await setup();
    const id = await live(s, { blocks: [msg('Welcome!'), wait(4, 'min'), msg('Four minutes later')] });
    const u = nextUser();
    await joinRequest(s, u);
    assert.equal((await jrOf(u)).hold_position, 2);
    // The person's request is older than the window (a slow server, a long pause): no quick send, they wait for Start.
    await app.db.query("update join_requests set requested_at = now() - interval '6 minutes', approve_at = now() - interval '1 second' where tg_user_id = $1", [u]);
    await dueNow(id);
    await tickAndSend();
    assert.deepEqual(textsTo(s.bot.token, u), ['Welcome!']);
    assert.equal((await runOf(id)).status, 'waiting');
    assert.equal(approvals(s.bot.token, u).length, 1, 'the held request was let in when its time was up');
    // Telegram answers 403 (the window closed early): the delivery fails, the person is not marked as blocked, and they are let in.
    const v = nextUser();
    await joinRequest(s, v);
    app.fakes.tg.block(v);
    try {
      await dueNow(id);
      await tickAndSend();
    } finally { app.fakes.tg.unblock(v); }
    const d = await app.db.one("select status, error from deliveries where join_request_id = (select id from join_requests where tg_user_id = $1) order by id desc limit 1", [v]);
    assert.equal(d.status, 'failed');
    assert.match(d.error, /5-minute window/);
    assert.equal((await subOf(s, v)).status, 'joinreq');
    assert.equal(approvals(s.bot.token, v).length, 1);
  });

  it('no hold when nothing is quick (first later message at 5 minutes or more)', async () => {
    const s = await setup();
    const id = await live(s, { blocks: [msg('Welcome!'), wait(5, 'min'), msg('Five minutes later')] });
    const u = nextUser();
    await joinRequest(s, u);
    assert.equal(approvals(s.bot.token, u).length, 1, 'let in straight after the welcome, as before');
    const jr = await jrOf(u);
    assert.deepEqual([jr.status, jr.hold_position], ['approved', null]);
    assert.equal((await runOf(id)).status, 'waiting');
  });

  it('auto follow-ups: "right away" and seconds, on time through the fast path', async () => {
    const s = await setup();
    const r = await s.c.post('/api/drips', { name: 'Fast start', connection_id: s.bot.connId, trigger_type: 'start', steps: [{ delay_value: 0, delay_unit: 'sec', body: 'Hello now' }, { delay_value: 2, delay_unit: 'sec', body: 'Two seconds later' }] });
    assert.equal(r.status, 200, r.text);
    const soon = app.require('workers/soon');
    soon.start(app.jobs.dripsTick);
    let stop = false;
    const senderLoop = (async () => { while (!stop) { await app.sender.tick(); await new Promise((res) => setTimeout(res, 500)); } })();
    try {
      const u = nextUser();
      const t0 = Date.now();
      await app.start(s.bot.connId, u);
      await app.waitFor(() => textsTo(s.bot.token, u).filter((x) => /^(Hello now|Two seconds later)$/.test(x)).length === 2, { timeout: 8000, message: 'follow-up steps' });
      const [a, b] = sendsTo(s.bot.token, u).filter((x) => /^(Hello now|Two seconds later)$/.test(x.params.text));
      assert.ok(a.at - t0 < 1800, `"right away" took ${a.at - t0} ms`);
      assert.ok(b.at - a.at >= 1900 && b.at - a.at <= 3600, `2-second wait took ${b.at - a.at} ms`);
    } finally {
      stop = true; await senderLoop; await soon.stop();
    }
  });
});

/** Load core.js + app-flows.js into a sandbox with tiny browser stubs (same as welcome-flows.test.js). */
function loadFlowsUi() {
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
  vm.runInContext('var PAGES = {}; var APP = { state: null }; var CFG = { features: {} };\n' + src + '\n;this.__ui = { blocksHtml, wfUnitOptions, wfMergeWaits, wfWait, wfRuleHtml };', ctx);
  return ctx.__ui;
}

'use strict';
/*
 * Supervisor QA of the Bots release (docs/SUPERVISOR-VERDICT-BOTS.md): one regression test per bug fixed.
 *   S-1  a drop to a smaller plan (Free, or a paid renewal at a smaller plan) pauses Chat bots the plan can't run
 *   S-2  answers hidden over a month's limit come back after an upgrade and next month; a re-answer never hides one
 *   S-3  a choice button of an older question still counts while another Chat bot also waits on a question
 *   S-4  an answer typed while a /start had just woken the run is not lost
 *   S-5  getChatMember "user not found" is "not joined yet", not "try again later" forever
 *   S-6  an "Invite friends" message that would be too long once the link is filled in is refused at save
 *   S-7  a Telegram resend of the same update_id is handled once (a typed answer can't answer the next question)
 *   S-8  "📊 My progress" of a bot without an invite step makes no invite code
 *   S-9  the CSV's Username column has no "@" (no formula guard apostrophe on every username)
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { if (app) await app.stop(); });
beforeEach(() => { app.rl._reset(); app.fakes.tg.chatMember = null; app.fakes.tg.chatMemberError = null; });

let chatSeq = -1007900000;
let userSeq = 990000;
let emailSeq = 0;
const nextUser = () => ++userSeq;

async function setPlan(wsId, code) {
  await app.db.query("update workspaces set plan_code = $2, plan_status = 'active', trial_ends_at = null, period_end = case when $2 = 'free' then null else now() + interval '20 days' end where id = $1", [wsId, code]);
  app.settings.bust();
}
async function setup(plan = 'growth') {
  const c = await app.loginByEmail(`botsup-${++emailSeq}@example.com`);
  const ws = await app.ws(c);
  await setPlan(ws.id, plan);
  const bot = await app.connectBot(c);
  const chanId = (await app.db.one("insert into connections(workspace_id, kind, tg_chat_id, title) values ($1,'channel',$2,'Signals Channel') returning id", [ws.id, --chatSeq])).id;
  return { c, bot, ws, chanId };
}
const chatBot = (s, steps, extra = {}) => ({ start_type: 'bot_start', name: 'My bot', bot_id: s.bot.connId, start_code: 'gift', steps, ...extra });
async function save(s, body, active = true) {
  const r = await s.c.post('/api/flows', { ...body, active });
  assert.equal(r.status, 200, r.text);
  return r.body.id;
}
let cq = 1;
async function tap(s, userId, data) {
  return app.telegramUpdate(s.bot.connId, { callback_query: { id: 'sq' + (cq++), from: { id: userId, is_bot: false, first_name: 'Ada' }, chat_instance: 'x', data, message: { message_id: 1, chat: { id: userId, type: 'private' } } } });
}
const msg = (userId, text) => ({ message: { message_id: 2, date: Math.floor(Date.now() / 1000), chat: { id: userId, type: 'private' }, from: { id: userId, is_bot: false, first_name: 'Ada' }, text } });
async function say(s, userId, text) { return app.telegramUpdate(s.bot.connId, msg(userId, text)); }
const sendsTo = (token, chat) => app.fakes.tgCalls(null, token).filter((x) => /^send/.test(x.method) && x.params.chat_id === chat);
const lastTo = (token, chat) => { const a = sendsTo(token, chat); return a[a.length - 1]; };
async function tick() { await app.jobs.dripsTick(); await app.drain(); }
const subOf = (s, u) => app.db.one('select * from subscribers where connection_id = $1 and tg_user_id = $2', [s.bot.connId, u]);
const runOf = async (id, s, u) => app.db.one('select * from sequence_runs where sequence_id = $1 and subscriber_id = $2', [id, (await subOf(s, u)).id]);
const liveOf = async (wsId) => Object.fromEntries((await app.db.many("select trigger_value, active, paused_by_plan from sequences where workspace_id = $1 and trigger_type = 'bot_start' order by id", [wsId])).map((r) => [r.trigger_value, r.active]));

describe('S-1: a smaller plan pauses the Chat bots it cannot run', () => {
  it('a drop to Free pauses a question bot and a bot with more messages than Free sends (they used to keep running)', async () => {
    const s = await setup('starter');
    await save(s, chatBot(s, [{ body: 'Hi' }, { type: 'ask', body: 'Email?', ask: { answer: 'email' } }, { body: 'Thanks' }], { start_code: 'leads' }));
    await save(s, chatBot(s, [{ body: 'One' }, { body: 'Two', trigger: { type: 'wait', value: 1, unit: 'day' } }], { start_code: 'two' }));
    await save(s, chatBot(s, [{ body: 'Gift' }], { start_code: 'gift' }));
    await app.require('services/billing').dropToFree(s.ws.id);
    assert.deepEqual(await liveOf(s.ws.id), { leads: false, two: false, gift: true }, 'only the bot that fits Free stays live');
    const p = await app.db.one("select paused_by_plan from sequences where workspace_id = $1 and trigger_value = 'leads'", [s.ws.id]);
    assert.equal(p.paused_by_plan, true);
  });

  it('a paid renewal at a smaller plan (Growth → Starter) pauses invite bots and bots over its limits', async () => {
    const s = await setup('growth');
    await save(s, chatBot(s, [{ type: 'referral', body: 'Invite {goal}: {invite_link}', referral: { goal: 2 } }, { body: 'Reward', trigger: { type: 'on_goal' } }], { start_code: 'ref' }));
    const six = [{ body: 'Hi' }].concat([1, 2, 3, 4, 5, 6].map((n) => ({ type: 'ask', body: 'Q' + n, ask: { answer: 'text', label: 'Q' + n } })));
    await save(s, chatBot(s, six, { start_code: 'six' }));
    await save(s, chatBot(s, [{ body: 'Hi' }, { type: 'ask', body: 'Email?', ask: { answer: 'email' } }], { start_code: 'one' }));
    await app.db.query('update workspaces set wallet_cents = 1000000 where id = $1', [s.ws.id]);
    const r = await app.require('services/billing').activate(s.ws.id, 'starter', 'month');
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(await liveOf(s.ws.id), { ref: false, six: false, one: true }, 'Starter: no invite bots, 5 questions per bot at most');
  });
});

describe('S-2: hidden answers come back', () => {
  it('after an upgrade (room in the bigger plan) and next month; a re-answer never hides a visible answer', async () => {
    const s = await setup('starter');
    const id = await save(s, chatBot(s, [{ body: 'Hi' }, { type: 'ask', body: 'Email?', ask: { answer: 'email', label: 'Email' } }, { body: 'Thanks' }], { start_code: 'leads' }));
    const sub = (await app.db.one("insert into subscribers(connection_id, tg_user_id, first_name) values ($1, 4242001, 'Filler') returning id", [s.bot.connId])).id;
    await app.db.query("insert into bot_answers(workspace_id, sequence_id, step_id, subscriber_id, answer) select $1, $2, null, $3, 'x' from generate_series(1, 1100)", [s.ws.id, id, sub]);
    const u = nextUser();
    await app.start(s.bot.connId, u, 'leads');
    await tick();
    await say(s, u, 'late@example.com');
    await tick();
    assert.equal((await app.db.one("select hidden from bot_answers where answer = 'late@example.com'")).hidden, true);
    let v = (await s.c.get(`/api/bots/${id}/answers`)).body;
    assert.equal(v.hidden, 1, 'still hidden on the same plan');
    // A hidden answer from last month.
    const u2 = nextUser();
    await app.start(s.bot.connId, u2, 'leads');
    await tick();
    await say(s, u2, 'old@example.com');
    await tick();
    await app.db.query("update bot_answers set hidden = true, created_at = date_trunc('month', now()) - interval '3 days' where answer = 'old@example.com'");
    v = (await s.c.get(`/api/bots/${id}/answers`)).body;
    const step = String(v.questions[0].step_id);
    const tgOf = (x) => v.people.find((p) => p.tg_user_id === x);
    assert.equal(tgOf(u2).answers[step], 'old@example.com', 'last month\'s hidden answer shows again this month');
    assert.equal(tgOf(u).answers[step], null);
    await setPlan(s.ws.id, 'growth');
    v = (await s.c.get(`/api/bots/${id}/answers`)).body;
    assert.equal(v.hidden, 0);
    assert.equal(v.people.find((p) => p.tg_user_id === u).answers[step], 'late@example.com', 'shown after the upgrade');
    // Back on Starter (over the month again): answering the same question again keeps it visible.
    await setPlan(s.ws.id, 'starter');
    await app.start(s.bot.connId, u, 'leads');
    await tick();
    await say(s, u, 'again@example.com');
    await tick();
    assert.deepEqual(await app.db.one("select answer, hidden from bot_answers where answer = 'again@example.com'"), { answer: 'again@example.com', hidden: false });
  });
});

describe('S-3 / S-4: questions of two Chat bots, and a run woken by /start', () => {
  it('a choice button of the older question is saved (it used to say "answered already" and drop it)', async () => {
    const s = await setup('starter');
    const a = await save(s, chatBot(s, [{ type: 'ask', body: 'A: pick', ask: { answer: 'choice', label: 'A', choices: ['Red', 'Blue'] } }, { body: 'A done' }], { start_code: 'qa' }));
    const b = await save(s, chatBot(s, [{ type: 'ask', body: 'B: pick', ask: { answer: 'choice', label: 'B', choices: ['Cat', 'Dog'] } }, { body: 'B done' }], { start_code: 'qb' }));
    const u = nextUser();
    await app.start(s.bot.connId, u, 'qa');
    await tick();
    const kbA = lastTo(s.bot.token, u).params.reply_markup.inline_keyboard.flat();
    await app.start(s.bot.connId, u, 'qb');
    await tick();
    assert.equal(lastTo(s.bot.token, u).params.text, 'B: pick');
    await tap(s, u, kbA[1].callback_data);
    await tick();
    assert.equal(lastTo(s.bot.token, u).params.text, 'A done');
    assert.equal((await app.db.one('select answer from bot_answers where sequence_id = $1', [a])).answer, 'Blue');
    assert.equal((await runOf(a, s, u)).status, 'done');
    assert.equal((await runOf(b, s, u)).status, 'awaiting', 'B still waits for its own answer');
  });

  it('a typed answer while the run is "active" for a moment (woken by a /start) is still saved', async () => {
    const s = await setup('starter');
    const id = await save(s, chatBot(s, [{ type: 'ask', body: 'Email?', ask: { answer: 'email' } }, { body: 'Thanks' }], { start_code: 'em' }));
    const u = nextUser();
    await app.start(s.bot.connId, u, 'em');
    await tick();
    const run = await runOf(id, s, u);
    await app.db.query("update sequence_runs set status = 'active' where id = $1", [run.id]);
    await say(s, u, 'woke@example.com');
    await tick();
    assert.equal((await app.db.one('select answer from bot_answers where sequence_id = $1', [id])).answer, 'woke@example.com');
    assert.equal(lastTo(s.bot.token, u).params.text, 'Thanks');
  });
});

describe('S-5: join check when Telegram says "user not found"', () => {
  it('is a gentle "not joined yet", not "try again in a minute"', async () => {
    const s = await setup('starter');
    const id = await save(s, chatBot(s, [{ type: 'check_join', body: 'Join first 👇', check: { chat_id: s.chanId, nudge: 'Join first, then tap again 🙂' } }, { body: 'In!' }], { start_code: 'join' }));
    const u = nextUser();
    await app.start(s.bot.connId, u, 'join');
    await tick();
    const cb = lastTo(s.bot.token, u).params.reply_markup.inline_keyboard[1][0].callback_data;
    app.fakes.tg.chatMemberError = 'Bad Request: user not found';
    await tap(s, u, cb);
    const ans = app.fakes.tgCalls('answerCallbackQuery', s.bot.token).pop();
    assert.equal(ans.params.text, 'Join first, then tap again 🙂');
    assert.equal((await runOf(id, s, u)).status, 'awaiting');
    // Any other error is still "couldn't check".
    app.fakes.tg.chatMemberError = 'Bad Request: member list is inaccessible';
    await tap(s, u, cb);
    assert.match(app.fakes.tgCalls('answerCallbackQuery', s.bot.token).pop().params.text, /couldn't check/);
  });
});

describe('S-6: an invite message must fit once the link is filled in', () => {
  it('is refused at save when the filled-in text would pass 4,096 characters', async () => {
    const s = await setup('growth');
    const body = 'a'.repeat(4060) + ' {invite_link}';
    const r = await s.c.post('/api/flows', { ...chatBot(s, [{ type: 'referral', body, referral: { goal: 2 } }, { body: 'Reward', trigger: { type: 'on_goal' } }], { start_code: 'inv' }), active: false });
    assert.equal(r.status, 400, r.text);
    assert.match(r.body.error.message || r.body.error, /too long/);
    const ok = await s.c.post('/api/flows', { ...chatBot(s, [{ type: 'referral', body: 'a'.repeat(3900) + ' {invite_link}', referral: { goal: 2 } }, { body: 'Reward', trigger: { type: 'on_goal' } }], { start_code: 'inv2' }), active: false });
    assert.equal(ok.status, 200, ok.text);
  });
});

describe('S-7: a resent update (same update_id) is handled once', () => {
  it('a typed answer resent by Telegram does not also answer the next question', async () => {
    const s = await setup('starter');
    const id = await save(s, chatBot(s, [
      { type: 'ask', body: 'Your name?', ask: { answer: 'text', label: 'Name' } },
      { type: 'ask', body: 'Your city?', ask: { answer: 'text', label: 'City' } },
      { body: 'Thanks' },
    ], { start_code: 'nc' }));
    const u = nextUser();
    await app.start(s.bot.connId, u, 'nc');
    await tick();
    const upd = { update_id: 7700000 + u, ...msg(u, 'Ada') };
    await app.telegramUpdate(s.bot.connId, upd);
    await tick();
    assert.equal(lastTo(s.bot.token, u).params.text, 'Your city?');
    await app.telegramUpdate(s.bot.connId, upd);
    await tick();
    const rows = await app.db.many('select label, answer from bot_answers where sequence_id = $1 order by id', [id]);
    assert.deepEqual(rows.map((r) => [r.label, r.answer]), [['Name', 'Ada']]);
    assert.equal((await runOf(id, s, u)).status, 'awaiting');
  });
});

describe('S-8 / S-9: progress button and CSV', () => {
  it('"My progress" (cvr:) of a bot with no invite step makes no invite code', async () => {
    const s = await setup('growth');
    const id = await save(s, chatBot(s, [{ body: 'Hi' }], { start_code: 'plain' }));
    const u = nextUser();
    await app.start(s.bot.connId, u, 'plain');
    await tick();
    await tap(s, u, 'cvr:' + id);
    assert.equal((await app.db.one('select count(*)::int n from bot_invites where sequence_id = $1', [id])).n, 0);
  });

  it('the Username column is the plain username (cells starting with = + - @ are still made safe)', async () => {
    const s = await setup('starter');
    const id = await save(s, chatBot(s, [{ type: 'ask', body: 'Say', ask: { answer: 'text', label: 'Said' } }, { body: 'Ok' }], { start_code: 'csv' }));
    const u = nextUser();
    await app.start(s.bot.connId, u, 'csv', { username: 'ada_l' });
    await tick();
    await say(s, u, '=HYPERLINK("http://x")');
    await tick();
    const csv = (await s.c.get(`/api/bots/${id}/answers.csv`)).text;
    const line = csv.split('\r\n')[1];
    assert.match(line, /^User\d+,ada_l,\d+,"'=HYPERLINK\(""http:\/\/x""\)",/);
  });
});

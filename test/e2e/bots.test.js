'use strict';
/*
 * Bots (docs/BOTS.md): Chat bots (start links, plain Start), the new steps (Check they joined, Ask a question, Invite
 * friends) end to end with fake Telegram, answer validation, referral counting and anti-abuse, plan limits (bots,
 * types, steps, questions, menu buttons, referral bots, answers per month), the broadcast audience, the logged-in
 * devices cap, the flow test engine, and the builder's preview for the new steps (in a sandbox).
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
beforeEach(() => { app.rl._reset(); app.fakes.tg.chatMember = null; });

let chatSeq = -1007700000;
let userSeq = 880000;
let emailSeq = 0;
const nextUser = () => ++userSeq;

async function setPlan(wsId, code) {
  await app.db.query("update workspaces set plan_code = $2, plan_status = 'active', trial_ends_at = null, period_end = case when $2 = 'free' then null else now() + interval '20 days' end where id = $1", [wsId, code]);
  app.settings.bust();
}
async function setup(plan = 'growth') {
  const c = await app.loginByEmail(`bots-${++emailSeq}@example.com`);
  const ws = await app.ws(c);
  if (plan !== 'trial') await setPlan(ws.id, plan);
  const bot = await app.connectBot(c);
  const chat = --chatSeq;
  const chanId = (await app.db.one("insert into connections(workspace_id, kind, tg_chat_id, title) values ($1,'channel',$2,'Signals Channel') returning id", [ws.id, chat])).id;
  return { c, bot, ws, chat, chanId };
}
const chatBot = (s, steps, extra = {}) => ({ start_type: 'bot_start', name: 'My bot', bot_id: s.bot.connId, start_code: 'gift', steps, ...extra });
async function save(s, body, active = true) {
  const r = await s.c.post('/api/flows', { ...body, active });
  assert.equal(r.status, 200, r.text);
  return r.body.id;
}
let cq = 1;
async function tap(s, userId, data) {
  return app.telegramUpdate(s.bot.connId, { callback_query: { id: 'cq' + (cq++), from: { id: userId, is_bot: false, first_name: 'Ada' }, chat_instance: 'x', data, message: { message_id: 1, chat: { id: userId, type: 'private' } } } });
}
async function say(s, userId, text, extra = {}) {
  return app.telegramUpdate(s.bot.connId, { message: { message_id: 2, date: Math.floor(Date.now() / 1000), chat: { id: userId, type: 'private' }, from: { id: userId, is_bot: false, first_name: 'Ada' }, ...(text != null ? { text } : {}), ...extra } });
}
const sendsTo = (token, chat) => app.fakes.tgCalls(null, token).filter((x) => /^send/.test(x.method) && x.params.chat_id === chat);
const textsTo = (token, chat) => sendsTo(token, chat).map((x) => x.params.text || x.params.caption);
const lastTo = (token, chat) => { const a = sendsTo(token, chat); return a[a.length - 1]; };
const callbackAnswers = (token) => app.fakes.tgCalls('answerCallbackQuery', token);
async function tick() { await app.jobs.dripsTick(); await app.drain(); }
const subOf = (s, u) => app.db.one('select * from subscribers where connection_id = $1 and tg_user_id = $2', [s.bot.connId, u]);
const runOf = async (id, s, u) => app.db.one('select * from sequence_runs where sequence_id = $1 and subscriber_id = $2', [id, (await subOf(s, u)).id]);

describe('answer checks (no AI)', () => {
  it('text, number, email, phone and choice, with gentle retry words', () => {
    const v = app.require('services/bots').validateAnswer;
    assert.deepEqual(v('text', '  Ada Lovelace '), { ok: true, value: 'Ada Lovelace' });
    assert.equal(v('text', '').ok, false);
    assert.equal(v('text', '/start').ok, false, 'a command is never an answer');
    assert.deepEqual(v('number', '1,250'), { ok: true, value: '1250' });
    assert.deepEqual(v('number', '-3.5'), { ok: true, value: '-3.5' });
    assert.equal(v('number', 'twelve').ok, false);
    assert.match(v('number', 'x').message, /number/);
    assert.deepEqual(v('email', ' Ada@Example.COM '), { ok: true, value: 'ada@example.com' });
    for (const bad of ['ada', 'ada@', 'ada@example', 'a b@c.com', '@example.com']) assert.equal(v('email', bad).ok, false, bad);
    assert.deepEqual(v('phone', '+234 801 234 5678'), { ok: true, value: '+2348012345678' });
    assert.deepEqual(v('phone', { phone: '2348012345678' }), { ok: true, value: '2348012345678' });
    assert.equal(v('phone', '123').ok, false);
    assert.equal(v('phone', 'call me').ok, false);
    assert.equal(v('text', { phone: '+2348012345678' }).ok, false, 'a shared contact only answers a phone question');
    const cfg = { choices: ['⭐ Signals', 'Lessons'] };
    assert.deepEqual(v('choice', 'signals', cfg), { ok: true, value: '⭐ Signals' });
    assert.deepEqual(v('choice', '2', cfg), { ok: true, value: 'Lessons' });
    assert.equal(v('choice', 'other', cfg).ok, false);
    assert.equal(v('email', 'nope', { retry_text: 'Try again please' }).message, 'Try again please');
  });
  it('invite text: {invite_link}, {invites}, {goal}, and the link is added when the text has none', () => {
    const { fillInvite } = app.require('services/bots');
    assert.equal(fillInvite('Link {invite_link} · {invites}/{goal}', { link: 'L', invites: 2, goal: 3 }), 'Link L · 2/3');
    assert.match(fillInvite('Invite friends!', { link: 'https://t.me/x?start=r_a', invites: 0, goal: 3 }), /Invite friends!\n\n🔗 https:\/\/t\.me\/x\?start=r_a$/);
  });
});

describe('Chat bots: saving and the JSON the save API takes', () => {
  let s;
  before(async () => { s = await setup('growth'); });

  it('saves a Chat bot with its start code and gives back the step types (the builder\'s format)', async () => {
    const id = await save(s, chatBot(s, [
      { body: 'Hi {name} 👋' },
      { type: 'ask', body: 'Your email?', ask: { answer: 'email', label: 'Email' } },
      { type: 'check_join', body: 'Join first 👇', check: { chat_id: s.chanId, remind: { value: 5, unit: 'min' } } },
      { type: 'referral', body: 'Invite {goal}: {invite_link}', referral: { goal: 2 } },
      { body: 'Reward 🎁', trigger: { type: 'on_goal' } },
    ], { start_code: 'mix' }), false);
    const f = (await s.c.get('/api/flows/' + id)).body.flow;
    assert.equal(f.start_type, 'bot_start');
    assert.equal(f.start_code, 'mix');
    assert.equal(f.start_url, `https://t.me/${s.bot.username}?start=mix`);
    assert.deepEqual(f.steps.map((x) => x.type), ['message', 'ask', 'check_join', 'referral', 'message']);
    assert.equal(f.steps[1].ask.answer, 'email');
    assert.equal(f.steps[2].check.chat_id, s.chanId);
    assert.match(f.steps[2].check.link, /^https:\/\/t\.me\/\+/, 'a private channel gets an invite link made by the bot');
    assert.deepEqual([f.steps[2].check.remind.value, f.steps[2].check.remind.unit], [5, 'min']);
    assert.equal(f.steps[3].referral.goal, 2);
    assert.equal(f.steps[4].trigger.type, 'on_goal');
    assert.equal(f.bot_type, 'referral');
    // Saving it back unchanged keeps it (the builder round trip), and the list shows it under Chat bots.
    const r = await s.c.put('/api/flows/' + id, { start_type: 'bot_start', name: f.name, bot_id: f.bot_id, start_code: f.start_code, steps: f.steps });
    assert.equal(r.status, 200, r.text);
    const list = (await s.c.get('/api/flows')).body;
    assert.ok(list.chatbots.some((b) => b.id === id && b.start_code === 'mix'));
    assert.ok(list.bot_templates.find((t) => t.key === 'referral'));
    assert.equal(list.plan.limits.bots.max_bots, 15);
    const all = (await s.c.get('/api/bots')).body;
    assert.ok(all.chat_bots.some((b) => b.id === id));
    assert.equal(all.limits.referral_bots, 2);
  });

  it('refuses kindly: reserved codes, Start triggers in a Chat bot, questions in a Welcome bot, a check as the welcome, buttons on a special step, rewards without an invite step', async () => {
    const bad = async (body, rx) => { const r = await s.c.post('/api/flows', body); assert.equal(r.status, 400, r.text); assert.match(r.body.error.message || r.body.error, rx); };
    await bad(chatBot(s, [{ body: 'Hi' }], { start_code: 'j_abc' }), /used by Castvoo/);
    await bad(chatBot(s, [{ body: 'Hi' }], { start_code: 'has space' }), /letters, numbers/);
    await bad(chatBot(s, [{ body: 'Hi' }, { body: 'x', trigger: { type: 'on_start' } }]), /tapped Start already/);
    await bad(chatBot(s, [{ body: 'Hi' }, { body: 'x', trigger: { type: 'on_goal' } }]), /Invite friends/);
    await bad(chatBot(s, [{ body: 'Hi' }, { type: 'ask', body: 'Q', ask: { answer: 'choice', choices: ['A'] } }]), /at least 2 choices/);
    await bad(chatBot(s, [{ body: 'Hi' }, { type: 'check_join', body: 'Join', check: {} }]), /pick the channel/);
    await bad(chatBot(s, [{ body: 'Hi' }, { type: 'ask', body: 'Q', ask: { answer: 'text' }, buttons: [{ label: 'x', url: 'https://a.co' }] }]), /own buttons/);
    const welcome = { name: 'W', chat_id: s.chanId, bot_id: s.bot.connId, approve_mode: 'after_welcome' };
    await bad({ ...welcome, steps: [{ type: 'check_join', body: 'Join', check: { chat_id: s.chanId } }] }, /welcome is a normal message/);
    await bad({ ...welcome, steps: [{ body: 'Hi' }, { type: 'ask', body: 'Q', ask: { answer: 'text' } }] }, /Chat bots/);
  });

  it('a check step needs the bot to be an admin of that channel (friendly message at save time)', async () => {
    app.fakes.tg.chatMember = { status: 'left' };
    const r = await s.c.post('/api/flows', chatBot(s, [{ type: 'check_join', body: 'Join first', check: { chat_id: s.chanId } }, { body: 'Thanks' }], { start_code: 'jc' }));
    assert.equal(r.status, 409, r.text);
    assert.equal(r.body.error.code || r.body.code, 'bot_not_admin_check');
    assert.match(JSON.stringify(r.body), /needs to be an admin of \\"Signals Channel\\"/);
    app.fakes.tg.chatMember = null;
    const ok = await s.c.post('/api/bots/check-join', { bot_id: s.bot.connId, chat_id: s.chanId });
    assert.deepEqual(ok.body, { ok: true });
  });

  it('Welcome bots keep working as before and can have a "Check they joined" step', async () => {
    const id = await save(s, { name: 'Welcome + check', chat_id: s.chanId, bot_id: s.bot.connId, approve_mode: 'after_welcome', start_button: true, steps: [
      { body: 'Welcome {name}!' }, { type: 'check_join', body: 'Also join our main channel 👇', check: { chat_id: s.chanId } },
    ] }, false);
    const f = (await s.c.get('/api/flows/' + id)).body.flow;
    assert.equal(f.start_type, 'join_request');
    assert.equal(f.steps[1].type, 'check_join');
  });
});

describe('Chat bots: people open the bot', () => {
  let s, gift, def;
  before(async () => {
    s = await setup('free');
    gift = await save(s, chatBot(s, [{ body: 'Hi {name} 👋 Here is your gift', buttons: [{ id: 'g', label: '🎁 Open', url: 'https://example.com/gift', kind: 'link' }] }], { name: 'Gift', start_code: 'gift' }));
  });

  it('t.me/<bot>?start=<code> starts it: the person becomes a subscriber and gets the first message, with the Free line', async () => {
    const u = nextUser();
    await app.start(s.bot.connId, u, 'gift');
    await tick();
    const m = lastTo(s.bot.token, u);
    assert.match(m.params.text, /^Hi User\d+ 👋 Here is your gift/);
    assert.match(m.params.text, /⚡ <a href="[^"]+\/r\/[^"]+">Free bot by Castvoo\.com<\/a>$/);
    assert.equal(m.params.reply_markup.inline_keyboard.length, 1, 'no "Stop these messages" button in a Chat bot');
    assert.equal((await subOf(s, u)).status, 'active');
    assert.equal((await runOf(gift, s, u)).status, 'done');
    // Start again later: the gift comes again.
    await app.start(s.bot.connId, u, 'gift');
    await tick();
    assert.equal(textsTo(s.bot.token, u).filter((t) => /Here is your gift/.test(t)).length, 2);
  });

  it('a plain Start (or an unknown code) goes to the bot that answers plain Start; Welcome Tap Start links never do', async () => {
    const u = nextUser();
    await app.start(s.bot.connId, u);
    await tick();
    assert.equal(textsTo(s.bot.token, u).length, 0, 'no default bot yet');
    await app.db.query("update sequences set active = false where id = $1", [gift]);
    def = await save(s, chatBot(s, [{ body: 'Hello from the default bot' }], { name: 'Default', start_code: 'hello', is_default: true }));
    await app.start(s.bot.connId, u);
    await app.start(s.bot.connId, nextUser(), 'some_ad_tag');
    const v = nextUser();
    await app.start(s.bot.connId, v, 'j_abcdefghij');
    await tick();
    assert.deepEqual(textsTo(s.bot.token, u).map((t) => t.split('\n')[0]), ['Hello from the default bot']);
    assert.equal(textsTo(s.bot.token, v).length, 0);
    // Two live bots can't both answer plain Start on one Telegram bot.
    const r = await s.c.post('/api/flows', { ...chatBot(s, [{ body: 'Other' }], { name: 'Other', start_code: 'other', is_default: true }), active: true });
    assert.equal(r.status, 409);
    assert.match(r.body.error.message || r.body.error, /plain Start/);
    // Switching on a draft with the same start link: asked first, then "use this one" switches the other off.
    const draft = (await s.c.post('/api/flows', chatBot(s, [{ body: 'New hello' }], { name: 'New', start_code: 'HELLO' }))).body.id;
    const t1 = await s.c.post(`/api/flows/${draft}/toggle`, { active: true });
    assert.equal(t1.status, 409);
    assert.equal(t1.body.code, 'bot_live_clash');
    const t2 = await s.c.post(`/api/flows/${draft}/toggle`, { active: true, replace: true });
    assert.equal(t2.status, 200, t2.text);
    assert.equal(t2.body.replaced, def);
    assert.equal((await app.db.one('select active from sequences where id = $1', [def])).active, false);
  });
});

describe('Check they joined', () => {
  let s, id;
  before(async () => {
    s = await setup('starter');
    id = await save(s, chatBot(s, [
      { type: 'check_join', body: 'Please join our channel first 👇', check: { chat_id: s.chanId, remind: { value: 10, unit: 'min' }, nudge: 'Not yet 🙂 Join, then tap again.' } },
      { body: 'Welcome aboard! 🎉' },
    ], { start_code: 'join' }));
  });

  it('shows the link and "I\'ve joined ✅"; not joined → a gentle popup and nothing more; joined → the next message', async () => {
    const u = nextUser();
    await app.start(s.bot.connId, u, 'join');
    await tick();
    const m = lastTo(s.bot.token, u);
    assert.equal(m.params.text, 'Please join our channel first 👇');
    const kb = m.params.reply_markup.inline_keyboard;
    assert.equal(kb[0][0].text, '📣 Open the channel');
    assert.match(kb[0][0].url, /^https:\/\/t\.me\/\+/);
    assert.equal(kb[1][0].text, 'I\'ve joined ✅');
    assert.match(kb[1][0].callback_data, /^cvj:\d+$/);
    assert.equal((await runOf(id, s, u)).status, 'awaiting');
    app.fakes.tg.chatMember = { status: 'left' };
    await tap(s, u, kb[1][0].callback_data);
    const ans = callbackAnswers(s.bot.token).pop();
    assert.equal(ans.params.show_alert, true);
    assert.equal(ans.params.text, 'Not yet 🙂 Join, then tap again.');
    await tick();
    assert.equal(textsTo(s.bot.token, u).length, 1);
    app.fakes.tg.chatMember = { status: 'member' };
    await tap(s, u, kb[1][0].callback_data);
    await tick();
    assert.equal(textsTo(s.bot.token, u)[1], 'Welcome aboard! 🎉');
    assert.equal((await runOf(id, s, u)).status, 'done');
    // A double tap later does nothing more.
    await tap(s, u, kb[1][0].callback_data);
    await tick();
    assert.equal(textsTo(s.bot.token, u).length, 2);
    // The reminder was cancelled when they passed.
    const fsr = await app.db.one('select status from flow_step_runs where run_id = $1', [(await runOf(id, s, u)).id]);
    assert.equal(fsr.status, 'cancelled');
  });

  it('tapping Start again while the check waits shows the check again; a menu starts again from the top', async () => {
    const u = nextUser();
    await app.start(s.bot.connId, u, 'join');
    await tick();
    await app.start(s.bot.connId, u, 'join');
    await tick();
    assert.deepEqual(textsTo(s.bot.token, u), ['Please join our channel first 👇', 'Please join our channel first 👇']);
    assert.equal((await runOf(id, s, u)).status, 'awaiting');
    const menu = await save(s, chatBot(s, [{ body: 'Pick', buttons: [{ id: 'a', label: 'A', kind: 'reply' }] }, { body: 'You picked A', trigger: { type: 'on_button', button: 'a' } }], { start_code: 'menu2' }));
    await app.start(s.bot.connId, u, 'menu2');
    await tick();
    await app.start(s.bot.connId, u, 'menu2');
    await tick();
    assert.equal(textsTo(s.bot.token, u).filter((t) => t === 'Pick').length, 2);
    assert.equal((await runOf(menu, s, u)).status, 'awaiting');
  });

  it('a reminder comes if they don\'t tap in time (with the same two buttons), only once', async () => {
    const u = nextUser();
    await app.start(s.bot.connId, u, 'join');
    await tick();
    const run = await runOf(id, s, u);
    await app.db.query('update flow_step_runs set due_at = now() where run_id = $1', [run.id]);
    await tick();
    const texts = textsTo(s.bot.token, u);
    assert.equal(texts.length, 2);
    assert.match(texts[1], /gentle reminder/);
    assert.equal(lastTo(s.bot.token, u).params.reply_markup.inline_keyboard[1][0].text, 'I\'ve joined ✅');
    await tick();
    assert.equal(textsTo(s.bot.token, u).length, 2);
  });
});

describe('Ask a question', () => {
  let s, id;
  before(async () => {
    s = await setup('starter');
    id = await save(s, chatBot(s, [
      { body: 'Hi {name}! A few questions.' },
      { type: 'ask', body: 'What is your email?', ask: { answer: 'email', label: 'Email' } },
      { type: 'ask', body: 'Your phone?', ask: { answer: 'phone', label: 'Phone' } },
      { type: 'ask', body: 'Pick one', ask: { answer: 'choice', label: 'Interest', choices: ['Signals', 'Lessons'] } },
      { body: 'Thank you! 🙌' },
    ], { start_code: 'leads' }));
  });

  it('waits for each answer, checks it, saves it, then goes on (typed, shared number, choice button)', async () => {
    const u = nextUser();
    await app.start(s.bot.connId, u, 'leads');
    await tick();
    assert.deepEqual(textsTo(s.bot.token, u), ['Hi User' + u + '! A few questions.', 'What is your email?']);
    await say(s, u, 'not an email');
    assert.match(lastTo(s.bot.token, u).params.text, /doesn't look like an email/);
    await say(s, u, 'Ada@Example.com');
    await tick();
    const phoneQ = lastTo(s.bot.token, u);
    assert.equal(phoneQ.params.text, 'Your phone?');
    assert.equal(phoneQ.params.reply_markup.keyboard[0][0].request_contact, true);
    await say(s, u, null, { contact: { phone_number: '+2348012345678', user_id: u, first_name: 'Ada' } });
    await tick();
    const choiceQ = lastTo(s.bot.token, u);
    assert.equal(choiceQ.params.text, 'Pick one');
    const kb = choiceQ.params.reply_markup.inline_keyboard.flat();
    assert.deepEqual(kb.map((b) => b.text), ['Signals', 'Lessons']);
    await tap(s, u, kb[1].callback_data);
    await tick();
    assert.equal(lastTo(s.bot.token, u).params.text, 'Thank you! 🙌');
    const rows = await app.db.many('select label, answer, hidden from bot_answers where sequence_id = $1 order by id', [id]);
    assert.deepEqual(rows.map((r) => [r.label, r.answer, r.hidden]), [['Email', 'ada@example.com', false], ['Phone', '+2348012345678', false], ['Interest', 'Lessons', false]]);
    // The Leads view and the CSV file (owner).
    const v = (await s.c.get(`/api/bots/${id}/answers`)).body;
    assert.deepEqual(v.questions.map((q) => q.label), ['Email', 'Phone', 'Interest']);
    assert.equal(v.people.length, 1);
    assert.equal(v.people[0].answers[String(v.questions[0].step_id)], 'ada@example.com');
    const csv = await s.c.get(`/api/bots/${id}/answers.csv`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.text.split('\r\n')[0], /^First name,Username,Telegram ID,Email,Phone,Interest,Answered at$/);
    assert.match(csv.text, /ada@example\.com,'\+2348012345678,Lessons/, 'a phone number starting with + is not run as a formula');
  });

  it('a no-answer reminder; someone else\'s shared contact is refused kindly', async () => {
    const id2 = await save(s, chatBot(s, [{ type: 'ask', body: 'Your name?', ask: { answer: 'text', remind: { value: 1, unit: 'hour' }, remind_text: 'Still there? 🙂' } }, { body: 'Thanks' }], { start_code: 'nm' }));
    const u = nextUser();
    await app.start(s.bot.connId, u, 'nm');
    await tick();
    await app.db.query('update flow_step_runs set due_at = now() where run_id = $1', [(await runOf(id2, s, u)).id]);
    await tick();
    assert.equal(lastTo(s.bot.token, u).params.text, 'Still there? 🙂');
    await say(s, u, 'Ada');
    await tick();
    assert.equal(lastTo(s.bot.token, u).params.text, 'Thanks');
    const u2 = nextUser();
    await app.start(s.bot.connId, u2, 'leads');
    await tick();
    await say(s, u2, 'b@c.co');
    await tick();
    await say(s, u2, null, { contact: { phone_number: '+111111111', user_id: 999, first_name: 'Other' } });
    assert.match(lastTo(s.bot.token, u2).params.text, /share your own number/);
  });

  it('over the month\'s answers (+10% grace) the bot still says thanks; answers are kept hidden; CSV export is Starter and up', async () => {
    const ws = await app.db.one('select * from workspaces where id = $1', [s.ws.id]);
    const m = await app.require('services/billing').answersMeter(ws);
    assert.equal(m.limit, 1000);
    assert.equal(m.hard, 1100);
    const seq = await app.db.one('select id from sequences where id = $1', [id]);
    const sub = await app.db.one("select id from subscribers where connection_id = $1 limit 1", [s.bot.connId]);
    await app.db.query(`insert into bot_answers(workspace_id, sequence_id, step_id, subscriber_id, answer) select $1, $2, null, $3, 'x' from generate_series(1, 1100)`, [ws.id, seq.id, sub.id]);
    const u = nextUser();
    await app.start(s.bot.connId, u, 'leads');
    await tick();
    await say(s, u, 'late@example.com');
    await tick();
    assert.equal(lastTo(s.bot.token, u).params.text, 'Your phone?', 'the bot carries on');
    const row = await app.db.one("select hidden from bot_answers where answer = 'late@example.com'");
    assert.equal(row.hidden, true);
    const v = (await s.c.get(`/api/bots/${id}/answers`)).body;
    assert.ok(v.hidden >= 1);
    await app.db.query('delete from bot_answers where step_id is null');
    await setPlan(ws.id, 'free');
    const csv = await s.c.get(`/api/bots/${id}/answers.csv`);
    assert.equal(csv.status, 402);
    await setPlan(ws.id, 'starter');
  });
});

describe('Invite friends (referral)', () => {
  let s, id, inviter, link;
  before(async () => {
    s = await setup('growth');
    id = await save(s, chatBot(s, [
      { type: 'referral', body: 'Invite {goal} friends!\n{invite_link}\nSo far: {invites} of {goal}', referral: { goal: 2 } },
      { body: '🎉 Reward unlocked!', trigger: { type: 'on_goal' } },
    ], { start_code: 'invite' }));
    inviter = nextUser();
    await app.start(s.bot.connId, inviter, 'invite');
    await tick();
    const m = lastTo(s.bot.token, inviter);
    link = /https:\/\/t\.me\/\S+\?start=(r_[a-z0-9]+)/.exec(m.params.text);
    assert.ok(link, m.params.text);
  });

  it('each person gets their own link and progress; the reward waits for the goal', async () => {
    const m = lastTo(s.bot.token, inviter);
    assert.match(m.params.text, /So far: 0 of 2/);
    const kb = m.params.reply_markup.inline_keyboard;
    assert.match(kb[0][0].url, /^https:\/\/t\.me\/share\/url\?url=/);
    assert.match(kb[1][0].callback_data, /^cvr:\d+$/);
    assert.equal((await runOf(id, s, inviter)).status, 'awaiting');
    const code = link[1].slice(2);
    assert.ok(await app.db.one('select 1 from bot_invites where code = $1', [code]));
  });

  it('counts only NEW people (not themselves, not people the bot knew), once each; the goal sends the reward', async () => {
    await app.start(s.bot.connId, inviter, link[1]); // themselves
    const known = nextUser();
    await app.start(s.bot.connId, known); // knew the bot already
    await app.start(s.bot.connId, known, link[1]);
    const a = nextUser();
    await app.start(s.bot.connId, a, link[1]);
    await app.start(s.bot.connId, a, link[1]); // the same person twice
    await tick();
    const lb = (await s.c.get(`/api/bots/${id}/referrals`)).body;
    assert.equal(lb.goal, 2);
    assert.equal(lb.top[0].invites, 1);
    assert.deepEqual(lb.not_counted.map((x) => x.reason).sort(), ['not_new']);
    assert.ok(!textsTo(s.bot.token, inviter).includes('🎉 Reward unlocked!'));
    assert.ok(textsTo(s.bot.token, inviter).some((t) => /A friend joined through your link! 1 of 2/.test(t)));
    assert.match(textsTo(s.bot.token, inviter).filter((t) => /^Invite 2 friends!/.test(t)).pop(), /So far: 1 of 2/, 'tapping Start again shows their link and progress again');
    // The invited person starts the same bot (and gets their own link).
    assert.match(textsTo(s.bot.token, a)[0], /Invite 2 friends!/);
    const b = nextUser();
    await app.start(s.bot.connId, b, link[1]);
    await tick();
    assert.ok(textsTo(s.bot.token, inviter).includes('🎉 Reward unlocked!'));
    assert.equal((await runOf(id, s, inviter)).status, 'done');
    // "My progress" and /invite.
    await tap(s, inviter, lastTo(s.bot.token, a).params.reply_markup.inline_keyboard[1][0].callback_data.replace(/\d+$/, String(id)));
    assert.match(lastTo(s.bot.token, inviter).params.text, /Goal reached/);
    await say(s, b, '/invite');
    assert.match(lastTo(s.bot.token, b).params.text, /Your invite link:\nhttps:\/\/t\.me\/\S+\?start=r_[a-z0-9]+\n\nFriends joined: 0 of 2/);
  });

  it('at most 50 counted per inviter a day; the rest are kept with the reason', async () => {
    const sub = await subOf(s, inviter);
    const vals = Array.from({ length: 50 }, (_, i) => `(${s.ws.id}, ${id}, ${s.bot.connId}, ${sub.id}, null, ${9900000 + i}, true)`).join(',');
    await app.db.query(`insert into bot_referrals(workspace_id, sequence_id, connection_id, referrer_id, referred_id, referred_tg_user_id, counted) values ${vals}`);
    const n = nextUser();
    await app.start(s.bot.connId, n, link[1]);
    const r = await app.db.one('select counted, reason from bot_referrals where referred_tg_user_id = $1', [n]);
    assert.deepEqual(r, { counted: false, reason: 'daily_limit' });
  });
});

describe('Plan limits for bots (friendly 402s)', () => {
  it('Free: 2 live bots (welcome + 1), 1 message per reply, menus up to 4 buttons, no questions or invites', async () => {
    const s = await setup('free');
    const code = async (body, active = false) => { const r = await s.c.post('/api/flows', { ...body, active }); return [r.status, r.body && r.body.error ? (r.body.error.code || r.body.code) : null, r.body]; };
    let [st, c] = await code(chatBot(s, [{ body: 'Hi' }, { body: 'Later', trigger: { type: 'wait', value: 1, unit: 'day' } }]));
    assert.deepEqual([st, c], [402, 'limit_bot_steps']);
    [st, c] = await code(chatBot(s, [{ body: 'Hi' }, { type: 'ask', body: 'Q?', ask: { answer: 'text' } }]));
    assert.deepEqual([st, c], [402, 'plan_bot_type']);
    [st, c] = await code(chatBot(s, [{ type: 'referral', body: 'Invite', referral: { goal: 2 } }]));
    assert.deepEqual([st, c], [402, 'plan_bot_type']);
    const btn = (n) => Array.from({ length: n }, (_, i) => ({ id: 'b' + i, label: 'B' + i, kind: 'reply' }));
    [st, c] = await code(chatBot(s, [{ body: 'Menu', buttons: btn(5) }]));
    assert.deepEqual([st, c], [402, 'limit_menu_buttons']);
    // A menu with 4 answers and a join check are fine on Free.
    const menu = [{ body: 'Menu', buttons: btn(4) }, ...btn(4).map((b) => ({ body: 'Answer ' + b.label, trigger: { type: 'on_button', button: b.id } }))];
    [st] = await code(chatBot(s, menu, { start_code: 'menu' }), true);
    assert.equal(st, 200);
    [st] = await code(chatBot(s, [{ type: 'check_join', body: 'Join', check: { chat_id: s.chanId } }, { body: 'Thanks' }], { start_code: 'jc' }));
    assert.equal(st, 200);
    // Live: the welcome bot + 1 Chat bot = 2. A third can't go live.
    const w = await s.c.post('/api/flows', { name: 'W', chat_id: s.chanId, bot_id: s.bot.connId, steps: [{ body: 'Welcome' }], active: true });
    assert.equal(w.status, 200, w.text);
    const [st3, c3, b3] = await code(chatBot(s, [{ body: 'Third' }], { start_code: 'third' }), true);
    assert.deepEqual([st3, c3], [402, 'limit_bots']);
    assert.match(b3.error.message || b3.error, /runs 2 bots at a time/);
    // Switching a draft on hits the same limit.
    const draft = (await s.c.post('/api/flows', chatBot(s, [{ body: 'Draft' }], { start_code: 'draft' }))).body.id;
    const t = await s.c.post(`/api/flows/${draft}/toggle`, { active: true });
    assert.equal(t.status, 402);
  });

  it('Starter: questions up to 5 per bot, no invite bots; Growth: 2 live invite bots; Scale: no bot limit', async () => {
    const s = await setup('starter');
    const ask = (n) => Array.from({ length: n }, (_, i) => ({ type: 'ask', body: 'Q' + i, ask: { answer: 'text' } }));
    let r = await s.c.post('/api/flows', chatBot(s, [{ body: 'Hi' }, ...ask(6)], { start_code: 'q6' }));
    assert.equal(r.status, 402);
    assert.equal(r.body.error.code || r.body.code, 'limit_lead_questions');
    r = await s.c.post('/api/flows', chatBot(s, [{ body: 'Hi' }, ...ask(5)], { start_code: 'q5' }));
    assert.equal(r.status, 200, r.text);
    r = await s.c.post('/api/flows', chatBot(s, [{ type: 'referral', body: 'x', referral: { goal: 1 } }], { start_code: 'ref' }));
    assert.equal(r.status, 402);
    await setPlan(s.ws.id, 'growth');
    const ref = (k) => chatBot(s, [{ type: 'referral', body: 'x {invite_link}', referral: { goal: 1 } }, { body: 'Reward', trigger: { type: 'on_goal' } }], { start_code: 'ref' + k });
    for (const k of [1, 2]) assert.equal((await s.c.post('/api/flows', { ...ref(k), active: true })).status, 200);
    r = await s.c.post('/api/flows', { ...ref(3), active: true });
    assert.equal(r.status, 402);
    assert.equal(r.body.error.code || r.body.code, 'limit_referral_bots');
    await setPlan(s.ws.id, 'scale');
    r = await s.c.post('/api/flows', { ...ref(3), active: true });
    assert.equal(r.status, 200, r.text);
    const lim = app.require('services/billing').BOT_PLANS;
    assert.equal(lim.scale.max_bots, -1);
    assert.equal(lim.free.max_bot_subscribers, 100);
    assert.equal(lim.growth.lead_answers_per_month, 10000);
  });

  it('a drop to Free switches off the Chat bots that don\'t fit (kept, paused by plan)', async () => {
    const s = await setup('growth');
    await save(s, { name: 'W', chat_id: s.chanId, bot_id: s.bot.connId, steps: [{ body: 'Welcome' }] });
    for (const k of ['a', 'b', 'c']) await save(s, chatBot(s, [{ body: 'Bot ' + k }], { start_code: k }));
    await save(s, chatBot(s, [{ type: 'referral', body: 'x', referral: { goal: 1 } }, { body: 'R', trigger: { type: 'on_goal' } }], { start_code: 'r' }));
    await app.require('services/billing').dropToFree(s.ws.id);
    const rows = await app.db.many("select trigger_value, active, paused_by_plan from sequences where workspace_id = $1 and trigger_type = 'bot_start' order by id", [s.ws.id]);
    // Free runs 2 bots: the live welcome bot + the oldest Chat bot. The invite bot can't run on Free at all.
    assert.deepEqual(rows.map((r) => [r.trigger_value, r.active, r.paused_by_plan]), [['a', true, false], ['b', false, true], ['c', false, true], ['r', false, true]]);
  });
});

describe('Broadcast to people who started a Chat bot', () => {
  it('makes the "Started <bot>" audience (no Audiences feature needed) and reaches only people who can still be messaged', async () => {
    const s = await setup('starter');
    const id = await save(s, chatBot(s, [{ body: 'Hi' }], { name: 'Gift bot', start_code: 'gift' }));
    const [a, b, c] = [nextUser(), nextUser(), nextUser()];
    for (const u of [a, b]) await app.start(s.bot.connId, u, 'gift');
    await app.start(s.bot.connId, c); // started the Telegram bot, not this Chat bot
    await say(s, b, '/stop');
    await tick();
    const r = await s.c.post(`/api/bots/${id}/audience`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.name, 'Started Gift bot');
    assert.equal(r.body.count, 1);
    const bc = await s.c.post('/api/broadcasts', { connection_id: s.bot.connId, segment_id: r.body.segment_id, body: 'News for you' });
    assert.equal(bc.status, 200, bc.text);
    await app.flush();
    assert.ok(textsTo(s.bot.token, a).some((t) => /News for you/.test(t)));
    assert.ok(!textsTo(s.bot.token, b).some((t) => /News for you/.test(t)));
    assert.ok(!textsTo(s.bot.token, c).some((t) => /News for you/.test(t)));
    // Free has no broadcasts.
    await setPlan(s.ws.id, 'free');
    assert.equal((await s.c.post(`/api/bots/${id}/audience`)).status, 402);
  });
});

describe('Logged-in devices per seat', () => {
  it('a 3rd login on Free logs out the oldest device and sends the new-login alert; Scale allows 3', async () => {
    const email = `devices-${++emailSeq}@example.com`;
    const c1 = await app.loginByEmail(email);
    const c2 = await app.loginByEmail(email);
    assert.equal((await c1.get('/api/app/state')).status, 200);
    const before = app.fakes.emailsTo(email).filter((e) => /^New login/.test(e.subject)).length;
    const c3 = await app.loginByEmail(email);
    assert.equal((await c1.get('/api/app/state')).status, 401, 'the oldest device is logged out');
    assert.equal((await c2.get('/api/app/state')).status, 200);
    assert.equal((await c3.get('/api/app/state')).status, 200);
    const after = app.fakes.emailsTo(email).filter((e) => /^New login/.test(e.subject)).length;
    assert.equal(after, before + 1, 'the new-login alert went out');
    const ws = await app.ws(c3);
    await setPlan(ws.id, 'scale');
    const c4 = await app.loginByEmail(email);
    assert.equal((await c2.get('/api/app/state')).status, 200);
    assert.equal((await c3.get('/api/app/state')).status, 200);
    assert.equal((await c4.get('/api/app/state')).status, 200);
    const n = (await app.db.one('select count(*)::int n from sessions where user_id = $1', [c4.user.id])).n;
    assert.equal(n, 3);
  });
});

describe('Ownership check (warn only)', () => {
  it('a Telegram bot nobody on the team has started gets a gentle tip, never a block', async () => {
    const s = await setup('starter');
    const d = (await s.c.get('/api/bots')).body;
    assert.equal(d.ownership.length, 1);
    assert.match(d.ownership[0].message, /tap Start once/);
    await app.db.query('update users set tg_user_id = $2 where id = $1', [s.c.user.id, 5550001]);
    await app.start(s.bot.connId, 5550001);
    assert.equal((await s.c.get('/api/bots')).body.ownership.length, 0);
  });
});

describe('Send a test to my Telegram: the engine plays the new steps', () => {
  const F = {
    start_type: 'bot_start', start_button: false, steps: [
      { position: 1, trigger_type: 'after_previous', step_type: 'check_join', config: { chat_id: 1, remind_seconds: 60 }, buttons: [] },
      { position: 2, trigger_type: 'after_previous', step_type: 'ask', config: { answer: 'email' }, buttons: [] },
      { position: 3, trigger_type: 'after_previous', step_type: 'referral', config: { goal: 2 }, buttons: [] },
      { position: 4, trigger_type: 'on_goal', step_type: 'message', config: {}, buttons: [] },
    ],
  };
  it('joined / not joined, a typed answer (checked), pretend friends, then the reward', () => {
    const T = app.require('services/flow-test');
    const st = T.newState();
    let r = T.run(F, st, 0);
    assert.deepEqual(r.send, [0]);
    assert.equal(r.waitingFor, 'joined');
    r = T.run(F, st, 10, { joined: false });
    assert.equal(r.nudge, true);
    assert.deepEqual(r.send, []);
    r = T.run(F, st, 3001 + 3000);
    assert.deepEqual(r.remind, [0], 'the check\'s reminder');
    r = T.run(F, st, 7000, { joined: true });
    assert.deepEqual(r.send, [1]);
    assert.equal(r.waitingFor, 'answer');
    r = T.run(F, st, 7100, { answer: 'nope' });
    assert.match(r.retry, /email/);
    r = T.run(F, st, 7200, { answer: 'a@b.co' });
    assert.deepEqual(r.send, [2]);
    assert.equal(r.waitingFor, 'goal');
    assert.equal(st.answers[1], 'a@b.co');
    T.run(F, st, 7300, { ref: true });
    r = T.run(F, st, 7400, { ref: true });
    assert.deepEqual(r.send, [3]);
    assert.equal(r.done, true);
  });
});

describe('Send a test to my Telegram: a Chat bot with the new steps, for real', () => {
  it('check (Telegram is asked), a typed answer (checked), pretend friends, the reward; nothing is counted or saved', async () => {
    const s = await setup('growth');
    const tg = 7770001;
    await app.db.query('update users set tg_user_id = $2 where id = $1', [s.c.user.id, tg]);
    const body = chatBot(s, [
      { type: 'check_join', body: 'Join first 👇', check: { chat_id: s.chanId } },
      { type: 'ask', body: 'Your email?', ask: { answer: 'email', label: 'Email' } },
      { type: 'referral', body: 'Invite {goal}: {invite_link} ({invites})', referral: { goal: 1 } },
      { body: 'Reward 🎁', trigger: { type: 'on_goal' } },
    ], { start_code: 'tst' });
    const r = await s.c.post('/api/flows/tests', body);
    assert.equal(r.status, 200, r.text);
    const t = r.body.test;
    assert.equal(t.waiting_for, 'joined');
    const code = (await app.db.one('select code from flow_tests where id = $1', [t.id])).code;
    const check = lastTo(s.bot.token, tg);
    assert.equal(check.params.text, 'Join first 👇');
    assert.equal(check.params.reply_markup.inline_keyboard[1][0].callback_data, `cvt:${code}:cvjoin`);
    app.fakes.tg.chatMember = { status: 'left' };
    await tap({ bot: s.bot }, tg, `cvt:${code}:cvjoin`);
    assert.equal(callbackAnswers(s.bot.token).pop().params.show_alert, true);
    app.fakes.tg.chatMember = { status: 'member' };
    await tap({ bot: s.bot }, tg, `cvt:${code}:cvjoin`);
    assert.equal(lastTo(s.bot.token, tg).params.text, 'Your email?');
    await say(s, tg, 'nope');
    assert.match(lastTo(s.bot.token, tg).params.text, /doesn't look like an email/);
    await say(s, tg, 'me@example.com');
    const inv = lastTo(s.bot.token, tg);
    assert.match(inv.params.text, /Invite 1: https:\/\/t\.me\/\S+\?start=r_test \(0\)/);
    assert.equal(inv.params.reply_markup.inline_keyboard[0][0].callback_data, `cvt:${code}:cvref`);
    await tap({ bot: s.bot }, tg, `cvt:${code}:cvref`);
    assert.ok(textsTo(s.bot.token, tg).includes('Reward 🎁'));
    const g = (await s.c.get('/api/flows/tests/' + t.id)).body.test;
    assert.equal(g.status, 'done');
    assert.equal(g.answers['1'], 'me@example.com');
    assert.equal((await app.db.one('select count(*)::int n from bot_answers where workspace_id = $1', [s.ws.id])).n, 0, 'a test saves no answers');
    assert.equal(await app.db.one('select 1 from subscribers where connection_id = $1 and tg_user_id = $2', [s.bot.connId, tg]), null, 'and makes no subscriber');
  });
});

describe('The builder: preview of the new steps (sandbox)', () => {
  let ui;
  before(() => { ui = loadUi(); });
  const J = (x) => JSON.parse(JSON.stringify(x));
  const E = () => ({
    start_type: 'bot_start', approve_mode: 'after_welcome', start_button: false, start_label: '', steps: [
      { body: 'Join first', type: 'check_join', check: { chat_id: 1, open_label: '📣 Open', join_label: 'I\'ve joined ✅' }, buttons: [], trigger: null },
      { body: 'Your email?', type: 'ask', ask: { answer: 'email', label: 'Email' }, buttons: [], trigger: { type: 'after_previous' } },
      { body: 'Invite {goal}: {invite_link} ({invites})', type: 'referral', referral: { goal: 2 }, buttons: [], trigger: { type: 'after_previous' } },
      { body: 'Reward!', buttons: [], trigger: { type: 'on_goal' } },
    ],
  });

  it('simulates not joined → nudge, joined → next, typed answers checked, pretend friends → reward', () => {
    let sim = J(ui.simRun(E(), []));
    assert.equal(sim.waitingFor, 'joined');
    sim = J(ui.simRun(E(), [{ joined: false }]));
    assert.ok(sim.log.some((x) => x.k === 'sys' && /haven't joined/.test(x.text)));
    assert.equal(sim.waitingFor, 'joined');
    sim = J(ui.simRun(E(), [{ joined: true }]));
    assert.equal(sim.waitingFor, 'answer');
    sim = J(ui.simRun(E(), [{ joined: true }, { answer: 'nope' }]));
    assert.ok(sim.log.some((x) => x.k === 'bot_retry'));
    assert.equal(sim.waitingFor, 'answer');
    sim = J(ui.simRun(E(), [{ joined: true }, { answer: 'a@b.co' }]));
    assert.equal(sim.waitingFor, 'goal');
    sim = J(ui.simRun(E(), [{ joined: true }, { answer: 'a@b.co' }, { ref: true }, { ref: true }]));
    assert.ok(sim.sent.some((x) => x.i === 3));
    const html = ui.simHtml(E(), ui.simRun(E(), [{ joined: true }]), { bot: 'mybot' });
    assert.match(html, /data-simanswer/);
    const html2 = ui.simHtml(E(), ui.simRun(E(), []), { bot: 'mybot' });
    assert.match(html2, /data-simjoin="1"/);
    assert.match(html2, /data-simjoin="0"/);
  });

  it('"Preview this step" and "play the whole flow" reach the reward; gentle tips for a check without a channel', () => {
    const p = J(ui.wfPathTo(E(), 3));
    assert.equal(p.ok, true);
    assert.deepEqual(p.events.map((e) => Object.keys(e)[0]), ['joined', 'answer', 'ref', 'ref']);
    const e2 = E(); e2.steps[0].check.chat_id = null;
    const tips = J(ui.wfTips(e2, {}));
    assert.ok(tips.some((x) => x.kind === 'nochat' && x.block === 'save'));
    assert.match(ui.wfWhen(E(), 3), /reach their invite goal/);
    assert.match(ui.wfWhen(E(), 0), /tap Start/);
    const nx = J(ui.wfPlayNext(E(), { events: [] }));
    assert.equal(nx.pause, 'joined');
    const play = ui.wfPlayHtml(E(), { events: [], shown: 99 }, { bot: 'mybot' });
    assert.match(play, /data-playjoin="0"/);
    const play2 = ui.wfPlayHtml(E(), { events: [{ joined: true }], shown: 99 }, { bot: 'mybot' });
    assert.match(play2, /data-playanswer/);
    assert.match(play2, /data-playsample="ada@example\.com"/);
  });

  it('draws the special steps\' settings, the "special step" picker, and the Chat bot card (escaped)', () => {
    const e = E(); e.steps[1].ask = { answer: 'choice', choices: ['<b>A</b>', 'B'], label: 'Pick' };
    const html = ui.stepsHtml(e, { editable: true, has: () => true, chats: [{ id: 1, title: 'Chan <x>' }], joinAdmin: { 1: { ok: false, message: 'Make @bot an admin' } }, adding: true });
    for (const k of ['data-ckchat="0"', 'data-ckjoin="0"', 'data-rem="0"', 'data-akind="1:choice"', 'data-ach="1:0"', 'data-achadd="1"', 'data-rgoal="2"', 'data-tok="2:{invite_link}"', 'data-adds="check_join"', 'data-adds="ask"', 'data-adds="referral"', 'data-addt="on_goal"']) assert.ok(html.includes(k), k);
    assert.ok(!html.includes('data-addt="on_start"'), 'no "When they tap Start" in a Chat bot');
    assert.ok(!html.includes('<b>A</b>') && html.includes('&lt;b&gt;A&lt;/b&gt;'));
    assert.match(html, /Make @bot an admin/);
    assert.ok(!html.includes('data-ba="0"'), 'a special step has no "Add a button"');
    const card = ui.botCardHtml({ id: 7, name: 'Gift <bot>', bot_username: 'mybot', start_code: 'gift', active: true, bot_type: 'lead_magnet', started: 12, finished: 3, steps: 2 });
    assert.match(card, /Gift &lt;bot&gt;/);
    assert.match(card, /\?start=gift/);
  });
});

/** Load core.js + app-flows.js into a sandbox with tiny browser stubs (like flow-triggers.test.js). */
function loadUi() {
  const root = path.join(__dirname, '..', '..', 'public', 'js');
  const noop = () => {};
  const el = () => ({ addEventListener: noop, appendChild: noop, setAttribute: noop, classList: { add: noop, remove: noop, toggle: noop }, style: {}, dataset: {} });
  const ctx = { console, setTimeout, clearTimeout, requestAnimationFrame: noop, matchMedia: () => ({ matches: false }), localStorage: { getItem: () => null, setItem: noop }, location: { hash: '', search: '' }, history: { replaceState: noop }, navigator: { userAgent: '' }, document: { addEventListener: noop, createElement: el, querySelector: () => null, querySelectorAll: () => [], body: el(), documentElement: el(), hidden: false }, window: {} };
  ctx.window = ctx;
  vm.createContext(ctx);
  const src = ['core.js', 'app-flows.js'].map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n;\n');
  vm.runInContext('var PAGES = {}; var APP = { state: null }; var CFG = { features: {} };\n' + src + '\n;this.__ui = { simRun, simHtml, wfPathTo, wfTips, wfWhen, wfPlayNext, wfPlayHtml, stepsHtml, botCardHtml };', ctx);
  return ctx.__ui;
}

describe('Leads privacy: only the owner and the setup helper see answers', () => {
  it('drafters and senders get counts only; the owner and the helper see the answers; the CSV stays owner-only', async () => {
    const s = await setup('growth');
    const id = await save(s, chatBot(s, [{ body: 'Hi' }, { type: 'ask', body: 'Your phone?', ask: { answer: 'phone', label: 'Phone' } }], { start_code: 'priv' }), false);
    const step = await app.db.one("select id from sequence_steps where sequence_id = $1 and step_type = 'ask'", [id]);
    const sub = (await app.db.one("insert into subscribers(connection_id, tg_user_id, first_name) values ($1, $2, 'Ada') returning id", [s.bot.connId, nextUser()])).id;
    await app.db.query("insert into bot_answers(workspace_id, sequence_id, step_id, subscriber_id, question, label, answer_type, answer) values ($1,$2,$3,$4,'Your phone?','Phone','phone','+2348012345678')", [s.ws.id, id, step.id, sub]);
    const own = await s.c.get(`/api/bots/${id}/answers`);
    assert.equal(own.status, 200, own.text);
    assert.equal(own.body.people[0].answers[String(step.id)], '+2348012345678');
    assert.ok(!own.body.restricted);
    const as = { headers: { 'x-ws': String(s.ws.id) } };
    for (const role of ['drafter', 'sender', 'helper']) {
      const email = `leads-${role}-${++emailSeq}@example.com`;
      const inv = await s.c.post('/api/app/team/invite', { email, role });
      assert.equal(inv.status, 200, inv.text);
      const m = await app.loginByEmail(email);
      const acc = await m.post('/api/invites/accept', { token: inv.body.link.split('#join/')[1], consent: true });
      assert.equal(acc.status, 200, acc.text);
      const r = await m.get(`/api/bots/${id}/answers`, as);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.total, 1, `${role} sees how many answered`);
      if (role === 'helper') {
        assert.ok(!r.body.restricted);
        assert.equal(r.body.people[0].answers[String(step.id)], '+2348012345678');
      } else {
        assert.equal(r.body.restricted, true, `${role} is restricted`);
        assert.deepEqual(r.body.people, [], `${role} never gets the answers`);
        assert.doesNotMatch(r.text, /2348012345678|Ada/);
      }
      assert.equal((await m.get(`/api/bots/${id}/answers.csv`, as)).status, 403, `${role} can't download the CSV`);
    }
  });
});

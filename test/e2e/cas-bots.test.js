'use strict';
/*
 * Cas Builder builds every bot type (public/js/cas-engine.js, services/cas-builder.js, docs/BOTS.md "Cas Builder"):
 *   - the first question is the goal; each Chat bot kind is built from taps alone (no AI call) and saved through the
 *     builder's save path; the same payload is accepted by POST /api/flows
 *   - the join check asks Telegram (the POST /api/bots/check-join check) and explains softly when the bot isn't an admin
 *   - plan gating: a locked kind says which plan has it and offers a similar one; max live bots → saved as a draft
 *   - one build per new bot (the same count as flows), edits free
 *   - "Something else": the AI's whole bot is checked against AI_BOT_KEYS (flows.cleanAiBot), bad answers are refused
 *   - the Cas preview draws the special parts (sandbox)
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { startApp } = require('../helpers/app');
const E = require('../../public/js/cas-engine.js');

let app;
before(async () => { app = await startApp(); });
after(async () => { if (app) await app.stop(); });
beforeEach(async () => {
  app.rl._reset(); app.fakes.tg.chatMember = null; app.fakes.ai.script = null; app.fakes.ai.failNext = 0;
  await app.db.query("delete from settings where key = 'cas_builder'"); app.settings.bust();
});

let chatSeq = -1008800000;
let emailSeq = 0;
async function setPlan(wsId, code) {
  await app.db.query("update workspaces set plan_code = $2, plan_status = 'active', trial_ends_at = null, period_end = case when $2 = 'free' then null else now() + interval '20 days' end where id = $1", [wsId, code]);
  app.settings.bust();
}
async function setup(plan = 'growth', { chats = 1 } = {}) {
  const c = await app.loginByEmail(`cbots-${++emailSeq}@example.com`);
  const ws = await app.ws(c);
  const bot = await app.connectBot(c);
  const chanIds = [];
  for (let i = 0; i < chats; i++) chanIds.push((await app.db.one("insert into connections(workspace_id, kind, tg_chat_id, title) values ($1,'channel',$2,$3) returning id", [ws.id, --chatSeq, 'Signals Channel ' + (i + 1)])).id);
  await setPlan(ws.id, plan);
  return { c, ws, bot, chanId: chanIds[0], chanIds };
}
const aiCalls = () => app.fakes.ai.calls.length;
async function start(s, body = {}) { const r = await s.c.post('/api/cas-builder/sessions', body); assert.equal(r.status, 200, r.text); return r.body.session; }
async function say(s, sid, input) { const r = await s.c.post(`/api/cas-builder/sessions/${sid}/reply`, input); assert.equal(r.status, 200, r.text); return r.body; }
async function save(s, sid, body) { const r = await s.c.post(`/api/cas-builder/sessions/${sid}/save`, body); assert.equal(r.status, 200, r.text); return r.body; }
const casSaid = (r) => r.turns.filter((t) => t.from === 'cas').map((t) => t.text).join('\n');
const JARGON = /\b(triggers?|webhooks?|callbacks?|payloads?|flows?|steps?)\b/i;

/** Tap through a whole bot with the server; returns the last view and every Cas line. */
async function tapThrough(s, inputs, startBody = {}) {
  const ses = await start(s, startBody);
  let v = { view: ses.view, turns: ses.turns };
  const said = ses.turns.filter((t) => t.from === 'cas').map((t) => t.text);
  for (const inp of inputs) { v = await say(s, ses.id, inp); said.push(...v.turns.filter((t) => t.from === 'cas').map((t) => t.text)); }
  return { sid: ses.id, v, said };
}

describe('Cas Builder: every Chat bot kind from taps alone, saved through the builder', () => {
  const KINDS = {
    join_check: { inputs: [{ chip: 'kind:join_check' }, { chip: 'bg:link' }, { text: 'gift.example.com/guide' }, { chip: 'bkr:yes' }], types: ['check_join', 'message'], code: 'join' },
    lead_magnet: { inputs: [{ chip: 'kind:lead_magnet' }, { text: 'https://example.com/free.pdf' }, { chip: 'bf:3600' }], types: ['message', 'message'], code: 'gift' },
    menu: { inputs: [{ chip: 'kind:menu' }, { chip: 'mb:p0' }, { text: '🕘 Opening hours' }, { chip: 'mb:done' }, { chip: 'ma:write' }, { text: 'We are open 9 to 5 🕘' }], types: ['message', 'message', 'message'], code: 'menu' },
    lead_questions: { inputs: [{ chip: 'kind:lead_questions' }, { chip: 'lq:rec' }, { chip: 'bt:thanks' }], types: ['message', 'ask', 'ask', 'ask', 'message'], code: 'leads' },
    referral: { inputs: [{ chip: 'kind:referral' }, { chip: 'rg:5' }, { chip: 'rr:link' }, { text: 'https://example.com/reward' }], types: ['referral', 'message'], code: 'invite' },
  };
  for (const [kind, k] of Object.entries(KINDS)) {
    it(`${kind}: built from taps (no AI), switched on, and its payload is accepted by POST /api/flows`, async () => {
      const s = await setup('growth');
      const c0 = aiCalls();
      const { sid, v, said } = await tapThrough(s, k.inputs);
      assert.equal(aiCalls(), c0, 'no AI call at all');
      assert.equal(v.view.stage, 'jb_review', said.join('\n'));
      const d = v.view.draft;
      assert.equal(d.start_type, 'bot_start');
      assert.deepEqual(d.steps.map((x) => x.type || 'message'), k.types);
      assert.equal(d.start_code, k.code);
      assert.equal(d.bot_id, s.bot.connId, 'the only Telegram bot is picked for them');
      assert.ok(said.some((t) => t.includes(`t.me/${s.bot.username}?start=${k.code}`)), 'Cas gives the start link');
      assert.deepEqual(said.filter((t) => JARGON.test(t)), [], 'no technical words');
      // The payload Cas would save is valid for the flows save API as is.
      const body = E.toBody(d);
      const direct = await s.c.post('/api/flows', { ...body, start_code: body.start_code + 'x', active: false });
      assert.equal(direct.status, 200, direct.text);
      const saved = (await s.c.get('/api/flows/' + direct.body.id)).body.flow;
      assert.deepEqual(saved.steps.map((x) => x.type), k.types);
      // Like it? → ready → switch on with the builder's checks.
      let r = await say(s, sid, { chip: 'jb:ok' });
      assert.equal(r.view.stage, 'ready');
      assert.ok(r.turns.some((t) => t.celebrate && t.text === '🎉 Your bot is ready!'));
      assert.ok(r.view.chips.some((c) => c.act === 'switch'));
      r = await save(s, sid, { active: true });
      assert.ok(!r.error, JSON.stringify(r.error));
      assert.equal(r.saved.active, true);
      assert.match(casSaid(r), new RegExp(`You're live! 🎉 Share this link in your ads and posts: t\\.me/${s.bot.username}\\?start=${k.code}`));
      const q = await app.db.one('select * from sequences where id = $1', [r.saved.flow_id]);
      assert.equal(q.trigger_type, 'bot_start');
      assert.equal(q.trigger_value, k.code);
      assert.equal(q.active, true);
      assert.equal(q.bot_type, kind);
      const steps = await app.db.many('select step_type, trigger_type, config from sequence_steps where sequence_id = $1 and variant = 0 order by position', [q.id]);
      assert.deepEqual(steps.map((x) => x.step_type), k.types);
      if (kind === 'join_check') { assert.equal(steps[0].config.chat_id, Number(s.chanId)); assert.equal(steps[0].config.remind_seconds, 600); }
      if (kind === 'lead_magnet') assert.equal(steps[1].trigger_type, 'wait');
      if (kind === 'menu') assert.deepEqual(steps.map((x) => x.trigger_type), ['after_previous', 'on_button', 'on_button']);
      if (kind === 'lead_questions') assert.deepEqual(steps.slice(1, 4).map((x) => x.config.answer), ['text', 'phone', 'email']);
      if (kind === 'referral') { assert.equal(steps[0].config.goal, 5); assert.equal(steps[1].trigger_type, 'on_goal'); }
      const ses = await app.db.one('select counted_at, paid_by from cas_sessions where id = $1', [sid]);
      assert.ok(ses.counted_at, 'one build for the new bot');
    });
  }

  it('"✨ Just build it for me" right after the goal builds every kind with good defaults (no AI)', async () => {
    const s = await setup('growth');
    const c0 = aiCalls();
    for (const kind of ['join_check', 'lead_magnet', 'menu', 'lead_questions', 'referral']) {
      const ses = await start(s, { kind });
      assert.notEqual(ses.view.stage, 'kind', 'a kind given at the start skips the first question');
      const v = await say(s, ses.id, { chip: 'jb:go' });
      assert.equal(v.view.stage, 'jb_review', kind);
      const saved = await save(s, ses.id, { active: false });
      assert.ok(!saved.error, kind + ': ' + JSON.stringify(saved.error));
      assert.match(casSaid(saved), /Saved as a draft/);
    }
    assert.equal(aiCalls(), c0);
  });

  it('asks which Telegram bot and which channel when there are several, then checks the channel', async () => {
    const s = await setup('growth', { chats: 2 });
    const bot2 = await app.connectBot(s.c);
    const ses = await start(s);
    let v = await say(s, ses.id, { chip: 'kind:join_check' });
    assert.equal(v.view.stage, 'bot');
    assert.match(casSaid(v), /Which of your Telegram bots should people open\?/);
    v = await say(s, ses.id, { chip: 'bot:' + bot2.connId });
    assert.equal(v.view.stage, 'chat');
    assert.match(casSaid(v), /Which channel should people join first\?/);
    v = await say(s, ses.id, { chip: 'chat:' + s.chanIds[1] });
    assert.match(casSaid(v), new RegExp(`✓ @${bot2.username} can check who joined \\*Signals Channel 2\\*`));
    assert.equal(v.view.stage, 'bk_gift');
    v = await say(s, ses.id, { chip: 'jb:go' });
    assert.equal(v.view.draft.bot_id, bot2.connId);
    assert.equal(v.view.draft.steps[0].check.chat_id, s.chanIds[1]);
  });
});

describe('Cas Builder: the join check explains softly how to fix the bot', () => {
  it('not an admin → how to fix it, "I\'ve made it an admin" checks again; "later" goes on and the switch explains again', async () => {
    const s = await setup('starter');
    app.fakes.tg.chatMember = { status: 'member' };
    const ses = await start(s);
    let v = await say(s, ses.id, { chip: 'kind:join_check' });
    assert.equal(v.view.stage, 'bk_admin');
    const msg = casSaid(v);
    assert.match(msg, /One small thing 🌱/);
    assert.match(msg, /needs to be an admin of "Signals Channel 1"/);
    assert.match(msg, /Administrators → Add admin/);
    assert.doesNotMatch(msg, /Then try again/);
    assert.deepEqual(v.view.chips.map((c) => c.label), ['✅ I\'ve made it an admin', 'I\'ll do it later']);
    v = await say(s, ses.id, { chip: 'ba:again' });
    assert.equal(v.view.stage, 'bk_admin', 'still not an admin');
    app.fakes.tg.chatMember = null;
    v = await say(s, ses.id, { text: 'done' });
    assert.match(casSaid(v), /can check who joined/);
    assert.equal(v.view.stage, 'bk_gift');
    // The same, but they do it later: the bot is built, and switching on explains it again.
    app.fakes.tg.chatMember = { status: 'member' };
    const s2 = await start(s);
    await say(s, s2.id, { chip: 'kind:join_check' });
    v = await say(s, s2.id, { chip: 'ba:later' });
    assert.equal(v.view.stage, 'bk_gift');
    v = await say(s, s2.id, { chip: 'jb:go' });
    v = await say(s, s2.id, { chip: 'jb:ok' });
    const sv = await save(s, s2.id, { active: true });
    assert.equal(sv.error.code, 'bot_not_admin_check');
    assert.match(casSaid(sv), /One more thing before it goes live 🌱/);
  });
});

describe('Cas Builder: plan gating for bots', () => {
  it('Free: questions and invite friends say which plan has them and offer a similar bot; the menu fits the plan', async () => {
    const s = await setup('free');
    await app.db.query('update workspaces set cas_credits = 5 where id = $1', [s.ws.id]);
    const ses = await start(s);
    const kinds = ses.view.chips;
    assert.equal(kinds.find((c) => c.id === 'kind:lead_questions').hint, 'Starter');
    assert.equal(kinds.find((c) => c.id === 'kind:referral').hint, 'Growth');
    assert.ok(!kinds.find((c) => c.id === 'kind:menu').hint);
    let v = await say(s, ses.id, { chip: 'kind:lead_questions' });
    assert.equal(v.view.stage, 'kind_locked');
    assert.match(casSaid(v), /Bots that ask questions are on the Starter plan and up 🌱/);
    assert.deepEqual(v.view.chips.map((c) => c.label), ['📋 Build a menu instead', '⬆ See plans', '↩ Pick something else']);
    assert.equal(v.view.chips[1].lock, 'bot_lead_questions');
    v = await say(s, ses.id, { chip: 'kl:alt' });
    assert.equal(v.view.stage, 'bk_menu');
    v = await say(s, ses.id, { chip: 'mb:rec' });
    for (let i = 0; i < 3; i++) v = await say(s, ses.id, { chip: 'ma:write' });
    assert.equal(v.view.stage, 'jb_review');
    v = await say(s, ses.id, { chip: 'jb:ok' });
    const sv = await save(s, ses.id, { active: true });
    assert.ok(!sv.error, JSON.stringify(sv.error));
    assert.equal(sv.saved.active, true);
    // A free gift bot on Free: just the gift (1 message per reply), no follow-up question.
    const g = await start(s, { kind: 'lead_magnet' });
    v = await say(s, g.id, { text: 'https://example.com/g' });
    assert.equal(v.view.stage, 'jb_review');
    assert.equal(v.view.draft.steps.length, 1);
    assert.match(casSaid(v), /Your Free plan sends 1 message per reply/);
    // Invite friends → a free gift bot instead.
    const r = await start(s);
    v = await say(s, r.id, { chip: 'kind:referral' });
    assert.match(casSaid(v), /Invite-friends bots are on the Growth plan and up/);
    assert.equal(v.view.chips[0].id, 'kl:alt');
    v = await say(s, r.id, { chip: 'kl:back' });
    assert.equal(v.view.stage, 'kind');
  });

  it('Free with its welcome bot already made: the welcome kind offers a join-check bot instead', async () => {
    const s = await setup('free');
    const f = await s.c.post('/api/flows', { name: 'Welcome', chat_id: s.chanId, bot_id: s.bot.connId, steps: [{ body: 'Hi {name}' }] });
    assert.equal(f.status, 200, f.text);
    await app.db.query('update workspaces set cas_credits = 5 where id = $1', [s.ws.id]);
    const ses = await start(s);
    const v = await say(s, ses.id, { chip: 'kind:welcome' });
    assert.equal(v.view.stage, 'kind_locked');
    assert.match(casSaid(v), /Your Free plan includes 1 welcome bot, and you have it already/);
    assert.equal(v.view.chips[0].label, '✅ Build a join-check bot instead');
  });

  it('max live bots reached: the new bot is saved as a draft (switched off) and Cas explains', async () => {
    const s = await setup('free');
    const live = (code) => s.c.post('/api/flows', { start_type: 'bot_start', name: 'B ' + code, bot_id: s.bot.connId, start_code: code, steps: [{ body: 'Hi {name}' }], active: true });
    assert.equal((await live('one')).status, 200);
    assert.equal((await live('two')).status, 200);
    const ses = await start(s, { kind: 'menu' });
    await say(s, ses.id, { chip: 'jb:go' });
    await say(s, ses.id, { chip: 'jb:ok' });
    const sv = await save(s, ses.id, { active: true });
    assert.equal(sv.error.code, 'limit_bots');
    assert.match(casSaid(sv), /Saved as a draft 💾 It's switched off for now\. Your Free plan runs 2 bots at a time/);
    const q = await app.db.one("select active from sequences where workspace_id = $1 and trigger_value = 'menu'", [s.ws.id]);
    assert.equal(q.active, false, 'kept as a draft');
    assert.equal(sv.view.stage, 'live');
  });

  it('Starter: up to 5 questions; a 6th is refused gently', async () => {
    const s = await setup('starter');
    const ses = await start(s, { kind: 'lead_questions' });
    let v;
    for (const q of ['name', 'phone', 'email', 'country']) v = await say(s, ses.id, { chip: 'lq:' + q });
    v = await say(s, ses.id, { text: 'How many trades do you make a week?' });
    assert.ok(!v.view.chips.some((c) => c.id === 'lq:custom'), 'no room for more');
    assert.match(casSaid(v), /That's the most your plan asks in one bot/);
    v = await say(s, ses.id, { text: 'One more question?' });
    assert.match(casSaid(v), /That's the most your plan asks in one bot/);
    v = await say(s, ses.id, { chip: 'lq:done' });
    v = await say(s, ses.id, { chip: 'bt:thanks' });
    const asks = v.view.draft.steps.filter((x) => x.type === 'ask');
    assert.equal(asks.length, 5);
    assert.equal(asks[4].ask.answer, 'number', 'the answer type is guessed from the words');
    const sv = await save(s, ses.id, { active: true });
    assert.ok(!sv.error, JSON.stringify(sv.error));
  });
});

describe('Cas Builder: builds for bots', () => {
  it('one build per new bot on the shared count; changing a saved bot by chat is free', async () => {
    const s = await setup('free');
    const ses = await start(s, { kind: 'lead_magnet' });
    await say(s, ses.id, { text: 'https://example.com/g' });
    await say(s, ses.id, { chip: 'jb:ok' });
    const sv = await save(s, ses.id, { active: false });
    assert.ok(sv.saved);
    const b = (await s.c.get('/api/cas-builder')).body.builds;
    assert.equal(b.used, 1);
    const again = await s.c.post('/api/cas-builder/sessions', {});
    assert.equal(again.status, 402);
    assert.equal(again.body.code, 'cas_builds_out');
    // Edit the saved bot by chat: tap to edit its words, save; still 1 build.
    const ed = await start(s, { flow_id: sv.saved.flow_id });
    assert.equal(ed.view.draft.start_type, 'bot_start');
    const e = await s.c.post(`/api/cas-builder/sessions/${ed.id}/edit`, { message: 1, text: 'Hi {name} 🎁 Your gift is here.' });
    assert.equal(e.status, 200, e.text);
    const sv2 = await save(s, ed.id, { active: false });
    assert.ok(sv2.saved, JSON.stringify(sv2.error));
    const f = (await s.c.get('/api/flows/' + sv.saved.flow_id)).body.flow;
    assert.equal(f.steps[0].body, 'Hi {name} 🎁 Your gift is here.');
    assert.equal(f.start_type, 'bot_start');
    assert.equal((await s.c.get('/api/cas-builder')).body.builds.used, 1, 'edits never count');
    const edc = await app.db.one('select counted_at from cas_sessions where id = $1', [ed.id]);
    assert.equal(edc.counted_at, null);
  });

  it('a pasted link later becomes the gift button; welcome-only changes are refused for a Chat bot', async () => {
    const s = await setup('growth');
    const ses = await start(s, { kind: 'lead_magnet' });
    let v = await say(s, ses.id, { chip: 'bkl:later' });
    v = await say(s, ses.id, { chip: 'bf:none' });
    assert.equal(v.view.stage, 'jb_review');
    assert.equal(v.view.draft.steps[0].buttons.length, 0);
    v = await say(s, ses.id, { text: 'example.com/my-guide' });
    assert.deepEqual(v.view.draft.steps[0].buttons.map((b) => [b.label, b.url]), [['🎁 Open my gift', 'https://example.com/my-guide']]);
    assert.match(v.view.draft.steps[0].body, /Tap the button below/);
    app.fakes.ai.script = (b) => (Array.isArray(b.tools) && b.tools.length ? { text: 'ok', tools: [{ name: 'set_approve_mode', input: { mode: 'instant' } }] } : { text: 'x' });
    v = await say(s, ses.id, { text: 'let people in straight away' });
    assert.match(casSaid(v), /works in welcome bots, not in this bot/);
  });
});

describe('Cas Builder: "Something else" and the AI\'s whole bot (AI_BOT_KEYS)', () => {
  const good = {
    start_type: 'bot_start', name: 'Signals menu', start_code: 'sig',
    steps: [
      { type: 'message', body: 'Hi {name} 👋 Pick one 👇', buttons: [{ id: 'free', label: '📘 Free tips', kind: 'reply' }, { id: 'vip', label: '⭐ VIP', kind: 'reply' }] },
      { type: 'message', body: 'Here is a free tip', trigger: { type: 'on_button', button: 'free' } },
      { type: 'message', body: 'VIP is open', trigger: { type: 'on_button', button: 'vip' } },
      { type: 'ask', body: 'Your email?', ask: { answer: 'email', label: 'Email' }, trigger: { type: 'wait', value: 1, unit: 'hour' } },
    ],
  };
  const clean = (o) => app.require('services/flows').cleanAiBot(typeof o === 'string' ? o : JSON.stringify(o));
  const bad = (o, why) => { assert.throws(() => clean(o), (e) => e.code === 'ai_bad_flow' && (!why || why.test(e.message)), JSON.stringify(o).slice(0, 120)); };
  const withStep = (i, patch) => { const o = JSON.parse(JSON.stringify(good)); o.steps[i] = { ...o.steps[i], ...patch }; return o; };

  it('cleanAiBot keeps a good bot and refuses anything outside AI_BOT_KEYS', () => {
    const b = clean('Sure! ```json\n' + JSON.stringify(good) + '\n```');
    assert.equal(b.name, 'Signals menu');
    assert.equal(b.start_code, 'sig');
    assert.deepEqual(b.steps.map((x) => x.type), ['message', 'message', 'message', 'ask']);
    assert.deepEqual(b.steps[3].trigger, { type: 'wait', seconds: 3600 });
    assert.equal(b.steps[3].ask.answer, 'email');
    bad('not json at all', /not JSON/);
    bad({ ...good, colour: 'red' }, /unknown field "colour"/);
    bad({ ...good, start_type: 'join_request' }, /bot_start/);
    bad({ ...good, approve_mode: 'instant' }, /Welcome bots/);
    bad({ ...good, start_code: 'r_abc' }, /start_code/);
    bad(withStep(0, { type: 'poll' }), /type/);
    bad(withStep(1, { trigger: { type: 'on_start' } }), /on_start/);
    bad(withStep(1, { trigger: { type: 'on_button', button: 'nope' } }), /button of a step above/);
    bad(withStep(1, { trigger: { type: 'on_goal' } }), /Invite friends/);
    bad(withStep(3, { buttons: [{ label: 'x', kind: 'reply' }] }), /special step/);
    bad(withStep(3, { ask: { answer: 'choice', choices: ['only one'] } }), /choices/);
    bad(withStep(3, { ask: { answer: 'date' } }), /answer type/);
    bad(withStep(3, { ask: { answer: 'email', secret: 1 } }), /unknown field/);
    bad(withStep(3, { trigger: { type: 'on_button', button: 'free' } }), /special step/);
    bad(withStep(3, { check: { chat_id: 1 } }), /has "check"/);
    bad(withStep(0, { buttons: [{ label: 'Site', kind: 'link', url: 'javascript:alert(1)' }] }), /url/);
    bad(withStep(0, { body: '<script>x</script>' }), /code/);
    bad({ ...good, steps: Array.from({ length: 11 }, () => ({ type: 'message', body: 'Hi' })) }, /more than 10 steps/);
    bad({ ...good, steps: [{ type: 'referral', body: 'a', referral: { goal: 2 } }, { type: 'referral', body: 'b', referral: { goal: 2 } }] }, /more than one/);
    const ref = clean({ steps: [{ type: 'referral', body: 'Invite {goal}', referral: { goal: 4 } }, { body: 'Reward', trigger: { type: 'on_goal' } }] });
    assert.deepEqual(ref.steps.map((x) => x.trigger && x.trigger.type), [null, 'on_goal']);
  });

  it('"Something else" typed: common wishes need no AI; others get the AI\'s bot, checked again for the plan', async () => {
    const s = await setup('starter');
    let ses = await start(s);
    const c0 = aiCalls();
    let v = await say(s, ses.id, { chip: 'kind:other' });
    assert.equal(v.view.stage, 'kind_other');
    v = await say(s, ses.id, { text: 'I want to collect emails from my ad' });
    assert.equal(aiCalls(), c0, 'understood without the AI');
    assert.match(casSaid(v), /A bot that asks questions/);
    assert.equal(v.view.stage, 'bk_qs');
    // Broadcast is explained (it's Send a message, not a bot).
    ses = await start(s);
    v = await say(s, ses.id, { text: 'broadcast to everyone who started my bot' });
    assert.equal(v.view.stage, 'bk_broadcast');
    assert.ok(v.view.chips.some((c) => c.act === 'broadcast'));
    // The AI writes the whole bot.
    app.fakes.ai.script = () => ({ text: JSON.stringify(good) });
    ses = await start(s);
    v = await say(s, ses.id, { text: 'something for my signals group with tips and vip' });
    assert.equal(aiCalls(), c0 + 1);
    const call = app.fakes.ai.calls[app.fakes.ai.calls.length - 1];
    assert.match(JSON.stringify(call.messages), /ONE JSON object/);
    assert.match(JSON.stringify(call.messages), /bot types welcome, join_check, lead_magnet, menu, broadcast, lead_questions/);
    assert.equal(v.view.stage, 'jb_review', casSaid(v));
    assert.equal(v.view.draft.start_code, 'sig');
    assert.equal(v.view.draft.steps.length, 4);
    const sv = await save(s, ses.id, { active: true });
    assert.ok(!sv.error, JSON.stringify(sv.error));
    assert.ok((await app.db.one('select counted_at from cas_sessions where id = $1', [ses.id])).counted_at, 'the AI call counted the build');
    // A refused answer: Cas asks to pick the closest kind instead (nothing half-built).
    app.fakes.ai.script = () => ({ text: JSON.stringify({ ...good, hacked: true }) });
    ses = await start(s);
    v = await say(s, ses.id, { text: 'make it do magic things please' });
    assert.equal(v.view.stage, 'kind');
    assert.match(casSaid(v), /couldn't put that one together/);
    assert.equal(v.view.draft.steps.length, 0);
    // A bot the plan doesn't have (invite friends on Starter) is refused by the engine.
    app.fakes.ai.script = () => ({ text: JSON.stringify({ steps: [{ type: 'referral', body: 'Invite {goal}', referral: { goal: 3 } }, { body: 'Reward', trigger: { type: 'on_goal' } }] }) });
    ses = await start(s);
    v = await say(s, ses.id, { text: 'make it do magic things please' });
    assert.equal(v.view.stage, 'kind');
    assert.match(casSaid(v), /I had an idea, but invite-friends bots are on the Growth plan and up/);
  });
});

describe('Cas Builder engine: every bot kind on every plan stays valid (no AI)', () => {
  const BP = () => app.require('services/billing').BOT_PLANS;
  const ctxFor = (code, { chats = 1, bots = 1 } = {}) => ({
    plan: { name: code[0].toUpperCase() + code.slice(1), features: code === 'free' ? [] : ['welcome_flows', 'tap_to_start', 'broadcasts'], flow_steps: code === 'free' ? 1 : 20, branding: code === 'free', bots: { ...BP()[code], unlock: { lead_questions: 'Starter', referral: 'Growth', broadcast: 'Starter' } } },
    chats: Array.from({ length: chats }, (_, i) => ({ id: 10 + i, title: 'Channel ' + (i + 1), kind: 'channel' })), bots: Array.from({ length: bots }, (_, i) => ({ id: 20 + i, username: 'bot' + (i + 1) })), flows: [], profile: {}, chatbots: [],
  });
  function run(ctx, inputs) {
    let { state, turns } = E.start(ctx, {});
    let all = turns.slice();
    let ai = 0;
    for (const inp of inputs) {
      const r = E.reply(state, inp, ctx);
      state = r.state; all = all.concat(r.turns);
      if (r.ai) ai++;
      if (r.check) { const d = E.checkDone(state, { ok: true }, ctx); state = d.state; all = all.concat(d.turns); }
    }
    return { state, turns: all, view: E.view(state, ctx), ai };
  }
  it('Just build it after each kind: allowed kinds build valid bots, locked kinds offer an allowed one', () => {
    for (const code of ['free', 'starter', 'growth', 'scale']) {
      for (const shape of [{ chats: 1, bots: 1 }, { chats: 0, bots: 0 }]) {
        const ctx = ctxFor(code, shape);
        for (const kind of ['join_check', 'lead_magnet', 'menu', 'lead_questions', 'referral']) {
          const tag = code + '/' + kind + '/' + shape.chats;
          const r = run(ctx, [{ chip: 'kind:' + kind }, { chip: 'jb:go' }]);
          assert.equal(r.ai, 0, tag);
          if (!ctx.plan.bots.bot_types.includes(kind)) { assert.equal(r.view.stage, 'kind_locked', tag); continue; }
          assert.equal(r.view.stage, 'jb_review', tag + ' ' + r.turns.map((t) => t.text).join(' | '));
          const d = r.state.draft;
          assert.equal(E.problems(d, ctx), '', tag);
          assert.equal(E.botTypeOfD(d), kind, tag);
          assert.deepEqual(E.directionIssues(d), [], tag);
          const lim = ctx.plan.bots.bot_steps;
          if (lim >= 0) assert.ok(E.botMsgs(d) <= lim, tag + ': fits the plan');
          const body = E.toBody(d);
          assert.equal(body.start_type, 'bot_start');
          for (const s of body.steps) for (const k of Object.keys(s)) assert.ok(['id', 'type', 'body', 'media_id', 'trigger', 'buttons', 'check', 'ask', 'referral'].includes(k), tag + ': ' + k);
          if (!shape.bots) { assert.equal(d.bot_id, null); assert.ok(r.view.chips.length); }
          // Ready: connect what's missing first.
          const ok = E.reply(r.state, { chip: 'jb:ok' }, ctx);
          const chips = E.view(ok.state, ctx).chips.map((c) => c.id);
          assert.ok(chips.includes(shape.bots ? (kind === 'join_check' && !shape.chats ? 'cc:connect' : 'rd:on') : 'cb:connect'), tag + ': ' + chips.join(','));
        }
      }
    }
  });
  it('guesses the kind from a few words, and round-trips a saved bot', () => {
    assert.equal(E.guessKind('people must join my channel first'), 'join_check');
    assert.equal(E.guessKind('send my free PDF'), 'lead_magnet');
    assert.equal(E.guessKind('a menu with prices'), 'menu');
    assert.equal(E.guessKind('collect phone numbers'), 'lead_questions');
    assert.equal(E.guessKind('reward people who invite friends'), 'referral');
    assert.equal(E.guessKind('welcome people who ask to join'), 'welcome');
    assert.equal(E.guessKind('do something fun'), null);
    assert.deepEqual(E.questionFrom('What is your WhatsApp number?'), { answer: 'phone', label: 'Phone' });
    assert.equal(E.questionFrom('Do you trade already? (yes/no)').answer, 'choice');
    const detail = { start_type: 'bot_start', name: 'X', bot_id: 3, start_code: 'x', is_default: true, steps: [
      { id: 1, type: 'check_join', body: 'Join', buttons: [], trigger: null, check: { chat_id: 9, remind: { value: 10, unit: 'min', seconds: 600 } } },
      { id: 2, type: 'message', body: 'Thanks', buttons: [], trigger: { type: 'wait', value: 2, unit: 'hour', seconds: 7200 } },
    ] };
    const d = E.fromFlow(detail);
    assert.equal(d.steps[1].trigger.seconds, 7200);
    const b = E.toBody(d);
    assert.deepEqual(b.steps[0].check.remind, { value: 10, unit: 'min' });
    assert.deepEqual(b.steps[1].trigger, { type: 'wait', seconds: 7200 });
    assert.equal(b.is_default, true);
  });
});

describe('Cas Builder: the phone preview draws the special parts (sandbox)', () => {
  it('check, question and invite parts show their own buttons (not editable) and a one-line note', () => {
    const root = path.join(__dirname, '..', '..', 'public', 'js');
    const noop = () => {};
    const el = () => ({ addEventListener: noop, appendChild: noop, setAttribute: noop, classList: { add: noop, remove: noop, toggle: noop }, style: {}, dataset: {} });
    const ctx = { console, setTimeout, clearTimeout, requestAnimationFrame: noop, matchMedia: () => ({ matches: false }), localStorage: { getItem: () => null, setItem: noop }, location: { hash: '', search: '' }, history: { replaceState: noop }, navigator: { userAgent: '' }, document: { addEventListener: noop, createElement: el, querySelector: () => null, querySelectorAll: () => [], body: el(), documentElement: el(), hidden: false }, window: {} };
    ctx.window = ctx;
    vm.createContext(ctx);
    const src = ['core.js', 'app-flows.js', 'app-cas-builder.js'].map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n;\n');
    const draft = { start_type: 'bot_start', name: 'T', bot_id: 2, start_code: 'join', is_default: true, steps: [
      { type: 'check_join', body: 'Join <b>us</b> first', buttons: [], trigger: null, check: { chat_id: 1, remind: { value: 10, unit: 'min' } } },
      { type: 'ask', body: 'Your phone?', buttons: [], trigger: { type: 'after_previous' }, ask: { answer: 'phone', label: 'Phone' } },
      { type: 'referral', body: 'Invite {goal}: {invite_link}', buttons: [], trigger: { type: 'after_previous' }, referral: { goal: 4 } },
      { type: 'message', body: 'Reward', buttons: [{ id: 'bgift', label: '🎁 Get it', kind: 'link', url: 'https://example.com' }], trigger: { type: 'on_goal' } },
    ] };
    vm.runInContext('var PAGES = {}; var APP = { state: null }; var CFG = { features: {} };\n' + src +
      '\n;FL.data = { plan: { branding: true, limits: {} }, bots: [{ id: 2, username: "mybot" }], chats: [{ id: 1, title: "Signals <Chan>" }] };' +
      'CB.s = { view: { draft: ' + JSON.stringify(draft) + ', focus: 0 }, live: false };' +
      'this.__html = cbPhoneHtml(cbE(), new Set());', ctx);
    const html = ctx.__html;
    assert.match(html, /✅ Goes on once they join Signals &lt;Chan&gt; · reminder after 10 minutes/);
    assert.match(html, /❓ Waits for their answer: a phone number \(saved as Phone\)/);
    assert.match(html, /🔗 Their own invite link · goal 4 friends/);
    assert.match(html, /t\.me\/mybot\?start=r_ada/, 'the invite text is filled in');
    assert.match(html, /Free bot by Castvoo\.com/);
    assert.match(html, /👆 The moment they tap Start/);
    assert.match(html, /data-eb="3:bgift"/, 'a normal button stays tap-to-edit');
    assert.ok(!/data-eb="0:/.test(html) && !/data-eb="1:/.test(html) && !/data-eb="2:/.test(html), 'special buttons are not');
    assert.match(html, /data-ed="0"/, 'the words of a special part are tap-to-edit');
  });
});

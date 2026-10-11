'use strict';
/*
 * Cas Builder: build a Welcome Flow by chatting with Cas (services/cas-builder.js, public/js/cas-engine.js).
 *   - chip taps never call the AI (the fake model's call list does not grow)
 *   - typed instructions become strict, validated operations (the fake model answers with tool calls)
 *   - unknown operations, code in texts, javascript: links and more messages than the plan allows are refused
 *   - builds are counted per plan (Free: the first flow, for life), Cas credits are bought and used, the daily cost cap
 *   - a draft is resumed; changing an existing flow by chat never counts; saving and switching on use the builder's checks
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers/app');
const E = require('../../public/js/cas-engine.js');

let app;
before(async () => { app = await startApp(); });
after(async () => { if (app) await app.stop(); });
beforeEach(async () => {
  app.rl._reset(); app.fakes.tg.chatMember = null; app.fakes.ai.script = null; app.fakes.ai.failNext = 0;
  await app.db.query("delete from settings where key = 'cas_builder'"); app.settings.bust();
});

let chatSeq = -1007700000;
let emailSeq = 0;
async function setup(plan = 'growth', { chat = true, bot = true } = {}) {
  const c = await app.loginByEmail(`cb-${++emailSeq}@example.com`);
  const ws = await app.ws(c);
  const b = bot ? await app.connectBot(c) : null;
  const tg = --chatSeq;
  const chanId = chat ? (await app.db.one("insert into connections(workspace_id, kind, tg_chat_id, title) values ($1,'channel',$2,'Signals Channel') returning id", [ws.id, tg])).id : null;
  await setPlan(ws.id, plan);
  return { c, ws, bot: b, chat: tg, chanId };
}
async function setPlan(wsId, code) {
  if (code === 'trial') return;
  await app.db.query("update workspaces set plan_code = $2, plan_status = 'active', trial_ends_at = null, period_end = case when $2 = 'free' then null else now() + interval '20 days' end where id = $1", [wsId, code]);
  app.settings.bust();
}
async function setConf(v) {
  await app.db.query("insert into settings(key, value) values ('cas_builder', $1) on conflict (key) do update set value = excluded.value", [JSON.stringify({ ...require('../../server/services/cas-builder').DEFAULTS, ...v })]);
  app.settings.bust();
}
const aiCalls = () => app.fakes.ai.calls.length;
async function start(s, body = {}) { const r = await s.c.post('/api/cas-builder/sessions', body); return r; }
async function say(s, sid, input) { const r = await s.c.post(`/api/cas-builder/sessions/${sid}/reply`, input); assert.equal(r.status, 200, r.text); return r.body; }
const lastCas = (r) => r.turns.filter((t) => t.from === 'cas').map((t) => t.text).join('\n');

/** The fake model: plain text for writes, tool calls (from `ops`) when it is given tools. */
function scriptModel({ write = 'Hi {name} 👋 Welcome to the channel!', ops = null } = {}) {
  app.fakes.ai.script = (b) => {
    if (Array.isArray(b.tools) && b.tools.length) return { text: 'Done!', tools: (typeof ops === 'function' ? ops(b) : ops || []).map((o) => ({ name: o.op, input: Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'op')) })) };
    return { text: typeof write === 'function' ? write(b) : write };
  };
}

/** Walk the chat to "Anything else?" with a welcome (goal: welcome them, one message at a time, no message after Start yet). */
async function toNext(s) {
  scriptModel();
  const r = await start(s);
  assert.equal(r.status, 200, r.text);
  const sid = r.body.session.id;
  await say(s, sid, { chip: 'goal:welcome' });
  await say(s, sid, { chip: 'about:trading' });
  await say(s, sid, { chip: 'way:one' });
  let n = await say(s, sid, { chip: 'rv:ok' });
  if (n.view.stage === 'offer_start') n = await say(s, sid, { chip: 'os:no' });
  assert.equal(n.view.stage, 'next');
  return sid;
}

describe('Cas Builder: chips are free, typed words are checked', () => {
  it('builds the owner\'s example by tapping, and chip taps never call the AI', async () => {
    const s = await setup('growth');
    scriptModel({ write: (b) => (/the WELCOME/.test(JSON.stringify(b.messages)) ? 'Hi {name} 👋 Welcome to Signals! Daily signals here.' : 'VIP members get every signal first 💎') });
    const r = await start(s);
    assert.equal(r.status, 200, r.text);
    const sid = r.body.session.id;
    assert.match(r.body.session.turns.map((t) => t.text).join(' '), /build your bot/);
    assert.equal(r.body.session.view.stage, 'kind', 'the first question is what their bot should do');
    const c0 = aiCalls();
    let v = await say(s, sid, { chip: 'kind:welcome' });
    assert.equal(v.view.stage, 'goal', 'a welcome bot: then what should happen when someone joins');
    v = await say(s, sid, { chip: 'goal:vip' });
    v = await say(s, sid, { chip: 'about:trading' });
    assert.equal(aiCalls(), c0, 'a chip tap never calls the AI');
    assert.equal(v.view.stage, 'link');
    v = await say(s, sid, { text: 'https://vip.example.com/join' });
    assert.match(lastCas(v), /Signals Channel/, 'the only channel is picked for them');
    assert.equal(v.view.stage, 'way');
    assert.equal(aiCalls(), c0, 'a pasted link is not an AI call');
    v = await say(s, sid, { chip: 'way:one' });
    assert.equal(aiCalls(), c0 + 1, 'Cas writes the welcome (the AI writes text)');
    const writeCall = app.fakes.ai.calls[app.fakes.ai.calls.length - 1];
    assert.ok(writeCall.system_blocks[0].cache_control, 'the shared system prompt is cached');
    assert.match(writeCall.system_blocks[0].text, /Cas Builder/);
    assert.match(JSON.stringify(writeCall.messages), /offer them the VIP group/, 'the AI knows their goal');
    assert.equal(writeCall.model, 'claude-sonnet-4-5', 'the writing model');
    assert.equal(v.view.stage, 'review');
    assert.match(lastCas(v), /Like this\? 👍/);
    assert.match(v.view.draft.steps[0].body, /Welcome to Signals/);
    v = await say(s, sid, { chip: 'rv:ok' });
    assert.match(lastCas(v), /right after they get your welcome/, 'the default for who gets in, in one line');
    assert.equal(v.view.draft.approve_mode, 'after_welcome');
    assert.equal(v.view.stage, 'offer_start');
    v = await say(s, sid, { chip: 'os:yes' });
    assert.equal(aiCalls(), c0 + 2, 'Cas writes the message after Start');
    assert.equal(v.view.draft.start_button, true, 'the Tap Start button is added for them');
    assert.match(lastCas(v), /added a Tap Start button/);
    const c1 = aiCalls();
    v = await say(s, sid, { chip: 'rv:ok' });
    assert.deepEqual(v.view.draft.steps[1].buttons.map((b) => [b.label, b.kind, b.url]), [['💎 Join VIP', 'link', 'https://vip.example.com/join']], 'their link becomes a button that opens it');
    assert.equal(v.view.stage, 'offer_remind');
    const chips = [
      { chip: 'or:yes' }, { chip: 'rv:ok' },
      { chip: 'nx:msg' }, { chip: 't:0' }, { chip: 'p:own' }, { text: 'VIP or free tips, {name}?' }, { chip: 'nx:button' }, { chip: 'bk:reply' }, { chip: 'bl:⭐ VIP signals' },
      { chip: 'bm:more' }, { text: '📘 Free tips' }, { chip: 'bm:done' }, { chip: 'br:own' }, { text: 'VIP it is ⭐' }, { chip: 'br:own' }, { text: 'Free tips 📘' },
      { chip: 'nx:done' },
    ];
    for (const input of chips) v = await say(s, sid, input);
    assert.equal(aiCalls(), c1, 'no AI call for any of those taps (or the typed answers to Cas\'s questions)');
    assert.equal(v.view.stage, 'ready');
    assert.ok(v.turns.some((t) => t.celebrate && /Your welcome bot is ready/.test(t.text)), 'a small celebration');
    assert.deepEqual(v.view.chips.filter((c) => c.act).map((c) => c.label).slice(0, 3), ['🚀 Switch it on', '📲 Send me a test on Telegram', '▶ See it play']);
    const d = v.view.draft;
    assert.deepEqual(d.steps.map((x, i) => E.trigOf(x, i)), ['after_previous', 'on_start', 'no_response', 'after_previous', 'on_button', 'on_button']);
    assert.equal(d.steps[2].trigger.seconds, 3600, 'the reminder comes after 1 hour');
    assert.deepEqual(d.steps[3].buttons.map((b) => [b.label, b.kind]), [['⭐ VIP signals', 'reply'], ['📘 Free tips', 'reply']], '"They get another message" makes buttons they tap for an answer');
    assert.equal(E.problems(d, { plan: { features: ['welcome_flows', 'tap_to_start'], flow_steps: 20 }, flows: [] }), '');
    // See it play: Cas says one line and stays ready.
    v = await say(s, sid, { chip: 'rd:play' });
    assert.equal(v.view.stage, 'ready');
    // Switch it on: saved and live, with the builder's checks.
    const sv = await s.c.post(`/api/cas-builder/sessions/${sid}/save`, { active: true });
    assert.equal(sv.status, 200, sv.text);
    assert.ok(!sv.body.error, JSON.stringify(sv.body.error));
    assert.equal(sv.body.saved.active, true);
    assert.match(lastCas(sv.body), /You're live/);
    const q = await app.db.one('select * from sequences where id = $1', [sv.body.saved.flow_id]);
    assert.equal(q.active, true);
    const steps = await app.db.many('select position, trigger_type, delay_seconds from sequence_steps where sequence_id = $1 and variant = 0 order by position', [q.id]);
    assert.deepEqual(steps.map((x) => x.trigger_type), ['after_previous', 'on_start', 'no_response', 'after_previous', 'on_button', 'on_button']);
    const ses = await app.db.one('select * from cas_sessions where id = $1', [sid]);
    assert.ok(ses.counted_at, 'counted as one build');
    assert.equal(ses.paid_by, 'plan');
    const use = await app.db.one("select count(*)::int n, sum(cost_usd)::float cost from ai_usage where kind = 'cas_builder' and session_id = $1", [sid]);
    assert.equal(use.n, 2);
    assert.ok(use.cost > 0, 'the cost is estimated and logged');
  });

  it('"✨ Just build it for me" builds a whole bot from the goal and the topic, without the AI', async () => {
    const s = await setup('growth');
    scriptModel();
    const r = await start(s);
    const sid = r.body.session.id;
    assert.ok(!r.body.session.view.chips.some((c) => c.id === 'jb:go'), 'not offered before they answer anything');
    let v = await say(s, sid, { chip: 'goal:gift' });
    assert.ok(!v.view.chips.some((c) => c.id === 'jb:go'), 'not after the first answer either');
    v = await say(s, sid, { chip: 'about:shop' });
    assert.ok(v.view.chips.some((c) => c.id === 'jb:go' && c.label === '✨ Just build it for me'), 'offered after the second answer');
    await say(s, sid, { text: 'gift.example.com/free-guide' });
    const c0 = aiCalls();
    v = await say(s, sid, { chip: 'jb:go' });
    assert.equal(aiCalls(), c0, 'no AI call');
    assert.equal(v.view.stage, 'jb_review');
    assert.equal(v.turns.filter((t) => t.from === 'cas').pop().text, 'Like it?', 'then it only asks "Like it?"');
    const d = v.view.draft;
    assert.deepEqual(d.steps.map((x, i) => E.trigOf(x, i)), ['after_previous', 'after_previous', 'on_start', 'no_response'], 'welcome, a right-away nudge, a message after Start, a reminder');
    assert.equal(d.approve_mode, 'after_welcome');
    assert.equal(d.start_button, true);
    assert.match(d.steps[1].body, /Tap \*Start\*/);
    assert.deepEqual(d.steps[2].buttons.map((b) => [b.label, b.kind, b.url]), [['🎁 Get my gift', 'link', 'https://gift.example.com/free-guide']]);
    assert.equal(d.steps[3].trigger.seconds, 3600);
    assert.equal(d.chat_id, s.chanId); assert.equal(d.bot_id, s.bot.connId);
    v = await say(s, sid, { text: 'yes' });
    assert.equal(v.view.stage, 'ready');
    assert.ok(v.turns.some((t) => t.celebrate));
    const sv = await s.c.post(`/api/cas-builder/sessions/${sid}/save`, { active: true });
    assert.equal(sv.status, 200, sv.text);
    assert.equal(sv.body.saved.active, true, JSON.stringify(sv.body.error));
    assert.equal(aiCalls(), c0, 'built and switched on with no AI call at all');
  });

  it('a typed instruction becomes validated operations (the model answers with tools)', async () => {
    const s = await setup('growth');
    const sid = await toNext(s);
    await say(s, sid, { chip: 'nx:msg' }); await say(s, sid, { chip: 't:0' }); await say(s, sid, { chip: 'p:own' });
    await say(s, sid, { text: 'please tap the button above, {name} 👆 We have lots of great things waiting for you here.' });
    scriptModel({ ops: [{ op: 'update_message', message: 2, text: 'Tap the button above 👆' }, { op: 'add_button', message: 1, label: '⭐ VIP', kind: 'link', url: 'https://vip.example.com/join' }, { op: 'set_wait', message: 2, seconds: 10 }] });
    const c0 = aiCalls();
    const v = await say(s, sid, { text: 'make message 2 shorter, add a VIP button with link https://vip.example.com/join and wait 10 seconds before message 2' });
    assert.equal(aiCalls(), c0 + 1);
    const call = app.fakes.ai.calls[app.fakes.ai.calls.length - 1];
    assert.ok(call.tools.some((t) => t.name === 'add_message') && call.tools.some((t) => t.name === 'ask_user'), 'strict tools are offered');
    assert.equal(call.model, 'claude-haiku-4-5-20251001', 'the fast model reads instructions');
    assert.match(JSON.stringify(call.messages), /The flow now/, 'a compact flow state is sent');
    const d = v.view.draft;
    assert.equal(d.steps[1].body, 'Tap the button above 👆');
    assert.deepEqual(d.steps[1].trigger, { type: 'wait', seconds: 10 });
    assert.equal(d.steps[0].buttons[0].url, 'https://vip.example.com/join');
    assert.match(lastCas(v), /Changed message 2/);
    // "rewrite" asks the writing model for the words.
    scriptModel({ ops: [{ op: 'update_message', message: 1, rewrite: 'shorter' }], write: 'Hi {name} 👋 Short and sweet.' });
    const v2 = await say(s, sid, { text: 'make the welcome shorter' });
    assert.equal(v2.view.draft.steps[0].body, 'Hi {name} 👋 Short and sweet.');
    assert.equal(aiCalls(), c0 + 3, 'one call to read it, one to write it');
    // Undo puts it back.
    const u = await s.c.post(`/api/cas-builder/sessions/${sid}/undo`, {});
    assert.equal(u.status, 200, u.text);
    assert.notEqual(u.body.view.draft.steps[0].body, 'Hi {name} 👋 Short and sweet.');
  });

  it('refuses unknown operations, code, javascript: links and more messages than the plan allows', async () => {
    const s = await setup('starter'); // 5 messages a flow
    const sid = await toNext(s);
    const draft = async () => (await s.c.get(`/api/cas-builder/sessions/${sid}`)).body.session.view.draft;
    const before = JSON.stringify(await draft());
    const tryOps = async (ops) => { scriptModel({ ops }); return say(s, sid, { text: 'do the thing' }); };
    let v = await tryOps([{ op: 'drop_database' }]);
    assert.match(lastCas(v), /couldn't do that one/i);
    assert.equal(JSON.stringify(v.view.draft), before);
    v = await tryOps([{ op: 'update_message', message: 1, text: 'Hi <script>alert(1)</script>' }]);
    assert.match(lastCas(v), /code in it/);
    assert.equal(JSON.stringify(v.view.draft), before);
    v = await tryOps([{ op: 'add_button', message: 1, label: 'Click', kind: 'link', url: 'javascript:alert(1)' }]);
    assert.match(lastCas(v), /isn't a web page/);
    assert.equal(JSON.stringify(v.view.draft), before);
    v = await tryOps([{ op: 'update_message', message: 1, text: 'ok', sneaky: true }]);
    assert.match(lastCas(v), /Unknown field/);
    v = await tryOps([{ op: 'update_message', message: 1, text: 'fine' }, { op: 'delete_step', message: 1 }]);
    assert.match(lastCas(v), /welcome always comes first/);
    assert.equal(JSON.stringify(v.view.draft), before, 'all or nothing: the good change in the same answer is not kept either');
    const many = Array.from({ length: 6 }, (_, i) => ({ op: 'add_message', trigger: { type: 'wait', seconds: 60 + i }, text: 'Tip number ' + (i + 1) }));
    v = await tryOps(many);
    assert.match(lastCas(v), /Starter plan allows 5 messages/);
    assert.equal(JSON.stringify(v.view.draft), before);
    // An op that names a button that isn't there.
    v = await tryOps([{ op: 'add_message', trigger: { type: 'on_button', button: 'nope' }, text: 'Answer' }]);
    assert.match(lastCas(v), /couldn't find the button/);
    // The engine also refuses these on its own (the demo uses the same checks).
    const ctx = { plan: { features: ['welcome_flows', 'tap_to_start'], flow_steps: 5 }, flows: [] };
    const d0 = await draft();
    assert.equal(E.applyOps(d0, [{ op: 'add_button', message: 1, label: '<img src=x onerror=alert(1)>', kind: 'reply' }], ctx).ok, false);
    assert.equal(E.applyOps(d0, [{ op: 'rename_flow', name: 'ok' }], ctx).ok, true);
    // Free plan: no follow-ups or choice buttons, by chat either.
    const f = await setup('free');
    const sf = await toNext(f);
    scriptModel({ ops: [{ op: 'add_message', trigger: { type: 'wait', seconds: 5 }, text: 'More!' }] });
    const vf = await say(f, sf, { text: 'add another message after 5 seconds' });
    assert.match(lastCas(vf), /Free plan sends 1 welcome message|Starter and up/);
    assert.equal(vf.view.draft.steps.length, 1);
  });

  it('a link the builder would refuse is refused before it stays (same checks as a save)', async () => {
    const s = await setup('growth');
    const sid = await toNext(s);
    scriptModel({ ops: [{ op: 'add_button', message: 1, label: 'Shop', kind: 'link', url: 'https://' + 'x'.repeat(290) + '.com' }] });
    const v = await say(s, sid, { text: 'add a shop button' });
    assert.match(lastCas(v), /couldn't do that one|doesn't look like a link/i);
    assert.equal(v.view.draft.steps[0].buttons.length, 0);
  });
});

describe('Cas Builder: builds, credits and the daily cap', () => {
  it('counts a build per new flow: Free gets its first flow for life', async () => {
    const s = await setup('free');
    let st = (await s.c.get('/api/cas-builder')).body;
    assert.equal(st.builds.limit, 1);
    assert.equal(st.builds.period, 'lifetime');
    assert.equal(st.builds.left, 1);
    const sid = await toNext(s);
    st = (await s.c.get('/api/cas-builder')).body;
    assert.equal(st.builds.used, 1, 'counted when Cas first wrote for it');
    assert.equal(st.builds.left, 0);
    // Resume still works for the one already counted.
    const back = await s.c.get(`/api/cas-builder/sessions/${sid}`);
    assert.equal(back.status, 200);
    // A new build is refused, with gentle options.
    const r = await start(s);
    assert.equal(r.status, 402);
    assert.equal(r.body.code, 'cas_builds_out');
    assert.match(r.body.error, /builder \(free\)/);
    assert.equal(r.body.pack.builds, 20);
    assert.equal(r.body.builds.left, 0);
    // Still refused months later (lifetime).
    await app.db.query("update cas_sessions set counted_at = now() - interval '200 days' where id = $1", [sid]);
    assert.equal((await start(s)).body.code, 'cas_builds_out');
  });

  it('paid plans count per month; credits are bought from the wallet and used after the plan', async () => {
    const s = await setup('starter');
    for (let i = 0; i < 10; i++) await app.db.query("insert into cas_sessions(workspace_id, user_id, kind, counted_at, paid_by, status) values ($1,$2,'new', now(), 'plan', 'saved')", [s.ws.id, s.c.user.id]);
    let st = (await s.c.get('/api/cas-builder')).body;
    assert.equal(st.builds.used, 10); assert.equal(st.builds.left, 0); assert.equal(st.builds.period, 'month');
    assert.equal((await start(s)).body.code, 'cas_builds_out');
    // Last month's builds don't count this month.
    await app.db.query("update cas_sessions set counted_at = date_trunc('month', now()) - interval '1 day' where workspace_id = $1", [s.ws.id]);
    assert.equal((await s.c.get('/api/cas-builder')).body.builds.left, 10);
    await app.db.query("update cas_sessions set counted_at = now() where workspace_id = $1", [s.ws.id]);
    // Wallet short → a friendly 402.
    let b = await s.c.post('/api/cas-builder/credits', {});
    assert.equal(b.status, 402); assert.equal(b.body.code, 'wallet_short');
    // Bonus credit does not pay for credits.
    await app.db.query('update workspaces set bonus_cents = 5000, wallet_cents = 600 where id = $1', [s.ws.id]);
    b = await s.c.post('/api/cas-builder/credits', {});
    assert.equal(b.status, 200, b.text);
    assert.equal(b.body.credits, 20);
    const w = await app.db.one('select wallet_cents, bonus_cents, cas_credits from workspaces where id = $1', [s.ws.id]);
    assert.equal(Number(w.wallet_cents), 100); assert.equal(Number(w.bonus_cents), 5000); assert.equal(w.cas_credits, 20);
    const tx = await app.db.one("select * from wallet_tx where workspace_id = $1 and kind = 'cas_credits'", [s.ws.id]);
    assert.equal(Number(tx.amount_cents), -500);
    // Now a build uses a credit.
    const sid = await toNext(s);
    const ses = await app.db.one('select paid_by from cas_sessions where id = $1', [sid]);
    assert.equal(ses.paid_by, 'credit');
    assert.equal((await app.db.one('select cas_credits from workspaces where id = $1', [s.ws.id])).cas_credits, 19);
    // The team can stop selling credits.
    await setConf({ credit_pack_price_cents: 0 });
    assert.equal((await s.c.post('/api/cas-builder/credits', {})).body.code, 'cas_credits_off');
    // A setup helper can't spend the wallet on credits (billing permission).
  });

  it('Scale is unlimited with a fair-use soft cap', async () => {
    const s = await setup('scale');
    await setConf({ fair_use_monthly: 2 });
    let st = (await s.c.get('/api/cas-builder')).body;
    assert.equal(st.builds.unlimited, true); assert.equal(st.builds.left, 2);
    for (let i = 0; i < 2; i++) await app.db.query("insert into cas_sessions(workspace_id, user_id, kind, counted_at, paid_by, status) values ($1,$2,'new', now(), 'plan', 'saved')", [s.ws.id, s.c.user.id]);
    st = (await s.c.get('/api/cas-builder')).body;
    assert.equal(st.builds.available, false);
    const r = await start(s);
    assert.equal(r.body.code, 'cas_builds_out');
    assert.match(r.body.error, /fair-use/);
  });

  it('rests until tomorrow when the day\'s spend reaches the cap (and taps keep working)', async () => {
    const s = await setup('growth');
    const sid = await toNext(s);
    await setConf({ daily_cap_usd: 0.5 });
    await app.db.query("insert into ai_usage(workspace_id, user_id, kind, writes, cost_usd) values ($1, $2, 'cas_builder', 0, 0.6)", [s.ws.id, s.c.user.id]);
    const st = (await s.c.get('/api/cas-builder')).body;
    assert.equal(st.resting, true);
    const r = await start(s);
    assert.equal(r.status, 503); assert.equal(r.body.code, 'cas_resting');
    assert.match(r.body.error, /resting until tomorrow/);
    // Inside an open chat: taps work, writing falls back to a ready-made text, typed words get a kind note. No AI calls.
    const c0 = aiCalls();
    await say(s, sid, { chip: 'nx:start' });
    let v = await say(s, sid, { chip: 'p:thanks' });
    assert.match(lastCas(v), /resting until tomorrow/);
    assert.match(v.view.draft.steps[1].body, /Thanks for tapping Start/);
    v = await say(s, sid, { chip: 'rv:ok' });
    v = await say(s, sid, { text: 'make the welcome more exciting' });
    assert.match(lastCas(v), /resting until tomorrow/);
    assert.equal(aiCalls(), c0);
    // Admin → Cas AI sees it.
    const owner = await app.owner();
    const a = await owner.get('/api/admin/cas-builder');
    assert.equal(a.status, 200, a.text);
    assert.equal(a.body.cas_builder.resting, true);
    assert.ok(a.body.cas_builder.builds_today >= 1);
    assert.ok(a.body.cas_builder.spent_today >= 0.6);
  });
});

describe('Cas Builder: drafts, existing flows, saving', () => {
  it('saves the draft as you go: resume it later', async () => {
    const s = await setup('growth');
    const sid = await toNext(s);
    await say(s, sid, { chip: 'nx:msg' });
    const st = (await s.c.get('/api/cas-builder')).body;
    assert.equal(st.draft.id, sid);
    assert.equal(st.draft.steps, 1);
    const g = await s.c.get(`/api/cas-builder/sessions/${sid}`);
    assert.equal(g.body.session.view.stage, 'timing');
    assert.ok(g.body.session.turns.length > 8);
    assert.match(g.body.session.view.draft.steps[0].body, /Welcome/);
    // Someone else can't open it.
    const other = await setup('growth');
    assert.equal((await other.c.get(`/api/cas-builder/sessions/${sid}`)).status, 404);
    // A fresh start closes the unsaved draft.
    scriptModel();
    await start(s);
    assert.equal((await app.db.one('select status from cas_sessions where id = $1', [sid])).status, 'closed');
    assert.equal((await s.c.post(`/api/cas-builder/sessions/${sid}/reply`, { chip: 't:0' })).status, 409);
  });

  it('changing an existing flow by chat never counts as a build', async () => {
    const s = await setup('starter');
    const f = await s.c.post('/api/flows', { name: 'Old flow', chat_id: s.chanId, bot_id: s.bot.connId, approve_mode: 'after_welcome', start_button: true, start_label: '👆 Tap Start', steps: [{ body: 'Hi {name}, welcome!' }, { body: 'Thanks for tapping Start!', trigger: { type: 'on_start' } }] });
    assert.equal(f.status, 200, f.text);
    for (let i = 0; i < 10; i++) await app.db.query("insert into cas_sessions(workspace_id, user_id, kind, counted_at, paid_by, status) values ($1,$2,'new', now(), 'plan', 'saved')", [s.ws.id, s.c.user.id]);
    assert.equal((await s.c.get('/api/cas-builder')).body.builds.left, 0);
    const r = await start(s, { flow_id: f.body.id });
    assert.equal(r.status, 200, r.text);
    const sid = r.body.session.id;
    assert.equal(r.body.session.kind, 'edit');
    assert.equal(r.body.session.view.stage, 'next');
    assert.match(r.body.session.turns[0].text, /Old flow/);
    scriptModel({ ops: [{ op: 'update_message', message: 2, text: 'Thank you, {name}! 🎉' }, { op: 'add_message', trigger: { type: 'wait', seconds: 3600 }, text: 'A tip for you 💡' }] });
    const v = await say(s, sid, { text: 'make message 2 warmer and add a tip an hour later' });
    assert.equal(v.view.draft.steps.length, 3);
    const sv = await s.c.post(`/api/cas-builder/sessions/${sid}/save`, {});
    assert.equal(sv.status, 200, sv.text);
    assert.equal(sv.body.saved.flow_id, f.body.id, 'saved over the same flow');
    const steps = await app.db.many('select body, trigger_type, delay_seconds from sequence_steps where sequence_id = $1 and variant = 0 order by position', [f.body.id]);
    assert.deepEqual(steps.map((x) => x.body), ['Hi {name}, welcome!', 'Thank you, {name}! 🎉', 'A tip for you 💡']);
    assert.equal(steps[2].delay_seconds, 3600);
    const ses = await app.db.one('select counted_at, kind from cas_sessions where id = $1', [sid]);
    assert.equal(ses.counted_at, null, 'not a build');
    assert.equal((await s.c.get('/api/cas-builder')).body.builds.used, 10);
  });

  it('switching on explains a bot that is not an admin, and offers to replace a live flow', async () => {
    const s = await setup('growth');
    const sid = await toNext(s);
    const rd = await say(s, sid, { chip: 'nx:done' });
    assert.equal(rd.view.stage, 'ready');
    app.fakes.tg.chatMember = { status: 'member' };
    let sv = await s.c.post(`/api/cas-builder/sessions/${sid}/save`, { active: true });
    assert.equal(sv.status, 200, sv.text);
    assert.equal(sv.body.error.code, 'bot_not_admin');
    assert.match(lastCas(sv.body), /One more thing/);
    assert.ok(sv.body.view.chips.some((c) => c.id === 'sw:on'));
    assert.doesNotMatch(lastCas(sv.body), /\b(flows?|join requests?)\b/i, 'the server\'s words are made plain');
    app.fakes.tg.chatMember = null;
    // Another live flow on the same channel.
    const other = await s.c.post('/api/flows', { name: 'Live one', chat_id: s.chanId, bot_id: s.bot.connId, approve_mode: 'after_welcome', steps: [{ body: 'Hello' }], active: true });
    assert.equal(other.status, 200, other.text);
    sv = await s.c.post(`/api/cas-builder/sessions/${sid}/save`, { active: true });
    assert.equal(sv.body.error.code, 'flow_live_clash');
    assert.doesNotMatch(lastCas(sv.body), /\bflows?\b/i);
    assert.ok(sv.body.view.chips.some((c) => c.id === 'sw:replace'));
    sv = await s.c.post(`/api/cas-builder/sessions/${sid}/save`, { active: true, replace: true });
    assert.equal(sv.body.saved.active, true);
    assert.equal((await app.db.one('select active from sequences where id = $1', [other.body.id])).active, false);
    // Only one build for this flow, however many saves.
    assert.equal((await app.db.one('select count(*)::int n from cas_sessions where workspace_id = $1 and counted_at is not null', [s.ws.id])).n, 1);
  });

  it('a drafter cannot build, the switch can turn it off, and the AI\'s plan list knows the builds', async () => {
    const s = await setup('growth');
    await app.db.query("update features set enabled = false where key = 'cas_builder'").catch(() => {});
    await app.db.query("insert into feature_flags(key, enabled) values ('cas_builder', false) on conflict (key) do update set enabled = false");
    app.settings.bust();
    const r = await start(s);
    assert.equal(r.status, 403);
    await app.db.query("update feature_flags set enabled = true where key = 'cas_builder'");
    app.settings.bust();
    const txt = await require('../../server/services/ai').plansText();
    assert.match(txt, /10 Cas Builder builds a month/);
    assert.match(txt, /20 builds for \$5/);
  });
});

/* ---------- The conversation itself, for total beginners (engine only: the same file runs on the server and in the demo) ---------- */
describe('Cas Builder: made for total beginners', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const BANNED = /\b(flows?|triggers?|approve mode|join requests?|reply buttons?|link buttons?|steps?)\b/i;
  const bots = (k) => ({ ...app.require('services/billing').BOT_PLANS[k], unlock: { lead_questions: 'Starter', referral: 'Growth', broadcast: 'Starter' } });
  const plan = (code) => ({
    free: { name: 'Free', features: ['auto_approve', 'welcome_message'], flow_steps: 1, branding: true, bots: bots('free') },
    starter: { name: 'Starter', features: ['auto_approve', 'welcome_message', 'welcome_flows', 'tap_to_start', 'broadcasts'], flow_steps: 5, branding: false, bots: bots('starter') },
    growth: { name: 'Growth', features: ['auto_approve', 'welcome_message', 'welcome_flows', 'tap_to_start', 'start_another_flow', 'broadcasts'], flow_steps: 20, branding: false, bots: bots('growth') },
    tiny: { name: 'Tiny', features: ['auto_approve', 'welcome_message', 'welcome_flows', 'tap_to_start'], flow_steps: 2, branding: false, bots: { ...bots('starter'), bot_steps: 2, menu_buttons: 2, lead_questions_per_form: 2 } },
  })[code];
  const ctxFor = (code, { chats = 1, bots = 1 } = {}) => ({ plan: plan(code), chats: Array.from({ length: chats }, (_, i) => ({ id: 10 + i, title: 'Channel ' + (i + 1), kind: 'channel' })), bots: Array.from({ length: bots }, (_, i) => ({ id: 20 + i, username: 'bot' + (i + 1) })), flows: [], profile: {} });
  /** Run inputs through the engine; AI requests get the ready-made texts (no AI anywhere). */
  function run(ctx, inputs) {
    let { state, turns } = E.start(ctx, {});
    let all = turns.slice();
    let aiAsked = 0;
    for (const inp of inputs) {
      const r = E.reply(state, inp, ctx);
      state = r.state; all = all.concat(r.turns);
      if (r.ai) { aiAsked++; const d = E.aiDone(state, r.ai.kind === 'write' ? { fallback: true, reason: 'off' } : { ops: [] }, ctx); state = d.state; all = all.concat(d.turns); }
      if (r.check) { const d = E.checkDone(state, { ok: true }, ctx); state = d.state; all = all.concat(d.turns); }
    }
    return { state, turns: all, view: E.view(state, ctx), aiAsked };
  }

  it('asks about their goal first, with answers to tap', () => {
    const { state, turns } = E.start(ctxFor('growth'), {});
    assert.equal(state.stage, 'kind');
    assert.equal(turns[turns.length - 1].text, 'What do you want your bot to do?');
    assert.deepEqual(E.view(state, ctxFor('growth')).chips.map((c) => c.label), ['👋 Welcome people who ask to join my channel', '✅ Make people join my channel first', '🎁 Give a free gift', '📋 Show a menu', '❓ Ask people questions (collect leads)', '🔗 Get people to invite friends', '✍️ Something else (type it)']);
    const w = E.reply(state, { chip: 'kind:welcome' }, ctxFor('growth'));
    assert.equal(w.state.stage, 'goal');
    assert.equal(w.turns[w.turns.length - 1].text, 'What would you like to happen when someone joins your channel?');
    assert.deepEqual(E.view(w.state, ctxFor('growth')).chips.map((c) => c.label), ['Welcome them 👋', 'Send them my link 🔗', 'Give a free gift 🎁', 'Offer VIP 💎', 'Something else ✍️']);
    // Typing still works, and needs no AI.
    const r = run(ctxFor('growth'), [{ chip: 'kind:welcome' }, { text: 'I want to send people to my VIP group' }]);
    assert.equal(r.aiAsked, 0);
    assert.equal(r.state.goal, 'vip');
    assert.equal(r.view.stage, 'about');
  });

  it('never uses technical words: every message and answer in cas-engine.js is plain', () => {
    // 1. Every piece of text written in the engine.
    const code = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'cas-engine.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const bad = [];
    for (const m of code.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) { const v = m[1]; if (/^[\w:.-]*$/.test(v)) continue; if (BANNED.test(v)) bad.push(v); }
    assert.deepEqual(bad, [], 'strings with technical words');
    // 2. Everything Cas says and every chip, walking the chat at random on every plan (seeded, repeatable).
    let seed = 7;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const UI_ONLY = ['switch', 'switch_replace', 'save', 'draft', 'builder', 'close', 'connect_channel', 'connect_bot'];
    const said = new Set(), chipsSeen = new Set(), long = [];
    for (const code of ['free', 'starter', 'growth', 'tiny']) {
      for (const shape of [{ chats: 1, bots: 1 }, { chats: 0, bots: 0 }, { chats: 2, bots: 2 }]) {
        const ctx = ctxFor(code, shape);
        for (let walk = 0; walk < 40; walk++) {
          let { state, turns } = E.start(ctx, {});
          turns.forEach((t) => said.add(t.text));
          for (let k = 0; k < 30; k++) {
            const v = E.view(state, ctx);
            const q = E.question(state, ctx);
            if (q.text && [...q.text].length > 140) long.push(q.text);
            v.chips.forEach((c) => chipsSeen.add(c.label));
            const pick = v.chips.filter((c) => !c.lock && !UI_ONLY.includes(c.act));
            let input;
            if (v.stage === 'link' || v.stage === 'link_late' || v.stage === 'btn_link') input = rnd(3) ? { text: 'https://example.com/x' } : pick.length ? { chip: pick[rnd(pick.length)].id } : { text: 'later' };
            else if (['own', 'own_new', 'btn_label', 'about', 'goal_other', 'timing_other', 'remind_other', 'bk_menu_own', 'bk_q_custom', 'bk_ans', 'bk_gift', 'bk_thanks', 'bk_reward', 'bk_goal', 'kind_other'].includes(v.stage) && (!pick.length || !rnd(3))) input = { text: v.stage.endsWith('other') && !['goal_other', 'kind_other'].includes(v.stage) ? '10 minutes' : v.stage === 'bk_goal' ? '4' : v.stage === 'kind_other' ? ['a menu for my shop', 'collect emails', 'something fun', 'invite friends'][rnd(4)] : 'Hello {name} 🙂' };
            else if (v.stage === 'bk_link') input = rnd(3) ? { text: 'https://example.com/gift' } : { text: 'later' };
            else if (!pick.length) break;
            else input = { chip: pick[rnd(pick.length)].id };
            const r = E.reply(state, input, ctx);
            state = r.state;
            let ts = r.turns;
            if (r.ai) { const d = E.aiDone(state, r.ai.kind === 'write' ? { fallback: true, reason: 'off' } : { ops: [] }, ctx); state = d.state; ts = ts.concat(d.turns); }
            if (r.check) { const d = E.checkDone(state, rnd(3) ? { ok: true } : { ok: false, message: '@bot1 needs to be an admin of "Channel 1" so it can check who joined. Then try again.' }, ctx); state = d.state; ts = ts.concat(d.turns); }
            for (const t of ts) if (t.from === 'cas') said.add(t.text);
            assert.equal(E.problems(state.draft, ctx), '', 'the draft always stays valid');
            assert.deepEqual(E.directionIssues(state.draft), [], 'Cas\'s words always point the right way (below / above)');
          }
        }
      }
    }
    const jargon = [...said, ...chipsSeen].filter((t) => BANNED.test(t));
    assert.deepEqual(jargon, [], 'Cas said a technical word');
    assert.deepEqual(long, [], 'questions are one short sentence');
    assert.ok(said.size > 40 && chipsSeen.size > 40, 'the walk covered the chat (' + said.size + ' lines, ' + chipsSeen.size + ' chips)');
  });

  it('"Just build it" makes a valid bot for every goal and plan, without the AI', () => {
    for (const code of ['free', 'starter', 'growth', 'tiny']) {
      for (const goal of ['welcome', 'link', 'gift', 'vip', 'other']) {
        for (const link of [true, false]) {
          const inputs = [{ chip: 'goal:' + goal }];
          if (goal === 'other') inputs.push({ chip: 'go:tips' });
          inputs.push({ chip: 'about:sports' });
          if (['link', 'gift', 'vip'].includes(goal) && link) inputs.push({ text: 'https://example.com/' + goal });
          inputs.push({ chip: 'jb:go' });
          const ctx = ctxFor(code);
          const r = run(ctx, inputs);
          const tag = code + '/' + goal + '/' + link;
          assert.equal(r.aiAsked, 0, tag);
          assert.equal(r.view.stage, 'jb_review', tag);
          const d = r.state.draft;
          assert.equal(E.problems(d, ctx), '', tag);
          assert.equal(d.approve_mode, 'after_welcome', tag);
          const trig = d.steps.map((s, i) => E.trigOf(s, i));
          const links = d.steps.flatMap((s) => s.buttons).filter((b) => b.kind === 'link');
          const wantsLink = ['link', 'gift', 'vip'].includes(goal) && link;
          assert.equal(links.length, wantsLink ? 1 : 0, tag + ': a button that opens their link, only when they gave one');
          if (wantsLink) assert.equal(links[0].url, 'https://example.com/' + goal);
          if (code === 'free') { assert.deepEqual(trig, ['after_previous'], tag); assert.equal(d.start_button, false, tag); }
          if (code === 'growth' || code === 'starter') {
            assert.deepEqual(trig, wantsLink ? ['after_previous', 'after_previous', 'on_start', 'no_response'] : ['after_previous', 'after_previous', 'on_start'], tag);
            assert.equal(d.start_button, true, tag + ': the Tap Start button comes with the message after Start');
            if (wantsLink) assert.equal(d.steps[3].trigger.seconds, 3600, tag);
          }
          if (code === 'tiny') { assert.equal(d.steps.length, 2, tag + ': fits the plan'); assert.deepEqual(trig, ['after_previous', 'on_start'], tag); }
          assert.deepEqual(E.directionIssues(d), [], tag + ': every "below" / "above" points at the right button');
          if (d.start_button) for (const [k, st] of d.steps.entries()) if (k > 0 && /\bstart\b/i.test(st.body) && /tap/i.test(st.body)) assert.doesNotMatch(st.body, /below|👇/, tag + ': the Start button is above message ' + (k + 1));
          // Then they're asked only "Like it?"; yes → ready, with a celebration.
          const ok = E.reply(r.state, { chip: 'jb:ok' }, ctx);
          assert.equal(E.view(ok.state, ctx).stage, 'ready', tag);
          assert.ok(ok.turns.some((t) => t.celebrate && t.text === '🎉 Your welcome bot is ready!'), tag);
        }
      }
    }
  });

  it('a link pasted later becomes the button their goal needs', () => {
    const ctx = ctxFor('growth');
    const r = run(ctx, [{ chip: 'goal:vip' }, { chip: 'about:trading' }, { chip: 'lk:later' }, { chip: 'jb:go' }, { text: 'https://t.me/+vipgroup' }]);
    assert.equal(r.aiAsked, 0);
    const v = r.state.draft.steps.find((s, i) => E.trigOf(s, i) === 'on_start');
    assert.deepEqual(v.buttons.map((b) => [b.label, b.kind, b.url]), [['💎 Join VIP', 'link', 'https://t.me/+vipgroup']]);
    assert.match(v.body, /VIP/);
    assert.equal(r.view.stage, 'jb_review');
  });

  it('chooses the technical things itself, with safe defaults and a gentle note', () => {
    const ctx = ctxFor('growth');
    // Who gets in: right after the welcome, said once, with a chip to change it in plain words.
    let r = run(ctx, [{ chip: 'goal:welcome' }, { chip: 'about:learn' }, { chip: 'way:one' }, { chip: 'rv:ok' }]);
    assert.ok(r.turns.some((t) => t.text === 'I\'ll let people in right after they get your welcome ✅'));
    assert.ok(r.view.chips.some((c) => c.id === 'os:mode' && c.label === 'Change when they get in'));
    const m = run(ctx, [{ chip: 'goal:welcome' }, { chip: 'about:learn' }, { chip: 'way:one' }, { chip: 'rv:ok' }, { chip: 'os:mode' }, { chip: 'mode:instant' }]);
    assert.equal(m.state.draft.approve_mode, 'instant');
    assert.equal(m.view.stage, 'offer_start', 'back where they were');
    // The Tap Start button is added when a message after Start needs it.
    r = run(ctx, [{ chip: 'goal:welcome' }, { chip: 'about:learn' }, { chip: 'way:one' }, { chip: 'rv:ok' }, { chip: 'os:yes' }]);
    assert.equal(r.state.draft.start_button, true);
    assert.ok(r.turns.some((t) => /added a Tap Start button/.test(t.text)));
    assert.equal(r.view.stage, 'review');
    assert.equal(r.turns[r.turns.length - 1].text, 'Like this? 👍', 'show, don\'t ask');
    assert.deepEqual(r.view.chips.map((c) => c.label), ['Yes, perfect', 'Shorter', 'Friendlier', '✍️ Type my own']);
    // The kind of button follows from what happens next.
    const base = [{ chip: 'goal:welcome' }, { chip: 'about:learn' }, { chip: 'way:one' }, { chip: 'rv:ok' }, { chip: 'os:no' }, { chip: 'nx:button' }];
    r = run(ctx, base);
    assert.deepEqual(r.view.chips.map((c) => c.label), ['🔗 It opens my link', '💬 They get another message']);
    r = run(ctx, base.concat([{ chip: 'bk:link' }, { chip: 'bl:👉 Open' }, { text: 'example.com' }]));
    assert.deepEqual(r.state.draft.steps[0].buttons.map((b) => [b.kind, b.url]), [['link', 'https://example.com']]);
    r = run(ctx, base.concat([{ chip: 'bk:reply' }, { chip: 'bl:✅ Yes please' }]));
    assert.equal(r.state.draft.steps[0].buttons[0].kind, 'reply');
    // Telegram's 5-minute rule: handled for them with one line, and they can keep their time.
    const late = [{ chip: 'goal:welcome' }, { chip: 'about:learn' }, { chip: 'way:one' }, { chip: 'rv:ok' }, { chip: 'os:no' }, { chip: 'nx:msg' }, { chip: 't:3600' }];
    r = run(ctx, late);
    assert.ok(r.turns.some((t) => /so I'll send this one when they tap Start/.test(t.text)));
    assert.equal(r.view.stage, 'purpose');
    assert.ok(r.view.chips.some((c) => c.id === 'rule:keep' && c.label === '⏱ Keep 1 hour'));
    const kept = run(ctx, late.concat([{ chip: 'rule:keep' }, { chip: 'p:tip' }]));
    assert.deepEqual(kept.state.draft.steps[1].trigger, { type: 'wait', seconds: 3600 });
    const moved = run(ctx, late.concat([{ chip: 'p:tip' }]));
    assert.equal(E.trigOf(moved.state.draft.steps[1], 1), 'on_start');
    assert.equal(moved.state.draft.start_button, true);
    // A short wait needs no note at all.
    const upTo = [{ chip: 'goal:welcome' }, { chip: 'about:learn' }, { chip: 'way:one' }, { chip: 'rv:ok' }, { chip: 'os:no' }, { chip: 'nx:msg' }];
    r = run(ctx, upTo.concat([{ chip: 't:60' }]));
    assert.ok(!r.turns.slice(run(ctx, upTo).turns.length).some((t) => /5 minutes|tap Start/.test(t.text)));
  });

  it('keeps undo, drafts of old chats and the plan limits', () => {
    const ctx = ctxFor('growth');
    const r = run(ctx, [{ chip: 'goal:gift' }, { chip: 'about:shop' }, { text: 'https://example.com/gift' }, { chip: 'jb:go' }]);
    const u = E.undo(r.state, ctx);
    assert.equal(u.state.draft.steps.length, 0, 'undo takes the whole build back');
    assert.equal(E.view(u.state, ctx).stage, 'way');
    // A chat saved before this change (old stage names) still opens and carries on.
    const old = { ...r.state, stage: 'preview', pend: {} };
    assert.equal(E.view(old, ctx).stage, 'ready');
    const go = E.reply(old, { chip: 'rd:play' }, ctx);
    assert.equal(E.view(go.state, ctx).stage, 'ready');
    // A locked answer explains the plan instead.
    const f = run(ctxFor('free'), [{ chip: 'goal:welcome' }, { chip: 'about:learn' }, { chip: 'way:one' }, { chip: 'rv:ok' }]);
    assert.equal(f.view.stage, 'next');
    const lock = f.view.chips.find((c) => c.lock);
    assert.ok(lock);
    const lr = E.reply(f.state, { chip: lock.id }, ctxFor('free'));
    assert.ok(lr.turns.some((t) => t.lock));
  });
});

/* ---------- Arrows point the right way, type your own anything, tap to edit ---------- */
describe('Cas Builder: "below" and "above" point at the right button', () => {
  const ctx = { plan: { name: 'Growth', features: ['welcome_flows', 'tap_to_start'], flow_steps: 20, branding: false }, chats: [], bots: [], flows: [], profile: {} };
  const base = () => ({ name: 'T', approve_mode: 'after_welcome', start_button: true, start_label: '👆 Tap Start', steps: [
    { body: 'Hi {name} 👋 Welcome!\n\nTap *Start* below to get more 👇', buttons: [], trigger: null },
    { body: '👇 Tap *Start* below and I\'ll send you a quick tip.', buttons: [], trigger: { type: 'after_previous' } },
    { body: 'Thanks, {name}! 🎉 Tap the button above to open it.', buttons: [{ id: 'b1', label: '🔗 Your link', url: 'https://example.com', kind: 'link' }], trigger: { type: 'on_start' } },
    { body: 'Still there, {name}? Tap the button below to get your link.', buttons: [], trigger: { type: 'no_response', seconds: 600 } },
  ] });

  it('the owner\'s screenshot: message 2 points down at a Start button that is above it', () => {
    const d = base();
    const iss = E.directionIssues(d);
    assert.deepEqual(iss.map((x) => [x.i, x.word, x.want]), [[1, 'below', 'above'], [2, 'above', 'below'], [3, 'below', 'above']]);
    assert.equal(iss[0].text, 'This says “below”, but the Start button is above.');
    assert.equal(E.fixDirections(d, 1), '👆 Tap *Start* above and I\'ll send you a quick tip.', 'the word and the emoji are turned around, nothing else');
    assert.equal(E.fixDirections(d, 2), 'Thanks, {name}! 🎉 Tap the button below to open it.');
    assert.equal(E.fixDirections(d, 3), 'Still there, {name}? Tap the button above to get your link.');
    assert.equal(E.fixDirections(d, 0), d.steps[0].body, 'the welcome is right: its Start button is under it');
    // Fixed, nothing is left; sentences that don't talk about a button are never touched.
    const f = E.fixAllDirections(base());
    assert.deepEqual(E.directionIssues(f), []);
    const calm = base(); calm.steps[1].body = 'Our tips are below the price chart 👇 Have a look at the news above.';
    assert.deepEqual(E.directionIssues(calm, 1), []);
  });

  it('the builder\'s templates and every ready-made text are right', () => {
    const { TEMPLATES } = require('../../server/services/flows');
    for (const t of TEMPLATES) {
      const d = E.fromFlow({ name: t.name, approve_mode: t.approve_mode, start_button: t.start_button, start_label: t.start_label, steps: t.steps });
      assert.deepEqual(E.directionIssues(d), [], t.key);
    }
    // The ready-made texts that mention Start, when they come after the welcome, say "above".
    for (const goal of ['welcome', 'link', 'gift', 'vip']) {
      const st = E.start(ctx, {}).state;
      let r = E.reply(st, { chip: 'goal:' + goal }, ctx);
      r = E.reply(r.state, { chip: 'about:trading' }, ctx);
      if (r.state.stage === 'link') r = E.reply(r.state, { text: 'https://example.com/' + goal }, ctx);
      r = E.reply(r.state, { chip: 'jb:go' }, ctx);
      const n = r.state.draft.steps[1].body;
      assert.match(n, /👆|above/, goal);
      assert.doesNotMatch(n, /👇|below/, goal);
    }
  });

  it('Cas\'s own written words are turned the right way before they reach the phone', () => {
    let { state } = E.start(ctx, {});
    state.draft = { ...base(), steps: base().steps.slice(0, 1) };
    state.stage = 'next';
    let r = E.reply(state, { chip: 'nx:start' }, ctx);
    r = E.reply(r.state, { chip: 'p:tip' }, ctx);
    assert.equal(r.ai.kind, 'write');
    const d = E.aiDone(r.state, { text: 'Thanks for tapping *Start*! 🎉 Tap *Start* below any time for more tips 👇' }, ctx);
    assert.equal(d.state.draft.steps[1].body, 'Thanks for tapping *Start*! 🎉 Tap *Start* above any time for more tips 👆');
  });
});

describe('Cas Builder: "✍️ Type my own" on every question with suggestions', () => {
  const ctx = { plan: { name: 'Growth', features: ['welcome_flows', 'tap_to_start'], flow_steps: 20, branding: false }, chats: [{ id: 1, title: 'C', kind: 'channel' }], bots: [{ id: 2, username: 'b' }], flows: [], profile: {} };
  const go = (inputs) => { let { state } = E.start(ctx, {}); for (const i of inputs) { const r = E.reply(state, i, ctx); state = r.state; if (r.ai) state = E.aiDone(state, { fallback: true, reason: 'off' }, ctx).state; } return { state, view: E.view(state, ctx) }; };
  const own = (v) => v.chips.find((c) => c.label === '✍️ Type my own');
  const toNext = [{ chip: 'goal:welcome' }, { chip: 'about:learn' }, { chip: 'way:one' }, { chip: 'rv:ok' }, { chip: 'os:no' }];

  it('button text, message text, link, wait time, channel topic and "Something else"', () => {
    const cases = {
      goal_other: [{ chip: 'goal:other' }],
      about: [{ chip: 'goal:welcome' }],
      link: [{ chip: 'goal:vip' }, { chip: 'about:trading' }],
      timing: toNext.concat([{ chip: 'nx:msg' }]),
      purpose: toNext.concat([{ chip: 'nx:msg' }, { chip: 't:5' }]),
      review: [{ chip: 'goal:welcome' }, { chip: 'about:learn' }, { chip: 'way:one' }],
      btn_label: toNext.concat([{ chip: 'nx:button' }, { chip: 'bk:reply' }]),
      branch: toNext.concat([{ chip: 'nx:button' }, { chip: 'bk:reply' }, { chip: 'bl:✅ Yes please' }, { chip: 'bm:done' }]),
      remind_time: toNext.concat([{ chip: 'nx:button' }, { chip: 'bk:reply' }, { chip: 'bl:✅ Yes please' }, { chip: 'bm:done' }, { chip: 'br:skip' }, { chip: 'nx:remind' }]),
    };
    const want = { btn_label: 'Type your button text…', link: 'Paste your link here…', about: 'Type what your channel is about…', goal_other: 'Tell me in a few words…', timing: 'For example: 10 minutes', purpose: 'Type your message…' };
    for (const [stage, inputs] of Object.entries(cases)) {
      const { view } = go(inputs);
      assert.equal(view.stage, stage, stage);
      const c = own(view);
      assert.ok(c, stage + ': has "✍️ Type my own"');
      assert.ok(c.type, stage + ': with a helpful placeholder');
      if (want[stage]) assert.equal(c.type, want[stage], stage);
    }
    // Cas's own question (ask_user) gets one too.
    let { state } = go(toNext);
    const a = E.reply(state, { text: 'something unclear' }, ctx);
    const d = E.aiDone(a.state, { ops: [{ op: 'ask_user', question: 'Which one?', chips: ['VIP', 'Free'] }] }, ctx);
    assert.equal(own(E.view(d.state, ctx)).type, 'Type your answer…');
    // Tapping the keyboard-only chip changes nothing and says nothing.
    state = go([{ chip: 'goal:welcome' }]).state;
    const t = E.reply(state, { chip: 'type:own' }, ctx);
    assert.deepEqual(t.turns, []);
    assert.equal(t.state.stage, 'about');
    // ...and typing the answer works as before (no AI).
    const typed = E.reply(state, { text: 'Daily crypto news' }, ctx);
    assert.equal(typed.ai, null);
    assert.equal(typed.state.about, 'Daily crypto news');
  });
});

describe('Cas Builder: tap to edit and quick actions (no AI, checked, undoable)', () => {
  const edit = (s, sid, body) => s.c.post(`/api/cas-builder/sessions/${sid}/edit`, body);
  const tweak = (s, sid, body) => s.c.post(`/api/cas-builder/sessions/${sid}/tweak`, body);

  it('edits a message\'s words in place: Cas acknowledges, the rest is kept, bad words are refused', async () => {
    const s = await setup('growth');
    const sid = await toNext(s);
    await say(s, sid, { chip: 'nx:start' }); await say(s, sid, { chip: 'p:own' });
    await say(s, sid, { text: 'Line one 🎉\nLine two\nLine three' });
    const c0 = aiCalls();
    let r = await edit(s, sid, { message: 2, text: 'Line one 🎉\nLine TWO, {name}\nLine three' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.view.draft.steps[1].body, 'Line one 🎉\nLine TWO, {name}\nLine three');
    assert.equal(r.body.turns.filter((t) => t.from === 'cas').pop().text, 'Updated message 2 ✓');
    assert.ok(!r.body.turns.some((t) => t.from === 'me'));
    const stage = r.body.view.stage;
    const welcome = r.body.view.draft.steps[0].body;
    // Refused: code, a javascript: trick, hidden characters, too long, empty, a message that isn't there.
    for (const [text, rx] of [['Hi <script>alert(1)</script>', /code in it/], ['<img src=x onerror=alert(1)>', /code in it/], ['Go to javascript:alert(1)', /code in it/], ['Hi\u0007there', /hidden characters/], ['x'.repeat(4097), /too long/], ['   ', /empty/]]) {
      const b = await edit(s, sid, { message: 2, text });
      assert.equal(b.status, 400, text.slice(0, 20));
      assert.equal(b.body.code, 'cas_edit');
      assert.match(b.body.error, rx);
    }
    assert.equal((await edit(s, sid, { message: 9, text: 'Hello' })).status, 400);
    assert.equal((await edit(s, sid, { message: 2, text: { evil: true } })).status, 400);
    const g = (await s.c.get(`/api/cas-builder/sessions/${sid}`)).body.session;
    assert.equal(g.view.draft.steps[1].body, 'Line one 🎉\nLine TWO, {name}\nLine three', 'nothing changed by the refused edits');
    assert.equal(g.view.draft.steps[0].body, welcome);
    assert.equal(g.view.stage, stage, 'the chat stays where it was');
    // Undo takes the edit back.
    const u = await s.c.post(`/api/cas-builder/sessions/${sid}/undo`, {});
    assert.equal(u.body.view.draft.steps[1].body, 'Line one 🎉\nLine two\nLine three');
    assert.equal(aiCalls(), c0, 'editing never calls the AI');
  });

  it('edits a button\'s text and link, and the Start button', async () => {
    const s = await setup('growth');
    scriptModel();
    const r0 = await start(s);
    const sid = r0.body.session.id;
    await say(s, sid, { chip: 'goal:gift' }); await say(s, sid, { chip: 'about:shop' });
    await say(s, sid, { text: 'https://gift.example.com/a' });
    let v = await say(s, sid, { chip: 'jb:go' });
    const i = v.view.draft.steps.findIndex((x) => x.buttons.length);
    const b = v.view.draft.steps[i].buttons[0];
    const c0 = aiCalls();
    let r = await edit(s, sid, { message: i + 1, button: b.id, label: '🎁 Open my gift', url: 'gift.example.com/b' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.view.draft.steps[i].buttons.map((x) => [x.label, x.url]), [['🎁 Open my gift', 'https://gift.example.com/b']]);
    assert.match(r.body.turns.pop().text, /Updated the button “🎁 Open my gift” ✓/);
    for (const [body, rx] of [[{ label: '<b onmouseover="x">' }, /code in it/], [{ url: 'javascript:alert(1)' }, /isn't a web page/], [{ label: 'x'.repeat(41) }, /too long/], [{ url: 'not a link' }, /look like a link/]]) {
      const bad = await edit(s, sid, { message: i + 1, button: b.id, ...body });
      assert.equal(bad.status, 400, JSON.stringify(body)); assert.match(bad.body.error, rx);
    }
    assert.equal((await edit(s, sid, { message: i + 1, button: 'nope', label: 'Hi' })).status, 400);
    r = await edit(s, sid, { start: true, label: '🎁 Tap Start for my gift' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.view.draft.start_label, '🎁 Tap Start for my gift');
    assert.equal((await edit(s, sid, { start: true, label: '<script>' })).status, 400);
    // A choice button has no link.
    v = await say(s, sid, { chip: 'jb:edit' });
    await say(s, sid, { chip: 'nx:button' }); await say(s, sid, { chip: 'bk:reply' }); v = await say(s, sid, { chip: 'bl:✅ Yes please' });
    const rb = v.view.draft.steps.flatMap((x, k) => x.buttons.map((y) => [k, y])).find(([, y]) => y.kind === 'reply');
    const nl = await edit(s, sid, { message: rb[0] + 1, button: rb[1].id, url: 'https://example.com' });
    assert.equal(nl.status, 400); assert.match(nl.body.error, /choice button has no link/);
    assert.equal(aiCalls(), c0);
    // Undo, twice: back to the original button.
    await s.c.post(`/api/cas-builder/sessions/${sid}/undo`, {});
    const u = await s.c.post(`/api/cas-builder/sessions/${sid}/undo`, {});
    assert.equal(u.body.view.draft.start_label, '👆 Tap Start');
    const u2 = await s.c.post(`/api/cas-builder/sessions/${sid}/undo`, {});
    assert.equal(u2.body.view.draft.steps[i].buttons[0].label, b.label);
  });

  it('quick actions: Add emoji needs no AI, Shorter asks the writer once and the chat carries on', async () => {
    const s = await setup('growth');
    const sid = await toNext(s);
    const c0 = aiCalls();
    let r = await tweak(s, sid, { message: 1, how: 'emoji' });
    assert.equal(r.status, 200, r.text);
    assert.equal(aiCalls(), c0);
    assert.match(r.body.turns.pop().text, /Added an emoji/);
    assert.equal(r.body.view.stage, 'next');
    scriptModel({ write: 'Hi {name} 👋 Short one.' });
    r = await tweak(s, sid, { message: 1, how: 'shorter' });
    assert.equal(r.status, 200, r.text);
    assert.equal(aiCalls(), c0 + 1);
    const call = app.fakes.ai.calls[app.fakes.ai.calls.length - 1];
    assert.match(JSON.stringify(call.messages), /Where buttons are/, 'the writer is told where the buttons are');
    assert.equal(r.body.view.draft.steps[0].body, 'Hi {name} 👋 Short one.');
    assert.equal(r.body.view.stage, 'next', 'back where we were');
    assert.match(r.body.turns.pop().text, /shorter/);
    assert.equal((await tweak(s, sid, { message: 1, how: 'delete_everything' })).status, 400);
    assert.equal((await tweak(s, sid, { message: 7, how: 'shorter' })).status, 400);
    const u = await s.c.post(`/api/cas-builder/sessions/${sid}/undo`, {});
    assert.notEqual(u.body.view.draft.steps[0].body, 'Hi {name} 👋 Short one.');
    // The system prompt tells the model where buttons sit.
    assert.match(call.system_blocks[0].text, /buttons sit right UNDER that message/);
  });
});

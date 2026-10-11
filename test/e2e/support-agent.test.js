'use strict';
/*
 * The support agent that "sees everything": account visibility tools scoped to the customer's own workspace, the
 * automatic diagnosis (one test per problem), link cards checked against a whitelist (tool, [[link:KEY]] markers,
 * typed URLs, tampered rows), confirm-before-action enforced in code, the Zedapex brands (and refusing made-up ones),
 * referral facts (5 to 15%), human style, and that every guide id / deep link the agent can send really exists.
 * The AI is the fake Anthropic API (helpers/fakes.js): ai.script plays tool calls and answers.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp } = require('../helpers/app');

const ROOT = path.join(__dirname, '..', '..');
let app, sai, tools, links, ai;
before(async () => {
  app = await startApp();
  sai = app.require('services/support-ai');
  tools = app.require('services/support-tools');
  links = app.require('services/support-links');
  ai = app.fakes.ai;
  await app.setSetting('support_ai', { typing_min_ms: 0, typing_max_ms: 0, debounce_ms: 0 });
});
after(async () => { if (app) await app.stop(); });
beforeEach(() => { app.rl._reset(); ai.script = null; app.fakes.tg.chatMember = null; app.fakes.tg.webhookInfo = null; });

let seq = 0, chatSeq = -1008800000;
async function customer(plan = 'growth', name = 'Ada Obi') {
  const c = await app.loginByEmail(`agent-${++seq}@example.com`, { name, country: 'NG' });
  const ws = await app.ws(c);
  if (plan) await setPlan(ws.id, plan);
  return { c, ws, scope: { userId: c.user.id, workspaceId: ws.id, role: 'owner', threadId: null, log: false } };
}
async function setPlan(wsId, code) {
  await app.db.query("update workspaces set plan_code = $2, plan_status = 'active', trial_ends_at = null, period_end = case when $2 = 'free' then null else now() + interval '20 days' end where id = $1", [wsId, code]);
  app.settings.bust();
}
async function channel(ws, title = 'Signals VIP') {
  const chat = --chatSeq;
  const id = (await app.db.one("insert into connections(workspace_id, kind, tg_chat_id, title, member_count) values ($1,'channel',$2,$3,120) returning id", [ws.id, chat, title])).id;
  return { id: Number(id), chat };
}
async function welcomeBot(ws, bot, ch, { active = true, name = 'VIP welcome', ageHours = 0 } = {}) {
  const q = await app.db.one(`insert into sequences(workspace_id, connection_id, name, trigger_type, trigger_value, active, created_at, updated_at)
    values ($1,$2,$3,'join_request',$4,$5, now() - make_interval(hours => $6), now() - make_interval(hours => $6)) returning id`, [ws.id, bot.connId, name, String(ch.chat), active, ageHours]);
  await app.db.query("insert into sequence_steps(sequence_id, position, body) values ($1, 0, 'Hi {name} 👋')", [q.id]);
  return Number(q.id);
}
async function chatBot(ws, bot, { code = 'gift', active = true, name = 'Free gift', check = null, isDefault = false } = {}) {
  const q = await app.db.one(`insert into sequences(workspace_id, connection_id, name, trigger_type, trigger_value, active, is_default, bot_type)
    values ($1,$2,$3,'bot_start',$4,$5,$6,$7) returning id`, [ws.id, bot.connId, name, code, active, isDefault, check ? 'join_check' : 'lead_magnet']);
  if (check) await app.db.query("insert into sequence_steps(sequence_id, position, body, step_type, config) values ($1, 0, 'Join first 👇', 'check_join', $2)", [q.id, JSON.stringify({ chat_id: check })]);
  else await app.db.query("insert into sequence_steps(sequence_id, position, body) values ($1, 0, 'Here is your gift')", [q.id]);
  return Number(q.id);
}
const run = async (name, input, scope) => (await tools.run(name, input, scope)).output;
const codes = (d) => d.problems.map((p) => p.problem);
async function say(c, text) {
  const r = await c.post('/api/support', { body: text });
  assert.equal(r.status, 200, r.text);
  await sai.tick();
  return r.body.thread_id;
}
const lastReq = () => ai.calls[ai.calls.length - 1];

describe('account visibility: every tool sees only the chatting customer\'s workspace', () => {
  let A, B, botA, botB, chA, chB, wA, cbB;
  before(async () => {
    A = await customer('growth', 'Amaka A'); B = await customer('growth', 'Bayo B');
    botA = await app.connectBot(A.c, 'agent_a_bot'); botB = await app.connectBot(B.c, 'agent_b_bot');
    chA = await channel(A.ws, 'A Signals'); chB = await channel(B.ws, 'B Secret Room');
    wA = await welcomeBot(A.ws, botA, chA);
    cbB = await chatBot(B.ws, botB, { code: 'bsecret', name: 'B secret bot' });
  });

  it('get_bots / check_bot_setup / toggle_bot / share_link refuse the other workspace\'s ids', async () => {
    const mine = await run('get_bots', {}, A.scope);
    assert.deepEqual(mine.bots.map((b) => b.id), [wA]);
    assert.equal(mine.bots[0].kind, 'Welcome bot');
    assert.equal(mine.bots[0].channel, 'A Signals');
    assert.ok(!JSON.stringify(mine).includes('B secret'));
    assert.equal((await run('get_bots', { bot_id: cbB }, A.scope)).found, false);
    assert.equal((await run('check_bot_setup', { bot_id: cbB }, A.scope)).found, false);
    assert.equal((await run('toggle_bot', { bot_id: cbB, on: false }, { ...A.scope, threadId: 1 })).found, false);
    const sl = await run('share_link', { key: 'bot:' + cbB }, A.scope);
    assert.equal(sl.ok, false);
    assert.equal((await app.db.one('select active from sequences where id = $1', [cbB])).active, true, 'B\'s bot untouched');
  });

  it('a real chat: the model asks with B\'s ids, nothing about B reaches it', async () => {
    ai.script = [{ tools: [{ name: 'get_bots', input: { bot_id: cbB } }, { name: 'diagnose_account', input: {} }, { name: 'get_security', input: {} }, { name: 'get_cas_builder', input: {} }, { name: 'share_link', input: { key: 'bot_stats:' + cbB } }] }, { text: 'All checked.' }];
    const id = await say(A.c, 'check everything please');
    const log = await app.db.many('select tool, workspace_id, output from support_ai_tool_log where thread_id = $1 order by id', [id]);
    assert.ok(log.every((l) => Number(l.workspace_id) === Number(A.ws.id)));
    const sent = JSON.stringify(lastReq().messages);
    for (const bad of ['agent_b_bot', 'B secret', 'B Secret Room', 'Bayo', botB.token]) assert.ok(!sent.includes(bad), 'leaked ' + bad);
    assert.ok(!sent.includes(botA.token), 'never a token');
  });

  it('get_connections shows names, usernames, members and status; never tokens', async () => {
    const out = await run('get_connections', {}, A.scope);
    const bot = out.connections.find((x) => x.kind === 'bot');
    const ch = out.connections.find((x) => x.kind === 'channel');
    assert.equal(bot.username, '@agent_a_bot');
    assert.equal(ch.title, 'A Signals');
    assert.equal(ch.members, 120);
    assert.ok(!JSON.stringify(out).includes(botA.token));
  });

  it('get_usage has live bots vs limit, lead answers, Cas builds and devices per person', async () => {
    const u = await run('get_usage', {}, A.scope);
    assert.equal(u.bots.live_now, 1);
    assert.equal(u.bots.live_limit, 15);
    assert.ok(u.bots.bot_types_on_plan.includes('referral'));
    assert.equal(u.lead_answers_this_month.limit, 10000);
    assert.equal(u.cas_builder_builds.included, 50);
    assert.equal(u.devices_per_person, 2);
  });

  it('get_security counts only this person\'s devices; get_account shows the setup helper state', async () => {
    const s = await run('get_security', {}, A.scope);
    assert.ok(s.devices_logged_in >= 1);
    assert.ok(!JSON.stringify(s).match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/), 'no IP addresses');
    const acc = await run('get_account', {}, A.scope);
    assert.equal(acc.setup_helper.has_one, false);
    assert.equal(acc.you_are_role, 'Owner');
  });

  it('get_cas_builder: builds left and sessions of this workspace only', async () => {
    await app.db.query("insert into cas_sessions(workspace_id, user_id, kind, status, counted_at, paid_by) values ($1,$2,'new','saved',now(),'plan')", [B.ws.id, B.c.user.id]);
    const a = await run('get_cas_builder', {}, A.scope);
    assert.equal(a.sessions.length, 0);
    assert.equal(a.builds.used, 0);
    const b = await run('get_cas_builder', {}, B.scope);
    assert.equal(b.builds.used, 1);
    assert.equal(b.sessions.length, 1);
  });
});

describe('diagnosis: each common problem is found with a plain fix', () => {
  it('Welcome bot: own bot not an admin with "Add members"', async () => {
    const X = await customer();
    const bot = await app.connectBot(X.c, 'diag_wb_bot');
    const ch = await channel(X.ws, 'Diag Channel');
    await welcomeBot(X.ws, bot, ch);
    app.fakes.tg.chatMember = { status: 'member' };
    const d = await run('diagnose_account', {}, X.scope);
    const p = d.problems.find((x) => x.problem === 'welcome_bot_not_admin');
    assert.ok(p, JSON.stringify(codes(d)));
    assert.match(p.what, /@diag_wb_bot is not an admin of "Diag Channel"/);
    assert.match(p.what, /Add members/);
    assert.equal(p.severity, 'high');
    assert.match(p.link, /^bot:\d+$/);
  });

  it('Chat bot join check: bot not an admin of the checked channel', async () => {
    const X = await customer();
    const bot = await app.connectBot(X.c, 'diag_cj_bot');
    const ch = await channel(X.ws, 'Check Room');
    const id = await chatBot(X.ws, bot, { code: 'join', check: ch.id });
    app.fakes.tg.chatMember = { status: 'left' };
    const d = await run('diagnose_account', {}, X.scope);
    const p = d.problems.find((x) => x.problem === 'check_bot_not_admin');
    assert.ok(p, JSON.stringify(codes(d)));
    assert.match(p.what, /needs to be an admin of "Check Room"/);
    // check_bot_setup says the same for that bot, and passes once fixed (re-check after the customer fixed it).
    const c1 = await run('check_bot_setup', { bot_id: id }, X.scope);
    assert.equal(c1.ok, false);
    app.fakes.tg.chatMember = null;
    app.rl._reset();
    const c2 = await run('check_bot_setup', { bot_id: id }, X.scope);
    assert.equal(c2.ok, true, JSON.stringify(c2));
    assert.ok(c2.fine.some((f) => /can check who joined "Check Room"/.test(f)));
  });

  it('join requests not enabled on the invite link (live a day, no requests)', async () => {
    const X = await customer();
    const bot = await app.connectBot(X.c, 'diag_jr_bot');
    const ch = await channel(X.ws, 'Quiet Channel');
    await welcomeBot(X.ws, bot, ch, { ageHours: 30 });
    const d = await run('diagnose_account', {}, X.scope);
    const p = d.problems.find((x) => x.problem === 'no_join_requests');
    assert.ok(p, JSON.stringify(codes(d)));
    assert.match(p.fix, /Approve new members/);
  });

  it('webhook taken by another program, and a token that stopped working', async () => {
    const X = await customer();
    const bot = await app.connectBot(X.c, 'diag_wh_bot');
    app.fakes.tg.webhookInfo = { url: 'https://some-other-tool.example/hook', pending_update_count: 3 };
    let d = await run('diagnose_account', {}, X.scope);
    let p = d.problems.find((x) => x.problem === 'webhook_taken');
    assert.ok(p, JSON.stringify(codes(d)));
    assert.match(p.what, /another program/);
    assert.match(p.fix, /repair_webhook/);
    app.fakes.tg.webhookInfo = null;
    app.fakes.tg.markInvalid(bot.token);
    app.rl._reset();
    d = await run('diagnose_account', {}, X.scope);
    p = d.problems.find((x) => x.problem === 'token_invalid');
    assert.ok(p, JSON.stringify(codes(d)));
    assert.match(p.fix, /@BotFather/);
  });

  it('plan limit hit (live bots), paused by plan, and the Free plan branding line', async () => {
    const X = await customer('free');
    const bot = await app.connectBot(X.c, 'diag_free_bot');
    const ch = await channel(X.ws, 'Free Channel');
    await welcomeBot(X.ws, bot, ch);
    await chatBot(X.ws, bot, { code: 'gift' });
    await chatBot(X.ws, bot, { code: 'menu', active: false, name: 'Old menu' });
    await app.db.query("update sequences set paused_by_plan = true where workspace_id = $1 and name = 'Old menu'", [X.ws.id]);
    const d = await run('diagnose_account', {}, X.scope);
    for (const c of ['bot_limit', 'paused_by_plan', 'free_branding']) assert.ok(codes(d).includes(c), c + ' in ' + JSON.stringify(codes(d)));
    assert.match(d.problems.find((x) => x.problem === 'bot_limit').what, /2 of 2 live bots/);
    assert.match(d.problems.find((x) => x.problem === 'free_branding').what, /Free welcome bot by Castvoo\.com/);
    assert.equal(d.problems.find((x) => x.problem === 'bot_limit').link, 'plans');
  });

  it('broadcasts: many people blocked the bot, and a failed broadcast', async () => {
    const X = await customer();
    const bot = await app.connectBot(X.c, 'diag_bc_bot');
    const b = await app.db.one("insert into broadcasts(workspace_id, connection_id, title, body, status, total, sent, failed) values ($1,$2,'Big promo','Hi','sent',100,70,30) returning id", [X.ws.id, bot.connId]);
    await app.db.query("insert into broadcasts(workspace_id, connection_id, title, body, status) values ($1,$2,'Night promo','Hi','failed')", [X.ws.id, bot.connId]);
    await app.db.query(`insert into deliveries(workspace_id, sender_key, broadcast_id, chat_id, status, error)
      select $1, 'bot:' || $2, $3, 5000 + g, case when g <= 30 then 'blocked' else 'sent' end, case when g <= 30 then 'Forbidden: bot was blocked by the user' end from generate_series(1, 100) g`, [X.ws.id, bot.connId, b.id]);
    const d = await run('diagnose_account', {}, X.scope);
    const p = d.problems.find((x) => x.problem === 'many_blocked');
    assert.ok(p, JSON.stringify(codes(d)));
    assert.match(p.what, /30 of 100/);
    assert.match(p.fix, /Most messages one person gets per day/);
    assert.ok(codes(d).includes('broadcast_failed'));
    const bc = await run('get_broadcasts', {}, X.scope);
    assert.ok(bc.broadcasts.find((x) => x.title === 'Big promo').top_errors.some((e) => /= they blocked the bot/.test(e)), 'failure reasons in plain words');
  });

  it('payments: pending automatic, waiting manual and failed (status only)', async () => {
    const X = await customer();
    await app.db.query(`insert into payments(workspace_id, user_id, provider, method_key, reference, amount_cents, currency, status, created_at) values
      ($1,$2,'flutterwave','flw_ng','cv_diagpend1',2500,'USD','pending', now() - interval '30 minutes'),
      ($1,$2,'manual_crypto','usdt','cv_diagman1',5037,'USD','pending', now()),
      ($1,$2,'flutterwave','flw_ng','cv_diagfail1',1000,'USD','failed', now())`, [X.ws.id, X.c.user.id]);
    await app.db.query("update payments set reason = 'Card declined' where reference = 'cv_diagfail1'");
    const d = await run('diagnose_account', {}, X.scope);
    for (const c of ['payment_pending', 'manual_payment_pending', 'payment_failed']) assert.ok(codes(d).includes(c), c);
    assert.match(d.problems.find((x) => x.problem === 'payment_pending').fix, /credited only if they confirm/);
    assert.match(d.problems.find((x) => x.problem === 'payment_failed').what, /Card declined/);
  });

  it('start code clash, unverified email and a paused plan', async () => {
    const X = await customer();
    const bot = await app.connectBot(X.c, 'diag_clash_bot');
    await chatBot(X.ws, bot, { code: 'promo', name: 'Live promo' });
    await chatBot(X.ws, bot, { code: 'PROMO', name: 'Draft promo', active: false });
    await app.db.query('update users set email_verified = false where id = $1', [X.c.user.id]);
    await app.db.query("update workspaces set plan_status = 'paused' where id = $1", [X.ws.id]);
    const d = await run('diagnose_account', {}, X.scope);
    const clash = d.problems.find((x) => x.problem === 'start_code_clash');
    assert.ok(clash, JSON.stringify(codes(d)));
    assert.match(clash.what, /Draft "Draft promo" uses the same start link \(PROMO\) as live bot "Live promo"/);
    assert.ok(codes(d).includes('email_not_verified'));
    const cs = d.problems.find((x) => x.problem === 'cannot_send');
    assert.ok(cs && cs.severity === 'high');
    assert.equal(d.problems[0].severity, 'high', 'most serious first');
  });

  it('a healthy workspace: nothing serious', async () => {
    const X = await customer();
    await app.connectBot(X.c, 'diag_ok_bot');
    const d = await run('diagnose_account', {}, X.scope);
    assert.equal(d.all_good, true, JSON.stringify(d.problems));
    assert.equal(d.checked_with_telegram, true);
  });
});

describe('link cards: only whitelisted places', () => {
  let X, bot, wid;
  before(async () => {
    X = await customer();
    bot = await app.connectBot(X.c, 'links_bot');
    wid = await chatBot(X.ws, bot, { code: 'leads', name: 'Lead form' });
  });

  it('share_link builds cards for keys and exact URLs, and refuses everything else', async () => {
    const ok = async (input) => { const r = await run('share_link', input, X.scope); assert.equal(r.ok, true, JSON.stringify([input, r])); return r.card; };
    assert.deepEqual(await ok({ key: 'topup' }), { key: 'topup', kind: 'app', label: 'Top up your wallet', sub: 'Opens the top-up window', href: '#app/wallet?topup=1' });
    assert.equal((await ok({ key: 'plans' })).href, '#app/wallet?plans=1');
    assert.equal((await ok({ key: 'team' })).href, '#app/settings?tab=team');
    assert.equal((await ok({ key: 'bot_leads:' + wid })).href, `#app/flows?id=${wid}&tab=leads`);
    assert.equal((await ok({ url: `#app/flows?id=${wid}` })).key, 'bot:' + wid);
    const g = await ok({ key: 'guide:connect-bot' });
    assert.deepEqual([g.kind, g.guide, g.href], ['guide', 'connect-bot', '#app/guides']);
    const a = await ok({ key: 'article:zedapex-brands' });
    assert.equal(a.kind, 'article');
    assert.match(a.text, /VooSquare/);
    assert.equal((await ok({ key: 'legal:refunds' })).href, '/legal/refunds');
    assert.equal((await ok({ key: 'site:joinvoo' })).href, 'https://joinvoo.com');
    assert.equal((await ok({ url: 'https://affiliate.voosquare.com' })).key, 'site:voosquare_affiliate');
    assert.equal((await ok({ url: 'https://castvoo.com/legal/privacy' })).key, 'legal:privacy');
    for (const bad of [{ url: 'https://evil.com' }, { url: 'https://joinvoo.com.evil.com/' }, { url: 'http://joinvoo.com/' }, { url: 'https://joinvoo.com/login?next=x' },
      { url: 'https://user:pw@joinvoo.com/' }, { url: 'javascript:alert(1)' }, { url: '#app/wallet?evil=1' }, { key: 'site:ebookvoo' }, { key: 'guide:no-such-guide' },
      { key: 'article:no-such-article' }, { key: 'blog:no-such-post' }, { key: 'legal:secret' }, { key: 'bot:999999' }, { key: '<script>' }, {}]) {
      const r = await run('share_link', bad, X.scope);
      assert.equal(r.ok, false, 'should refuse ' + JSON.stringify(bad));
    }
    assert.equal((await run('share_link', { key: 'bot_requests:' + wid }, X.scope)).ok, false, 'Join requests is a Welcome bot tab');
  });

  it('cards reach the chat under the last bubble; markers are checked; typed phishing URLs are removed', async () => {
    ai.script = [
      { tools: [{ name: 'share_link', input: { key: 'topup' } }, { name: 'share_link', input: { url: 'https://evil.example/pay' } }, { name: 'share_link', input: { key: 'guide:wallet-plans' } }] },
      { text: 'Hi Ada! You can top up right from your wallet.\n\nTap the card below 👇 or pay at https://evil.example/pay now.\n[[link:plans]]\n[[link:site:totally-fake]]' },
    ];
    const id = await say(X.c, 'how do I add money?');
    const v = (await X.c.get('/api/support')).body;
    const mine = v.messages.filter((m) => m.author_type === 'ai');
    const last = mine[mine.length - 1];
    assert.deepEqual(last.links.map((l) => l.key), ['topup', 'guide:wallet-plans', 'plans']);
    assert.ok(mine.slice(0, -1).every((m) => !m.links.length), 'cards only on the last bubble');
    assert.ok(!mine.some((m) => /evil\.example|\[\[link/.test(m.body)), 'no raw phishing URL or marker reaches the customer');
    assert.ok(mine.some((m) => /\(link removed\)/.test(m.body)));
    // A card tampered with in the database is not shown (checked again on the way out).
    await app.db.query(`update support_messages set links = $2 where id = $1`, [last.id, JSON.stringify([{ key: 'x', kind: 'external', label: 'Claim bonus', href: 'https://evil.example' }, { key: 'y', kind: 'app', label: 'ok', href: 'javascript:alert(1)' }, last.links[0]])]);
    const again = (await X.c.get('/api/support')).body.messages.find((m) => m.id === last.id);
    assert.deepEqual(again.links.map((l) => l.key), ['topup']);
    // The admin sees the cards too.
    const staff = await app.staff('support');
    const view = await staff.get('/api/admin/support/' + id);
    assert.ok(view.body.messages.some((m) => Array.isArray(m.links) || (m.links && m.links.length)));
  });

  it('website chat (logged out): markers become cards; bot links and unknown keys are dropped', async () => {
    ai.script = [{ text: 'Replyvoo is our AI that answers Telegram chats for you.\n\n[[link:site:replyvoo]]\n[[link:bot:' + wid + ']]\n[[link:site:evil]]' }];
    const r = await app.client().post('/api/public/chat', { message: 'do you have AI auto replies?' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.links.map((l) => l.key), ['site:replyvoo']);
    assert.ok(!r.body.bubbles.join(' ').includes('[[link'));
    assert.match(lastReq().system, /\[\[link:KEY\]\]/);
  });

  it('the widget and the Help page render cards safely', () => {
    const w = fs.readFileSync(path.join(ROOT, 'public/js/widget.js'), 'utf8');
    assert.match(w, /function supLinkCards/);
    assert.match(w, /rel="noopener noreferrer"/);
    assert.match(w, /openVideoGuide\(id\)/);
    assert.match(fs.readFileSync(path.join(ROOT, 'public/js/app-account.js'), 'utf8'), /supLinkCards\(m\.links/);
    assert.match(fs.readFileSync(path.join(ROOT, 'public/css/castvoo.css'), 'utf8'), /\.slk-c\{/);
  });
});

describe('confirm before action (enforced in code)', () => {
  let X, bot, id;
  before(async () => {
    X = await customer();
    bot = await app.connectBot(X.c, 'confirm_bot');
    id = await chatBot(X.ws, bot, { code: 'vip', name: 'VIP bot', active: false });
  });
  const active = async () => (await app.db.one('select active from sequences where id = $1', [id])).active;

  it('toggle_bot only asks first; "no" or a second call in the same turn does nothing; "yes" switches it on', async () => {
    ai.script = [{ tools: [{ name: 'toggle_bot', input: { bot_id: id, on: true } }, { name: 'toggle_bot', input: { bot_id: id, on: true } }] }, { text: 'I can switch "VIP bot" on for you. Shall I do that?' }];
    const tid = await say(X.c, 'my VIP bot is off, can you turn it on');
    let log = await app.db.many("select output from support_ai_tool_log where thread_id = $1 and tool = 'toggle_bot' order by id", [tid]);
    assert.ok(log.every((l) => l.output.needs_confirmation === true));
    assert.match(log[0].output.ask, /Switch ON the bot "VIP bot"/);
    assert.equal(await active(), false);

    ai.script = [{ tools: [{ name: 'toggle_bot', input: { bot_id: id, on: true } }] }, { text: 'No problem, I left it off.' }];
    await say(X.c, 'no wait, not yet');
    assert.equal(await active(), false, '"no wait" is not a yes');

    // A yes for something else (switching OFF) does not run the switch ON.
    ai.script = [{ tools: [{ name: 'toggle_bot', input: { bot_id: id, on: false } }] }, { text: 'It is already off.' }];
    await say(X.c, 'yes');
    assert.equal(await active(), false);

    ai.script = [{ tools: [{ name: 'toggle_bot', input: { bot_id: id, on: true } }] }, { text: 'Done ✅ "VIP bot" is live.' }];
    await say(X.c, 'ok go ahead');
    assert.equal(await active(), true);
    log = await app.db.many("select output from support_ai_tool_log where thread_id = $1 and tool = 'toggle_bot' order by id desc limit 1", [tid]);
    assert.equal(log[0].output.done, true);
    assert.equal(log[0].output.confirmed_by_customer, true);
    // The confirmation is used once: another "yes" later does not switch anything again.
    const n = await app.db.one("select count(*)::int n from support_ai_actions where thread_id = $1 and used_at is not null", [tid]);
    assert.equal(n.n, 1);
  });

  it('resend_email_verification and repair_webhook ask first too; drafters can never toggle', async () => {
    const Y = await customer();
    const yb = await app.connectBot(Y.c, 'confirm_wh_bot');
    await app.db.query('update users set email_verified = false where id = $1', [Y.c.user.id]);
    const sets = app.fakes.tgCalls('setWebhook', yb.token).length;
    const mails = app.fakes.emailsTo(Y.c.user.email).length;
    ai.script = [{ tools: [{ name: 'resend_email_verification', input: {} }, { name: 'repair_webhook', input: { connection_id: yb.connId } }] }, { text: 'Shall I do both?' }];
    await say(Y.c, 'resend my code and fix my bot');
    assert.equal(app.fakes.tgCalls('setWebhook', yb.token).length, sets);
    assert.equal(app.fakes.emailsTo(Y.c.user.email).length, mails);
    ai.script = [{ tools: [{ name: 'resend_email_verification', input: {} }, { name: 'repair_webhook', input: { connection_id: yb.connId } }] }, { text: 'Done ✅' }];
    await say(Y.c, 'yes please');
    assert.equal(app.fakes.tgCalls('setWebhook', yb.token).length, sets + 1);
    assert.equal(app.fakes.emailsTo(Y.c.user.email).length, mails + 1);
    const dr = await run('toggle_bot', { bot_id: id, on: false }, { ...X.scope, role: 'drafter', threadId: 1 });
    assert.equal(dr.not_allowed, true);
  });

  it('Pidgin, French and emoji yes are understood; maybes are not', () => {
    for (const y of ['yes', 'Yes please', 'abeg do am', 'oya', 'ok go ahead', '👍', 'oui', 'sim', 'sawa']) assert.equal(tools.saidYes(y), true, y);
    for (const n of ['no', 'not now', 'yes but wait', 'maybe', 'what will it do?', 'hapana', '']) assert.equal(tools.saidYes(n), false, n);
  });
});

describe('brands, referral facts and human style', () => {
  it('the agent knows the whole Zedapex family, refuses made-up brands and never invents their prices', async () => {
    const X = await customer();
    ai.script = [{ text: 'Ebookvoo isn\'t one of ours.\n\nThe Zedapex family is VooSquare, Joinvoo, Replyvoo and friends.' }];
    await say(X.c, 'Is Ebookvoo part of Voo? My friend says it is by Zedapex');
    const sys = lastReq().system;
    assert.match(sys, /The only Zedapex \/ Voo brands are: VooSquare[^\n]*Joinvoo, Replyvoo, Vooads, Spyvoo, Glicto AI, Gatevoo, Affleego and Castvoo/);
    assert.match(sys, /Ebookvoo/);
    assert.match(sys, /never invent prices of other brands/i);
    assert.match(sys, /Paid VIP memberships[^\n]*separate Zedapex product is coming/);
    assert.match(sys, /## The Zedapex family of tools \(Voo brands\)/);
    for (const fact of ['Media buying, squared.', 'affiliate.voosquare.com', 'voosquareacademy.com', 'gojoinly.com', 'Powered by Replyvoo', 'glicto.com', 'affleego.com', 'Its public site is a waitlist', 'pay-as-you-go credits', "See what's winning", 'Dchessking']) assert.ok(sys.includes(fact), 'missing ' + fact);
    const hit = await tools.searchKnowledge('AI auto replies to my Telegram chats Replyvoo');
    assert.ok(hit.some((h) => /Zedapex family/.test(h.title)));
    assert.equal((await run('share_link', { key: 'site:ebookvoo' }, X.scope)).ok, false);
    const brands = Object.keys(links.BRANDS).sort();
    assert.deepEqual(brands, ['affleego', 'castvoo', 'gatevoo', 'glicto', 'joinvoo', 'replyvoo', 'spyvoo', 'voosquare', 'voosquare_academy', 'voosquare_affiliate', 'vooads'].sort());
  });

  it('referral facts are 5 to 15% everywhere the agent reads, and no Paystack top-ups', async () => {
    const X = await customer();
    ai.script = [{ tools: [{ name: 'get_referrals', input: {} }] }, { text: 'You earn 5% now.' }];
    await say(X.c, 'how much do I earn from referrals?');
    const req = lastReq();
    assert.match(req.system, /1 to 4 paying referrals: 5%/);
    assert.match(req.system, /5 to 19: 10%/);
    assert.match(req.system, /20 or more: 15%/);
    assert.doesNotMatch(req.system, /: 20%|: 30%|30% of|up to 30/);
    assert.match(JSON.stringify(req.messages), /rate_percent\\":5,/);
    for (const line of req.system.split('\n')) if (/paystack/i.test(line)) assert.match(line, /no longer|before|removed|old/i, line);
  });

  it('every knowledge article reaches the agent (none skipped for size)', async () => {
    const X = await customer();
    ai.script = [{ text: 'Hi!' }];
    await say(X.c, 'hello');
    const sys = lastReq().system;
    for (const k of require(path.join(ROOT, 'server/knowledge-defaults'))) assert.ok(sys.includes('## ' + k.title), 'missing article ' + k.key);
    assert.match(sys, /Bots \(🤖 Bots page\):\n- Free bots: 2 live bots/, 'bot limits in the live plan list');
  });

  it('writes like a person: WhatsApp-style rules, Pidgin understood, robotic phrases removed', async () => {
    const X = await customer('growth', 'Tunde Bello');
    ai.script = [{ text: 'Great question! As an AI, I can check that.\n\nI apologize for any inconvenience. Your bot is fine.' }];
    const id = await say(X.c, 'abeg my bot no dey reply, wetin happen?');
    const sys = lastReq().system;
    for (const rule of [/Nigerian Pidgin/, /Ask ONE question at a time/, /Shall I do that\?/, /Greet by first name/, /1 to 3 short lines/, /Done ✅/]) assert.match(sys, rule);
    assert.match(sys, /First name: "Tunde"/);
    const bodies = (await app.db.many("select body from support_messages where thread_id = $1 and author_type = 'ai' order by id", [id])).map((m) => m.body);
    assert.deepEqual(bodies, ['I can check that.', 'Sorry about that. Your bot is fine.']);
  });
});

describe('every guide id and deep link the agent can send exists', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const guideIds = () => [...read('public/js/app-guides.js').matchAll(/\{ id: '([a-z0-9-]+)', title:/g)].map((m) => m[1]);

  it('guide ids in the link catalogue and in the knowledge are real guides', () => {
    const real = new Set(guideIds());
    assert.ok(real.size >= 13);
    for (const g of Object.keys(links.GUIDES)) assert.ok(real.has(g), 'guide ' + g + ' is not in app-guides.js');
    for (const g of real) assert.ok(links.GUIDES[g], 'guide ' + g + ' cannot be sent by support yet');
    const kb = require(path.join(ROOT, 'server/knowledge-defaults'));
    const vg = kb.find((k) => k.key === 'video-guides').body;
    const named = [...vg.matchAll(/^\d+\. [^(\n]+\((?:guide id )?([a-z0-9-]+)[;)]/gm)].map((m) => m[1]);
    assert.equal(named.length, 13, JSON.stringify(named));
    for (const g of named) assert.ok(real.has(g), 'knowledge names guide ' + g);
    for (const m of kb.map((k) => k.body).join('\n').matchAll(/guide:([a-z0-9-]+)/g)) if (m[1] !== '<id>') assert.ok(real.has(m[1]), m[1]);
  });

  it('every dashboard link opens a real page, and its query is handled there', () => {
    const js = fs.readdirSync(path.join(ROOT, 'public/js')).filter((f) => f.endsWith('.js')).map((f) => read('public/js/' + f)).join('\n');
    const pages = new Set([...js.matchAll(/PAGES\.([a-z_]+)\s*=/g)].map((m) => m[1]));
    for (const [key, [, , href]] of Object.entries(links.APP)) {
      const m = href.match(/^#app(?:\/([a-z]+))?(?:\?([a-z]+)=)?/);
      const page = m[1] || 'overview';
      assert.ok(pages.has(page), `${key}: no page "${page}"`);
      if (m[2]) {
        const where = { flows: 'app-flows.js', wallet: 'app-money.js', settings: 'app-account.js' }[page];
        assert.ok(where && read('public/js/' + where).includes('q.' + m[2]), `${key}: ${where} does not read q.${m[2]}`);
      }
    }
    assert.match(read('public/js/app-flows.js'), /q\.tab/);
    // Dashboard links written in the knowledge also exist.
    const kb = require(path.join(ROOT, 'server/knowledge-defaults')).map((k) => k.body).join('\n');
    for (const m of kb.matchAll(/#app\/([a-z]+)/g)) assert.ok(pages.has(m[1]), 'knowledge links #app/' + m[1]);
    for (const m of kb.matchAll(/\barticle:([a-z0-9-]+)/g)) assert.ok(require(path.join(ROOT, 'server/knowledge-defaults')).some((k) => k.key === m[1]), 'article ' + m[1]);
  });

  it('legal pages and brand sites in the catalogue exist / are https', () => {
    for (const l of Object.keys(links.LEGAL)) assert.ok(fs.existsSync(path.join(ROOT, 'server/legal', l + '.html')), 'legal ' + l);
    for (const b of Object.values(links.BRANDS)) assert.match(b.url, /^https:\/\/[a-z.]+\.com$/);
  });
});

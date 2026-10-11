'use strict';
/*
 * Support, October 2026: handover only when the customer asks (no "Talk to a person" button), reliably, through the
 * widget's own endpoint (POST /api/support); and the website chat is the same fast support team as inside.
 *
 * The owner's iPhone: "Hello", then "I'd like to talk to a person from the team, please." got "Hello again! How can I
 * assist you?" and no handover. Cause: the second message arrived while the AI was still answering "Hello"; the
 * answer was saved after it, so the next turn found "nothing new" and the handover rule never ran.
 */

const fs = require('node:fs');
const path = require('node:path');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers/app');

let app, sai, ai, n = 0;
before(async () => {
  app = await startApp();
  sai = app.require('services/support-ai');
  ai = app.fakes.ai;
  await app.setSetting('support_ai', { typing_min_ms: 0, typing_max_ms: 0, debounce_ms: 0 });
});
after(async () => { if (app) await app.stop(); });
beforeEach(() => { app.rl._reset(); ai.script = null; ai.delayMs = 0; });

const T = (c) => app.db.one('select * from support_threads where user_id = $1 order by id desc limit 1', [c.user.id]);
const visible = async (c) => (await c.get('/api/support')).body;
const customer = (extra = {}) => app.loginByEmail(`handoff${++n}@example.com`, { name: 'Bola Ade', country: 'NG', ...extra });
const waitFor = async (fn, ms = 5000) => { const t0 = Date.now(); while (!(await fn())) { if (Date.now() - t0 > ms) throw new Error('timed out'); await app.sleep(20); } };

const ASKS = [
  'I’d like to talk to a person from the team, please.', // curly apostrophe, as an iPhone types it
  "I'd like to talk to a person",
  'talk to a person',
  'human',
  'Agent',
  'agent please',
  'Can I speak to an agent?',
  'I want a real person',
  'customer care',
  'Please connect me to someone from your team',
  'I wan talk to person',
  'Abeg I wan talk to una person',
  'abeg connect me to person',
  'I need a human being',
  "I don't want to talk to a bot",
  'Je voudrais parler à un humain',
  'Je veux parler à quelqu’un de votre équipe',
  'Quero falar com um atendente',
  'Posso falar com uma pessoa?',
  'Quiero hablar con una persona',
  'Necesito hablar con un agente',
];
const NOT_ASKS = ['hello', 'Hello', 'hi there', 'Good morning', 'Are your agents AI?', 'How do I connect my bot to the team channel?', 'My bot is not working', 'How do I pay?', 'Bonjour', 'Olá', 'Hola'];

describe('asking for a person, in their own words', () => {
  it('every phrasing hands the chat over at once through the widget endpoint, without the model', async () => {
    for (const text of ASKS) {
      const c = await customer();
      const calls = ai.calls.length;
      const r = await c.post('/api/support', { body: text });
      assert.equal(r.status, 200, r.text);
      // Handed over in the same request: no AI turn needed (and none can race with it).
      const t = await T(c);
      assert.deepEqual([t.needs_human, t.ai_paused, t.handoff_reason, t.queue], [true, true, 'asked_for_human', 'support'], text);
      await sai.tick();
      assert.equal(ai.calls.length, calls, `no model call for: ${text}`);
      const v = await visible(c);
      assert.equal(v.thread.with_human, true, text);
      const last = v.messages[v.messages.length - 1];
      assert.equal(last.author_type, 'ai');
      assert.match(last.body, /(teammate|collègue|colega|compañero|team|équipe|equipa|equipo).*(reply|répondra|responder|responderá)|reply right here|vous répondra|vai responder|te responderá/i, text);
      const note = await app.db.one("select body from support_messages where thread_id = $1 and internal order by id desc limit 1", [t.id]);
      assert.match(note.body, /Customer asked for a person/);
      assert.ok(note.body.includes(text.slice(0, 20)), 'the summary quotes the customer');
      assert.ok(t.ai_summary && t.ai_summary.length > 10);
    }
  });

  it('the customer is told honestly when a teammate will reply', async () => {
    const c = await customer();
    await c.post('/api/support', { body: 'I’d like to talk to a person from the team, please.' });
    const v = await visible(c);
    assert.match(v.messages[v.messages.length - 1].body, /I've passed this to a teammate\. Someone from the team will reply right here within .+, and you'll get an email too\./);
  });

  it('"hello" and ordinary questions never hand over', async () => {
    assert.ok(NOT_ASKS.every((t) => !sai.wantsHuman(t)), NOT_ASKS.filter((t) => sai.wantsHuman(t)).join(' | '));
    assert.ok(ASKS.every((t) => sai.wantsHuman(t)));
    const c = await customer();
    ai.script = [{ text: 'Hi Bola! How can I help?' }];
    await c.post('/api/support', { body: 'Hello' });
    await sai.tick();
    const t = await T(c);
    assert.equal(t.needs_human, false);
    assert.equal(t.ai_paused, false);
    const v = await visible(c);
    assert.equal(v.messages[v.messages.length - 1].body, 'Hi Bola! How can I help?');
  });

  it('the iPhone case: "Hello", then asking for a person while the AI is still answering → handed over, no "Hello again"', async () => {
    const c = await customer();
    ai.delayMs = 400;
    ai.script = [{ text: 'Hello again! How can I assist you?' }];
    await c.post('/api/support', { body: 'Hello' });
    const calls = ai.calls.length;
    const turn = sai.tick();
    await waitFor(() => ai.calls.length > calls); // the model is "thinking" about "Hello"
    const r = await c.post('/api/support', { body: 'I’d like to talk to a person from the team, please.' });
    assert.equal(r.status, 200);
    await turn;
    await sai.tick();
    const t = await T(c);
    assert.deepEqual([t.needs_human, t.ai_paused, t.handoff_reason], [true, true, 'asked_for_human']);
    const v = await visible(c);
    assert.ok(!v.messages.some((m) => /Hello again/.test(m.body)), 'the stale answer to "Hello" is not sent after the request');
    assert.match(v.messages[v.messages.length - 1].body, /teammate/);
    assert.equal(v.thread.with_human, true);
  });

  it('a message sent while the AI is thinking gets its own answer (root cause: "nothing new")', async () => {
    const c = await customer();
    ai.delayMs = 300;
    ai.script = [{ text: 'Hi! What can I do for you?' }, { text: 'Open Channels & bots and tap Add a channel.' }];
    await c.post('/api/support', { body: 'Hello' });
    const calls = ai.calls.length;
    const turn = sai.tick();
    await waitFor(() => ai.calls.length > calls);
    await c.post('/api/support', { body: 'How do I connect a channel?' });
    await turn;
    ai.delayMs = 0;
    await sai.tick();
    const msgs = (await visible(c)).messages.filter((m) => m.author_type === 'ai').map((m) => m.body);
    assert.deepEqual(msgs, ['Hi! What can I do for you?', 'Open Channels & bots and tap Add a channel.']);
    const t = await T(c);
    const lastUser = await app.db.one("select max(id)::bigint id from support_messages where thread_id = $1 and author_type = 'user'", [t.id]);
    assert.equal(String(t.ai_seen_msg_id), String(lastUser.id));
  });

  it('after "Hand back to AI", asking again hands over again; with a teammate already on it, it goes back in the queue', async () => {
    const c = await customer();
    const staff = await app.staff('support');
    await c.post('/api/support', { body: 'talk to a person' });
    const t = await T(c);
    assert.equal((await staff.post(`/api/admin/support/${t.id}/ai`, { action: 'handback' })).status, 200);
    assert.equal((await T(c)).needs_human, false);
    await c.post('/api/support', { body: 'customer care abeg' });
    assert.deepEqual([(await T(c)).needs_human, (await T(c)).ai_paused], [true, true]);
    // A teammate answers (the AI steps back; needs_human clears), then the customer asks for a person again.
    await staff.post(`/api/admin/support/${t.id}/reply`, { body: 'Hi, Ejiro here.' });
    assert.equal((await T(c)).needs_human, false);
    const aiBefore = (await app.db.one("select count(*)::int n from support_messages where thread_id = $1 and author_type = 'ai'", [t.id])).n;
    await c.post('/api/support', { body: 'Can I speak to your manager?' });
    const t2 = await T(c);
    assert.deepEqual([t2.needs_human, t2.ai_paused, t2.unread_staff], [true, true, true]);
    assert.equal((await app.db.one("select count(*)::int n from support_messages where thread_id = $1 and author_type = 'ai'", [t.id])).n, aiBefore, 'no AI bubble while a teammate is on it');
  });

  it('switched off in Admin → Support AI (escalation.human_request), the AI answers instead', async () => {
    const c = await customer();
    await app.setSetting('support_ai', { escalation: { human_request: false } });
    try {
      ai.script = [{ text: 'I can help with that here.' }];
      await c.post('/api/support', { body: 'talk to a person' });
      assert.equal((await T(c)).needs_human, false);
      await sai.tick();
      assert.equal((await T(c)).needs_human, false);
    } finally { await app.setSetting('support_ai', { escalation: { human_request: true } }); }
  });
});

describe('no "Talk to a person" button anywhere', () => {
  it('the widget and the Help page have no such button or canned message', () => {
    for (const f of ['public/js/widget.js', 'public/js/app-account.js', 'public/js/site.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
      assert.ok(!/data-person/.test(src), f);
      assert.ok(!/I'd like to talk to a person from the team/.test(src), f);
      assert.ok(!/'Talk to a person'|>Talk to a person</.test(src), f);
    }
  });

  it('the knowledge tells the agents there is no button: just ask', async () => {
    const k = await app.db.one("select body from knowledge where key = 'support'");
    assert.match(k.body, /in your own words/);
    assert.doesNotMatch(k.body, /"Talk to a person" in the chat/);
  });
});

describe('the website chat is the same support team, as fast', () => {
  it('the same 16 agents, sticky per browser, the same writing rules, knowledge and model, with typing delays', async () => {
    await app.setSetting('support_ai', { typing_min_ms: 1500, typing_max_ms: 6000, model: 'claude-test-model' });
    try {
      const cfg = (await app.client().get('/api/public/config')).body;
      assert.equal(cfg.site_chat.agents.length, 16);
      const pick = cfg.site_chat.agents[7];
      const v = app.client();
      await v.get('/');
      ai.script = [{ text: 'Castvoo greets everyone who asks to join.\n\nIt also sends broadcasts and follow-ups.' }];
      const t0 = Date.now();
      const r = await v.post('/api/public/chat', { message: 'What does Castvoo do?', persona_id: pick.id });
      assert.equal(r.status, 200, r.text);
      assert.ok(Date.now() - t0 < 2000, 'answers at once: no waiting for a cookie or a slow path');
      assert.equal(r.body.persona.id, pick.id, 'the agent the browser already talks to');
      assert.equal(r.body.persona.avatar, pick.avatar);
      assert.equal(r.body.bubbles.length, 2);
      assert.equal(r.body.delays.length, 2);
      assert.ok(r.body.delays.every((d) => d >= 1500 && d <= 6000), 'the same typing delays as inside');
      assert.equal(r.body.cta, null, 'no "Start free" for a plain question');
      const site = ai.calls[ai.calls.length - 1];
      assert.equal(site.model, 'claude-test-model', 'the same model');
      assert.ok(!site.tools, 'no account tools');
      assert.match(site.system, new RegExp(`You are ${pick.name},`));
      assert.match(site.system, /HOW YOU WRITE/);
      // Logged in, the same writing rules and knowledge budget.
      const c = await customer();
      ai.script = [{ text: 'Sure.' }];
      await c.post('/api/support', { body: 'What does Castvoo do?' });
      await sai.tick();
      const inside = ai.calls[ai.calls.length - 1];
      assert.equal(inside.model, 'claude-test-model');
      const rules = (s) => s.slice(s.indexOf('HOW YOU WRITE'), s.indexOf('HOW YOU WORK'));
      assert.equal(rules(site.system), rules(inside.system));
      const know = (s) => s.slice(s.indexOf('# Castvoo knowledge'), s.indexOf('# Current plans'));
      assert.equal(know(site.system), know(inside.system), 'the same knowledge');
      // Without a persona id, the visitor still gets one agent and keeps it.
      ai.script = () => ({ text: 'ok' });
      const a = await v.post('/api/public/chat', { message: 'q1' });
      const b = await v.post('/api/public/chat', { message: 'q2' });
      assert.equal(a.body.persona.id, b.body.persona.id);
    } finally { await app.setSetting('support_ai', { typing_min_ms: 0, typing_max_ms: 0, model: '' }); }
  });

  it('"Start free" when it helps (prices, plans, getting started)', async () => {
    ai.script = () => ({ text: 'Growth is $49 a month.' });
    const r = await app.client().post('/api/public/chat', { message: 'How much is the Growth plan?' });
    assert.deepEqual(r.body.cta, { label: 'Start free', href: '#signup' });
  });

  it('asking for a person on the website: an honest answer and the way to a teammate, no model call', async () => {
    const calls = ai.calls.length;
    const r = await app.client().post('/api/public/chat', { message: 'I’d like to talk to a person' });
    assert.equal(r.status, 200, r.text);
    assert.equal(ai.calls.length, calls);
    assert.equal(r.body.login, true);
    assert.match(r.body.bubbles.join(' '), /log in/i);
    assert.match(r.body.bubbles.join(' '), /support@/);
    assert.equal(r.body.delays.length, r.body.bubbles.length);
  });

  it('a normal visitor never waits for the budget gate; scripts without a page load still do', async () => {
    // Today's answers at 70% of the cap: past the open 60%, below the strict 90%.
    const today = (await app.db.one("select count(*)::int n from ai_usage where kind = 'site_chat' and created_at > date_trunc('day', now())")).n;
    const cap = Math.max(100, Math.ceil(today / 0.7) + 10);
    await app.db.query("insert into ai_usage(workspace_id, kind, writes) select 0, 'site_chat', 0 from generate_series(1, $1::int)", [Math.round(cap * 0.7) - today]);
    await app.setSetting('support_ai', { site_chat_daily_cap: cap, site_chat_soft_pct: 0.6, site_chat_strict_pct: 0.9, site_chat_known_after_s: 300 });
    try {
      ai.script = () => ({ text: 'Hi there.' });
      const visitor = app.client();
      await visitor.get('/'); // the page they are on sets the cookie
      const r = await visitor.post('/api/public/chat', { message: 'hi' });
      assert.equal(r.status, 200, 'a visitor who just arrived is answered at once: ' + r.text);
      assert.equal((await app.client().post('/api/public/chat', { message: 'hi' })).status, 503, 'an API script with no page load is not');
    } finally { await app.setSetting('support_ai', { site_chat_daily_cap: 500, site_chat_soft_pct: 0.6, site_chat_strict_pct: 0.9, site_chat_known_after_s: 300 }); }
  });

  it('logged in on the website, the public config tells the widget nothing private; its chat is the account thread', async () => {
    const c = await customer();
    // The widget logged in uses GET/POST /api/support, the same thread as Help, wherever it is opened.
    await c.post('/api/support', { body: 'Hello from the website' });
    const t = await T(c);
    assert.equal((await visible(c)).thread.id, t.id);
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public/js/site.js'), 'utf8');
    assert.match(src, /const useVoo = view === 'site' && !\(ME && ME\.user\)/, 'logged in: never the VooSquare widget');
  });
});

describe('the widget always loads the latest JS', () => {
  it('index.html points at fingerprinted widget, site and CSS files, cached forever by version', async () => {
    const home = await app.client().get('/');
    const m = /src="\/js\/widget\.js\?v=([0-9a-f]{10})"/.exec(home.text);
    assert.ok(m, 'widget.js has the asset fingerprint');
    assert.match(home.text, new RegExp(`/css/castvoo\\.css\\?v=${m[1]}"`));
    assert.match(home.text, new RegExp(`/js/site\\.js\\?v=${m[1]}"`));
    assert.equal(home.headers.get('cache-control'), 'no-cache', 'the page itself is always checked');
    const js = await fetch(`${app.url}/js/widget.js?v=${m[1]}`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('cache-control'), /immutable/);
    assert.ok(!(await js.text()).includes('data-person'));
  });
});

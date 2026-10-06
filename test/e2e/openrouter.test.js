'use strict';
/* Cas on OpenRouter (and OpenAI) next to the original Claude path, against a local mock (helpers/mock-openrouter.js).
   Provider selection, request shape, parsing, retries, missing keys, fallbacks, admin key handling and the AI allowance. */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startApp } = require('../helpers/app');
const { startMockAi } = require('../helpers/mock-openrouter');

const KEY = 'sk-or-v1-castvoo-env-key-1234';
let app, mock, c, ws, owner, config, llm;

before(async () => {
  mock = await startMockAi();
  app = await startApp({ env: { AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: mock.base + '/api/v1', OPENAI_BASE_URL: mock.base + '/v1', AI_RETRY_BASE_MS: '10' } });
  config = app.require('config');
  llm = app.require('services/llm');
  c = await app.loginByEmail('router@example.com');
  ws = await app.ws(c);
  owner = await app.owner();
});
after(async () => { if (app) await app.stop(); if (mock) await mock.close(); });
beforeEach(async () => {
  app.rl._reset(); mock.reset(); app.fakes.ai.failNext = 0;
  config.ai.provider = 'openrouter'; config.ai.openrouter.apiKey = KEY; config.ai.openrouter.fallbacks = ''; config.ai.openai.apiKey = '';
  await app.db.query("update settings set value = $1 where key = 'ai_provider'", [JSON.stringify({ provider: '', openrouter_model: '', fallback_models: '', key_enc: '', key_for: '' })]);
  await app.db.query('update workspaces set ai_used = 0 where id = $1', [ws.id]);
  app.require('services/settings').bust();
});

const used = async () => (await app.db.one('select ai_used from workspaces where id = $1', [ws.id])).ai_used;
const readConfig = (env) => execFileSync(process.execPath, ['-e', 'const c=require("./server/config");process.stdout.write(JSON.stringify({p:c.ai.provider,or:c.ai.openrouter.apiBase,oa:c.ai.openai.apiBase,m:c.ai.openrouter.model}))'],
  { cwd: path.join(__dirname, '..', '..'), env: { PATH: process.env.PATH, ...env } }).toString();

describe('Cas on OpenRouter', () => {
  it('AI_PROVIDER picks the provider; unset keeps Claude; the admin choice wins', async () => {
    assert.deepEqual(JSON.parse(readConfig({})), { p: 'anthropic', or: 'https://openrouter.ai/api/v1', oa: 'https://api.openai.com/v1', m: 'anthropic/claude-sonnet-4.5' });
    assert.equal(JSON.parse(readConfig({ AI_PROVIDER: 'OpenRouter' })).p, 'openrouter');
    assert.equal((await llm.resolve()).provider, 'openrouter');
    config.ai.provider = 'anthropic';
    assert.equal((await llm.resolve()).provider, 'anthropic');
    assert.equal((await owner.put('/api/admin/ai/provider', { provider: 'openrouter' })).status, 200);
    assert.equal((await llm.resolve()).provider, 'openrouter');
  });

  it('OPENROUTER_BASE_URL and OPENAI_BASE_URL are ignored in production', () => {
    const p = JSON.parse(readConfig({ NODE_ENV: 'production', OPENROUTER_BASE_URL: 'http://127.0.0.1:4971/api/v1', OPENAI_BASE_URL: 'http://evil.example/v1' }));
    assert.equal(p.or, 'https://openrouter.ai/api/v1');
    assert.equal(p.oa, 'https://api.openai.com/v1');
  });

  it('write: Bearer key, referer/title headers, model, system role with prompt caching, parsed answer, usage with cost', async () => {
    const r = await c.post('/api/ai/write', { goal: 'Announce the weekend sale', tone: 'fun' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.text, 'Hello from *OpenRouter* 👋', '**bold** becomes Telegram *bold*');
    const call = mock.last('openrouter');
    assert.equal(call.path, '/api/v1/chat/completions');
    assert.equal(call.headers.authorization, 'Bearer ' + KEY);
    assert.equal(call.headers['http-referer'], app.url);
    assert.equal(call.headers['x-title'], 'Castvoo');
    const b = call.body;
    assert.equal(b.model, 'anthropic/claude-sonnet-4.5');
    assert.equal(b.max_tokens, 900);
    assert.equal(b.temperature, 0.7);
    assert.equal(b.system, undefined, 'no Anthropic-style system field');
    assert.equal(b.models, undefined);
    assert.equal(b.response_format, undefined);
    assert.equal(b.messages[0].role, 'system');
    assert.match(b.messages[0].content[0].text, /You are Cas/);
    assert.deepEqual(b.messages[0].content[0].cache_control, { type: 'ephemeral' });
    assert.match(b.messages[0].content[1].text, /The user's business/);
    assert.equal(b.messages[1].role, 'user');
    assert.match(b.messages[1].content, /Announce the weekend sale/);
    assert.equal(b.messages.length, 2);
    assert.equal(await used(), 1);
    const u = await app.db.one("select * from ai_usage where workspace_id = $1 and kind = 'write' order by id desc limit 1", [ws.id]);
    assert.equal(u.provider, 'openrouter');
    assert.equal(u.model, 'anthropic/claude-sonnet-4.5');
    assert.equal(u.input_tokens, 50);
    assert.equal(u.output_tokens, 20);
    assert.equal(Number(u.cost_usd), 0.00042);
    assert.equal(app.fakes.ai.calls.length, 0, 'Claude was never called');
  });

  it('sequence (JSON array) and ask (history turns) work through OpenRouter', async () => {
    const r = await c.post('/api/ai/sequence', { goal: 'Welcome new traders', steps: 3 });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.steps.length, 3);
    assert.equal(r.body.steps[0].body, 'Hi {name}! *Welcome*');
    assert.equal(mock.last().body.max_tokens, 2500);
    const a = await c.post('/api/ai/ask', { question: 'How did my sends go?', history: [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }] });
    assert.equal(a.status, 200, a.text);
    assert.deepEqual(mock.last().body.messages.slice(1).map((m) => m.role), ['user', 'assistant', 'user']);
  });

  it('retries 429 and 5xx with backoff; gives up with a friendly error and gives the write back', async () => {
    mock.queue.push({ status: 429, headers: { 'retry-after': '0' } }, { status: 503 });
    const ok = await c.post('/api/ai/write', { goal: 'Works on the third try' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(mock.calls.length, 3);
    assert.equal(await used(), 1, 'one write, not three');

    mock.reset();
    mock.queue.push({ status: 429 }, { status: 429 }, { status: 429 });
    const busy = await c.post('/api/ai/write', { goal: 'Always busy' });
    assert.equal(busy.status, 503);
    assert.equal(busy.body.code, 'ai_busy');
    assert.equal(mock.calls.length, 1 + config.ai.retries);
    assert.equal(await used(), 1, 'the failed write was given back');

    mock.reset();
    mock.queue.push({ status: 400, body: { error: { code: 400, message: 'bad request' } } });
    const bad = await c.post('/api/ai/write', { goal: 'Bad request' });
    assert.equal(bad.status, 502);
    assert.equal(bad.body.code, 'ai_error');
    assert.equal(mock.calls.length, 1, '400 is never retried');

    mock.reset();
    mock.queue.push({ status: 200, body: { error: { code: 502, message: 'upstream died ' + KEY } } }, { status: 200, body: { error: { code: 502, message: 'x' } } }, { status: 200, body: { error: { code: 502, message: 'x' } } });
    const midErr = await c.post('/api/ai/write', { goal: 'Error inside a 200' });
    assert.equal(midErr.status, 502);
    assert.ok(!midErr.text.includes(KEY));
  });

  it('missing key: clear 503, nothing sent, write given back, Cas shows as unavailable', async () => {
    config.ai.openrouter.apiKey = '';
    const r = await c.post('/api/ai/write', { goal: 'No key' });
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'ai_not_configured');
    assert.match(r.body.error, /OPENROUTER_API_KEY is missing/);
    assert.equal(mock.calls.length, 0);
    assert.equal(await used(), 0);
    const pc = await app.client().get('/api/public/config');
    assert.equal(pc.body.ai_available, false);
    config.ai.openrouter.apiKey = KEY;
    app.require('services/settings').bust();
    assert.equal((await app.client().get('/api/public/config')).body.ai_available, true, 'back on once the key is there');
  });

  it('fallback models are passed through as "models", main model first', async () => {
    config.ai.openrouter.fallbacks = 'openai/gpt-4o-mini, anthropic/claude-sonnet-4.5';
    await c.post('/api/ai/write', { goal: 'With fallbacks' });
    assert.deepEqual(mock.last().body.models, ['anthropic/claude-sonnet-4.5', 'openai/gpt-4o-mini']);
    await owner.put('/api/admin/ai/provider', { openrouter_model: 'openai/gpt-4o-mini', fallback_models: 'anthropic/claude-sonnet-4.5' });
    await c.post('/api/ai/write', { goal: 'Admin fallbacks' });
    const b = mock.last().body;
    assert.equal(b.model, 'openai/gpt-4o-mini');
    assert.deepEqual(b.models, ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-4.5']);
  });

  it('the Claude path is unchanged: x-api-key, cached system blocks, one try, same usage', async () => {
    const r0 = await owner.put('/api/admin/ai/provider', { provider: 'anthropic' });
    assert.equal(r0.status, 200, r0.text);
    const r = await c.post('/api/ai/write', { goal: 'Back on Claude' });
    assert.equal(r.status, 200, r.text);
    const call = app.fakes.ai.calls[app.fakes.ai.calls.length - 1];
    assert.equal(call.model, 'claude-haiku-4-5-20251001');
    assert.ok(Array.isArray(call.system_blocks) && call.system_blocks[0].cache_control, 'system stays Anthropic blocks');
    assert.deepEqual(Object.keys(call).filter((k) => !['system_blocks'].includes(k)).sort(), ['max_tokens', 'messages', 'model', 'system', 'temperature']);
    assert.equal(mock.calls.length, 0, 'OpenRouter was never called');
    const u = await app.db.one("select * from ai_usage where workspace_id = $1 order by id desc limit 1", [ws.id]);
    assert.equal(u.provider, 'anthropic');
    assert.equal(u.input_tokens, 120);
    app.fakes.ai.failNext = 1;
    const before = app.fakes.ai.calls.length;
    const f = await c.post('/api/ai/write', { goal: 'Claude fails' });
    assert.equal(f.status, 502);
    assert.equal(f.body.code, 'ai_error');
    assert.equal(app.fakes.ai.calls.length, before + 1, 'no retries added to the Claude path');
  });

  it('plain OpenAI uses the same OpenAI-format path', async () => {
    config.ai.openai.apiKey = 'sk-openai-test';
    await owner.put('/api/admin/ai/provider', { provider: 'openai' });
    const r = await c.post('/api/ai/rewrite', { text: 'Make this clearer please', how: 'clearer' });
    assert.equal(r.status, 200, r.text);
    const call = mock.last();
    assert.equal(call.kind, 'openai');
    assert.equal(call.body.model, 'gpt-4o-mini');
    assert.equal(typeof call.body.messages[0].content, 'string', 'OpenAI gets the system prompt as one string');
    assert.equal(call.headers['http-referer'], undefined);
  });

  it('admin: key saved encrypted, never returned, audited without the key, re-entered when the endpoint changes', async () => {
    const SAVED = 'sk-or-v1-admin-saved-key-9876';
    const r = await owner.put('/api/admin/ai/provider', { provider: 'openrouter', openrouter_model: 'openai/gpt-4o-mini', key: SAVED });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.ai.key_source, 'admin');
    assert.equal(r.body.ai.key_hint, '…9876');
    for (const p of ['/api/admin/ai/provider', '/api/admin/settings', '/api/admin/overview', '/api/admin/audit']) {
      const g = await owner.get(p);
      assert.equal(g.status, 200, p);
      assert.ok(!g.text.includes(SAVED) && !g.text.includes('key_enc'), p + ' must not show the key');
    }
    const viewer = await app.staff('viewer');
    const vg = await viewer.get('/api/admin/ai/provider');
    assert.equal(vg.status, 200);
    assert.ok(!vg.text.includes(SAVED));
    assert.equal((await viewer.put('/api/admin/ai/provider', { provider: 'openai' })).status, 403);
    assert.equal((await (await app.staff('support')).put('/api/admin/ai/provider', { key: 'sk-x' })).status, 403);

    await c.post('/api/ai/write', { goal: 'Uses the saved key' });
    assert.equal(mock.last().headers.authorization, 'Bearer ' + SAVED, 'the saved key wins over the env key');
    assert.equal(mock.last().body.model, 'openai/gpt-4o-mini');
    const a = await app.db.one("select data from audit_log where action = 'settings.ai_provider' order by id desc limit 1");
    const d = typeof a.data === 'string' ? a.data : JSON.stringify(a.data);
    assert.ok(!d.includes(SAVED) && !d.includes('v1.'));
    assert.match(d, /saved for openrouter/);

    // Another OpenRouter address (env change) never receives the saved key.
    const real = config.ai.openrouter.apiBase;
    config.ai.openrouter.apiBase = 'http://127.0.0.1:1/api/v1';
    assert.equal((await llm.resolve()).key, KEY);
    config.ai.openrouter.apiBase = real;

    const sw = await owner.put('/api/admin/ai/provider', { provider: 'openai' });
    assert.equal(sw.body.key_cleared, true);
    assert.equal(sw.body.ai.has_key, false);
    assert.match(JSON.stringify((await app.db.one("select data from audit_log where action = 'settings.ai_provider' order by id desc limit 1")).data), /cleared/);
    for (const bad of [{ provider: 'skynet' }, { openrouter_model: 'not a model' }, { fallback_models: 'a/b,c/d,e/f,g/h,i/j,k/l' }, { key: 'has spaces in it' }]) {
      assert.equal((await owner.put('/api/admin/ai/provider', bad)).status, 400, JSON.stringify(bad));
    }
  });

  it('the AI allowance still applies on OpenRouter', async () => {
    await app.db.query('update workspaces set ai_used = 99 where id = $1', [ws.id]);
    const last = await c.post('/api/ai/write', { goal: 'The last one' });
    assert.equal(last.status, 200, last.text);
    assert.equal(last.body.ai_writes_left, 0);
    const over = await c.post('/api/ai/write', { goal: 'One too many' });
    assert.equal(over.status, 402);
    assert.equal(over.body.code, 'ai_limit');
    assert.equal(mock.calls.length, 1, 'the refused write never reached OpenRouter');
  });
});

'use strict';
// A local stand-in for OpenRouter (and OpenAI / Anthropic), so tests never call a real API:
//   POST /api/v1/chat/completions   OpenRouter (OpenAI format)
//   POST /v1/chat/completions       OpenAI
//   POST /v1/messages               Anthropic
// Every request is recorded ({ kind, path, headers, body }). Program failures with mock.queue.push({ status, body, headers }).
// It listens on the first free port in 4971–4979 (MOCK_AI_PORTS can change the range).
const http = require('node:http');

function defaultText(body) {
  const last = JSON.stringify((body.messages || []).slice(-1));
  if (/follow-up sequence/.test(last)) return 'Here you go:\n[{"delay_value":0,"delay_unit":"min","body":"Hi {name}! **Welcome**"},{"delay_value":1,"delay_unit":"day","body":"Day two"},{"delay_value":3,"delay_unit":"day","body":"Day three"}]';
  return 'Hello from **OpenRouter** 👋';
}

async function startMockAi() {
  const calls = [];
  const queue = [];
  // mock.script: (body, kind) => { text } | { tools: [{ name, input }], text? } | null; scripts tool calls in either format.
  const mock = { calls, queue, text: null, script: null, usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70, cost: 0.00042 }, base: '' };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = {}; }
      const p = req.url.split('?')[0];
      const kind = p === '/api/v1/chat/completions' ? 'openrouter' : p === '/v1/chat/completions' ? 'openai' : p === '/v1/messages' ? 'anthropic' : 'unknown';
      calls.push({ kind, path: p, headers: req.headers, body });
      const send = (status, obj, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
      if (kind === 'unknown' || req.method !== 'POST') return send(404, { error: { code: 404, message: 'Not found' } });
      if (queue.length) { const q = queue.shift(); return send(q.status, q.body || { error: { code: q.status, message: 'Mock error ' + q.status } }, q.headers); }
      const scripted = typeof mock.script === 'function' ? mock.script(body, kind) : null;
      if (scripted && (scripted.tools || []).length) {
        if (kind === 'anthropic') return send(200, { id: 'msg_mock', type: 'message', model: body.model, stop_reason: 'tool_use', content: [...(scripted.text ? [{ type: 'text', text: scripted.text }] : []), ...scripted.tools.map((t, i) => ({ type: 'tool_use', id: 'toolu_' + calls.length + '_' + i, name: t.name, input: t.input || {} }))], usage: { input_tokens: 120, output_tokens: 40 } });
        const used = Array.isArray(body.models) && body.models.length ? body.models[0] : body.model;
        return send(200, { id: 'gen-mock', object: 'chat.completion', model: used, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: scripted.text || null, tool_calls: scripted.tools.map((t, i) => ({ id: 'call_' + calls.length + '_' + i, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input || {}) } })) } }], usage: mock.usage });
      }
      const text = scripted && scripted.text != null ? scripted.text : typeof mock.text === 'function' ? mock.text(body, kind) : mock.text != null ? mock.text : defaultText(body);
      if (kind === 'anthropic') {
        if (!req.headers['x-api-key']) return send(401, { error: { message: 'no key' } });
        return send(200, { id: 'msg_mock', type: 'message', model: body.model, content: [{ type: 'text', text }], usage: { input_tokens: 120, output_tokens: 40 } });
      }
      if (!/^Bearer \S+/.test(String(req.headers.authorization || ''))) return send(401, { error: { code: 401, message: 'No auth credentials found' } });
      const used = Array.isArray(body.models) && body.models.length ? body.models[0] : body.model;
      return send(200, { id: 'gen-mock', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: used, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }], usage: mock.usage });
    });
  });
  const [lo, hi] = String(process.env.MOCK_AI_PORTS || '4971-4979').split('-').map(Number);
  let port = 0;
  for (let p = lo; p <= hi && !port; p++) {
    port = await new Promise(resolve => { server.once('error', () => resolve(0)); server.listen(p, '127.0.0.1', () => resolve(p)); });
  }
  if (!port) throw new Error('No free mock AI port in ' + lo + '–' + hi);
  mock.base = 'http://127.0.0.1:' + port;
  mock.last = kind => [...calls].reverse().find(c => !kind || c.kind === kind);
  mock.reset = () => { calls.length = 0; queue.length = 0; mock.text = null; mock.script = null; };
  mock.close = () => new Promise(r => { server.close(() => r()); server.closeAllConnections(); });
  return mock;
}

module.exports = { startMockAi };

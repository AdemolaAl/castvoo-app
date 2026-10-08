'use strict';
/*
 * The one door Cas uses to reach an AI model: complete({ system, messages, maxTokens, temperature, json, tools }).
 * It routes to the provider picked in Admin → Cas AI, or AI_PROVIDER (default anthropic = Claude direct):
 *   anthropic   POST {ANTHROPIC_API_BASE}/v1/messages                 the original path, unchanged
 *   openrouter  POST https://openrouter.ai/api/v1/chat/completions     OpenAI format, one key, many models, fallbacks
 *   openai      POST https://api.openai.com/v1/chat/completions
 * Answers come back as { text, toolCalls, usage: { input_tokens, output_tokens, cost_usd, provider, model } } so callers can
 * log them in ai_usage as before. Keys and prompts are never logged.
 *
 * Tool calling (the support agent and Cas's read-only workspace tools) works the same on all three providers.
 * Callers use ONE neutral format and this file translates it:
 *   tools:    [{ name, description, parameters: <JSON schema object> }]
 *   messages: { role: 'user' | 'assistant', content: 'text' }
 *             { role: 'user', content: [{ type: 'text', text }, { type: 'image', mime: 'image/png', data: '<base64>' }] }
 *                (images: Claude gets base64 image blocks, OpenRouter / OpenAI get image_url data URLs)
 *             { role: 'assistant', content: 'text or empty', tool_calls: [{ id, name, input: {...} }] }
 *             { role: 'tool', tool_call_id, name, content: 'result text (JSON)' }
 *   answer:   { text, toolCalls: [{ id, name, input }] }   toolCalls is [] when the model just answered.
 * Requests without tools are byte-for-byte what they were before.
 */

const config = require('../config');
const settings = require('./settings');
const log = require('../lib/log');
const { httpError, badRequest, encrypt, decrypt } = require('../lib/util');

const FIXED = { openrouter: 'https://openrouter.ai/api/v1', openai: 'https://api.openai.com/v1' };
const PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude)', envKey: 'ANTHROPIC_API_KEY', base: () => config.ai.apiBase, key: () => config.ai.apiKey },
  openrouter: { label: 'OpenRouter', envKey: 'OPENROUTER_API_KEY', base: () => config.ai.openrouter.apiBase, key: () => config.ai.openrouter.apiKey },
  openai: { label: 'OpenAI', envKey: 'OPENAI_API_KEY', base: () => config.ai.openai.apiBase, key: () => config.ai.openai.apiKey },
};
// OpenRouter model ids look like "anthropic/claude-sonnet-4.5", "openai/gpt-4o-mini" or "~anthropic/claude-sonnet-latest".
const MODEL_RE = /^~?[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;
const EMPTY = { provider: '', openrouter_model: '', fallback_models: '', key_enc: '', key_for: '' };

const csv = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const origin = (u) => { try { return new URL(u).origin; } catch { return ''; } };
const bindingFor = (provider) => `${provider} ${origin(PROVIDERS[provider].base())}`;
const envProvider = () => (PROVIDERS[config.ai.provider] ? config.ai.provider : 'anthropic');

/** Provider, models and key from a settings value (sync, so config.integrations() can use it). */
function resolveFrom(s, model) {
  s = { ...EMPTY, ...(s || {}) };
  const provider = PROVIDERS[s.provider] ? s.provider : envProvider();
  const p = PROVIDERS[provider];
  let saved = '';
  // A key saved in the admin is only ever sent to the endpoint it was saved for.
  if (s.key_enc && s.key_for === bindingFor(provider)) { try { saved = decrypt(s.key_enc); } catch { saved = ''; } }
  const key = saved || p.key() || '';
  const m = provider === 'openrouter' ? (s.openrouter_model || config.ai.openrouter.model) : provider === 'openai' ? config.ai.openai.model : model;
  const fallbacks = provider === 'openrouter' ? csv(s.fallback_models || config.ai.openrouter.fallbacks).filter((x) => x !== m) : [];
  return { provider, label: p.label, envKey: p.envKey, base: p.base(), key, keySource: saved ? 'admin' : key ? 'env' : '', model: m, fallbacks };
}
async function resolve() {
  const [s, ai] = await Promise.all([settings.get('ai_provider'), settings.get('ai')]);
  return resolveFrom(s, ai.model);
}
// config.integrations().ai now also sees a provider and key saved in the admin (from the last loaded settings).
config.aiReady = () => { const s = settings.peek(); return !!resolveFrom(s ? s.ai_provider : null).key; };

/** What the admin may see: never the key, only where it comes from and its last 4 characters. */
async function publicInfo() {
  const s = { ...EMPTY, ...((await settings.get('ai_provider')) || {}) };
  const r = await resolve();
  return {
    provider: r.provider, label: r.label, provider_from: PROVIDERS[s.provider] ? 'admin' : 'env', env_provider: envProvider(),
    model: r.model, fallbacks: r.fallbacks, openrouter_model: s.openrouter_model, fallback_models: s.fallback_models,
    default_openrouter_model: config.ai.openrouter.model, default_fallbacks: config.ai.openrouter.fallbacks,
    has_key: !!r.key, key_source: r.keySource, key_hint: r.key ? '…' + r.key.slice(-4) : '', key_env: r.envKey,
    saved_key_other_endpoint: !!s.key_enc && s.key_for !== bindingFor(r.provider),
    endpoint: origin(r.base), test_endpoint: r.provider !== 'anthropic' && origin(r.base) !== origin(FIXED[r.provider]),
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, env_key: !!p.key() })),
  };
}

/** Validates an admin change. Returns { value, changed, key } where key says what happened to the key (for the audit log). */
async function validate(b) {
  const cur = { ...EMPTY, ...((await settings.get('ai_provider')) || {}) };
  const next = { ...cur };
  const changed = [];
  if (b.provider !== undefined) {
    const v = String(b.provider || '').trim().toLowerCase();
    if (v && !PROVIDERS[v]) throw badRequest('Pick Anthropic, OpenRouter or OpenAI.');
    if (v !== cur.provider) changed.push('provider');
    next.provider = v;
  }
  if (b.openrouter_model !== undefined) {
    const v = String(b.openrouter_model || '').trim();
    if (v && (v.length > 100 || !MODEL_RE.test(v))) throw badRequest('Use an OpenRouter model id like anthropic/claude-sonnet-4.5 (copy it from openrouter.ai/models).');
    if (v !== cur.openrouter_model) changed.push('openrouter_model');
    next.openrouter_model = v;
  }
  if (b.fallback_models !== undefined) {
    const list = csv(b.fallback_models);
    if (list.length > 5) throw badRequest('Add at most 5 fallback models.');
    const bad = list.find((m) => m.length > 100 || !MODEL_RE.test(m));
    if (bad) throw badRequest(`“${bad.slice(0, 60)}” is not an OpenRouter model id.`);
    if (list.join(',') !== cur.fallback_models) changed.push('fallback_models');
    next.fallback_models = list.join(',');
  }
  const provider = PROVIDERS[next.provider] ? next.provider : envProvider();
  const key = b.key !== undefined ? String(b.key || '').trim() : '';
  let keyNote = '';
  if (key) {
    if (key.length > 300 || /\s/.test(key)) throw badRequest('That key doesn’t look right. Paste it again.');
    next.key_enc = encrypt(key); next.key_for = bindingFor(provider); keyNote = 'saved for ' + provider;
  } else if (b.clear_key) {
    next.key_enc = ''; next.key_for = ''; keyNote = cur.key_enc ? 'removed' : '';
  } else if (cur.key_enc && cur.key_for !== bindingFor(provider)) {
    // The endpoint changed: the saved key is dropped and has to be pasted again for the new one.
    next.key_enc = ''; next.key_for = ''; keyNote = 'cleared (endpoint changed)';
  }
  return { value: next, changed, key: keyNote };
}

/* ---------- message formats ---------- */
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && typeof b.text === 'string').map((b) => b.text).join('\n\n') : String(c ?? ''));
const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const isImage = (b) => b && b.type === 'image' && IMAGE_MIME.includes(b.mime) && typeof b.data === 'string' && b.data.length > 0;
const hasImages = (c) => Array.isArray(c) && c.some(isImage);
/** A user turn with images, in the OpenAI / OpenRouter format (text parts and image_url data URLs). */
const chatParts = (c) => c.filter((b) => isImage(b) || (b && typeof b.text === 'string')).map((b) => (isImage(b)
  ? { type: 'image_url', image_url: { url: `data:${b.mime};base64,${b.data}` } }
  : { type: 'text', text: b.text }));
/** The same in Claude's format (base64 image blocks). */
const anthropicParts = (c) => c.filter((b) => isImage(b) || (b && typeof b.text === 'string')).map((b) => (isImage(b)
  ? { type: 'image', source: { type: 'base64', media_type: b.mime, data: b.data } }
  : { type: 'text', text: b.text }));

/** o-series and GPT-5 model ids (also "openai/o3-mini" style ids). */
const isReasoningModel = (m) => /^(openai\/)?(o\d|gpt-5)/i.test(String(m || ''));
/** OpenAI / OpenRouter body: the system prompt becomes the first message with role "system". */
function chatBody({ system, messages, maxTokens, temperature, json, tools }, model, provider, fallbacks) {
  const msgs = [];
  if (Array.isArray(system) ? system.length : String(system || '').trim()) {
    // OpenRouter keeps Anthropic-style cache_control on text parts (prompt caching); plain OpenAI gets one string.
    if (Array.isArray(system) && provider === 'openrouter') msgs.push({ role: 'system', content: system.map((b) => ({ type: 'text', text: String(b.text || ''), ...(b.cache_control ? { cache_control: b.cache_control } : {}) })) });
    else msgs.push({ role: 'system', content: textOf(system) });
  }
  for (const m of messages || []) {
    if (m.role === 'tool') { msgs.push({ role: 'tool', tool_call_id: String(m.tool_call_id), content: textOf(m.content) }); continue; }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      msgs.push({ role: 'assistant', content: textOf(m.content) || null, tool_calls: m.tool_calls.map((t) => ({ id: String(t.id), type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input || {}) } })) });
      continue;
    }
    if (m.role !== 'assistant' && hasImages(m.content)) { msgs.push({ role: 'user', content: chatParts(m.content) }); continue; }
    msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: textOf(m.content) });
  }
  // OpenAI's reasoning models (o1, o3, o4-mini, gpt-5...) refuse max_tokens and any non-default temperature (ENG-13).
  // max_completion_tokens works for every current OpenAI chat model, so plain OpenAI always gets it.
  const reasoning = provider === 'openai' && isReasoningModel(model);
  const body = provider === 'openai' ? { model, messages: msgs, max_completion_tokens: maxTokens } : { model, messages: msgs, max_tokens: maxTokens };
  if (Array.isArray(tools) && tools.length) body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } } }));
  if (temperature !== undefined && temperature !== null && !reasoning) body.temperature = temperature;
  if (json) body.response_format = { type: 'json_object' };
  if (provider === 'openrouter' && fallbacks.length) body.models = [model, ...fallbacks];
  return body;
}

/* ---------- transport ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY = new Set([408, 429, 500, 502, 503, 504, 529]);
const redact = (s, key) => { let t = String(s || '').slice(0, 200); if (key) t = t.split(key).join('[key]'); return t.replace(/sk-[a-z0-9_-]{8,}/gi, '[key]'); };

/** The fixed host for keys in production; a test address is only accepted outside production. */
function checkBase(provider, base) {
  let u;
  try { u = new URL(base); } catch { throw httpError(500, 'The AI address is not valid.', 'ai_error'); }
  const fixed = new URL(FIXED[provider]);
  if (u.username || u.password) throw httpError(500, 'The AI address is not valid.', 'ai_error');
  if (config.isProd && (u.protocol !== 'https:' || u.host !== fixed.host)) throw httpError(500, `AI calls may only go to ${fixed.host}.`, 'ai_error');
  return base;
}

/** Parse OpenAI-style tool calls; arguments arrive as a JSON string (or broken JSON from weaker models). */
function parseChatToolCalls(list) {
  return (Array.isArray(list) ? list : []).filter((t) => t && t.function && t.function.name).map((t, i) => {
    let input = {};
    const a = t.function.arguments;
    if (a && typeof a === 'object') input = a;
    else { try { input = JSON.parse(a || '{}') || {}; } catch { input = {}; } }
    if (typeof input !== 'object' || Array.isArray(input)) input = {};
    return { id: String(t.id || 'call_' + i), name: String(t.function.name), input };
  });
}

async function chatComplete(r, { system, messages, maxTokens, temperature, json, tools }) {
  const url = checkBase(r.provider, r.base) + '/chat/completions';
  const headers = { Authorization: 'Bearer ' + r.key, 'Content-Type': 'application/json' };
  if (r.provider === 'openrouter') { headers['HTTP-Referer'] = config.appUrl; headers['X-Title'] = 'Castvoo'; headers['X-OpenRouter-Title'] = 'Castvoo'; }
  const body = JSON.stringify(chatBody({ system, messages, maxTokens, temperature, json, tools }, r.model, r.provider, r.fallbacks));
  for (let attempt = 0; ; attempt++) {
    let res, j, netErr;
    try {
      res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(config.ai.timeoutMs) });
      j = await res.json().catch(() => ({}));
    } catch (e) { netErr = e; }
    // OpenRouter can answer 200 with { error } when a model fails after the request was accepted.
    const bodyErr = !netErr && j && j.error && !(j.choices && j.choices.length) ? j.error : null;
    if (!netErr && res.ok && !bodyErr) {
      const msg = ((j.choices || [])[0] || {}).message || {};
      const u = j.usage || {};
      return { text: textOf(msg.content).trim(), toolCalls: parseChatToolCalls(msg.tool_calls), usage: { input_tokens: Number(u.prompt_tokens) || 0, output_tokens: Number(u.completion_tokens) || 0, cost_usd: Number(u.cost) || 0, provider: r.provider, model: j.model || r.model } };
    }
    const code = netErr ? 0 : bodyErr ? Number(bodyErr.code) || 502 : res.status;
    const retryable = !!netErr || RETRY.has(code);
    if (retryable && attempt < config.ai.retries) {
      const ra = !netErr && Number(res.headers.get('retry-after'));
      await sleep(ra > 0 ? Math.min(ra * 1000, 10000) : backoff(attempt));
      continue;
    }
    if (netErr) { log.warn('AI request failed', { provider: r.provider, err: netErr.name === 'TimeoutError' ? 'timeout' : netErr.message, attempts: attempt + 1 }); throw httpError(502, 'Cas could not be reached. Please try again.', 'ai_down'); }
    // The provider's own error text stays in our logs (without keys); customers get a plain message.
    log.warn('AI provider error', { provider: r.provider, status: code, err: redact((bodyErr || j.error || {}).message, r.key), attempts: attempt + 1 });
    if (code === 429 || code === 529) throw httpError(503, 'Cas is very busy right now. Please try again in a minute.', 'ai_busy');
    throw httpError(502, 'Cas had a problem answering. Please try again.', 'ai_error');
  }
}

/** Neutral messages → Anthropic: tool calls become tool_use blocks, tool results a user turn of tool_result blocks. */
function anthropicMessages(messages) {
  const out = [];
  const lastUser = () => { const l = out[out.length - 1]; return l && l.role === 'user' && Array.isArray(l.content) ? l : null; };
  for (const m of messages || []) {
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: String(m.tool_call_id), content: textOf(m.content) };
      const u = lastUser();
      if (u) u.content.push(block); else out.push({ role: 'user', content: [block] });
      continue;
    }
    if (m.role === 'assistant') {
      const content = [];
      const t = textOf(m.content).trim();
      if (t) content.push({ type: 'text', text: t });
      for (const tc of m.tool_calls || []) content.push({ type: 'tool_use', id: String(tc.id), name: tc.name, input: tc.input || {} });
      out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '…' }] });
      continue;
    }
    const u = lastUser();
    if (hasImages(m.content)) {
      if (u) u.content.push(...anthropicParts(m.content)); else out.push({ role: 'user', content: anthropicParts(m.content) });
      continue;
    }
    if (u) u.content.push({ type: 'text', text: textOf(m.content) });
    else out.push({ role: 'user', content: typeof m.content === 'string' ? m.content : textOf(m.content) });
  }
  return out;
}
const hasToolParts = (messages) => (messages || []).some((m) => m.role === 'tool' || (Array.isArray(m.tool_calls) && m.tool_calls.length) || hasImages(m.content));

/**
 * Claude direct: the request Castvoo always sent (separate system blocks, prompt caching), now with the same
 * retries as the other providers (ENG-12): 408, 429, 500, 502, 503, 504 and 529 (overloaded) and network errors are
 * retried up to AI_RETRIES times, honouring retry-after (seconds) and Anthropic's ratelimit reset headers, with
 * backoff; each try is limited by AI_TIMEOUT_MS. A busy minute no longer hands a support chat to a person.
 */
async function anthropicComplete(r, { system, messages, maxTokens, temperature, tools }, ai) {
  const body = { model: ai.model, max_tokens: maxTokens || ai.max_output_tokens || 900, temperature: temperature ?? ai.temperature ?? 0.7, system, messages };
  const withTools = Array.isArray(tools) && tools.length;
  if (withTools || hasToolParts(messages)) body.messages = anthropicMessages(messages);
  if (withTools) body.tools = tools.map((t) => ({ name: t.name, description: t.description || '', input_schema: t.parameters || { type: 'object', properties: {} } }));
  const payload = JSON.stringify(body);
  for (let attempt = 0; ; attempt++) {
    let res, j, netErr;
    try {
      res = await fetch(r.base + '/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': r.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(config.ai.timeoutMs),
      });
      j = await res.json().catch(() => ({}));
    } catch (e) { netErr = e; }
    if (!netErr && res.ok) {
      const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      const toolCalls = (j.content || []).filter((b) => b.type === 'tool_use' && b.name).map((b) => ({ id: String(b.id), name: String(b.name), input: b.input && typeof b.input === 'object' && !Array.isArray(b.input) ? b.input : {} }));
      return { text, toolCalls, usage: { ...(j.usage || {}), provider: 'anthropic', model: j.model || ai.model } };
    }
    const code = netErr ? 0 : res.status;
    if ((netErr || RETRY.has(code)) && attempt < config.ai.retries) {
      await sleep(netErr ? backoff(attempt) : waitFor(res.headers, attempt));
      continue;
    }
    if (netErr) { log.warn('AI request failed', { provider: 'anthropic', err: netErr.name === 'TimeoutError' ? 'timeout' : netErr.message, attempts: attempt + 1 }); throw httpError(502, 'Cas could not be reached. Please try again.', 'ai_down'); }
    log.warn('AI provider error', { provider: 'anthropic', status: code, err: redact((j.error && j.error.message) || '', r.key), attempts: attempt + 1 });
    if (code === 429 || code === 529) throw httpError(503, 'Cas is very busy right now. Please try again in a minute.', 'ai_busy');
    throw httpError(502, 'Cas had a problem answering. Please try again.', 'ai_error');
  }
}
const backoff = (attempt) => config.ai.retryBaseMs * 2 ** attempt + Math.floor(Math.random() * 100);
/** How long to wait before retrying: retry-after (seconds), else Anthropic's ratelimit reset time, else backoff. At most 10 s. */
function waitFor(h, attempt) {
  const ra = Number(h.get('retry-after'));
  if (ra > 0) return Math.min(ra * 1000, 10000);
  const reset = ['anthropic-ratelimit-requests-reset', 'anthropic-ratelimit-tokens-reset', 'anthropic-ratelimit-input-tokens-reset'].map((k) => Date.parse(h.get(k) || '')).filter((t) => t > Date.now());
  if (reset.length) return Math.min(Math.min(...reset) - Date.now(), 10000);
  return backoff(attempt);
}

/**
 * model (optional): a different model for this call on the same provider (Admin → Support AI → Model).
 * On OpenRouter it is an OpenRouter id; on Claude direct a Claude model name; on OpenAI an OpenAI model name.
 */
async function complete({ system, messages, maxTokens, temperature, json = false, tools, model }) {
  const ai = await settings.get('ai');
  const r = resolveFrom(await settings.get('ai_provider'), ai.model);
  if (!r.key) throw httpError(503, `Cas is not switched on yet on this server (${r.envKey} is missing).`, 'ai_not_configured');
  const m = model && typeof model === 'string' && model.length <= 100 && /^~?[a-z0-9][a-z0-9._:/-]*$/i.test(model) ? model : null;
  if (r.provider === 'anthropic') return anthropicComplete(r, { system, messages, maxTokens, temperature, tools }, m ? { ...ai, model: m } : ai);
  return chatComplete({ ...r, ...(m ? { model: m } : {}) }, { system, messages, maxTokens: maxTokens || ai.max_output_tokens || 900, temperature: temperature ?? ai.temperature ?? 0.7, json, tools });
}

module.exports = { complete, resolve, resolveFrom, publicInfo, validate, chatBody, anthropicMessages, parseChatToolCalls, hasImages, isReasoningModel, PROVIDERS, MODEL_RE };

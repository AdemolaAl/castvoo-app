'use strict';
/*
 * One local HTTP server that pretends to be every outside service Castvoo talks to:
 *   Telegram Bot API   /bot<token>/<method>
 *   Resend             POST /emails
 *   Anthropic          POST /v1/messages
 *   Paystack           /transaction/initialize, /transaction/verify/:ref, /balance
 *   Flutterwave        /v3/payments, /v3/transactions/:id/verify, /v3/transactions/verify_by_reference, /v3/balances
 *   Gatevoo            /api/v1/invoices (POST, GET /:id), /healthz
 *   Google-like OIDC   /oidc/.well-known/openid-configuration, /oidc/authorize, /oidc/token, /oidc/userinfo
 *   VooSquare events   POST /voo/events
 *
 * Every call is recorded in `fakes.calls` ({ service, method, params, at, token }) so tests
 * can assert on exactly what the server sent. Failures can be programmed per service.
 *
 *   const fakes = await startFakes();
 *   const bot = fakes.tg.newBot('shopbot');   // { token, id, username }
 *   fakes.tg.block(12345);                    // chat 12345 answers 403 "bot was blocked by the user"
 *   fakes.tg.rateLimit(3, 1);                 // next 3 calls answer 429 retry_after=1
 *   fakes.emailsTo('a@b.co')                  // emails sent to that address
 *   await fakes.stop();
 */

const http = require('node:http');
const crypto = require('node:crypto');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Text length the way Telegram counts it after parsing HTML entities and tags. */
function visibleHtmlLength(s) {
  const plain = String(s || '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  return [...plain].length;
}

async function startFakes() {
  const calls = [];
  let msgId = 1000;
  let fileSeq = 1;

  /* ---------- Telegram state ---------- */
  const tg = {
    bots: new Map(), // token -> { id, username, first_name }
    invalid: new Set(),
    blocked: new Set(), // chat ids (string) that answer 403
    forbiddenChats: new Set(), // channel/group chat ids where the bot can't post (403 not enough rights)
    rate429: { n: 0, retryAfter: 1 },
    memberCount: 42,
    chatMember: null, // override for getChatMember result
    uploads: [], // { method, field, filename, size, file_id }
    fail5xx: 0,
    nextBotId: 700000000,
    newBot(username = 'bot' + crypto.randomBytes(3).toString('hex')) {
      const id = this.nextBotId++;
      const token = `${id}:${crypto.randomBytes(26).toString('base64url').slice(0, 35)}`;
      this.bots.set(token, { id, is_bot: true, username, first_name: username });
      return { token, id, username };
    },
    addBot(token, { id, username }) { this.bots.set(token, { id, is_bot: true, username, first_name: username }); },
    markInvalid(token) { this.invalid.add(token); },
    block(chatId) { this.blocked.add(String(chatId)); },
    unblock(chatId) { this.blocked.delete(String(chatId)); },
    rateLimit(n, retryAfter = 1) { this.rate429 = { n, retryAfter }; },
  };

  /* ---------- Other services ---------- */
  const emails = [];
  const ai = { calls: [], failNext: 0, text: 'Hello from Cas 👋 Here is your message.' };
  const paystack = { txns: new Map(), webhookSecret: null };
  const flw = { txns: new Map(), byId: new Map(), nextId: 5000 };
  const gatevoo = { invoices: new Map() };
  const oidc = { codes: new Map(), tokens: new Map(), nextUser: { sub: 'g-1', email: 'guser@example.com', email_verified: true, name: 'Goo User' }, clientId: null, clientSecret: null };
  const voo = { events: [], seen: new Set(), rejectIds: new Set(), support: [], failNext: 0, codes: new Map(), nextUser: { voo_id: 'vs_new', email: 'vsuser@example.com', name: 'Voo Square', country: 'KE' }, clientId: 'cv-client', clientSecret: 'cv-secret' };

  function record(service, method, params, token) {
    const c = { service, method, params, at: Date.now(), token };
    calls.push(c);
    return c;
  }

  function send(res, status, obj, headers = {}) {
    const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': typeof obj === 'string' ? 'text/plain' : 'application/json', ...headers });
    res.end(body);
  }

  async function parseParams(req, raw) {
    const type = String(req.headers['content-type'] || '');
    if (type.includes('multipart/form-data')) {
      const fd = await new Response(raw, { headers: { 'content-type': type } }).formData();
      const out = {};
      const files = {};
      for (const [k, v] of fd.entries()) {
        if (typeof v === 'string') {
          try { out[k] = /^[[{]/.test(v) ? JSON.parse(v) : v; } catch { out[k] = v; }
        } else {
          const buf = Buffer.from(await v.arrayBuffer());
          files[k] = { filename: v.name, size: buf.length, type: v.type };
          out[k] = { file: true, filename: v.name, size: buf.length };
        }
      }
      return { params: out, files };
    }
    if (type.includes('application/json')) return { params: raw.length ? JSON.parse(raw.toString('utf8')) : {}, files: {} };
    if (type.includes('application/x-www-form-urlencoded')) return { params: Object.fromEntries(new URLSearchParams(raw.toString('utf8'))), files: {} };
    return { params: {}, files: {} };
  }

  function tgOk(res, result) { send(res, 200, { ok: true, result }); }
  function tgErr(res, code, description, parameters) { send(res, code, { ok: false, error_code: code, description, ...(parameters ? { parameters } : {}) }); }

  function mediaResult(method, chatId, params, files, field) {
    const m = { message_id: msgId++, chat: { id: Number(chatId) }, date: Math.floor(Date.now() / 1000), caption: params.caption };
    let fileId;
    if (files[field]) {
      fileId = `FILE_${field}_${fileSeq++}`;
      tg.uploads.push({ method, field, filename: files[field].filename, size: files[field].size, file_id: fileId });
    } else {
      fileId = String(params[field]);
    }
    if (field === 'photo') m.photo = [{ file_id: fileId + '_small', width: 90, height: 90 }, { file_id: fileId, width: 800, height: 800 }];
    else if (field === 'video') m.video = { file_id: fileId };
    else m.animation = { file_id: fileId };
    return m;
  }

  async function telegram(req, res, token, method, raw) {
    const { params, files } = await parseParams(req, raw);
    record('telegram', method, params, token);
    if (tg.invalid.has(token) || !tg.bots.has(token)) return tgErr(res, 401, 'Unauthorized');
    const bot = tg.bots.get(token);
    if (tg.rate429.n > 0) { tg.rate429.n--; return tgErr(res, 429, `Too Many Requests: retry after ${tg.rate429.retryAfter}`, { retry_after: tg.rate429.retryAfter }); }
    if (tg.fail5xx > 0) { tg.fail5xx--; return tgErr(res, 502, 'Bad Gateway'); }
    const chatId = params.chat_id !== undefined ? String(params.chat_id) : null;
    const sending = /^(send|edit|pin|delete)/.test(method);
    if (sending && chatId && tg.blocked.has(chatId)) return tgErr(res, 403, 'Forbidden: bot was blocked by the user');
    if (sending && chatId && tg.forbiddenChats.has(chatId)) return tgErr(res, 403, 'Forbidden: bot is not a member of the channel chat');
    switch (method) {
      case 'getMe': return tgOk(res, { ...bot });
      case 'setWebhook': case 'deleteWebhook': case 'setMyCommands': case 'answerCallbackQuery': case 'approveChatJoinRequest':
      case 'leaveChat': case 'pinChatMessage': case 'deleteMessage':
        return tgOk(res, true);
      case 'getWebhookInfo': return tgOk(res, { url: 'https://example/tg', pending_update_count: 0 });
      case 'getChatMemberCount': return tgOk(res, tg.memberCount);
      case 'getChatMember': return tgOk(res, tg.chatMember || { status: 'administrator', can_invite_users: true, user: { id: Number(params.user_id) } });
      case 'sendMessage': {
        if (visibleHtmlLength(params.text) > 4096) return tgErr(res, 400, 'Bad Request: message is too long');
        if (!String(params.text || '').trim()) return tgErr(res, 400, 'Bad Request: message text is empty');
        return tgOk(res, { message_id: msgId++, chat: { id: Number(chatId) }, date: Math.floor(Date.now() / 1000), text: params.text });
      }
      case 'editMessageText':
        if (visibleHtmlLength(params.text) > 4096) return tgErr(res, 400, 'Bad Request: message is too long');
        return tgOk(res, { message_id: Number(params.message_id), chat: { id: Number(chatId) }, text: params.text });
      case 'editMessageCaption':
        if (visibleHtmlLength(params.caption) > 1024) return tgErr(res, 400, 'Bad Request: message caption is too long');
        return tgOk(res, { message_id: Number(params.message_id), chat: { id: Number(chatId) }, caption: params.caption });
      case 'sendPhoto': case 'sendVideo': case 'sendAnimation': {
        if (visibleHtmlLength(params.caption) > 1024) return tgErr(res, 400, 'Bad Request: message caption is too long');
        const field = method === 'sendPhoto' ? 'photo' : method === 'sendVideo' ? 'video' : 'animation';
        if (!files[field] && !params[field]) return tgErr(res, 400, 'Bad Request: there is no ' + field + ' in the request');
        return tgOk(res, mediaResult(method, chatId, params, files, field));
      }
      default: return tgErr(res, 404, 'Not Found: method not found');
    }
  }

  /* ---------- AI ---------- */
  function aiReply(body) {
    const userText = JSON.stringify(body.messages || []);
    if (/JSON array/.test(userText)) {
      const n = Number((/exactly (\d+) Telegram messages/.exec(userText) || [])[1] || 3);
      const arr = Array.from({ length: n }, (_, i) => ({ delay_value: i === 0 ? 5 : i, delay_unit: i === 0 ? 'hour' : 'day', body: `Step ${i + 1}: **hello** there` }));
      return 'Here you go:\n' + JSON.stringify(arr);
    }
    return ai.text;
  }

  /* ---------- Router ---------- */
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://x');
      const p = u.pathname;
      const raw = await readBody(req);

      let m = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(p);
      if (m) return await telegram(req, res, decodeURIComponent(m[1]), m[2], raw);

      const json = () => { try { return JSON.parse(raw.toString('utf8') || '{}'); } catch { return {}; } };
      const auth = String(req.headers.authorization || '');

      if (p === '/emails' && req.method === 'POST') {
        const b = json();
        record('resend', 'send', b);
        if (!auth.startsWith('Bearer ')) return send(res, 401, { message: 'missing key' });
        const e = { id: 'em_' + emails.length, to: b.to[0], subject: b.subject, html: b.html, text: b.text, at: Date.now() };
        emails.push(e);
        return send(res, 200, { id: e.id });
      }

      if (p === '/v1/messages' && req.method === 'POST') {
        const b = json();
        record('anthropic', 'messages', b);
        // Castvoo sends the system prompt as cached blocks; tests read it as one text.
        ai.calls.push({ ...b, system_blocks: b.system, system: Array.isArray(b.system) ? b.system.map((x) => x.text).join('\n\n') : b.system });
        if (!req.headers['x-api-key']) return send(res, 401, { error: { message: 'no key' } });
        if (ai.failNext > 0) { ai.failNext--; return send(res, 500, { error: { message: 'overloaded' } }); }
        return send(res, 200, { content: [{ type: 'text', text: aiReply(b) }], usage: { input_tokens: 120, output_tokens: 40 } });
      }

      /* Paystack */
      if (p === '/transaction/initialize' && req.method === 'POST') {
        const b = json();
        record('paystack', 'initialize', b);
        paystack.txns.set(b.reference, { reference: b.reference, amount: b.amount, currency: b.currency, status: 'abandoned', email: b.email });
        return send(res, 200, { status: true, data: { authorization_url: 'https://checkout.paystack.test/' + b.reference, access_code: 'ac_' + b.reference, reference: b.reference } });
      }
      m = /^\/transaction\/verify\/(.+)$/.exec(p);
      if (m) {
        const ref = decodeURIComponent(m[1]);
        record('paystack', 'verify', { reference: ref });
        const t = paystack.txns.get(ref);
        if (!t) return send(res, 404, { status: false, message: 'Transaction reference not found' });
        return send(res, 200, { status: true, data: { ...t } });
      }
      if (p === '/balance') { record('paystack', 'balance', {}); return send(res, 200, { status: true, data: [] }); }

      /* Flutterwave */
      if (p === '/v3/payments' && req.method === 'POST') {
        const b = json();
        record('flutterwave', 'payments', b);
        const id = flw.nextId++;
        const t = { id, tx_ref: b.tx_ref, amount: b.amount, currency: b.currency, status: 'pending' };
        flw.txns.set(b.tx_ref, t); flw.byId.set(String(id), t);
        return send(res, 200, { status: 'success', data: { link: 'https://checkout.flutterwave.test/' + b.tx_ref } });
      }
      m = /^\/v3\/transactions\/(\d+)\/verify$/.exec(p);
      if (m) {
        record('flutterwave', 'verify', { id: m[1] });
        const t = flw.byId.get(m[1]);
        return t ? send(res, 200, { status: 'success', data: { ...t } }) : send(res, 404, { status: 'error', message: 'not found' });
      }
      if (p === '/v3/transactions/verify_by_reference') {
        const ref = u.searchParams.get('tx_ref');
        record('flutterwave', 'verify_by_reference', { tx_ref: ref });
        const t = flw.txns.get(ref);
        return t ? send(res, 200, { status: 'success', data: { ...t } }) : send(res, 404, { status: 'error', message: 'not found' });
      }
      if (p === '/v3/balances') { record('flutterwave', 'balances', {}); return send(res, 200, { status: 'success', data: [] }); }

      /* Gatevoo */
      if (p === '/api/v1/invoices' && req.method === 'POST') {
        const b = json();
        record('gatevoo', 'create', b);
        const id = 'inv_' + crypto.randomBytes(5).toString('hex');
        gatevoo.invoices.set(id, { id, status: 'pending', order_id: b.order_id, amount_usd: b.amount_usd });
        return send(res, 200, { id, checkout_url: 'https://pay.gatevoo.test/i/' + id });
      }
      m = /^\/api\/v1\/invoices\/([^/]+)$/.exec(p);
      if (m && req.method === 'GET') {
        record('gatevoo', 'get', { id: m[1] });
        const inv = gatevoo.invoices.get(decodeURIComponent(m[1]));
        return inv ? send(res, 200, { invoice: { ...inv } }) : send(res, 404, { error: 'not found' });
      }
      if (p === '/healthz') { record('gatevoo', 'healthz', {}); return send(res, 200, { ok: true }); }

      /* OIDC */
      if (p === '/oidc/.well-known/openid-configuration') {
        return send(res, 200, { issuer: base + '/oidc', authorization_endpoint: base + '/oidc/authorize', token_endpoint: base + '/oidc/token', userinfo_endpoint: base + '/oidc/userinfo' });
      }
      if (p === '/oidc/authorize') {
        const q = Object.fromEntries(u.searchParams);
        record('oidc', 'authorize', q);
        const code = 'code_' + crypto.randomBytes(6).toString('hex');
        oidc.codes.set(code, { challenge: q.code_challenge, client_id: q.client_id, redirect_uri: q.redirect_uri, user: { ...oidc.nextUser } });
        const to = new URL(q.redirect_uri);
        to.searchParams.set('code', code);
        to.searchParams.set('state', q.state);
        res.writeHead(302, { Location: to.toString() });
        return res.end();
      }
      if (p === '/oidc/token' && req.method === 'POST') {
        const b = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
        record('oidc', 'token', b);
        const c = oidc.codes.get(b.code);
        if (!c) return send(res, 400, { error: 'invalid_grant' });
        oidc.codes.delete(b.code);
        const challenge = crypto.createHash('sha256').update(String(b.code_verifier || '')).digest('base64url');
        if (challenge !== c.challenge) return send(res, 400, { error: 'invalid_grant', error_description: 'PKCE failed' });
        if (b.client_id !== oidc.clientId || b.client_secret !== oidc.clientSecret || b.redirect_uri !== c.redirect_uri) return send(res, 401, { error: 'invalid_client' });
        const at = 'at_' + crypto.randomBytes(8).toString('hex');
        oidc.tokens.set(at, c.user);
        return send(res, 200, { access_token: at, token_type: 'Bearer', expires_in: 3600 });
      }
      if (p === '/oidc/userinfo') {
        const user = oidc.tokens.get(auth.replace(/^Bearer /, ''));
        record('oidc', 'userinfo', {});
        return user ? send(res, 200, user) : send(res, 401, { error: 'invalid_token' });
      }

      /* VooSquare (fixed OAuth endpoints, events API and support inbox API) */
      if (p === '/voo/oauth/authorize') {
        const q = Object.fromEntries(u.searchParams);
        record('voosquare', 'authorize', q);
        const code = 'vcode_' + crypto.randomBytes(6).toString('hex');
        voo.codes.set(code, { redirect_uri: q.redirect_uri, user: { ...voo.nextUser } });
        const to = new URL(q.redirect_uri);
        to.searchParams.set('code', code);
        to.searchParams.set('state', q.state);
        res.writeHead(302, { Location: to.toString() });
        return res.end();
      }
      if (p === '/voo/oauth/token' && req.method === 'POST') {
        const b = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
        record('voosquare', 'token', b);
        const c = voo.codes.get(b.code);
        if (!c) return send(res, 400, { error: 'invalid_grant' });
        voo.codes.delete(b.code);
        if (b.client_id !== voo.clientId || b.client_secret !== voo.clientSecret || b.redirect_uri !== c.redirect_uri) return send(res, 401, { error: 'invalid_client' });
        // A real HS256 id_token, signed with the client secret, as VooSquare does (the kit verifies it).
        const now = Math.floor(Date.now() / 1000);
        const u2 = { sub: c.user.voo_id, email_verified: true, ...c.user };
        const claims = { iss: base + '/voo', aud: voo.clientId, sub: u2.voo_id, voo_id: u2.voo_id, email: u2.email, email_verified: u2.email_verified, name: u2.name, country: u2.country, voo_ref: u2.voo_ref || '', iat: now, exp: now + 600, ...(voo.tokenClaims || {}) };
        const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
        const h = b64({ alg: 'HS256', typ: 'JWT' }), pl = b64(claims);
        const idToken = `${h}.${pl}.${crypto.createHmac('sha256', voo.idTokenSecret || voo.clientSecret).update(`${h}.${pl}`).digest('base64url')}`;
        return send(res, 200, { access_token: 'vat_' + crypto.randomBytes(6).toString('hex'), token_type: 'Bearer', expires_in: 3600, id_token: idToken, user: u2 });
      }
      if ((p === '/voo/api/v1/events' || p === '/voo/events') && req.method === 'POST') {
        if (String(req.headers.authorization || '') !== 'Bearer voo-api-key-456') return send(res, 401, { error: 'bad key' });
        const sig = String(req.headers['x-voo-signature'] || '');
        record('voosquare', 'event', { raw: raw.toString('utf8'), sig });
        if (voo.failNext > 0) { voo.failNext--; return send(res, 500, { error: 'down' }); }
        const body = json();
        const rejected = [];
        let stored = 0;
        for (const ev of (body.events || [body])) {
          if (voo.rejectIds && voo.rejectIds.has(ev.event_id)) { rejected.push({ event_id: ev.event_id, error: 'occurred_at is more than 400 days ago' }); continue; }
          if (voo.seen.has(ev.event_id)) continue; // repeats are ignored, like VooSquare
          voo.seen.add(ev.event_id); stored++;
          voo.events.push({ raw: raw.toString('utf8'), body: ev, sig });
        }
        return send(res, 200, { ok: true, stored, ...(rejected.length ? { rejected } : {}) });
      }
      if (p === '/voo/api/v1/support/messages' && req.method === 'POST') {
        if (String(req.headers.authorization || '') !== 'Bearer voo-api-key-456') return send(res, 401, { error: 'bad key' });
        record('voosquare', 'support', json());
        voo.support.push(json());
        return send(res, 200, { ok: true, ticket_id: 't_' + voo.support.length });
      }

      send(res, 404, { error: 'fake: no route ' + req.method + ' ' + p });
    } catch (e) {
      send(res, 500, { error: 'fake crashed: ' + e.message });
    }
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const fakes = {
    base, calls, tg, emails, ai, paystack, flw, gatevoo, oidc, voo,
    /** Telegram calls, optionally only one method and/or one bot token. */
    tgCalls(method, token) { return calls.filter((c) => c.service === 'telegram' && (!method || c.method === method) && (!token || c.token === token)); },
    emailsTo(addr) { return emails.filter((e) => e.to === String(addr).toLowerCase()); },
    lastEmail(addr, subjectRe) { const l = this.emailsTo(addr).filter((e) => !subjectRe || subjectRe.test(e.subject)); return l[l.length - 1] || null; },
    lastCode(addr) {
      const e = this.emailsTo(addr).filter((x) => /login code: \d{6}/.test(x.subject || '')).pop();
      return e ? /(\d{6})/.exec(e.subject)[1] : null;
    },
    reset() { calls.length = 0; },
    stop() { return new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }); },
  };
  return fakes;
}

module.exports = { startFakes, visibleHtmlLength };

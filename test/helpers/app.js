'use strict';
/*
 * Starts a full Castvoo server for end-to-end tests:
 *   a throwaway PostgreSQL, the fake outside services (test/helpers/fakes.js),
 *   migrations + seed, and the HTTP server, all in this process.
 * The background workers are NOT started on timers: tests call the jobs directly
 * (app.jobs.billingTick(), app.drain() for the sender) so every step is deterministic.
 *
 *   const app = await startApp();
 *   const c = await app.loginByEmail('ada@example.com');
 *   const r = await c.post('/api/broadcasts', { ... });
 *   await app.stop();
 */

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { startPgServer } = require('./pgserver');
const { startFakes } = require('./fakes');

const ROOT = path.join(__dirname, '..', '..');
const S = (p) => path.join(ROOT, 'server', p);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function waitFor(fn, { timeout = 10000, interval = 25, message = 'condition' } = {}) {
  const start = Date.now();
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() - start > timeout) throw new Error(`waitFor timed out: ${message}`);
    await sleep(interval);
  }
}

let ipSeq = 1;

/** A tiny browser: cookie jar, `x-cv: 1` on every request, JSON in and out. */
function makeClient(base, { csrf = true, ip } = {}) {
  const jar = new Map();
  const myIp = ip || `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;
  async function request(method, p, body, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (csrf && opts.csrf !== false) headers['x-cv'] = '1';
    headers['x-forwarded-for'] = opts.ip || myIp;
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload;
    if (body !== undefined && body !== null) {
      if (Buffer.isBuffer(body) || typeof body === 'string') payload = body;
      else { payload = JSON.stringify(body); headers['content-type'] = headers['content-type'] || 'application/json'; }
    }
    const res = await fetch(base + p, { method, headers, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (attrs.some((a) => /max-age=0\b/i.test(a.trim())) || v === '') jar.delete(k); else jar.set(k, v);
    }
    const text = await res.text();
    let json = null;
    if ((res.headers.get('content-type') || '').includes('json')) { try { json = JSON.parse(text); } catch { /* not json */ } }
    return { status: res.status, headers: res.headers, body: json, text };
  }
  return {
    ip: myIp, jar,
    get: (p, o) => request('GET', p, undefined, o),
    post: (p, b, o) => request('POST', p, b === undefined ? {} : b, o),
    put: (p, b, o) => request('PUT', p, b === undefined ? {} : b, o),
    del: (p, o) => request('DELETE', p, undefined, o),
    request,
  };
}

/**
 * port / host: the address Castvoo is reached at (APP_URL). The hub connection test uses host "localhost" so Castvoo's
 * cookies never mix with VooSquare's on 127.0.0.1 (browsers ignore ports for cookies).
 */
async function startApp({ env = {}, port: wantPort, host = '127.0.0.1' } = {}) {
  const pg = await startPgServer({ ssl: false });
  let fakes, server, uploadDir, app6 = null;
  try {
    fakes = await startFakes();
    const port = wantPort || await freePort();
    const appUrl = `http://${host}:${port}`;
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'castvoo-uploads-'));
    const platformBotToken = '600000001:' + crypto.randomBytes(26).toString('base64url').slice(0, 35);
    fakes.tg.addBot(platformBotToken, { id: 600000001, username: 'CastvooBot' });

    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: pg.url,
      DB_POOL_MAX: '20',
      APP_SECRET: crypto.randomBytes(32).toString('hex'),
      APP_URL: appUrl,
      PORT: String(port),
      RUN_WORKERS: '0',
      TRUST_PROXY: '1',
      TELEGRAM_API_BASE: fakes.base,
      CASTVOO_BOT_TOKEN: platformBotToken,
      CASTVOO_BOT_USERNAME: 'CastvooBot',
      RESEND_API_KEY: 're_test_key',
      RESEND_API_BASE: fakes.base,
      ANTHROPIC_API_KEY: 'sk-ant-test',
      ANTHROPIC_API_BASE: fakes.base,
      AI_PROVIDER: 'anthropic',
      OPENROUTER_API_KEY: '',
      OPENROUTER_FALLBACK_MODELS: '',
      OPENAI_API_KEY: '',
      PAYSTACK_SECRET_KEY: 'sk_test_paystack',
      PAYSTACK_API_BASE: fakes.base,
      FLW_SECRET_KEY: 'FLWSECK_TEST-123',
      FLW_WEBHOOK_HASH: 'flw-hash-secret',
      FLW_API_BASE: fakes.base,
      GATEVOO_URL: fakes.base,
      GATEVOO_KEY: 'gv_test_key',
      GATEVOO_WEBHOOK_SECRET: 'gv-webhook-secret',
      VOO_SERVICE_KEY: 'voo-service-key-123',
      VOO_BASE: fakes.base + '/voo',
      VOO_API_KEY: 'voo-api-key-456',
      VOO_CLIENT_ID: 'cv-client',
      VOO_CLIENT_SECRET: 'cv-secret',
      OWNER_EMAIL: 'owner@castvoo.test',
      UPLOAD_DIR: uploadDir,
      TG_SEND_PER_SECOND: '200',
      QUIET_LOGS: '1',
      AI_RETRY_BASE_MS: '20',
      // The leaving-Castvoo page for new accounts' links is tested on its own (security-fixes.test.js).
      LINK_WARN_NEW_DAYS: '0',
      ...env,
    });

    const db = require(S('db'));
    db.init();
    await db.migrate();
    await require(S('seed')).run();
    const { createServer } = require(S('app'));
    server = createServer();
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
    if (host === 'localhost') { // some systems resolve localhost to ::1 first
      app6 = require(S('app')).createServer();
      await new Promise((r) => { app6.once('error', () => r()); app6.listen(port, '::1', r); });
    }

    const config = require(S('config'));
    const jobs = require(S('workers/jobs'));
    const sender = require(S('workers/sender'));
    const settings = require(S('services/settings'));
    const rl = require(S('lib/ratelimit'));
    const platformBot = require(S('services/platform-bot'));
    const voosquare = require(S('services/voosquare'));

    // Ctrl+C or a killed test run: still stop postgres and remove the temp folders.
    const onSignal = (sig) => { app.stop().finally(() => process.kill(process.pid, sig)); };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    let tgUpdateId = 1;
    const app = {
      url: appUrl, pg, fakes, db, config, jobs, sender, settings, rl, voosquare, uploadDir, platformBotToken,
      require: (p) => require(S(p)),
      client: (o) => makeClient(appUrl, o),
      waitFor,
      sleep,

      /** Log in with the email code flow. Returns a logged-in client. */
      async loginByEmail(email, extra = {}, client = makeClient(appUrl)) {
        const s = await client.post('/api/auth/email/start', { email });
        assert.equal(s.status, 200, 'email/start: ' + s.text);
        const code = fakes.lastCode(email);
        assert.ok(code, 'no login code email for ' + email);
        const v = await client.post('/api/auth/email/verify', { email, code, ...extra });
        assert.equal(v.status, 200, 'email/verify: ' + v.text);
        client.created = v.body.created;
        const me = await client.get('/api/me');
        client.user = me.body.user;
        client.workspaces = me.body.workspaces;
        return client;
      },

      /** A logged-in staff member with the given role (made by the platform owner). */
      async staff(role, email = `${role}-${crypto.randomBytes(3).toString('hex')}@castvoo.test`) {
        const owner = await app.owner();
        if (role !== 'owner' || email !== config.ownerEmail) {
          const r = await owner.post('/api/admin/team', { email, role });
          assert.equal(r.status, 200, 'add staff: ' + r.text);
        }
        return app.loginByEmail(email);
      },
      async owner() {
        if (!app._owner) app._owner = await app.loginByEmail(config.ownerEmail);
        return app._owner;
      },

      /** Workspace row for a client. */
      async ws(client) { return db.one('select * from workspaces where owner_user_id = $1 order by id limit 1', [client.user.id]); },

      /** Connect a new fake bot for this client. */
      async connectBot(client, username) {
        const bot = fakes.tg.newBot(username);
        const r = await client.post('/api/connections/bot', { token: bot.token });
        assert.equal(r.status, 200, 'connect bot: ' + r.text);
        return { ...bot, connId: r.body.connection.id };
      },

      /** Send an update to a customer's bot webhook, with the right secret. */
      async telegramUpdate(connectionId, update, { secret } = {}) {
        const c = await db.one('select webhook_secret from connections where id = $1', [connectionId]);
        const res = await fetch(`${appUrl}/tg/b/${connectionId}`, {
          method: 'POST', body: JSON.stringify({ update_id: tgUpdateId++, ...update }),
          headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret ?? (c ? c.webhook_secret : '') },
        });
        const out = { status: res.status, text: await res.text() };
        // Join requests are handled just after the webhook answers (ENG-10): wait for that work, like Telegram's user would.
        if (update.chat_join_request && !update.noWait) await require(S('services/bot-updates')).idle();
        return out;
      },
      async platformUpdate(update, { secret } = {}) {
        const res = await fetch(`${appUrl}/tg/platform`, {
          method: 'POST', body: JSON.stringify({ update_id: tgUpdateId++, ...update }),
          headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret ?? platformBot.secret() },
        });
        return { status: res.status, text: await res.text() };
      },
      /** A person presses Start on a customer's bot. */
      async start(connectionId, userId, payload = '', from = {}) {
        return app.telegramUpdate(connectionId, {
          message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: userId, type: 'private' }, from: { id: userId, is_bot: false, first_name: 'User' + userId, ...from }, text: payload ? `/start ${payload}` : '/start' },
        });
      },
      /** Insert `n` active subscribers straight into the database (fast). */
      async addSubscribers(connectionId, n, { from = 1000000, ...cols } = {}) {
        await db.query(`insert into subscribers(connection_id, tg_user_id, first_name, lang, source, tz)
          select $1, g, 'Sub' || g, $4, $5, $6 from generate_series($2::bigint, $3::bigint) g`, [connectionId, from, from + n - 1, cols.lang || null, cols.source || null, cols.tz || null]);
      },

      /** Run the sender until nothing due is left in the queue. */
      async drain({ maxMs = 60000 } = {}) {
        const start = Date.now();
        for (;;) {
          await sender.tick();
          await Promise.all([...sender.running.values()]);
          const q = await db.one("select count(*)::int n from deliveries where status = 'queued' and due_at <= now()");
          if (!q.n) return;
          if (Date.now() - start > maxMs) throw new Error('drain timed out with ' + q.n + ' queued');
          await sleep(20);
        }
      },
      /** Send everything queued, then let the broadcast job close finished broadcasts. */
      async flush() { await app.drain(); await jobs.broadcastsTick(); },

      async setFeature(key, enabled) {
        await db.query('insert into feature_flags(key, enabled) values ($1,$2) on conflict (key) do update set enabled = excluded.enabled', [key, enabled]);
        settings.bust();
      },
      async setSetting(key, patch) {
        const cur = await settings.get(key);
        const value = typeof cur === 'object' && cur && !Array.isArray(cur) ? { ...cur, ...patch } : patch;
        await db.query('insert into settings(key, value) values ($1,$2) on conflict (key) do update set value = excluded.value', [key, JSON.stringify(value)]);
        settings.bust();
      },

      async stop() {
        if (app.stopped) return;
        app.stopped = true;
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
        try { if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); } } catch { /* ignore */ }
        try { if (app6 && app6.listening) { app6.closeAllConnections(); await new Promise((r) => app6.close(r)); } } catch { /* ignore */ }
        try { await Promise.race([sender.stop(), sleep(3000)]); } catch { /* ignore */ }
        // Don't wait forever for a query that is still running; stopping postgres ends it anyway.
        try { await Promise.race([db.end(), sleep(5000)]); } catch { /* ignore */ }
        try { await fakes.stop(); } catch { /* ignore */ }
        try { await pg.stop(); } catch { /* ignore */ }
        try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch { /* ignore */ }
      },
    };
    return app;
  } catch (e) {
    try { if (server) server.close(); } catch { /* ignore */ }
    try { if (fakes) await fakes.stop(); } catch { /* ignore */ }
    try { if (uploadDir) fs.rmSync(uploadDir, { recursive: true, force: true }); } catch { /* ignore */ }
    await pg.stop();
    throw e;
  }
}

/** Telegram Login Widget hash, computed exactly like Telegram does. */
function telegramLoginHash(botToken, data) {
  const check = Object.keys(data).filter((k) => k !== 'hash' && data[k] !== undefined && data[k] !== '').sort().map((k) => `${k}=${data[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(botToken).digest();
  return crypto.createHmac('sha256', secret).update(check).digest('hex');
}

/** Small valid file heads for upload tests. */
const FILES = {
  jpg: () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(2000)]),
  png: () => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), crypto.randomBytes(2000)]),
  mp4: () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), crypto.randomBytes(4000)]),
};

module.exports = { startApp, makeClient, waitFor, sleep, telegramLoginHash, FILES };

'use strict';
/* Fixes from the October 2026 audit (docs/CHANGES-FROM-TESTS.md, "Audit 2026-10"). */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, FILES } = require('../helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { if (app) await app.stop(); });
beforeEach(() => app.rl._reset());

describe('bad numbers are a 400, not a server error', () => {
  it('ids and numbers the database cannot read', async () => {
    const c = await app.loginByEmail('badnums@example.com');
    const bot = await app.connectBot(c);
    for (const [label, r] of [
      ['estimate ?connection_id=abc', await c.get('/api/broadcasts/estimate?connection_id=abc')],
      ['subscribers ?connection=abc', await c.get('/api/subscribers?connection=abc')],
      ['segment_id=abc', await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'x', segment_id: 'abc', draft: true })],
      ['media_id=abc', await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'x', media_id: 'abc', draft: true })],
      ['id 1e20', await c.get('/api/broadcasts/99999999999999999999')],
      ['tag ids 1e20', await c.post('/api/subscribers/tag', { tag: 'x', ids: ['99999999999999999999'] })],
    ]) {
      assert.equal(r.status, 400, label + ': ' + r.text);
      assert.equal(r.body.code, 'bad_value', label);
    }
  });
});

describe('webhook secrets', () => {
  it('a bot connection without a webhook secret never accepts an update without one', async () => {
    const c = await app.loginByEmail('nosecret@example.com');
    const bot = await app.connectBot(c);
    await app.db.query("update connections set webhook_secret = '' where id = $1", [bot.connId]);
    const r = await fetch(`${app.url}/tg/b/${bot.connId}`, { method: 'POST', body: JSON.stringify({ update_id: 1, message: { chat: { id: 5, type: 'private' }, from: { id: 5 }, text: '/start' } }), headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 401);
    assert.equal((await app.db.one('select count(*)::int n from subscribers where connection_id = $1', [bot.connId])).n, 0);
  });
});

describe('billing', () => {
  it('renewal switched off during the trial: the trial ends, nothing is charged', async () => {
    const c = await app.loginByEmail('trialcancel@example.com');
    const ws = await app.ws(c);
    await app.db.query('update workspaces set wallet_cents = 10000 where id = $1', [ws.id]);
    assert.equal((await c.post('/api/app/plan', { plan: 'growth', cycle: 'month' })).status, 200);
    assert.equal((await c.post('/api/app/plan/cancel')).status, 200);
    await app.db.query("update workspaces set trial_ends_at = now() - interval '1 minute' where id = $1", [ws.id]);
    await app.jobs.billingTick();
    const after = await app.db.one('select * from workspaces where id = $1', [ws.id]);
    // The trial ends on the Free plan (not paused, not charged).
    assert.deepEqual([after.plan_code, after.plan_status], ['free', 'active']);
    assert.equal(Number(after.wallet_cents), 10000, 'not charged');
    assert.equal((await app.db.one("select count(*)::int n from wallet_tx where workspace_id = $1 and kind = 'plan'", [ws.id])).n, 0);
    // Picking a plan again later works as usual.
    const r = await c.post('/api/app/plan', { plan: 'growth', cycle: 'month' });
    assert.equal(r.status, 200, r.text);
    assert.equal((await app.db.one('select plan_status from workspaces where id = $1', [ws.id])).plan_status, 'active');
  });
});

describe('accounts', () => {
  it('logging in with an emailed code marks the email verified (team members added by an admin)', async () => {
    const owner = await app.owner();
    assert.equal((await owner.post('/api/admin/team', { email: 'newstaff@example.com', role: 'support' })).status, 200);
    assert.equal((await app.db.one("select email_verified from users where email = 'newstaff@example.com'")).email_verified, false);
    await app.loginByEmail('newstaff@example.com');
    assert.equal((await app.db.one("select email_verified from users where email = 'newstaff@example.com'")).email_verified, true);
  });
});

describe('uploads', () => {
  it('a workspace cannot fill the disk: storage is capped per workspace', async () => {
    const c = await app.loginByEmail('storage@example.com');
    const ws = await app.ws(c);
    const { STORAGE } = app.require('routes/media');
    await app.db.query("insert into media(workspace_id, kind, filename, mime, size_bytes, path) values ($1, 'video', 'big.mp4', 'video/mp4', $2, '/nonexistent/big.mp4')", [ws.id, STORAGE.bytes - 100]);
    const r = await c.post('/api/media', FILES.jpg(), { headers: { 'content-type': 'image/jpeg', 'x-filename': 'a.jpg' } });
    assert.equal(r.status, 413);
    assert.equal(r.body.code, 'storage_full');
  });

  it('files no message uses are removed after 3 days; used ones stay', async () => {
    const c = await app.loginByEmail('unused@example.com');
    const bot = await app.connectBot(c);
    const a = (await c.post('/api/media', FILES.jpg(), { headers: { 'content-type': 'image/jpeg', 'x-filename': 'a.jpg' } })).body.media;
    const b = (await c.post('/api/media', FILES.png(), { headers: { 'content-type': 'image/png', 'x-filename': 'b.png' } })).body.media;
    assert.equal((await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'With photo', media_id: b.id, draft: true })).status, 200);
    await app.db.query("update media set created_at = now() - interval '4 days' where id = any($1::bigint[])", [[a.id, b.id]]);
    const pa = (await app.db.one('select path from media where id = $1', [a.id])).path;
    const pb = (await app.db.one('select path from media where id = $1', [b.id])).path;
    await app.jobs.cleanupTick();
    assert.equal(await app.db.one('select 1 from media where id = $1', [a.id]), null);
    assert.ok(!fs.existsSync(pa), 'unused file deleted');
    assert.ok(await app.db.one('select 1 from media where id = $1', [b.id]), 'used by a draft: kept');
    assert.ok(fs.existsSync(pb));
    assert.ok(path.resolve(pa).startsWith(path.resolve(app.uploadDir)));
  });
});

describe('client IP behind a proxy', () => {
  const { execFileSync } = require('node:child_process');
  const trust = (extra) => {
    const env = { ...process.env, ...extra };
    for (const k of ['TRUST_PROXY', 'RAILWAY_ENVIRONMENT']) if (!(k in extra)) delete env[k];
    return execFileSync(process.execPath, ['-e', "process.stdout.write(String(require('./server/config').trustProxy))"], { cwd: path.join(__dirname, '..', '..'), env, encoding: 'utf8' });
  };
  it('X-Forwarded-For is trusted by default only on Railway (its edge adds the real address); TRUST_PROXY overrides', () => {
    assert.equal(trust({}), 'false', 'no proxy: a visitor must not pick their own IP and dodge the per-IP limits');
    assert.equal(trust({ RAILWAY_ENVIRONMENT: 'production' }), 'true');
    assert.equal(trust({ TRUST_PROXY: 'true' }), 'true');
    assert.equal(trust({ RAILWAY_ENVIRONMENT: 'production', TRUST_PROXY: 'false' }), 'false');
  });
});

describe('support copy for VooSquare', () => {
  it('is in the outbox as soon as the customer\'s message is saved (no race with the next flush)', async () => {
    const c = await app.loginByEmail('race@example.com');
    for (let i = 0; i < 5; i++) {
      assert.equal((await c.post('/api/support', { body: 'Message ' + i })).status, 200);
      const n = await app.db.one("select count(*)::int n from outbox where kind = 'voo_support' and payload->>'email' = 'race@example.com'");
      assert.equal(n.n, i + 1);
    }
  });
});

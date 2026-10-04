'use strict';
/* "Download my data" and "Delete my account". */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { startApp, FILES } = require('../helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { if (app) await app.stop(); });

describe('account', () => {
  let c, bot, ws, payRef, file, otherDevice;
  before(async () => {
    c = await app.loginByEmail('leaving@example.com', { name: 'Leaving User', country: 'NG' });
    otherDevice = await app.loginByEmail('leaving@example.com');
    ws = await app.ws(c);
    bot = await app.connectBot(c);
    await app.start(bot.connId, 91001, 'ads', { first_name: 'Sub One' });
    await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Exported message' });
    await app.flush();
    await c.post('/api/app/ai-profile', { business: 'Leaving Ltd' });
    await c.post('/api/support', { body: 'Please export my data' });
    const support = await app.staff('support');
    const tid = (await app.db.one('select id from support_threads where user_id = $1', [c.user.id])).id;
    await support.post(`/api/admin/support/${tid}/reply`, { body: 'Secret staff note', internal: true });
    const top = await c.post('/api/wallet/topup', { amount: 20, method: 'paystack_ng' });
    payRef = top.body.reference;
    app.fakes.paystack.txns.get(payRef).status = 'success';
    await app.require('payments').verifyPaystack(payRef);
    const m = await c.post('/api/media', FILES.jpg(), { headers: { 'content-type': 'image/jpeg' } });
    file = (await app.db.one('select path from media where id = $1', [m.body.media.id])).path;
  });

  it('export: everything about me as a JSON download, without secrets or staff notes', async () => {
    const r = await c.get('/api/me/export');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /attachment; filename="castvoo-data.json"/);
    const d = JSON.parse(r.text);
    assert.equal(d.account.email, 'leaving@example.com');
    assert.equal(d.workspaces[0].ai_training.business, 'Leaving Ltd');
    assert.equal(d.connections[0].username, bot.username);
    assert.equal(d.subscribers[0].first_name, 'Sub One');
    assert.equal(d.broadcasts[0].body, 'Exported message');
    assert.equal(d.payments[0].reference, payRef);
    assert.ok(d.wallet.some((t) => t.kind === 'topup'));
    assert.deepEqual(d.support.map((m) => m.body), ['Please export my data']);
    for (const secret of [bot.token, 'token_enc', 'webhook_secret', 'Secret staff note', 'code_hash', 'token_hash']) assert.ok(!r.text.includes(secret), 'export contains ' + secret);
    // Another user's export has none of it.
    const other = await app.loginByEmail('stranger@example.com');
    const o = JSON.parse((await other.get('/api/me/export')).text);
    assert.equal(o.subscribers.length, 0);
    assert.equal(o.payments.length, 0);
  });

  it('delete needs the word DELETE', async () => {
    assert.equal((await c.post('/api/me/delete', { confirm: 'yes' })).status, 400);
    assert.equal((await c.post('/api/me/delete', { confirm: 'DELETE' }, { csrf: false })).status, 403);
  });

  it('delete: data scrubbed, sessions gone everywhere, bot disconnected, payments kept', async () => {
    const r = await c.post('/api/me/delete', { confirm: 'delete' });
    assert.equal(r.status, 200, r.text);
    assert.ok(app.fakes.lastEmail('leaving@example.com', /account has been deleted/));
    assert.equal((await c.get('/api/me')).body.user, null);
    assert.equal((await otherDevice.get('/api/me')).body.user, null, 'other devices are logged out too');
    assert.equal((await app.db.one('select count(*)::int n from sessions where user_id = $1', [c.user.id])).n, 0);
    const u = await app.db.one('select * from users where id = $1', [c.user.id]);
    assert.deepEqual([u.status, u.email, u.name, u.tg_user_id], ['deleted', null, 'Deleted user', null]);
    assert.equal((await app.db.one('select count(*)::int n from subscribers where connection_id = $1', [bot.connId])).n, 0);
    assert.equal((await app.db.one('select count(*)::int n from support_threads where user_id = $1', [c.user.id])).n, 0, 'support chats deleted');
    const conn = await app.db.one('select status, token_enc from connections where id = $1', [bot.connId]);
    assert.deepEqual([conn.status, conn.token_enc], ['removed', null]);
    assert.ok(app.fakes.tgCalls('deleteWebhook', bot.token).length >= 1);
    assert.equal((await app.db.one('select count(*)::int n from broadcasts where workspace_id = $1', [ws.id])).n, 0);
    assert.ok(!fs.existsSync(file), 'uploaded file deleted');
    const w = await app.db.one('select name, ai_profile, plan_status from workspaces where id = $1', [ws.id]);
    assert.deepEqual([w.name, w.ai_profile, w.plan_status], ['Deleted workspace', {}, 'cancelled']);
    const p = await app.db.one('select status, user_id, amount_cents from payments where reference = $1', [payRef]);
    assert.deepEqual([p.status, p.user_id, Number(p.amount_cents)], ['paid', c.user.id, 2000], 'payment record kept');
    // The bot's webhook no longer reaches anything.
    assert.equal((await app.start(bot.connId, 91002)).status, 401);
    // The same email can sign up again as a brand-new account.
    const again = await app.loginByEmail('leaving@example.com');
    assert.equal(again.created, true);
    assert.notEqual(again.user.id, c.user.id);
    // The bot can be connected again by someone else.
    const nb = await again.post('/api/connections/bot', { token: bot.token });
    assert.equal(nb.status, 200, nb.text);
    void crypto;
  });
});

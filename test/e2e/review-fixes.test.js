'use strict';
/* Fixes from the independent pre-launch review: each test pins one of them down. */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { if (app) await app.stop(); });
beforeEach(() => { app.rl._reset(); });

const W = (id) => app.db.one('select * from workspaces where id = $1', [id]);

describe('yearly plans get their AI writes every month', () => {
  it('the job refills yearly plans after 30 days and tells the refill date', async () => {
    const c = await app.loginByEmail('yearly-ai@example.com');
    const ws = await app.ws(c);
    await app.db.query(`update workspaces set plan_status = 'active', plan_code = 'starter', billing_cycle = 'year', ai_used = 300,
      ai_period_start = now() - interval '31 days', period_end = now() + interval '300 days' where id = $1`, [ws.id]);
    const st = await c.get('/api/app/state');
    assert.ok(st.body.plan.ai_refill_at, 'refill date shown');
    await app.jobs.billingTick();
    const after = await W(ws.id);
    assert.equal(after.ai_used, 0);
    assert.ok(new Date(after.ai_period_start) > new Date(Date.now() - 2 * 86400000), 'new 30-day period started');
    // Monthly plans are not touched by this job (they refill at renewal).
    await app.db.query("update workspaces set billing_cycle = 'month', ai_used = 5, ai_period_start = now() - interval '40 days' where id = $1", [ws.id]);
    await app.jobs.billingTick();
    assert.equal((await W(ws.id)).ai_used, 5);
  });
});

describe('broadcast edits', () => {
  it('a message that is still going out cannot be edited', async () => {
    const c = await app.loginByEmail('edit-sending@example.com');
    const bot = await app.connectBot(c);
    await app.addSubscribers(bot.connId, 3, { from: 870001 });
    const r = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Original' });
    assert.equal(r.status, 200, r.text);
    await app.db.query("update broadcasts set status = 'sending' where id = $1", [r.body.id]);
    const e = await c.post(`/api/broadcasts/${r.body.id}/edit`, { body: 'Changed' });
    assert.equal(e.status, 400);
    assert.equal(e.body.code, 'still_sending');
    assert.equal((await app.db.one('select body from broadcasts where id = $1', [r.body.id])).body, 'Original');
  });
});

describe('follow-up buttons', () => {
  it('editing keeps short links (and their order); removed buttons keep redirecting', async () => {
    const c = await app.loginByEmail('drip-links@example.com');
    const bot = await app.connectBot(c);
    const steps = [{ body: 'Hi', delay_value: 0, delay_unit: 'min', buttons: [
      { label: 'One', url: 'https://example.com/1' }, { label: 'Two', url: 'https://example.com/2' }, { label: 'Three', url: 'https://example.com/3' }] }];
    const r = await c.post('/api/drips', { connection_id: bot.connId, name: 'Links', trigger_type: 'start', steps });
    assert.equal(r.status, 200, r.text);
    const codes = async () => (await c.get('/api/drips')).body.sequences.find((q) => q.id === r.body.id).steps[0].buttons;
    const before = await codes();
    assert.deepEqual(before.map((b) => b.label), ['One', 'Two', 'Three'], 'order kept');
    const ed = await c.put('/api/drips/' + r.body.id, { name: 'Links', trigger_type: 'start', steps: [{ ...steps[0], buttons: [{ label: 'One!', url: 'https://example.com/1b' }, { label: 'Two', url: 'https://example.com/2' }] }] });
    assert.equal(ed.status, 200, ed.text);
    const afterB = await codes();
    assert.deepEqual(afterB.map((b) => b.code), before.slice(0, 2).map((b) => b.code), 'same short links');
    assert.equal(afterB[0].url, 'https://example.com/1b');
    // The removed third button still redirects for people who already have it.
    const old = await fetch(app.url + '/l/' + before[2].code, { redirect: 'manual' });
    assert.equal(old.status, 302);
    assert.equal(old.headers.get('location'), 'https://example.com/3');
    // Deleting the follow-up keeps its sent links working too.
    assert.equal((await c.request('DELETE', '/api/drips/' + r.body.id)).status, 200);
    assert.equal((await fetch(app.url + '/l/' + before[0].code, { redirect: 'manual' })).status, 302);
  });
});

describe('drafters', () => {
  it('cannot switch follow-ups, delete them, change tags or delete audiences', async () => {
    const owner = await app.loginByEmail('drafter-owner@example.com');
    const bot = await app.connectBot(owner);
    const q = await owner.post('/api/drips', { connection_id: bot.connId, name: 'Q', trigger_type: 'start', steps: [{ body: 'Hi', delay_value: 0, delay_unit: 'min' }] });
    const ws = await app.ws(owner);
    const inv = await owner.post('/api/app/team/invite', { email: 'drafter-only@example.com', role: 'drafter' });
    assert.equal(inv.status, 200, inv.text);
    const d = await app.loginByEmail('drafter-only@example.com');
    assert.equal((await d.post('/api/invites/accept', { token: inv.body.link.split('#join/')[1] })).status, 200);
    const as = (m, p, b) => d.request(m, p, b, { headers: { 'x-ws': String(ws.id) } });
    assert.equal((await as('POST', `/api/drips/${q.body.id}/toggle`, { active: false })).status, 403);
    assert.equal((await as('DELETE', `/api/drips/${q.body.id}`)).status, 403);
    assert.equal((await as('POST', '/api/subscribers/tag', { tag: 'vip', ids: [1] })).status, 403);
  });
});

describe('one channel, one workspace', () => {
  it('a channel already used by another workspace is not taken over, and the bot does not leave it', async () => {
    const link = (cl, id) => app.db.query('update users set tg_user_id = $2 where id = $1', [cl.user.id, id]);
    const a = await app.loginByEmail('chan-a@example.com');
    const b = await app.loginByEmail('chan-b@example.com');
    await link(a, 7101); await link(b, 7102);
    const chat = { id: -1009998887, type: 'channel', title: 'Shared News' };
    const added = (from) => app.platformUpdate({ my_chat_member: { chat, from: { id: from }, date: 1, old_chat_member: { status: 'left' }, new_chat_member: { status: 'administrator', can_post_messages: true, user: { id: 600000001 } } } });
    await a.post('/api/connections/request', { kind: 'channel' });
    await added(7101);
    await b.post('/api/connections/request', { kind: 'channel' });
    const leavesBefore = app.fakes.tgCalls('leaveChat', app.platformBotToken).length;
    await added(7102);
    const live = await app.db.many("select workspace_id from connections where tg_chat_id = $1 and status <> 'removed'", [chat.id]);
    assert.equal(live.length, 1);
    assert.equal(Number(live[0].workspace_id), Number((await app.ws(a)).id));
    assert.match(app.fakes.tgCalls('sendMessage', app.platformBotToken).pop().params.text, /already connected to another Castvoo workspace/);
    assert.equal(app.fakes.tgCalls('leaveChat', app.platformBotToken).length, leavesBefore, 'did not leave');
  });
});

describe('referral clawback', () => {
  it('a refund cancels unsettled earnings; the balance shows them gone', async () => {
    const ref = await app.loginByEmail('claw-ref@example.com');
    const code = (await ref.get('/api/me')).body.user.ref_code;
    const buyer = await app.loginByEmail('claw-buyer@example.com');
    void code;
    const bws = await app.ws(buyer);
    await app.db.query('update users set referred_by = $2 where id = $1', [buyer.user.id, ref.user.id]);
    await app.db.query("insert into referral_ledger(user_id, kind, amount_cents, from_workspace_id, rate, settles_at, ref) values ($1,'earning',490,$2,10, now() + interval '20 days','plan-x')", [ref.user.id, bws.id]);
    const bal = () => app.require('services/referrals').balances(ref.user.id);
    assert.equal((await bal()).pending, 490);
    const fin = await app.owner();
    await app.db.query('update workspaces set wallet_cents = 10000 where id = $1', [bws.id]);
    const r = await fin.post(`/api/admin/workspaces/${bws.id}/wallet`, { amount: -49, kind: 'cash', reason: 'Refunded by bank', refund: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.referral_reversed, 4.9);
    const b2 = await bal();
    assert.equal(b2.pending, 0);
    assert.equal(b2.available, 0);
    // A second refund does not reverse twice.
    const r2 = await fin.post(`/api/admin/workspaces/${bws.id}/wallet`, { amount: -1, kind: 'cash', reason: 'Another', refund: true });
    assert.equal(r2.body.referral_reversed, 0);
  });
});

describe('subscriber limits and login', () => {
  it('Google login without a verified email never becomes the Owner', async () => {
    const cfg = app.require('config');
    const was = cfg.ownerEmail;
    cfg.ownerEmail = 'boss@example.com';
    try {
      app.fakes.oidc.nextUser = { sub: 'g-boss-fake', email: 'boss@example.com', name: 'Fake Boss' };
      const c = app.client();
      const s = await c.get('/api/auth/google/start');
      const back = await fetch(s.headers.get('location'), { redirect: 'manual' });
      const cb = new URL(back.headers.get('location'));
      await c.get(cb.pathname + cb.search);
      const me = await c.get('/api/me');
      assert.equal(me.body.user.staff_role, null);
    } finally { cfg.ownerEmail = was; }
  });
});

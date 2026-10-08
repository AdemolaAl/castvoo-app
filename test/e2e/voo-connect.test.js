'use strict';
/*
 * Voo Connect (VooSquare login, affiliate hand-off, money events) against the fake VooSquare in test/helpers/fakes.js.
 * The same flows against the REAL VooSquare are in test/e2e/voo-connect-hub.test.js (runs when the VooSquare repo is
 * available next to Castvoo, or VOOSQUARE_DIR points to it).
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startApp } = require('../helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { if (app) await app.stop(); });
beforeEach(() => { if (app) app.rl._reset(); });

let seq = 0;
const vooUser = (extra = {}) => { seq++; return { voo_id: `vs_t${seq}`, email: `voo${seq}@example.com`, name: `Voo Person ${seq}`, country: 'NG', voo_ref: `vref${seq}`, ...extra }; };

/** Runs the whole login: our start → (fake) VooSquare authorize → our callback. */
async function vooLogin(c, user, startPath = '/auth/voosquare') {
  if (user) app.fakes.voo.nextUser = user;
  const start = await c.get(startPath);
  assert.equal(start.status, 302, start.text);
  const authorize = new URL(start.headers.get('location'));
  const back = await fetch(authorize, { redirect: 'manual' });
  const cb = new URL(back.headers.get('location'));
  const res = await c.get(cb.pathname + cb.search);
  return { start, authorize, res, location: res.headers.get('location') };
}
const evs = (vooId) => app.fakes.voo.events.filter((e) => e.body.voo_id === vooId).map((e) => e.body);
const queued = (vooId) => app.db.many("select payload from outbox where kind = 'voosquare' and payload->>'voo_id' = $1 order by id", [vooId]).then((r) => r.map((x) => x.payload));
const paystackHook = (ev) => {
  const body = JSON.stringify(ev);
  return fetch(app.url + '/pay/paystack', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-paystack-signature': crypto.createHmac('sha512', 'sk_test_paystack').update(body).digest('hex') } });
};
async function topup(c, usd) {
  const r = await c.post('/api/wallet/topup', { amount: usd, method: 'paystack_ng' });
  assert.equal(r.status, 200, r.text);
  Object.assign(app.fakes.paystack.txns.get(r.body.reference), { status: 'success' });
  const ok = await c.post('/api/wallet/check', { reference: r.body.reference });
  assert.equal(ok.body.status, 'paid');
  return r.body.reference;
}

describe('Voo ID login', () => {
  it('affiliate click → Start free → prompt=signup with ref and vclick → new account, hand-off and state cookies cleared', async () => {
    const c = app.client();
    const land = await c.get('/?ref=amaref&vclick=Click0001&sub1=fb');
    assert.equal(land.status, 200);
    const attr = land.headers.getSetCookie().find((x) => x.startsWith('voo_attr='));
    assert.ok(attr, 'voo_attr cookie set on the landing page');
    assert.match(attr, /Max-Age=5184000/);
    assert.match(attr, /SameSite=Lax/);
    assert.doesNotMatch(attr, /HttpOnly/, 'the browser snippet reads it too');
    const u = vooUser();
    const { start, authorize, location, res } = await vooLogin(c, u, '/auth/voosquare?signup=1&return_to=%2F%23app');
    const st = start.headers.getSetCookie().find((x) => x.startsWith('voo_state='));
    assert.match(st, /HttpOnly/); assert.match(st, /Max-Age=600/);
    assert.equal(authorize.searchParams.get('prompt'), 'signup');
    assert.equal(authorize.searchParams.get('ref'), 'amaref');
    assert.equal(authorize.searchParams.get('vclick'), 'Click0001');
    assert.ok(authorize.searchParams.get('state').length >= 20);
    assert.equal(location, '/#signup/country');
    const cleared = res.headers.getSetCookie();
    assert.ok(cleared.some((x) => x.startsWith('voo_attr=;') && /Max-Age=0/.test(x)), 'hand-off cleared');
    assert.ok(cleared.some((x) => x.startsWith('voo_state=;') && /Max-Age=0/.test(x)), 'state cleared');
    assert.ok(cleared.some((x) => x.startsWith('cv_session=') && /HttpOnly/.test(x)), 'our own session');
    const row = await app.db.one('select * from users where voo_id = $1', [u.voo_id]);
    assert.equal(row.email, u.email);
    assert.equal(row.country, 'NG');
    assert.equal(row.voo_ref, u.voo_ref);
    assert.equal(row.email_verified, true);
    assert.ok(await app.db.one('select 1 from workspaces where owner_user_id = $1', [row.id]), 'workspace with a trial');
    // Logging in again finds the same account by voo_id and goes to return_to.
    const c2 = app.client();
    const again = await vooLogin(c2, u, '/auth/voosquare?return_to=%2F%23app%2Fbroadcast');
    assert.equal(again.location, '/#app/broadcast');
    assert.equal((await c2.get('/api/me')).body.user.id, row.id);
  });

  it('VooSquare launcher: /auth/voosquare?return_to=/dashboard lands on the dashboard; off-site return_to is ignored', async () => {
    const u = vooUser();
    await vooLogin(app.client(), u);
    assert.equal((await vooLogin(app.client(), u, '/auth/voosquare?return_to=/dashboard')).location, '/#app');
    assert.equal((await vooLogin(app.client(), u, '/auth/voosquare?return_to=//evil.example/x')).location, '/#app');
    assert.equal((await vooLogin(app.client(), u, '/auth/voosquare?return_to=https://evil.example')).location, '/#app');
    assert.equal((await app.client().get('/dashboard')).headers.get('location'), '/#app');
  });

  it('links an existing account by an email verified on both sides; never by an unverified one', async () => {
    const old = await app.loginByEmail('linkme@example.com');
    const u = vooUser({ email: 'LinkMe@Example.com' });
    const r = await vooLogin(app.client(), u);
    assert.equal(r.location, '/#app');
    const row = await app.db.one('select * from users where voo_id = $1', [u.voo_id]);
    assert.equal(String(row.id), String(old.user.id), 'same Castvoo account');
    // VooSquare says the email is NOT verified: a new account without that email.
    await app.loginByEmail('notverified@example.com');
    const u2 = vooUser({ email: 'notverified@example.com', email_verified: false });
    const r2 = await vooLogin(app.client(), u2);
    assert.equal(r2.location, '/#signup/country');
    const row2 = await app.db.one('select * from users where voo_id = $1', [u2.voo_id]);
    assert.equal(row2.email, null);
    // A Castvoo account whose email was never verified here is not joined either.
    await app.db.query("insert into users(email, email_verified, name, ref_code) values ('unverified-here@example.com', false, 'U', 'unvh1')");
    const u3 = vooUser({ email: 'unverified-here@example.com' });
    await vooLogin(app.client(), u3);
    const row3 = await app.db.one('select * from users where voo_id = $1', [u3.voo_id]);
    assert.equal(row3.email, null, 'new account; the unverified one is untouched');
    assert.equal((await app.db.one("select voo_id from users where email = 'unverified-here@example.com'")).voo_id, null);
  });

  it('"Connect your VooSquare account" links the logged-in account; a plain Voo ID login while someone is logged in switches account instead', async () => {
    const me = await app.loginByEmail('connect-me@example.com');
    const u = vooUser({ email: 'different-on-voo@example.com' });
    // Only a POST from our page (x-cv header) starts linking; another website cannot.
    assert.equal((await me.post('/api/auth/voosquare/link', {}, { csrf: false })).status, 403);
    const lk = await me.post('/api/auth/voosquare/link');
    assert.equal(lk.status, 200, lk.text);
    const r = await vooLogin(me, u, lk.body.url);
    assert.equal(r.location, '/#app/settings');
    assert.equal((await app.db.one('select voo_id from users where id = $1', [me.user.id])).voo_id, u.voo_id);
    assert.equal((await me.get('/api/me')).body.user.voo_linked, true);
    // Someone else is logged in on this browser and VooSquare's launcher opens Castvoo for member B: switch, never link.
    const a = await app.loginByEmail('shared-pc@example.com');
    const b = vooUser();
    await vooLogin(app.client(), b); // B exists already
    const sw = await vooLogin(a, b, '/auth/voosquare?return_to=/dashboard');
    assert.equal(sw.location, '/#app');
    assert.equal((await app.db.one('select voo_id from users where id = $1', [a.user.id])).voo_id, null, 'A was not linked to B');
    assert.equal((await a.get('/api/me')).body.user.email, b.email, 'the browser is now B');
    // Linking a Voo ID that already belongs to another account is refused.
    // A cross-site GET with ?link=1 cannot link either: it is a plain login (switch).
    const v = await app.loginByEmail('victim@example.com');
    const att = vooUser();
    await vooLogin(v, att, '/auth/voosquare?link=1');
    assert.equal((await app.db.one('select voo_id from users where id = $1', [v.user.id])).voo_id, null, 'victim not linked');
    const c = await app.loginByEmail('wants-b@example.com');
    const clash = await vooLogin(c, b, (await c.post('/api/auth/voosquare/link')).body.url);
    assert.equal(clash.res.status, 409);
    assert.match(clash.res.text, /Login did not finish/);
    assert.match(clash.res.text, /already linked/);
  });

  it('N-2: connecting the same VooSquare account again keeps the first link date (attribution does not flip)', async () => {
    const me = await app.loginByEmail('relink-same@example.com');
    const u = vooUser({ email: 'relink-same-voo@example.com' });
    const first = await vooLogin(me, u, (await me.post('/api/auth/voosquare/link')).body.url);
    assert.equal(first.location, '/#app/settings');
    // Pretend the link was made a week ago. Then the same Voo ID comes back through the linking path again (a second
    // tab that started "Connect VooSquare" before the first one finished): the Settings button itself answers 409.
    assert.equal((await me.post('/api/auth/voosquare/link')).status, 409);
    await app.db.query("update users set voo_linked_at = now() - interval '7 days' where id = $1", [me.user.id]);
    const before = (await app.db.one('select voo_linked_at from users where id = $1', [me.user.id])).voo_linked_at;
    const auth = require('../../server/services/auth');
    const current = await app.db.one('select * from users where id = $1', [me.user.id]);
    const again = await auth.loginWithVoo({ ...u, email_verified: true }, { current });
    assert.equal(String(again.user.id), String(me.user.id));
    const row = await app.db.one('select voo_id, voo_linked_at from users where id = $1', [me.user.id]);
    assert.equal(row.voo_id, u.voo_id);
    assert.equal(new Date(row.voo_linked_at).getTime(), new Date(before).getTime(), 'link date unchanged');
  });

  it('refuses a forged id_token, a missing state cookie and a cancelled login, with a Try again link', async () => {
    app.fakes.voo.idTokenSecret = 'not-the-client-secret';
    try {
      const r = await vooLogin(app.client(), vooUser());
      assert.equal(r.res.status, 400);
      assert.match(r.res.text, /Login did not finish/);
      assert.match(r.res.text, /href="\/auth\/voosquare"/);
    } finally { app.fakes.voo.idTokenSecret = null; }
    const c = app.client();
    const s = await c.get('/auth/voosquare');
    const az = new URL(s.headers.get('location'));
    const back = await fetch(az, { redirect: 'manual' });
    const cb = new URL(back.headers.get('location'));
    const fresh = app.client(); // no state cookie in this browser
    const r2 = await fresh.get(cb.pathname + cb.search);
    assert.equal(r2.status, 400);
    assert.equal((await fresh.get('/api/me')).body.user, null);
    const r3 = await c.get('/auth/voosquare/callback?error=access_denied&state=' + az.searchParams.get('state'));
    assert.equal(r3.status, 400);
    assert.match(r3.text, /cancelled/);
  });

  it('a suspended account cannot log in with its Voo ID', async () => {
    const u = vooUser();
    await vooLogin(app.client(), u);
    await app.db.query("update users set status = 'suspended' where voo_id = $1", [u.voo_id]);
    const r = await vooLogin(app.client(), u);
    assert.equal(r.res.status, 403);
  });

  it('log out everywhere: our session ends, then VooSquare\'s, then back to our home page', async () => {
    const c = app.client();
    await vooLogin(c, vooUser());
    const lo = await c.get('/logout');
    const to = new URL(lo.headers.get('location'));
    assert.equal(to.origin + to.pathname, app.fakes.base + '/voo/oauth/logout');
    assert.equal(to.searchParams.get('redirect_uri'), app.url + '/');
    assert.equal((await c.get('/api/me')).body.user, null);
    const plain = await app.loginByEmail('plain-logout@example.com');
    assert.equal((await plain.get('/logout')).headers.get('location'), '/', 'no VooSquare detour without a Voo ID');
  });

  it('public config, CSP and the browser snippet', async () => {
    const cfg = (await app.client().get('/api/public/config')).body;
    assert.equal(cfg.login.voosquare, true);
    assert.equal(cfg.voo.app_url, app.fakes.base + '/voo/app');
    assert.equal(cfg.voo.widget_src, app.fakes.base + '/voo/widget.js');
    const home = await app.client().get('/');
    assert.match(home.headers.get('content-security-policy'), new RegExp(`script-src [^;]*${app.fakes.base.replace(/[.:/]/g, '\\$&')}`));
    assert.match(home.text, /<script defer src="\/voo-connect-browser.js"><\/script>/);
    const js = await app.client().get('/voo-connect-browser.js');
    assert.equal(js.status, 200);
    assert.match(js.text, /VooConnect/);
    const legal = await app.client().get('/legal/terms');
    assert.match(legal.text, /Part of VooSquare/);
    // Castvoo's own referral link no longer uses ?ref= (that is VooSquare's affiliate hand-off).
    const owner = await app.loginByEmail('reflink@example.com');
    const code = owner.user.ref_code;
    const rl = await app.client().get('/r/' + code);
    assert.equal(rl.headers.get('location'), '/?cvref=' + code + '#signup');
  });
});

describe('Money events', () => {
  let c, u, ws;
  before(async () => {
    c = app.client();
    u = vooUser();
    await vooLogin(c, u);
    await c.post('/api/me', { country: 'NG' });
    ws = await app.db.one('select w.* from workspaces w join users x on x.id = w.owner_user_id where x.voo_id = $1', [u.voo_id]);
  });

  it('top-up → wallet_topup (no commission); first plan → spend (cash) + plan_started; renewal → spend + plan_renewed; stable ids', async () => {
    const ref = await topup(c, 100);
    const pay = await app.db.one('select * from payments where reference = $1', [ref]);
    const r = await c.post('/api/app/plan', { plan: 'growth', cycle: 'month', start_now: true });
    assert.equal(r.status, 200, r.text);
    const tx1 = await app.db.one("select * from wallet_tx where workspace_id = $1 and kind = 'plan' order by id desc limit 1", [ws.id]);
    // Renewal: the period ends and the billing job renews from the wallet.
    await app.db.query("update workspaces set period_end = now() - interval '1 minute' where id = $1", [ws.id]);
    await app.jobs.billingTick();
    const tx2 = await app.db.one("select * from wallet_tx where workspace_id = $1 and kind = 'plan' order by id desc limit 1", [ws.id]);
    assert.notEqual(String(tx2.id), String(tx1.id));
    const q = await queued(u.voo_id);
    const byId = Object.fromEntries(q.map((e) => [e.event_id, e]));
    assert.deepEqual(Object.keys(byId).sort(), [`cv_pay_${tx1.id}`, `cv_pay_${tx2.id}`, `cv_plan_${tx1.id}`, `cv_renew_${tx2.id}`, `cv_topup_${pay.id}`].sort());
    assert.equal(byId[`cv_topup_${pay.id}`].type, 'wallet_topup');
    assert.equal(byId[`cv_topup_${pay.id}`].value_usd, 100);
    assert.deepEqual([byId[`cv_pay_${tx1.id}`].type, byId[`cv_pay_${tx1.id}`].value_usd, byId[`cv_pay_${tx1.id}`].plan], ['spend', 49, 'Growth']);
    assert.equal(byId[`cv_pay_${tx1.id}`].label, 'Castvoo Growth, monthly');
    assert.equal(byId[`cv_pay_${tx1.id}`].country, 'NG');
    assert.deepEqual([byId[`cv_plan_${tx1.id}`].type, byId[`cv_plan_${tx1.id}`].value_usd], ['plan_started', 49]);
    assert.deepEqual([byId[`cv_renew_${tx2.id}`].type, byId[`cv_pay_${tx2.id}`].type], ['plan_renewed', 'spend']);
    // Running the same money code again never queues a second copy.
    await app.voosquare.planPaid(null, { wsId: ws.id, txId: tx1.id, plan: { name: 'Growth' }, cycle: 'month', priceCents: 4900, cashCents: 4900, first: true, at: new Date() });
    assert.equal((await queued(u.voo_id)).length, 5);
    await app.voosquare.flush();
    const sent = evs(u.voo_id);
    assert.equal(sent.length, 5);
    for (const e of sent) {
      assert.ok(!JSON.stringify(e).includes(u.email), 'no email');
      assert.ok(!('email' in e) && !('name' in e) && !('telegram_id' in e));
      assert.ok(e.value_usd === undefined || e.value_usd > 0, 'never negative');
    }
    assert.equal((await app.db.one("select count(*)::int n from outbox where kind = 'voosquare' and payload->>'voo_id' = $1 and sent_at is null", [u.voo_id])).n, 0);
  });

  it('refund of wallet money → refund event (commission stays); dispute → one chargeback per plan payment that used that money', async () => {
    const owner = await app.owner();
    const rf = await owner.post(`/api/admin/workspaces/${ws.id}/wallet`, { amount: -2, kind: 'cash', reason: 'Unused money back', refund: true });
    assert.equal(rf.status, 200, rf.text);
    const rtx = await app.db.one("select * from wallet_tx where workspace_id = $1 and kind = 'refund' order by id desc limit 1", [ws.id]);
    const pay = await app.db.one("select * from payments where workspace_id = $1 and status = 'paid' order by id limit 1", [ws.id]);
    const plans = await app.db.many("select * from wallet_tx where workspace_id = $1 and kind = 'plan' order by id", [ws.id]);
    const hook = { event: 'charge.dispute.create', data: { id: 777, transaction: { reference: pay.reference } } };
    assert.equal((await paystackHook(hook)).status, 200);
    assert.equal((await paystackHook(hook)).status, 200, 'Paystack repeats itself');
    const q = await queued(u.voo_id);
    const refund = q.find((e) => e.event_id === `cv_rf_${rtx.id}`);
    assert.deepEqual([refund.type, refund.value_usd], ['refund', 2]);
    const cbs = q.filter((e) => e.type === 'chargeback');
    assert.deepEqual(cbs.map((e) => [e.event_id, e.original_event_id, e.value_usd]).sort(), plans.map((p) => [`cv_cb_${pay.id}_${p.id}`, `cv_pay_${p.id}`, 49]).sort());
    assert.ok((await app.db.one('select disputed_at from payments where id = $1', [pay.id])).disputed_at);
    // Staff cannot record the same dispute a second time.
    assert.equal((await owner.post(`/api/admin/payments/${pay.reference}/chargeback`, { reason: 'again' })).status, 400);
  });

  it('FIFO: a disputed top-up that was never spent reverses nothing; plan paid from bonus credit sends plan_started but no spend', async () => {
    const c2 = app.client();
    const u2 = vooUser();
    await vooLogin(c2, u2);
    await c2.post('/api/me', { country: 'NG' });
    const ws2 = await app.db.one('select w.* from workspaces w join users x on x.id = w.owner_user_id where x.voo_id = $1', [u2.voo_id]);
    const owner = await app.owner();
    assert.equal((await owner.post(`/api/admin/workspaces/${ws2.id}/wallet`, { amount: 49, kind: 'bonus', reason: 'Goodwill credit' })).status, 200);
    assert.equal((await c2.post('/api/app/plan', { plan: 'growth', cycle: 'month', start_now: true })).status, 200);
    const ref = await topup(c2, 50);
    const r = await owner.post(`/api/admin/payments/${ref}/chargeback`, { reason: 'Card dispute' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.voosquare_events, 0);
    const q = await queued(u2.voo_id);
    assert.deepEqual(q.map((e) => e.type).sort(), ['plan_started', 'wallet_topup']);
  });

  it('allocation follows the money: older cash is spent first', async () => {
    // Two top-ups of $20 and $40, one $49 plan: $20 from the first, $29 from the second.
    const c3 = app.client();
    const u3 = vooUser();
    await vooLogin(c3, u3);
    await c3.post('/api/me', { country: 'NG' });
    const w3 = await app.db.one('select w.* from workspaces w join users x on x.id = w.owner_user_id where x.voo_id = $1', [u3.voo_id]);
    const r1 = await topup(c3, 20);
    const r2 = await topup(c3, 40);
    assert.equal((await c3.post('/api/app/plan', { plan: 'growth', cycle: 'month', start_now: true })).status, 200);
    const plan = await app.db.one("select id from wallet_tx where workspace_id = $1 and kind = 'plan'", [w3.id]);
    const a = await app.db.tx((x) => app.voosquare.spendsUsingTopup(x, w3.id, r1));
    const b = await app.db.tx((x) => app.voosquare.spendsUsingTopup(x, w3.id, r2));
    assert.deepEqual(a, [{ txId: String(plan.id), cents: 2000 }]);
    assert.deepEqual(b, [{ txId: String(plan.id), cents: 2900 }]);
  });

  it('VooSquare refuses an event for good → kept as failed, not retried; repeats are ignored by VooSquare', async () => {
    const u4 = vooUser();
    const c4 = app.client();
    await vooLogin(c4, u4);
    await c4.post('/api/me', { country: 'NG' });
    const ref = await topup(c4, 30);
    const pay = await app.db.one('select id from payments where reference = $1', [ref]);
    app.fakes.voo.rejectIds.add(`cv_topup_${pay.id}`);
    await app.voosquare.flush();
    const row = await app.db.one("select * from outbox where payload->>'event_id' = $1", [`cv_topup_${pay.id}`]);
    assert.ok(row.failed_at, 'failed for good');
    assert.match(row.last_error, /400 days/);
    const calls = app.fakes.calls.filter((x) => x.service === 'voosquare' && x.method === 'event').length;
    await app.db.query('update outbox set next_at = now() where id = $1', [row.id]);
    await app.voosquare.flush();
    assert.equal(app.fakes.calls.filter((x) => x.service === 'voosquare' && x.method === 'event').length, calls, 'not sent again');
  });

  it('drip_step_sent: one event per workspace per finished hour, however often the job runs', async () => {
    const u5 = vooUser();
    const c5 = app.client();
    await vooLogin(c5, u5);
    const w5 = await app.db.one('select w.* from workspaces w join users x on x.id = w.owner_user_id where x.voo_id = $1', [u5.voo_id]);
    const bot = await app.connectBot(c5);
    const seqId = (await app.db.one("insert into sequences(workspace_id, connection_id, name, trigger_type, active) values ($1,$2,'Welcome','start',true) returning id", [w5.id, bot.connId])).id;
    const stepId = (await app.db.one("insert into sequence_steps(sequence_id, position, delay_minutes, body) values ($1,1,0,'Hi') returning id", [seqId])).id;
    // N-3: the rollup only counts hours that finished more than 2 minutes ago, so put the rows half an hour before the
    // newest such hour boundary (not before date_trunc('hour', now()), which falls outside it during hh:00-hh:02).
    await app.db.query(`insert into deliveries(workspace_id, sender_key, step_id, chat_id, status, sent_at)
      select $1, 'bot:' || $2, $3, g, 'sent', date_trunc('hour', now() - interval '2 minutes') - interval '30 minutes' from generate_series(1, 3) g`, [w5.id, bot.connId, stepId]);
    await app.voosquare.dripRollup();
    await app.voosquare.dripRollup();
    const d = (await queued(u5.voo_id)).filter((e) => e.type === 'drip_step_sent');
    assert.equal(d.length, 1);
    assert.equal(d[0].label, 'Follow-ups: 3 messages');
    assert.match(d[0].event_id, new RegExp(`^cv_drip_${w5.id}_\\d{4}-\\d\\d-\\d\\dT\\d\\d$`));
  });

  it('VooSquare calls Castvoo: summary and the support webhook at /hooks/voosquare/support (Bearer API key)', async () => {
    const h = { authorization: 'Bearer voo-api-key-456' };
    const s = await fetch(`${app.url}/api/voosquare/summary?voo_id=${u.voo_id}&period=7d`, { headers: h }).then((r) => r.json());
    assert.equal(s.linked, true);
    assert.deepEqual(s.metrics.slice(0, 4).map((m) => m.key), ['messages_sent', 'broadcasts', 'active_drips', 'subscribers']);
    assert.ok(!s.metrics.some((m) => /read/.test(m.key)), 'never reads');
    const no = await fetch(`${app.url}/hooks/voosquare/support`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(no.status, 401);
    const ok = await fetch(`${app.url}/hooks/voosquare/support`, { method: 'POST', body: JSON.stringify({ type: 'other' }), headers: { ...h, 'content-type': 'application/json' } });
    assert.equal(ok.status, 200);
  });
});

describe('VOO_CONNECT=off', () => {
  let off;
  before(async () => {
    await app.stop(); app = null;
    // The config module reads the environment once; a fresh process state for the switched-off app.
    for (const k of Object.keys(require.cache)) if (k.includes('/server/')) delete require.cache[k];
    off = await startApp({ env: { VOO_CONNECT: 'off' } });
  });
  after(async () => { if (off) await off.stop(); for (const k of Object.keys(require.cache)) if (k.includes('/server/')) delete require.cache[k]; process.env.VOO_CONNECT = ''; });

  it('no Voo ID button, no hand-off cookie, no widget, no events; the old logins still work', async () => {
    const cfg = (await off.client().get('/api/public/config')).body;
    assert.equal(cfg.login.voosquare, false);
    assert.equal(cfg.voo, null);
    const land = await off.client().get('/?ref=amaref&vclick=Click0001');
    assert.ok(!land.headers.getSetCookie().some((x) => x.startsWith('voo_attr=')));
    assert.doesNotMatch(land.headers.get('content-security-policy'), /\/voo/);
    assert.equal((await off.client().get('/auth/voosquare')).headers.get('location'), '/#login');
    assert.match((await off.client().get('/voo-connect-browser.js')).text, /off/);
    const c = await off.loginByEmail('offmode@example.com');
    await off.db.query("update users set voo_id = 'vs_off' where id = $1", [c.user.id]);
    await off.connectBot(c);
    assert.equal((await off.db.one("select count(*)::int n from outbox where kind = 'voosquare'")).n, 0);
    assert.equal((await c.get('/logout')).headers.get('location'), '/');
  });
});

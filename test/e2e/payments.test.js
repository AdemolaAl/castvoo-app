'use strict';
/* Wallet top-ups: Flutterwave, Gatevoo and manual crypto; webhooks, verification, bonuses and limits.
 * Paystack is retired: no new top-up can start, but old Paystack references still verify. */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startApp, telegramLoginHash } = require('../helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { if (app) await app.stop(); });
beforeEach(() => app.rl._reset());

let n = 0;
async function payer(country, extra = {}) {
  const email = `payer${++n}@example.com`;
  const c = await app.loginByEmail(email, { country, ...extra });
  return { c, email, ws: await app.ws(c) };
}
const W = (id) => app.db.one('select * from workspaces where id = $1', [id]);
const P = (ref) => app.db.one('select * from payments where reference = $1', [ref]);

function post(path, body, headers) {
  return fetch(app.url + path, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } }).then(async (r) => ({ status: r.status, text: await r.text() }));
}
const paystackHook = (ev, sig) => {
  const body = JSON.stringify(ev);
  return post('/pay/paystack', body, { 'x-paystack-signature': sig ?? crypto.createHmac('sha512', 'sk_test_paystack').update(body).digest('hex') });
};
const flwHook = (ev, hash = 'flw-hash-secret') => post('/pay/flutterwave', JSON.stringify(ev), { 'verif-hash': hash });
const gatevooHook = (ev, { ts = Math.floor(Date.now() / 1000), secret = 'gv-webhook-secret' } = {}) => {
  const body = JSON.stringify(ev);
  return post('/pay/gatevoo', body, { 'x-gatevoo-timestamp': String(ts), 'x-gatevoo-signature': crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex') });
};

describe('wallet', () => {
  it('shows methods for my country, bonuses and limits', async () => {
    const { c } = await payer('NG');
    const w = await c.get('/api/wallet');
    assert.equal(w.status, 200);
    assert.deepEqual(w.body.methods.map((m) => m.key), ['flw_ng', 'gatevoo']);
    assert.equal(w.body.methods[0].currency, 'NGN');
    assert.ok(!w.body.methods.some((m) => /paystack/i.test(m.key + m.label)), 'no Paystack');
    assert.equal(w.body.min_topup, 10);
    assert.equal(w.body.max_topup, 5000);
    assert.deepEqual(w.body.bonuses, [{ min: 200, bonus: 10 }, { min: 500, bonus: 40 }, { min: 1000, bonus: 60 }]);
    assert.equal(w.body.has_email, true);
  });

  it('min, max and method checks', async () => {
    const { c } = await payer('NG');
    assert.equal((await c.post('/api/wallet/topup', { amount: 9.99, method: 'flw_ng' })).status, 400);
    assert.equal((await c.post('/api/wallet/topup', { amount: 5000.01, method: 'flw_ng' })).status, 400);
    assert.equal((await c.post('/api/wallet/topup', { amount: 'lots', method: 'flw_ng' })).status, 400);
    assert.equal((await c.post('/api/wallet/topup', { amount: 50, method: 'flw_ke' })).status, 400, 'Kenya method for a Nigerian');
    await app.setFeature('topups', false);
    try { assert.equal((await c.post('/api/wallet/topup', { amount: 50, method: 'flw_ng' })).status, 403); } finally { await app.setFeature('topups', true); }
  });

  it('card payments need an email; crypto does not', async () => {
    const c = app.client();
    const f = { id: 919191, first_name: 'NoMail', auth_date: Math.floor(Date.now() / 1000) };
    await c.post('/api/auth/telegram', { ...f, hash: telegramLoginHash(app.platformBotToken, f), country: 'NG' });
    const r = await c.post('/api/wallet/topup', { amount: 50, method: 'flw_ng' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'email_needed');
    const g = await c.post('/api/wallet/topup', { amount: 50, method: 'gatevoo' });
    assert.equal(g.status, 200, g.text);
  });
});

const flwPaid = (ref) => { const t = app.fakes.flw.txns.get(ref); t.status = 'successful'; return flwHook({ event: 'charge.completed', data: { id: t.id, tx_ref: ref, status: 'successful' } }); };

describe('Nigeria, Ghana and South Africa pay through Flutterwave', () => {
  it('Nigeria: card, bank transfer and USSD in naira → verified → credited exactly once', async () => {
    const { c, email, ws } = await payer('NG');
    const r = await c.post('/api/wallet/topup', { amount: 50, method: 'flw_ng' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.kind, 'redirect');
    assert.equal(r.body.currency, 'NGN');
    assert.equal(r.body.amount_local, 77500);
    const init = app.fakes.calls.filter((x) => x.service === 'flutterwave' && x.method === 'payments').pop();
    assert.equal(init.params.payment_options, 'card,banktransfer,ussd');
    assert.equal(init.params.amount, 77500);
    assert.equal(init.params.currency, 'NGN');
    assert.equal(init.params.customer.email, email);
    assert.equal(init.params.redirect_url, `${app.url}/pay/return?ref=${r.body.reference}`);
    assert.equal(app.fakes.calls.filter((x) => x.service === 'paystack' && x.method === 'initialize').length, 0, 'Paystack is never called');
    const ref = r.body.reference;
    assert.equal((await c.get('/api/wallet')).body.pending[0].reference, ref);
    const t = app.fakes.flw.txns.get(ref);
    // Flutterwave says pending (a forged event): not credited.
    await flwHook({ event: 'charge.completed', data: { id: t.id, tx_ref: ref, status: 'successful' } });
    assert.equal((await P(ref)).status, 'pending');
    t.status = 'successful';
    const hooks = await Promise.all(Array.from({ length: 5 }, () => flwHook({ event: 'charge.completed', data: { id: t.id, tx_ref: ref, status: 'successful' } })));
    assert.ok(hooks.every((h) => h.status === 200));
    assert.equal(Number((await W(ws.id)).wallet_cents), 5000);
    assert.equal((await P(ref)).status, 'paid');
    assert.equal((await app.db.one("select count(*)::int n from wallet_tx where workspace_id = $1 and kind = 'topup'", [ws.id])).n, 1);
    assert.equal(app.fakes.emailsTo(email).filter((e) => /topped up with \$50\.00/.test(e.subject)).length, 1);
    const back = await c.get('/pay/return?ref=' + ref);
    assert.equal(back.status, 302);
    assert.equal(Number((await W(ws.id)).wallet_cents), 5000);
    assert.equal((await c.post('/api/wallet/check', { reference: ref })).body.status, 'paid');
  });

  it('Ghana (cedis, mobile money) and South Africa (rand, card)', async () => {
    const gh = await payer('GH');
    assert.deepEqual((await gh.c.get('/api/wallet')).body.methods.map((m) => m.key), ['flw_gh', 'gatevoo']);
    const g = await gh.c.post('/api/wallet/topup', { amount: 20, method: 'flw_gh' });
    assert.equal(g.status, 200, g.text);
    assert.equal(g.body.currency, 'GHS');
    assert.equal(app.fakes.calls.filter((x) => x.service === 'flutterwave' && x.method === 'payments').pop().params.payment_options, 'card,mobilemoneyghana');
    const za = await payer('ZA');
    assert.deepEqual((await za.c.get('/api/wallet')).body.methods.map((m) => m.key), ['flw_za', 'gatevoo']);
    const z = await za.c.post('/api/wallet/topup', { amount: 20, method: 'flw_za' });
    assert.equal(z.body.currency, 'ZAR');
    await flwPaid(z.body.reference);
    assert.equal(Number((await W(za.ws.id)).wallet_cents), 2000);
  });

  it('webhook, return page and "check" all at once still credit once', async () => {
    const { c, ws } = await payer('NG');
    const r = await c.post('/api/wallet/topup', { amount: 20, method: 'flw_ng' });
    const t = app.fakes.flw.txns.get(r.body.reference);
    t.status = 'successful';
    await Promise.all([
      flwHook({ event: 'charge.completed', data: { id: t.id, tx_ref: r.body.reference, status: 'successful' } }),
      c.get('/pay/return?tx_ref=' + r.body.reference),
      c.post('/api/wallet/check', { reference: r.body.reference }),
      flwHook({ event: 'charge.completed', data: { id: t.id, tx_ref: r.body.reference, status: 'successful' } }),
    ]);
    assert.equal(Number((await W(ws.id)).wallet_cents), 2000);
  });

  it('top-up bonus by tier', async () => {
    const { c, ws } = await payer('NG');
    for (const [usd, bonus] of [[199, 0], [200, 1000], [500, 4000]]) {
      const r = await c.post('/api/wallet/topup', { amount: usd, method: 'flw_ng' });
      assert.equal(Number((await P(r.body.reference)).bonus_cents), bonus, `$${usd}`);
      await flwPaid(r.body.reference);
    }
    const w = await W(ws.id);
    assert.equal(Number(w.wallet_cents), 89900);
    assert.equal(Number(w.bonus_cents), 5000);
  });

  it('a paused plan starts again by itself after a top-up', async () => {
    const { c, ws } = await payer('NG');
    await app.db.query("update workspaces set plan_status = 'paused', trial_ends_at = null, period_end = now() where id = $1", [ws.id]);
    const r = await c.post('/api/wallet/topup', { amount: 60, method: 'flw_ng' });
    await flwPaid(r.body.reference);
    const w = await W(ws.id);
    assert.equal(w.plan_status, 'active');
    assert.equal(Number(w.wallet_cents), 6000 - 4900);
  });
});


describe('Paystack (retired)', () => {
  // An old Paystack payment, as made before Paystack was removed (no new one can start).
  async function oldPaystack(ws, user, usd, ref) {
    await app.db.query("insert into payments(workspace_id, user_id, provider, method_key, reference, amount_cents, bonus_cents, currency, amount_local) values ($1,$2,'paystack','paystack_ng',$3,$4,0,'NGN',$5)",
      [ws.id, user.id, ref, usd * 100, usd * 1550]);
    app.fakes.paystack.txns.set(ref, { reference: ref, amount: usd * 1550 * 100, currency: 'NGN', status: 'abandoned' });
    return ref;
  }

  it('no new Paystack top-up can start, even when a Paystack method is switched back on', async () => {
    const { c } = await payer('NG');
    const r = await c.post('/api/wallet/topup', { amount: 50, method: 'paystack_ng' });
    assert.equal(r.status, 400);
    // An old database: the Paystack row exists and someone switches it on and puts it on Nigeria by hand.
    await app.db.query("insert into payment_methods(key, provider, label, detail) values ('paystack_ng', 'paystack', 'Paystack', 'Card') on conflict (key) do update set active = true, deleted_at = null");
    await app.db.query(`update countries set methods = '["paystack_ng", "flw_ng", "crypto"]' where code = 'NG'`);
    app.settings.bust();
    try {
      assert.deepEqual((await c.get('/api/wallet')).body.methods.map((m) => m.key), ['flw_ng', 'gatevoo'], 'never offered');
      const r2 = await c.post('/api/wallet/topup', { amount: 50, method: 'paystack_ng' });
      assert.equal(r2.status, 400);
      await assert.rejects(app.require('payments').GATEWAYS.paystack.start(), /no longer available/);
      assert.equal(app.fakes.calls.filter((x) => x.service === 'paystack' && x.method === 'initialize').length, 0);
    } finally {
      await app.db.query(`update countries set methods = '["flw_ng", "crypto"]' where code = 'NG'`);
      await app.db.query("update payment_methods set active = false, deleted_at = now() where key = 'paystack_ng'");
      app.settings.bust();
    }
  });

  it('an old Paystack reference still verifies: signed webhook → Paystack confirms → credited once', async () => {
    const { c, ws } = await payer('NG');
    const ref = await oldPaystack(ws, c.user, 50, 'cv_oldps1');
    assert.equal((await paystackHook({ event: 'charge.success', data: { reference: ref } }, 'deadbeef')).status, 401);
    assert.equal((await paystackHook({ event: 'charge.success', data: { reference: ref } })).status, 200);
    assert.equal((await P(ref)).status, 'pending', 'Paystack says not paid');
    app.fakes.paystack.txns.get(ref).status = 'success';
    await Promise.all(Array.from({ length: 3 }, () => paystackHook({ event: 'charge.success', data: { reference: ref } })));
    assert.equal((await P(ref)).status, 'paid');
    assert.equal(Number((await W(ws.id)).wallet_cents), 5000);
    // The return page and "check" ask Paystack too (and credit nothing more).
    assert.equal((await c.post('/api/wallet/check', { reference: ref })).body.status, 'paid');
    assert.equal(Number((await W(ws.id)).wallet_cents), 5000);
    // A dispute on that old Paystack payment still arrives by Paystack's webhook, once.
    const dispute = { event: 'charge.dispute.create', data: { id: 4242, transaction: { reference: ref } } };
    assert.equal((await paystackHook(dispute)).status, 200);
    assert.equal((await paystackHook(dispute)).status, 200, 'Paystack repeats itself');
    assert.ok((await P(ref)).disputed_at);
    assert.equal(Number((await W(ws.id)).wallet_cents), 0, 'the disputed money comes out once');
  });

  it('an old Paystack reference: the return page / check verify it; amount or currency mismatch is not credited', async () => {
    const { c, ws } = await payer('NG');
    const ok = await oldPaystack(ws, c.user, 20, 'cv_oldps2');
    app.fakes.paystack.txns.get(ok).status = 'success';
    await c.get('/pay/return?reference=' + ok);
    assert.equal((await P(ok)).status, 'paid');
    const a = await oldPaystack(ws, c.user, 100, 'cv_oldps3');
    Object.assign(app.fakes.paystack.txns.get(a), { status: 'success', amount: 100 });
    await paystackHook({ event: 'charge.success', data: { reference: a } });
    assert.equal((await P(a)).status, 'pending');
    assert.match((await P(a)).reason, /did not match/);
    const b = await oldPaystack(ws, c.user, 100, 'cv_oldps4');
    Object.assign(app.fakes.paystack.txns.get(b), { status: 'success', currency: 'GHS' });
    await c.post('/api/wallet/check', { reference: b });
    assert.equal((await P(b)).status, 'pending');
    assert.equal(Number((await W(ws.id)).wallet_cents), 2000);
  });

  it('a Paystack webhook for someone else\'s Flutterwave payment is ignored', async () => {
    const { c } = await payer('KE');
    const r = await c.post('/api/wallet/topup', { amount: 30, method: 'flw_ke' });
    app.fakes.paystack.txns.set(r.body.reference, { reference: r.body.reference, status: 'success', amount: 999999999, currency: 'KES' });
    await paystackHook({ event: 'charge.success', data: { reference: r.body.reference } });
    assert.equal((await P(r.body.reference)).status, 'pending');
  });

  it('migration 022 on an old database: Paystack off and hidden, countries moved to Flutterwave, history kept', async () => {
    await app.db.query("insert into payment_methods(key, provider, label, detail) values ('paystack_gh', 'paystack', 'Paystack', 'Card, mobile money'), ('paystack_za', 'paystack', 'Paystack', 'Card, instant EFT') on conflict (key) do update set active = true, deleted_at = null");
    await app.db.query("insert into payment_methods(key, provider, label, detail) values ('paystack_ng', 'paystack', 'Paystack', 'Card') on conflict (key) do update set active = true, deleted_at = null");
    await app.db.query(`update countries set methods = '["paystack_ng", "crypto"]' where code = 'NG'`);
    await app.db.query(`update countries set methods = '["paystack_gh", "crypto", "flw_gh"]' where code = 'GH'`);
    await app.db.query(`update countries set methods = '["crypto", "paystack_za"]' where code = 'ZA'`);
    await app.db.query("delete from schema_migrations where name = '022_remove_paystack.sql'");
    await app.db.migrate();
    app.settings.bust();
    const m = (code) => app.db.one('select methods from countries where code = $1', [code]).then((r) => r.methods);
    assert.deepEqual(await m('NG'), ['flw_ng', 'crypto']);
    assert.deepEqual(await m('GH'), ['flw_gh', 'crypto'], 'no duplicate');
    assert.deepEqual(await m('ZA'), ['crypto', 'flw_za']);
    assert.deepEqual(await m('KE'), ['flw_ke', 'crypto'], 'other countries untouched');
    const ps = await app.db.many("select key, active, deleted_at from payment_methods where provider = 'paystack' order by key");
    assert.equal(ps.length, 3, 'the records stay');
    assert.ok(ps.every((x) => !x.active && x.deleted_at), 'switched off and hidden');
    const owner = await app.owner();
    const admin = await owner.get('/api/admin/countries');
    assert.ok(!admin.body.methods.some((x) => x.provider === 'paystack'), 'hidden from Admin → Countries & payments');
    // It can't be put back on a country either.
    const put = await owner.put('/api/admin/countries/NG', { name: 'Nigeria', currency: 'NGN', usd_rate: 1550, methods: ['paystack_ng', 'flw_ng', 'crypto'], featured: true, sort: 1 });
    assert.equal(put.status, 200, put.text);
    assert.deepEqual(await m('NG'), ['flw_ng', 'crypto']);
    assert.ok((await app.db.many('select 1 from payments where provider = $1', ['paystack'])).length >= 1, 'old Paystack payments are still there');
  });
});

describe('Flutterwave', () => {
  it('verif-hash webhook → verify by transaction id → credited once', async () => {
    const { c, ws } = await payer('KE');
    const r = await c.post('/api/wallet/topup', { amount: 40, method: 'flw_ke' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.currency, 'KES');
    const init = app.fakes.calls.filter((x) => x.service === 'flutterwave' && x.method === 'payments').pop();
    assert.equal(init.params.payment_options, 'card,mpesa');
    assert.equal(init.params.amount, 5160);
    const t = app.fakes.flw.txns.get(r.body.reference);
    assert.equal((await flwHook({ event: 'charge.completed', data: { id: t.id, tx_ref: r.body.reference, status: 'successful' } }, 'wrong')).status, 401);
    await flwHook({ event: 'charge.completed', data: { id: t.id, tx_ref: r.body.reference, status: 'successful' } });
    assert.equal((await P(r.body.reference)).status, 'pending', 'Flutterwave says pending');
    t.status = 'successful';
    await Promise.all([1, 2, 3].map(() => flwHook({ event: 'charge.completed', data: { id: t.id, tx_ref: r.body.reference, status: 'successful' } })));
    assert.equal(Number((await W(ws.id)).wallet_cents), 4000);
  });

  it('a webhook pairing my reference with someone else\'s paid transaction id is not credited', async () => {
    const a = await payer('KE');
    const b = await payer('KE');
    const ra = await a.c.post('/api/wallet/topup', { amount: 500, method: 'flw_ke' });
    const rb = await b.c.post('/api/wallet/topup', { amount: 10, method: 'flw_ke' });
    const tb = app.fakes.flw.txns.get(rb.body.reference);
    tb.status = 'successful';
    // Attacker claims B's (cheap, paid) transaction is A's $500 top-up.
    await flwHook({ data: { id: tb.id, tx_ref: ra.body.reference, status: 'successful' } });
    assert.equal((await P(ra.body.reference)).status, 'pending');
    assert.equal(Number((await W(a.ws.id)).wallet_cents), 0);
  });

  it('the return page verifies by reference; amount mismatch is not credited', async () => {
    const { c, ws } = await payer('XX');
    const r = await c.post('/api/wallet/topup', { amount: 25, method: 'flw_card' });
    assert.equal(r.body.currency, 'USD');
    Object.assign(app.fakes.flw.txns.get(r.body.reference), { status: 'successful', amount: 24.5 });
    await c.get(`/pay/return?tx_ref=${r.body.reference}`);
    assert.equal((await P(r.body.reference)).status, 'pending');
    app.fakes.flw.txns.get(r.body.reference).amount = 25;
    await c.get(`/pay/return?tx_ref=${r.body.reference}&transaction_id=${app.fakes.flw.txns.get(r.body.reference).id}`);
    assert.equal(Number((await W(ws.id)).wallet_cents), 2500);
  });
});

describe('Gatevoo (crypto checkout)', () => {
  it('invoice → signed webhook → verify → credited; replays and bad signatures refused', async () => {
    const { c, ws } = await payer('GH');
    const r = await c.post('/api/wallet/topup', { amount: 75, method: 'gatevoo' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.kind, 'gatevoo');
    const inv = app.fakes.gatevoo.invoices.get(r.body.invoice_id);
    assert.equal(inv.order_id, r.body.reference);
    assert.equal(inv.amount_usd, 75);
    const ev = { type: 'invoice.paid', data: { id: inv.id, order_id: r.body.reference } };
    assert.equal((await gatevooHook(ev, { secret: 'wrong' })).status, 401);
    assert.equal((await gatevooHook(ev)).status, 200);
    assert.equal((await P(r.body.reference)).status, 'pending', 'Gatevoo says pending');
    inv.status = 'paid';
    assert.equal((await gatevooHook(ev, { ts: Math.floor(Date.now() / 1000) - 301 })).status, 401, 'older than 5 minutes');
    assert.equal((await gatevooHook(ev, { ts: Math.floor(Date.now() / 1000) + 301 })).status, 401, 'from the future');
    assert.equal((await gatevooHook(ev)).status, 200);
    assert.equal((await gatevooHook(ev)).status, 200);
    assert.equal(Number((await W(ws.id)).wallet_cents), 7500);
    assert.equal((await gatevooHook({ type: 'invoice.test', data: {} })).status, 200);
  });

  it('an invoice paid for less is not credited', async () => {
    const { c, ws } = await payer('GH');
    const r = await c.post('/api/wallet/topup', { amount: 75, method: 'gatevoo' });
    Object.assign(app.fakes.gatevoo.invoices.get(r.body.invoice_id), { status: 'paid', amount_usd: 7.5 });
    await gatevooHook({ type: 'invoice.paid', data: { order_id: r.body.reference } });
    assert.equal(Number((await W(ws.id)).wallet_cents), 0);
  });
});

describe('manual crypto (USDT, exact amounts)', () => {
  const USDT = 'TQ7mZ2r9VbKx4LwN8pHc3eYd6sFa1JuXo5';
  const BTC = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
  before(async () => {
    const owner = await app.owner();
    const bad = await owner.put('/api/admin/settings/crypto', { value: { use_gatevoo: false, usdt_address: '0xNOTTRON', btc_address: '' } });
    assert.equal(bad.status, 400);
    const ok = await owner.put('/api/admin/settings/crypto', { value: { use_gatevoo: false, usdt_address: USDT, btc_address: BTC } });
    assert.equal(ok.status, 200, ok.text);
  });
  after(async () => { const owner = await app.owner(); await owner.put('/api/admin/settings/crypto', { value: { use_gatevoo: true, usdt_address: '', btc_address: '' } }); });

  it('pay to the address, paste the txid, finance approves (with the amount that arrived)', async () => {
    const { c, email, ws } = await payer('NG');
    const w = await c.get('/api/wallet');
    assert.deepEqual(w.body.methods.map((m) => m.key), ['flw_ng', 'usdt'], 'manual mode is USDT only');
    assert.equal((await c.post('/api/wallet/topup', { amount: 50, method: 'btc' })).status, 400);
    const r = await c.post('/api/wallet/topup', { amount: 50, method: 'usdt' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.body.kind, r.body.coin, r.body.address, r.body.network], ['crypto', 'USDT', USDT, 'TRON (TRC20)']);
    // Each top-up gets its own exact amount: $50 plus 1–99 unique cents.
    assert.ok(r.body.exact && r.body.amount_usd > 50 && r.body.amount_usd < 51, String(r.body.amount_usd));
    assert.equal(Number((await P(r.body.reference)).amount_cents), Math.round(r.body.amount_usd * 100));
    // Approve is refused until the customer has sent a transaction ID.
    const fin0 = await app.staff('finance');
    assert.equal((await fin0.post(`/api/admin/payments/${r.body.reference}/approve`)).status, 400, 'no txid yet');
    const txid = 'a'.repeat(64);
    assert.equal((await c.post('/api/wallet/crypto-txid', { reference: r.body.reference, txid: 'not valid!' })).status, 400);
    const sub = await c.post('/api/wallet/crypto-txid', { reference: r.body.reference, txid });
    assert.equal(sub.status, 200, sub.text);
    assert.ok(app.fakes.lastEmail(email, /We got your USDT transaction ID/));
    // The same txid can't be used for a second top-up, by me or anyone.
    const r2 = await c.post('/api/wallet/topup', { amount: 50, method: 'usdt' });
    assert.notEqual(r2.body.amount_usd, r.body.amount_usd, 'two open top-ups never share an amount');
    assert.equal((await c.post('/api/wallet/crypto-txid', { reference: r2.body.reference, txid })).status, 400);
    const other = await payer('NG');
    const r3 = await other.c.post('/api/wallet/topup', { amount: 50, method: 'usdt' });
    assert.equal((await other.c.post('/api/wallet/crypto-txid', { reference: r3.body.reference, txid })).status, 400);
    assert.equal((await other.c.post('/api/wallet/crypto-txid', { reference: r.body.reference, txid: 'b'.repeat(64) })).status, 404, 'not my payment');
    // Paying "check" does not credit manual crypto.
    await c.post('/api/wallet/check', { reference: r.body.reference });
    assert.equal(Number((await W(ws.id)).wallet_cents), 0);

    const finance = await app.staff('finance');
    const list = await finance.get('/api/admin/payments?check=1');
    assert.ok(list.body.payments.some((p) => p.reference === r.body.reference));
    const ap = await finance.post(`/api/admin/payments/${r.body.reference}/approve`, { amount: 45 });
    assert.equal(ap.status, 200, ap.text);
    assert.equal(Number((await W(ws.id)).wallet_cents), 4500);
    assert.equal(Number((await P(r.body.reference)).amount_cents), 4500);
    assert.equal((await finance.post(`/api/admin/payments/${r.body.reference}/approve`)).status, 400, 'already paid');
    await c.post('/api/wallet/crypto-txid', { reference: r2.body.reference, txid: 'f'.repeat(64) });
    await Promise.all([finance.post(`/api/admin/payments/${r2.body.reference}/approve`), finance.post(`/api/admin/payments/${r2.body.reference}/approve`)]);
    assert.equal(Number((await W(ws.id)).wallet_cents), 4500 + Math.round(r2.body.amount_usd * 100), 'double click credits once, the exact amount');

    await other.c.post('/api/wallet/crypto-txid', { reference: r3.body.reference, txid: 'c'.repeat(64) });
    const rej = await finance.post(`/api/admin/payments/${r3.body.reference}/reject`, { reason: 'Not found on chain' });
    assert.equal(rej.status, 200);
    assert.ok(app.fakes.lastEmail(other.email, /could not confirm your USDT payment/));
    assert.equal((await other.c.post('/api/wallet/crypto-txid', { reference: r3.body.reference, txid: 'd'.repeat(64) })).status, 400, 'already handled');
    // Two payments racing with the same txid: one wins, the other gets a clear 400 (not a 500).
    const q1 = await c.post('/api/wallet/topup', { amount: 20, method: 'usdt' });
    const q2 = await other.c.post('/api/wallet/topup', { amount: 20, method: 'usdt' });
    const race = await Promise.all([c.post('/api/wallet/crypto-txid', { reference: q1.body.reference, txid: 'e'.repeat(64) }), other.c.post('/api/wallet/crypto-txid', { reference: q2.body.reference, txid: 'e'.repeat(64) })]);
    assert.deepEqual(race.map((x) => x.status).sort(), [200, 400]);
    const support = await app.staff('support');
    assert.equal((await support.post(`/api/admin/payments/${r3.body.reference}/approve`)).status, 403);
  });

  it('card and Gatevoo payments can never be approved by hand', async () => {
    const owner = await app.owner();
    await owner.put('/api/admin/settings/crypto', { value: { use_gatevoo: true, usdt_address: USDT, btc_address: '' } });
    try {
      const { c } = await payer('GH');
      const g = await c.post('/api/wallet/topup', { amount: 30, method: 'gatevoo' });
      assert.equal(g.status, 200, g.text);
      const finance = await app.staff('finance');
      const ap = await finance.post(`/api/admin/payments/${g.body.reference}/approve`);
      assert.equal(ap.status, 400);
      assert.equal((await P(g.body.reference)).status, 'pending');
    } finally {
      await owner.put('/api/admin/settings/crypto', { value: { use_gatevoo: false, usdt_address: USDT, btc_address: BTC } });
    }
  });

  it('Gatevoo: an invoice for another order is not credited', async () => {
    const owner = await app.owner();
    await owner.put('/api/admin/settings/crypto', { value: { use_gatevoo: true, usdt_address: '', btc_address: '' } });
    try {
      const { c, ws } = await payer('GH');
      const r = await c.post('/api/wallet/topup', { amount: 40, method: 'gatevoo' });
      Object.assign(app.fakes.gatevoo.invoices.get(r.body.invoice_id), { status: 'paid', order_id: 'cv_someone_else' });
      await gatevooHook({ type: 'invoice.paid', data: { id: r.body.invoice_id, order_id: r.body.reference } });
      assert.equal(Number((await W(ws.id)).wallet_cents), 0);
    } finally {
      await owner.put('/api/admin/settings/crypto', { value: { use_gatevoo: false, usdt_address: USDT, btc_address: BTC } });
    }
  });
});

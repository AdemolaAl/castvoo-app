'use strict';
/* Wallet top-ups: Paystack, Flutterwave, Gatevoo and manual crypto; webhooks, verification, bonuses and limits. */

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
  it('keeps Paystack and Flutterwave unavailable when their feature switches are off', async () => {
    const { c } = await payer('NG');
    await app.setFeature('paystack', false);
    await app.setFeature('flutterwave', false);
    try {
      const w = await c.get('/api/wallet');
      assert.ok(!w.body.methods.some((m) => ['paystack_ng', 'flw_card'].includes(m.key)));
      assert.equal((await c.post('/api/wallet/topup', { amount: 50, method: 'paystack_ng' })).status, 400);
      assert.equal((await c.post('/api/wallet/topup', { amount: 50, method: 'flw_card' })).status, 400);
    } finally {
      await app.setFeature('paystack', true);
      await app.setFeature('flutterwave', true);
    }
  });

  it('shows methods for my country, bonuses and limits', async () => {
    const { c } = await payer('NG');
    const w = await c.get('/api/wallet');
    assert.equal(w.status, 200);
    assert.deepEqual(w.body.methods.map((m) => m.key), ['paystack_ng', 'gatevoo']);
    assert.equal(w.body.methods[0].currency, 'NGN');
    assert.equal(w.body.min_topup, 10);
    assert.equal(w.body.max_topup, 5000);
    assert.deepEqual(w.body.bonuses, [{ min: 200, bonus: 10 }, { min: 500, bonus: 40 }, { min: 1000, bonus: 60 }]);
    assert.equal(w.body.has_email, true);
  });

  it('min, max and method checks', async () => {
    const { c } = await payer('NG');
    assert.equal((await c.post('/api/wallet/topup', { amount: 9.99, method: 'paystack_ng' })).status, 400);
    assert.equal((await c.post('/api/wallet/topup', { amount: 5000.01, method: 'paystack_ng' })).status, 400);
    assert.equal((await c.post('/api/wallet/topup', { amount: 'lots', method: 'paystack_ng' })).status, 400);
    assert.equal((await c.post('/api/wallet/topup', { amount: 50, method: 'flw_ke' })).status, 400, 'Kenya method for a Nigerian');
    await app.setFeature('topups', false);
    try { assert.equal((await c.post('/api/wallet/topup', { amount: 50, method: 'paystack_ng' })).status, 403); } finally { await app.setFeature('topups', true); }
  });

  it('card payments need an email; crypto does not', async () => {
    const c = app.client();
    const f = { id: 919191, first_name: 'NoMail', auth_date: Math.floor(Date.now() / 1000) };
    await c.post('/api/auth/telegram', { ...f, hash: telegramLoginHash(app.platformBotToken, f), country: 'NG' });
    const r = await c.post('/api/wallet/topup', { amount: 50, method: 'paystack_ng' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'email_needed');
    const g = await c.post('/api/wallet/topup', { amount: 50, method: 'gatevoo' });
    assert.equal(g.status, 200, g.text);
  });
});

describe('Paystack', () => {
  it('initialize → signed webhook → verify → credited exactly once', async () => {
    const { c, email, ws } = await payer('NG');
    const r = await c.post('/api/wallet/topup', { amount: 50, method: 'paystack_ng' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.kind, 'redirect');
    assert.equal(r.body.currency, 'NGN');
    assert.equal(r.body.amount_local, 77500);
    const init = app.fakes.calls.filter((x) => x.service === 'paystack' && x.method === 'initialize').pop();
    assert.equal(init.params.amount, 7750000, 'kobo');
    assert.equal(init.params.email, email);
    assert.equal(init.params.callback_url, `${app.url}/pay/return?ref=${r.body.reference}`);
    const ref = r.body.reference;
    const pending = await c.get('/api/wallet');
    assert.equal(pending.body.pending[0].reference, ref);

    // Wrong signature: refused.
    assert.equal((await paystackHook({ event: 'charge.success', data: { reference: ref } }, 'deadbeef')).status, 401);
    // Right signature but Paystack says it is not paid (a forged event): not credited.
    assert.equal((await paystackHook({ event: 'charge.success', data: { reference: ref } })).status, 200);
    assert.equal((await P(ref)).status, 'pending');

    const t = app.fakes.paystack.txns.get(ref);
    t.status = 'success';
    const hooks = await Promise.all(Array.from({ length: 5 }, () => paystackHook({ event: 'charge.success', data: { reference: ref } })));
    assert.ok(hooks.every((h) => h.status === 200));
    const w = await W(ws.id);
    assert.equal(Number(w.wallet_cents), 5000);
    assert.equal((await P(ref)).status, 'paid');
    assert.equal((await app.db.one("select count(*)::int n from wallet_tx where workspace_id = $1 and kind = 'topup'", [ws.id])).n, 1);
    assert.equal(app.fakes.emailsTo(email).filter((e) => /topped up with \$50\.00/.test(e.subject)).length, 1);
    // Coming back from the checkout page verifies again but credits nothing more.
    const back = await c.get('/pay/return?ref=' + ref);
    assert.equal(back.status, 302);
    assert.equal(back.headers.get('location'), '/#app/wallet?ref=' + ref);
    assert.equal(Number((await W(ws.id)).wallet_cents), 5000);
    assert.equal((await c.post('/api/wallet/check', { reference: ref })).body.status, 'paid');
  });

  it('webhook, return page and "check" all at once still credit once', async () => {
    const { c, ws } = await payer('NG');
    const r = await c.post('/api/wallet/topup', { amount: 20, method: 'paystack_ng' });
    app.fakes.paystack.txns.get(r.body.reference).status = 'success';
    await Promise.all([
      paystackHook({ event: 'charge.success', data: { reference: r.body.reference } }),
      c.get('/pay/return?reference=' + r.body.reference),
      c.post('/api/wallet/check', { reference: r.body.reference }),
      paystackHook({ event: 'charge.success', data: { reference: r.body.reference } }),
    ]);
    assert.equal(Number((await W(ws.id)).wallet_cents), 2000);
  });

  it('amount or currency mismatch is not credited', async () => {
    const { c, ws } = await payer('NG');
    const a = await c.post('/api/wallet/topup', { amount: 100, method: 'paystack_ng' });
    Object.assign(app.fakes.paystack.txns.get(a.body.reference), { status: 'success', amount: 100 });
    await paystackHook({ event: 'charge.success', data: { reference: a.body.reference } });
    const pa = await P(a.body.reference);
    assert.equal(pa.status, 'pending');
    assert.match(pa.reason, /did not match/);
    const b = await c.post('/api/wallet/topup', { amount: 100, method: 'paystack_ng' });
    Object.assign(app.fakes.paystack.txns.get(b.body.reference), { status: 'success', currency: 'GHS' });
    await paystackHook({ event: 'charge.success', data: { reference: b.body.reference } });
    assert.equal((await P(b.body.reference)).status, 'pending');
    assert.equal(Number((await W(ws.id)).wallet_cents), 0);
  });

  it('a webhook for someone else\'s Flutterwave payment is ignored by the Paystack check', async () => {
    const { c } = await payer('KE');
    const r = await c.post('/api/wallet/topup', { amount: 30, method: 'flw_ke' });
    app.fakes.paystack.txns.set(r.body.reference, { reference: r.body.reference, status: 'success', amount: 999999999, currency: 'KES' });
    await paystackHook({ event: 'charge.success', data: { reference: r.body.reference } });
    assert.equal((await P(r.body.reference)).status, 'pending');
  });

  it('top-up bonus by tier', async () => {
    const { c, ws } = await payer('NG');
    for (const [usd, bonus] of [[199, 0], [200, 1000], [500, 4000]]) {
      const r = await c.post('/api/wallet/topup', { amount: usd, method: 'paystack_ng' });
      assert.equal(Number((await P(r.body.reference)).bonus_cents), bonus, `$${usd}`);
      app.fakes.paystack.txns.get(r.body.reference).status = 'success';
      await paystackHook({ event: 'charge.success', data: { reference: r.body.reference } });
    }
    const w = await W(ws.id);
    assert.equal(Number(w.wallet_cents), 89900);
    assert.equal(Number(w.bonus_cents), 5000);
  });

  it('a paused plan starts again by itself after a top-up', async () => {
    const { c, ws } = await payer('NG');
    await app.db.query("update workspaces set plan_status = 'paused', trial_ends_at = null, period_end = now() where id = $1", [ws.id]);
    const r = await c.post('/api/wallet/topup', { amount: 60, method: 'paystack_ng' });
    app.fakes.paystack.txns.get(r.body.reference).status = 'success';
    await paystackHook({ event: 'charge.success', data: { reference: r.body.reference } });
    const w = await W(ws.id);
    assert.equal(w.plan_status, 'active');
    assert.equal(Number(w.wallet_cents), 6000 - 4900);
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
    assert.deepEqual(w.body.methods.map((m) => m.key), ['paystack_ng', 'usdt'], 'manual mode is USDT only');
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

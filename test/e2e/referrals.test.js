'use strict';
/* Referral earnings: settling, using them for the plan, crypto withdrawals and the finance review. */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { if (app) await app.stop(); });
beforeEach(() => app.rl._reset());

const USDT = 'TQ7mZ2r9VbKx4LwN8pHc3eYd6sFa1JuXo5';
const BTC = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';
let k = 0;
async function earner(cents, { settled = true } = {}) {
  const email = `earner${++k}@example.com`;
  const c = await app.loginByEmail(email);
  if (cents) {
    await app.db.query(`insert into referral_ledger(user_id, kind, amount_cents, rate, settles_at) values ($1, 'earning', $2, 10, now() ${settled ? "- interval '1 day'" : "+ interval '29 days'"})`, [c.user.id, cents]);
  }
  return { c, email, id: c.user.id, ws: await app.ws(c) };
}
const bal = async (c) => (await c.get('/api/referrals')).body.balance;

describe('referrals', () => {
  it('the referral page: link, tiers, people and their status', async () => {
    const r = await earner(0);
    const friend = await app.loginByEmail(`friendof${r.id}@example.com`, { ref: r.c.user.ref_code });
    const page = await r.c.get('/api/referrals');
    assert.equal(page.status, 200);
    assert.equal(page.body.link, `${app.url}/r/${r.c.user.ref_code}`);
    assert.equal(page.body.rate, 10);
    assert.deepEqual(page.body.tiers.map((t) => t.rate), [10, 20, 30]);
    assert.equal(page.body.signups, 1);
    assert.equal(page.body.people[0].status, 'Trial');
    assert.equal(page.body.min_withdraw, 300);
    void friend;
  });

  it('earnings are pending for 30 days, then available', async () => {
    const r = await earner(5000, { settled: false });
    let b = await bal(r.c);
    assert.deepEqual([b.available, b.pending, b.earned], [0, 50, 50]);
    await app.db.query("update referral_ledger set settles_at = now() - interval '1 second' where user_id = $1", [r.id]);
    b = await bal(r.c);
    assert.deepEqual([b.available, b.pending], [50, 0]);
  });

  it('use earnings on the plan: moved into bonus credit', async () => {
    const r = await earner(5000);
    assert.equal((await r.c.post('/api/referrals/use', { amount: 0.5 })).status, 400);
    assert.equal((await r.c.post('/api/referrals/use', { amount: 60 })).status, 400, 'more than available');
    const u = await r.c.post('/api/referrals/use', { amount: 30 });
    assert.equal(u.status, 200, u.text);
    const w = await app.db.one('select bonus_cents, wallet_cents from workspaces where id = $1', [r.ws.id]);
    assert.equal(Number(w.bonus_cents), 3000);
    assert.equal(Number(w.wallet_cents), 0);
    assert.equal((await bal(r.c)).available, 20);
    assert.ok(await app.db.one("select 1 from wallet_tx where workspace_id = $1 and kind = 'referral_credit' and amount_cents = 3000", [r.ws.id]));
  });

  it('withdraw: at least $300, a real TRC20/BTC address, one open request at a time', async () => {
    const r = await earner(100000);
    assert.equal((await r.c.post('/api/referrals/withdraw', { amount: 299, coin: 'USDT', address: USDT })).status, 400);
    assert.equal((await r.c.post('/api/referrals/withdraw', { amount: 300, coin: 'USDT', address: '0x52908400098527886E0F7030069857D2E4169EE7' })).status, 400, 'ERC20 address');
    assert.equal((await r.c.post('/api/referrals/withdraw', { amount: 300, coin: 'BTC', address: USDT })).status, 400);
    assert.equal((await r.c.post('/api/referrals/withdraw', { amount: 300, coin: 'DOGE', address: USDT })).status, 400);
    const ok = await r.c.post('/api/referrals/withdraw', { amount: 300, coin: 'usdt', address: ` ${USDT} ` });
    assert.equal(ok.status, 200, ok.text);
    assert.ok(app.fakes.lastEmail(r.email, /withdrawal request for \$300\.00/));
    const second = await r.c.post('/api/referrals/withdraw', { amount: 300, coin: 'BTC', address: BTC });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'withdrawal_open');
    assert.equal((await bal(r.c)).available, 700);
    assert.equal((await r.c.post('/api/referrals/withdraw', { amount: 2000, coin: 'BTC', address: BTC })).status, 409);
  });

  it('parallel requests cannot overdraw: 5 withdrawals and 3 plan uses at once', async () => {
    const r = await earner(40000);
    const rs = await Promise.all([
      ...Array.from({ length: 5 }, () => r.c.post('/api/referrals/withdraw', { amount: 300, coin: 'USDT', address: USDT })),
      ...Array.from({ length: 3 }, () => r.c.post('/api/referrals/use', { amount: 300 })),
    ]);
    const withdrawn = await app.db.one("select coalesce(sum(amount_cents), 0)::int n, count(*)::int c from withdrawals where user_id = $1", [r.id]);
    const used = await app.db.one("select coalesce(sum(amount_cents), 0)::int n from referral_ledger where user_id = $1 and kind = 'use'", [r.id]);
    assert.ok(withdrawn.c <= 1, 'one open withdrawal at most');
    assert.ok(withdrawn.n + used.n <= 40000, `took ${withdrawn.n + used.n} of 40000`);
    assert.equal(rs.filter((x) => x.status === 200).length, (withdrawn.n + used.n) / 30000);
    assert.equal((await bal(r.c)).available * 100, 40000 - withdrawn.n - used.n);
  });

  it('finance marks a withdrawal paid; a rejected one returns the money unless earnings are cancelled', async () => {
    const finance = await app.staff('finance');
    const support = await app.staff('support');
    const a = await earner(50000);
    const wa = await a.c.post('/api/referrals/withdraw', { amount: 400, coin: 'BTC', address: BTC });
    const list = await finance.get('/api/admin/withdrawals');
    assert.ok(list.body.withdrawals.some((w) => w.id === wa.body.id));
    assert.equal((await support.get('/api/admin/withdrawals')).status, 403);
    assert.equal((await support.post(`/api/admin/withdrawals/${wa.body.id}/paid`, { txid: 'x'.repeat(20) })).status, 403);
    assert.equal((await finance.post(`/api/admin/withdrawals/${wa.body.id}/paid`, { txid: 'short' })).status, 400);
    const paid = await finance.post(`/api/admin/withdrawals/${wa.body.id}/paid`, { txid: 'f'.repeat(64) });
    assert.equal(paid.status, 200);
    assert.ok(app.fakes.lastEmail(a.email, /\$400\.00 withdrawal has been sent/));
    assert.equal((await finance.post(`/api/admin/withdrawals/${wa.body.id}/paid`, { txid: 'f'.repeat(64) })).status, 404, 'only once');
    assert.equal((await bal(a.c)).available, 100);

    const b = await earner(50000);
    const wb = await b.c.post('/api/referrals/withdraw', { amount: 300, coin: 'USDT', address: USDT });
    await finance.post(`/api/admin/withdrawals/${wb.body.id}/reject`, { reason: 'Please use a TRC20 address you own' });
    assert.equal((await bal(b.c)).available, 500, 'money back');
    assert.ok(app.fakes.lastEmail(b.email, /could not process your \$300\.00 withdrawal/));
    const wb2 = await b.c.post('/api/referrals/withdraw', { amount: 300, coin: 'USDT', address: USDT });
    assert.equal(wb2.status, 200, 'can ask again after a rejection');
    await finance.post(`/api/admin/withdrawals/${wb2.body.id}/reject`, { reason: 'Fraudulent referrals', cancel_earnings: true });
    assert.equal((await bal(b.c)).available, 200, 'reversed');
    const audit = await app.db.one("select * from audit_log where action = 'withdrawal.reject' and target = $1", ['withdrawal:' + wb2.body.id]);
    assert.equal(audit.data.cancel_earnings, true);
  });

  it('switches: withdrawals off, referral program off', async () => {
    const r = await earner(50000);
    await app.setFeature('withdrawals', false);
    try {
      const x = await r.c.post('/api/referrals/withdraw', { amount: 300, coin: 'USDT', address: USDT });
      assert.equal(x.status, 403);
      assert.match(x.body.error, /earnings are safe/);
      assert.equal((await r.c.get('/api/referrals')).body.withdrawals_on, false);
    } finally { await app.setFeature('withdrawals', true); }
    await app.setFeature('referrals', false);
    try { assert.equal((await r.c.get('/api/referrals')).status, 403); } finally { await app.setFeature('referrals', true); }
  });

  it('no commission when the referral program is off', async () => {
    const r = await earner(0);
    const u = await app.loginByEmail(`offref${r.id}@example.com`, { ref: r.c.user.ref_code });
    const ws = await app.ws(u);
    await app.db.query("update workspaces set wallet_cents = 10000, trial_ends_at = now() - interval '1 minute' where id = $1", [ws.id]);
    await app.setFeature('referrals', false);
    try { await app.jobs.billingTick(); } finally { await app.setFeature('referrals', true); }
    assert.equal((await app.db.one('select plan_status from workspaces where id = $1', [ws.id])).plan_status, 'active');
    assert.equal((await app.db.one('select count(*)::int n from referral_ledger where user_id = $1', [r.id])).n, 0);
  });
});

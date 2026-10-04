'use strict';
/* Admin → Users: total spent per person (paid top-ups minus refunds), "Top spenders" sort, money strip. */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { if (app) await app.stop(); });

describe('total spend per user', () => {
  it('counts confirmed payments, minus refunds; sorts top spenders first', async () => {
    const big = await app.loginByEmail('big-spender@example.com');
    const small = await app.loginByEmail('small-spender@example.com');
    const none = await app.loginByEmail('no-spend@example.com');
    void none;
    const bw = await app.ws(big), sw = await app.ws(small);
    const pay = (u, w, ref, cents, status) => app.db.query("insert into payments(workspace_id, user_id, provider, method_key, reference, amount_cents, status, paid_at) values ($1,$2,'paystack','paystack_ng',$3,$4,$5, case when $5 = 'paid' then now() end)", [w.id, u.user.id, ref, cents, status]);
    await pay(big, bw, 'sp-1', 20000, 'paid');
    await pay(big, bw, 'sp-2', 5000, 'paid');
    await pay(big, bw, 'sp-3', 9900, 'failed');   // not counted
    await pay(small, sw, 'sp-4', 1000, 'paid');
    await app.db.query("insert into wallet_tx(workspace_id, kind, amount_cents, cash_cents, note) values ($1,'plan',-4900,-4900,'Growth'), ($1,'refund',-2000,-2000,'Refunded')", [bw.id]);

    const owner = await app.owner();
    const list = await owner.get('/api/admin/users?sort=spent');
    assert.equal(list.status, 200, list.text);
    const ids = list.body.users.map((u) => u.id);
    assert.ok(ids.indexOf(big.user.id) < ids.indexOf(small.user.id), 'top spender first');
    assert.equal(list.body.users.find((u) => u.id === big.user.id).spent, 230);   // 200 + 50 − 20 refund
    assert.equal(list.body.users.find((u) => u.id === small.user.id).spent, 10);

    const d = await owner.get('/api/admin/users/' + big.user.id);
    assert.equal(d.status, 200, d.text);
    assert.deepEqual([d.body.money.paid, d.body.money.plans, d.body.money.refunded, d.body.money.spent, d.body.money.payments], [250, 49, 20, 230, 2]);
  });
});

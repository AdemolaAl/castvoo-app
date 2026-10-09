'use strict';
/*
 * Extra team seats: bought on any paid plan for the rest of the period (prorated, from the wallet, with a receipt),
 * renewed with the plan in the same payment, lowered from the next renewal (never below the seats in use), the seat
 * limit (plan seats + extra seats), the setup helper never counted, Free and trial refused, the admin price
 * (0 = not sold), wallet short, and what the dashboard, the AI and the admin see.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers/app');

let app, billing;
before(async () => { app = await startApp(); billing = app.require('services/billing'); });
after(async () => { if (app) await app.stop(); });
beforeEach(async () => { app.rl._reset(); await app.setSetting('billing', { seat_price_cents: 500 }); });

let seq = 0;
const W = (id) => app.db.one('select * from workspaces where id = $1', [id]);
async function owner({ wallet = 0, plan = 'growth', daysLeft = 15, cycle = 'month', active = true } = {}) {
  const email = `seats${++seq}@example.com`;
  const c = await app.loginByEmail(email, { name: 'Ejiro Owner' });
  const ws = await app.ws(c);
  await app.db.query('update workspaces set wallet_cents = $2 where id = $1', [ws.id, wallet]);
  if (active) {
    await app.db.query("update workspaces set plan_status = 'active', plan_code = $2, billing_cycle = $3, trial_ends_at = null, paid_ever = true, period_end = now() + make_interval(days => $4) where id = $1", [ws.id, plan, cycle, daysLeft]);
  }
  return { c, email, id: ws.id };
}
const seatTx = (id) => app.db.many("select * from wallet_tx where workspace_id = $1 and kind = 'plan' order by id", [id]);
const near = (a, b, d = 2) => assert.ok(Math.abs(a - b) <= d, `${a} ≈ ${b}`);

describe('buying extra seats', () => {
  it('pays the days left of the period from the wallet, sends a receipt, and raises the seat limit', async () => {
    const o = await owner({ wallet: 5000, daysLeft: 15 }); // half of a 30-day month left
    const r = await o.c.post('/api/app/team/seats', { seats: 2 });
    assert.equal(r.status, 200, r.text);
    near(Math.round(r.body.charged * 100), 500); // 2 × $5 × half a month
    assert.match(r.body.message, /Seats added\. \$5\.0\d was paid/);
    const w = await W(o.id);
    assert.equal(w.extra_seats, 2);
    near(Number(w.wallet_cents), 4500);
    const tx = (await seatTx(o.id)).pop();
    assert.match(tx.note, /2 extra team seats \(rest of this period\)/);
    const mail = app.fakes.lastEmail(o.email, /extra team seats/);
    assert.ok(mail, 'receipt email');
    assert.match(mail.text, /Added: 2 extra team seats/);
    assert.match(mail.text, /Price: \$5\.00 a month each, renewed with your plan/);
    assert.match(mail.text, /Paid from wallet: \$5\.0\d/);
    // Limits and the dashboard: Growth has 3 seats, now 5.
    const l = await billing.limits(w);
    assert.equal(l.seats, 5);
    assert.equal(l.plan_seats, 3);
    assert.equal(l.extra_seats, 2);
    const team = (await o.c.get('/api/app/team')).body;
    assert.equal(team.seats, 5);
    assert.equal(team.extra_seats.extra, 2);
    assert.equal(team.extra_seats.price_month, 5);
    assert.equal(team.extra_seats.can_buy, true);
    const plan = (await o.c.get('/api/app/plan')).body;
    assert.equal(plan.limits.seats, 5);
    assert.equal(plan.limits.extra_seats, 2);
    assert.equal(plan.seats.renews, 10);
    assert.ok(await app.db.one("select 1 from audit_log where action = 'workspace.extra_seats' and target = $1", ['workspace:' + o.id]));
  });

  it('a yearly plan pays 12 months a seat, prorated over the year', async () => {
    assert.equal(await billing.seatPrice('month'), 500);
    assert.equal(await billing.seatPrice('year'), 6000);
    const o = await owner({ wallet: 10000, cycle: 'year', daysLeft: 73 }); // a fifth of the year left
    const r = await o.c.post('/api/app/team/seats', { seats: 1 });
    assert.equal(r.status, 200, r.text);
    near(Math.round(r.body.charged * 100), 1200);
  });

  it('a short wallet is refused with the amount needed (the dashboard offers a top-up)', async () => {
    const o = await owner({ wallet: 100, daysLeft: 30 });
    const r = await o.c.post('/api/app/team/seats', { seats: 3 });
    assert.equal(r.status, 402);
    assert.equal(r.body.code, 'wallet_short');
    near(Math.round(r.body.needed * 100), 1500);
    assert.match(r.body.error, /Top up/);
    assert.equal((await W(o.id)).extra_seats, 0, 'nothing changed');
    assert.equal(Number((await W(o.id)).wallet_cents), 100);
  });

  it('Free and the trial have no extra seats (upgrade prompt)', async () => {
    const f = await owner({ active: false });
    await billing.dropToFree(f.id);
    const r = await f.c.post('/api/app/team/seats', { seats: 1 });
    assert.equal(r.status, 402);
    assert.equal(r.body.code, 'seats_paid_plan');
    assert.match(r.body.error, /paid plan/);
    const team = (await f.c.get('/api/app/team')).body;
    assert.equal(team.extra_seats.can_buy, false);
    assert.equal(team.extra_seats.reason, 'free');
    const t = await owner({ active: false, wallet: 5000 }); // still in the trial
    const r2 = await t.c.post('/api/app/team/seats', { seats: 1 });
    assert.equal(r2.status, 402);
    assert.equal(r2.body.code, 'seats_paid_plan');
    assert.match(r2.body.error, /once your paid plan starts/);
    assert.equal((await t.c.get('/api/app/team')).body.extra_seats.reason, 'trial');
  });

  it('only the owner can change seats', async () => {
    const o = await owner({ wallet: 5000 });
    await o.c.post('/api/app/team/invite', { email: `mate${seq}@example.com`, role: 'sender' });
    const mate = await app.loginByEmail(`mate${seq}@example.com`);
    const tok = (await app.db.one('select token from invites where workspace_id = $1 order by created_at desc limit 1', [o.id])).token;
    assert.equal((await mate.post('/api/invites/accept', { token: tok })).status, 200);
    const r = await mate.post('/api/app/team/seats', { seats: 2 }, { headers: { 'x-ws': String(o.id) } });
    assert.equal(r.status, 403);
    assert.equal((await W(o.id)).extra_seats, 0);
  });

  it('refuses a silly number', async () => {
    const o = await owner({ wallet: 5000 });
    assert.equal((await o.c.post('/api/app/team/seats', { seats: -1 })).status, 400);
    assert.equal((await o.c.post('/api/app/team/seats', { seats: 501 })).status, 400);
    assert.equal((await o.c.post('/api/app/team/seats', { seats: 'x' })).status, 400);
  });
});

describe('the seat limit', () => {
  it('counts plan seats + extra seats, and never the setup helper', async () => {
    const o = await owner({ wallet: 5000, plan: 'starter' }); // Starter: 1 seat (the owner)
    const full = await o.c.post('/api/app/team/invite', { email: `a${seq}@example.com`, role: 'sender' });
    assert.equal(full.status, 402);
    assert.equal(full.body.code, 'limit_seats');
    assert.equal(full.body.can_buy_seats, true);
    assert.match(full.body.error, /Add a seat in Settings → Team/);
    // The setup helper is free even when every seat is used.
    assert.equal((await o.c.post('/api/app/team/invite', { email: `h${seq}@example.com`, role: 'helper' })).status, 200);
    assert.equal((await o.c.post('/api/app/team/seats', { seats: 2 })).status, 200);
    assert.equal((await o.c.post('/api/app/team/invite', { email: `a${seq}@example.com`, role: 'sender' })).status, 200);
    assert.equal((await o.c.post('/api/app/team/invite', { email: `b${seq}@example.com`, role: 'drafter' })).status, 200);
    const third = await o.c.post('/api/app/team/invite', { email: `c${seq}@example.com`, role: 'sender' });
    assert.equal(third.status, 402, 'owner + 2 invites = 3 seats used');
    const team = (await o.c.get('/api/app/team')).body;
    assert.equal(team.seats, 3);
    assert.equal(team.seats_used, 3, 'the helper invite is not counted');
    assert.equal(team.extra_seats.taken, 3);
  });

  it('lowering seats: not below the seats in use; from the next renewal; the seats to go cannot be filled', async () => {
    const o = await owner({ wallet: 5000, plan: 'starter' });
    assert.equal((await o.c.post('/api/app/team/seats', { seats: 3 })).status, 200);
    for (const x of ['p', 'q', 'r']) assert.equal((await o.c.post('/api/app/team/invite', { email: `${x}${seq}@example.com`, role: 'sender' })).status, 200);
    const tooLow = await o.c.post('/api/app/team/seats', { seats: 1 });
    assert.equal(tooLow.status, 409);
    assert.equal(tooLow.body.code, 'seats_in_use');
    assert.match(tooLow.body.error, /4 people use seats now/);
    await app.db.query("delete from invites where workspace_id = $1 and email like 'q%' or workspace_id = $1 and email like 'r%'", [o.id]);
    const low = await o.c.post('/api/app/team/seats', { seats: 1 });
    assert.equal(low.status, 200, low.text);
    assert.equal(low.body.charged, 0, 'nothing refunded or charged');
    assert.match(low.body.message, /1 extra seat from your next renewal/);
    const w = await W(o.id);
    assert.equal(w.extra_seats, 3, 'the seats stay until the renewal');
    assert.equal(w.pending_extra_seats, 1);
    // 2 seats taken (owner + 1 invite), room for invites = 1 + min(3, 1) = 2: full.
    const inv = await o.c.post('/api/app/team/invite', { email: `s${seq}@example.com`, role: 'sender' });
    assert.equal(inv.status, 402);
    // Same number as now: cancels the lower number.
    const keep = await o.c.post('/api/app/team/seats', { seats: 3 });
    assert.equal(keep.status, 200);
    assert.equal((await W(o.id)).pending_extra_seats, null);
  });
});

describe('renewal', () => {
  it('renews the extra seats with the plan in one wallet payment, with the seat line on the receipt', async () => {
    const o = await owner({ wallet: 20000, daysLeft: 30 });
    assert.equal((await o.c.post('/api/app/team/seats', { seats: 3 })).status, 200);
    const before = Number((await W(o.id)).wallet_cents);
    await app.db.query("update workspaces set period_end = now() - interval '1 minute' where id = $1", [o.id]);
    await app.jobs.billingTick();
    const w = await W(o.id);
    assert.equal(w.plan_status, 'active');
    assert.equal(w.extra_seats, 3);
    assert.equal(before - Number(w.wallet_cents), 4900 + 1500, 'Growth $49 + 3 × $5');
    const tx = (await seatTx(o.id)).pop();
    assert.equal(Number(tx.amount_cents), -6400);
    assert.match(tx.note, /Growth plan · monthly \+ 3 extra seats/);
    const mail = app.fakes.lastEmail(o.email, /Receipt for your Growth plan/);
    assert.match(mail.text, /Extra team seats: 3 seats × \$5\.00 = \$15\.00/);
    assert.match(mail.text, /Paid from wallet: \$64\.00/);
  });

  it('a lower number asked for starts at the renewal', async () => {
    const o = await owner({ wallet: 20000, daysLeft: 30 });
    await o.c.post('/api/app/team/seats', { seats: 2 });
    await o.c.post('/api/app/team/seats', { seats: 0 });
    const before = Number((await W(o.id)).wallet_cents);
    await app.db.query("update workspaces set period_end = now() - interval '1 minute' where id = $1", [o.id]);
    await app.jobs.billingTick();
    const w = await W(o.id);
    assert.equal(w.extra_seats, 0);
    assert.equal(w.pending_extra_seats, null);
    assert.equal(before - Number(w.wallet_cents), 4900, 'only the plan');
    assert.match(app.fakes.lastEmail(o.email, /Receipt for your Growth plan/).text, /Extra team seats: None/);
  });

  it('the low-balance reminder counts the seats; a short wallet drops to Free and the seats end', async () => {
    const o = await owner({ wallet: 20000, daysLeft: 30 });
    await o.c.post('/api/app/team/seats', { seats: 4 });
    await app.db.query("update workspaces set wallet_cents = 5000, reminded_at = null, period_end = now() + interval '2 days' where id = $1", [o.id]);
    await app.jobs.billingTick();
    const remind = app.fakes.lastEmail(o.email, /Top up before/);
    assert.ok(remind && /\$69\.00/.test(remind.text), 'the reminder asks for $49 + 4 × $5 = $69 (wallet has $50)');
    await app.db.query("update workspaces set period_end = now() - interval '1 minute' where id = $1", [o.id]);
    await app.jobs.billingTick();
    const w = await W(o.id);
    assert.equal(w.plan_code, 'free');
    assert.equal(w.extra_seats, 0);
    assert.equal(Number(w.wallet_cents), 5000, 'nothing charged');
  });
});

describe('admin price', () => {
  it('Admin → Settings → Billing sets the price; the public config, the AI and the pricing note follow it', async () => {
    const admin = await app.owner();
    const cur = (await admin.get('/api/admin/settings')).body.settings.billing;
    const r = await admin.put('/api/admin/settings/billing', { value: { min_topup: cur.min_topup_cents / 100, max_topup: cur.max_topup_cents / 100, refund_days: cur.refund_days, data_retention_days: cur.data_retention_days, renew_reminder_days: cur.renew_reminder_days, seat_price: 7 } });
    assert.equal(r.status, 200, r.text);
    app.settings.bust();
    assert.equal((await app.settings.get('billing')).seat_price_cents, 700);
    assert.equal((await app.client().get('/api/public/config')).body.billing.seat_price, 7);
    assert.match(await app.require('services/ai').plansText(), /Extra team seats: \$7 a month per seat on any paid plan \(yearly plans: \$84 a year per seat\)/);
    const o = await owner({ wallet: 5000, daysLeft: 30 });
    near(Math.round((await o.c.post('/api/app/team/seats', { seats: 1 })).body.charged * 100), 700);
  });

  it('0 = not sold: no new seats, and seats already bought end at their next renewal', async () => {
    const o = await owner({ wallet: 20000, daysLeft: 30 });
    await o.c.post('/api/app/team/seats', { seats: 2 });
    await app.setSetting('billing', { seat_price_cents: 0 });
    const r = await o.c.post('/api/app/team/seats', { seats: 3 });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'seats_off');
    const team = (await o.c.get('/api/app/team')).body;
    assert.equal(team.extra_seats.on_sale, false);
    assert.equal((await app.client().get('/api/public/config')).body.billing.seat_price, 0);
    assert.doesNotMatch(await app.require('services/ai').plansText(), /Extra team seats/);
    const before = Number((await W(o.id)).wallet_cents);
    await app.db.query("update workspaces set period_end = now() - interval '1 minute' where id = $1", [o.id]);
    await app.jobs.billingTick();
    const w = await W(o.id);
    assert.equal(w.extra_seats, 0);
    assert.equal(before - Number(w.wallet_cents), 4900);
  });

  it('the admin user view shows the extra seats', async () => {
    const o = await owner({ wallet: 5000 });
    await o.c.post('/api/app/team/seats', { seats: 2 });
    const admin = await app.owner();
    const u = (await admin.get('/api/admin/users/' + o.c.user.id)).body;
    assert.equal(u.workspaces[0].extra_seats, 2);
  });
});

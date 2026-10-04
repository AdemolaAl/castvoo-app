'use strict';
/* Billing: trials, renewals, pausing, cancelling, upgrades, downgrades, coupons, bonus credit, commissions, data purge. */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startApp, FILES } = require('../helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { if (app) await app.stop(); });
beforeEach(() => app.rl._reset());

let seq = 0;
async function customer({ wallet = 0, bonus = 0, ref = null, prefix = 'cust' } = {}) {
  const email = `${prefix}${++seq}@example.com`;
  const c = await app.loginByEmail(email, ref ? { ref } : {});
  const ws = await app.ws(c);
  await app.db.query('update workspaces set wallet_cents = $2, bonus_cents = $3 where id = $1', [ws.id, wallet, bonus]);
  return { c, email, ws, id: ws.id };
}
const W = (id) => app.db.one('select * from workspaces where id = $1', [id]);
const endTrial = (id) => app.db.query("update workspaces set trial_ends_at = now() - interval '1 minute' where id = $1", [id]);
const endPeriod = (id) => app.db.query("update workspaces set period_end = now() - interval '1 minute' where id = $1", [id]);
const planTx = (id) => app.db.many("select * from wallet_tx where workspace_id = $1 and kind = 'plan' order by id", [id]);
const daysFromNow = (d) => (new Date(d) - Date.now()) / 86400000;
async function makeActive(id, { plan = 'growth', daysLeft = 15, cycle = 'month' } = {}) {
  await app.db.query("update workspaces set plan_status = 'active', plan_code = $2, billing_cycle = $3, trial_ends_at = null, paid_ever = true, period_end = now() + make_interval(days => $4) where id = $1", [id, plan, cycle, daysLeft]);
}

describe('trial', () => {
  it('reminds once, two days before the end (even with two servers running the job)', async () => {
    const u = await customer({ wallet: 1000 });
    await app.db.query("update workspaces set trial_ends_at = now() + interval '1 day' where id = $1", [u.id]);
    await Promise.all([app.jobs.billingTick(), app.jobs.billingTick()]);
    await app.jobs.billingTick();
    const mails = app.fakes.emailsTo(u.email).filter((e) => /trial ends on/.test(e.subject));
    assert.equal(mails.length, 1);
    assert.match(mails[0].text, /\$10\.00/, 'shows the wallet balance');
    assert.match(mails[0].text, /\$49\.00/);
  });

  it('trial ends with money in the wallet: plan starts, receipt, referrer earns 10% once', async () => {
    const referrer = await customer({ prefix: 'ref' });
    const u = await customer({ wallet: 10000, ref: referrer.c.user.ref_code });
    await app.db.query('update workspaces set ai_used = 40 where id = $1', [u.id]);
    await endTrial(u.id);
    await Promise.all([app.jobs.billingTick(), app.jobs.billingTick()]);
    await app.jobs.billingTick();
    const w = await W(u.id);
    assert.equal(w.plan_status, 'active');
    assert.equal(w.plan_code, 'growth');
    assert.equal(w.trial_ends_at, null);
    assert.equal(w.paid_ever, true);
    assert.equal(w.ai_used, 0);
    assert.ok(Math.abs(daysFromNow(w.period_end) - 30) < 0.01);
    assert.equal(Number(w.wallet_cents), 10000 - 4900, 'charged exactly once');
    assert.equal((await planTx(u.id)).length, 1);
    const receipt = app.fakes.emailsTo(u.email).filter((e) => /Receipt for your Growth plan/.test(e.subject));
    assert.equal(receipt.length, 1);
    assert.match(receipt[0].text, /\$49\.00/);
    const led = await app.db.many("select * from referral_ledger where user_id = $1 and kind = 'earning'", [referrer.c.user.id]);
    assert.equal(led.length, 1);
    assert.equal(Number(led[0].amount_cents), 490);
    assert.equal(led[0].rate, 10);
    assert.ok(Math.abs(daysFromNow(led[0].settles_at) - 30) < 0.01, 'settles after 30 days');
    assert.ok(app.fakes.lastEmail(referrer.email, /You earned \$4\.90/));
  });

  it('commission rate grows with paying referrals: 20% from 5, 30% from 20', async () => {
    for (const [existing, rate] of [[3, 10], [5, 20], [20, 30]]) {
      const referrer = await customer({ prefix: 'tier' });
      const rid = referrer.c.user.id;
      for (let i = 0; i < existing; i++) {
        const u = await app.db.one("insert into users(email, name, ref_code, referred_by) values ($1, 'P', $2, $3) returning id", [`paying${rid}-${i}@example.com`, `p${rid}x${i}`, rid]);
        await app.db.query("insert into workspaces(name, owner_user_id, plan_code, plan_status, paid_ever, period_end) values ('W', $1, 'growth', 'active', true, now() + interval '10 days')", [u.id]);
      }
      const u = await customer({ wallet: 4900, ref: referrer.c.user.ref_code });
      await endTrial(u.id);
      await app.jobs.billingTick();
      const led = await app.db.one("select rate, amount_cents from referral_ledger where user_id = $1 and from_workspace_id = $2", [rid, u.id]);
      assert.equal(led.rate, rate, `${existing} paying referrals`);
      assert.equal(Number(led.amount_cents), Math.floor(4900 * rate / 100));
    }
  });

  it('trial ends with an empty wallet: paused, "trial ended" email, nothing charged', async () => {
    const u = await customer({ wallet: 4899 });
    await endTrial(u.id);
    await app.jobs.billingTick();
    const w = await W(u.id);
    assert.equal(w.plan_status, 'paused');
    assert.equal(Number(w.wallet_cents), 4899);
    assert.ok(app.fakes.lastEmail(u.email, /trial has ended/));
    // Topping up later + picking the plan starts it.
    await app.db.query('update workspaces set wallet_cents = 6000 where id = $1', [u.id]);
    const r = await u.c.post('/api/app/plan', { plan: 'growth' });
    assert.equal(r.status, 200, r.text);
    assert.equal((await W(u.id)).plan_status, 'active');
    assert.equal(Number((await W(u.id)).wallet_cents), 1100);
  });

  it('a plan picked during the trial starts (and is paid) when the trial ends; or right away with start_now', async () => {
    const u = await customer({ wallet: 5000 });
    const r = await u.c.post('/api/app/plan', { plan: 'starter' });
    assert.match(r.body.message, /starts when your free trial ends/);
    assert.equal((await W(u.id)).pending_plan_code, 'starter');
    await endTrial(u.id);
    await app.jobs.billingTick();
    const w = await W(u.id);
    assert.equal(w.plan_code, 'starter');
    assert.equal(Number(w.wallet_cents), 5000 - 1900);
    assert.equal(w.pending_plan_code, null);

    const v = await customer({ wallet: 100000 });
    const now = await v.c.post('/api/app/plan', { plan: 'scale', cycle: 'year', start_now: true });
    assert.equal(now.status, 200);
    const wv = await W(v.id);
    assert.equal(wv.plan_status, 'active');
    assert.equal(wv.billing_cycle, 'year');
    assert.equal(Number(wv.wallet_cents), 100000 - 99000);
    assert.ok(Math.abs(daysFromNow(wv.period_end) - 365) < 0.01);
    assert.equal((await v.c.post('/api/app/plan', { plan: 'nope' })).status, 400);
  });

  it('a trial whose plan was switched off in admin pauses instead of failing forever', async () => {
    const u = await customer({ wallet: 100000 });
    await app.db.query("insert into plans(code, name, price_month_cents, price_year_cents, connections, subscribers, ai_writes, seats, active) values ('retired','Retired',500,5000,1,100,0,1,false) on conflict do nothing");
    app.settings.bust();
    await app.db.query("update workspaces set pending_plan_code = 'retired' where id = $1", [u.id]);
    await endTrial(u.id);
    await app.jobs.billingTick();
    assert.equal((await W(u.id)).plan_status, 'paused');
  });
});

describe('renewals', () => {
  it('renews from the wallet, and only once with two servers', async () => {
    const u = await customer({ wallet: 20000 });
    await makeActive(u.id);
    await endPeriod(u.id);
    await Promise.all([app.jobs.billingTick(), app.jobs.billingTick()]);
    const w = await W(u.id);
    assert.equal(w.plan_status, 'active');
    assert.equal(Number(w.wallet_cents), 20000 - 4900);
    assert.ok(Math.abs(daysFromNow(w.period_end) - 30) < 0.01);
    assert.equal((await planTx(u.id)).length, 1);
  });

  it('low balance reminder before renewal (once), then pause when the money is short', async () => {
    const u = await customer({ wallet: 1000 });
    await makeActive(u.id, { daysLeft: 2 });
    await Promise.all([app.jobs.billingTick(), app.jobs.billingTick()]);
    await app.jobs.billingTick();
    assert.equal(app.fakes.emailsTo(u.email).filter((e) => /Top up before/.test(e.subject)).length, 1);
    const rich = await customer({ wallet: 100000 });
    await makeActive(rich.id, { daysLeft: 2 });
    await app.jobs.billingTick();
    assert.equal(app.fakes.emailsTo(rich.email).filter((e) => /Top up before/.test(e.subject)).length, 0, 'no reminder when the wallet covers it');

    await endPeriod(u.id);
    await app.jobs.billingTick();
    assert.equal((await W(u.id)).plan_status, 'paused');
    assert.ok(app.fakes.lastEmail(u.email, /could not renew your Growth plan/));
    assert.equal(Number((await W(u.id)).wallet_cents), 1000);
  });

  it('cancel at period end: runs to the end, then stops; resume undoes it', async () => {
    const u = await customer({ wallet: 100000 });
    await makeActive(u.id);
    assert.equal((await u.c.post('/api/app/plan/cancel')).status, 200);
    assert.equal((await W(u.id)).cancel_at_period_end, true);
    await u.c.post('/api/app/plan/cancel', { resume: true });
    assert.equal((await W(u.id)).cancel_at_period_end, false);
    await u.c.post('/api/app/plan/cancel');
    await app.jobs.billingTick();
    assert.equal((await W(u.id)).plan_status, 'active', 'still active until the end');
    await endPeriod(u.id);
    await app.jobs.billingTick();
    const w = await W(u.id);
    assert.equal(w.plan_status, 'cancelled');
    assert.equal(Number(w.wallet_cents), 100000, 'not charged');
  });

  it('upgrade mid-period pays the difference for the days left; commission on it', async () => {
    const referrer = await customer({ prefix: 'upref' });
    const u = await customer({ wallet: 10000, ref: referrer.c.user.ref_code });
    await makeActive(u.id, { daysLeft: 15 });
    const r = await u.c.post('/api/app/plan', { plan: 'scale' });
    assert.equal(r.status, 200, r.text);
    assert.match(r.body.message, /Upgraded to Scale/);
    const w = await W(u.id);
    assert.equal(w.plan_code, 'scale');
    const charged = 10000 - Number(w.wallet_cents);
    assert.ok(Math.abs(charged - 2500) <= 1, 'half of $50 difference, got ' + charged);
    assert.ok(Math.abs(daysFromNow(w.period_end) - 15) < 0.01, 'period end unchanged');
    const led = await app.db.one('select amount_cents from referral_ledger where user_id = $1', [referrer.c.user.id]);
    assert.equal(Number(led.amount_cents), Math.floor(charged * 0.1));
    // Not enough money for the upgrade.
    const poor = await customer({ wallet: 100 });
    await makeActive(poor.id, { daysLeft: 15 });
    const p = await poor.c.post('/api/app/plan', { plan: 'scale' });
    assert.equal(p.status, 402);
    assert.equal(p.body.code, 'wallet_short');
    assert.equal((await W(poor.id)).plan_code, 'growth');
  });

  it('downgrade waits for the next renewal and is charged at the new price', async () => {
    const u = await customer({ wallet: 10000 });
    await makeActive(u.id);
    const r = await u.c.post('/api/app/plan', { plan: 'starter' });
    assert.match(r.body.message, /starts at your next renewal/);
    let w = await W(u.id);
    assert.equal(w.plan_code, 'growth');
    assert.equal(w.pending_plan_code, 'starter');
    assert.equal(Number(w.wallet_cents), 10000);
    await endPeriod(u.id);
    await app.jobs.billingTick();
    w = await W(u.id);
    assert.equal(w.plan_code, 'starter');
    assert.equal(Number(w.wallet_cents), 10000 - 1900);
    assert.equal(w.pending_plan_code, null);
  });

  it('bonus credit is spent before cash; commission only on the cash part', async () => {
    const referrer = await customer({ prefix: 'bonusref' });
    const u = await customer({ wallet: 10000, bonus: 2000, ref: referrer.c.user.ref_code });
    await endTrial(u.id);
    await app.jobs.billingTick();
    const w = await W(u.id);
    assert.equal(Number(w.bonus_cents), 0);
    assert.equal(Number(w.wallet_cents), 10000 - 2900);
    const tx = (await planTx(u.id))[0];
    assert.deepEqual([Number(tx.amount_cents), Number(tx.cash_cents), Number(tx.bonus_part_cents)], [-4900, -2900, -2000]);
    const led = await app.db.one('select amount_cents from referral_ledger where user_id = $1', [referrer.c.user.id]);
    assert.equal(Number(led.amount_cents), 290);
  });

  it('only the workspace owner changes the plan', async () => {
    const u = await customer({ wallet: 10000 });
    const inv = await u.c.post('/api/app/team/invite', { email: `planmember${seq}@example.com`, role: 'sender' });
    const m = await app.loginByEmail(`planmember${seq}@example.com`);
    const acc = await m.post('/api/invites/accept', { token: inv.body.link.split('#join/')[1] });
    const h = { headers: { 'x-ws': String(acc.body.workspace_id) } };
    assert.equal((await m.post('/api/app/plan', { plan: 'scale', start_now: true }, h)).status, 403);
    assert.equal((await m.post('/api/app/plan/cancel', {}, h)).status, 403);
    assert.equal((await m.post('/api/app/coupon', { code: 'COMEBACK20' }, h)).status, 403);
  });
});

describe('coupons', () => {
  it('percent off for N payments, then full price; cannot be used twice', async () => {
    const owner = await app.owner();
    const o = await owner.post('/api/admin/offers', { kind: 'coupon', title: 'Two months 50%', code: 'half2', percent: 50, months: 2 });
    assert.equal(o.status, 200, o.text);
    const u = await customer({ wallet: 20000 });
    const r = await u.c.post('/api/app/coupon', { code: 'HALF2' });
    assert.equal(r.status, 200, r.text);
    assert.match(r.body.message, /50% off your next 2 plan payments/);
    const plan = await u.c.get('/api/app/plan');
    assert.deepEqual(plan.body.coupon, { code: 'HALF2', percent: 50, months_left: 2 });
    await endTrial(u.id);
    await app.jobs.billingTick();
    assert.equal(Number((await W(u.id)).wallet_cents), 20000 - 2450);
    await endPeriod(u.id);
    await app.jobs.billingTick();
    assert.equal(Number((await W(u.id)).wallet_cents), 20000 - 4900);
    let w = await W(u.id);
    assert.equal(w.coupon_id, null);
    assert.equal(w.coupon_months_left, 0);
    await endPeriod(u.id);
    await app.jobs.billingTick();
    w = await W(u.id);
    assert.equal(Number(w.wallet_cents), 20000 - 4900 - 4900, 'full price after the coupon');
    const again = await u.c.post('/api/app/coupon', { code: 'HALF2' });
    assert.equal(again.status, 400);
    assert.match(again.body.error, /already used/);
    assert.equal((await u.c.post('/api/app/coupon', { code: 'NOPE' })).status, 400);
  });

  it('max uses: the code runs out, even when several people use it at the same moment', async () => {
    const owner = await app.owner();
    await owner.post('/api/admin/offers', { kind: 'coupon', title: 'Only two', code: 'ONLY2', percent: 10, max_uses: 2 });
    const people = await Promise.all([1, 2, 3, 4].map(() => customer()));
    const rs = await Promise.all(people.map((p) => p.c.post('/api/app/coupon', { code: 'only2' })));
    assert.equal(rs.filter((r) => r.status === 200).length, 2);
    assert.ok(rs.filter((r) => r.status === 400).every((r) => /used up|not valid/.test(r.body.error)));
    assert.equal((await app.db.one("select uses from offers where code = 'ONLY2'")).uses, 2);
  });

  it('the same person cannot redeem one code twice at the same moment', async () => {
    const u = await customer();
    const rs = await Promise.all([1, 2, 3].map(() => u.c.post('/api/app/coupon', { code: 'COMEBACK20' })));
    assert.equal(rs.filter((r) => r.status === 200).length, 1);
  });
});

describe('data retention', () => {
  it('a workspace paused for longer than the retention period loses its data (and files), payments stay', async () => {
    const u = await customer({ wallet: 0 });
    const bot = await app.connectBot(u.c);
    await app.start(bot.connId, 88001);
    const m = await u.c.post('/api/media', FILES.jpg(), { headers: { 'content-type': 'image/jpeg' } });
    const file = (await app.db.one('select path from media where id = $1', [m.body.media.id])).path;
    assert.ok(fs.existsSync(file));
    await u.c.post('/api/broadcasts', { connection_id: bot.connId, body: 'hi' });
    await app.db.query("insert into wallet_tx(workspace_id, kind, amount_cents, note) values ($1, 'topup', 100, 'kept')", [u.id]);
    await app.db.query("update workspaces set plan_status = 'paused', period_end = now() - interval '59 days' where id = $1", [u.id]);
    await app.jobs.billingTick();
    assert.equal((await W(u.id)).purged_at, null, 'not yet at 59 days');
    await app.db.query("update workspaces set period_end = now() - interval '61 days' where id = $1", [u.id]);
    await app.jobs.billingTick();
    const w = await W(u.id);
    assert.ok(w.purged_at);
    assert.equal((await app.db.one('select count(*)::int n from subscribers where connection_id = $1', [bot.connId])).n, 0);
    assert.equal((await app.db.one('select status from connections where id = $1', [bot.connId])).status, 'removed');
    assert.ok(app.fakes.tgCalls('deleteWebhook', bot.token).length >= 1);
    assert.equal((await app.db.one('select count(*)::int n from broadcasts where workspace_id = $1', [u.id])).n, 0);
    assert.equal((await app.db.one('select count(*)::int n from media where workspace_id = $1', [u.id])).n, 0);
    assert.ok(!fs.existsSync(file), 'uploaded file deleted from disk');
    assert.equal((await app.db.one("select count(*)::int n from wallet_tx where workspace_id = $1", [u.id])).n, 1, 'money records kept');
    // Runs once.
    await app.jobs.billingTick();
  });
});

describe('price changes', () => {
  it('raising a price: people already paying get an email and keep the old price for 30 days', async () => {
    const u = await customer({ wallet: 40000, prefix: 'pricelock' });
    await makeActive(u.id, { plan: 'scale', daysLeft: 3 });
    const admin = await app.staff('admin');
    const plans = (await admin.get('/api/admin/plans')).body.plans;
    const scale = plans.find((p) => p.code === 'scale');
    const body = { ...scale, price_month: 129, price_year: scale.price_year, bullets: scale.bullets };
    const r = await admin.put('/api/admin/plans/scale', body);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.customers_notified >= 1, true);
    const mail = app.fakes.emailsTo(u.email).find((e) => /price is changing/.test(e.subject));
    assert.ok(mail, 'notice email sent');
    assert.match(mail.text, /\$99\.00/);
    assert.match(mail.text, /\$129\.00/);
    // Renewal inside the 30 days is still charged at the old price.
    await endPeriod(u.id);
    await app.jobs.billingTick();
    const tx = await planTx(u.id);
    assert.equal(Number(tx[tx.length - 1].amount_cents), -9900);
    // After the notice period the new price applies.
    await app.db.query("update workspaces set locked_until = now() - interval '1 minute' where id = $1", [u.id]);
    await endPeriod(u.id);
    await app.jobs.billingTick();
    const tx2 = await planTx(u.id);
    assert.equal(Number(tx2[tx2.length - 1].amount_cents), -12900);
    // Put the price back for the other tests.
    await admin.put('/api/admin/plans/scale', { ...body, price_month: 99 });
  });
});

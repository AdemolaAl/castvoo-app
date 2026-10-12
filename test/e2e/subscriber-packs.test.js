'use strict';
/*
 * Subscriber packs on the Scale plan: +50,000 bot subscribers for $29 a month each, up to 8. Bought for the rest of the
 * period (prorated, from the wallet, with a receipt), renewed with the plan, lowered from the next renewal (nothing
 * deleted), a short wallet at renewal drops to Free like seats, Starter/Growth told to upgrade, the limit math, the
 * 402 that offers a pack (or "talk to us"), broadcasts allowed again after a pack, the admin's packs and custom limit,
 * commission like seats, the support link whitelist and what the AI knows.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp } = require('../helpers/app');

let app, billing;
before(async () => { app = await startApp(); billing = app.require('services/billing'); });
after(async () => { if (app) await app.stop(); });
beforeEach(async () => {
  app.rl._reset();
  await app.setSetting('billing', { seat_price_cents: 500, sub_pack_size: 50000, sub_pack_price_cents: 2900, sub_pack_max: 8 });
});

let seq = 0;
const W = (id) => app.db.one('select * from workspaces where id = $1', [id]);
async function owner({ wallet = 0, plan = 'scale', daysLeft = 15, cycle = 'month', active = true, ref = null } = {}) {
  const email = `packs${++seq}@example.com`;
  const c = await app.loginByEmail(email, ref ? { name: 'Pack Owner', ref } : { name: 'Pack Owner' });
  const ws = await app.ws(c);
  await app.db.query('update workspaces set wallet_cents = $2 where id = $1', [ws.id, wallet]);
  if (active) {
    await app.db.query("update workspaces set plan_status = 'active', plan_code = $2, billing_cycle = $3, trial_ends_at = null, paid_ever = true, period_end = now() + make_interval(days => $4) where id = $1", [ws.id, plan, cycle, daysLeft]);
  }
  return { c, email, id: ws.id };
}
const planTx = (id) => app.db.many("select * from wallet_tx where workspace_id = $1 and kind = 'plan' order by id", [id]);
const near = (a, b, d = 2) => assert.ok(Math.abs(a - b) <= d, `${a} ≈ ${b}`);

describe('limit math', () => {
  it('Scale = 100,000 + 50,000 × packs, for the plan meter and the bots limit; packs count only on an active Scale plan', async () => {
    const o = await owner();
    await app.db.query('update workspaces set subscriber_packs = 2 where id = $1', [o.id]);
    const l = await billing.limits(await W(o.id));
    assert.equal(l.subscribers, 200000);
    assert.equal(l.plan_subscribers, 100000);
    assert.equal(l.subscriber_packs, 2);
    assert.equal(l.bots.max_bot_subscribers, 200000);
    assert.equal(l.bots.plan_max_bot_subscribers, 100000);
    const plan = (await o.c.get('/api/app/plan')).body;
    assert.equal(plan.limits.subscribers, 200000);
    assert.equal(plan.limits.subscriber_grace, 220000);
    assert.equal(plan.packs.current, 2);
    assert.equal(plan.packs.renews, 58);
    assert.equal(plan.packs.max_total, 500000);
    // Packs left on the row don't count on another plan, in the trial or on Free.
    await app.db.query("update workspaces set plan_code = 'growth' where id = $1", [o.id]);
    assert.equal((await billing.limits(await W(o.id))).subscribers, 25000);
    await app.db.query("update workspaces set plan_code = 'scale', plan_status = 'trial', trial_ends_at = now() + interval '3 days' where id = $1", [o.id]);
    assert.equal((await billing.limits(await W(o.id))).subscribers, 100000);
  });
});

describe('buying packs', () => {
  it('pays the days left of the period from the wallet, sends a receipt, and raises the limit', async () => {
    const o = await owner({ wallet: 10000, daysLeft: 15 }); // half of a 30-day month
    const before = (await o.c.get('/api/app/plan')).body.packs;
    assert.equal(before.can_buy, true);
    near(Math.round(before.one_now * 100), 1450);
    const r = await o.c.post('/api/app/plan/packs', { packs: 2 });
    assert.equal(r.status, 200, r.text);
    near(Math.round(r.body.charged * 100), 2900); // 2 × $29 × half a month
    assert.match(r.body.message, /up to 200,000 bot subscribers/);
    const w = await W(o.id);
    assert.equal(w.subscriber_packs, 2);
    near(Number(w.wallet_cents), 7100);
    const tx = (await planTx(o.id)).pop();
    assert.match(tx.note, /2 subscriber packs \(\+100,000 bot subscribers, rest of this period\)/);
    const mail = app.fakes.lastEmail(o.email, /subscriber packs/);
    assert.ok(mail, 'receipt email');
    assert.match(mail.text, /Added: 2 subscriber packs \(\+100,000 bot subscribers\)/);
    assert.match(mail.text, /Bot subscribers you can have now: 200,000/);
    assert.match(mail.text, /Price: \$29\.00 a month each, renewed with your plan/);
    assert.equal((await billing.limits(w)).subscribers, 200000);
    assert.ok(await app.db.one("select 1 from audit_log where action = 'workspace.subscriber_packs' and target = $1", ['workspace:' + o.id]));
  });

  it('a yearly plan pays 12 months a pack, prorated over the year', async () => {
    assert.equal(await billing.packPrice('year'), 34800);
    const o = await owner({ wallet: 20000, cycle: 'year', daysLeft: 73 }); // a fifth of the year
    const r = await o.c.post('/api/app/plan/packs', { packs: 1 });
    assert.equal(r.status, 200, r.text);
    near(Math.round(r.body.charged * 100), 6960);
  });

  it('a short wallet is refused with the amount needed, nothing changes', async () => {
    const o = await owner({ wallet: 100, daysLeft: 30 });
    const r = await o.c.post('/api/app/plan/packs', { packs: 1 });
    assert.equal(r.status, 402);
    assert.equal(r.body.code, 'wallet_short');
    near(Math.round(r.body.needed * 100), 2900);
    assert.equal((await W(o.id)).subscriber_packs, 0);
    assert.equal(Number((await W(o.id)).wallet_cents), 100);
  });

  it('Starter, Growth, Free and the trial are told to upgrade to Scale first', async () => {
    for (const plan of ['starter', 'growth']) {
      const o = await owner({ wallet: 10000, plan });
      const r = await o.c.post('/api/app/plan/packs', { packs: 1 });
      assert.equal(r.status, 402, plan);
      assert.equal(r.body.code, 'packs_scale_only');
      assert.match(r.body.error, /Upgrade to Scale first: it includes 100,000 bot subscribers/);
      const info = (await o.c.get('/api/app/plan')).body.packs;
      assert.deepEqual([info.can_buy, info.reason, info.top_plan_name], [false, 'not_top_plan', 'Scale']);
      assert.equal((await W(o.id)).subscriber_packs, 0);
    }
    const f = await owner({ active: false });
    await billing.dropToFree(f.id);
    assert.equal((await f.c.post('/api/app/plan/packs', { packs: 1 })).body.code, 'packs_scale_only');
    const t = await owner({ active: false, wallet: 10000 });
    await app.db.query("update workspaces set plan_code = 'scale' where id = $1", [t.id]);
    const r2 = await t.c.post('/api/app/plan/packs', { packs: 1 });
    assert.equal(r2.status, 402);
    assert.match(r2.body.error, /once your paid Scale plan starts/);
  });

  it('refuses more than the most packs (talk to us) and silly numbers; a teammate cannot buy', async () => {
    const o = await owner({ wallet: 50000 });
    const r = await o.c.post('/api/app/plan/packs', { packs: 9 });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /between 0 and 8 subscriber packs.*Talk to us/);
    assert.equal((await o.c.post('/api/app/plan/packs', { packs: -1 })).status, 400);
    assert.equal((await o.c.post('/api/app/plan/packs', { packs: 'x' })).status, 400);
    await o.c.post('/api/app/team/invite', { email: `packmate${seq}@example.com`, role: 'sender' });
    const mate = await app.loginByEmail(`packmate${seq}@example.com`);
    const tok = (await app.db.one('select token from invites where workspace_id = $1 order by created_at desc limit 1', [o.id])).token;
    assert.equal((await mate.post('/api/invites/accept', { token: tok })).status, 200);
    assert.equal((await mate.post('/api/app/plan/packs', { packs: 1 }, { headers: { 'x-ws': String(o.id) } })).status, 403);
    assert.equal((await W(o.id)).subscriber_packs, 0);
  });
});

describe('renewal', () => {
  it('renews the packs with the plan in one wallet payment, with the pack line on the receipt', async () => {
    const o = await owner({ wallet: 50000, daysLeft: 30 });
    assert.equal((await o.c.post('/api/app/plan/packs', { packs: 2 })).status, 200);
    const before = Number((await W(o.id)).wallet_cents);
    await app.db.query("update workspaces set period_end = now() - interval '1 minute' where id = $1", [o.id]);
    await app.jobs.billingTick();
    const w = await W(o.id);
    assert.equal(w.plan_status, 'active');
    assert.equal(w.subscriber_packs, 2);
    assert.equal(before - Number(w.wallet_cents), 9900 + 5800, 'Scale $99 + 2 × $29');
    const tx = (await planTx(o.id)).pop();
    assert.match(tx.note, /Scale plan · monthly \+ 2 subscriber packs/);
    const mail = app.fakes.lastEmail(o.email, /Receipt for your Scale plan/);
    assert.match(mail.text, /Subscriber packs: 2 packs × \$29\.00 = \$58\.00 \(\+100,000 bot subscribers\)/);
    assert.match(mail.text, /Paid from wallet: \$157\.00/);
  });

  it('fewer packs start at the next renewal (nothing refunded or deleted)', async () => {
    const o = await owner({ wallet: 50000, daysLeft: 30 });
    await o.c.post('/api/app/plan/packs', { packs: 3 });
    const low = await o.c.post('/api/app/plan/packs', { packs: 1 });
    assert.equal(low.status, 200, low.text);
    assert.equal(low.body.charged, 0);
    assert.match(low.body.message, /1 subscriber pack from your next renewal\. Nothing is deleted/);
    let w = await W(o.id);
    assert.deepEqual([w.subscriber_packs, w.pending_subscriber_packs], [3, 1]);
    assert.equal((await billing.limits(w)).subscribers, 250000, 'the packs stay until the renewal');
    const before = Number(w.wallet_cents);
    await app.db.query("update workspaces set period_end = now() - interval '1 minute' where id = $1", [o.id]);
    await app.jobs.billingTick();
    w = await W(o.id);
    assert.deepEqual([w.subscriber_packs, w.pending_subscriber_packs], [1, null]);
    assert.equal(before - Number(w.wallet_cents), 9900 + 2900);
  });

  it('the reminder counts the packs; a short wallet drops to Free like seats and the packs end (nothing deleted)', async () => {
    const o = await owner({ wallet: 50000, daysLeft: 30 });
    await o.c.post('/api/app/plan/packs', { packs: 2 });
    await app.db.query("update workspaces set wallet_cents = 10000, reminded_at = null, period_end = now() + interval '2 days' where id = $1", [o.id]);
    await app.jobs.billingTick();
    const remind = app.fakes.lastEmail(o.email, /Top up before/);
    assert.ok(remind && /\$157\.00/.test(remind.text), 'the reminder asks for $99 + 2 × $29');
    await app.db.query("update workspaces set period_end = now() - interval '1 minute' where id = $1", [o.id]);
    await app.jobs.billingTick();
    const w = await W(o.id);
    assert.equal(w.plan_code, 'free');
    assert.equal(w.dropped_from, 'scale');
    assert.deepEqual([w.subscriber_packs, w.pending_subscriber_packs], [0, null]);
    assert.equal(Number(w.wallet_cents), 10000, 'nothing charged');
  });

  it('a move to Growth at renewal ends the packs', async () => {
    const o = await owner({ wallet: 50000, daysLeft: 30 });
    await o.c.post('/api/app/plan/packs', { packs: 1 });
    await app.db.query("update workspaces set pending_plan_code = 'growth', pending_cycle = 'month', period_end = now() - interval '1 minute' where id = $1", [o.id]);
    const before = Number((await W(o.id)).wallet_cents);
    await app.jobs.billingTick();
    const w = await W(o.id);
    assert.deepEqual([w.plan_code, w.subscriber_packs], ['growth', 0]);
    assert.equal(before - Number(w.wallet_cents), 4900);
  });
});

describe('over the limit', () => {
  it('the 402 offers a pack with the prorated price; after one pack broadcasts work again', async () => {
    // Small numbers so the test stays fast: Scale allows 10, a pack adds 5.
    await app.db.query("update plans set subscribers = 10 where code = 'scale'");
    app.settings.bust();
    await app.setSetting('billing', { sub_pack_size: 5 });
    try {
      const o = await owner({ wallet: 10000, daysLeft: 15 });
      const bot = await app.connectBot(o.c);
      await app.addSubscribers(bot.connId, 12, { from: 88001 }); // 12 > 10 + 10% (11)
      const r = await o.c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Hello everyone' });
      assert.equal(r.status, 402);
      assert.equal(r.body.code, 'limit_subscribers');
      assert.match(r.body.error, /You have 12 bot subscribers and your Scale plan allows 10\. Add 5 subscribers for \$29\.00\/month to broadcast again\. Nothing is deleted, and your bots keep answering/);
      assert.equal(r.body.packs.can_buy, true);
      near(Math.round(r.body.packs.one_now * 100), 1450);
      assert.equal(r.body.talk_to_us, false);
      // Bots still save new subscribers (nothing is blocked there).
      await app.start(bot.connId, 88100);
      assert.ok(await app.db.one("select 1 from subscribers where connection_id = $1 and tg_user_id = 88100 and status = 'active'", [bot.connId]));
      assert.equal((await o.c.post('/api/app/plan/packs', { packs: 1 })).status, 200);
      const ok = await o.c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Hello everyone' });
      assert.equal(ok.status, 200, ok.text);
      // At the most packs the message says "talk to us" instead.
      await app.db.query('update workspaces set subscriber_packs = 8 where id = $1', [o.id]);
      await app.addSubscribers(bot.connId, 50, { from: 89001 });
      const full = await o.c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Again' });
      assert.equal(full.status, 402);
      assert.match(full.body.error, /Need more than 50\? Talk to us for a custom plan/);
      assert.equal(full.body.talk_to_us, true);
      // Growth over its limit is asked to upgrade (Scale includes more and can add packs).
      const g = await owner({ wallet: 0, plan: 'growth' });
      await app.db.query("update plans set subscribers = 2 where code = 'growth'");
      app.settings.bust();
      const gb = await app.connectBot(g.c);
      await app.addSubscribers(gb.connId, 5, { from: 89501 });
      const gr = await g.c.post('/api/broadcasts', { connection_id: gb.connId, body: 'Hi' });
      assert.equal(gr.status, 402);
      assert.match(gr.body.error, /Upgrade to broadcast again \(Scale includes 10 and can add more\)/);
      await app.db.query("update plans set subscribers = 25000 where code = 'growth'");
    } finally {
      await app.db.query("update plans set subscribers = 100000 where code = 'scale'");
      await app.db.query("update plans set subscribers = 25000 where code = 'growth'");
      app.settings.bust();
    }
  });
});

describe('admin', () => {
  it('sets packs or a custom subscriber limit for a custom deal; a custom limit stops self-serve packs', async () => {
    const o = await owner({ wallet: 50000 });
    const admin = await app.owner();
    const r = await admin.post(`/api/admin/workspaces/${o.id}/plan`, { subscriber_packs: 3, note: 'Deal' });
    assert.equal(r.status, 200, r.text);
    assert.equal((await billing.limits(await W(o.id))).subscribers, 250000);
    const c = await admin.post(`/api/admin/workspaces/${o.id}/plan`, { custom_subscriber_limit: 750000, note: 'Custom plan' });
    assert.equal(c.status, 200, c.text);
    const l = await billing.limits(await W(o.id));
    assert.equal(l.subscribers, 750000);
    assert.equal(l.bots.max_bot_subscribers, 750000);
    assert.equal(l.custom_subscriber_limit, 750000);
    const buy = await o.c.post('/api/app/plan/packs', { packs: 4 });
    assert.equal(buy.status, 409);
    assert.equal(buy.body.code, 'custom_limit');
    assert.equal((await o.c.get('/api/app/plan')).body.packs.reason, 'custom');
    assert.ok(await app.db.one("select 1 from audit_log where action = 'workspace.plan' and target = $1 and data::text like '%750000%'", ['workspace:' + o.id]));
    // Blank removes it again; the admin user view shows the columns.
    assert.equal((await admin.post(`/api/admin/workspaces/${o.id}/plan`, { custom_subscriber_limit: '' })).status, 200);
    assert.equal((await billing.limits(await W(o.id))).subscribers, 250000);
    const u = (await admin.get('/api/admin/users/' + o.c.user.id)).body;
    assert.equal(u.workspaces[0].subscriber_packs, 3);
  });

  it('Admin → Settings → Billing sets the pack size, price and most packs; the public config and pricing line follow', async () => {
    const admin = await app.owner();
    const cur = (await admin.get('/api/admin/settings')).body.settings.billing;
    const r = await admin.put('/api/admin/settings/billing', { value: { min_topup: cur.min_topup_cents / 100, max_topup: cur.max_topup_cents / 100, refund_days: cur.refund_days, data_retention_days: cur.data_retention_days, renew_reminder_days: cur.renew_reminder_days, sub_pack_size: 40000, sub_pack_price: 25, sub_pack_max: 5 } });
    assert.equal(r.status, 200, r.text);
    app.settings.bust();
    assert.deepEqual(await billing.packConf(), { size: 40000, price_cents: 2500, max: 5 });
    const cfg = (await app.client().get('/api/public/config')).body;
    assert.deepEqual(cfg.billing.subscriber_pack, { size: 40000, price: 25, max: 5 });
    const scale = cfg.plans.find((p) => p.code === 'scale');
    assert.ok(scale.bullets.includes('Bigger audience? Add 40,000 subscribers for $25/month, or talk to us for a custom plan.'));
    assert.ok(!cfg.plans.find((p) => p.code === 'growth').bullets.some((b) => /Bigger audience/.test(b)));
  });

  it('the pricing line uses the defaults: 50,000 for $29/month', async () => {
    const scale = (await app.client().get('/api/public/config')).body.plans.find((p) => p.code === 'scale');
    assert.equal(scale.bullets.filter((b) => /Bigger audience/.test(b)).length, 1);
    assert.ok(scale.bullets.includes('Bigger audience? Add 50,000 subscribers for $29/month, or talk to us for a custom plan.'));
  });
});

describe('commission', () => {
  it('a pack payment pays the Castvoo referral like a seat payment (same rate, base and ledger row)', async () => {
    const ref = await app.loginByEmail(`packref${++seq}@example.com`);
    const a = await owner({ wallet: 50000, daysLeft: 30, ref: ref.user.ref_code });
    const b = await owner({ wallet: 50000, daysLeft: 30, ref: ref.user.ref_code });
    assert.equal((await a.c.post('/api/app/plan/packs', { packs: 1 })).status, 200);
    assert.equal((await b.c.post('/api/app/team/seats', { seats: 2 })).status, 200);
    const txA = (await planTx(a.id)).pop(), txB = (await planTx(b.id)).pop();
    assert.equal(txA.commission_to, 'castvoo_referral');
    assert.equal(txB.commission_to, 'castvoo_referral');
    const eA = await app.db.one("select * from referral_ledger where user_id = $1 and from_workspace_id = $2 and kind = 'earning'", [ref.user.id, a.id]);
    const eB = await app.db.one("select * from referral_ledger where user_id = $1 and from_workspace_id = $2 and kind = 'earning'", [ref.user.id, b.id]);
    assert.ok(eA && eB);
    assert.equal(Number(eA.rate), Number(eB.rate));
    assert.equal(Number(eA.amount_cents), Math.floor(-Number(txA.cash_cents) * Number(eA.rate) / 100));
    assert.ok(Number(eA.rate) >= 5 && Number(eA.rate) <= 15);
  });

  it('a VooSquare affiliate customer: the pack payment is a commissionable spend, no Castvoo earning', async () => {
    const o = await owner({ wallet: 50000, daysLeft: 30 });
    await app.db.query("update users set voo_id = $2, voo_ref = 'affpk', voo_linked_at = now() where id = $1", [o.c.user.id, 'vs_pack_' + o.id]);
    assert.equal((await o.c.post('/api/app/plan/packs', { packs: 1 })).status, 200);
    const tx = (await planTx(o.id)).pop();
    assert.equal(tx.commission_to, 'voosquare');
    const ev = await app.db.many("select payload from outbox where kind = 'voosquare' and payload->>'voo_id' = $1", ['vs_pack_' + o.id]);
    const spend = ev.find((e) => e.payload.type === 'spend');
    assert.ok(spend, 'spend event');
    assert.match(spend.payload.label, /Castvoo 1 subscriber pack/);
    assert.equal(await app.db.one('select 1 from referral_ledger where from_workspace_id = $1', [o.id]), null);
  });
});

describe('support and Cas', () => {
  it('the support link whitelist has the packs and talk-to-us cards; the agent sees packs in plan and usage', async () => {
    const links = app.require('services/support-links');
    const card = await links.resolve({ key: 'subscriber_packs' }, {});
    assert.equal(card.ok, true);
    assert.equal(card.card.href, '#app/wallet?packs=1');
    assert.equal((await links.resolve({ url: '#app/wallet?packs=1' }, {})).card.key, 'subscriber_packs');
    assert.equal((await links.resolve({ key: 'talk_to_us' }, {})).card.href, '#app/help?topic=custom');
    assert.equal((await links.resolve({ url: '#app/wallet?packs=2' }, {})).ok, false);
    const money = fs.readFileSync(path.join(__dirname, '../../public/js/app-money.js'), 'utf8');
    assert.match(money, /q\.packs/);
    assert.match(fs.readFileSync(path.join(__dirname, '../../public/js/app-account.js'), 'utf8'), /q\.topic === 'custom'/);

    const o = await owner({ wallet: 50000 });
    await app.db.query('update workspaces set subscriber_packs = 2 where id = $1', [o.id]);
    const tools = app.require('services/support-tools');
    const scope = { userId: o.c.user.id, workspaceId: o.id, role: 'owner', threadId: null, log: false };
    const res = await tools.run('get_usage', {}, scope);
    assert.equal(res.ok, true, JSON.stringify(res));
    const u = res.output;
    assert.equal(u.bot_subscribers.limit, 200000);
    assert.equal(u.subscriber_packs.has, 2);
    assert.equal(u.subscriber_packs.can_buy, true);
    assert.equal(u.subscriber_packs.pack_size, 50000);
    assert.equal(u.subscriber_packs.price_a_month, 29);
    assert.equal(u.subscriber_packs.above_this_talk_to_us, 500000);
  });

  it('the live plan list and the knowledge tell Cas and support the rules', async () => {
    const live = await app.require('services/ai').plansText();
    assert.match(live, /Subscriber packs \(Scale plan only\): \+50,000 bot subscribers for \$29 a month per pack/);
    assert.match(live, /up to 8 packs \(500,000 bot subscribers in all\)/);
    assert.match(live, /Starter and Growth customers upgrade to Scale first/);
    assert.match(live, /Need more than 500,000.*Talk to us/);
    assert.match(live, /bots keep working and answering, new subscribers are still saved, channel and group members never count, only broadcasts to bot subscribers pause/);
    assert.match(live, /plus 10% extra/);
    const kb = app.require('knowledge-defaults');
    const art = kb.find((k) => k.key === 'subscriber-packs');
    assert.ok(art, 'knowledge article');
    for (const re of [/10% extra/, /bots keep working/, /still saved/, /Channel and group members never count/, /nothing is deleted/i, /Scale plan only/, /Talk to us/, /next renewal/, /subscriber_packs/]) assert.match(art.body, re);
    // Synced into the database the agents read.
    assert.ok(await app.db.one("select 1 from knowledge where key = 'subscriber-packs'"));
  });
});

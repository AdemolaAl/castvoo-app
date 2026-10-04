'use strict';
/*
 * Plans, limits, wallet charges, coupons and referral commissions.
 *
 * Rules (also written in the Terms and the FAQ):
 * - Plans are paid from the wallet. Bonus credit is used first, then cash.
 * - Trial = the trial plan's limits for N days, with a smaller AI allowance.
 * - Upgrading mid-period: pay the price difference for the days left. Downgrades start at the next renewal.
 * - If the wallet is short at renewal, the plan pauses (nothing is deleted).
 * - Referral commission = rate% of the cash part of each plan payment, settles after N days.
 */

const db = require('../db');
const settings = require('./settings');
const email = require('./email');
const { httpError, badRequest, fmtUSD, fmtDate, addDays } = require('../lib/util');

const DAY = 86400000;
const periodDays = (cycle) => (cycle === 'year' ? 365 : 30);
const priceOf = (plan, cycle) => Number(cycle === 'year' ? plan.price_year_cents : plan.price_month_cents);

/** The limits that apply to a workspace right now. */
async function limits(ws) {
  const plan = await settings.plan(ws.plan_code);
  const trial = await settings.get('trial');
  if (!plan) throw new Error('Plan missing: ' + ws.plan_code);
  return {
    plan,
    connections: plan.connections,
    subscribers: plan.subscribers,
    seats: plan.seats,
    ai_writes: ws.plan_status === 'trial' ? trial.ai_writes : plan.ai_writes,
  };
}

/** How much of the plan is being used. */
async function usage(wsId) {
  const r = await db.one(`select
      (select count(*)::int from connections where workspace_id = $1 and status <> 'removed') as connections,
      (select count(*)::int from subscribers s join connections c on c.id = s.connection_id where c.workspace_id = $1 and c.status <> 'removed' and c.kind = 'bot' and s.status = 'active') as bot_subscribers,
      (select coalesce(sum(member_count), 0)::int from connections where workspace_id = $1 and status <> 'removed' and kind <> 'bot') as chat_members,
      (select count(*)::int from members where workspace_id = $1) as seats,
      (select ai_used from workspaces where id = $1) as ai_used`, [wsId]);
  // Only bot subscribers count toward the plan. A channel or group post is one message whatever
  // its size, so channel and group members are free and unlimited.
  return { ...r, subscribers: r.bot_subscribers };
}

/** Throws a friendly error when the workspace may not send right now. */
async function assertCanSend(ws) {
  if (ws.plan_status === 'paused' || ws.plan_status === 'cancelled') {
    throw httpError(402, 'Your plan is paused. Top up your wallet and pick a plan to start sending again.', 'plan_paused');
  }
  if (ws.plan_status === 'trial' && new Date(ws.trial_ends_at) < new Date()) throw httpError(402, 'Your free trial has ended. Pick a plan to keep sending.', 'trial_over');
  const [l, u] = [await limits(ws), await usage(ws.id)];
  if (u.subscribers > l.subscribers) {
    throw httpError(402, `You have ${u.subscribers.toLocaleString('en-US')} bot subscribers and your plan allows ${l.subscribers.toLocaleString('en-US')}. Upgrade to keep sending. Nothing is deleted.`, 'limit_subscribers');
  }
}

async function assertCanConnect(ws) {
  const [l, u] = [await limits(ws), await usage(ws.id)];
  if (u.connections >= l.connections) throw httpError(402, `Your ${l.plan.name} plan allows ${l.connections} connection${l.connections > 1 ? 's' : ''}. Upgrade to add more.`, 'limit_connections');
}

/**
 * When the AI writes refill. Monthly plans: at renewal. Yearly plans: every 30 days
 * (the jobs worker resets them), so a yearly customer gets the same writes each month.
 */
function aiRefillAt(ws) {
  if (ws.plan_status !== 'active') return null;
  if (ws.billing_cycle === 'year' && ws.ai_period_start) {
    const next = addDays(new Date(ws.ai_period_start), 30);
    return ws.period_end && new Date(ws.period_end) < next ? new Date(ws.period_end) : next;
  }
  return ws.period_end ? new Date(ws.period_end) : null;
}

/** Use one or more AI writes; throws when the month's allowance is used up. */
async function useAi(ws, writes = 1) {
  const l = await limits(ws);
  const r = await db.one('update workspaces set ai_used = ai_used + $2 where id = $1 and ai_used + $2 <= $3 returning ai_used', [ws.id, writes, l.ai_writes]);
  if (!r) {
    const at = aiRefillAt(ws);
    const when = ws.plan_status === 'trial' ? 'when your plan starts' : at ? `on ${fmtDate(at)}` : 'when your plan is active again';
    throw httpError(402, `Cas has used all ${l.ai_writes.toLocaleString('en-US')} AI writes for this period. They refill ${when}.`, 'ai_limit');
  }
  return r.ai_used;
}
async function refundAi(wsId, writes = 1) { await db.query('update workspaces set ai_used = greatest(0, ai_used - $2) where id = $1', [wsId, writes]); }

/** Price after coupon, in cents. */
async function priceWithCoupon(c, ws, plan, cycle) {
  let price = priceOf(plan, cycle);
  // Price went up recently: this customer keeps the old price until their notice period ends.
  if (ws.locked_until && new Date(ws.locked_until) > new Date() && ws.plan_code === plan.code && ws.locked_cycle === cycle && ws.locked_price_cents != null) {
    price = Math.min(price, Number(ws.locked_price_cents));
  }
  let couponUsed = null;
  if (ws.coupon_id && ws.coupon_months_left > 0) {
    const o = (await c.query('select * from offers where id = $1', [ws.coupon_id])).rows[0];
    if (o && o.percent) { price = Math.round(price * (100 - o.percent) / 100); couponUsed = o; }
  }
  return { price, couponUsed };
}

/**
 * Take a plan payment from the wallet inside a transaction `c`.
 * Returns { charged, cash, bonus } or null if the wallet is short.
 */
async function takePayment(c, wsId, amount, note, ref) {
  const ws = (await c.query('select * from workspaces where id = $1 for update', [wsId])).rows[0];
  if (Number(ws.bonus_cents) + Number(ws.wallet_cents) < amount) return null;
  const bonus = Math.min(Number(ws.bonus_cents), amount);
  const cash = amount - bonus;
  await c.query('update workspaces set bonus_cents = bonus_cents - $2, wallet_cents = wallet_cents - $3 where id = $1', [wsId, bonus, cash]);
  if (amount > 0) {
    await c.query("insert into wallet_tx(workspace_id, kind, amount_cents, cash_cents, bonus_part_cents, method, ref, note) values ($1,'plan',$2,$3,$4,'wallet',$5,$6)",
      [wsId, -amount, -cash, -bonus, ref || null, note]);
  }
  return { charged: amount, cash, bonus };
}

/** Pay referral commission on the cash part of a plan payment. */
async function payCommission(c, ws, cashCents, ref) {
  if (cashCents <= 0) return null;
  if (!(await settings.feature('referrals'))) return null;
  const owner = (await c.query('select id, referred_by, name from users where id = $1', [ws.owner_user_id])).rows[0];
  if (!owner || !owner.referred_by || owner.referred_by === owner.id) return null;
  const rs = await settings.get('referral');
  const paying = (await c.query(`select count(distinct u.id)::int n from users u join workspaces w on w.owner_user_id = u.id
    where u.referred_by = $1 and w.plan_status = 'active' and w.paid_ever`, [owner.referred_by])).rows[0].n;
  const rate = paying >= rs.tier3_min ? rs.rates[2] : paying >= rs.tier2_min ? rs.rates[1] : rs.rates[0];
  const amount = Math.floor(cashCents * rate / 100);
  if (amount <= 0) return null;
  const settles = addDays(new Date(), rs.settle_days);
  await c.query("insert into referral_ledger(user_id, kind, amount_cents, from_workspace_id, rate, settles_at, ref) values ($1,'earning',$2,$3,$4,$5,$6)",
    [owner.referred_by, amount, ws.id, rate, settles, ref]);
  return { referrer: owner.referred_by, amount, rate, settles, referredName: owner.name };
}

/**
 * Start or renew a plan now, paid from the wallet.
 * Returns { ok:true, ... } or throws 402 if the wallet is short.
 *
 * `expect(ws)` is checked AFTER the workspace row is locked. If it returns false, nothing is
 * charged and { skipped: true } is returned. Use it to say "only if this is still a trial that
 * ended" etc.: two servers running the billing job, or a top-up arriving while the customer
 * clicks "start plan", used to charge the plan twice.
 */
async function activate(wsId, planCode, cycle, { reason = 'renewal', expect = null } = {}) {
  void reason;
  const plan = await settings.plan(planCode);
  if (!plan || !plan.active) throw badRequest('That plan is not available.');
  const result = await db.tx(async (c) => {
    const ws = (await c.query('select * from workspaces where id = $1 for update', [wsId])).rows[0];
    if (expect && !expect(ws)) return { skipped: true };
    const { price, couponUsed } = await priceWithCoupon(c, ws, plan, cycle);
    const ref = `plan-${wsId}-${Date.now()}`;
    const paid = await takePayment(c, wsId, price, `${plan.name} plan · ${cycle === 'year' ? 'yearly' : 'monthly'}`, ref);
    if (!paid) return { short: true, price };
    const start = new Date();
    const end = addDays(start, periodDays(cycle));
    await c.query(`update workspaces set plan_code = $2, billing_cycle = $3, plan_status = 'active', period_end = $4, trial_ends_at = null,
      cancel_at_period_end = false, pending_plan_code = null, pending_cycle = null, ai_used = 0, ai_period_start = now(), paid_ever = true, reminded_at = null,
      coupon_months_left = greatest(0, coupon_months_left - $5), coupon_id = case when coupon_months_left - $5 <= 0 then null else coupon_id end
      where id = $1`, [wsId, plan.code, cycle, end, couponUsed ? 1 : 0]);
    const commission = await payCommission(c, ws, paid.cash, ref);
    return { ok: true, price, start, end, commission, ref, wsName: ws.name, ownerId: ws.owner_user_id };
  });
  if (result.skipped) return result;
  if (result.short) throw httpError(402, `Your wallet needs ${fmtUSD(result.price)} for this plan. Top up and try again.`, 'wallet_short', { needed: result.price / 100 });

  const owner = await db.one('select * from users where id = $1', [result.ownerId]);
  const wsNow = await db.one('select * from workspaces where id = $1', [wsId]);
  await email.send('payment_receipt', owner, {
    plan_name: plan.name, amount: fmtUSD(result.price), period_start: fmtDate(result.start), period_end: fmtDate(result.end),
    receipt_id: result.ref, wallet_balance: fmtUSD(Number(wsNow.wallet_cents) + Number(wsNow.bonus_cents)), billing_url: require('../config').appUrl + '/#app/wallet',
  });
  if (result.commission) {
    const ref = await db.one('select * from users where id = $1', [result.commission.referrer]);
    await email.send('referral_earned', ref, {
      amount: fmtUSD(result.commission.amount), referral_name: (result.commission.referredName || 'Someone').split(' ')[0],
      settle_date: fmtDate(result.commission.settles), referrals_url: require('../config').appUrl + '/#app/referrals',
    });
  }
  require('./voosquare').event('spend', { voo_id: owner.voo_id, label: `${plan.name} plan`, value_usd: result.price / 100 }).catch(() => {});
  return result;
}

/** Upgrade during a paid period: pay the difference for the days left. */
async function upgradeNow(wsId, planCode) {
  const plan = await settings.plan(planCode);
  if (!plan || !plan.active) throw badRequest('That plan is not available.');
  return db.tx(async (c) => {
    const ws = (await c.query('select * from workspaces where id = $1 for update', [wsId])).rows[0];
    if (ws.plan_status !== 'active') throw httpError(409, 'Your plan changed a moment ago. Refresh the page and try again.', 'plan_changed');
    const cur = await settings.plan(ws.plan_code);
    const left = Math.max(0, new Date(ws.period_end).getTime() - Date.now()) / (periodDays(ws.billing_cycle) * DAY);
    const diff = Math.max(0, Math.round((priceOf(plan, ws.billing_cycle) - priceOf(cur, ws.billing_cycle)) * left));
    const paid = await takePayment(c, wsId, diff, `Upgrade to ${plan.name} (rest of this period)`, `upgrade-${wsId}-${Date.now()}`);
    if (!paid) throw httpError(402, `Your wallet needs ${fmtUSD(diff)} to upgrade now. Top up and try again.`, 'wallet_short', { needed: diff / 100 });
    await c.query('update workspaces set plan_code = $2, pending_plan_code = null, pending_cycle = null where id = $1', [wsId, plan.code]);
    await payCommission(c, ws, paid.cash, `upgrade-${wsId}`);
    return { ok: true, charged: diff };
  });
}

/** What a workspace sees on the Wallet → Plan card. */
async function planState(ws) {
  const l = await limits(ws);
  const u = await usage(ws.id);
  const plans = await settings.plans({ activeOnly: true });
  const coupon = ws.coupon_id ? await db.one('select code, percent from offers where id = $1', [ws.coupon_id]) : null;
  return {
    plan_code: ws.plan_code, plan_name: l.plan.name, status: ws.plan_status, cycle: ws.billing_cycle,
    trial_ends_at: ws.trial_ends_at, period_end: ws.period_end, cancel_at_period_end: ws.cancel_at_period_end, ai_refill_at: aiRefillAt(ws),
    pending_plan_code: ws.pending_plan_code, coupon: coupon && ws.coupon_months_left > 0 ? { ...coupon, months_left: ws.coupon_months_left } : null,
    limits: { connections: l.connections, subscribers: l.subscribers, ai_writes: l.ai_writes, seats: l.seats },
    usage: { connections: u.connections, subscribers: u.subscribers, ai_writes: u.ai_used, seats: u.seats },
    plans: plans.map((p) => ({ code: p.code, name: p.name, price_month: p.price_month_cents / 100, price_year: p.price_year_cents / 100, connections: p.connections, subscribers: p.subscribers, ai_writes: p.ai_writes, seats: p.seats, popular: p.popular })),
  };
}

module.exports = { aiRefillAt, limits, usage, assertCanSend, assertCanConnect, useAi, refundAi, activate, upgradeNow, planState, takePayment, payCommission, priceOf, periodDays };

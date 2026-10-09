'use strict';
/*
 * Plans, limits, wallet charges, coupons and referral commissions.
 *
 * Rules (also written in the Terms and the FAQ):
 * - Plans are paid from the wallet. Bonus credit is used first, then cash.
 * - Trial = the trial plan's limits for N days, with a smaller AI allowance.
 * - Upgrading mid-period: pay the price difference for the days left. Downgrades start at the next renewal.
 * - Extra team seats (paid plans only, billing.seat_price_cents a seat a month, yearly plans pay 12 months): bought
 *   any time for the days left of the period, then renewed with the plan in the same wallet payment. Fewer seats
 *   start at the next renewal (pending_extra_seats), never below the seats in use. The Free plan and a plan that
 *   drops to Free have no extra seats. The setup helper never uses a seat.
 * - If the wallet is short at renewal, the workspace moves to the Free plan (nothing is deleted); a top-up that
 *   covers the plan starts it again.
 * - One commission per plan payment (AUD-1): the Castvoo referral OR the VooSquare affiliate, never both. The first
 *   attribution wins (users.referred_at vs users.voo_linked_at with a voo_ref). When the Castvoo referral pays, the
 *   commissionable `spend` event is not sent to VooSquare (plan_started / plan_renewed still are: they carry no commission).
 * - Commission base = the cash part minus the processor fee of the top-ups that money came from (when the provider
 *   reported it), capped at referral.commission_cap_pct (50%) and at referral.yearly_cap_pct (35%) on yearly payments.
 * - Earnings that look like a self-referral (SEC-2) are held for Finance to review instead of settling.
 */

const db = require('../db');
const settings = require('./settings');
const email = require('./email');
const voosquare = require('./voosquare');
const { httpError, badRequest, fmtUSD, fmtDate, addDays } = require('../lib/util');

const DAY = 86400000;
const periodDays = (cycle) => (cycle === 'year' ? 365 : 30);
const priceOf = (plan, cycle) => Number(cycle === 'year' ? plan.price_year_cents : plan.price_month_cents);

/** -1 in a plan limit means unlimited. */
const UNLIMITED = -1;
const over = (used, limit) => limit !== UNLIMITED && used >= limit;
// Features people already paying on 8 Oct 2026 keep while they stay on the same plan (grandfathered).
const LEGACY_FEATURES = ['audiences', 'start_links', 'csv_export', 'drips', 'broadcasts', 'schedule', 'ai', 'tracked_buttons', 'basic_stats'];
const isLegacy = (ws) => !!ws.legacy_plan_code && ws.legacy_plan_code === ws.plan_code;
const trialOver = (ws) => ws.plan_status === 'trial' && ws.trial_ends_at && new Date(ws.trial_ends_at) < new Date();

/**
 * The plan whose limits apply right now. A trial that has ended but was not processed yet by the
 * billing job already counts as Free (that is where it is going), unless the Free plan was removed.
 */
async function effectivePlan(ws) {
  if (trialOver(ws)) {
    const free = await settings.plan('free');
    if (free) return free;
  }
  const plan = await settings.plan(ws.plan_code);
  if (!plan) throw new Error('Plan missing: ' + ws.plan_code);
  return plan;
}

/** The limits that apply to a workspace right now. */
async function limits(ws) {
  const plan = await effectivePlan(ws);
  const trial = await settings.get('trial');
  const inTrial = ws.plan_status === 'trial' && !trialOver(ws);
  const features = Array.isArray(plan.features) ? plan.features : [];
  let ai = inTrial ? trial.ai_writes : plan.ai_writes;
  if (isLegacy(ws) && ws.legacy_ai_writes > ai) ai = ws.legacy_ai_writes;
  const ab = features.includes('ab_welcome_4') ? 4 : features.includes('ab_welcome_2') ? 2 : 1;
  const extra = extraSeatsNow(ws, plan);
  return {
    plan,
    connections: plan.connections,
    subscribers: plan.subscribers,
    seats: Number(plan.seats) + extra,
    plan_seats: Number(plan.seats),
    extra_seats: extra,
    // What new invites may fill: seats the owner already asked to remove at the next renewal can't be filled.
    seats_for_invites: Number(plan.seats) + Math.min(extra, ws.pending_extra_seats != null ? Number(ws.pending_extra_seats) : extra),
    ai_writes: ai,
    join_requests: inTrial && trial.join_requests != null ? Number(trial.join_requests) : (plan.join_requests ?? UNLIMITED),
    flows: plan.flows ?? UNLIMITED,
    flow_steps: plan.flow_steps ?? UNLIMITED,
    branding: !!plan.branding,
    features,
    ab_variants: ab,
    legacy: isLegacy(ws),
  };
}

/** The features a workspace has, from its limits(): the plan's, plus the grandfathered ones (ENG-22: one place). */
function featureSet(l) { return new Set([...(l.features || []), ...(l.legacy ? LEGACY_FEATURES : [])]); }

/** Does the workspace's plan include a feature (see FEATURE_SETS in seed.js)? */
async function hasFeature(ws, key) {
  return featureSet(await limits(ws)).has(key);
}

/** The cheapest active paid plan that includes a feature (for "Upgrade to Growth" messages). */
async function planFor(key) {
  const plans = (await settings.plans({ activeOnly: true })).filter((p) => Number(p.price_month_cents) > 0 && (p.features || []).includes(key));
  plans.sort((a, b) => Number(a.price_month_cents) - Number(b.price_month_cents));
  return plans[0] || null;
}

const FEATURE_WORDS = {
  broadcasts: 'Broadcasts are', drips: 'Auto follow-ups are', ai: 'Cas, the AI helper, is', audiences: 'Audiences are', start_links: 'Start links are',
  welcome_flows: 'Follow-up steps in a Welcome Flow are', tap_to_start: 'The "Tap to start" button is', ab_welcome_2: 'A/B welcomes are', ab_welcome_4: 'A/B welcomes with 3 or 4 versions are',
  condition_clicked: 'Click conditions are', flow_funnel_stats: 'Flow funnel stats are', basic_stats: 'Stats are', csv_export: 'CSV export is', schedule: 'Scheduling is',
};
/** Throw a friendly 402 (code plan_feature) when the plan does not include a feature. */
async function requirePlanFeature(ws, key) {
  if (await hasFeature(ws, key)) return;
  const p = await planFor(key);
  const what = FEATURE_WORDS[key] || 'This is';
  throw httpError(402, `${what} on ${p ? `the ${p.name} plan and up (${fmtUSD(p.price_month_cents)} a month)` : 'a bigger plan'}. Upgrade to use it.`, 'plan_feature', { feature: key, plan: p ? p.code : null });
}

/**
 * Start of the period the join-request meter counts: the calendar month (UTC), or the whole trial. A workspace that
 * dropped to Free this month counts from the drop (ENG-9): the trial's join requests don't use up the Free allowance.
 */
function meterStart(ws, now = new Date()) {
  if (ws.plan_status === 'trial' && !trialOver(ws)) return new Date(ws.created_at);
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  if (ws.dropped_at && new Date(ws.dropped_at) > month && new Date(ws.dropped_at) <= now) return new Date(ws.dropped_at);
  if (trialOver(ws) && ws.trial_ends_at && new Date(ws.trial_ends_at) > month) return new Date(ws.trial_ends_at);
  return month;
}
function meterResets(now = new Date()) { return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)); }

/** The meter's limit numbers for a workspace (no counting). */
async function meterLimits(ws) {
  const l = await limits(ws);
  const b = await settings.get('billing');
  const grace = Number(b.limit_grace_pct ?? 10);
  const limit = l.join_requests;
  const legacyGrace = l.legacy && ws.legacy_until && new Date(ws.legacy_until) > new Date();
  const hard = limit === UNLIMITED || legacyGrace ? UNLIMITED : Math.floor(limit * (1 + grace / 100));
  return { limit, hard, grace, legacyGrace };
}

/** Join requests counted so far in this period: the counter row (ENG-2), or a one-time count when there is none yet. */
async function meterUsed(ws, start) {
  const row = await db.one('select used from join_meter where workspace_id = $1 and since = $2', [ws.id, start]);
  if (row) return Number(row.used);
  return (await db.one('select count(*)::int n from join_requests where workspace_id = $1 and requested_at >= $2', [ws.id, start])).n;
}

/**
 * Join requests this month against the plan. After limit + grace (10%), people are still let in
 * (auto-approve keeps working) but welcome and flow messages pause until next month or an upgrade.
 * `counts: false` skips the dashboard-only numbers (approved, no_welcome): the hot paths use that.
 */
async function joinMeter(ws, { counts = true } = {}) {
  const m = await meterLimits(ws);
  const start = meterStart(ws);
  const used = await meterUsed(ws, start);
  let extra = { approved: 0, no_welcome: 0 };
  if (counts) {
    extra = await db.one(`select count(*) filter (where welcome = 'skipped_limit')::int no_welcome, count(*) filter (where status = 'approved')::int approved
      from join_requests where workspace_id = $1 and requested_at >= $2`, [ws.id, start]);
  }
  return {
    used, approved: extra.approved, no_welcome: extra.no_welcome, limit: m.limit, hard: m.hard, grace_pct: m.grace,
    paused: over(used, m.hard), pct: m.limit > 0 ? Math.round(used / m.limit * 100) : (m.limit === 0 ? 100 : 0),
    since: start, resets_at: ws.plan_status === 'trial' && !trialOver(ws) ? ws.trial_ends_at : meterResets(), unlimited_until: m.legacyGrace ? ws.legacy_until : null,
  };
}

/**
 * Count one new join request (ENG-2 / ENG-26), in two steps around the join_requests insert:
 *   meterEnsure(ws)        BEFORE the insert: make sure the period's counter row exists. A new row starts from the
 *                          requests already saved this period (before Castvoo kept a counter, or at a period start).
 *                          Every request ensures before it inserts, so no request is counted twice.
 *   meterBump(ws, since)   AFTER a successful insert: one atomic increment. This request is over limit + grace if the
 *                          value the increment returned is, so parallel webhooks can't all see "not paused".
 */
async function meterEnsure(ws) {
  const start = meterStart(ws);
  await db.query(`insert into join_meter(workspace_id, since, used)
    values ($1, $2, (select count(*)::int from join_requests where workspace_id = $1 and requested_at >= $2)) on conflict do nothing`, [ws.id, start]);
  return start;
}
async function meterBump(ws, since = null) {
  const m = await meterLimits(ws);
  const start = since || (await meterEnsure(ws));
  const r = await db.one('update join_meter set used = used + 1 where workspace_id = $1 and since = $2 returning used', [ws.id, start]);
  const used = r ? Number(r.used) : 1;
  return {
    used, limit: m.limit, hard: m.hard, grace_pct: m.grace, paused: m.hard !== UNLIMITED && used > m.hard,
    since: start, resets_at: ws.plan_status === 'trial' && !trialOver(ws) ? ws.trial_ends_at : meterResets(), unlimited_until: m.legacyGrace ? ws.legacy_until : null,
  };
}

/** How much of the plan is being used. */
async function usage(wsId) {
  const r = await db.one(`select
      (select count(*)::int from connections where workspace_id = $1 and status <> 'removed') as connections,
      (select count(*)::int from connections where workspace_id = $1 and status <> 'removed' and kind = 'bot') as bots,
      (select count(*)::int from subscribers s join connections c on c.id = s.connection_id where c.workspace_id = $1 and c.status <> 'removed' and c.kind = 'bot' and s.status = 'active') as bot_subscribers,
      (select coalesce(sum(member_count), 0)::int from connections where workspace_id = $1 and status <> 'removed' and kind <> 'bot') as chat_members,
      (select count(*)::int from members where workspace_id = $1 and role <> 'helper') as seats, -- the setup helper is free
      (select count(*)::int from sequences q join connections c on c.id = q.connection_id where q.workspace_id = $1 and q.trigger_type = 'join_request' and c.status <> 'removed') as flows,
      (select count(*)::int from sequences q join connections c on c.id = q.connection_id where q.workspace_id = $1 and q.trigger_type = 'join_request' and q.active and c.status <> 'removed'
        and exists (select 1 from connections ch where ch.workspace_id = q.workspace_id and ch.kind <> 'bot' and ch.status <> 'removed' and ch.tg_chat_id::text = q.trigger_value)) as active_flows,
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
  if (trialOver(ws)) throw httpError(402, 'Your free trial has ended. Pick a plan to keep sending.', 'trial_over');
  await requirePlanFeature(ws, 'broadcasts');
  const [l, u] = [await limits(ws), await usage(ws.id)];
  if (u.subscribers > l.subscribers) {
    throw httpError(402, `You have ${u.subscribers.toLocaleString('en-US')} bot subscribers and your plan allows ${l.subscribers.toLocaleString('en-US')}. Upgrade to keep sending. Nothing is deleted.`, 'limit_subscribers');
  }
}

/**
 * Can one more bot / channel / group be connected? On a plan without broadcasts (Free) the limit counts
 * channels and groups, and one bot (the welcome bot) comes free next to them.
 */
async function assertCanConnect(ws, kind = 'bot') {
  const [l, u] = [await limits(ws), await usage(ws.id)];
  const welcomeOnly = !(await hasFeature(ws, 'broadcasts'));
  if (welcomeOnly) {
    if (kind === 'bot') {
      if (u.bots >= 1) throw httpError(402, `The ${l.plan.name} plan includes 1 welcome bot. Upgrade to connect more bots.`, 'limit_connections');
      return;
    }
    if (u.connections - u.bots >= l.connections) throw httpError(402, `The ${l.plan.name} plan includes ${l.connections} channel or group${l.connections > 1 ? 's' : ''} and its welcome bot. Upgrade to add more.`, 'limit_connections');
    return;
  }
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
  await requirePlanFeature(ws, 'ai');
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
  // A charged-back wallet below zero pays nothing until the debt is topped up (bonus credit can't cover it).
  if (Number(ws.wallet_cents) < 0 && amount > 0) return null;
  if (Number(ws.bonus_cents) + Number(ws.wallet_cents) < amount) return null;
  const bonus = Math.min(Number(ws.bonus_cents), amount);
  const cash = amount - bonus;
  await c.query('update workspaces set bonus_cents = bonus_cents - $2, wallet_cents = wallet_cents - $3 where id = $1', [wsId, bonus, cash]);
  let txId = null;
  if (amount > 0) {
    txId = (await c.query("insert into wallet_tx(workspace_id, kind, amount_cents, cash_cents, bonus_part_cents, method, ref, note) values ($1,'plan',$2,$3,$4,'wallet',$5,$6) returning id",
      [wsId, -amount, -cash, -bonus, ref || null, note])).rows[0].id;
  }
  return { charged: amount, cash, bonus, txId };
}

/** The referral settings with safe defaults for keys added after the row was saved (AUD-1). */
async function referralSettings() {
  const rs = { ...REFERRAL_DEFAULTS, ...((await settings.get('referral')) || {}) };
  rs.commission_cap_pct = Math.max(0, Math.min(HARD_CAP_PCT, Number(rs.commission_cap_pct ?? HARD_CAP_PCT)));
  rs.yearly_cap_pct = Math.max(0, Math.min(rs.commission_cap_pct, Number(rs.yearly_cap_pct ?? 35)));
  return rs;
}
const REFERRAL_DEFAULTS = { commission_cap_pct: 50, yearly_cap_pct: 35, first_attribution: true, net_of_fees: true };
const HARD_CAP_PCT = 50;

/**
 * Who gets the commission on this workspace's plan payments (AUD-1): 'castvoo_referral' (users.referred_by),
 * 'voosquare' (a VooSquare affiliate: the owner linked a Voo ID that came with a voo_ref), or 'none'.
 * With both, the first attribution wins; at the same moment (sign-up through both) the Castvoo link wins.
 */
function attributionOf(owner, rs) {
  const cv = !!owner.referred_by && String(owner.referred_by) !== String(owner.id);
  const voo = !!owner.voo_id && !!owner.voo_ref;
  if (cv && voo && rs.first_attribution !== false) {
    const a = new Date(owner.referred_at || owner.created_at).getTime();
    const b = new Date(owner.voo_linked_at || owner.created_at).getTime();
    return b < a ? 'voosquare' : 'castvoo_referral';
  }
  if (cv) return 'castvoo_referral';
  if (voo) return 'voosquare';
  return 'none';
}

/**
 * The processor fees on the cash a plan payment used (AUD-1): wallet cash is spent oldest first, and each top-up's
 * fee (payments.fee_cents, when the provider reported it) is shared over its cents. Returns cents (0 when unknown).
 */
async function feeShare(c, wsId, txId) {
  const fees = new Map((await c.query('select reference, amount_cents, fee_cents from payments where workspace_id = $1 and fee_cents is not null and fee_cents > 0', [wsId])).rows
    .map((r) => [r.reference, Number(r.fee_cents) / Math.max(1, Number(r.amount_cents))]));
  if (!fees.size) return 0;
  const txs = (await c.query('select id, kind, cash_cents, ref from wallet_tx where workspace_id = $1 and id <= $2 order by id', [wsId, txId])).rows;
  const lots = [];
  let fee = 0;
  for (const t of txs) {
    const cash = Number(t.cash_cents);
    if (t.kind === 'chargeback') { const lot = lots.find((x) => x.ref === t.ref); if (lot) lot.left = Math.max(0, lot.left + cash); continue; }
    if (cash > 0) { lots.push({ ref: t.kind === 'topup' ? t.ref : null, left: cash }); continue; }
    let need = -cash;
    while (need > 0 && lots.length) {
      const lot = lots[0];
      const take = Math.min(lot.left, need);
      lot.left -= take; need -= take;
      if (String(t.id) === String(txId) && lot.ref && fees.has(lot.ref)) fee += take * fees.get(lot.ref);
      if (lot.left <= 0) lots.shift();
    }
  }
  return Math.round(fee);
}

/** "a.b+x@gmail.com" and "ab@gmail.com" are one mailbox (SEC-2). */
function mailbox(e) {
  if (!e) return null;
  let [local, domain] = String(e).trim().toLowerCase().split('@');
  if (!local || !domain) return null;
  local = local.split('+')[0];
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return local + '@' + domain;
}

/**
 * SEC-2: signs that the referred account belongs to the referrer. Returns a short reason, or null.
 * Same Telegram account, same mailbox (aliases count), same VooSquare account, the same IP address as the referrer
 * within 24 hours of the sign-up, or a payment made with the referrer's card / payer account.
 */
async function selfReferralSignal(c, owner, referrerId, wsId) {
  const ref = (await c.query('select id, email, tg_user_id, tg_username, voo_id from users where id = $1', [referrerId])).rows[0];
  if (!ref) return null;
  if (owner.tg_user_id && ref.tg_user_id && String(owner.tg_user_id) === String(ref.tg_user_id)) return 'same Telegram account';
  if (owner.tg_username && ref.tg_username && owner.tg_username.toLowerCase() === ref.tg_username.toLowerCase()) return 'same Telegram username';
  if (owner.email && ref.email && mailbox(owner.email) === mailbox(ref.email)) return 'same email mailbox';
  if (owner.voo_id && ref.voo_id && owner.voo_id === ref.voo_id) return 'same VooSquare account';
  const ip = (await c.query(`select b.ip from user_ips b join user_ips a on a.ip = b.ip and a.user_id = $2
      where b.user_id = $1 and b.first_seen <= $3::timestamptz + interval '1 hour'
        and a.last_seen >= $3::timestamptz - interval '24 hours' and a.first_seen <= $3::timestamptz + interval '24 hours' limit 1`,
  [owner.id, referrerId, owner.created_at])).rows[0];
  if (ip) return 'same IP address as the referrer at sign-up';
  const fp = (await c.query(`select 1 from payments p join payments q on q.payer_fp = p.payer_fp
      where p.workspace_id = $1 and p.payer_fp is not null and (q.user_id = $2 or q.workspace_id in (select workspace_id from members where user_id = $2)) limit 1`, [wsId, referrerId])).rows[0];
  if (fp) return 'paid with the referrer\'s card or payer account';
  return null;
}

/**
 * Pay referral commission on a plan payment (AUD-1, SEC-2). `cashCents` is the cash part, `txId` the wallet_tx of the
 * payment (for the fee share), `cycle` 'month' | 'year'. Returns null (nothing paid) or { referrer, amount, rate, held }.
 */
async function payCommission(c, ws, cashCents, ref, { txId = null, cycle = 'month' } = {}) {
  if (cashCents <= 0) return null;
  if (!(await settings.feature('referrals'))) return null;
  const owner = (await c.query('select * from users where id = $1', [ws.owner_user_id])).rows[0];
  if (!owner || !owner.referred_by || String(owner.referred_by) === String(owner.id)) return null;
  const rs = await referralSettings();
  const paying = (await c.query(`select count(distinct u.id)::int n from users u join workspaces w on w.owner_user_id = u.id
    where u.referred_by = $1 and w.plan_status = 'active' and w.paid_ever`, [owner.referred_by])).rows[0].n;
  let rate = Number(paying >= rs.tier3_min ? rs.rates[2] : paying >= rs.tier2_min ? rs.rates[1] : rs.rates[0]);
  rate = Math.min(rate, cycle === 'year' ? rs.yearly_cap_pct : rs.commission_cap_pct);
  const fee = rs.net_of_fees !== false && txId ? await feeShare(c, ws.id, txId) : 0;
  const base = Math.max(0, cashCents - fee);
  const amount = Math.floor(base * rate / 100);
  if (amount <= 0) return null;
  const why = await selfReferralSignal(c, owner, owner.referred_by, ws.id);
  const settles = addDays(new Date(), rs.settle_days);
  await c.query("insert into referral_ledger(user_id, kind, amount_cents, from_workspace_id, rate, settles_at, ref, held, hold_reason) values ($1,'earning',$2,$3,$4,$5,$6,$7,$8)",
    [owner.referred_by, amount, ws.id, rate, settles, ref, !!why, why]);
  if (why) {
    require('../lib/log').warn('referral earning held for review', { referrer: owner.referred_by, workspace: ws.id, reason: why });
    return { referrer: owner.referred_by, amount, rate, settles, referredName: owner.name, held: true, base };
  }
  return { referrer: owner.referred_by, amount, rate, settles, referredName: owner.name, held: false, base };
}

/**
 * One commission per payment (AUD-1). Pays the Castvoo referral when it owns the attribution, and returns what to
 * tell VooSquare: `voo` true = send the commissionable spend (VooSquare's affiliate owns it, or nobody does).
 * The decision and the base are kept on the wallet_tx row (commission_to, commission_base_cents).
 */
async function settleCommission(c, ws, paid, ref, cycle) {
  if (!paid || !paid.txId || paid.cash <= 0) return { commission: null, voo: true, base: paid ? paid.cash : 0 };
  const owner = (await c.query('select id, referred_by, referred_at, voo_id, voo_ref, voo_linked_at, created_at from users where id = $1', [ws.owner_user_id])).rows[0] || {};
  const rs = await referralSettings();
  const who = attributionOf(owner, rs);
  const fee = rs.net_of_fees !== false ? await feeShare(c, ws.id, paid.txId) : 0;
  const base = Math.max(0, paid.cash - fee);
  let commission = null;
  if (who === 'castvoo_referral') commission = await payCommission(c, ws, paid.cash, ref, { txId: paid.txId, cycle });
  const to = commission ? 'castvoo_referral' : who === 'voosquare' ? 'voosquare' : 'none';
  await c.query('update wallet_tx set commission_to = $2, commission_base_cents = $3 where id = $1', [paid.txId, to, base]);
  return { commission, voo: !commission, base };
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
  // The Free plan is never "paid": moving to it is a drop (nothing charged, no receipt).
  if (isFreePlan(plan)) return dropToFree(wsId, { expect });
  const result = await db.tx(async (c) => {
    const ws = (await c.query('select * from workspaces where id = $1 for update', [wsId])).rows[0];
    if (expect && !expect(ws)) return { skipped: true };
    const { price: planPrice, couponUsed } = await priceWithCoupon(c, ws, plan, cycle);
    // Extra team seats renew with the plan, in the same payment (the lower number the owner asked for, if any).
    const unit = await seatPrice(cycle);
    const seats = unit > 0 ? seatsNext(ws) : 0;
    const price = planPrice + seats * unit;
    const ref = `plan-${wsId}-${Date.now()}`;
    const paid = await takePayment(c, wsId, price, `${plan.name} plan · ${cycle === 'year' ? 'yearly' : 'monthly'}${seats ? ` + ${plural(seats, 'extra seat')}` : ''}`, ref);
    if (!paid) return { short: true, price };
    const start = new Date();
    const end = addDays(start, periodDays(cycle));
    await c.query(`update workspaces set plan_code = $2, billing_cycle = $3, plan_status = 'active', period_end = $4, trial_ends_at = null,
      cancel_at_period_end = false, pending_plan_code = null, pending_cycle = null, ai_used = 0, ai_period_start = now(), paid_ever = true, reminded_at = null,
      dropped_from = null, dropped_cycle = null, dropped_at = null,
      legacy_plan_code = case when plan_code = $2 and plan_status = 'active' then legacy_plan_code else null end,
      coupon_months_left = greatest(0, coupon_months_left - $5), coupon_id = case when coupon_months_left - $5 <= 0 then null else coupon_id end,
      extra_seats = $6, pending_extra_seats = null
      where id = $1`, [wsId, plan.code, cycle, end, couponUsed ? 1 : 0, seats]);
    // AUD-8: a move to a smaller plan switches off the live flows beyond its limit (kept, paused_by_plan).
    const flowsOff = await trimFlows(c, wsId, plan, ws.keep_flow_ids);
    // One commission per payment: the Castvoo referral or the VooSquare affiliate (AUD-1).
    const { commission, voo, base } = await settleCommission(c, ws, paid, ref, cycle);
    // VooSquare: spend (cash part, net of fees) + plan_started / plan_renewed, queued in this same transaction.
    // No spend when the Castvoo referral was paid: plan_started / plan_renewed carry no commission.
    await voosquare.planPaid(c, { wsId, txId: paid.txId, plan, cycle, priceCents: price, cashCents: voo ? base : 0, first: !ws.paid_ever, at: start });
    return { ok: true, price, planPrice, seats, seatUnit: unit, start, end, commission, ref, wsName: ws.name, ownerId: ws.owner_user_id, flowsOff };
  });
  if (result.skipped) return result;
  if (result.short) throw httpError(402, `Your wallet needs ${fmtUSD(result.price)} for this plan. Top up and try again.`, 'wallet_short', { needed: result.price / 100 });

  const owner = await db.one('select * from users where id = $1', [result.ownerId]);
  const wsNow = await db.one('select * from workspaces where id = $1', [wsId]);
  await email.send('payment_receipt', owner, {
    plan_name: plan.name, amount: fmtUSD(result.price), period_start: fmtDate(result.start), period_end: fmtDate(result.end),
    extra_seats: result.seats ? `${plural(result.seats, 'seat')} × ${fmtUSD(result.seatUnit)} = ${fmtUSD(result.seats * result.seatUnit)}` : 'None',
    receipt_id: result.ref, wallet_balance: fmtUSD(Number(wsNow.wallet_cents) + Number(wsNow.bonus_cents)), billing_url: require('../config').appUrl + '/#app/wallet',
  });
  if (result.commission && !result.commission.held) {
    const ref = await db.one('select * from users where id = $1', [result.commission.referrer]);
    await email.send('referral_earned', ref, {
      amount: fmtUSD(result.commission.amount), referral_name: (result.commission.referredName || 'Someone').split(' ')[0],
      settle_date: fmtDate(result.commission.settles), referrals_url: require('../config').appUrl + '/#app/referrals',
    });
  }
  return result;
}

const isFreePlan = (plan) => !!plan && Number(plan.price_month_cents) === 0 && Number(plan.price_year_cents) === 0;

/* ---------- Extra team seats ---------- */

/** Price of one extra seat for a billing cycle, in cents (0 = extra seats are not sold). Yearly = 12 months. */
async function seatPrice(cycle = 'month') {
  const b = (await settings.get('billing')) || {};
  const m = Math.max(0, Math.round(Number(b.seat_price_cents ?? 500)) || 0);
  return cycle === 'year' ? m * 12 : m;
}
/** Extra seats that count right now: only on an active paid plan (not the trial, not Free). */
function extraSeatsNow(ws, plan) {
  if (!ws || ws.plan_status !== 'active' || trialOver(ws) || isFreePlan(plan)) return 0;
  return Math.max(0, Number(ws.extra_seats) || 0);
}
/** Extra seats the next renewal pays for. */
const seatsNext = (ws) => Math.max(0, Number(ws.pending_extra_seats != null ? ws.pending_extra_seats : ws.extra_seats) || 0);
/** Seats taken: every member but the setup helper, plus open invites (not for a helper). */
async function seatsTaken(wsId, c = null) {
  const q = c ? (sql, p) => c.query(sql, p).then((r) => r.rows[0]) : db.one;
  const r = await q(`select (select count(*)::int from members where workspace_id = $1 and role <> 'helper')
      + (select count(*)::int from invites where workspace_id = $1 and role <> 'helper' and accepted_at is null and declined_at is null and expires_at > now()) as n`, [wsId]);
  return r.n;
}
/** What the next renewal costs: { plan, seats, total } in cents (plan price before a coupon). */
async function renewalCost(ws, plan, cycle) {
  const unit = await seatPrice(cycle);
  const seats = unit > 0 && !isFreePlan(plan) ? seatsNext(ws) : 0;
  const planCents = priceOf(plan, cycle);
  return { plan: planCents, seats: seats * unit, seat_count: seats, unit, total: planCents + seats * unit };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;

/**
 * The owner sets how many extra seats the workspace has (`target`, 0–500):
 *  - more than now: the new seats are paid now for the rest of the period (prorated, like an upgrade) and renew
 *    with the plan. A wallet that can't cover it answers 402 wallet_short (the dashboard offers a top-up).
 *  - fewer: nothing is refunded; the lower number applies at the next renewal (pending_extra_seats). Not below the
 *    seats in use (members and open invites): remove someone first.
 *  - the same: cancels a lower number asked for earlier.
 * Paid plans only (the trial and Free answer 402 seats_paid_plan). Returns { ok, extra_seats, pending, charged }.
 */
async function setExtraSeats(wsId, target) {
  const want = Number(target);
  if (!Number.isInteger(want) || want < 0 || want > 500) throw badRequest('Pick between 0 and 500 extra seats.');
  const result = await db.tx(async (c) => {
    const ws = (await c.query('select * from workspaces where id = $1 for update', [wsId])).rows[0];
    const plan = await settings.plan(ws.plan_code);
    if (ws.plan_status === 'trial') throw httpError(402, 'Extra seats can be added once your paid plan starts. During the trial you have the trial plan\'s seats.', 'seats_paid_plan');
    if (ws.plan_status !== 'active' || isFreePlan(plan) || trialOver(ws)) throw httpError(402, 'Extra team seats come with a paid plan. Upgrade to add seats.', 'seats_paid_plan');
    const unit = await seatPrice(ws.billing_cycle);
    const cur = Math.max(0, Number(ws.extra_seats) || 0);
    if (!unit && want > cur) throw httpError(403, 'Extra seats are not available right now.', 'seats_off');
    if (want > cur) {
      const add = want - cur;
      const left = Math.max(0, new Date(ws.period_end).getTime() - Date.now()) / (periodDays(ws.billing_cycle) * DAY);
      const charge = Math.max(0, Math.round(add * unit * Math.min(1, left)));
      const ref = `seats-${wsId}-${Date.now()}`;
      const paid = await takePayment(c, wsId, charge, `${plural(add, 'extra team seat')} (rest of this period)`, ref);
      if (!paid) throw httpError(402, `Your wallet needs ${fmtUSD(charge)} for ${plural(add, 'extra seat')}. Top up and try again.`, 'wallet_short', { needed: charge / 100 });
      await c.query('update workspaces set extra_seats = $2, pending_extra_seats = null where id = $1', [wsId, want]);
      const { voo, base } = await settleCommission(c, ws, paid, ref, ws.billing_cycle);
      if (voo) await voosquare.seatsPaid(c, { wsId, txId: paid.txId, plan, seats: add, cashCents: base, at: new Date() });
      return { ok: true, extra_seats: want, pending: null, charged: charge, added: add, ref, unit, periodEnd: ws.period_end, ownerId: ws.owner_user_id, cycle: ws.billing_cycle, plan };
    }
    if (want < cur) {
      const taken = await seatsTaken(wsId, c);
      const room = Number(plan.seats) + want;
      if (taken > room) {
        throw httpError(409, `${plural(taken, 'person uses a seat', 'people use seats')} now (invites count too) and ${plural(room, 'seat')} would be left. Remove someone or cancel an invite first, then lower your seats.`, 'seats_in_use', { taken, room });
      }
      await c.query('update workspaces set pending_extra_seats = $2 where id = $1', [wsId, want]);
      return { ok: true, extra_seats: cur, pending: want, charged: 0, periodEnd: ws.period_end };
    }
    await c.query('update workspaces set pending_extra_seats = null where id = $1', [wsId]);
    return { ok: true, extra_seats: cur, pending: null, charged: 0 };
  });
  if (result.added) {
    const owner = await db.one('select * from users where id = $1', [result.ownerId]);
    const wsNow = await db.one('select wallet_cents, bonus_cents from workspaces where id = $1', [wsId]);
    await email.send('seats_receipt', owner, {
      seats_added: plural(result.added, 'extra team seat'), extra_seats_total: String(result.extra_seats), amount: fmtUSD(result.charged),
      seat_price: `${fmtUSD(result.unit)} a ${result.cycle === 'year' ? 'year' : 'month'} each`, period_end: fmtDate(result.periodEnd),
      receipt_id: result.ref, wallet_balance: fmtUSD(Number(wsNow.wallet_cents) + Number(wsNow.bonus_cents)), team_url: require('../config').appUrl + '/#app/settings?tab=team',
    });
  }
  return { ok: true, extra_seats: result.extra_seats, pending: result.pending, charged: result.charged || 0 };
}

/**
 * Drop a workspace to the Free plan: the trial ended unpaid, a plan ended, or the wallet could not cover a renewal.
 * Nothing is deleted. The first live Welcome Flow keeps welcoming (as the Free welcome, with the Castvoo line);
 * other flows, follow-ups and scheduled messages are switched off and kept. `remember` = the plan it had, so a
 * top-up that covers it starts it again. `expect(ws)` works like in activate().
 */
async function dropToFree(wsId, { expect = null, remember = null, rememberCycle = null } = {}) {
  const free = await settings.plan('free');
  if (!free) return { skipped: true, reason: 'no_free_plan' };
  return db.tx(async (c) => {
    const ws = (await c.query('select * from workspaces where id = $1 for update', [wsId])).rows[0];
    if (!ws || (expect && !expect(ws))) return { skipped: true };
    await c.query(`update workspaces set plan_code = $2, plan_status = 'active', billing_cycle = 'month', period_end = null, trial_ends_at = null,
      cancel_at_period_end = false, pending_plan_code = null, pending_cycle = null, ai_used = 0, ai_period_start = now(), reminded_at = null,
      dropped_from = $3, dropped_cycle = $4, dropped_at = now(), extra_seats = 0, pending_extra_seats = null where id = $1`, [wsId, free.code, remember, rememberCycle]);
    const off = await trimFlows(c, wsId, free, ws.keep_flow_ids);
    if (!(free.features || []).includes('drips')) await c.query("update sequences set active = false, paused_by_plan = true where workspace_id = $1 and trigger_type <> 'join_request' and active", [wsId]);
    if (!(free.features || []).includes('broadcasts')) await c.query("update broadcasts set status = 'draft' where workspace_id = $1 and status in ('scheduled','pending_approval')", [wsId]);
    return { ok: true, dropped: true, from: ws.plan_code, flowsOff: off };
  });
}

/**
 * Switch off the live Welcome Flows beyond the plan's limit, inside transaction c (AUD-8). The flows the owner
 * picked (workspaces.keep_flow_ids, set when they chose the smaller plan) stay first, then the oldest. The others are
 * kept as drafts with paused_by_plan, so the dashboard shows "paused by your plan" and the owner can swap them.
 * Returns how many were switched off.
 */
async function trimFlows(c, wsId, plan, keepIds) {
  if (plan.flows == null || Number(plan.flows) === UNLIMITED) return 0;
  const live = (await c.query("select id from sequences where workspace_id = $1 and trigger_type = 'join_request' and active order by id", [wsId])).rows.map((r) => String(r.id));
  const pick = (keepIds || []).map(String).filter((id) => live.includes(id));
  const order = [...pick, ...live.filter((id) => !pick.includes(id))];
  const off = order.slice(Math.max(0, Number(plan.flows)));
  if (off.length) await c.query('update sequences set active = false, paused_by_plan = true where id = any($1::bigint[])', [off]);
  if (keepIds) await c.query('update workspaces set keep_flow_ids = null where id = $1', [wsId]);
  return off.length;
}

/** Upgrade during a paid period: pay the difference for the days left. */
async function upgradeNow(wsId, planCode) {
  const plan = await settings.plan(planCode);
  if (!plan || !plan.active) throw badRequest('That plan is not available.');
  const now = await db.one('select plan_code, billing_cycle from workspaces where id = $1', [wsId]);
  // From Free there is no period to top up: the new plan simply starts now.
  if (isFreePlan(await settings.plan(now.plan_code))) {
    const r = await activate(wsId, planCode, now.billing_cycle || 'month', { expect: (w) => w.plan_code === now.plan_code && w.plan_status === 'active' });
    if (r.skipped) throw httpError(409, 'Your plan changed a moment ago. Refresh the page and try again.', 'plan_changed');
    return { ok: true, charged: r.price };
  }
  return db.tx(async (c) => {
    const ws = (await c.query('select * from workspaces where id = $1 for update', [wsId])).rows[0];
    if (ws.plan_status !== 'active') throw httpError(409, 'Your plan changed a moment ago. Refresh the page and try again.', 'plan_changed');
    const cur = await settings.plan(ws.plan_code);
    const left = Math.max(0, new Date(ws.period_end).getTime() - Date.now()) / (periodDays(ws.billing_cycle) * DAY);
    const diff = Math.max(0, Math.round((priceOf(plan, ws.billing_cycle) - priceOf(cur, ws.billing_cycle)) * left));
    const paid = await takePayment(c, wsId, diff, `Upgrade to ${plan.name} (rest of this period)`, `upgrade-${wsId}-${Date.now()}`);
    if (!paid) throw httpError(402, `Your wallet needs ${fmtUSD(diff)} to upgrade now. Top up and try again.`, 'wallet_short', { needed: diff / 100 });
    await c.query('update workspaces set plan_code = $2, pending_plan_code = null, pending_cycle = null where id = $1', [wsId, plan.code]);
    const { voo, base } = await settleCommission(c, ws, paid, `upgrade-${wsId}`, ws.billing_cycle);
    if (voo) await voosquare.upgradePaid(c, { wsId, txId: paid.txId, plan, cashCents: base, at: new Date() });
    return { ok: true, charged: diff };
  });
}

/** Extra seats for the dashboard: price, what renews, and whether this workspace can buy them now. */
async function seatsInfo(ws, l = null) {
  l = l || (await limits(ws));
  const cycle = ws.billing_cycle || 'month';
  const unit = await seatPrice(cycle);
  const monthUnit = await seatPrice('month');
  const paid = ws.plan_status === 'active' && !isFreePlan(l.plan) && !trialOver(ws);
  const left = paid && ws.period_end ? Math.max(0, new Date(ws.period_end).getTime() - Date.now()) / (periodDays(cycle) * DAY) : 0;
  const next = paid ? (ws.pending_extra_seats != null ? Number(ws.pending_extra_seats) : l.extra_seats) : 0;
  return {
    price_month: monthUnit / 100, price: unit / 100, cycle, on_sale: monthUnit > 0, can_buy: paid && monthUnit > 0,
    reason: !paid ? (ws.plan_status === 'trial' ? 'trial' : 'free') : monthUnit > 0 ? null : 'off',
    plan_seats: l.plan_seats, extra: l.extra_seats, next, pending: paid && ws.pending_extra_seats != null ? Number(ws.pending_extra_seats) : null,
    taken: await seatsTaken(ws.id), period_left: Math.round(left * 10000) / 10000, period_end: paid ? ws.period_end : null,
    renews: next * unit / 100,
  };
}

/** What a workspace sees on the Wallet → Plan card. */
async function planState(ws) {
  const l = await limits(ws);
  const u = await usage(ws.id);
  const meter = await joinMeter(ws);
  const plans = await settings.plans({ activeOnly: true });
  const coupon = ws.coupon_id ? await db.one('select code, percent from offers where id = $1', [ws.coupon_id]) : null;
  // "Switch to yearly, save 2 months": shown after the 2nd monthly payment.
  const payments = ws.billing_cycle === 'month' && ws.plan_status === 'active' && !isFreePlan(l.plan)
    ? (await db.one("select count(*)::int n from wallet_tx where workspace_id = $1 and kind = 'plan' and amount_cents < 0", [ws.id])).n : 0;
  const yearlySave = payments >= 2 ? Number(l.plan.price_month_cents) * 12 - Number(l.plan.price_year_cents) : 0;
  return {
    plan_code: l.plan.code, plan_name: l.plan.name, status: ws.plan_status, cycle: ws.billing_cycle, free: isFreePlan(l.plan),
    trial_ends_at: ws.trial_ends_at, period_end: ws.period_end, cancel_at_period_end: ws.cancel_at_period_end, ai_refill_at: aiRefillAt(ws),
    pending_plan_code: ws.pending_plan_code, dropped_from: ws.dropped_from, coupon: coupon && ws.coupon_months_left > 0 ? { ...coupon, months_left: ws.coupon_months_left } : null,
    limits: { connections: l.connections, subscribers: l.subscribers, ai_writes: l.ai_writes, seats: l.seats, plan_seats: l.plan_seats, extra_seats: l.extra_seats, join_requests: l.join_requests, flows: l.flows, flow_steps: l.flow_steps, ab_variants: l.ab_variants },
    seats: await seatsInfo(ws, l),
    usage: { connections: u.connections, bots: u.bots, subscribers: u.subscribers, ai_writes: u.ai_used, seats: u.seats, join_requests: meter.used, flows: u.flows, active_flows: u.active_flows },
    features: [...featureSet(l)], branding: l.branding, welcome_only: !l.features.includes('broadcasts') && !l.legacy,
    join: meter,
    suggest_yearly: yearlySave > 0 ? { save: yearlySave / 100 } : null,
    plans: plans.map((p) => ({ code: p.code, name: p.name, price_month: p.price_month_cents / 100, price_year: p.price_year_cents / 100, connections: p.connections, subscribers: p.subscribers, ai_writes: p.ai_writes, seats: p.seats, popular: p.popular,
      join_requests: p.join_requests, flows: p.flows, flow_steps: p.flow_steps, branding: p.branding, features: p.features || [] })),
  };
}

module.exports = { seatPrice, seatsNext, seatsTaken, seatsInfo, setExtraSeats, renewalCost, extraSeatsNow, UNLIMITED, LEGACY_FEATURES, featureSet, meterBump, meterEnsure, referralSettings, attributionOf, selfReferralSignal, mailbox, feeShare, settleCommission, trimFlows, aiRefillAt, effectivePlan, limits, hasFeature, requirePlanFeature, planFor, joinMeter, meterStart, isFreePlan, dropToFree, usage, assertCanSend, assertCanConnect, useAi, refundAi, activate, upgradeNow, planState, takePayment, payCommission, priceOf, periodDays };

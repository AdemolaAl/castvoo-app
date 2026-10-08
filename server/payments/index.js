'use strict';
/*
 * Wallet top-ups: automatic gateways (Paystack, Flutterwave, Gatevoo), manual USDT, and the team's own
 * manual methods (bank transfer, mobile money, a crypto wallet... added in Admin → Countries & payments).
 *
 *   start()   creates a pending payment and returns what the customer does next
 *   credit()  marks a payment paid and adds the money to the wallet (safe to call twice)
 *   verify()  asks the provider whether a payment really succeeded (never trust the browser)
 *
 * Two kinds of method:
 *   AUTOMATIC  a gateway confirms the payment server to server, then we call credit(). Listed in GATEWAYS below.
 *   MANUAL     provider 'manual' (and manual USDT). The customer pays by themselves and sends proof; Finance
 *              checks it and presses Approve in Admin → Payments, which calls credit(). No code is needed to add
 *              one: the team does it in the admin.
 *
 * HOW TO ADD A NEW AUTOMATIC GATEWAY (say "Stripe"). Full steps: docs/INTEGRATIONS.md → "Adding a payment gateway".
 *   1. config.js: its keys, and `stripe: !!key` in integrations()
 *   2. a migration: allow 'stripe' in payment_methods_provider_check, and add a method row (or put it in seed.js METHODS)
 *   3. here: startStripe(ctx, m, base) inserts the payment with insert() and returns { kind: 'redirect', url, reference },
 *      and verifyStripe(reference) asks Stripe whether it is paid FOR THE RIGHT AMOUNT, then calls credit(reference).
 *      Add `stripe: { start: startStripe, verify: verifyStripe }` to GATEWAYS.
 *   4. services/settings.js methodsFor(): offer the method only when integ.stripe is true
 *   5. routes/payment-webhooks.js: a webhook that checks the signature and calls verify(reference)
 *   6. test/helpers/fakes.js: a fake Stripe, and a test in test/e2e/payments.test.js
 */

const db = require('../db');
const config = require('../config');
const log = require('../lib/log');
const settings = require('../services/settings');
const email = require('../services/email');
const { randomToken, httpError, badRequest, fmtUSD, cents } = require('../lib/util');

const localAmount = (usdCents, rate) => Math.round(usdCents * Number(rate)) / 100; // e.g. 1550.00 NGN per $1
const FLW_OPTIONS = { flw_ke: 'card,mpesa', flw_cm: 'card,mobilemoneyfranco', flw_card: 'card' };

async function start(ctx, { amount, methodKey }) {
  await settings.requireFeature('topups');
  const b = await settings.get('billing');
  const amountCents = cents(amount);
  if (!Number.isFinite(amountCents) || amountCents < b.min_topup_cents) throw badRequest(`The smallest top-up is ${fmtUSD(b.min_topup_cents)}.`);
  if (amountCents > b.max_topup_cents) throw badRequest(`The largest single top-up is ${fmtUSD(b.max_topup_cents)}. Split it into smaller top-ups.`);
  const methods = await settings.methodsFor(ctx.user.country || 'XX');
  const m = methods.find((x) => x.key === methodKey);
  if (!m) throw badRequest('That payment method is not available for your country. Change your country in Settings if it is wrong.');
  const bonus = await settings.topupBonus(amountCents);
  const ref = 'cv_' + randomToken(12).replace(/[^A-Za-z0-9]/g, '').slice(0, 14);
  const base = { workspace_id: ctx.workspace.id, user_id: ctx.user.id, method_key: m.key, reference: ref, amount_cents: amountCents, bonus_cents: bonus };

  if (m.gatevoo) return GATEWAYS.gatevoo.start(ctx, m, base);
  if (GATEWAYS[m.provider]) return GATEWAYS[m.provider].start(ctx, m, base);
  if (m.provider === 'crypto' && m.key === 'usdt') return startUsdt(ctx, m, base);
  if (m.provider === 'manual') return startManual(ctx, m, base);
  throw badRequest('That payment method is not available.');
}

/* ---------- Automatic gateways: start ---------- */

async function startCard(ctx, m, base) {
  if (!ctx.user.email) throw httpError(409, 'Add your email in Settings first. The payment provider sends your receipt there.', 'email_needed');
  const ref = base.reference, ws = ctx.workspace, amountCents = base.amount_cents;
  const local = localAmount(amountCents, m.usd_rate);
  await insert({ ...base, provider: m.provider, currency: m.currency, amount_local: local });
  const returnUrl = `${config.appUrl}/pay/return?ref=${ref}`;
  let url, ext;
  if (m.provider === 'paystack') {
    const r = await fetch(config.paystack.apiBase + '/transaction/initialize', {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { Authorization: 'Bearer ' + config.paystack.secretKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ctx.user.email, amount: Math.round(local * 100), currency: m.currency, reference: ref, callback_url: returnUrl, metadata: { workspace_id: ws.id, usd: amountCents / 100 } }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.status) { await fail(ref, 'Paystack: ' + (j.message || r.status)); throw httpError(502, 'Paystack could not start the payment: ' + (j.message || 'please try again'), 'paystack_error'); }
    url = j.data.authorization_url; ext = j.data.access_code;
  } else {
    const r = await fetch(config.flutterwave.apiBase + '/v3/payments', {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { Authorization: 'Bearer ' + config.flutterwave.secretKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_ref: ref, amount: local, currency: m.currency, redirect_url: returnUrl, payment_options: FLW_OPTIONS[m.key] || 'card',
        customer: { email: ctx.user.email, name: ctx.user.name }, customizations: { title: 'Castvoo wallet top-up', description: `${fmtUSD(amountCents)} for your Castvoo wallet` }, meta: { workspace_id: ws.id } }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.status !== 'success') { await fail(ref, 'Flutterwave: ' + (j.message || r.status)); throw httpError(502, 'Flutterwave could not start the payment: ' + (j.message || 'please try again'), 'flutterwave_error'); }
    url = j.data.link;
  }
  await db.query('update payments set checkout_url = $2, external_id = $3 where reference = $1', [ref, url, ext || null]);
  return { kind: 'redirect', url, reference: ref, currency: m.currency, amount_local: local };
}

async function startGatevoo(ctx, m, base) {
  const ref = base.reference, amountCents = base.amount_cents;
  await insert({ ...base, provider: 'gatevoo', currency: 'USD', amount_local: amountCents / 100 });
  const r = await fetch(config.gatevoo.url + '/api/v1/invoices', {
    method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { Authorization: 'Bearer ' + config.gatevoo.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount_usd: amountCents / 100, order_id: ref, customer_name: (ctx.user.name || '').split(' ')[0] || undefined, description: 'Castvoo wallet top-up', redirect_url: `${config.appUrl}/pay/return?ref=${ref}`, metadata: { workspace_id: ctx.workspace.id } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.checkout_url) { await fail(ref, 'Gatevoo: ' + (j.error || j.message || r.status)); throw httpError(502, 'The crypto checkout could not start. Please try again.', 'gatevoo_error'); }
  await db.query('update payments set checkout_url = $2, external_id = $3 where reference = $1', [ref, j.checkout_url, j.id]);
  return { kind: 'gatevoo', url: j.checkout_url, invoice_id: j.id, reference: ref };
}

/* ---------- Manual methods: start ---------- */

/** Pick one of the 99 cents values (1..99 above `from`) that no open payment uses. Throws when all are taken. */
function freeCents(from, taken, code = 'amount_busy') {
  const free = [];
  for (let i = 1; i <= 99; i++) if (!taken.has(from + i)) free.push(from + i);
  if (!free.length) throw httpError(409, 'Too many people are paying this exact amount right now. Try a slightly different amount.', code);
  return free[Math.floor(Math.random() * free.length)];
}

async function startUsdt(ctx, m, base) {
  const c = await settings.get('crypto');
  if (!c.usdt_address) throw badRequest('This coin is not available right now.');
  const amountCents = base.amount_cents;
  // Everyone sends to the same address, so each top-up gets its own exact amount (e.g. 100.37 USDT).
  // The team approves only when exactly that amount arrived, so nobody can claim someone else's payment.
  const exact = await db.tx(async (tc) => {
    await tc.query('select pg_advisory_xact_lock(7002)');
    const taken = new Set((await tc.query(`select amount_cents from payments where provider = 'manual_crypto' and status = 'pending'
      and created_at > now() - interval '7 days' and amount_cents between $1 and $1 + 99`, [amountCents])).rows.map((r) => Number(r.amount_cents)));
    const total = freeCents(amountCents, taken, 'crypto_busy');
    await tc.query(`insert into payments(workspace_id, user_id, provider, method_key, reference, amount_cents, bonus_cents, currency, amount_local, coin)
      values ($1,$2,'manual_crypto',$3,$4,$5,$6,'USD',$7,'USDT')`, [base.workspace_id, base.user_id, m.key, base.reference, total, base.bonus_cents, total / 100]);
    return total;
  });
  return { kind: 'crypto', coin: 'USDT', network: 'TRON (TRC20)', address: c.usdt_address, amount_usd: exact / 100, exact: true, reference: base.reference };
}

/**
 * A method the team added in the admin. Like manual USDT, every open payment gets its own exact amount (unique cents),
 * so Finance can match a bank or wallet transfer to one customer. In US dollars the cents are added to the top-up
 * (and credited). In a local currency the customer pays the local amount plus unique local cents, and the USD amount
 * they asked for is what gets credited. The customer can never change the amount: only Finance can, when approving.
 */
async function startManual(ctx, m, base) {
  const amountCents = base.amount_cents;
  if (m.min_cents != null && amountCents < Number(m.min_cents)) throw badRequest(`With ${m.label} the smallest top-up is ${fmtUSD(m.min_cents)}.`);
  if (m.max_cents != null && amountCents > Number(m.max_cents)) throw badRequest(`With ${m.label} the largest top-up is ${fmtUSD(m.max_cents)}. Pick another method or a smaller amount.`);
  const cur = m.currency && m.currency !== 'USD' ? m.currency : 'USD';
  await db.tx(async (tc) => {
    await tc.query('select pg_advisory_xact_lock(7003)');
    if (cur === 'USD') {
      const taken = new Set((await tc.query(`select amount_cents from payments where method_key = $2 and status = 'pending'
        and created_at > now() - interval '7 days' and amount_cents between $1 and $1 + 99`, [amountCents, m.key])).rows.map((r) => Number(r.amount_cents)));
      const total = freeCents(amountCents, taken);
      await insertWith(tc, { ...base, amount_cents: total, provider: 'manual', currency: 'USD', amount_local: total / 100 });
    } else {
      const whole = Math.round((amountCents / 100) * Number(m.usd_rate)) * 100; // local cents, whole units
      const taken = new Set((await tc.query(`select round(amount_local * 100)::bigint c from payments where method_key = $2 and status = 'pending'
        and created_at > now() - interval '7 days' and amount_local * 100 between $1 and $1 + 99`, [whole, m.key])).rows.map((r) => Number(r.c)));
      const local = freeCents(whole, taken);
      await insertWith(tc, { ...base, provider: 'manual', currency: cur, amount_local: local / 100 });
    }
  });
  return manualView(await db.one('select * from payments where reference = $1', [base.reference]), m);
}

/** What the customer needs to pay a manual method (also used to open it again from the wallet page). */
function manualView(p, m) {
  return {
    kind: 'manual', reference: p.reference, status: p.status,
    amount_usd: Number(p.amount_cents) / 100, currency: p.currency || 'USD', amount_due: Number(p.amount_local), exact: true,
    proof_ref_sent: p.proof_ref || null, proof_image_sent: !!p.proof_path, submitted: !!p.submitted_at,
    method: { key: m.key, label: m.label, detail: m.detail, kind: m.kind, icon: m.icon, color: m.color, instructions: m.instructions, proof_ref: m.proof_ref, proof_image: m.proof_image },
  };
}

async function insert(p) { return insertWith(db, p); }
async function insertWith(c, p) {
  await c.query(`insert into payments(workspace_id, user_id, provider, method_key, reference, amount_cents, bonus_cents, currency, amount_local, coin)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [p.workspace_id, p.user_id, p.provider, p.method_key, p.reference, p.amount_cents, p.bonus_cents, p.currency, p.amount_local, p.coin || null]);
}
async function fail(ref, reason) { await db.query("update payments set status = 'failed', reason = $2 where reference = $1 and status = 'pending'", [ref, String(reason).slice(0, 300)]); }

/**
 * Mark a payment paid and credit the wallet. Idempotent: a second call does nothing.
 * `override` lets finance staff credit a different USD amount for a manual payment (manual crypto or a team method).
 * Only a PENDING payment is credited (SEC-3): the status is checked after the row lock, so a Reject pressed at the same
 * moment wins or loses as one decision. `allowFailed` lets an automatic gateway credit a payment whose start was marked
 * failed when the provider now says it succeeded; a rejected payment is never credited.
 * Returns { already, p } or { refused: <status>, p } or the credit result.
 * `feeCents` / `payerFp`: the processor fee in USD cents and a hashed payer fingerprint, when the provider reports them.
 */
async function credit(reference, { reviewedBy = null, overrideCents = null, txid = null, allowFailed = false, feeCents = null, payerFp = null } = {}) {
  const res = await db.tx(async (c) => {
    const p = (await c.query('select * from payments where reference = $1 for update', [reference])).rows[0];
    if (!p) throw httpError(404, 'Payment not found.', 'not_found');
    if (p.status === 'paid') return { already: true, p };
    if (p.status !== 'pending' && !(allowFailed && p.status === 'failed')) return { already: false, refused: p.status, p };
    const amount = overrideCents != null ? overrideCents : Number(p.amount_cents);
    const bonus = overrideCents != null ? await settings.topupBonus(amount) : Number(p.bonus_cents);
    await c.query(`update payments set status = 'paid', paid_at = now(), amount_cents = $2, bonus_cents = $3, reviewed_by = $4, txid = coalesce($5, txid),
      fee_cents = coalesce($6, fee_cents), payer_fp = coalesce($7, payer_fp) where id = $1`,
    [p.id, amount, bonus, reviewedBy, txid, Number.isFinite(feeCents) && feeCents >= 0 ? Math.round(feeCents) : null, payerFp || null]);
    await c.query('update workspaces set wallet_cents = wallet_cents + $2, bonus_cents = bonus_cents + $3 where id = $1', [p.workspace_id, amount, bonus]);
    let label = { paystack: 'Paystack', flutterwave: 'Flutterwave', gatevoo: 'Crypto (Gatevoo)', manual_crypto: p.coin || 'Crypto' }[p.provider] || p.provider;
    if (p.provider === 'manual') label = ((await c.query('select label from payment_methods where key = $1', [p.method_key])).rows[0] || {}).label || 'Manual payment';
    await c.query("insert into wallet_tx(workspace_id, kind, amount_cents, cash_cents, method, ref, note, created_by) values ($1,'topup',$2,$2,$3,$4,'Top up',$5)", [p.workspace_id, amount, label, p.reference, reviewedBy]);
    if (bonus > 0) await c.query("insert into wallet_tx(workspace_id, kind, amount_cents, bonus_part_cents, method, ref, note) values ($1,'bonus',$2,$2,'Offer',$3,'Top-up bonus')", [p.workspace_id, bonus, p.reference]);
    // VooSquare: wallet_topup (money in, no commission). The spend is sent when a plan uses the money.
    await require('../services/voosquare').topupPaid(c, { payment: { ...p, amount_cents: amount, txid: txid || p.txid }, label, at: new Date() });
    return { already: false, p: { ...p, amount_cents: amount, bonus_cents: bonus }, label };
  });
  if (res.already || res.refused) return res;
  const ws = await db.one('select * from workspaces where id = $1', [res.p.workspace_id]);
  const user = await db.one('select * from users where id = $1', [res.p.user_id]);
  await email.send('topup_received', user, {
    amount: fmtUSD(res.p.amount_cents), bonus: fmtUSD(res.p.bonus_cents), method: res.label, new_balance: fmtUSD(Number(ws.wallet_cents) + Number(ws.bonus_cents)),
    receipt_id: res.p.reference, wallet_url: config.appUrl + '/#app/wallet',
  });
  // A paused plan starts again by itself once the wallet covers it.
  if (ws.plan_status === 'paused') {
    await require('../services/billing').activate(ws.id, ws.pending_plan_code || ws.plan_code, ws.pending_cycle || ws.billing_cycle, { expect: (w) => w.plan_status === 'paused' }).catch(() => {});
  }
  // Dropped to Free because the wallet was short: the plan they had starts again once the wallet covers it.
  if (ws.plan_code === 'free' && ws.dropped_from && ws.dropped_from !== 'free') {
    await require('../services/billing').activate(ws.id, ws.dropped_from, ws.dropped_cycle || 'month', { expect: (w) => w.plan_code === 'free' && w.dropped_from === ws.dropped_from }).catch(() => {});
  }
  return res;
}

/**
 * A paid top-up was disputed / charged back (Paystack webhook, or recorded by finance staff for other providers).
 * Once per payment (refunds policy §9):
 *  - the disputed money comes out of the wallet (the top-up's cash, and what is left of its bonus). The wallet can go
 *    below zero; then a paid plan moves to the Free plan at once (nothing is deleted, the plan is remembered and a
 *    top-up that covers the balance and the plan starts it again),
 *  - unsettled referral earnings from that customer are cancelled,
 *  - VooSquare is told, which reverses the affiliate commission on the plan payments that used this money.
 * Returns { already, reversed_cents, debited_cents, wallet_cents, dropped, events }.
 */
async function chargeback(reference, { disputeRef = null } = {}) {
  const out = await db.tx(async (c) => {
    const p = (await c.query('select * from payments where reference = $1 for update', [reference])).rows[0];
    if (!p) throw httpError(404, 'Payment not found.', 'not_found');
    if (p.status !== 'paid') throw badRequest('Only a paid top-up can be charged back.');
    if (p.disputed_at) return { already: true, reversed_cents: 0, debited_cents: 0, events: [] };
    const ws = (await c.query('select * from workspaces where id = $1 for update', [p.workspace_id])).rows[0];
    const cash = Number(p.amount_cents);
    const bonus = Math.min(Math.max(0, Number(ws.bonus_cents)), Number(p.bonus_cents || 0));
    const w = (await c.query('update workspaces set wallet_cents = wallet_cents - $2, bonus_cents = bonus_cents - $3 where id = $1 returning wallet_cents, bonus_cents',
      [ws.id, cash, bonus])).rows[0];
    await c.query(`insert into wallet_tx(workspace_id, kind, amount_cents, cash_cents, bonus_part_cents, method, ref, note)
      values ($1,'chargeback',$2,$3,$4,'Chargeback',$5,'Top-up charged back')`, [ws.id, -(cash + bonus), -cash, -bonus, p.reference]);
    await c.query('update payments set disputed_at = now(), dispute_ref = $2, chargeback_cents = $3 where id = $1', [p.id, disputeRef ? String(disputeRef).slice(0, 120) : null, cash]);
    const reversed = await require('../services/referrals').clawback(c, p.workspace_id, 'dispute');
    const events = await require('../services/voosquare').chargedBack(c, { payment: p, at: new Date() });
    return { already: false, reversed_cents: reversed, debited_cents: cash + bonus, wallet_cents: Number(w.wallet_cents), events: events.map((e) => e.event_id), workspace_id: p.workspace_id };
  });
  if (out.already) return out;
  log.warn('top-up charged back', { reference, workspace: out.workspace_id, debited_cents: out.debited_cents, wallet_cents: out.wallet_cents });
  out.dropped = false;
  if (out.wallet_cents < 0) {
    const billing = require('../services/billing');
    const ws = await db.one('select * from workspaces where id = $1', [out.workspace_id]);
    const plan = await settings.plan(ws.plan_code);
    if (ws.plan_status !== 'cancelled' && plan && !billing.isFreePlan(plan)) {
      const r = await billing.dropToFree(ws.id, { expect: (w) => w.plan_code === ws.plan_code && Number(w.wallet_cents) < 0, remember: ws.plan_code, rememberCycle: ws.billing_cycle });
      out.dropped = !!r.ok;
    }
  }
  return out;
}

/**
 * Castvoo won the dispute (the bank gave the money back): the charged-back amount returns to the wallet. Once.
 */
async function disputeWon(reference, { by = null } = {}) {
  const res = await db.tx(async (c) => {
    const p = (await c.query('select * from payments where reference = $1 for update', [reference])).rows[0];
    if (!p) throw httpError(404, 'Payment not found.', 'not_found');
    if (!p.disputed_at) throw badRequest('This payment has no chargeback recorded.');
    if (p.dispute_won_at) return { already: true };
    const back = Number(p.chargeback_cents || 0);
    await c.query('update payments set dispute_won_at = now() where id = $1', [p.id]);
    if (back > 0) {
      await c.query('update workspaces set wallet_cents = wallet_cents + $2 where id = $1', [p.workspace_id, back]);
      await c.query("insert into wallet_tx(workspace_id, kind, amount_cents, cash_cents, method, ref, note, created_by) values ($1,'adjustment',$2,$2,'Dispute won',$3,'Chargeback reversed: dispute won',$4)",
        [p.workspace_id, back, p.reference, by]);
    }
    return { already: false, credited_cents: back, workspace_id: p.workspace_id };
  });
  return res;
}

/* ---------- Provider checks (server to server) ---------- */

async function verifyPaystack(reference) {
  const p = await db.one('select * from payments where reference = $1', [reference]);
  if (!p || p.provider !== 'paystack') return false;
  const r = await fetch(`${config.paystack.apiBase}/transaction/verify/${encodeURIComponent(reference)}`, { headers: { Authorization: 'Bearer ' + config.paystack.secretKey }, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  const d = j.data || {};
  if (!j.status || d.status !== 'success') return false;
  if (d.currency !== p.currency || Number(d.amount) < Math.round(Number(p.amount_local) * 100)) {
    log.warn('paystack amount mismatch', { reference, got: d.amount, currency: d.currency });
    await db.query("update payments set reason = 'Amount or currency did not match. Check in Paystack.' where id = $1", [p.id]);
    return false;
  }
  const r2 = await credit(reference, { allowFailed: true, feeCents: localFeeToUsd(Number(d.fees) / 100, p), payerFp: fingerprint(d.authorization && (d.authorization.signature || d.authorization.authorization_code)) });
  return !r2.refused;
}

async function verifyFlutterwave(reference, transactionId) {
  const p = await db.one('select * from payments where reference = $1', [reference]);
  if (!p || p.provider !== 'flutterwave') return false;
  const url = transactionId
    ? `${config.flutterwave.apiBase}/v3/transactions/${encodeURIComponent(transactionId)}/verify`
    : `${config.flutterwave.apiBase}/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + config.flutterwave.secretKey }, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  const d = j.data || {};
  if (j.status !== 'success' || d.status !== 'successful' || d.tx_ref !== reference) return false;
  if (d.currency !== p.currency || Number(d.amount) + 0.001 < Number(p.amount_local)) {
    log.warn('flutterwave amount mismatch', { reference, got: d.amount, currency: d.currency });
    await db.query("update payments set reason = 'Amount or currency did not match. Check in Flutterwave.' where id = $1", [p.id]);
    return false;
  }
  const card = d.card || {};
  const fp = card.last_4digits ? [card.first_6digits, card.last_4digits, card.expiry].join(':') : (d.customer && d.customer.phone_number) || null;
  const r2 = await credit(reference, { allowFailed: true, feeCents: localFeeToUsd(Number(d.app_fee), p), payerFp: fingerprint(fp) });
  return !r2.refused;
}

async function verifyGatevoo(reference) {
  const p = await db.one('select * from payments where reference = $1', [reference]);
  if (!p || p.provider !== 'gatevoo' || !p.external_id) return false;
  const r = await fetch(`${config.gatevoo.url}/api/v1/invoices/${encodeURIComponent(p.external_id)}`, { headers: { Authorization: 'Bearer ' + config.gatevoo.key }, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  const inv = j.invoice || j.data || j;
  if (!r.ok || inv.status !== 'paid') return false;
  // Both must be present and right; a missing field is treated as "not paid".
  if (String(inv.order_id || '') !== reference) { log.warn('gatevoo order mismatch', { reference, got: inv.order_id }); return false; }
  const paidUsd = Number(inv.amount_paid_usd ?? inv.paid_usd ?? inv.amount_usd);
  if (!Number.isFinite(paidUsd) || paidUsd + 0.001 < Number(p.amount_cents) / 100) { log.warn('gatevoo amount missing or short', { reference, got: paidUsd }); return false; }
  const feeUsd = Number(inv.fee_usd ?? inv.network_fee_usd);
  const r2 = await credit(reference, { allowFailed: true, feeCents: Number.isFinite(feeUsd) ? Math.round(feeUsd * 100) : null, payerFp: fingerprint(inv.payer_address || inv.from_address) });
  return !r2.refused;
}

/** A provider fee in local currency units → USD cents, at the payment's own rate. null when unknown. */
function localFeeToUsd(feeLocal, p) {
  if (!Number.isFinite(feeLocal) || feeLocal < 0 || !(Number(p.amount_local) > 0)) return null;
  return Math.round(feeLocal / Number(p.amount_local) * Number(p.amount_cents));
}
/** A payer's card signature / account / wallet, hashed (SEC-2: same payer on two accounts). Never stored raw. */
function fingerprint(v) {
  if (!v) return null;
  return require('node:crypto').createHmac('sha256', config.appSecret || 'castvoo').update('payer:' + String(v)).digest('hex').slice(0, 40);
}

/**
 * The automatic gateways. `start` begins a payment (see start() above), `verify` asks the provider server to server.
 * Keyed by payments.provider. Add a new gateway here (see the steps at the top of this file).
 */
const GATEWAYS = {
  paystack: { start: startCard, verify: (ref) => verifyPaystack(ref) },
  flutterwave: { start: startCard, verify: (ref, extra) => verifyFlutterwave(ref, extra.transaction_id) },
  gatevoo: { start: startGatevoo, verify: (ref) => verifyGatevoo(ref) },
};

async function verify(reference, extra = {}) {
  const p = await db.one('select provider from payments where reference = $1', [reference]);
  if (!p || !GATEWAYS[p.provider]) return false; // manual payments are only ever approved by the team
  return GATEWAYS[p.provider].verify(reference, extra);
}

module.exports = { start, credit, chargeback, disputeWon, fingerprint, verify, verifyPaystack, verifyFlutterwave, verifyGatevoo, localAmount, manualView, GATEWAYS };

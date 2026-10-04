'use strict';
/*
 * Wallet top-ups through Paystack, Flutterwave, Gatevoo (crypto) or manual crypto.
 *
 *   start()   creates a pending payment and returns where to send the customer
 *   credit()  marks a payment paid and adds the money to the wallet (safe to call twice)
 *   verify*() asks the provider whether a payment really succeeded (never trust the browser)
 *
 * To add a provider: write start + verify for it here, add a method row in Admin → Countries,
 * and a webhook route in routes/payment-webhooks.js.
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
  const ws = ctx.workspace;
  const base = { workspace_id: ws.id, user_id: ctx.user.id, method_key: m.key, reference: ref, amount_cents: amountCents, bonus_cents: bonus };

  if (m.provider === 'paystack' || m.provider === 'flutterwave') {
    if (!ctx.user.email) throw httpError(409, 'Add your email in Settings first. The payment provider sends your receipt there.', 'email_needed');
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

  if (m.key === 'gatevoo') {
    await insert({ ...base, provider: 'gatevoo', currency: 'USD', amount_local: amountCents / 100 });
    const r = await fetch(config.gatevoo.url + '/api/v1/invoices', {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { Authorization: 'Bearer ' + config.gatevoo.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount_usd: amountCents / 100, order_id: ref, customer_name: (ctx.user.name || '').split(' ')[0] || undefined, description: 'Castvoo wallet top-up', redirect_url: `${config.appUrl}/pay/return?ref=${ref}`, metadata: { workspace_id: ws.id } }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.checkout_url) { await fail(ref, 'Gatevoo: ' + (j.error || j.message || r.status)); throw httpError(502, 'The crypto checkout could not start. Please try again.', 'gatevoo_error'); }
    await db.query('update payments set checkout_url = $2, external_id = $3 where reference = $1', [ref, j.checkout_url, j.id]);
    return { kind: 'gatevoo', url: j.checkout_url, invoice_id: j.id, reference: ref };
  }

  if (m.provider === 'crypto' && m.key === 'usdt') {
    const c = await settings.get('crypto');
    if (!c.usdt_address) throw badRequest('This coin is not available right now.');
    // Everyone sends to the same address, so each top-up gets its own exact amount (e.g. 100.37 USDT).
    // The team approves only when exactly that amount arrived, so nobody can claim someone else's payment.
    const exact = await db.tx(async (tc) => {
      await tc.query('select pg_advisory_xact_lock(7002)');
      const taken = new Set((await tc.query(`select amount_cents from payments where provider = 'manual_crypto' and status = 'pending'
        and created_at > now() - interval '7 days' and amount_cents between $1 and $1 + 99`, [amountCents])).rows.map((r) => Number(r.amount_cents)));
      const free = [];
      for (let i = 1; i <= 99; i++) if (!taken.has(amountCents + i)) free.push(amountCents + i);
      if (!free.length) throw httpError(409, 'Too many people are paying this exact amount right now. Try a slightly different amount.', 'crypto_busy');
      const total = free[Math.floor(Math.random() * free.length)];
      await tc.query(`insert into payments(workspace_id, user_id, provider, method_key, reference, amount_cents, bonus_cents, currency, amount_local, coin)
        values ($1,$2,'manual_crypto',$3,$4,$5,$6,'USD',$7,'USDT')`, [ws.id, ctx.user.id, m.key, ref, total, bonus, total / 100]);
      return total;
    });
    return { kind: 'crypto', coin: 'USDT', network: 'TRON (TRC20)', address: c.usdt_address, amount_usd: exact / 100, exact: true, reference: ref };
  }
  throw badRequest('That payment method is not available.');
}

async function insert(p) {
  await db.query(`insert into payments(workspace_id, user_id, provider, method_key, reference, amount_cents, bonus_cents, currency, amount_local, coin)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [p.workspace_id, p.user_id, p.provider, p.method_key, p.reference, p.amount_cents, p.bonus_cents, p.currency, p.amount_local, p.coin || null]);
}
async function fail(ref, reason) { await db.query("update payments set status = 'failed', reason = $2 where reference = $1 and status = 'pending'", [ref, String(reason).slice(0, 300)]); }

/**
 * Mark a payment paid and credit the wallet. Idempotent: a second call does nothing.
 * `override` lets finance staff credit a different USD amount for manual crypto.
 */
async function credit(reference, { reviewedBy = null, overrideCents = null, txid = null } = {}) {
  const res = await db.tx(async (c) => {
    const p = (await c.query('select * from payments where reference = $1 for update', [reference])).rows[0];
    if (!p) throw httpError(404, 'Payment not found.', 'not_found');
    if (p.status === 'paid') return { already: true, p };
    const amount = overrideCents != null ? overrideCents : Number(p.amount_cents);
    const bonus = overrideCents != null ? await settings.topupBonus(amount) : Number(p.bonus_cents);
    await c.query("update payments set status = 'paid', paid_at = now(), amount_cents = $2, bonus_cents = $3, reviewed_by = $4, txid = coalesce($5, txid) where id = $1",
      [p.id, amount, bonus, reviewedBy, txid]);
    await c.query('update workspaces set wallet_cents = wallet_cents + $2, bonus_cents = bonus_cents + $3 where id = $1', [p.workspace_id, amount, bonus]);
    const label = { paystack: 'Paystack', flutterwave: 'Flutterwave', gatevoo: 'Crypto (Gatevoo)', manual_crypto: p.coin || 'Crypto' }[p.provider] || p.provider;
    await c.query("insert into wallet_tx(workspace_id, kind, amount_cents, cash_cents, method, ref, note, created_by) values ($1,'topup',$2,$2,$3,$4,'Top up',$5)", [p.workspace_id, amount, label, p.reference, reviewedBy]);
    if (bonus > 0) await c.query("insert into wallet_tx(workspace_id, kind, amount_cents, bonus_part_cents, method, ref, note) values ($1,'bonus',$2,$2,'Offer',$3,'Top-up bonus')", [p.workspace_id, bonus, p.reference]);
    return { already: false, p: { ...p, amount_cents: amount, bonus_cents: bonus }, label };
  });
  if (res.already) return res;
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
  await credit(reference);
  return true;
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
  await credit(reference);
  return true;
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
  await credit(reference);
  return true;
}

async function verify(reference, extra = {}) {
  const p = await db.one('select provider from payments where reference = $1', [reference]);
  if (!p) return false;
  if (p.provider === 'paystack') return verifyPaystack(reference);
  if (p.provider === 'flutterwave') return verifyFlutterwave(reference, extra.transaction_id);
  if (p.provider === 'gatevoo') return verifyGatevoo(reference);
  return false;
}

module.exports = { start, credit, verify, verifyPaystack, verifyFlutterwave, verifyGatevoo, localAmount };

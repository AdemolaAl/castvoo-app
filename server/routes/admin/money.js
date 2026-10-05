'use strict';
/* Admin → Payments and Withdrawals. */

const db = require('../../db');
const config = require('../../config');
const payments = require('../../payments');
const email = require('../../services/email');
const { audit } = require('../../services/audit');
const { str, int, cents, badRequest, notFound, fmtUSD } = require('../../lib/util');

module.exports = (r) => {
  r.get('/api/admin/payments', async (ctx) => {
    const q = ctx.query, params = [];
    let where = '1=1';
    if (q.status) { params.push(String(q.status)); where += ` and p.status = $${params.length}`; }
    if (q.provider) { params.push(String(q.provider)); where += ` and p.provider = $${params.length}`; }
    if (q.check === '1') where += " and p.provider = 'manual_crypto' and p.status = 'pending' and p.txid is not null";
    if (q.q) { params.push('%' + String(q.q).replace(/[%_]/g, '') + '%'); where += ` and (p.reference ilike $${params.length} or p.txid ilike $${params.length} or u.email ilike $${params.length})`; }
    const rows = await db.many(`select p.*, u.name as user_name, u.email as user_email, w.name as workspace_name, rv.name as reviewed_by_name
      from payments p join users u on u.id = p.user_id join workspaces w on w.id = p.workspace_id left join users rv on rv.id = p.reviewed_by
      where ${where} order by p.id desc limit 200`, params);
    const totals = await db.one(`select coalesce(sum(amount_cents) filter (where status = 'paid' and paid_at > now() - interval '30 days'), 0)::bigint paid_30d,
      count(*) filter (where status = 'pending' and provider = 'manual_crypto' and txid is not null)::int to_check from payments`);
    return { payments: rows.map((p) => ({ ...p, amount: Number(p.amount_cents) / 100, bonus: Number(p.bonus_cents) / 100 })), totals: { paid_30d: Number(totals.paid_30d) / 100, to_check: totals.to_check } };
  }, { staff: 'payments.view' });

  /** Confirm a manual crypto payment (after checking the transaction on the blockchain). */
  r.post('/api/admin/payments/:ref/approve', async (ctx) => {
    const p = await db.one('select * from payments where reference = $1', [ctx.params.ref]);
    if (!p) throw notFound('That payment');
    if (p.status === 'paid') throw badRequest('This payment is already paid.');
    // Card and Gatevoo payments are credited only by the provider's confirmation (use Recheck), never by hand.
    if (p.provider !== 'manual_crypto') throw badRequest('Only manual crypto payments are approved by hand. Use Recheck for card and Gatevoo payments.');
    if (p.status !== 'pending') throw badRequest('This payment was already rejected or failed.');
    if (!p.txid) throw badRequest('The customer has not sent a transaction ID yet.');
    const override = ctx.body.amount !== undefined && ctx.body.amount !== '' ? cents(ctx.body.amount) : null;
    if (override !== null && (!Number.isFinite(override) || override <= 0)) throw badRequest('Enter the USD amount that arrived.');
    await payments.credit(p.reference, { reviewedBy: ctx.user.id, overrideCents: override, txid: ctx.body.txid ? String(ctx.body.txid).slice(0, 120) : null });
    await audit(ctx, 'payment.approve', 'payment:' + p.reference, { amount_cents: override ?? p.amount_cents });
    return { ok: true };
  }, { staff: 'payments.review' });

  r.post('/api/admin/payments/:ref/reject', async (ctx) => {
    const p = await db.one("select * from payments where reference = $1 and status = 'pending'", [ctx.params.ref]);
    if (!p) throw notFound('That pending payment');
    const reason = str(ctx.body.reason, 'Reason', { min: 3, max: 300 });
    await db.query("update payments set status = 'rejected', reason = $2, reviewed_by = $3 where id = $1", [p.id, reason, ctx.user.id]);
    if (p.provider === 'manual_crypto') {
      const u = await db.one('select * from users where id = $1', [p.user_id]);
      await email.send('crypto_rejected', u, { amount: fmtUSD(p.amount_cents), coin: p.coin || 'crypto', txid: p.txid || '(none)', reason });
    }
    await audit(ctx, 'payment.reject', 'payment:' + p.reference, { reason });
    return { ok: true };
  }, { staff: 'payments.review' });

  /**
   * Record a chargeback / dispute on a paid top-up (Flutterwave, Gatevoo or manual crypto; Paystack disputes arrive by
   * webhook). Cancels unsettled referral earnings and reverses the affiliate commission in VooSquare. Once per payment.
   */
  r.post('/api/admin/payments/:ref/chargeback', async (ctx) => {
    const reason = str(ctx.body.reason, 'Reason', { min: 3, max: 300 });
    const out = await payments.chargeback(String(ctx.params.ref), { disputeRef: 'admin:' + ctx.user.id });
    if (out.already) throw badRequest('This payment was already recorded as charged back.');
    await audit(ctx, 'payment.chargeback', 'payment:' + ctx.params.ref, { reason, referral_reversed_cents: out.reversed_cents, voo_events: out.events });
    return { ok: true, referral_reversed: out.reversed_cents / 100, voosquare_events: out.events.length };
  }, { staff: 'payments.review' });

  /** Ask Paystack / Flutterwave / Gatevoo again whether a payment went through. */
  r.post('/api/admin/payments/:ref/recheck', async (ctx) => {
    const ok = await payments.verify(ctx.params.ref).catch((e) => { throw badRequest('Check failed: ' + e.message); });
    const p = await db.one('select status, reason from payments where reference = $1', [ctx.params.ref]);
    await audit(ctx, 'payment.recheck', 'payment:' + ctx.params.ref, { result: p && p.status });
    return { ok, status: p && p.status, reason: p && p.reason };
  }, { staff: 'payments.review' });

  /* ---------- Withdrawals ---------- */
  r.get('/api/admin/withdrawals', async (ctx) => {
    const status = ['requested', 'paid', 'rejected'].includes(ctx.query.status) ? ctx.query.status : 'requested';
    const rows = await db.many(`select w.*, u.name as user_name, u.email as user_email, u.ref_code,
        (select count(*)::int from users x where x.referred_by = u.id) as referrals
      from withdrawals w join users u on u.id = w.user_id where w.status = $1 order by w.id desc limit 200`, [status]);
    return { withdrawals: rows.map((w) => ({ ...w, amount: Number(w.amount_cents) / 100 })) };
  }, { staff: 'payments.view' });

  r.post('/api/admin/withdrawals/:id/paid', async (ctx) => {
    const id = int(ctx.params.id, 'Withdrawal');
    const txid = str(ctx.body.txid, 'Transaction ID', { min: 10, max: 120 });
    const w = await db.one("update withdrawals set status = 'paid', txid = $2, processed_by = $3, processed_at = now() where id = $1 and status = 'requested' returning *", [id, txid, ctx.user.id]);
    if (!w) throw notFound('That open withdrawal');
    const u = await db.one('select * from users where id = $1', [w.user_id]);
    await email.send('withdrawal_paid', u, { amount: fmtUSD(w.amount_cents), coin: w.coin, address: w.address, txid });
    await audit(ctx, 'withdrawal.paid', 'withdrawal:' + id, { amount_cents: w.amount_cents, coin: w.coin, txid });
    return { ok: true };
  }, { staff: 'withdrawals.review' });

  r.post('/api/admin/withdrawals/:id/reject', async (ctx) => {
    const id = int(ctx.params.id, 'Withdrawal');
    const reason = str(ctx.body.reason, 'Reason', { min: 3, max: 300 });
    const w = await db.one("update withdrawals set status = 'rejected', reason = $2, processed_by = $3, processed_at = now() where id = $1 and status = 'requested' returning *", [id, reason, ctx.user.id]);
    if (!w) throw notFound('That open withdrawal');
    if (ctx.body.cancel_earnings) {
      await db.query("insert into referral_ledger(user_id, kind, amount_cents, ref) values ($1,'reversal',$2,$3)", [w.user_id, w.amount_cents, 'withdrawal:' + id]);
    }
    const u = await db.one('select * from users where id = $1', [w.user_id]);
    await email.send('withdrawal_rejected', u, { amount: fmtUSD(w.amount_cents), reason, referrals_url: config.appUrl + '/#app/referrals' });
    await audit(ctx, 'withdrawal.reject', 'withdrawal:' + id, { reason, cancel_earnings: !!ctx.body.cancel_earnings });
    return { ok: true };
  }, { staff: 'withdrawals.review' });
};

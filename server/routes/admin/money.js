'use strict';
/* Admin → Payments and Withdrawals. */

// A manual payment the customer says is paid and the team must check: manual crypto with a transaction ID,
// or one of the team's own methods after the customer pressed "I've paid".
const TO_CHECK = "p.status = 'pending' and ((p.provider = 'manual_crypto' and p.txid is not null) or (p.provider = 'manual' and p.submitted_at is not null))";
const MANUAL = ['manual_crypto', 'manual'];

const db = require('../../db');
const config = require('../../config');
const payments = require('../../payments');
const email = require('../../services/email');
const proofs = require('../../services/payment-proofs');
const { audit } = require('../../services/audit');
const { str, int, cents, badRequest, notFound, fmtUSD, httpError } = require('../../lib/util');

/**
 * SEC-11: nobody on the team decides money for themselves. A reviewer may not approve, reject or charge back a payment
 * they made, or one for a workspace they belong to (owner or teammate). Another reviewer must do it.
 */
async function notOwnPayment(ctx, p) {
  const mine = String(p.user_id) === String(ctx.user.id)
    || !!(await db.one('select 1 from members where workspace_id = $1 and user_id = $2', [p.workspace_id, ctx.user.id]));
  if (mine) throw httpError(403, 'This top-up is for a workspace you belong to. Ask another team member to review it.', 'own_payment');
}

module.exports = (r) => {
  r.get('/api/admin/payments', async (ctx) => {
    const q = ctx.query, params = [];
    let where = '1=1';
    if (q.status) { params.push(String(q.status)); where += ` and p.status = $${params.length}`; }
    if (q.provider) { params.push(String(q.provider)); where += ` and p.provider = $${params.length}`; }
    if (q.check === '1') where += ' and ' + TO_CHECK;
    if (q.q) { params.push('%' + String(q.q).replace(/[%_]/g, '') + '%'); where += ` and (p.reference ilike $${params.length} or p.txid ilike $${params.length} or p.proof_ref ilike $${params.length} or u.email ilike $${params.length})`; }
    const rows = await db.many(`select p.*, u.name as user_name, u.email as user_email, w.name as workspace_name, rv.name as reviewed_by_name,
        pm.label as method_label, pm.kind as method_kind, pm.icon as method_icon, pm.color as method_color
      from payments p join users u on u.id = p.user_id join workspaces w on w.id = p.workspace_id left join users rv on rv.id = p.reviewed_by
        left join payment_methods pm on pm.key = p.method_key and p.provider = 'manual'
      where ${where} order by p.id desc limit 200`, params);
    const totals = await db.one(`select coalesce(sum(amount_cents) filter (where status = 'paid' and paid_at > now() - interval '30 days'), 0)::bigint paid_30d,
      count(*) filter (where ${TO_CHECK})::int to_check from payments p`);
    // The file path stays on the server: the browser only learns there is a screenshot.
    return { payments: rows.map(({ proof_path, ...p }) => ({ ...p, has_screenshot: !!proof_path, amount: Number(p.amount_cents) / 100, bonus: Number(p.bonus_cents) / 100 })), totals: { paid_30d: Number(totals.paid_30d) / 100, to_check: totals.to_check } };
  }, { staff: 'payments.view' });

  /** The screenshot a customer sent for a manual top-up. */
  r.get('/api/admin/payments/:ref/screenshot', async (ctx) => {
    const p = await db.one('select proof_path, proof_mime from payments where reference = $1', [ctx.params.ref]);
    if (!p || !(await proofs.stream(ctx, p))) throw notFound('That screenshot');
  }, { staff: 'payments.view' });

  /**
   * Confirm a manual payment: manual crypto (after checking the transaction on the blockchain) or one of the team's
   * own methods (after checking the bank or wallet). Credits the wallet once, with the same bonus rules as any top-up.
   */
  r.post('/api/admin/payments/:ref/approve', async (ctx) => {
    const p = await db.one('select * from payments where reference = $1', [ctx.params.ref]);
    if (!p) throw notFound('That payment');
    await notOwnPayment(ctx, p);
    if (p.status === 'paid') throw badRequest('This payment is already paid.');
    // Card and Gatevoo payments are credited only by the provider's confirmation (use Recheck), never by hand.
    if (!MANUAL.includes(p.provider)) throw badRequest('Only manual payments are approved by hand. Use Recheck for card and Gatevoo payments.');
    if (p.status !== 'pending') throw badRequest('This payment was already rejected or failed.');
    if (p.provider === 'manual_crypto' && !p.txid) throw badRequest('The customer has not sent a transaction ID yet.');
    if (p.provider === 'manual' && !p.submitted_at) throw badRequest('The customer has not said they paid yet.');
    const override = ctx.body.amount !== undefined && ctx.body.amount !== '' ? cents(ctx.body.amount) : null;
    if (override !== null && (!Number.isFinite(override) || override <= 0 || override > 10000000)) throw badRequest('Enter the USD amount that arrived.');
    const txid = p.provider === 'manual_crypto' && ctx.body.txid ? String(ctx.body.txid).slice(0, 120) : null;
    // credit() decides under the row lock: only a payment that is still pending is credited (SEC-3).
    const res = await payments.credit(p.reference, { reviewedBy: ctx.user.id, overrideCents: override, txid });
    if (res.already) throw badRequest('This payment is already paid.'); // two people pressed Approve at once: credited once
    if (res.refused) throw httpError(409, `This payment was ${res.refused} a moment ago, so it was not credited.`, 'payment_decided');
    await audit(ctx, 'payment.approve', 'payment:' + p.reference, { amount_cents: override ?? p.amount_cents, provider: p.provider, method: p.method_key });
    return { ok: true };
  }, { staff: 'payments.review' });

  r.post('/api/admin/payments/:ref/reject', async (ctx) => {
    const reason = str(ctx.body.reason, 'Reason', { min: 3, max: 300 });
    const p0 = await db.one('select * from payments where reference = $1', [ctx.params.ref]);
    if (!p0) throw notFound('That pending payment');
    await notOwnPayment(ctx, p0);
    // One atomic transition: only a payment still pending is rejected (an Approve at the same moment wins or loses as a whole).
    const p = await db.one("update payments set status = 'rejected', reason = $2, reviewed_by = $3 where reference = $1 and status = 'pending' returning *", [ctx.params.ref, reason, ctx.user.id]);
    if (!p) throw notFound('That pending payment');
    const u = await db.one('select * from users where id = $1', [p.user_id]);
    if (p.provider === 'manual_crypto') {
      await email.send('crypto_rejected', u, { amount: fmtUSD(p.amount_cents), coin: p.coin || 'crypto', txid: p.txid || '(none)', reason });
    } else if (p.provider === 'manual') {
      const m = await db.one('select label from payment_methods where key = $1', [p.method_key]);
      await email.send('topup_rejected', u, { amount: fmtUSD(p.amount_cents), method: m ? m.label : 'manual', reference: p.proof_ref || p.reference, reason });
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
    const p = await db.one('select * from payments where reference = $1', [String(ctx.params.ref)]);
    if (!p) throw notFound('That payment');
    await notOwnPayment(ctx, p);
    const out = await payments.chargeback(String(ctx.params.ref), { disputeRef: 'admin:' + ctx.user.id });
    if (out.already) throw badRequest('This payment was already recorded as charged back.');
    await audit(ctx, 'payment.chargeback', 'payment:' + ctx.params.ref, { reason, debited_cents: out.debited_cents, wallet_cents: out.wallet_cents, dropped_to_free: out.dropped, referral_reversed_cents: out.reversed_cents, voo_events: out.events });
    return { ok: true, debited: out.debited_cents / 100, wallet: out.wallet_cents / 100, dropped_to_free: out.dropped, referral_reversed: out.reversed_cents / 100, voosquare_events: out.events.length };
  }, { staff: 'payments.review' });

  /** The bank decided the dispute for Castvoo: the charged-back money returns to the customer's wallet. Once. */
  r.post('/api/admin/payments/:ref/dispute-won', async (ctx) => {
    const p = await db.one('select * from payments where reference = $1', [String(ctx.params.ref)]);
    if (!p) throw notFound('That payment');
    await notOwnPayment(ctx, p);
    const out = await payments.disputeWon(p.reference, { by: ctx.user.id });
    if (out.already) throw badRequest('This dispute was already marked as won.');
    await audit(ctx, 'payment.dispute_won', 'payment:' + p.reference, { credited_cents: out.credited_cents });
    return { ok: true, credited: out.credited_cents / 100 };
  }, { staff: 'payments.review' });

  /* ---------- Referral earnings held for review (SEC-2: looks like a self-referral) ---------- */
  r.get('/api/admin/referrals/held', async () => {
    const rows = await db.many(`select e.id, e.user_id, e.amount_cents, e.rate, e.hold_reason, e.created_at, e.settles_at, e.from_workspace_id,
        u.name as referrer_name, u.email as referrer_email, w.name as workspace_name, o.email as referred_email
      from referral_ledger e join users u on u.id = e.user_id left join workspaces w on w.id = e.from_workspace_id left join users o on o.id = w.owner_user_id
      where e.kind = 'earning' and e.held and e.cancelled_at is null order by e.id desc limit 200`);
    return { held: rows.map((x) => ({ ...x, amount: Number(x.amount_cents) / 100 })) };
  }, { staff: 'payments.view' });

  /** Release (it is a real referral: the earning counts again) or cancel (a self-referral: it never pays). */
  r.post('/api/admin/referrals/held/:id', async (ctx) => {
    const id = int(ctx.params.id, 'Earning');
    const action = ['release', 'cancel'].includes(ctx.body.action) ? ctx.body.action : null;
    if (!action) throw badRequest('Choose release or cancel.');
    const e = await db.one("select * from referral_ledger where id = $1 and kind = 'earning' and held and cancelled_at is null", [id]);
    if (!e) throw notFound('That held earning');
    if (String(e.user_id) === String(ctx.user.id)) throw httpError(403, 'This earning is yours. Ask another team member to review it.', 'own_payment');
    if (action === 'release') await db.query("update referral_ledger set held = false where id = $1 and held", [id]);
    else await db.query('update referral_ledger set cancelled_at = now() where id = $1 and held and cancelled_at is null', [id]); // stays held: never counts
    await audit(ctx, 'referral.' + action, 'earning:' + id, { amount_cents: e.amount_cents, reason: e.hold_reason });
    return { ok: true };
  }, { staff: 'withdrawals.review' });

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
        (select count(*)::int from users x where x.referred_by = u.id) as referrals,
        (select count(*)::int from referral_ledger e where e.user_id = u.id and e.kind = 'earning' and e.held and e.cancelled_at is null) as held_earnings,
        (select string_agg(distinct e.hold_reason, '; ') from referral_ledger e where e.user_id = u.id and e.hold_reason is not null) as self_referral_signals
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

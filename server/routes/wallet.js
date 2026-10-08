'use strict';
/* Wallet: balance, history, top-ups, crypto transaction IDs, proof for the team's manual methods. */

const db = require('../db');
const settings = require('../services/settings');
const email = require('../services/email');
const payments = require('../payments');
const proofs = require('../services/payment-proofs');
const { str, badRequest, notFound, fmtUSD } = require('../lib/util');

module.exports = (r) => {
  r.get('/api/wallet', async (ctx) => {
    const ws = await db.one('select wallet_cents, bonus_cents from workspaces where id = $1', [ctx.workspace.id]);
    const tx = await db.many('select id, kind, amount_cents, method, note, ref, created_at from wallet_tx where workspace_id = $1 order by id desc limit 60', [ctx.workspace.id]);
    const pending = await db.many(`select p.reference, p.provider, p.coin, p.amount_cents, p.txid, p.checkout_url, p.created_at, p.currency, p.amount_local,
        p.submitted_at, pm.label as method_label
      from payments p left join payment_methods pm on pm.key = p.method_key and p.provider = 'manual'
      where p.workspace_id = $1 and p.status = 'pending' and p.created_at > now() - interval '7 days' order by p.id desc limit 10`, [ctx.workspace.id]);
    const methods = await settings.methodsFor(ctx.user.country || 'XX');
    const cfg = await settings.get('billing');
    const country = ctx.user.country ? await db.one('select code, name, flag, currency, usd_rate from countries where code = $1', [ctx.user.country]) : null;
    return {
      cash: Number(ws.wallet_cents) / 100, bonus: Number(ws.bonus_cents) / 100, total: (Number(ws.wallet_cents) + Number(ws.bonus_cents)) / 100,
      transactions: tx.map((t) => ({ ...t, amount: Number(t.amount_cents) / 100 })),
      pending: pending.map((p) => ({ ...p, amount: Number(p.amount_cents) / 100, amount_local: p.amount_local == null ? null : Number(p.amount_local), submitted: !!p.submitted_at })),
      methods: methods.map((m) => ({ key: m.key, label: m.label, detail: m.detail, color: m.color, icon: m.icon, currency: m.currency, usd_rate: m.usd_rate, gatevoo: !!m.gatevoo, coin: m.coin || null,
        ...(m.manual ? { manual: true, kind: m.kind, min: m.min_cents != null ? Number(m.min_cents) / 100 : null, max: m.max_cents != null ? Number(m.max_cents) / 100 : null } : {}) })),
      country, min_topup: cfg.min_topup_cents / 100, max_topup: cfg.max_topup_cents / 100,
      bonuses: (await settings.activeOffers('topup_bonus')).map((o) => ({ min: Number(o.min_topup_cents) / 100, bonus: Number(o.bonus_cents) / 100 })).sort((a, b) => a.min - b.min),
      has_email: !!ctx.user.email,
    };
  }, { auth: 'workspace' });

  r.post('/api/wallet/topup', async (ctx) => {
    const out = await payments.start(ctx, { amount: Number(ctx.body.amount), methodKey: String(ctx.body.method || '') });
    return out;
  }, { auth: 'workspace', rate: [20, 600] });

  /** Manual crypto: the customer pastes the transaction ID; the finance team confirms it. */
  r.post('/api/wallet/crypto-txid', async (ctx) => {
    const ref = str(ctx.body.reference, 'Payment', { min: 5, max: 40 });
    const txid = str(ctx.body.txid, 'Transaction ID', { min: 20, max: 120 }).replace(/\s+/g, '');
    if (!/^[A-Za-z0-9]+$/.test(txid)) throw badRequest('A transaction ID uses only letters and numbers. Copy it again from your wallet.');
    const p = await db.one("select * from payments where reference = $1 and workspace_id = $2 and provider = 'manual_crypto'", [ref, ctx.workspace.id]);
    if (!p) throw notFound('That payment');
    if (p.status !== 'pending') throw badRequest('This payment was already handled.');
    const dupe = await db.one('select 1 from payments where coin = $1 and txid = $2 and id <> $3', [p.coin, txid, p.id]);
    if (dupe) throw badRequest('That transaction ID was already used for another top-up.');
    try {
      await db.query("update payments set txid = $2 where id = $1 and status = 'pending'", [p.id, txid]);
    } catch (e) {
      // 23505 = unique index payments_txid: the same txid was pasted for another payment a moment ago.
      if (e.code === '23505') throw badRequest('That transaction ID was already used for another top-up.');
      throw e;
    }
    await email.send('crypto_submitted', ctx.user, { amount: fmtUSD(p.amount_cents), coin: p.coin, txid });
    return { ok: true };
  }, { auth: 'workspace', rate: [20, 600] });

  /* ---------- The team's manual methods (bank transfer, mobile money, ...) ---------- */
  const myManual = async (ctx, ref) => {
    const p = await db.one("select * from payments where reference = $1 and workspace_id = $2 and provider = 'manual'", [str(ref, 'Payment', { min: 5, max: 40 }), ctx.workspace.id]);
    if (!p) throw notFound('That payment');
    return p;
  };
  const methodOf = (p) => db.one('select * from payment_methods where key = $1', [p.method_key]);

  /** The instructions and exact amount again (the customer closed the sheet and comes back from the wallet page). */
  r.get('/api/wallet/manual/:ref', async (ctx) => {
    const p = await myManual(ctx, ctx.params.ref);
    return payments.manualView(p, await methodOf(p));
  }, { auth: 'workspace' });

  /** A screenshot of the payment. The raw image is the request body. Replaces an earlier one. */
  r.post('/api/wallet/manual/:ref/screenshot', async (ctx) => {
    const p = await myManual(ctx, ctx.params.ref);
    if (p.status !== 'pending' || p.submitted_at) throw badRequest('This payment was already sent to the team.');
    const m = await methodOf(p);
    if (!m || m.proof_image === 'off') throw badRequest('This payment method does not take screenshots.');
    const f = await proofs.save(ctx, ctx.workspace.id);
    const row = await db.one("update payments set proof_path = $2, proof_mime = $3 where id = $1 and status = 'pending' and submitted_at is null returning id", [p.id, f.path, f.mime]);
    if (!row) { await proofs.remove([f.path]); throw badRequest('This payment was already sent to the team.'); }
    if (p.proof_path) await proofs.remove([p.proof_path]);
    return { ok: true, size: f.size };
  }, { auth: 'workspace', stream: true, rate: [20, 600] });

  /** "I've paid": the reference (if the method asks for one) goes to the team, who check it and approve. */
  r.post('/api/wallet/manual/:ref/submit', async (ctx) => {
    const p = await myManual(ctx, ctx.params.ref);
    if (p.status !== 'pending') throw badRequest('This payment was already handled.');
    if (p.submitted_at) throw badRequest('You already sent this payment to the team. They are checking it.');
    const m = await methodOf(p);
    if (!m) throw badRequest('This payment method is not available any more. Ask us in the Help chat.');
    let ref = m.proof_ref === 'off' ? null : str(ctx.body.proof_ref, 'Reference', { max: 120, required: false }) || null;
    if (ref) ref = ref.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (m.proof_ref === 'required' && (!ref || ref.length < 3)) throw badRequest('Add the transaction reference or ID from your bank or wallet app.');
    if (m.proof_image === 'required' && !p.proof_path) throw badRequest('Add a screenshot of the payment first.');
    let row;
    try {
      row = await db.one("update payments set proof_ref = $2, submitted_at = now() where id = $1 and status = 'pending' and submitted_at is null returning id", [p.id, ref]);
    } catch (e) {
      // 23505 = unique index payments_proof_ref: this reference was already sent for another top-up.
      if (e.code === '23505') throw badRequest('That reference was already used for another top-up. Check it and try again.');
      throw e;
    }
    if (!row) throw badRequest('You already sent this payment to the team. They are checking it.');
    await email.send('topup_submitted', ctx.user, { amount: fmtUSD(p.amount_cents), method: m.label, reference: ref || p.reference });
    return { ok: true };
  }, { auth: 'workspace', rate: [20, 600] });

  /** Check a payment now (used when the customer comes back from the checkout page). */
  r.post('/api/wallet/check', async (ctx) => {
    const ref = str(ctx.body.reference, 'Payment', { min: 5, max: 40 });
    const p = await db.one('select * from payments where reference = $1 and workspace_id = $2', [ref, ctx.workspace.id]);
    if (!p) throw notFound('That payment');
    if (p.status === 'pending' && !['manual_crypto', 'manual'].includes(p.provider)) await payments.verify(ref).catch(() => false);
    const now = await db.one('select status from payments where id = $1', [p.id]);
    return { status: now.status };
  }, { auth: 'workspace', rate: [60, 600] });
};

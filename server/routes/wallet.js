'use strict';
/* Wallet: balance, history, top-ups, crypto transaction IDs. */

const db = require('../db');
const settings = require('../services/settings');
const email = require('../services/email');
const payments = require('../payments');
const { str, badRequest, notFound, fmtUSD } = require('../lib/util');

module.exports = (r) => {
  r.get('/api/wallet', async (ctx) => {
    const ws = await db.one('select wallet_cents, bonus_cents from workspaces where id = $1', [ctx.workspace.id]);
    const tx = await db.many('select id, kind, amount_cents, method, note, ref, created_at from wallet_tx where workspace_id = $1 order by id desc limit 60', [ctx.workspace.id]);
    const pending = await db.many("select reference, provider, coin, amount_cents, txid, checkout_url, created_at from payments where workspace_id = $1 and status = 'pending' and created_at > now() - interval '7 days' order by id desc limit 10", [ctx.workspace.id]);
    const methods = await settings.methodsFor(ctx.user.country || 'XX');
    const cfg = await settings.get('billing');
    const country = ctx.user.country ? await db.one('select code, name, flag, currency, usd_rate from countries where code = $1', [ctx.user.country]) : null;
    return {
      cash: Number(ws.wallet_cents) / 100, bonus: Number(ws.bonus_cents) / 100, total: (Number(ws.wallet_cents) + Number(ws.bonus_cents)) / 100,
      transactions: tx.map((t) => ({ ...t, amount: Number(t.amount_cents) / 100 })),
      pending: pending.map((p) => ({ ...p, amount: Number(p.amount_cents) / 100 })),
      methods: methods.map((m) => ({ key: m.key, label: m.label, detail: m.detail, color: m.color, icon: m.icon, currency: m.currency, usd_rate: m.usd_rate, gatevoo: !!m.gatevoo, coin: m.coin || null })),
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

  /** Check a payment now (used when the customer comes back from the checkout page). */
  r.post('/api/wallet/check', async (ctx) => {
    const ref = str(ctx.body.reference, 'Payment', { min: 5, max: 40 });
    const p = await db.one('select * from payments where reference = $1 and workspace_id = $2', [ref, ctx.workspace.id]);
    if (!p) throw notFound('That payment');
    if (p.status === 'pending' && p.provider !== 'manual_crypto') await payments.verify(ref).catch(() => false);
    const now = await db.one('select status from payments where id = $1', [p.id]);
    return { status: now.status };
  }, { auth: 'workspace', rate: [60, 600] });
};

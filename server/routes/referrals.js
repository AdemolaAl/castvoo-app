'use strict';
/* Referral program: link, earnings, use on plan, withdraw in crypto. */

const db = require('../db');
const config = require('../config');
const settings = require('../services/settings');
const email = require('../services/email');
const { balances } = require('../services/referrals');
const { str, oneOf, cents, badRequest, httpError, fmtUSD } = require('../lib/util');

const ADDRESS = {
  USDT: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  BTC: /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
};

module.exports = (r) => {
  r.get('/api/referrals', async (ctx) => {
    await settings.requireFeature('referrals', 'The referral program is paused right now.');
    const u = ctx.user;
    const rs = await settings.get('referral');
    const people = await db.many(`select u.name, u.created_at, w.plan_status, w.plan_code, w.paid_ever,
        coalesce((select sum(amount_cents) from referral_ledger l where l.user_id = $1 and l.kind = 'earning' and l.from_workspace_id = w.id), 0)::bigint as earned
      from users u join workspaces w on w.owner_user_id = u.id where u.referred_by = $1 and u.status = 'active' order by u.created_at desc limit 100`, [u.id]);
    const paying = people.filter((p) => p.plan_status === 'active' && p.paid_ever).length;
    const rate = paying >= rs.tier3_min ? rs.rates[2] : paying >= rs.tier2_min ? rs.rates[1] : rs.rates[0];
    const bal = await balances(u.id);
    const withdrawals = await db.many('select id, amount_cents, coin, address, status, txid, reason, created_at, processed_at from withdrawals where user_id = $1 order by id desc limit 20', [u.id]);
    return {
      link: `${config.appUrl}/r/${u.ref_code}`, code: u.ref_code, rate, paying, signups: people.length,
      tiers: [{ min: 1, rate: rs.rates[0] }, { min: rs.tier2_min, rate: rs.rates[1] }, { min: rs.tier3_min, rate: rs.rates[2] }],
      min_withdraw: rs.min_withdraw_cents / 100, settle_days: rs.settle_days,
      balance: { available: bal.available / 100, pending: bal.pending / 100, earned: bal.earned / 100 },
      people: people.map((p) => ({ name: (p.name || '').split(' ')[0] || 'Friend', joined: p.created_at, status: p.plan_status === 'active' && p.paid_ever ? 'Paying' : p.plan_status === 'trial' ? 'Trial' : 'Not paying', plan: p.plan_code, earned: Number(p.earned) / 100 })),
      withdrawals: withdrawals.map((w) => ({ ...w, amount: Number(w.amount_cents) / 100 })),
      withdrawals_on: await settings.feature('withdrawals'),
    };
  }, { auth: 'workspace' });

  /** Move settled earnings into the wallet as plan credit. */
  r.post('/api/referrals/use', async (ctx) => {
    const amount = cents(ctx.body.amount);
    if (!Number.isFinite(amount) || amount < 100) throw badRequest('Use at least $1.');
    await db.tx(async (c) => {
      await c.query('select pg_advisory_xact_lock(7001, $1::int)', [ctx.user.id]);
      const bal = await balances(ctx.user.id, c);
      if (amount > bal.available) throw badRequest(`You have ${fmtUSD(bal.available)} ready to use.`);
      await c.query("insert into referral_ledger(user_id, kind, amount_cents, ref) values ($1,'use',$2,$3)", [ctx.user.id, amount, 'ws:' + ctx.workspace.id]);
      await c.query('update workspaces set bonus_cents = bonus_cents + $2 where id = $1', [ctx.workspace.id, amount]);
      await c.query("insert into wallet_tx(workspace_id, kind, amount_cents, bonus_part_cents, method, note) values ($1,'referral_credit',$2,$2,'Referral earnings','Referral earnings added for your plan')", [ctx.workspace.id, amount]);
    });
    return { ok: true, message: `${fmtUSD(amount)} added to your wallet for plan payments.` };
  }, { auth: 'workspace', rate: [20, 3600] });

  r.post('/api/referrals/withdraw', async (ctx) => {
    await settings.requireFeature('withdrawals', 'Withdrawals are paused right now. Your earnings are safe.');
    const rs = await settings.get('referral');
    const coin = oneOf(String(ctx.body.coin || '').toUpperCase(), 'Coin', ['USDT', 'BTC']);
    const address = str(ctx.body.address, 'Wallet address', { min: 20, max: 100 }).replace(/\s+/g, '');
    if (!ADDRESS[coin].test(address)) throw badRequest(coin === 'USDT' ? 'That is not a TRON (TRC20) address. It starts with T and has 34 characters.' : 'That is not a Bitcoin address. It starts with bc1, 1 or 3.');
    const amount = cents(ctx.body.amount);
    if (!Number.isFinite(amount) || amount < rs.min_withdraw_cents) throw badRequest(`The smallest withdrawal is ${fmtUSD(rs.min_withdraw_cents)}.`);
    const id = await db.tx(async (c) => {
      await c.query('select pg_advisory_xact_lock(7001, $1::int)', [ctx.user.id]);
      const open = (await c.query("select 1 from withdrawals where user_id = $1 and status = 'requested'", [ctx.user.id])).rows[0];
      if (open) throw httpError(409, 'You already have a withdrawal being processed. Please wait for it to finish.', 'withdrawal_open');
      const bal = await balances(ctx.user.id, c);
      if (amount > bal.available) throw badRequest(`You have ${fmtUSD(bal.available)} ready to withdraw.`);
      return (await c.query('insert into withdrawals(user_id, amount_cents, coin, address) values ($1,$2,$3,$4) returning id', [ctx.user.id, amount, coin, address])).rows[0].id;
    });
    await email.send('withdrawal_requested', ctx.user, { amount: fmtUSD(amount), coin, address });
    return { ok: true, id };
  }, { auth: 'workspace', rate: [10, 3600] });
};

'use strict';
/*
 * Referral balances. The ledger holds: earning (+), use (spent on own plan), reversal (cancelled earning).
 * Withdrawals live in their own table. Amounts in the ledger are always positive.
 *   available = settled earnings − uses − settled reversals − withdrawals (requested or paid)
 * A reversal of a not-yet-settled earning carries that earning's settle date, so it cancels it
 * out of "pending" now and never shows up as available.
 */

const db = require('../db');

async function balances(userId, c = null) {
  const q = (sql, p) => (c ? c.query(sql, p).then((r) => r.rows[0]) : db.one(sql, p));
  const r = await q(`select
      coalesce(sum(amount_cents) filter (where kind = 'earning' and settles_at <= now()), 0)::bigint as settled,
      coalesce(sum(amount_cents) filter (where kind = 'earning' and settles_at > now()), 0)::bigint
        - coalesce(sum(amount_cents) filter (where kind = 'reversal' and settles_at > now()), 0)::bigint as pending,
      coalesce(sum(amount_cents) filter (where kind = 'earning'), 0)::bigint as earned,
      coalesce(sum(amount_cents) filter (where kind = 'use'), 0)::bigint as used,
      coalesce(sum(amount_cents) filter (where kind = 'reversal' and settles_at <= now()), 0)::bigint as reversed
    from referral_ledger where user_id = $1`, [userId]);
  const w = await q("select coalesce(sum(amount_cents), 0)::bigint as out from withdrawals where user_id = $1 and status in ('requested','paid')", [userId]);
  const available = Number(r.settled) - Number(r.used) - Number(r.reversed) - Number(w.out);
  return { available: Math.max(0, available), pending: Math.max(0, Number(r.pending)), earned: Number(r.earned), used: Number(r.used), withdrawn: Number(w.out) };
}

/**
 * Money from a workspace was refunded or disputed: cancel the referral earnings it created
 * that have not settled yet (settled ones were the 30-day promise; those stay).
 * Safe to call twice: each earning is reversed at most once. Returns how many cents were reversed.
 */
async function clawback(c, workspaceId, why) {
  const rows = (await c.query(`select e.* from referral_ledger e where e.kind = 'earning' and e.from_workspace_id = $1 and e.settles_at > now()
    and not exists (select 1 from referral_ledger r where r.kind = 'reversal' and r.ref = 'earning:' || e.id) for update`, [workspaceId])).rows;
  let total = 0;
  for (const e of rows) {
    await c.query(`insert into referral_ledger(user_id, kind, amount_cents, from_workspace_id, settles_at, ref) values ($1,'reversal',$2,$3,$4,$5)`,
      [e.user_id, e.amount_cents, workspaceId, e.settles_at, 'earning:' + e.id]);
    total += Number(e.amount_cents);
  }
  void why;
  return total;
}

module.exports = { balances, clawback };

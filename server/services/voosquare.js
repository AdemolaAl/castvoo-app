'use strict';
/*
 * Castvoo → VooSquare, through the Voo Connect kit (server/lib/voo.js). Contract: VooSquare docs/VOO_CONNECT.md,
 * "Castvoo" sheet, and docs/INTEGRATION.md sections 2 and 2b.
 *
 * Every event is checked by the kit (normalizeEvent) when it is queued, and queued in our `outbox` table, in the same
 * database transaction as the money it describes when a transaction is passed. flush() (every 10 s in workers/index.js)
 * hands due rows to the kit's EventsClient, which sends them in calls of at most 100, resends what VooSquare asks for and
 * reports what it refuses for good. Event ids are stable, so a retry or a second run never counts twice.
 *
 * Castvoo's money model and the events it produces (the customer is the workspace owner's Voo ID):
 *   wallet top-up paid            wallet_topup  cv_topup_<payment id>          no commission
 *   plan paid from the wallet     spend         cv_pay_<wallet_tx id>          the CASH part only (bonus credit is not money)
 *                                 plan_started  cv_plan_<wallet_tx id>         first paid plan (price in value_usd)
 *                                 plan_renewed  cv_renew_<wallet_tx id>        every later plan payment
 *   upgrade paid from the wallet  spend         cv_pay_<wallet_tx id>
 *   plan set to cancel / ended    plan_cancelled cv_cancel_<workspace>_<period end>
 *   wallet money returned (admin) refund        cv_rf_<wallet_tx id>           never reverses commission
 *   top-up charged back           chargeback    cv_cb_<payment id>_<wallet_tx id>  one per plan payment that used that
 *                                                money (oldest money is spent first), original_event_id = cv_pay_<wallet_tx id>
 *   activity                      broadcast_sent cv_bc_<broadcast id> · drip_step_sent cv_drip_<workspace>_<hour> ·
 *                                 channel_connected cv_conn_<connection id>
 * Never sent: subscribers' Telegram IDs, usernames, names or phone numbers; read receipts (Telegram gives bots none).
 */

const db = require('../db');
const config = require('../config');
const log = require('../lib/log');
const voo = require('../lib/voo');

const V = () => config.voosquare;
const enabled = () => config.vooEventsOn();
const supportEnabled = () => !!(V().connect && V().base && V().apiKey);
const usd = (cents) => Math.round(Number(cents)) / 100;
const exec = (c) => (c ? (sql, p) => c.query(sql, p) : (sql, p) => db.query(sql, p));

/**
 * Queue one event (camelCase like the kit: eventId, vooId, valueUsd, label, plan, country, occurredAt, originalEventId,
 * signals). Never throws: a bad event is a bug, logged loudly, and must not break a payment.
 */
async function queue(type, o, c = null) {
  if (!enabled() || !o || !o.vooId) return null;
  let ev;
  try {
    ev = voo.K.normalizeEvent({
      event_id: o.eventId, voo_id: o.vooId, type, value_usd: o.valueUsd, label: o.label, plan: o.plan, country: o.country || undefined,
      occurred_at: o.occurredAt, original_event_id: o.originalEventId, signals: o.signals,
    });
  } catch (e) {
    log.error('VooSquare event not queued (invalid)', { type, event_id: o.eventId, err: e.message });
    return null;
  }
  await exec(c)("insert into outbox(kind, payload) values ('voosquare', $1) on conflict ((payload->>'event_id')) where kind = 'voosquare' do nothing", [JSON.stringify(ev)]);
  return ev;
}

async function owner(wsId, c = null) {
  const r = (await exec(c)('select u.voo_id, u.country from workspaces w join users u on u.id = w.owner_user_id where w.id = $1', [wsId])).rows[0];
  return r || { voo_id: null, country: null };
}

const cycleWord = (cycle) => (cycle === 'year' ? 'yearly' : 'monthly');

/** A plan was paid from the wallet (start or renewal). `first`: the workspace never paid before. */
async function planPaid(c, { wsId, txId, plan, cycle, priceCents, cashCents, first, at }) {
  const o = await owner(wsId, c);
  if (!o.voo_id || !txId) return;
  const label = `Castvoo ${plan.name}, ${cycleWord(cycle)}`;
  if (Number(cashCents) >= 1) {
    await queue('spend', { eventId: voo.eventId('pay', txId), vooId: o.voo_id, valueUsd: usd(cashCents), plan: plan.name, label, country: o.country, occurredAt: at,
      signals: o.country ? { payment_country: o.country } : undefined }, c);
  }
  if (Number(priceCents) >= 1) {
    await queue(first ? 'plan_started' : 'plan_renewed', { eventId: voo.eventId(first ? 'plan' : 'renew', txId), vooId: o.voo_id, valueUsd: usd(priceCents), plan: plan.name, label, occurredAt: at }, c);
  }
}

/** An upgrade paid from the wallet during a period (the price difference for the days left). */
async function upgradePaid(c, { wsId, txId, plan, cashCents, at }) {
  const o = await owner(wsId, c);
  if (!o.voo_id || !txId || !(Number(cashCents) >= 1)) return;
  await queue('spend', { eventId: voo.eventId('pay', txId), vooId: o.voo_id, valueUsd: usd(cashCents), plan: plan.name, label: `Castvoo upgrade to ${plan.name}`, country: o.country, occurredAt: at }, c);
}

/** A wallet top-up was paid (money in, not used yet: no commission). */
async function topupPaid(c, { payment, label, at }) {
  const o = await owner(payment.workspace_id, c);
  if (!o.voo_id) return;
  const signals = {};
  if (o.country) signals.payment_country = o.country;
  const fp = payment.txid || null; // crypto: the transaction; cards have no fingerprint in our records
  if (fp) signals.payment_fingerprint = voo.hashSignal(fp);
  await queue('wallet_topup', { eventId: voo.eventId('topup', payment.id), vooId: o.voo_id, valueUsd: usd(payment.amount_cents), label: `Castvoo wallet top-up (${label})`,
    country: o.country, occurredAt: at, signals: Object.keys(signals).length ? signals : undefined }, c);
}

/** The team returned wallet money (Admin → Users → wallet → refund). Logged by VooSquare; commission stays. */
async function refunded(c, { wsId, txId, amountCents, originalEventId, at }) {
  const o = await owner(wsId, c);
  if (!o.voo_id || !(Math.abs(Number(amountCents)) >= 1)) return;
  await queue('refund', { eventId: voo.eventId('rf', txId), vooId: o.voo_id, valueUsd: usd(Math.abs(Number(amountCents))), label: 'Castvoo wallet money returned', originalEventId: originalEventId || undefined, occurredAt: at }, c);
}

/**
 * Which plan payments used the money of one top-up. Wallet cash is spent oldest first (FIFO over wallet_tx), so
 * a chargeback reverses commission only on the plan payments that really used the disputed money.
 * Returns [{ txId, cents }].
 */
async function spendsUsingTopup(c, wsId, reference) {
  const txs = (await c.query('select id, kind, cash_cents, ref from wallet_tx where workspace_id = $1 order by id', [wsId])).rows;
  const lots = [];
  const used = [];
  for (const t of txs) {
    const cash = Number(t.cash_cents);
    if (cash > 0) { lots.push({ ref: t.kind === 'topup' ? t.ref : null, left: cash }); continue; }
    let need = -cash;
    while (need > 0 && lots.length) {
      const lot = lots[0];
      const take = Math.min(lot.left, need);
      lot.left -= take; need -= take;
      if (lot.ref === reference && t.kind === 'plan' && take > 0) {
        const prev = used.find((u) => u.txId === String(t.id));
        if (prev) prev.cents += take; else used.push({ txId: String(t.id), cents: take });
      }
      if (lot.left <= 0) lots.shift();
    }
  }
  return used;
}

/** A top-up was charged back: one chargeback per plan payment that used that money. Returns the events queued. */
async function chargedBack(c, { payment, at }) {
  const o = await owner(payment.workspace_id, c);
  if (!o.voo_id) return [];
  const out = [];
  for (const u of await spendsUsingTopup(c, payment.workspace_id, payment.reference)) {
    const ev = await queue('chargeback', { eventId: voo.eventId('cb', payment.id, u.txId), vooId: o.voo_id, valueUsd: usd(u.cents), originalEventId: voo.eventId('pay', u.txId),
      label: 'Castvoo top-up disputed', occurredAt: at }, c);
    if (ev) out.push(ev);
  }
  return out;
}

async function planCancelled({ wsId, plan, periodEnd, label }) {
  const o = await owner(wsId);
  if (!o.voo_id) return;
  const when = periodEnd ? new Date(periodEnd).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  await queue('plan_cancelled', { eventId: voo.eventId('cancel', wsId, when), vooId: o.voo_id, plan: plan || undefined, label: label || 'Castvoo plan cancelled' });
}

/** Activity: broadcast_sent, channel_connected (labels name the channel or campaign, never a person). */
async function activity(type, { wsId, idParts, label, at }) {
  const o = await owner(wsId);
  if (!o.voo_id) return;
  await queue(type, { eventId: voo.eventId(...idParts), vooId: o.voo_id, label, occurredAt: at });
}

/**
 * One drip_step_sent per workspace per finished hour: "Follow-ups: 1,240 messages". Safe to run often and on several
 * servers: the event id is fixed for the hour, so a repeat is ignored.
 */
async function dripRollup() {
  if (!enabled()) return;
  const rows = await db.many(`select d.workspace_id, date_trunc('hour', d.sent_at) as hour, count(*)::int n, u.voo_id, u.country
    from deliveries d join workspaces w on w.id = d.workspace_id join users u on u.id = w.owner_user_id
    where d.status = 'sent' and d.step_id is not null and d.action = 'send' and u.voo_id is not null
      and d.sent_at >= date_trunc('hour', now()) - interval '3 hours' and d.sent_at < date_trunc('hour', now() - interval '2 minutes')
    group by 1, 2, 4, 5`);
  for (const r of rows) {
    const hour = new Date(r.hour).toISOString().slice(0, 13);
    await queue('drip_step_sent', { eventId: voo.eventId('drip', r.workspace_id, hour), vooId: r.voo_id, label: `Follow-ups: ${r.n.toLocaleString('en-US')} message${r.n === 1 ? '' : 's'}`, occurredAt: new Date(new Date(r.hour).getTime() + 3599_000) });
  }
}

/** Copy a customer's support message into the VooSquare HQ inbox (same conversation each time). */
async function supportMessage({ threadId, user, subject, body }) {
  if (!supportEnabled() || !user.email) return;
  await db.query('insert into outbox(kind, payload) values ($1,$2)', ['voo_support', JSON.stringify({
    email: user.email, name: user.name || '', subject: String(subject || '').slice(0, 120), body: String(body).slice(0, 4000),
    external_ref: 'castvoo-' + threadId, voo_id: user.voo_id || undefined,
  })]);
}

const backoffSec = (attempts) => Math.min(3600, 30 * 2 ** Math.min(attempts, 7));

async function flush() {
  const k = voo.kit();
  if (!k || (!enabled() && !supportEnabled())) return { sent: 0 };
  await dripRollup().catch((e) => log.warn('drip rollup failed', { err: e.message }));
  let sent = 0;
  await db.tx(async (c) => {
    const rows = (await c.query(`select * from outbox where sent_at is null and failed_at is null and next_at <= now() and attempts < 40
      order by id limit 300 for update skip locked`)).rows;
    const later = async (row, err) => c.query('update outbox set attempts = attempts + 1, next_at = now() + make_interval(secs => $2), last_error = $3 where id = $1',
      [row.id, backoffSec(row.attempts), String(err || '').slice(0, 300)]);
    const dead = async (row, err) => c.query('update outbox set failed_at = now(), last_error = $2 where id = $1', [row.id, String(err || '').slice(0, 300)]);

    const events = rows.filter((r) => r.kind === 'voosquare');
    if (events.length && enabled()) {
      let lastErr = '';
      // A fresh client per run on the kit's HTTP layer: our table is the outbox, the kit does the sending rules.
      const client = new voo.K.EventsClient({ http: k.http, apiKey: V().apiKey, prefix: 'cv', store: voo.K.memoryStore(), maxAttempts: 1e9, backoffMs: 1000,
        onRejected: () => {}, onError: (e) => { lastErr = e.message; } });
      const byId = new Map();
      for (const r of events) {
        try { const ev = client.track(r.payload); byId.set(ev.event_id, r); } catch (e) { await dead(r, e.message); log.error('VooSquare event invalid', { id: r.id, err: e.message }); }
      }
      if (byId.size) {
        await client.flush();
        const pending = new Set(client.pending().map((e) => e.event_id));
        const failed = new Map(client.failures().map((f) => [f.event_id, f.error]));
        for (const [id, row] of byId) {
          if (failed.has(id)) { await dead(row, failed.get(id)); log.warn('VooSquare refused an event', { event_id: id, error: failed.get(id) }); } else if (pending.has(id)) await later(row, lastErr || 'not sent yet');
          else { await c.query('update outbox set sent_at = now(), last_error = null where id = $1', [row.id]); sent++; }
        }
        if (lastErr) log.warn('voosquare send failed', { err: lastErr, pending: pending.size });
      }
    }
    for (const row of rows.filter((r) => r.kind === 'voo_support')) {
      if (!supportEnabled()) break;
      try {
        await k.support.send(row.payload);
        await c.query('update outbox set sent_at = now(), last_error = null where id = $1', [row.id]);
      } catch (e) {
        await later(row, e.message);
      }
    }
  });
  return { sent };
}

module.exports = {
  queue, planPaid, upgradePaid, topupPaid, refunded, chargedBack, spendsUsingTopup, planCancelled, activity, dripRollup,
  supportMessage, flush, enabled, supportEnabled,
};

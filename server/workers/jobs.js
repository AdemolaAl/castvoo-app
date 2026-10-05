'use strict';
/*
 * Background jobs (they run inside the web server process; see workers/index.js for timings).
 * Every job is safe to run on several servers at once: they use row locks or unique keys.
 */

const db = require('../db');
const config = require('../config');
const log = require('../lib/log');
const settings = require('../services/settings');
const billing = require('../services/billing');
const email = require('../services/email');
const B = require('../services/broadcasts');
const connections = require('../services/connections');
const { fmtUSD, fmtDate } = require('../lib/util');

const APP = () => config.appUrl;

/** Scheduled broadcasts that are due → queue them. Finished broadcasts → mark sent. */
async function broadcastsTick() {
  const due = await db.many("select * from broadcasts where status = 'scheduled' and (send_at is null or send_at <= now()) order by id limit 20");
  for (const b of due) {
    // Maintenance, or broadcasts switched off in admin: try again in 5 minutes.
    const f = await settings.features();
    if (f.maintenance || !f.broadcasts) { await db.query("update broadcasts set send_at = now() + interval '5 minutes' where id = $1 and status = 'scheduled'", [b.id]); continue; }
    const ws = await db.one('select * from workspaces where id = $1', [b.workspace_id]);
    try {
      await billing.assertCanSend(ws);
      // enqueue() claims the broadcast itself (scheduled -> sending), so a "send now" request or another
      // server running this job at the same moment can't queue it a second time.
      await B.enqueue(b);
    } catch (e) {
      await db.query("update broadcasts set status = 'failed', finished_at = now() where id = $1 and status = 'scheduled'", [b.id]);
      log.warn('scheduled broadcast not sent', { id: b.id, reason: e.message });
    }
  }
  // 'sending' deliveries are in the hands of the sender right now, so the broadcast is not finished yet.
  const done = await db.many(`select b.* from broadcasts b where b.status = 'sending'
    and not exists (select 1 from deliveries d where d.broadcast_id = b.id and d.status in ('queued','sending') and d.action = 'send') limit 50`);
  for (const b of done) {
    const c = await db.one(`select count(*) filter (where status = 'sent')::int sent, count(*) filter (where status in ('failed','blocked'))::int failed
      from deliveries where broadcast_id = $1 and action = 'send'`, [b.id]);
    const r = await db.one("update broadcasts set status = 'sent', sent = $2, failed = $3, finished_at = now() where id = $1 and status = 'sending' returning id", [b.id, c.sent, c.failed]);
    if (!r) continue;
    const ws = await db.one('select w.*, u.email, u.name, u.id as uid, u.marketing_opt_out, u.voo_id from workspaces w join users u on u.id = w.owner_user_id where w.id = $1', [b.workspace_id]);
    if (b.total >= 100) {
      const k = await db.one('select count(*)::int n from clicks k join links l on l.code = k.code where l.broadcast_id = $1', [b.id]);
      await email.send('broadcast_finished', { id: ws.uid, email: ws.email, name: ws.name }, {
        broadcast_title: b.title, delivered: c.sent.toLocaleString('en-US'), failed: c.failed.toLocaleString('en-US'), clicks: k.n.toLocaleString('en-US'), report_url: APP() + '/#app/broadcast',
      });
    }
    if (c.sent > 0) require('../services/voosquare').activity('broadcast_sent', { wsId: b.workspace_id, idParts: ['bc', b.id], label: `${String(b.title || 'Broadcast').slice(0, 80)}: ${c.sent.toLocaleString('en-US')} message${c.sent === 1 ? '' : 's'}` }).catch(() => {});
  }
}

/** Follow-up steps that are due → queue one delivery each. */
async function dripsTick() {
  if (!(await settings.feature('drips'))) return;
  if (await settings.feature('maintenance')) return; // maintenance pauses all sending

  await db.tx(async (c) => {
    const runs = (await c.query(`select r.*, q.connection_id, q.workspace_id, q.active as seq_active, s.status as sub_status, s.tg_user_id, s.joined_at,
        w.plan_status, w.trial_ends_at
      from sequence_runs r join sequences q on q.id = r.sequence_id join subscribers s on s.id = r.subscriber_id join workspaces w on w.id = q.workspace_id
      where r.status = 'active' and r.due_at <= now() order by r.due_at limit 500 for update of r skip locked`)).rows;
    for (const r of runs) {
      const later = (mins) => c.query('update sequence_runs set due_at = now() + make_interval(mins => $2) where id = $1', [r.id, mins]);
      if (r.sub_status === 'blocked' || r.sub_status === 'stopped') { await c.query("update sequence_runs set status = 'stopped' where id = $1", [r.id]); continue; }
      if (r.sub_status === 'joinreq') {
        if (Date.now() - new Date(r.joined_at).getTime() > 7 * 86400000) await c.query("update sequence_runs set status = 'stopped' where id = $1", [r.id]);
        else await later(60);
        continue;
      }
      const paused = r.plan_status === 'paused' || r.plan_status === 'cancelled' || (r.plan_status === 'trial' && new Date(r.trial_ends_at) < new Date());
      if (!r.seq_active || paused) { await later(60); continue; }
      const step = (await c.query('select * from sequence_steps where sequence_id = $1 and position = $2', [r.sequence_id, r.next_position])).rows[0];
      if (!step) { await c.query("update sequence_runs set status = 'done' where id = $1", [r.id]); continue; }
      await c.query(`insert into deliveries(workspace_id, sender_key, step_id, subscriber_id, chat_id, priority, due_at) values ($1,$2,$3,$4,$5,4, now())`,
        [r.workspace_id, 'bot:' + r.connection_id, step.id, r.subscriber_id, r.tg_user_id]);
      const next = (await c.query('select position, delay_minutes from sequence_steps where sequence_id = $1 and position > $2 order by position limit 1', [r.sequence_id, step.position])).rows[0];
      if (next) await c.query('update sequence_runs set next_position = $2, due_at = now() + make_interval(mins => $3) where id = $1', [r.id, next.position, next.delay_minutes]);
      else await c.query("update sequence_runs set status = 'done' where id = $1", [r.id]);
    }
  });
}

/** Trials ending, renewals, reminders and pausing. */
async function billingTick() {
  const trial = await settings.get('trial');
  const b = await settings.get('billing');
  const owner = (ws) => db.one('select * from users where id = $1', [ws.owner_user_id]);

  // 1. Trial ends in under 2 days: remind once.
  for (const ws of await db.many("select * from workspaces where plan_status = 'trial' and trial_ends_at between now() and now() + interval '2 days' and reminded_at is null limit 200")) {
    const plan = await settings.plan(ws.pending_plan_code || ws.plan_code);
    // Only the server that sets reminded_at sends the email (the job may run on several servers).
    if (!(await db.one('update workspaces set reminded_at = now() where id = $1 and reminded_at is null returning id', [ws.id]))) continue;
    await email.send('trial_ending', await owner(ws), {
      trial_end_date: fmtDate(ws.trial_ends_at), plan_name: plan.name, plan_price: fmtUSD(billing.priceOf(plan, ws.pending_cycle || 'month')),
      wallet_balance: fmtUSD(Number(ws.wallet_cents) + Number(ws.bonus_cents)), topup_url: APP() + '/#app/wallet',
    });
  }
  // 2. Trial over: start the chosen plan from the wallet, or pause.
  for (const ws of await db.many("select * from workspaces where plan_status = 'trial' and trial_ends_at <= now() limit 200")) {
    // Renewal switched off during the trial: the trial just ends. Nothing is charged.
    if (ws.cancel_at_period_end) {
      await db.query("update workspaces set plan_status = 'cancelled', period_end = now() where id = $1 and plan_status = 'trial' and cancel_at_period_end", [ws.id]);
      continue;
    }
    const code = ws.pending_plan_code || ws.plan_code;
    const cycle = ws.pending_cycle || 'month';
    // expect: only if it is still a trial that has ended (another server may have just done it).
    try { await billing.activate(ws.id, code, cycle, { expect: (w) => w.plan_status === 'trial' && !w.cancel_at_period_end && new Date(w.trial_ends_at) <= new Date() }); } catch (e) {
      if (e.code !== 'wallet_short' && e.code !== 'bad_request') { log.error('trial activation failed', { ws: ws.id, err: e }); continue; }
      const r = await db.one("update workspaces set plan_status = 'paused', period_end = now() where id = $1 and plan_status = 'trial' returning id", [ws.id]);
      if (r) {
        const plan = await settings.plan(code);
        await email.send('trial_ended', await owner(ws), { plan_name: plan.name, plan_price: fmtUSD(billing.priceOf(plan, cycle)), topup_url: APP() + '/#app/wallet' });
      }
    }
  }
  // 3. Renewal in under N days and the wallet is short: remind once.
  for (const ws of await db.many(`select * from workspaces where plan_status = 'active' and not cancel_at_period_end and reminded_at is null
      and period_end between now() and now() + make_interval(days => $1) limit 200`, [b.renew_reminder_days])) {
    const plan = await settings.plan(ws.pending_plan_code || ws.plan_code);
    const price = billing.priceOf(plan, ws.pending_cycle || ws.billing_cycle);
    if (!(await db.one('update workspaces set reminded_at = now() where id = $1 and reminded_at is null returning id', [ws.id]))) continue;
    if (Number(ws.wallet_cents) + Number(ws.bonus_cents) >= price) continue;
    await email.send('renewal_low_balance', await owner(ws), {
      plan_name: plan.name, amount: fmtUSD(price), renewal_date: fmtDate(ws.period_end), wallet_balance: fmtUSD(Number(ws.wallet_cents) + Number(ws.bonus_cents)), topup_url: APP() + '/#app/wallet',
    });
  }
  // 4. Period over: cancel, renew, or pause.
  for (const ws of await db.many("select * from workspaces where plan_status = 'active' and period_end <= now() limit 200")) {
    if (ws.cancel_at_period_end) {
      if (!(await db.one("update workspaces set plan_status = 'cancelled' where id = $1 and plan_status = 'active' and cancel_at_period_end returning id", [ws.id]))) continue;
      const plan = await settings.plan(ws.plan_code);
      require('../services/voosquare').planCancelled({ wsId: ws.id, plan: plan && plan.name, periodEnd: ws.period_end, label: 'Castvoo plan ended' }).catch(() => {});
      continue;
    }
    const code = ws.pending_plan_code || ws.plan_code;
    const cycle = ws.pending_cycle || ws.billing_cycle;
    try { await billing.activate(ws.id, code, cycle, { expect: (w) => w.plan_status === 'active' && !w.cancel_at_period_end && new Date(w.period_end) <= new Date() }); } catch (e) {
      if (e.code !== 'wallet_short' && e.code !== 'bad_request') { log.error('renewal failed', { ws: ws.id, err: e }); continue; }
      const r = await db.one("update workspaces set plan_status = 'paused' where id = $1 and plan_status = 'active' returning id", [ws.id]);
      if (r) {
        const plan = await settings.plan(code);
        await email.send('plan_paused', await owner(ws), { plan_name: plan.name, amount: fmtUSD(billing.priceOf(plan, cycle)), topup_url: APP() + '/#app/wallet' });
      }
    }
  }
  // 4b. Yearly plans: AI writes refill every 30 days (monthly plans refill at renewal above).
  await db.query(`update workspaces set ai_used = 0, ai_period_start = ai_period_start + interval '30 days'
    where plan_status = 'active' and billing_cycle = 'year' and ai_period_start <= now() - interval '30 days'`);
  // 5. Delete data of workspaces that have been paused or cancelled for longer than the retention period.
  for (const ws of await db.many(`select * from workspaces where plan_status in ('paused','cancelled') and purged_at is null
      and coalesce(period_end, trial_ends_at, created_at) < now() - make_interval(days => $1) limit 20`, [b.data_retention_days])) {
    for (const conn of await db.many("select * from connections where workspace_id = $1 and status <> 'removed'", [ws.id])) {
      await connections.remove(ws, conn.id).catch(() => {});
    }
    await require('../services/media-files').removeFiles([ws.id]);
    await db.tx(async (c) => {
      await c.query('delete from subscribers where connection_id in (select id from connections where workspace_id = $1)', [ws.id]);
      await c.query('delete from segments where workspace_id = $1', [ws.id]);
      await c.query('delete from deliveries where workspace_id = $1', [ws.id]);
      await c.query('delete from broadcasts where workspace_id = $1', [ws.id]);
      await c.query('delete from sequences where workspace_id = $1', [ws.id]);
      await c.query('delete from media where workspace_id = $1', [ws.id]);
      await c.query('update workspaces set purged_at = now() where id = $1', [ws.id]);
    });
    log.info('workspace data deleted after retention period', { ws: ws.id });
  }
  void trial;
}

/** The 7 helpful sales emails for trial users (each sent at most once). */
async function salesTick() {
  if (!(await settings.feature('sales_emails'))) return;
  // Only one server sends sales emails at a time, so nobody gets the same email twice.
  const lock = await db.one(`insert into job_locks(name, locked_until) values ('sales', now() + interval '14 minutes')
    on conflict (name) do update set locked_until = excluded.locked_until where job_locks.locked_until < now() returning name`);
  if (!lock) return;
  try { await salesAll(); } finally { await db.query("update job_locks set locked_until = now() where name = 'sales'"); }
}

async function salesAll() {
  const winback = (await settings.activeOffers('coupon')).find((o) => o.code === 'COMEBACK20');
  // Go through everyone in pages of 500 (by id), so nobody is skipped however many sign up.
  let lastId = 0;
  for (;;) {
    const users = await db.many(`select u.*, w.id as ws_id, w.plan_status, w.trial_ends_at, w.paid_ever, w.ai_profile, w.pending_plan_code, w.plan_code,
      extract(epoch from now() - u.created_at) / 3600 as age_h,
      (select count(*)::int from connections c where c.workspace_id = w.id and c.status <> 'removed') as conns,
      (select count(*)::int from broadcasts b where b.workspace_id = w.id and b.status in ('sent','sending','scheduled')) as casts,
      (select count(*)::int from sequences q where q.workspace_id = w.id) as seqs
    from users u join workspaces w on w.owner_user_id = u.id
    where u.status = 'active' and u.email is not null and not u.marketing_opt_out and u.created_at > now() - interval '25 days' and not w.paid_ever
      and w.id = (select min(x.id) from workspaces x where x.owner_user_id = u.id) and u.id > $1
    order by u.id limit 500`, [lastId]);
    if (!users.length) break;
    lastId = Number(users[users.length - 1].id);
    await salesBatch(users, winback);
  }
}

async function salesBatch(users, winback) {
  for (const u of users) {
    const ws = u;
    if (u.plan_status === 'trial') {
      if (u.age_h >= 24 && u.conns === 0) await email.send('sales_connect_nudge', u, { connect_url: APP() + '/#app/bots', guide_url: APP() + '/#guide' }, { once: true });
      else if (u.age_h >= 48 && u.conns > 0 && u.casts === 0) await email.send('sales_first_message', u, { broadcast_url: APP() + '/#app/broadcast' }, { once: true });
      else if (u.age_h >= 72 && u.conns > 0 && u.seqs === 0) await email.send('sales_followups', u, { drips_url: APP() + '/#app/drips' }, { once: true });
      else if (u.age_h >= 96 && Object.keys(u.ai_profile || {}).length === 0) await email.send('sales_cas', u, { train_url: APP() + '/#app/ai' }, { once: true });
      if (new Date(ws.trial_ends_at).getTime() - Date.now() < 30 * 3600000) {
        const plan = await settings.plan(u.pending_plan_code || u.plan_code);
        await email.send('sales_trial_last_day', u, { plan_name: plan.name, plan_price: fmtUSD(plan.price_month_cents), pricing_url: APP() + '/#app/wallet', topup_url: APP() + '/#app/wallet' }, { once: true });
      }
    } else if (u.plan_status === 'paused') {
      const since = Date.now() - new Date(ws.trial_ends_at || u.created_at).getTime();
      if (winback && since > 3 * 86400000) {
        await email.send('sales_winback', u, { coupon_code: winback.code, coupon_percent: winback.percent, coupon_expiry: winback.ends_at ? fmtDate(winback.ends_at) : fmtDate(new Date(Date.now() + 14 * 86400000)), pricing_url: APP() + '/#app/wallet' }, { once: true });
      }
      if (u.age_h >= 21 * 24) await email.send('sales_feedback', u, { reply_url: `mailto:${(await settings.get('company')).support_email}?subject=What%20stopped%20me` }, { once: true });
    }
  }
}

/** Hourly tidy-up. */
async function cleanupTick() {
  await db.query('delete from sessions where expires_at < now()');
  await db.query("delete from login_codes where created_at < now() - interval '1 day'");
  await db.query('delete from oauth_states where expires_at < now()');
  await db.query('delete from connect_requests where expires_at < now()');
  await db.query("delete from tg_link_tokens where expires_at < now() - interval '1 day'");
  await db.query("delete from exports where expires_at < now()");
  await db.query("delete from deliveries where created_at < now() - interval '120 days' and status <> 'queued'");
  await db.query("delete from outbox where sent_at < now() - interval '14 days'");
  await db.query('delete from sender_leases where expires_at < now() - interval \'1 hour\'');
  await require('../services/media-files').removeUnused(3).catch((e) => log.warn('unused media cleanup failed', { err: e.message }));
  await connections.refreshCounts(1000);
}

module.exports = { broadcastsTick, dripsTick, billingTick, salesTick, cleanupTick };

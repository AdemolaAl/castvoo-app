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

/**
 * Follow-up steps that are due → queue one delivery each. Covers auto follow-ups and the later steps of
 * Welcome Flows. People who only asked to join (never pressed Start) can't be messaged: their run waits
 * ('waiting') until they press Start (services/flows.js onStart wakes it), and stops after 7 days.
 */
async function dripsTick() {
  const f = await settings.features();
  const dripsOn = !!f.drips, flowsOn = !!(f.welcome_flows && f.join_welcome);
  if (!dripsOn && !flowsOn) return;
  if (f.maintenance) return; // maintenance pauses all sending

  await db.query("update sequence_runs set status = 'stopped' where status = 'waiting' and created_at < now() - interval '7 days'");
  const plans = new Map();
  const planOf = async (ws) => {
    if (!plans.has(ws.id)) {
      const l = await billing.limits(ws);
      const feats = billing.featureSet(l); // ENG-22: the same feature list as the dashboard and the runtime
      const has = (k) => feats.has(k);
      const meter = await billing.joinMeter(ws, { counts: false });
      plans.set(ws.id, { l, has, joinPaused: meter.paused });
    }
    return plans.get(ws.id);
  };

  await db.tx(async (c) => {
    const runs = (await c.query(`select r.*, q.connection_id, q.workspace_id, q.active as seq_active, q.trigger_type, s.status as sub_status, s.tg_user_id, s.joined_at,
        w.plan_code, w.plan_status, w.trial_ends_at, w.created_at as ws_created_at, w.legacy_plan_code, w.legacy_ai_writes, w.legacy_until, w.dropped_at
      from sequence_runs r join sequences q on q.id = r.sequence_id join subscribers s on s.id = r.subscriber_id join workspaces w on w.id = q.workspace_id
      where r.status = 'active' and r.due_at <= now() and (($1 and q.trigger_type <> 'join_request') or ($2 and q.trigger_type = 'join_request'))
      order by r.due_at limit 500 for update of r skip locked`, [dripsOn, flowsOn])).rows;
    for (const r of runs) {
      const later = (mins) => c.query('update sequence_runs set due_at = now() + make_interval(mins => $2) where id = $1', [r.id, mins]);
      const done = () => c.query("update sequence_runs set status = 'done' where id = $1", [r.id]);
      if (r.sub_status === 'blocked' || r.sub_status === 'stopped') { await c.query("update sequence_runs set status = 'stopped' where id = $1", [r.id]); continue; }
      if (r.sub_status === 'joinreq') {
        // Telegram: no messages to people who never pressed Start. Wait for them (onStart wakes the run).
        await c.query("update sequence_runs set status = 'waiting' where id = $1", [r.id]);
        continue;
      }
      if (r.plan_status === 'paused' || r.plan_status === 'cancelled') { await later(60); continue; }
      if (!r.seq_active) { await later(60); continue; }
      const ws = { id: r.workspace_id, plan_code: r.plan_code, plan_status: r.plan_status, trial_ends_at: r.trial_ends_at, created_at: r.ws_created_at, legacy_plan_code: r.legacy_plan_code, legacy_ai_writes: r.legacy_ai_writes, legacy_until: r.legacy_until, dropped_at: r.dropped_at };
      const P = await planOf(ws);
      const isFlow = r.trigger_type === 'join_request';
      if (isFlow) {
        // The plan decides how much of a flow runs: Free sends only the welcome; others up to their steps per flow.
        if (!P.has('welcome_flows')) { await done(); continue; }
        if (P.l.flow_steps !== billing.UNLIMITED && r.next_position > P.l.flow_steps) { await done(); continue; }
        if (P.joinPaused) { await later(60); continue; } // over the month's join requests: flow messages pause
      } else if (!P.has('drips')) { await later(60); continue; }
      const step = (await c.query('select * from sequence_steps where sequence_id = $1 and position = $2 and variant = 0', [r.sequence_id, r.next_position])).rows[0];
      if (!step) { await done(); continue; }
      // QA-4: a step that still has a template's "(Write ... here)" placeholder is never sent.
      let skip = !!require('../services/flows').placeholderIn(step.body);
      if (!skip && step.condition) {
        // "Only if they clicked / didn't click a button in the previous message" (any version of it, for A/B welcomes).
        if (!P.has('condition_clicked')) skip = true;
        else {
          // "The previous message" = the last earlier message that has buttons (so two steps in a row can split on the same message).
          const prev = (await c.query(`select max(s.position) p from sequence_steps s where s.sequence_id = $1 and s.position < $2
            and exists (select 1 from links l where l.step_id = s.id)`, [r.sequence_id, step.position])).rows[0].p;
          const clicked = !!(await c.query(`select 1 from clicks k join links l on l.code = k.code join sequence_steps s on s.id = l.step_id
            where s.sequence_id = $1 and s.position = $2 and k.subscriber_id = $3 limit 1`, [r.sequence_id, prev, r.subscriber_id])).rows[0];
          skip = step.condition === 'clicked' ? !clicked : clicked;
        }
      }
      if (!skip) {
        await c.query(`insert into deliveries(workspace_id, sender_key, step_id, subscriber_id, chat_id, priority, due_at) values ($1,$2,$3,$4,$5,4, now())`,
          [r.workspace_id, 'bot:' + r.connection_id, step.id, r.subscriber_id, r.tg_user_id]);
      }
      const next = (await c.query('select position, delay_minutes from sequence_steps where sequence_id = $1 and position > $2 and variant = 0 order by position limit 1', [r.sequence_id, step.position])).rows[0];
      if (next) await c.query('update sequence_runs set next_position = $2, due_at = now() + make_interval(mins => $3) where id = $1', [r.id, next.position, next.delay_minutes]);
      else await done();
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
  // 2. Trial over: start the chosen plan from the wallet, or drop to Free (not paused: the welcome keeps running).
  for (const ws of await db.many("select * from workspaces where plan_status = 'trial' and trial_ends_at <= now() limit 200")) {
    const isTrialOver = (w) => w.plan_status === 'trial' && new Date(w.trial_ends_at) <= new Date();
    const code = ws.pending_plan_code || ws.plan_code;
    const cycle = ws.pending_cycle || 'month';
    const plan = await settings.plan(code);
    let toFree = ws.cancel_at_period_end || !plan || billing.isFreePlan(plan);
    if (!toFree) {
      // expect: only if it is still a trial that has ended (another server may have just done it).
      try { await billing.activate(ws.id, code, cycle, { expect: (w) => isTrialOver(w) && !w.cancel_at_period_end }); } catch (e) {
        if (e.code !== 'wallet_short' && e.code !== 'bad_request') { log.error('trial activation failed', { ws: ws.id, err: e }); continue; }
        toFree = true;
      }
    }
    if (!toFree) continue;
    // A plan they picked is remembered: a top-up that covers it starts it by itself.
    const r = await billing.dropToFree(ws.id, { expect: isTrialOver, remember: ws.pending_plan_code && !ws.cancel_at_period_end && plan && !billing.isFreePlan(plan) ? code : null, rememberCycle: cycle });
    if (r.ok) {
      const meter = await db.one("select count(*)::int n from join_requests where workspace_id = $1 and welcome = 'sent'", [ws.id]);
      const starter = (await settings.plans({ activeOnly: true })).filter((p) => !billing.isFreePlan(p)).sort((a, b) => a.price_month_cents - b.price_month_cents)[0];
      await email.send('trial_dropped_to_free', await owner(ws), {
        welcomed: meter.n.toLocaleString('en-US'), plan_name: starter ? starter.name : 'Starter', plan_price: fmtUSD(starter ? starter.price_month_cents : 1900), topup_url: APP() + '/#app/wallet',
      });
    } else if (r.reason === 'no_free_plan') {
      // The team removed the Free plan: the old rule (pause until a top-up).
      const p2 = await db.one("update workspaces set plan_status = 'paused', period_end = now() where id = $1 and plan_status = 'trial' returning id", [ws.id]);
      if (p2 && plan) await email.send('trial_ended', await owner(ws), { plan_name: plan.name, plan_price: fmtUSD(billing.priceOf(plan, cycle)), topup_url: APP() + '/#app/wallet' });
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
  // 4. Period over: renew, or drop to Free (cancelled, moving to Free, or the wallet is short). Nothing is deleted.
  for (const ws of await db.many("select * from workspaces where plan_status = 'active' and period_end <= now() limit 200")) {
    const ended = (w) => w.plan_status === 'active' && w.period_end && new Date(w.period_end) <= new Date();
    const code = ws.pending_plan_code || ws.plan_code;
    const cycle = ws.pending_cycle || ws.billing_cycle;
    const next = await settings.plan(code);
    if (ws.cancel_at_period_end || billing.isFreePlan(next)) {
      const r = await billing.dropToFree(ws.id, { expect: (w) => ended(w) && (w.cancel_at_period_end || w.pending_plan_code === ws.pending_plan_code) });
      if (r.reason === 'no_free_plan') {
        if (!(await db.one("update workspaces set plan_status = 'cancelled' where id = $1 and plan_status = 'active' and cancel_at_period_end returning id", [ws.id]))) continue;
      } else if (!r.ok) continue;
      const plan = await settings.plan(ws.plan_code);
      require('../services/voosquare').planCancelled({ wsId: ws.id, plan: plan && plan.name, periodEnd: ws.period_end, label: 'Castvoo plan ended' }).catch(() => {});
      continue;
    }
    try { await billing.activate(ws.id, code, cycle, { expect: (w) => ended(w) && !w.cancel_at_period_end }); } catch (e) {
      if (e.code !== 'wallet_short' && e.code !== 'bad_request') { log.error('renewal failed', { ws: ws.id, err: e }); continue; }
      const plan = await settings.plan(code);
      const r = await billing.dropToFree(ws.id, { expect: (w) => ended(w) && !w.cancel_at_period_end, remember: code, rememberCycle: cycle });
      if (r.ok) {
        await email.send('plan_dropped_to_free', await owner(ws), { plan_name: plan ? plan.name : code, amount: fmtUSD(plan ? billing.priceOf(plan, cycle) : 0), topup_url: APP() + '/#app/wallet' });
      } else if (r.reason === 'no_free_plan') {
        const p2 = await db.one("update workspaces set plan_status = 'paused' where id = $1 and plan_status = 'active' returning id", [ws.id]);
        if (p2 && plan) await email.send('plan_paused', await owner(ws), { plan_name: plan.name, amount: fmtUSD(billing.priceOf(plan, cycle)), topup_url: APP() + '/#app/wallet' });
      }
    }
  }
  // 4b. Yearly plans: AI writes refill every 30 days (monthly plans refill at renewal above).
  await db.query(`update workspaces set ai_used = 0, ai_period_start = ai_period_start + interval '30 days'
    where plan_status = 'active' and billing_cycle = 'year' and ai_period_start <= now() - interval '30 days'`);
  // 5. Delete data of workspaces that have been paused or cancelled for longer than the retention period (only when
  //    the team removed the Free plan: otherwise an ended plan moves to Free and the data is kept, see 6).
  for (const ws of await db.many(`select * from workspaces where plan_status in ('paused','cancelled') and purged_at is null
      and coalesce(period_end, trial_ends_at, created_at) < now() - make_interval(days => $1) limit 20`, [b.data_retention_days])) {
    await purgeWorkspace(ws);
    log.info('workspace data deleted after retention period', { ws: ws.id });
  }
  // 6. AUD-6: data is kept while a workspace is on the Free plan and in use. A Free workspace that nobody has used for
  //    billing.inactive_free_days (default 365: no owner login or dashboard visit, no join request, no money in the
  //    wallet) is inactive. The legal pages promise "we email you first", so its content is deleted only after two
  //    warning emails (see inactiveFreeTick): never sooner than 30 days after the first and 7 days after the second.
  await inactiveFreeTick(b);
  void trial;
}

const DAY = 86400000;
const WARN_FIRST_DAYS = 30;  // first warning: 30 days before the delete date
const WARN_LAST_DAYS = 7;    // last warning: 7 days before it

/** Inactive Free workspaces: warn at 30 and 7 days, then purge. Coming back (login, a dashboard visit, a join request,
 *  money in the wallet) cancels it: a warning sent before the last activity no longer counts. */
async function inactiveFreeTick(b) {
  const days = Number(b.inactive_free_days ?? 365);
  if (!(days > 0)) return;
  // last_act: the latest sign of use. A warning counts only if it was sent after last_act.
  const rows = await db.many(`with c as (
      select w.*, u.email as owner_email, u.status as owner_status,
        greatest(w.created_at, u.created_at, coalesce(u.last_login_at, u.created_at), coalesce(u.last_seen_at, u.created_at),
          coalesce((select max(j.requested_at) from join_requests j where j.workspace_id = w.id), w.created_at)) as last_act
      from workspaces w join users u on u.id = w.owner_user_id
      where w.plan_code = 'free' and w.plan_status = 'active' and w.purged_at is null and w.wallet_cents <= 0 and w.bonus_cents = 0
        and w.created_at < now() - make_interval(days => $1::int - $2::int))
    , s as (select c.*, c.last_act + make_interval(days => $1::int) as due,
      coalesce(c.inactive_warn1_at > c.last_act, false) as w1,
      coalesce(c.inactive_warn2_at > c.last_act and c.inactive_warn2_at >= c.inactive_warn1_at, false) as w2
      from c where c.last_act < now() - make_interval(days => $1::int - $2::int))
    -- next_at: when this workspace next needs something (a warning or the purge); only those due now are read.
    select s.*, s.last_act::text as last_act_raw, s.inactive_warn2_at::text as warn2_raw from s
    where case when not s.w1 then s.owner_email is not null and s.owner_status = 'active'
      when not s.w2 then greatest(s.due, s.inactive_warn1_at + make_interval(days => $2::int)) - make_interval(days => $3::int) <= now()
      else greatest(s.due, s.inactive_warn1_at + make_interval(days => $2::int), s.inactive_warn2_at + make_interval(days => $3::int)) <= now() end
    order by s.last_act limit 100`, [days, WARN_FIRST_DAYS, WARN_LAST_DAYS]);
  for (const ws of rows) {
    const due = new Date(ws.last_act).getTime() + days * DAY;
    // The delete date never comes sooner than 30 days after the first warning or 7 days after the last one.
    const deleteAt = (w1, w2) => Math.max(due, w1 ? new Date(w1).getTime() + WARN_FIRST_DAYS * DAY : Infinity, w2 ? new Date(w2).getTime() + WARN_LAST_DAYS * DAY : 0);
    if (!ws.w1) {
      // (Owners with no email address are never warned, so their data is never deleted this way.)
      await warnInactive(ws, 1, deleteAt(Date.now(), null));
    } else if (!ws.w2) {
      const at = deleteAt(ws.inactive_warn1_at, null);
      if (Date.now() >= at - WARN_LAST_DAYS * DAY) await warnInactive(ws, 2, deleteAt(ws.inactive_warn1_at, Date.now()));
    } else if (Date.now() >= deleteAt(ws.inactive_warn1_at, ws.inactive_warn2_at)) {
      // Re-check under the claim that nothing changed since the list was read (a login or a top-up in between).
      const still = await db.one(`update workspaces set inactive_warn2_at = inactive_warn2_at where id = $1 and purged_at is null
        and plan_code = 'free' and plan_status = 'active' and wallet_cents <= 0 and bonus_cents = 0 and inactive_warn2_at = $2::timestamptz returning id`, [ws.id, ws.warn2_raw]);
      if (!still) continue;
      const fresh = await db.one(`select greatest(u.last_login_at, u.last_seen_at) as seen from users u where u.id = $1`, [ws.owner_user_id]);
      if (fresh && fresh.seen && new Date(fresh.seen) > new Date(ws.inactive_warn2_at)) continue;
      await purgeWorkspace(ws);
      log.info('inactive Free workspace data deleted', { ws: ws.id, days });
    }
  }
}

/** Send warning 1 or 2. Only the server that records it sends it; if the email fails, the record is undone. */
async function warnInactive(ws, n, deleteAtMs) {
  const col = n === 1 ? 'inactive_warn1_at' : 'inactive_warn2_at';
  const prev = ws[col];
  // Claim: the warning is not on record yet for this stretch of inactivity (none, or one sent before the last activity).
  const stale = n === 1 ? `(inactive_warn1_at is null or inactive_warn1_at <= $2::timestamptz)`
    : `(inactive_warn1_at > $2::timestamptz and (inactive_warn2_at is null or inactive_warn2_at <= $2::timestamptz or inactive_warn2_at < inactive_warn1_at))`;
  const claimed = await db.one(`update workspaces set ${col} = now() where id = $1 and ${stale} returning id`, [ws.id, ws.last_act_raw]);
  if (!claimed) return;
  const owner = await db.one('select * from users where id = $1', [ws.owner_user_id]);
  const ok = await email.send('inactive_free_warning', owner, {
    workspace_name: ws.name || 'your workspace',
    delete_date: fmtDate(deleteAtMs),
    days_left: String(Math.max(1, Math.round((deleteAtMs - Date.now()) / DAY))),
    login_url: APP() + '/#login',
  });
  if (!ok) await db.query(`update workspaces set ${col} = $2 where id = $1`, [ws.id, prev]);
  else log.info('inactive Free workspace warned', { ws: ws.id, warning: n, delete_date: new Date(deleteAtMs).toISOString() });
}

/** Delete a workspace's content (connections, subscribers, messages, flows, media, join requests, links, clicks,
 *  replies, the support AI tool log). Money records, the account and its members stay. */
async function purgeWorkspace(ws) {
  for (const conn of await db.many("select * from connections where workspace_id = $1 and status <> 'removed'", [ws.id])) {
    await connections.remove(ws, conn.id).catch(() => {});
  }
  await require('../services/media-files').removeFiles([ws.id]);
  await db.tx(async (c) => {
    // SEC-8: the same list as account deletion (join requests, follow-up progress, links and clicks, replies, the support
    // AI's tool log). Runs first: sequence_runs are found through the subscribers deleted below. Members stay.
    await require('../services/purge').purgeRows(c, [ws.id]);
    await c.query('delete from subscribers where connection_id in (select id from connections where workspace_id = $1)', [ws.id]);
    await c.query('delete from segments where workspace_id = $1', [ws.id]);
    await c.query('delete from deliveries where workspace_id = $1', [ws.id]);
    await c.query('delete from broadcasts where workspace_id = $1', [ws.id]);
    await c.query('delete from join_requests where workspace_id = $1', [ws.id]);
    await c.query('delete from join_meter where workspace_id = $1', [ws.id]);
    await c.query('delete from sequences where workspace_id = $1', [ws.id]);
    await c.query('delete from media where workspace_id = $1', [ws.id]);
    await c.query('update workspaces set purged_at = now() where id = $1', [ws.id]);
  });
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
    const users = await db.many(`select u.*, w.id as ws_id, w.plan_status, w.trial_ends_at, w.paid_ever, w.ai_profile, w.pending_plan_code, w.plan_code, w.dropped_at,
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
  const b = await settings.get('billing');
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
    } else if (u.plan_status === 'paused' || (u.plan_status === 'active' && u.plan_code === 'free' && u.dropped_at)) {
      // AUD-4: trials now end on the Free plan (active, plan 'free', dropped_at set), not paused. Win-back on day 8 and
      // day 14 after sign-up (COMEBACK20), then the feedback question on day 21. Old paused workspaces get the same.
      const onFree = u.plan_status === 'active';
      if (winback) {
        const sent = (await db.one("select count(*)::int n, max(created_at) last from email_log where user_id = $1 and template = 'sales_winback' and status = 'sent'", [u.id]));
        const due = (sent.n === 0 && u.age_h >= 8 * 24) || (sent.n === 1 && u.age_h >= 14 * 24 && Date.now() - new Date(sent.last).getTime() > 4 * 86400000);
        if (due) {
          await email.send('sales_winback', u, {
            coupon_code: winback.code, coupon_percent: winback.percent, coupon_expiry: winback.ends_at ? fmtDate(winback.ends_at) : fmtDate(new Date(Date.now() + 14 * 86400000)), pricing_url: APP() + '/#app/wallet',
            plan_now: onFree
              ? 'Your workspace is on the Free plan now. Your first Welcome Flow still welcomes people (with the small Castvoo line), but your follow-ups, broadcasts and other flows are paused.'
              : 'Your plan is paused, so nothing is sending right now.',
            data_note: onFree
              ? 'Everything stays saved while your workspace is on the Free plan, so it is all waiting for you.'
              : `We keep your data for ${b.data_retention_days} days after a plan ends, then it is deleted for good. Come back before then and it is all waiting for you.`,
          });
        }
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
  // ENG-2: join requests are not kept for ever. Open ones older than 30 days are gone in Telegram too; decided ones
  // older than about 13 months are deleted (the meter and the stats only look at recent ones). Old meter rows go too.
  await db.query("update join_requests set status = 'gone', decided_at = now(), error = 'Expired: open for more than 30 days.' where status = 'pending' and requested_at < now() - interval '30 days'");
  await db.query("delete from join_requests where status <> 'pending' and requested_at < now() - interval '400 days'");
  await db.query("delete from join_meter where since < now() - interval '400 days'");
  await require('../services/media-files').removeUnused(3).catch((e) => log.warn('unused media cleanup failed', { err: e.message }));
  await require('../services/support-images').removeUnsent(24).catch((e) => log.warn('unsent support images cleanup failed', { err: e.message }));
  await connections.refreshCounts(1000);
}

module.exports = { broadcastsTick, dripsTick, billingTick, salesTick, cleanupTick, purgeWorkspace };

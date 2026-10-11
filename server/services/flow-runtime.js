'use strict';
/*
 * The flow runtime: moves each person through a Welcome Flow (or an auto follow-up) from top to bottom.
 *
 * A person's place in a flow is their run (sequence_runs: next_position, due_at, status). The drips job
 * (workers/jobs.js dripsTick) calls processRun() for every run that is due, and processTimer() for every due row of
 * flow_step_runs. Short times are fired on time by workers/soon.js (call env.soon(t) / soon.at(t)).
 *
 * What a run does at the message it points to (its trigger, see services/flows.js):
 *   after_previous / wait  send it now (its wait was already counted in due_at), then point to the next message
 *   no_response            start its timer (a flow_step_runs row due after its wait) and point to the next message
 *   on_start               they tapped Start already (subscriber 'active')? send it. If not: the run is 'awaiting'
 *   on_button              a choice: one or more answers in a row for buttons of the same message. A button of that
 *                          message tapped already? Each tapped button's answer is queued (flow_step_runs) and the run
 *                          points past the choice. If not: 'awaiting'
 * Events (they come in through bot-updates.js and the /l/ link redirect):
 *   onStarted(sub)         Start: 'awaiting' and 'waiting' runs go again, answers 'waiting_start' are queued, answered
 *                          reminders are cancelled
 *   onTap(conn, sub, link) a Reply button (callback) or a tracked Link button: the run at that choice goes again at once;
 *                          a run already past it (they tap another button later) gets that button's answer queued.
 *                          flow_step_runs (run_id, step_id) is unique: a double tap sends an answer once.
 * Timers (flow_step_runs, status 'scheduled'):
 *   a reminder whose person tapped Start (since it was armed) or a button of the message above is 'cancelled';
 *   otherwise it is sent like any message.
 * Bots (services/bots.js): Chat bots (trigger_type 'bot_start') run here too, plus the step types:
 *   check_join / ask       sent once (sequence_runs.sent_position), then the run is 'awaiting' until the person taps
 *                          "I've joined" (and really joined) or sends a valid answer (bots.js passStep → advanceRun).
 *                          Their optional reminder is a flow_step_runs row of the step itself, cancelled once they pass it.
 *   referral               sends their invite link and progress, then goes on
 *   on_goal (trigger)      the reward: sent once they reached the goal of the referral step above, else 'awaiting'
 *                          (bots.js recordReferral wakes it)
 * Telegram rules: someone who never tapped Start can only be messaged in the 5-minute window after asking to join,
 * while the request is open (a "quick" send through user_chat_id). Outside it, a run is 'waiting' (until Start) and a
 * button answer is 'waiting_start'; a reminder they can't get is 'skipped' (it asked them to tap Start anyway).
 */

const db = require('../db');
const billing = require('./billing');
const soon = require('../workers/soon');

const flows = () => require('./flows');

/** Everything one tick shares: plan answers per workspace, steps per flow, the soonest due time it set. */
function env() {
  const plans = new Map();
  const seqs = new Map();
  const e = {
    soonest: null,
    soon(t) { const d = t instanceof Date ? t : new Date(t); if (!e.soonest || d < e.soonest) e.soonest = d; },
    async planOf(r) {
      if (!plans.has(r.workspace_id)) {
        const ws = { id: r.workspace_id, plan_code: r.plan_code, plan_status: r.plan_status, trial_ends_at: r.trial_ends_at, created_at: r.ws_created_at, legacy_plan_code: r.legacy_plan_code, legacy_ai_writes: r.legacy_ai_writes, legacy_until: r.legacy_until, dropped_at: r.dropped_at };
        const l = await billing.limits(ws);
        const feats = billing.featureSet(l); // ENG-22: the same feature list as the dashboard and the runtime
        const meter = await billing.joinMeter(ws, { counts: false });
        plans.set(r.workspace_id, { l, has: (k) => feats.has(k), joinPaused: meter.paused });
      }
      return plans.get(r.workspace_id);
    },
    async seq(c, seqId) {
      const k = String(seqId);
      if (!seqs.has(k)) seqs.set(k, await loadSeq(c, seqId));
      return seqs.get(k);
    },
  };
  return e;
}

/** One flow's steps (variant 0, in order), with its graph (see flows.flowGraph). */
async function loadSeq(c, seqId) {
  const q = (await c.query('select id, start_button, approve_mode, trigger_type, connection_id, workspace_id from sequences where id = $1', [seqId])).rows[0] || null;
  const steps = (await c.query(`select s.id, s.position, s.delay_seconds, s.delay_minutes, s.trigger_type, s.trigger_button, s.action_start_flow_id, s.condition, s.body, s.step_type, s.config,
      (select coalesce(json_agg(json_build_object('button_id', l.button_id, 'code', l.code)), '[]') from links l where l.step_id = s.id) as buttons
    from sequence_steps s where s.sequence_id = $1 and s.variant = 0 order by s.position`, [seqId])).rows;
  const F = flows();
  const graph = F.flowGraph(steps, { startButton: !!(q && q.trigger_type === 'join_request' && (q.start_button || q.approve_mode === 'tap')) });
  return {
    q, steps, graph,
    byPos: new Map(steps.map((s) => [s.position, s])),
    byId: new Map(steps.map((s) => [String(s.id), s])),
    first: steps[0] ? steps[0].position : null,
    after: (pos) => steps.find((s) => s.position > pos) || null,
    trigger: (s) => (steps[0] && s.position === steps[0].position ? 'after_previous' : F.triggerOf(s)),
  };
}

/** How long the run waits before this step once it points to it: a wait counts, everything else is checked at once. */
function dueFor(S, step) { const t = S.trigger(step); return t === 'after_previous' || t === 'wait' ? flows().delayOf(step) : 0; }

/** Point the run to the message after `pos` (or finish it). */
async function advance(c, r, S, pos, e) {
  const next = S.after(pos);
  if (!next) { await c.query("update sequence_runs set status = 'done' where id = $1", [r.id]); return; }
  const due = (await c.query("update sequence_runs set next_position = $2, due_at = now() + make_interval(secs => $3), status = 'active' where id = $1 returning due_at", [r.id, next.position, dueFor(S, next)])).rows[0].due_at;
  e.soon(due);
}

/** The open join request this person can still be reached through (Telegram's 5-minute window), if any. */
async function quickFor(c, r) {
  return (await c.query(`select id, sequence_id, user_chat_id, tg_user_id, hold_position from join_requests
      where subscriber_id = $1 and connection_id = $2 and status = 'pending' and requested_at > now() - make_interval(secs => $3)
      order by (sequence_id = $4) desc, id desc limit 1`, [r.subscriber_id, r.connection_id, flows().WINDOW_SECONDS, r.sequence_id])).rows[0] || null;
}

/**
 * Is this the message after which a held request is let in? The held step itself, or (when the held step is a
 * message on the main line) any later main-line message. A reminder only counts when it is the held step.
 */
function holdHereFor(quick, r, S, step, isTimer) {
  if (!quick || !quick.hold_position || String(quick.sequence_id) !== String(r.sequence_id)) return false;
  const hold = Number(quick.hold_position);
  if (step.position === hold) return true;
  if (isTimer) return false;
  const hs = S.byPos.get(hold);
  return !!hs && S.trigger(hs) !== 'no_response' && step.position > hold;
}

/**
 * Queue one message to the person (or skip it: template placeholder, or its click condition says no).
 * Quick sends go first in the bot's queue (priority 1): the window is short. Returns true when queued.
 */
async function sendStep(c, r, S, step, P, quick, holdHere, opts = {}) {
  const F = flows();
  // QA-4: a step that still has a template's "(Write ... here)" placeholder is never sent.
  let skip = !!F.placeholderIn(step.body);
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
    // Chat bots: the Free plan's line on the first message; a bot step's kind for the sender (services/bots.js deliveryParts).
    const kind = step.step_type || 'message';
    const brand = r.trigger_type === 'bot_start' && step.position === S.first && !!P.l.branding;
    const extra = kind !== 'message' || brand || opts.reminder ? { kind, ...(brand ? { brand: true } : {}), ...(opts.reminder ? { reminder: true } : {}) } : null;
    await c.query(`insert into deliveries(workspace_id, sender_key, step_id, subscriber_id, chat_id, priority, due_at, join_request_id, then_approve, extra)
        values ($1,$2,$3,$4,$5,$6, now(), $7, $8, $9)`,
    [r.workspace_id, 'bot:' + r.connection_id, step.id, r.subscriber_id, quick ? (quick.user_chat_id || quick.tg_user_id) : r.tg_user_id, quick ? 1 : (r.trigger_type === 'bot_start' ? 2 : 4), quick ? quick.id : null, holdHere, extra ? JSON.stringify(extra) : null]);
  } else if (holdHere) {
    await c.query("update join_requests set approve_at = now() where id = $1 and status = 'pending' and approve_at is not null", [quick.id]);
  }
  if (!skip && !opts.reminder && step.action_start_flow_id && P.has('start_another_flow')) {
    await startFlowFor(c, r, step.action_start_flow_id); // fires its first message on time itself (soon.at)
  }
  return !skip;
}

/**
 * "Start another flow": the person starts that flow from its first message (same workspace and bot only).
 * A person goes through each flow once (a run that exists already is left alone), so two flows can't loop.
 */
async function startFlowFor(c, r, targetId) {
  const t = (await c.query('select id, workspace_id, connection_id from sequences where id = $1', [targetId])).rows[0];
  if (!t || String(t.workspace_id) !== String(r.workspace_id) || String(t.connection_id) !== String(r.connection_id)) return null;
  const first = (await c.query('select position, delay_seconds from sequence_steps where sequence_id = $1 and variant = 0 order by position limit 1', [t.id])).rows[0];
  if (!first) return null;
  const ins = await c.query(`insert into sequence_runs(sequence_id, subscriber_id, next_position, due_at, status) values ($1,$2,$3, now() + make_interval(secs => $4), 'active')
      on conflict (sequence_id, subscriber_id) do nothing returning due_at`, [t.id, r.subscriber_id, first.position, Number(first.delay_seconds) || 0]);
  const due = ins.rows[0] ? ins.rows[0].due_at : null;
  if (due) soon.at(due);
  return due;
}

/** Plan and switch checks shared by runs and timers. Returns null (go on) or what to do: 'later' | 'end'. */
async function planGate(r, P, position) {
  if (r.plan_status === 'paused' || r.plan_status === 'cancelled') return 'later';
  if (!r.seq_active) return 'later';
  if (r.trigger_type === 'bot_start') return null; // Chat bots: the plan was checked when the bot was saved and switched on
  if (r.trigger_type === 'join_request') {
    // The plan decides how much of a flow runs: Free sends only the welcome; others up to their steps per flow.
    if (!P.has('welcome_flows')) return 'end';
    if (P.l.flow_steps !== billing.UNLIMITED && position > P.l.flow_steps) return 'end';
    if (P.joinPaused) return 'later'; // over the month's join requests: flow messages pause
  } else if (!P.has('drips')) return 'later';
  return null;
}

/** Process one due run (inside the tick's transaction c; the row is locked). */
async function processRun(c, r, e) {
  const later = (mins) => c.query('update sequence_runs set due_at = now() + make_interval(mins => $2) where id = $1', [r.id, mins]);
  const status = (st) => c.query('update sequence_runs set status = $2 where id = $1', [r.id, st]);
  if (r.sub_status === 'blocked' || r.sub_status === 'stopped') { await status('stopped'); return; }
  let quick = null; // the open join request this step can still reach them through (Telegram's 5-minute window)
  if (r.sub_status === 'joinreq') {
    quick = await quickFor(c, r);
    // Telegram: no messages to people who never pressed Start (after the window). Wait for them (Start wakes the run).
    if (!quick) { await status('waiting'); return; }
  }
  const P = await e.planOf(r);
  const gate = await planGate(r, P, r.next_position);
  if (gate === 'later') { await later(60); return; }
  if (gate === 'end') { await status('done'); return; }
  const S = await e.seq(c, r.sequence_id);
  const step = S.byPos.get(Number(r.next_position));
  if (!step) { await status('done'); return; }
  const tr = S.trigger(step);
  const kind = step.step_type || 'message';
  if (kind === 'check_join' || kind === 'ask') {
    // Sent once; then the run waits for "I've joined" / their answer (services/bots.js).
    if (Number(r.sent_position) === Number(step.position)) { await status('awaiting'); return; }
    const sent = await sendStep(c, r, S, step, P, quick, holdHereFor(quick, r, S, step, false));
    if (!sent) { await advance(c, r, S, step.position, e); return; } // a template placeholder: skipped, never stuck
    await c.query("update sequence_runs set sent_position = $2, status = 'awaiting' where id = $1", [r.id, step.position]);
    const remind = Number((step.config || {}).remind_seconds) || 0;
    if (remind > 0) {
      const t = await c.query(`insert into flow_step_runs(run_id, step_id, status, due_at) values ($1,$2,'scheduled', now() + make_interval(secs => $3))
          on conflict (run_id, step_id) do update set status = 'scheduled', due_at = excluded.due_at, done_at = null returning due_at`, [r.id, step.id, remind]);
      e.soon(t.rows[0].due_at);
    }
    return;
  }
  if (tr === 'on_goal' && !(await goalReached(c, r, S, step))) { await status('awaiting'); return; }
  if (tr === 'no_response') {
    const ins = await c.query(`insert into flow_step_runs(run_id, step_id, status, due_at, armed_active) values ($1,$2,'scheduled', now() + make_interval(secs => $3), $4)
        on conflict (run_id, step_id) do nothing returning due_at`, [r.id, step.id, flows().delayOf(step), r.sub_status === 'active']);
    if (ins.rows[0]) e.soon(ins.rows[0].due_at);
    await advance(c, r, S, step.position, e);
    return;
  }
  if (tr === 'on_start' && r.sub_status !== 'active') { await status('awaiting'); return; }
  if (tr === 'on_button') {
    const g = (S.graph.get(step.position) || {}).group;
    if (!g || !g.owner) { await status('awaiting'); return; }
    const tapped = new Set((await c.query(`select distinct l.button_id from clicks k join links l on l.code = k.code join sequence_steps s on s.id = l.step_id
        where s.sequence_id = $1 and s.position = $2 and k.subscriber_id = $3`, [r.sequence_id, g.owner, r.subscriber_id])).rows.map((x) => x.button_id));
    const hits = g.members.map((p) => S.byPos.get(p)).filter((m) => m && tapped.has(m.trigger_button));
    if (!hits.length) { await status('awaiting'); return; }
    for (const m of hits) {
      await c.query("insert into flow_step_runs(run_id, step_id, status, due_at) values ($1,$2,'scheduled', now()) on conflict (run_id, step_id) do nothing", [r.id, m.id]);
    }
    e.soon(new Date());
    await advance(c, r, S, Math.max(...g.members), e);
    return;
  }
  await sendStep(c, r, S, step, P, quick, holdHereFor(quick, r, S, step, false));
  await advance(c, r, S, step.position, e);
}

/** Did they answer what this reminder waits for (Start since it was armed, or a button of the message above)? */
async function responded(c, t, S, step) {
  const info = S.graph.get(step.position) || {};
  const a = info.awaits || { start: false, buttons: [], positions: [] };
  if (a.start && !t.armed_active && t.sub_status === 'active') return true;
  if (a.buttons.length) {
    const hit = (await c.query(`select 1 from clicks k join links l on l.code = k.code join sequence_steps s on s.id = l.step_id
        where s.sequence_id = $1 and s.position = any($2::int[]) and k.subscriber_id = $3 limit 1`, [t.sequence_id, a.positions, t.subscriber_id])).rows[0];
    if (hit) return true;
  }
  return false;
}

/** Process one due flow_step_runs row: a reminder or a button's answer. */
async function processTimer(c, t, e) {
  const fin = (st) => c.query('update flow_step_runs set status = $2, done_at = now() where id = $1', [t.fsr_id, st]);
  const later = (mins) => c.query('update flow_step_runs set due_at = now() + make_interval(mins => $2) where id = $1', [t.fsr_id, mins]);
  if (t.sub_status === 'blocked' || t.sub_status === 'stopped' || t.status === 'stopped') { await fin('skipped'); return; }
  const S = await e.seq(c, t.sequence_id);
  const step = S.byId.get(String(t.step_id));
  if (!step) { await fin('cancelled'); return; }
  const P = await e.planOf(t);
  const gate = await planGate(t, P, step.position);
  if (gate === 'later') { await later(60); return; }
  if (gate === 'end') { await fin('skipped'); return; }
  const tr = S.trigger(step);
  const quick = t.sub_status === 'joinreq' ? await quickFor(c, t) : null;
  if (step.step_type === 'check_join' || step.step_type === 'ask') {
    // The reminder of a check or a question: only while they still sit on it.
    if (Number(t.next_position) !== Number(step.position) || t.status !== 'awaiting' || Number(t.sent_position) !== Number(step.position)) { await fin('cancelled'); return; }
    if (t.sub_status === 'joinreq' && !quick) { await fin('skipped'); return; }
    const sent = await sendStep(c, t, S, step, P, quick, false, { reminder: true });
    await fin(sent ? 'sent' : 'skipped');
    return;
  }
  const holdHere = holdHereFor(quick, t, S, step, true);
  if (tr === 'no_response' && await responded(c, t, S, step)) {
    await fin('cancelled');
    if (holdHere) await c.query("update join_requests set approve_at = now() where id = $1 and status = 'pending' and approve_at is not null", [quick.id]);
    return;
  }
  if (t.sub_status === 'joinreq' && !quick) { await fin(tr === 'no_response' ? 'skipped' : 'waiting_start'); return; }
  const sent = await sendStep(c, t, S, step, P, quick, holdHere);
  await fin(sent ? 'sent' : 'skipped');
}

/** The run columns the tick reads (runs and timers join the same things). */
const RUN_COLS = `r.*, q.connection_id, q.workspace_id, q.active as seq_active, q.trigger_type, s.status as sub_status, s.tg_user_id, s.joined_at,
  w.plan_code, w.plan_status, w.trial_ends_at, w.created_at as ws_created_at, w.legacy_plan_code, w.legacy_ai_writes, w.legacy_until, w.dropped_at`;

/** Due runs (locked for this transaction). */
async function dueRuns(c, dripsOn, flowsOn, limit = 500, botsOn = flowsOn) {
  return (await c.query(`select ${RUN_COLS}
      from sequence_runs r join sequences q on q.id = r.sequence_id join subscribers s on s.id = r.subscriber_id join workspaces w on w.id = q.workspace_id
      where r.status = 'active' and r.due_at <= now() and (($1 and q.trigger_type not in ('join_request','bot_start')) or ($2 and q.trigger_type = 'join_request') or ($4 and q.trigger_type = 'bot_start'))
      order by r.due_at limit $3 for update of r skip locked`, [dripsOn, flowsOn, limit, botsOn])).rows;
}
/** Due timers and answers (locked for this transaction). */
async function dueTimers(c, dripsOn, flowsOn, limit = 500, botsOn = flowsOn) {
  return (await c.query(`select f.id as fsr_id, f.step_id, f.armed_active, ${RUN_COLS}
      from flow_step_runs f join sequence_runs r on r.id = f.run_id join sequences q on q.id = r.sequence_id join subscribers s on s.id = r.subscriber_id join workspaces w on w.id = q.workspace_id
      where f.status = 'scheduled' and f.due_at <= now() and (($1 and q.trigger_type not in ('join_request','bot_start')) or ($2 and q.trigger_type = 'join_request') or ($4 and q.trigger_type = 'bot_start'))
      order by f.due_at limit $3 for update of f skip locked`, [dripsOn, flowsOn, limit, botsOn])).rows;
}

/** Cancel this person's reminders that are answered now (they tapped Start, or a button of the message above). */
async function cancelAnswered(subId) {
  const rows = await db.many(`select f.id as fsr_id, f.step_id, f.armed_active, r.sequence_id, r.subscriber_id, s.status as sub_status
      from flow_step_runs f join sequence_runs r on r.id = f.run_id join subscribers s on s.id = r.subscriber_id join sequence_steps st on st.id = f.step_id
      where r.subscriber_id = $1 and f.status = 'scheduled' and st.trigger_type = 'no_response'`, [subId]);
  const cache = new Map();
  let n = 0;
  for (const t of rows) {
    if (!cache.has(String(t.sequence_id))) cache.set(String(t.sequence_id), await loadSeq(db, t.sequence_id));
    const S = cache.get(String(t.sequence_id));
    const step = S.byId.get(String(t.step_id));
    if (step && await responded(db, t, S, step)) {
      const r = await db.one("update flow_step_runs set status = 'cancelled', done_at = now() where id = $1 and status = 'scheduled' returning id", [t.fsr_id]);
      if (r) n++;
    }
  }
  return n;
}

/** They pressed Start: runs waiting for Start (or for a "when they tap Start" message) go now, waiting answers go out. */
async function onStarted(sub) {
  const woke = await db.many("update sequence_runs set status = 'active', due_at = greatest(due_at, now()) where subscriber_id = $1 and status = 'waiting' returning due_at", [sub.id]);
  const now = await db.many("update sequence_runs set status = 'active', due_at = now() where subscriber_id = $1 and status = 'awaiting' returning due_at", [sub.id]);
  const ans = await db.many("update flow_step_runs set status = 'scheduled', due_at = now() where status = 'waiting_start' and run_id in (select id from sequence_runs where subscriber_id = $1 and status <> 'stopped') returning due_at", [sub.id]);
  await cancelAnswered(sub.id);
  for (const w of [...woke, ...now, ...ans]) soon.at(w.due_at);
}

/**
 * A button was tapped (a Reply button's callback, or a tracked Link button opened). link: the links row.
 * Returns { ok, answered } (answered: how many answers this tap queued or woke).
 */
async function onTap(conn, sub, link) {
  if (!link || !link.step_id) return { ok: false, answered: 0 };
  const st = await db.one('select s.id, s.sequence_id, s.position, q.connection_id, q.workspace_id from sequence_steps s join sequences q on q.id = s.sequence_id where s.id = $1', [link.step_id]);
  if (!st || String(st.connection_id) !== String(conn.id) || String(st.workspace_id) !== String(conn.workspace_id)) return { ok: false, answered: 0 };
  const run = await db.one('select * from sequence_runs where sequence_id = $1 and subscriber_id = $2', [st.sequence_id, sub.id]);
  await cancelAnswered(sub.id);
  if (!run || run.status === 'stopped') return { ok: true, answered: 0 };
  const S = await loadSeq(db, st.sequence_id);
  let answered = 0;
  for (const a of S.steps) {
    if (S.trigger(a) !== 'on_button' || a.trigger_button !== link.button_id) continue;
    const g = (S.graph.get(a.position) || {}).group;
    if (!g || Number(g.owner) !== Number(st.position)) continue;
    const start = Math.min(...g.members), end = Math.max(...g.members);
    if (run.status !== 'done' && Number(run.next_position) <= end) {
      // The run has not passed this choice: when it points to it, it sees the tap (now, if it is there already).
      // ('waiting': they may be reachable now, inside the 5-minute window; if not, the run just goes back to waiting.)
      if (Number(run.next_position) >= start) await db.query("update sequence_runs set status = 'active', due_at = now() where id = $1 and status in ('awaiting','active','waiting')", [run.id]);
    } else {
      await db.query("insert into flow_step_runs(run_id, step_id, status, due_at) values ($1,$2,'scheduled', now()) on conflict (run_id, step_id) do nothing", [run.id, a.id]);
    }
    answered++;
  }
  if (answered) soon.at(Date.now());
  return { ok: true, answered };
}

/** Did this person reach the goal of the referral step above this reward? */
async function goalReached(c, r, S, step) {
  const ref = S.steps.filter((x) => x.step_type === 'referral' && x.position < step.position).pop();
  if (!ref) return true;
  const goal = Number((ref.config || {}).goal) || 3;
  const n = (await c.query('select count(*)::int n from bot_referrals where sequence_id = $1 and referrer_id = $2 and counted', [r.sequence_id, r.subscriber_id])).rows[0].n;
  return n >= goal;
}

/**
 * Move a run past the step at `pos` (a check they passed, a question they answered), only if it still points there.
 * The next step goes out on time (soon.at). Returns { moved, done }.
 */
async function advanceRun(runId, seqId, pos) {
  const S = await loadSeq(db, seqId);
  const next = S.after(pos);
  if (!next) {
    const r = await db.one("update sequence_runs set status = 'done', sent_position = null where id = $1 and next_position = $2 and status in ('awaiting','active') returning id", [runId, pos]);
    return { moved: !!r, done: true };
  }
  const r = await db.one(`update sequence_runs set next_position = $3, status = 'active', sent_position = null, due_at = now() + make_interval(secs => $4)
      where id = $1 and next_position = $2 and status in ('awaiting','active') returning due_at`, [runId, pos, next.position, dueFor(S, next)]);
  if (r) soon.at(r.due_at);
  return { moved: !!r, done: false };
}

module.exports = { goalReached, advanceRun, env, loadSeq, processRun, processTimer, dueRuns, dueTimers, onStarted, onTap, cancelAnswered, startFlowFor, responded };

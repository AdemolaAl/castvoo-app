'use strict';
/*
 * Repeating messages ("Repeat this message", services/repeats.js): list, preview the next times, create, edit,
 * pause, resume, stop and approve. Each run becomes a normal broadcast, so its report is the usual message report.
 */

const db = require('../db');
const billing = require('../services/billing');
const settings = require('../services/settings');
const B = require('../services/broadcasts');
const R = require('../services/repeats');
const { str, int, badRequest, notFound, forbidden } = require('../lib/util');

/** Roles whose messages wait for the owner (the same rule as one-off messages). */
const waitsForOwner = (ctx) => ctx.member.role === 'drafter' || (ctx.member.role === 'helper' && ctx.workspace.helper_send === false) || (ctx.workspace.require_approval && ctx.member.role !== 'owner');

async function getOwn(ctx) {
  const s = await db.one('select * from repeat_series where id = $1 and workspace_id = $2', [int(ctx.params.id, 'Repeating message'), ctx.workspace.id]);
  if (!s) throw notFound('That repeating message');
  return s;
}

/** Everything a create or edit form says, checked. */
async function cleanForm(ctx, b) {
  const ws = ctx.workspace;
  const conn = await db.one("select * from connections where id = $1 and workspace_id = $2 and status = 'active'", [int(b.connection_id, 'Where to send'), ws.id]);
  if (!conn) throw badRequest('Pick a connected bot, channel or group to send from.');
  let segmentId = null;
  if (b.segment_id) {
    if (conn.kind !== 'bot') throw badRequest('Audiences only work for bots. A channel or group post goes to everyone in it.');
    const s = await db.one('select id, rules from segments where id = $1 and workspace_id = $2', [Number(b.segment_id), ws.id]);
    if (!s) throw badRequest('That audience was not found.');
    if (!require('../services/segments').flowOnly(s.rules)) { await settings.requireFeature('segments'); await billing.requirePlanFeature(ws, 'audiences'); }
    segmentId = s.id;
  }
  const sched = R.cleanSchedule(b, R.todayIn(ws.timezone));
  const versions = await R.cleanVersions(ws.id, b.versions);
  if (versions.some((v) => v.media_id)) await settings.requireFeature('media');
  const extras = await B.checkExtras(conn, b);
  const title = str(b.title, 'Name', { max: 60, required: false }) || B.titleFrom(versions[0].body, versions[0].media_kind);
  const next = R.nextRun(sched, ws.timezone, Date.now());
  if (next == null) throw badRequest('With this end date there is no time left to send it. Pick a later end date.');
  return { conn, segmentId, sched, versions, extras, title, include_stop: conn.kind === 'bot' ? b.include_stop !== false : false, next };
}

async function saveVersions(c, seriesId, versions) {
  await c.query('delete from repeat_versions where series_id = $1', [seriesId]);
  for (const [i, v] of versions.entries()) {
    await c.query('insert into repeat_versions(series_id, position, body, media_id, buttons) values ($1,$2,$3,$4,$5)', [seriesId, i, v.body, v.media_id, JSON.stringify(v.buttons)]);
  }
}

module.exports = (r) => {
  r.get('/api/repeats', async (ctx) => R.list(ctx.workspace), { auth: 'workspace' });

  r.get('/api/repeats/:id', async (ctx) => {
    const s = await getOwn(ctx);
    return { series: await R.view(s, ctx.workspace) };
  }, { auth: 'workspace' });

  /** The next few times a schedule would send (before saving), in the workspace time zone. */
  r.post('/api/repeats/preview', async (ctx) => {
    const ws = ctx.workspace;
    const sched = R.cleanSchedule(ctx.body, R.todayIn(ws.timezone));
    const times = R.upcoming({ ...sched, runs: 0 }, ws.timezone, Date.now(), Date.now() + 400 * 86400000, 5);
    return { schedule: R.describe(sched), timezone: R.safeZone(ws.timezone), next: times.map((t) => ({ at: new Date(t).toISOString(), label: R.label(t, ws.timezone) })) };
  }, { auth: 'workspace' });

  r.post('/api/repeats', async (ctx) => {
    await settings.requireFeature('broadcasts');
    await settings.requireFeature('repeats');
    const ws = ctx.workspace;
    await R.assertSlot(ws);
    const f = await cleanForm(ctx, ctx.body);
    const pending = waitsForOwner(ctx);
    if (!pending) await billing.assertCanSend(ws);
    const id = await db.tx(async (c) => {
      const s = (await c.query(`insert into repeat_series(workspace_id, connection_id, segment_id, title, include_stop, freq, days, time_of_day, end_mode, end_date, end_count, rotation,
          next_version, status, next_run_at, delete_after_hours, pin, pin_notify, unpin_after_hours, created_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) returning id`,
      [ws.id, f.conn.id, f.segmentId, f.title, f.include_stop, f.sched.freq, f.sched.days, f.sched.time_of_day, f.sched.end_mode, f.sched.end_date, f.sched.end_count, f.sched.rotation,
        R.firstVersion(f.sched.rotation, f.versions.length), pending ? 'pending_approval' : 'active', pending ? null : new Date(f.next),
        f.extras.delete_after_hours, f.extras.pin, f.extras.pin_notify, f.extras.unpin_after_hours, ctx.user.id])).rows[0];
      await saveVersions(c, s.id, f.versions);
      return s.id;
    });
    const s = await db.one('select * from repeat_series where id = $1', [id]);
    return { ok: true, id, status: s.status, next_label: pending ? null : R.label(f.next, ws.timezone), series: await R.view(s, ws, { history: false }) };
  }, { auth: 'workspace', rate: [30, 600] });

  /** Change the schedule, the versions or the options. The next time is worked out again from now (no catch-up). */
  r.post('/api/repeats/:id/edit', async (ctx) => {
    await settings.requireFeature('repeats');
    const s = await getOwn(ctx);
    if (['stopped', 'ended'].includes(s.status)) throw badRequest('This repeating message has finished. Make a new one instead.');
    const ws = ctx.workspace;
    const f = await cleanForm(ctx, ctx.body);
    const pending = waitsForOwner(ctx);
    // A teammate whose messages wait for the owner sends the change for approval (it stops until then).
    const status = pending ? 'pending_approval' : s.status;
    // A paused one sent for approval counts toward the plan again (waiting ones do), so it needs a free slot.
    if (status === 'pending_approval' && s.status === 'paused') await R.assertSlot(ws, s.id);
    // Moved to a later time today after today's message went out: it starts the next day it repeats (said gently).
    const fresh = await R.nextFresh({ ...f.sched, id: s.id }, ws.timezone);
    if (fresh.next == null) throw badRequest('With this end date there is no time left to send it. Pick a later end date.');
    f.next = fresh.next;
    const n = f.versions.length;
    const changedRotation = f.sched.rotation !== s.rotation;
    const nextVersion = changedRotation ? R.firstVersion(f.sched.rotation, n) : Math.min(s.next_version, n - 1);
    await db.tx(async (c) => {
      await c.query(`update repeat_series set connection_id = $2, segment_id = $3, title = $4, include_stop = $5, freq = $6, days = $7, time_of_day = $8, end_mode = $9, end_date = $10,
          end_count = $11, rotation = $12, next_version = $13, used_versions = '{}', status = $14, next_run_at = $15, delete_after_hours = $16, pin = $17, pin_notify = $18,
          unpin_after_hours = $19, last_error = null, updated_at = now() where id = $1`,
      [s.id, f.conn.id, f.segmentId, f.title, f.include_stop, f.sched.freq, f.sched.days, f.sched.time_of_day, f.sched.end_mode, f.sched.end_date, f.sched.end_count, f.sched.rotation,
        nextVersion, status, status === 'active' ? new Date(f.next) : null, f.extras.delete_after_hours, f.extras.pin, f.extras.pin_notify, f.extras.unpin_after_hours]);
      await saveVersions(c, s.id, f.versions);
      // "After N sends" already reached with the new number: it is done.
      if (f.sched.end_mode === 'count' && s.runs >= f.sched.end_count) await c.query("update repeat_series set status = 'ended', next_run_at = null where id = $1", [s.id]);
    });
    const now = await db.one('select * from repeat_series where id = $1', [s.id]);
    return { ok: true, status: now.status, note: fresh.note, series: await R.view(now, ws, { history: false }) };
  }, { auth: 'workspace', rate: [60, 600] });

  r.post('/api/repeats/:id/pause', async (ctx) => {
    const s = await getOwn(ctx);
    if (s.status !== 'active') throw badRequest('Only a running repeating message can be paused.');
    await db.query("update repeat_series set status = 'paused', next_run_at = null, updated_at = now() where id = $1", [s.id]);
    return { ok: true, status: 'paused' };
  }, { auth: 'workspace' });

  /** Resume: it carries on at the next upcoming time. Runs missed while paused are not sent. */
  r.post('/api/repeats/:id/resume', async (ctx) => {
    const s = await getOwn(ctx);
    if (s.status !== 'paused') throw badRequest('Only a paused repeating message can be resumed.');
    if (waitsForOwner(ctx)) throw forbidden('Ask the owner to resume it.');
    await R.assertSlot(ctx.workspace, s.id);
    await billing.assertCanSend(ctx.workspace);
    const { next, note } = await R.nextFresh(s, ctx.workspace.timezone);
    if (next == null) { await db.query("update repeat_series set status = 'ended', updated_at = now() where id = $1", [s.id]); return { ok: true, status: 'ended', note }; }
    await db.query("update repeat_series set status = 'active', next_run_at = $2, last_error = null, updated_at = now() where id = $1", [s.id, new Date(next)]);
    return { ok: true, status: 'active', next_label: R.label(next, ctx.workspace.timezone), note };
  }, { auth: 'workspace' });

  /** Stop for good (its sent messages and reports stay). A run already made and waiting to go out is cancelled too. */
  r.post('/api/repeats/:id/stop', async (ctx) => {
    const s = await getOwn(ctx);
    if (['stopped', 'ended'].includes(s.status)) throw badRequest('This repeating message has already finished.');
    await db.tx(async (c) => {
      await c.query("update repeat_series set status = 'stopped', next_run_at = null, updated_at = now() where id = $1", [s.id]);
      await c.query("update broadcasts set status = 'cancelled', finished_at = now() where series_id = $1 and status = 'scheduled'", [s.id]);
    });
    return { ok: true, status: 'stopped' };
  }, { auth: 'workspace' });

  r.post('/api/repeats/:id/approve', async (ctx) => {
    if (ctx.member.role !== 'owner') throw forbidden('Only the owner can approve messages.');
    const s = await getOwn(ctx);
    if (s.status !== 'pending_approval') throw badRequest('This repeating message is not waiting for approval.');
    // The plan's limit is checked again (it may have changed since it was sent for approval, e.g. a smaller plan).
    await R.assertSlot(ctx.workspace, s.id);
    await billing.assertCanSend(ctx.workspace);
    const { next, note } = await R.nextFresh(s, ctx.workspace.timezone);
    if (next == null) { await db.query("update repeat_series set status = 'ended', updated_at = now() where id = $1", [s.id]); return { ok: true, status: 'ended', note }; }
    await db.query("update repeat_series set status = 'active', next_run_at = $2, updated_at = now() where id = $1", [s.id, new Date(next)]);
    return { ok: true, status: 'active', next_label: R.label(next, ctx.workspace.timezone), note };
  }, { auth: 'workspace' });
};

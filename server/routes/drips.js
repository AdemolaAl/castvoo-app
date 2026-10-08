'use strict';
/* Auto follow-ups (sequences): list, create, edit, switch on/off, delete. */

const db = require('../db');
const settings = require('../services/settings');
const tg = require('../services/telegram');
const B = require('../services/broadcasts');
const { tokenOf } = require('../services/connections');
const billing = require('../services/billing');
const flows = require('../services/flows');
const { str, int, oneOf, badRequest, notFound, httpError } = require('../lib/util');

const UNIT = { min: 1, hour: 60, day: 1440 };

async function cleanSteps(wsId, steps) {
  if (!Array.isArray(steps) || !steps.length) throw badRequest('Add at least one message.');
  if (steps.length > 20) throw badRequest('Use 20 messages or fewer in one follow-up.');
  const out = [];
  for (const [i, s] of steps.entries()) {
    const unit = oneOf(s.delay_unit || 'min', 'Wait unit', Object.keys(UNIT));
    const value = int(s.delay_value ?? 0, `Wait for message ${i + 1}`, { min: 0, max: unit === 'day' ? 365 : unit === 'hour' ? 8760 : 525600 });
    const msg = await B.checkMessage(wsId, s);
    out.push({ ...msg, delay_minutes: value * UNIT[unit] });
  }
  return out;
}

/**
 * ENG-5: a join-request sequence made or edited here IS a Welcome Flow, so it goes through the same checks as
 * /api/flows (plan flows and steps, the Free plan's 3 buttons / photo / branding length, live-clash, A/B kept).
 * The old body (steps with delay_value / delay_unit) is turned into Welcome Flow blocks.
 */
function flowBodyFrom(conn, b, chatId) {
  const blocks = [];
  for (const [i, st] of (Array.isArray(b.steps) ? b.steps : []).entries()) {
    const v = Number(st.delay_value || 0);
    if (i > 0 && v > 0) blocks.push({ type: 'wait', value: v, unit: st.delay_unit || 'min' });
    blocks.push({ type: 'message', body: st.body, media_id: st.media_id, buttons: st.buttons || [] });
  }
  return { name: b.name, chat_id: chatId, bot_id: conn.id, approve_mode: b.approve_join !== false ? 'after_welcome' : 'manual', blocks };
}

async function list(wsId) {
  const seqs = await db.many(`select q.*, c.username as bot, c.title as bot_title,
      (select count(*)::int from sequence_runs r where r.sequence_id = q.id) as people,
      (select count(*)::int from sequence_runs r where r.sequence_id = q.id and r.status = 'active') as in_progress
    from sequences q join connections c on c.id = q.connection_id where q.workspace_id = $1 and c.status <> 'removed' order by q.id`, [wsId]);
  for (const q of seqs) {
    q.steps = await db.many(`select s.id, s.position, s.delay_minutes, s.body, s.media_id,
        (select coalesce(json_agg(json_build_object('label', l.label, 'url', l.url, 'code', l.code) order by l.position, l.created_at, l.code), '[]') from links l where l.step_id = s.id) as buttons,
        (select count(*)::int from deliveries d where d.step_id = s.id and d.status = 'sent') as sent,
        (select count(*)::int from clicks k join links l on l.code = k.code where l.step_id = s.id) as clicks
      from sequence_steps s where s.sequence_id = $1 and s.variant = 0 order by s.position`, [q.id]);
    q.join_chat = null;
    if (q.trigger_type === 'join_request') q.join_chat = await db.one("select id, title, kind from connections where workspace_id = $1 and tg_chat_id::text = $2 and kind <> 'bot' and status <> 'removed'", [wsId, q.trigger_value || '']);
  }
  return seqs;
}

async function checkTrigger(ws, conn, b) {
  const type = oneOf(b.trigger_type, 'Trigger', ['start', 'start_tag', 'join_request', 'tag']);
  let value = null;
  if (type === 'start_tag' || type === 'tag') {
    value = str(b.trigger_value, type === 'tag' ? 'Tag' : 'Start link name', { min: 1, max: 64 });
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw badRequest('Use only letters, numbers, _ and -.');
    // Tags are always saved in lowercase (see routes/subscribers.js), so the trigger must be too.
    if (type === 'tag') value = value.toLowerCase();
  }
  if (type === 'join_request') {
    await settings.requireFeature('join_welcome');
    const chat = await db.one("select * from connections where id = $1 and workspace_id = $2 and kind <> 'bot' and status <> 'removed'", [int(b.join_connection_id, 'Channel or group'), ws.id]);
    if (!chat) throw badRequest('Pick the channel or group that uses join requests.');
    try {
      const me = await tg.call(tokenOf(conn), 'getChatMember', { chat_id: chat.tg_chat_id, user_id: conn.tg_chat_id });
      if (me.status !== 'administrator' || me.can_invite_users === false) throw new Error('not admin');
    } catch {
      throw httpError(409, `Make @${conn.username} an admin of "${chat.title}" with the "Add members" (invite users) right, then try again. Telegram only sends join requests to admins who can let people in.`, 'bot_not_admin');
    }
    value = String(chat.tg_chat_id);
  }
  return { type, value };
}

module.exports = (r) => {
  r.get('/api/drips', async (ctx) => ({ sequences: await list(ctx.workspace.id) }), { auth: 'workspace' });

  r.post('/api/drips', async (ctx) => {
    await settings.requireFeature('drips');
    const ws = ctx.workspace, b = ctx.body;
    if (ctx.member.role === 'drafter') throw httpError(403, 'Ask the owner to create follow-ups.', 'forbidden');
    const conn = await db.one("select * from connections where id = $1 and workspace_id = $2 and kind = 'bot' and status = 'active'", [int(b.connection_id, 'Bot'), ws.id]);
    if (!conn) throw badRequest('Follow-ups are sent by a bot. Connect a bot first.');
    const name = str(b.name, 'Name', { min: 1, max: 60 });
    const trig = await checkTrigger(ws, conn, b);
    // Join-request follow-ups are Welcome Flows now (routes/flows.js); this older path still works for them, with the
    // same plan rules (ENG-5).
    if (trig.type === 'join_request') {
      const f = await flows.cleanFlow(ws, flowBodyFrom(conn, b, int(b.join_connection_id, 'Channel or group')));
      const live = b.active !== false;
      const l = await billing.limits(ws);
      if (l.flows !== billing.UNLIMITED && (await billing.usage(ws.id)).flows >= l.flows) throw httpError(402, `Your ${l.plan.name} plan includes ${l.flows} Welcome Flow${l.flows === 1 ? '' : 's'}. Edit the one you have in Welcome Flows, or upgrade.`, 'limit_flows', { limit: l.flows });
      if (live) {
        flows.assertNoPlaceholders(f.steps);
        const clash = await flows.liveClash(f.chat, null, 0);
        if (clash) throw httpError(409, 'A Welcome Flow is already live on that channel or group. Switch it off first, or edit it in Welcome Flows.', 'flow_live_clash');
        await flows.assertCanGoLive(ws, 0, 0);
      }
      const id = await db.tx(async (c) => {
        const q = (await c.query(`insert into sequences(workspace_id, connection_id, name, trigger_type, trigger_value, approve_join, approve_mode, active)
          values ($1,$2,$3,'join_request',$4,$5,$6,$7) returning id`, [ws.id, conn.id, f.name, String(f.chat.tg_chat_id), f.approve_mode !== 'manual', f.approve_mode, live])).rows[0].id;
        await flows.saveSteps(c, ws.id, q, f.steps);
        return q;
      }).catch((e) => { if (e.code === '23505') throw httpError(409, 'A Welcome Flow is already live on that channel or group. Switch it off first, or edit it in Welcome Flows.', 'flow_live_clash'); throw e; });
      return { ok: true, id };
    }
    await billing.requirePlanFeature(ws, 'drips');
    const steps = await cleanSteps(ws.id, b.steps);
    const id = await db.tx(async (c) => {
      const q = (await c.query(`insert into sequences(workspace_id, connection_id, name, trigger_type, trigger_value, approve_join, approve_mode, active)
        values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`, [ws.id, conn.id, name, trig.type, trig.value, b.approve_join !== false, b.approve_join !== false ? 'after_welcome' : 'manual', b.active !== false])).rows[0].id;
      for (const [i, s] of steps.entries()) {
        const st = (await c.query('insert into sequence_steps(sequence_id, position, delay_minutes, body, media_id) values ($1,$2,$3,$4,$5) returning id', [q, i + 1, s.delay_minutes, s.body, s.media_id])).rows[0];
        await B.makeLinks(c, ws.id, s.buttons, { stepId: st.id });
      }
      return q;
    }).catch((e) => { if (e.code === '23505') throw httpError(409, 'A Welcome Flow is already live on that channel or group. Switch it off first, or edit it in Welcome Flows.', 'flow_live_clash'); throw e; });
    return { ok: true, id };
  }, { auth: 'workspace' });

  r.put('/api/drips/:id', async (ctx) => {
    const ws = ctx.workspace, b = ctx.body;
    if (ctx.member.role === 'drafter') throw httpError(403, 'Ask the owner to edit follow-ups.', 'forbidden');
    const q = await db.one('select * from sequences where id = $1 and workspace_id = $2', [int(ctx.params.id, 'Follow-up'), ws.id]);
    if (!q) throw notFound('That follow-up');
    const conn = await db.one('select * from connections where id = $1', [q.connection_id]);
    const name = str(b.name, 'Name', { min: 1, max: 60 });
    const trig = await checkTrigger(ws, conn, b);
    if (q.trigger_type === 'join_request' || trig.type === 'join_request') {
      // ENG-5: a Welcome Flow. A/B versions and side-by-side buttons only exist in the Welcome Flows builder: this old
      // form can't show them, so saving here would lose them. Those flows are edited in Welcome Flows only.
      if (q.trigger_type !== trig.type) throw badRequest('Welcome Flows and follow-ups are different things now. Make a new one instead.');
      const fancy = await db.one(`select 1 from sequence_steps s where s.sequence_id = $1 and (s.variant > 0 or s.condition is not null
          or exists (select 1 from links l where l.step_id = s.id and l.row is not null)) limit 1`, [q.id]);
      if (fancy || q.start_button || q.invite_link || q.approve_mode === 'tap') throw httpError(409, 'This flow uses Welcome Flows features (A/B versions, conditions, buttons side by side, Tap to start or an invite link). Edit it in Welcome Flows.', 'edit_in_flows');
      const f = await flows.cleanFlow(ws, flowBodyFrom(conn, b, int(b.join_connection_id, 'Channel or group')));
      if (q.active) {
        flows.assertNoPlaceholders(f.steps);
        const clash = await flows.liveClash(f.chat, null, q.id);
        if (clash) throw httpError(409, 'A Welcome Flow is already live on that channel or group. Switch it off first.', 'flow_live_clash');
      }
      await db.tx(async (c) => {
        await c.query(`update sequences set name = $2, trigger_value = $3, approve_join = $4, approve_mode = $5, updated_at = now() where id = $1`,
          [q.id, f.name, String(f.chat.tg_chat_id), f.approve_mode !== 'manual', f.approve_mode]);
        // Step rows are kept by position, so stats and the people part-way through stay.
        const old = (await c.query('select id, position from sequence_steps where sequence_id = $1 and variant = 0 order by position', [q.id])).rows;
        await flows.saveSteps(c, ws.id, q.id, f.steps.map((st) => ({ ...st, id: (old.find((o) => o.position === st.position) || {}).id || null })));
      }).catch((e) => { if (e.code === '23505') throw httpError(409, 'A Welcome Flow is already live on that channel or group. Switch it off first.', 'flow_live_clash'); throw e; });
      return { ok: true };
    }
    const steps = await cleanSteps(ws.id, b.steps);
    await db.tx(async (c) => {
      await c.query(`update sequences set name = $2, trigger_type = $3, trigger_value = $4, approve_join = $5,
        approve_mode = case when $3 = 'join_request' then (case when $5 then (case when approve_mode = 'manual' then 'after_welcome' else approve_mode end) else 'manual' end) else approve_mode end where id = $1`,
      [q.id, name, trig.type, trig.value, b.approve_join !== false]);
      // Keep step rows that still exist (so stats and running people stay), replace their content.
      const old = (await c.query('select id, position from sequence_steps where sequence_id = $1 and variant = 0 order by position', [q.id])).rows;
      for (const [i, s] of steps.entries()) {
        const pos = i + 1;
        const existing = old.find((o) => o.position === pos);
        let stepId;
        if (existing) {
          stepId = existing.id;
          await c.query('update sequence_steps set delay_minutes = $2, body = $3, media_id = $4 where id = $1', [stepId, s.delay_minutes, s.body, s.media_id]);
          // Keep each button's short link (people may already have it in Telegram): change its text and
          // address in place, add new ones, and unhook extra ones (they keep redirecting, clicks are kept).
          const had = (await c.query('select code from links where step_id = $1 order by position, created_at, code', [stepId])).rows;
          for (const [bi, btn] of s.buttons.entries()) {
            if (had[bi]) await c.query('update links set label = $2, url = $3, position = $4 where code = $1', [had[bi].code, btn.label, btn.url, bi]);
          }
          if (s.buttons.length > had.length) await B.makeLinks(c, ws.id, s.buttons.slice(had.length).map((btn, j) => ({ ...btn, position: had.length + j })), { stepId });
          for (const extra of had.slice(s.buttons.length)) await c.query('update links set step_id = null where code = $1', [extra.code]);
          continue;
        } else {
          stepId = (await c.query('insert into sequence_steps(sequence_id, position, delay_minutes, body, media_id) values ($1,$2,$3,$4,$5) returning id', [q.id, pos, s.delay_minutes, s.body, s.media_id])).rows[0].id;
        }
        await B.makeLinks(c, ws.id, s.buttons, { stepId });
      }
      await c.query('update links set step_id = null where step_id in (select id from sequence_steps where sequence_id = $1 and (position > $2 or variant > 0))', [q.id, steps.length]);
      await c.query('delete from sequence_steps where sequence_id = $1 and variant > 0', [q.id]);
      await c.query('delete from sequence_steps where sequence_id = $1 and position > $2', [q.id, steps.length]);
      await c.query("update sequence_runs set status = 'done' where sequence_id = $1 and status in ('active','waiting') and next_position > $2", [q.id, steps.length]);
    }).catch((e) => { if (e.code === '23505') throw httpError(409, 'A Welcome Flow is already live on that channel or group. Switch it off first.', 'flow_live_clash'); throw e; });
    return { ok: true };
  }, { auth: 'workspace' });

  r.post('/api/drips/:id/toggle', async (ctx) => {
    if (ctx.member.role === 'drafter') throw httpError(403, 'Ask the owner to switch follow-ups on or off.', 'forbidden');
    const id = int(ctx.params.id, 'Follow-up');
    const cur = await db.one('select * from sequences where id = $1 and workspace_id = $2', [id, ctx.workspace.id]);
    if (!cur) throw notFound('That follow-up');
    if (ctx.body.active && cur.trigger_type !== 'join_request') await billing.requirePlanFeature(ctx.workspace, 'drips');
    if (ctx.body.active && cur.trigger_type === 'join_request' && !cur.active) {
      // ENG-5: switching a Welcome Flow on here has the same checks as Welcome Flows → toggle.
      const ws = ctx.workspace;
      const chat = await db.one("select * from connections where workspace_id = $1 and kind <> 'bot' and status <> 'removed' and tg_chat_id::text = $2", [ws.id, cur.trigger_value || '']);
      if (!chat) throw badRequest('This flow\'s channel or group is not connected any more.');
      const steps = await flows.loadSteps(cur.id);
      const f = await flows.cleanFlow(ws, { name: cur.name, chat_id: chat.id, bot_id: cur.connection_id, approve_mode: cur.approve_mode, start_button: cur.start_button, start_label: cur.start_label, invite_link: cur.invite_link, blocks: flows.stepsToBlocks(steps) });
      flows.assertNoPlaceholders(f.steps);
      const clash = await flows.liveClash(chat, cur.invite_link, cur.id);
      if (clash) throw httpError(409, `"${clash.name}" is already live on ${chat.title}. Switch it off first.`, 'flow_live_clash');
      await flows.assertCanGoLive(ws, cur.id, 0);
    }
    const row = await db.one('update sequences set active = $3, paused_by_plan = false where id = $1 and workspace_id = $2 returning active', [id, ctx.workspace.id, !!ctx.body.active])
      .catch((e) => { if (e.code === '23505') throw httpError(409, 'A Welcome Flow is already live on that channel or group. Switch it off first.', 'flow_live_clash'); throw e; });
    if (!row) throw notFound('That follow-up');
    return { ok: true, active: row.active };
  }, { auth: 'workspace' });

  r.delete('/api/drips/:id', async (ctx) => {
    if (ctx.member.role === 'drafter') throw httpError(403, 'Ask the owner to delete follow-ups.', 'forbidden');
    const id = int(ctx.params.id, 'Follow-up');
    const row = await db.tx(async (c) => {
      // Links already sent in Telegram keep working after the follow-up is deleted.
      await c.query('update links set step_id = null where step_id in (select s.id from sequence_steps s join sequences q on q.id = s.sequence_id where q.id = $1 and q.workspace_id = $2)', [id, ctx.workspace.id]);
      return (await c.query('delete from sequences where id = $1 and workspace_id = $2 returning id', [id, ctx.workspace.id])).rows[0];
    });
    if (!row) throw notFound('That follow-up');
    return { ok: true };
  }, { auth: 'workspace' });
};

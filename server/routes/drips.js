'use strict';
/* Auto follow-ups (sequences): list, create, edit, switch on/off, delete. */

const db = require('../db');
const settings = require('../services/settings');
const tg = require('../services/telegram');
const B = require('../services/broadcasts');
const { tokenOf } = require('../services/connections');
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
      from sequence_steps s where s.sequence_id = $1 order by s.position`, [q.id]);
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
    const steps = await cleanSteps(ws.id, b.steps);
    const id = await db.tx(async (c) => {
      const q = (await c.query(`insert into sequences(workspace_id, connection_id, name, trigger_type, trigger_value, approve_join, active)
        values ($1,$2,$3,$4,$5,$6,$7) returning id`, [ws.id, conn.id, name, trig.type, trig.value, b.approve_join !== false, b.active !== false])).rows[0].id;
      for (const [i, s] of steps.entries()) {
        const st = (await c.query('insert into sequence_steps(sequence_id, position, delay_minutes, body, media_id) values ($1,$2,$3,$4,$5) returning id', [q, i + 1, s.delay_minutes, s.body, s.media_id])).rows[0];
        await B.makeLinks(c, ws.id, s.buttons, { stepId: st.id });
      }
      return q;
    });
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
    const steps = await cleanSteps(ws.id, b.steps);
    await db.tx(async (c) => {
      await c.query('update sequences set name = $2, trigger_type = $3, trigger_value = $4, approve_join = $5 where id = $1', [q.id, name, trig.type, trig.value, b.approve_join !== false]);
      // Keep step rows that still exist (so stats and running people stay), replace their content.
      const old = (await c.query('select id, position from sequence_steps where sequence_id = $1 order by position', [q.id])).rows;
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
      await c.query('update links set step_id = null where step_id in (select id from sequence_steps where sequence_id = $1 and position > $2)', [q.id, steps.length]);
      await c.query('delete from sequence_steps where sequence_id = $1 and position > $2', [q.id, steps.length]);
      await c.query("update sequence_runs set status = 'done' where sequence_id = $1 and status = 'active' and next_position > $2", [q.id, steps.length]);
    });
    return { ok: true };
  }, { auth: 'workspace' });

  r.post('/api/drips/:id/toggle', async (ctx) => {
    if (ctx.member.role === 'drafter') throw httpError(403, 'Ask the owner to switch follow-ups on or off.', 'forbidden');
    const row = await db.one('update sequences set active = $3 where id = $1 and workspace_id = $2 returning active', [int(ctx.params.id, 'Follow-up'), ctx.workspace.id, !!ctx.body.active]);
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

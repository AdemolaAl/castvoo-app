'use strict';
/* Sending messages: create, schedule, approve, cancel, edit, pin, delete, test, report. */

const db = require('../db');
const config = require('../config');
const billing = require('../services/billing');
const settings = require('../services/settings');
const B = require('../services/broadcasts');
const send = require('../services/send');
const { tokenOf, senderKey } = require('../services/connections');
const { count: segmentCount } = require('./segments');
const { str, int, oneOf, badRequest, notFound, forbidden, httpError } = require('../lib/util');

const PER_SECOND = () => config.telegram.sendPerSecond;
/** The owner switched the setup helper's "Can send broadcasts" off: the helper writes and schedules, the owner sends. */
const noHelperSend = (ctx) => ctx.member.role === 'helper' && ctx.workspace.helper_send === false;

async function getOwn(ctx) {
  const b = await db.one('select * from broadcasts where id = $1 and workspace_id = $2', [int(ctx.params.id, 'Broadcast'), ctx.workspace.id]);
  if (!b) throw notFound('That message');
  return b;
}

async function audienceFor(wsId, conn, segmentId) {
  if (conn.kind !== 'bot') return conn.member_count;
  const segRow = segmentId ? await db.one('select rules from segments where id = $1 and workspace_id = $2', [segmentId, wsId]) : null;
  return segmentCount(wsId, segRow ? segRow.rules : [], conn.id);
}

module.exports = (r) => {
  r.get('/api/broadcasts', async (ctx) => {
    const rows = await db.many(`select b.id, b.title, b.body, b.status, b.send_mode, b.send_at, b.total, b.sent, b.failed, b.created_at, b.started_at, b.finished_at,
        b.media_id, b.buttons, b.include_stop, b.segment_id, b.connection_id, c.kind, c.title as conn_title, c.username as conn_username, s.name as segment_name,
        (select count(*)::int from clicks k join links l on l.code = k.code where l.broadcast_id = b.id) as clicks,
        (select count(distinct k.subscriber_id)::int from clicks k join links l on l.code = k.code where l.broadcast_id = b.id) as clickers,
        -- "9am local time" broadcasts have no send_at: their deliveries are queued for each time zone's 9am. The calendar uses these.
        case when b.send_mode = 'local9' then (select min(d.due_at) from deliveries d where d.broadcast_id = b.id and d.action = 'send') end as first_due,
        case when b.send_mode = 'local9' and b.status = 'sending' then (select min(d.due_at) from deliveries d where d.broadcast_id = b.id and d.action = 'send' and d.status = 'queued') end as next_due
      from broadcasts b join connections c on c.id = b.connection_id left join segments s on s.id = b.segment_id
      where b.workspace_id = $1 order by b.id desc limit 100`, [ctx.workspace.id]);
    return { broadcasts: rows };
  }, { auth: 'workspace' });

  /** Every tracked link with its clicks (Clicks page). */
  r.get('/api/links', async (ctx) => {
    const links = await db.many(`select l.code, l.label, l.url, l.created_at, l.broadcast_id, l.step_id,
        coalesce(b.title, q.name, 'Removed button') as source_title, case when l.broadcast_id is not null then 'broadcast' else 'follow-up' end as source_kind,
        (select count(*)::int from clicks k where k.code = l.code) as clicks,
        (select count(distinct k.subscriber_id)::int from clicks k where k.code = l.code and k.subscriber_id is not null) as people
      from links l left join broadcasts b on b.id = l.broadcast_id left join sequence_steps s on s.id = l.step_id left join sequences q on q.id = s.sequence_id
      where l.workspace_id = $1 order by l.created_at desc limit 200`, [ctx.workspace.id]);
    const daily = await db.many(`select to_char(d, 'YYYY-MM-DD') as day, (select count(*)::int from clicks k where k.workspace_id = $1 and k.created_at >= d and k.created_at < d + interval '1 day') n
      from generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') d order by d`, [ctx.workspace.id]);
    const people = await db.many(`select s.first_name, s.username, l.label, k.created_at from clicks k join links l on l.code = k.code join subscribers s on s.id = k.subscriber_id
      where k.workspace_id = $1 order by k.id desc limit 30`, [ctx.workspace.id]);
    return { links: links.map((l) => ({ ...l, short: `${config.appUrl.replace(/^https?:\/\//, '')}/l/${l.code}` })), daily, recent: people };
  }, { auth: 'workspace' });

  r.get('/api/broadcasts/estimate', async (ctx) => {
    const conn = await db.one("select * from connections where id = $1 and workspace_id = $2 and status = 'active'", [Number(ctx.query.connection_id), ctx.workspace.id]);
    if (!conn) throw notFound('That connection');
    const n = await audienceFor(ctx.workspace.id, conn, ctx.query.segment_id ? Number(ctx.query.segment_id) : null);
    return { audience: n, seconds: conn.kind === 'bot' ? Math.ceil(n / PER_SECOND()) : 1, kind: conn.kind };
  }, { auth: 'workspace' });

  r.get('/api/broadcasts/:id', async (ctx) => {
    const b = await getOwn(ctx);
    const links = await db.many('select l.code, l.label, l.url, (select count(*)::int from clicks k where k.code = l.code) as clicks from links l where l.broadcast_id = $1 order by l.position, l.created_at', [b.id]);
    const errors = await db.many("select error, count(*)::int n from deliveries where broadcast_id = $1 and status in ('failed','blocked') group by 1 order by 2 desc limit 5", [b.id]);
    const queued = await db.one("select count(*)::int n, min(due_at) as next from deliveries where broadcast_id = $1 and status = 'queued' and action = 'send'", [b.id]);
    return { broadcast: b, links, errors, queued: queued.n, next_due: queued.next };
  }, { auth: 'workspace' });

  r.post('/api/broadcasts', async (ctx) => {
    await settings.requireFeature('broadcasts');
    const ws = ctx.workspace;
    const b = ctx.body;
    // An ended trial says so first (it is about to become Free, which has no broadcasts).
    if (ws.plan_status === 'trial' && new Date(ws.trial_ends_at) < new Date() && !b.draft) await billing.assertCanSend(ws);
    await billing.requirePlanFeature(ws, 'broadcasts');
    const conn = await db.one("select * from connections where id = $1 and workspace_id = $2 and status = 'active'", [int(b.connection_id, 'Where to send'), ws.id]);
    if (!conn) throw badRequest('Pick a connected bot, channel or group to send from.');
    const msg = await B.checkMessage(ws.id, b);
    if (msg.media_id) await settings.requireFeature('media');
    let segmentId = null;
    if (b.segment_id) {
      if (conn.kind !== 'bot') throw badRequest('Audiences only work for bots. A channel or group post goes to everyone in it.');
      await settings.requireFeature('segments');
      await billing.requirePlanFeature(ws, 'audiences');
      const s = await db.one('select id from segments where id = $1 and workspace_id = $2', [Number(b.segment_id), ws.id]);
      if (!s) throw badRequest('That audience was not found.');
      segmentId = s.id;
    }
    const mode = oneOf(b.send_mode || 'now', 'When', ['now', 'at', 'local9']);
    if (mode === 'local9') {
      await settings.requireFeature('local_time');
      if (conn.kind !== 'bot') throw badRequest('Local-time sending works for bots. For a channel, pick a time instead.');
    }
    if (mode !== 'now') await billing.requirePlanFeature(ws, 'schedule');
    let sendAt = null;
    if (mode === 'at') {
      sendAt = new Date(b.send_at);
      if (Number.isNaN(sendAt.getTime())) throw badRequest('Pick a date and time to send.');
      if (sendAt.getTime() < Date.now() - 60000) throw badRequest('That time has already passed.');
      if (sendAt.getTime() > Date.now() + 90 * 86400000) throw badRequest('You can schedule up to 90 days ahead.');
    }
    const asDraft = !!b.draft;
    let status = asDraft ? 'draft' : (mode === 'at' ? 'scheduled' : 'sending');
    // The setup helper sends like a teammate, unless the owner switched "Can send broadcasts" off: then the owner approves.
    const helperWaits = ctx.member.role === 'helper' && ws.helper_send === false;
    if (!asDraft && (ctx.member.role === 'drafter' || helperWaits || (ws.require_approval && ctx.member.role !== 'owner'))) status = 'pending_approval';
    if (!asDraft && status !== 'pending_approval') await billing.assertCanSend(ws);

    const title = str(b.title, 'Title', { max: 80, required: false }) || msg.body.replace(/[*_]/g, '').split('\n').find((l) => l.trim()).trim().slice(0, 60);
    const includeStop = conn.kind === 'bot' ? b.include_stop !== false : false;
    const row = await db.tx(async (c) => {
      const br = (await c.query(`insert into broadcasts(workspace_id, connection_id, segment_id, title, body, media_id, buttons, include_stop, send_mode, send_at, status, created_by)
        values ($1,$2,$3,$4,$5,$6,'[]',$7,$8,$9,$10,$11) returning *`,
      [ws.id, conn.id, segmentId, title, msg.body, msg.media_id, includeStop, mode, sendAt, status === 'sending' ? 'scheduled' : status, ctx.user.id])).rows[0];
      const btns = await B.makeLinks(c, ws.id, msg.buttons, { broadcastId: br.id });
      await c.query('update broadcasts set buttons = $2 where id = $1', [br.id, JSON.stringify(btns)]);
      return { ...br, buttons: btns };
    });
    let queued = 0;
    if (status === 'sending') queued = await B.enqueue(row);
    const est = conn.kind === 'bot' ? Math.ceil(queued / PER_SECOND()) : 1;
    return { ok: true, id: row.id, status: status === 'sending' ? (queued ? 'sending' : 'sent') : status, queued, seconds: est };
  }, { auth: 'workspace', rate: [60, 600] });

  r.post('/api/broadcasts/:id/approve', async (ctx) => {
    await settings.requireFeature('broadcasts');
    if (ctx.member.role !== 'owner') throw forbidden('Only the owner can approve messages.');
    const b = await getOwn(ctx);
    if (b.status !== 'pending_approval') throw badRequest('This message is not waiting for approval.');
    await billing.assertCanSend(ctx.workspace);
    if (b.send_mode === 'at' && b.send_at && new Date(b.send_at) > new Date()) {
      await db.query("update broadcasts set status = 'scheduled' where id = $1", [b.id]);
      return { ok: true, status: 'scheduled' };
    }
    const n = await B.enqueue(b);
    return { ok: true, status: 'sending', queued: n };
  }, { auth: 'workspace' });

  r.post('/api/broadcasts/:id/send', async (ctx) => {
    // Send a draft now.
    await settings.requireFeature('broadcasts');
    const b = await getOwn(ctx);
    if (b.status !== 'draft') throw badRequest('Only drafts can be sent from here.');
    if (ctx.member.role === 'drafter' || noHelperSend(ctx)) throw forbidden('Ask the owner to send this.');
    await billing.assertCanSend(ctx.workspace);
    const n = await B.enqueue(b);
    return { ok: true, status: 'sending', queued: n };
  }, { auth: 'workspace' });

  r.post('/api/broadcasts/:id/cancel', async (ctx) => {
    const b = await getOwn(ctx);
    if (!['scheduled', 'pending_approval', 'sending', 'draft'].includes(b.status)) throw badRequest('This message has already gone out.');
    // Drafters may drop drafts and messages waiting for approval, not messages that are scheduled or going out.
    if ((ctx.member.role === 'drafter' || noHelperSend(ctx)) && !['draft', 'pending_approval'].includes(b.status)) throw forbidden('Ask the owner to cancel this message.');
    await db.tx(async (c) => {
      await c.query("update broadcasts set status = 'cancelled', finished_at = now() where id = $1", [b.id]);
      await c.query("update deliveries set status = 'skipped', error = 'Cancelled' where broadcast_id = $1 and status = 'queued'", [b.id]);
    });
    return { ok: true };
  }, { auth: 'workspace' });

  /** Edit text: drafts/scheduled change in place; sent messages are edited in Telegram for everyone. */
  r.post('/api/broadcasts/:id/edit', async (ctx) => {
    const b = await getOwn(ctx);
    if ((ctx.member.role === 'drafter' || noHelperSend(ctx)) && !['draft', 'pending_approval'].includes(b.status)) throw forbidden('Ask the owner to edit sent messages.');
    // Editing halfway through would leave some people with the old text and some with the new one.
    if (b.status === 'sending') throw badRequest('This message is still going out. You can edit it as soon as it has finished sending.', 'still_sending');
    const body = str(ctx.body.body, 'Message', { min: 1, max: 20000, trim: false }).replace(/\r\n/g, '\n'); // real limit checked below
    const tgl = require('../services/telegram');
    const len = tgl.visibleLength(body);
    if (b.media_id && len > tgl.LIMITS.caption) throw badRequest('With a photo or video, Telegram allows 1,024 characters.');
    if (len > tgl.LIMITS.text) throw badRequest('Telegram allows 4,096 characters per message.');
    if (!body.trim()) throw badRequest('Write a message first.');
    await db.query('update broadcasts set body = $2 where id = $1', [b.id, body]);
    if (b.status === 'sent') {
      const n = await B.queueAction({ ...b, body }, 'edit');
      return { ok: true, editing: n };
    }
    return { ok: true };
  }, { auth: 'workspace' });

  r.post('/api/broadcasts/:id/pin', async (ctx) => {
    const b = await getOwn(ctx);
    if (ctx.member.role === 'drafter' || noHelperSend(ctx)) throw forbidden('Ask the owner to pin sent messages.');
    if (!['sent', 'sending'].includes(b.status)) throw badRequest('Only sent messages can be pinned.');
    return { ok: true, pinning: await B.queueAction(b, 'pin') };
  }, { auth: 'workspace' });

  r.post('/api/broadcasts/:id/delete', async (ctx) => {
    const b = await getOwn(ctx);
    if (ctx.member.role === 'drafter' || noHelperSend(ctx)) throw forbidden('Ask the owner to delete sent messages.');
    if (!['sent', 'sending'].includes(b.status)) throw badRequest('Only sent messages can be deleted from Telegram.');
    if (b.started_at && Date.now() - new Date(b.started_at).getTime() > 47.5 * 3600000) throw badRequest('Telegram only lets bots delete messages for 48 hours after sending.');
    await db.query("update deliveries set status = 'skipped', error = 'Deleted' where broadcast_id = $1 and status = 'queued' and action = 'send'", [b.id]);
    return { ok: true, deleting: await B.queueAction(b, 'delete') };
  }, { auth: 'workspace' });

  /** Send a test to yourself (you must have pressed Start on that bot, or on @CastvooBot for channels). */
  r.post('/api/broadcasts/test', async (ctx) => {
    await settings.requireFeature('broadcasts');
    const conn = await db.one("select * from connections where id = $1 and workspace_id = $2 and status = 'active'", [int(ctx.body.connection_id, 'Where to send'), ctx.workspace.id]);
    if (!conn) throw badRequest('Pick a connection first.');
    if (!ctx.user.tg_user_id) throw httpError(409, 'Link your Telegram account in Settings to get test messages.', 'tg_not_linked');
    const msg = await B.checkMessage(ctx.workspace.id, ctx.body);
    try {
      await send.sendOne({ ...msg, body: '🧪 Test\n\n' + msg.body }, { token: tokenOf(conn), botKey: senderKey(conn), chatId: ctx.user.tg_user_id, includeStop: false, firstName: conn.kind === 'bot' ? String(ctx.user.name || '').split(' ')[0] : null });
    } catch (e) {
      if (e.code === 403 || e.code === 400) {
        const bot = conn.kind === 'bot' ? '@' + conn.username : '@' + config.telegram.botUsername;
        throw httpError(409, `Open ${bot} in Telegram and press Start once, then try the test again.`, 'start_bot_first');
      }
      throw httpError(502, 'Telegram did not accept the test: ' + (e.description || e.message), 'telegram_error');
    }
    return { ok: true };
  }, { auth: 'workspace', rate: [30, 600] });
};

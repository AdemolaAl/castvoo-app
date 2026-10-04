'use strict';
/* Connecting bots, channels and groups, start links, and linking a Telegram account. */

const db = require('../db');
const config = require('../config');
const connections = require('../services/connections');
const settings = require('../services/settings');
const { ownerOnly } = require('./workspace');
const { str, int, oneOf, randomToken, badRequest, httpError, notFound } = require('../lib/util');

const TAG_RE = /^[A-Za-z0-9_-]{1,64}$/;

module.exports = (r) => {
  r.get('/api/connections', async (ctx) => {
    const rows = await db.many(`select c.id, c.kind, c.username, c.title, c.member_count, c.status, c.last_error, c.created_at,
        case when c.kind = 'bot' then (select count(*)::int from subscribers s where s.connection_id = c.id and s.status = 'active') else c.member_count end as reach,
        case when c.kind = 'bot' then (select count(*)::int from subscribers s where s.connection_id = c.id and s.status = 'blocked') else 0 end as blocked,
        (select count(*)::int from deliveries d where d.sender_key = case when c.kind = 'bot' then 'bot:' || c.id else 'platform' end and d.workspace_id = c.workspace_id and d.status = 'sent' and d.sent_at > now() - interval '30 days') as sent_30d,
        (select count(*)::int from deliveries d where d.sender_key = case when c.kind = 'bot' then 'bot:' || c.id else 'platform' end and d.workspace_id = c.workspace_id and d.status in ('failed') and d.sent_at > now() - interval '30 days') as failed_30d
      from connections c where c.workspace_id = $1 and c.status <> 'removed' order by c.id`, [ctx.workspace.id]);
    return { connections: rows, platform_bot: config.telegram.botUsername || null, tg_linked: !!ctx.user.tg_user_id };
  }, { auth: 'workspace' });

  r.post('/api/connections/bot', async (ctx) => {
    ownerOnly(ctx);
    const conn = await connections.connectBot(ctx.workspace, ctx.body.token);
    return { ok: true, reconnected: !!conn.reconnected, connection: { id: conn.id, kind: conn.kind, username: conn.username, title: conn.title } };
  }, { auth: 'workspace', rate: [20, 600] });

  /** One-tap channel/group: remember the request, give back the Telegram link. */
  r.post('/api/connections/request', async (ctx) => {
    ownerOnly(ctx);
    const kind = oneOf(ctx.body.kind, 'Type', ['channel', 'group']);
    if (!config.telegram.botToken || !config.telegram.botUsername) throw httpError(503, 'Channel connections are not set up yet on this server.', 'not_configured');
    if (!ctx.user.tg_user_id) throw httpError(409, 'Link your Telegram account first, so Castvoo knows the channel is yours.', 'tg_not_linked');
    await db.query("insert into connect_requests(user_id, workspace_id, kind, expires_at) values ($1,$2,$3, now() + interval '30 minutes')", [ctx.user.id, ctx.workspace.id, kind]);
    const rights = kind === 'channel' ? 'post_messages+edit_messages+delete_messages+invite_users' : 'delete_messages+pin_messages+invite_users';
    return { url: `https://t.me/${config.telegram.botUsername}?start${kind}&admin=${rights}`, bot: config.telegram.botUsername };
  }, { auth: 'workspace' });

  r.delete('/api/connections/:id', async (ctx) => {
    ownerOnly(ctx);
    return connections.remove(ctx.workspace, int(ctx.params.id, 'Connection'));
  }, { auth: 'workspace' });

  /** Link Telegram via t.me/CastvooBot?start=link_<token> (works on phones, no widget needed). */
  r.post('/api/me/telegram-link', async (ctx) => {
    if (!config.telegram.botUsername) throw httpError(503, 'Telegram linking is not set up yet.', 'not_configured');
    const token = randomToken(18).replace(/[^A-Za-z0-9_-]/g, '');
    await db.query("insert into tg_link_tokens(token, user_id, expires_at) values ($1,$2, now() + interval '15 minutes')", [token, ctx.user.id]);
    return { url: `https://t.me/${config.telegram.botUsername}?start=link_${token}` };
  }, { auth: 'user', rate: [20, 600] });

  /* ---------- Start links ---------- */
  r.get('/api/connections/:id/start-links', async (ctx) => {
    const conn = await db.one("select * from connections where id = $1 and workspace_id = $2 and kind = 'bot' and status <> 'removed'", [int(ctx.params.id, 'Connection'), ctx.workspace.id]);
    if (!conn) throw notFound('That bot');
    const rows = await db.many(`select l.tag, l.created_at,
        (select count(*)::int from subscribers s where s.connection_id = $1 and s.source = l.tag) as starts
      from start_links l where l.connection_id = $1 order by l.created_at desc`, [conn.id]);
    const other = await db.many('select source as tag, count(*)::int as starts from subscribers where connection_id = $1 and source is not null and source not in (select tag from start_links where connection_id = $1) group by source order by 2 desc limit 20', [conn.id]);
    return { bot: conn.username, links: rows.map((x) => ({ ...x, url: `https://t.me/${conn.username}?start=${x.tag}` })), untracked: other };
  }, { auth: 'workspace' });

  r.post('/api/connections/:id/start-links', async (ctx) => {
    await settings.requireFeature('start_links');
    const conn = await db.one("select * from connections where id = $1 and workspace_id = $2 and kind = 'bot' and status <> 'removed'", [int(ctx.params.id, 'Connection'), ctx.workspace.id]);
    if (!conn) throw notFound('That bot');
    const tag = str(ctx.body.tag, 'Name', { min: 1, max: 64 }).replace(/\s+/g, '_');
    if (!TAG_RE.test(tag)) throw badRequest('Use only letters, numbers, _ and - (no spaces), up to 64 characters.');
    await db.query('insert into start_links(connection_id, tag) values ($1,$2) on conflict do nothing', [conn.id, tag]);
    return { ok: true, url: `https://t.me/${conn.username}?start=${tag}` };
  }, { auth: 'workspace' });

  r.delete('/api/connections/:id/start-links/:tag', async (ctx) => {
    const conn = await db.one('select id from connections where id = $1 and workspace_id = $2', [int(ctx.params.id, 'Connection'), ctx.workspace.id]);
    if (!conn) throw notFound('That bot');
    await db.query('delete from start_links where connection_id = $1 and tag = $2', [conn.id, ctx.params.tag]);
    return { ok: true };
  }, { auth: 'workspace' });
};

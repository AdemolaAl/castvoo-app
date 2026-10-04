'use strict';
/* Subscribers: list, search, tag, export. */

const db = require('../db');
const drips = require('../services/drips');
const { ownerOnly, canSend } = require('./workspace');
const { str, int, badRequest } = require('../lib/util');

const TAG_RE = /^[A-Za-z0-9_-]{1,40}$/;

module.exports = (r) => {
  r.get('/api/subscribers', async (ctx) => {
    const q = ctx.query;
    const page = Math.max(1, Math.min(10000, Number(q.page) || 1));
    const params = [ctx.workspace.id];
    let where = "c.workspace_id = $1 and c.status <> 'removed' and c.kind = 'bot'";
    if (q.connection) { params.push(Number(q.connection)); where += ` and c.id = $${params.length}`; }
    if (q.status && ['active', 'blocked', 'stopped', 'joinreq'].includes(q.status)) { params.push(q.status); where += ` and s.status = $${params.length}`; }
    if (q.source) { params.push(String(q.source)); where += ` and s.source = $${params.length}`; }
    if (q.tag) { params.push(String(q.tag)); where += ` and $${params.length} = any(s.tags)`; }
    if (q.q) { params.push('%' + String(q.q).replace(/[%_]/g, '').slice(0, 60) + '%'); where += ` and (s.first_name ilike $${params.length} or s.username ilike $${params.length})`; }
    const total = await db.one(`select count(*)::int n from subscribers s join connections c on c.id = s.connection_id where ${where}`, params);
    params.push((page - 1) * 50);
    const rows = await db.many(`select s.id, s.first_name, s.username, s.lang, s.source, s.tags, s.status, s.joined_at, s.last_seen_at, c.username as bot,
        (select count(*)::int from clicks k where k.subscriber_id = s.id) as clicks
      from subscribers s join connections c on c.id = s.connection_id where ${where} order by s.joined_at desc limit 50 offset $${params.length}`, params);
    const counts = await db.one(`select count(*) filter (where s.status = 'active')::int active, count(*) filter (where s.status = 'blocked')::int blocked,
        count(*) filter (where s.status = 'stopped')::int stopped, count(*) filter (where s.joined_at > now() - interval '7 days')::int new_7d
      from subscribers s join connections c on c.id = s.connection_id where c.workspace_id = $1 and c.status <> 'removed'`, [ctx.workspace.id]);
    const channels = await db.many("select id, kind, title, username, member_count from connections where workspace_id = $1 and kind <> 'bot' and status <> 'removed'", [ctx.workspace.id]);
    return { subscribers: rows, total: total.n, page, pages: Math.max(1, Math.ceil(total.n / 50)), counts, channels };
  }, { auth: 'workspace' });

  /** Add or remove a tag on subscribers. Adding can start "tag" follow-ups. */
  r.post('/api/subscribers/tag', async (ctx) => {
    canSend(ctx); // tags decide who gets follow-ups, so drafters can't change them
    const tag = str(ctx.body.tag, 'Tag', { min: 1, max: 40 }).toLowerCase();
    if (!TAG_RE.test(tag)) throw badRequest('Tags can use letters, numbers, _ and -.');
    const ids = (Array.isArray(ctx.body.ids) ? ctx.body.ids : []).map(Number).filter(Number.isInteger).slice(0, 1000);
    if (!ids.length) throw badRequest('Pick at least one subscriber.');
    const remove = !!ctx.body.remove;
    const rows = await db.many(`update subscribers s set tags = ${remove ? 'array_remove(s.tags, $2)' : 'case when $2 = any(s.tags) then s.tags else array_append(s.tags, $2) end'}
      from connections c where c.id = s.connection_id and c.workspace_id = $1 and s.id = any($3) returning s.*`, [ctx.workspace.id, tag, ids]);
    if (!remove) for (const s of rows) await drips.start(s, s.connection_id, 'tag', tag);
    return { ok: true, updated: rows.length };
  }, { auth: 'workspace' });

  r.get('/api/subscribers/export.csv', async (ctx) => {
    ownerOnly(ctx);
    const rows = await db.many(`select c.username as bot, s.tg_user_id, s.first_name, s.username, s.lang, s.source, array_to_string(s.tags, ' ') as tags, s.status, s.joined_at
      from subscribers s join connections c on c.id = s.connection_id where c.workspace_id = $1 and c.status <> 'removed' order by s.id limit 200000`, [ctx.workspace.id]);
    // Names come from Telegram, so anyone can be called "=HYPERLINK(...)". Spreadsheets run cells that
    // start with = + - @ (or a tab / carriage return before them), so those get a ' in front.
    const cell = (v) => {
      const t = v instanceof Date ? v.toISOString() : String(v ?? '');
      const formula = /^[=+\-@\t\r]/.test(t);
      return /[",\r\n]/.test(t) || formula ? '"' + (formula ? "'" : '') + t.replace(/"/g, '""') + '"' : t;
    };
    const head = 'bot,telegram_id,first_name,username,language,start_tag,tags,status,joined_at';
    const csv = [head, ...rows.map((x) => [x.bot, x.tg_user_id, x.first_name, x.username, x.lang, x.source, x.tags, x.status, x.joined_at].map(cell).join(','))].join('\n');
    ctx.send(200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="castvoo-subscribers.csv"', 'Cache-Control': 'no-store' });
  }, { auth: 'workspace', rate: [10, 3600] });
};

module.exports.int = int;

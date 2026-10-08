'use strict';
/* Audiences (segments) for bot subscribers. */

const db = require('../db');
const seg = require('../services/segments');
const settings = require('../services/settings');
const billing = require('../services/billing');
const { str, int, notFound, forbidden } = require('../lib/util');

async function count(wsId, rules, connectionId) {
  const w = seg.toSql(rules, connectionId ? 3 : 2);
  const params = connectionId ? [wsId, connectionId, ...w.params] : [wsId, ...w.params];
  const r = await db.one(`select count(*)::int n from subscribers s join connections c on c.id = s.connection_id
    where c.workspace_id = $1 and c.kind = 'bot' and c.status = 'active' and s.status = 'active'${connectionId ? ' and c.id = $2' : ''}${w.sql}`, params);
  return r.n;
}

module.exports = (r) => {
  r.get('/api/segments', async (ctx) => {
    const rows = await db.many('select * from segments where workspace_id = $1 order by id', [ctx.workspace.id]);
    const out = [];
    for (const s of rows) out.push({ id: s.id, name: s.name, rules: s.rules, describe: seg.describe(s.rules), count: await count(ctx.workspace.id, s.rules) });
    const everyone = await count(ctx.workspace.id, []);
    const sources = await db.many(`select s.source, count(*)::int n from subscribers s join connections c on c.id = s.connection_id where c.workspace_id = $1 and s.source is not null group by 1 order by 2 desc limit 30`, [ctx.workspace.id]);
    const tags = await db.many(`select t as tag, count(*)::int n from subscribers s join connections c on c.id = s.connection_id, unnest(s.tags) t where c.workspace_id = $1 group by 1 order by 2 desc limit 30`, [ctx.workspace.id]);
    const langs = await db.many(`select lower(left(s.lang, 2)) as lang, count(*)::int n from subscribers s join connections c on c.id = s.connection_id where c.workspace_id = $1 and s.lang is not null group by 1 order by 2 desc limit 15`, [ctx.workspace.id]);
    return { segments: out, everyone, fields: seg.FIELDS, sources, tags, langs };
  }, { auth: 'workspace' });

  r.post('/api/segments/preview', async (ctx) => ({ count: await count(ctx.workspace.id, seg.cleanRules(ctx.body.rules || []), ctx.body.connection_id ? Number(ctx.body.connection_id) : null) }), { auth: 'workspace' });

  r.post('/api/segments', async (ctx) => {
    await settings.requireFeature('segments');
    await billing.requirePlanFeature(ctx.workspace, 'audiences');
    const name = str(ctx.body.name, 'Audience name', { min: 1, max: 60 });
    const rules = seg.cleanRules(ctx.body.rules || []);
    const row = await db.one('insert into segments(workspace_id, name, rules) values ($1,$2,$3) returning *', [ctx.workspace.id, name, JSON.stringify(rules)]);
    return { segment: { ...row, describe: seg.describe(rules), count: await count(ctx.workspace.id, rules) } };
  }, { auth: 'workspace' });

  r.delete('/api/segments/:id', async (ctx) => {
    if (ctx.member.role === 'drafter') throw forbidden('Ask the owner to delete audiences.');
    const row = await db.one('delete from segments where id = $1 and workspace_id = $2 returning id', [int(ctx.params.id, 'Audience'), ctx.workspace.id]);
    if (!row) throw notFound('That audience');
    return { ok: true };
  }, { auth: 'workspace' });
};

module.exports.count = count;

'use strict';
/*
 * The setup helper's activity, in plain words, for the owner (Settings → Team → Setup helper → Activity).
 *
 * server/app.js calls before() and after() around every change (not GET) a setup helper makes in a workspace:
 *   before() reads the name of the thing the route works on (a flow, a message, a bot), because a delete removes it,
 *   after()  writes one line, like "Created Welcome Flow 'VIP welcome'", once the handler succeeded.
 * Lines only hold names the workspace already has (no message text, no tokens). Routes not listed get a generic line.
 * record() is also used directly ("Joined as setup helper", "Left the workspace").
 */

const db = require('../db');
const log = require('../lib/log');

const q = (s, max = 60) => {
  const t = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};
const named = (what, name) => (name ? `${what} '${q(name)}'` : what);
const connLabel = (c) => (c ? (c.kind === 'bot' ? '@' + (c.username || 'bot') : c.title || (c.username ? '@' + c.username : c.kind)) : '');

/* What a route works on, read before the handler runs. */
const LOOKUP = {
  flow: (ws, id) => db.one('select name from sequences where id = $1 and workspace_id = $2', [Number(id) || 0, ws]).then((r) => r && r.name),
  drip: (ws, id) => db.one('select name from sequences where id = $1 and workspace_id = $2', [Number(id) || 0, ws]).then((r) => r && r.name),
  broadcast: (ws, id) => db.one('select title from broadcasts where id = $1 and workspace_id = $2', [Number(id) || 0, ws]).then((r) => r && r.title),
  segment: (ws, id) => db.one('select name from segments where id = $1 and workspace_id = $2', [Number(id) || 0, ws]).then((r) => r && r.name),
  connection: (ws, id) => db.one('select kind, username, title from connections where id = $1 and workspace_id = $2', [Number(id) || 0, ws]).then(connLabel),
};

/* route → [lookup kind (or null), (ctx, name, out) => line] */
const LINES = {
  'POST /api/app/settings': [null, () => 'Changed the workspace settings'],
  'POST /api/app/plan': [null, (ctx) => `Changed the plan to ${q(ctx.body.plan, 30)}`],
  'POST /api/app/coupon': [null, () => 'Used a coupon code'],
  'POST /api/app/ai-profile': [null, () => 'Updated Train Cas'],
  'POST /api/connections/bot': [null, (ctx, n, out) => `Connected bot ${out && out.connection ? '@' + q(out.connection.username, 40) : ''}`.trim()],
  'POST /api/connections/request': [null, (ctx) => `Started connecting a ${ctx.body.kind === 'group' ? 'group' : 'channel'}`],
  'DELETE /api/connections/:id': ['connection', (ctx, n) => (n ? `Removed connection ${q(n)}` : 'Removed a connection')],
  'POST /api/connections/:id/start-links': ['connection', (ctx) => `Added start link '${q(ctx.body.tag, 40)}'`],
  'DELETE /api/connections/:id/start-links/:tag': ['connection', (ctx) => `Removed start link '${q(ctx.params.tag, 40)}'`],
  'POST /api/subscribers/tag': [null, (ctx, n, out) => `${ctx.body.remove ? 'Removed' : 'Added'} tag '${q(ctx.body.tag, 40)}' ${ctx.body.remove ? 'from' : 'on'} ${Number(out && out.updated) || 0} subscriber${Number(out && out.updated) === 1 ? '' : 's'}`],
  'POST /api/segments': [null, (ctx) => named('Created audience', ctx.body.name)],
  'DELETE /api/segments/:id': ['segment', (ctx, n) => named('Deleted audience', n)],
  'POST /api/media': [null, () => 'Uploaded a photo or video'],
  'POST /api/broadcasts': [null, (ctx, n, out) => {
    const st = out && out.status;
    const verb = st === 'draft' ? 'Saved draft' : st === 'scheduled' ? 'Scheduled broadcast' : st === 'pending_approval' ? 'Wrote broadcast for your approval' : 'Sent broadcast';
    const title = ctx.body.title || String(ctx.body.body || '').replace(/[*_]/g, '').split('\n').find((l) => l.trim()) || '';
    return named(verb, title);
  }],
  'POST /api/broadcasts/:id/send': ['broadcast', (ctx, n) => named('Sent broadcast', n)],
  'POST /api/broadcasts/:id/cancel': ['broadcast', (ctx, n) => named('Cancelled broadcast', n)],
  'POST /api/broadcasts/:id/edit': ['broadcast', (ctx, n) => named('Edited broadcast', n)],
  'POST /api/broadcasts/:id/pin': ['broadcast', (ctx, n) => named('Pinned broadcast', n)],
  'POST /api/broadcasts/:id/delete': ['broadcast', (ctx, n) => named('Deleted broadcast from Telegram', n)],
  'POST /api/broadcasts/test': [null, () => 'Sent a test message to themselves'],
  'POST /api/drips': [null, (ctx) => named('Created follow-up', ctx.body.name)],
  'PUT /api/drips/:id': ['drip', (ctx, n) => named('Edited follow-up', ctx.body.name || n)],
  'POST /api/drips/:id/toggle': ['drip', (ctx, n, out) => named(out && out.active === false ? 'Switched off follow-up' : 'Switched on follow-up', n)],
  'DELETE /api/drips/:id': ['drip', (ctx, n) => named('Deleted follow-up', n)],
  'POST /api/flows': [null, async (ctx, n, out) => named('Created Welcome Flow', ctx.body.name || (out && out.id ? await LOOKUP.flow(ctx.workspace.id, out.id) : ''))],
  'POST /api/flows/requests/decide': [null, (ctx) => `${ctx.body.action === 'decline' ? 'Declined' : 'Let in'} ${Array.isArray(ctx.body.ids) && ctx.body.ids.length === 1 ? 'a join request' : 'join requests'}`],
  'PUT /api/flows/:id': ['flow', (ctx, n) => named('Edited Welcome Flow', ctx.body.name || n)],
  'POST /api/flows/:id/toggle': ['flow', (ctx, n, out) => named(out && out.active === false ? 'Switched off Welcome Flow' : 'Switched on Welcome Flow', n)],
  'POST /api/flows/:id/duplicate': ['flow', (ctx, n) => named('Duplicated Welcome Flow', n)],
  'DELETE /api/flows/:id': ['flow', (ctx, n) => named('Deleted Welcome Flow', n)],
  'POST /api/flows/:id/invite-link': ['flow', (ctx, n) => named('Made an invite link for Welcome Flow', n)],
  'POST /api/wallet/topup': [null, (ctx) => `Started a wallet top-up of $${q(ctx.body.amount, 12)}`],
  'POST /api/support': [null, () => 'Wrote to Castvoo support'],
};
// Routes that change nothing worth a line (AI writing helpers, previews, uploads of support screenshots).
const QUIET = new Set(['POST /api/ai/write', 'POST /api/ai/rewrite', 'POST /api/ai/translate', 'POST /api/ai/sequence', 'POST /api/ai/ask',
  'POST /api/flows/check', 'POST /api/segments/preview', 'POST /api/support/attachments', 'POST /api/wallet/check', 'POST /api/wallet/crypto-txid',
  'POST /api/wallet/manual/:ref/screenshot', 'POST /api/wallet/manual/:ref/submit']);

async function record(wsId, userId, action, line, role = 'helper') {
  await db.query('insert into workspace_activity(workspace_id, actor_user_id, role, action, line) values ($1,$2,$3,$4,$5)', [wsId, userId, role, String(action).slice(0, 80), q(line, 200)]);
}

/** Before the handler: the name of what the route works on. Never throws. */
async function before(ctx, key) {
  const spec = LINES[key];
  if (!spec || !spec[0]) return null;
  try { return await LOOKUP[spec[0]](ctx.workspace.id, ctx.params.id); } catch { return null; }
}

/** After a successful change: one line in the workspace's activity. Never throws. */
async function after(ctx, key, name, out) {
  if (QUIET.has(key)) return;
  try {
    const spec = LINES[key];
    const line = spec ? await spec[1](ctx, name, out) : `Changed something (${key.replace(/:([a-z_]+)/g, '…')})`;
    if (line) await record(ctx.workspace.id, ctx.user.id, key, line);
  } catch (e) { log.warn('activity line failed', { key, err: e.message }); }
}

/** "Last active" on the owner's helper card: at most one write a minute per person and workspace. Never waits or throws. */
function seen(wsId, userId) {
  db.query("update members set last_active_at = now() where workspace_id = $1 and user_id = $2 and (last_active_at is null or last_active_at < now() - interval '1 minute')", [wsId, userId])
    .catch((e) => log.warn('last active failed', { err: e.message }));
}

/** Was this person removed as setup helper of this workspace lately (and not invited back)? */
async function wasRemoved(wsId, userId) {
  if (!Number.isSafeInteger(wsId) || wsId <= 0) return false;
  return !!(await db.one(`select 1 from workspace_activity a where a.workspace_id = $1 and a.actor_user_id = $2 and a.action = 'helper.removed'
    and a.created_at > now() - interval '30 days' and not exists (select 1 from members m where m.workspace_id = $1 and m.user_id = $2) limit 1`, [wsId, userId]));
}

/** The last lines for one workspace (the owner's helper card). */
async function list(wsId, { userId = null, limit = 30 } = {}) {
  return db.many(`select a.line, a.created_at, a.role, u.name as actor from workspace_activity a left join users u on u.id = a.actor_user_id
    where a.workspace_id = $1 and ($2::bigint is null or a.actor_user_id = $2) order by a.id desc limit $3`, [wsId, userId, limit]);
}

module.exports = { record, before, after, list, seen, wasRemoved, LINES, QUIET };

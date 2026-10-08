'use strict';
/*
 * Admin → Support AI: the master switch, agent personas (name, face or photo, role, short bio), images in the chat,
 * the "Powered by Replyvoo" line, tone and house rules,
 * when to hand over, typing delays, caps, the model, and a sandbox to chat as a chosen customer workspace
 * (read-only tools: nothing is credited, repaired, emailed or handed over from the sandbox).
 *   view:  support.view      change: support_ai.edit (Owner, Admin)      sandbox: support_ai.test (Owner, Admin, Support)
 */

const db = require('../../db');
const settings = require('../../services/settings');
const llm = require('../../services/llm');
const supportAi = require('../../services/support-ai');
const { audit } = require('../../services/audit');
const { str, int, bool, badRequest, notFound } = require('../../lib/util');

const ESC_KEYS = Object.keys(supportAi.DEFAULTS.escalation);

function cleanSettings(b, cur) {
  const n = (v, name, min, max) => (v === undefined ? undefined : int(v, name, { min, max }));
  const out = { ...cur };
  if (b.enabled !== undefined) out.enabled = bool(b.enabled);
  if (b.house_rules !== undefined) out.house_rules = str(b.house_rules, 'Tone and house rules', { max: 6000, required: false, trim: false }) || '';
  if (b.escalation && typeof b.escalation === 'object') {
    out.escalation = { ...cur.escalation };
    for (const k of ESC_KEYS) if (b.escalation[k] !== undefined) out.escalation[k] = bool(b.escalation[k]);
  }
  const nums = [['typing_min_ms', 'Shortest typing delay', 0, 15000], ['typing_max_ms', 'Longest typing delay', 0, 20000], ['debounce_ms', 'Wait for more messages', 0, 10000],
    ['daily_cap_per_user', 'AI replies per customer per day', 1, 1000], ['daily_cap_total', 'AI replies per day in total', 1, 200000], ['msgs_per_min', 'Messages per minute', 2, 60],
    ['free_conversations_per_month', 'Free plan AI chats per month', 0, 1000], ['max_tool_rounds', 'Tool rounds', 1, 10], ['site_chat_daily_cap', 'Website chat answers per day', 0, 100000], ['site_chat_per_ip_day', 'Website chat answers per visitor per day', 1, 1000],
    ['concurrency', 'Conversations answered at once (per server)', 1, 16], ['turn_max_ms', 'Longest time for one answer (ms)', 10000, 300000],
    ['site_chat_known_after_s', 'Website chat: seconds on the site before a visitor counts as known', 0, 86400], ['resolution_goal_pct', 'AI resolution goal (%)', 1, 100]];
  for (const [k, name, min, max] of nums) { const v = n(b[k], name, min, max); if (v !== undefined && v !== null) out[k] = v; }
  if (b.site_chat_soft_pct !== undefined) {
    const v = Number(b.site_chat_soft_pct);
    if (!Number.isFinite(v) || v < 0 || v > 1) throw badRequest('The open part of the website chat budget is a share between 0 and 1 (for example 0.6).');
    out.site_chat_soft_pct = v;
  }
  if (out.typing_max_ms < out.typing_min_ms) throw badRequest('The longest typing delay must be at least the shortest.');
  if (b.model !== undefined) {
    const m = String(b.model || '').trim();
    if (m && (m.length > 100 || !/^~?[a-z0-9][a-z0-9._:/-]*$/i.test(m))) throw badRequest('Use a model id like claude-haiku-4-5-20251001 or anthropic/claude-sonnet-4.5, or leave it empty to use the Cas model.');
    out.model = m;
  }
  if (b.handoff_eta && typeof b.handoff_eta === 'object') {
    out.handoff_eta = { ...cur.handoff_eta };
    for (const k of ['free', 'paid', 'priority']) if (b.handoff_eta[k] !== undefined) out.handoff_eta[k] = str(b.handoff_eta[k], 'Reply time', { min: 3, max: 80 });
  }
  if (b.customer_images !== undefined) out.customer_images = bool(b.customer_images);
  if (b.powered_by !== undefined) out.powered_by = bool(b.powered_by);
  if (b.powered_by_text !== undefined) out.powered_by_text = str(b.powered_by_text, 'Powered by text', { max: 60, required: false }) || 'Powered by Replyvoo';
  if (b.priority_plans !== undefined) {
    if (!Array.isArray(b.priority_plans) || b.priority_plans.length > 20) throw badRequest('Pick the plans that get priority support.');
    out.priority_plans = b.priority_plans.map((x) => String(x).slice(0, 30));
  }
  return out;
}

function cleanPersona(b) {
  return {
    name: str(b.name, 'First name', { min: 2, max: 24 }).split(/\s+/)[0],
    role: str(b.role, 'Role', { max: 60, required: false }) || '',
    bio: str(b.bio, 'Short bio', { max: 300, required: false }) || '',
    active: b.active === undefined ? true : bool(b.active),
    sort: b.sort === undefined ? 0 : int(b.sort, 'Order', { min: 0, max: 999 }),
  };
}

module.exports = (r) => {
  r.get('/api/admin/support-ai', async () => {
    const [c, list, f, model] = [await supportAi.conf(), await supportAi.personas(), await settings.features(), await llm.publicInfo()];
    const stats = await db.one(`select
        (select count(*)::int from ai_usage where kind = 'support' and created_at > now() - interval '1 day') replies_24h,
        (select count(distinct thread_id)::int from ai_usage where kind = 'support' and created_at > now() - interval '1 day') conversations_24h,
        (select count(*)::int from support_threads where handoff_at > now() - interval '1 day') handoffs_24h,
        (select count(*)::int from support_threads where needs_human and status <> 'closed') waiting_for_human,
        (select coalesce(sum(cost_usd), 0)::float from ai_usage where kind in ('support','support_sandbox','site_chat') and created_at > now() - interval '1 day') cost_24h,
        (select coalesce(sum(input_tokens + output_tokens), 0)::bigint from ai_usage where kind in ('support','support_sandbox','site_chat') and created_at > now() - interval '1 day') tokens_24h,
        (select count(*)::int from ai_usage where kind = 'site_chat' and created_at > now() - interval '1 day') site_chats_24h`);
    return {
      settings: c, personas: list.map((p) => ({ ...p, avatar: supportAi.avatarUrl(p) })),
      features: { support_ai: !!f.support_ai, site_chat: !!f.site_chat, support_chat: !!f.support_chat },
      on: await supportAi.isOn(), model: { provider: model.provider, label: model.label, cas_model: model.model, has_key: model.has_key },
      plans: (await settings.plans()).map((p) => ({ code: p.code, name: p.name })), stats: { ...stats, tokens_24h: Number(stats.tokens_24h) },
      // AI resolution rate: conversations solved without a person / all AI conversations (goal: c.resolution_goal_pct).
      resolution: { goal_pct: Number(c.resolution_goal_pct) || 99, d7: await supportAi.resolutionStats(7), d30: await supportAi.resolutionStats(30) },
      escalation_keys: ESC_KEYS,
      faces: supportAi.FACES.map((f) => ({ ...f, url: `/img/agents/${f.key}.svg` })),
    };
  }, { staff: 'support.view' });

  r.put('/api/admin/support-ai/settings', async (ctx) => {
    const cur = await supportAi.conf();
    const next = cleanSettings(ctx.body || {}, cur);
    await db.query('insert into settings(key, value, updated_at) values ($1,$2, now()) on conflict (key) do update set value = excluded.value, updated_at = now()', ['support_ai', JSON.stringify(next)]);
    settings.bust();
    await audit(ctx, 'support_ai.settings', 'settings:support_ai', { changed: Object.keys(ctx.body || {}) });
    return { ok: true, settings: await supportAi.conf() };
  }, { staff: 'support_ai.edit', rate: [60, 600] });

  r.post('/api/admin/support-ai/personas', async (ctx) => {
    const p = cleanPersona(ctx.body || {});
    const n = await db.one('select count(*)::int n from support_personas');
    if (n.n >= 30) throw badRequest('Use 30 agents or fewer.');
    const face = supportAi.FACES.some((f) => f.key === ctx.body.face) ? ctx.body.face : null;
    const row = await db.one('insert into support_personas(name, role, bio, active, sort, face) values ($1,$2,$3,$4,$5,$6) returning id', [p.name, p.role, p.bio, p.active, p.sort, face]);
    await audit(ctx, 'support_ai.persona_create', 'persona:' + row.id, { name: p.name });
    return { ok: true, id: row.id };
  }, { staff: 'support_ai.edit' });

  r.put('/api/admin/support-ai/personas/:id', async (ctx) => {
    const id = int(ctx.params.id, 'Agent');
    const p = cleanPersona(ctx.body || {});
    const row = await db.one('update support_personas set name = $2, role = $3, bio = $4, active = $5, sort = $6, updated_at = now() where id = $1 returning id', [id, p.name, p.role, p.bio, p.active, p.sort]);
    if (!row) throw notFound('That agent');
    await audit(ctx, 'support_ai.persona_update', 'persona:' + id, { name: p.name, active: p.active });
    return { ok: true };
  }, { staff: 'support_ai.edit' });

  r.delete('/api/admin/support-ai/personas/:id', async (ctx) => {
    const id = int(ctx.params.id, 'Agent');
    await supportAi.removePhoto(id).catch(() => {});
    await db.query('delete from support_personas where id = $1', [id]);
    await audit(ctx, 'support_ai.persona_delete', 'persona:' + id, {});
    return { ok: true };
  }, { staff: 'support_ai.edit' });

  /** The photo is the raw request body (JPG, PNG or WEBP, up to 5 MB). */
  r.post('/api/admin/support-ai/personas/:id/photo', async (ctx) => {
    const id = int(ctx.params.id, 'Agent');
    const out = await supportAi.savePhoto(ctx, id);
    await audit(ctx, 'support_ai.persona_photo', 'persona:' + id, { size: out.size });
    return out;
  }, { staff: 'support_ai.edit', stream: true, rate: [30, 600] });

  /** Pick one of the built-in illustrated faces (public/img/agents). An uploaded photo still shows first. */
  r.put('/api/admin/support-ai/personas/:id/face', async (ctx) => {
    const id = int(ctx.params.id, 'Agent');
    await supportAi.setFace(id, ctx.body.face || null);
    await audit(ctx, 'support_ai.persona_face', 'persona:' + id, { face: ctx.body.face || null });
    return { ok: true };
  }, { staff: 'support_ai.edit' });

  r.delete('/api/admin/support-ai/personas/:id/photo', async (ctx) => {
    const id = int(ctx.params.id, 'Agent');
    await supportAi.removePhoto(id);
    await audit(ctx, 'support_ai.persona_photo_remove', 'persona:' + id, {});
    return { ok: true };
  }, { staff: 'support_ai.edit' });

  /** Pick a customer workspace for the sandbox. */
  r.get('/api/admin/support-ai/workspaces', async (ctx) => {
    const q = String(ctx.query.q || '').replace(/[%_]/g, '').trim().slice(0, 60);
    const rows = await db.many(`select w.id, w.name, w.plan_code, w.plan_status, u.name as owner_name, u.email as owner_email from workspaces w join users u on u.id = w.owner_user_id
      where w.purged_at is null ${q ? 'and (u.email ilike $1 or u.name ilike $1 or w.name ilike $1)' : ''} order by w.id desc limit 20`, q ? ['%' + q + '%'] : []);
    return { workspaces: rows };
  }, { staff: 'support_ai.test' });

  /** Chat with the support AI as a chosen customer. Tools are read-only here and nothing is saved in their chat. */
  r.post('/api/admin/support-ai/sandbox', async (ctx) => {
    const out = await supportAi.sandbox({
      workspaceId: int(ctx.body.workspace_id, 'Workspace'), personaId: ctx.body.persona_id ? int(ctx.body.persona_id, 'Agent') : null,
      history: ctx.body.history, message: ctx.body.message, staffUser: ctx.user,
    });
    await audit(ctx, 'support_ai.sandbox', 'workspace:' + ctx.body.workspace_id, { tools: (out.tools || []).map((t) => t.name) });
    return out;
  }, { staff: 'support_ai.test', rate: [60, 600] });
};

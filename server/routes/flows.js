'use strict';
/*
 * Welcome Flows (dashboard → Welcome Flows). The logic is in services/flows.js.
 *   GET    /api/flows                    list, templates, the join-request meter, what the plan allows
 *   POST   /api/flows                    create (from a template or from blocks)
 *   GET    /api/flows/:id                one flow with its blocks
 *   PUT    /api/flows/:id                save name, settings and blocks
 *   POST   /api/flows/:id/toggle         live / draft ({ active, replace } — replace switches off the flow live on the same chat)
 *   POST   /api/flows/:id/duplicate      copy as a draft
 *   DELETE /api/flows/:id
 *   POST   /api/flows/check              is the bot an admin of the chat with "Add members"?
 *   POST   /api/flows/:id/invite-link    make the flow's own join link (createChatInviteLink, needs approval)
 *   GET    /api/flows/:id/stats
 *   GET    /api/flows/requests           open join requests (?flow=<id>)
 *   POST   /api/flows/requests/decide    { ids, action: 'approve' | 'decline' }
 */

const db = require('../db');
const settings = require('../services/settings');
const billing = require('../services/billing');
const flows = require('../services/flows');
const tg = require('../services/telegram');
const { tokenOf } = require('../services/connections');
const { int, oneOf, httpError, badRequest, notFound } = require('../lib/util');

const canEdit = (ctx, what = 'change Welcome Flows') => { if (ctx.member.role === 'drafter') throw httpError(403, `Your role can't ${what}. Ask the workspace owner.`, 'forbidden'); };
const on = () => settings.requireFeature('welcome_flows', 'Welcome Flows are switched off for a moment. Please check back soon.');

async function create(ctx, f, active) {
  const ws = ctx.workspace;
  const l = await billing.limits(ws);
  const total = (await billing.usage(ws.id)).flows;
  if (l.flows !== billing.UNLIMITED && total >= l.flows) {
    throw httpError(402, `Your ${l.plan.name} plan includes ${l.flows} Welcome Flow${l.flows === 1 ? '' : 's'}. Upgrade to make more, or edit the one you have.`, 'limit_flows', { limit: l.flows });
  }
  if (active) {
    flows.assertNoPlaceholders(f.steps); // QA-4: template placeholders never go live
    await flows.requireAdmin(f.bot, f.chat);
    const clash = await flows.liveClash(f.chat, f.invite_link, 0);
    if (clash) throw httpError(409, `"${clash.name}" is already live on ${f.chat.title}. Save this one as a draft, or switch that one off first.`, 'flow_live_clash', { other: clash.id });
    await flows.assertCanGoLive(ws, 0, 0);
  }
  return db.tx(async (c) => {
    const q = (await c.query(`insert into sequences(workspace_id, connection_id, name, trigger_type, trigger_value, approve_join, approve_mode, start_button, start_label, invite_link, active)
      values ($1,$2,$3,'join_request',$4,$5,$6,$7,$8,$9,$10) returning id`,
    [ws.id, f.bot.id, f.name, String(f.chat.tg_chat_id), f.approve_mode !== 'manual', f.approve_mode, f.start_button, f.start_label, f.invite_link, !!active])).rows[0].id;
    await flows.saveSteps(c, ws.id, q, f.steps);
    return q;
  }).catch((e) => { if (e.code === '23505') throw httpError(409, `Another flow is already live on ${f.chat.title}. Save this one as a draft.`, 'flow_live_clash'); throw e; });
}

/** A template's blocks, ready to save: buttons without a link yet are left out (the builder shows them). */
function templateBody(t, b) {
  return {
    name: b.name || t.name, chat_id: b.chat_id, bot_id: b.bot_id, approve_mode: b.approve_mode || t.approve_mode, start_button: b.start_button ?? t.start_button, start_label: b.start_label || t.start_label || '',
    blocks: t.blocks.map((x) => (x.type === 'message' ? { ...x, buttons: (x.buttons || []).filter((y) => y.url) } : { ...x })),
  };
}

module.exports = (r) => {
  r.get('/api/flows', async (ctx) => {
    const ws = ctx.workspace;
    const [list, plan, meter, conns, open] = await Promise.all([
      flows.summary(ws.id), billing.planState(ws), billing.joinMeter(ws),
      db.many("select id, kind, username, title, status from connections where workspace_id = $1 and status <> 'removed' order by id", [ws.id]),
      db.one("select count(*)::int n from join_requests where workspace_id = $1 and status = 'pending'", [ws.id]),
    ]);
    return {
      flows: list,
      templates: flows.TEMPLATES.map((t) => ({ key: t.key, name: t.name, emoji: t.emoji, about: t.about, approve_mode: t.approve_mode, start_button: t.start_button, start_label: t.start_label || '', blocks: t.blocks })),
      meter, pending: open.n,
      plan: { code: plan.plan_code, plan_code: plan.plan_code, name: plan.plan_name, cycle: plan.cycle, status: plan.status, free: plan.free, limits: plan.limits, usage: plan.usage, features: plan.features, branding: plan.branding, plans: plan.plans },
      bots: conns.filter((c) => c.kind === 'bot'), chats: conns.filter((c) => c.kind !== 'bot'),
      branding_text: flows.BRAND_TEXT,
    };
  }, { auth: 'workspace' });

  r.post('/api/flows', async (ctx) => {
    await on();
    canEdit(ctx);
    const b = ctx.body || {};
    let body = b;
    if (b.template) {
      const t = flows.template(String(b.template));
      if (!t) throw badRequest('That template was not found.');
      body = b.blocks ? { ...b, approve_mode: b.approve_mode || t.approve_mode } : templateBody(t, b);
    }
    const f = await flows.cleanFlow(ctx.workspace, body);
    const id = await create(ctx, f, b.active === true);
    return { ok: true, id };
  }, { auth: 'workspace', rate: [120, 600] });

  r.post('/api/flows/check', async (ctx) => {
    const ws = ctx.workspace;
    const bot = await db.one("select * from connections where id = $1 and workspace_id = $2 and kind = 'bot' and status <> 'removed'", [int(ctx.body.bot_id, 'Bot'), ws.id]);
    const chat = await db.one("select * from connections where id = $1 and workspace_id = $2 and kind <> 'bot' and status <> 'removed'", [int(ctx.body.chat_id, 'Channel or group'), ws.id]);
    if (!bot || !chat) throw notFound('That bot or channel');
    return flows.checkAdmin(bot, chat);
  }, { auth: 'workspace', rate: [60, 60] });

  r.get('/api/flows/requests', async (ctx) => {
    const flowId = ctx.query.flow ? int(ctx.query.flow, 'Flow') : null;
    if (flowId) await flows.getOwn(ctx.workspace.id, flowId);
    return { requests: await flows.pending(ctx.workspace.id, flowId) };
  }, { auth: 'workspace' });

  r.post('/api/flows/requests/decide', async (ctx) => {
    canEdit(ctx, 'let people in or decline them');
    const action = oneOf(ctx.body.action, 'Action', ['approve', 'decline']);
    const ids = (Array.isArray(ctx.body.ids) ? ctx.body.ids : []).slice(0, 200).map((x) => int(x, 'Request', { min: 1 }));
    if (!ids.length) throw badRequest('Pick at least one person.');
    return { ok: true, ...(await flows.decideMany(ctx.workspace.id, ids, action)) };
  }, { auth: 'workspace', rate: [60, 600] });

  r.get('/api/flows/:id', async (ctx) => {
    const q = await flows.getOwn(ctx.workspace.id, int(ctx.params.id, 'Flow'));
    return { flow: await flows.detail(ctx.workspace, q) };
  }, { auth: 'workspace' });

  r.get('/api/flows/:id/stats', async (ctx) => {
    const q = await flows.getOwn(ctx.workspace.id, int(ctx.params.id, 'Flow'));
    return { stats: await flows.stats(ctx.workspace, q) };
  }, { auth: 'workspace' });

  r.put('/api/flows/:id', async (ctx) => {
    await on();
    canEdit(ctx);
    const ws = ctx.workspace;
    const q = await flows.getOwn(ws.id, int(ctx.params.id, 'Flow'));
    const f = await flows.cleanFlow(ws, ctx.body || {});
    // A live flow stays live: its new chat and bot must be ready, and nothing else may be live there.
    if (q.active) {
      flows.assertNoPlaceholders(f.steps); // QA-4
      if (String(f.chat.tg_chat_id) !== String(q.trigger_value) || Number(f.bot.id) !== Number(q.connection_id)) await flows.requireAdmin(f.bot, f.chat);
      const clash = await flows.liveClash(f.chat, f.invite_link, q.id);
      if (clash) throw httpError(409, `"${clash.name}" is already live on ${f.chat.title}. Switch it off first.`, 'flow_live_clash', { other: clash.id });
    }
    await db.tx(async (c) => {
      await c.query(`update sequences set name = $2, connection_id = $3, trigger_value = $4, approve_join = $5, approve_mode = $6, start_button = $7, start_label = $8,
        invite_link = $9, updated_at = now() where id = $1`, [q.id, f.name, f.bot.id, String(f.chat.tg_chat_id), f.approve_mode !== 'manual', f.approve_mode, f.start_button, f.start_label, f.invite_link]);
      await flows.saveSteps(c, ws.id, q.id, f.steps);
    }).catch((e) => { if (e.code === '23505') throw httpError(409, 'Another flow is already live there. Switch it off first.', 'flow_live_clash'); throw e; });
    return { ok: true, flow: await flows.detail(ws, await flows.getOwn(ws.id, q.id)) };
  }, { auth: 'workspace', rate: [240, 600] });

  r.post('/api/flows/:id/toggle', async (ctx) => {
    await on();
    canEdit(ctx);
    const ws = ctx.workspace;
    const q = await flows.getOwn(ws.id, int(ctx.params.id, 'Flow'));
    const active = !!ctx.body.active;
    if (!active) {
      await db.query('update sequences set active = false, paused_by_plan = false, updated_at = now() where id = $1', [q.id]);
      return { ok: true, active: false };
    }
    const chat = await db.one("select * from connections where workspace_id = $1 and kind <> 'bot' and status <> 'removed' and tg_chat_id::text = $2", [ws.id, q.trigger_value || '']);
    if (!chat) throw badRequest('This flow\'s channel or group is not connected any more. Pick another one and save first.');
    const bot = await db.one("select * from connections where id = $1 and status <> 'removed'", [q.connection_id]);
    // The plan may have changed since it was saved (e.g. dropped to Free): check the steps against today's plan.
    const steps = await flows.loadSteps(q.id);
    const f = await flows.cleanFlow(ws, { name: q.name, chat_id: chat.id, bot_id: bot.id, approve_mode: q.approve_mode, start_button: q.start_button, start_label: q.start_label, invite_link: q.invite_link, blocks: flows.stepsToBlocks(steps) });
    flows.assertNoPlaceholders(f.steps); // QA-4
    await flows.requireAdmin(bot, chat);
    const clash = await flows.liveClash(chat, q.invite_link, q.id);
    if (clash && !ctx.body.replace) throw httpError(409, `"${clash.name}" is live on ${chat.title} now. Switch to this flow instead?`, 'flow_live_clash', { other: clash.id, other_name: clash.name });
    await flows.assertCanGoLive(ws, q.id, clash ? clash.id : 0);
    await db.tx(async (c) => {
      if (clash) await c.query('update sequences set active = false, updated_at = now() where id = $1 and workspace_id = $2', [clash.id, ws.id]);
      await c.query('update sequences set active = true, paused_by_plan = false, updated_at = now() where id = $1', [q.id]);
    }).catch((e) => { if (e.code === '23505') throw httpError(409, 'Another flow went live there a moment ago. Refresh and try again.', 'flow_live_clash'); throw e; });
    return { ok: true, active: true, replaced: clash ? clash.id : null };
  }, { auth: 'workspace' });

  r.post('/api/flows/:id/duplicate', async (ctx) => {
    await on();
    canEdit(ctx);
    const ws = ctx.workspace;
    const q = await flows.getOwn(ws.id, int(ctx.params.id, 'Flow'));
    const d = await flows.detail(ws, q);
    if (!d.chat) throw badRequest('This flow\'s channel or group is not connected any more, so it can\'t be copied.');
    const blocks = d.blocks.map((x) => (x.type === 'message' ? { ...x, id: null, variants: (x.variants || []).map((v) => ({ ...v, id: null })) } : x));
    const f = await flows.cleanFlow(ws, { name: (q.name + ' (copy)').slice(0, 60), chat_id: d.chat.id, bot_id: q.connection_id, approve_mode: q.approve_mode, start_button: q.start_button, start_label: q.start_label, invite_link: null, blocks });
    return { ok: true, id: await create(ctx, f, false) };
  }, { auth: 'workspace', rate: [60, 600] });

  r.delete('/api/flows/:id', async (ctx) => {
    canEdit(ctx);
    const q = await flows.getOwn(ctx.workspace.id, int(ctx.params.id, 'Flow'));
    await db.tx(async (c) => {
      // Links already sent in Telegram keep working after the flow is deleted.
      await c.query('update links set step_id = null where step_id in (select id from sequence_steps where sequence_id = $1)', [q.id]);
      await c.query('delete from sequences where id = $1 and workspace_id = $2', [q.id, ctx.workspace.id]);
    });
    return { ok: true };
  }, { auth: 'workspace' });

  r.post('/api/flows/:id/invite-link', async (ctx) => {
    await on();
    canEdit(ctx);
    const ws = ctx.workspace;
    await billing.requirePlanFeature(ws, 'welcome_flows');
    const q = await flows.getOwn(ws.id, int(ctx.params.id, 'Flow'));
    const chat = await db.one("select * from connections where workspace_id = $1 and kind <> 'bot' and status <> 'removed' and tg_chat_id::text = $2", [ws.id, q.trigger_value || '']);
    const bot = await db.one("select * from connections where id = $1 and status <> 'removed'", [q.connection_id]);
    if (!chat || !bot) throw badRequest('Connect the channel or group and the bot first.');
    await flows.requireAdmin(bot, chat);
    let link;
    try {
      link = await tg.call(tokenOf(bot), 'createChatInviteLink', { chat_id: chat.tg_chat_id, name: q.name.slice(0, 32), creates_join_request: true });
    } catch (e) {
      throw httpError(502, 'Telegram did not make the link: ' + String(e.description || e.message).replace(/^Bad Request: /, '') + '.', 'telegram_error');
    }
    if (q.active) {
      const clash = await flows.liveClash(chat, link.invite_link, q.id);
      if (clash) throw httpError(409, 'Another live flow already uses that link.', 'flow_live_clash');
    }
    await db.query('update sequences set invite_link = $2, updated_at = now() where id = $1', [q.id, link.invite_link]);
    return { ok: true, invite_link: link.invite_link };
  }, { auth: 'workspace', rate: [20, 600] });
};

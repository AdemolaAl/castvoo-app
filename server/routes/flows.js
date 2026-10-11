'use strict';
/*
 * Bots (dashboard → 🤖 Bots): Welcome bots (the Welcome Flows) and Chat bots share these routes. The logic is in
 * services/flows.js and services/bots.js; bot-only extras (answers, invites, audience) are in routes/bots.js.
 * A body with start_type 'bot_start' saves a Chat bot (see services/flows.js AI_BOT_KEYS for the JSON).
 *   GET    /api/flows                    list, templates, the join-request meter, what the plan allows
 *   POST   /api/flows                    create (from a template or from blocks)
 *   GET    /api/flows/:id                one flow with its blocks
 *   PUT    /api/flows/:id                save name, settings and blocks
 *   POST   /api/flows/:id/toggle         live / draft ({ active, replace } — replace switches off the flow live on the same chat)
 *   POST   /api/flows/:id/duplicate      copy as a draft
 *   DELETE /api/flows/:id
 *   POST   /api/flows/check              is the bot an admin of the chat with "Add members"?
 *   POST   /api/flows/:id/invite-link    make the flow's own join link (createChatInviteLink, needs approval)
 *   POST   /api/flows/:id/audience       the "Tapped Start in <flow>" audience for Send a message (broadcast tie-in)
 *   POST   /api/flows/tests              send a test of the builder's flow to my own Telegram (services/flow-test.js)
 *   GET    /api/flows/tests/:tid         how that test is going   ·   POST /api/flows/tests/:tid/stop
 *   (Cas builds a flow from one sentence: POST /api/ai/flow in routes/ai.js)
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

async function create(ctx, f, active) { return createFlow(ctx.workspace, f, active); }

/* The save paths, shared with Cas Builder (routes/cas-builder.js), so a flow built by chatting is checked and saved
   exactly like one built by hand. */
async function createFlow(ws, f, active) {
  if (f.start_type === 'bot_start') return createBot(ws, f, active);
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

/* ---------- Chat bots (start_type 'bot_start') ---------- */
const BOTS = () => require('../services/bots');
const hasReferral = (f) => f.steps.some((s) => s.step_type === 'referral');
async function botLiveChecks(ws, f, exceptId, replace = null) {
  flows.assertNoPlaceholders(f.steps); // QA-4: template placeholders never go live
  const clash = await BOTS().botClash(ws, f.bot.id, f.start_code, f.is_default, exceptId);
  if (clash && !(replace && Number(replace) === Number(clash.id))) {
    throw httpError(409, clash.why === 'default'
      ? `"${clash.name}" already answers a plain Start on @${f.bot.username}. Switch that off first, or untick "Also answer a plain Start" here.`
      : `"${clash.name}" already uses the start link ?start=${f.start_code} on @${f.bot.username}. Pick another code, or switch that bot off first.`, 'bot_live_clash', { other: clash.id, other_name: clash.name });
  }
  await billing.assertBotSlots(ws, { exceptIds: [exceptId || 0, replace || 0], referral: hasReferral(f) });
}
async function createBot(ws, f, active) {
  await settings.requireFeature('bots', 'Chat bots are switched off for a moment. Please check back soon.');
  const drafts = (await db.one("select count(*)::int n from sequences where workspace_id = $1 and trigger_type = 'bot_start'", [ws.id])).n;
  if (drafts >= 200) throw httpError(402, 'That\'s a lot of bots! Delete a few you don\'t use, then make a new one.', 'limit_bots');
  if (active) await botLiveChecks(ws, f, 0);
  return db.tx(async (c) => {
    const q = (await c.query(`insert into sequences(workspace_id, connection_id, name, trigger_type, trigger_value, approve_join, approve_mode, start_button, start_label, is_default, bot_type, active)
      values ($1,$2,$3,'bot_start',$4,false,'after_welcome',false,'',$5,$6,$7) returning id`, [ws.id, f.bot.id, f.name, f.start_code, f.is_default, f.bot_type, !!active])).rows[0].id;
    await flows.saveSteps(c, ws.id, q, f.steps);
    return q;
  }).catch((e) => { if (e.code === '23505') throw httpError(409, 'Another bot went live with the same start link a moment ago. Save this one as a draft.', 'bot_live_clash'); throw e; });
}
async function updateBot(ws, q, f) {
  if (q.active) await botLiveChecks(ws, f, q.id);
  await db.tx(async (c) => {
    await c.query('update sequences set name = $2, connection_id = $3, trigger_value = $4, is_default = $5, bot_type = $6, updated_at = now() where id = $1', [q.id, f.name, f.bot.id, f.start_code, f.is_default, f.bot_type]);
    await flows.saveSteps(c, ws.id, q.id, f.steps);
  }).catch((e) => { if (e.code === '23505') throw httpError(409, 'Another bot already uses that start link. Pick another code.', 'bot_live_clash'); throw e; });
}
/** The saved bot as the builder sends it (for switching on and copying). */
async function botBody(ws, q) {
  const d = await flows.detail(ws, q);
  return { start_type: 'bot_start', name: d.name, bot_id: d.bot_id, start_code: d.start_code, is_default: d.is_default, steps: d.steps };
}
async function switchOnBot(ws, q, replace) {
  const f = await flows.cleanFlow(ws, await botBody(ws, q), { flowId: q.id });
  // A clash (same start link or plain Start) is refused unless the owner chose to switch to this bot (replace).
  const clash = replace ? await BOTS().botClash(ws, f.bot.id, f.start_code, f.is_default, q.id) : null;
  await botLiveChecks(ws, f, q.id, clash ? clash.id : null);
  await db.tx(async (c) => {
    if (clash) await c.query('update sequences set active = false, updated_at = now() where id = $1 and workspace_id = $2', [clash.id, ws.id]);
    await c.query('update sequences set active = true, paused_by_plan = false, updated_at = now() where id = $1', [q.id]);
  }).catch((e) => { if (e.code === '23505') throw httpError(409, 'Another bot went live with that start link a moment ago. Refresh and try again.', 'bot_live_clash'); throw e; });
  return { ok: true, active: true, replaced: clash ? clash.id : null };
}

/** A template's steps, ready to save: Link buttons without a link yet are left out (the builder shows them). */
function templateBody(t, b) {
  return {
    name: b.name || t.name, chat_id: b.chat_id, bot_id: b.bot_id, approve_mode: b.approve_mode || t.approve_mode, start_button: b.start_button ?? t.start_button, start_label: b.start_label || t.start_label || '',
    steps: t.steps.map((x) => ({ ...x, buttons: (x.buttons || []).filter((y) => y.kind === 'reply' || y.url) })),
  };
}

/** Save a checked flow `f` over the saved flow `q` (a live flow stays live: its chat and bot must be ready). */
async function updateFlow(ws, q, f) {
  const isBot = q.trigger_type === 'bot_start';
  if (isBot !== (f.start_type === 'bot_start')) throw badRequest(isBot ? 'This is a Chat bot. It starts when someone taps Start in your bot.' : 'This is a Welcome bot. It starts when someone asks to join your channel.');
  if (isBot) return updateBot(ws, q, f);
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
}

/** Switch a saved flow on, with every check (today's plan, placeholders, bot admin, one live flow per chat). */
async function switchOn(ws, q, replace) {
  if (q.trigger_type === 'bot_start') return switchOnBot(ws, q, replace);
  const chat = await db.one("select * from connections where workspace_id = $1 and kind <> 'bot' and status <> 'removed' and tg_chat_id::text = $2", [ws.id, q.trigger_value || '']);
  if (!chat) throw badRequest('This flow\'s channel or group is not connected any more. Pick another one and save first.');
  const bot = await db.one("select * from connections where id = $1 and status <> 'removed'", [q.connection_id]);
  // The plan may have changed since it was saved (e.g. dropped to Free): check the steps against today's plan.
  const steps = await flows.loadSteps(q.id);
  const f = await flows.cleanFlow(ws, { name: q.name, chat_id: chat.id, bot_id: bot.id, approve_mode: q.approve_mode, start_button: q.start_button, start_label: q.start_label, invite_link: q.invite_link, steps: flows.stepsToV2(steps) }, { flowId: q.id });
  flows.assertNoPlaceholders(f.steps); // QA-4
  await flows.requireAdmin(bot, chat);
  const clash = await flows.liveClash(chat, q.invite_link, q.id);
  if (clash && !replace) throw httpError(409, `"${clash.name}" is live on ${chat.title} now. Switch to this flow instead?`, 'flow_live_clash', { other: clash.id, other_name: clash.name });
  await flows.assertCanGoLive(ws, q.id, clash ? clash.id : 0);
  await db.tx(async (c) => {
    if (clash) await c.query('update sequences set active = false, updated_at = now() where id = $1 and workspace_id = $2', [clash.id, ws.id]);
    await c.query('update sequences set active = true, paused_by_plan = false, updated_at = now() where id = $1', [q.id]);
  }).catch((e) => { if (e.code === '23505') throw httpError(409, 'Another flow went live there a moment ago. Refresh and try again.', 'flow_live_clash'); throw e; });
  return { ok: true, active: true, replaced: clash ? clash.id : null };
}

const templateOut = (t) => ({ key: t.key, name: t.name, emoji: t.emoji, about: t.about, approve_mode: t.approve_mode, start_button: t.start_button, start_label: t.start_label || '', steps: t.steps, blocks: flows.templateBlocks(t) });

module.exports = (r) => {
  r.get('/api/flows', async (ctx) => {
    const ws = ctx.workspace;
    const [list, plan, meter, conns, open, startable] = await Promise.all([
      flows.summary(ws.id), billing.planState(ws), billing.joinMeter(ws),
      db.many("select id, kind, username, title, status from connections where workspace_id = $1 and status <> 'removed' order by id", [ws.id]),
      db.one("select count(*)::int n from join_requests where workspace_id = $1 and status = 'pending'", [ws.id]),
      flows.startable(ws.id),
    ]);
    const BOT = BOTS();
    const [chatbots, ans, live] = await Promise.all([BOT.summary(ws.id), billing.answersMeter(ws), billing.liveBots(ws.id)]);
    return {
      flows: list,
      chatbots,
      bot_templates: BOT.TEMPLATES,
      bot_usage: { live, answers: ans, referral_live: await billing.liveReferralBots(ws.id) },
      bot_brand_text: BOT.BOT_BRAND_TEXT,
      ownership: await BOT.ownershipWarnings(ws.id),
      templates: flows.TEMPLATES.map(templateOut),
      startable,
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
      body = b.blocks || b.steps ? { ...b, approve_mode: b.approve_mode || t.approve_mode } : templateBody(t, b);
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

  /* "📲 Send a test to my Telegram" (services/flow-test.js): the builder's flow as it is now, nothing saved or counted. */
  r.post('/api/flows/tests', async (ctx) => {
    return { ok: true, test: await require('../services/flow-test').create(ctx.workspace, ctx.user, ctx.body || {}) };
  }, { auth: 'workspace', rate: [30, 600] });

  r.get('/api/flows/tests/:tid', async (ctx) => {
    return { test: await require('../services/flow-test').get(ctx.user, int(ctx.params.tid, 'Test')) };
  }, { auth: 'workspace' });

  r.post('/api/flows/tests/:tid/stop', async (ctx) => {
    return { ok: true, test: await require('../services/flow-test').stop(ctx.user, int(ctx.params.tid, 'Test')) };
  }, { auth: 'workspace' });

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
    const f = await flows.cleanFlow(ws, ctx.body || {}, { flowId: q.id });
    await updateFlow(ws, q, f);
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
    return switchOn(ws, q, !!ctx.body.replace);
  }, { auth: 'workspace' });

  r.post('/api/flows/:id/duplicate', async (ctx) => {
    await on();
    canEdit(ctx);
    const ws = ctx.workspace;
    const q = await flows.getOwn(ws.id, int(ctx.params.id, 'Flow'));
    if (q.trigger_type === 'bot_start') {
      const body = await botBody(ws, q);
      const copy = { ...body, name: (q.name + ' (copy)').slice(0, 60), start_code: (body.start_code + '_copy').slice(0, 64), is_default: false,
        steps: body.steps.map((x) => ({ ...x, id: null, variants: [] })) };
      return { ok: true, id: await create(ctx, await flows.cleanFlow(ws, copy), false) };
    }
    const d = await flows.detail(ws, q);
    if (!d.chat) throw badRequest('This flow\'s channel or group is not connected any more, so it can\'t be copied.');
    const steps = d.steps.map((x) => ({ ...x, id: null, variants: (x.variants || []).map((v) => ({ ...v, id: null })) }));
    const f = await flows.cleanFlow(ws, { name: (q.name + ' (copy)').slice(0, 60), chat_id: d.chat.id, bot_id: q.connection_id, approve_mode: q.approve_mode, start_button: q.start_button, start_label: q.start_label, invite_link: null, steps });
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

  /**
   * Broadcast tie-in: the audience "Tapped Start in <flow name>" (made once, then reused) for Send a message.
   * Its only rule is flow_started, so it works on every plan that can broadcast (audiences are not needed).
   */
  r.post('/api/flows/:id/audience', async (ctx) => {
    canEdit(ctx, 'send broadcasts');
    const ws = ctx.workspace;
    await settings.requireFeature('broadcasts');
    await billing.requirePlanFeature(ws, 'broadcasts');
    const q = await flows.getOwn(ws.id, int(ctx.params.id, 'Flow'));
    if (q.trigger_type === 'bot_start') return require('./bots').botAudience(ws, q);
    const name = ('Tapped Start in ' + q.name).slice(0, 60);
    const rules = [{ field: 'flow_started', value: Number(q.id), name: q.name.slice(0, 60) }];
    let seg = await db.one("select id from segments where workspace_id = $1 and rules @> $2::jsonb and jsonb_array_length(rules) = 1", [ws.id, JSON.stringify([{ field: 'flow_started', value: Number(q.id) }])]);
    if (seg) await db.query('update segments set name = $2, rules = $3 where id = $1', [seg.id, name, JSON.stringify(rules)]);
    else seg = await db.one('insert into segments(workspace_id, name, rules) values ($1,$2,$3) returning id', [ws.id, name, JSON.stringify(rules)]);
    return { ok: true, segment_id: seg.id, bot_id: q.connection_id, name, count: await flows.startedCount(ws.id, q.id, q.connection_id) };
  }, { auth: 'workspace', rate: [60, 600] });

  r.post('/api/flows/:id/invite-link', async (ctx) => {
    await on();
    canEdit(ctx);
    const ws = ctx.workspace;
    await billing.requirePlanFeature(ws, 'welcome_flows');
    const q = await flows.getOwn(ws.id, int(ctx.params.id, 'Flow'));
    if (q.trigger_type === 'bot_start') throw badRequest('A Chat bot has its own start link already (t.me/yourbot?start=...).');
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
module.exports.createFlow = createFlow;
module.exports.updateFlow = updateFlow;
module.exports.switchOn = switchOn;

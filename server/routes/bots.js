'use strict';
/*
 * Bots (dashboard → 🤖 Bots). Saving, switching on, copying and deleting a bot use the flow routes (routes/flows.js,
 * start_type 'bot_start' for a Chat bot). These are the bot-only extras (services/bots.js):
 *   GET  /api/bots                     every bot (Welcome bots and Chat bots), the ready templates, plan limits and usage
 *   POST /api/bots/check-join          can the bot check who joined this channel? (it must be an admin there)
 *   GET  /api/bots/:id/answers         the Leads view: answers to "Ask a question" steps, one row per person
 *                                      (owner and setup helper only; other roles get counts, restricted: true)
 *   GET  /api/bots/:id/answers.csv     the same as a CSV file (owner; Starter and up)
 *   GET  /api/bots/:id/referrals       the invite leaderboard and the invites that did not count (with why)
 *   POST /api/bots/:id/audience        "Started <bot>": the audience to broadcast to people who started a Chat bot
 */

const db = require('../db');
const settings = require('../services/settings');
const billing = require('../services/billing');
const flows = require('../services/flows');
const bots = require('../services/bots');
const { int, httpError, badRequest, notFound } = require('../lib/util');
const { wsCan } = require('../permissions');

async function chatBot(ctx) {
  const q = await flows.getOwn(ctx.workspace.id, int(ctx.params.id, 'Bot'));
  if (q.trigger_type !== 'bot_start') throw httpError(404, 'That Chat bot was not found.', 'not_found');
  return q;
}

/**
 * The audience "Started <bot name>" (made once, then reused) for Send a message. Its only rule is bot_started, so it
 * works on every plan that can broadcast (the Audiences feature is not needed). Telegram's rule: only people who
 * started the bot and did not stop or block it are reached (subscribers with status active).
 */
async function botAudience(ws, q) {
  await settings.requireFeature('broadcasts');
  await billing.requireBotType(ws, 'broadcast');
  await billing.requirePlanFeature(ws, 'broadcasts');
  const l = await billing.limits(ws);
  const u = await billing.usage(ws.id);
  const cap = billing.withGrace(l.bots.max_bot_subscribers);
  // Over the limit + 10%: on Scale the 402 offers a subscriber pack; above the most packs, "talk to us".
  if (cap !== billing.UNLIMITED && u.subscribers > cap) throw await billing.subscriberLimitError(ws, l, u.subscribers, l.bots.max_bot_subscribers);
  const name = ('Started ' + q.name).slice(0, 60);
  const rules = [{ field: 'bot_started', value: Number(q.id), name: q.name.slice(0, 60) }];
  let seg = await db.one('select id from segments where workspace_id = $1 and rules @> $2::jsonb and jsonb_array_length(rules) = 1', [ws.id, JSON.stringify([{ field: 'bot_started', value: Number(q.id) }])]);
  if (seg) await db.query('update segments set name = $2, rules = $3 where id = $1', [seg.id, name, JSON.stringify(rules)]);
  else seg = await db.one('insert into segments(workspace_id, name, rules) values ($1,$2,$3) returning id', [ws.id, name, JSON.stringify(rules)]);
  return { ok: true, segment_id: seg.id, bot_id: q.connection_id, name, count: await bots.startedCount(q.id, q.connection_id) };
}

module.exports = (r) => {
  r.get('/api/bots', async (ctx) => {
    const ws = ctx.workspace;
    const [welcome, chat, l, answers, live] = await Promise.all([flows.summary(ws.id), bots.summary(ws.id), billing.limits(ws), billing.answersMeter(ws), billing.liveBots(ws.id)]);
    return {
      welcome_bots: welcome, chat_bots: chat, templates: bots.TEMPLATES, welcome_templates: flows.TEMPLATES.map((t) => ({ key: t.key, name: t.name, emoji: t.emoji, about: t.about })),
      limits: l.bots, usage: { live, answers, referral_live: await billing.liveReferralBots(ws.id) }, brand_text: bots.BOT_BRAND_TEXT,
      ownership: await bots.ownershipWarnings(ws.id),
    };
  }, { auth: 'workspace' });

  r.post('/api/bots/check-join', async (ctx) => {
    const ws = ctx.workspace;
    const bot = await db.one("select * from connections where id = $1 and workspace_id = $2 and kind = 'bot' and status <> 'removed'", [int(ctx.body.bot_id, 'Bot'), ws.id]);
    const chat = await db.one("select * from connections where id = $1 and workspace_id = $2 and kind <> 'bot' and status <> 'removed'", [int(ctx.body.chat_id, 'Channel or group'), ws.id]);
    if (!bot || !chat) throw notFound('That bot or channel');
    return bots.checkCanCheck(bot, chat);
  }, { auth: 'workspace', rate: [60, 60] });

  r.get('/api/bots/:id/answers', async (ctx) => {
    const q = await chatBot(ctx);
    const out = await bots.answers(ctx.workspace, q.id, { limit: 500 });
    const l = await billing.limits(ctx.workspace);
    // Leads are personal data (names, phones, emails): only the owner and the setup helper see them (ws.leads).
    // Other team members get the counts and the questions, never the answers.
    if (!wsCan(ctx.member.role, 'ws.leads', ctx.workspace)) return { questions: out.questions, people: [], total: out.total, hidden: out.hidden, meter: out.meter, export: l.bots.lead_export, restricted: true };
    return { ...out, export: l.bots.lead_export };
  }, { auth: 'workspace' });

  r.get('/api/bots/:id/answers.csv', async (ctx) => {
    if (ctx.member.role !== 'owner') throw httpError(403, 'Only the workspace owner can download leads.', 'forbidden');
    const ws = ctx.workspace;
    const q = await chatBot(ctx);
    const l = await billing.limits(ws);
    if (l.bots.lead_export === 'none') {
      const p = await billing.planForBots((b) => b.lead_export !== 'none');
      throw httpError(402, `Downloading your leads as a CSV file is ${p ? `on the ${p.name} plan and up` : 'on a bigger plan'}. Upgrade to use it.`, 'plan_bot_type', { bot_type: 'lead_questions', plan: p ? p.code : null });
    }
    const csv = await bots.answersCsv(ws, q.id);
    const file = 'castvoo-leads-' + String(q.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '.csv';
    ctx.send(200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${file || 'castvoo-leads.csv'}"`, 'Cache-Control': 'no-store' });
  }, { auth: 'workspace', rate: [20, 3600] });

  r.get('/api/bots/:id/referrals', async (ctx) => {
    const q = await chatBot(ctx);
    return bots.leaderboard(q.id);
  }, { auth: 'workspace' });

  r.post('/api/bots/:id/audience', async (ctx) => {
    if (ctx.member.role === 'drafter') throw httpError(403, 'Your role can\'t send broadcasts. Ask the workspace owner.', 'forbidden');
    const q = await chatBot(ctx);
    if (!q) throw badRequest('That bot was not found.');
    return botAudience(ctx.workspace, q);
  }, { auth: 'workspace', rate: [60, 600] });
};
module.exports.botAudience = botAudience;

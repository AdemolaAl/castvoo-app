'use strict';
/*
 * The customer side of support chat. The AI support team (services/support-ai.js) answers in the background;
 * GET /api/support shows only bubbles whose visible_at has passed, plus `typing` while an agent is "typing".
 */

const db = require('../db');
const rl = require('../lib/ratelimit');
const settings = require('../services/settings');
const support = require('../services/support');
const supportAi = require('../services/support-ai');
const images = require('../services/support-images');
const { httpError, int, notFound } = require('../lib/util');

const IMG_BASE = '/api/support/attachments';
/** The chat's footer and options the browser needs (Admin → Support AI). */
function chatOptions(c) {
  return { images: c.customer_images !== false, max_images: images.MAX_PER_MESSAGE, max_mb: images.MAX / 1048576, powered_by: c.powered_by !== false ? (c.powered_by_text || 'Powered by Replyvoo') : null };
}

async function view(ctx) {
  const reply_time = (await settings.get('support')).reply_time;
  const aiOn = await supportAi.isOn();
  const team = aiOn ? (await supportAi.personas({ activeOnly: true })).slice(0, 4).map(supportAi.publicPersona) : [];
  const chat = chatOptions(await supportAi.conf());
  const t = await support.latestThread(ctx.user.id, ctx.workspace.id);
  if (!t) return { thread: null, messages: [], reply_time, ai: { on: aiOn, team }, typing: null, chat };
  const rows = await db.many(`select m.id, m.author_type, m.author_name, m.body, m.persona_id, m.visible_at as created_at, p.updated_at as p_updated
    from support_messages m left join support_personas p on p.id = m.persona_id
    where m.thread_id = $1 and not m.internal and m.visible_at <= now() order by m.visible_at, m.id`, [t.id]);
  const att = await images.forMessages(rows.map((m) => m.id));
  const messages = rows.map(({ p_updated, ...m }) => ({ ...m, avatar: m.persona_id ? supportAi.avatarUrl({ id: m.persona_id, updated_at: p_updated }) : null,
    attachments: (att.get(Number(m.id)) || []).map((a) => images.publicRow(a, IMG_BASE)) }));
  if (t.unread_user) {
    const pending = await db.one("select 1 from support_messages where thread_id = $1 and visible_at > now() limit 1", [t.id]);
    if (!pending) await db.query('update support_threads set unread_user = false where id = $1', [t.id]);
  }
  const typing = await supportAi.typingFor(t);
  const persona = t.ai_persona_id ? await db.one('select * from support_personas where id = $1', [t.ai_persona_id]) : null;
  return {
    thread: { id: t.id, status: t.status, with_human: !!(t.needs_human || t.ai_paused || !t.ai_enabled), agent: persona ? supportAi.publicPersona(persona) : null },
    messages, reply_time, ai: { on: aiOn && t.ai_enabled && !t.ai_paused, team }, typing, chat,
  };
}

module.exports = (r) => {
  r.get('/api/support', view, { auth: 'workspace' });

  r.post('/api/support', async (ctx) => {
    await settings.requireFeature('support_chat', 'Support chat is switched off. Email us instead.');
    // Messages per minute per person (Admin → Support AI). Bursts beyond it are refused kindly; nothing is lost.
    const c = await supportAi.conf();
    // Shared across instances (SEC-5c): every message can start several paid model rounds.
    const lim = await rl.hitShared('support-min:' + ctx.user.id, Math.max(2, Number(c.msgs_per_min) || 8), 60);
    if (!lim.ok) throw httpError(429, 'You are sending messages very fast. Wait a few seconds, then send the rest.', 'rate_limited', { retry_after: Math.min(lim.retryAfter, 20) });
    if (Array.isArray(ctx.body.attachments) && ctx.body.attachments.length && c.customer_images === false) throw httpError(403, 'Images are switched off in the support chat right now.', 'images_off');
    const id = await support.userMessage(ctx.user, ctx.workspace.id, ctx.body.body, ctx.body.attachments);
    return { ok: true, thread_id: id };
  }, { auth: 'workspace', rate: [30, 600], shared: true });

  /**
   * Attach an image to the next message: the raw file is the body (JPG, PNG or WEBP, up to 10 MB). Send its id in
   * POST /api/support { attachments: [id] }. Up to 3 per message; 40 a day per person.
   */
  r.post('/api/support/attachments', async (ctx) => {
    await settings.requireFeature('support_chat', 'Support chat is switched off. Email us instead.');
    const c = await supportAi.conf();
    if (c.customer_images === false) throw httpError(403, 'Images are switched off in the support chat right now. Describe the problem in words, or email us the screenshot.', 'images_off');
    if (!(await rl.hitShared('support-img-day:' + ctx.user.id, 40, 86400)).ok) throw httpError(429, 'That\'s a lot of images for one day. Describe the rest in words, or email us.', 'rate_limited');
    const unsent = await db.one("select count(*)::int n from support_attachments where uploader_user_id = $1 and uploader_type = 'user' and message_id is null and created_at > now() - interval '1 day'", [ctx.user.id]);
    if (unsent.n >= 12) throw httpError(429, 'Send the images you already added first.', 'rate_limited');
    const open = await support.openThread(ctx.user.id, ctx.workspace.id);
    const a = await images.save(ctx, { threadId: open ? open.id : null, workspaceId: ctx.workspace.id, userId: ctx.user.id, type: 'user' });
    return { attachment: images.publicRow(a, IMG_BASE) };
  }, { auth: 'workspace', stream: true, rate: [20, 600], shared: true });

  /** An image in your own support chat (or one you just uploaded). Nobody else's. */
  r.get('/api/support/attachments/:id', async (ctx) => {
    const a = await images.forCustomer(int(ctx.params.id, 'Image'), ctx.user.id);
    if (!a || !(await images.stream(ctx, a))) throw notFound('That image');
  }, { auth: 'user' });
};

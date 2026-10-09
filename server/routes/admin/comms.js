'use strict';
/* Admin → Support inbox, Emails, Cas knowledge, Cas AI test. */

const db = require('../../db');
const support = require('../../services/support');
const supportAi = require('../../services/support-ai');
const images = require('../../services/support-images');
const email = require('../../services/email');
const ai = require('../../services/ai');
const llm = require('../../services/llm');
const { audit } = require('../../services/audit');
const { str, int, notFound, badRequest, bool } = require('../../lib/util');

/* The name customers see on a staff reply: first name only (PRODUCT-FACTS). A staff account with no real name has
   the start of its email as its name (for example "owner"), so that shows as "Castvoo team" instead. */
function publicStaffName(u) {
  const name = String((u && u.name) || '').trim();
  const local = String((u && u.email) || '').split('@')[0].toLowerCase();
  if (!name || name.toLowerCase() === local) return 'Castvoo team';
  return name.split(/\s+/)[0].slice(0, 60);
}

module.exports = (r) => {
  /* ---------- Support ---------- */
  r.get('/api/admin/support', async (ctx) => {
    const threads = await support.listThreads({ status: ctx.query.status || 'open', q: ctx.query.q, assigned: ctx.query.mine === '1' ? ctx.user.id : null, limit: 100 });
    const counts = await db.one(`select count(*) filter (where status = 'open')::int open, count(*) filter (where status = 'pending')::int pending, count(*) filter (where unread_staff and status <> 'closed')::int unread,
      count(*) filter (where needs_human and status <> 'closed')::int human from support_threads`);
    return { threads, counts };
  }, { staff: 'support.view' });

  r.get('/api/admin/support/:id', async (ctx) => {
    const id = int(ctx.params.id, 'Conversation');
    const t = await support.getThread(id);
    await db.query('update support_threads set unread_staff = false where id = $1', [id]);
    const staff = await db.many('select id, name from users where staff_role is not null and status = $1 order by name', ['active']);
    // What the AI did on this conversation (staff only; inputs and outputs are already redacted).
    const tool_log = await db.many('select id, tool, input, output, ok, ms, created_at from support_ai_tool_log where thread_id = $1 order by id desc limit 60', [id]);
    const persona = t.thread.ai_persona_id ? await db.one('select * from support_personas where id = $1', [t.thread.ai_persona_id]) : null;
    return { ...t, staff, tool_log, agent: supportAi.publicPersona(persona), ai_on: await supportAi.isOn() };
  }, { staff: 'support.view' });

  /** AI on this conversation: takeover (pause, assign to me), handback (AI answers again), on / off. */
  r.post('/api/admin/support/:id/ai', async (ctx) => {
    const id = int(ctx.params.id, 'Conversation');
    const action = String(ctx.body.action || '');
    await supportAi.staffAction(id, action, ctx.user);
    await audit(ctx, 'support.ai_' + action, 'support:' + id, {});
    return { ok: true };
  }, { staff: 'support.reply' });

  r.post('/api/admin/support/:id/reply', async (ctx) => {
    const id = int(ctx.params.id, 'Conversation');
    await support.staffReply(id, { authorUserId: ctx.user.id, authorName: publicStaffName(ctx.user), body: ctx.body.body, internal: bool(ctx.body.internal), attachments: ctx.body.attachments });
    if (ctx.body.close) await support.setStatus(id, 'closed');
    return { ok: true };
  }, { staff: 'support.reply' });

  /** Staff attach an image to their next reply (raw body, JPG / PNG / WEBP up to 10 MB). */
  r.post('/api/admin/support/:id/attachments', async (ctx) => {
    const t = await db.one('select id, workspace_id from support_threads where id = $1', [int(ctx.params.id, 'Conversation')]);
    if (!t) throw notFound('That conversation');
    const a = await images.save(ctx, { threadId: t.id, workspaceId: t.workspace_id, userId: ctx.user.id, type: 'staff' });
    return { attachment: images.publicRow(a, '/api/admin/support/attachments') };
  }, { staff: 'support.reply', stream: true, rate: [60, 600] });

  /** Any image in a support conversation, for the team (customer screenshots, AI handoff notes, staff replies). */
  r.get('/api/admin/support/attachments/:id', async (ctx) => {
    const a = await db.one('select * from support_attachments where id = $1', [int(ctx.params.id, 'Image')]);
    if (!a || !(await images.stream(ctx, a))) throw notFound('That image');
  }, { staff: 'support.view' });

  r.post('/api/admin/support/:id/status', async (ctx) => support.setStatus(int(ctx.params.id, 'Conversation'), String(ctx.body.status || '')), { staff: 'support.reply' });

  r.post('/api/admin/support/:id/assign', async (ctx) => {
    const to = ctx.body.user_id ? int(ctx.body.user_id, 'Team member') : null;
    if (to && !(await db.one('select 1 from users where id = $1 and staff_role is not null', [to]))) throw badRequest('Pick someone on the team.');
    await db.query('update support_threads set assigned_to = $2 where id = $1', [int(ctx.params.id, 'Conversation'), to]);
    return { ok: true };
  }, { staff: 'support.reply' });

  /** Cas drafts a reply from the knowledge base and the customer's account. Staff review it before sending. */
  r.post('/api/admin/support/:id/suggest', async (ctx) => {
    const { thread, messages } = await support.getThread(int(ctx.params.id, 'Conversation'), { includeInternal: false });
    const ws = thread.workspace_id ? await db.one('select * from workspaces where id = $1', [thread.workspace_id]) : null;
    const facts = ws ? await ai.workspaceFacts(ws) : '';
    const system = await ai.systemPrompt({ extra: `${facts}\n# Your job now\nYou are drafting a reply for the Castvoo support team to send to a customer. Be kind, specific and short (under 120 words). Answer only from the knowledge above and the account facts. If you are not sure, say what the team will check and by when. Sign off as "${(ctx.user.name || 'The Castvoo team').split(' ')[0]} from Castvoo". Reply with the message only.` });
    const convo = messages.slice(-12).map((m) => `${m.author_type === 'user' ? 'Customer' : 'Castvoo team'}: ${m.body}`).join('\n\n');
    const res = await ai.complete({ system, messages: [{ role: 'user', content: `Customer: ${thread.user_name} (plan ${thread.plan_code || 'none'}, ${thread.plan_status || ''}).\n\nConversation so far:\n${convo}\n\nWrite the next reply.` }], maxTokens: 500, temperature: 0.4 });
    await db.query("insert into ai_usage(workspace_id, user_id, kind, writes, input_tokens, output_tokens, provider, model, cost_usd) values (0, $1, 'support_suggest', 0, $2, $3, $4, $5, $6)", [ctx.user.id, res.usage.input_tokens || 0, res.usage.output_tokens || 0, res.usage.provider || 'anthropic', res.usage.model || null, res.usage.cost_usd || 0]);
    return { text: res.text };
  }, { staff: 'support.reply', rate: [60, 600] });

  /* ---------- Emails ---------- */
  r.get('/api/admin/emails', async () => {
    const overrides = new Set((await db.many('select key from email_templates')).map((x) => x.key));
    const sent = await db.many("select template, count(*)::int n from email_log where status = 'sent' and created_at > now() - interval '30 days' group by 1");
    const sentMap = Object.fromEntries(sent.map((x) => [x.template, x.n]));
    return { emails: Object.entries(email.TEMPLATES).map(([key, t]) => ({ key, name: t.name, when: t.when, category: t.category, subject: t.subject, edited: overrides.has(key), sent_30d: sentMap[key] || 0 })) };
  }, { staff: 'overview.view' });

  r.get('/api/admin/emails/:key', async (ctx) => {
    const base = email.TEMPLATES[ctx.params.key];
    if (!base) throw notFound('That email');
    const cur = await email.getTemplate(ctx.params.key);
    return { key: ctx.params.key, name: base.name, when: base.when, category: base.category, vars: base.vars, current: { subject: cur.subject, preheader: cur.preheader, body: cur.body, text: cur.text }, original: { subject: base.subject, preheader: base.preheader, body: base.body, text: base.text } };
  }, { staff: 'overview.view' });

  function cleanTemplate(b) {
    return { subject: str(b.subject, 'Subject', { min: 2, max: 200 }), preheader: str(b.preheader, 'Preview text', { max: 300, required: false }) || '', body: str(b.body, 'Body', { min: 10, max: 60000, trim: false }), text: str(b.text, 'Plain text', { max: 20000, required: false, trim: false }) || '' };
  }

  r.put('/api/admin/emails/:key', async (ctx) => {
    if (!email.TEMPLATES[ctx.params.key]) throw notFound('That email');
    const t = cleanTemplate(ctx.body);
    await db.query(`insert into email_templates(key, subject, preheader, body, text_body, updated_by, updated_at) values ($1,$2,$3,$4,$5,$6, now())
      on conflict (key) do update set subject = excluded.subject, preheader = excluded.preheader, body = excluded.body, text_body = excluded.text_body, updated_by = excluded.updated_by, updated_at = now()`,
    [ctx.params.key, t.subject, t.preheader, t.body, t.text, ctx.user.id]);
    await audit(ctx, 'email.save', 'email:' + ctx.params.key, { subject: t.subject });
    return { ok: true };
  }, { staff: 'emails.edit' });

  r.post('/api/admin/emails/:key/reset', async (ctx) => {
    await db.query('delete from email_templates where key = $1', [ctx.params.key]);
    await audit(ctx, 'email.reset', 'email:' + ctx.params.key, {});
    return { ok: true };
  }, { staff: 'emails.edit' });

  function sampleVars(key) {
    const base = email.TEMPLATES[key];
    const S = { code: '482913', trial_end_date: '10 October 2026', guide_url: '#', inviter_name: 'Ejiro', workspace_name: 'Zedapex', invite_url: '#', role_name: 'Support', admin_url: '#',
      plan_name: 'Growth', plan_price: '$49.00', wallet_balance: '$120.00', topup_url: '#', amount: '$100.00', period_start: '3 October 2026', period_end: '2 November 2026', receipt_id: 'cv_sample123',
      billing_url: '#', renewal_date: '2 November 2026', bonus: '$0.00', method: 'Paystack', new_balance: '$220.00', wallet_url: '#', coin: 'USDT', txid: 'a1b2c3d4e5f6a7b8c9d0', reference: 'FT2610081234567', reason: 'The transaction was not found on the TRON network.',
      referral_name: 'Tunde', settle_date: '2 November 2026', referrals_url: '#', address: 'TQ7mZ2r9VbKx4LwN8pHc3eYd6sFa1JuXo5', agent_name: 'Ada', message_preview: 'Hi! I checked your bot and it is connected now.',
      support_url: '#', broadcast_title: 'Weekend sale', delivered: '9,640', failed: '12', clicks: '1,104', report_url: '#', limit_name: 'subscribers', upgrade_url: '#', download_url: '#',
      connect_url: '#', broadcast_url: '#', drips_url: '#', train_url: '#', pricing_url: '#', coupon_code: 'COMEBACK20', coupon_percent: '20', coupon_expiry: '17 October 2026', reply_url: '#', first_name: 'Ejiro', unsubscribe_url: '#', old_price: '$49.00', new_price: '$59.00', billing_period: 'month', start_date: '2 November 2026',
      used: '412', limit: '500', reset_date: '1 November 2026', plans_url: '#', welcomed: '238',
      delete_date: '7 November 2026', days_left: '30', login_url: '#', helper_name: 'Tunde', helper_contact: 'tu•••e@gmail.com', owner_name: 'Ejiro', team_url: '#' };
    return Object.fromEntries([...base.vars, 'first_name', 'unsubscribe_url'].map((v) => [v, S[v] ?? '']));
  }

  r.post('/api/admin/emails/:key/preview', async (ctx) => {
    const base = email.TEMPLATES[ctx.params.key];
    if (!base) throw notFound('That email');
    const t = ctx.body && ctx.body.body ? { ...base, ...cleanTemplate(ctx.body) } : undefined;
    const out = await email.render(ctx.params.key, sampleVars(ctx.params.key), t);
    return { subject: out.subject, html: out.html, text: out.text };
  }, { staff: 'overview.view' });

  r.post('/api/admin/emails/:key/test', async (ctx) => {
    if (!email.TEMPLATES[ctx.params.key]) throw notFound('That email');
    if (!ctx.user.email) throw badRequest('Add an email to your account first.');
    const ok = await email.send(ctx.params.key, { email: ctx.user.email, name: ctx.user.name }, sampleVars(ctx.params.key));
    return { ok, to: ctx.user.email };
  }, { staff: 'emails.edit', rate: [20, 600] });

  /* ---------- Cas knowledge ---------- */
  r.get('/api/admin/knowledge', async () => ({ articles: await db.many('select k.*, u.name as updated_by_name from knowledge k left join users u on u.id = k.updated_by order by k.id') }), { staff: 'overview.view' });

  r.post('/api/admin/knowledge', async (ctx) => {
    const row = await db.one('insert into knowledge(title, body, active, updated_by) values ($1,$2,$3,$4) returning id',
      [str(ctx.body.title, 'Title', { min: 2, max: 120 }), str(ctx.body.body, 'Text', { min: 5, max: 8000 }), ctx.body.active === undefined ? true : bool(ctx.body.active), ctx.user.id]);
    await audit(ctx, 'knowledge.create', 'knowledge:' + row.id, { title: ctx.body.title });
    return { ok: true, id: row.id };
  }, { staff: 'knowledge.edit' });

  r.put('/api/admin/knowledge/:id', async (ctx) => {
    const id = int(ctx.params.id, 'Article');
    // edited = true: Castvoo's defaults never overwrite an article the team changed (seed.js syncKnowledge).
    const row = await db.one('update knowledge set title = $2, body = $3, active = $4, updated_by = $5, updated_at = now(), edited = true where id = $1 returning id',
      [id, str(ctx.body.title, 'Title', { min: 2, max: 120 }), str(ctx.body.body, 'Text', { min: 5, max: 8000 }), ctx.body.active === undefined ? true : bool(ctx.body.active), ctx.user.id]);
    if (!row) throw notFound('That article');
    await audit(ctx, 'knowledge.update', 'knowledge:' + id, { title: ctx.body.title });
    return { ok: true };
  }, { staff: 'knowledge.edit' });

  r.delete('/api/admin/knowledge/:id', async (ctx) => {
    // A deleted default is remembered, so a later deploy does not bring it back.
    const gone = await db.one('delete from knowledge where id = $1 returning key', [int(ctx.params.id, 'Article')]);
    if (gone && gone.key) await db.query('insert into knowledge_removed(key) values ($1) on conflict do nothing', [gone.key]);
    await audit(ctx, 'knowledge.delete', 'knowledge:' + ctx.params.id, {});
    return { ok: true };
  }, { staff: 'knowledge.edit' });

  /* ---------- Cas AI provider (Claude direct, OpenRouter or OpenAI) ---------- */
  /** Which provider and model Cas uses. The key is never returned: only where it comes from and its last 4 characters. */
  r.get('/api/admin/ai/provider', async () => ({ ai: await llm.publicInfo() }), { staff: 'overview.view' });

  /**
   * Change the provider, OpenRouter model, fallbacks or key. The key is stored encrypted and only used for the
   * endpoint it was saved for; switching provider clears it, so it has to be pasted again. Owner and Admin only.
   */
  r.put('/api/admin/ai/provider', async (ctx) => {
    const v = await llm.validate(ctx.body || {});
    if (v.changed.length || v.key) {
      await db.query('insert into settings(key, value, updated_at) values ($1,$2, now()) on conflict (key) do update set value = excluded.value, updated_at = now()', ['ai_provider', JSON.stringify(v.value)]);
      require('../../services/settings').bust();
      // Field names and what happened to the key; never the key or its ciphertext.
      await audit(ctx, 'settings.ai_provider', 'settings:ai_provider', { changed: v.changed, key: v.key || 'unchanged', provider: v.value.provider || 'env default' });
    }
    return { ok: true, key_cleared: /cleared/.test(v.key), ai: await llm.publicInfo() };
  }, { staff: 'ai.edit', rate: [30, 600] });

  /** Try Cas with the current knowledge and house rules (no customer data). */
  r.post('/api/admin/ai/test', async (ctx) => {
    const q = str(ctx.body.question, 'Question', { min: 2, max: 1500 });
    const res = await ai.complete({ system: await ai.systemPrompt({ profile: ctx.body.profile || undefined, extra: 'Answer as Cas would answer a Castvoo customer. Under 150 words.' }), messages: [{ role: 'user', content: q }], maxTokens: 600 });
    await db.query("insert into ai_usage(workspace_id, user_id, kind, writes, input_tokens, output_tokens, provider, model, cost_usd) values (0, $1, 'admin_test', 0, $2, $3, $4, $5, $6)", [ctx.user.id, res.usage.input_tokens || 0, res.usage.output_tokens || 0, res.usage.provider || 'anthropic', res.usage.model || null, res.usage.cost_usd || 0]);
    return { answer: res.text, usage: res.usage };
  }, { staff: 'knowledge.edit', rate: [60, 600] });
};

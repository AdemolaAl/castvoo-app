'use strict';
/* Cas AI for customers: write, rewrite, translate, sequence, ask. Each call uses AI writes. */

const db = require('../db');
const ai = require('../services/ai');
const billing = require('../services/billing');
const settings = require('../services/settings');
const { str, int, oneOf, badRequest } = require('../lib/util');

async function run(ctx, kind, writes, fn) {
  await settings.requireFeature('ai', 'Cas is switched off right now.');
  await billing.useAi(ctx.workspace, writes);
  try {
    const out = await fn();
    await db.query('insert into ai_usage(workspace_id, user_id, kind, writes, input_tokens, output_tokens) values ($1,$2,$3,$4,$5,$6)',
      [ctx.workspace.id, ctx.user.id, kind, writes, out.usage.input_tokens || 0, out.usage.output_tokens || 0]);
    const left = await billing.limits(ctx.workspace);
    const used = (await db.one('select ai_used from workspaces where id = $1', [ctx.workspace.id])).ai_used;
    return { ...out.result, ai_writes_left: Math.max(0, left.ai_writes - used) };
  } catch (e) {
    await billing.refundAi(ctx.workspace.id, writes);
    throw e;
  }
}

module.exports = (r) => {
  r.post('/api/ai/write', async (ctx) => {
    const b = ctx.body;
    const goal = str(b.goal, 'What the message is for', { min: 3, max: 1000 });
    return run(ctx, 'write', 1, async () => {
      const system = await ai.systemPrompt({ profile: ctx.workspace.ai_profile });
      const res = await ai.complete({ system, messages: [{ role: 'user', content: ai.TASKS.write({ goal, tone: str(b.tone, 'Tone', { max: 60, required: false }), language: str(b.language, 'Language', { max: 40, required: false }), length: b.length, kind: b.kind, max_chars: b.has_media ? 1024 : 3500 }) }] });
      return { result: { text: ai.clean(res.text) }, usage: res.usage };
    });
  }, { auth: 'workspace', rate: [40, 600] });

  r.post('/api/ai/rewrite', async (ctx) => {
    const text = str(ctx.body.text, 'Message', { min: 2, max: 4096 });
    const how = oneOf(ctx.body.how || 'clearer', 'Style', ['shorter', 'clearer', 'urgent', 'friendlier', 'fix']);
    return run(ctx, 'rewrite', 1, async () => {
      const res = await ai.complete({ system: await ai.systemPrompt({ profile: ctx.workspace.ai_profile }), messages: [{ role: 'user', content: ai.TASKS.rewrite({ text, how, max_chars: ctx.body.has_media ? 1024 : 4000 }) }] });
      return { result: { text: ai.clean(res.text) }, usage: res.usage };
    });
  }, { auth: 'workspace', rate: [40, 600] });

  r.post('/api/ai/translate', async (ctx) => {
    const text = str(ctx.body.text, 'Message', { min: 2, max: 4096 });
    const language = str(ctx.body.language, 'Language', { min: 2, max: 40 });
    return run(ctx, 'translate', 1, async () => {
      const res = await ai.complete({ system: await ai.systemPrompt({ profile: ctx.workspace.ai_profile }), messages: [{ role: 'user', content: ai.TASKS.translate({ text, language }) }], temperature: 0.3 });
      return { result: { text: ai.clean(res.text) }, usage: res.usage };
    });
  }, { auth: 'workspace', rate: [40, 600] });

  r.post('/api/ai/sequence', async (ctx) => {
    const goal = str(ctx.body.goal, 'What the follow-up is for', { min: 3, max: 1000 });
    const steps = int(ctx.body.steps || 4, 'Number of messages', { min: 2, max: 7 });
    return run(ctx, 'sequence', steps, async () => {
      const res = await ai.complete({ system: await ai.systemPrompt({ profile: ctx.workspace.ai_profile }), maxTokens: 2500,
        messages: [{ role: 'user', content: ai.TASKS.sequence({ goal, steps, trigger: str(ctx.body.trigger, 'Trigger', { max: 120, required: false }), language: str(ctx.body.language, 'Language', { max: 40, required: false }) }) }] });
      const m = res.text.match(/\[[\s\S]*\]/);
      let arr;
      try { arr = JSON.parse(m ? m[0] : res.text); } catch { throw badRequest('Cas wrote something unexpected. Please try again.'); }
      const out = (Array.isArray(arr) ? arr : []).slice(0, steps).map((s) => ({
        delay_value: Math.max(0, Math.min(365, parseInt(s.delay_value, 10) || 0)), delay_unit: ['min', 'hour', 'day'].includes(s.delay_unit) ? s.delay_unit : 'day', body: ai.clean(s.body).slice(0, 1000),
      })).filter((s) => s.body);
      if (!out.length) throw badRequest('Cas could not write that sequence. Try describing the goal differently.');
      out[0].delay_value = 0; out[0].delay_unit = 'min';
      return { result: { steps: out }, usage: res.usage };
    });
  }, { auth: 'workspace', rate: [20, 600] });

  /** Ask Cas anything about Castvoo or your own numbers. Keeps the last few turns for context. */
  r.post('/api/ai/ask', async (ctx) => {
    const question = str(ctx.body.question, 'Question', { min: 2, max: 1500 });
    const history = (Array.isArray(ctx.body.history) ? ctx.body.history : []).slice(-6)
      .filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string').map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
    while (history.length && history[0].role !== 'user') history.shift();
    return run(ctx, 'ask', 1, async () => {
      const system = await ai.systemPrompt({ profile: ctx.workspace.ai_profile, extra: (await ai.workspaceFacts(ctx.workspace)) + '\nAnswer in under 150 words unless the user asks for more. Use short paragraphs or a short list. Give concrete next steps inside Castvoo.' });
      const res = await ai.complete({ system, messages: [...history, { role: 'user', content: question }], maxTokens: 700 });
      return { result: { answer: res.text.replace(/\*\*(.+?)\*\*/g, '*$1*') }, usage: res.usage };
    });
  }, { auth: 'workspace', rate: [40, 600] });

  /** Fill "Train Cas" examples from the last messages they actually sent (free, no AI write). */
  r.get('/api/ai/my-examples', async (ctx) => {
    const rows = await db.many("select body from broadcasts where workspace_id = $1 and status = 'sent' order by id desc limit 3", [ctx.workspace.id]);
    return { examples: rows.map((x) => x.body) };
  }, { auth: 'workspace' });
};

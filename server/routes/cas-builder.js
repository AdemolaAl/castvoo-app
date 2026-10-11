'use strict';
/*
 * Cas Builder (services/cas-builder.js, public/js/cas-engine.js): build any bot (a Welcome bot or a Chat bot) by chatting with Cas.
 *   GET  /api/cas-builder                       builds left, Cas credits, the credit pack, resting, the draft to resume
 *   POST /api/cas-builder/sessions              start a chat ({ flow_id } = change an existing bot, never counts; { kind } = skip
 *                                               "What do you want your bot to do?": welcome | join_check | lead_magnet | menu | lead_questions | referral)
 *   GET  /api/cas-builder/sessions/:id          resume a chat
 *   POST /api/cas-builder/sessions/:id/reply    { chip } (never calls the AI) or { text }
 *   POST /api/cas-builder/sessions/:id/edit     tap-to-edit: { message, text } | { message, button, label, url } | { start, label } (never the AI)
 *   POST /api/cas-builder/sessions/:id/tweak    a quick action under a message: { message, how: shorter | friendlier | emoji }
 *   POST /api/cas-builder/sessions/:id/undo     undo the last change
 *   POST /api/cas-builder/sessions/:id/save     { active, replace }: save as a flow, and switch it on with the usual checks
 *   POST /api/cas-builder/sessions/:id/close    start over (the draft is closed)
 *   POST /api/cas-builder/credits               buy one pack of Cas credits from the wallet
 */

const cb = require('../services/cas-builder');
const { int, httpError } = require('../lib/util');

const canEdit = (ctx) => { if (ctx.member.role === 'drafter') throw httpError(403, 'Your role can\'t change Welcome Flows. Ask the workspace owner.', 'forbidden'); };
const input = (b) => {
  const out = {};
  if (b.chip != null) out.chip = String(b.chip).slice(0, 80);
  else if (b.text != null) out.text = String(b.text).slice(0, 2000);
  if (out.chip == null && out.text == null) throw httpError(400, 'Tap a choice or type a few words.', 'bad_request');
  return out;
};

module.exports = (r) => {
  r.get('/api/cas-builder', async (ctx) => cb.status(ctx.workspace, ctx.user), { auth: 'workspace' });

  r.post('/api/cas-builder/sessions', async (ctx) => {
    canEdit(ctx);
    const b = ctx.body || {};
    return { session: await cb.startSession(ctx.workspace, ctx.user, { flowId: b.flow_id ? int(b.flow_id, 'Flow', { min: 1 }) : null, kind: b.kind == null ? null : String(b.kind).slice(0, 20) }) };
  }, { auth: 'workspace', rate: [40, 600] });

  r.get('/api/cas-builder/sessions/:id', async (ctx) => ({ session: await cb.getSession(ctx.workspace, ctx.user, int(ctx.params.id, 'Chat')) }), { auth: 'workspace' });

  r.post('/api/cas-builder/sessions/:id/reply', async (ctx) => {
    canEdit(ctx);
    return cb.replySession(ctx.workspace, ctx.user, int(ctx.params.id, 'Chat'), input(ctx.body || {}));
  }, { auth: 'workspace', rate: [120, 600], shared: true });

  r.post('/api/cas-builder/sessions/:id/edit', async (ctx) => {
    canEdit(ctx);
    const b = ctx.body || {};
    const str = (v, n) => (v == null ? undefined : typeof v === 'string' ? v.slice(0, n) : v);
    const input = b.start === true ? { start: true, label: str(b.label, 200) }
      : b.button != null ? { message: Number(b.message), button: String(b.button).slice(0, 40), label: str(b.label, 200), url: str(b.url, 600) }
        : { message: Number(b.message), text: str(b.text, 6000) };
    return cb.editSession(ctx.workspace, ctx.user, int(ctx.params.id, 'Chat'), input);
  }, { auth: 'workspace', rate: [120, 600] });

  r.post('/api/cas-builder/sessions/:id/tweak', async (ctx) => {
    canEdit(ctx);
    const b = ctx.body || {};
    return cb.tweakSession(ctx.workspace, ctx.user, int(ctx.params.id, 'Chat'), { message: Number(b.message), how: String(b.how || '').slice(0, 20) });
  }, { auth: 'workspace', rate: [60, 600], shared: true });

  r.post('/api/cas-builder/sessions/:id/undo', async (ctx) => {
    canEdit(ctx);
    return cb.undoSession(ctx.workspace, ctx.user, int(ctx.params.id, 'Chat'));
  }, { auth: 'workspace', rate: [120, 600] });

  r.post('/api/cas-builder/sessions/:id/save', async (ctx) => {
    canEdit(ctx);
    const b = ctx.body || {};
    return cb.saveSession(ctx.workspace, ctx.user, int(ctx.params.id, 'Chat'), { active: b.active === true, replace: b.replace === true });
  }, { auth: 'workspace', rate: [60, 600] });

  r.post('/api/cas-builder/sessions/:id/close', async (ctx) => cb.closeSession(ctx.workspace, ctx.user, int(ctx.params.id, 'Chat')), { auth: 'workspace' });

  r.post('/api/cas-builder/credits', async (ctx) => ({ ok: true, ...(await cb.buyCredits(ctx.workspace)) }), { auth: 'workspace', rate: [20, 600] });
};

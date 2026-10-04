'use strict';
/* The customer side of support chat. */

const db = require('../db');
const settings = require('../services/settings');
const support = require('../services/support');

module.exports = (r) => {
  r.get('/api/support', async (ctx) => {
    const t = await db.one('select * from support_threads where user_id = $1 order by id desc limit 1', [ctx.user.id]);
    if (!t) return { thread: null, messages: [], reply_time: (await settings.get('support')).reply_time };
    const messages = await db.many('select id, author_type, author_name, body, created_at from support_messages where thread_id = $1 and not internal order by id', [t.id]);
    if (t.unread_user) await db.query('update support_threads set unread_user = false where id = $1', [t.id]);
    return { thread: { id: t.id, status: t.status }, messages, reply_time: (await settings.get('support')).reply_time };
  }, { auth: 'workspace' });

  r.post('/api/support', async (ctx) => {
    await settings.requireFeature('support_chat', 'Support chat is switched off. Email us instead.');
    const id = await support.userMessage(ctx.user, ctx.workspace.id, ctx.body.body);
    return { ok: true, thread_id: id };
  }, { auth: 'workspace', rate: [30, 600] });
};

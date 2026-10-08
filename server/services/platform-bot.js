'use strict';
/*
 * @CastvooBot, our own bot. It:
 *  - posts in customers' channels and groups (they add it as admin with one tap)
 *  - links a customer's Telegram account (t.me/CastvooBot?start=link_<token>)
 *  - powers "Log in with Telegram" (the login widget uses this bot's token to sign logins)
 */

const db = require('../db');
const config = require('../config');
const tg = require('./telegram');
const log = require('../lib/log');
const billing = require('./billing');
const connections = require('./connections');
const { hmac } = require('../lib/util');

const secret = () => config.telegram.webhookSecret || hmac(config.appSecret, 'tg-platform').slice(0, 40);

async function ensureWebhook() {
  await tg.platform('setWebhook', {
    url: `${config.appUrl}/tg/platform`, secret_token: secret(),
    allowed_updates: ['message', 'callback_query', 'my_chat_member'], drop_pending_updates: false,
  });
  await tg.platform('setMyCommands', { commands: [{ command: 'start', description: 'About Castvoo' }] }).catch(() => {});
  log.info('platform bot webhook set');
}

const dm = (chatId, text, extra = {}) => tg.platform('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }).catch(() => {});

async function onStart(msg, payload) {
  const from = msg.from;
  if (payload && payload.startsWith('link_')) {
    const token = payload.slice(5);
    const row = await db.one('select t.*, u.name, u.email from tg_link_tokens t join users u on u.id = t.user_id where t.token = $1 and t.used_at is null and t.expires_at > now()', [token]);
    if (!row) return dm(from.id, 'This link has expired. Go back to Castvoo and tap <b>Link Telegram</b> again.');
    const who = row.email ? row.email.replace(/^(.).*(@.*)$/, '$1•••$2') : row.name;
    return dm(from.id, `Link this Telegram account to the Castvoo account <b>${escape(who)}</b>?\n\nOnly tap Yes if <b>you</b> just asked for this on castvoo.com and that is <b>your</b> email. If someone sent you this link, tap No: linking would let them log in as you and receive your channels.`, {
      reply_markup: { inline_keyboard: [[{ text: 'Yes, link it', callback_data: 'link:' + token }], [{ text: 'No', callback_data: 'nolink' }]] },
    });
  }
  return dm(from.id, `Hi ${escape(from.first_name || '')} 👋\n\nI'm the Castvoo bot. I post messages in channels and groups for Castvoo customers.\n\nTo get started, open <a href="${config.appUrl}">${config.appUrl.replace(/^https?:\/\//, '')}</a>.`);
}

async function onCallback(q) {
  const data = String(q.data || '');
  if (data === 'nolink') {
    await tg.platform('answerCallbackQuery', { callback_query_id: q.id, text: 'OK, nothing was linked.' }).catch(() => {});
    return;
  }
  if (data.startsWith('link:')) {
    const token = data.slice(5);
    const row = await db.one('update tg_link_tokens set used_at = now() where token = $1 and used_at is null and expires_at > now() returning user_id', [token]);
    if (!row) { await tg.platform('answerCallbackQuery', { callback_query_id: q.id, text: 'This link has expired.' }).catch(() => {}); return; }
    const taken = await db.one('select id from users where tg_user_id = $1 and id <> $2', [q.from.id, row.user_id]);
    if (taken) {
      await tg.platform('answerCallbackQuery', { callback_query_id: q.id, text: 'This Telegram account is already linked to another Castvoo login.', show_alert: true }).catch(() => {});
      return;
    }
    await db.query('update users set tg_user_id = $2, tg_username = $3 where id = $1', [row.user_id, q.from.id, q.from.username || null]);
    await db.query('update tg_link_tokens set tg_user_id = $2 where token = $1', [token, q.from.id]);
    await tg.platform('answerCallbackQuery', { callback_query_id: q.id, text: 'Linked ✅' }).catch(() => {});
    // SEC-10: the person who tapped Yes can undo it from Telegram for 7 days (if someone talked them into it).
    await dm(q.from.id, '✅ Linked. Go back to Castvoo: you can now add channels and groups with one tap.\n\nNot you, or someone asked you to tap the link? Tap <b>Unlink</b> below.', {
      reply_markup: { inline_keyboard: [[{ text: 'Unlink this Telegram account', callback_data: 'unlink:' + token }]] },
    });
    return;
  }
  if (data.startsWith('unlink:')) {
    const token = data.slice(7);
    const t = await db.one("select * from tg_link_tokens where token = $1 and tg_user_id = $2 and used_at > now() - interval '7 days'", [token, q.from.id]);
    const done = t ? await db.one('update users set tg_user_id = null, tg_username = null where id = $1 and tg_user_id = $2 returning id', [t.user_id, q.from.id]) : null;
    if (done) {
      // Sessions started with "Log in with Telegram" since then end too.
      await db.query("delete from sessions where user_id = $1 and created_at >= $2", [t.user_id, t.used_at]).catch(() => {});
      log.warn('telegram link undone from Telegram', { user: t.user_id });
    }
    await tg.platform('answerCallbackQuery', { callback_query_id: q.id, text: done ? 'Unlinked. This Telegram account is no longer linked to that Castvoo account.' : 'Nothing to unlink.', show_alert: !!done }).catch(() => {});
  }
}

async function onMyChatMember(u) {
  const chat = u.chat, from = u.from, st = u.new_chat_member && u.new_chat_member.status;
  if (!['channel', 'group', 'supergroup'].includes(chat.type)) return;
  if (st === 'left' || st === 'kicked') {
    await db.query("update connections set status = 'error', last_error = $2 where tg_chat_id = $1 and kind <> 'bot' and status = 'active'",
      [chat.id, `@${config.telegram.botUsername} was removed from this chat. Add it again to keep posting.`]);
    return;
  }
  if (st !== 'administrator') return;
  const nm = u.new_chat_member;
  if (chat.type === 'channel' && !nm.can_post_messages) {
    return dm(from.id, `I was added to <b>${escape(chat.title)}</b> but without the <b>Post messages</b> right. Turn it on in the channel's admin settings and I'll connect it.`);
  }
  const user = await db.one("select * from users where tg_user_id = $1 and status = 'active'", [from.id]);
  if (!user) {
    await dm(from.id, `Thanks for adding me to <b>${escape(chat.title)}</b>. I couldn't find a Castvoo account linked to your Telegram. Open Castvoo → Settings → Link Telegram, then add me again.`);
    await tg.platform('leaveChat', { chat_id: chat.id }).catch(() => {});
    return;
  }
  const req = await db.one('delete from connect_requests where id = (select id from connect_requests where user_id = $1 and expires_at > now() order by id desc limit 1) returning workspace_id', [user.id]);
  const ws = req
    ? await db.one('select w.* from workspaces w join members m on m.workspace_id = w.id where w.id = $1 and m.user_id = $2', [req.workspace_id, user.id])
    : await db.one("select w.* from workspaces w join members m on m.workspace_id = w.id where m.user_id = $1 and m.role = 'owner' order by w.id limit 1", [user.id]);
  if (!ws) return;
  // One channel or group belongs to one Castvoo workspace. Don't leave it: the other workspace still uses it.
  const other = await db.one("select 1 from connections where tg_chat_id = $1 and kind <> 'bot' and status <> 'removed' and workspace_id <> $2", [chat.id, ws.id]);
  if (other) return dm(from.id, `<b>${escape(chat.title)}</b> is already connected to another Castvoo workspace. Remove it there first (Bots &amp; channels → Remove), then add me again.`);
  const already = await db.one("select 1 from connections where workspace_id = $1 and tg_chat_id = $2 and status <> 'removed'", [ws.id, chat.id]);
  if (!already) {
    try { await billing.assertCanConnect(ws, chat.type === 'channel' ? 'channel' : 'group'); } catch (e) {
      await dm(from.id, `I couldn't connect <b>${escape(chat.title)}</b>: ${escape(e.message)}`);
      await tg.platform('leaveChat', { chat_id: chat.id }).catch(() => {});
      return;
    }
  }
  const count = await tg.platform('getChatMemberCount', { chat_id: chat.id }).catch(() => 0);
  await connections.addChat(ws.id, chat, count);
  await dm(from.id, `✅ <b>${escape(chat.title)}</b> is connected to Castvoo. You can send to it from your dashboard now.`);
}

async function handleUpdate(update) {
  try {
    if (update.message) {
      const m = update.message;
      if (m.migrate_to_chat_id) { await db.query('update connections set tg_chat_id = $2 where tg_chat_id = $1', [m.chat.id, m.migrate_to_chat_id]); return; }
      if (m.chat && m.chat.type === 'private' && typeof m.text === 'string' && m.text.startsWith('/start')) return await onStart(m, m.text.split(/\s+/)[1] || '');
      return;
    }
    if (update.callback_query) return await onCallback(update.callback_query);
    if (update.my_chat_member) return await onMyChatMember(update.my_chat_member);
  } catch (e) {
    log.error('platform bot update failed', { err: e });
  }
}

function escape(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

module.exports = { ensureWebhook, handleUpdate, secret };

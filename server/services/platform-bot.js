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
const { hmac, badRequest } = require('../lib/util');

const secret = () => config.telegram.webhookSecret || hmac(config.appSecret, 'tg-platform').slice(0, 40);
const webhookUrl = () => `${config.appUrl}/tg/platform`;
const ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member'];

/*
 * Only ONE program may use a bot token. If another program (an old test bot, a bot builder, a second deploy) calls
 * setWebhook or getUpdates with CASTVOO_BOT_TOKEN, Telegram sends our users' /start taps there and @CastvooBot goes
 * quiet. checkWebhook() runs at start-up and every 10 minutes (workers/index.js): it puts the webhook back when the
 * address is wrong or Telegram reports a new delivery error, and logs a clear warning.
 * It also asks Telegram for the bot's real username (getMe). Links use that name, so a CASTVOO_BOT_USERNAME that
 * belongs to a different bot can never send people to a bot nobody answers.
 */
const ENV_USERNAME = config.telegram.botUsername;
const state = { me: null, lastSetAt: 0, lastCheck: null };

async function ensureWebhook() {
  await tg.platform('setWebhook', { url: webhookUrl(), secret_token: secret(), allowed_updates: ALLOWED_UPDATES, drop_pending_updates: false });
  state.lastSetAt = Date.now();
  await tg.platform('setMyCommands', { commands: [{ command: 'start', description: 'About Castvoo' }] }).catch(() => {});
  log.info('platform bot webhook set', { url: webhookUrl() });
}

/** getMe: remember the real username and use it for every link (config.telegram.botUsername). */
async function refreshIdentity() {
  const me = await tg.platform('getMe');
  state.me = { id: me.id, username: me.username, first_name: me.first_name };
  const mismatch = !!(ENV_USERNAME && me.username && ENV_USERNAME.toLowerCase() !== String(me.username).toLowerCase());
  if (mismatch) log.warn('CASTVOO_BOT_USERNAME does not match the bot of CASTVOO_BOT_TOKEN: links use the real name', { env_username: ENV_USERNAME, token_username: me.username });
  if (me.username) config.telegram.botUsername = me.username;
  return { username: me.username, mismatch };
}

/** The actual bot username (from getMe once known, else CASTVOO_BOT_USERNAME). */
const username = () => config.telegram.botUsername;

/**
 * Checks the webhook and fixes it when needed. { fix: false } only reports (Admin card).
 * Returns { username, env_username, username_mismatch, url, expected_url, url_ok, pending, last_error, last_error_at,
 *           max_connections, ip, fixed, reasons, checked_at }.
 */
async function checkWebhook({ fix = true } = {}) {
  const out = { expected_url: webhookUrl(), env_username: ENV_USERNAME || null, fixed: false, reasons: [], checked_at: new Date() };
  const id = await refreshIdentity();
  out.username = id.username; out.username_mismatch = id.mismatch;
  const info = await tg.platform('getWebhookInfo');
  Object.assign(out, {
    url: info.url || '', url_ok: info.url === webhookUrl(), pending: info.pending_update_count || 0,
    last_error: info.last_error_message || null, last_error_at: info.last_error_date ? new Date(info.last_error_date * 1000) : null,
    ip: info.ip_address || null, max_connections: info.max_connections || null,
  });
  if (!out.url_ok) out.reasons.push(info.url ? 'webhook points somewhere else' : 'no webhook set (another program may be using getUpdates)');
  // An error Telegram reported after our last setWebhook (older ones are already handled).
  const freshError = out.last_error && (!out.last_error_at || out.last_error_at.getTime() > state.lastSetAt);
  if (freshError) out.reasons.push('Telegram could not deliver updates: ' + out.last_error);
  if (fix && out.reasons.length) {
    log.warn('platform bot webhook was wrong, setting it again', { reasons: out.reasons, found_url: out.url || null, expected_url: out.expected_url, last_error_message: out.last_error, last_error_at: out.last_error_at, pending_update_count: out.pending, bot: out.username });
    await ensureWebhook();
    out.fixed = true;
  }
  state.lastCheck = out;
  return out;
}

/** Start-up and the 10-minute worker: never throws. */
async function selfHeal() {
  if (!config.telegram.botToken) return null;
  try { return await checkWebhook({ fix: true }); } catch (e) { log.warn('platform bot check failed', { err: e, code: e.code, description: e.description }); return null; }
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

async function onOther(msg) {
  const site = config.appUrl.replace(/^https?:\/\//, '');
  return dm(msg.from.id, `I'm the Castvoo bot, so I can't chat here 🙂\n\n<b>Linking your Telegram?</b> Open <a href="${config.appUrl}/#app/settings">${site}</a> → Link Telegram, tap <b>Open Telegram</b>, then tap <b>Start</b> and <b>Yes, link it</b>.\n\nNeed help? Chat with us on the Help page at <a href="${config.appUrl}/#app/help">${site}</a>.`);
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
      if (m.chat && m.chat.type === 'private' && typeof m.text === 'string' && /^\/start(@\w+)?(\s|$)/.test(m.text)) return await onStart(m, m.text.split(/\s+/)[1] || '');
      // Anything else in a private chat (a word, a photo, /help): say what this bot is for, so nobody is left waiting.
      if (m.chat && m.chat.type === 'private' && m.from && !m.from.is_bot) return await onOther(m);
      return;
    }
    if (update.callback_query) return await onCallback(update.callback_query);
    if (update.my_chat_member) return await onMyChatMember(update.my_chat_member);
  } catch (e) {
    log.error('platform bot update failed', { err: e });
  }
}

/** Admin → "Send test message to me": a DM to the admin's linked Telegram. */
async function sendTest(user) {
  if (!user.tg_user_id) throw badRequest('Link your own Telegram first (dashboard → Settings → Link Telegram), then try again.', 'tg_not_linked');
  return tg.platform('sendMessage', { chat_id: user.tg_user_id, text: `✅ Test from Castvoo admin. @${username()} can message you, so its token works.\n\nSent ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.`, disable_web_page_preview: true });
}

function escape(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

module.exports = { ensureWebhook, checkWebhook, selfHeal, refreshIdentity, username, webhookUrl, handleUpdate, secret, sendTest, _state: state };

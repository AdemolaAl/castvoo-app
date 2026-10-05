'use strict';
/*
 * Telegram connections: the customer's own bots, and the channels/groups that
 * @CastvooBot (our platform bot) posts in.
 * - A bot connection stores the bot token encrypted, and points the bot's webhook at /tg/b/<id>.
 * - Channels and groups are posted to by the platform bot, so they need no token.
 */

const db = require('../db');
const config = require('../config');
const tg = require('./telegram');
const billing = require('./billing');
const { encrypt, decrypt, randomToken, httpError, badRequest } = require('../lib/util');

const BOT_UPDATES = ['message', 'callback_query', 'my_chat_member', 'chat_join_request'];

function tokenOf(conn) {
  if (conn.kind === 'bot') return decrypt(conn.token_enc);
  return config.telegram.botToken;
}
/** Which queue a connection's messages go through (one queue per sending bot). */
function senderKey(conn) { return conn.kind === 'bot' ? 'bot:' + conn.id : 'platform'; }

async function connectBot(ws, rawToken) {
  const token = String(rawToken || '').trim();
  if (!tg.tokenLooksValid(token)) throw badRequest('That doesn\'t look like a bot token. It looks like 123456789:AAH... Copy it again from @BotFather.');
  let me;
  try { me = await tg.call(token, 'getMe'); } catch (e) {
    if (e.code === 401 || e.code === 404) throw badRequest('Telegram says this token is not valid. Copy it again from @BotFather, or send /token to BotFather for a fresh one.');
    throw httpError(502, 'Could not reach Telegram. Please try again in a minute.', 'telegram_down');
  }
  if (!me.is_bot) throw badRequest('That token is not for a bot.');
  const elsewhere = await db.one("select * from connections where kind = 'bot' and tg_chat_id = $1 and status <> 'removed'", [me.id]);
  if (elsewhere && Number(elsewhere.workspace_id) !== Number(ws.id)) throw httpError(409, `@${me.username} is already connected to another Castvoo workspace. Remove it there first.`, 'bot_taken');
  if (elsewhere) return reconnectBot(elsewhere, token, me);
  await billing.assertCanConnect(ws);

  const secret = randomToken(24).replace(/[^A-Za-z0-9_-]/g, '');
  let conn;
  try {
    conn = await db.one(`insert into connections(workspace_id, kind, tg_chat_id, username, title, token_enc, webhook_secret)
      values ($1,'bot',$2,$3,$4,$5,$6) returning *`, [ws.id, me.id, me.username, me.first_name || me.username, encrypt(token), secret]);
  } catch (e) {
    // 23505 = unique index "connections_one_live_bot": someone connected this bot a moment ago.
    if (e.code === '23505') throw httpError(409, `@${me.username} is already connected to a Castvoo workspace. Remove it there first.`, 'bot_taken');
    throw e;
  }
  try {
    await tg.call(token, 'setWebhook', { url: `${config.appUrl}/tg/b/${conn.id}`, secret_token: secret, allowed_updates: BOT_UPDATES, drop_pending_updates: false, max_connections: 40 });
  } catch (e) {
    await db.query("update connections set status = 'removed' where id = $1", [conn.id]);
    throw httpError(502, 'Telegram did not accept the connection: ' + (e.description || e.message) + '. Make sure APP_URL is a public https address.', 'webhook_failed');
  }
  require('./voosquare').activity('channel_connected', { wsId: ws.id, idParts: ['conn', conn.id], label: `Bot @${me.username} connected` }).catch(() => {});
  return conn;
}

/**
 * The same bot pasted again (a new token from /revoke, or it shows "Needs attention"):
 * keep its subscribers, follow-ups and stats, just swap in the new token and point the webhook again.
 */
async function reconnectBot(conn, token, me) {
  if (String(conn.tg_chat_id) !== String(me.id)) throw badRequest('That token belongs to a different bot.');
  try {
    await tg.call(token, 'setWebhook', { url: `${config.appUrl}/tg/b/${conn.id}`, secret_token: conn.webhook_secret, allowed_updates: BOT_UPDATES, drop_pending_updates: false, max_connections: 40 });
  } catch (e) {
    throw httpError(502, 'Telegram did not accept the connection: ' + (e.description || e.message) + '. Please try again in a minute.', 'webhook_failed');
  }
  const row = await db.one(`update connections set token_enc = $2, username = $3, title = $4, status = 'active', last_error = null
    where id = $1 returning *`, [conn.id, encrypt(token), me.username, me.first_name || me.username]);
  return { ...row, reconnected: true };
}

async function removeWebhook(conn) {
  if (conn.kind !== 'bot' || !conn.token_enc) return;
  await tg.call(decrypt(conn.token_enc), 'deleteWebhook', { drop_pending_updates: false });
}

async function remove(ws, id) {
  const conn = await db.one("select * from connections where id = $1 and workspace_id = $2 and status <> 'removed'", [id, ws.id]);
  if (!conn) throw httpError(404, 'That connection was not found.', 'not_found');
  if (conn.kind === 'bot') await removeWebhook(conn).catch(() => {});
  else {
    // Leave only when no other live connection uses this chat (never true today, but safe).
    const others = await db.one("select 1 from connections where tg_chat_id = $1 and kind <> 'bot' and status <> 'removed' and id <> $2", [conn.tg_chat_id, conn.id]);
    if (!others) await tg.platform('leaveChat', { chat_id: conn.tg_chat_id }).catch(() => {});
  }
  await db.tx(async (c) => {
    await c.query("update connections set status = 'removed', token_enc = null where id = $1", [conn.id]);
    await c.query("update deliveries set status = 'skipped', error = 'Connection removed' where status = 'queued' and sender_key = $1 and workspace_id = $2", [senderKey(conn), ws.id]);
    await c.query("update broadcasts set status = 'cancelled' where connection_id = $1 and status in ('scheduled','pending_approval','sending')", [conn.id]);
    await c.query('update sequences set active = false where connection_id = $1', [conn.id]);
  });
  return { ok: true };
}

/** Called by the platform bot when it is made admin of a channel or group. */
async function addChat(wsId, chat, memberCount) {
  const kind = chat.type === 'channel' ? 'channel' : 'group';
  const existing = await db.one("select * from connections where workspace_id = $1 and kind = $2 and tg_chat_id = $3 and status <> 'removed'", [wsId, kind, chat.id]);
  if (existing) {
    await db.query("update connections set status = 'active', last_error = null, title = $2, username = $3, member_count = $4 where id = $1", [existing.id, chat.title || '', chat.username || null, memberCount]);
    return existing;
  }
  let conn;
  try {
    conn = await db.one(`insert into connections(workspace_id, kind, tg_chat_id, username, title, member_count, counts_at) values ($1,$2,$3,$4,$5,$6, now()) returning *`,
      [wsId, kind, chat.id, chat.username || null, chat.title || '', memberCount]);
  } catch (e) {
    // 23505 = unique index "connections_one_live_chat": it is connected to another workspace.
    if (e.code === '23505') throw httpError(409, 'This chat is already connected to another Castvoo workspace.', 'chat_taken');
    throw e;
  }
  require('./voosquare').activity('channel_connected', { wsId, idParts: ['conn', conn.id], label: `${kind === 'channel' ? 'Channel' : 'Group'} connected: ${String(chat.title || chat.username || '').slice(0, 60)}`.replace(/: $/, '') }).catch(() => {});
  return conn;
}

/** Refresh member counts for channels/groups (runs hourly). */
async function refreshCounts(limit = 200) {
  // Oldest first, so every chat gets its turn however many there are.
  const rows = await db.many("select * from connections where kind <> 'bot' and status = 'active' order by counts_at nulls first, id limit $1", [limit]);
  for (const c of rows) {
    await db.query('update connections set counts_at = now() where id = $1', [c.id]);
    try {
      const n = await tg.platform('getChatMemberCount', { chat_id: c.tg_chat_id });
      await db.query('update connections set member_count = $2, last_error = null where id = $1', [c.id, n]);
    } catch (e) {
      if (e.code === 403 || e.code === 400) await db.query("update connections set status = 'error', last_error = $2 where id = $1", [c.id, 'Castvoo was removed from this chat or lost its admin rights. Add @' + config.telegram.botUsername + ' again.']);
    }
  }
}

module.exports = { connectBot, remove, removeWebhook, addChat, tokenOf, senderKey, refreshCounts, BOT_UPDATES };

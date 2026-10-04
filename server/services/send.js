'use strict';
/*
 * Sends one message (text, photo or video, with buttons) to one Telegram chat.
 * Used by the queue worker (broadcasts and follow-ups) and by join-request welcomes.
 */

const db = require('../db');
const config = require('../config');
const tg = require('./telegram');
const { sign } = require('../lib/util');

const uploading = new Map();
const STOP_BUTTON ={ text: '🔕 Stop these messages', callback_data: 'cv_stop' };

/** Make the inline keyboard: one row per button, tracked links, optional stop button. */
function keyboard(buttons, { subscriberId, includeStop }) {
  const rows = [];
  for (const b of buttons || []) {
    if (!b || !b.label) continue;
    let url = b.url;
    if (b.code) url = `${config.appUrl}/l/${b.code}` + (subscriberId ? `?s=${subscriberId}.${sign(`click:${b.code}:${subscriberId}`, 10)}` : '');
    rows.push([{ text: String(b.label).slice(0, 64), url }]);
  }
  if (includeStop) rows.push([STOP_BUTTON]);
  return rows.length ? { inline_keyboard: rows } : undefined;
}

async function mediaInput(media, botKey) {
  const cached = await db.one('select file_id from media_file_ids where media_id = $1 and bot_key = $2', [media.id, botKey]);
  if (cached) return { value: cached.file_id, file: null };
  return { value: null, file: { path: media.path, filename: media.filename, mime: media.mime } };
}

function fileIdFrom(result, kind) {
  if (kind === 'photo' && Array.isArray(result.photo)) return result.photo[result.photo.length - 1].file_id;
  if (kind === 'video' && result.video) return result.video.file_id;
  if (kind === 'animation' && (result.animation || result.document)) return (result.animation || result.document).file_id;
  return null;
}

/**
 * msg: { body, media_id, buttons }  opts: { token, botKey, chatId, subscriberId, includeStop, firstName }
 * {name} in the text becomes opts.firstName (or "there" when there is none, e.g. channel posts).
 * Returns Telegram's Message object. Throws TelegramError.
 */
async function sendOne(msg, opts) {
  const reply_markup = keyboard(msg.buttons, opts);
  const html = tg.personalize(tg.toHtml(msg.body), opts.firstName);
  if (msg.media_id) {
    const media = await db.one('select * from media where id = $1', [msg.media_id]);
    if (media) {
      const method = media.kind === 'video' ? 'sendVideo' : media.kind === 'animation' ? 'sendAnimation' : 'sendPhoto';
      const field = media.kind === 'video' ? 'video' : media.kind === 'animation' ? 'animation' : 'photo';
      const params = { chat_id: opts.chatId, caption: html, parse_mode: 'HTML', reply_markup };
      if (media.kind === 'video') params.supports_streaming = true;
      // Only the first send of a file uploads it; everyone after reuses Telegram's file_id.
      const lockKey = media.id + ':' + opts.botKey;
      while (uploading.has(lockKey)) await uploading.get(lockKey).catch(() => {});
      const inp = await mediaInput(media, opts.botKey);
      if (inp.value) return tg.call(opts.token, method, { ...params, [field]: inp.value });
      const p = (async () => {
        const result = await tg.call(opts.token, method, params, { field, ...inp.file });
        const fid = fileIdFrom(result, media.kind);
        if (fid) await db.query('insert into media_file_ids(media_id, bot_key, file_id) values ($1,$2,$3) on conflict do nothing', [media.id, opts.botKey, fid]);
        return result;
      })();
      uploading.set(lockKey, p);
      try { return await p; } finally { uploading.delete(lockKey); }
    }
  }
  return tg.call(opts.token, 'sendMessage', { chat_id: opts.chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: false, reply_markup });
}

module.exports = { sendOne, keyboard, STOP_BUTTON };

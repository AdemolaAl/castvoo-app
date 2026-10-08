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

/**
 * Make the inline keyboard: tracked links, optional "Tap to start" button first, optional stop button last.
 * Buttons with the same `row` number (Welcome Flows) sit side by side, 2 at most; others get a row each.
 */
function keyboard(buttons, { subscriberId, includeStop, startButton }) {
  const rows = [];
  if (startButton && startButton.label && startButton.url) rows.push([{ text: String(startButton.label).slice(0, 64), url: startButton.url }]);
  let lastRow = null;
  for (const b of buttons || []) {
    if (!b || !b.label) continue;
    let url = b.url;
    if (b.code) url = `${config.appUrl}/l/${b.code}` + (subscriberId ? `?s=${subscriberId}.${sign(`click:${b.code}:${subscriberId}`, 10)}` : '');
    const btn = { text: String(b.label).slice(0, 64), url };
    const row = b.row === undefined || b.row === null ? null : Number(b.row);
    if (row !== null && row === lastRow && rows.length && rows[rows.length - 1].length < 2) rows[rows.length - 1].push(btn);
    else rows.push([btn]);
    lastRow = row;
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
 * msg: { body, media_id, buttons }  opts: { token, botKey, chatId, subscriberId, includeStop, firstName, footerHtml, startButton }
 * {name} in the text becomes opts.firstName (or "there" when there is none, e.g. channel posts).
 * footerHtml is added after the text as it is (the Free plan's "Free welcome bot by Castvoo.com" line).
 * Returns Telegram's Message object. Throws TelegramError.
 */
async function sendOne(msg, opts) {
  const reply_markup = keyboard(msg.buttons, opts);
  const html = tg.personalize(tg.toHtml(msg.body), opts.firstName) + (opts.footerHtml || '');
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
  const params = { chat_id: opts.chatId, text: html, parse_mode: 'HTML', reply_markup };
  // ENG-20: the Free line's castvoo.com link must not become a big preview card: preview the message's own first
  // link, or none. (link_preview_options replaces the deprecated disable_web_page_preview.)
  if (opts.footerHtml) {
    const own = /href="([^"]+)"/.exec(tg.personalize(tg.toHtml(msg.body), opts.firstName)) || /\bhttps?:\/\/[^\s<>"]+/.exec(String(msg.body || ''));
    params.link_preview_options = own ? { url: (own[1] || own[0]).replace(/&amp;/g, '&') } : { is_disabled: true };
  }
  return tg.call(opts.token, 'sendMessage', params);
}

module.exports = { sendOne, keyboard, STOP_BUTTON };

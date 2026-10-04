'use strict';
/* Telegram sends bot updates here. Every request must carry the secret we gave Telegram. */

const db = require('../db');
const { safeEqual } = require('../lib/util');
const platformBot = require('../services/platform-bot');
const botUpdates = require('../services/bot-updates');

function parse(ctx) {
  try { return JSON.parse(ctx.rawBody.toString('utf8') || '{}'); } catch { return null; }
}

module.exports = (r) => {
  r.post('/tg/platform', async (ctx) => {
    if (!safeEqual(ctx.req.headers['x-telegram-bot-api-secret-token'] || '', platformBot.secret())) return ctx.send(401, 'no');
    const u = parse(ctx);
    if (u) await platformBot.handleUpdate(u);
    ctx.send(200, 'ok');
  }, { raw: true, limit: 512 * 1024 });

  r.post('/tg/b/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    const conn = Number.isInteger(id) ? await db.one("select * from connections where id = $1 and kind = 'bot' and status <> 'removed'", [id]) : null;
    if (!conn || !safeEqual(ctx.req.headers['x-telegram-bot-api-secret-token'] || '', conn.webhook_secret || '')) return ctx.send(401, 'no');
    const u = parse(ctx);
    if (u) await botUpdates.handleUpdate(conn, u);
    ctx.send(200, 'ok');
  }, { raw: true, limit: 512 * 1024 });
};

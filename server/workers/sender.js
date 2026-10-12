'use strict';
/*
 * The sending queue. Each sending bot ("bot:12" or "platform") is handled by one
 * server at a time (a 30-second lease in sender_leases), at TG_SEND_PER_SECOND
 * messages per second (25 by default, under Telegram's ~30/s limit).
 * It handles Telegram's "slow down" (429), blocked users (403) and retries.
 *
 * No message is ever sent twice: a batch is CLAIMED first (status queued -> sending, with
 * FOR UPDATE SKIP LOCKED), so even if two servers end up working on the same bot (a lease
 * that ran out during a long pause), each row is in only one server's hands.
 * Rows left 'sending' by a crashed server go back to the queue after 10 minutes.
 * Maintenance mode (Admin -> Features) pauses the whole queue.
 */

const crypto = require('node:crypto');
const db = require('../db');
const config = require('../config');
const log = require('../lib/log');
const tg = require('../services/telegram');
const send = require('../services/send');
const drips = require('../services/drips');
const settings = require('../services/settings');
const { decrypt } = require('../lib/util');

const ME = crypto.randomBytes(6).toString('hex');
const running = new Map(); // sender_key -> promise
let stopped = false;
let lastRecover = 0;
const LEASE_RENEW_MS = 5000;

async function lease(key) {
  const r = await db.one(`insert into sender_leases(sender_key, owner, expires_at) values ($1,$2, now() + interval '30 seconds')
    on conflict (sender_key) do update set owner = excluded.owner, expires_at = excluded.expires_at
    where sender_leases.expires_at < now() or sender_leases.owner = excluded.owner returning owner`, [key, ME]);
  return !!r;
}
const release = (key) => db.query('delete from sender_leases where sender_key = $1 and owner = $2', [key, ME]).catch(() => {});

async function tokenFor(key) {
  if (key === 'platform') return config.telegram.botToken;
  const c = await db.one("select token_enc from connections where id = $1 and status <> 'removed'", [Number(key.split(':')[1])]);
  return c && c.token_enc ? decrypt(c.token_enc) : null;
}

/** Load (and cache for this run) what a delivery should say. */
async function contentFor(cache, d) {
  const k = d.broadcast_id ? 'b' + d.broadcast_id : 's' + d.step_id;
  if (cache.has(k)) return cache.get(k);
  let v = null;
  if (d.broadcast_id) {
    const b = await db.one(`select b.body, b.media_id, b.buttons, b.include_stop, b.status, b.pin, b.pin_notify, b.unpin_after_hours, b.delete_after_hours, m.kind as media_kind
      from broadcasts b left join media m on m.id = b.media_id where b.id = $1`, [d.broadcast_id]);
    if (b) {
      v = { body: b.body, media_id: b.media_id, media_kind: b.media_kind, buttons: b.buttons || [], include_stop: b.include_stop, cancelled: b.status === 'cancelled',
        auto: { pin: !!b.pin, notify: !!b.pin_notify, unpin: b.unpin_after_hours || null, del: b.delete_after_hours || null } };
    }
  } else if (d.step_id) {
    const s = await db.one(`select s.id, s.body, s.media_id, s.position, s.sequence_id, s.step_type, s.config, q.trigger_type, q.start_button, q.approve_mode, q.start_label, b.username as bot_username,
        (select min(position) from sequence_steps x where x.sequence_id = s.sequence_id) as first
      from sequence_steps s join sequences q on q.id = s.sequence_id left join connections b on b.id = q.connection_id where s.id = $1`, [d.step_id]);
    if (s) {
      const links = await db.many('select code, label, url, row, kind from links where step_id = $1 order by position, created_at, code', [d.step_id]);
      v = { body: s.body, media_id: s.media_id, buttons: links.map((l) => ({ label: l.label, url: l.url, code: l.code, row: l.row, kind: l.kind })), include_stop: true };
      // Chat bots are a conversation: no "Stop these messages" button (/stop still works). Bot steps carry their kind.
      if (s.trigger_type === 'bot_start') { v.include_stop = false; v.bot = true; }
      if (s.step_type && s.step_type !== 'message') { v.kind = s.step_type; v.config = s.config || {}; v.step_id = s.id; v.sequence_id = s.sequence_id; }
      // A Welcome Flow's welcome sent from here ("Start another flow"): its Tap Start button opens the bot (cvf_<flow>).
      if (s.trigger_type === 'join_request' && s.position === s.first && (s.start_button || s.approve_mode === 'tap') && s.bot_username) {
        v.startButton = { label: s.start_label || require('../services/flows').DEFAULT_START, url: `https://t.me/${s.bot_username}?start=cvf_${s.sequence_id}` };
      }
    }
  }
  cache.set(k, v);
  return v;
}

/** Take up to 200 due messages for this bot and mark them 'sending' so nobody else takes them. */
async function claimBatch(key) {
  const rows = await db.many(`update deliveries d set status = 'sending', sent_at = now()
    where d.id in (select id from deliveries where sender_key = $1 and status = 'queued' and due_at <= now()
      order by priority, due_at, id limit 200 for update skip locked)
    returning d.*, (select s.status from subscribers s where s.id = d.subscriber_id) as sub_status,
      (select s.first_name from subscribers s where s.id = d.subscriber_id) as sub_name`, [key]);
  return rows.sort((a, b) => a.priority - b.priority || new Date(a.due_at) - new Date(b.due_at) || a.id - b.id);
}
/** Put claimed messages we did not get to back in the queue. */
async function unclaim(ids) {
  if (ids.length) await db.query("update deliveries set status = 'queued', sent_at = null where id = any($1::bigint[]) and status = 'sending'", [ids]);
}
const paused = async () => !!(await settings.features()).maintenance;

async function finish(d, fields) {
  await db.query('update deliveries set status = $2, message_id = coalesce($3, message_id), message_id2 = coalesce($5, message_id2), error = $4, sent_at = now(), attempts = attempts + 1 where id = $1',
    [d.id, fields.status, fields.message_id || null, fields.error || null, fields.message_id2 || null]);
}

/**
 * Auto-pin, auto-unpin and auto-delete of a broadcast message that was just sent (services/broadcasts.js checkExtras):
 * queued now for this message, so each person's times count from their own message. extra.auto marks them (one of
 * each per message, deliveries_auto_once), extra.notify = pin with a notification. Never fails the send.
 */
async function followUps(d, content, ids) {
  const a = content.auto;
  if (!a || !d.broadcast_id || !(a.pin || a.del)) return;
  const rows = [];
  if (a.pin) rows.push(['pin', 0, { auto: 1, notify: a.notify ? 1 : 0 }]);
  if (a.pin && a.unpin) rows.push(['unpin', a.unpin * 3600, { auto: 1 }]);
  if (a.del) rows.push(['delete', a.del * 3600, { auto: 1 }]);
  for (const [action, secs, extra] of rows) {
    await db.query(`insert into deliveries(workspace_id, sender_key, action, broadcast_id, subscriber_id, chat_id, message_id, message_id2, priority, due_at, extra)
      values ($1,$2,$3,$4,$5,$6,$7,$8, 4, now() + make_interval(secs => $9), $10) on conflict do nothing`,
    [d.workspace_id, d.sender_key, action, d.broadcast_id, d.subscriber_id, d.chat_id, ids.message_id, ids.message_id2 || null, secs, JSON.stringify(extra)]).catch((e) => log.warn('auto pin/delete not queued', { id: d.id, err: e.message }));
  }
}
/** Telegram lets bots delete messages for 48 hours; an auto-delete that waited longer (a long pause) is skipped. */
const DELETE_WINDOW_MS = 47.9 * 3600000;

/**
 * Send one delivery. A "quick" Welcome Flow step (join_request_id) goes to someone who asked to join and has not
 * tapped Start yet, inside Telegram's 5-minute window; once it is done (sent or failed, not requeued), a join request
 * held for it is let in (then_approve, services/flows.js quickStepDone).
 */
async function deliver(token, key, d, cache) {
  const res = await deliverOne(token, key, d, cache);
  if (d.then_approve && d.join_request_id) {
    const now = await db.one('select status from deliveries where id = $1', [d.id]);
    if (!now || (now.status !== 'queued' && now.status !== 'sending')) await require('../services/flows').quickStepDone(d.join_request_id).catch((e) => log.warn('held join request', { err: e.message }));
  }
  return res;
}

async function deliverOne(token, key, d, cache) {
  const content = await contentFor(cache, d);
  // A cancelled broadcast sends nothing more, but the auto-delete / pin / unpin of the messages it already sent go on.
  if (!content || (content.cancelled && (d.action === 'send' || d.action === 'edit'))) return finish(d, { status: 'skipped', error: 'Message no longer exists' });
  const quick = !!d.join_request_id && d.sub_status === 'joinreq';
  if (d.subscriber_id && d.action === 'send' && d.sub_status && d.sub_status !== 'active' && !quick) return finish(d, { status: 'skipped', error: 'Subscriber stopped or blocked' });
  const isPrivate = !!d.subscriber_id;
  try {
    if (d.action === 'send') {
      let msg = content, parts = {};
      if (content.kind || (d.extra && (d.extra.brand || d.extra.reminder))) {
        // A bot step (check, question, invite, reminder) or the Free plan's line: services/bots.js deliveryParts.
        const conn = await db.one('select id, username from connections where id = $1', [Number(String(key).split(':')[1]) || 0]);
        parts = await require('../services/bots').deliveryParts(content, d, conn || {});
        msg = parts.msg;
      }
      const m = await send.sendOne(msg, { token, botKey: key, chatId: d.chat_id, subscriberId: isPrivate ? d.subscriber_id : null, includeStop: isPrivate && content.include_stop && !parts.replyMarkup, firstName: isPrivate ? d.sub_name : null, startButton: content.startButton || null, footerHtml: parts.footerHtml || '', extraRows: parts.extraRows || null, replyMarkup: parts.replyMarkup || null,
        // Round video + text: the round video's id is saved as soon as it is sent; a retry sends only the text.
        sentFirst: d.message_id || null, onFirst: (id) => db.query('update deliveries set message_id = $2 where id = $1', [d.id, id]) });
      await finish(d, { status: 'sent', message_id: m.message_id, message_id2: m.extra_message_id || null });
      return followUps(d, content, { message_id: m.message_id, message_id2: m.extra_message_id || null });
    }
    if (d.action === 'edit') {
      const reply_markup = send.keyboard(content.buttons, { subscriberId: isPrivate ? d.subscriber_id : null, includeStop: isPrivate && content.include_stop });
      const html = tg.personalize(tg.toHtml(content.body), isPrivate ? d.sub_name : null);
      if (content.media_kind === 'video_note') {
        // A round video has no caption: its text is the message sent right after it (message_id2).
        if (d.message_id2 && String(content.body || '').trim()) await tg.call(token, 'editMessageText', { chat_id: d.chat_id, message_id: d.message_id2, text: html, parse_mode: 'HTML', reply_markup });
      } else if (content.media_id) await tg.call(token, 'editMessageCaption', { chat_id: d.chat_id, message_id: d.message_id, caption: html, parse_mode: 'HTML', reply_markup });
      else await tg.call(token, 'editMessageText', { chat_id: d.chat_id, message_id: d.message_id, text: html, parse_mode: 'HTML', reply_markup });
      return finish(d, { status: 'sent' });
    }
    if (d.action === 'delete') {
      if (d.extra && d.extra.auto && Date.now() - new Date(d.created_at).getTime() > DELETE_WINDOW_MS) return finish(d, { status: 'skipped', error: 'Too late to delete: Telegram lets bots delete messages for 48 hours' });
      await tg.call(token, 'deleteMessage', { chat_id: d.chat_id, message_id: d.message_id });
      if (d.message_id2) await tg.call(token, 'deleteMessage', { chat_id: d.chat_id, message_id: d.message_id2 }).catch(() => {});
      return finish(d, { status: 'sent' });
    }
    if (d.action === 'pin') {
      await tg.call(token, 'pinChatMessage', { chat_id: d.chat_id, message_id: d.message_id2 || d.message_id, disable_notification: !(d.extra && d.extra.notify) });
      return finish(d, { status: 'sent' });
    }
    if (d.action === 'unpin') { await tg.call(token, 'unpinChatMessage', { chat_id: d.chat_id, message_id: d.message_id2 || d.message_id }); return finish(d, { status: 'sent' }); }
  } catch (e) {
    const desc = String(e.description || e.message || '');
    if (e.code === 429) {
      await db.query("update deliveries set status = 'queued', sent_at = null, due_at = now() + make_interval(secs => $2) where id = $1", [d.id, Math.max(1, e.retryAfter || 5)]);
      return { pause: Math.max(1, e.retryAfter || 5) };
    }
    if (/message is not modified|message to delete not found|message to pin not found|message to unpin not found/i.test(desc)) return finish(d, { status: 'sent' });
    if (d.action === 'delete' && /can't be deleted|cannot be deleted/i.test(desc)) return finish(d, { status: 'failed', error: 'Telegram did not let the bot delete it (older than 48 hours, or no delete rights)' });
    if ((d.action === 'pin' || d.action === 'unpin') && /not enough rights|CHAT_ADMIN_REQUIRED|rights/i.test(desc)) return finish(d, { status: 'failed', error: 'The bot is missing the right to pin messages here' });
    if (e.code === 403 && quick) {
      // The window closed (or they cancelled the request): not a block. Their later steps wait for Start.
      return finish(d, { status: 'failed', error: 'Telegram\'s 5-minute window ended before they tapped Start' });
    }
    if (e.code === 403) {
      if (isPrivate) {
        await db.query("update subscribers set status = 'blocked' where id = $1", [d.subscriber_id]);
        await drips.stopFor(d.subscriber_id);
        return finish(d, { status: 'blocked', error: 'Blocked the bot' });
      }
      await db.query("update connections set status = 'error', last_error = $2 where tg_chat_id = $1 and kind <> 'bot'", [d.chat_id, 'Castvoo can no longer post here. Add @' + config.telegram.botUsername + ' as admin again.']);
      return finish(d, { status: 'failed', error: 'No permission to post' });
    }
    if (e.migrateTo) {
      await db.query('update connections set tg_chat_id = $2 where tg_chat_id = $1', [d.chat_id, e.migrateTo]);
      await db.query("update deliveries set status = 'queued', sent_at = null, chat_id = $2, due_at = now() where id = $1", [d.id, e.migrateTo]);
      return null;
    }
    if (e.code >= 500 || e.code === 599) {
      if (d.attempts < 4) {
        await db.query("update deliveries set status = 'queued', sent_at = null, attempts = attempts + 1, due_at = now() + make_interval(secs => $2), error = $3 where id = $1", [d.id, 15 * (d.attempts + 1), desc.slice(0, 200)]);
        return null;
      }
    }
    if (e.code === 401) {
      await db.query("update connections set status = 'error', last_error = 'The bot token stopped working. Reconnect the bot.' where id = $1", [Number(String(key).split(':')[1]) || 0]);
    }
    return finish(d, { status: 'failed', error: desc.replace(/^Bad Request: /, '').slice(0, 200) });
  }
  return finish(d, { status: 'skipped', error: 'Unknown action' });
}

async function runKey(key) {
  const token = await tokenFor(key);
  if (!token) {
    await db.query("update deliveries set status = 'skipped', error = 'Connection removed' where sender_key = $1 and status = 'queued'", [key]);
    return release(key);
  }
  const perSec = Math.max(1, config.telegram.sendPerSecond);
  const gap = 1000 / perSec;
  const cache = new Map();
  let lastLease = Date.now();
  // Keep the lease fresh, also in the middle of a batch (a slow batch used to outlive the 30-second lease).
  const keepLease = async () => {
    if (Date.now() - lastLease <= LEASE_RENEW_MS) return true;
    if (!(await lease(key))) return false;
    lastLease = Date.now();
    return true;
  };
  try {
    while (!stopped) {
      if (!(await keepLease())) return;
      if (await paused()) return;
      const batch = await claimBatch(key);
      if (!batch.length) return;
      const inflight = new Set();
      // Messages to the same chat go one after another, in queue order: a round video + its text (two Telegram calls)
      // or a first-time file upload must not let the next step overtake it (round video, voice note, THEN the text).
      const lastForChat = new Map();
      let pauseUntil = 0;
      let i = 0;
      let lost = false;
      for (; i < batch.length; i++) {
        const d = batch[i];
        if (stopped) break;
        if (Date.now() < pauseUntil) break;
        if (!(await keepLease())) { lost = true; break; }
        const prev = lastForChat.get(String(d.chat_id));
        const one = async () => {
          if (prev) {
            await prev;
            // A 429 or a stop while it waited: put it back for the next round instead of sending into the pause.
            if (stopped || Date.now() < pauseUntil) { await unclaim([d.id]); return; }
          }
          const res = await deliver(token, key, d, cache);
          if (res && res.pause) pauseUntil = Math.max(pauseUntil, Date.now() + res.pause * 1000);
        };
        const p = one()
          .catch(async (e) => {
            log.error('deliver crashed', { id: d.id, err: e });
            await unclaim([d.id]).catch(() => {});
          }).finally(() => inflight.delete(p));
        lastForChat.set(String(d.chat_id), p);
        inflight.add(p);
        if (inflight.size >= perSec * 2) await Promise.race(inflight);
        await new Promise((r) => setTimeout(r, gap));
      }
      await Promise.all(inflight);
      await unclaim(batch.slice(i).map((d) => d.id));
      if (lost) return;
      if (pauseUntil > Date.now()) await new Promise((r) => setTimeout(r, pauseUntil - Date.now()));
    }
  } finally {
    await release(key);
  }
}

async function tick() {
  if (stopped || (await paused())) return; // shutting down, or maintenance mode
  // Messages left 'sending' by a server that crashed mid-send go back to the queue.
  if (Date.now() - lastRecover > 60000) {
    lastRecover = Date.now();
    await db.query("update deliveries set status = 'queued', sent_at = null where status = 'sending' and sent_at < now() - interval '10 minutes'");
  }
  const keys = await db.many("select sender_key from deliveries where status = 'queued' and due_at <= now() group by sender_key limit 200");
  for (const { sender_key: key } of keys) {
    if (running.has(key)) continue;
    if (!(await lease(key))) continue;
    const p = runKey(key).catch((e) => log.error('sender failed', { key, err: e })).finally(() => running.delete(key));
    running.set(key, p);
  }
}

async function stop() { stopped = true; await Promise.all([...running.values()]); }

module.exports = { tick, stop, running };

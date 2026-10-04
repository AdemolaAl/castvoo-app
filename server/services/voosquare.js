'use strict';
/*
 * Castvoo ↔ VooSquare (see the "VooSquare Integration Spec").
 *
 * Castvoo → VooSquare (queued in the `outbox` table, sent by a background loop, retried for a day):
 *   events          POST <VOO_BASE>/api/v1/events             { events: [ {event_id, voo_id, type, label, value_usd, occurred_at} ] }
 *   support message POST <VOO_BASE>/api/v1/support/messages   { email, name, subject, body, external_ref, voo_id }
 *   Header: Authorization: Bearer <VOO_API_KEY>   (plus X-Voo-Signature when VOO_WEBHOOK_SECRET is set)
 *
 * VooSquare → Castvoo: see server/routes/voosquare.js.
 * Nothing is sent unless VOO_BASE and VOO_API_KEY are set. No end-customer personal data is sent in events.
 */

const db = require('../db');
const config = require('../config');
const log = require('../lib/log');
const { hmac, randomToken } = require('../lib/util');

const V = () => config.voosquare;
const eventsUrl = () => V().eventsUrl || (V().base ? V().base + '/api/v1/events' : '');
const enabled = () => !!(eventsUrl() && V().apiKey);
const supportEnabled = () => !!(V().base && V().apiKey);

async function event(type, { voo_id = null, workspace_id = null, label = '', value_usd = null } = {}) {
  if (!enabled()) return;
  let vid = voo_id;
  if (!vid && workspace_id) {
    const r = await db.one('select u.voo_id from workspaces w join users u on u.id = w.owner_user_id where w.id = $1', [workspace_id]);
    vid = r && r.voo_id;
  }
  if (!vid) return; // VooSquare only shows events for people who use VooSquare
  const payload = { event_id: 'cv_' + randomToken(12), voo_id: vid, type, occurred_at: new Date().toISOString(), label: String(label).slice(0, 120) };
  if (value_usd != null) payload.value_usd = value_usd;
  await db.query('insert into outbox(kind, payload) values ($1,$2)', ['voosquare', JSON.stringify(payload)]);
}

/** Copy a customer's support message into the VooSquare HQ inbox (same conversation each time). */
async function supportMessage({ threadId, user, subject, body }) {
  if (!supportEnabled() || !user.email) return;
  await db.query('insert into outbox(kind, payload) values ($1,$2)', ['voo_support', JSON.stringify({
    email: user.email, name: user.name || '', subject: String(subject || '').slice(0, 120), body: String(body).slice(0, 4000),
    external_ref: 'castvoo-' + threadId, voo_id: user.voo_id || undefined,
  })]);
}

async function post(url, payload) {
  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + V().apiKey };
  if (V().webhookSecret) headers['X-Voo-Signature'] = hmac(V().webhookSecret, body);
  const r = await fetch(url, { method: 'POST', body, headers, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
}

async function flush() {
  if (!enabled() && !supportEnabled()) return;
  await db.tx(async (c) => {
    const rows = (await c.query("select * from outbox where sent_at is null and next_at <= now() and attempts < 40 order by id limit 100 for update skip locked")).rows;
    const fail = async (ids, e) => {
      for (const row of rows.filter((x) => ids.includes(x.id))) {
        const wait = Math.min(3600, 30 * 2 ** Math.min(row.attempts, 7));
        await c.query('update outbox set attempts = attempts + 1, next_at = now() + make_interval(secs => $2), last_error = $3 where id = $1', [row.id, wait, String(e.message).slice(0, 200)]);
      }
      log.warn('voosquare send failed', { ids, err: e.message });
    };
    // Events go in one batch call (up to 100).
    const events = rows.filter((r) => r.kind === 'voosquare');
    if (events.length && enabled()) {
      try {
        await post(eventsUrl(), { events: events.map((r) => r.payload) });
        await c.query('update outbox set sent_at = now() where id = any($1)', [events.map((r) => r.id)]);
      } catch (e) { await fail(events.map((r) => r.id), e); }
    }
    for (const row of rows.filter((r) => r.kind === 'voo_support')) {
      if (!supportEnabled()) break;
      try {
        await post(V().base + '/api/v1/support/messages', row.payload);
        await c.query('update outbox set sent_at = now() where id = $1', [row.id]);
      } catch (e) { await fail([row.id], e); }
    }
  });
}

module.exports = { event, supportMessage, flush, enabled, supportEnabled };

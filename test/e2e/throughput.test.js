'use strict';
/*
 * The sender under load: 3,000 subscribers on one bot at TG_SEND_PER_SECOND=200.
 *  - the per-second rate stays at (or under) the setting
 *  - everyone gets exactly one message
 *  - two sender instances (two "servers") never send the same message twice, even when
 *    their leases are forced to expire in the middle of sending
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startApp, sleep } = require('../helpers/app');

let app;
before(async () => { app = await startApp({ env: { TG_SEND_PER_SECOND: '200' } }); });
after(async () => { if (app) await app.stop(); });

/** A second, independent copy of the sender module = a second server with its own lease owner id. */
function secondSender() {
  const p = path.join(__dirname, '..', '..', 'server', 'workers', 'sender.js');
  const original = require.cache[p];
  delete require.cache[p];
  const copy = require(p);
  require.cache[p] = original;
  return copy;
}

function maxPerSecond(times) {
  const t = [...times].sort((a, b) => a - b);
  let best = 0;
  for (let i = 0, j = 0; i < t.length; i++) {
    while (t[i] - t[j] >= 1000) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

async function bigBroadcast(email, n, from) {
  const c = await app.loginByEmail(email);
  const bot = await app.connectBot(c);
  await app.addSubscribers(bot.connId, n, { from });
  const r = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Load test' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.queued, n);
  assert.equal(r.body.seconds, Math.ceil(n / 200));
  return { c, bot, id: r.body.id };
}

const left = async (id) => (await app.db.one("select count(*)::int n from deliveries where broadcast_id = $1 and status in ('queued','sending')", [id])).n;

describe('sender throughput', () => {
  it('3,000 subscribers: rate respected, exactly one message each, with two servers ticking', async () => {
    const { bot, id } = await bigBroadcast('load@example.com', 3000, 7000000);
    const s1 = app.sender;
    const s2 = secondSender();
    const started = Date.now();
    while (await left(id)) {
      await Promise.all([s1.tick(), s2.tick()]);
      await Promise.all([...s1.running.values(), ...s2.running.values()]);
      if (Date.now() - started > 90000) throw new Error('took too long');
      await sleep(10);
    }
    const secs = (Date.now() - started) / 1000;
    const calls = app.fakes.tgCalls('sendMessage', bot.token);
    assert.equal(calls.length, 3000, 'one call per subscriber');
    assert.equal(new Set(calls.map((c) => c.params.chat_id)).size, 3000, 'no duplicates');
    const peak = maxPerSecond(calls.map((c) => c.at));
    assert.ok(peak <= 200 * 1.1, `peak ${peak}/s must stay at about 200/s`);
    const avg = 3000 / secs;
    assert.ok(avg >= 100, `average ${avg.toFixed(0)}/s is too slow`);
    await app.jobs.broadcastsTick();
    const b = await app.db.one('select status, sent, failed from broadcasts where id = $1', [id]);
    assert.deepEqual(b, { status: 'sent', sent: 3000, failed: 0 });
    await s2.stop();
  });

  it('leases forced to expire mid-send: two servers take turns but nobody gets two messages', async () => {
    const { bot, id } = await bigBroadcast('chaos@example.com', 1500, 8000000);
    const s1 = app.require('workers/sender');
    const s2 = secondSender();
    // Every 400 ms, pretend the current lease holder froze: its lease expires and the other server may take over.
    const chaos = setInterval(() => { app.db.query("update sender_leases set expires_at = now() - interval '1 second'").catch(() => {}); }, 400);
    let takeovers = 0;
    const owners = new Set();
    const watch = setInterval(() => { app.db.one('select owner from sender_leases where sender_key = $1', ['bot:' + bot.connId]).then((r) => { if (r && !owners.has(r.owner)) { owners.add(r.owner); takeovers++; } }).catch(() => {}); }, 50);
    try {
      const started = Date.now();
      const loop = async (s) => {
        while (await left(id)) {
          await s.tick();
          await Promise.all([...s.running.values()]);
          if (Date.now() - started > 90000) throw new Error('took too long');
          await sleep(5);
        }
      };
      await Promise.all([loop(s1), loop(s2)]);
    } finally { clearInterval(chaos); clearInterval(watch); }
    const calls = app.fakes.tgCalls('sendMessage', bot.token);
    const perChat = new Map();
    for (const c of calls) perChat.set(c.params.chat_id, (perChat.get(c.params.chat_id) || 0) + 1);
    const dupes = [...perChat.values()].filter((n) => n > 1).length;
    assert.equal(dupes, 0, `${dupes} people got the message more than once`);
    assert.equal(perChat.size, 1500);
    assert.ok(takeovers >= 1);
    await app.jobs.broadcastsTick();
    assert.equal((await app.db.one('select sent from broadcasts where id = $1', [id])).sent, 1500);
    await s2.stop();
  });

  it('a delivery left "sending" by a crashed server goes back to the queue', async () => {
    const c = await app.loginByEmail('crash@example.com');
    const bot = await app.connectBot(c);
    await app.start(bot.connId, 990001);
    const r = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Crash' });
    await app.db.query("update deliveries set status = 'sending', sent_at = now() - interval '11 minutes' where broadcast_id = $1", [r.body.id]);
    const s = secondSender(); // fresh module: runs its recovery on the first tick
    await s.tick();
    await Promise.all([...s.running.values()]);
    await app.drain();
    assert.equal((await app.db.one('select status from deliveries where broadcast_id = $1', [r.body.id])).status, 'sent');
    await s.stop();
  });
});

describe('scale', () => {
  it('daily cap, click audiences and data deletion stay fast with a big history', async () => {
    const c = await app.loginByEmail('history@example.com');
    const bot = await app.connectBot(c);
    const ws = await app.ws(c);
    await app.addSubscribers(bot.connId, 20000, { from: 9000000 });
    // 200,000 old deliveries (10 per subscriber), like a workspace that has been sending for months.
    await app.db.query(`insert into deliveries(workspace_id, sender_key, subscriber_id, chat_id, status, created_at, sent_at)
      select $1, $3, s.id, s.tg_user_id, 'sent', now() - interval '3 days', now() - interval '3 days' from subscribers s, generate_series(1,10) where s.connection_id = $2`, [ws.id, bot.connId, 'bot:' + bot.connId]);
    await app.db.query("insert into links(code, workspace_id, label, url) values ('histlnk', $1, 'x', 'https://e.com')", [ws.id]);
    await app.db.query("insert into clicks(code, workspace_id, subscriber_id, created_at) select 'histlnk', $1, s.id, now() - interval '2 days' from subscribers s where s.connection_id = $2 and s.tg_user_id % 4 = 0", [ws.id, bot.connId]);
    await app.db.query('analyze');
    await c.post('/api/app/settings', { daily_cap: 2 });
    let t = Date.now();
    const seg = await c.post('/api/segments', { name: 'clickers', rules: [{ field: 'clicked_days', value: 7 }] });
    assert.equal(seg.body.segment.count, 5000);
    const r = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Capped', segment_id: seg.body.segment.id });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.queued, 5000);
    assert.ok(Date.now() - t < 8000, `queueing took ${Date.now() - t} ms`);
    await app.db.query("update deliveries set status = 'skipped' where broadcast_id = $1", [r.body.id]);
    t = Date.now();
    await app.db.query('delete from subscribers where connection_id = $1', [bot.connId]);
    assert.ok(Date.now() - t < 8000, `deleting 20,000 subscribers took ${Date.now() - t} ms`);
  });
});

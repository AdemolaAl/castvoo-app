'use strict';
/* Broadcasts end to end: compose, links, media, limits, audiences, scheduling, approval, actions, the sender. */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, FILES } = require('../helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { if (app) await app.stop(); });
beforeEach(() => { app.rl._reset(); app.fakes.tg.rate429 = { n: 0, retryAfter: 1 }; app.fakes.tg.fail5xx = 0; });

const sendsTo = (token) => app.fakes.tgCalls(null, token).filter((c) => /^send/.test(c.method));
const upload = (c, buf, type, name = 'pic') => c.post('/api/media', buf, { headers: { 'content-type': type, 'x-filename': name } });

/** A workspace owner with a bot and `n` subscribers who pressed Start (tg ids base+1..base+n). */
async function setup(email, n = 3, base = 20000) {
  const c = await app.loginByEmail(email);
  const bot = await app.connectBot(c);
  for (let i = 1; i <= n; i++) await app.start(bot.connId, base + i);
  return { c, bot, ws: await app.ws(c), ids: Array.from({ length: n }, (_, i) => base + i + 1) };
}

describe('sending a broadcast', () => {
  it('text broadcast reaches every active subscriber once, with formatting and the stop button', async () => {
    const { c, bot, ids } = await setup('text@example.com', 4, 21000);
    await app.db.query("update subscribers set status = 'stopped' where connection_id = $1 and tg_user_id = $2", [bot.connId, ids[3]]);
    const est = await c.get(`/api/broadcasts/estimate?connection_id=${bot.connId}`);
    assert.equal(est.body.audience, 3);
    const r = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Hello *friends* & <fans>\nNew _drop_ today' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.status, 'sending');
    assert.equal(r.body.queued, 3);
    await app.flush();
    const sent = sendsTo(bot.token);
    assert.deepEqual(sent.map((s) => s.params.chat_id).sort(), ids.slice(0, 3).sort());
    const m = sent[0];
    assert.equal(m.params.parse_mode, 'HTML');
    assert.equal(m.params.text, 'Hello <b>friends</b> &amp; &lt;fans&gt;\nNew <i>drop</i> today');
    assert.deepEqual(m.params.reply_markup.inline_keyboard.pop()[0], { text: '🔕 Stop these messages', callback_data: 'cv_stop' });
    const b = (await c.get('/api/broadcasts/' + r.body.id)).body.broadcast;
    assert.equal(b.status, 'sent');
    assert.equal(b.sent, 3);
    assert.equal(b.failed, 0);
    assert.equal(b.title, 'Hello friends & <fans>');
    // Nobody got a second copy.
    await app.flush();
    assert.equal(sendsTo(bot.token).length, 3);
  });

  it('a broadcast with nobody to send to finishes at once', async () => {
    const c = await app.loginByEmail('empty@example.com');
    const bot = await app.connectBot(c);
    const r = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Anyone?' });
    assert.equal(r.body.status, 'sent');
    assert.equal(r.body.queued, 0);
  });

  it('buttons become tracked links that know which subscriber clicked; forged signatures are anonymous', async () => {
    const { c, bot, ids } = await setup('buttons@example.com', 2, 22000);
    const r = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Shop now', buttons: [{ label: 'Shop', url: 'example.com/shop?x=1' }, { label: 'Help', url: 'https://example.com/help' }] });
    assert.equal(r.status, 200, r.text);
    await app.flush();
    const msg = sendsTo(bot.token).find((s) => s.params.chat_id === ids[0]);
    const rows = msg.params.reply_markup.inline_keyboard;
    assert.equal(rows.length, 3, 'two buttons + stop');
    const shopUrl = new URL(rows[0][0].url);
    assert.equal(shopUrl.origin, app.url);
    assert.match(shopUrl.pathname, /^\/l\/[a-z0-9]{7}$/);
    const subId = (await app.db.one('select id from subscribers where connection_id = $1 and tg_user_id = $2', [bot.connId, ids[0]])).id;
    assert.match(shopUrl.searchParams.get('s'), new RegExp(`^${subId}\\.[0-9a-f]{10}$`));

    const click = await app.client().get(shopUrl.pathname + shopUrl.search);
    assert.equal(click.status, 302);
    assert.equal(click.headers.get('location'), 'https://example.com/shop?x=1');
    const forged = await app.client().get(`${shopUrl.pathname}?s=${subId + 1}.0000000000`);
    assert.equal(forged.status, 302);
    const plain = await app.client().get(shopUrl.pathname);
    assert.equal(plain.status, 302);
    const code = shopUrl.pathname.split('/').pop();
    await app.waitFor(async () => (await app.db.one('select count(*)::int n from clicks where code = $1', [code])).n === 3);
    const clicks = await app.db.many('select subscriber_id from clicks where code = $1 order by id', [code]);
    assert.deepEqual(clicks.map((x) => x.subscriber_id), [subId, null, null]);
    assert.equal((await app.client().get('/l/zzzzzzz')).status, 404);

    const links = await c.get('/api/links');
    const shop = links.body.links.find((l) => l.code === code);
    assert.equal(shop.clicks, 3);
    assert.equal(shop.people, 1);
    const detail = await c.get('/api/broadcasts/' + r.body.id);
    assert.equal(detail.body.links.find((l) => l.code === code).clicks, 3);
    assert.equal((await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'x', buttons: [{ label: 'Bad', url: 'javascript:alert(1)' }] })).status, 400);
    assert.equal((await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'x', buttons: Array.from({ length: 7 }, (_, i) => ({ label: 'B' + i, url: 'https://e.com' })) })).status, 400);
  });

  it('include_stop:false leaves the stop button out', async () => {
    const { c, bot } = await setup('nostop@example.com', 1, 23000);
    await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'No stop', include_stop: false });
    await app.flush();
    assert.equal(sendsTo(bot.token)[0].params.reply_markup, undefined);
  });

  it('message length limits: 4,096 for text, 1,024 with media; formatting marks do not count', async () => {
    const { c, bot } = await setup('limits@example.com', 1, 24000);
    assert.equal((await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'a'.repeat(4097) })).status, 400);
    const ok = await c.post('/api/broadcasts', { connection_id: bot.connId, body: '*' + 'a'.repeat(4096) + '*' });
    assert.equal(ok.status, 200, ok.text);
    await app.flush();
    const b = await app.db.one('select sent, failed from broadcasts where id = $1', [ok.body.id]);
    assert.deepEqual(b, { sent: 1, failed: 0 }, 'Telegram accepted 4,096 visible characters');
    const emoji = await c.post('/api/broadcasts', { connection_id: bot.connId, body: '😀'.repeat(4096) });
    assert.equal(emoji.status, 200, 'emoji count as one character each');
    const m = await upload(c, FILES.jpg(), 'image/jpeg');
    assert.equal((await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'a'.repeat(1025), media_id: m.body.media.id })).status, 400);
    assert.equal((await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'a'.repeat(1024), media_id: m.body.media.id })).status, 200);
    assert.equal((await c.post('/api/broadcasts', { connection_id: bot.connId, body: '   ' })).status, 400);
  });

  it('a subscriber who blocked the bot is marked blocked; the broadcast counts it as failed', async () => {
    const { c, bot, ids } = await setup('blocked@example.com', 3, 25000);
    app.fakes.tg.block(ids[1]);
    const r = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Hi' });
    await app.flush();
    const b = await app.db.one('select status, sent, failed from broadcasts where id = $1', [r.body.id]);
    assert.deepEqual(b, { status: 'sent', sent: 2, failed: 1 });
    assert.equal((await app.db.one('select status from subscribers where connection_id = $1 and tg_user_id = $2', [bot.connId, ids[1]])).status, 'blocked');
    const d = await c.get('/api/broadcasts/' + r.body.id);
    assert.equal(d.body.errors[0].error, 'Blocked the bot');
    // Next broadcast skips them.
    app.fakes.reset();
    await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Again' });
    await app.flush();
    assert.equal(sendsTo(bot.token).length, 2);
  });

  it('Telegram "slow down" (429): waits retry_after, then sends everything exactly once', async () => {
    const { c, bot, ids } = await setup('slow@example.com', 10, 26000);
    app.fakes.reset();
    app.fakes.tg.rateLimit(2, 1);
    const r = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Throttled' });
    await app.flush();
    const calls = app.fakes.tgCalls('sendMessage', bot.token);
    const ok = new Map();
    for (const call of calls) ok.set(call.params.chat_id, (ok.get(call.params.chat_id) || 0) + 1);
    // 2 calls were 429s, everyone else got exactly one successful message.
    assert.equal(calls.length, 12);
    for (const id of ids) assert.ok(ok.get(id) >= 1, 'got message: ' + id);
    const b = await app.db.one('select sent, failed from broadcasts where id = $1', [r.body.id]);
    assert.deepEqual(b, { sent: 10, failed: 0 });
    const delivered = await app.db.one("select count(*)::int n, count(distinct subscriber_id)::int d from deliveries where broadcast_id = $1 and status = 'sent'", [r.body.id]);
    assert.deepEqual(delivered, { n: 10, d: 10 });
    // After the first 429 the sender paused for about retry_after seconds.
    const first429 = calls[0].at;
    const quiet = calls.filter((x) => x.at > first429 + 150 && x.at < first429 + 850);
    assert.equal(quiet.length, 0, 'no calls during the retry_after pause');
  });

  it('a Telegram server error is retried later', async () => {
    const { c, bot } = await setup('retry@example.com', 1, 27000);
    app.fakes.tg.fail5xx = 1;
    const r = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Retry me' });
    await app.flush();
    const d = await app.db.one('select status, attempts, due_at from deliveries where broadcast_id = $1', [r.body.id]);
    assert.equal(d.status, 'queued');
    assert.equal(d.attempts, 1);
    assert.ok(new Date(d.due_at) > new Date(), 'retry is in the future');
    await app.db.query('update deliveries set due_at = now() where broadcast_id = $1', [r.body.id]);
    await app.flush();
    assert.equal((await app.db.one('select status from broadcasts where id = $1', [r.body.id])).status, 'sent');
    assert.equal((await app.db.one('select sent from broadcasts where id = $1', [r.body.id])).sent, 1);
  });

  it('a revoked bot token marks the connection as broken', async () => {
    const { c, bot } = await setup('revoked@example.com', 1, 28000);
    await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'x' });
    app.fakes.tg.markInvalid(bot.token);
    await app.flush();
    const conn = await app.db.one('select status, last_error from connections where id = $1', [bot.connId]);
    assert.equal(conn.status, 'error');
    assert.match(conn.last_error, /token/);
  });

  it('"broadcast finished" email only for 100+ recipients', async () => {
    const { c, bot } = await setup('big@example.com', 0);
    await app.addSubscribers(bot.connId, 120, { from: 3000000 });
    const r = await c.post('/api/broadcasts', { connection_id: bot.connId, title: 'Mega sale', body: 'Big one' });
    assert.equal(r.body.queued, 120);
    await app.flush();
    const e = app.fakes.lastEmail('big@example.com', /has finished sending/);
    assert.ok(e, 'email sent');
    assert.match(e.subject, /Mega sale/);
    assert.match(e.text, /120/);
    const small = await setup('small@example.com', 2, 29000);
    await small.c.post('/api/broadcasts', { connection_id: small.bot.connId, body: 'Tiny' });
    await app.flush();
    assert.equal(app.fakes.lastEmail('small@example.com', /has finished sending/), null);
  });
});

describe('media', () => {
  it('upload checks type, magic bytes and size; only the owner workspace can read it', async () => {
    const c = await app.loginByEmail('media@example.com');
    const ok = await upload(c, FILES.jpg(), 'image/jpeg', 'promo.jpg');
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.media.kind, 'photo');
    assert.equal(ok.body.media.filename, 'promo.jpg');
    assert.equal((await upload(c, FILES.png(), 'image/jpeg')).status, 400, 'PNG bytes sent as JPEG');
    assert.equal((await upload(c, Buffer.from('<?php echo 1; ?>'), 'image/png')).status, 400);
    assert.equal((await upload(c, Buffer.from('hello'), 'text/html')).status, 400);
    assert.equal((await upload(c, Buffer.alloc(0), 'image/jpeg')).status, 400);
    const big = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(10 * 1024 * 1024)]);
    const tooBig = await upload(c, big, 'image/jpeg');
    assert.equal(tooBig.status, 413);
    const evil = await upload(c, FILES.jpg(), 'image/jpeg', '../../etc/passwd');
    assert.equal(evil.status, 200);
    assert.ok(!evil.body.media.filename.includes('/'));
    const row = await app.db.one('select path from media where id = $1', [evil.body.media.id]);
    assert.ok(row.path.startsWith(app.uploadDir), 'file stays in the upload folder');
    const get = await c.get('/api/media/' + ok.body.media.id);
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('content-type'), 'image/jpeg');
    const other = await app.loginByEmail('media-other@example.com');
    assert.equal((await other.get('/api/media/' + ok.body.media.id)).status, 404);
    assert.equal((await other.post('/api/broadcasts', { connection_id: 1, body: 'x', media_id: ok.body.media.id })).status, 400);
    // Logged-out and no CSRF header are refused.
    assert.equal((await app.client().post('/api/media', FILES.jpg(), { headers: { 'content-type': 'image/jpeg' } })).status, 401);
    assert.equal((await c.post('/api/media', FILES.jpg(), { csrf: false, headers: { 'content-type': 'image/jpeg' } })).status, 403);
  });

  it('a photo is uploaded to Telegram once per bot, then reused by file_id', async () => {
    const { c, bot } = await setup('photo@example.com', 6, 30000);
    const m = await upload(c, FILES.jpg(), 'image/jpeg', 'sale.jpg');
    app.fakes.reset();
    const before = app.fakes.tg.uploads.length;
    const r = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Look *at* this', media_id: m.body.media.id });
    assert.equal(r.status, 200, r.text);
    await app.flush();
    const photos = app.fakes.tgCalls('sendPhoto', bot.token);
    assert.equal(photos.length, 6);
    assert.equal(app.fakes.tg.uploads.length - before, 1, 'uploaded exactly once');
    const byFileId = photos.filter((p) => typeof p.params.photo === 'string');
    assert.equal(byFileId.length, 5);
    assert.ok(byFileId.every((p) => p.params.photo === app.fakes.tg.uploads[app.fakes.tg.uploads.length - 1].file_id));
    assert.equal(photos[0].params.caption, 'Look <b>at</b> this');
    // Second broadcast: no upload at all.
    await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Again', media_id: m.body.media.id });
    await app.flush();
    assert.equal(app.fakes.tg.uploads.length - before, 1);
    // Editing a photo message changes its caption.
    assert.equal((await c.post(`/api/broadcasts/${r.body.id}/edit`, { body: 'a'.repeat(1025) })).status, 400, 'caption limit on edit');
    const e = await c.post(`/api/broadcasts/${r.body.id}/edit`, { body: 'New *caption*' });
    assert.equal(e.body.editing, 6);
    await app.flush();
    const caps = app.fakes.tgCalls('editMessageCaption', bot.token);
    assert.equal(caps.length, 6);
    assert.equal(caps[0].params.caption, 'New <b>caption</b>');
  });

  it('a video is sent with sendVideo and streaming on', async () => {
    const { c, bot } = await setup('video@example.com', 1, 31000);
    const m = await upload(c, FILES.mp4(), 'video/mp4', 'clip.mp4');
    assert.equal(m.body.media.kind, 'video');
    await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Watch', media_id: m.body.media.id });
    await app.flush();
    const v = app.fakes.tgCalls('sendVideo', bot.token)[0];
    assert.ok(v.params.video.file);
    assert.equal(v.params.supports_streaming, 'true');
  });

  it('media switched off', async () => {
    const c = await app.loginByEmail('nomedia@example.com');
    await app.setFeature('media', false);
    try { assert.equal((await upload(c, FILES.jpg(), 'image/jpeg')).status, 403); } finally { await app.setFeature('media', true); }
  });
});

describe('channels and groups', () => {
  it('a channel broadcast is one post in the chat, without a stop button or per-person links', async () => {
    const c = await app.loginByEmail('chan@example.com');
    const ws = await app.ws(c);
    const conn = await app.db.one("insert into connections(workspace_id, kind, tg_chat_id, title, member_count) values ($1,'channel',-100777,'News',500) returning id", [ws.id]);
    const est = await c.get('/api/broadcasts/estimate?connection_id=' + conn.id);
    assert.deepEqual(est.body, { audience: 500, seconds: 1, kind: 'channel' });
    app.fakes.reset();
    const r = await c.post('/api/broadcasts', { connection_id: conn.id, body: 'Channel post', buttons: [{ label: 'Go', url: 'https://example.com' }], include_stop: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.queued, 1);
    await app.flush();
    const calls = app.fakes.tgCalls('sendMessage', app.platformBotToken);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.chat_id, -100777);
    const kb = calls[0].params.reply_markup.inline_keyboard;
    assert.equal(kb.length, 1, 'no stop button');
    assert.ok(!kb[0][0].url.includes('?s='));
    assert.equal((await app.db.one('select include_stop from broadcasts where id = $1', [r.body.id])).include_stop, false);
    assert.equal((await c.post('/api/broadcasts', { connection_id: conn.id, body: 'x', send_mode: 'local9' })).status, 400);
    const seg = await c.post('/api/segments', { name: 'all', rules: [] });
    assert.equal((await c.post('/api/broadcasts', { connection_id: conn.id, body: 'x', segment_id: seg.body.segment.id })).status, 400);
  });

  it('a channel where Castvoo lost its rights goes to error', async () => {
    const c = await app.loginByEmail('chan403@example.com');
    const ws = await app.ws(c);
    const conn = await app.db.one("insert into connections(workspace_id, kind, tg_chat_id, title) values ($1,'channel',-100888,'Gone') returning id", [ws.id]);
    app.fakes.tg.forbiddenChats.add('-100888');
    await c.post('/api/broadcasts', { connection_id: conn.id, body: 'x' });
    await app.flush();
    assert.equal((await app.db.one('select status from connections where id = $1', [conn.id])).status, 'error');
  });
});

describe('audiences (segments)', () => {
  let c, bot, ws, subs;
  before(async () => {
    c = await app.loginByEmail('segments@example.com');
    bot = await app.connectBot(c);
    ws = await app.ws(c);
    const ins = (tg, lang, source, tags, joinedDaysAgo) => app.db.one(`insert into subscribers(connection_id, tg_user_id, first_name, lang, source, tags, joined_at)
      values ($1,$2,'S',$3,$4,$5, now() - make_interval(days => $6)) returning id`, [bot.connId, tg, lang, source, tags, joinedDaysAgo]);
    subs = {
      A: await ins(41001, 'fr', 'fb', ['vip'], 0),
      B: await ins(41002, 'en', 'ig', [], 10),
      C: await ins(41003, 'fr-CA', null, ['vip'], 10),
    };
    await app.db.query("insert into links(code, workspace_id, label, url) values ('segclik', $1, 'x', 'https://e.com')", [ws.id]);
    await app.db.query("insert into clicks(code, workspace_id, subscriber_id, created_at) values ('segclik', $1, $2, now() - interval '2 days'), ('segclik', $1, $3, now() - interval '20 days')", [ws.id, subs.A.id, subs.C.id]);
  });

  const cases = [
    ['source', [{ field: 'source', value: 'fb' }], ['A']],
    ['tag', [{ field: 'tag', value: 'vip' }], ['A', 'C']],
    ['lang', [{ field: 'lang', value: 'fr' }], ['A', 'C']],
    ['joined_days', [{ field: 'joined_days', value: 3 }], ['A']],
    ['clicked_days', [{ field: 'clicked_days', value: 7 }], ['A']],
    ['quiet_days', [{ field: 'quiet_days', value: 7 }], ['B', 'C']],
    ['two rules (AND)', [{ field: 'lang', value: 'fr' }, { field: 'quiet_days', value: 7 }], ['C']],
  ];
  for (const [name, rules, expected] of cases) {
    it(`rule ${name}: preview count and the broadcast reach the same people`, async () => {
      const p = await c.post('/api/segments/preview', { rules, connection_id: bot.connId });
      assert.equal(p.body.count, expected.length);
      const s = await c.post('/api/segments', { name, rules });
      assert.equal(s.status, 200, s.text);
      assert.equal(s.body.segment.count, expected.length);
      app.fakes.reset();
      const r = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Seg ' + name, segment_id: s.body.segment.id });
      assert.equal(r.body.queued, expected.length);
      await app.flush();
      const got = sendsTo(bot.token).map((x) => x.params.chat_id).sort();
      assert.deepEqual(got, expected.map((k) => ({ A: 41001, B: 41002, C: 41003 })[k]).sort());
    });
  }

  it('bad rules are refused; another workspace\'s audience can\'t be used; delete', async () => {
    assert.equal((await c.post('/api/segments', { name: 'x', rules: [{ field: 'evil', value: 1 }] })).status, 400);
    assert.equal((await c.post('/api/segments', { name: 'x', rules: [{ field: 'joined_days', value: 0 }] })).status, 400);
    assert.equal((await c.post('/api/segments', { name: 'x', rules: [{ field: 'tag', value: '' }] })).status, 400);
    assert.equal((await c.post('/api/segments', { name: 'x', rules: Array(7).fill({ field: 'tag', value: 'a' }) })).status, 400);
    const injection = await c.post('/api/segments/preview', { rules: [{ field: 'source', value: "x' or 1=1 --" }] });
    assert.equal(injection.body.count, 0);
    const other = await app.loginByEmail('segthief@example.com');
    const ob = await app.connectBot(other);
    const mine = (await c.get('/api/segments')).body.segments[0];
    assert.equal((await other.post('/api/broadcasts', { connection_id: ob.connId, body: 'x', segment_id: mine.id })).status, 400);
    assert.equal((await other.del('/api/segments/' + mine.id)).status, 404);
    assert.equal((await c.del('/api/segments/' + mine.id)).status, 200);
    const list = await c.get('/api/segments');
    assert.equal(list.body.everyone, 3);
    assert.ok(list.body.tags.find((t) => t.tag === 'vip' && t.n === 2));
  });
});

describe('scheduling', () => {
  it('send_at: waits until due, then the broadcast job queues it', async () => {
    const { c, bot } = await setup('sched@example.com', 2, 42000);
    const at = new Date(Date.now() + 3600000).toISOString();
    const r = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Later', send_mode: 'at', send_at: at });
    assert.equal(r.body.status, 'scheduled');
    await app.jobs.broadcastsTick();
    assert.equal((await app.db.one('select count(*)::int n from deliveries where broadcast_id = $1', [r.body.id])).n, 0);
    const state = await c.get('/api/app/state');
    assert.equal(state.body.upcoming[0].id, r.body.id);
    await app.db.query("update broadcasts set send_at = now() - interval '1 second' where id = $1", [r.body.id]);
    await app.jobs.broadcastsTick();
    await app.flush();
    assert.equal((await app.db.one('select status, sent from broadcasts where id = $1', [r.body.id])).sent, 2);
    assert.equal((await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'x', send_mode: 'at', send_at: new Date(Date.now() - 3600000).toISOString() })).status, 400);
    assert.equal((await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'x', send_mode: 'at', send_at: new Date(Date.now() + 91 * 86400000).toISOString() })).status, 400);
    assert.equal((await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'x', send_mode: 'at', send_at: 'tomorrow-ish' })).status, 400);
  });

  it('a scheduled broadcast fails cleanly if the plan paused meanwhile', async () => {
    const { c, bot, ws } = await setup('schedpause@example.com', 1, 43000);
    const r = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Later', send_mode: 'at', send_at: new Date(Date.now() + 60000).toISOString() });
    await app.db.query("update workspaces set plan_status = 'paused' where id = $1", [ws.id]);
    await app.db.query("update broadcasts set send_at = now() where id = $1", [r.body.id]);
    await app.jobs.broadcastsTick();
    assert.equal((await app.db.one('select status from broadcasts where id = $1', [r.body.id])).status, 'failed');
  });

  it('9am local time: each time zone gets its own 9:00', async () => {
    const { c, bot } = await setup('local9@example.com', 0);
    await app.addSubscribers(bot.connId, 2, { from: 44001 });
    await app.addSubscribers(bot.connId, 2, { from: 44101, tz: 'Asia/Tokyo' });
    await app.addSubscribers(bot.connId, 1, { from: 44201, tz: 'America/New_York' });
    const r = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Good morning', send_mode: 'local9' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.queued, 5);
    const rows = await app.db.many('select s.tg_user_id, d.due_at from deliveries d join subscribers s on s.id = d.subscriber_id where d.broadcast_id = $1', [r.body.id]);
    const hourIn = (d, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(d));
    for (const row of rows) {
      const tz = row.tg_user_id >= 44201 ? 'America/New_York' : row.tg_user_id >= 44101 ? 'Asia/Tokyo' : 'Africa/Lagos';
      assert.equal(hourIn(row.due_at, tz), '09:00:00', `${row.tg_user_id} in ${tz}`);
      const ahead = new Date(row.due_at) - Date.now();
      assert.ok(ahead > 0 && ahead <= 86400000 + 60000, 'within the next day');
    }
    // Nothing goes out before its time.
    await app.flush();
    assert.equal((await app.db.one('select status from broadcasts where id = $1', [r.body.id])).status, 'sending');
  });

  it('next9 is exactly 9:00:00 whatever the seconds are now, and across a DST change', () => {
    const { next9 } = app.require('services/broadcasts');
    const fmt = (d, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(d);
    assert.equal(fmt(next9('Africa/Lagos', new Date('2026-10-03T12:34:45.900Z')), 'Africa/Lagos'), '09:00:00');
    // New York switches from EDT to EST on 1 Nov 2026 at 2am.
    assert.equal(fmt(next9('America/New_York', new Date('2026-10-31T14:00:00Z')), 'America/New_York'), '09:00:00');
    assert.equal(fmt(next9('Not/AZone', new Date('2026-10-03T05:00:00Z')), 'UTC'), '09:00:00');
  });
});

describe('drafts, approval and team roles', () => {
  let owner, drafter, sender, bot, wsId;
  before(async () => {
    owner = await app.loginByEmail('approvals@example.com');
    bot = await app.connectBot(owner);
    for (let i = 1; i <= 2; i++) await app.start(bot.connId, 45000 + i);
    wsId = (await app.ws(owner)).id;
    for (const [email, role] of [['drafter@example.com', 'drafter'], ['sender@example.com', 'sender']]) {
      const inv = await owner.post('/api/app/team/invite', { email, role });
      assert.equal(inv.status, 200, inv.text);
      const cl = await app.loginByEmail(email);
      assert.equal((await cl.post('/api/invites/accept', { token: inv.body.link.split('#join/')[1] })).status, 200);
      if (role === 'drafter') drafter = cl; else sender = cl;
    }
    const team = await owner.get('/api/app/team');
    assert.equal(team.body.members.length, 3);
    // Seats are full (Growth trial = 3).
    assert.equal((await owner.post('/api/app/team/invite', { email: 'fourth@example.com' })).status, 402);
  });
  const as = (cl) => ({ headers: { 'x-ws': String(wsId) } });

  it('a draft is saved without sending and can be sent later by the owner', async () => {
    const r = await owner.post('/api/broadcasts', { connection_id: bot.connId, body: 'Draft', draft: true });
    assert.equal(r.body.status, 'draft');
    assert.equal((await app.db.one('select count(*)::int n from deliveries where broadcast_id = $1', [r.body.id])).n, 0);
    await app.jobs.broadcastsTick();
    assert.equal((await app.db.one('select status from broadcasts where id = $1', [r.body.id])).status, 'draft');
    assert.equal((await drafter.post(`/api/broadcasts/${r.body.id}/send`, {}, as(drafter))).status, 403);
    const s = await owner.post(`/api/broadcasts/${r.body.id}/send`);
    assert.equal(s.body.queued, 2);
    assert.equal((await owner.post(`/api/broadcasts/${r.body.id}/send`)).status, 400, 'cannot send twice');
  });

  it('a drafter\'s message waits for the owner\'s approval', async () => {
    const r = await drafter.post('/api/broadcasts', { connection_id: bot.connId, body: 'Please approve' }, as(drafter));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.status, 'pending_approval');
    assert.equal((await drafter.post(`/api/broadcasts/${r.body.id}/approve`, {}, as(drafter))).status, 403);
    assert.equal((await sender.post(`/api/broadcasts/${r.body.id}/approve`, {}, as(sender))).status, 403);
    const a = await owner.post(`/api/broadcasts/${r.body.id}/approve`);
    assert.equal(a.status, 200);
    assert.equal(a.body.queued, 2);
    assert.equal((await owner.post(`/api/broadcasts/${r.body.id}/approve`)).status, 400);
    await app.flush();
    assert.equal((await app.db.one('select sent from broadcasts where id = $1', [r.body.id])).sent, 2);
  });

  it('approving twice at the same moment queues the message once', async () => {
    const r = await drafter.post('/api/broadcasts', { connection_id: bot.connId, body: 'Double approve' }, as(drafter));
    const rs = await Promise.all([owner.post(`/api/broadcasts/${r.body.id}/approve`), owner.post(`/api/broadcasts/${r.body.id}/approve`)]);
    assert.ok(rs.some((x) => x.status === 200));
    assert.equal((await app.db.one('select count(*)::int n from deliveries where broadcast_id = $1', [r.body.id])).n, 2);
  });

  it('require_approval: senders need approval too, the owner does not', async () => {
    assert.equal((await sender.post('/api/app/settings', { require_approval: true }, as(sender))).status, 403);
    assert.equal((await owner.post('/api/app/settings', { require_approval: true })).status, 200);
    try {
      const s = await sender.post('/api/broadcasts', { connection_id: bot.connId, body: 'From sender' }, as(sender));
      assert.equal(s.body.status, 'pending_approval');
      const o = await owner.post('/api/broadcasts', { connection_id: bot.connId, body: 'From owner' });
      assert.equal(o.body.status, 'sending');
    } finally { await owner.post('/api/app/settings', { require_approval: false }); }
    const s2 = await sender.post('/api/broadcasts', { connection_id: bot.connId, body: 'Free again' }, as(sender));
    assert.equal(s2.body.status, 'sending');
  });

  it('drafters cannot pin, delete or cancel messages that went out', async () => {
    const r = await owner.post('/api/broadcasts', { connection_id: bot.connId, body: 'Sent one' });
    await app.flush();
    assert.equal((await drafter.post(`/api/broadcasts/${r.body.id}/delete`, {}, as(drafter))).status, 403);
    assert.equal((await drafter.post(`/api/broadcasts/${r.body.id}/pin`, {}, as(drafter))).status, 403);
    assert.equal((await drafter.post(`/api/broadcasts/${r.body.id}/edit`, { body: 'hacked' }, as(drafter))).status, 403);
    const sched = await owner.post('/api/broadcasts', { connection_id: bot.connId, body: 'Owner scheduled', send_mode: 'at', send_at: new Date(Date.now() + 3600000).toISOString() });
    assert.equal((await drafter.post(`/api/broadcasts/${sched.body.id}/cancel`, {}, as(drafter))).status, 403);
    // A drafter can still cancel their own draft.
    const d = await drafter.post('/api/broadcasts', { connection_id: bot.connId, body: 'My draft', draft: true }, as(drafter));
    assert.equal((await drafter.post(`/api/broadcasts/${d.body.id}/cancel`, {}, as(drafter))).status, 200);
  });

  it('team members are removed and roles changed by the owner only', async () => {
    assert.equal((await sender.post('/api/app/team/role', { user_id: drafter.user.id, role: 'sender' }, as(sender))).status, 403);
    assert.equal((await owner.post('/api/app/team/role', { user_id: owner.user.id, role: 'drafter' })).status, 200);
    assert.equal((await app.db.one('select role from members where workspace_id = $1 and user_id = $2', [wsId, owner.user.id])).role, 'owner', 'owner role untouched');
    assert.equal((await owner.post('/api/app/team/remove', { user_id: owner.user.id })).status, 400);
  });

  it('another workspace cannot see or touch these broadcasts', async () => {
    const r = await owner.post('/api/broadcasts', { connection_id: bot.connId, body: 'Private', draft: true });
    const x = await app.loginByEmail('outsider@example.com');
    assert.equal((await x.get('/api/broadcasts/' + r.body.id)).status, 404);
    assert.equal((await x.post(`/api/broadcasts/${r.body.id}/cancel`)).status, 404);
    assert.equal((await x.get('/api/broadcasts/' + r.body.id, { headers: { 'x-ws': String(wsId) } })).status, 404, 'x-ws of a workspace you are not in is ignored');
    assert.ok(!(await x.get('/api/broadcasts')).body.broadcasts.some((b) => b.id === r.body.id));
  });
});

describe('cancel, edit, pin, delete, test', () => {
  it('cancel a sending broadcast: queued messages are skipped', async () => {
    const { c, bot } = await setup('cancel@example.com', 0);
    await app.addSubscribers(bot.connId, 5, { from: 46001 });
    const r = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Oops' });
    const x = await c.post(`/api/broadcasts/${r.body.id}/cancel`);
    assert.equal(x.status, 200);
    await app.flush();
    assert.equal(app.fakes.tgCalls('sendMessage', bot.token).length, 0);
    assert.equal((await app.db.one('select status from broadcasts where id = $1', [r.body.id])).status, 'cancelled');
    assert.equal((await c.post(`/api/broadcasts/${r.body.id}/cancel`)).status, 400);
  });

  it('edit, pin and delete go through the queue for every sent message', async () => {
    const { c, bot, ids } = await setup('actions@example.com', 3, 47000);
    const r = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Original' });
    await app.flush();
    const sentIds = new Map(app.fakes.tgCalls('sendMessage', bot.token).map((x) => [x.params.chat_id, x]));
    const msgIds = await app.db.many("select chat_id, message_id from deliveries where broadcast_id = $1 and action = 'send'", [r.body.id]);
    assert.equal(msgIds.length, 3);
    assert.ok(sentIds.size === 3);

    const e = await c.post(`/api/broadcasts/${r.body.id}/edit`, { body: 'Edited *now*' });
    assert.equal(e.body.editing, 3);
    await app.flush();
    const edits = app.fakes.tgCalls('editMessageText', bot.token);
    assert.equal(edits.length, 3);
    for (const ed of edits) {
      assert.equal(ed.params.text, 'Edited <b>now</b>');
      assert.equal(ed.params.message_id, msgIds.find((m) => m.chat_id === ed.params.chat_id).message_id);
    }
    assert.equal((await app.db.one('select body from broadcasts where id = $1', [r.body.id])).body, 'Edited *now*');
    assert.equal((await app.db.one('select sent from broadcasts where id = $1', [r.body.id])).sent, 3, 'edits are not counted as sends');

    assert.equal((await c.post(`/api/broadcasts/${r.body.id}/pin`)).body.pinning, 3);
    await app.flush();
    assert.equal(app.fakes.tgCalls('pinChatMessage', bot.token).length, 3);
    assert.equal((await c.post(`/api/broadcasts/${r.body.id}/delete`)).body.deleting, 3);
    await app.flush();
    assert.deepEqual(app.fakes.tgCalls('deleteMessage', bot.token).map((x) => x.params.chat_id).sort(), ids.sort());
    assert.equal((await c.post(`/api/broadcasts/${r.body.id}/edit`, { body: 'a'.repeat(4097) })).status, 400);
  });

  it('delete is refused after 48 hours', async () => {
    const { c, bot } = await setup('old@example.com', 1, 48000);
    const r = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Old' });
    await app.flush();
    await app.db.query("update broadcasts set started_at = now() - interval '49 hours' where id = $1", [r.body.id]);
    const d = await c.post(`/api/broadcasts/${r.body.id}/delete`);
    assert.equal(d.status, 400);
    assert.match(d.body.error, /48 hours/);
  });

  it('test send goes to my own Telegram, with a clear error if I never pressed Start', async () => {
    const { c, bot } = await setup('tester@example.com', 1, 49000);
    const noLink = await c.post('/api/broadcasts/test', { connection_id: bot.connId, body: 'Try' });
    assert.equal(noLink.status, 409);
    assert.equal(noLink.body.code, 'tg_not_linked');
    await app.db.query('update users set tg_user_id = 4949 where id = $1', [c.user.id]);
    const ok = await c.post('/api/broadcasts/test', { connection_id: bot.connId, body: 'Try *me*' });
    assert.equal(ok.status, 200, ok.text);
    const call = app.fakes.tgCalls('sendMessage', bot.token).pop();
    assert.equal(call.params.chat_id, 4949);
    assert.equal(call.params.text, '🧪 Test\n\nTry <b>me</b>');
    assert.equal(call.params.reply_markup, undefined);
    app.fakes.tg.block(4949);
    const blocked = await c.post('/api/broadcasts/test', { connection_id: bot.connId, body: 'Try' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'start_bot_first');
  });
});

describe('limits and switches', () => {
  it('daily cap: a subscriber gets at most N broadcasts a day', async () => {
    const { c, bot } = await setup('cap@example.com', 2, 50000);
    assert.equal((await c.post('/api/app/settings', { daily_cap: 1 })).status, 200);
    const a = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'First' });
    assert.equal(a.body.queued, 2);
    const b = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Second' });
    assert.equal(b.body.queued, 0);
    assert.equal(b.body.status, 'sent');
    assert.equal((await c.post('/api/app/settings', { daily_cap: 21 })).status, 400);
  });

  it('over the subscriber limit: sending is blocked with 402', async () => {
    const { c, bot, ws } = await setup('overlimit@example.com', 0);
    await app.db.query("insert into plans(code, name, price_month_cents, price_year_cents, connections, subscribers, ai_writes, seats) values ('tiny','Tiny',100,1000,2,2,10,1) on conflict do nothing");
    await app.db.query("update workspaces set plan_code = 'tiny' where id = $1", [ws.id]);
    app.settings.bust();
    await app.addSubscribers(bot.connId, 3, { from: 51001 });
    const r = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Too many' });
    assert.equal(r.status, 402);
    assert.equal(r.body.code, 'limit_subscribers');
    // A draft is still allowed.
    assert.equal((await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Later', draft: true })).status, 200);
    // Channel and group members never count toward the plan.
    await app.db.query("insert into connections(workspace_id, kind, tg_chat_id, title, member_count) values ($1,'channel',-100777001,'Big channel',100000)", [ws.id]);
    const u = await app.require('services/billing').usage(ws.id);
    assert.equal(u.subscribers, 3);
    assert.equal(u.chat_members, 100000);
  });

  it('a paused plan or an ended trial cannot send', async () => {
    const { c, bot, ws } = await setup('paused@example.com', 1, 52000);
    await app.db.query("update workspaces set plan_status = 'paused' where id = $1", [ws.id]);
    const r = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'x' });
    assert.equal(r.status, 402);
    assert.equal(r.body.code, 'plan_paused');
    await app.db.query("update workspaces set plan_status = 'trial', trial_ends_at = now() - interval '1 minute' where id = $1", [ws.id]);
    assert.equal((await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'x' })).body.code, 'trial_over');
  });

  it('broadcasts switched off: new sends, drafts sent later and scheduled sends are all refused', async () => {
    const { c, bot } = await setup('switchoff@example.com', 1, 53000);
    const d = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Draft', draft: true });
    const s = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Sched', send_mode: 'at', send_at: new Date(Date.now() + 60000).toISOString() });
    await app.setFeature('broadcasts', false);
    try {
      assert.equal((await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'x' })).status, 403);
      assert.equal((await c.post(`/api/broadcasts/${d.body.id}/send`)).status, 403);
      await app.db.query('update broadcasts set send_at = now() where id = $1', [s.body.id]);
      await app.jobs.broadcastsTick();
      assert.equal((await app.db.one('select count(*)::int n from deliveries where broadcast_id = $1', [s.body.id])).n, 0);
      assert.equal((await app.db.one('select status from broadcasts where id = $1', [s.body.id])).status, 'scheduled');
    } finally { await app.setFeature('broadcasts', true); }
  });

  it('maintenance mode pauses the queue and scheduled sends, and resumes after', async () => {
    const { c, bot } = await setup('maint@example.com', 3, 54000);
    const r = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Before maintenance' });
    assert.equal(r.status, 200);
    await app.setFeature('maintenance', true);
    try {
      assert.equal((await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'x' })).status, 503);
      await app.sender.tick();
      await Promise.all([...app.sender.running.values()]);
      assert.equal(app.fakes.tgCalls('sendMessage', bot.token).length, 0, 'nothing sent during maintenance');
    } finally { await app.setFeature('maintenance', false); }
    await app.flush();
    assert.equal(app.fakes.tgCalls('sendMessage', bot.token).length, 3);
  });
});

describe('no double sending', () => {
  it('queueing the same broadcast twice at once still sends each person one message', async () => {
    const { c, bot, ws } = await setup('race@example.com', 0);
    await app.addSubscribers(bot.connId, 300, { from: 55001 });
    const r = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Race', send_mode: 'at', send_at: new Date(Date.now() + 60000).toISOString() });
    await app.db.query('update broadcasts set send_at = now() where id = $1', [r.body.id]);
    const B = app.require('services/broadcasts');
    const row = await app.db.one('select * from broadcasts where id = $1', [r.body.id]);
    await Promise.all([B.enqueue(row), B.enqueue(row), app.jobs.broadcastsTick(), app.jobs.broadcastsTick()]);
    const n = await app.db.one("select count(*)::int n, count(distinct subscriber_id)::int d from deliveries where broadcast_id = $1 and action = 'send'", [r.body.id]);
    assert.deepEqual(n, { n: 300, d: 300 });
    await app.flush();
    const calls = app.fakes.tgCalls('sendMessage', bot.token);
    assert.equal(calls.length, 300);
    assert.equal(new Set(calls.map((x) => x.params.chat_id)).size, 300);
    const b = await app.db.one('select status, total, sent from broadcasts where id = $1', [r.body.id]);
    assert.deepEqual(b, { status: 'sent', total: 300, sent: 300 });
    void ws;
  });

  it('"send now" racing the broadcast job does not double-queue', async () => {
    const { c, bot } = await setup('race2@example.com', 0);
    await app.addSubscribers(bot.connId, 2000, { from: 56001 });
    let stop = false;
    const ticker = (async () => { while (!stop) { await app.jobs.broadcastsTick(); } })();
    const r = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Now!' });
    stop = true;
    await ticker;
    const n = await app.db.one("select count(*)::int n from deliveries where broadcast_id = $1 and action = 'send'", [r.body.id]);
    assert.equal(n.n, 2000);
    await app.db.query("update deliveries set status = 'skipped' where broadcast_id = $1", [r.body.id]);
  });
});

'use strict';
/*
 * Supervisor review, Oct 12 2026 (docs/SUPERVISOR-VERDICT-OCT12.md): regression tests for the fixes to 966108d..799c64a
 * (subscriber packs, repeating messages, voice notes and round videos, auto-delete / auto-pin, migrations 029 and 030).
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { startApp } = require('../helpers/app');

const FAKE_FFMPEG = path.join(__dirname, '..', 'helpers', 'fake-ffmpeg.js');

let app;
before(async () => { app = await startApp({ env: { FFMPEG_PATH: FAKE_FFMPEG } }); });
after(async () => { if (app) await app.stop(); });
beforeEach(() => { app.rl._reset(); delete process.env.FAKE_FFMPEG_SLEEP_MS; delete process.env.FAKE_FFMPEG_FAIL; });

let seq = 0;
const R = () => app.require('services/repeats');
const B = () => app.require('services/broadcasts');
async function setPlan(wsId, code, status = 'active') {
  await app.db.query("update workspaces set plan_code = $2, plan_status = $3, trial_ends_at = null, period_end = case when $2 = 'free' then null else now() + interval '20 days' end where id = $1", [wsId, code, status]);
  app.settings.bust();
}
async function setup(plan = 'starter', n = 2) {
  const c = await app.loginByEmail(`sv12-${++seq}@example.com`);
  const ws = await app.ws(c);
  await setPlan(ws.id, plan);
  await app.db.query("update workspaces set timezone = 'Africa/Lagos' where id = $1", [ws.id]);
  const bot = await app.connectBot(c);
  const base = 7700000 + seq * 100;
  for (let i = 1; i <= n; i++) await app.start(bot.connId, base + i);
  return { c, ws, bot };
}
const series = (s, extra = {}) => ({ connection_id: s.bot.connId, freq: 'daily', time_of_day: '09:00', versions: [{ body: 'Daily tip' }], ...extra });
async function teammate(s, role) {
  const m = await app.loginByEmail(`sv12-mate-${++seq}@example.com`);
  await app.db.query('insert into members(workspace_id, user_id, role) values ($1,$2,$3)', [s.ws.id, m.user.id, role]);
  const h = { headers: { 'x-ws': String(s.ws.id) } };
  return { post: (p, b) => m.post(p, b, h) };
}
const local = (zone, t) => { const w = B().wallClock(zone, t); return `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')} ${String(w.h).padStart(2, '0')}:${String(w.min).padStart(2, '0')}`; };
const errCode = (r) => r.body.code || (r.body.error && r.body.error.code);

describe('supervisor Oct 12: repeating messages', () => {
  it('SV-3: a time that DST skips (midnight in Santiago / Cairo) runs after the jump on that same day, never the evening before', () => {
    // Santiago: clocks go from 00:00 to 01:00 on Sun 6 Sep 2026. Cairo: 00:00 to 01:00 on Fri 24 Apr 2026.
    assert.equal(local('America/Santiago', R().zonedInstant('America/Santiago', 2026, 9, 6, 0, 0)), '2026-09-06 01:00');
    assert.equal(local('Africa/Cairo', R().zonedInstant('Africa/Cairo', 2026, 4, 24, 0, 0)), '2026-04-24 01:00');
    // Unchanged elsewhere: a skipped 02:30 in New York becomes 03:30; a doubled 01:30 is the first one; normal days exact.
    assert.equal(local('America/New_York', R().zonedInstant('America/New_York', 2026, 3, 8, 2, 30)), '2026-03-08 03:30');
    assert.equal(R().zonedInstant('America/New_York', 2026, 11, 1, 1, 30), Date.UTC(2026, 10, 1, 5, 30));
    assert.equal(R().zonedInstant('Africa/Lagos', 2026, 10, 12, 9, 0), Date.UTC(2026, 9, 12, 8, 0));
    // Every day at 00:00 in Santiago: one run per date through the change (before: 5 Sep twice, 6 Sep lost).
    const s = { freq: 'daily', days: [], time_of_day: '00:00', end_mode: 'never' };
    const dates = R().upcoming({ ...s, runs: 0 }, 'America/Santiago', Date.UTC(2026, 8, 3), Date.UTC(2026, 8, 10), 10).map((t) => local('America/Santiago', t).slice(0, 10));
    assert.deepEqual(dates, ['2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09']);
    // "Sundays at 00:00": the run on the DST Sunday is on Sunday.
    const sun = R().nextRun({ freq: 'days', days: [0], time_of_day: '00:00', end_mode: 'never' }, 'America/Santiago', Date.UTC(2026, 8, 3));
    assert.equal(local('America/Santiago', sun), '2026-09-06 01:00');
  });

  it('SV-4: approving, or sending a paused one for approval, checks the plan\'s limit of running repeats', async () => {
    const s = await setup('starter', 1);
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await s.c.post('/api/repeats', series(s))).body.id);
    await s.c.post(`/api/repeats/${ids[0]}/pause`);
    assert.equal((await s.c.post('/api/repeats', series(s))).status, 200, 'the 3rd running one');
    // A drafter edits the paused one: it would wait for approval (and count) as a 4th.
    const drafter = await teammate(s, 'drafter');
    const e = await drafter.post(`/api/repeats/${ids[0]}/edit`, series(s, { versions: [{ body: 'Changed' }] }));
    assert.equal(e.status, 402, e.text);
    assert.equal(errCode(e), 'limit_repeats');
    assert.equal((await app.db.one('select status from repeat_series where id = $1', [ids[0]])).status, 'paused');
    // Waiting for approval while the plan got smaller: approving would make one too many.
    const g = await setup('growth', 1);
    await app.db.query('update workspaces set require_approval = true where id = $1', [g.ws.id]);
    for (let i = 0; i < 3; i++) assert.equal((await g.c.post('/api/repeats', series(g))).status, 200);
    const mate = await teammate(g, 'sender');
    const p = await mate.post('/api/repeats', series(g));
    assert.equal(p.body.status, 'pending_approval');
    await setPlan(g.ws.id, 'starter');
    const a = await g.c.post(`/api/repeats/${p.body.id}/approve`);
    assert.equal(a.status, 402, a.text);
    assert.equal(errCode(a), 'limit_repeats');
    assert.equal((await app.db.one('select status from repeat_series where id = $1', [p.body.id])).status, 'pending_approval');
    // With room it is approved as before.
    await setPlan(g.ws.id, 'growth');
    assert.equal((await g.c.post(`/api/repeats/${p.body.id}/approve`)).body.status, 'active');
  });

  it('SV-2: deleting an audience pauses the repeating messages sent to it (they never widen to every subscriber)', async () => {
    const s = await setup('growth', 2);
    const seg = await s.c.post('/api/segments', { name: 'French', rules: [{ field: 'lang', value: 'fr' }] });
    assert.equal(seg.status, 200, seg.text);
    const r = await s.c.post('/api/repeats', series(s, { segment_id: seg.body.segment.id }));
    assert.equal(r.status, 200, r.text);
    const other = await s.c.post('/api/repeats', series(s));
    const d = await s.c.del('/api/segments/' + seg.body.segment.id);
    assert.equal(d.status, 200, d.text);
    assert.equal(d.body.paused_repeats, 1);
    const row = await app.db.one('select status, next_run_at, segment_id, last_error from repeat_series where id = $1', [r.body.id]);
    assert.equal(row.status, 'paused');
    assert.equal(row.next_run_at, null);
    assert.equal(row.segment_id, null);
    assert.match(row.last_error, /audience "French" was deleted/);
    // Due or not, nothing goes out for it; the other repeat is untouched.
    await app.db.query("update repeat_series set next_run_at = now() - interval '1 minute' where id = $1", [other.body.id]);
    await app.jobs.broadcastsTick(); await app.flush();
    assert.equal((await app.db.one('select count(*)::int n from broadcasts where series_id = $1', [r.body.id])).n, 0);
    assert.equal((await app.db.one('select count(*)::int n from broadcasts where series_id = $1', [other.body.id])).n, 1);
    // Another workspace can't delete it (404) and the route still answers 404 for a missing audience.
    assert.equal((await s.c.del('/api/segments/999999999')).status, 404);
  });
});

describe('supervisor Oct 12: auto-delete and auto-pin', () => {
  it('SV-1: cancelling a message while it goes out still deletes and unpins the copies that already arrived', async () => {
    const s = await setup('starter', 3);
    const r = await s.c.post('/api/broadcasts', { connection_id: s.bot.connId, body: 'Flash sale, 1 hour only', delete_after_hours: 2, pin: true, unpin_after_hours: 1 });
    assert.equal(r.status, 200, r.text);
    await app.flush();
    // As if one person had not been reached yet when the owner pressed Cancel.
    const sends = await app.db.many("select id from deliveries where broadcast_id = $1 and action = 'send' order by id", [r.body.id]);
    await app.db.query("delete from deliveries where broadcast_id = $1 and action <> 'send' and chat_id = (select chat_id from deliveries where id = $2)", [r.body.id, sends[2].id]);
    await app.db.query("update deliveries set status = 'queued', message_id = null, sent_at = null where id = $1", [sends[2].id]);
    await app.db.query("update broadcasts set status = 'sending', finished_at = null where id = $1", [r.body.id]);
    const c = await s.c.post(`/api/broadcasts/${r.body.id}/cancel`);
    assert.equal(c.status, 200, c.text);
    const rows = await app.db.many("select action, status, error from deliveries where broadcast_id = $1 order by id", [r.body.id]);
    assert.equal(rows.filter((x) => x.action === 'send' && x.status === 'skipped' && x.error === 'Cancelled').length, 1, 'the unsent one is cancelled');
    assert.equal(rows.filter((x) => x.action === 'delete' && x.status === 'queued').length, 2, 'the deletes of the 2 sent copies wait');
    assert.equal(rows.filter((x) => x.action === 'unpin' && x.status === 'queued').length, 2, 'and their unpins');
    await app.db.query("update deliveries set due_at = now() where broadcast_id = $1 and action in ('delete','unpin') and status = 'queued'", [r.body.id]);
    await app.drain();
    assert.equal(app.fakes.tgCalls('deleteMessage', s.bot.token).length, 2);
    assert.equal(app.fakes.tgCalls('unpinChatMessage', s.bot.token).length, 2);
    assert.equal((await app.db.one("select count(*)::int n from deliveries where broadcast_id = $1 and action = 'delete' and status = 'sent'", [r.body.id])).n, 2);
    // Nothing more is sent for a cancelled message (3 = the first sends, before the simulated cancel).
    assert.equal(app.fakes.tgCalls(null, s.bot.token).filter((x) => /^send/.test(x.method)).length, 3);
  });
});

describe('supervisor Oct 12: message order', () => {
  it('SV-7: a round video + text step, then a voice step right away: the person gets round video, text, voice (in that order)', async () => {
    const { FILES } = require('../helpers/app');
    // Each round: a new bot (so both files are uploaded for the first time, the slow path) and one person.
    for (let round = 0; round < 4; round++) {
      const s = await setup('growth', 0);
      const up = (buf, type, as) => s.c.post('/api/media' + (as ? '?as=' + as : ''), buf, { headers: { 'content-type': type, 'x-filename': 'rec' } });
      const m = await up(FILES.mp4(), 'video/mp4', 'video_note');
      const v = await up(Buffer.concat([Buffer.from('ID3'), crypto.randomBytes(3000)]), 'audio/mpeg');
      assert.equal(m.status, 200, m.text);
      const f = await s.c.post('/api/flows', { start_type: 'bot_start', name: 'Order bot', bot_id: s.bot.connId, start_code: 'order', active: true, steps: [{ body: 'Watch this', media_id: m.body.media.id }, { body: '', media_id: v.body.media.id }] });
      assert.equal(f.status, 200, f.text);
      const u = 7790001 + seq;
      await app.start(s.bot.connId, u, 'order');
      for (let i = 0; i < 3; i++) { await app.jobs.dripsTick(); await app.drain(); }
      const mine = app.fakes.tgCalls(null, s.bot.token).filter((c) => /^send/.test(c.method) && Number(c.params.chat_id) === u).map((c) => c.method);
      assert.deepEqual(mine.slice(0, 3), ['sendVideoNote', 'sendMessage', 'sendVoice'], 'round ' + round);
    }
  });
});

describe('supervisor Oct 12: ffmpeg', () => {
  it('SV-5: every conversion opens plain files only, of the containers we accept, with a frame-size cap; voice is cut at 60 minutes', () => {
    const conv = app.require('services/media-convert');
    for (const [args, formats] of [[conv.voiceArgs('/u/in.mp3', '/u/out.ogg'), 'ogg,mp3,mov,matroska,wav,aac'], [conv.roundArgs('/u/in.mov', '/u/out.mp4'), 'mov,matroska']]) {
      const i = args.indexOf('-i');
      const inputOpts = args.slice(0, i);
      assert.equal(inputOpts[inputOpts.indexOf('-protocol_whitelist') + 1], 'file');
      assert.equal(inputOpts[inputOpts.indexOf('-format_whitelist') + 1], formats);
      assert.equal(inputOpts[inputOpts.indexOf('-max_pixels') + 1], String(4096 * 4096));
      assert.ok(args.includes('-nostats'));
    }
    const v = conv.voiceArgs('/u/in.mp3', '/u/out.ogg');
    assert.equal(v[v.indexOf('-t') + 1], '3600');
  });

  it('SV-5: with the real ffmpeg, a crafted "MP3" (ID3 + ffconcat) is refused, real recordings convert', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 && 'ffmpeg is not installed here' }, () => {
    const conv = app.require('services/media-convert');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv12-ff-'));
    try {
      const run = (args) => spawnSync('ffmpeg', args, { encoding: 'utf8', timeout: 60000 });
      assert.equal(run(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=duration=1', '-y', path.join(dir, 'other.wav')]).status, 0);
      assert.equal(run(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=duration=1', '-y', path.join(dir, 'real.mp3')]).status, 0);
      // An ID3 tag passes the upload's MP3 check; without the whitelists ffmpeg then reads the ffconcat list after it
      // and opens the other file in the same folder (checked: it converted it).
      fs.writeFileSync(path.join(dir, 'evil.mp3'), Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1'), Buffer.from('ffconcat version 1.0\nfile other.wav\n')]));
      const bad = run(conv.voiceArgs(path.join(dir, 'evil.mp3'), path.join(dir, 'evil.ogg')));
      assert.notEqual(bad.status, 0, 'refused');
      assert.ok(!fs.existsSync(path.join(dir, 'evil.ogg')) || fs.statSync(path.join(dir, 'evil.ogg')).size === 0);
      const good = run(conv.voiceArgs(path.join(dir, 'real.mp3'), path.join(dir, 'real.ogg')));
      assert.equal(good.status, 0, good.stderr);
      assert.equal(fs.readFileSync(path.join(dir, 'real.ogg')).slice(0, 4).toString(), 'OggS');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('SV-5: when conversions pile up, extra uploads get a friendly "busy" (503) instead of waiting without end', async () => {
    const s = await setup('starter', 0);
    process.env.FAKE_FFMPEG_SLEEP_MS = '1500';
    const conv = app.require('services/media-convert');
    const n = 2 + conv.MAX_WAITING + 3;
    const ups = await Promise.all(Array.from({ length: n }, () => s.c.post('/api/media?as=voice', Buffer.concat([Buffer.from('OggS'), crypto.randomBytes(2000)]), { headers: { 'content-type': 'audio/ogg', 'x-filename': 'rec' } })));
    const codes = ups.map((u) => u.status);
    assert.ok(codes.filter((c) => c === 503).length >= 1, 'some busy: ' + codes.join(','));
    assert.ok(codes.filter((c) => c === 200).length >= 2 + conv.MAX_WAITING - 1, 'the rest convert: ' + codes.join(','));
    const busy = ups.find((u) => u.status === 503);
    assert.equal(errCode(busy), 'conversion_busy');
    assert.match(busy.body.error, /try again in a minute/);
    // A refused upload leaves no file behind and no row.
    const rows = (await app.db.one('select count(*)::int n from media where workspace_id = $1', [s.ws.id])).n;
    assert.equal(rows, codes.filter((c) => c === 200).length);
    const dir = path.join(app.require('config').uploadDir, String(s.ws.id));
    assert.equal(fs.readdirSync(dir).length, rows, 'no leftover files');
  });
});

describe('supervisor Oct 12: migrations on existing data', () => {
  it('029 and 030 run twice on a database with packs, repeats, runs and auto actions, and keep everything', async () => {
    const s = await setup('scale', 1);
    await app.db.query('update workspaces set subscriber_packs = 2, pending_subscriber_packs = 1 where id = $1', [s.ws.id]);
    const r = await s.c.post('/api/repeats', series(s, { delete_after_hours: 3 }));
    assert.equal(r.status, 200, r.text);
    await app.db.query("update repeat_series set next_run_at = now() - interval '1 minute' where id = $1", [r.body.id]);
    await app.jobs.broadcastsTick(); await app.flush();
    await app.db.query("update settings set value = value || '{\"sub_pack_price_cents\": 3500}'::jsonb where key = 'billing'");
    const snap = async () => ({
      ws: await app.db.one('select subscriber_packs, pending_subscriber_packs from workspaces where id = $1', [s.ws.id]),
      series: await app.db.one('select status, runs, used_versions from repeat_series where id = $1', [r.body.id]),
      runs: (await app.db.one('select count(*)::int n from broadcasts where series_id = $1', [r.body.id])).n,
      auto: (await app.db.one("select count(*)::int n from deliveries d join broadcasts b on b.id = d.broadcast_id where b.series_id = $1 and d.extra->>'auto' is not null", [r.body.id])).n,
      billing: (await app.db.one("select value from settings where key = 'billing'")).value,
    });
    const before = await snap();
    assert.equal(before.runs, 1);
    assert.equal(before.auto, 1);
    for (const f of ['029_subscriber_packs.sql', '030_repeat_media_pin.sql']) {
      const sql = fs.readFileSync(path.join(__dirname, '../../server/migrations', f), 'utf8');
      for (let k = 0; k < 2; k++) await app.db.tx(async (c) => { for (const st of app.db.splitSql(sql)) await c.query(st); });
    }
    const now = await snap();
    assert.deepEqual(now, before);
    assert.equal(now.billing.sub_pack_price_cents, 3500, 'a saved pack price is kept');
    try {
      await app.db.query("insert into media(workspace_id, kind, filename, mime, size_bytes, path) values ($1, 'gif', 'x', 'image/gif', 1, '/x')", [s.ws.id]);
      assert.fail('kind check still on');
    } catch (e) { assert.match(e.message, /media_kind_check/); }
    settingsBust();
  });
});

function settingsBust() { app.settings.bust(); }

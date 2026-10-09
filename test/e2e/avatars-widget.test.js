'use strict';
/*
 * Customer cartoon avatars and nicknames, the 16 support agents, and the floating support widget's endpoints.
 *   - avatar schema: only known keys and values are stored (public/js/avatar.js clean(), server/lib/avatar.js)
 *   - nickname: cleaned, ≤ 24 characters, no markup; greeting name = nickname > first name > email prefix
 *   - personas: 16 seeded with their faces; migration 020 adds the new ones without touching edited agents
 *   - widget: same auth as Help (logged out can't read the thread or upload images), unread count while closed
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp } = require('../helpers/app');
const AV = require('../../public/js/avatar.js');

let app, sai, ai;
before(async () => {
  app = await startApp();
  sai = app.require('services/support-ai');
  ai = app.fakes.ai;
  await app.setSetting('support_ai', { typing_min_ms: 0, typing_max_ms: 0, debounce_ms: 0 });
});
after(async () => { if (app) await app.stop(); });
beforeEach(() => { app.rl._reset(); ai.script = null; });

describe('avatar module (shared by the browser and the server)', () => {
  it('fills defaults when drawing, but refuses anything unknown in strict mode', () => {
    const d = AV.clean({}, true);
    assert.deepEqual(Object.keys(d).sort(), AV.KEYS.slice().sort());
    assert.throws(() => AV.clean({ hair: 'mohawk' }, true), /option/);
    assert.throws(() => AV.clean({ hacked: 'x' }, true), /unknown part/);
    assert.throws(() => AV.clean({ acc: ['earrings', 'crown'] }, true), /extra/);
    assert.throws(() => AV.clean({ acc: 'earrings' }, true));
    assert.throws(() => AV.clean({ skin: { $gt: '' } }, true));
    assert.throws(() => AV.clean([], true));
    assert.equal(AV.clean({ hair: 'mohawk', skin: 't3' }, false).hair, AV.DEFAULT.hair, 'drawing falls back to the default');
    assert.deepEqual(AV.clean({ acc: ['chain', 'chain'] }, true).acc, ['chain'], 'no duplicates');
  });

  it('renders every option, 24 presets and random avatars as clean SVG with unique ids', () => {
    for (const [k, list] of Object.entries(AV.OPTIONS)) {
      for (const [v] of list) {
        const svg = AV.render(k === 'acc' ? { acc: [v] } : { [k]: v }, { size: 64 });
        assert.match(svg, /^<svg [^>]*viewBox="0 0 128 128"/, `${k}=${v}`);
        assert.doesNotMatch(svg, /undefined|NaN|<script|on\w+=/i, `${k}=${v}`);
      }
    }
    assert.equal(AV.PRESETS.length, 24);
    for (const p of AV.PRESETS) assert.deepEqual(AV.clean(p, true), p, 'presets are valid');
    for (let i = 0; i < 40; i++) AV.clean(AV.random(), true);
    const a = AV.render(AV.PRESETS[0]), b = AV.render(AV.PRESETS[0]);
    const ida = a.match(/id="([^"]+)"/)[1], idb = b.match(/id="([^"]+)"/)[1];
    assert.notEqual(ida, idb, 'two drawings on one page never share an id');
    assert.ok(AV.OPTIONS.hair.length >= 14 && AV.OPTIONS.skin.length >= 8 && AV.OPTIONS.eyes.length >= 6 && AV.OPTIONS.mouth.length >= 6);
    for (const h of ['afro', 'braids', 'locs', 'buzz', 'bun', 'bob', 'curly', 'waves', 'long', 'hijab', 'headwrap', 'cap', 'none', 'fade', 'ponytail']) assert.ok(AV.OPTIONS.hair.some((x) => x[0] === h), h);
  });

  it('a stored config with markup can never reach the drawing', () => {
    const svg = AV.render({ hair: '"><script>alert(1)</script>', bg: 'x" onload="alert(1)' }, { label: '<b>x</b>"' });
    assert.doesNotMatch(svg, /<script|onload|<b>/);
  });

  it('greeting name: nickname > first name > email prefix', () => {
    assert.equal(AV.greetName({ nickname: 'Dchessking', name: 'Ejiro Segbuyota', email: 'ejirosegbuyota19@gmail.com' }), 'Dchessking');
    assert.equal(AV.greetName({ nickname: '', name: 'Ejiro Segbuyota', email: 'e@x.com' }), 'Ejiro');
    assert.equal(AV.greetName({ name: '', email: 'ejirosegbuyota19@gmail.com' }), 'ejirosegbuyota19');
    assert.equal(AV.greetName(null), '');
  });
});

describe('saving an avatar and nickname (POST /api/me)', () => {
  let c;
  before(async () => { c = await app.loginByEmail('ejirosegbuyota19@example.com'); });

  it('new accounts are asked once; skipping is remembered on the server', async () => {
    const d = await app.loginByEmail('skipper@example.com');
    assert.equal((await d.get('/api/me')).body.user.avatar_prompt, true);
    const r = await d.post('/api/me', { avatar_prompt_done: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.avatar_prompt, false);
    assert.equal((await d.get('/api/me')).body.user.avatar_prompt, false);
  });

  it('stores a valid avatar and nickname, and returns them in /api/me', async () => {
    const av = AV.PRESETS[3];
    const r = await c.post('/api/me', { avatar: av, nickname: '  Dchessking 👑 ' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.user.nickname, 'Dchessking 👑');
    assert.deepEqual(r.body.user.avatar, AV.clean(av, true));
    assert.equal(r.body.user.avatar_prompt, false, 'making an avatar answers the prompt');
    const row = await app.db.one('select nickname, avatar from users where id = $1', [c.user.id]);
    assert.equal(row.nickname, 'Dchessking 👑');
    assert.equal(row.avatar.hair, av.hair);
  });

  it('refuses unknown keys and values, and leaves the saved avatar alone', async () => {
    for (const bad of [{ hair: 'mohawk' }, { hair: 'afro', evil: 1 }, { acc: ['earrings', '<svg onload=1>'] }, { skin: 5 }, 'afro', [1, 2], { bg: 'url(javascript:alert(1))' }]) {
      const r = await c.post('/api/me', { avatar: bad });
      assert.equal(r.status, 400, JSON.stringify(bad) + ' ' + r.text);
    }
    const huge = { ...AV.PRESETS[0], hair: 'afro'.padEnd(5000, 'x') };
    assert.equal((await c.post('/api/me', { avatar: huge })).status, 400);
    const row = await app.db.one('select avatar from users where id = $1', [c.user.id]);
    assert.equal(row.avatar.hair, AV.PRESETS[3].hair, 'unchanged');
  });

  it('refuses markup, links and long nicknames; an empty box removes it', async () => {
    for (const bad of ['<img src=x onerror=alert(1)>', '"><script>alert(1)</script>', 'Dchess&king', 'visit castvoo-pay.com', 'x'.repeat(25), { a: 1 }]) {
      const r = await c.post('/api/me', { nickname: bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal((await app.db.one('select nickname from users where id = $1', [c.user.id])).nickname, 'Dchessking 👑');
    const ok = await c.post('/api/me', { nickname: 'Kim\u0000‮Brain' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.nickname, 'Kim Brain', 'control and direction characters are removed');
    const clear = await c.post('/api/me', { nickname: '   ' });
    assert.equal(clear.body.user.nickname, null);
    await c.post('/api/me', { nickname: 'Dchessking' });
  });

  it('removing the avatar (null) goes back to initials; logged out cannot save', async () => {
    const d = await app.loginByEmail('remover@example.com');
    await d.post('/api/me', { avatar: AV.PRESETS[1] });
    const r = await d.post('/api/me', { avatar: null });
    assert.equal(r.body.user.avatar, null);
    assert.equal((await app.client().post('/api/me', { avatar: AV.PRESETS[0] })).status, 401);
  });

  it('the team list shows members\' avatars and nicknames', async () => {
    const t = await c.get('/api/app/team');
    const me = t.body.members.find((m) => m.id === c.user.id);
    assert.equal(me.nickname, 'Dchessking');
    assert.equal(me.avatar.hair, AV.PRESETS[3].hair);
  });

  it('the support AI greets with the nickname, quoted as data', async () => {
    await c.post('/api/support', { body: 'Hello there' });
    ai.script = [{ text: 'Hi Dchessking!' }];
    await sai.tick();
    const call = ai.calls[ai.calls.length - 1];
    assert.match(call.system, /Nickname they chose \(use it when you greet them\): "Dchessking"/);
  });

  it('staff see the avatar and nickname in Admin → Users and in support threads', async () => {
    const owner = await app.loginByEmail('owner@castvoo.test');
    const u = await owner.get('/api/admin/users/' + c.user.id);
    assert.equal(u.status, 200);
    assert.equal(u.body.user.nickname, 'Dchessking');
    assert.ok(u.body.user.avatar && u.body.user.avatar.hair);
    const list = await owner.get('/api/admin/users?q=ejirosegbuyota19');
    assert.ok(list.body.users.some((x) => x.avatar && x.nickname === 'Dchessking'));
  });
});

describe('16 support agents', () => {
  const NAMES = ['Mia', 'Daniel', 'Amara', 'Leo', 'Aisha', 'Kenji', 'Sofia', 'Tunde', 'Zara', 'Marcus', 'Nadia', 'Emeka', 'Lucas', 'Priya', 'Kofi', 'Elena'];

  it('a new database has all 16, each with its own illustrated face file', async () => {
    const rows = await app.db.many('select name, face, active from support_personas order by sort, id');
    assert.deepEqual(rows.map((r) => r.name), NAMES);
    for (const r of rows) {
      assert.equal(r.face, r.name.toLowerCase());
      assert.ok(r.active);
      const f = path.join(__dirname, '..', '..', 'public', 'img', 'agents', r.face + '.svg');
      const svg = fs.readFileSync(f, 'utf8');
      assert.match(svg, /viewBox="0 0 128 128"/);
      assert.ok(!/<script|on\w+=/i.test(svg));
      for (const m of svg.matchAll(/id="([^"]+)"/g)) assert.ok(m[1].startsWith(r.face + '-'), `${r.face}: id ${m[1]} is prefixed`);
    }
    assert.equal(sai.FACES.length, 16);
  });

  it('migration 020 adds the new agents to an older database, never touching edited ones', async () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'migrations', '020_avatars_support_widget.sql'), 'utf8');
    const insert = sql.slice(sql.indexOf('insert into support_personas'));
    await app.db.tx(async (t) => {
      // An older database: the 4 starting agents, one renamed with a new face, one given a face of the new set.
      await t.query('create temp table sp_backup as select * from support_personas');
      await t.query('delete from support_personas where sort > 4');
      await t.query("update support_personas set name = 'Mary', bio = 'Edited by the team' where name = 'Mia'");
      await t.query("update support_personas set face = 'kofi' where name = 'Leo'");
      await t.query(insert);
      const rows = await t.query('select name, face, bio from support_personas order by sort, id');
      const names = rows.rows.map((r) => r.name);
      assert.equal(rows.rows.length, 15, '4 old + 11 new (Kofi\'s face is taken)');
      assert.ok(names.includes('Mary') && !names.includes('Kofi'));
      assert.ok(names.includes('Mia') === false || rows.rows.find((r) => r.name === 'Mia').face !== 'mia', 'Mia is not re-added with Mary\'s face');
      assert.equal(rows.rows.find((r) => r.name === 'Mary').bio, 'Edited by the team');
      // Running it again adds nothing.
      await t.query(insert);
      assert.equal((await t.query('select count(*)::int n from support_personas')).rows[0].n, 15);
      throw Object.assign(new Error('rollback'), { rollback: true });
    }).catch((e) => { if (!e.rollback) throw e; });
    assert.equal((await app.db.one('select count(*)::int n from support_personas')).n, 16, 'rolled back');
  });

  it('the admin face picker offers all 16 faces', async () => {
    const owner = await app.loginByEmail('owner@castvoo.test');
    const g = await owner.get('/api/admin/support-ai');
    assert.equal(g.body.faces.length, 16);
    assert.ok(g.body.faces.every((f) => fs.existsSync(path.join(__dirname, '..', '..', 'public', f.url))));
  });

  it('the website config lists the faces for the widget launcher (no account data)', async () => {
    const cfg = (await app.client().get('/api/public/config')).body;
    assert.ok(Array.isArray(cfg.support_team));
    assert.ok(cfg.support_team.length >= 1 && cfg.support_team.length <= 4);
    for (const p of cfg.support_team) assert.deepEqual(Object.keys(p).sort(), ['avatar', 'id', 'name', 'role']);
  });
});

describe('floating support widget endpoints', () => {
  let c;
  before(async () => { c = await app.loginByEmail('widget.user@example.com', { name: 'Kemi Ade' }); });

  it('logged out: no thread, no unread count, no uploads, and the website chat refuses images', async () => {
    const v = app.client();
    assert.equal((await v.get('/api/support')).status, 401);
    assert.equal((await v.get('/api/support/unread')).status, 401);
    assert.equal((await v.post('/api/support', { body: 'hi' })).status, 401);
    assert.equal((await v.request('POST', '/api/support/attachments', Buffer.from('89504e47', 'hex'), { headers: { 'content-type': 'image/png' } })).status, 401);
    await app.setFeature('site_chat', true);
    const r = await v.post('/api/public/chat', { message: 'look', images: ['data:image/png;base64,AAAA'] });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'images_not_allowed');
  });

  it('unread counts replies that arrived while the widget was closed; opening the chat clears it', async () => {
    assert.deepEqual((await c.get('/api/support/unread')).body, { unread: 0, typing: false });
    await c.post('/api/support', { body: 'Where is my welcome message?' });
    assert.equal((await c.get('/api/support/unread')).body.unread, 0, 'my own message is not unread');
    ai.script = [{ text: 'Let me check.\n\nYour flow is live.' }];
    await sai.tick();
    const u1 = (await c.get('/api/support/unread')).body;
    assert.equal(u1.unread, 2, 'two new bubbles');
    assert.equal((await c.get('/api/support/unread')).body.unread, 2, 'reading the count does not mark them seen');
    const view = await c.get('/api/support');
    assert.equal(view.status, 200);
    assert.deepEqual((await c.get('/api/support/unread')).body, { unread: 0, typing: false }, 'opening the chat marks them seen');
    const t = await app.db.one('select id from support_threads where user_id = $1', [c.user.id]);
    await app.db.query("insert into support_messages(thread_id, author_type, author_name, body, visible_at) values ($1,'staff','Ejiro','On it!', now() + interval '1 second')", [t.id]);
    await app.db.query('update support_threads set unread_user = true where id = $1', [t.id]);
    await app.sleep(1100);
    assert.equal((await c.get('/api/support/unread')).body.unread, 1, 'a staff reply counts');
    await app.db.query("insert into support_messages(thread_id, author_type, author_name, body, internal) values ($1,'system','Note','internal', true)", [t.id]);
    assert.equal((await c.get('/api/support/unread')).body.unread, 1, 'internal notes never count');
  });

  it('only counts the customer\'s own thread in this workspace', async () => {
    const other = await app.loginByEmail('widget.other@example.com');
    assert.equal((await other.get('/api/support/unread')).body.unread, 0);
  });

  it('"Talk to a person" in the widget hands the chat to the team', async () => {
    const d = await app.loginByEmail('widget.person@example.com');
    await d.post('/api/support', { body: 'I\'d like to talk to a person from the team, please.' });
    await sai.tick();
    const t = await app.db.one('select needs_human from support_threads where user_id = $1', [d.user.id]);
    assert.equal(t.needs_human, true);
    assert.equal((await d.get('/api/support')).body.thread.with_human, true);
  });
});

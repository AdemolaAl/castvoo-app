'use strict';
/* QA fixes (front end and copy, review of 8 Oct 2026): each test pins one QA-n finding down. */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { startApp } = require('../helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { if (app) await app.stop(); });
beforeEach(() => { app.rl._reset(); });

describe('QA-6: admin does not count Free workspaces as paying', () => {
  it('overview and the Users filter split Free from Paying', async () => {
    const free = await app.loginByEmail('qa6-free@example.com');
    const paid = await app.loginByEmail('qa6-paid@example.com');
    const fw = await app.ws(free), pw = await app.ws(paid);
    await app.db.query("update workspaces set plan_code = 'free', plan_status = 'active' where id = $1", [fw.id]);
    await app.db.query("update workspaces set plan_code = 'starter', plan_status = 'active', period_end = now() + interval '20 days' where id = $1", [pw.id]);
    const owner = await app.owner();
    const o = await owner.get('/api/admin/overview');
    assert.equal(o.status, 200, o.text);
    const counts = await app.db.one(`select count(*) filter (where p.price_month_cents > 0 and w.plan_status = 'active')::int paying,
      count(*) filter (where p.price_month_cents = 0 and w.plan_status = 'active')::int free from workspaces w join plans p on p.code = w.plan_code where w.purged_at is null`);
    assert.equal(o.body.workspaces.paying, counts.paying);
    assert.equal(o.body.workspaces.free, counts.free);
    assert.ok(o.body.workspaces.free >= 1);
    assert.ok(!o.body.plans.some((p) => p.plan === 'free'), 'Free is not in "Paying customers by plan"');

    const active = await owner.get('/api/admin/users?status=active');
    assert.ok(active.body.users.some((u) => u.id === paid.user.id), 'paid user listed as paying');
    assert.ok(!active.body.users.some((u) => u.id === free.user.id), 'free user not listed as paying');
    const onFree = await owner.get('/api/admin/users?status=free');
    const row = onFree.body.users.find((u) => u.id === free.user.id);
    assert.ok(row, 'free filter lists the Free workspace');
    assert.equal(row.plan_free, true);
    const detail = await owner.get('/api/admin/users/' + free.user.id);
    assert.equal(detail.body.workspaces[0].plan_free, true);
  });
});

describe('QA-14: people who only asked to join are not "new subscribers"', () => {
  it('Home counts people who pressed Start only', async () => {
    const c = await app.loginByEmail('qa14@example.com');
    const bot = await app.connectBot(c);
    await app.db.query("insert into subscribers(connection_id, tg_user_id, first_name, status) values ($1, 991401, 'Asked', 'joinreq')", [bot.connId]);
    let st = await c.get('/api/app/state');
    assert.equal(st.body.stats.new_subscribers_24h, 0);
    assert.ok(!st.body.activity.some((a) => a.kind === 'start' && a.who === 'Asked'));
    await app.addSubscribers(bot.connId, 1, { from: 991402 });
    st = await c.get('/api/app/state');
    assert.equal(st.body.stats.new_subscribers_24h, 1);
  });
});

describe('QA-8: "9am local time" broadcasts on the calendar', () => {
  it('the list gives the first and next 9am delivery time', async () => {
    const c = await app.loginByEmail('qa8@example.com');
    const ws = await app.ws(c);
    await app.db.query("update workspaces set plan_code = 'growth', plan_status = 'active', period_end = now() + interval '20 days' where id = $1", [ws.id]);
    const bot = await app.connectBot(c);
    await app.addSubscribers(bot.connId, 2, { from: 990801 });
    const r = await c.post('/api/broadcasts', { connection_id: bot.connId, body: 'Good morning', send_mode: 'local9' });
    assert.equal(r.status, 200, r.text);
    const list = await c.get('/api/broadcasts');
    const b = list.body.broadcasts.find((x) => x.id === r.body.id);
    assert.equal(b.send_at, null);
    assert.ok(b.next_due && new Date(b.next_due) > new Date(), 'next 9am is in the future');
    assert.equal(new Date(b.first_due).getTime(), new Date(b.next_due).getTime());
  });
});

describe('QA-15: customers see a first name (or "Castvoo team") on staff replies', () => {
  it('a staff account without a real name shows as Castvoo team', async () => {
    const c = await app.loginByEmail('qa15@example.com');
    const s = await c.post('/api/support', { body: 'Hello, I need help' });
    assert.equal(s.status, 200, s.text);
    const t = await app.db.one('select id from support_threads where user_id = $1 order by id desc limit 1', [c.user.id]);
    const owner = await app.owner();
    const name = await app.db.one('select name, email from users where id = $1', [owner.user.id]);
    assert.equal(name.name, name.email.split('@')[0], 'the test owner has no real name');
    const rep = await owner.post('/api/admin/support/' + t.id + '/reply', { body: 'Hi! Happy to help.' });
    assert.equal(rep.status, 200, rep.text);
    let m = await app.db.one("select author_name from support_messages where thread_id = $1 and author_type = 'staff' order by id desc limit 1", [t.id]);
    assert.equal(m.author_name, 'Castvoo team');
    await app.db.query("update users set name = 'Ngozi Okafor' where id = $1", [owner.user.id]);
    await owner.post('/api/admin/support/' + t.id + '/reply', { body: 'Anything else?' });
    m = await app.db.one("select author_name from support_messages where thread_id = $1 and author_type = 'staff' order by id desc limit 1", [t.id]);
    assert.equal(m.author_name, 'Ngozi', 'first name only');
    await app.db.query('update users set name = $2 where id = $1', [owner.user.id, name.name]);
  });
});

describe('AUD-7: Cas knows Welcome Flows and can write a welcome', () => {
  it('the persona names Welcome Flows and kind=welcome reaches the prompt (1 AI write)', async () => {
    const c = await app.loginByEmail('aud7@example.com');
    app.fakes.ai.text = 'Hi {name}, welcome!';
    const r = await c.post('/api/ai/write', { goal: 'Welcome new members to my fashion channel', kind: 'welcome' });
    assert.equal(r.status, 200, r.text);
    const call = app.fakes.ai.calls[app.fakes.ai.calls.length - 1];
    assert.match(call.system, /Welcome Flows/);
    assert.match(call.messages[0].content, /moment someone asks to join/);
    const ws = await app.ws(c);
    assert.equal(ws.ai_used, 1);
  });
});

describe('AUD-12: knowledge about the video guides', () => {
  it('has a video-guides article and no "40-second video on the Help page"', async () => {
    const kb = require('../../server/knowledge-defaults');
    const guides = kb.find((k) => k.key === 'video-guides');
    assert.ok(guides, 'video-guides article exists');
    assert.match(guides.body, /9 short video/);
    const gs = kb.find((k) => k.key === 'getting-started');
    assert.doesNotMatch(gs.body, /Help page shows each step in a 40-second video/);
    const keys = kb.map((k) => k.key);
    assert.equal(new Set(keys).size, keys.length, 'keys are unique');
    const row = await app.db.one("select title from knowledge where key = 'video-guides'");
    assert.ok(row, 'synced into the database on start');
    // Every guide in the player is named in the article.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'app-guides.js'), 'utf8');
    const titles = [...src.matchAll(/\{ id: '[^']+', title: '([^']+)'/g)].map((m) => m[1]);
    assert.equal(titles.length, 9);
    for (const t of titles) assert.ok(guides.body.includes(t.replace(/&amp;/g, '&')), 'article names ' + t);
  });
});

describe('builder helpers (public/js/app-flows.js)', () => {
  const ui = loadFlowsUi();
  it('QA-4: template placeholder text is caught before saving', () => {
    assert.equal(ui.wfPlaceholder('Hi {name}, here is today\'s tip:\n\n(Write one useful tip for your audience here.)'), '(Write one useful tip for your audience here.)');
    assert.ok(ui.wfPlaceholder('Thanks 💙\n\n(Tell them about your offer here, with one clear button.)'));
    assert.ok(ui.wfPlaceholder('Sale ends [ADD DETAIL]'));
    assert.equal(ui.wfPlaceholder('Hi {name} (you are in!) Tap here for more.'), '');
  });
  it('QA-10: wait units follow the number', () => {
    assert.match(ui.wfUnitOptions(1, 'hour'), /value="hour" selected>hour</);
    assert.match(ui.wfUnitOptions(1, 'hour'), />day</);
    assert.match(ui.wfUnitOptions(2, 'day'), /value="day" selected>days</);
  });
  it('QA-20: two waits in a row become one, and Wait has no Duplicate button', () => {
    const blocks = [{ type: 'message', body: 'a' }, { type: 'wait', value: 1, unit: 'day' }, { type: 'wait', value: 12, unit: 'hour' }, { type: 'message', body: 'b' }];
    assert.equal(ui.wfMergeWaits(blocks), '36 hours');
    assert.equal(JSON.stringify(blocks[1]), JSON.stringify({ type: "wait", value: 36, unit: "hour" }));
    assert.equal(blocks.length, 3);
    const html = ui.blocksHtml([{ type: 'message', body: 'a', buttons: [], variants: [] }, { type: 'wait', value: 1, unit: 'day' }, { type: 'message', body: 'b', buttons: [], variants: [] }], { editable: true });
    const waitHtml = html.slice(html.indexOf('wf-blk wait'), html.indexOf('wf-blk msg', html.indexOf('wf-blk wait')));
    assert.doesNotMatch(waitHtml, /data-dup=/);
    assert.match(waitHtml, /selected>day</, '"Wait 1 day", not "1 days"');
  });
  it('QA-9: the upload progress box is not an upgrade badge; AI-W: Write it with Cas shows when Cas is on', () => {
    const blocks = [{ type: 'message', body: 'a', buttons: [], variants: [] }];
    const on = ui.blocksHtml(blocks, { editable: true, ai: true, has: () => true });
    assert.match(on, /class="nup" data-upl="0"/);
    assert.doesNotMatch(on, /class="nup" data-up=/);
    assert.match(on, /data-aiw="0">✨ Write it with Cas</);
    const locked = ui.blocksHtml(blocks, { editable: true, ai: true, has: (k) => k !== 'ai' });
    assert.match(locked, /Write it with Cas <span class="wf-lock" data-up="ai">/);
    assert.doesNotMatch(ui.blocksHtml(blocks, { editable: true, ai: false }), /Write it with Cas/);
  });
});

/** Load core.js + app-flows.js into a sandbox with tiny browser stubs (same as welcome-flows.test.js). */
function loadFlowsUi() {
  const root = path.join(__dirname, '..', '..', 'public', 'js');
  const ctx = {
    console, URLSearchParams, URL, Date, Math, JSON, Intl, setTimeout, clearTimeout,
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    document: { querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} }), documentElement: {}, body: {} },
    window: {}, location: { hash: '' }, localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {} },
    navigator: {}, history: {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  const src = ['core.js', 'app-flows.js'].map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n;\n');
  vm.runInContext('var PAGES = {}; var APP = { state: null }; var CFG = { features: {} };\n' + src + '\n;this.__ui = { blocksHtml, wfPlaceholder, wfUnitOptions, wfMergeWaits };', ctx);
  return ctx.__ui;
}

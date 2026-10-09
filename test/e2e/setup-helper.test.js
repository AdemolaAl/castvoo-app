'use strict';
/*
 * Setup helper: the owner invites one person (by email or a one-time link) to set up and run the workspace with
 * their own login. Consent screen, single-use links, the workspace role map checked on EVERY route (generated from
 * the router), what the helper can't see or do, the billing and sending switches, the activity list, removal that
 * takes effect on the next request, one helper per workspace, no seat used, the Free plan, and the support AI's scope.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers/app');

let app, perms;
before(async () => { app = await startApp(); perms = app.require('permissions'); });
after(async () => { if (app) await app.stop(); });
beforeEach(() => { app.rl._reset(); app.fakes.ai.script = null; });

/** Requests as `c`, inside workspace `wsId` (the dashboard sends x-ws). */
const inWs = (c, wsId) => {
  const h = (o = {}) => ({ ...o, headers: { ...(o.headers || {}), 'x-ws': String(wsId) } });
  return {
    get: (p, o) => c.get(p, h(o)), post: (p, b, o) => c.post(p, b, h(o)), put: (p, b, o) => c.put(p, b, h(o)), del: (p, o) => c.del(p, h(o)),
    request: (m, p, b, o) => c.request(m, p, b, h(o)),
  };
};
const tokenOf = (link) => link.split('#join/')[1];
let seq = 0;
/** An owner with a workspace called `name`, and a person who becomes their setup helper (by email invite). */
async function withHelper(name = 'Daily Market Tips') {
  const n = ++seq;
  const owner = await app.loginByEmail(`owner${n}.helper@example.com`, { name: 'Ejiro Owner' });
  const ws = await app.ws(owner);
  await owner.post('/api/app/settings', { name });
  const helperMail = `tunde${n}.helper@example.com`;
  const inv = await owner.post('/api/app/team/invite', { email: helperMail, role: 'helper' });
  assert.equal(inv.status, 200, inv.text);
  const hc = await app.loginByEmail(helperMail, { name: 'Tunde Media' });
  const acc = await hc.post('/api/invites/accept', { token: tokenOf(inv.body.link), consent: true });
  assert.equal(acc.status, 200, acc.text);
  return { owner, ws, hc, h: inWs(hc, ws.id), helperMail };
}
const emailKeys = (userOrEmail) => app.db.many('select template from email_log where to_email = $1 order by id', [userOrEmail]).then((r) => r.map((x) => x.template));

describe('inviting a setup helper', () => {
  it('by email: only that email, a consent screen, Accept needs consent, the owner hears about it', async () => {
    const owner = await app.loginByEmail('ada.owner@example.com', { name: 'Ejiro Segbuyota' });
    const ws = await app.ws(owner);
    await owner.post('/api/app/settings', { name: 'Daily Market Tips' });
    const inv = await owner.post('/api/app/team/invite', { email: 'buyer@example.com', role: 'helper' });
    assert.equal(inv.status, 200, inv.text);
    const mail = app.fakes.lastEmail('buyer@example.com');
    assert.match(mail.subject, /wants your help setting up Castvoo/);
    assert.ok(mail.text.includes(inv.body.link));
    assert.deepEqual(await emailKeys('buyer@example.com'), ['helper_invite']);
    const token = tokenOf(inv.body.link);

    // Someone else (a forwarded email) can't open it.
    const stranger = await app.loginByEmail('stranger.helper@example.com');
    const g0 = await stranger.get('/api/invites/' + token);
    assert.equal(g0.status, 403);
    assert.equal(g0.body.code, 'invite_email');
    assert.equal((await stranger.post('/api/invites/accept', { token, consent: true })).status, 403);

    const hc = await app.loginByEmail('buyer@example.com', { name: 'Tunde Bakare' });
    const g = await hc.get('/api/invites/' + token);
    assert.equal(g.status, 200, g.text);
    assert.equal(g.body.role, 'helper');
    assert.equal(g.body.kind, 'email');
    assert.equal(g.body.workspace_name, 'Daily Market Tips');
    assert.equal(g.body.owner_name, 'Ejiro');
    assert.ok(g.body.can.some((x) => /Welcome Flows/.test(x)));
    assert.ok(g.body.cannot.some((x) => /login/.test(x)));
    assert.ok(!g.text.includes('ada.owner@example.com'), 'the consent screen does not show the owner\'s email');

    const noConsent = await hc.post('/api/invites/accept', { token });
    assert.equal(noConsent.status, 400);
    assert.equal(noConsent.body.code, 'consent_needed');
    const acc = await hc.post('/api/invites/accept', { token, consent: true });
    assert.equal(acc.status, 200, acc.text);
    assert.equal(acc.body.role, 'helper');
    assert.equal(acc.body.workspace_id, ws.id);
    assert.equal((await hc.post('/api/invites/accept', { token, consent: true })).status, 404, 'used up');

    // The owner: an email and a notice in the dashboard (until "Got it").
    assert.ok((await emailKeys('ada.owner@example.com')).includes('helper_joined'));
    assert.match(app.fakes.lastEmail('ada.owner@example.com').text, /Tunde Bakare/);
    let st = (await owner.get('/api/app/state')).body;
    assert.deepEqual(st.helper.notice, { name: 'Tunde Bakare' });
    assert.equal(st.helper.active, true);
    assert.equal((await owner.post('/api/app/team/helper/seen')).status, 200);
    st = (await owner.get('/api/app/state')).body;
    assert.equal(st.helper.notice, null);

    // The helper: the workspace is in their list with the helper role, and its state says so.
    const me = (await hc.get('/api/me')).body;
    assert.ok(me.workspaces.some((w) => w.id === ws.id && w.role === 'helper'));
    const hs = (await inWs(hc, ws.id).get('/api/app/state')).body;
    assert.equal(hs.workspace.role, 'helper');
    assert.deepEqual(hs.helper, { you: true, billing: false, send: true });
  });

  it('by one-time link: the first person to accept gets it, then it is burned; it expires; decline burns it', async () => {
    const owner = await app.loginByEmail('linkowner@example.com', { name: 'Link Owner' });
    const ws = await app.ws(owner);
    const r = await owner.post('/api/app/team/helper-link');
    assert.equal(r.status, 200, r.text);
    assert.match(r.body.link, /#join\/[A-Za-z0-9_-]{20,}$/);
    const days = (new Date(r.body.expires_at) - Date.now()) / 86400000;
    assert.ok(days > 6.9 && days < 7.1, 'expires in 7 days');
    const token = tokenOf(r.body.link);
    // The team list shows the pending link to the owner.
    const team = (await owner.get('/api/app/team')).body;
    assert.equal(team.helper.invite.kind, 'link');
    assert.equal(team.helper.invite.link, r.body.link);

    const first = await app.loginByEmail('first.link@example.com', { name: 'First Person' });
    const second = await app.loginByEmail('second.link@example.com', { name: 'Second Person' });
    assert.equal((await first.get('/api/invites/' + token)).status, 200, 'any logged-in person can open a link invite');
    assert.equal((await first.post('/api/invites/accept', { token, consent: true })).status, 200);
    const again = await second.post('/api/invites/accept', { token, consent: true });
    assert.equal(again.status, 404, 'single use');
    assert.equal((await second.get('/api/invites/' + token)).status, 404);
    const inv = await app.db.one('select * from invites where token = $1', [token]);
    assert.equal(Number(inv.accepted_by), first.user.id, 'bound to the first acceptor');
    const m = await app.db.one('select role from members where workspace_id = $1 and user_id = $2', [ws.id, first.user.id]);
    assert.equal(m.role, 'helper');

    // Expiry.
    const o2 = await app.loginByEmail('linkowner2@example.com');
    const l2 = await o2.post('/api/app/team/helper-link');
    await app.db.query("update invites set expires_at = now() - interval '1 second' where token = $1", [tokenOf(l2.body.link)]);
    assert.equal((await second.post('/api/invites/accept', { token: tokenOf(l2.body.link), consent: true })).status, 404, 'expired');

    // A new link replaces the old one; Decline burns it.
    const l3 = await o2.post('/api/app/team/helper-link');
    const l4 = await o2.post('/api/app/team/helper-link');
    assert.equal((await second.get('/api/invites/' + tokenOf(l3.body.link))).status, 404, 'the newer link cancelled the older one');
    assert.equal((await second.post('/api/invites/decline', { token: tokenOf(l4.body.link) })).status, 200);
    assert.equal((await first.post('/api/invites/accept', { token: tokenOf(l4.body.link), consent: true })).status, 404, 'declined links are burned');
    // The owner can cancel a pending link.
    const l5 = await o2.post('/api/app/team/helper-link');
    assert.equal((await o2.post('/api/app/team/helper/cancel-invite')).status, 200);
    assert.equal((await second.get('/api/invites/' + tokenOf(l5.body.link))).status, 404);
    // The owner can't use their own link.
    const l6 = await o2.post('/api/app/team/helper-link');
    const self = await o2.post('/api/invites/accept', { token: tokenOf(l6.body.link), consent: true });
    assert.equal(self.status, 409);
    assert.equal(self.body.code, 'already_member');
  });

  it('one helper per workspace; the helper uses no team seat; the Free plan includes one', async () => {
    const owner = await app.loginByEmail('freeowner@example.com', { name: 'Free Owner' });
    const ws = await app.ws(owner);
    await app.db.query("update workspaces set plan_code = 'free', plan_status = 'active', trial_ends_at = null where id = $1", [ws.id]);
    // Free has 1 seat (the owner's): a teammate needs an upgrade...
    const tm = await owner.post('/api/app/team/invite', { email: 'mate.free@example.com', role: 'sender' });
    assert.equal(tm.status, 402);
    assert.equal(tm.body.code, 'limit_seats');
    // ...but the setup helper is included.
    const inv = await owner.post('/api/app/team/invite', { email: 'free.helper@example.com', role: 'helper' });
    assert.equal(inv.status, 200, inv.text);
    const hc = await app.loginByEmail('free.helper@example.com', { name: 'Free Helper' });
    assert.equal((await hc.post('/api/invites/accept', { token: tokenOf(inv.body.link), consent: true })).status, 200);
    const team = (await owner.get('/api/app/team')).body;
    assert.equal(team.seats, 1);
    assert.equal(team.seats_used, 1, 'the helper is not counted');
    assert.equal(team.helper.member.email, 'free.helper@example.com');
    assert.equal((await owner.get('/api/app/plan')).body.usage.seats, 1, 'plan usage does not count the helper either');
    // Max one helper: a second invite (email or link) is refused while one is active.
    for (const r of [await owner.post('/api/app/team/invite', { email: 'second.helper@example.com', role: 'helper' }), await owner.post('/api/app/team/helper-link')]) {
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'helper_exists');
    }
    // Even an old invite accepted later can't make a second helper.
    await app.db.query("insert into invites(token, workspace_id, email, role, kind, created_by, expires_at) values ('oldhelperinvite123456', $1, null, 'helper', 'link', $2, now() + interval '1 day')", [ws.id, owner.user.id]);
    const late = await app.loginByEmail('late.helper@example.com');
    const lr = await late.post('/api/invites/accept', { token: 'oldhelperinvite123456', consent: true });
    assert.equal(lr.status, 409);
    assert.equal(lr.body.code, 'helper_exists');
    // On a 3-seat plan the owner can still fill both teammate seats with a helper present.
    await app.db.query("update workspaces set plan_code = 'growth' where id = $1", [ws.id]);
    assert.equal((await owner.post('/api/app/team/invite', { email: 'mate1.free@example.com' })).status, 200);
    assert.equal((await owner.post('/api/app/team/invite', { email: 'mate2.free@example.com' })).status, 200);
    assert.equal((await owner.post('/api/app/team/invite', { email: 'mate3.free@example.com' })).status, 402);
  });
});

describe('what a setup helper may do (the role map, on every route)', () => {
  let s;
  before(async () => { s = await withHelper('Route Map Tips'); });

  it('every workspace route answers the helper exactly as WS_ROUTES says', async () => {
    const routes = app.require('app').buildRouter().routes.filter((r) => (r.opts || {}).auth === 'workspace');
    assert.ok(routes.length > 60, 'all workspace routes are listed');
    const skip = new Set(['POST /api/app/team/leave']); // allowed, tested on its own below (it would end the membership)
    const fill = (p) => p.replace(':id', '999999').replace(':tag', 'none').replace(':ref', 'cv_none_123');
    let allowed = 0, denied = 0;
    for (const rt of routes) {
      const key = `${rt.method} ${rt.pattern}`;
      if (skip.has(key)) continue;
      const perm = perms.WS_ROUTES[key];
      assert.ok(perm, `${key} is in WS_ROUTES`);
      const may = perms.wsCan('helper', perm, { helper_billing: false });
      app.rl._reset();
      const r = await s.h.request(rt.method, fill(rt.pattern), rt.method === 'GET' ? undefined : {});
      const blocked = r.status === 403 && r.body && r.body.code === 'owner_only';
      if (may) { allowed++; assert.ok(!blocked, `${key} (${perm}) should be allowed for the helper, got ${r.status} ${r.text.slice(0, 120)}`); }
      else { denied++; assert.ok(blocked, `${key} (${perm}) should be refused for the helper, got ${r.status} ${r.text.slice(0, 120)}`); }
      assert.notEqual(r.status, 500, `${key} crashed: ${r.text.slice(0, 200)}`);
    }
    assert.ok(allowed > 40 && denied >= 10, `allowed ${allowed}, denied ${denied}`);
    // Never for a helper, whatever the switches.
    for (const p of ['ws.team', 'ws.export', 'ws.earnings', 'ws.cancel', 'ws.approve']) assert.equal(perms.wsCan('helper', p, { helper_billing: true, helper_send: true }), false, p);
  });

  it('the helper still belongs (the map test did not remove them) and the owner still has every route', async () => {
    assert.equal((await s.h.get('/api/app/state')).body.workspace.role, 'helper');
    for (const [k, perm] of Object.entries(perms.WS_ROUTES)) if (perm !== 'ws.leave') assert.ok(perms.wsCan('owner', perm, {}), `owner may ${k}`);
  });

  it("can't see the owner's login, contact details or payout details", async () => {
    const team = await s.h.get('/api/app/team');
    assert.equal(team.status, 200);
    const ownerEmail = s.owner.user.email;
    assert.ok(!team.text.includes(ownerEmail), 'owner email hidden');
    const ownerRow = team.body.members.find((m) => m.role === 'owner');
    assert.match(ownerRow.email, /•••/);
    assert.equal(ownerRow.tg_username, null);
    assert.deepEqual(team.body.invites, [], 'no invite emails or tokens');
    assert.deepEqual(team.body.helper.activity, [], 'the activity list is for the owner');
    const st = await s.h.get('/api/app/state');
    assert.ok(!st.text.includes(ownerEmail));
    // Referral payout details: refused, and the owner's withdrawal address never appears anywhere the helper can read.
    await app.db.query("insert into withdrawals(user_id, amount_cents, coin, address) values ($1, 30000, 'USDT', 'TQ7xY3mRbN8vK2pL5sW9dF4gH6jC1aE0zU')", [s.owner.user.id]);
    const ref = await s.h.get('/api/referrals');
    assert.equal(ref.status, 403);
    assert.equal(ref.body.code, 'owner_only');
    for (const p of ['/api/app/state', '/api/app/team', '/api/wallet', '/api/app/plan']) assert.ok(!(await s.h.get(p)).text.includes('TQ7xY3mRbN8vK2pL5sW9dF4gH6jC1aE0zU'), p);
    assert.equal((await s.h.post('/api/referrals/withdraw', { coin: 'USDT', address: 'TQ7xY3mRbN8vK2pL5sW9dF4gH6jC1aE0zU', amount: 300 })).status, 403);
    assert.equal((await s.h.get('/api/subscribers/export.csv')).status, 403, 'no export of all data');
  });

  it("can't remove or change the owner, invite people or change roles", async () => {
    for (const [p, b] of [['/api/app/team/remove', { user_id: s.owner.user.id }], ['/api/app/team/role', { user_id: s.owner.user.id, role: 'drafter' }],
      ['/api/app/team/invite', { email: 'friend.of.helper@example.com', role: 'sender' }], ['/api/app/team/invite', { email: 'other.helper@example.com', role: 'helper' }],
      ['/api/app/team/helper-link', {}], ['/api/app/team/helper/settings', { billing: true }]]) {
      const r = await s.h.post(p, b);
      assert.equal(r.status, 403, p);
      assert.equal(r.body.code, 'owner_only');
      assert.match(r.body.error, /Only the workspace owner/);
    }
    const m = await app.db.one("select role from members where workspace_id = $1 and user_id = $2", [s.ws.id, s.owner.user.id]);
    assert.equal(m.role, 'owner');
    assert.equal((await app.db.one('select count(*)::int n from invites where workspace_id = $1 and accepted_at is null', [s.ws.id])).n, 0);
    // The owner can't make the helper a seat-using teammate by changing the role.
    const r = await s.owner.post('/api/app/team/role', { user_id: s.hc.user.id, role: 'sender' });
    assert.equal(r.status, 400);
  });

  it('can set up the workspace: settings, Train Cas, connect a bot', async () => {
    assert.equal((await s.h.post('/api/app/settings', { timezone: 'Africa/Nairobi' })).status, 200);
    assert.equal((await app.db.one('select timezone from workspaces where id = $1', [s.ws.id])).timezone, 'Africa/Nairobi');
    assert.equal((await s.h.post('/api/app/ai-profile', { business: 'Daily Market Tips' })).status, 200);
    const bot = app.fakes.tg.newBot('helperbuilt_bot');
    const c = await s.h.post('/api/connections/bot', { token: bot.token });
    assert.equal(c.status, 200, c.text);
    const conn = await app.db.one('select workspace_id from connections where id = $1', [c.body.connection.id]);
    assert.equal(Number(conn.workspace_id), s.ws.id, 'connected to the customer\'s workspace, not the helper\'s own');
    const list = (await s.h.get('/api/connections')).body;
    assert.ok(!JSON.stringify(list).includes(bot.token), 'bot tokens stay hidden');
  });
});

describe('the owner\'s switches', () => {
  it('"Can manage billing & plan" is off by default; on, the helper can change the plan (never cancel it)', async () => {
    const s = await withHelper('Billing Tips');
    let r = await s.h.post('/api/app/plan', { plan: 'starter' });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'owner_only');
    assert.equal((await s.h.post('/api/app/coupon', { code: 'NOPE' })).status, 403);
    assert.equal((await s.owner.post('/api/app/team/helper/settings', { billing: true })).status, 200);
    assert.equal((await s.h.get('/api/app/state')).body.helper.billing, true);
    r = await s.h.post('/api/app/plan', { plan: 'starter' });
    assert.equal(r.status, 200, r.text);
    assert.equal((await app.db.one('select pending_plan_code from workspaces where id = $1', [s.ws.id])).pending_plan_code, 'starter');
    assert.equal((await s.h.post('/api/app/coupon', { code: 'NOPE' })).status, 400, 'allowed now (the code is just wrong)');
    assert.equal((await s.h.post('/api/app/plan/cancel')).status, 403, 'cancelling stays the owner\'s');
    await s.owner.post('/api/app/team/helper/settings', { billing: false });
    assert.equal((await s.h.post('/api/app/plan', { plan: 'growth' })).status, 403, 'off again');
  });

  it('"Can send broadcasts": off, the helper writes and schedules and the owner approves', async () => {
    const s = await withHelper('Sending Tips');
    const bot = app.fakes.tg.newBot();
    const conn = (await s.h.post('/api/connections/bot', { token: bot.token })).body.connection;
    let r = await s.h.post('/api/broadcasts', { connection_id: conn.id, body: 'Morning signals are live' });
    assert.equal(r.status, 200, r.text);
    assert.notEqual(r.body.status, 'pending_approval', 'on by default');
    assert.equal((await s.owner.post('/api/app/team/helper/settings', { send: false })).status, 200);
    r = await s.h.post('/api/broadcasts', { connection_id: conn.id, body: 'Evening recap' });
    assert.equal(r.body.status, 'pending_approval');
    const d = await s.h.post('/api/broadcasts', { connection_id: conn.id, body: 'Draft for later', draft: true });
    assert.equal(d.body.status, 'draft');
    assert.equal((await s.h.post(`/api/broadcasts/${d.body.id}/send`)).status, 403, 'the owner presses Send');
    assert.equal((await s.h.post(`/api/broadcasts/${r.body.id}/approve`)).status, 403);
    const ok = await s.owner.post(`/api/broadcasts/${r.body.id}/approve`);
    assert.equal(ok.status, 200, ok.text);
  });
});

describe('activity and removal', () => {
  it("records the helper's changes as plain lines for the owner", async () => {
    const s = await withHelper('Activity Tips');
    const bot = app.fakes.tg.newBot('activity_tips_bot');
    const conn = (await s.h.post('/api/connections/bot', { token: bot.token })).body.connection;
    const chanId = (await app.db.one("insert into connections(workspace_id, kind, tg_chat_id, title) values ($1,'channel',-100990001,'Tips Channel') returning id", [s.ws.id])).id;
    const f = await s.h.post('/api/flows', { name: 'VIP welcome', chat_id: chanId, bot_id: conn.id, approve_mode: 'after_welcome', blocks: [{ type: 'message', body: 'Hi {name}!' }] });
    assert.equal(f.status, 200, f.text);
    await s.h.post('/api/broadcasts', { connection_id: conn.id, body: 'Weekly outlook\nMore text', title: 'Weekly outlook' });
    await s.h.post('/api/segments', { name: 'All buyers', rules: [] });
    await s.h.del('/api/flows/' + f.body.id);
    await s.h.post('/api/ai/write', { prompt: 'x' }); // writing helpers make no line
    const team = (await s.owner.get('/api/app/team')).body;
    const lines = team.helper.activity.map((a) => a.line);
    for (const want of ['Joined as setup helper', 'Connected bot @activity_tips_bot', "Created Welcome Flow 'VIP welcome'", "Sent broadcast 'Weekly outlook'", "Created audience 'All buyers'", "Deleted Welcome Flow 'VIP welcome'"]) {
      assert.ok(lines.includes(want), `activity has "${want}": ${JSON.stringify(lines)}`);
    }
    assert.equal(lines[0], "Deleted Welcome Flow 'VIP welcome'", 'newest first');
    assert.ok(team.helper.activity.every((a) => a.actor === 'Tunde Media'));
    const rows = await app.db.many('select actor_user_id from workspace_activity where workspace_id = $1', [s.ws.id]);
    assert.ok(rows.every((x) => Number(x.actor_user_id) === s.hc.user.id), 'the helper is the actor');
    assert.ok(team.helper.member.last_active_at, 'last active is shown');
    // The owner's own changes are not in the helper's activity.
    await s.owner.post('/api/segments', { name: 'Owner only', rules: [] });
    assert.ok(!(await s.owner.get('/api/app/team')).body.helper.activity.some((a) => /Owner only/.test(a.line)));
  });

  it('remove helper: access ends on the very next request, they get an email, what they scheduled keeps running', async () => {
    const s = await withHelper('Removal Tips');
    const bot = app.fakes.tg.newBot();
    const conn = (await s.h.post('/api/connections/bot', { token: bot.token })).body.connection;
    const sched = await s.h.post('/api/broadcasts', { connection_id: conn.id, body: 'Later', send_mode: 'at', send_at: new Date(Date.now() + 3600e3).toISOString() });
    assert.equal(sched.body.status, 'scheduled', sched.text);
    assert.equal((await s.h.get('/api/app/state')).status, 200);
    const r = await s.owner.post('/api/app/team/remove', { user_id: s.hc.user.id });
    assert.equal(r.status, 200);
    assert.equal(r.body.removed, true);
    // The same session, next call:
    const next = await s.h.get('/api/app/state');
    assert.equal(next.status, 403);
    assert.equal(next.body.code, 'access_removed');
    assert.equal((await s.h.post('/api/app/settings', { name: 'Hijacked' })).status, 403);
    assert.notEqual((await app.db.one('select name from workspaces where id = $1', [s.ws.id])).name, 'Hijacked');
    // Without x-ws they simply land in their own workspace.
    const own = await s.hc.get('/api/app/state');
    assert.equal(own.status, 200);
    assert.notEqual(own.body.workspace.id, s.ws.id);
    assert.ok(!(await s.hc.get('/api/me')).body.workspaces.some((w) => w.id === s.ws.id));
    assert.ok((await emailKeys(s.helperMail)).includes('helper_removed'));
    assert.equal((await app.db.one('select status from broadcasts where id = $1', [sched.body.id])).status, 'scheduled', 'scheduled message keeps running');
    // The owner can invite a new helper right away.
    assert.equal((await s.owner.post('/api/app/team/helper-link')).status, 200);
  });

  it('the helper can leave; the owner cannot', async () => {
    const s = await withHelper('Leaving Tips');
    assert.equal((await s.owner.post('/api/app/team/leave')).status, 403, 'not for the owner (role map)');
    assert.equal((await s.h.post('/api/app/team/leave')).status, 200);
    assert.equal(await app.db.one('select 1 from members where workspace_id = $1 and user_id = $2', [s.ws.id, s.hc.user.id]), null);
    assert.ok((await app.db.many('select line from workspace_activity where workspace_id = $1', [s.ws.id])).some((x) => x.line === 'Left the workspace'));
  });
});

describe('support AI and Cas for a setup helper', () => {
  it('gets workspace facts, never the owner\'s private data, and the prompt says who they are', async () => {
    const s = await withHelper('Support Scope Tips');
    await app.setSetting('support_ai', { typing_min_ms: 0, typing_max_ms: 0, debounce_ms: 0 });
    const sai = app.require('services/support-ai');
    app.fakes.ai.script = [{ tools: [{ name: 'get_account' }, { name: 'get_referrals' }, { name: 'get_withdrawals' }] }, { text: 'You are the setup helper here.' }];
    const r = await s.h.post('/api/support', { body: 'What can I do in this workspace? What is the owner email?' });
    assert.equal(r.status, 200, r.text);
    const t = await app.db.one('select * from support_threads where id = $1', [r.body.thread_id]);
    assert.equal(Number(t.workspace_id), s.ws.id);
    assert.equal(Number(t.user_id), s.hc.user.id);
    await sai.tick();
    const call = app.fakes.ai.calls.find((c) => JSON.stringify(c.system || '').includes('SETUP HELPER'));
    assert.ok(call, 'the system prompt tells the agent this is the setup helper');
    const logs = await app.db.many('select tool, output from support_ai_tool_log where thread_id = $1 order by id', [t.id]);
    const acc = logs.find((l) => l.tool === 'get_account').output;
    assert.match(acc.you_are, /setup helper/);
    assert.equal(acc.workspace.name, 'Support Scope Tips');
    const text = JSON.stringify(logs);
    const [u, d] = s.owner.user.email.split('@');
    assert.ok(!text.includes(s.owner.user.email) && !text.includes(u.slice(0, 2) + '***' + u.slice(-1) + '@' + d), 'no owner email, not even masked');
    assert.equal(acc.members.find((m) => m.role === 'Owner').email, undefined);
    assert.equal(acc.members.find((m) => m.role === 'Setup helper').name, 'Tunde');
    for (const tool of ['get_referrals', 'get_withdrawals']) assert.equal(logs.find((l) => l.tool === tool).output.not_available, true, tool);
    // Cas (read-only) gets the same scope.
    const tools = app.require('services/support-tools');
    const cas = await tools.run('get_account', {}, { userId: s.hc.user.id, workspaceId: s.ws.id, role: 'helper', log: false });
    assert.ok(!JSON.stringify(cas.output).includes(s.owner.user.email));
    // The owner asking the same gets their own account as before.
    const mine = await tools.run('get_account', {}, { userId: s.owner.user.id, workspaceId: s.ws.id, role: 'owner', log: false });
    assert.equal(mine.output.you_are, undefined);
    assert.ok(mine.output.members.find((m) => m.role === 'Owner').email);
  });

  it('the knowledge article is there for the agents', async () => {
    const k = await app.db.one("select title, body from knowledge where key = 'setup-helper'");
    assert.ok(k, 'synced from knowledge-defaults');
    assert.match(k.body, /THEIR OWN Castvoo login/);
    assert.match(k.body, /CANNOT/);
  });
});

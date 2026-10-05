'use strict';
/* Admin panel: every route vs every staff role, team ranks, and each admin screen doing its job. */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers/app');

let app;
const staff = {};
before(async () => {
  app = await startApp();
  staff.owner = await app.owner();
  for (const role of ['admin', 'finance', 'support', 'marketing', 'viewer']) staff[role] = await app.staff(role, `${role}@castvoo.test`);
});
after(async () => { if (app) await app.stop(); });
beforeEach(() => app.rl._reset());

const PERMS = () => app.require('permissions').PERMS;
const MONEY_SETTINGS = ['owner']; // where crypto payments go: Owner only

// [method, path, permission, body]. Ids that don't exist: an allowed role gets 400/404, never 401/403/500.
const ROUTES = [
  ['GET', '/api/admin/me', 'overview.view'],
  ['GET', '/api/admin/overview', 'overview.view'],
  ['GET', '/api/admin/users', 'users.view'],
  ['GET', '/api/admin/users/999999', 'users.view'],
  ['POST', '/api/admin/users/999999/status', 'users.edit', { status: 'active' }],
  ['POST', '/api/admin/workspaces/999999/plan', 'users.edit', {}],
  ['POST', '/api/admin/workspaces/999999/wallet', 'wallet.adjust', { amount: 1, reason: 'test' }],
  ['GET', '/api/admin/payments', 'payments.view'],
  ['POST', '/api/admin/payments/nope/approve', 'payments.review', {}],
  ['POST', '/api/admin/payments/nope/reject', 'payments.review', { reason: 'xyz' }],
  ['POST', '/api/admin/payments/nope/recheck', 'payments.review', {}],
  ['POST', '/api/admin/payments/nope/chargeback', 'payments.review', { reason: 'Card dispute' }],
  ['GET', '/api/admin/withdrawals', 'payments.view'],
  ['POST', '/api/admin/withdrawals/999999/paid', 'withdrawals.review', { txid: 'x'.repeat(20) }],
  ['POST', '/api/admin/withdrawals/999999/reject', 'withdrawals.review', { reason: 'xyz' }],
  ['GET', '/api/admin/plans', 'users.view'],
  ['POST', '/api/admin/plans', 'pricing.edit', {}],
  ['PUT', '/api/admin/plans/nope', 'pricing.edit', {}],
  ['GET', '/api/admin/offers', 'users.view'],
  ['POST', '/api/admin/offers', 'offers.edit', {}],
  ['PUT', '/api/admin/offers/999999', 'offers.edit', {}],
  ['POST', '/api/admin/offers/999999/toggle', 'offers.edit', {}],
  ['DELETE', '/api/admin/offers/999999', 'offers.edit'],
  ['GET', '/api/admin/countries', 'users.view'],
  ['PUT', '/api/admin/countries/QQ', 'countries.edit', {}],
  ['PUT', '/api/admin/methods/nope', 'countries.edit', {}],
  ['GET', '/api/admin/features', 'overview.view'],
  ['POST', '/api/admin/features/nope', 'features.edit', {}],
  ['GET', '/api/admin/content', 'overview.view'],
  ['PUT', '/api/admin/content/zz_test', 'content.edit', {}],
  ['GET', '/api/admin/settings', 'overview.view'],
  ['PUT', '/api/admin/settings/company', 'settings.edit', {}],
  ['PUT', '/api/admin/settings/crypto', 'MONEY', { value: { usdt_address: 'bad' } }],
  ['GET', '/api/admin/support', 'support.view'],
  ['GET', '/api/admin/support/999999', 'support.view'],
  ['POST', '/api/admin/support/999999/reply', 'support.reply', { body: 'x' }],
  ['POST', '/api/admin/support/999999/status', 'support.reply', { status: 'open' }],
  ['POST', '/api/admin/support/999999/assign', 'support.reply', { user_id: 999999 }],
  ['POST', '/api/admin/support/999999/suggest', 'support.reply', {}],
  ['GET', '/api/admin/emails', 'overview.view'],
  ['GET', '/api/admin/emails/nope', 'overview.view'],
  ['PUT', '/api/admin/emails/nope', 'emails.edit', {}],
  ['POST', '/api/admin/emails/nope/reset', 'emails.edit', {}],
  ['POST', '/api/admin/emails/nope/preview', 'overview.view', {}],
  ['POST', '/api/admin/emails/nope/test', 'emails.edit', {}],
  ['GET', '/api/admin/knowledge', 'overview.view'],
  ['POST', '/api/admin/knowledge', 'knowledge.edit', {}],
  ['PUT', '/api/admin/knowledge/999999', 'knowledge.edit', { title: 'Title', body: 'Body text' }],
  ['DELETE', '/api/admin/knowledge/999999', 'knowledge.edit'],
  ['POST', '/api/admin/ai/test', 'knowledge.edit', {}],
  ['GET', '/api/admin/team', 'overview.view'],
  ['POST', '/api/admin/team', 'team.manage', {}],
  ['POST', '/api/admin/team/999999/role', 'team.manage', { role: 'viewer' }],
  ['GET', '/api/admin/audit', 'audit.view'],
  ['GET', '/api/admin/system', 'system.view'],
  ['POST', '/api/admin/integrations/nope/test', 'system.view', {}],
];

describe('admin permissions', () => {
  it('every /api/admin route declares a staff permission, and this test covers all of them', () => {
    const r = app.require('app').buildRouter();
    const admin = r.routes.filter((x) => x.pattern.startsWith('/api/admin'));
    for (const x of admin) assert.ok(x.opts && x.opts.staff, `${x.method} ${x.pattern} has no staff permission`);
    const norm = (p) => p.replace(/\/(\d+|nope|QQ|zz_test|company|crypto)(?=\/|$)/g, '/:x');
    const covered = new Set(ROUTES.map(([m, p]) => m + ' ' + norm(p)));
    for (const x of admin) assert.ok(covered.has(x.method + ' ' + x.pattern.replace(/:[a-z_]+/g, ':x')), `not covered by the matrix: ${x.method} ${x.pattern}`);
  });

  for (const role of ['owner', 'admin', 'finance', 'support', 'marketing', 'viewer']) {
    it(`role ${role}: allowed routes work, the rest answer 403`, async () => {
      const c = staff[role];
      for (const [method, path, perm, body] of ROUTES) {
        const allowed = perm === 'MONEY' ? MONEY_SETTINGS.includes(role) : PERMS()[perm].includes(role);
        const r = await c.request(method, path, method === 'GET' || method === 'DELETE' ? undefined : body || {});
        if (allowed) assert.ok(![401, 403].includes(r.status) && r.status < 500, `${role} ${method} ${path} should be allowed, got ${r.status} ${r.text.slice(0, 200)}`);
        else assert.equal(r.status, 403, `${role} ${method} ${path} should be refused, got ${r.status}`);
      }
    });
  }

  it('customers and logged-out people get nothing', async () => {
    const cust = await app.loginByEmail('notstaff@example.com');
    for (const [method, path] of ROUTES.slice(0, 10)) {
      assert.equal((await cust.request(method, path, method === 'GET' ? undefined : {})).status, 403, path);
      assert.equal((await app.client().request(method, path, method === 'GET' ? undefined : {})).status, 401, path);
    }
  });

  it('/api/admin/me lists the permissions of the role', async () => {
    const v = await staff.viewer.get('/api/admin/me');
    assert.equal(v.body.user.role, 'viewer');
    assert.deepEqual(v.body.perms.sort(), ['overview.view', 'support.view', 'users.view']);
  });
});

describe('team ranks', () => {
  it('admins manage people below them only; owners can do anything except leave no owner', async () => {
    const { admin, owner } = staff;
    assert.equal((await admin.post('/api/admin/team', { email: 'newadmin@castvoo.test', role: 'admin' })).status, 403, 'admin cannot create admins');
    assert.equal((await admin.post('/api/admin/team', { email: 'newowner@castvoo.test', role: 'owner' })).status, 403);
    assert.equal((await admin.post('/api/admin/team', { email: 'helper@castvoo.test', role: 'support' })).status, 200);
    const helper = await app.db.one("select id from users where email = 'helper@castvoo.test'");
    assert.equal((await admin.post(`/api/admin/team/${helper.id}/role`, { role: 'admin' })).status, 403, 'cannot promote to own rank');
    assert.equal((await admin.post(`/api/admin/team/${helper.id}/role`, { role: 'viewer' })).status, 200);
    assert.equal((await admin.post(`/api/admin/team/${owner.user.id}/role`, { role: 'viewer' })).status, 403, 'cannot demote the owner');
    assert.equal((await admin.post(`/api/admin/team/${owner.user.id}/role`, { role: null })).status, 403, 'cannot remove the owner');
    const admin2 = await app.staff('admin', 'admin2@castvoo.test');
    assert.equal((await admin.post(`/api/admin/team/${admin2.user.id}/role`, { role: 'viewer' })).status, 403, 'cannot manage an equal');
    assert.equal((await admin.post(`/api/admin/team/${admin.user.id}/role`, { role: 'viewer' })).status, 400, 'not your own role');
    assert.equal((await admin.post('/api/admin/team', { email: 'owner@castvoo.test', role: 'viewer' })).status, 403, 'cannot re-role the owner by email');
    // Admins cannot suspend other admins or the owner either.
    assert.equal((await admin.post(`/api/admin/users/${admin2.user.id}/status`, { status: 'suspended' })).status, 403);
    assert.equal((await admin.post(`/api/admin/users/${owner.user.id}/status`, { status: 'suspended' })).status, 403);
    // Owner: promote, demote, remove.
    assert.equal((await owner.post(`/api/admin/team/${admin2.user.id}/role`, { role: 'owner' })).status, 200);
    assert.equal((await owner.post(`/api/admin/team/${admin2.user.id}/role`, { role: null })).status, 200, 'two owners: one can remove the other');
    assert.equal((await app.db.one('select staff_role from users where id = $1', [admin2.user.id])).staff_role, null);
    assert.equal((await owner.post(`/api/admin/team/${owner.user.id}/role`, { role: 'admin' })).status, 400, 'the last owner cannot step down');
    // The last owner cannot delete their account either.
    assert.equal((await owner.post('/api/me/delete', { confirm: 'DELETE' })).status, 400);
    const team = await owner.get('/api/admin/team');
    assert.equal(team.body.staff[0].staff_role, 'owner');
    assert.ok(app.fakes.lastEmail('helper@castvoo.test', /staff team/));
  });
});

describe('admin screens', () => {
  it('plans: create, edit and switch off show up in the public config at once', async () => {
    const { owner } = staff;
    const bad = await owner.post('/api/admin/plans', { code: 'pro', name: 'Pro', price_month: 'abc', price_year: 1, connections: 1, subscribers: 100, ai_writes: 0, seats: 1 });
    assert.equal(bad.status, 400);
    const ok = await owner.post('/api/admin/plans', { code: 'pro', name: 'Pro', price_month: 29.99, price_year: 299, connections: 2, subscribers: 10000, ai_writes: 500, seats: 2, bullets: 'One\nTwo', sort: 4 });
    assert.equal(ok.status, 200, ok.text);
    assert.equal((await owner.post('/api/admin/plans', { code: 'pro', name: 'Pro', price_month: 1, price_year: 1, connections: 1, subscribers: 100, ai_writes: 0, seats: 1 })).status, 400, 'duplicate code');
    let cfg = (await app.client().get('/api/public/config')).body;
    const pro = cfg.plans.find((p) => p.code === 'pro');
    assert.equal(pro.price_month, 29.99);
    assert.deepEqual(pro.bullets, ['One', 'Two']);
    await owner.put('/api/admin/plans/pro', { name: 'Pro+', price_month: 39, price_year: 390, connections: 2, subscribers: 10000, ai_writes: 500, seats: 2, popular: true, sort: 4 });
    cfg = (await app.client().get('/api/public/config')).body;
    assert.equal(cfg.plans.find((p) => p.code === 'pro').name, 'Pro+');
    assert.deepEqual(cfg.plans.filter((p) => p.popular).map((p) => p.code), ['pro'], 'only one popular plan');
    await owner.put('/api/admin/plans/pro', { name: 'Pro+', price_month: 39, price_year: 390, connections: 2, subscribers: 10000, ai_writes: 500, seats: 2, active: false });
    cfg = (await app.client().get('/api/public/config')).body;
    assert.ok(!cfg.plans.some((p) => p.code === 'pro'));
    const trialPlan = await owner.put('/api/admin/plans/growth', { name: 'Growth', price_month: 49, price_year: 490, connections: 5, subscribers: 25000, ai_writes: 2000, seats: 3, active: false });
    assert.equal(trialPlan.status, 400, 'the trial plan cannot be switched off');
  });

  it('offers: banner on/off, bonus validation', async () => {
    const { marketing } = staff;
    const b = await marketing.post('/api/admin/offers', { kind: 'banner', title: 'Black Friday', description: '50% off', link_url: 'https://castvoo.com/bf' });
    assert.equal(b.status, 200, b.text);
    let cfg = (await app.client().get('/api/public/config')).body;
    assert.ok(cfg.banners.some((x) => x.title === 'Black Friday'));
    const id = (await app.db.one("select id from offers where title = 'Black Friday'")).id;
    await marketing.post(`/api/admin/offers/${id}/toggle`, { active: false });
    cfg = (await app.client().get('/api/public/config')).body;
    assert.ok(!cfg.banners.some((x) => x.title === 'Black Friday'));
    assert.equal((await marketing.post('/api/admin/offers', { kind: 'topup_bonus', title: 'Too generous', min_topup: 100, bonus: 60 })).status, 400);
    assert.equal((await marketing.post('/api/admin/offers', { kind: 'coupon', title: 'Bad code', code: 'no spaces!', percent: 10 })).status, 400);
    assert.equal((await marketing.post('/api/admin/offers', { kind: 'nope', title: 'x' })).status, 400);
    const future = await marketing.post('/api/admin/offers', { kind: 'banner', title: 'Later', starts_at: new Date(Date.now() + 86400000).toISOString() });
    assert.equal(future.status, 200);
    cfg = (await app.client().get('/api/public/config')).body;
    assert.ok(!cfg.banners.some((x) => x.title === 'Later'), 'not started yet');
  });

  it('countries and methods change what /api/public/methods offers', async () => {
    const { finance } = staff;
    const r = await finance.put('/api/admin/countries/NG', { name: 'Nigeria', flag: '🇳🇬', currency: 'ngn', usd_rate: 1600, methods: ['crypto', 'made_up'], featured: true });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual((await app.client().get('/api/public/methods?country=NG')).body.methods.map((m) => m.key), ['gatevoo']);
    assert.equal((await finance.put('/api/admin/countries/NG', { name: 'Nigeria', currency: 'NGN', usd_rate: -1, methods: [] })).status, 400);
    await finance.put('/api/admin/countries/NG', { name: 'Nigeria', currency: 'NGN', usd_rate: 1600, methods: ['paystack_ng', 'crypto'], featured: true });
    await finance.put('/api/admin/methods/paystack_ng', { label: 'Paystack', detail: 'Card', active: false });
    assert.deepEqual((await app.client().get('/api/public/methods?country=NG')).body.methods.map((m) => m.key), ['gatevoo']);
    await finance.put('/api/admin/methods/paystack_ng', { label: 'Paystack', detail: 'Card, bank transfer', active: true });
    assert.deepEqual((await app.client().get('/api/public/methods?country=NG')).body.methods.map((m) => m.key), ['paystack_ng', 'gatevoo']);
    // A new country.
    await finance.put('/api/admin/countries/QA', { name: 'Qatar', currency: 'USD', usd_rate: 1, methods: ['flw_card'] });
    assert.ok((await app.client().get('/api/public/config')).body.countries.some((c) => c.code === 'QA'));
  });

  it('website text and FAQ validation', async () => {
    const { marketing } = staff;
    assert.equal((await marketing.put('/api/admin/content/hero_title', { value: 'Sell *more* on Telegram' })).status, 200);
    assert.equal((await app.client().get('/api/public/config')).body.content.hero_title, 'Sell *more* on Telegram');
    assert.equal((await marketing.put('/api/admin/content/faq', { value: 'not json' })).status, 400);
    assert.equal((await marketing.put('/api/admin/content/faq', { value: [{ q: 'Only a question' }] })).status, 400);
    assert.equal((await marketing.put('/api/admin/content/faq', { value: [{ q: 'Q1?', a: 'A1', extra: '<script>' }] })).status, 200);
    assert.deepEqual(JSON.parse((await app.client().get('/api/public/config')).body.content.faq), [{ q: 'Q1?', a: 'A1' }]);
    assert.equal((await marketing.put('/api/admin/content/Bad-Key', { value: 'x' })).status, 400);
    assert.equal((await marketing.put('/api/admin/content/hero_title', {})).status, 400, 'missing value');
    assert.equal((await marketing.put('/api/admin/content/hero_title', { value: 'x'.repeat(20001) })).status, 400);
  });

  it('settings are validated per key, and money settings need owner/admin/finance', async () => {
    const { owner, finance, marketing } = staff;
    assert.equal((await owner.put('/api/admin/settings/crypto', { value: { usdt_address: 'T123' } })).status, 400);
    assert.equal((await owner.put('/api/admin/settings/crypto', { value: { btc_address: 'notbitcoin' } })).status, 400);
    assert.equal((await owner.put('/api/admin/settings/referral', { value: { rate_1: 10, rate_2: 20, rate_3: 30, tier2_min: 5, tier3_min: 5, settle_days: 30, min_withdraw: 300, cookie_days: 60 } })).status, 400);
    assert.equal((await owner.put('/api/admin/settings/referral', { value: { rate_1: 10, rate_2: 20, rate_3: 99, tier2_min: 5, tier3_min: 20, settle_days: 30, min_withdraw: 300, cookie_days: 60 } })).status, 400);
    assert.equal((await owner.put('/api/admin/settings/trial', { value: { days: 7, plan: 'pro', ai_writes: 100 } })).status, 400, 'inactive plan');
    assert.equal((await owner.put('/api/admin/settings/nope', { value: {} })).status, 404);
    const okB = await finance.put('/api/admin/settings/billing', { value: { refund_days: 14, data_retention_days: 60, min_topup: 5, max_topup: 5000, renew_reminder_days: 3 } });
    assert.equal(okB.status, 200, okB.text);
    assert.equal((await app.client().get('/api/public/config')).body.billing.min_topup, 5);
    assert.equal((await finance.put('/api/admin/settings/company', { value: { name: 'X' } })).status, 403);
    assert.equal((await marketing.put('/api/admin/settings/billing', { value: {} })).status, 403);
    const okT = await owner.put('/api/admin/settings/trial', { value: { days: 14, plan: 'scale', ai_writes: 50 } });
    assert.equal(okT.status, 200);
    assert.deepEqual((await app.client().get('/api/public/config')).body.trial, { days: 14, plan: 'scale', ai_writes: 50 });
    const nu = await app.loginByEmail('after-trial-change@example.com');
    const ws = await app.ws(nu);
    assert.equal(ws.plan_code, 'scale');
    assert.ok((new Date(ws.trial_ends_at) - Date.now()) / 86400000 > 13.9);
    await owner.put('/api/admin/settings/trial', { value: { days: 7, plan: 'growth', ai_writes: 100 } });
    const legal = await owner.put('/api/admin/settings/legal_updated', { value: '1 November 2026' });
    assert.equal(legal.status, 200);
    assert.match((await app.client().get('/legal/terms')).text, /1 November 2026/);
  });

  it('features: switching AI off in admin refuses Cas at once; maintenance shows its message', async () => {
    const { owner } = staff;
    const cust = await app.loginByEmail('featureuser@example.com');
    assert.equal((await owner.post('/api/admin/features/ai', { enabled: false })).status, 200);
    try {
      assert.equal((await cust.post('/api/ai/write', { goal: 'Hello there' })).status, 403);
      assert.equal((await app.client().get('/api/public/config')).body.ai_available, false);
    } finally { await owner.post('/api/admin/features/ai', { enabled: true }); }
    assert.equal((await cust.post('/api/ai/write', { goal: 'Hello there' })).status, 200);
    await owner.post('/api/admin/features/maintenance', { enabled: true });
    try {
      const cfg = (await app.client().get('/api/public/config')).body;
      assert.equal(cfg.features.maintenance, true);
      const bot = await app.connectBot(cust);
      const r = await cust.post('/api/broadcasts', { connection_id: bot.connId, body: 'x' });
      assert.equal(r.status, 503);
      assert.equal(r.body.error, cfg.content.maintenance_message);
    } finally { await owner.post('/api/admin/features/maintenance', { enabled: false }); }
    const f = await owner.get('/api/admin/features');
    assert.ok(f.body.features.find((x) => x.key === 'maintenance').enabled === false);
  });

  it('email templates: override, preview, used for real emails, reset', async () => {
    const { marketing } = staff;
    const orig = await marketing.get('/api/admin/emails/welcome');
    assert.equal(orig.status, 200);
    assert.ok(orig.body.vars.includes('trial_end_date'));
    assert.equal((await marketing.put('/api/admin/emails/welcome', { subject: 'Hi', body: 'short' })).status, 400);
    const save = await marketing.put('/api/admin/emails/welcome', { subject: 'Custom hello {{first_name}}', preheader: 'pre', body: '<p>Welcome aboard, {{first_name}}. Trial ends {{trial_end_date}}.</p>', text: 'Welcome aboard {{first_name}}' });
    assert.equal(save.status, 200);
    const prev = await marketing.post('/api/admin/emails/welcome/preview', {});
    assert.equal(prev.body.subject, 'Custom hello Ejiro');
    assert.match(prev.body.html, /Trial ends 10 October 2026/);
    assert.ok(!/\{\{/.test(prev.body.html));
    const draft = await marketing.post('/api/admin/emails/welcome/preview', { subject: 'Draft {{first_name}}', body: '<p>Draft body text here</p>' });
    assert.equal(draft.body.subject, 'Draft Ejiro');
    await app.loginByEmail('templated@example.com', { name: 'Musa' });
    const mail = app.fakes.lastEmail('templated@example.com', /hello/);
    assert.equal(mail.subject, 'Custom hello Musa');
    assert.equal(mail.text, 'Welcome aboard Musa');
    const list = await marketing.get('/api/admin/emails');
    assert.equal(list.body.emails.find((e) => e.key === 'welcome').edited, true);
    const test = await marketing.post('/api/admin/emails/welcome/test');
    assert.equal(test.body.ok, true);
    assert.equal((await marketing.post('/api/admin/emails/welcome/reset')).status, 200);
    assert.equal((await marketing.get('/api/admin/emails/welcome')).body.current.subject, orig.body.original.subject);
  });

  it('Cas knowledge: create, edit, delete; Cas uses it', async () => {
    const { support } = staff;
    const c = await support.post('/api/admin/knowledge', { title: 'Refund window', body: 'Refunds within 14 days of a top-up.' });
    assert.equal(c.status, 200);
    const cust = await app.loginByEmail('kbuser@example.com');
    await cust.post('/api/ai/ask', { question: 'Refunds?' });
    assert.match(app.fakes.ai.calls[app.fakes.ai.calls.length - 1].system, /## Refund window\nRefunds within 14 days/);
    assert.equal((await support.put('/api/admin/knowledge/' + c.body.id, { title: 'Refund window', body: 'Updated text here', active: false })).status, 200);
    await cust.post('/api/ai/ask', { question: 'Refunds?' });
    assert.ok(!app.fakes.ai.calls[app.fakes.ai.calls.length - 1].system.includes('Updated text here'), 'inactive articles are left out');
    assert.equal((await support.del('/api/admin/knowledge/' + c.body.id)).status, 200);
    assert.equal((await support.get('/api/admin/knowledge')).body.articles.some((a) => a.id === c.body.id), false);
    const t = await support.post('/api/admin/ai/test', { question: 'What is Castvoo?' });
    assert.equal(t.status, 200);
  });

  it('users: search, details, plan change, wallet corrections', async () => {
    const { owner, finance } = staff;
    const cust = await app.loginByEmail('findme@example.com', { name: 'Findable Person' });
    const ws = await app.ws(cust);
    const s = await owner.get('/api/admin/users?q=findme');
    assert.equal(s.body.total, 1);
    assert.equal(s.body.users[0].workspace_id, ws.id);
    assert.equal((await owner.get('/api/admin/users?q=%25')).status, 200);
    const d = await owner.get('/api/admin/users/' + cust.user.id);
    assert.equal(d.body.user.email, 'findme@example.com');
    assert.equal(d.body.workspaces[0].id, ws.id);
    const extend = await owner.post(`/api/admin/workspaces/${ws.id}/plan`, { trial_ends_at: new Date(Date.now() + 20 * 86400000).toISOString(), reset_ai: true, note: 'goodwill' });
    assert.equal(extend.status, 200);
    assert.ok((new Date((await app.ws(cust)).trial_ends_at) - Date.now()) / 86400000 > 19.9);
    assert.equal((await owner.post(`/api/admin/workspaces/${ws.id}/plan`, { plan_status: 'active', period_end: '' })).status, 400);
    assert.equal((await owner.post(`/api/admin/workspaces/${ws.id}/plan`, { plan_code: 'nope' })).status, 400);
    assert.equal((await finance.post(`/api/admin/workspaces/${ws.id}/wallet`, { amount: 25, reason: 'Goodwill credit' })).status, 200);
    assert.equal((await finance.post(`/api/admin/workspaces/${ws.id}/wallet`, { amount: -30, reason: 'Too much' })).status, 400, 'would go negative');
    assert.equal((await finance.post(`/api/admin/workspaces/${ws.id}/wallet`, { amount: -5, reason: 'Refund', refund: true })).status, 200);
    assert.equal((await finance.post(`/api/admin/workspaces/${ws.id}/wallet`, { amount: 5, kind: 'bonus', reason: 'Promo' })).status, 200);
    const w = await app.ws(cust);
    assert.deepEqual([Number(w.wallet_cents), Number(w.bonus_cents)], [2000, 500]);
    const tx = await app.db.many('select kind from wallet_tx where workspace_id = $1 order by id', [ws.id]);
    assert.deepEqual(tx.map((x) => x.kind), ['adjustment', 'refund', 'adjustment']);
  });

  it('overview and system health', async () => {
    const o = await staff.viewer.get('/api/admin/overview');
    assert.equal(o.status, 200, o.text);
    assert.equal(o.body.series.signups.length, 30);
    assert.ok(o.body.users.total > 5);
    const s = await staff.admin.get('/api/admin/system');
    assert.equal(s.status, 200, s.text);
    assert.equal(s.body.platform_bot.url, 'https://example/tg');
    assert.deepEqual(s.body.problems, []);
  });

  it('integration test buttons talk to the (fake) services', async () => {
    for (const name of ['telegram', 'email', 'ai', 'paystack', 'flutterwave', 'gatevoo']) {
      const r = await staff.owner.post(`/api/admin/integrations/${name}/test`);
      assert.equal(r.status, 200, name + ' ' + r.text);
      assert.equal(r.body.ok, true, name + ': ' + r.body.detail);
    }
    assert.ok(app.fakes.tgCalls('setWebhook', app.platformBotToken).some((c) => c.params.url === app.url + '/tg/platform'));
    assert.equal((await staff.owner.post('/api/admin/integrations/nope/test')).status, 404);
  });

  it('audit log records admin changes with who did them', async () => {
    const a = await staff.owner.get('/api/admin/audit');
    const actions = a.body.entries.map((e) => e.action);
    for (const act of ['plan.create', 'plan.update', 'offer.create', 'country.save', 'content.save', 'settings.billing', 'feature.off', 'email.save', 'email.reset', 'knowledge.create', 'wallet.adjust', 'wallet.refund', 'workspace.plan', 'team.add', 'team.role', 'integration.test']) {
      assert.ok(actions.includes(act), 'audit has ' + act);
    }
    const e = a.body.entries.find((x) => x.action === 'wallet.adjust');
    assert.equal(e.actor_email, 'finance@castvoo.test');
    const q = await staff.owner.get('/api/admin/audit?q=wallet');
    assert.ok(q.body.entries.every((x) => /wallet/.test(x.action + x.target) || /wallet/.test(x.actor_email || '')));
  });
});

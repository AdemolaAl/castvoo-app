'use strict';
/*
 * Fixes from the engineering review (ENG-n), the product audit (AUD-n), the security review (SEC-2/3/11) and QA-4:
 * the join-request runtime (meter counter, repeats, the Free rules at send time, removed channels, invite links),
 * money (one commission per payment, self-referral holds, approve/reject races, chargebacks), plans (downgrades,
 * features), sales emails, data retention, the support reply-time promise, file streaming and migrations.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { startApp } = require('../helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { if (app) await app.stop(); });
beforeEach(() => { app.rl._reset(); app.fakes.tg.chatMember = null; app.fakes.tg.joinError = null; });

let chatSeq = -1006600000;
let userSeq = 990000;
let mailSeq = 0;
const nextUser = () => ++userSeq;
const mail = (p) => `${p}${++mailSeq}@example.com`;

async function setup(prefix, plan = 'trial', extra = {}) {
  const c = await app.loginByEmail(mail(prefix), extra);
  const bot = await app.connectBot(c);
  const ws = await app.ws(c);
  const chat = --chatSeq;
  const chanId = (await app.db.one("insert into connections(workspace_id, kind, tg_chat_id, title) values ($1,'channel',$2,'Core Channel') returning id", [ws.id, chat])).id;
  if (plan !== 'trial') await setPlan(ws.id, plan);
  return { c, bot, ws, chat, chanId };
}
async function setPlan(wsId, code) {
  await app.db.query("update workspaces set plan_code = $2, plan_status = 'active', trial_ends_at = null, period_end = case when $2 = 'free' then null else now() + interval '20 days' end where id = $1", [wsId, code]);
  app.settings.bust();
}
const msg = (body, extra = {}) => ({ type: 'message', body, ...extra });
const flowBody = (s, extra = {}) => ({ name: 'Flow', chat_id: s.chanId, bot_id: s.bot.connId, approve_mode: 'after_welcome', blocks: [msg('Hi {name}!')], ...extra });
async function live(s, body) {
  const r = await s.c.post('/api/flows', { ...body, active: true });
  assert.equal(r.status, 200, r.text);
  return r.body.id;
}
function joinRequest(s, userId, extra = {}) {
  return app.telegramUpdate(s.bot.connId, { chat_join_request: { chat: { id: s.chat, type: 'channel', title: 'Core Channel' }, from: { id: userId, first_name: 'Ada', is_bot: false }, user_chat_id: userId, date: Math.floor(Date.now() / 1000), ...extra } });
}
const sendsTo = (token, chat) => app.fakes.tgCalls(null, token).filter((x) => /^send/.test(x.method) && x.params.chat_id === chat);
const textsTo = (token, chat) => sendsTo(token, chat).map((x) => x.params.text || x.params.caption);
const jrOf = (userId) => app.db.one('select * from join_requests where tg_user_id = $1 order by id desc limit 1', [userId]);
const W = (id) => app.db.one('select * from workspaces where id = $1', [id]);

describe('join requests: meter, repeats and the runtime', () => {
  it('ENG-2 / ENG-26: the meter is one counter row, and parallel requests past the hard cap are not all welcomed', async () => {
    const s = await setup('meter', 'free');
    await app.db.query("insert into plans(code, name, price_month_cents, price_year_cents, connections, subscribers, ai_writes, seats, join_requests, flows, flow_steps, branding, features, active) values ('tiny2','Tiny',0,0,1,0,0,1,10,1,1,true,'[\"auto_approve\",\"welcome_message\"]',false) on conflict do nothing");
    await app.db.query("update workspaces set plan_code = 'tiny2' where id = $1", [s.ws.id]);
    app.settings.bust();
    await live(s, flowBody(s, { blocks: [msg('Hello')] }));
    const users = Array.from({ length: 20 }, nextUser);
    await Promise.all(users.map((u) => joinRequest(s, u)));
    const welcomed = users.filter((u) => textsTo(s.bot.token, u).length === 1).length;
    assert.equal(welcomed, 11, '10 included + 10% grace, decided by the atomic counter');
    const row = await app.db.one('select used from join_meter where workspace_id = $1', [s.ws.id]);
    assert.equal(row.used, 20);
    const m = (await s.c.get('/api/flows')).body.meter;
    assert.deepEqual([m.used, m.no_welcome, m.paused], [20, 9, true]);
    const plan = await app.db.many("explain select id from join_requests where chat_id = 1 and tg_user_id = 2 and status <> 'pending' and requested_at > now() - interval '1 day'");
    assert.match(JSON.stringify(plan), /join_requests_recent|Index|Bitmap/, 'the dedupe query can use an index');
  });

  it('ENG-3 / AUD-19: a redelivery is ignored, but a new request after a stale open one or a decline is handled', async () => {
    const s = await setup('repeat');
    await live(s, flowBody(s, { approve_mode: 'manual' }));
    const u = nextUser();
    await joinRequest(s, u, { date: 1700000000 });
    await joinRequest(s, u, { date: 1700000000 });
    assert.equal(textsTo(s.bot.token, u).length, 1, 'same Telegram date = the same request');
    // The person cancelled and asked again two minutes later: the open row is refreshed and they are welcomed again.
    await app.db.query("update join_requests set requested_at = now() - interval '2 minutes' where tg_user_id = $1", [u]);
    await joinRequest(s, u, { date: 1700000200 });
    assert.equal(textsTo(s.bot.token, u).length, 2);
    assert.equal((await app.db.one('select count(*)::int n from join_requests where tg_user_id = $1', [u])).n, 1);
    assert.equal(Number((await jrOf(u)).tg_date), 1700000200);
    // Declined, then asks again (a new date): handled again.
    const u2 = nextUser();
    await joinRequest(s, u2, { date: 1700001000 });
    await app.db.query("update join_requests set status = 'declined', decided_at = now(), requested_at = now() - interval '1 minute' where tg_user_id = $1", [u2]);
    await joinRequest(s, u2, { date: 1700001100 });
    assert.equal(textsTo(s.bot.token, u2).length, 2);
  });

  it('ENG-4 / AUD-14 / ENG-20: a flow saved on a paid plan keeps working on Free: 3 buttons, no video, text cut to fit the Castvoo line, no link preview', async () => {
    const s = await setup('freert', 'growth');
    const video = (await app.db.one("insert into media(workspace_id, kind, filename, mime, size_bytes, path) values ($1,'video','v.mp4','video/mp4',100,'/nonexistent/v.mp4') returning id", [s.ws.id])).id;
    const buttons = Array.from({ length: 6 }, (_, i) => ({ label: 'B' + i, url: 'https://example.com/' + i }));
    const long = 'x'.repeat(1000);
    await live(s, flowBody(s, { blocks: [msg(long, { media_id: video, buttons })] }));
    await setPlan(s.ws.id, 'free');
    const u = nextUser();
    await joinRequest(s, u);
    const sent = sendsTo(s.bot.token, u);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, 'sendMessage', 'the video is left out on Free');
    assert.equal(sent[0].params.reply_markup.inline_keyboard.flat().length, 3);
    assert.match(sent[0].params.text, /Free welcome bot by Castvoo\.com/);
    assert.deepEqual(sent[0].params.link_preview_options, { is_disabled: true });
    assert.equal((await jrOf(u)).status, 'approved');

    // Text near Telegram's limit: cut so the Castvoo line still fits.
    const s2 = await setup('freert2', 'growth');
    await live(s2, flowBody(s2, { blocks: [msg('y'.repeat(4090))] }));
    await setPlan(s2.ws.id, 'free');
    const u2 = nextUser();
    await joinRequest(s2, u2);
    const t = textsTo(s2.bot.token, u2)[0];
    assert.ok(t, 'welcome sent');
    assert.ok([...t.replace(/<[^>]+>/g, '')].length <= 4096);
    assert.match(t, /…\n\n⚡ /);
  });

  it('ENG-4: a welcome Telegram refuses for its content still lets the person in (after the welcome)', async () => {
    const s = await setup('contenterr', 'starter');
    await live(s, flowBody(s));
    const u = nextUser();
    // A message Castvoo itself refuses to send (template placeholder) counts as a content problem.
    await app.db.query("update sequence_steps set body = 'Hi (Write your welcome here.)' where sequence_id = (select id from sequences where workspace_id = $1 limit 1)", [s.ws.id]);
    await joinRequest(s, u);
    assert.equal(textsTo(s.bot.token, u).length, 0, 'QA-4: placeholder text is never sent');
    const jr = await jrOf(u);
    assert.deepEqual([jr.welcome, jr.status], ['failed', 'approved']);
  });

  it('ENG-6: removing a channel switches its flows off; the next workspace that connects it can go live and sees no other tenant\'s flow', async () => {
    const a = await setup('rmA');
    await live(a, flowBody(a, { name: 'Secret flow A' }));
    assert.equal((await a.c.del(`/api/connections/${a.chanId}`)).status, 200);
    assert.equal((await app.db.one("select count(*)::int n from sequences where workspace_id = $1 and active", [a.ws.id])).n, 0);
    const b = await setup('rmB');
    const chanB = (await app.db.one("insert into connections(workspace_id, kind, tg_chat_id, title) values ($1,'channel',$2,'Core Channel') returning id", [b.ws.id, a.chat])).id;
    const r = await b.c.post('/api/flows', { ...flowBody(b, { name: 'B flow' }), chat_id: chanB, active: true });
    assert.equal(r.status, 200, r.text);
    assert.doesNotMatch(r.text, /Secret flow A/);
  });

  it('ENG-6: a live flow left on a removed chat cannot block or leak to another workspace (index per workspace)', async () => {
    const a = await setup('stA');
    const flowA = await live(a, flowBody(a, { name: 'Stale A' }));
    await app.db.query("update connections set status = 'removed' where id = $1", [a.chanId]); // removed the old way
    assert.equal((await app.db.one('select active from sequences where id = $1', [flowA])).active, true);
    const b = await setup('stB');
    const chanB = (await app.db.one("insert into connections(workspace_id, kind, tg_chat_id, title) values ($1,'channel',$2,'Core Channel') returning id", [b.ws.id, a.chat])).id;
    const r = await b.c.post('/api/flows', { ...flowBody(b), chat_id: chanB, active: true });
    assert.equal(r.status, 200, r.text);
    assert.doesNotMatch(r.text, /Stale A/);
  });

  it('ENG-9: a trial that used 600 join requests this month drops to Free and the next request is still welcomed', async () => {
    const s = await setup('trialmeter');
    await live(s, flowBody(s, { blocks: [msg('Welcome')] }));
    await app.db.query(`insert into join_requests(workspace_id, connection_id, chat_id, tg_user_id, status, welcome, requested_at)
      select $1, $2, $3, g, 'approved', 'sent', now() - interval '1 hour' from generate_series(1, 600) g`, [s.ws.id, s.bot.connId, s.chat]);
    await app.db.query("update workspaces set trial_ends_at = now() - interval '1 minute' where id = $1", [s.ws.id]);
    await app.jobs.billingTick();
    const w = await W(s.ws.id);
    assert.deepEqual([w.plan_code, w.plan_status], ['free', 'active']);
    const u = nextUser();
    await joinRequest(s, u);
    assert.match(textsTo(s.bot.token, u)[0], /^Welcome/);
    const m = (await s.c.get('/api/flows')).body.meter;
    assert.equal(m.used, 1, 'the Free meter starts at the drop');
  });

  it('ENG-21: meter emails are keyed by the meter period, not the calendar month', async () => {
    const s = await setup('alerts', 'free');
    await app.db.query("insert into plans(code, name, price_month_cents, price_year_cents, connections, subscribers, ai_writes, seats, join_requests, flows, flow_steps, branding, features, active) values ('tiny3','Tiny',0,0,1,0,0,1,5,1,1,true,'[\"auto_approve\",\"welcome_message\"]',false) on conflict do nothing");
    await app.db.query("update workspaces set plan_code = 'tiny3' where id = $1", [s.ws.id]);
    app.settings.bust();
    await live(s, flowBody(s));
    for (let i = 0; i < 5; i++) await joinRequest(s, nextUser());
    const w = await W(s.ws.id);
    const since = (await s.c.get('/api/flows')).body.meter.since;
    assert.equal(w.join_alert, `${new Date(since).toISOString().slice(0, 10)}:100`);
  });

  it('ENG-27: an invite link made by a human admin (Telegram hides its end) still picks its flow', async () => {
    const s = await setup('invite');
    await live(s, flowBody(s, { name: 'Default', blocks: [msg('Default welcome')] }));
    await live(s, flowBody(s, { name: 'Ad', blocks: [msg('Ad welcome')], invite_link: 'https://t.me/+HumanMadeLink123456' }));
    const u = nextUser();
    await joinRequest(s, u, { invite_link: { invite_link: 'https://t.me/+HumanMad...', creates_join_request: true } });
    assert.equal(textsTo(s.bot.token, u)[0], 'Ad welcome');
  });

  it('QA-4: a template with placeholder text can be saved but not switched on', async () => {
    const s = await setup('placeholder');
    const r = await s.c.post('/api/flows', { template: 'followup', chat_id: s.chanId, bot_id: s.bot.connId });
    assert.equal(r.status, 200, r.text);
    const on = await s.c.post(`/api/flows/${r.body.id}/toggle`, { active: true });
    assert.equal(on.status, 400);
    assert.equal(on.body.code, 'placeholder_text');
    assert.match(on.body.error || on.text, /Write one useful tip/);
    const direct = await s.c.post('/api/flows', { ...flowBody(s, { blocks: [msg('Hi (Tell them about your offer here, with one clear button.)')] }), active: true });
    assert.equal(direct.body.code, 'placeholder_text');
  });

  it('QA-4: a follow-up step with placeholder text is skipped by the runtime', async () => {
    const s = await setup('phdrip', 'starter');
    const r = await s.c.post('/api/drips', { connection_id: s.bot.connId, name: 'D', trigger_type: 'start', steps: [{ body: 'Real first' }, { body: '(Write one useful tip for your audience here.)', delay_value: 1, delay_unit: 'min' }] });
    assert.equal(r.status, 200, r.text);
    const u = nextUser();
    await app.start(s.bot.connId, u);
    for (let i = 0; i < 2; i++) { await app.db.query('update sequence_runs set due_at = now() - interval \'1 minute\' where sequence_id = $1', [r.body.id]); await app.jobs.dripsTick(); await app.drain(); }
    const texts = textsTo(s.bot.token, u);
    assert.ok(texts.includes('Real first'));
    assert.ok(!texts.some((t) => /Write one useful tip/.test(t)));
  });
});

describe('ENG-5: the old /api/drips path follows the Welcome Flow rules', () => {
  it('Free: a second live flow, 4 buttons or follow-up steps are refused; a flow with A/B versions is edited in Welcome Flows only', async () => {
    const s = await setup('olddrips', 'free');
    const base = { connection_id: s.bot.connId, name: 'Join', trigger_type: 'join_request', join_connection_id: s.chanId };
    const four = await s.c.post('/api/drips', { ...base, steps: [{ body: 'Hi', buttons: [1, 2, 3, 4].map((i) => ({ label: 'b' + i, url: 'https://e.com/' + i })) }] });
    assert.equal(four.status, 402, four.text);
    const two = await s.c.post('/api/drips', { ...base, steps: [{ body: 'Hi' }, { body: 'Later', delay_value: 1, delay_unit: 'day' }] });
    assert.equal(two.body.code, 'limit_flow_steps');
    assert.equal((await s.c.post('/api/drips', { ...base, steps: [{ body: 'Hi' }] })).status, 200);
    const again = await s.c.post('/api/drips', { ...base, steps: [{ body: 'Hi again' }] });
    assert.equal(again.body.code, 'limit_flows');

    const g = await setup('olddrips2');
    const id = await live(g, flowBody(g, { blocks: [msg('A', { variants: [{ body: 'B' }] })] }));
    const put = await g.c.put('/api/drips/' + id, { name: 'Join', trigger_type: 'join_request', join_connection_id: g.chanId, steps: [{ body: 'Changed' }] });
    assert.equal(put.status, 409);
    assert.equal(put.body.code, 'edit_in_flows');
    assert.equal((await app.db.one('select count(*)::int n from sequence_steps where sequence_id = $1 and variant > 0', [id])).n, 1, 'A/B version kept');
  });
});

describe('money', () => {
  async function customer(prefix, extra = {}) {
    const c = await app.loginByEmail(mail(prefix), extra);
    return { c, ws: await app.ws(c), id: (await app.ws(c)).id };
  }
  async function manualPayment(ws, userId, ref, cents = 5000) {
    await app.db.query("insert into payments(workspace_id, user_id, provider, method_key, reference, amount_cents, coin, txid) values ($1,$2,'manual_crypto','usdt',$3,$4,'USDT',$5)", [ws.id, userId, ref, cents, 'tx' + ref]);
  }

  it('SEC-3 / ENG-17: Approve and Reject at the same moment are one decision; a rejected payment is never credited', async () => {
    const fin1 = await app.staff('finance');
    const fin2 = await app.staff('finance');
    for (let i = 0; i < 4; i++) {
      const u = await customer('race');
      const ref = 'race-' + u.id + '-' + i;
      await manualPayment(u.ws, u.c.user.id, ref);
      const [a, r] = await Promise.all([fin1.post(`/api/admin/payments/${ref}/approve`, {}), fin2.post(`/api/admin/payments/${ref}/reject`, { reason: 'Not received' })]);
      const p = await app.db.one('select status from payments where reference = $1', [ref]);
      const w = await W(u.id);
      if (p.status === 'paid') { assert.equal(a.status, 200); assert.notEqual(r.status, 200); assert.equal(Number(w.wallet_cents), 5000); } else { assert.equal(p.status, 'rejected'); assert.notEqual(a.status, 200); assert.equal(Number(w.wallet_cents), 0); }
    }
    const u = await customer('race2');
    const ref = 'race2-' + u.id;
    await manualPayment(u.ws, u.c.user.id, ref);
    await app.db.query("update payments set status = 'rejected' where reference = $1", [ref]);
    const res = await app.require('payments').credit(ref);
    assert.equal(res.refused, 'rejected');
    assert.equal(Number((await W(u.id)).wallet_cents), 0);
  });

  it('SEC-11: nobody on the team approves, rejects or charges back a payment for a workspace they belong to', async () => {
    const fin = await app.staff('finance');
    const own = await app.ws(fin);
    await manualPayment(own, fin.user.id, 'self-' + own.id);
    const a = await fin.post(`/api/admin/payments/self-${own.id}/approve`, {});
    assert.equal(a.status, 403);
    assert.equal(a.body.code, 'own_payment');
    assert.equal((await fin.post(`/api/admin/payments/self-${own.id}/reject`, { reason: 'mine' })).status, 403);
    // A teammate's workspace counts too.
    const cust = await customer('teamws');
    await app.db.query("insert into members(workspace_id, user_id, role) values ($1,$2,'sender')", [cust.id, fin.user.id]);
    await manualPayment(cust.ws, cust.c.user.id, 'team-' + cust.id);
    assert.equal((await fin.post(`/api/admin/payments/team-${cust.id}/approve`, {})).status, 403);
    const other = await app.staff('finance');
    assert.equal((await other.post(`/api/admin/payments/team-${cust.id}/approve`, {})).status, 200);
  });

  it('ENG-18: a rejected top-up\'s reference can be sent again', async () => {
    const u = await customer('proofref');
    await app.db.query("insert into payments(workspace_id, user_id, provider, method_key, reference, amount_cents, proof_ref, status) values ($1,$2,'manual','bank_x',$3,5000,'BANKREF1','rejected')", [u.id, u.c.user.id, 'pr1-' + u.id]);
    await app.db.query("insert into payments(workspace_id, user_id, provider, method_key, reference, amount_cents, proof_ref) values ($1,$2,'manual','bank_x',$3,5000,'BANKREF1')", [u.id, u.c.user.id, 'pr2-' + u.id]);
    await assert.rejects(app.db.query("insert into payments(workspace_id, user_id, provider, method_key, reference, amount_cents, proof_ref) values ($1,$2,'manual','bank_x',$3,5000,'bankref1')", [u.id, u.c.user.id, 'pr3-' + u.id]), /duplicate|unique/);
  });

  it('AUD-5: a chargeback takes the money out of the wallet; below zero a paid plan drops to Free; a won dispute puts it back', async () => {
    const owner = await app.owner();
    const u = await customer('cb');
    await app.db.query("insert into payments(workspace_id, user_id, provider, method_key, reference, amount_cents, bonus_cents) values ($1,$2,'paystack','paystack_ng',$3,10000,0)", [u.id, u.c.user.id, 'cb1-' + u.id]);
    await app.require('payments').credit('cb1-' + u.id);
    assert.equal((await u.c.post('/api/app/plan', { plan: 'growth', cycle: 'month', start_now: true })).status, 200);
    assert.equal(Number((await W(u.id)).wallet_cents), 5100);
    const r = await owner.post(`/api/admin/payments/cb1-${u.id}/chargeback`, { reason: 'Card dispute' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.body.debited, r.body.wallet, r.body.dropped_to_free], [100, -49, true]);
    const w = await W(u.id);
    assert.deepEqual([Number(w.wallet_cents), w.plan_code, w.dropped_from], [-4900, 'free', 'growth']);
    assert.ok(await app.db.one("select 1 from wallet_tx where workspace_id = $1 and kind = 'chargeback' and cash_cents = -10000", [u.id]));
    assert.ok(await app.db.one("select 1 from audit_log where action = 'payment.chargeback' and target = $1", ['payment:cb1-' + u.id]));
    // The plan cannot be paid while the wallet is below zero, even with bonus credit.
    await app.db.query('update workspaces set bonus_cents = 10000 where id = $1', [u.id]);
    const up = await u.c.post('/api/app/plan', { plan: 'starter', cycle: 'month' });
    assert.equal(up.status, 402);
    await app.db.query('update workspaces set bonus_cents = 0 where id = $1', [u.id]);
    const won = await owner.post(`/api/admin/payments/cb1-${u.id}/dispute-won`, {});
    assert.equal(won.status, 200, won.text);
    assert.equal(Number((await W(u.id)).wallet_cents), 5100);
    assert.equal((await owner.post(`/api/admin/payments/cb1-${u.id}/dispute-won`, {})).status, 400, 'once');
  });

  it('AUD-1: Castvoo referral first → it earns, VooSquare gets no spend; VooSquare affiliate first → no Castvoo earning, spend sent', async () => {
    const ref = await customer('refA');
    // Castvoo link first, VooSquare affiliate later.
    const u1 = await customer('both1', { ref: ref.c.user.ref_code });
    await app.db.query("update users set voo_id = $2, voo_ref = 'aff1', voo_linked_at = now() + interval '1 minute' where id = $1", [u1.c.user.id, 'vs_both1_' + u1.id]);
    await app.db.query('update workspaces set wallet_cents = 4900 where id = $1', [u1.id]);
    await app.db.query("update workspaces set trial_ends_at = now() - interval '1 minute', pending_plan_code = 'growth' where id = $1", [u1.id]);
    await app.jobs.billingTick();
    const tx1 = await app.db.one("select * from wallet_tx where workspace_id = $1 and kind = 'plan'", [u1.id]);
    assert.equal(tx1.commission_to, 'castvoo_referral');
    assert.ok(await app.db.one("select 1 from referral_ledger where user_id = $1 and from_workspace_id = $2 and kind = 'earning'", [ref.c.user.id, u1.id]));
    const ev1 = await app.db.many("select payload from outbox where kind = 'voosquare' and payload->>'voo_id' = $1", ['vs_both1_' + u1.id]);
    assert.deepEqual(ev1.map((e) => e.payload.type).sort(), ['plan_started'], 'no commissionable spend');

    // VooSquare affiliate first (linked before the Castvoo referral was recorded).
    const u2 = await customer('both2', { ref: ref.c.user.ref_code });
    await app.db.query("update users set voo_id = $2, voo_ref = 'aff2', voo_linked_at = now() - interval '1 day' where id = $1", [u2.c.user.id, 'vs_both2_' + u2.id]);
    await app.db.query("update workspaces set wallet_cents = 4900, trial_ends_at = now() - interval '1 minute', pending_plan_code = 'growth' where id = $1", [u2.id]);
    await app.jobs.billingTick();
    const tx2 = await app.db.one("select * from wallet_tx where workspace_id = $1 and kind = 'plan'", [u2.id]);
    assert.equal(tx2.commission_to, 'voosquare');
    assert.equal(await app.db.one("select 1 from referral_ledger where from_workspace_id = $1", [u2.id]), null);
    const ev2 = await app.db.many("select payload from outbox where kind = 'voosquare' and payload->>'voo_id' = $1", ['vs_both2_' + u2.id]);
    assert.deepEqual(ev2.map((e) => e.payload.type).sort(), ['plan_started', 'spend']);
  });

  it('AUD-1: commission is on cash minus the processor fee, capped at 50% (35% yearly), from admin settings', async () => {
    const ref = await customer('capref');
    const u = await customer('capu', { ref: ref.c.user.ref_code });
    await app.db.query("insert into payments(workspace_id, user_id, provider, method_key, reference, amount_cents) values ($1,$2,'paystack','paystack_ng',$3,4900)", [u.id, u.c.user.id, 'fee1-' + u.id]);
    await app.require('payments').credit('fee1-' + u.id, { feeCents: 900 });
    await app.setSetting('referral', { rates: [60, 60, 60], commission_cap_pct: 50 });
    try {
      assert.equal((await u.c.post('/api/app/plan', { plan: 'growth', cycle: 'month', start_now: true })).status, 200);
      const e = await app.db.one("select * from referral_ledger where from_workspace_id = $1 and kind = 'earning'", [u.id]);
      assert.deepEqual([Number(e.amount_cents), e.rate], [2000, 50], '50% of (4900 - 900)');
      const tx = await app.db.one("select * from wallet_tx where workspace_id = $1 and kind = 'plan'", [u.id]);
      assert.equal(Number(tx.commission_base_cents), 4000);

      const u2 = await customer('capy', { ref: ref.c.user.ref_code });
      await app.db.query('update workspaces set wallet_cents = 49000 where id = $1', [u2.id]);
      assert.equal((await u2.c.post('/api/app/plan', { plan: 'growth', cycle: 'year', start_now: true })).status, 200);
      const e2 = await app.db.one("select * from referral_ledger where from_workspace_id = $1 and kind = 'earning'", [u2.id]);
      assert.equal(e2.rate, 35, 'yearly cap');
    } finally { await app.setSetting('referral', { rates: [10, 20, 30] }); }
    // The admin cannot set a rate above the cap.
    const owner = await app.owner();
    const bad = await owner.put('/api/admin/settings/referral', { value: { rate_1: 55, rate_2: 20, rate_3: 30, tier2_min: 5, tier3_min: 20, settle_days: 30, min_withdraw: 300, cookie_days: 60 } });
    assert.equal(bad.status, 400);
    const ok = await owner.put('/api/admin/settings/referral', { value: { rate_1: 10, rate_2: 20, rate_3: 30, tier2_min: 5, tier3_min: 20, settle_days: 30, min_withdraw: 300, cookie_days: 60, yearly_cap_pct: 30 } });
    assert.equal(ok.status, 200, ok.text);
    const saved = await app.settings.get('referral');
    assert.deepEqual([saved.commission_cap_pct, saved.yearly_cap_pct, saved.first_attribution, saved.net_of_fees], [50, 30, true, true]);
    await app.setSetting('referral', { yearly_cap_pct: 35 });
  });

  it('SEC-2: a referred account signed up from the referrer\'s IP is held for review, not paid; Finance releases or cancels it', async () => {
    const ip = '10.250.1.' + (mailSeq % 200);
    const refC = await app.loginByEmail(mail('selfref'), {}, app.client({ ip }));
    const u = await app.loginByEmail(mail('selfref2'), { ref: refC.user.ref_code }, app.client({ ip }));
    const ws = await app.ws(u);
    await app.db.query("update workspaces set wallet_cents = 4900, trial_ends_at = now() - interval '1 minute', pending_plan_code = 'growth' where id = $1", [ws.id]);
    await app.jobs.billingTick();
    const e = await app.db.one("select * from referral_ledger where from_workspace_id = $1 and kind = 'earning'", [ws.id]);
    assert.deepEqual([e.held, e.hold_reason], [true, 'same IP address as the referrer at sign-up']);
    let b = (await refC.get('/api/referrals')).body.balance;
    assert.deepEqual([b.pending, b.earned], [0, 0]);
    assert.ok(!app.fakes.lastEmail(refC.user.email, /You earned/), 'no "you earned" email for a held earning');
    const fin = await app.staff('finance');
    const held = (await fin.get('/api/admin/referrals/held')).body.held;
    assert.ok(held.some((x) => x.id === e.id));
    assert.equal((await fin.post(`/api/admin/referrals/held/${e.id}`, { action: 'release' })).status, 200);
    b = (await refC.get('/api/referrals')).body.balance;
    assert.equal(b.earned, 4.9);

    // Same mailbox (a Gmail alias) is caught too.
    assert.equal(app.require('services/billing').mailbox('Jo.Hn+cv@googlemail.com'), 'john@gmail.com');
  });
});

describe('plans', () => {
  it('AUD-8: a downgrade at renewal switches off the extra live flows, keeping the ones the owner picked', async () => {
    const s = await setup('down', 'growth');
    const chats = [s.chanId];
    for (let i = 0; i < 4; i++) chats.push((await app.db.one("insert into connections(workspace_id, kind, tg_chat_id, title) values ($1,'group',$2,'G') returning id", [s.ws.id, --chatSeq])).id);
    const ids = [];
    for (const ch of chats) ids.push(await live(s, { ...flowBody(s, { name: 'F' + ch }), chat_id: ch }));
    await app.db.query("update workspaces set wallet_cents = 1900, paid_ever = true, billing_cycle = 'month' where id = $1", [s.ws.id]);
    const pick = [ids[4], ids[3], ids[0]];
    assert.equal((await s.c.post('/api/app/plan', { plan: 'starter', cycle: 'month', keep_flows: pick })).status, 200);
    await app.db.query("update workspaces set period_end = now() - interval '1 minute' where id = $1", [s.ws.id]);
    await app.jobs.billingTick();
    const w = await W(s.ws.id);
    assert.equal(w.plan_code, 'starter');
    const rows = await app.db.many('select id, active, paused_by_plan from sequences where workspace_id = $1 order by id', [s.ws.id]);
    assert.deepEqual(rows.filter((r) => r.active).map((r) => String(r.id)).sort(), pick.map(String).sort());
    assert.deepEqual(rows.filter((r) => !r.active).map((r) => r.paused_by_plan), [true, true]);
  });

  it('AUD-3: no plan sells tag branching or CSV export as a Scale feature; the AI plan text agrees', async () => {
    const plans = await app.db.many('select code, features from plans');
    for (const p of plans) assert.ok(!p.features.includes('tag_branching') && !p.features.includes('csv_export'), p.code);
    const text = await app.require('services/ai').plansText();
    assert.doesNotMatch(text, /tag branching|CSV export/i);
  });
});

describe('emails and data', () => {
  it('AUD-4: a trial that ended on Free gets the win-back on day 8 and day 14, with words true on Free', async () => {
    const c = await app.loginByEmail(mail('winback'));
    const ws = await app.ws(c);
    await app.db.query("update workspaces set trial_ends_at = now() - interval '1 minute' where id = $1", [ws.id]);
    await app.jobs.billingTick();
    await app.db.query("update users set created_at = now() - interval '8 days 1 hour' where id = $1", [c.user.id]);
    await app.jobs.salesTick();
    let wb = app.fakes.emailsTo(c.user.email).filter((e) => /off your first month/.test(e.subject));
    assert.equal(wb.length, 1);
    assert.match(wb[0].text, /Free plan/);
    assert.match(wb[0].text, /stays saved while your workspace is on the Free plan/);
    assert.doesNotMatch(wb[0].text, /nobody gets your welcome|deleted for good/);
    await app.jobs.salesTick();
    assert.equal(app.fakes.emailsTo(c.user.email).filter((e) => /off your first month/.test(e.subject)).length, 1, 'not again on day 8');
    await app.db.query("update users set created_at = now() - interval '14 days 1 hour' where id = $1", [c.user.id]);
    await app.db.query("update email_log set created_at = now() - interval '6 days' where user_id = $1 and template = 'sales_winback'", [c.user.id]);
    await app.jobs.salesTick();
    wb = app.fakes.emailsTo(c.user.email).filter((e) => /off your first month/.test(e.subject));
    assert.equal(wb.length, 2, 'day 14');
  });

  it('AUD-6: a Free workspace in use keeps its data; one unused for the inactive period is warned twice, then cleared (payments stay)', async () => {
    const used = await setup('keepdata', 'free');
    const idle = await setup('idledata', 'free');
    await app.db.query("insert into payments(workspace_id, user_id, provider, method_key, reference, amount_cents, status) values ($1,$2,'paystack','paystack_ng',$3,1000,'failed')", [idle.ws.id, idle.c.user.id, 'idle-' + idle.ws.id]);
    // Rows the SEC-8 purge list covers (links, clicks, replies, the support AI tool log).
    const code = 'idle' + idle.ws.id;
    await app.db.query("insert into links(code, workspace_id, url) values ($1,$2,'https://example.com')", [code, idle.ws.id]);
    await app.db.query('insert into clicks(code, workspace_id) values ($1,$2)', [code, idle.ws.id]);
    await app.db.query('insert into replies(workspace_id, connection_id) values ($1,$2)', [idle.ws.id, idle.chanId]);
    await app.db.query("update workspaces set created_at = now() - interval '400 days' where id = any($1::bigint[])", [[used.ws.id, idle.ws.id]]);
    await app.db.query("update users set last_login_at = now() - interval '400 days', last_seen_at = now() - interval '400 days', created_at = now() - interval '400 days' where id = $1", [idle.c.user.id]);
    await app.db.query("update users set created_at = now() - interval '400 days' where id = $1", [used.c.user.id]);
    const warnings = (u) => app.fakes.emailsTo(u.email).filter((e) => /will be cleared on/.test(e.subject));

    // Overdue, but never warned: first warning, nothing deleted, delete date 30 days out.
    await app.jobs.billingTick();
    assert.equal((await W(idle.ws.id)).purged_at, null, 'never deleted without a warning first');
    let w = warnings(idle.c.user);
    assert.equal(w.length, 1);
    assert.match(w[0].text, /in 30 days/);
    assert.match(w[0].text, /Keep my account: .*#login/);
    assert.match(w[0].html, /Keep my account/);
    assert.equal(warnings(used.c.user).length, 0, 'in use: no warning');
    await app.jobs.billingTick();
    assert.equal(warnings(idle.c.user).length, 1, 'not twice');

    // 24 days later: the last warning (7 days before), still nothing deleted.
    await app.db.query("update workspaces set inactive_warn1_at = inactive_warn1_at - interval '24 days' where id = $1", [idle.ws.id]);
    await app.jobs.billingTick();
    w = warnings(idle.c.user);
    assert.equal(w.length, 2);
    assert.match(w[1].text, /in 7 days/);
    assert.equal((await W(idle.ws.id)).purged_at, null);
    await app.jobs.billingTick();
    assert.equal((await W(idle.ws.id)).purged_at, null, 'not before the delete date');

    // The delete date has passed: cleared, with the SEC-8 rows.
    await app.db.query("update workspaces set inactive_warn1_at = inactive_warn1_at - interval '8 days', inactive_warn2_at = inactive_warn2_at - interval '8 days' where id = $1", [idle.ws.id]);
    await app.jobs.billingTick();
    assert.ok((await W(idle.ws.id)).purged_at);
    assert.equal((await app.db.one("select count(*)::int n from connections where workspace_id = $1 and status <> 'removed'", [idle.ws.id])).n, 0);
    for (const t of ['links', 'clicks', 'replies']) assert.equal((await app.db.one(`select count(*)::int n from ${t} where workspace_id = $1`, [idle.ws.id])).n, 0, t);
    assert.ok(await app.db.one('select 1 from payments where workspace_id = $1', [idle.ws.id]), 'payment records stay');
    assert.ok(await app.db.one('select 1 from members where workspace_id = $1', [idle.ws.id]), 'the owner keeps the (empty) workspace');
    assert.equal((await W(used.ws.id)).purged_at, null, 'logged in recently: kept');
  });

  it('AUD-6: coming back after a warning keeps the data (a dashboard visit counts, not only a new login)', async () => {
    const s = await setup('comeback', 'free');
    await app.db.query("update workspaces set created_at = now() - interval '400 days' where id = $1", [s.ws.id]);
    await app.db.query("update users set last_login_at = now() - interval '400 days', last_seen_at = now() - interval '400 days', created_at = now() - interval '400 days' where id = $1", [s.c.user.id]);
    await app.jobs.billingTick();
    assert.ok((await W(s.ws.id)).inactive_warn1_at, 'warned');
    // The owner still has a (sliding) session and opens the dashboard: that is use.
    assert.equal((await s.c.get('/api/me')).status, 200);
    const u = await app.db.one('select last_seen_at from users where id = $1', [s.c.user.id]);
    assert.ok(Date.now() - new Date(u.last_seen_at).getTime() < 60000, 'visit recorded');
    await app.db.query("update workspaces set inactive_warn1_at = inactive_warn1_at - interval '40 days' where id = $1", [s.ws.id]);
    await app.jobs.billingTick();
    assert.equal((await W(s.ws.id)).purged_at, null);
    assert.equal(app.fakes.emailsTo(s.c.user.email).filter((e) => /will be cleared on/.test(e.subject)).length, 1, 'no last warning after coming back');
  });

  it('AUD-6: an owner with no email address is never cleared (we could not warn them)', async () => {
    const s = await setup('noemail', 'free');
    await app.db.query("update workspaces set created_at = now() - interval '400 days' where id = $1", [s.ws.id]);
    await app.db.query("update users set email = null, last_login_at = now() - interval '400 days', last_seen_at = now() - interval '400 days', created_at = now() - interval '400 days' where id = $1", [s.c.user.id]);
    await app.jobs.billingTick();
    await app.jobs.billingTick();
    const w = await W(s.ws.id);
    assert.equal(w.purged_at, null);
    assert.equal(w.inactive_warn1_at, null);
  });
});

describe('support reply times (AUD-10)', () => {
  it('plan-based and aware of the team\'s hours', () => {
    const h = app.require('services/support-hours');
    const cfg = { handoff_eta: { free: 'within 24 hours', paid: 'within one business day (8am to 10pm WAT)', priority: 'within 4 business hours (8am to 10pm WAT)' } };
    const noonWAT = new Date('2026-10-08T11:00:00Z');
    const threeAmWAT = new Date('2026-10-08T02:00:00Z');
    assert.equal(h.etaText(cfg, { tier: 'priority' }, noonWAT), 'within 4 business hours (8am to 10pm WAT)');
    assert.equal(h.etaText(cfg, { tier: 'priority' }, threeAmWAT), 'within 4 business hours (8am to 10pm WAT), counted from 8am WAT when the team is back');
    assert.equal(h.etaText(cfg, { tier: 'free' }, threeAmWAT), 'within 24 hours');
    const seed = app.require('seed').SETTINGS.support_ai.handoff_eta;
    assert.doesNotMatch(JSON.stringify(seed), /about an hour/);
  });
});

describe('files and startup', () => {
  it('ENG-1: aborted Range requests for a video do not leave files open', async () => {
    const vids = fs.readdirSync(path.join(__dirname, '..', '..', 'public', 'videos')).filter((f) => f.endsWith('.mp4'));
    assert.ok(vids.length, 'a video to fetch');
    const url = new URL(app.url + '/videos/' + vids[0]);
    const count = () => fs.readdirSync('/proc/self/fd').length;
    const abortOne = () => new Promise((resolve) => {
      const req = http.get({ host: url.hostname, port: url.port, path: url.pathname, headers: { Range: 'bytes=0-' } }, (res) => { res.once('data', () => { req.destroy(); setTimeout(resolve, 20); }); });
      req.on('error', () => resolve());
    });
    await abortOne();
    await app.sleep(200);
    const before = count();
    for (let i = 0; i < 20; i++) await abortOne();
    await app.sleep(500);
    assert.ok(count() - before < 5, `open files grew by ${count() - before}`);
  });

  it('ENG-28: every migration is recorded on its own (013 included)', async () => {
    const names = (await app.db.many('select name from schema_migrations order by name')).map((r) => r.name);
    assert.ok(names.includes('013_core_fixes.sql'));
    assert.deepEqual(await app.db.migrate(), [], 'a second run does nothing');
  });

  it('ENG-19: the 013 step moves paused workspaces to Free and keeps only their first live flow', async () => {
    const s = await setup('paused19', 'growth');
    const a = await live(s, flowBody(s, { name: 'one' }));
    const g = (await app.db.one("insert into connections(workspace_id, kind, tg_chat_id, title) values ($1,'group',$2,'G') returning id", [s.ws.id, --chatSeq])).id;
    const b = await live(s, { ...flowBody(s, { name: 'two' }), chat_id: g });
    await app.db.query("update workspaces set plan_status = 'paused' where id = $1", [s.ws.id]);
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'migrations', '013_core_fixes.sql'), 'utf8');
    const block = sql.slice(sql.indexOf('-- ENG-19'));
    const { splitSql } = app.require('db');
    await app.db.tx(async (c) => { for (const st of splitSql(block)) await c.query(st); });
    const w = await W(s.ws.id);
    assert.deepEqual([w.plan_code, w.plan_status, w.dropped_from], ['free', 'active', 'growth']);
    const rows = await app.db.many('select id, active from sequences where workspace_id = $1 order by id', [s.ws.id]);
    assert.deepEqual(rows.map((r) => [r.id, r.active]), [[a, true], [b, false]]);
  });
});

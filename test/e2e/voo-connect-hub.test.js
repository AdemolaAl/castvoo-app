'use strict';
/*
 * Castvoo ↔ the REAL VooSquare, end to end (docs/VOO_CONNECT.md, section 4, "Test it end to end"):
 *   VooSquare boots from its own repo (SQLite, its own temp folder) and Castvoo is registered in Admin → Products;
 *   the kit's check.js passes every line; affiliate link → Castvoo landing (ref + vclick kept) → Continue with Voo ID
 *   (prompt=signup) → Voo ID sign-up on VooSquare → back in Castvoo, logged in → attribution recorded in VooSquare →
 *   wallet top-up (wallet_topup, no commission) → plan from the wallet (spend + plan_started) → RevShare commission →
 *   refund (no clawback) → renewal (spend + plan_renewed) → chargeback (clawback of the commissions that money paid)
 *   → VooSquare's dashboard card from our summary URL → support message both ways → log out everywhere.
 * Outside services (Telegram, Paystack, email) stay fake; nothing real is called.
 *
 * Where VooSquare is: VOOSQUARE_DIR, else ../voosquare-app or ../../voosquare-app next to this repo, else the
 * copies at /tmp/claude-0/cv/hub-src (a fresh copy of the current hub) or /tmp/claude-0/snap2/app. Without it the test is skipped (and says so).
 * Ports: the first free ones in 4863–4869 (VOO_HUB_PORTS="a-b" to change).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { startApp, sleep } = require('../helpers/app');

const ROOT = path.join(__dirname, '..', '..');
const HUB = [process.env.VOOSQUARE_DIR, path.join(ROOT, '..', 'voosquare-app'), path.join(ROOT, '..', '..', 'voosquare-app'), '/tmp/claude-0/cv/hub-src', '/tmp/claude-0/snap2/app']
  .filter(Boolean).find((d) => fs.existsSync(path.join(d, 'server.js')) && fs.existsSync(path.join(d, 'sdk', 'voo-connect')));
const skip = HUB ? false : 'VooSquare repo not found (set VOOSQUARE_DIR to run the real-hub connection test)';

const portFree = (port) => new Promise((resolve) => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '0.0.0.0', () => s.close(() => resolve(true))); });
async function waitHttp(url, ms = 15000) { const t = Date.now(); while (Date.now() - t < ms) { try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* booting */ } await sleep(80); } return false; }

/** A browser: cookies kept per host name (ports ignored, as browsers do), Max-Age=0 honoured. */
class Browser {
  constructor() { this.c = []; this.ip = `10.88.${crypto.randomInt(250)}.${crypto.randomInt(250)}`; }
  setCookie(host, header) {
    const [kv, ...attrs] = header.split(';').map((s) => s.trim());
    const i = kv.indexOf('='); const name = kv.slice(0, i); const value = kv.slice(i + 1);
    const dead = value === '' || attrs.some((a) => /^max-age=0$/i.test(a));
    this.c = this.c.filter((x) => !(x.name === name && x.host === host));
    if (!dead) this.c.push({ name, value, host, raw: header });
  }
  cookie(name, host) { return this.c.find((x) => x.name === name && x.host === host); }
  clear(host) { this.c = this.c.filter((x) => x.host !== host); }
  req(method, url, { body, headers = {} } = {}) {
    const u = new URL(url);
    const h = { host: u.host, 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Castvoo-hub-test', 'x-forwarded-for': this.ip, ...headers };
    const ck = this.c.filter((x) => x.host === u.hostname).map((x) => `${x.name}=${x.value}`).join('; ');
    if (ck) h.cookie = ck;
    let payload;
    if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(payload); }
    return new Promise((resolve, reject) => {
      const r = http.request({ host: u.hostname === 'localhost' ? '127.0.0.1' : u.hostname, port: Number(u.port), method, path: u.pathname + u.search, headers: h }, (res) => {
        for (const c of [].concat(res.headers['set-cookie'] || [])) this.setCookie(u.hostname, c);
        let t = ''; res.on('data', (d) => { t += d; });
        res.on('end', () => { let data; try { data = JSON.parse(t); } catch { data = t; } resolve({ status: res.statusCode, data, location: res.headers.location || '', headers: res.headers }); });
      });
      r.on('error', reject); if (payload) r.write(payload); r.end();
    });
  }
  get(u, o) { return this.req('GET', u, o); }
  post(u, o) { return this.req('POST', u, o); }
}

describe('Castvoo ↔ real VooSquare (Voo Connect end to end)', { skip }, () => {
  let hub, hubLog = '', cv, sql, VS, CV, CB, cred, aff, prod, run;
  const q1 = (s, ...a) => sql.prepare(s).get(...a);
  const qa = (s, ...a) => sql.prepare(s).all(...a);
  const until = async (fn, ms = 8000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v || Date.now() - t > ms) return v; await sleep(60); } };
  const hubSignup = async (b, email, name, product) => {
    const s = await b.post(`${VS}/api/auth/start`, { body: { email, name, product }, headers: { 'x-vs': '1' } });
    assert.ok(s.data && s.data.dev_code, 'hub dev code: ' + JSON.stringify(s.data));
    const v = await b.post(`${VS}/api/auth/verify`, { body: { email, code: s.data.dev_code }, headers: { 'x-vs': '1' } });
    return v.data && v.data.user;
  };

  before(async () => {
    const [lo, hi] = String(process.env.VOO_HUB_PORTS || '4863-4869').split('-').map(Number);
    const free = [];
    for (let p = lo; p <= hi && free.length < 2; p++) if (await portFree(p)) free.push(p);
    assert.equal(free.length, 2, `two free ports in ${lo}-${hi}`);
    VS = `http://127.0.0.1:${free[0]}`; CV = `http://localhost:${free[1]}`; CB = `${CV}/auth/voosquare/callback`;
    run = fs.mkdtempSync(path.join(os.tmpdir(), 'castvoo-hub-'));
    const db = path.join(run, 'hub.db');
    hub = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
      cwd: HUB, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(free[0]), BASE_URL: VS, DATABASE_PATH: db, UPLOADS_DIR: path.join(run, 'uploads'), BACKUPS_DIR: path.join(run, 'backups'), VOICE_DIR: path.join(run, 'voice'),
        OWNER_EMAIL: 'owner@hub.test', NODE_ENV: 'test', EMAIL_PROVIDER: '', AFF_JOBS: 'off', AFFILIATE_URL: '', SCHOOL_EXTRA_DIR: '' },
    });
    hub.stdout.on('data', (d) => { hubLog += d; }); hub.stderr.on('data', (d) => { hubLog += d; });
    assert.ok(await waitHttp(`${VS}/healthz`), 'VooSquare boots: ' + hubLog.slice(-500));
    const { DatabaseSync } = require('node:sqlite');
    sql = new DatabaseSync(db); sql.exec('PRAGMA busy_timeout=5000');

    // The owner registers Castvoo in Admin → Products (URL, SSO, the two redirect URIs, summary URL, support webhook).
    const owner = new Browser(); await hubSignup(owner, 'owner@hub.test', 'Hub Owner');
    const existing = q1("SELECT id FROM products WHERE slug='castvoo'");
    const saved = await owner.post(`${VS}/api/admin/products`, { headers: { 'x-vs': '1' }, body: { id: existing ? existing.id : undefined, slug: 'castvoo', name: 'Castvoo', url: CV, sso: true, status: 'live', visible: 1,
      redirect_uris: [CB, `${CV}/`], summary_url: `${CV}/api/voosquare/summary`, support_webhook: `${CV}/hooks/voosquare/support` } });
    prod = saved.data && saved.data.product;
    assert.ok(prod && /^vsc_/.test(prod.client_id), 'product saved: ' + JSON.stringify(saved.data));
    cred = { clientId: prod.client_id, clientSecret: prod.client_secret, apiKey: prod.api_key };
    // An approved affiliate.
    const a = new Browser(); await hubSignup(a, 'ama@hub.test', 'Ama');
    const H = { 'x-vs': '1' };
    await a.post(`${VS}/api/aff/account`, { body: {}, headers: H });
    await a.req('PUT', `${VS}/api/aff/application/1`, { headers: H, body: { display_name: 'Ama', country: 'NG', telegram: '@ama_cv', kind: 'individual' } });
    await a.req('PUT', `${VS}/api/aff/application/2`, { headers: H, body: { sources: ['Meta ads'], geos: ['NG'], volume: '$10k–$50k', products: ['castvoo'] } });
    await a.req('PUT', `${VS}/api/aff/application/3`, { headers: H, body: { years: '3–5', plan: 'Meta ads to Castvoo for Nigerian media buyers, plus a Telegram channel with reviews.', links: ['https://t.me/x'] } });
    const acct = (await a.req('PUT', `${VS}/api/aff/application/4`, { headers: H, body: { accept_terms: true, no_income_claims: true, adult: true, usdt: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE' } })).data.account;
    await owner.post(`${VS}/api/admin/aff/applications/${acct.id}/approve`, { body: {}, headers: H });
    sql.prepare('UPDATE aff_affiliates SET activated_at=? WHERE id=?').run(Date.now() - 86400_000, acct.id);
    aff = q1('SELECT * FROM aff_affiliates WHERE id=?', acct.id);
    assert.equal(aff.status, 'approved');

    cv = await startApp({ port: free[1], host: 'localhost', env: { VOO_BASE: VS, VOO_CLIENT_ID: cred.clientId, VOO_CLIENT_SECRET: cred.clientSecret, VOO_API_KEY: cred.apiKey, VOO_SIGNAL_SECRET: 'hub-test-signal-secret', VOO_CONNECT: 'on' } });
  });

  after(async () => {
    if (cv) await cv.stop();
    if (hub) { hub.kill('SIGTERM'); await sleep(200); }
    try { if (sql) sql.close(); } catch { /* ignore */ }
    if (run) fs.rmSync(run, { recursive: true, force: true });
  });

  it('check.js (the kit\'s self-test against VooSquare): every line PASS', async () => {
    const out = await new Promise((resolve) => execFile(process.execPath, [path.join(ROOT, 'voo-connect', 'check.js'), '--base', VS, '--client-id', cred.clientId, '--client-secret', cred.clientSecret, '--api-key', cred.apiKey,
      '--redirect-uri', CB, '--logout-uri', `${CV}/`, '--summary-url', `${CV}/api/voosquare/summary`], { timeout: 30000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, text: String(stdout) + String(stderr) })));
    assert.equal(out.code, 0, out.text);
    assert.match(out.text, /0 failed/);
    assert.doesNotMatch(out.text, /FAIL/);
  });

  it('affiliate link → landing → Continue with Voo ID (sign-up) → logged in → money → commission → refund → chargeback → summary → support → logout', async () => {
    const buyer = new Browser();
    // 1. The affiliate's link lands on Castvoo with ref and vclick; Castvoo keeps them in its own cookie.
    const click = await buyer.get(`${VS}/a/${aff.code}?p=castvoo&sub1=fb_ng&click_id=CLK-CV1`);
    assert.equal(click.status, 302, JSON.stringify(click.data).slice(0, 300));
    const land = new URL(click.location);
    assert.equal(land.origin, CV);
    assert.equal(land.searchParams.get('ref'), aff.code);
    const vclick = land.searchParams.get('vclick');
    const page = await buyer.get(land.toString());
    assert.equal(page.status, 200);
    assert.ok(buyer.cookie('voo_attr', 'localhost'), 'voo_attr kept');
    buyer.clear('127.0.0.1'); // in-app browsers lose VooSquare's own click cookie: only the hand-off can attribute now

    // 2. Start free → VooSquare's sign-up view for Castvoo.
    const start = await buyer.get(`${CV}/auth/voosquare?signup=1&return_to=%2F%23app`);
    const az = new URL(start.location);
    assert.deepEqual([az.origin + az.pathname, az.searchParams.get('prompt'), az.searchParams.get('ref'), az.searchParams.get('vclick'), az.searchParams.get('redirect_uri')],
      [`${VS}/oauth/authorize`, 'signup', aff.code, vclick, CB]);
    const a1 = await buyer.get(az.toString());
    assert.ok(a1.location.startsWith('/login?product=castvoo&mode=signup&next='), a1.location);
    const member = await hubSignup(buyer, 'buyer@castvoo.test', 'Bola Buyer', 'castvoo');
    const a2 = await buyer.get(VS + new URLSearchParams(a1.location.split('?')[1]).get('next'));
    const back = new URL(a2.location);
    assert.equal(back.origin + back.pathname, CB);
    // 3. Back in Castvoo: a new account, logged in, sent to the first sign-up step.
    const cb = await buyer.get(back.toString());
    assert.equal(cb.status, 302, String(cb.data).slice(0, 300));
    assert.equal(cb.location, '/#signup/country');
    assert.ok(buyer.cookie('cv_session', 'localhost'));
    assert.ok(!buyer.cookie('voo_attr', 'localhost') && !buyer.cookie('voo_state', 'localhost'), 'hand-off and state cleared');
    const me = (await buyer.get(`${CV}/api/me`)).data.user;
    assert.equal(me.email, 'buyer@castvoo.test');
    assert.equal(me.voo_linked, true);
    const at = q1('SELECT t.*, f.code FROM aff_attributions t JOIN aff_affiliates f ON f.id=t.affiliate_id WHERE t.customer_user_id=(SELECT id FROM users WHERE voo_id=?)', member.voo_id);
    assert.ok(at && at.code === aff.code && at.sub1 === 'fb_ng', 'VooSquare attributed the sign-up to the affiliate: ' + JSON.stringify(at));

    // 4. Money (mock Paystack): top-up $120, Growth plan from the wallet.
    const X = { 'x-cv': '1' };
    await buyer.post(`${CV}/api/me`, { body: { country: 'NG' }, headers: X });
    const t = await buyer.post(`${CV}/api/wallet/topup`, { body: { amount: 120, method: 'paystack_ng' }, headers: X });
    assert.equal(t.status, 200, JSON.stringify(t.data));
    cv.fakes.paystack.txns.get(t.data.reference).status = 'success';
    assert.equal((await buyer.post(`${CV}/api/wallet/check`, { body: { reference: t.data.reference }, headers: X })).data.status, 'paid');
    const plan = await buyer.post(`${CV}/api/app/plan`, { body: { plan: 'growth', cycle: 'month', start_now: true }, headers: X });
    assert.equal(plan.status, 200, JSON.stringify(plan.data));
    await cv.voosquare.flush();
    const ws = await cv.db.one('select w.* from workspaces w join users u on u.id = w.owner_user_id where u.voo_id = $1', [member.voo_id]);
    const pay = await cv.db.one('select * from payments where reference = $1', [t.data.reference]);
    const tx1 = await cv.db.one("select id from wallet_tx where workspace_id = $1 and kind = 'plan' order by id desc limit 1", [ws.id]);
    const evRow = (ext) => q1('SELECT * FROM events WHERE product_id=? AND ext_id=?', prod.id, ext);
    await until(() => evRow(`cv_pay_${tx1.id}`));
    assert.equal(evRow(`cv_topup_${pay.id}`).type, 'wallet_topup');
    assert.deepEqual([evRow(`cv_pay_${tx1.id}`).type, evRow(`cv_pay_${tx1.id}`).value_usd, evRow(`cv_pay_${tx1.id}`).plan], ['spend', 49, 'Growth']);
    assert.equal(evRow(`cv_plan_${tx1.id}`).type, 'plan_started');
    const custId = q1('SELECT id FROM users WHERE voo_id=?', member.voo_id).id;
    const coms = () => qa('SELECT * FROM aff_commissions WHERE customer_user_id=? ORDER BY id', custId);
    const rs1 = await until(() => coms().find((c) => c.type === 'revshare'));
    assert.ok(rs1 && rs1.affiliate_id === aff.id && rs1.amount_cents > 0 && rs1.status === 'available', 'RevShare on the $49 spend: ' + JSON.stringify(coms()));
    assert.equal(coms().filter((c) => c.type === 'revshare').length, 1, 'the top-up earned nothing');
    assert.ok(q1("SELECT 1 FROM aff_plans WHERE product_key='castvoo' AND plan='Growth' AND price_cents=4900"), 'plan synced to the Offers page');

    // 5. Refund of unused wallet money: logged, commission stays.
    const owner = await cv.owner();
    const rf = await owner.post(`/api/admin/workspaces/${ws.id}/wallet`, { amount: -10, kind: 'cash', reason: 'Unused money back', refund: true });
    assert.equal(rf.status, 200, rf.text);
    await cv.voosquare.flush();
    const rtx = await cv.db.one("select id from wallet_tx where workspace_id = $1 and kind = 'refund' order by id desc limit 1", [ws.id]);
    await until(() => evRow(`cv_rf_${rtx.id}`));
    await sleep(200);
    assert.equal(evRow(`cv_rf_${rtx.id}`).type, 'refund');
    assert.ok(!coms().some((c) => c.type === 'clawback') && coms()[0].status === 'available', 'no clawback after a refund');

    // 6. Renewal (spend + plan_renewed), then the top-up is charged back: both plan payments used that money.
    await cv.db.query("update workspaces set period_end = now() - interval '1 minute' where id = $1", [ws.id]);
    await cv.jobs.billingTick();
    await cv.voosquare.flush();
    const tx2 = await cv.db.one("select id from wallet_tx where workspace_id = $1 and kind = 'plan' order by id desc limit 1", [ws.id]);
    await until(() => evRow(`cv_renew_${tx2.id}`));
    assert.equal(evRow(`cv_pay_${tx2.id}`).type, 'spend');
    await until(() => coms().filter((c) => c.type === 'revshare').length === 2);
    const body = JSON.stringify({ event: 'charge.dispute.create', data: { id: 9001, transaction: { reference: pay.reference } } });
    const hook = await fetch(`${CV}/pay/paystack`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-paystack-signature': crypto.createHmac('sha512', 'sk_test_paystack').update(body).digest('hex') } });
    assert.equal(hook.status, 200);
    await cv.voosquare.flush();
    await until(() => coms().filter((c) => c.type === 'clawback').length === 2);
    const claws = coms().filter((c) => c.type === 'clawback');
    const earned = coms().filter((c) => c.type === 'revshare').reduce((s, c) => s + c.amount_cents, 0);
    assert.equal(claws.length, 2, JSON.stringify(coms()));
    assert.equal(claws.reduce((s, c) => s + c.amount_cents, 0), -earned, 'every commission that money paid is reversed');
    assert.equal(evRow(`cv_cb_${pay.id}_${tx1.id}`).ref_event, `cv_pay_${tx1.id}`);
    const left = await cv.db.one("select count(*)::int n from outbox where sent_at is null or failed_at is not null");
    assert.equal(left.n, 0, 'nothing pending or refused');

    // 7. VooSquare's dashboard card comes from our summary URL.
    const home = await buyer.get(`${VS}/api/me/home`);
    const card = home.data && home.data.tools && home.data.tools.find((x) => x.slug === 'castvoo');
    assert.ok(card && card.summary && card.summary.metrics.some((m) => m.key === 'messages_sent'), JSON.stringify(card));
    assert.equal(card.launch_url, `${CV}/auth/voosquare?return_to=/dashboard`);

    // 8. Support both ways: a Castvoo help message lands in VooSquare's inbox; the staff reply comes back to Castvoo.
    const sup = await buyer.post(`${CV}/api/support`, { body: { body: 'My broadcast is stuck' }, headers: X });
    assert.equal(sup.status, 200, JSON.stringify(sup.data));
    await cv.voosquare.flush();
    const tk = await until(() => q1('SELECT * FROM tickets WHERE external_ref=?', 'castvoo-' + sup.data.thread_id));
    assert.ok(tk && tk.product_id === prod.id, 'ticket in the VooSquare inbox');
    const hubOwner = new Browser(); await hubSignup(hubOwner, 'owner@hub.test', 'Hub Owner');
    await hubOwner.post(`${VS}/api/admin/tickets/${tk.id}/reply`, { body: { body: 'Unstuck it for you.' }, headers: { 'x-vs': '1' } });
    const reply = await until(() => cv.db.one("select * from support_messages where thread_id = $1 and via = 'voosquare' and body = 'Unstuck it for you.'", [sup.data.thread_id]));
    assert.ok(reply, 'staff reply delivered to Castvoo');

    // 9. Log out everywhere: Castvoo, then VooSquare, then back on Castvoo's home page.
    const lo = await buyer.get(`${CV}/logout`);
    const lou = new URL(lo.location);
    assert.deepEqual([lou.origin + lou.pathname, lou.searchParams.get('redirect_uri')], [`${VS}/oauth/logout`, `${CV}/`]);
    const lo2 = await buyer.get(lo.location);
    assert.equal(lo2.location, `${CV}/`);
    assert.equal((await buyer.get(`${VS}/api/me`)).data.user, null);
    assert.equal((await buyer.get(`${CV}/api/me`)).data.user, null);
  });
});

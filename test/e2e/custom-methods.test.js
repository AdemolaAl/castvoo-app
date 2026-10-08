'use strict';
/*
 * The team's own payment methods (Admin → Countries & payments → Add payment method): bank transfer, mobile money...
 * Create, edit, delete, who may do it, which countries see it, the customer's exact amount and proof, and Finance
 * approving (wallet credited once, with bonuses) or rejecting it. Admin text is always shown escaped.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { startApp } = require('../helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { if (app) await app.stop(); });
beforeEach(() => app.rl._reset());

let n = 0;
async function payer(country) {
  const email = `cm${++n}@example.com`;
  const c = await app.loginByEmail(email, { country });
  return { c, email, ws: await app.ws(c) };
}
const W = (id) => app.db.one('select * from workspaces where id = $1', [id]);
const P = (ref) => app.db.one('select * from payments where reference = $1', [ref]);
const PNG = () => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(200, 7)]);
const shot = (c, ref, body, type = 'image/png') => c.post(`/api/wallet/manual/${ref}/screenshot`, body, { headers: { 'content-type': type } });

const BANK = {
  label: 'GTBank transfer', kind: 'bank', detail: 'Naira bank transfer', icon: '🏦', color: '#E05A00',
  instructions: 'Bank: GTBank\nAccount number: 0123456789\nAccount name: Zedapex Limited',
  proof_ref: 'required', proof_image: 'required', countries: ['NG'], sort: 10, active: true,
};

describe('custom payment methods: admin', () => {
  it('Finance adds a method; the key is made from the name; it is in the audit log', async () => {
    const fin = await app.staff('finance');
    const r = await fin.post('/api/admin/methods', BANK);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.key, 'gtbank_transfer');
    const again = await fin.post('/api/admin/methods', BANK);
    assert.equal(again.body.key, 'gtbank_transfer_2', 'same name gets a free key');
    const list = await fin.get('/api/admin/countries');
    const m = list.body.methods.find((x) => x.key === 'gtbank_transfer');
    assert.equal(m.provider, 'manual');
    assert.deepEqual(m.countries, ['NG']);
    assert.ok(list.body.method_kinds.some((k) => k.key === 'mobile_money'));
    assert.ok(await app.db.one("select 1 from audit_log where action = 'method.create' and target = 'method:gtbank_transfer'"));
    assert.equal((await fin.del('/api/admin/methods/gtbank_transfer_2')).status, 200);
  });

  it('checks what the admin typed', async () => {
    const owner = await app.owner();
    const bad = async (patch, why) => {
      const r = await owner.post('/api/admin/methods', { ...BANK, label: 'Check ' + why, ...patch });
      assert.equal(r.status, 400, why + ': ' + r.text);
      return r.body.error;
    };
    await bad({ instructions: '' }, 'no instructions');
    await bad({ instructions: 'x'.repeat(2001) }, 'instructions too long');
    await bad({ label: 'x' }, 'name too short');
    await bad({ label: 'x'.repeat(41) }, 'name too long');
    await bad({ color: 'red;background:url(//evil)' }, 'colour that is not #RRGGBB');
    await bad({ icon: 'ABCDE' }, 'long icon');
    await bad({ kind: 'cheque' }, 'unknown kind');
    await bad({ countries: [] }, 'no country');
    await bad({ countries: ['ZZ'] }, 'unknown country only');
    await bad({ currency: 'NAIRA' }, 'bad currency');
    await bad({ currency: 'NGN', usd_rate: -5 }, 'bad rate');
    await bad({ min: 100, max: 50 }, 'max below min');
    await bad({ proof_ref: 'sometimes' }, 'bad proof setting');
    await bad({ key: 'Has Spaces' }, 'bad key');
    await bad({ key: 'paystack_ng' }, 'key taken by a built-in method');
    await bad({ key: 'usdt' }, 'reserved key');
    assert.match(await bad({ countries: [] }, 'no country again'), /at least one country/);
  });

  it('low roles cannot add, edit or delete methods', async () => {
    const owner = await app.owner();
    const made = await owner.post('/api/admin/methods', { ...BANK, label: 'Role test bank' });
    assert.equal(made.status, 200, made.text);
    for (const role of ['support', 'marketing', 'viewer']) {
      const s = await app.staff(role);
      assert.equal((await s.post('/api/admin/methods', { ...BANK, label: 'Nope ' + role })).status, 403, role);
      assert.equal((await s.put('/api/admin/methods/' + made.body.key, { label: 'Hacked' })).status, 403, role);
      assert.equal((await s.del('/api/admin/methods/' + made.body.key)).status, 403, role);
    }
    const customer = (await payer('NG')).c;
    assert.equal((await customer.post('/api/admin/methods', BANK)).status, 403);
    assert.equal((await app.db.one('select label from payment_methods where key = $1', [made.body.key])).label, 'Role test bank');
  });

  it('built-in methods can be switched off but not deleted; a country lists only built-in methods', async () => {
    const owner = await app.owner();
    assert.equal((await owner.del('/api/admin/methods/paystack_ng')).status, 400);
    assert.ok(await app.db.one("select 1 from payment_methods where key = 'paystack_ng'"));
    const off = await owner.put('/api/admin/methods/flw_cm', { label: 'Flutterwave', detail: 'Card, MTN and Orange mobile money', active: false });
    assert.equal(off.status, 200, off.text);
    const cm = await payer('CM');
    assert.ok(!(await cm.c.get('/api/wallet')).body.methods.some((m) => m.key === 'flw_cm'));
    await owner.put('/api/admin/methods/flw_cm', { label: 'Flutterwave', detail: 'Card, MTN and Orange mobile money', active: true });
    const own = await owner.post('/api/admin/methods', { ...BANK, label: 'Ghana bank', countries: ['GH'] });
    const c = (await owner.get('/api/admin/countries')).body.countries.find((x) => x.code === 'GH');
    const put = await owner.put('/api/admin/countries/GH', { ...c, usd_rate: Number(c.usd_rate), methods: [...c.methods, own.body.key] });
    assert.equal(put.status, 200);
    assert.ok(!(await app.db.one("select methods from countries where code = 'GH'")).methods.includes(own.body.key), 'manual keys are not stored on the country');
  });
});

describe('custom payment methods: customers', () => {
  let key, mobile;
  before(async () => {
    const owner = await app.owner();
    key = (await owner.post('/api/admin/methods', { ...BANK, label: 'Lagos bank' })).body.key;
    mobile = (await owner.post('/api/admin/methods', { label: 'Mobile money everywhere', kind: 'mobile_money', instructions: 'Number: +254700000000\nName: Zedapex', proof_ref: 'required', proof_image: 'off', all_countries: true, min: 15, max: 300 })).body.key;
  });

  it('only people in an allowed country see it; "all countries" shows everywhere', async () => {
    const ng = await payer('NG');
    const keys = (await ng.c.get('/api/wallet')).body.methods.map((m) => m.key);
    assert.ok(keys.includes(key) && keys.includes(mobile), keys.join());
    const m = (await ng.c.get('/api/wallet')).body.methods.find((x) => x.key === key);
    assert.equal(m.manual, true);
    assert.equal(m.instructions, undefined, 'instructions are shown after starting, not in the list');
    const ke = await payer('KE');
    const ke2 = (await ke.c.get('/api/wallet')).body.methods.map((x) => x.key);
    assert.ok(!ke2.includes(key), 'not offered in Kenya');
    assert.ok(ke2.includes(mobile));
    assert.equal((await ke.c.post('/api/wallet/topup', { amount: 50, method: key })).status, 400, 'a Kenyan cannot use the Nigerian bank');
    assert.ok((await app.client().get('/api/public/methods?country=NG')).body.methods.some((x) => x.key === key));
  });

  it('min and max of the method apply', async () => {
    const { c } = await payer('KE');
    assert.equal((await c.post('/api/wallet/topup', { amount: 12, method: mobile })).status, 400);
    assert.equal((await c.post('/api/wallet/topup', { amount: 301, method: mobile })).status, 400);
    assert.equal((await c.post('/api/wallet/topup', { amount: 20, method: mobile })).status, 200);
  });

  it('pay, send the reference and a screenshot, Finance approves: credited once with the bonus', async () => {
    const { c, email, ws } = await payer('NG');
    const r = await c.post('/api/wallet/topup', { amount: 200, method: key });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.kind, 'manual');
    assert.equal(r.body.currency, 'USD');
    assert.ok(r.body.amount_due > 200 && r.body.amount_due < 201, 'unique cents: ' + r.body.amount_due);
    assert.equal(r.body.method.instructions, BANK.instructions);
    assert.equal(r.body.method.proof_image, 'required');
    const p0 = await P(r.body.reference);
    assert.equal(p0.provider, 'manual');
    assert.equal(Number(p0.amount_cents), Math.round(r.body.amount_due * 100));
    // Two open top-ups of the same amount never share it.
    const r2 = await c.post('/api/wallet/topup', { amount: 200, method: key });
    assert.notEqual(r2.body.amount_due, r.body.amount_due);
    // Back from the wallet page: the same details.
    const again = await c.get('/api/wallet/manual/' + r.body.reference);
    assert.equal(again.body.amount_due, r.body.amount_due);
    assert.ok((await c.get('/api/wallet')).body.pending.some((x) => x.reference === r.body.reference && x.method_label === 'Lagos bank' && !x.submitted));

    // Proof checks.
    assert.equal((await c.post(`/api/wallet/manual/${r.body.reference}/submit`, { proof_ref: 'FT123456' })).status, 400, 'screenshot is required');
    assert.equal((await shot(c, r.body.reference, Buffer.from('<?php echo 1; ?>'))).status, 400, 'not really a PNG');
    assert.equal((await shot(c, r.body.reference, Buffer.from('hello'), 'text/html')).status, 400);
    assert.equal((await shot(c, r.body.reference, Buffer.from('ftypmp4'), 'video/mp4')).status, 400, 'images only');
    assert.equal((await shot(c, r.body.reference, Buffer.concat([PNG(), Buffer.alloc(10 * 1024 * 1024)]))).status, 413);
    const other = await payer('NG');
    assert.equal((await shot(other.c, r.body.reference, PNG())).status, 404, 'not my payment');
    assert.equal((await other.c.get('/api/wallet/manual/' + r.body.reference)).status, 404);
    assert.equal((await shot(c, r.body.reference, PNG())).status, 200);
    const first = (await P(r.body.reference)).proof_path;
    assert.equal((await shot(c, r.body.reference, PNG())).status, 200, 'replace it');
    assert.ok(!fs.existsSync(first), 'the old screenshot is removed');
    assert.ok(fs.existsSync((await P(r.body.reference)).proof_path));
    assert.ok(path.resolve((await P(r.body.reference)).proof_path).startsWith(path.resolve(app.uploadDir, 'proofs')));
    assert.equal((await c.post(`/api/wallet/manual/${r.body.reference}/submit`, {})).status, 400, 'reference is required');
    // The customer can't choose what is credited.
    const sub = await c.post(`/api/wallet/manual/${r.body.reference}/submit`, { proof_ref: 'FT123456', amount: 5000, amount_cents: 500000 });
    assert.equal(sub.status, 200, sub.text);
    assert.ok(app.fakes.lastEmail(email, /We are checking your Lagos bank payment/));
    assert.equal((await c.post(`/api/wallet/manual/${r.body.reference}/submit`, { proof_ref: 'FT999' })).status, 400, 'only once');
    assert.equal((await shot(c, r.body.reference, PNG())).status, 400, 'no new screenshot after sending');
    // The same reference can't be used for another top-up with this method.
    await shot(c, r2.body.reference, PNG());
    assert.equal((await c.post(`/api/wallet/manual/${r2.body.reference}/submit`, { proof_ref: 'ft123456' })).status, 400);
    // "Check now" never credits a manual payment.
    await c.post('/api/wallet/check', { reference: r.body.reference });
    assert.equal(Number((await W(ws.id)).wallet_cents), 0);

    const fin = await app.staff('finance');
    const list = await fin.get('/api/admin/payments?check=1');
    const row = list.body.payments.find((x) => x.reference === r.body.reference);
    assert.ok(row, 'in the queue to check');
    assert.equal(row.proof_ref, 'FT123456');
    assert.equal(row.has_screenshot, true);
    assert.equal(row.method_label, 'Lagos bank');
    assert.equal(row.proof_path, undefined, 'the file path stays on the server');
    assert.ok(list.body.totals.to_check >= 1);
    assert.ok(!list.body.payments.some((x) => x.reference === r2.body.reference), 'not sent yet: not in the queue');
    assert.ok((await fin.get('/api/admin/payments?q=FT123456')).body.payments.some((x) => x.reference === r.body.reference), 'search by reference');
    const img = await fin.get(`/api/admin/payments/${r.body.reference}/screenshot`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await (await app.staff('support')).get(`/api/admin/payments/${r.body.reference}/screenshot`)).status, 403);
    assert.equal((await c.get(`/api/admin/payments/${r.body.reference}/screenshot`)).status, 403);
    assert.equal((await fin.get(`/api/admin/payments/${r2.body.reference}/screenshot`)).status, 200);
    assert.equal((await (await app.staff('support')).post(`/api/admin/payments/${r.body.reference}/approve`)).status, 403);
    assert.equal((await fin.post(`/api/admin/payments/${r2.body.reference}/approve`)).status, 400, 'customer has not said they paid');

    // Two people press Approve at once: credited once.
    const both = await Promise.all([fin.post(`/api/admin/payments/${r.body.reference}/approve`), fin.post(`/api/admin/payments/${r.body.reference}/approve`)]);
    assert.deepEqual(both.map((x) => x.status).sort(), [200, 400]);
    const w = await W(ws.id);
    assert.equal(Number(w.wallet_cents), Math.round(r.body.amount_due * 100), 'exact amount credited');
    assert.equal(Number(w.bonus_cents), 1000, '$200 top-up bonus');
    assert.equal((await P(r.body.reference)).status, 'paid');
    assert.equal((await fin.post(`/api/admin/payments/${r.body.reference}/approve`)).status, 400, 'already paid');
    assert.ok(app.fakes.lastEmail(email, /topped up with/));
    const tx = await app.db.one("select * from wallet_tx where ref = $1 and kind = 'topup'", [r.body.reference]);
    assert.equal(tx.method, 'Lagos bank');
    assert.ok(await app.db.one("select 1 from audit_log where action = 'payment.approve' and target = $1", ['payment:' + r.body.reference]));
  });

  it('Finance can credit a different amount, or reject with a reason the customer is emailed', async () => {
    const { c, email, ws } = await payer('KE');
    const a = await c.post('/api/wallet/topup', { amount: 40, method: mobile });
    assert.equal((await shot(c, a.body.reference, PNG())).status, 400, 'this method takes no screenshots');
    assert.equal((await c.post(`/api/wallet/manual/${a.body.reference}/submit`, { proof_ref: 'QWE123RTY' })).status, 200);
    const fin = await app.staff('finance');
    assert.equal((await fin.post(`/api/admin/payments/${a.body.reference}/approve`, { amount: 35 })).status, 200);
    assert.equal(Number((await W(ws.id)).wallet_cents), 3500);

    const b = await c.post('/api/wallet/topup', { amount: 40, method: mobile });
    await c.post(`/api/wallet/manual/${b.body.reference}/submit`, { proof_ref: 'NOTREAL1' });
    assert.equal((await fin.post(`/api/admin/payments/${b.body.reference}/reject`, { reason: 'x' })).status, 400, 'reason too short');
    const rej = await fin.post(`/api/admin/payments/${b.body.reference}/reject`, { reason: 'Nothing arrived on our number.' });
    assert.equal(rej.status, 200, rej.text);
    const mail = app.fakes.lastEmail(email, /could not confirm your Mobile money everywhere payment/);
    assert.ok(mail, 'rejection email');
    assert.match(mail.text, /Nothing arrived on our number/);
    assert.equal((await P(b.body.reference)).status, 'rejected');
    assert.equal(Number((await W(ws.id)).wallet_cents), 3500, 'wallet unchanged');
    assert.equal((await fin.post(`/api/admin/payments/${b.body.reference}/approve`)).status, 400, 'a rejected payment cannot be approved');
    assert.equal((await c.post(`/api/wallet/manual/${b.body.reference}/submit`, { proof_ref: 'AGAIN123' })).status, 400);
  });

  it('a local-currency method: the customer pays naira with unique kobo; the USD they asked for is credited', async () => {
    const owner = await app.owner();
    const k = (await owner.post('/api/admin/methods', { label: 'Opay', kind: 'mobile_money', currency: 'ngn', instructions: 'Opay number: 08000000000\nName: Zedapex', proof_ref: 'optional', proof_image: 'off', countries: ['NG', 'KE'] })).body.key;
    const { c, ws } = await payer('NG');
    const m = (await c.get('/api/wallet')).body.methods.find((x) => x.key === k);
    assert.equal(m.currency, 'NGN');
    assert.equal(m.usd_rate, 1550, 'the country rate');
    const r = await c.post('/api/wallet/topup', { amount: 50, method: k });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.currency, 'NGN');
    assert.ok(r.body.amount_due > 77500 && r.body.amount_due < 77501, String(r.body.amount_due));
    assert.equal(r.body.amount_usd, 50);
    const r2 = await c.post('/api/wallet/topup', { amount: 50, method: k });
    assert.notEqual(r2.body.amount_due, r.body.amount_due);
    assert.equal((await c.post(`/api/wallet/manual/${r.body.reference}/submit`, {})).status, 200, 'reference optional');
    assert.equal((await (await app.staff('finance')).post(`/api/admin/payments/${r.body.reference}/approve`)).status, 200);
    assert.equal(Number((await W(ws.id)).wallet_cents), 5000);
    // Kenya uses KES, and this method has no rate of its own: not offered there.
    const ke = await payer('KE');
    assert.ok(!(await ke.c.get('/api/wallet')).body.methods.some((x) => x.key === k));
    // With its own rate it is.
    assert.equal((await owner.put('/api/admin/methods/' + k, { usd_rate: 1500 })).status, 200);
    app.settings.bust();
    assert.equal((await ke.c.get('/api/wallet')).body.methods.find((x) => x.key === k).usd_rate, 1500);
  });

  it('edit, switch off and delete (hidden when payments use it)', async () => {
    const owner = await app.owner();
    const k = (await owner.post('/api/admin/methods', { ...BANK, label: 'Temp bank', proof_image: 'off' })).body.key;
    const ed = await owner.put('/api/admin/methods/' + k, { label: 'Temp bank 2', countries: ['GH'] });
    assert.equal(ed.status, 200, ed.text);
    const row = await app.db.one('select * from payment_methods where key = $1', [k]);
    assert.equal(row.label, 'Temp bank 2');
    assert.deepEqual(row.countries, ['GH']);
    assert.equal(row.instructions, BANK.instructions, 'fields left out keep their value');
    assert.equal((await owner.put('/api/admin/methods/' + k, { color: 'javascript:alert(1)' })).status, 400);
    const gh = await payer('GH');
    assert.ok((await gh.c.get('/api/wallet')).body.methods.some((x) => x.key === k));
    assert.equal((await owner.put('/api/admin/methods/' + k, { active: false })).status, 200);
    assert.ok(!(await gh.c.get('/api/wallet')).body.methods.some((x) => x.key === k), 'switched off');
    await owner.put('/api/admin/methods/' + k, { active: true });
    const p = await gh.c.post('/api/wallet/topup', { amount: 30, method: k });
    assert.equal(p.status, 200);
    assert.equal((await owner.del('/api/admin/methods/' + k)).status, 400, 'an open payment uses it');
    await (await app.staff('finance')).post(`/api/admin/payments/${p.body.reference}/reject`, { reason: 'Test payment, closing it.' });
    const d = await owner.del('/api/admin/methods/' + k);
    assert.equal(d.status, 200, d.text);
    assert.equal(d.body.hidden, true);
    const after = await app.db.one('select * from payment_methods where key = $1', [k]);
    assert.ok(after && after.deleted_at && !after.active, 'kept for history, hidden');
    assert.ok(!(await owner.get('/api/admin/countries')).body.methods.some((x) => x.key === k));
    assert.ok(!(await gh.c.get('/api/wallet')).body.methods.some((x) => x.key === k));
    assert.equal((await owner.put('/api/admin/methods/' + k, { label: 'Back' })).status, 404);
    // Never used: really deleted.
    const k2 = (await owner.post('/api/admin/methods', { ...BANK, label: 'Unused bank' })).body.key;
    assert.equal((await owner.del('/api/admin/methods/' + k2)).body.hidden, false);
    assert.equal(await app.db.one('select 1 from payment_methods where key = $1', [k2]), null);
    assert.ok(await app.db.one("select 1 from audit_log where action = 'method.save' and target = $1", ['method:' + k]));
    assert.ok(await app.db.one("select 1 from audit_log where action = 'method.delete' and target = $1", ['method:' + k2]));
  });
});

describe('custom payment methods: admin text is never run as HTML', () => {
  const EVIL = '<img src=x onerror=alert(1)>';
  it('stored as typed, escaped in emails', async () => {
    const owner = await app.owner();
    const k = (await owner.post('/api/admin/methods', { label: 'Bank <b>bold</b>', detail: EVIL, instructions: `Account: ${EVIL}\n<script>alert(2)</script>`, proof_ref: 'required', proof_image: 'off', all_countries: true })).body.key;
    const { c, email } = await payer('GH');
    const r = await c.post('/api/wallet/topup', { amount: 20, method: k });
    assert.equal(r.body.method.instructions, `Account: ${EVIL}\n<script>alert(2)</script>`, 'the API returns plain text; the page escapes it');
    await c.post(`/api/wallet/manual/${r.body.reference}/submit`, { proof_ref: '<svg onload=alert(3)>' });
    const mail = app.fakes.lastEmail(email, /We are checking your/);
    assert.ok(mail);
    assert.ok(!mail.html.includes('<b>bold</b>') && mail.html.includes('&lt;b&gt;bold&lt;/b&gt;'), 'label escaped in the email');
    assert.ok(!mail.html.includes('<svg onload') && mail.html.includes('&lt;svg onload=alert(3)&gt;'), 'reference escaped in the email');
  });

  it('the customer page escapes every instruction line', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../public/js/app-money.js'), 'utf8');
    const core = fs.readFileSync(path.join(__dirname, '../../public/js/core.js'), 'utf8');
    const fn = /function instructionsHtml\(text\) \{[\s\S]*?\n\}/.exec(src)[0];
    const esc = /const esc = [^\n]+/.exec(core)[0];
    const sandbox = { icon: () => '<svg></svg>' };
    vm.runInNewContext(`${esc}\n${fn}\nthis.out = instructionsHtml(${JSON.stringify(`Account: ${EVIL}\n<script>alert(2)</script>\nName: "a" onmouseover="x`)});`, sandbox);
    const out = sandbox.out;
    assert.ok(!/<img|<script|onmouseover="x/.test(out), out);
    assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(out, /&lt;script&gt;/);
    assert.match(out, /data-copy="&lt;img/);
  });

  it('the admin page escapes everything put into its templates', () => {
    const core = fs.readFileSync(path.join(__dirname, '../../public/admin/js/core.js'), 'utf8');
    const sandbox = { window: {}, document: {} };
    vm.runInNewContext(core, sandbox);
    const { html } = sandbox.window.CV;
    const m = { label: 'Bank <b>x</b>', icon: EVIL, instructions: '<script>alert(1)</script>' };
    const out = String(html`<b>${m.label}</b><span>${m.icon}</span><p>${m.instructions}</p><i title="${'" onclick="x'}"></i>`);
    assert.ok(!/<script|<img|onclick="x/.test(out), out);
    const store = fs.readFileSync(path.join(__dirname, '../../public/admin/js/store.js'), 'utf8');
    assert.match(store, /const safeColor = /, 'colours are checked before going into style=""');
    assert.ok(!/innerHTML\s*=/.test(store), 'store.js never sets innerHTML directly');
  });
});

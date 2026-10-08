#!/usr/bin/env node
'use strict';

// Renders every Castvoo email template with sample values into
// scripts/out/emails/<key>.html (+ <key>.txt) and an index.html.
// Exits with code 1 if any {{variable}} is left after replacement,
// or if a template uses a variable that is not listed or global.
// Node.js built-ins only.

const fs = require('node:fs');
const path = require('node:path');
const { layout } = require('../server/emails/layout');
const templates = require('../server/emails/templates');

const GLOBALS = {
  first_name: 'Ejiro',
  app_url: 'https://castvoo.com/#app',
  site_url: 'https://castvoo.com',
  support_email: 'support@castvoo.com',
  company_name: 'Zedapex',
  company_address: 'Lagos, Nigeria',
  unsubscribe_url: 'https://castvoo.com/unsubscribe?t=sample-token',
  data_retention_days: '60',
  billing_email: 'billing@castvoo.com',
  privacy_email: 'privacy@castvoo.com',
};

const SAMPLE = {
  old_price: '$49.00', new_price: '$59.00', billing_period: 'month', start_date: '2 November 2026',
  used: '412', limit: '500', reset_date: '1 November 2026', plans_url: 'https://castvoo.com/#app/wallet', welcomed: '238',
  code: '482913',
  trial_end_date: '10 October 2026',
  guide_url: 'https://castvoo.com/guide',
  inviter_name: 'Tolu Adeyemi',
  workspace_name: 'Kicks by Tolu',
  invite_url: 'https://castvoo.com/#app/invite/sample',
  role_name: 'Support agent',
  admin_url: 'https://castvoo.com/#admin',
  plan_name: 'Growth',
  plan_price: '$49.00',
  wallet_balance: '$12.00',
  topup_url: 'https://castvoo.com/#app/wallet/topup',
  amount: '$49.00',
  period_start: '10 October 2026',
  period_end: '10 November 2026',
  receipt_id: 'CV-2026-000184',
  billing_url: 'https://castvoo.com/#app/billing',
  renewal_date: '10 November 2026',
  bonus: '$0.00',
  method: 'Paystack (card)',
  new_balance: '$61.00',
  wallet_url: 'https://castvoo.com/#app/wallet',
  coin: 'USDT (TRC20)',
  reference: 'FT2610081234567',
  txid: '9f2c4b7a1e0d8c3b6a5f4e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b',
  reason: 'We could not find a transaction with this ID sent to the Castvoo address.',
  referral_name: 'Amaka',
  settle_date: '9 November 2026',
  referrals_url: 'https://castvoo.com/#app/referrals',
  address: 'TQ7xY3mRbN8vK2pL5sW9dF4gH6jC1aE0zU',
  agent_name: 'Chidi',
  message_preview: 'Thanks for waiting. Your bot is connected again. Could you try sending the broadcast once more and tell me if it works?',
  support_url: 'https://castvoo.com/#app/support',
  broadcast_title: 'Friday sneaker drop',
  delivered: '4,812',
  failed: '37',
  clicks: '612',
  report_url: 'https://castvoo.com/#app/broadcasts/sample',
  limit_name: 'subscriber',
  upgrade_url: 'https://castvoo.com/#app/billing/plans',
  download_url: 'https://castvoo.com/#app/export/sample',
  connect_url: 'https://castvoo.com/#app/connect',
  broadcast_url: 'https://castvoo.com/#app/broadcasts/new',
  drips_url: 'https://castvoo.com/#app/followups',
  train_url: 'https://castvoo.com/#app/cas/train',
  pricing_url: 'https://castvoo.com/#pricing',
  coupon_code: 'COMEBACK20',
  coupon_percent: '20',
  coupon_expiry: '31 October 2026',
  reply_url: 'https://castvoo.com/feedback',
};

const FIELDS = ['category', 'name', 'when', 'subject', 'preheader', 'body', 'text', 'vars'];
const VAR_RE = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

function render(str, values) {
  return str.replace(VAR_RE, (m, k) => (Object.prototype.hasOwnProperty.call(values, k) ? String(values[k]) : m));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const outDir = path.join(__dirname, 'out', 'emails');
fs.mkdirSync(outDir, { recursive: true });

const errors = [];
const rows = [];

for (const [key, t] of Object.entries(templates)) {
  for (const f of FIELDS) if (!(f in t)) errors.push(`${key}: missing field "${f}"`);
  if (!['transactional', 'marketing'].includes(t.category)) errors.push(`${key}: bad category`);

  const used = new Set();
  for (const f of ['subject', 'preheader', 'body', 'text']) {
    for (const m of String(t[f] || '').matchAll(VAR_RE)) used.add(m[1]);
  }
  for (const v of used) {
    if (!(v in GLOBALS) && !t.vars.includes(v)) errors.push(`${key}: uses {{${v}}} but it is not in vars`);
  }
  for (const v of t.vars) {
    if (!used.has(v)) errors.push(`${key}: lists "${v}" in vars but never uses it`);
    if (v in GLOBALS) errors.push(`${key}: lists global "${v}" in vars`);
    if (!(v in SAMPLE)) errors.push(`${key}: no sample value for "${v}"`);
  }

  const values = { ...GLOBALS, ...SAMPLE };
  const subject = render(t.subject, values);
  const preheader = render(t.preheader, values);
  const html = render(layout({ subject: t.subject, preheader: t.preheader, body: t.body, category: t.category, vars: t.vars }), values);
  const text = render(t.text, values);

  for (const [label, s] of [['html', html], ['text', text], ['subject', subject], ['preheader', preheader]]) {
    if (s.includes('{{') || s.includes('}}')) errors.push(`${key}: unreplaced placeholder in ${label}`);
  }
  if (t.category === 'marketing' && !html.includes(GLOBALS.unsubscribe_url)) errors.push(`${key}: marketing email without unsubscribe link`);
  if (t.category === 'transactional' && html.includes(GLOBALS.unsubscribe_url)) errors.push(`${key}: transactional email has an unsubscribe link`);

  fs.writeFileSync(path.join(outDir, `${key}.html`), html);
  fs.writeFileSync(path.join(outDir, `${key}.txt`), `Subject: ${subject}\n\n${text}\n`);
  rows.push({ key, t, subject });
}

const index = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Castvoo email previews</title>
<style>body{font-family:Arial,Helvetica,sans-serif;background:#F3F6FC;color:#0B1430;margin:0;padding:24px 16px}
main{max-width:860px;margin:0 auto}h1{font-size:22px}h2{font-size:15px;margin:28px 0 8px;color:#6B7690;text-transform:uppercase;letter-spacing:.06em}
a.row{display:block;background:#fff;border:1px solid #E3E8F2;border-radius:12px;padding:12px 16px;margin:8px 0;text-decoration:none;color:#0B1430}
a.row:hover{border-color:#2F6BFF}.k{font-family:monospace;font-size:12px;color:#2F6BFF}.s{font-size:14px;margin-top:4px}.w{font-size:12px;color:#6B7690;margin-top:4px}</style></head>
<body><main><h1>Castvoo email previews (${rows.length})</h1>
${['transactional', 'marketing'].map((cat) => `<h2>${cat}</h2>` + rows.filter((r) => r.t.category === cat).map((r) =>
  `<a class="row" href="${r.key}.html"><div class="k">${r.key} · ${escapeHtml(r.t.name)}</div><div class="s">${escapeHtml(r.subject)}</div><div class="w">${escapeHtml(r.t.when)}</div></a>`).join('\n')).join('\n')}
</main></body></html>`;
fs.writeFileSync(path.join(outDir, 'index.html'), index);

if (errors.length) {
  console.error(`FAILED with ${errors.length} problem(s):\n` + errors.map((e) => '  - ' + e).join('\n'));
  process.exit(1);
}
console.log(`OK: rendered ${rows.length} emails to ${path.relative(process.cwd(), outDir) || outDir}`);

'use strict';
/*
 * Sending emails.
 *   await email.send('welcome', user, { trial_end_date: '10 October 2026', guide_url: '...' });
 *
 * Templates live in server/emails/templates.js. The team can override the
 * subject and text of any template in Admin → Emails (saved in email_templates).
 * Marketing emails are skipped for people who unsubscribed.
 * With no RESEND_API_KEY, emails are written to the log instead of sent (handy locally).
 */

const db = require('../db');
const config = require('../config');
const log = require('../lib/log');
const settings = require('./settings');
const { fill, sign, escHtml } = require('../lib/util');
const TEMPLATES = require('../emails/templates');
const { layout } = require('../emails/layout');

const outbox = []; // last emails, kept in memory for tests and the admin "preview"

async function getTemplate(key) {
  const base = TEMPLATES[key];
  if (!base) throw new Error('Unknown email template: ' + key);
  const o = await db.one('select subject, preheader, body, text_body from email_templates where key = $1', [key]);
  if (!o) return base;
  return { ...base, subject: o.subject, preheader: o.preheader, body: o.body, text: o.text_body || base.text };
}

function unsubscribeUrl(userId) {
  return `${config.appUrl}/email/unsubscribe?u=${userId}&s=${sign('unsub:' + userId)}`;
}

/** Build the final subject/html/text for a template. Used by send() and by the admin preview. */
async function render(key, vars, tplOverride) {
  const t = tplOverride || (await getTemplate(key));
  const globals = await settings.publicVars();
  const all = { ...globals, first_name: 'there', ...vars };
  const subject = fill(t.subject, all);
  // In the HTML version every value is escaped: names and workspace names are typed by users, and some
  // emails (team invites) go to other people, so "<a href=evil>Verify</a>" as a name must stay text.
  // Braces are escaped too, so a value like "{{code}}" can't pull in another variable.
  const safe = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, escHtml(v).replace(/\{/g, '&#123;').replace(/\}/g, '&#125;')]));
  const html = fill(layout({ subject: fill(t.subject, safe), preheader: t.preheader, body: t.body, category: t.category }), safe);
  const text = fill(t.text, all);
  return { subject, html, text, category: t.category };
}

async function deliver({ to, subject, html, text }) {
  if (config.email.provider !== 'resend' || !config.email.resendKey) {
    log.info('email (not sent: no RESEND_API_KEY)', config.isProd ? { to, subject } : { to, subject, text: String(text).slice(0, 600) });
    return { id: 'log-' + Date.now() };
  }
  const r = await fetch(config.email.resendBase + '/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + config.email.resendKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.email.from, to: [to], reply_to: config.email.replyTo, subject, html, text }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Resend ${r.status}: ${body.message || JSON.stringify(body)}`);
  return body;
}

/**
 * Send a template to a user (object with id, email, name, marketing_opt_out) or a plain { email, name }.
 * Never throws: email problems are logged so they can't break the action that triggered them.
 * Returns true if sent.
 */
async function send(key, user, vars = {}, { once = false } = {}) {
  try {
    if (!user || !user.email) return false;
    const t = await getTemplate(key);
    if (t.category === 'marketing') {
      if (user.marketing_opt_out) { await logEmail(user, key, 'skipped', null, 'unsubscribed'); return false; }
      if (!(await settings.feature('sales_emails'))) return false;
    }
    if (once && user.id && (await db.one("select 1 from email_log where user_id = $1 and template = $2 and status = 'sent'", [user.id, key]))) return false;
    const firstName = (user.name || '').trim().split(/\s+/)[0] || 'there';
    const r = await render(key, { first_name: firstName, unsubscribe_url: user.id ? unsubscribeUrl(user.id) : '', ...vars }, t);
    const res = await deliver({ to: user.email, subject: r.subject, html: r.html, text: r.text });
    outbox.push({ key, to: user.email, subject: r.subject, text: r.text, html: r.html, at: new Date() });
    if (outbox.length > 50) outbox.shift();
    await logEmail(user, key, 'sent', res.id);
    return true;
  } catch (err) {
    log.error('email failed', { key, to: user && user.email, err });
    await logEmail(user, key, 'failed', null, String(err.message || err)).catch(() => {});
    return false;
  }
}

async function logEmail(user, key, status, providerId, error) {
  await db.query('insert into email_log(user_id, template, to_email, status, provider_id, error) values ($1,$2,$3,$4,$5,$6)',
    [user.id || null, key, user.email, status, providerId || null, error || null]);
}

/** Send to a raw address (used for staff invites and the admin "send test"). */
async function sendTo(emailAddress, key, vars = {}) { return send(key, { email: emailAddress, name: vars.first_name || '' }, vars); }

module.exports = { send, sendTo, render, getTemplate, unsubscribeUrl, TEMPLATES, outbox };

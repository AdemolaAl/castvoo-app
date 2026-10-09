'use strict';
/*
 * The tools the support AI (and, read-only, Cas) can call. Every tool runs for ONE customer:
 *
 *   scope = { userId, workspaceId, role, threadId, sandbox, log }
 *
 * role is the person's CURRENT role in that workspace (owner / sender / drafter / helper), read by support-ai.js from
 * members just before the turn. Tools marked owner: true (they change something, like the dashboard keeps for owners)
 * only run for owners and the setup helper (SEC-1). Tools marked personal: true (referral money) don't run for a setup
 * helper, and get_account hides the other members' emails from them: a helper gets workspace facts, never owner-private data.
 *
 * The scope comes from the logged-in session / the support thread, never from the model. Tools take no user or
 * workspace id, and every id the model may pass (a connection id, a payment reference) is looked up with
 * `workspace_id = scope.workspaceId`, so asking for someone else's data just finds nothing.
 *
 * Money rules are enforced HERE, in code, whatever the model writes:
 *   - recheck_payment only asks the provider (payments.verify, the same server-to-server check as the wallet page).
 *     The wallet is credited only when Paystack / Flutterwave / Gatevoo confirm it, and crediting twice does nothing.
 *   - Manual methods (bank, mobile money, manual USDT...) are read-only: the AI can see the status and hands the
 *     conversation to Finance. No tool can approve, credit, refund, give a bonus or discount, change a price or move money.
 *
 * Every output goes through redact(): keys like token / secret / password / code / api_key are removed and values
 * that look like bot tokens or API keys are masked. Internal staff notes, admin settings and other customers'
 * data are never read by any tool.
 */

const db = require('../db');
const config = require('../config');
const log = require('../lib/log');
const rl = require('../lib/ratelimit');
const settings = require('./settings');
const billing = require('./billing');
const tg = require('./telegram');
const { decrypt, fmtUSD } = require('../lib/util');
const HELPER = require('./helper');
const ROLE_NAMES = { owner: 'Owner', sender: 'Can send', drafter: 'Drafts only', helper: 'Setup helper' };

/* ---------------- redaction ---------------- */
// Keys that are never shown, wherever they appear in a tool's output.
const SECRET_KEY = /(^|_)(token|tokens|secret|secrets|password|passwd|passcode|pwd|api_?key|apikey|private_?key|key_enc|token_enc|code|codes|code_hash|otp|pin|cvv|cvc|card_?number|pan|authorization|auth|cookie|session|signature|webhook_secret|proof_path)$/i;
const VALUE_PATTERNS = [
  [/\b\d{5,15}:[A-Za-z0-9_-]{30,60}\b/g, '[bot token hidden]'], // Telegram bot token
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[key hidden]'],                 // OpenAI / OpenRouter / Anthropic keys
  [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{6,}\b/g, '[key hidden]'], // Paystack keys
  [/\bFLWSECK[A-Za-z0-9_-]*\b/g, '[key hidden]'],                 // Flutterwave keys
  [/\bv1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\b/g, '[encrypted value hidden]'],
  [/\b(login|verification|security) code(?: is)?:? ?\d{4,8}\b/gi, '$1 code: [hidden]'],
];
function redactString(s) {
  let t = String(s);
  for (const [re, rep] of VALUE_PATTERNS) t = t.replace(re, rep);
  return t.length > 2000 ? t.slice(0, 1997) + '…' : t;
}
/** Deep copy without secrets. Safe for anything: arrays, nested objects, dates, numbers. */
function redact(v, depth = 0) {
  if (depth > 8) return '[…]';
  if (v === null || v === undefined) return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return redactString(v);
  if (typeof v === 'bigint') return Number(v);
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (SECRET_KEY.test(k)) continue;
    out[k] = redact(x, depth + 1);
  }
  return out;
}

/* ---------------- small helpers ---------------- */
const usd = (c) => fmtUSD(Number(c || 0));
const day = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : null);
function maskEmail(e) {
  if (!e) return null;
  const [u, d] = String(e).split('@');
  if (!d) return '***';
  return (u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '***' + u.slice(-1)) + '@' + d;
}
const providerLabel = (p, coin, label) => ({ paystack: 'Paystack', flutterwave: 'Flutterwave', gatevoo: 'Crypto checkout (Gatevoo)', manual_crypto: (coin || 'USDT') + ' sent by hand' }[p] || (p === 'manual' ? (label || 'Manual method') : p));
const MANUAL = new Set(['manual', 'manual_crypto']);
const connName = (c) => (c.kind === 'bot' ? '@' + (c.username || 'bot') : c.title || (c.username ? '@' + c.username : c.kind));

async function scopeRows(scope) {
  const ws = await db.one('select * from workspaces where id = $1', [scope.workspaceId]);
  const user = await db.one('select * from users where id = $1', [scope.userId]);
  if (!ws || !user) throw new Error('scope not found');
  return { ws, user };
}
/** A connection of THIS workspace only. */
async function myConnection(scope, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return db.one("select * from connections where id = $1 and workspace_id = $2 and status <> 'removed'", [n, scope.workspaceId]);
}

/* ---------------- the tools ---------------- */
const S = (props = {}, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });

const TOOLS = {
  get_account: {
    description: "The customer's own account and workspace: name, email (partly hidden), country, plan, plan status, trial end, renewal date, seats and team members.",
    parameters: S(),
    async run(scope) {
      const { ws, user } = await scopeRows(scope);
      const l = await billing.limits(ws);
      const members = await db.many('select u.id, u.name, u.email, m.role from members m join users u on u.id = m.user_id where m.workspace_id = $1 order by m.created_at', [ws.id]);
      const pending = ws.pending_plan_code ? await settings.plan(ws.pending_plan_code) : null;
      const helperView = scope.role === 'helper';
      return {
        // A setup helper is not the owner: they get the workspace, never the owner's login details (SEC-1).
        ...(helperView ? { you_are: 'the setup helper of this workspace, not its owner', helper_rules: { can: HELPER.CAN, cannot: HELPER.CANNOT, can_change_plan: !!ws.helper_billing, can_send_broadcasts: ws.helper_send !== false } } : {}),
        user: { first_name: (user.name || '').split(' ')[0] || null, email: maskEmail(user.email), email_verified: user.email_verified, country: user.country, telegram_linked: !!user.tg_user_id, telegram_username: user.tg_username || null, voosquare_linked: !!user.voo_id, since: day(user.created_at) },
        workspace: { name: ws.name, plan: l.plan.name, plan_status: ws.plan_status, billing_cycle: ws.billing_cycle, trial_ends_at: day(ws.trial_ends_at), renewal_date: ws.plan_status === 'active' ? day(ws.period_end) : null, cancel_at_period_end: ws.cancel_at_period_end, next_plan: pending ? pending.name : null, timezone: ws.timezone || null },
        seats: { used: members.filter((m) => m.role !== 'helper').length, limit: l.seats, setup_helper: 'one free on every plan, does not use a seat' },
        members: members.map((m) => ({ name: (m.name || '').split(' ')[0] || 'Teammate', ...(helperView && Number(m.id) !== Number(scope.userId) ? {} : { email: maskEmail(m.email) }), role: ROLE_NAMES[m.role] || m.role })),
      };
    },
  },

  get_wallet: {
    description: 'Wallet balance (cash and bonus credit) and the last wallet transactions.',
    parameters: S(),
    async run(scope) {
      const { ws } = await scopeRows(scope);
      const tx = await db.many('select kind, amount_cents, method, note, ref, created_at from wallet_tx where workspace_id = $1 order by id desc limit 12', [ws.id]);
      return {
        cash: usd(ws.wallet_cents), bonus: usd(ws.bonus_cents), total: usd(Number(ws.wallet_cents) + Number(ws.bonus_cents)),
        note: 'Bonus credit pays for plans only and is not refundable.',
        transactions: tx.map((t) => ({ kind: t.kind, amount: usd(t.amount_cents), method: t.method, note: t.note, reference: t.ref, at: day(t.created_at) })),
      };
    },
  },

  get_payments: {
    description: 'Recent top-up payments with status, method, amount and reference. Use before recheck_payment.',
    parameters: S(),
    async run(scope) {
      const rows = await db.many(`select p.*, pm.label as method_label from payments p left join payment_methods pm on pm.key = p.method_key
        where p.workspace_id = $1 order by p.id desc limit 12`, [scope.workspaceId]);
      return {
        payments: rows.map((p) => ({
          reference: p.reference, method: providerLabel(p.provider, p.coin, p.method_label), automatic: !MANUAL.has(p.provider),
          amount: usd(p.amount_cents), local_amount: p.currency && p.currency !== 'USD' && p.amount_local != null ? `${Number(p.amount_local).toLocaleString('en-US')} ${p.currency}` : null,
          bonus: Number(p.bonus_cents) ? usd(p.bonus_cents) : null, status: p.status, reason: p.reason || null,
          customer_sent_proof: MANUAL.has(p.provider) ? !!(p.txid || p.submitted_at) : null,
          transaction_id_end: p.txid ? '…' + String(p.txid).slice(-6) : null,
          created_at: day(p.created_at), paid_at: day(p.paid_at),
        })),
      };
    },
  },

  recheck_payment: {
    description: 'Ask the payment provider again whether a top-up was paid. For Paystack, Flutterwave and Gatevoo the wallet is credited automatically ONLY if the provider confirms it. For manual methods (bank transfer, mobile money, USDT sent by hand) this only shows the status: the finance team confirms those.',
    parameters: S({ reference: { type: 'string', description: 'The payment reference, like cv_xxxxx (from get_payments)' } }, ['reference']),
    async run(scope, input) {
      const ref = String(input.reference || '').trim().slice(0, 40);
      const p = ref ? await db.one('select p.*, pm.label as method_label from payments p left join payment_methods pm on pm.key = p.method_key where p.reference = $1 and p.workspace_id = $2', [ref, scope.workspaceId]) : null;
      if (!p) return { found: false, message: 'No payment with that reference in this workspace. Use get_payments to see the real references.' };
      const base = { reference: p.reference, method: providerLabel(p.provider, p.coin, p.method_label), amount: usd(p.amount_cents) };
      if (p.status === 'paid') return { ...base, status: 'paid', credited: false, already_paid: true, paid_at: day(p.paid_at) };
      if (p.status !== 'pending') return { ...base, status: p.status, reason: p.reason || null, credited: false };
      if (MANUAL.has(p.provider)) {
        // Read-only. The agent hands this to Finance (support-ai.js does it in code, not on the model's word).
        return { ...base, status: 'pending', manual: true, credited: false, customer_sent_proof: !!(p.txid || p.submitted_at), sent_at: day(p.submitted_at), created_at: day(p.created_at),
          rule: 'Manual payments are confirmed by the finance team only, usually within a few hours. You cannot confirm or credit them.' };
      }
      if (scope.sandbox) return { ...base, status: 'pending', credited: false, sandbox: true, message: 'Sandbox: the provider was not asked and nothing was credited.' };
      if (!(await rl.hitShared('recheck:' + p.reference, 6, 600)).ok) return { ...base, status: 'pending', credited: false, message: 'Checked several times in the last few minutes. Wait a little before checking again.' };
      const payments = require('../payments');
      await payments.verify(p.reference).catch((e) => { log.warn('support recheck failed', { ref: p.reference, err: e.message }); return false; });
      const now = await db.one('select status, paid_at, reason from payments where id = $1', [p.id]);
      return { ...base, status: now.status, credited: now.status === 'paid', paid_at: day(now.paid_at), reason: now.status === 'paid' ? null : (now.reason || 'The provider has not confirmed this payment yet.') };
    },
  },

  get_usage: {
    description: 'Plan limits, features and what is used: connections, bot subscribers, team seats, AI writes (and when they refill), the join-request meter for this month, Welcome Flows (made, live, messages per flow), and whether sending is allowed right now.',
    parameters: S(),
    async run(scope) {
      const { ws } = await scopeRows(scope);
      const [l, u, meter] = [await billing.limits(ws), await billing.usage(ws.id), await billing.joinMeter(ws)];
      let can_send = true, blocked_reason = null;
      try { await billing.assertCanSend(ws); } catch (e) { can_send = false; blocked_reason = e.message; }
      const jr = await db.one(`select count(*) filter (where s.status = 'joinreq')::int waiting
        from subscribers s join connections c on c.id = s.connection_id where c.workspace_id = $1`, [ws.id]);
      const open = await db.one("select count(*)::int n from join_requests where workspace_id = $1 and status = 'pending'", [ws.id]);
      const offByPlan = await db.one("select count(*)::int n from sequences where workspace_id = $1 and paused_by_plan and not active", [ws.id]);
      const refill = billing.aiRefillAt(ws);
      const lim = (v) => (v === billing.UNLIMITED ? 'unlimited' : v);
      const free = billing.isFreePlan(l.plan);
      return {
        plan: l.plan.name, plan_status: ws.plan_status, free_plan: free,
        moved_to_free_from: free && ws.dropped_from ? ws.dropped_from : null,
        features: [...new Set([...l.features, ...(l.legacy ? ['grandfathered features of the old plan'] : [])])],
        can_send, blocked_reason,
        connections: { used: u.connections, limit: l.connections, note: free ? 'On Free the limit counts channels and groups; 1 welcome bot comes free next to them.' : undefined },
        bot_subscribers: { used: u.bot_subscribers, limit: l.subscribers, note: 'Channel and group members do not count.' },
        channel_group_members: u.chat_members,
        seats: { used: u.seats, limit: l.seats },
        ai_writes: { used: u.ai_used, limit: l.ai_writes, refill: refill ? day(refill) : ws.plan_status === 'trial' ? 'when the plan starts' : null },
        join_requests: {
          this_period: meter.used, limit: lim(meter.limit), let_in: meter.approved, percent: meter.pct,
          welcomes_paused_over_limit: meter.paused, joined_without_welcome: meter.no_welcome,
          counted_since: day(meter.since), resets: day(meter.resets_at), unlimited_until: day(meter.unlimited_until),
          waiting_for_owner_decision: open.n, people_waiting_to_press_start: jr.waiting,
        },
        welcome_flows: { made: u.flows, live: u.active_flows, limit: lim(l.flows), messages_per_flow: lim(l.flow_steps), ab_versions: l.ab_variants, switched_off_by_plan: offByPlan.n },
      };
    },
  },

  get_connections: {
    description: 'The bots, channels and groups in this workspace: name, kind, status, last error, reach and recent delivery failures. No tokens.',
    parameters: S(),
    async run(scope) {
      const rows = await db.many(`select c.id, c.kind, c.username, c.title, c.status, c.last_error, c.member_count, c.created_at,
          case when c.kind = 'bot' then (select count(*)::int from subscribers s where s.connection_id = c.id and s.status = 'active') else c.member_count end as reach,
          (select count(*)::int from deliveries d where d.workspace_id = c.workspace_id and d.sender_key = case when c.kind = 'bot' then 'bot:' || c.id else 'platform' end and d.status = 'failed' and d.created_at > now() - interval '7 days') as failed_7d,
          (select count(*)::int from deliveries d where d.workspace_id = c.workspace_id and d.sender_key = case when c.kind = 'bot' then 'bot:' || c.id else 'platform' end and d.status = 'queued') as queued
        from connections c where c.workspace_id = $1 and c.status <> 'removed' order by c.id`, [scope.workspaceId]);
      return {
        platform_bot: config.telegram.botUsername ? '@' + config.telegram.botUsername : null,
        connections: rows.map((c) => ({ id: c.id, kind: c.kind, name: connName(c), status: c.status === 'error' ? 'needs attention' : c.status, last_error: c.last_error || null, reach: c.reach, failed_last_7_days: c.failed_7d, waiting_to_send: c.queued, connected_at: day(c.created_at) })),
      };
    },
  },

  test_connection: {
    description: "Live check of one connection with Telegram: for a bot, whether its token works and its webhook points at Castvoo; for a channel or group, whether @CastvooBot is still an admin with the right permissions. Read-only.",
    parameters: S({ connection_id: { type: 'integer', description: 'id from get_connections' } }, ['connection_id']),
    async run(scope, input) {
      const c = await myConnection(scope, input.connection_id);
      if (!c) return { found: false, message: 'No connection with that id in this workspace. Use get_connections.' };
      if (!(await rl.hitShared('tconn:' + c.id, 10, 600)).ok) return { id: c.id, message: 'Checked several times just now. Wait a minute.' };
      if (c.kind === 'bot') {
        if (!c.token_enc) return { id: c.id, name: connName(c), token_works: false, fix: 'Paste the bot token again in Channels & bots.' };
        const token = decrypt(c.token_enc);
        const out = { id: c.id, kind: 'bot', name: connName(c), status: c.status };
        try { await tg.call(token, 'getMe'); out.token_works = true; } catch (e) {
          out.token_works = e.code === 401 || e.code === 404 ? false : null;
          out.telegram_error = e.code === 401 || e.code === 404 ? 'Telegram says the token is not valid (it was revoked or changed).' : 'Telegram could not be reached just now.';
          return out;
        }
        try {
          const info = await tg.call(token, 'getWebhookInfo');
          const want = `${config.appUrl}/tg/b/${c.id}`;
          out.webhook_points_to_castvoo = info.url === want;
          out.pending_updates = info.pending_update_count || 0;
          out.webhook_last_error = info.last_error_message || null;
          out.webhook_last_error_at = info.last_error_date ? day(new Date(info.last_error_date * 1000)) : null;
          if (!out.webhook_points_to_castvoo) out.fix = 'The webhook is not pointing at Castvoo (another tool may have taken over the bot). repair_webhook can fix it.';
        } catch { out.webhook_points_to_castvoo = null; }
        return out;
      }
      const out = { id: c.id, kind: c.kind, name: connName(c), status: c.status, members: c.member_count };
      if (!config.telegram.botToken) return { ...out, message: 'Channel checks are not available on this server.' };
      try {
        const me = Number(String(config.telegram.botToken).split(':')[0]);
        const m = await tg.platform('getChatMember', { chat_id: c.tg_chat_id, user_id: me });
        out.castvoo_bot_status = m.status;
        out.is_admin = m.status === 'administrator' || m.status === 'creator';
        if (c.kind === 'channel') out.rights = { post_messages: m.can_post_messages !== false, edit_messages: m.can_edit_messages !== false, delete_messages: m.can_delete_messages !== false, invite_users: m.can_invite_users !== false };
        else out.rights = { delete_messages: m.can_delete_messages !== false, pin_messages: m.can_pin_messages !== false, invite_users: m.can_invite_users !== false };
        if (!out.is_admin) out.fix = `Add @${config.telegram.botUsername} as an admin again from Channels & bots.`;
      } catch (e) {
        out.is_admin = false;
        out.telegram_error = e.code === 400 || e.code === 403 ? `@${config.telegram.botUsername} is no longer in this chat or lost its admin rights.` : 'Telegram could not be reached just now.';
        out.fix = `Add @${config.telegram.botUsername} as an admin again from Channels & bots.`;
      }
      return out;
    },
  },

  repair_webhook: {
    description: "Point a connected bot's webhook at Castvoo again (the same step Castvoo does when you connect a bot). Safe: keeps subscribers, follow-ups and pending updates. Bots only.",
    parameters: S({ connection_id: { type: 'integer', description: 'id of a bot from get_connections' } }, ['connection_id']),
    write: true,
    owner: true, // the dashboard keeps reconnecting bots for the workspace owner
    async run(scope, input) {
      const c = await myConnection(scope, input.connection_id);
      if (!c) return { found: false, message: 'No connection with that id in this workspace.' };
      if (c.kind !== 'bot') return { id: c.id, repaired: false, message: `Channels and groups have no webhook. If posting fails, add @${config.telegram.botUsername} as admin again.` };
      if (scope.sandbox) return { id: c.id, repaired: false, sandbox: true, message: 'Sandbox: nothing was changed.' };
      if (!(await rl.hitShared('repair:' + c.id, 3, 600)).ok) return { id: c.id, repaired: false, message: 'Repaired a moment ago. Wait a few minutes before trying again.' };
      try {
        const r = await require('./connections').repairWebhook(c);
        return { id: c.id, name: '@' + (r.username || c.username), repaired: true };
      } catch (e) { return { id: c.id, repaired: false, message: e.message }; }
    },
  },

  get_broadcasts: {
    description: 'Recent broadcasts with status, schedule, delivered and failed counts and the most common errors.',
    parameters: S(),
    async run(scope) {
      const rows = await db.many(`select b.id, b.title, b.status, b.send_mode, b.send_at, b.total, b.sent, b.failed, b.started_at, b.finished_at, b.created_at, c.kind, c.username, c.title as ctitle,
          (select count(*)::int from deliveries d where d.broadcast_id = b.id and d.status = 'queued' and d.action = 'send') as waiting,
          (select count(*)::int from deliveries d where d.broadcast_id = b.id and d.status = 'sent' and d.action = 'send') as delivered_now,
          (select count(*)::int from deliveries d where d.broadcast_id = b.id and d.status in ('failed','blocked') and d.action = 'send') as failed_now
        from broadcasts b join connections c on c.id = b.connection_id where b.workspace_id = $1 order by b.id desc limit 10`, [scope.workspaceId]);
      const out = [];
      for (const b of rows) {
        const errs = b.failed_now ? await db.many(`select coalesce(error, 'unknown') error, count(*)::int n from deliveries where broadcast_id = $1 and status in ('failed','blocked') group by 1 order by 2 desc limit 3`, [b.id]) : [];
        out.push({ id: b.id, title: b.title, status: b.status, to: connName({ kind: b.kind, username: b.username, title: b.ctitle }), send_mode: b.send_mode, send_at: day(b.send_at), total: b.total,
          delivered: b.status === 'sending' ? b.delivered_now : b.sent, failed: b.status === 'sending' ? b.failed_now : b.failed, still_waiting: b.waiting, started_at: day(b.started_at), finished_at: day(b.finished_at),
          top_errors: errs.map((e) => `${e.error} (${e.n})`) });
      }
      return { broadcasts: out, note: 'Telegram gives bots no read receipts, so there are no read numbers.' };
    },
  },

  get_flows: {
    description: 'Welcome Flows (join-request welcomes: channel, bot, live or draft, how people are let in, steps, requests, welcomed, let in, waiting) and auto follow-ups (drips: trigger, steps, people in them), with recent errors.',
    parameters: S(),
    async run(scope) {
      const { ws } = await scopeRows(scope);
      const rows = await db.many(`select q.id, q.name, q.trigger_type, q.trigger_value, q.active, q.paused_by_plan, q.approve_mode, q.start_button, q.invite_link, c.kind, c.username, c.title as ctitle, c.status as cstatus,
          (select count(*)::int from sequence_steps s where s.sequence_id = q.id and s.variant = 0) steps,
          (select count(*)::int from sequence_steps s where s.sequence_id = q.id and s.variant > 0) ab_versions,
          (select count(*)::int from sequence_runs r where r.sequence_id = q.id and r.status = 'active') running,
          (select count(*)::int from sequence_runs r where r.sequence_id = q.id and r.status = 'waiting') waiting_start,
          (select count(*)::int from sequence_runs r where r.sequence_id = q.id and r.status = 'done') finished,
          (select count(*)::int from deliveries d join sequence_steps s on s.id = d.step_id where s.sequence_id = q.id and d.status = 'sent' and d.created_at > now() - interval '7 days') sent_7d,
          (select count(*)::int from deliveries d join sequence_steps s on s.id = d.step_id where s.sequence_id = q.id and d.status = 'failed' and d.created_at > now() - interval '7 days') failed_7d
        from sequences q join connections c on c.id = q.connection_id where q.workspace_id = $1 and c.status <> 'removed' order by q.active desc, q.id desc limit 30`, [scope.workspaceId]);
      const trig = { start: 'someone presses Start', start_tag: 'Start through a start link', join_request: 'someone asks to join', tag: 'a subscriber gets a tag' };
      const modes = { instant: 'straight away', after_welcome: 'after the welcome', tap: 'when they tap the button and press Start', manual: 'the owner decides (Requests tab)' };
      const errorsOf = async (q) => (q.failed_7d ? (await db.many(`select coalesce(d.error, 'unknown') error, count(*)::int n from deliveries d join sequence_steps s on s.id = d.step_id where s.sequence_id = $1 and d.status = 'failed' and d.created_at > now() - interval '7 days' group by 1 order by 2 desc limit 3`, [q.id])).map((e) => `${e.error} (${e.n})`) : []);
      const welcome = [], follow = [];
      for (const q of rows) {
        const base = { id: q.id, name: q.name, on: q.active, switched_off_by_plan: q.paused_by_plan && !q.active, bot: '@' + (q.username || 'bot'), bot_status: q.cstatus === 'error' ? 'needs attention' : q.cstatus,
          steps: q.steps, sent_7d: q.sent_7d, failed_7d: q.failed_7d, top_errors: await errorsOf(q) };
        if (q.trigger_type === 'join_request') {
          const chat = await db.one("select title, username, kind, status from connections where workspace_id = $1 and kind <> 'bot' and tg_chat_id::text = $2 and status <> 'removed'", [ws.id, q.trigger_value || '']);
          const j = await db.one(`select count(*)::int requests, count(*) filter (where welcome = 'sent')::int welcomed, count(*) filter (where welcome = 'failed')::int welcome_failed,
              count(*) filter (where welcome = 'skipped_limit')::int no_welcome_over_limit, count(*) filter (where status = 'approved')::int let_in,
              count(*) filter (where status = 'pending')::int waiting_for_decision, count(started_at)::int tapped_start
            from join_requests where sequence_id = $1`, [q.id]);
          const err = await db.one("select error from join_requests where sequence_id = $1 and error is not null order by id desc limit 1", [q.id]);
          welcome.push({ ...base, channel: chat ? connName({ kind: chat.kind, username: chat.username, title: chat.title }) : 'not connected any more', channel_status: chat ? (chat.status === 'error' ? 'needs attention' : chat.status) : null,
            how_people_get_in: modes[q.approve_mode] || q.approve_mode, tap_to_start_button: q.start_button, own_invite_link: !!q.invite_link, ab_versions: q.ab_versions ? q.ab_versions + 1 : 1,
            people_waiting_to_press_start: q.waiting_start, ...j, last_join_error: err ? err.error : null });
        } else {
          follow.push({ ...base, trigger: trig[q.trigger_type] || q.trigger_type, trigger_tag: q.trigger_type === 'start_tag' || q.trigger_type === 'tag' ? q.trigger_value : null, people_in_progress: q.running, finished: q.finished });
        }
      }
      const l = await billing.limits(ws);
      const paused = ws.plan_status === 'paused' || ws.plan_status === 'cancelled' || (ws.plan_status === 'trial' && new Date(ws.trial_ends_at) < new Date());
      const meter = await billing.joinMeter(ws);
      return {
        welcome_flows: welcome, follow_ups: follow,
        follow_ups_on_plan: l.features.includes('drips') || l.legacy,
        welcomes_paused_over_join_limit: meter.paused ? `This month's join requests are over the plan limit, so welcomes and flow messages pause until ${day(meter.resets_at)} or an upgrade. People are still let in.` : null,
        all_paused_because_plan: paused ? 'The plan is paused or the trial ended, so follow-ups wait until the plan is active.' : null,
        feature_on: { follow_ups: await settings.feature('drips'), welcome_flows: (await settings.feature('welcome_flows')) && (await settings.feature('join_welcome')) },
      };
    },
  },

  get_subscribers_summary: {
    description: 'Counts only: bot subscribers by status (active, blocked, stopped, waiting after a join request) and new ones in the last 7 days.',
    parameters: S(),
    async run(scope) {
      const rows = await db.many(`select c.id, c.username, count(s.*) filter (where s.status = 'active')::int active, count(s.*) filter (where s.status = 'blocked')::int blocked,
          count(s.*) filter (where s.status = 'stopped')::int stopped, count(s.*) filter (where s.status = 'joinreq')::int waiting_join, count(s.*) filter (where s.joined_at > now() - interval '7 days')::int new_7d
        from connections c left join subscribers s on s.connection_id = c.id where c.workspace_id = $1 and c.kind = 'bot' and c.status <> 'removed' group by c.id, c.username order by c.id`, [scope.workspaceId]);
      return { bots: rows.map((r) => ({ bot: '@' + (r.username || 'bot'), active: r.active, blocked: r.blocked, stopped: r.stopped, waiting_after_join_request: r.waiting_join, new_last_7_days: r.new_7d })) };
    },
  },

  get_recent_errors: {
    description: 'Problems in the last days: connections that need attention, the most common delivery errors, failed broadcasts, failed or rejected payments and failed emails.',
    parameters: S(),
    async run(scope) {
      const ws = scope.workspaceId;
      const [conns, deliv, bcs, pays, mails] = await Promise.all([
        db.many("select id, kind, username, title, last_error from connections where workspace_id = $1 and status = 'error'", [ws]),
        db.many("select coalesce(error, 'unknown') error, count(*)::int n, max(created_at) last from deliveries where workspace_id = $1 and status = 'failed' and created_at > now() - interval '7 days' group by 1 order by 2 desc limit 6", [ws]),
        db.many("select id, title, finished_at from broadcasts where workspace_id = $1 and status = 'failed' and created_at > now() - interval '14 days' order by id desc limit 5", [ws]),
        db.many("select reference, provider, status, reason, created_at from payments where workspace_id = $1 and status in ('failed','rejected') and created_at > now() - interval '30 days' order by id desc limit 5", [ws]),
        db.many("select template, error, created_at from email_log where user_id = $1 and status = 'failed' and created_at > now() - interval '30 days' order by id desc limit 5", [scope.userId]),
      ]);
      const blocked = await db.one("select count(*)::int n from deliveries where workspace_id = $1 and status = 'blocked' and created_at > now() - interval '7 days'", [ws]);
      return {
        connections_needing_attention: conns.map((c) => ({ id: c.id, name: connName(c), error: c.last_error })),
        delivery_errors_7d: deliv.map((d) => ({ error: d.error, count: d.n, last: day(d.last) })),
        people_who_blocked_the_bot_7d: blocked.n,
        failed_broadcasts_14d: bcs.map((b) => ({ id: b.id, title: b.title, at: day(b.finished_at) })),
        failed_payments_30d: pays.map((p) => ({ reference: p.reference, method: providerLabel(p.provider), status: p.status, reason: p.reason })),
        failed_emails_30d: mails.map((m) => ({ email: m.template, error: m.error, at: day(m.created_at) })),
      };
    },
  },

  get_email_log: {
    description: 'Which emails Castvoo sent to the customer recently (login codes, receipts, reminders) and whether they were delivered to the email provider. Never shows the content or any code.',
    parameters: S(),
    async run(scope) {
      const T = require('../emails/templates');
      const rows = await db.many('select template, to_email, status, created_at from email_log where user_id = $1 order by id desc limit 15', [scope.userId]);
      const { user } = await scopeRows(scope);
      return {
        account_email: maskEmail(user.email), email_verified: user.email_verified, email_service_on: !!config.integrations().email,
        emails: rows.map((r) => ({ email: (T[r.template] && T[r.template].name) || r.template, to: maskEmail(r.to_email), status: r.status, at: day(r.created_at) })),
        tip: 'Login codes expire after 10 minutes. If one did not arrive: check spam and promotions, wait a minute, then tap "Send a new code". At most 5 codes an hour per email.',
      };
    },
  },

  resend_email_verification: {
    description: "Send a fresh verification code to the customer's own account email (only if it is not verified yet), through the normal Settings flow. The code goes only to their inbox; you never see it.",
    parameters: S(),
    write: true,
    async run(scope) {
      const { user } = await scopeRows(scope);
      if (!user.email) return { sent: false, message: 'There is no email on this account yet. Add one in Settings → Profile.' };
      if (user.email_verified) return { sent: false, already_verified: true, email: maskEmail(user.email) };
      if (scope.sandbox) return { sent: false, sandbox: true, message: 'Sandbox: no email was sent.' };
      try {
        await require('../routes/auth').sendCode(null, user.email, 'add_email');
        return { sent: true, to: maskEmail(user.email), next: 'Open Settings → Profile and type the 6-digit code from the email.' };
      } catch (e) { return { sent: false, message: e.message }; }
    },
  },

  get_referrals: {
    description: "The customer's own referral programme: their rate and tier, sign-ups and paying referrals, earnings that are pending (not settled yet), ready to use or withdraw, already used on plans, and why an earning was cancelled. Read-only.",
    personal: true,
    parameters: S(),
    async run(scope) {
      const { user } = await scopeRows(scope);
      const rs = await settings.get('referral');
      const bal = await require('./referrals').balances(user.id);
      const people = await db.one(`select count(*)::int signups, count(*) filter (where w.plan_status = 'active' and w.paid_ever)::int paying
        from users u join workspaces w on w.owner_user_id = u.id where u.referred_by = $1 and u.status = 'active'`, [user.id]);
      const rate = people.paying >= rs.tier3_min ? rs.rates[2] : people.paying >= rs.tier2_min ? rs.rates[1] : rs.rates[0];
      const next = people.paying < rs.tier2_min ? { at: rs.tier2_min, rate: rs.rates[1] } : people.paying < rs.tier3_min ? { at: rs.tier3_min, rate: rs.rates[2] } : null;
      const rows = await db.many(`select kind, amount_cents, rate, settles_at, created_at from referral_ledger where user_id = $1 order by id desc limit 12`, [user.id]);
      const label = { earning: 'commission', use: 'used on a plan', withdrawal: 'withdrawn', reversal: 'cancelled (refund, dispute or review)' };
      return {
        programme_on: await settings.feature('referrals'), rate_percent: rate, paying_referrals: people.paying, signups: people.signups,
        next_tier: next ? { paying_referrals_needed: next.at, rate_percent: next.rate } : null,
        settle_days: rs.settle_days, min_withdraw: usd(rs.min_withdraw_cents),
        balance: { pending: usd(bal.pending), ready: usd(bal.available), earned_total: usd(bal.earned), used_on_plans: usd(bal.used), withdrawn: usd(bal.withdrawn) },
        recent: rows.map((r) => ({ what: label[r.kind] || r.kind, amount: usd(r.amount_cents), rate_percent: r.rate, settles: r.kind === 'earning' ? day(r.settles_at) : null, at: day(r.created_at) })),
        rule: 'Commission is earned on cash payments and settles after the settle days. Earnings from refunded or disputed payments, or flagged for review, are cancelled. You cannot add, change or pay out earnings.',
      };
    },
  },

  get_withdrawals: {
    description: "The customer's referral withdrawals (USDT or Bitcoin): amount, coin, status (requested, paid, rejected), the end of the wallet address and of the transaction id, the reason if rejected, and dates. Read-only: only the finance team pays withdrawals.",
    personal: true,
    parameters: S(),
    async run(scope) {
      const rows = await db.many('select amount_cents, coin, address, status, txid, reason, created_at, processed_at from withdrawals where user_id = $1 order by id desc limit 10', [scope.userId]);
      const words = { requested: 'waiting for the finance team', paid: 'paid', rejected: 'rejected (the money is back in the referral balance)' };
      return {
        withdrawals_on: await settings.feature('withdrawals'),
        withdrawals: rows.map((w) => ({ amount: usd(w.amount_cents), coin: w.coin, to_address_end: '…' + String(w.address || '').slice(-6), status: w.status, meaning: words[w.status] || w.status,
          transaction_id_end: w.txid ? '…' + String(w.txid).slice(-6) : null, reason: w.reason || null, requested_at: day(w.created_at), processed_at: day(w.processed_at) })),
        rule: 'Withdrawals are paid by hand by the finance team, one at a time per person. You cannot speed up, approve or pay one; hand over to finance if one is late.',
      };
    },
  },

  get_offers: {
    description: "Discounts on the customer's account: the coupon on this workspace (name, percent off, months left), coupons they redeemed before, and the top-up bonuses and offers running now for everyone. Read-only: you can never add a coupon, discount or bonus.",
    parameters: S(),
    async run(scope) {
      const { ws } = await scopeRows(scope);
      const coupon = ws.coupon_id && Number(ws.coupon_months_left) > 0 ? await db.one('select title, percent, ends_at from offers where id = $1', [ws.coupon_id]) : null;
      const used = await db.many(`select o.title, o.percent, r.created_at from coupon_redemptions r join offers o on o.id = r.offer_id where r.user_id = $1 order by r.created_at desc limit 10`, [scope.userId]);
      const live = await db.many(`select kind, title, description, percent, min_topup_cents, bonus_cents, ends_at from offers
        where active and kind in ('topup_bonus', 'banner') and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now()) order by kind, min_topup_cents nulls last limit 10`);
      return {
        coupon_on_workspace: coupon ? { name: coupon.title, percent_off: coupon.percent, months_left: Number(ws.coupon_months_left), offer_ends: day(coupon.ends_at) } : null,
        coupons_used_before: used.map((u) => ({ name: u.title, percent_off: u.percent, at: day(u.created_at) })),
        offers_now: live.map((o) => ({ kind: o.kind === 'topup_bonus' ? 'top-up bonus' : 'offer', name: o.title, about: o.description || null, top_up_from: o.min_topup_cents ? usd(o.min_topup_cents) : null, bonus: o.bonus_cents ? usd(o.bonus_cents) : null, percent_off: o.percent || null, ends: day(o.ends_at) })),
        rule: 'A coupon is entered by the customer in Wallet and plan. Bonus credit pays for plans only and is never refunded. You cannot add or change any discount.',
      };
    },
  },

  search_knowledge: {
    description: 'Search the Castvoo help articles. Use it for how-to questions and error messages.',
    parameters: S({ query: { type: 'string' } }, ['query']),
    async run(scope, input) { return { results: await searchKnowledge(String(input.query || '')) } },
  },

  create_handoff: {
    description: 'Hand this conversation to a human teammate. Use it when the customer asks for a person; for refunds, chargebacks, legal, data deletion, ownership or account closure; when a manual payment must be confirmed; when you are not sure; or after you could not fix the problem. After this you stop replying.',
    parameters: S({
      reason: { type: 'string', enum: ['asked_for_human', 'refund', 'chargeback', 'legal', 'data_deletion', 'ownership', 'account_closure', 'manual_payment', 'frustrated', 'not_confident', 'tool_error', 'not_fixed', 'other'] },
      summary: { type: 'string', description: 'Two or three sentences for the teammate: the problem, what you checked, what is left.' },
      priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
      team: { type: 'string', enum: ['support', 'finance', 'tech', 'privacy'] },
    }, ['reason', 'summary']),
    async run(scope, input) { return { ok: true, handed_off: true, reason: String(input.reason || 'other') }; },
  },
};

/** Simple keyword search over active knowledge articles (title words count double). */
async function searchKnowledge(q, limit = 3) {
  const rows = await db.many('select title, body from knowledge where active order by id');
  const words = String(q).toLowerCase().normalize('NFKD').replace(/[^a-z0-9@{}\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).slice(0, 12);
  if (!words.length) return rows.slice(0, limit).map((r) => ({ title: r.title, text: r.body.slice(0, 1500) }));
  return rows.map((r) => {
    const t = r.title.toLowerCase(), b = r.body.toLowerCase();
    let s = 0;
    for (const w of words) { if (t.includes(w)) s += 3; const m = b.split(w).length - 1; s += Math.min(m, 4); }
    return { r, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit).map(({ r }) => ({ title: r.title, text: r.body.slice(0, 2500) }));
}
const STOP = new Set(['the', 'and', 'for', 'you', 'your', 'how', 'what', 'why', 'can', 'does', 'not', 'are', 'with', 'this', 'that', 'have', 'from', 'when', 'did', 'was', 'its', 'but', 'get', 'got', 'any', 'into']);

/** The tool list in the neutral format llm.complete() takes. */
function definitions(names) {
  return names.filter((n) => TOOLS[n]).map((n) => ({ name: n, description: TOOLS[n].description, parameters: TOOLS[n].parameters }));
}
const SUPPORT_TOOLS = Object.keys(TOOLS);
// Cas (the in-app helper) only reads the workspace. Account and payment questions go to the support chat.
const CAS_TOOLS = ['get_usage', 'get_connections', 'get_broadcasts', 'get_flows', 'get_subscribers_summary', 'get_recent_errors', 'search_knowledge'];

/**
 * Run one tool for one scope. Never throws: returns { ok, output } with a redacted output.
 * scope.allowed limits which tools may run (Cas gets the read-only list), whatever the model asks for.
 */
async function run(name, input, scope) {
  const t0 = Date.now();
  const tool = TOOLS[name];
  const args = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  let ok = true, output;
  if (!tool || (scope.allowed && !scope.allowed.includes(name))) { ok = false; output = { error: `There is no tool called ${String(name).slice(0, 40)}.` }; }
  // Owner-only tools (they change something): refused for senders and drafters, as in the dashboard (SEC-1).
  // The setup helper connects and fixes bots in the dashboard, so the bot tools work for them too.
  else if (tool.owner && !scope.sandbox && !['owner', 'helper'].includes(scope.role)) { ok = true; output = { done: false, not_allowed: true, message: 'Only the workspace owner can do this. Ask the owner to write to support, or to do it in Channels & bots.' }; }
  // Referral money belongs to each person's own account; while helping a customer, the helper's own earnings are not shown.
  else if (tool.personal && !scope.sandbox && scope.role === 'helper') { ok = true; output = { not_available: true, message: 'This chat is about the workspace this person helps set up. Referral earnings and withdrawals are only shown in their own workspace.' }; }
  else {
    try { output = await tool.run(scope, args); } catch (e) {
      ok = false;
      log.warn('support tool failed', { tool: name, err: e.message });
      output = { error: 'This check did not work just now.' };
    }
  }
  const clean = redact(output);
  if (scope.log !== false) {
    await db.query('insert into support_ai_tool_log(thread_id, workspace_id, tool, input, output, ok, ms, sandbox) values ($1,$2,$3,$4,$5,$6,$7,$8)',
      [scope.threadId || null, scope.workspaceId || null, String(name).slice(0, 60), JSON.stringify(redact(args)).slice(0, 4000), JSON.stringify(clean).slice(0, 20000), ok, Date.now() - t0, !!scope.sandbox]).catch((e) => log.warn('tool log failed', { err: e.message }));
  }
  return { ok, output: clean };
}

module.exports = { TOOLS, SUPPORT_TOOLS, CAS_TOOLS, definitions, run, redact, maskEmail, searchKnowledge };

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
 *     The wallet is credited only when Flutterwave / Gatevoo (or Paystack, for an old Paystack payment) confirm it, and crediting twice does nothing.
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
/** A Telegram delivery error in plain words (the raw text stays next to it for the model). */
function plainError(e) {
  const s = String(e || '');
  if (/blocked by the user/i.test(s)) return 'they blocked the bot';
  if (/user is deactivated/i.test(s)) return 'their Telegram account was deleted';
  if (/chat not found|PEER_ID_INVALID/i.test(s)) return 'Telegram could not find the chat (they never pressed Start, or left)';
  if (/bot was kicked|bot is not a member/i.test(s)) return 'the bot was removed from that chat';
  if (/not enough rights|have no rights|CHAT_WRITE_FORBIDDEN|need administrator rights|CHAT_ADMIN_REQUIRED/i.test(s)) return 'the bot lost its admin rights there';
  if (/Unauthorized|401/i.test(s)) return 'the bot token stopped working';
  if (/Too Many Requests|429/i.test(s)) return 'Telegram asked to slow down (Castvoo retries by itself)';
  if (/too long/i.test(s)) return 'the message was too long';
  if (/wrong file|HTTP URL content|wrong type of the web page|failed to get/i.test(s)) return 'Telegram could not use the photo or video';
  if (/stopped|\/stop/i.test(s)) return 'they asked to stop messages';
  return null;
}
const errLine = (e, n) => { const p = plainError(e); return `${e}${p ? ' = ' + p : ''} (${n})`; };
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

/** Bots, lead answers, Cas builds and devices: the plan's bot limits (billing.BOT_PLANS) next to what is used. */
async function botsUsage(ws, l, lim) {
  const b = l.bots || billing.botLimitsFor(l.plan, ws.plan_status === 'trial');
  const [live, refLive, ans, paused] = [await billing.liveBots(ws.id), await billing.liveReferralBots(ws.id), await billing.answersMeter(ws),
    await db.one("select count(*)::int n from sequences where workspace_id = $1 and paused_by_plan and not active and trigger_type in ('join_request','bot_start')", [ws.id])];
  let builds = null;
  try {
    const cb = require('./cas-builder');
    const x = await cb.builds(ws);
    builds = { included: x.unlimited ? 'unlimited (fair use)' : x.limit, period: x.period === 'lifetime' ? 'for the life of the workspace (Free: the first build)' : 'this calendar month (UTC)',
      used: x.used, left: x.left < 0 ? 'unlimited' : x.left, cas_credits_bought: x.credits, resets: day(x.resets_at), resting_today: await cb.resting().catch(() => false) };
  } catch { /* Cas Builder not available */ }
  return {
    bots: { live_now: live, live_limit: lim(b.max_bots), fair_use: b.max_bots_fair_use || null, bot_types_on_plan: b.bot_types, messages_per_bot: lim(b.bot_steps), menu_buttons: lim(b.menu_buttons),
      lead_questions_per_bot: lim(b.lead_questions_per_form), referral_bots_live: refLive, referral_bots_limit: lim(b.referral_bots), lead_csv: b.lead_export === 'csv' ? 'yes (owner)' : 'no',
      free_branding_line: !!b.branding, paused_by_plan: paused.n, note: 'Live bots = Welcome bots + Chat bots switched on; drafts never count.' },
    lead_answers_this_month: { used: ans.used, limit: lim(ans.limit), stops_showing_after: lim(ans.hard), over_limit: ans.over, resets: day(ans.resets_at), note: 'Over the limit (+10%) the bot still says thanks; answers are kept hidden until next month or an upgrade.' },
    cas_builder_builds: builds,
    devices_per_person: b.concurrent_sessions_per_seat,
  };
}

/** The steps of a bot in a few words: "1 welcome message · 2 check they joined 'VIP' · 3 question (email)". */
function stepWords(steps, chats) {
  const trig = { after_previous: 'right away', wait: 'after a wait', on_start: 'when they tap Start', on_button: 'when they tap a button', no_response: 'reminder if no response', on_goal: 'when they reach the invite goal' };
  return steps.map((s, i) => {
    const c = s.config || {};
    let what = 'message';
    if (s.step_type === 'check_join') { const ch = chats.get(String(c.chat_id)); what = `check they joined ${ch ? JSON.stringify(ch) : '(no channel picked)'}`; }
    else if (s.step_type === 'ask') what = `question (${c.answer || 'text'}${c.label ? ': ' + String(c.label).slice(0, 30) : ''})`;
    else if (s.step_type === 'referral') what = `invite friends (goal ${c.goal || 3})`;
    return `${i + 1}. ${what}${i ? ', ' + (trig[s.trigger_type] || s.trigger_type || 'right away') : ''}`;
  });
}

const PAYMENT_AUTO = new Set(['flutterwave', 'gatevoo', 'paystack']);
/**
 * Everything that commonly goes wrong, found automatically, each with a plain fix and a link key for share_link.
 * live: also ask Telegram (token, webhook, admin rights), at most a few calls, rate-limited per workspace.
 */
async function diagnose(scope, { live = true } = {}) {
  const { ws, user } = await scopeRows(scope);
  const P = [];
  // ("problem", not "code": redact() removes keys named code.)
  const add = (problem, severity, what, fix, link = null) => P.push({ problem, severity, what, fix, link });
  const platform = config.telegram.botUsername ? '@' + config.telegram.botUsername : '@CastvooBot';
  const l = await billing.limits(ws);
  const free = billing.isFreePlan(l.plan);
  let liveOk = live && !scope.sandbox;
  if (liveOk && !(await rl.hitShared('diag:' + ws.id, 6, 600)).ok) liveOk = false;

  // Plan and sending.
  try { await billing.assertCanSend(ws); } catch (e) { add('cannot_send', 'high', e.message, 'Top up the wallet and pick a plan; a plan that stopped because the wallet was short starts again by itself once a top-up covers it.', 'topup'); }
  const u = await billing.usage(ws.id);
  if (l.subscribers !== billing.UNLIMITED && Number(l.subscribers) > 0 && u.bot_subscribers >= Number(l.subscribers)) {
    // On Scale the way out is a subscriber pack (or "talk to us" above the most packs), not a bigger plan.
    const pk = await billing.packsInfo(ws, l);
    const fix = pk.can_buy && pk.current < pk.max ? `Add a subscriber pack in Wallet and plan: +${pk.size.toLocaleString('en-US')} bot subscribers for $${pk.price_month}/month (about $${pk.one_now} now for the rest of this period).`
      : pk.top_plan ? `Talk to us about a custom plan (more than ${pk.max_total.toLocaleString('en-US')} subscribers, or a custom deal).` : `Upgrade to a bigger plan${pk.top_plan_name ? ` (${pk.top_plan_name} includes ${pk.top_plan_subscribers.toLocaleString('en-US')} and can add subscriber packs)` : ''}.`;
    add('subscriber_limit', 'high', `${u.bot_subscribers} bot subscribers, the plan allows ${l.subscribers}${l.subscriber_packs ? ` (${l.plan_subscribers} + ${l.subscriber_packs} subscriber packs)` : ''}. Broadcasts pause above the limit + 10% (bots keep answering, new subscribers are saved, nothing is deleted).`, fix,
      pk.can_buy && pk.current < pk.max ? 'subscriber_packs' : pk.top_plan ? 'talk_to_us' : 'plans');
  }
  if (l.connections !== billing.UNLIMITED && u.connections >= Number(l.connections)) add('connection_limit', 'low', `All ${l.connections} connections on the plan are used.`, 'Remove a bot, channel or group you no longer use, or upgrade.', 'channels');
  const meter = await billing.joinMeter(ws);
  if (meter.paused) add('join_limit', 'high', `This month's join requests (${meter.used}) are over the plan limit, so welcomes pause until ${day(meter.resets_at)}. People are still let in.`, 'Upgrade to keep welcoming everyone, or wait for the new month.', 'plans');
  const b = l.bots || billing.botLimitsFor(l.plan, ws.plan_status === 'trial');
  const liveBots = await billing.liveBots(ws.id);
  if (b.max_bots !== billing.UNLIMITED && liveBots >= b.max_bots) add('bot_limit', 'medium', `${liveBots} of ${b.max_bots} live bots are switched on, the most the ${l.plan.name} plan runs.`, 'Switch a bot off first (drafts don\'t count), or upgrade.', 'plans');
  const paused = await db.many("select id, name from sequences where workspace_id = $1 and paused_by_plan and not active and trigger_type in ('join_request','bot_start') order by id limit 5", [ws.id]);
  if (paused.length) add('paused_by_plan', 'medium', `${paused.length} bot${paused.length > 1 ? 's were' : ' was'} switched off when the plan changed: ${paused.map((x) => JSON.stringify(x.name)).join(', ')}.`, 'Upgrade, then switch them on again on the Bots page.', 'bots');
  const ans = await billing.answersMeter(ws);
  if (ans.over) add('lead_answers_over', 'medium', `Lead answers this month (${ans.used}) are over the plan limit. New answers are kept hidden until next month or an upgrade.`, 'Upgrade to see them now; nothing is deleted.', 'plans');
  if (Number(l.ai_writes) > 0 && u.ai_used >= Number(l.ai_writes)) add('ai_writes_out', 'low', `Cas has used all ${l.ai_writes} AI writes this period.`, `They refill on ${day(billing.aiRefillAt(ws)) || 'the next billing date'}. There is never an extra charge.`, 'plans');
  try { const cb = await require('./cas-builder').builds(ws); if (!cb.available) add('cas_builds_out', 'low', 'No Cas Builder builds are left on the plan right now.', 'Keep building in the builder (free), buy Cas credits from the wallet, or upgrade.', 'wallet'); } catch { /* not available */ }
  if (free) {
    const anyLive = await db.one("select 1 from sequences where workspace_id = $1 and active and trigger_type in ('join_request','bot_start') limit 1", [ws.id]);
    if (anyLive) add('free_branding', 'low', 'On the Free plan every welcome ends with "⚡ Free welcome bot by Castvoo.com" (and each Free Chat bot\'s first message with "⚡ Free bot by Castvoo.com"). It links to the owner\'s referral link.', 'It can\'t be removed on Free; any paid plan removes it.', 'plans');
  }

  // Connections.
  const conns = await db.many("select * from connections where workspace_id = $1 and status <> 'removed' order by id", [ws.id]);
  for (const c of conns.filter((x) => x.status === 'error')) {
    add('needs_attention', 'high', `${connName(c)} shows "Needs attention"${c.last_error ? ': ' + c.last_error : ''}.`, c.kind === 'bot' ? 'Paste a fresh token from @BotFather in Channels & bots (subscribers, follow-ups and stats stay).' : `Add ${platform} as an admin of the ${c.kind} again from Channels & bots, with "Post messages".`, 'channels');
  }
  const connections = require('./connections');
  if (liveOk) {
    for (const c of conns.filter((x) => x.kind === 'bot' && x.status !== 'error' && x.token_enc).slice(0, 4)) {
      const token = connections.tokenOf(c);
      try { await tg.call(token, 'getMe'); } catch (e) {
        if (e.code === 401 || e.code === 404) add('token_invalid', 'high', `Telegram says the token of ${connName(c)} is not valid any more (revoked or changed in @BotFather).`, 'Get the token again in @BotFather (/token) and paste it in Channels & bots. Subscribers stay.', 'channels');
        continue;
      }
      try {
        const info = await tg.call(token, 'getWebhookInfo');
        if (info.url !== `${config.appUrl}/tg/b/${c.id}`) add('webhook_taken', 'high', `${connName(c)} is not listening to Castvoo: ${info.url ? 'another program set its own webhook' : 'its webhook was removed (another program may be reading it with getUpdates)'}. New subscribers and taps are not seen.`, `Stop using this token in other tools or scripts, then let support re-point it (repair_webhook, after the customer says yes) or paste the token again. connection_id ${c.id}.`, 'channels');
        else if (info.last_error_date && Date.now() / 1000 - info.last_error_date < 3600) add('webhook_errors', 'medium', `Telegram reported a recent delivery error for ${connName(c)}: ${info.last_error_message || 'unknown'}.`, 'Usually temporary. If it keeps happening, re-point the webhook (repair_webhook).', null);
      } catch { /* Telegram unreachable: skip */ }
    }
  }

  // Bots: Welcome bots need their own bot as admin with "Add members"; join checks need the bot admin in that channel.
  const seqs = await db.many(`select q.*, c.username, c.tg_chat_id as bot_tg_id, c.status as cstatus from sequences q join connections c on c.id = q.connection_id
    where q.workspace_id = $1 and c.status <> 'removed' and q.trigger_type in ('join_request','bot_start') order by q.active desc, q.id desc limit 40`, [ws.id]);
  const byId = new Map(conns.map((c) => [String(c.id), c]));
  const byChat = new Map(conns.filter((c) => c.kind !== 'bot').map((c) => [String(c.tg_chat_id), c]));
  let checks = 0;
  const flowsSvc = require('./flows'), botsSvc = require('./bots');
  for (const q of seqs.filter((x) => x.active)) {
    const bot = byId.get(String(q.connection_id));
    if (q.trigger_type === 'join_request') {
      const chat = byChat.get(String(q.trigger_value));
      if (!chat) { add('welcome_no_channel', 'high', `Welcome bot "${q.name}" is live but its channel is not connected any more.`, 'Connect the channel again, or open the bot and pick another channel.', 'bot:' + q.id); continue; }
      if (liveOk && bot && checks < 4) {
        checks++;
        const r = await flowsSvc.checkAdmin(bot, chat).catch(() => ({ ok: true }));
        if (!r.ok) add('welcome_bot_not_admin', 'high', r.message, 'Telegram only sends join requests to admins who can let people in. After fixing it in Telegram, ask support to check again.', 'bot:' + q.id);
      }
      const jr = await db.one('select count(*)::int n, max(requested_at) last from join_requests where sequence_id = $1', [q.id]);
      const ageH = (Date.now() - new Date(q.updated_at || q.created_at).getTime()) / 3600000;
      if (!jr.n && ageH > 24) add('no_join_requests', 'medium', `Welcome bot "${q.name}" has been live for over a day with no join requests on "${chat.title || 'the channel'}".`, 'Likely the invite link people use does not have "Approve new members" (join requests) on. In Telegram: the channel → Invite links → edit the link → turn on "Approve new members". Also share that link, not a public @username.', 'bot:' + q.id);
      const wf = await db.one("select count(*)::int n, max(error) err from join_requests where sequence_id = $1 and welcome = 'failed' and requested_at > now() - interval '7 days'", [q.id]);
      if (wf.n) add('welcome_failed', 'medium', `${wf.n} welcome${wf.n > 1 ? 's' : ''} from "${q.name}" could not be sent in the last 7 days${wf.err ? ' (' + (plainError(wf.err) || wf.err) + ')' : ''}.`, 'Check the bot is still an admin with "Add members" and its token works.', 'bot:' + q.id);
    } else {
      const steps = await db.many("select config from sequence_steps where sequence_id = $1 and variant = 0 and step_type = 'check_join'", [q.id]);
      for (const s of steps) {
        const chat = byId.get(String((s.config || {}).chat_id));
        if (!chat) { add('check_no_channel', 'high', `Chat bot "${q.name}" checks a channel that is not connected any more.`, 'Open the bot and pick the channel again in the ✅ Check they joined step.', 'bot:' + q.id); continue; }
        if (liveOk && bot && checks < 4) {
          checks++;
          const r = await botsSvc.checkCanCheck(bot, chat).catch(() => ({ ok: true }));
          if (!r.ok) add('check_bot_not_admin', 'high', r.message, 'Without admin rights the bot can\'t see who joined, so everyone gets "you haven\'t joined yet".', 'bot:' + q.id);
        }
      }
    }
  }
  // Start-code clash: a draft Chat bot with the same start link (or plain Start) as a live one on the same Telegram bot.
  for (const d of seqs.filter((x) => !x.active && x.trigger_type === 'bot_start')) {
    const other = seqs.find((x) => x.active && x.trigger_type === 'bot_start' && Number(x.connection_id) === Number(d.connection_id) && (String(x.trigger_value).toLowerCase() === String(d.trigger_value).toLowerCase() || (d.is_default && x.is_default)));
    if (other) add('start_code_clash', 'low', `Draft "${d.name}" uses the same ${String(other.trigger_value).toLowerCase() === String(d.trigger_value).toLowerCase() ? 'start link (' + d.trigger_value + ')' : 'plain Start'} as live bot "${other.name}" on @${d.username}.`, 'Give the draft its own start code, or switch to it (switching it on offers to replace the live one).', 'bot:' + d.id);
  }
  for (const w of await botsSvc.ownershipWarnings(ws.id).catch(() => [])) add('team_telegram_tip', 'low', w.message, 'Nothing is blocked; it just shows the bot belongs to the team.', null);
  const drip = await db.one("select count(*)::int n from sequences where workspace_id = $1 and paused_by_plan and not active and trigger_type not in ('join_request','bot_start')", [ws.id]);
  if (drip.n) add('follow_ups_off_by_plan', 'medium', `${drip.n} auto follow-up${drip.n > 1 ? 's were' : ' was'} switched off by a plan change.`, 'Auto follow-ups are on Starter and up. Upgrade, then switch them on again.', 'follow_ups');

  // Broadcasts.
  const bl = await db.one(`select count(*) filter (where d.status = 'blocked' or d.error ilike '%blocked by the user%')::int blocked, count(*)::int total
    from deliveries d where d.workspace_id = $1 and d.broadcast_id is not null and d.created_at > now() - interval '14 days'`, [ws.id]);
  if (bl.blocked >= 20 && bl.blocked / Math.max(1, bl.total) >= 0.05) add('many_blocked', 'medium', `${bl.blocked} of ${bl.total} broadcast messages in the last 14 days failed because people blocked the bot.`, 'A few percent is normal. Send less often, keep the "Stop these messages" button on, and set "Most messages one person gets per day" to 2 or 3 in Settings → Workspace.', 'settings');
  const fb = await db.many("select id, title from broadcasts where workspace_id = $1 and status = 'failed' and created_at > now() - interval '14 days' order by id desc limit 3", [ws.id]);
  if (fb.length) add('broadcast_failed', 'medium', `Broadcast${fb.length > 1 ? 's' : ''} that failed: ${fb.map((x) => JSON.stringify(x.title || '#' + x.id)).join(', ')}.`, 'Run get_broadcasts for the reasons (often a paused plan at send time, or the bot lost its rights).', 'send');
  const stuck = await db.one("select count(*)::int n from broadcasts where workspace_id = $1 and status = 'sending' and started_at < now() - interval '3 hours' and sent = 0", [ws.id]);
  if (stuck.n) add('broadcast_stuck', 'high', 'A broadcast shows "Sending" for over 3 hours with nothing delivered.', 'Hand it to the technical team with the broadcast name.', null);
  // Repeating messages that skipped their last send (plan paused, over the plan's repeating messages, connection broken).
  const skipped = await db.many("select id, title, last_error from repeat_series where workspace_id = $1 and status = 'active' and last_skip_at > now() - interval '7 days' and last_error is not null and (last_run_at is null or last_skip_at > last_run_at) order by id limit 3", [ws.id]);
  for (const r of skipped) add('repeat_skipped', 'medium', `Repeating message "${r.title}" skipped its last send: ${r.last_error}`, 'It carries on by itself at the next time once the reason is fixed (missed sends are never sent late). get_repeats shows the schedule.', 'repeats');
  const conv = await db.one("select count(*)::int n from media_conversions where workspace_id = $1 and not ok and created_at > now() - interval '7 days'", [ws.id]);
  if (conv.n) add('media_conversion_failed', 'low', `${conv.n} voice note or round video upload${conv.n > 1 ? 's' : ''} could not be converted in the last 7 days.`, 'Record again, or upload an MP3/M4A/OGG for voice and a short MP4 for a round video. If it says conversion isn\'t set up, hand it to the technical team.', 'send');

  // Payments (status only).
  const pays = await db.many("select reference, provider, status, reason, created_at, amount_cents from payments where workspace_id = $1 and created_at > now() - interval '30 days' order by id desc limit 10", [ws.id]);
  for (const p of pays.filter((x) => x.status === 'pending' && PAYMENT_AUTO.has(x.provider) && Date.now() - new Date(x.created_at).getTime() > 10 * 60000).slice(0, 2)) add('payment_pending', 'medium', `Top-up ${p.reference} (${usd(p.amount_cents)}, ${providerLabel(p.provider)}) is still pending.`, 'recheck_payment asks the provider again; the wallet is credited only if they confirm it.', 'wallet');
  for (const p of pays.filter((x) => x.status === 'pending' && MANUAL.has(x.provider)).slice(0, 2)) add('manual_payment_pending', 'low', `Manual top-up ${p.reference} (${usd(p.amount_cents)}) waits for the finance team.`, 'They confirm by hand, usually within a few hours. If they paid and sent proof long ago, hand it to finance.', 'wallet');
  for (const p of pays.filter((x) => ['failed', 'rejected'].includes(x.status)).slice(0, 2)) add('payment_failed', 'low', `Top-up ${p.reference} ${p.status}${p.reason ? ': ' + p.reason : ''}.`, 'Try again (the right amount and network for crypto), or another method in Wallet → Top up.', 'topup');

  // Account.
  if (user.email && !user.email_verified) add('email_not_verified', 'low', 'The account email is not verified yet.', 'resend_email_verification sends a new code (after the customer says yes); they type it in Settings → Profile.', 'profile');
  const devs = await db.one('select count(*)::int n from sessions where user_id = $1 and expires_at > now()', [user.id]);
  const per = b.concurrent_sessions_per_seat || 2;
  if (devs.n >= per) add('devices_full', 'low', `Logged in on ${devs.n} devices, the most per person (${per}). One more login logs out the oldest.`, 'Teammates should use their own login (seats) or the free setup helper.', 'security');

  const order = { high: 0, medium: 1, low: 2 };
  P.sort((a, b2) => order[a.severity] - order[b2.severity]);
  return { checked_with_telegram: liveOk, problems: P, all_good: !P.some((p) => p.severity !== 'low'), plan: l.plan.name };
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
      const helperInvite = await db.one("select created_at, expires_at from invites where workspace_id = $1 and role = 'helper' and accepted_at is null and expires_at > now() order by created_at desc limit 1", [ws.id]).catch(() => null);
      const helperRow = members.find((m) => m.role === 'helper');
      const extra = Number(ws.extra_seats) || 0;
      return {
        you_are_role: ROLE_NAMES[scope.role] || scope.role,
        setup_helper: { has_one: !!helperRow, name: helperRow ? (helperRow.name || '').split(' ')[0] || 'Helper' : null, invite_waiting: !!helperInvite, invite_expires: helperInvite ? day(helperInvite.expires_at) : null,
          can_send_broadcasts: ws.helper_send !== false, can_manage_billing: !!ws.helper_billing },
        extra_seats: extra,
        subscriber_packs: Number(ws.subscriber_packs) || 0,
        custom_subscriber_limit: ws.custom_subscriber_limit || null,
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
    description: 'Ask the payment provider again whether a top-up was paid. For Flutterwave and Gatevoo (and old Paystack payments, from before Paystack was removed) the wallet is credited automatically ONLY if the provider confirms it. For manual methods (bank transfer, mobile money, USDT sent by hand) this only shows the status: the finance team confirms those.',
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
        bot_subscribers: { used: u.bot_subscribers, limit: l.subscribers, limit_with_grace: billing.withGrace(Number(l.subscribers)), plan_includes: l.plan_subscribers, note: 'Channel and group members do not count. Over the limit + 10%: broadcasts pause, bots keep answering, new subscribers are saved, nothing is deleted.' },
        subscriber_packs: await (async () => {
          const pk = await billing.packsInfo(ws, l);
          return { has: pk.current, from_next_renewal: pk.pending, can_buy: pk.can_buy, why_not: pk.reason, pack_size: pk.size, price_a_month: pk.price_month, most_packs: pk.max,
            one_more_now_costs: pk.one_now, renews_for: pk.renews, custom_limit_from_team: pk.custom_limit, above_this_talk_to_us: pk.max_total, link_key: pk.can_buy ? 'subscriber_packs' : pk.top_plan ? 'talk_to_us' : 'plans' };
        })(),
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
        ...(await botsUsage(ws, l, lim)),
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
        connections: rows.map((c) => ({ id: c.id, kind: c.kind, name: connName(c), username: c.username ? '@' + c.username : null, title: c.kind === 'bot' ? null : c.title || null,
          status: c.status === 'error' ? 'needs attention' : c.status, last_error: c.last_error || null, reach: c.reach, members: c.kind === 'bot' ? null : c.member_count,
          failed_last_7_days: c.failed_7d, waiting_to_send: c.queued, connected_at: day(c.created_at) })),
        tip: 'For token, webhook and admin-rights health, run test_connection (one) or diagnose_account (everything).',
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
    description: "Point a connected bot's webhook at Castvoo again (the same step Castvoo does when you connect a bot). Keeps subscribers, follow-ups and pending updates. Bots only. It CHANGES the bot: first ask the customer and get a clear yes; the system only runs it after they agreed in their own message.",
    parameters: S({ connection_id: { type: 'integer', description: 'id of a bot from get_connections' } }, ['connection_id']),
    write: true,
    owner: true, // the dashboard keeps reconnecting bots for the workspace owner
    confirm: true,
    async prepare(scope, input) {
      const c = await myConnection(scope, input.connection_id);
      if (!c) return { stop: { found: false, message: 'No connection with that id in this workspace.' } };
      if (c.kind !== 'bot') return { stop: { id: c.id, repaired: false, message: `Channels and groups have no webhook. If posting fails, add @${config.telegram.botUsername} as admin again.` } };
      return { key: String(c.id), ask: `Point @${c.username || 'your bot'} back at Castvoo (re-register its webhook)? Subscribers, follow-ups and stats stay. If another tool uses the same token, it stops getting updates.` };
    },
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
          top_errors: errs.map((e) => errLine(e.error, e.n)) });
      }
      return { broadcasts: out, note: 'Telegram gives bots no read receipts, so there are no read numbers. "Blocked the bot" failures are people who blocked it: a few percent is normal.' };
    },
  },

  get_repeats: {
    description: 'Repeating messages ("Repeat this message"): schedule, status (running, paused, waiting for approval, ended, stopped), next send in the workspace time zone, which version goes next (rotating versions), how many times sent, the last skip reason (plan paused, over the plan, missed while paused), auto-delete / auto-pin settings, the last runs (broadcast ids for message:<id> links) and the plan limit. Also voice note / round video conversions that failed lately.',
    parameters: S(),
    async run(scope) {
      const R = require('./repeats');
      const { ws } = await scopeRows(scope);
      const all = await R.list(ws, { days: 7 });
      const out = [];
      for (const s of all.series.slice(0, 15)) {
        const runs = await db.many('select id, status, total, sent, failed, run_date from broadcasts where series_id = $1 order by id desc limit 3', [s.id]);
        out.push({ id: s.id, name: s.title, status: s.status, to: s.connection ? connName(s.connection) : null, schedule: s.schedule, timezone: s.timezone,
          next_send: s.next_label, versions: s.versions.length, next_version: s.versions.length > 1 ? `version ${s.next_version + 1} of ${s.versions.length} (${s.rotation === 'random' ? 'random order, no repeats' : 'in order'})` : null,
          sent_times: s.runs, last_sent: day(s.last_run_at), last_skipped: day(s.last_skip_at), last_problem: s.last_error,
          delete_after_hours: s.delete_after_hours, pin: s.pin ? { notify: s.pin_notify, unpin_after_hours: s.unpin_after_hours } : false,
          media: s.versions.filter((v) => v.media).map((v) => v.media.kind),
          last_runs: runs.map((b) => ({ broadcast_id: b.id, date: b.run_date, status: b.status, delivered: b.sent, failed: b.failed })) });
      }
      const conv = await db.many("select kind, error, created_at from media_conversions where workspace_id = $1 and not ok and created_at > now() - interval '14 days' order by id desc limit 5", [ws.id]);
      const ff = await require('./media-convert').detect();
      return {
        repeating_messages: out,
        plan_limit: { running_now: all.limit.active, most_at_once: all.limit.max === -1 ? `unlimited (fair use ${all.limit.fair_use})` : all.limit.max },
        failed_voice_or_round_video_conversions_14d: conv.map((c) => ({ kind: c.kind === 'voice' ? 'voice note' : 'round video', at: day(c.created_at), why: /not set up/.test(c.error || '') ? 'conversion is not set up on the server (team issue)' : 'the file could not be converted' })),
        conversion_ready_on_server: ff.ok,
        note: 'Runs missed while paused, while the plan could not send or during an outage are skipped, never sent late. Paused series do not count toward the plan limit. Telegram lets bots delete messages for 48 hours, so auto-delete is 1 to 47 hours.',
      };
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
          (select coalesce(json_agg(s.trigger_type order by s.position), '[]') from sequence_steps s where s.sequence_id = q.id and s.variant = 0) triggers,
          (select count(*)::int from sequence_runs r where r.sequence_id = q.id and r.status = 'awaiting') awaiting_tap,
          (select count(*)::int from sequence_runs r where r.sequence_id = q.id and r.status = 'active') running,
          (select count(*)::int from sequence_runs r where r.sequence_id = q.id and r.status = 'waiting') waiting_start,
          (select count(*)::int from sequence_runs r where r.sequence_id = q.id and r.status = 'done') finished,
          (select count(*)::int from deliveries d join sequence_steps s on s.id = d.step_id where s.sequence_id = q.id and d.status = 'sent' and d.created_at > now() - interval '7 days') sent_7d,
          (select count(*)::int from deliveries d join sequence_steps s on s.id = d.step_id where s.sequence_id = q.id and d.status = 'failed' and d.created_at > now() - interval '7 days') failed_7d
        from sequences q join connections c on c.id = q.connection_id where q.workspace_id = $1 and c.status <> 'removed' order by q.active desc, q.id desc limit 30`, [scope.workspaceId]);
      const trig = { start: 'someone presses Start', start_tag: 'Start through a start link', join_request: 'someone asks to join', tag: 'a subscriber gets a tag' };
      const modes = { instant: 'straight away', after_welcome: 'after the welcome', tap: 'when they tap Start in the bot', manual: 'the owner decides (Requests tab)' };
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
            people_waiting_to_press_start: q.waiting_start, people_waiting_for_a_tap: q.awaiting_tap,
            // When each message comes: right_away, wait, when_they_tap_start, when_they_tap_a_button, reminder_if_no_response.
            when_each_message_comes: (q.triggers || []).map((t, i) => (i === 0 ? 'welcome' : ({ after_previous: 'right_away', wait: 'after_a_wait', on_start: 'when_they_tap_start', on_button: 'when_they_tap_a_button', no_response: 'reminder_if_no_response' })[t] || t)),
            ...j, last_join_error: err ? err.error : null });
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
    description: "Send a fresh verification code to the customer's own account email (only if it is not verified yet), through the normal Settings flow. The code goes only to their inbox; you never see it. Ask first; it runs only after the customer says yes.",
    parameters: S(),
    write: true,
    confirm: true,
    async prepare(scope) {
      const { user } = await scopeRows(scope);
      if (!user.email) return { stop: { sent: false, message: 'There is no email on this account yet. Add one in Settings → Profile.' } };
      if (user.email_verified) return { stop: { sent: false, already_verified: true, email: maskEmail(user.email) } };
      return { key: 'verify', ask: `Send a new verification code to ${maskEmail(user.email)}?` };
    },
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

  get_bots: {
    description: 'All Bots (🤖 Bots page): Welcome bots (join requests) and Chat bots (start links): id, kind and template type, live / draft / paused by plan, which Telegram bot and channel, start link, the steps in a few words, people started, leads (answers), invite stats, join requests and recent errors. Pass bot_id for one bot only.',
    parameters: S({ bot_id: { type: 'integer', description: 'optional: one bot id from an earlier get_bots' } }),
    async run(scope, input) {
      const { ws } = await scopeRows(scope);
      const one = Number(input.bot_id) > 0 ? Number(input.bot_id) : null;
      const rows = await db.many(`select q.id, q.name, q.trigger_type, q.trigger_value, q.active, q.paused_by_plan, q.is_default, q.bot_type, q.approve_mode, q.start_button, q.created_at, q.updated_at,
          c.id as conn_id, c.username, c.status as cstatus,
          (select count(*)::int from sequence_runs r where r.sequence_id = q.id) started,
          (select count(*)::int from sequence_runs r where r.sequence_id = q.id and r.status = 'awaiting') waiting_on_a_step,
          (select count(distinct a.subscriber_id)::int from bot_answers a where a.sequence_id = q.id) people_answered,
          (select count(*)::int from bot_answers a where a.sequence_id = q.id and a.created_at >= date_trunc('month', now())) answers_this_month,
          (select count(*)::int from bot_answers a where a.sequence_id = q.id and a.hidden) answers_hidden_over_limit,
          (select count(*)::int from bot_referrals x where x.sequence_id = q.id and x.counted) invites_counted,
          (select coalesce(json_object_agg(t.reason, t.n), '{}') from (select coalesce(reason, 'other') reason, count(*)::int n from bot_referrals x where x.sequence_id = q.id and not x.counted group by 1) t) invites_not_counted,
          (select count(*)::int from bot_invites i where i.sequence_id = q.id and i.reached_at is not null) reached_invite_goal,
          (select count(*)::int from join_requests j where j.sequence_id = q.id) join_requests,
          (select max(j.requested_at) from join_requests j where j.sequence_id = q.id) last_join_request,
          (select count(*)::int from deliveries d join sequence_steps s on s.id = d.step_id where s.sequence_id = q.id and d.status = 'failed' and d.created_at > now() - interval '7 days') failed_7d
        from sequences q join connections c on c.id = q.connection_id
        where q.workspace_id = $1 and c.status <> 'removed' and q.trigger_type in ('join_request','bot_start') ${one ? 'and q.id = $2' : ''}
        order by q.active desc, q.id desc limit 40`, one ? [ws.id, one] : [ws.id]);
      if (one && !rows.length) return { found: false, message: 'No bot with that id in this workspace. Call get_bots without bot_id.' };
      const chats = await db.many("select id, tg_chat_id, title, username from connections where workspace_id = $1 and kind <> 'bot' and status <> 'removed'", [ws.id]);
      const chatName = new Map(chats.map((c) => [String(c.id), c.title || (c.username ? '@' + c.username : 'channel')]));
      const byTg = new Map(chats.map((c) => [String(c.tg_chat_id), c.title || (c.username ? '@' + c.username : 'channel')]));
      const flowsSvc = require('./flows');
      const out = [];
      for (const q of rows) {
        const steps = await db.many('select step_type, trigger_type, config from sequence_steps where sequence_id = $1 and variant = 0 order by position', [q.id]);
        const errs = q.failed_7d ? await db.many(`select coalesce(d.error, 'unknown') error, count(*)::int n from deliveries d join sequence_steps s on s.id = d.step_id where s.sequence_id = $1 and d.status = 'failed' and d.created_at > now() - interval '7 days' group by 1 order by 2 desc limit 3`, [q.id]) : [];
        const welcome = q.trigger_type === 'join_request';
        out.push({
          id: q.id, name: q.name, kind: welcome ? 'Welcome bot' : 'Chat bot', type: q.bot_type || (welcome ? 'welcome' : null),
          status: q.active ? 'live' : q.paused_by_plan ? 'paused by plan' : 'draft', telegram_bot: '@' + (q.username || 'bot'), telegram_bot_status: q.cstatus === 'error' ? 'needs attention' : q.cstatus,
          ...(welcome ? { channel: byTg.get(String(q.trigger_value)) || 'not connected any more', how_people_get_in: q.approve_mode, tap_start_button: q.start_button, join_requests: q.join_requests, last_join_request: day(q.last_join_request) }
            : { start_link: q.username ? flowsSvc.startUrl({ username: q.username }, q.trigger_value) : null, answers_plain_start: !!q.is_default }),
          steps: stepWords(steps, chatName), people_started: q.started, waiting_on_a_check_or_question: q.waiting_on_a_step,
          ...(steps.some((s) => s.step_type === 'ask') ? { leads: { people: q.people_answered, answers_this_month: q.answers_this_month, hidden_over_limit: q.answers_hidden_over_limit } } : {}),
          ...(steps.some((s) => s.step_type === 'referral') ? { invites: { counted: q.invites_counted, not_counted_by_reason: q.invites_not_counted, reached_goal: q.reached_invite_goal } } : {}),
          failed_7d: q.failed_7d, top_errors: errs.map((e) => errLine(e.error, e.n)), updated_at: day(q.updated_at),
        });
      }
      return { bots: out, link_keys: 'share_link with bot:<id>, bot_leads:<id>, bot_invites:<id>, bot_requests:<id>', tip: 'check_bot_setup asks Telegram whether a bot is set up right (admin rights, token, webhook).' };
    },
  },

  check_bot_setup: {
    description: "Live check of one Bot with Telegram (read-only, changes nothing): the Telegram bot's token and webhook, for a Welcome bot whether it is an admin of the channel with \"Add members\", for a Chat bot's ✅ Check they joined steps whether it is an admin of each channel (the same check as the builder), and start-link clashes. Use it to re-check admin rights after the customer fixed them.",
    parameters: S({ bot_id: { type: 'integer', description: 'Bot id from get_bots' } }, ['bot_id']),
    async run(scope, input) {
      const id = Number(input.bot_id);
      const q = Number.isInteger(id) && id > 0 ? await db.one("select * from sequences where id = $1 and workspace_id = $2 and trigger_type in ('join_request','bot_start')", [id, scope.workspaceId]) : null;
      if (!q) return { found: false, message: 'No bot with that id in this workspace. Use get_bots.' };
      const bot = await db.one("select * from connections where id = $1 and workspace_id = $2 and status <> 'removed'", [q.connection_id, scope.workspaceId]);
      if (!bot) return { id: q.id, ok: false, problems: ['Its Telegram bot is not connected any more. Connect it again in Channels & bots.'] };
      if (!scope.sandbox && !(await rl.hitShared('botcheck:' + q.id, 8, 600)).ok) return { id: q.id, message: 'Checked several times just now. Wait a minute.' };
      const problems = [], fine = [];
      if (scope.sandbox) return { id: q.id, sandbox: true, message: 'Sandbox: Telegram was not asked.' };
      const token = require('./connections').tokenOf(bot);
      try { await tg.call(token, 'getMe'); fine.push(`the token of @${bot.username} works`); } catch (e) {
        problems.push(e.code === 401 || e.code === 404 ? `Telegram says the token of @${bot.username} is not valid any more. Paste a fresh token from @BotFather in Channels & bots.` : 'Telegram could not be reached just now.');
        return { id: q.id, name: q.name, ok: false, problems, fine };
      }
      try {
        const info = await tg.call(token, 'getWebhookInfo');
        if (info.url === `${config.appUrl}/tg/b/${bot.id}`) fine.push('it listens to Castvoo');
        else problems.push(`@${bot.username} is not listening to Castvoo (another program took it over). repair_webhook can fix it after the customer says yes (connection_id ${bot.id}).`);
      } catch { /* skip */ }
      if (q.trigger_type === 'join_request') {
        const chat = await db.one("select * from connections where workspace_id = $1 and kind <> 'bot' and status <> 'removed' and tg_chat_id::text = $2", [scope.workspaceId, q.trigger_value || '']);
        if (!chat) problems.push('Its channel or group is not connected any more.');
        else { const r = await require('./flows').checkAdmin(bot, chat); if (r.ok) fine.push(`@${bot.username} is an admin of "${chat.title}" and can let people in`); else problems.push(r.message); }
      } else {
        const steps = await db.many("select config from sequence_steps where sequence_id = $1 and variant = 0 and step_type = 'check_join'", [q.id]);
        for (const s of steps) {
          const chat = await db.one("select * from connections where id = $1 and workspace_id = $2 and kind <> 'bot' and status <> 'removed'", [Number((s.config || {}).chat_id) || 0, scope.workspaceId]);
          if (!chat) { problems.push('A ✅ Check they joined step points at a channel that is not connected any more.'); continue; }
          const r = await require('./bots').checkCanCheck(bot, chat);
          if (r.ok) fine.push(`@${bot.username} can check who joined "${chat.title}"`); else problems.push(r.message);
        }
        const clash = await require('./bots').botClash({ id: scope.workspaceId }, bot.id, q.trigger_value, q.is_default, q.id);
        if (clash) problems.push(`Live bot "${clash.name}" already uses ${clash.why === 'code' ? 'this start link' : 'the plain Start'} on @${bot.username}. Only one can be live with it.`);
      }
      return { id: q.id, name: q.name, ok: !problems.length, problems, fine };
    },
  },

  diagnose_account: {
    description: 'Checks the whole workspace for the common problems at once and returns each with a plain fix and a link key: plan paused or limits hit (live bots, subscribers, join requests, lead answers, AI writes, Cas builds), bots paused by plan, Needs attention, bot token not valid, webhook taken by another program, own bot not admin of the channel (Welcome bots) or of the checked channel (join checks), no join requests (invite link without "Approve new members"), failed welcomes, start-link clashes, many people blocking the bot, failed or stuck broadcasts, repeating messages that skipped a send, voice notes or round videos that could not be converted, pending or failed payments, the Free plan branding line, unverified email, devices limit. Read-only. Use it first when something "doesn\'t work".',
    parameters: S(),
    async run(scope) { return diagnose(scope, { live: true }); },
  },

  get_security: {
    description: "The customer's own login security: how many devices are logged in now (device, browser, country, last active; never IP addresses), the most per person on the plan, recent new-login alerts and new devices.",
    personal: false,
    parameters: S(),
    async run(scope) {
      const { user } = await scopeRows(scope);
      const list = await require('./security').list(user.id, null);
      const alerts = await db.many("select created_at, status from email_log where user_id = $1 and template = 'new_login' and created_at > now() - interval '30 days' order by id desc limit 5", [user.id]);
      const per = await billing.sessionsPerSeat(user.id).catch(() => 2);
      return {
        devices_logged_in: list.length, most_per_person: per,
        devices: list.slice(0, 6).map((d) => ({ device: d.device, country: d.country_name, first_seen: day(d.created_at), last_active: day(d.last_seen_at) })),
        new_login_alerts_30d: alerts.map((a) => ({ at: day(a.created_at), email: a.status })),
        telegram_alerts_on: user.login_alert_tg !== false && !!user.tg_user_id,
        how_to: 'Settings → Security: "Log out" one device or "Log out all other devices". You cannot log devices out for them.',
      };
    },
  },

  get_cas_builder: {
    description: 'Cas Builder (build a bot by chatting with Cas): builds included, used and left this month (Free: lifetime), Cas credits bought, whether Cas is resting today, and the recent Cas Builder chats (new or edit, open / saved, which bot, whether it counted as a build).',
    parameters: S(),
    async run(scope) {
      const { ws } = await scopeRows(scope);
      const cb = require('./cas-builder');
      const x = await cb.builds(ws);
      const cf = await cb.conf();
      const rows = await db.many(`select s.id, s.kind, s.status, s.counted_at, s.paid_by, s.updated_at, s.flow_id, q.name from cas_sessions s left join sequences q on q.id = s.flow_id
        where s.workspace_id = $1 order by s.updated_at desc limit 6`, [ws.id]);
      return {
        builds: { included: x.unlimited ? 'unlimited (fair use ' + (x.fair || 'about 500') + ' a month)' : x.limit, period: x.period, used: x.used, left: x.left < 0 ? 'unlimited' : x.left, credits: x.credits, resets: day(x.resets_at), can_build_now: x.available },
        credit_pack: Number(cf.credit_pack_price_cents) > 0 ? `${cf.credit_pack_builds} builds for ${usd(cf.credit_pack_price_cents)} from the wallet (cash, not bonus; never expire)` : 'not sold right now',
        resting_today: await cb.resting().catch(() => false),
        sessions: rows.map((r) => ({ kind: r.kind === 'edit' ? 'changing a saved bot (never counts)' : 'new bot', status: r.status, bot: r.name || null, bot_id: r.flow_id || null, counted_as_build: !!r.counted_at, paid_by: r.paid_by, last_used: day(r.updated_at) })),
      };
    },
  },

  toggle_bot: {
    description: 'Switch one Bot on (live) or off (draft), with every check the Bots page does (plan limits, admin rights, one live bot per channel or start link). It CHANGES the account: first explain what will happen and get a clear yes; the system only runs it after the customer agreed in their own message. Not for drafts-only members.',
    parameters: S({ bot_id: { type: 'integer', description: 'Bot id from get_bots' }, on: { type: 'boolean', description: 'true = switch on, false = switch off' } }, ['bot_id', 'on']),
    write: true,
    confirm: true,
    async prepare(scope, input) {
      if (scope.role === 'drafter') return { stop: { done: false, not_allowed: true, message: 'Drafts-only members can\'t switch bots on or off. Ask the owner.' } };
      const q = await db.one("select id, name, active from sequences where id = $1 and workspace_id = $2 and trigger_type in ('join_request','bot_start')", [Number(input.bot_id) || 0, scope.workspaceId]);
      if (!q) return { stop: { found: false, message: 'No bot with that id in this workspace. Use get_bots.' } };
      const on = input.on === true || input.on === 'true';
      if (q.active === on) return { stop: { id: q.id, already: true, status: on ? 'live' : 'draft', message: `"${q.name}" is already ${on ? 'live' : 'switched off'}.` } };
      return { key: `${q.id}:${on ? 1 : 0}`, ask: `Switch ${on ? 'ON' : 'OFF'} the bot "${q.name}"${on ? '' : ' (people stop getting it until it is switched on again; nothing is deleted)'}?` };
    },
    async run(scope, input) {
      const q = await db.one('select * from sequences where id = $1 and workspace_id = $2', [Number(input.bot_id) || 0, scope.workspaceId]);
      const on = input.on === true || input.on === 'true';
      if (scope.sandbox) return { id: q.id, done: false, sandbox: true, message: 'Sandbox: nothing was changed.' };
      if (!on) { await db.query('update sequences set active = false, paused_by_plan = false, updated_at = now() where id = $1 and workspace_id = $2', [q.id, scope.workspaceId]); return { id: q.id, name: q.name, done: true, status: 'draft' }; }
      try {
        const ws = await db.one('select * from workspaces where id = $1', [scope.workspaceId]);
        await require('../routes/flows').switchOn(ws, q, false);
        return { id: q.id, name: q.name, done: true, status: 'live' };
      } catch (e) { return { id: q.id, name: q.name, done: false, why: e.message }; }
    },
  },

  share_link: {
    description: 'Send the customer a tappable link card that opens the exact place: a dashboard page, one of their bots, a video guide, a help article, a blog post, a legal page or a Zedapex site. Only keys from the list work (any other web address is refused). The card appears under your next message, so say in words what it opens. Keys:\n' + require('./support-links').keysText(),
    parameters: S({ key: { type: 'string', description: 'e.g. "topup", "bot:12", "guide:connect-bot", "article:wallet", "site:joinvoo"' }, label: { type: 'string', description: 'optional short button text' }, url: { type: 'string', description: 'instead of key: a Castvoo dashboard link (#app/...) or a Zedapex site home page; anything else is refused' } }),
    async run(scope, input) {
      const r = await require('./support-links').resolve({ key: input.key, label: input.label, url: input.url }, scope);
      return r.ok ? { ok: true, card: r.card, shown: 'The card shows under your reply.' } : { ok: false, refused: true, reason: r.reason };
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

/*
 * "Yes" in the customer's own words (English, Pidgin, French, Portuguese, Spanish, Swahili). A message with a "no",
 * "wait", "don't"... is never a yes.
 */
const YES_RX = /^(?:(?:yes|yeah|yea|yep|yup|ya|ok|okay|okey|k|sure|alright|all right|go ahead|go on|please do|do it|do am|abeg do am|oya|oya do am|confirm|confirmed|proceed|sounds good|correct|right|exactly|please|pls|abeg|yes please|ok please|yes do it|na so|e don do|make you do am|oui|d'accord|vas-y|sim|pode|claro|sí|si|vale|dale|ndiyo|sawa)\b[\s,.!👍🙏]*)+(?:(?:please|pls|abeg|thanks|thank you|go ahead|do it|now|o|sir|ma|boss)\b[\s,.!👍🙏]*)*$/i;
const NO_RX = /\b(no|not|don'?t|dont|do not|wait|stop|cancel|later|hold on|never|abeg no|non|não|nao|hapana)\b/i;
function saidYes(text) {
  const t = String(text || '').normalize('NFKC').replace(/[‘’]/g, "'").trim().toLowerCase();
  if (!t || t.length > 80 || NO_RX.test(t)) return false;
  return YES_RX.test(t) || /^👍+$/.test(t);
}

async function confirmGate(name, tool, args, prep, scope) {
  if (!scope.threadId) return { done: false, needs_confirmation: true, ask: prep.ask, message: 'This can only be done from the support chat.' };
  const key = String(prep.key || '').slice(0, 200);
  const pending = await db.one(`select * from support_ai_actions where thread_id = $1 and tool = $2 and input_key = $3 and used_at is null and expires_at > now()
    order by id desc limit 1`, [scope.threadId, name, key]);
  const yesAt = scope.customerAt ? new Date(scope.customerAt) : null;
  if (pending && yesAt && new Date(pending.created_at) < yesAt && saidYes(scope.customerText)) {
    const used = await db.one('update support_ai_actions set used_at = now() where id = $1 and used_at is null returning id', [pending.id]);
    if (used) return { ...(await tool.run(scope, args)), confirmed_by_customer: true };
  }
  if (!pending) await db.query('insert into support_ai_actions(thread_id, workspace_id, tool, input_key, summary) values ($1,$2,$3,$4,$5)', [scope.threadId, scope.workspaceId || null, name, key, String(prep.ask || '').slice(0, 300)]);
  return { done: false, needs_confirmation: true, ask: prep.ask,
    rule: 'Nothing was changed yet. Ask the customer this in your own warm words (one short question) and wait. When they answer yes in their next message, call this tool again with the same input.' };
}

/** The tool list in the neutral format llm.complete() takes. */
function definitions(names) {
  return names.filter((n) => TOOLS[n]).map((n) => ({ name: n, description: TOOLS[n].description, parameters: TOOLS[n].parameters }));
}
const SUPPORT_TOOLS = Object.keys(TOOLS);
// Cas (the in-app helper) only reads the workspace. Account and payment questions go to the support chat.
const CAS_TOOLS = ['get_usage', 'get_connections', 'get_broadcasts', 'get_repeats', 'get_flows', 'get_bots', 'get_subscribers_summary', 'get_recent_errors', 'search_knowledge'];

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
    try {
      // Confirm before acting (enforced here, not by the model): a tool that changes something first returns the
      // question; it runs only when the customer's newest message says yes AFTER that question was asked.
      if (tool.confirm && !scope.sandbox) {
        const prep = await tool.prepare(scope, args);
        output = prep.stop ? prep.stop : await confirmGate(name, tool, args, prep, scope);
      } else output = await tool.run(scope, args);
    } catch (e) {
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

module.exports = { TOOLS, SUPPORT_TOOLS, CAS_TOOLS, definitions, run, redact, maskEmail, searchKnowledge, diagnose, saidYes, plainError };

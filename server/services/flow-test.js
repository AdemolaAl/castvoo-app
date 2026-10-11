'use strict';
/*
 * "📲 Send a test to my Telegram" (Welcome Flow builder): plays a flow to the person's own linked Telegram, through the
 * flow's own bot, exactly as a new member would get it, but:
 *   - every wait and reminder is shortened to TEST_WAIT_MS (3 seconds),
 *   - Start and the buttons work for real: they tap in Telegram and the next message comes,
 *   - nothing is counted and nobody real is touched: no subscriber, run, delivery, click, reply or join-request row and
 *     no meter is ever written (a test lives only in flow_tests), and nobody is let in or declined,
 *   - the welcome looks the same as for real people (the Free plan's branding line included),
 *   - at most TEST_LIMIT tests per person an hour.
 * Telegram only lets a bot message someone who started it. The test checks that first (sendChatAction); if not, it
 * waits ('need_start') for them to open t.me/<bot>?start=cvt_<code> and tap Start, then begins by itself.
 *
 * The flow is the builder's current version (checked by services/flows.js cleanFlow, nothing is saved), so people can
 * test before saving. Version A of an A/B welcome is used. "Start another flow" is not followed in a test.
 *
 * Where events come in: bot-updates.js (/start cvt_<code>, Reply buttons "cvt:<code>:<button id>", other messages of a
 * person who is testing), routes/pages.js (/lt/<code>/<button id>: a Link button, then the real address).
 * Due waits are played by tick() (called by the follow-ups job; workers/soon.js fires it on time).
 *
 * Bots (services/bots.js): Chat bots test the same way (the first message comes as soon as the test starts). The new
 * steps work for real in the test, without saving anything: "Check they joined" asks Telegram about the tester
 * ("cvt:<code>:cvjoin"), "Ask a question" takes the tester's typed answer (or shared number, or a choice
 * "cvt:<code>:cva<n>") and checks it like the real bot, and "Invite friends" shows a test link with a
 * "🧪 Pretend a friend joined" button ("cvt:<code>:cvref") so the reward can be seen.
 */

const db = require('../db');
const config = require('../config');
const log = require('../lib/log');
const tg = require('./telegram');
const send = require('./send');
const settings = require('./settings');
const billing = require('./billing');
const { tokenOf } = require('./connections');
const { httpError, randomCode } = require('../lib/util');

const flows = () => require('./flows');
const soon = () => require('../workers/soon');

const TEST_WAIT_MS = 3000;
const TEST_LIMIT = 10; // tests per person per hour
const EXPIRE_MINUTES = 30;
const OPEN = ['need_start', 'running', 'waiting'];
const CODE_RX = /^[a-z0-9]{12}$/;
const BTN_RX = /^[a-z0-9]{1,16}$/;

/* ---------- The engine (pure: the same rules as services/flow-runtime.js, with short waits) ---------- */

/** The flow's graph (services/flows.js flowGraph). F.steps: [{ position, trigger_type, trigger_button, delay_seconds, buttons: [{ id }] }] */
function graphOf(F) {
  return flows().flowGraph(F.steps.map((s) => ({ position: s.position, trigger_type: s.trigger_type, trigger_button: s.trigger_button, delay_seconds: s.delay_seconds, buttons: (s.buttons || []).map((b) => ({ button_id: b.id })) })), { startButton: !!F.start_button });
}
const trigOf = (F, i) => (i === 0 ? 'after_previous' : flows().triggerOf(F.steps[i]));
function newState() { return { p: 0, started: false, taps: [], sent: [], reminders: [], waitAt: null, log: [], answers: {}, refs: 0 }; }
const kindOf = (F, i) => (F.steps[i] && F.steps[i].step_type) || 'message';
const goalBefore = (F, i) => { for (let k = i - 1; k >= 0; k--) if (kindOf(F, k) === 'referral') return Number((F.steps[k].config || {}).goal) || 3; return 0; };

/**
 * Move a test along. ev: null (time passed), { start: true }, { tap: buttonId }, and for bots { joined: bool },
 * { answer: text | { phone } }, { ref: true } (a pretend friend). Changes `st` in place.
 * Returns { send: [step indexes to send now, in order], remind: [indexes of checks / questions whose reminder is due],
 * next (ms when to look again, or null), waitingFor, done, ignored, nudge (not joined), retry (an answer to try again) }.
 */
function run(F, st, now, ev = null, wait = TEST_WAIT_MS) {
  st.answers = st.answers || {}; st.refs = st.refs || 0;
  const remind = [];
  let nudge = false, retry = null;
  const G = graphOf(F);
  const n = F.steps.length;
  const out = [];
  const info = (i) => G.get(F.steps[i].position) || {};
  const send = (i) => { if (!st.sent.includes(i) && !out.includes(i)) { st.sent.push(i); out.push(i); st.log.push({ k: 'sent', i, t: now }); } };
  const answered = (r) => { const a = info(r.i).awaits || { start: false, buttons: [] }; return (a.start && !r.armed && st.started) || a.buttons.some((b) => st.taps.includes(b)); };
  // "Only if they clicked / didn't click": a button of the last earlier message that has buttons.
  const condOk = (i) => {
    const c = F.steps[i].condition;
    if (!c) return true;
    let k = i - 1; while (k >= 0 && !(F.steps[k].buttons || []).length) k--;
    const clicked = k >= 0 && F.steps[k].buttons.some((b) => st.taps.includes(b.id));
    return c === 'clicked' ? clicked : !clicked;
  };
  let ignored = false;
  const at = st.p < n ? kindOf(F, st.p) : null;
  if (ev && ev.joined !== undefined) {
    if (at !== 'check_join' || !st.sent.includes(st.p)) ignored = true;
    else if (ev.joined) { st.log.push({ k: 'joined', i: st.p, t: now }); st.reminders = st.reminders.filter((r) => r.i !== st.p); st.p++; }
    else nudge = true;
  } else if (ev && ev.answer !== undefined) {
    if (at !== 'ask' || !st.sent.includes(st.p)) ignored = true;
    else {
      const v = require('./bots').validateAnswer((F.steps[st.p].config || {}).answer || 'text', ev.answer, F.steps[st.p].config || {});
      if (v.ok) { st.answers[st.p] = v.value; st.log.push({ k: 'answer', i: st.p, value: v.value, t: now }); st.reminders = st.reminders.filter((r) => r.i !== st.p); st.p++; } else retry = v.message;
    }
  } else if (ev && ev.ref) {
    st.refs++; st.log.push({ k: 'ref', n: st.refs, t: now });
  } else if (ev && ev.start) {
    if (!F.start_button || st.started) ignored = true;
    else { st.started = true; st.log.push({ k: 'start', t: now }); }
  } else if (ev && ev.tap) {
    const owner = F.steps.findIndex((s) => (s.buttons || []).some((b) => b.id === ev.tap));
    if (owner < 0 || !st.sent.includes(owner) || st.taps.includes(ev.tap)) ignored = true; // unknown, not shown yet, or a double tap
    else {
      st.taps.push(ev.tap);
      const b = F.steps[owner].buttons.find((x) => x.id === ev.tap);
      st.log.push({ k: 'tap', id: ev.tap, label: b ? b.label : '', t: now });
      // A choice they passed already (they tap another button later): its answer comes now.
      F.steps.forEach((s, k) => {
        const g = info(k).group;
        if (k > 0 && trigOf(F, k) === 'on_button' && s.trigger_button === ev.tap && g && Math.max(...g.members) - 1 < st.p) send(k);
      });
    }
  }
  st.reminders = st.reminders.filter((r) => !answered(r));
  for (let guard = 0; guard < 1000; guard++) {
    if (st.p === 0) {
      const k0 = n ? kindOf(F, 0) : null;
      if (k0 === 'check_join' || k0 === 'ask') {
        if (!st.sent.includes(0)) { send(0); if (Number((F.steps[0].config || {}).remind_seconds) > 0) st.reminders.push({ i: 0, due: now + wait, special: true }); }
        break;
      }
      if (n) send(0); st.p = 1; continue;
    }
    if (st.p >= n) break;
    const i = st.p, t = trigOf(F, i), kind = kindOf(F, i);
    // A check or a question: sent once, then the test waits for them (with its reminder, if it has one).
    const interactive = () => {
      if (!st.sent.includes(i)) { send(i); if (Number((F.steps[i].config || {}).remind_seconds) > 0) st.reminders.push({ i, due: now + wait, special: true }); }
      return false;
    };
    if ((t === 'after_previous' || (t === 'wait' && st.waitAt == null && st.sent.includes(i))) && (kind === 'check_join' || kind === 'ask')) { interactive(); break; }
    if (t === 'after_previous') { if (condOk(i)) send(i); st.p++; continue; }
    if (t === 'wait') {
      if (st.waitAt == null) st.waitAt = now + wait;
      if (now >= st.waitAt) {
        st.waitAt = null;
        if (kind === 'check_join' || kind === 'ask') { interactive(); break; }
        if (condOk(i)) send(i); st.p++; continue;
      }
      break;
    }
    if (t === 'on_goal') { if (st.refs >= goalBefore(F, i)) { send(i); st.p++; continue; } break; }
    if (t === 'no_response') { if (!st.reminders.some((r) => r.i === i)) st.reminders.push({ i, due: now + wait, armed: st.started }); st.p++; continue; }
    if (t === 'on_start') { if (st.started) { send(i); st.p++; continue; } break; }
    if (t === 'on_button') {
      const g = info(i).group;
      const hits = g ? g.members.filter((pos) => st.taps.includes(F.steps[pos - 1].trigger_button)) : [];
      if (hits.length) { hits.forEach((pos) => send(pos - 1)); st.p = Math.max(...g.members); continue; }
      break;
    }
    st.p++;
  }
  // Reminders that are due and not answered are sent.
  for (const r of st.reminders.slice()) {
    if (r.due > now) continue;
    st.reminders = st.reminders.filter((x) => x !== r);
    if (r.special) { if (st.p === r.i) remind.push(r.i); continue; }
    if (!answered(r)) send(r.i);
  }
  const atT = st.p < n ? trigOf(F, st.p) : null;
  const atK = st.p < n ? kindOf(F, st.p) : null;
  const times = [st.waitAt, ...st.reminders.map((r) => r.due)].filter((x) => x != null);
  const next = times.length ? Math.min(...times) : null;
  const waitingFor = atK === 'check_join' && st.sent.includes(st.p) ? 'joined' : atK === 'ask' && st.sent.includes(st.p) ? 'answer'
    : atT === 'on_start' ? 'start' : atT === 'on_button' ? 'button' : atT === 'on_goal' ? 'goal' : null;
  return { send: out, remind, next, waitingFor, done: st.p >= n && next == null, ignored, nudge, retry };
}

/* ---------- Database side ---------- */

const startUrl = (bot, code) => `https://t.me/${bot.username}?start=cvt_${code}`;
const firstWord = (s) => String(s || '').trim().split(/\s+/)[0].slice(0, 64);

/** What the builder shows: { id, status, sent, total, waiting_for, next_in, start_url, bot, log, error } */
function view(row, bot) {
  const F = row.flow || { steps: [] };
  const st = row.state || newState();
  const at = st.p < F.steps.length ? trigOf(F, st.p) : null;
  const atK = st.p < F.steps.length ? kindOf(F, st.p) : null;
  let waitingFor = null;
  if (row.status === 'waiting' || row.status === 'running') {
    if (atK === 'check_join' && (st.sent || []).includes(st.p)) waitingFor = 'joined';
    else if (atK === 'ask' && (st.sent || []).includes(st.p)) waitingFor = 'answer';
    else if (at === 'on_start' && !st.started) waitingFor = 'start';
    else if (at === 'on_button') waitingFor = 'button';
    else if (at === 'on_goal') waitingFor = 'goal';
  }
  const label = (id) => { for (const s of F.steps) for (const b of s.buttons || []) if (b.id === id) return b.label; return ''; };
  const waitBtns = waitingFor === 'button' ? (() => { const g = (graphOf(F).get(F.steps[st.p].position) || {}).group; return g ? g.members.map((p) => label(F.steps[p - 1].trigger_button)).filter(Boolean) : []; })() : [];
  return {
    id: Number(row.id), status: row.status, sent: (st.sent || []).length, total: F.steps.length, sent_steps: st.sent || [], next_step: st.p < F.steps.length ? st.p : null,
    waiting_for: waitingFor, waiting_buttons: waitBtns, start_label: F.start_label || '',
    next_in: row.status === 'running' && row.due_at ? Math.max(0, new Date(row.due_at).getTime() - Date.now()) : null,
    start_url: bot && bot.username ? startUrl(bot, row.code) : null, bot: bot ? bot.username : null,
    log: (st.log || []).slice(-30), error: row.error || null, wait_seconds: TEST_WAIT_MS / 1000, first_name: row.first_name || null,
    start_type: F.start_type || 'join_request', answers: st.answers || {}, refs: st.refs || 0,
  };
}

/** One message of the test, to the tester. Buttons are the test's own (cvt: callbacks, /lt/ links). */
async function sendStep(row, conn, i, { reminder = false } = {}) {
  const F = row.flow;
  const s = F.steps[i];
  const B = require('./bots');
  const kind = s.step_type || 'message';
  const cfg = s.config || {};
  let msg = { body: s.body, media_id: s.media_id || null, buttons: (s.buttons || []).map((b) => ({ ...b })) };
  let footerHtml = '', extraRows = null, replyMarkup = null;
  const isBot = F.start_type === 'bot_start';
  if (i === 0 && F.branding) {
    const ws = await db.one('select * from workspaces where id = $1', [row.workspace_id]);
    if (!isBot) msg = await flows().freeWelcome(msg);
    footerHtml = await flows().brandingHtml(ws, isBot ? B.BOT_BRAND_TEXT : undefined);
  }
  if (reminder) msg = { body: cfg.remind_text || (kind === 'check_join' ? B.DEFAULTS.check_remind : B.DEFAULTS.ask_remind), media_id: null, buttons: [] };
  if (kind === 'check_join') extraRows = [[{ text: String(cfg.open_label || B.DEFAULTS.open_label).slice(0, 64), url: cfg.link }], [{ text: String(cfg.join_label || B.DEFAULTS.join_label).slice(0, 64), callback_data: `cvt:${row.code}:cvjoin` }]];
  if (kind === 'ask' && cfg.answer === 'choice') extraRows = (cfg.choices || []).map((c, k) => [{ text: String(c).slice(0, 64), callback_data: `cvt:${row.code}:cva${k}` }]);
  if (kind === 'ask' && cfg.answer === 'phone') replyMarkup = B.phoneKeyboard(cfg);
  if (kind === 'referral') {
    const st = row.state || {};
    const link = `https://t.me/${conn.username}?start=r_test`;
    msg = { ...msg, body: B.fillInvite(msg.body, { link, invites: st.refs || 0, goal: Number(cfg.goal) || 3 }) };
    extraRows = [[{ text: '🧪 Pretend a friend joined', callback_data: `cvt:${row.code}:cvref` }]];
  }
  const startButton = i === 0 && F.start_button ? { label: F.start_label || flows().DEFAULT_START, url: startUrl(conn, row.code) } : null;
  const buttonFor = (b) => {
    if (!b.id || !BTN_RX.test(b.id)) return null;
    if (b.kind === 'reply') return { text: String(b.label).slice(0, 64), callback_data: `cvt:${row.code}:${b.id}` };
    return { text: String(b.label).slice(0, 64), url: `${config.appUrl}/lt/${row.code}/${b.id}` };
  };
  return send.sendOne(msg, { token: tokenOf(conn), botKey: 'bot:' + conn.id, chatId: row.tg_user_id, includeStop: false, firstName: row.first_name, footerHtml, startButton, buttonFor, extraRows, replyMarkup });
}

const note = (conn, chatId, text) => tg.call(tokenOf(conn), 'sendMessage', { chat_id: chatId, text }).catch(() => {});

/**
 * Move one test along and save it. Must run inside transaction c with the row locked (for update).
 * ev: null | { start: true } | { tap: id } | { begin: true }.
 */
async function step(c, row, ev) {
  const conn = (await c.query("select * from connections where id = $1 and status <> 'removed'", [row.connection_id])).rows[0];
  if (!conn) { await c.query("update flow_tests set status = 'stopped', due_at = null, error = $2, updated_at = now() where id = $1", [row.id, 'The bot is not connected any more.']); return null; }
  const F = row.flow;
  const st = row.state && row.state.log ? row.state : newState();
  if (ev && ev.begin) {
    await note(conn, row.tg_user_id, F.start_type === 'bot_start'
      ? `🧪 Test of "${F.name}"\n\nThis is how people see your bot after they tap Start. Waits are ${TEST_WAIT_MS / 1000} seconds here, and nothing is counted or saved. Tap and answer like they would 👇`
      : `🧪 Test of "${F.name}"\n\nThis is how new members see your flow. Waits are ${TEST_WAIT_MS / 1000} seconds here, and nothing is counted. Tap the buttons like they would 👇`);
  }
  // Time passed (tick): the row is due, so its next wait or reminder has come (even if this clock is a little behind).
  const pending = [st.waitAt, ...(st.reminders || []).map((x) => x.due)].filter((x) => x != null);
  const now = !ev && pending.length ? Math.max(Date.now(), Math.min(...pending)) : Date.now();
  const r = run(F, st, now, ev && !ev.begin ? ev : null);
  let error = null;
  if (r.retry) await tg.call(tokenOf(conn), 'sendMessage', { chat_id: row.tg_user_id, text: r.retry }).catch(() => {});
  for (const i of r.remind) await sendStep({ ...row, state: st }, conn, i, { reminder: true }).catch(() => {});
  for (const i of r.send) {
    try { await sendStep({ ...row, state: st }, conn, i); } catch (e) {
      const d = String(e.description || e.message || '');
      error = e.code === 403 || /blocked|can't initiate|chat not found/i.test(d) ? `Telegram didn't let @${conn.username} message you. Open the bot, tap Start, then try again.` : 'Telegram didn\'t take message ' + (i + 1) + ': ' + d.replace(/^Bad Request: /, '').slice(0, 160);
      log.warn('flow test send failed', { test: row.id, err: d });
      break;
    }
  }
  let status = error ? 'stopped' : r.done ? 'done' : r.next != null ? 'running' : 'waiting';
  if (status === 'done') await note(conn, row.tg_user_id, F.start_type === 'bot_start' ? '✅ That\'s the whole bot! Nothing was counted or saved. You can run another test from the builder any time.' : '✅ That\'s the whole flow! Nothing was counted, and nobody was let in. You can run another test from the builder any time.');
  await c.query(`update flow_tests set state = $2, status = $3, due_at = $4, sent = $5, error = $6, updated_at = now() where id = $1`,
    [row.id, JSON.stringify(st), status, status === 'running' && r.next != null ? new Date(r.next) : null, st.sent.length, error]);
  if (status === 'running' && r.next != null) soon().at(r.next);
  return { ...row, state: st, status, error, due_at: r.next != null ? new Date(r.next) : null, conn, nudge: r.nudge };
}

/** Lock one test and move it along. Returns the new row (or null). */
async function withTest(where, args, ev) {
  return db.tx(async (c) => {
    const row = (await c.query(`select * from flow_tests where ${where} for update`, args)).rows[0];
    if (!row) return null;
    if (!OPEN.includes(row.status)) return { ...row, ended: true };
    if (ev && ev.begin && row.status !== 'need_start') return row;
    return step(c, row, ev);
  });
}

/**
 * Start a test (POST /api/flows/tests). body: the builder's flow (like PUT /api/flows/:id) + optional flow_id.
 * Returns view().
 */
async function create(ws, user, body) {
  await settings.requireFeature('welcome_flows', 'Welcome Flows are switched off for a moment. Please check back soon.');
  if (!user.tg_user_id) throw httpError(409, 'Link your Telegram first, so we know where to send your test.', 'tg_not_linked');
  const recent = await db.one("select count(*)::int n, min(created_at) first from flow_tests where user_id = $1 and created_at > now() - interval '1 hour'", [user.id]);
  if (recent.n >= TEST_LIMIT) {
    const mins = Math.max(1, Math.ceil((new Date(recent.first).getTime() + 3600000 - Date.now()) / 60000));
    throw httpError(429, `That's ${TEST_LIMIT} tests this hour. Take a little breather, and try again in ${mins} minute${mins === 1 ? '' : 's'}.`, 'test_limit', { minutes: mins });
  }
  const flowId = body.flow_id ? Number(body.flow_id) || null : null;
  const f = await flows().cleanFlow(ws, body, { flowId });
  if (flowId && !(await db.one("select 1 from sequences where id = $1 and workspace_id = $2 and trigger_type in ('join_request','bot_start')", [flowId, ws.id]))) throw httpError(404, 'That flow was not found.', 'not_found');
  const l = await billing.limits(ws);
  const snapshot = {
    name: f.name, chat_title: f.chat ? f.chat.title || '' : '', start_button: !!f.start_button, start_label: f.start_label || '', approve_mode: f.approve_mode, branding: !!l.branding,
    start_type: f.start_type || 'join_request',
    steps: f.steps.map((s) => ({ position: s.position, trigger_type: s.trigger_type, trigger_button: s.trigger_button, delay_seconds: s.delay_seconds, condition: s.condition || null, step_type: s.step_type || 'message', config: s.config || {},
      body: s.body, media_id: s.media_id || null, buttons: (s.buttons || []).map((b) => ({ id: b.button_id, label: b.label, url: b.url || '', kind: b.kind || 'link', row: b.row })) })),
  };
  // One test at a time per person: an older one still open stops here.
  await db.query(`update flow_tests set status = 'stopped', due_at = null, updated_at = now() where user_id = $1 and status = any($2::text[])`, [user.id, OPEN]);
  let code; do code = randomCode(12); while (await db.one('select 1 from flow_tests where code = $1', [code]));
  const row = await db.one(`insert into flow_tests(code, workspace_id, user_id, connection_id, sequence_id, tg_user_id, first_name, flow, state)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
  [code, ws.id, user.id, f.bot.id, flowId, user.tg_user_id, firstWord(user.name) || null, JSON.stringify(snapshot), JSON.stringify(newState())]);
  // Can the bot message them? (They must have started it once.)
  try {
    await tg.call(tokenOf(f.bot), 'sendChatAction', { chat_id: user.tg_user_id, action: 'typing' });
  } catch (e) {
    if (e.code === 401) {
      await db.query("update flow_tests set status = 'stopped', error = 'bot token' where id = $1", [row.id]);
      throw httpError(409, `The token of @${f.bot.username} stopped working. Reconnect the bot on the Channels & bots page, then try again.`, 'bot_token');
    }
    return view(row, f.bot); // need_start: open the bot and tap Start first
  }
  const out = await withTest('id = $1', [row.id], { begin: true });
  return view(out, f.bot);
}

async function get(user, id) {
  const row = await db.one('select * from flow_tests where id = $1 and user_id = $2', [id, user.id]);
  if (!row) throw httpError(404, 'That test was not found.', 'not_found');
  const bot = await db.one('select id, username from connections where id = $1', [row.connection_id]);
  return view(row, bot);
}

async function stop(user, id) {
  await db.query(`update flow_tests set status = 'stopped', due_at = null, updated_at = now() where id = $1 and user_id = $2 and status = any($3::text[])`, [id, user.id, OPEN]);
  return get(user, id);
}

/** Play the due waits and reminders, and expire old tests. Called by the follow-ups job (workers/jobs.js dripsTick). */
async function tick(limit = 50) {
  await db.query(`update flow_tests set status = 'expired', due_at = null where status = any($1::text[]) and updated_at < now() - make_interval(mins => $2)`, [OPEN, EXPIRE_MINUTES]);
  const due = await db.many("select id from flow_tests where status = 'running' and due_at <= now() order by due_at limit $1", [limit]);
  let n = 0;
  for (const d of due) {
    const r = await db.tx(async (c) => {
      const row = (await c.query("select * from flow_tests where id = $1 and status = 'running' and due_at <= now() for update skip locked", [d.id])).rows[0];
      return row ? step(c, row, null) : null;
    }).catch((e) => { log.warn('flow test tick failed', { test: d.id, err: e.message }); return null; });
    if (r) n++;
  }
  // The next due test fires on time (workers/soon.js); the job's poll is the fallback.
  const next = await db.one("select min(due_at) t from flow_tests where status = 'running'");
  if (next && next.t) soon().at(next.t);
  return n;
}

/* ---------- Events from Telegram ---------- */

/**
 * /start in a customer's bot. Returns true when it was for a test (then it is not a real Start: no subscriber, no flows).
 * payload "cvt_<code>": the test's Start link or its welcome's Start button. A plain /start counts too while that person
 * has a test waiting for Start on this bot.
 */
async function onStart(conn, from, payload) {
  if (payload && payload.startsWith('cvt_')) {
    const code = payload.slice(4);
    const row = CODE_RX.test(code) ? await db.one('select id, status from flow_tests where code = $1 and connection_id = $2 and tg_user_id = $3', [code, conn.id, from.id]) : null;
    if (!row || !OPEN.includes(row.status)) { await note(conn, from.id, 'This test has ended. You can start a new one from the Welcome Flow builder any time 🙂'); return true; }
    await startTest(row.id, from);
    return true;
  }
  if (payload) return false;
  const open = await db.one(`select id, status, state, flow from flow_tests where connection_id = $1 and tg_user_id = $2 and status = any($3::text[]) order by id desc limit 1`, [conn.id, from.id, OPEN]);
  if (!open) return false;
  if (open.status !== 'need_start' && (open.state.started || !open.flow.start_button)) return open.flow.start_type === 'bot_start';
  await startTest(open.id, from);
  return true;
}
async function startTest(id, from) {
  const fn = String(from.first_name || '').slice(0, 64);
  if (fn) await db.query('update flow_tests set first_name = $2 where id = $1', [id, fn]);
  const row = await db.one('select status from flow_tests where id = $1', [id]);
  return withTest('id = $1', [id], row.status === 'need_start' ? { begin: true } : { start: true });
}

/** A Reply button of a test ("cvt:<code>:<button id>"). Returns true when the callback was a test's. */
async function onCallback(conn, q) {
  const m = /^cvt:([a-z0-9]{12}):([a-z0-9]{1,16})$/.exec(String(q.data || ''));
  if (!m) return false;
  const row = await db.one('select id, status from flow_tests where code = $1 and connection_id = $2 and tg_user_id = $3', [m[1], conn.id, q.from && q.from.id]);
  const ended = !row || !OPEN.includes(row.status);
  const answer = (o) => tg.call(tokenOf(conn), 'answerCallbackQuery', { callback_query_id: q.id, ...o }).catch(() => {});
  if (ended) { await answer({ text: 'This test has ended.' }); return true; }
  if (m[2] === 'cvjoin') {
    // "I've joined ✅" in a test: Telegram is really asked about the tester.
    const t = await db.one('select flow, state from flow_tests where id = $1', [row.id]);
    const s = t.flow.steps[(t.state || {}).p] || {};
    const chat = s.config && s.config.chat_id ? await db.one("select tg_chat_id from connections where id = $1 and kind <> 'bot'", [s.config.chat_id]) : null;
    let joined = false;
    if (chat) {
      try { const mem = await tg.call(tokenOf(conn), 'getChatMember', { chat_id: chat.tg_chat_id, user_id: q.from.id }); joined = ['creator', 'administrator', 'member'].includes(mem.status) || (mem.status === 'restricted' && mem.is_member === true); } catch { joined = false; }
    }
    await answer(joined ? { text: 'Thanks for joining! ✅' } : { text: (s.config && s.config.nudge) || require('./bots').DEFAULTS.nudge, show_alert: true });
    await withTest('id = $1', [row.id], { joined });
    return true;
  }
  await answer({});
  if (m[2] === 'cvref') { await withTest('id = $1', [row.id], { ref: true }); return true; }
  const ch = /^cva(\d{1,2})$/.exec(m[2]);
  if (ch) {
    const t = await db.one('select flow, state from flow_tests where id = $1', [row.id]);
    const s = t.flow.steps[(t.state || {}).p] || {};
    const pick = ((s.config || {}).choices || [])[Number(ch[1])];
    if (pick) await withTest('id = $1', [row.id], { answer: pick });
    return true;
  }
  await withTest('id = $1', [row.id], { tap: m[2] });
  return true;
}

/**
 * A message from someone who is testing on this bot. Returns true when it belongs to the test (then it is never a
 * real reply): a typed answer or a shared number goes to the test's question.
 */
async function onMessage(conn, m) {
  const open = await db.one('select id, state, flow from flow_tests where connection_id = $1 and tg_user_id = $2 and status = any($3::text[]) order by id desc limit 1', [conn.id, m.from.id, OPEN]);
  if (!open) return false;
  const s = open.flow.steps[(open.state || {}).p];
  if (s && s.step_type === 'ask' && (open.state.sent || []).includes(open.state.p)) {
    const ans = m.contact ? { phone: m.contact.phone_number } : (typeof m.text === 'string' ? m.text : '');
    await withTest('id = $1', [open.id], { answer: ans });
  }
  return true;
}

/** A Link button of a test (/lt/<code>/<button id>): counts as their tap, returns the real address (or null). */
async function onLink(code, btn) {
  if (!CODE_RX.test(String(code)) || !BTN_RX.test(String(btn))) return null;
  const row = await db.one('select id, status, flow from flow_tests where code = $1', [code]);
  if (!row) return null;
  let url = null;
  for (const s of row.flow.steps || []) for (const b of s.buttons || []) if (b.id === btn && b.kind !== 'reply') url = b.url;
  if (url && OPEN.includes(row.status)) await withTest('id = $1', [row.id], { tap: btn }).catch(() => {});
  return url;
}

/** Is this person testing a flow on this bot right now? (Their other messages then aren't counted as replies.) */
async function testing(conn, tgUserId) {
  return !!(await db.one('select 1 from flow_tests where connection_id = $1 and tg_user_id = $2 and status = any($3::text[]) limit 1', [conn.id, tgUserId, OPEN]));
}

module.exports = { TEST_WAIT_MS, TEST_LIMIT, run, newState, create, get, stop, tick, onStart, onCallback, onLink, onMessage, testing, view };

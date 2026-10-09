'use strict';
/* The dashboard's home data, workspace settings, team, plan choices and Cas training. */

const db = require('../db');
const config = require('../config');
const billing = require('../services/billing');
const settings = require('../services/settings');
const email = require('../services/email');
const { str, int, oneOf, email: vEmail, randomToken, badRequest, forbidden, notFound, httpError, fmtUSD, cleanName, LOOKS_LIKE_URL } = require('../lib/util');
const rl = require('../lib/ratelimit');
const perms = require('../permissions');
const helper = require('../services/helper');
const helperLog = require('../services/activity');

const ownerOnly = (ctx) => { if (ctx.member.role !== 'owner') throw forbidden('Only the workspace owner can do that.'); };
/** Connecting Telegram and workspace settings: the owner and the setup helper. */
const canSetup = (ctx) => { if (!perms.wsCan(ctx.member.role, 'ws.setup', ctx.workspace)) throw forbidden('Only the workspace owner can do that.'); };
/** Plan and coupons: the owner, and the setup helper when the owner allows billing. */
const canBilling = (ctx) => { if (!perms.wsCan(ctx.member.role, 'ws.billing', ctx.workspace)) throw forbidden(ctx.member.role === 'helper' ? 'Only the owner can change the plan. They can allow it in Settings → Team.' : 'Only the workspace owner can do that.'); };
const safeName = (v, fallback) => { const x = cleanName(v, 60); return x && !LOOKS_LIKE_URL.test(x) ? x : fallback; };
const maskEmail = (e) => { if (!e) return null; const [u, d] = String(e).split('@'); if (!d) return '•••'; return (u.length <= 2 ? u[0] + '•' : u.slice(0, 2) + '•••' + u.slice(-1)) + '@' + d; };
const seatsUsed = (members, invites) => members + invites;

/** Room for a setup helper: one per workspace (free on every plan, no seat). */
async function helperRoom(ctx) {
  const h = await helper.current(ctx.workspace.id);
  if (h) throw httpError(409, 'You already have a setup helper. Remove them first to invite someone else.', 'helper_exists');
}
/** SEC-12: invites are emails from Castvoo's domain with text the owner chose. New accounts may send fewer per day. */
async function invitesPerDay(ctx) {
  const ageDays = (Date.now() - new Date(ctx.user.created_at || Date.now()).getTime()) / 86400000;
  const perDay = ctx.workspace.paid_ever ? 100 : ageDays < 2 ? 5 : ageDays < 14 ? 15 : 40;
  if (!(await rl.hitShared('invite-day:' + ctx.user.id, perDay, 86400)).ok) throw httpError(429, 'That is a lot of invites for one day. Try again tomorrow.', 'rate_limited');
}
/** An invite that can still be used by this person. Email invites only work for the email they were sent to. */
async function openInvite(ctx, token) {
  const inv = await db.one('select * from invites where token = $1 and accepted_at is null and declined_at is null and expires_at > now()', [str(token, 'Invite', { min: 10, max: 100 })]);
  if (!inv) throw notFound('That invite');
  // The invite only works for the email it was sent to, so a forwarded link can't be used by someone else.
  if (inv.kind === 'email' && (!ctx.user.email || ctx.user.email.toLowerCase() !== String(inv.email).toLowerCase())) {
    const hint = String(inv.email).replace(/^(.).*(@.*)$/, '$1•••$2');
    throw httpError(403, `This invite was sent to ${hint}. Log in with that email, or add it to your account in Settings, then open the link again.`, 'invite_email');
  }
  return inv;
}
const canSend = (ctx) => { if (ctx.member.role === 'drafter') throw forbidden('Your role can write drafts. Ask the owner to send.'); };

async function stats(wsId) {
  const [d, prev, clicks, clickers, replies, starts, series] = await Promise.all([
    db.one("select count(*)::int n from deliveries where workspace_id = $1 and status = 'sent' and sent_at > now() - interval '14 days'", [wsId]),
    db.one("select count(*)::int n from deliveries where workspace_id = $1 and status = 'sent' and sent_at between now() - interval '28 days' and now() - interval '14 days'", [wsId]),
    db.one("select count(*)::int n from clicks where workspace_id = $1 and created_at > now() - interval '14 days'", [wsId]),
    db.one("select count(distinct subscriber_id)::int n from clicks where workspace_id = $1 and subscriber_id is not null and created_at > now() - interval '14 days'", [wsId]),
    db.one("select count(*)::int n from replies where workspace_id = $1 and created_at > now() - interval '14 days'", [wsId]),
    db.one("select count(*)::int n from subscribers s join connections c on c.id = s.connection_id where c.workspace_id = $1 and s.status <> 'joinreq' and s.joined_at > now() - interval '1 day'", [wsId]), // people who asked to join but never pressed Start are not subscribers
    db.many(`select to_char(d, 'YYYY-MM-DD') as day,
        (select count(*)::int from deliveries x where x.workspace_id = $1 and x.status = 'sent' and x.sent_at >= d and x.sent_at < d + interval '1 day') as sent,
        (select count(*)::int from deliveries x where x.workspace_id = $1 and x.status = 'sent' and x.sent_at >= d - interval '14 days' and x.sent_at < d - interval '13 days') as prev
      from generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') d order by d`, [wsId]),
  ]);
  return { delivered_14d: d.n, delivered_prev_14d: prev.n, clicks_14d: clicks.n, clickers_14d: clickers.n, replies_14d: replies.n, new_subscribers_24h: starts.n, series };
}

async function activity(wsId) {
  return db.many(`(select 'start' as kind, s.first_name as who, s.source as detail, c.title as place, s.joined_at as at
        from subscribers s join connections c on c.id = s.connection_id where c.workspace_id = $1 and s.status <> 'joinreq' order by s.joined_at desc limit 8)
    union all (select 'click', coalesce(s.first_name, 'Someone'), l.label, '', k.created_at from clicks k join links l on l.code = k.code left join subscribers s on s.id = k.subscriber_id where k.workspace_id = $1 order by k.created_at desc limit 8)
    union all (select 'broadcast', b.title, b.status, '', coalesce(b.finished_at, b.started_at, b.created_at) from broadcasts b where b.workspace_id = $1 and b.status in ('sent','sending') order by b.id desc limit 4)
    order by at desc limit 12`, [wsId]);
}

module.exports = (r) => {
  /** Everything the dashboard needs on first load. */
  r.get('/api/app/state', async (ctx) => {
    const ws = ctx.workspace;
    const [plan, conns, wallet, st, act, sending, upcoming, unread] = await Promise.all([
      billing.planState(ws),
      db.many("select id, kind, username, title, member_count, status, last_error, created_at from connections where workspace_id = $1 and status <> 'removed' order by id", [ws.id]),
      db.one('select wallet_cents, bonus_cents from workspaces where id = $1', [ws.id]),
      stats(ws.id),
      activity(ws.id),
      db.one("select b.id, b.title, b.total, b.sent, b.failed, c.title as conn from broadcasts b join connections c on c.id = b.connection_id where b.workspace_id = $1 and b.status = 'sending' order by b.id desc limit 1", [ws.id]),
      db.many("select id, title, send_at, total from broadcasts where workspace_id = $1 and status = 'scheduled' order by send_at limit 3", [ws.id]),
      db.one("select count(*)::int n from support_threads where user_id = $1 and workspace_id = $2 and unread_user", [ctx.user.id, ws.id]),
    ]);
    const firstBroadcast = await db.one("select 1 from broadcasts where workspace_id = $1 and status in ('sent','sending','scheduled') limit 1", [ws.id]);
    const anyDrip = await db.one("select 1 from sequences where workspace_id = $1 and active and trigger_type <> 'join_request' limit 1", [ws.id]);
    const anyFlow = await db.one("select 1 from sequences where workspace_id = $1 and active and trigger_type = 'join_request' limit 1", [ws.id]);
    const pendingJoins = await db.one("select count(*)::int n from join_requests where workspace_id = $1 and status = 'pending'", [ws.id]);
    const teammates = await db.one("select count(*)::int n from members where workspace_id = $1 and role <> 'helper'", [ws.id]);
    const anyTopup = await db.one("select 1 from wallet_tx where workspace_id = $1 and kind = 'topup' limit 1", [ws.id]);
    // Setup helper: for the owner, whether one is invited or working (and the "they joined" notice);
    // for the helper, what the owner allows (billing, sending broadcasts).
    const h = await helper.current(ws.id);
    const role = ctx.member.role;
    const helperInfo = role === 'owner'
      ? { active: !!h, name: h ? h.name : null, pending: !h && !!(await helper.pendingInvite(ws.id)), notice: h && !h.owner_seen ? { name: h.name || 'Your setup helper' } : null }
      : role === 'helper' ? { you: true, billing: !!ws.helper_billing, send: ws.helper_send !== false } : null;
    return {
      workspace: { id: ws.id, name: ws.name, timezone: ws.timezone, role, daily_cap: ws.daily_cap, require_approval: ws.require_approval, ai_trained: Object.keys(ws.ai_profile || {}).length > 0 },
      helper: helperInfo,
      plan, connections: conns,
      wallet: { cash: Number(wallet.wallet_cents) / 100, bonus: Number(wallet.bonus_cents) / 100, total: (Number(wallet.wallet_cents) + Number(wallet.bonus_cents)) / 100 },
      stats: st, activity: act, sending, upcoming, support_unread: unread.n, flows: { live: !!anyFlow, pending: pendingJoins.n },
      checklist: [
        { key: 'account', label: 'Create your account', done: true },
        { key: 'connect', label: 'Connect a bot, channel or group', done: conns.length > 0, go: 'connect' },
        { key: 'flow', label: 'Switch on a Welcome Flow', done: !!anyFlow, go: 'flows' },
        ...(plan.welcome_only ? [] : [{ key: 'drip', label: 'Switch on an auto follow-up', done: !!anyDrip, go: 'drips' }]),
        ...(plan.welcome_only ? [] : [{ key: 'broadcast', label: 'Send your first message', done: !!firstBroadcast, go: 'broadcast' },
          { key: 'train', label: 'Teach Cas about your business', done: Object.keys(ws.ai_profile || {}).length > 0, go: 'ai' }]),
        { key: 'topup', label: 'Top up your wallet', done: !!anyTopup, go: 'topup' },
        ...(plan.limits.seats > 1 ? [{ key: 'team', label: 'Invite a teammate', done: teammates.n > 1, go: 'settings' }] : []),
      ],
    };
  }, { auth: 'workspace' });

  r.post('/api/app/settings', async (ctx) => {
    canSetup(ctx);
    const b = ctx.body;
    let name = ctx.workspace.name;
    if (b.name !== undefined) {
      // SEC-12: the name goes into invite emails, so no web addresses, newlines or odd characters.
      name = cleanName(str(b.name, 'Workspace name', { min: 1, max: 120 }), 60);
      if (!name) throw badRequest('Workspace name is required.');
      if (LOOKS_LIKE_URL.test(name)) throw badRequest('A workspace name can\'t contain a web address or email.');
    }
    let tz = ctx.workspace.timezone;
    if (b.timezone !== undefined) {
      tz = str(b.timezone, 'Time zone', { min: 1, max: 60 });
      try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { throw badRequest('That time zone is not recognised.'); }
    }
    const cap = b.daily_cap !== undefined ? int(b.daily_cap, 'Daily limit', { min: 0, max: 20 }) : ctx.workspace.daily_cap;
    const appr = b.require_approval !== undefined ? !!b.require_approval : ctx.workspace.require_approval;
    await db.query('update workspaces set name = $2, timezone = $3, daily_cap = $4, require_approval = $5 where id = $1', [ctx.workspace.id, name, tz, cap, appr]);
    return { ok: true };
  }, { auth: 'workspace' });

  /* ---------- Team ---------- */
  r.get('/api/app/team', async (ctx) => {
    const ws = ctx.workspace;
    const owner = ctx.member.role === 'owner';
    const rows = await db.many('select u.id, u.name, u.email, u.tg_username, u.nickname, u.avatar, m.role, m.created_at as joined_at, m.last_active_at from members m join users u on u.id = m.user_id where m.workspace_id = $1 order by m.created_at', [ws.id]);
    // A setup helper sees who is on the team, not their logins (emails partly hidden, no Telegram usernames).
    const members = rows.map((m) => (owner || m.id === ctx.user.id ? m : { id: m.id, name: m.name, email: maskEmail(m.email), tg_username: null, nickname: m.nickname, avatar: m.avatar, role: m.role, joined_at: m.joined_at }));
    const invites = owner ? await db.many("select email, role, kind, expires_at from invites where workspace_id = $1 and role <> 'helper' and accepted_at is null and declined_at is null and expires_at > now() order by created_at desc", [ws.id]) : [];
    const h = rows.find((m) => m.role === 'helper') || null;
    const pend = owner && !h ? await helper.pendingInvite(ws.id) : null;
    return {
      members, invites, seats: (await billing.limits(ws)).seats, seats_used: seatsUsed(rows.length - (h ? 1 : 0), invites.length),
      // Extra team seats (Settings → Team → Add seats): price, what renews, and whether this workspace can buy them.
      extra_seats: await billing.seatsInfo(ws),
      helper: {
        included: 1,
        member: h ? { id: h.id, name: h.name, nickname: h.nickname, avatar: h.avatar, email: owner ? h.email : maskEmail(h.email), tg_username: owner ? h.tg_username : null, joined_at: h.joined_at, last_active_at: h.last_active_at } : null,
        invite: pend ? { kind: pend.kind, email: pend.email, expires_at: pend.expires_at, link: `${config.appUrl}/#join/${pend.token}` } : null,
        settings: { billing: !!ws.helper_billing, send: ws.helper_send !== false },
        activity: owner && h ? await helperLog.list(ws.id, { limit: 30 }) : [],
        can: helper.CAN, cannot: helper.CANNOT,
      },
    };
  }, { auth: 'workspace' });

  r.post('/api/app/team/invite', async (ctx) => {
    ownerOnly(ctx);
    const mail = vEmail(ctx.body.email);
    const role = oneOf(ctx.body.role || 'sender', 'Role', ['sender', 'drafter', 'helper']);
    if (mail === String(ctx.user.email || '').toLowerCase()) throw badRequest('That is your own email. Invite someone else.');
    if (role === 'helper') await helperRoom(ctx);
    else {
      // Plan seats + extra seats bought (not the ones the owner asked to remove at the next renewal).
      const l = await billing.limits(ctx.workspace);
      const seats = l.seats_for_invites;
      // The setup helper (and an invite for one) never uses a team seat.
      const taken = await billing.seatsTaken(ctx.workspace.id);
      if (taken >= seats) {
        const info = await billing.seatsInfo(ctx.workspace, l);
        throw httpError(402, `You have ${seats} seat${seats > 1 ? 's' : ''} and all are in use. ${info.can_buy ? 'Add a seat in Settings → Team, or remove someone.' : 'Upgrade to invite more people.'}`, 'limit_seats', { can_buy_seats: info.can_buy });
      }
    }
    await invitesPerDay(ctx);
    const token = randomToken(24);
    await db.tx(async (c) => {
      if (role === 'helper') await helper.expirePending(ctx.workspace.id, c); // one helper invite at a time: the new one replaces the old
      await c.query("insert into invites(token, workspace_id, email, role, kind, created_by, expires_at) values ($1,$2,$3,$4,'email',$5, now() + interval '7 days')", [token, ctx.workspace.id, mail, role, ctx.user.id]);
    });
    const link = `${config.appUrl}/#join/${token}`;
    const vars = { inviter_name: safeName(ctx.user.name, 'A Castvoo customer'), workspace_name: safeName(ctx.workspace.name, 'their workspace'), invite_url: link };
    await email.sendTo(mail, role === 'helper' ? 'helper_invite' : 'team_invite', vars);
    return { ok: true, link };
  }, { auth: 'workspace', rate: [30, 3600] });

  /**
   * Extra team seats: { seats: N } is the number of extra seats wanted (0–500). More = paid now for the rest of the
   * period from the wallet; fewer = from the next renewal (not below the seats in use). Owner only (ws.team).
   */
  r.post('/api/app/team/seats', async (ctx) => {
    ownerOnly(ctx);
    const want = int(ctx.body.seats, 'Extra seats', { min: 0, max: 500 });
    const before = Number(ctx.workspace.extra_seats) || 0;
    const r2 = await billing.setExtraSeats(ctx.workspace.id, want);
    await require('../services/audit').audit(ctx, 'workspace.extra_seats', 'workspace:' + ctx.workspace.id, { before, want, charged_cents: r2.charged, pending: r2.pending });
    const info = await billing.seatsInfo(await db.one('select * from workspaces where id = $1', [ctx.workspace.id]));
    const msg = r2.charged ? `Seats added. ${fmtUSD(r2.charged)} was paid from your wallet for the rest of this period.`
      : r2.pending != null ? `You'll have ${r2.pending} extra seat${r2.pending === 1 ? '' : 's'} from your next renewal. Nothing more is charged.`
        : want > before ? 'Seats added.' : 'Your seats stay as they are.';
    return { ok: true, message: msg, charged: r2.charged / 100, extra_seats: info };
  }, { auth: 'workspace', rate: [30, 600] });

  /** A one-time link to invite a setup helper (share it on Telegram or WhatsApp). The first person to accept gets it. */
  r.post('/api/app/team/helper-link', async (ctx) => {
    ownerOnly(ctx);
    await helperRoom(ctx);
    await invitesPerDay(ctx);
    const token = randomToken(24);
    await db.tx(async (c) => {
      await helper.expirePending(ctx.workspace.id, c);
      await c.query("insert into invites(token, workspace_id, email, role, kind, created_by, expires_at) values ($1,$2,null,'helper','link',$3, now() + interval '7 days')", [token, ctx.workspace.id, ctx.user.id]);
    });
    const exp = await db.one('select expires_at from invites where token = $1', [token]);
    return { ok: true, link: `${config.appUrl}/#join/${token}`, expires_at: exp.expires_at };
  }, { auth: 'workspace', rate: [30, 3600] });

  r.post('/api/app/team/helper/cancel-invite', async (ctx) => {
    ownerOnly(ctx);
    await helper.expirePending(ctx.workspace.id);
    return { ok: true };
  }, { auth: 'workspace' });

  r.post('/api/app/team/helper/settings', async (ctx) => {
    ownerOnly(ctx);
    const b = ctx.body || {};
    const billingOn = b.billing === undefined ? !!ctx.workspace.helper_billing : !!b.billing;
    const sendOn = b.send === undefined ? ctx.workspace.helper_send !== false : !!b.send;
    await db.query('update workspaces set helper_billing = $2, helper_send = $3 where id = $1', [ctx.workspace.id, billingOn, sendOn]);
    return { ok: true, settings: { billing: billingOn, send: sendOn } };
  }, { auth: 'workspace' });

  /** The owner saw the "your setup helper joined" notice. */
  r.post('/api/app/team/helper/seen', async (ctx) => {
    ownerOnly(ctx);
    await db.query("update members set owner_seen = true where workspace_id = $1 and role = 'helper'", [ctx.workspace.id]);
    return { ok: true };
  }, { auth: 'workspace' });

  r.post('/api/app/team/remove', async (ctx) => {
    ownerOnly(ctx);
    const uid = int(ctx.body.user_id, 'Person');
    if (uid === ctx.user.id) throw badRequest('You cannot remove yourself.');
    // Deleting the membership is enough: every request reads the membership again, so the person's open
    // sessions lose this workspace on their next click. Things they scheduled keep running unless the owner cancels them.
    const gone = await db.one("delete from members where workspace_id = $1 and user_id = $2 and role <> 'owner' returning role", [ctx.workspace.id, uid]);
    if (gone && gone.role === 'helper') {
      const u = await db.one('select * from users where id = $1', [uid]);
      await helperLog.record(ctx.workspace.id, uid, 'helper.removed', 'Was removed as setup helper by the owner', 'owner');
      if (u) await email.send('helper_removed', u, { owner_name: safeName(ctx.user.name, 'The owner'), workspace_name: safeName(ctx.workspace.name, 'the workspace') });
    }
    return { ok: true, removed: !!gone };
  }, { auth: 'workspace' });

  /** Leave a workspace you were invited to (teammates and the setup helper). */
  r.post('/api/app/team/leave', async (ctx) => {
    if (ctx.member.role === 'owner') throw badRequest('You own this workspace, so you can\'t leave it.');
    if (ctx.member.role === 'helper') await helperLog.record(ctx.workspace.id, ctx.user.id, 'helper.left', 'Left the workspace');
    await db.query("delete from members where workspace_id = $1 and user_id = $2 and role <> 'owner'", [ctx.workspace.id, ctx.user.id]);
    return { ok: true };
  }, { auth: 'workspace' });

  r.post('/api/app/team/role', async (ctx) => {
    ownerOnly(ctx);
    const role = oneOf(ctx.body.role, 'Role', ['sender', 'drafter']);
    const uid = int(ctx.body.user_id, 'Person');
    const cur = await db.one('select role from members where workspace_id = $1 and user_id = $2', [ctx.workspace.id, uid]);
    // A helper becoming a teammate would need a seat; remove them and invite them as a teammate instead.
    if (cur && cur.role === 'helper') throw badRequest('The setup helper has their own role. To make them a teammate, remove them and invite them with a role.');
    await db.query("update members set role = $3 where workspace_id = $1 and user_id = $2 and role not in ('owner','helper')", [ctx.workspace.id, uid, role]);
    return { ok: true };
  }, { auth: 'workspace' });

  /** What an invite is, for the screen before accepting (the setup helper's consent screen). */
  r.get('/api/invites/:token', async (ctx) => {
    const inv = await openInvite(ctx, ctx.params.token);
    const ws = await db.one('select w.name, w.owner_user_id, u.name as owner_name from workspaces w join users u on u.id = w.owner_user_id where w.id = $1', [inv.workspace_id]);
    const member = await db.one('select role from members where workspace_id = $1 and user_id = $2', [inv.workspace_id, ctx.user.id]);
    return {
      role: inv.role, kind: inv.kind, expires_at: inv.expires_at,
      workspace_name: ws.name, owner_name: safeName((ws.owner_name || '').split(' ')[0], 'The owner'),
      already_member: !!member,
      can: inv.role === 'helper' ? helper.CAN : [], cannot: inv.role === 'helper' ? helper.CANNOT : [],
    };
  }, { auth: 'user', rate: [60, 600] });

  r.post('/api/invites/accept', async (ctx) => {
    const inv = await openInvite(ctx, ctx.body.token);
    if (inv.role === 'helper' && ctx.body.consent !== true) throw badRequest('Read what a setup helper can do, then tap Accept.', 'consent_needed');
    const already = await db.one('select role from members where workspace_id = $1 and user_id = $2', [inv.workspace_id, ctx.user.id]);
    if (already) throw httpError(409, already.role === 'owner' ? 'This is your own workspace. Send the invite to the person who will help you.' : 'You are already in this workspace.', 'already_member');
    await db.tx(async (c) => {
      // Used once: a link invite belongs to the first person who accepts it.
      const used = (await c.query('update invites set accepted_at = now(), accepted_by = $2 where token = $1 and accepted_at is null and declined_at is null and expires_at > now() returning token', [inv.token, ctx.user.id])).rows[0];
      if (!used) throw notFound('That invite');
      if (inv.role === 'helper') {
        await c.query('select pg_advisory_xact_lock(7101, $1::int)', [inv.workspace_id]);
        const h = (await c.query("select 1 from members where workspace_id = $1 and role = 'helper'", [inv.workspace_id])).rows[0];
        if (h) throw httpError(409, 'This workspace already has a setup helper. Ask the owner to remove them first.', 'helper_exists');
      }
      await c.query('insert into members(workspace_id, user_id, role, owner_seen) values ($1,$2,$3,$4) on conflict do nothing', [inv.workspace_id, ctx.user.id, inv.role, inv.role !== 'helper']);
    });
    if (inv.role === 'helper') {
      await helperLog.record(inv.workspace_id, ctx.user.id, 'helper.joined', 'Joined as setup helper');
      const ws = await db.one('select w.name, u.* from workspaces w join users u on u.id = w.owner_user_id where w.id = $1', [inv.workspace_id]);
      if (ws) await email.send('helper_joined', ws, { helper_name: safeName(ctx.user.name, 'Your setup helper'), helper_contact: maskEmail(ctx.user.email) || (ctx.user.tg_username ? '@' + ctx.user.tg_username : 'a Castvoo account'), workspace_name: safeName(ws.name, 'your workspace'), team_url: `${config.appUrl}/#app/settings?tab=team` });
    }
    return { ok: true, workspace_id: inv.workspace_id, role: inv.role };
  }, { auth: 'user' });

  r.post('/api/invites/decline', async (ctx) => {
    const inv = await openInvite(ctx, ctx.body.token);
    await db.query('update invites set declined_at = now() where token = $1 and accepted_at is null', [inv.token]);
    return { ok: true };
  }, { auth: 'user', rate: [30, 600] });

  /* ---------- Plan ---------- */
  r.get('/api/app/plan', async (ctx) => billing.planState(ctx.workspace), { auth: 'workspace' });

  r.post('/api/app/plan', async (ctx) => {
    canBilling(ctx);
    const ws = ctx.workspace;
    const code = str(ctx.body.plan, 'Plan', { min: 1, max: 30 });
    // AUD-8: on a move to a smaller plan the owner picks which Welcome Flows stay live (the others are switched off
    // and kept when the smaller plan starts). Only this workspace's flows count; unknown ids are ignored.
    if (Array.isArray(ctx.body.keep_flows)) {
      const ids = ctx.body.keep_flows.slice(0, 200).map((x) => Number(x)).filter((x) => Number.isSafeInteger(x) && x > 0);
      const own = ids.length ? (await db.many("select id from sequences where workspace_id = $1 and trigger_type = 'join_request' and id = any($2::bigint[])", [ctx.workspace.id, ids])).map((x) => String(x.id)) : [];
      await db.query('update workspaces set keep_flow_ids = $2 where id = $1', [ctx.workspace.id, ids.filter((x) => own.includes(String(x)))]);
      ctx.workspace.keep_flow_ids = ids;
    }
    const cycle = oneOf(ctx.body.cycle || ws.billing_cycle || 'month', 'Billing', ['month', 'year']);
    const plan = await settings.plan(code);
    if (!plan || !plan.active) throw badRequest('That plan is not available.');
    const cur0 = await settings.plan(ws.plan_code);
    const onFree = ws.plan_status === 'active' && billing.isFreePlan(cur0);
    if (billing.isFreePlan(plan)) {
      if (onFree) return { ok: true, message: `You are on ${plan.name} already.` };
      if (ws.plan_status === 'paused' || ws.plan_status === 'cancelled') {
        await billing.dropToFree(ws.id, { expect: (w) => w.plan_status === 'paused' || w.plan_status === 'cancelled' });
        return { ok: true, message: `You are on ${plan.name} now. Your first live Welcome Flow keeps welcoming people.` };
      }
      await db.query('update workspaces set pending_plan_code = $2, pending_cycle = $3 where id = $1', [ws.id, plan.code, 'month']);
      return { ok: true, message: ws.plan_status === 'trial' ? `${plan.name} starts when your free trial ends.` : `${plan.name} starts at your next renewal. Nothing more is charged.` };
    }
    if (onFree) {
      // From Free the new plan starts now, paid from the wallet (there is no period to finish).
      const rf = await billing.activate(ws.id, code, cycle, { expect: (w) => w.plan_code === ws.plan_code && w.plan_status === 'active' });
      if (rf.skipped) throw httpError(409, 'Your plan changed a moment ago. Refresh the page and try again.', 'plan_changed');
      return { ok: true, message: `${plan.name} is active. Welcome aboard!` };
    }
    if (ws.plan_status === 'trial') {
      // Picked during the trial: it starts (and is paid) when the trial ends, unless they want to start now.
      if (ctx.body.start_now) {
        const r0 = await billing.activate(ws.id, code, cycle, { expect: (w) => w.plan_status === 'trial' });
        if (r0.skipped) throw httpError(409, 'Your plan changed a moment ago. Refresh the page and try again.', 'plan_changed');
        return { ok: true, message: `${plan.name} is active.` };
      }
      await db.query('update workspaces set pending_plan_code = $2, pending_cycle = $3 where id = $1', [ws.id, code, cycle]);
      return { ok: true, message: `${plan.name} starts when your free trial ends.` };
    }
    if (ws.plan_status === 'paused' || ws.plan_status === 'cancelled') {
      // expect: a top-up may have restarted the plan a moment ago; don't charge it twice.
      const r1 = await billing.activate(ws.id, code, cycle, { expect: (w) => w.plan_status === 'paused' || w.plan_status === 'cancelled' });
      if (r1.skipped) throw httpError(409, 'Your plan changed a moment ago. Refresh the page and try again.', 'plan_changed');
      return { ok: true, message: `${plan.name} is active again.` };
    }
    const cur = await settings.plan(ws.plan_code);
    if (cycle === ws.billing_cycle && billing.priceOf(plan, cycle) > billing.priceOf(cur, cycle)) {
      const r2 = await billing.upgradeNow(ws.id, code);
      return { ok: true, message: `Upgraded to ${plan.name}. ${r2.charged ? fmtUSD(r2.charged) + ' was taken for the rest of this period.' : ''}`.trim() };
    }
    await db.query('update workspaces set pending_plan_code = $2, pending_cycle = $3 where id = $1', [ws.id, code, cycle]);
    return { ok: true, message: `${plan.name} (${cycle === 'year' ? 'yearly' : 'monthly'}) starts at your next renewal.` };
  }, { auth: 'workspace' });

  r.post('/api/app/plan/cancel', async (ctx) => {
    ownerOnly(ctx);
    await db.query('update workspaces set cancel_at_period_end = $2 where id = $1', [ctx.workspace.id, ctx.body.resume ? false : true]);
    // VooSquare hears plan_cancelled when the plan really ends (workers/jobs.js), so a resumed plan never reports a cancel.
    return { ok: true };
  }, { auth: 'workspace' });

  r.post('/api/app/coupon', async (ctx) => {
    canBilling(ctx);
    const code = str(ctx.body.code, 'Coupon code', { min: 2, max: 40 }).toUpperCase();
    const o = (await settings.activeOffers('coupon')).find((x) => (x.code || '').toUpperCase() === code);
    if (!o) throw badRequest('That code is not valid or has expired.');
    // One use per account, recorded in coupon_redemptions. (Checking workspaces.coupon_id alone was not
    // enough: it is cleared when the discount runs out, so the same code could be used again and again.)
    await db.tx(async (c) => {
      const owner = ctx.workspace.owner_user_id;
      const old = (await c.query('select 1 from workspaces where owner_user_id = $1 and coupon_id = $2', [owner, o.id])).rows[0];
      const first = (await c.query('insert into coupon_redemptions(offer_id, user_id, workspace_id) values ($1,$2,$3) on conflict do nothing returning offer_id', [o.id, owner, ctx.workspace.id])).rows[0];
      if (old || !first) throw badRequest('You already used this code.');
      const r2 = (await c.query('update offers set uses = uses + 1 where id = $1 and (max_uses is null or uses < max_uses) returning id', [o.id])).rows[0];
      if (!r2) throw badRequest('This code has been used up.');
      await c.query('update workspaces set coupon_id = $2, coupon_months_left = $3 where id = $1', [ctx.workspace.id, o.id, o.months || 1]);
    });
    settings.bust();
    return { ok: true, message: `${o.percent}% off your next ${o.months > 1 ? o.months + ' plan payments' : 'plan payment'}.` };
  }, { auth: 'workspace', rate: [20, 3600] });

  /* ---------- Train Cas ---------- */
  r.get('/api/app/ai-profile', async (ctx) => ({ profile: ctx.workspace.ai_profile || {} }), { auth: 'workspace' });

  r.post('/api/app/ai-profile', async (ctx) => {
    canSend(ctx);
    const b = ctx.body || {};
    const f = (k, max) => str(b[k], k, { max, required: false }) || '';
    const examples = Array.isArray(b.examples) ? b.examples.slice(0, 5).map((x) => str(x, 'Example message', { max: 1500, required: false }) || '').filter(Boolean) : [];
    const faqs = Array.isArray(b.faqs) ? b.faqs.slice(0, 15).map((x) => ({ q: str(x && x.q, 'Question', { max: 300, required: false }) || '', a: str(x && x.a, 'Answer', { max: 1000, required: false }) || '' })).filter((x) => x.q && x.a) : [];
    const profile = {
      business: f('business', 120), what_you_sell: f('what_you_sell', 1500), audience: f('audience', 800), tone: f('tone', 200),
      language: f('language', 60), offers: f('offers', 1500), links: f('links', 800), always: f('always', 600), never: f('never', 600),
      examples, faqs,
    };
    for (const k of Object.keys(profile)) if (!profile[k] || (Array.isArray(profile[k]) && !profile[k].length)) delete profile[k];
    await db.query('update workspaces set ai_profile = $2 where id = $1', [ctx.workspace.id, JSON.stringify(profile)]);
    return { ok: true, profile };
  }, { auth: 'workspace' });
};

module.exports.ownerOnly = ownerOnly;
module.exports.canSetup = canSetup;
module.exports.canSend = canSend;

'use strict';
/*
 * app-account.js: Settings (profile, workspace, team, your data) and Help (support chat).
 * API: POST /api/me, /api/me/email/*, /api/app/settings, GET /api/app/team (+ invite, role, remove),
 *      GET /api/me/export, POST /api/me/delete, POST /api/auth/logout, GET/POST /api/support
 */

function timeZones(cur) {
  let z = [];
  try { z = Intl.supportedValuesOf('timeZone'); } catch (_) { z = ['UTC', 'Africa/Lagos', 'Africa/Nairobi', 'Africa/Accra', 'Africa/Johannesburg', 'Africa/Douala', 'Africa/Cairo', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Jakarta']; }
  if (cur && !z.includes(cur)) z.unshift(cur);
  return z;
}

PAGES.settings = {
  title: 'Settings', sub: 'Profile, workspace, team and your data',
  async render(el, q, alive) {
    el.innerHTML = '<div class="dg"><div class="c6">' + skel(1, 380) + '</div><div class="c6">' + skel(1, 380) + '</div></div>';
    const [me, team] = await Promise.all([GET('/api/me'), GET('/api/app/team').catch(() => null)]);
    if (!alive()) return;
    ME = me;
    const u = me.user, ws = APP.state.workspace, owner = isOwner(), p = APP.state.plan;
    const ctry = (CFG.countries || []);
    const L = CFG.login || {};
    el.innerHTML = '<div class="dg">' +
      // Profile
      '<div class="box c6" id="stProfile"><div class="bh"><h3>' + icon('users') + 'Your profile</h3></div>' +
      '<div class="field"><label for="stName">Your name</label><input class="inp" id="stName" maxlength="80" value="' + esc(u.name || '') + '"></div>' +
      '<div class="field"><label for="stCt">Country</label><select class="inp" id="stCt"><option value="">Choose your country</option>' + ctry.map((c) => '<option value="' + esc(c.code) + '"' + (c.code === u.country ? ' selected' : '') + '>' + esc(c.flag + ' ' + c.name) + '</option>').join('') + '</select><small class="hint" id="stCtH">Your country decides which payment methods you see when you top up.</small></div>' +
      '<button type="button" class="btn b-blue sm" id="stPSave" style="align-self:flex-start">Save profile</button>' +
      '<div class="srow"><span class="sri">' + icon('mail') + '</span><div style="flex:1;min-width:0"><b>Email</b><small class="ell" style="display:block">' + (u.email ? esc(u.email) + (u.email_verified ? ' · verified' : '') : 'No email yet. Add one for receipts and login codes.') + '</small></div><button type="button" class="btn b-ghost xs" id="stEm">' + (u.email ? 'Change' : 'Add email') + '</button></div><div id="stEmBox"></div>' +
      '<div class="srow"><span class="sri">' + icon('tg') + '</span><div style="flex:1;min-width:0"><b>Telegram</b><small style="display:block">' + (u.tg_linked ? 'Linked' + (u.tg_username ? ' as @' + esc(u.tg_username) : '') + '. Used for channels, groups and test messages.' : 'Not linked. Link it to add channels and groups and get test messages.') + '</small></div>' + (u.tg_linked ? '<span class="pill p-ok">Linked</span>' : '<button type="button" class="btn b-ghost xs" id="stTg">Link Telegram</button>') + '</div>' +
      (u.google_linked ? '<div class="srow"><span class="sri">G</span><div style="flex:1"><b>Google</b><small style="display:block">You can log in with Google.</small></div><span class="pill p-ok">Linked</span></div>' : '') +
      (L.voosquare ? '<div class="srow"><span class="sri vq">V</span><div style="flex:1;min-width:0"><b>VooSquare</b><small style="display:block">' + (u.voo_linked ? 'Linked. One Voo ID for all Zedapex tools.' : 'Connect your VooSquare account to log in with your Voo ID.') + '</small></div>' + (u.voo_linked ? '<span class="pill p-ok">Linked</span>' : '<button type="button" class="btn b-ghost xs" id="stVoo">Connect</button>') + '</div>' : '') +
      '<div class="tg"><span><b style="font-size:14.5px">Tips and offers by email</b><br><small class="muted">Helpful emails about getting more from Castvoo. Receipts and login codes always arrive.</small></span>' + toggleBtn('stMk', !u.marketing_opt_out, 'Tips and offers by email') + '</div></div>' +
      // Workspace
      '<div class="box c6"><div class="bh"><h3>' + icon('gear') + 'Workspace</h3>' + (owner ? '' : '<span class="pill p-grey">Only the owner can change these</span>') + '</div>' +
      '<div class="field"><label for="wsN">Workspace name</label><input class="inp" id="wsN" maxlength="60" value="' + esc(ws.name) + '"' + (owner ? '' : ' disabled') + '></div>' +
      '<div class="field"><label for="wsTz">Time zone</label><select class="inp" id="wsTz"' + (owner ? '' : ' disabled') + '>' + timeZones(ws.timezone).map((z) => '<option' + (z === ws.timezone ? ' selected' : '') + '>' + esc(z) + '</option>').join('') + '</select><small class="hint">Used for "9am local time" and for dates in reports. Pick where most of your audience lives.</small></div>' +
      '<div class="field"><label for="wsCap">Most messages one person gets per day</label><select class="inp" id="wsCap"' + (owner ? '' : ' disabled') + '><option value="0"' + (!ws.daily_cap ? ' selected' : '') + '>No limit</option>' + Array.from({ length: 20 }, (_, i) => '<option value="' + (i + 1) + '"' + (ws.daily_cap === i + 1 ? ' selected' : '') + '>' + (i + 1) + '</option>').join('') + '</select><small class="hint">Too many messages a day makes people block bots. 2 or 3 is a safe limit. Applies to bot broadcasts.</small></div>' +
      '<div class="tg"><span><b style="font-size:14.5px">Approve before sending</b><br><small class="muted">Teammates\' messages wait for the owner to approve them.</small></span>' + toggleBtn('wsAp', ws.require_approval, 'Approve before sending') + '</div>' +
      (owner ? '<button type="button" class="btn b-blue sm" id="wsSave" style="align-self:flex-start">Save workspace</button>' : '') +
      '<div class="srow"><span class="sri">' + icon('wallet') + '</span><div style="flex:1;min-width:0"><b>Plan: ' + esc(p.plan_name) + '</b><small style="display:block">' + esc({ trial: 'Free trial', active: 'Active', paused: 'Paused', cancelled: 'No active plan' }[p.status] || p.status) + '</small></div><button type="button" class="btn b-ghost xs" data-go="wallet">Manage plan</button></div></div>' +
      // Team
      '<div class="box c6" id="stTeam"><div class="bh"><h3>' + icon('users') + 'Team</h3>' + (team ? '<span class="hint">' + fmt(team.members.length + team.invites.length) + ' of ' + plural(team.seats, 'seat') + ' used</span>' : '') + '</div>' +
      (team ? team.members.map((m) => '<div class="srow">' + ava(m.name || m.email || '?', 40) + '<div style="flex:1;min-width:0"><b class="ell" style="display:block">' + esc(m.name || 'Teammate') + (m.id === u.id ? ' <span class="muted">(you)</span>' : '') + '</b><small class="ell" style="display:block">' + esc(m.email || (m.tg_username ? '@' + m.tg_username : '')) + '</small></div>' + (owner && m.role !== 'owner' ? '<select class="inp sm" data-role="' + m.id + '" aria-label="Role"><option value="sender"' + (m.role === 'sender' ? ' selected' : '') + '>Can send</option><option value="drafter"' + (m.role === 'drafter' ? ' selected' : '') + '>Drafts only</option></select><button type="button" class="x" data-rmm="' + m.id + '" aria-label="Remove ' + esc(m.name) + '"><svg width="15" height="15"><use href="#i-trash"/></svg></button>' : '<span class="pill p-grey">' + roleName(m.role) + '</span>') + '</div>').join('') +
        team.invites.map((i) => '<div class="srow"><span class="sri">' + icon('mail') + '</span><div style="flex:1;min-width:0"><b class="ell" style="display:block">' + esc(i.email) + '</b><small>Invited · ' + roleName(i.role) + ' · expires ' + fmtDate(i.expires_at, false) + '</small></div><span class="pill p-warn">Waiting</span></div>').join('') : '<p class="muted">Could not load the team.</p>') +
      (owner ? '<form class="invf" id="invF" novalidate><input class="inp" id="invE" type="email" placeholder="teammate@company.com" aria-label="Teammate email"><select class="inp sm" id="invR" aria-label="Role"><option value="sender">Can send</option><option value="drafter">Drafts only</option></select><button type="submit" class="btn b-blue sm">' + icon('plus') + 'Invite</button></form><p class="ferr" id="invErr" hidden></p><div id="invOk"></div><p class="hint"><b>Can send:</b> writes and sends messages. <b>Drafts only:</b> writes, and the owner sends.</p>' : '') + '</div>' +
      // Data
      '<div class="box c6"><div class="bh"><h3>' + icon('shield') + 'Your data</h3></div><p class="muted" style="font-size:14px">Download everything Castvoo holds about you, or delete your account. Read the <a href="/legal/privacy" target="_blank" rel="noopener">privacy policy</a>.</p>' +
      '<div class="srow"><span class="sri">' + icon('down') + '</span><div style="flex:1"><b>Download my data</b><small style="display:block">A file with your account, workspaces, subscribers and messages.</small></div><a class="btn b-ghost xs" href="/api/me/export" download>Download</a></div>' +
      '<div class="srow"><span class="sri bad">' + icon('trash') + '</span><div style="flex:1"><b>Delete my account</b><small style="display:block">Removes your account, bots, subscribers and messages. This can\'t be undone.</small></div><button type="button" class="btn b-ghost xs danger" id="stDel">Delete…</button></div>' +
      '<button type="button" class="btn b-ghost sm" data-logout style="align-self:flex-start">' + icon('out') + 'Log out</button>' +
      '<p class="hint"><a href="/legal/terms" target="_blank" rel="noopener">Terms</a> · <a href="/legal/privacy" target="_blank" rel="noopener">Privacy</a> · <a href="/legal/refunds" target="_blank" rel="noopener">Refunds</a> · <a href="/legal/acceptable-use" target="_blank" rel="noopener">Acceptable use</a> · <a href="/legal/cookies" target="_blank" rel="noopener">Cookies</a></p></div>' +
      '</div>';
    if (q.tab === 'team') later(150, () => { const t = $('#stTeam'); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); });

    const ctH = () => { const c = $('#stCt').value; if (!c) return; GET('/api/public/methods?country=' + c).then((r) => { if ($('#stCtH')) $('#stCtH').textContent = r.methods.length ? 'You can pay with: ' + r.methods.map((m) => m.label + (m.detail ? ' (' + m.detail + ')' : '')).join(', ') + '.' : 'Card and crypto options appear here once payments are switched on.'; }).catch(() => {}); };
    $('#stCt').onchange = ctH; ctH();
    const sv = $('#stVoo'); if (sv) sv.onclick = async () => {
      btnBusy(sv, true, 'Opening…');
      try { const r = await POST('/api/auth/voosquare/link'); location.href = r.url; } catch (ex) { btnBusy(sv, false); apiErr(ex); }
    };
    $('#stPSave').onclick = async (e) => {
      const name = $('#stName').value.trim();
      if (!name) { toast('Your name can\'t be empty.', { kind: 'err' }); return; }
      btnBusy(e.currentTarget, true, 'Saving…');
      try { const body = { name }; if ($('#stCt').value) body.country = $('#stCt').value; ME = await POST('/api/me', body); shellUI(); toast('Profile saved.'); } catch (ex) { apiErr(ex); }
      btnBusy(e.currentTarget, false);
    };
    $('#stMk').onclick = async (e) => {
      const b = e.currentTarget, on = !b.classList.contains('on');
      setToggle(b, on);
      try { ME = await POST('/api/me', { marketing_opt_out: !on }); toast(on ? 'You\'ll get tips and offers.' : 'No more tips and offers by email.'); } catch (ex) { setToggle(b, !on); apiErr(ex); }
    };
    const tg = $('#stTg'); if (tg) tg.onclick = () => linkTelegram(() => renderPage('settings', {}));
    $('#stEm').onclick = () => { emailMini($('#stEmBox'), () => renderPage('settings', {})); const t = $('#stEmBox b'); if (t) t.textContent = 'Your email'; const p2 = $('#stEmBox p'); if (p2) p2.textContent = 'We send a 6-digit code to check it\'s yours.'; };
    const ap = $('#wsAp'); ap.onclick = () => { if (owner) setToggle(ap, !ap.classList.contains('on')); };
    const wsv = $('#wsSave'); if (wsv) wsv.onclick = async (e) => {
      btnBusy(e.currentTarget, true, 'Saving…');
      try { await POST('/api/app/settings', { name: $('#wsN').value.trim(), timezone: $('#wsTz').value, daily_cap: +$('#wsCap').value, require_approval: ap.classList.contains('on') }); await refreshState(); await loadMe(); toast('Workspace saved.'); } catch (ex) { apiErr(ex); }
      btnBusy(e.currentTarget, false);
    };
    const inv = $('#invF'); if (inv) inv.onsubmit = async (e) => {
      e.preventDefault();
      const email = $('#invE').value.trim(), err = $('#invErr');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { err.textContent = 'Enter your teammate\'s email.'; err.hidden = false; return; }
      err.hidden = true;
      const b = $('button[type=submit]', inv); btnBusy(b, true, '');
      try {
        const r = await POST('/api/app/team/invite', { email, role: $('#invR').value });
        toast('Invite sent to ' + email + '.');
        renderPage('settings', { tab: 'team' }).then(() => { const ok = $('#invOk'); if (ok) ok.innerHTML = '<div class="copy"><code>' + esc(r.link) + '</code><button type="button" class="btn b-blue xs" data-copy="' + esc(r.link) + '" data-msg="Invite link copied">' + icon('copy') + 'Copy</button></div><p class="hint">We emailed it. You can also send this link yourself. It works for 7 days.</p>'; });
      } catch (ex) { btnBusy(b, false); err.textContent = ex.message; err.hidden = false; apiErr(ex, { silent: true }); }
    };
    el.addEventListener('change', async (e) => {
      const r = e.target.closest('[data-role]'); if (!r) return;
      try { await POST('/api/app/team/role', { user_id: +r.dataset.role, role: r.value }); toast('Role changed.'); } catch (ex) { apiErr(ex); }
    });
    el.addEventListener('click', async (e) => {
      const rm = e.target.closest('[data-rmm]');
      if (rm) { if (!(await confirmBox('Remove this teammate?', 'They lose access to this workspace straight away.', 'Remove', true))) return; try { await POST('/api/app/team/remove', { user_id: +rm.dataset.rmm }); toast('Removed.'); renderPage('settings', { tab: 'team' }); } catch (ex) { apiErr(ex); } return; }
      if (e.target.closest('#stDel')) deleteAccount();
    });
  },
};

function deleteAccount() {
  const h = sheet('Delete your account', '<span class="spk" style="background:var(--bad)">' + icon('trash') + '</span>',
    '<p class="muted" style="font-size:14.5px">This deletes your account and the workspaces you own: bots, subscribers, messages and follow-ups. Payment records are kept because the law requires it, but they are no longer linked to you. <b>This can\'t be undone.</b></p>' +
    '<p class="muted" style="font-size:14px">Unused wallet money? Ask for a refund first from the Help page.</p>' +
    '<div class="field"><label for="delI">Type DELETE to confirm</label><input class="inp" id="delI" autocomplete="off" placeholder="DELETE"></div><p class="ferr" id="delE" hidden></p>' +
    '<div class="row2b"><button type="button" class="btn b-ghost" data-shx>Keep my account</button><button type="button" class="btn b-bad" id="delGo" disabled>Delete forever</button></div>');
  $('#delI', h).oninput = (e) => { $('#delGo', h).disabled = e.target.value.trim().toUpperCase() !== 'DELETE'; };
  $('#delGo', h).onclick = async (e) => {
    btnBusy(e.currentTarget, true, 'Deleting…');
    try { await POST('/api/me/delete', { confirm: 'DELETE' }); closeModal(); ME = { user: null, workspaces: [] }; APP.booted = false; APP.state = null; WS.set(null); siteAuthUI(); location.hash = '#top'; toast('Your account was deleted. Thank you for trying Castvoo.'); }
    catch (ex) { btnBusy(e.currentTarget, false); $('#delE', h).textContent = ex.message; $('#delE', h).hidden = false; }
  };
}

/* ---------- Help ---------- */
PAGES.help = {
  title: 'Help', sub: 'Chat with the Castvoo team',
  async render(el, q, alive) {
    el.innerHTML = skel(1, 140) + skel(1, 360);
    const s = CFG.support || {};
    const chatOn = CFG.features.support_chat !== false;
    let d = chatOn ? await GET('/api/support') : { messages: [], reply_time: s.reply_time };
    if (!alive()) return;
    if (APP.state.support_unread) { APP.state.support_unread = 0; shellUI(); }
    el.innerHTML = '<div class="box hello helpb"><div style="display:flex;flex-direction:column;gap:10px;min-width:0;padding-bottom:16px"><h2>How can we help?</h2><p>' + esc(d.reply_time || s.reply_time || '') + '</p><div class="acts"><a class="btn b-w" href="mailto:' + esc(s.email) + '">' + icon('mail') + esc(s.email) + '</a>' + (s.telegram ? '<a class="btn b-g" href="https://t.me/' + esc(String(s.telegram).replace(/^@/, '')) + '" target="_blank" rel="noopener">' + icon('tg') + '@' + esc(String(s.telegram).replace(/^@/, '')) + '</a>' : '') + '</div></div><div class="hart" data-cas="happy"></div></div>' +
      '<div class="dg"><div class="box c8 chatb"><div class="bh"><h3>' + icon('chat') + 'Chat with the team</h3>' + (chatOn ? '<span class="pill p-ok"><span class="dl"></span>We reply here and by email</span>' : '') + '</div>' +
      (chatOn ? '<div class="chatl tall" id="hpL"></div><form class="chatf" id="hpF"><textarea class="inp" id="hpQ" rows="2" maxlength="4000" placeholder="Write your message. Tell us what you were trying to do." aria-label="Your message"></textarea><button type="submit" class="btn b-blue" aria-label="Send">' + icon('send') + '<span class="hide-sm">Send</span></button></form>'
        : emptyBox({ plain: 1, emoji: '✉️', title: 'Chat is offline right now', text: 'Email us at <a href="mailto:' + esc(s.email) + '">' + esc(s.email) + '</a> and we\'ll get back to you.' })) + '</div>' +
      '<div class="box c4"><div class="bh"><h3>Quick help</h3></div><div class="qhelp"><button type="button" data-guide>' + icon('play') + '<span><b>Watch the setup guide</b><small>Connect Telegram in 40 seconds</small></span></button>' + (aiOn() ? '<button type="button" data-go="ai">' + icon('spark') + '<span><b>Ask Cas</b><small>Instant answers, any time</small></span></button>' : '') + '<a href="/#faq" target="_blank" rel="noopener">' + icon('help') + '<span><b>Read the FAQ</b><small>Common questions</small></span></a><a href="/legal/refunds" target="_blank" rel="noopener">' + icon('wallet') + '<span><b>Refunds</b><small>How refunds work</small></span></a></div></div></div>';
    if (!chatOn) return;
    const draw = () => {
      const L = $('#hpL'); if (!L) return;
      const atBottom = L.scrollHeight - L.scrollTop - L.clientHeight < 60;
      L.innerHTML = d.messages.length ? d.messages.map((m) => '<div class="cmsg ' + (m.author_type === 'user' ? 'u' : 'a') + '">' + (m.author_type === 'user' ? '' : '<span class="cav team">' + esc((m.author_name || 'C')[0]) + '</span>') + '<div class="cb">' + (m.author_type === 'user' ? '' : '<small class="cn">' + esc(m.author_name || 'Castvoo team') + '</small>') + esc(m.body).replace(/\n/g, '<br>') + '<small class="ct">' + fmtDate(m.created_at) + '</small></div></div>').join('')
        : '<div class="cmsg a"><span class="cav" data-cas="mini"></span><div class="cb">Hi! Send us a message about anything: setup, payments, or a question about your bot. A real person from the Castvoo team will answer.</div></div>';
      paintCas(L);
      if (atBottom || !draw.done) L.scrollTop = L.scrollHeight;
      draw.done = true;
    };
    draw();
    $('#hpF').onsubmit = async (e) => {
      e.preventDefault();
      const t = $('#hpQ').value.trim(); if (!t) return;
      const b = $('button[type=submit]', e.currentTarget); btnBusy(b, true, '');
      try { await POST('/api/support', { body: t }); $('#hpQ').value = ''; d = await GET('/api/support'); draw.done = false; draw(); toast('Sent. We\'ll reply here and by email.'); } catch (ex) { apiErr(ex); }
      btnBusy(b, false);
    };
    $('#hpQ').onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#hpF').requestSubmit(); };
    every(10000, async () => { try { const n = await GET('/api/support'); if (!alive()) return; if (n.messages.length !== d.messages.length) { d = n; draw(); } } catch (_) { /* try again later */ } });
  },
};

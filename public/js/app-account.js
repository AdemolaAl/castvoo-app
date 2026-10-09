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
    const u = me.user, ws = APP.state.workspace, owner = isOwner(), setup = canSetup(), p = APP.state.plan;
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
      (L.voosquare ? '<div class="srow"><span class="sri vq">V</span><div style="flex:1;min-width:0"><b>VooSquare</b><small style="display:block">' + (u.voo_linked ? 'Linked. One Voo ID for all Zedapex tools.' : 'Connect your VooSquare account to log in with your Voo ID.') + '</small></div>' + (u.voo_linked ? '<span class="pill p-ok">Linked</span>' : '<button type="button" class="btn b-ghost xs" id="stVoo">Connect</button>') + '</div>' : '') +
      '<div class="tg"><span><b style="font-size:14.5px">Tips and offers by email</b><br><small class="muted">Helpful emails about getting more from Castvoo. Receipts and login codes always arrive.</small></span>' + toggleBtn('stMk', !u.marketing_opt_out, 'Tips and offers by email') + '</div></div>' +
      // Workspace
      '<div class="box c6"><div class="bh"><h3>' + icon('gear') + 'Workspace</h3>' + (setup ? '' : '<span class="pill p-grey">Only the owner can change these</span>') + '</div>' +
      '<div class="field"><label for="wsN">Workspace name</label><input class="inp" id="wsN" maxlength="60" value="' + esc(ws.name) + '"' + (setup ? '' : ' disabled') + '></div>' +
      '<div class="field"><label for="wsTz">Time zone</label><select class="inp" id="wsTz"' + (setup ? '' : ' disabled') + '>' + timeZones(ws.timezone).map((z) => '<option' + (z === ws.timezone ? ' selected' : '') + '>' + esc(z) + '</option>').join('') + '</select><small class="hint">Used for "9am local time" and for dates in reports. Pick where most of your audience lives.</small></div>' +
      '<div class="field"><label for="wsCap">Most messages one person gets per day</label><select class="inp" id="wsCap"' + (setup ? '' : ' disabled') + '><option value="0"' + (!ws.daily_cap ? ' selected' : '') + '>No limit</option>' + Array.from({ length: 20 }, (_, i) => '<option value="' + (i + 1) + '"' + (ws.daily_cap === i + 1 ? ' selected' : '') + '>' + (i + 1) + '</option>').join('') + '</select><small class="hint">Too many messages a day makes people block bots. 2 or 3 is a safe limit. Applies to bot broadcasts.</small></div>' +
      '<div class="tg"><span><b style="font-size:14.5px">Approve before sending</b><br><small class="muted">Teammates\' messages wait for the owner to approve them.</small></span>' + toggleBtn('wsAp', ws.require_approval, 'Approve before sending') + '</div>' +
      (setup ? '<button type="button" class="btn b-blue sm" id="wsSave" style="align-self:flex-start">Save workspace</button>' : '') +
      '<div class="srow"><span class="sri">' + icon('wallet') + '</span><div style="flex:1;min-width:0"><b>Plan: ' + esc(p.plan_name) + '</b><small style="display:block">' + esc({ trial: 'Free trial', active: 'Active', paused: 'Paused', cancelled: 'No active plan' }[p.status] || p.status) + '</small></div><button type="button" class="btn b-ghost xs" data-go="wallet">Manage plan</button></div></div>' +
      // Team
      '<div class="box c6" id="stTeam"><div class="bh"><h3>' + icon('users') + 'Team</h3>' + (team ? '<span class="hint">' + fmt(team.seats_used) + ' of ' + plural(team.seats, 'seat') + ' used</span>' : '') + '</div>' +
      (team ? team.members.filter((m) => m.role !== 'helper').map((m) => '<div class="srow">' + ava(m.name || m.email || '?', 40) + '<div style="flex:1;min-width:0"><b class="ell" style="display:block">' + esc(m.name || 'Teammate') + (m.id === u.id ? ' <span class="muted">(you)</span>' : '') + '</b><small class="ell" style="display:block">' + esc(m.email || (m.tg_username ? '@' + m.tg_username : '')) + '</small></div>' + (owner && m.role !== 'owner' ? '<select class="inp sm" data-role="' + m.id + '" aria-label="Role"><option value="sender"' + (m.role === 'sender' ? ' selected' : '') + '>Can send</option><option value="drafter"' + (m.role === 'drafter' ? ' selected' : '') + '>Drafts only</option></select><button type="button" class="x" data-rmm="' + m.id + '" aria-label="Remove ' + esc(m.name) + '"><svg width="15" height="15"><use href="#i-trash"/></svg></button>' : '<span class="pill p-grey">' + roleName(m.role) + '</span>') + '</div>').join('') +
        team.invites.map((i) => '<div class="srow"><span class="sri">' + icon('mail') + '</span><div style="flex:1;min-width:0"><b class="ell" style="display:block">' + esc(i.email) + '</b><small>Invited · ' + roleName(i.role) + ' · expires ' + fmtDate(i.expires_at, false) + '</small></div><span class="pill p-warn">Waiting</span></div>').join('') : '<p class="muted">Could not load the team.</p>') +
      (owner ? '<form class="invf" id="invF" novalidate><input class="inp" id="invE" type="email" placeholder="teammate@company.com" aria-label="Teammate email"><select class="inp sm" id="invR" aria-label="Role"><option value="sender">Can send</option><option value="drafter">Drafts only</option></select><button type="submit" class="btn b-blue sm">' + icon('plus') + 'Invite</button></form><p class="ferr" id="invErr" hidden></p><div id="invOk"></div><p class="hint"><b>Can send:</b> writes and sends messages. <b>Drafts only:</b> writes, and the owner sends.</p>' : '') + '</div>' +
      // Setup helper
      (team ? helperBox(team, u) : '') +
      // Data
      '<div class="box c6"><div class="bh"><h3>' + icon('shield') + 'Your data</h3></div><p class="muted" style="font-size:14px">Download everything Castvoo holds about you, or delete your account. Read the <a href="/legal/privacy" target="_blank" rel="noopener">privacy policy</a>.</p>' +
      '<div class="srow"><span class="sri">' + icon('down') + '</span><div style="flex:1"><b>Download my data</b><small style="display:block">A file with your account, workspaces, subscribers and messages.</small></div><a class="btn b-ghost xs" href="/api/me/export" download>Download</a></div>' +
      '<div class="srow"><span class="sri bad">' + icon('trash') + '</span><div style="flex:1"><b>Delete my account</b><small style="display:block">Removes your account, bots, subscribers and messages. This can\'t be undone.</small></div><button type="button" class="btn b-ghost xs danger" id="stDel">Delete…</button></div>' +
      '<button type="button" class="btn b-ghost sm" data-logout style="align-self:flex-start">' + icon('out') + 'Log out</button>' +
      '<p class="hint"><a href="/legal/terms" target="_blank" rel="noopener">Terms</a> · <a href="/legal/privacy" target="_blank" rel="noopener">Privacy</a> · <a href="/legal/refunds" target="_blank" rel="noopener">Refunds</a> · <a href="/legal/acceptable-use" target="_blank" rel="noopener">Acceptable use</a> · <a href="/legal/cookies" target="_blank" rel="noopener">Cookies</a></p></div>' +
      '</div>';
    if (q.tab === 'team' || q.tab === 'helper') later(150, () => { const t = $(q.tab === 'helper' ? '#stHelper' : '#stTeam'); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    if (team) wireHelperBox(el, team);

    const ctH = () => { const c = $('#stCt').value; if (!c) return; GET('/api/public/methods?country=' + c).then((r) => { if ($('#stCtH')) $('#stCtH').textContent = r.methods.length ? 'You can pay with: ' + r.methods.map((m) => m.label + (m.detail ? ' (' + m.detail + ')' : '')).join(', ') + '.' : 'Card and crypto options appear here once payments are switched on.'; }).catch(() => {}); };
    $('#stCt').onchange = ctH; ctH();
    const sv = $('#stVoo'); if (sv) sv.onclick = async () => {
      btnBusy(sv, true, 'Opening…');
      try { const r = await POST('/api/auth/voosquare/link'); location.href = r.url; } catch (ex) { btnBusy(sv, false); apiErr(ex); }
    };
    $('#stPSave').onclick = async (e) => {
      const name = $('#stName').value.trim();
      if (!name) { toast('Your name can\'t be empty.', { kind: 'err' }); return; }
      await busy(e.currentTarget, 'Saving…', async () => {
        try { const body = { name }; if ($('#stCt').value) body.country = $('#stCt').value; ME = await POST('/api/me', body); shellUI(); toast('Profile saved.'); } catch (ex) { apiErr(ex); }
      });
    };
    $('#stMk').onclick = async (e) => {
      const b = e.currentTarget, on = !b.classList.contains('on');
      setToggle(b, on);
      try { ME = await POST('/api/me', { marketing_opt_out: !on }); toast(on ? 'You\'ll get tips and offers.' : 'No more tips and offers by email.'); } catch (ex) { setToggle(b, !on); apiErr(ex); }
    };
    const tg = $('#stTg'); if (tg) tg.onclick = () => linkTelegram(() => renderPage('settings', {}));
    $('#stEm').onclick = () => { emailMini($('#stEmBox'), () => renderPage('settings', {})); const t = $('#stEmBox b'); if (t) t.textContent = 'Your email'; const p2 = $('#stEmBox p'); if (p2) p2.textContent = 'We send a 6-digit code to check it\'s yours.'; };
    const ap = $('#wsAp'); ap.onclick = () => { if (setup) setToggle(ap, !ap.classList.contains('on')); };
    const wsv = $('#wsSave'); if (wsv) wsv.onclick = async (e) => {
      await busy(e.currentTarget, 'Saving…', async () => {
        try { await POST('/api/app/settings', { name: $('#wsN').value.trim(), timezone: $('#wsTz').value, daily_cap: +$('#wsCap').value, require_approval: ap.classList.contains('on') }); await refreshState(); await loadMe(); toast('Workspace saved.'); } catch (ex) { apiErr(ex); }
      });
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

/* ---------- Setup helper (Settings → Team) ----------
 * One person the owner invites to set up and run the workspace with their own login. Free on every plan, no seat.
 * API: GET /api/app/team (helper: member, invite, settings, activity), POST /api/app/team/invite { role: 'helper' },
 *      /api/app/team/helper-link, /helper/cancel-invite, /helper/settings, /team/remove, /team/leave.
 */
function helperLists(can, cannot, who) {
  who = who || 'They';
  return '<div class="hlpl"><div><b class="ok">' + icon('check') + who + ' can</b><ul>' + (can || []).map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul></div>' +
    '<div><b class="no">' + icon('x') + who + ' can\'t</b><ul>' + (cannot || []).map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul></div></div>';
}
function helperBox(team, u) {
  const H = team.helper || {}, m = H.member, inv = H.invite;
  let body = '';
  if (isHelper()) {
    body = '<div class="srow">' + ava(u.name || u.email || '?', 40) + '<div style="flex:1;min-width:0"><b>You\'re the setup helper</b><small style="display:block">You use your own login. The owner can remove you at any time.</small></div><button type="button" class="btn b-ghost xs danger" data-helper-leave>Leave</button></div>' +
      helperLists(H.can, H.cannot, 'You') +
      '<p class="hint">Right now you ' + (H.settings.send ? 'can send broadcasts' : 'write and schedule broadcasts, and the owner sends them') + ', and you ' + (H.settings.billing ? 'can change the plan' : 'can\'t change the plan') + '.</p>';
  } else if (!isOwner()) {
    body = m ? '<div class="srow">' + ava(m.name || '?', 40) + '<div style="flex:1;min-width:0"><b class="ell" style="display:block">' + esc(m.name || 'Setup helper') + '</b><small>Setup helper · joined ' + esc(fmtDate(m.joined_at, false)) + '</small></div><span class="pill p-tg">Helper</span></div>' : '<p class="muted" style="font-size:14px">No setup helper yet. The owner can invite one.</p>';
  } else if (m) {
    const act = H.activity || [];
    body = '<div class="hlpm">' + ava(m.name || m.email || '?', 48) + '<div style="flex:1;min-width:0"><b class="ell" style="display:block;font-size:15.5px">' + esc(m.name || 'Setup helper') + ' <span class="pill p-tg">Helper</span></b><small class="ell" style="display:block">' + esc([m.email, m.tg_username ? '@' + m.tg_username : ''].filter(Boolean).join(' · ')) + '</small>' +
      '<small class="hlpd"><span>Joined ' + esc(fmtDate(m.joined_at, false)) + '</span><span>' + (m.last_active_at ? 'Active ' + esc(ago(m.last_active_at)) : 'Not active yet') + '</span></small></div></div>' +
      '<div class="tg"><span><b style="font-size:14.5px">Can send broadcasts</b><br><small class="muted">Off: they write and schedule, and you approve before anything goes out.</small></span>' + toggleBtn('hpSend', H.settings.send, 'Can send broadcasts') + '</div>' +
      '<div class="tg"><span><b style="font-size:14.5px">Can manage billing &amp; plan</b><br><small class="muted">Change the plan and use coupons. Cancelling, refunds and earnings stay yours.</small></span>' + toggleBtn('hpBill', H.settings.billing, 'Can manage billing and plan') + '</div>' +
      '<div class="hlpa"><b>Activity</b>' + (act.length ? '<ol>' + act.map((a) => '<li><span>' + esc(a.line) + '</span><small>' + esc(ago(a.created_at)) + '</small></li>').join('') + '</ol>' : '<p class="muted" style="font-size:14px;margin:6px 0 0">Nothing yet. What they change shows up here.</p>') + '</div>' +
      '<button type="button" class="btn b-ghost sm danger" id="hpRm" data-id="' + Number(m.id) + '" data-name="' + esc(m.name || 'your setup helper') + '" style="align-self:flex-start">' + icon('trash') + 'Remove helper</button>';
  } else if (inv) {
    body = '<div class="srow"><span class="sri">' + icon(inv.kind === 'link' ? 'link' : 'mail') + '</span><div style="flex:1;min-width:0"><b class="ell" style="display:block">' + (inv.kind === 'link' ? 'One-time invite link' : esc(inv.email)) + '</b><small>Waiting for them to accept · expires ' + esc(fmtDate(inv.expires_at, false)) + '</small></div><span class="pill p-warn">Waiting</span></div>' +
      (inv.link ? '<div class="copy"><code>' + esc(inv.link) + '</code><button type="button" class="btn b-blue xs" data-copy="' + esc(inv.link) + '" data-msg="Invite link copied">' + icon('copy') + 'Copy</button></div>' : '') +
      '<div class="row2b"><button type="button" class="btn b-ghost sm" id="hpCancel">Cancel invite</button><button type="button" class="btn b-blue sm" data-helper-invite>New invite</button></div>';
  } else {
    body = '<p class="muted" style="font-size:14.5px;margin:0">Let your media buyer, a freelancer or a friend set up your bots, Welcome Flows and broadcasts with <b>their own login</b>. No password sharing, and you can remove them any time.</p>' +
      helperLists(H.can, H.cannot) +
      '<button type="button" class="btn b-blue sm" data-helper-invite style="align-self:flex-start">' + icon('plus') + 'Invite a setup helper</button>';
  }
  // The video guide sits under the card for the owner and the helper (app-guides.js "setup-helper").
  const vg = (isOwner() || isHelper()) && typeof guideLink === 'function' ? '<div class="hlpg">' + guideLink('setup-helper') + '</div>' : '';
  return '<div class="box c6 hlpbox" id="stHelper"><div class="bh"><h3>' + icon('users') + 'Setup helper</h3><span class="pill p-ok">1 included, free</span></div>' + body + vg + '</div>';
}
function wireHelperBox(el, team) {
  const H = team.helper || {};
  const flip = (id, key, msgOn, msgOff) => {
    const b = $('#' + id, el); if (!b) return;
    b.onclick = async () => {
      const on = !b.classList.contains('on'); setToggle(b, on);
      try { await POST('/api/app/team/helper/settings', { [key]: on }); toast(on ? msgOn : msgOff); } catch (ex) { setToggle(b, !on); apiErr(ex); }
    };
  };
  flip('hpSend', 'send', 'Your helper can send broadcasts.', 'Your helper\'s broadcasts now wait for you.');
  flip('hpBill', 'billing', 'Your helper can manage the plan.', 'Only you can change the plan now.');
  const c = $('#hpCancel', el); if (c) c.onclick = async () => { try { await POST('/api/app/team/helper/cancel-invite'); toast('Invite cancelled. The link no longer works.'); await refreshState(); renderPage('settings', { tab: 'helper' }); } catch (ex) { apiErr(ex); } };
  const rm = $('#hpRm', el); if (rm) rm.onclick = () => removeHelper(+rm.dataset.id, rm.dataset.name);
  void H;
}
function removeHelper(id, name) {
  const h = sheet('Remove ' + esc(name) + '?', '<span class="spk" style="background:var(--bad)">' + icon('trash') + '</span>',
    '<p class="muted" style="font-size:15px">They lose access to this workspace <b>straight away</b>, on every device. Things they scheduled keep running unless you cancel them in Send a message and Welcome Flows.</p>' +
    '<p class="muted" style="font-size:14px">We\'ll email them that their access ended. You can invite a new helper any time.</p>' +
    '<div class="row2b"><button type="button" class="btn b-ghost" data-shx>Keep helper</button><button type="button" class="btn b-bad" id="hpRmGo">Remove helper</button></div>');
  $('#hpRmGo', h).onclick = async (e) => {
    await busy(e.currentTarget, 'Removing…', async () => {
      try { await POST('/api/app/team/remove', { user_id: id }); closeModal(); toast('Removed. They no longer have access.'); await refreshState(); renderPage('settings', { tab: 'helper' }); } catch (ex) { apiErr(ex); }
    });
  };
}
/* Invite a setup helper: by email (only that email can accept) or a one-time link to share on Telegram or WhatsApp. */
function openHelperInvite() {
  if (!isOwner()) { toast(OWNER_ONLY); return; }
  const h = sheet('Invite a setup helper', '<span class="spk">' + icon('users') + '</span>',
    '<p class="muted" style="font-size:14.5px;margin-top:0">They set things up with their own login. No password sharing. Free on every plan, and you can remove them any time.</p>' +
    '<div class="seg2" role="tablist"><button type="button" class="on" data-hm="email" role="tab" aria-selected="true">' + icon('mail') + 'By email</button><button type="button" data-hm="link" role="tab" aria-selected="false">' + icon('link') + 'Invite link</button></div>' +
    '<div data-hp="email"><div class="field"><label for="hpE">Their email</label><input class="inp" id="hpE" type="email" inputmode="email" autocomplete="off" placeholder="mediabuyer@gmail.com"></div><p class="hint">Only this email can accept. The invite works for 7 days.</p><p class="ferr" id="hpErr" hidden></p><button type="button" class="btn b-blue full" id="hpGo">' + icon('send') + 'Send invite</button></div>' +
    '<div data-hp="link" hidden><p class="muted" style="font-size:14px">A one-time link you send on Telegram or WhatsApp. The first person who opens it, logs in and accepts becomes your helper, then the link stops working. It expires in 7 days.</p><div id="hpL"><button type="button" class="btn b-blue full" id="hpMk">' + icon('link') + 'Create invite link</button></div></div>' +
    '<details class="hlpx"><summary>What can a setup helper do?</summary>' + helperLists(HELPER_CAN, HELPER_CANNOT) + '</details>');
  $('.seg2', h).onclick = (e) => {
    const b = e.target.closest('[data-hm]'); if (!b) return;
    $$('.seg2 button', h).forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); });
    $$('[data-hp]', h).forEach((x) => { x.hidden = x.dataset.hp !== b.dataset.hm; });
  };
  $('#hpGo', h).onclick = async (e) => {
    const email = $('#hpE', h).value.trim(), err = $('#hpErr', h);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { err.textContent = 'Enter your helper\'s email.'; err.hidden = false; return; }
    err.hidden = true;
    await busy(e.currentTarget, 'Sending…', async () => {
      try { await POST('/api/app/team/invite', { email, role: 'helper' }); closeModal(); toast('Invite sent to ' + email + '.'); await refreshState(); if (APP.page === 'settings') renderPage('settings', { tab: 'helper' }); else renderPage(APP.page, APP.q); }
      catch (ex) { err.textContent = ex.message; err.hidden = false; apiErr(ex, { silent: true }); }
    });
  };
  $('#hpMk', h).onclick = async (e) => {
    await busy(e.currentTarget, 'Creating…', async () => {
      try {
        const r = await POST('/api/app/team/helper-link');
        const msg = 'Hi! I\'d like your help setting up my Castvoo account. Open this link to accept (you\'ll use your own login): ' + r.link;
        $('#hpL', h).innerHTML = '<div class="copy"><code>' + esc(r.link) + '</code><button type="button" class="btn b-blue xs" data-copy="' + esc(r.link) + '" data-msg="Invite link copied">' + icon('copy') + 'Copy</button></div>' +
          '<div class="row2b"><a class="btn b-ghost sm" target="_blank" rel="noopener" href="https://t.me/share/url?url=' + encodeURIComponent(r.link) + '&text=' + encodeURIComponent('Help me set up my Castvoo account (you\'ll use your own login).') + '">' + icon('tg') + 'Telegram</a><a class="btn b-ghost sm" target="_blank" rel="noopener" href="https://wa.me/?text=' + encodeURIComponent(msg) + '">' + icon('chat') + 'WhatsApp</a></div>' +
          '<p class="hint">Works once, until ' + esc(fmtDate(r.expires_at, false)) + '. Making a new link cancels this one.</p>';
        refreshState();
      } catch (ex) { apiErr(ex); }
    });
  };
}
/* Shown on the invite sheet before the server's list arrives (the server's GET /api/app/team has the same words). */
const HELPER_CAN = ['Connect bots, channels and groups', 'Build Welcome Flows, follow-ups, audiences and start links', 'Write, schedule and send broadcasts', 'See subscribers and add tags', 'Train Cas and use the AI writing tools', 'Change workspace settings', 'Top up the wallet with your own payment method, if you want to', 'Chat with Castvoo support about this workspace'];
const HELPER_CANNOT = ['See or change the owner\'s login, email or Telegram link', 'Delete the workspace or the account, or export all data', 'Invite, remove or change teammates', 'Change or cancel the plan (unless the owner allows billing)', 'See, move or withdraw referral earnings or payout details', 'Ask for refunds'];
async function leaveAsHelper() {
  const name = APP.state ? APP.state.workspace.name : 'this workspace';
  if (!(await confirmBox('Leave ' + name + '?', 'You will no longer be able to open this workspace. The owner can invite you again.', 'Leave', true))) return;
  try { await POST('/api/app/team/leave'); WS.set(null); await loadMe(); APP.booted = false; toast('You left ' + name + '.'); appGo('overview'); } catch (ex) { apiErr(ex); }
}

function deleteAccount() {
  const h = sheet('Delete your account', '<span class="spk" style="background:var(--bad)">' + icon('trash') + '</span>',
    '<p class="muted" style="font-size:14.5px">This deletes your account and the workspaces you own: bots, subscribers, messages and follow-ups. Payment records are kept because the law requires it, but they are no longer linked to you. <b>This can\'t be undone.</b></p>' +
    '<p class="muted" style="font-size:14px">Unused wallet money? Ask for a refund first from the Help page.</p>' +
    '<div class="field"><label for="delI">Type DELETE to confirm</label><input class="inp" id="delI" autocomplete="off" placeholder="DELETE"></div><p class="ferr" id="delE" hidden></p>' +
    '<div class="row2b"><button type="button" class="btn b-ghost" data-shx>Keep my account</button><button type="button" class="btn b-bad" id="delGo" disabled>Delete forever</button></div>');
  $('#delI', h).oninput = (e) => { $('#delGo', h).disabled = e.target.value.trim().toUpperCase() !== 'DELETE'; };
  $('#delGo', h).onclick = async (e) => {
    await busy(e.currentTarget, 'Deleting…', async () => {
      try { await POST('/api/me/delete', { confirm: 'DELETE' }); closeModal(); ME = { user: null, workspaces: [] }; APP.booted = false; APP.state = null; WS.set(null); siteAuthUI(); location.hash = '#top'; toast('Your account was deleted. Thank you for trying Castvoo.'); }
      catch (ex) { $('#delE', h).textContent = ex.message; $('#delE', h).hidden = false; }
    });
  };
}

/* ---------- Help ---------- */
/*
 * Support chat. When the AI support team is on, named agents answer 24/7: the server sends `typing` while an agent
 * "types", and bubbles appear one by one (their visible_at). We poll every 1.5 s while someone is typing or just
 * after you sent a message, and every 10 s otherwise. A human teammate can take over the same chat at any time.
 * Images: up to 3 screenshots per message (button, paste or drag and drop). Each is uploaded first
 * (POST /api/support/attachments) and its id sent with the message. Only you and the support team can open them.
 */
const supAva = (m) => (m.avatar ? '<img class="sav" src="' + esc(m.avatar) + '" alt="" width="34" height="34" loading="lazy">' : '<span class="sav team">' + esc((m.author_name || 'C')[0]) + '</span>');
function supTeam(team, n) {
  return '<span class="steam">' + (team || []).slice(0, n || 3).map((p) => '<img src="' + esc(p.avatar) + '" alt="' + esc(p.name) + '" width="30" height="30">').join('') + '</span>';
}
const supPics = (list) => (list && list.length ? '<span class="cpics n' + Math.min(list.length, 3) + '">' + list.map((a) => '<button type="button" class="cpic" data-lb="' + esc(a.url) + '" aria-label="Open image"><img src="' + esc(a.url) + '" alt="Image"' + (a.width && a.height ? ' width="' + Number(a.width) + '" height="' + Number(a.height) + '"' : '') + '></button>').join('') + '</span>' : '');
PAGES.help = {
  title: 'Help', sub: '24/7 customer support',
  async render(el, q, alive) {
    el.innerHTML = skel(1, 140) + skel(1, 360);
    const s = CFG.support || {};
    const chatOn = CFG.features.support_chat !== false;
    let d = chatOn ? await GET('/api/support') : { messages: [], reply_time: s.reply_time };
    if (!alive()) return;
    if (APP.state.support_unread) { APP.state.support_unread = 0; shellUI(); }
    const ai = d.ai || { on: false, team: [] };
    const team = ai.team || [];
    const opt = d.chat || { images: false, max_images: 3, max_mb: 10, powered_by: null };
    const names = team.slice(0, 2).map((p) => p.name).join(' and ');
    const lead = ai.on && team.length ? 'Ask anything, any time. ' + esc(names) + ' answer in seconds, day and night, and a person from our team can step in whenever you need one.' : esc(d.reply_time || s.reply_time || '');
    el.innerHTML = '<div class="box hello helpb"><div style="display:flex;flex-direction:column;gap:10px;min-width:0;padding-bottom:16px">' + (ai.on ? '<span class="h247"><span class="sdot"></span>24/7 customer support · replies in seconds</span>' : '') + '<h2>How can we help?</h2><p>' + lead + '</p><div class="acts"><a class="btn b-w" href="mailto:' + esc(s.email) + '">' + icon('mail') + esc(s.email) + '</a>' + (s.telegram ? '<a class="btn b-g" href="https://t.me/' + esc(String(s.telegram).replace(/^@/, '')) + '" target="_blank" rel="noopener">' + icon('tg') + '@' + esc(String(s.telegram).replace(/^@/, '')) + '</a>' : '') + '</div></div>' + (team.length && ai.on ? '<div class="hface">' + supTeam(team, 4) + '<small>Your support team</small></div>' : '<div class="hart" data-cas="happy"></div>') + '</div>' +
      '<div class="dg"><div class="box c8 chatb" id="hpBox">' +
      (chatOn ? '<div class="shead">' + (team.length ? supTeam(team, 3) : '<span class="sav team">C</span>') + '<div class="sh-t"><b>Castvoo support</b><small id="hpSt"></small></div></div>' : '<div class="bh"><h3>' + icon('chat') + 'Chat with the team</h3></div>') +
      (chatOn ? '<div class="chatl tall" id="hpL" aria-live="polite"></div>' +
        '<form class="chatf hpf" id="hpF"><div class="cmp-pics" id="hpP" hidden></div>' +
        (opt.images ? '<label class="ib cmp-att" title="Attach a screenshot (or paste one)"><input type="file" id="hpFile" accept="image/jpeg,image/png,image/webp" multiple hidden>' + icon('image') + '<span class="sr">Attach a screenshot</span></label>' : '') +
        '<textarea class="inp" id="hpQ" rows="2" maxlength="4000" placeholder="' + (opt.images ? 'Write your message, or paste a screenshot…' : 'Write your message. Tell us what you were trying to do.') + '" aria-label="Your message"></textarea><button type="submit" class="btn b-blue" aria-label="Send">' + icon('send') + '<span class="hide-sm">Send</span></button></form>' +
        '<div class="chat-foot"><span>' + (ai.on ? icon('clock') + '24/7 · AI agents with our human team on call' : icon('mail') + 'We reply here and by email') + '</span>' + poweredBy(opt.powered_by) + '</div>' +
        (opt.images ? '<div class="dropz" id="hpDrop" hidden><span>' + icon('image') + 'Drop your screenshot to attach it</span></div>' : '')
        : emptyBox({ plain: 1, emoji: '✉️', title: 'Chat is offline right now', text: 'Email us at <a href="mailto:' + esc(s.email) + '">' + esc(s.email) + '</a> and we\'ll get back to you.' })) + '</div>' +
      '<div class="box c4"><div class="bh"><h3>Quick help</h3></div><div class="qhelp">' + (isOwner() && APP.state.helper && !APP.state.helper.active ? '<button type="button" data-helper-invite>' + icon('users') + '<span><b>Invite a setup helper</b><small>Your media buyer sets it up, no password sharing</small></span></button>' : '') + '<button type="button" class="vgq" data-go="guides">' + icon('play') + '<span><b>Watch the video guides</b><small>' + (typeof VGUIDES !== 'undefined' ? VGUIDES.length + ' ' : '') + 'short tutorials with voice and captions</small></span></button>' + (aiOn() ? '<button type="button" data-go="ai">' + icon('spark') + '<span><b>Ask Cas</b><small>Help writing messages</small></span></button>' : '') + '<a href="/#faq" target="_blank" rel="noopener">' + icon('help') + '<span><b>Read the FAQ</b><small>Common questions</small></span></a>' + (CFG.features.blog !== false ? '<a href="/blog" target="_blank" rel="noopener">' + icon('pencil') + '<span><b>Read the blog</b><small>Guides to grow on Telegram</small></span></a>' : '') + '<a href="/legal/refunds" target="_blank" rel="noopener">' + icon('wallet') + '<span><b>Refunds</b><small>How refunds work</small></span></a></div></div></div>';
    paintCas(el);
    if (!chatOn) return;
    const status = () => {
      const st = $('#hpSt'); if (!st) return;
      const human = d.thread && d.thread.with_human;
      st.innerHTML = '<span class="sdot' + (human ? ' h' : '') + '"></span><span>' + (human ? 'A teammate is on this chat · 24/7 support' : ai.on ? '24/7 customer support · replies in seconds' : esc(d.reply_time || 'We reply here and by email')) + '</span>';
    };
    let lastKey = '';
    const draw = (force) => {
      const L = $('#hpL'); if (!L) return;
      const key = d.messages.map((m) => m.id + ':' + (m.attachments || []).length).join(',') + '|' + (d.typing ? d.typing.name : '');
      if (!force && key === lastKey) return;
      lastKey = key;
      const atBottom = L.scrollHeight - L.scrollTop - L.clientHeight < 80;
      const ms = d.messages;
      let h = '';
      if (!ms.length) {
        h = team.length && ai.on
          ? '<div class="cmsg a first last">' + supAva(team[0]) + '<div class="cb"><small class="cn">' + esc(team[0].name) + '</small>Hi! I\'m ' + esc(team[0].name) + ' from Castvoo. Ask me anything: setup, sending, payments or your bot. I can check your account for you' + (opt.images ? ', and you can send me a screenshot' : '') + '.</div></div>'
          : '<div class="cmsg a first last"><span class="cav" data-cas="mini"></span><div class="cb">Hi! Send us a message about anything: setup, payments, or a question about your bot. A real person from the Castvoo team will answer.</div></div>';
      }
      ms.forEach((m, i) => {
        const mine = m.author_type === 'user';
        const prev = ms[i - 1], next = ms[i + 1];
        const same = (x) => x && (x.author_type === 'user') === mine && (mine || x.author_name === m.author_name);
        const first = !same(prev), last = !same(next) && !(d.typing && !mine && i === ms.length - 1 && d.typing.name === m.author_name);
        const ava = mine ? '' : last ? supAva(m) : '<span class="sav sp"></span>';
        const nm = !mine && first ? '<small class="cn">' + esc(m.author_name || 'Castvoo team') + (m.author_type === 'staff' ? ' <span class="steam-tag">Team</span>' : '') + '</small>' : '';
        const pics = supPics(m.attachments);
        const text = m.body ? esc(m.body).replace(/\n/g, '<br>') : '';
        h += '<div class="cmsg ' + (mine ? 'u' : 'a') + (first ? ' first' : '') + (last ? ' last' : '') + '">' + ava + '<div class="cb' + (pics && !text ? ' po' : '') + '">' + nm + pics + text + (last ? '<small class="ct">' + (m.sending ? 'Sending…' : fmtDate(m.created_at)) + '</small>' : '') + '</div></div>';
      });
      if (d.typing) h += '<div class="cmsg a typing last">' + supAva({ avatar: d.typing.avatar, author_name: d.typing.name }) + '<div class="cb"><span class="tg-typing in"><i></i><i></i><i></i></span></div><span class="tlabel">' + esc(d.typing.name) + ' is typing…</span></div>';
      L.innerHTML = h;
      paintCas(L);
      const stick = atBottom || !draw.done;
      if (stick) {
        L.scrollTop = L.scrollHeight;
        // Images finish loading after this: keep the newest message in view.
        $$('img', L).forEach((im) => { if (!im.complete) im.addEventListener('load', () => { L.scrollTop = L.scrollHeight; }, { once: true }); });
      }
      draw.done = true;
    };
    status(); draw(true);
    $('#hpL').onclick = (e) => { const b = e.target.closest('[data-lb]'); if (b) openLightbox(b.dataset.lb); };
    let fastUntil = d.typing ? Date.now() + 60000 : 0;
    let busy = false;
    const refresh = async () => {
      if (busy) return; busy = true;
      try { const n = await GET('/api/support'); if (!alive()) return; d = n; status(); draw(); if (d.typing) fastUntil = Math.max(fastUntil, Date.now() + 15000); } catch (_) { /* try again later */ }
      busy = false;
    };

    /* images waiting to be sent: { k, file, url, att, st: 'up' | 'ok' | 'err' } */
    let pend = [];
    const P = $('#hpP');
    const drawPend = () => {
      P.hidden = !pend.length;
      P.innerHTML = pend.map((x) => '<span class="cmp-pic ' + x.st + '"><img src="' + esc(x.url) + '" alt="">' + (x.st === 'up' ? '<i class="spin"></i>' : x.st === 'err' ? '<b title="' + esc(x.err || '') + '">!</b>' : '') + '<button type="button" class="cmp-x" data-rmp="' + x.k + '" aria-label="Remove image">' + icon('x') + '</button></span>').join('') +
        (pend.some((x) => x.att && !x.att.ai_readable) ? '<small class="cmp-note">This image is big. The team can see it, but for an instant answer send a smaller screenshot.</small>' : '');
    };
    const TYPES = ['image/jpeg', 'image/png', 'image/webp'];
    const addFiles = (files) => {
      for (const f of [...(files || [])]) {
        if (!TYPES.includes(f.type)) { toast('Send a JPG, PNG or WEBP image.', { kind: 'err' }); continue; }
        if (f.size > (opt.max_mb || 10) * 1048576) { toast('Images can be up to ' + (opt.max_mb || 10) + ' MB. Send a smaller screenshot.', { kind: 'err' }); continue; }
        if (pend.length >= (opt.max_images || 3)) { toast('Send up to ' + (opt.max_images || 3) + ' images in one message.', { kind: 'err' }); break; }
        const x = { k: Math.random().toString(36).slice(2), file: f, url: URL.createObjectURL(f), st: 'up' };
        pend.push(x);
        uploadTo('/api/support/attachments', 'attachment', f).then((att) => { x.att = att; x.st = 'ok'; drawPend(); }).catch((ex) => { x.st = 'err'; x.err = ex.message; drawPend(); apiErr(ex); });
      }
      drawPend();
    };
    if (opt.images) {
      $('#hpFile').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
      $('#hpQ').addEventListener('paste', (e) => { const fs = [...((e.clipboardData && e.clipboardData.files) || [])].filter((f) => f.type.startsWith('image/')); if (fs.length) { e.preventDefault(); addFiles(fs); } });
      const box = $('#hpBox'), dz = $('#hpDrop');
      let depth = 0;
      box.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer.types || [])].includes('Files')) { depth++; dz.hidden = false; e.preventDefault(); } });
      box.addEventListener('dragover', (e) => { if ([...(e.dataTransfer.types || [])].includes('Files')) e.preventDefault(); });
      box.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) dz.hidden = true; });
      box.addEventListener('drop', (e) => { e.preventDefault(); depth = 0; dz.hidden = true; addFiles(e.dataTransfer.files); });
      P.onclick = (e) => { const b = e.target.closest('[data-rmp]'); if (!b) return; const x = pend.find((y) => y.k === b.dataset.rmp); if (x) URL.revokeObjectURL(x.url); pend = pend.filter((y) => y.k !== b.dataset.rmp); drawPend(); };
    }
    $('#hpF').onsubmit = async (e) => {
      e.preventDefault();
      const t = $('#hpQ').value.trim();
      if (pend.some((x) => x.st === 'up')) { toast('Wait a second, your image is still uploading.'); return; }
      const ready = pend.filter((x) => x.st === 'ok');
      if (!t && !ready.length) return;
      const b = $('button[type=submit]', e.currentTarget); btnBusy(b, true, '');
      try {
        await POST('/api/support', { body: t, attachments: ready.map((x) => x.att.id) });
        $('#hpQ').value = '';
        d.messages = d.messages.concat([{ id: 'tmp' + Date.now(), author_type: 'user', body: t, created_at: new Date().toISOString(), attachments: ready.map((x) => ({ id: x.att.id, url: x.att.url })) }]);
        pend = []; drawPend();
        draw(true);
        fastUntil = Date.now() + 90000;
        if (!ai.on) toast('Sent. We\'ll reply here and by email.');
        later(600, refresh);
      } catch (ex) { apiErr(ex); }
      btnBusy(b, false);
    };
    $('#hpQ').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(pointer:fine)').matches) { e.preventDefault(); $('#hpF').requestSubmit(); } };
    let tick = 0;
    every(1500, () => { tick++; if (Date.now() < fastUntil || tick % 7 === 0) refresh(); });
  },
};

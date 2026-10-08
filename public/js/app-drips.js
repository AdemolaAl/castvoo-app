'use strict';
/*
 * app-drips.js: "Auto follow-ups" (sequences of messages a bot sends by itself).
 * API: GET/POST /api/drips, PUT/DELETE /api/drips/:id, POST /api/drips/:id/toggle, POST /api/ai/sequence
 */

const TRIG = {
  start: 'Someone starts your bot',
  start_tag: 'Someone opens one of your start links',
  join_request: 'Someone asks to join your channel or group',
  tag: 'A tag is added to someone',
};
const UNIT_MIN = { min: 1, hour: 60, day: 1440 };
function splitDelay(m) { m = Number(m) || 0; if (m && m % 1440 === 0) return [m / 1440, 'day']; if (m && m % 60 === 0) return [m / 60, 'hour']; return [m, 'min']; }
function delayText(v, u) { v = Number(v) || 0; if (!v) return 'Instantly'; const n = { min: ['minute', 'minutes'], hour: ['hour', 'hours'], day: ['day', 'days'] }[u]; return 'Wait ' + v + ' ' + (v === 1 ? n[0] : n[1]); }
function blankStep(first) { return { delay_value: first ? 0 : 1, delay_unit: first ? 'min' : 'day', body: '', media: null, buttons: [], sent: 0, clicks: 0 }; }

let DRIP = { list: [], sel: null, E: null, dirty: false };

function dripFromApi(q) {
  return {
    id: q.id, name: q.name, connection_id: q.connection_id, trigger_type: q.trigger_type, trigger_value: q.trigger_value || '',
    join_connection_id: q.join_chat ? q.join_chat.id : '', approve_join: q.approve_join !== false, active: !!q.active, people: q.people, in_progress: q.in_progress,
    steps: q.steps.map((s) => { const [v, u] = splitDelay(s.delay_minutes); return { delay_value: v, delay_unit: u, body: s.body, media: s.media_id ? { id: s.media_id } : null, buttons: (s.buttons || []).map((b) => ({ label: b.label, url: b.url })), sent: s.sent, clicks: s.clicks }; }),
  };
}

PAGES.drips = {
  title: 'Auto follow-ups', sub: 'Messages that send themselves',
  async render(el, q, alive) {
    el.innerHTML = '<div class="drips"><div>' + skel(3, 70) + '</div><div>' + skel(1, 380) + '</div></div>';
    const bots = APP.state.connections.filter((c) => c.kind === 'bot' && c.status !== 'removed');
    if (CFG.features.drips === false) { el.innerHTML = emptyBox({ cas: 'think', title: 'Auto follow-ups are switched off for a moment', text: 'The Castvoo team has paused them. Please check back soon.' }); return; }
    const r = await GET('/api/drips');
    if (!alive()) return;
    // Join-request follow-ups live in Welcome Flows now.
    DRIP.list = (r.sequences || []).filter((x) => x.trigger_type !== 'join_request');
    $('#navDrips').textContent = DRIP.list.filter((x) => x.active).length || '';
    $('#navDrips').hidden = !DRIP.list.some((x) => x.active);
    const pf = (APP.state.plan.features || []);
    if (!pf.includes('drips')) {
      el.innerHTML = emptyBox({ cas: 'wave', title: 'Auto follow-ups are on Starter and up', text: 'Your plan welcomes people who ask to join. Upgrade to send follow-ups to everyone who starts your bot.', action: '<div class="row2b" style="max-width:420px"><button type="button" class="btn b-blue" data-upgrade-drips>' + icon('up') + 'See plans</button><button type="button" class="btn b-ghost" data-go="flows">Welcome Flows</button></div>' });
      $('[data-upgrade-drips]', el).onclick = () => openUpgrade({ title: 'Send auto follow-ups', text: 'Auto follow-ups are on Starter and up.', feature: 'drips' });
      return;
    }
    if (!bots.length) {
      el.innerHTML = emptyBox({ cas: 'wave', title: 'Follow-ups are sent by a bot', text: 'Connect a Telegram bot first. Then Castvoo can welcome every new subscriber and follow up on day 1, 3 and 7 for you.', action: '<div class="row2b" style="max-width:420px"><button type="button" class="btn b-blue" data-connect="bot">' + icon('plus') + 'Connect a bot</button><button type="button" class="btn b-ghost" data-vguide="connect-bot">' + icon('play') + 'Watch how</button></div>' });
      return;
    }
    if (q.new === '1') { DRIP.sel = 'new'; DRIP.E = newDrip(bots); DRIP.dirty = false; }
    else if (DRIP.sel === 'new' && DRIP.E) { /* keep the unsaved one */ }
    else if (!DRIP.list.some((x) => x.id === DRIP.sel)) { DRIP.sel = DRIP.list[0] ? DRIP.list[0].id : 'new'; DRIP.E = DRIP.list[0] ? dripFromApi(DRIP.list[0]) : newDrip(bots); }
    else DRIP.E = dripFromApi(DRIP.list.find((x) => x.id === DRIP.sel));
    drawDrips(el, bots, alive);
  },
};
function newDrip(bots) { return { id: null, name: 'Welcome follow-up', connection_id: bots[0].id, trigger_type: 'start', trigger_value: '', join_connection_id: '', approve_join: true, active: true, people: 0, steps: [blankStep(true)] }; }

function drawDrips(el, bots, alive) {
  const E = DRIP.E;
  const chats = APP.state.connections.filter((c) => c.kind !== 'bot');
  const editable = APP.state.workspace.role !== 'drafter';
  el.innerHTML = '<div class="drips"><div class="dlst">' +
    DRIP.list.map((x) => '<button type="button" class="dli ' + (x.id === DRIP.sel ? 'on' : '') + '" data-d="' + x.id + '"><span class="dlih"><b class="ell">' + esc(x.name) + '</b><span class="pill ' + (x.active ? 'p-ok' : 'p-grey') + '">' + (x.active ? '<span class="dl"></span>On' : 'Off') + '</span></span><small>' + plural(x.steps.length, 'message') + ' · ' + plural(x.people, 'person', 'people') + ' so far · @' + esc(x.bot) + '</small></button>').join('') +
    (DRIP.sel === 'new' ? '<button type="button" class="dli on"><span class="dlih"><b>' + esc(E.name || 'New follow-up') + '</b><span class="pill p-warn">Not saved</span></span><small>' + plural(E.steps.length, 'message') + '</small></button>' : '') +
    (editable ? '<button type="button" class="btn b-ghost sm" id="dNew">' + icon('plus') + 'New follow-up</button>' + (aiOn() ? '<button type="button" class="btn b-ink sm" id="dAI">' + icon('spark') + 'Write one with Cas</button>' : '') : '') +
    '<div class="note2"><span>💡</span><span>Start with a welcome: message 1 instantly, then a tip on day 1 and your offer on day 3.</span></div>' +
    '<div class="note2"><span>👋</span><span>Welcoming people who ask to join a channel or group? Use <button type="button" class="lnk" data-go="flows">Welcome Flows</button>.</span></div></div>' +
    '<div class="box"><div class="bh"><div style="min-width:0;flex:1"><input class="inp ttlin" id="dName" value="' + esc(E.name) + '" maxlength="60" aria-label="Follow-up name"' + (editable ? '' : ' disabled') + '><small class="muted">' + (E.id ? plural(E.people || 0, 'person has', 'people have') + ' started it · ' + fmt(E.in_progress || 0) + ' in it now' : 'New follow-up, not saved yet') + '</small></div>' +
    '<div class="dtgl"><span class="muted" id="dTgL">' + (E.active ? 'On' : 'Off') + '</span>' + toggleBtn('dTg', E.active, 'Turn this follow-up on or off') + '</div></div>' +
    '<div class="canvas" id="dCv"></div>' +
    '<p class="ferr" id="dErr" hidden></p>' +
    (editable ? '<div class="dact"><button type="button" class="btn b-blue" id="dSave">' + icon('check') + (E.id ? 'Save changes' : 'Save follow-up') + '</button>' + (E.id ? '<button type="button" class="btn b-ghost" id="dDel">' + icon('trash') + 'Delete</button>' : '') + '</div>' : '<p class="hint">Your role can\'t change follow-ups. Ask the workspace owner.</p>') + '</div></div>';
  drawCanvas(bots, chats, editable);

  const mark = () => { DRIP.dirty = true; };
  $('#dName').oninput = (e) => { E.name = e.target.value; mark(); };
  $('.dlst', el).onclick = async (e) => {
    const b = e.target.closest('[data-d]'); if (!b) return;
    if (DRIP.dirty && !(await confirmBox('Leave without saving?', 'Your changes to this follow-up will be lost.', 'Leave'))) return;
    DRIP.sel = +b.dataset.d; DRIP.E = dripFromApi(DRIP.list.find((x) => x.id === DRIP.sel)); DRIP.dirty = false; drawDrips(el, bots, alive);
  };
  const nb = $('#dNew'); if (nb) nb.onclick = async () => { if (DRIP.dirty && !(await confirmBox('Leave without saving?', 'Your changes will be lost.', 'Leave'))) return; DRIP.sel = 'new'; DRIP.E = newDrip(bots); DRIP.dirty = false; drawDrips(el, bots, alive); };
  const ab = $('#dAI'); if (ab) ab.onclick = () => aiSequence((steps, name) => { if (DRIP.sel !== 'new' && DRIP.E.id) { DRIP.sel = 'new'; DRIP.E = newDrip(bots); } DRIP.E.steps = steps; if (name) DRIP.E.name = name; DRIP.E.active = false; DRIP.dirty = true; drawDrips(el, bots, alive); toast('Cas wrote ' + plural(steps.length, 'message') + '. Check them, then save and switch on.'); });
  $('#dTg').onclick = async (e) => {
    const b = e.currentTarget;
    if (!editable) return;
    E.active = !E.active; setToggle(b, E.active); $('#dTgL').textContent = E.active ? 'On' : 'Off';
    if (!E.id) { mark(); return; }
    try { await POST('/api/drips/' + E.id + '/toggle', { active: E.active }); const x = DRIP.list.find((d) => d.id === E.id); if (x) x.active = E.active; toast(E.active ? 'Follow-up is on.' : 'Follow-up is off. Nobody new will start it.'); refreshState(); drawDrips(el, bots, alive); }
    catch (ex) { E.active = !E.active; setToggle(b, E.active); apiErr(ex); }
  };
  const sv = $('#dSave'); if (sv) sv.onclick = async (e) => {
    const err = $('#dErr'); err.hidden = true;
    const problem = checkDrip(E);
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    const body = {
      name: E.name.trim(), connection_id: E.connection_id, trigger_type: E.trigger_type, trigger_value: E.trigger_value || undefined,
      join_connection_id: E.trigger_type === 'join_request' ? +E.join_connection_id : undefined, approve_join: E.approve_join, active: E.active,
      steps: E.steps.map((s) => ({ delay_value: Number(s.delay_value) || 0, delay_unit: s.delay_unit, body: s.body, media_id: s.media ? s.media.id : null, buttons: cleanButtons(s.buttons) })),
    };
    await busy(e.currentTarget, 'Saving…', async () => { try {
      if (E.id) await api('PUT', '/api/drips/' + E.id, body);
      else { const r = await POST('/api/drips', body); DRIP.sel = r.id; }
      DRIP.dirty = false;
      toast(E.id ? 'Saved.' : (E.active ? 'Saved and switched on. Castvoo takes it from here.' : 'Saved. Switch it on when you\'re ready.'));
      if (!E.id) confetti();
      refreshState();
      renderPage('drips', {});
    } catch (ex) { err.textContent = ex.message; err.hidden = false; apiErr(ex, { silent: true }); } });
  };
  const dl = $('#dDel'); if (dl) dl.onclick = async () => {
    if (!(await confirmBox('Delete "' + E.name + '"?', 'It stops for everyone in it, and its numbers are removed. This can\'t be undone.', 'Delete', true))) return;
    try { await api('DELETE', '/api/drips/' + E.id); DRIP.sel = null; DRIP.dirty = false; toast('Deleted.'); refreshState(); renderPage('drips', {}); } catch (ex) { apiErr(ex); }
  };
}

function checkDrip(E) {
  if (!E.name.trim()) return 'Give this follow-up a name.';
  if ((E.trigger_type === 'start_tag' || E.trigger_type === 'tag') && !/^[A-Za-z0-9_-]{1,64}$/.test(E.trigger_value || '')) return E.trigger_type === 'tag' ? 'Type the tag, using only letters, numbers, _ and -.' : 'Type the start link name, using only letters, numbers, _ and -.';
  if (E.trigger_type === 'join_request' && !E.join_connection_id) return 'Pick the channel or group that uses join requests.';
  if (!E.steps.length) return 'Add at least one message.';
  for (const [i, s] of E.steps.entries()) {
    if (!s.body.trim()) return 'Message ' + (i + 1) + ' is empty.';
    const lim = s.media ? 1024 : 4096;
    if (visibleLength(s.body) > lim) return 'Message ' + (i + 1) + ' is too long for Telegram (' + fmt(lim) + ' characters' + (s.media ? ' with a photo or video' : '') + ').';
    const b = checkButtons(s.buttons); if (b) return 'Message ' + (i + 1) + ': ' + b;
  }
  return '';
}

function drawCanvas(bots, chats, editable) {
  const E = DRIP.E;
  const dis = editable ? '' : ' disabled';
  const types = Object.keys(TRIG).filter((k) => k !== 'join_request' || E.trigger_type === k);
  const trig = '<div class="node trig"><div class="nh"><b style="display:flex;align-items:center;gap:8px">' + TG + 'Starts when</b><span class="pill" style="background:rgba(255,255,255,.14);color:#fff">Trigger</span></div>' +
    '<label class="tlab">Bot that sends it</label><select class="trigsel" id="dBot"' + (E.id ? ' disabled title="The bot can\'t be changed after saving. Make a new follow-up instead."' : dis) + '>' + bots.map((b) => '<option value="' + b.id + '"' + (b.id === E.connection_id ? ' selected' : '') + '>@' + esc(b.username || b.title) + '</option>').join('') + '</select>' +
    '<label class="tlab">What starts it</label><select class="trigsel" id="dTrig"' + dis + '>' + types.map((k) => '<option value="' + k + '"' + (k === E.trigger_type ? ' selected' : '') + '>' + TRIG[k] + '</option>').join('') + '</select>' +
    (E.trigger_type === 'start_tag' ? '<label class="tlab" for="dTv">Start link name</label><input class="trigsel" id="dTv" value="' + esc(E.trigger_value) + '" placeholder="for example meta_ad14" maxlength="64"' + dis + '><div class="trignote">Only people who start the bot through t.me/yourbot?start=' + esc(E.trigger_value || 'name') + ' get this follow-up. Make start links on the Channels &amp; bots page.</div>' : '') +
    (E.trigger_type === 'tag' ? '<label class="tlab" for="dTv">Tag</label><input class="trigsel" id="dTv" value="' + esc(E.trigger_value) + '" placeholder="for example buyer" maxlength="64"' + dis + '><div class="trignote">Starts when you add this tag to someone on the Subscribers page.</div>' : '') +
    (E.trigger_type === 'join_request' ? (chats.length ? '<label class="tlab">Channel or group</label><select class="trigsel" id="dJc"' + dis + '><option value="">Choose…</option>' + chats.map((c) => '<option value="' + c.id + '"' + (String(c.id) === String(E.join_connection_id) ? ' selected' : '') + '>' + esc(connName(c)) + '</option>').join('') + '</select>' +
      '<div class="tg tgd"><span><b>Let them in automatically</b><br><small>Approve each join request after the welcome.</small></span>' + toggleBtn('dAp', E.approve_join, 'Let them in automatically') + '</div>' +
      '<div class="trignote"><b>How this works:</b> Telegram lets your bot message a person for 5 minutes after they ask to join. So message 1 goes out straight away and invites them to tap Start. Only people who tap Start get the later messages. Your bot must be an admin of the channel or group with the "Add members" right.</div>'
      : '<div class="trignote">Connect the channel or group first (Channels &amp; bots page), and make your bot an admin there.</div>') : '') +
    '</div>';
  const steps = E.steps.map((s, i) => '<div class="conn"><span>' + delayText(s.delay_value, s.delay_unit) + '</span></div>' +
    '<div class="node" data-step="' + i + '"><div class="nh"><b>Message ' + (i + 1) + '</b><div class="nhr"><div class="delay"><span class="hint">' + (i === 0 ? 'Send after' : 'Wait') + '</span><input type="number" min="0" max="525600" value="' + (Number(s.delay_value) || 0) + '" data-dv="' + i + '" aria-label="Wait time"' + dis + '><select data-du="' + i + '" aria-label="Unit"' + dis + '><option value="min"' + (s.delay_unit === 'min' ? ' selected' : '') + '>min</option><option value="hour"' + (s.delay_unit === 'hour' ? ' selected' : '') + '>hours</option><option value="day"' + (s.delay_unit === 'day' ? ' selected' : '') + '>days</option></select></div>' + (editable && E.steps.length > 1 ? '<button type="button" class="x" data-del="' + i + '" aria-label="Delete message ' + (i + 1) + '"><svg width="15" height="15"><use href="#i-trash"/></svg></button>' : '') + '</div></div>' +
    (s.media ? '<div class="nmed">' + (s.media.url ? (s.media.kind === 'video' ? '<video src="' + esc(s.media.url) + '" muted playsinline></video>' : '<img src="' + esc(s.media.url) + '" alt="">') : '<img class="mimg" src="' + esc(mediaUrl(s.media.id)) + '" alt="">') + (editable ? '<button type="button" class="x" data-dmx="' + i + '" aria-label="Remove photo or video">×</button>' : '') + '</div>' : '') +
    '<textarea class="inp" rows="4" data-body="' + i + '" placeholder="Write message ' + (i + 1) + '…"' + dis + '>' + esc(s.body) + '</textarea><div class="cc" data-cc="' + i + '">' + counterHtml(s.body, !!s.media) + '</div>' +
    '<div class="btnl" data-btns="' + i + '">' + btnRows(s.buttons) + '</div>' +
    (editable ? '<div class="nacts"><button type="button" class="addm" data-dma="' + i + '"' + (CFG.features.media === false ? ' hidden' : '') + '>📎 ' + (s.media ? 'Replace' : 'Add') + ' photo or video</button>' + (s.buttons.length < 6 ? '<button type="button" class="addm" data-dba="' + i + '">🔘 Add a button</button>' : '') + '<button type="button" class="addm" data-dname="' + i + '" title="Each person sees their own first name">👤 Add their name</button></div>' : '') +
    '<div class="nup" data-upl="' + i + '"></div>' +
    (E.id ? '<div class="stats"><span>📨 ' + fmt(s.sent) + ' sent</span><span>🔘 ' + fmt(s.clicks) + ' clicks</span></div>' : '') + '</div>').join('');
  $('#dCv').innerHTML = trig + steps + (editable && E.steps.length < 20 ? '<div class="conn"><span>Then</span></div><button type="button" class="btn b-ghost sm" id="dAdd">' + icon('plus') + 'Add a message</button>' : '');
  $$('#dCv img.mimg').forEach((im) => im.addEventListener('error', () => { const v = document.createElement('video'); v.src = im.src; v.muted = true; v.playsInline = true; im.replaceWith(v); }, { once: true }));

  const cv = $('#dCv');
  const mark = () => { DRIP.dirty = true; };
  cv.onchange = (e) => {
    const t = e.target;
    if (t.id === 'dBot') { E.connection_id = +t.value; mark(); }
    if (t.id === 'dTrig') { E.trigger_type = t.value; E.trigger_value = ''; mark(); drawCanvas(bots, chats, editable); }
    if (t.id === 'dJc') { E.join_connection_id = t.value; mark(); }
    if (t.dataset.du != null) { E.steps[t.dataset.du].delay_unit = t.value; mark(); drawCanvas(bots, chats, editable); }
    if (t.dataset.dv != null) { E.steps[t.dataset.dv].delay_value = Math.max(0, parseInt(t.value, 10) || 0); mark(); drawCanvas(bots, chats, editable); }
  };
  cv.oninput = (e) => {
    const t = e.target;
    if (t.id === 'dTv') { E.trigger_value = t.value.trim(); mark(); }
    if (t.dataset.body != null) { const i = +t.dataset.body; E.steps[i].body = t.value; const c = $('[data-cc="' + i + '"]', cv); c.innerHTML = counterHtml(t.value, !!E.steps[i].media); c.classList.toggle('bad', visibleLength(t.value) > (E.steps[i].media ? 1024 : 4096)); mark(); }
    const bl = t.closest('[data-btns]');
    if (bl) { const i = +bl.dataset.btns; if (t.dataset.bl != null) E.steps[i].buttons[t.dataset.bl].label = t.value; if (t.dataset.bu != null) E.steps[i].buttons[t.dataset.bu].url = t.value; mark(); }
  };
  cv.onclick = async (e) => {
    const t = e.target;
    const ap = t.closest('#dAp'); if (ap) { E.approve_join = !E.approve_join; setToggle(ap, E.approve_join); mark(); return; }
    const nm = t.closest('[data-dname]');
    if (nm) {
      insertAtCaret($('[data-body="' + nm.dataset.dname + '"]', cv), '{name}'); return;
    }
    const d = t.closest('[data-del]'); if (d) { E.steps.splice(+d.dataset.del, 1); mark(); drawCanvas(bots, chats, editable); return; }
    const bx = t.closest('[data-bx]'); if (bx) { const i = +bx.closest('[data-btns]').dataset.btns; E.steps[i].buttons.splice(+bx.dataset.bx, 1); mark(); drawCanvas(bots, chats, editable); return; }
    const ba = t.closest('[data-dba]'); if (ba) { E.steps[+ba.dataset.dba].buttons.push({ label: '', url: '' }); mark(); drawCanvas(bots, chats, editable); return; }
    const mx = t.closest('[data-dmx]'); if (mx) { E.steps[+mx.dataset.dmx].media = null; mark(); drawCanvas(bots, chats, editable); return; }
    const ma = t.closest('[data-dma]'); if (ma) {
      const i = +ma.dataset.dma;
      const fin = document.createElement('input'); fin.type = 'file'; fin.accept = 'image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime';
      fin.onchange = async () => { const f = fin.files[0]; if (!f) return; const m = await pickAndUpload(f, $('[data-upl="' + i + '"]', cv)); if (m) { E.steps[i].media = m; mark(); } drawCanvas(bots, chats, editable); };
      fin.click();
      return;
    }
    if (t.closest('#dAdd')) { E.steps.push(blankStep(false)); mark(); drawCanvas(bots, chats, editable); const ta = $$('#dCv [data-body]').pop(); if (ta) ta.focus(); }
  };
}

/* Cas writes a whole follow-up. done(steps, name) */
function aiSequence(done) {
  const h = sheet('Write a follow-up with Cas', '<span class="spk">' + icon('spark') + '</span>',
    '<div class="mh"><div class="ca" data-cas="think"></div><div class="mt"><small class="muted">Uses 1 AI write per message · <span data-aileft>' + fmt(aiLeft()) + ' AI writes left</span></small></div></div>' +
    '<div class="field"><label for="asP">What is this follow-up for?</label><textarea class="inp" id="asP" rows="3" maxlength="1000" placeholder="For example: Welcome new members of my cooking class and get them to buy the full course."></textarea></div>' +
    '<div class="row2b"><div class="field"><label for="asN">How many messages?</label><select class="inp" id="asN">' + [2, 3, 4, 5, 6, 7].map((n) => '<option' + (n === 4 ? ' selected' : '') + '>' + n + '</option>').join('') + '</select></div><div class="field"><label for="asL">Language</label><input class="inp" id="asL" maxlength="40" placeholder="English"></div></div>' +
    '<div id="asOut" hidden></div><p class="ferr" id="asErr" hidden></p>' +
    '<div class="row2b"><button type="button" class="btn b-ghost" id="asX">Cancel</button><button type="button" class="btn b-blue" id="asGo">' + icon('spark') + 'Write it</button></div>');
  let steps = null;
  $('#asX', h).onclick = closeModal;
  $('#asGo', h).onclick = async (e) => {
    if (steps) { closeModal(); done(steps, ($('#asP').value.trim().split(/[.!?\n]/)[0] || '').slice(0, 50)); return; }
    const goal = $('#asP', h).value.trim();
    if (goal.length < 3) { $('#asErr', h).textContent = 'Tell Cas what the follow-up is for.'; $('#asErr', h).hidden = false; return; }
    $('#asErr', h).hidden = true;
    const r = await aiCall('/api/ai/sequence', { goal, steps: +$('#asN', h).value, trigger: TRIG[(DRIP.E && DRIP.E.trigger_type) || 'start'], language: $('#asL', h).value.trim() || undefined }, e.currentTarget);
    if (!r || !$('#asOut', h)) return;
    steps = r.steps.map((s) => ({ delay_value: s.delay_value, delay_unit: s.delay_unit, body: s.body, media: null, buttons: [], sent: 0, clicks: 0 }));
    $('#asOut', h).hidden = false;
    $('#asOut', h).innerHTML = '<div class="aiseq">' + steps.map((s, i) => '<div><span class="pill p-blue">' + (i === 0 ? 'Instantly' : delayText(s.delay_value, s.delay_unit).replace('Wait ', 'After ')) + '</span><p>' + fmtMsg(s.body) + '</p></div>').join('') + '</div>';
    $('.ca', h).innerHTML = cas('happy');
    $('#asGo', h).innerHTML = icon('check') + 'Use these messages';
  };
}

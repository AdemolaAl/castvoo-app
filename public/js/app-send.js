'use strict';
/*
 * app-send.js: "Send a message" (composer + history), the message report, Ask Cas helpers for writing,
 * shared media picker, and the Calendar page.
 * API: /api/broadcasts (list, create, estimate, test, edit, pin, delete, cancel, approve, send), /api/media, /api/ai/*
 */

const COMP = { conn: null, seg: '', text: '', media: null, btns: [], stop: true, when: 'now', at: '' };
(function restoreDraft() { const t = store.get('cv_draft'); if (t) COMP.text = t; })();

const aiOn = () => CFG.ai_available && CFG.features.ai !== false;
function aiLeft() { const p = APP.state && APP.state.plan; return p ? Math.max(0, (p.limits.ai_writes || 0) - (p.usage.ai_writes || 0)) : 0; }
function setAiLeft(n) { if (APP.state && n != null) { APP.state.plan.usage.ai_writes = Math.max(0, APP.state.plan.limits.ai_writes - n); } $$('[data-aileft]').forEach((e) => { e.textContent = fmt(aiLeft()) + ' AI writes left'; }); }
const isBot = (c) => c && c.kind === 'bot';
const fixUrl = (u) => { const s = String(u || '').trim(); return !s || /^https?:\/\//i.test(s) ? s : 'https://' + s; };

/* ---------- Media (photo / video) ---------- */
const MEDIA_RULES = 'JPG, PNG, WEBP, GIF, MP4 or MOV. Photos up to 10 MB, videos up to 50 MB.';
function fsize(b) { return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
function checkFile(f) {
  const img = /^image\/(jpeg|png|gif|webp)$/.test(f.type), vid = /^video\/(mp4|quicktime)$/.test(f.type);
  if (!img && !vid) { toast('Use a JPG, PNG, WEBP, GIF, MP4 or MOV file.', { kind: 'err' }); return false; }
  if (img && f.size > 10485760) { toast('Photos can be up to 10 MB. This one is ' + fsize(f.size) + '.', { kind: 'err' }); return false; }
  if (vid && f.size > 52428800) { toast('Videos can be up to 50 MB. This one is ' + fsize(f.size) + '.', { kind: 'err' }); return false; }
  return true;
}
/* Upload with a progress bar inside `box`. Resolves the media object { id, kind, filename, size, url } or null. */
async function pickAndUpload(file, box) {
  if (!checkFile(file)) return null;
  const url = URL.createObjectURL(file);
  const kind = file.type.startsWith('video') ? 'video' : (file.type === 'image/gif' ? 'animation' : 'photo');
  if (box) box.innerHTML = '<div class="mrow"><span class="mth">' + (kind === 'video' ? '<video src="' + url + '" muted playsinline></video>' : '<img src="' + url + '" alt="">') + '</span><span class="mt2"><b>' + esc(file.name) + '</b><small>Uploading… <span data-pct>0%</span></small><div class="upb"><i style="width:0"></i></div></span></div>';
  try {
    const m = await upload(file, (p) => { if (!box) return; const b = $('.upb i', box); if (b) b.style.width = Math.round(p * 100) + '%'; const t = $('[data-pct]', box); if (t) t.textContent = Math.round(p * 100) + '%'; });
    return { id: m.id, kind: m.kind || kind, filename: m.filename || file.name, size: m.size_bytes || file.size, url };
  } catch (e) { URL.revokeObjectURL(url); apiErr(e); return null; }
}
function mediaThumb(m) { if (!m) return ''; const src = m.url || mediaUrl(m.id); return m.kind === 'video' ? '<video src="' + esc(src) + '" muted playsinline preload="metadata"></video><span class="vb">▶</span>' : '<img src="' + esc(src) + '" alt="">'; }
function mediaPreview(m) { if (!m) return ''; const src = m.url || mediaUrl(m.id); return m.kind === 'video' ? '<div class="img med" style="position:relative"><video src="' + esc(src) + '" muted autoplay loop playsinline></video><span class="vplay">▶</span></div>' : '<div class="img med"><img src="' + esc(src) + '" alt="Attached photo"></div>'; }

/* ---------- Telegram phone preview ---------- */
function phonePreview(conn, text, media, btns, stop) {
  const name = conn ? connName(conn) : 'Your Telegram';
  const bs = (btns || []).filter((b) => (b.label || '').trim());
  const showStop = isBot(conn) && stop;
  return '<div class="tg-top"><span class="bk">‹</span><div class="tt"><b>' + esc(name) + ' ' + VF + '</b><small>' + (conn ? (isBot(conn) ? 'bot' : (KIND[conn.kind] || KIND.bot).n.toLowerCase()) : '') + '</small></div><span class="tg-ava" style="background:var(--grad)"><svg viewBox="0 0 40 40"><use href="#logo"/></svg></span></div>' +
    '<div class="tg-bg"><div class="tm in">' + mediaPreview(media) + '<span class="px">' + (fmtMsg(text, { name: isBot(conn) ? 'Tunde' : null }) || '<span style="color:#9AA3B2">Your message appears here</span>') + '</span><span class="ti">' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + '</span></div>' +
    (bs.length || showStop ? '<div class="tbtns one">' + bs.map((b) => '<span>' + esc(b.label) + ' ↗</span>').join('') + (showStop ? '<span class="stopb">🔕 Stop these messages</span>' : '') + '</div>' : '') + '</div>' +
    '<div class="tg-in"><span class="pc0">📎</span><span class="fld">Message</span><span class="sb">➤</span></div>';
}

/* ---------- Ask Cas (writing) ---------- */
async function aiCall(path, body, btn) {
  if (btn) btnBusy(btn, true, 'Cas is writing…');
  try { const r = await POST(path, body); setAiLeft(r.ai_writes_left); return r; } catch (e) { apiErr(e); return null; } finally { if (btn) btnBusy(btn, false); }
}
/* onText(text) is called with the new message. hasMedia changes the length Cas aims for. */
/* opts.kind: 'welcome' | 'followup' (Welcome Flows) so Cas knows what it is writing; opts.placeholder: example goal. */
function openAIWrite(onText, hasMedia, opts = {}) {
  const tones = ['Friendly', 'Confident', 'Urgent', 'Fun', 'Professional'];
  const h = sheet('Ask Cas to write it', '<span class="spk">' + icon('spark') + '</span>',
    '<div class="mh"><div class="ca" data-cas="think"></div><div class="mt"><small class="muted">Uses 1 AI write · <span data-aileft>' + fmt(aiLeft()) + ' AI writes left</span></small></div></div>' +
    '<div class="field"><label for="awP">What should this message do?</label><textarea class="inp" id="awP" rows="3" maxlength="1000" placeholder="' + esc(opts.placeholder || 'For example: Remind people the sale ends tonight. Friendly but urgent. One button to the shop.') + '"></textarea></div>' +
    '<div class="field"><label>Tone</label><div class="chips" id="awTone">' + tones.map((t, i) => '<button type="button" class="chb' + (i === 0 ? ' on' : '') + '">' + t + '</button>').join('') + '</div></div>' +
    '<div class="field"><label for="awL">Language <span class="hint">(optional)</span></label><input class="inp" id="awL" maxlength="40" placeholder="English"></div>' +
    '<div id="awOut" class="aio" hidden></div><p class="ferr" id="awErr" hidden></p>' +
    '<div class="row2b"><button type="button" class="btn b-ghost" id="awX">Cancel</button><button type="button" class="btn b-blue" id="awGo">' + icon('spark') + 'Write it</button></div>');
  let out = '';
  $('#awTone', h).onclick = (e) => { const b = e.target.closest('.chb'); if (b) $$('#awTone .chb', h).forEach((x) => x.classList.toggle('on', x === b)); };
  $('#awX', h).onclick = closeModal;
  $('#awGo', h).onclick = async () => {
    if (out) { closeModal(); onText(out); return; }
    const goal = $('#awP', h).value.trim();
    if (goal.length < 3) { $('#awErr', h).textContent = 'Tell Cas in a few words what the message is for.'; $('#awErr', h).hidden = false; return; }
    $('#awErr', h).hidden = true;
    const r = await aiCall('/api/ai/write', { goal, tone: $('#awTone .on', h).textContent, language: $('#awL', h).value.trim() || undefined, has_media: !!hasMedia, kind: opts.kind || undefined }, $('#awGo', h));
    if (!r || !$('#awOut', h)) return;
    out = r.text;
    const o = $('#awOut', h); o.hidden = false; o.innerHTML = fmtMsg(out);
    $('.ca', h).innerHTML = cas('happy');
    $('#awGo', h).innerHTML = icon('check') + 'Use this';
    $('#awX', h).textContent = 'Try again';
    $('#awX', h).onclick = () => { out = ''; $('#awOut', h).hidden = true; $('#awGo', h).innerHTML = icon('spark') + 'Write it'; $('#awX', h).textContent = 'Cancel'; $('#awX', h).onclick = closeModal; $('#awGo', h).click(); };
  };
  setTimeout(() => { const t = $('#awP'); if (t) t.focus(); }, 80);
}
function askLanguage() {
  return new Promise((resolve) => {
    const L = ['French', 'Portuguese', 'Spanish', 'Swahili', 'Nigerian Pidgin', 'Arabic', 'Hausa', 'Yoruba'];
    const h = sheet('Translate with Cas', '<span class="spk">' + icon('globe') + '</span>', '<p class="muted" style="font-size:14px">Uses 1 AI write. Pick a language or type one.</p><div class="chips" id="tlC">' + L.map((l) => '<button type="button" class="chb" data-l="' + l + '">' + l + '</button>').join('') + '</div><div class="field"><label for="tlI">Another language</label><input class="inp" id="tlI" maxlength="40" placeholder="For example: German"></div><button type="button" class="btn b-blue full" id="tlGo">' + icon('globe') + 'Translate</button>', { onClose: () => resolve(null) });
    $('#tlC', h).onclick = (e) => { const b = e.target.closest('[data-l]'); if (b) { onModalClose = null; closeModal(); resolve(b.dataset.l); } };
    $('#tlGo', h).onclick = () => { const v = $('#tlI', h).value.trim(); if (v.length < 2) { $('#tlI', h).focus(); return; } onModalClose = null; closeModal(); resolve(v); };
  });
}
const REWRITE = [['shorter', 'Shorter'], ['clearer', 'Clearer'], ['urgent', 'More urgent'], ['friendlier', 'Friendlier'], ['fix', 'Fix spelling']];
function aiChips(id) { return aiOn() ? '<div class="chips aichips" id="' + id + '">' + REWRITE.map((r) => '<button type="button" class="chb" data-how="' + r[0] + '">✨ ' + r[1] + '</button>').join('') + '<button type="button" class="chb" data-how="translate">✨ Translate…</button><span class="hint" data-aileft>' + fmt(aiLeft()) + ' AI writes left</span></div>' : ''; }
/* Wire rewrite chips: getText() -> current text, setText(t) -> put it back. */
function wireAiChips(box, getText, setText, hasMedia) {
  if (!box) return;
  box.onclick = async (e) => {
    const b = e.target.closest('[data-how]'); if (!b) return;
    const text = getText().trim();
    if (text.length < 2) { toast('Write something first, then Cas can rewrite it.', { kind: 'info' }); return; }
    let r;
    if (b.dataset.how === 'translate') { const lang = await askLanguage(); if (!lang) return; r = await aiCall('/api/ai/translate', { text, language: lang }, b); }
    else r = await aiCall('/api/ai/rewrite', { text, how: b.dataset.how, has_media: !!hasMedia() }, b);
    if (!r) return;
    const before = getText();
    setText(r.text);
    toast('Cas rewrote it.', { action: { label: 'Undo', onClick: () => setText(before) } });
  };
}
function fmtButtons(id) { return '<div class="fmt" id="' + id + '"><button type="button" data-f="*" title="Bold" aria-label="Bold"><b>B</b></button><button type="button" data-f="_" title="Italic" aria-label="Italic"><i>I</i></button><button type="button" class="nmb" data-e="{name}" title="Add each person\'s first name" aria-label="Add each person\'s first name">👤 Name</button>' + ['🔥', '✅', '⏳', '🎁', '👇', '💙'].map((x) => '<button type="button" data-e="' + x + '" aria-label="Add ' + x + '">' + x + '</button>').join('') + (aiOn() ? '<button type="button" class="aiw" data-aiw>' + icon('spark') + 'Ask Cas</button>' : '') + '</div>'; }
function wireFmt(box, ta, onChange) {
  box.onclick = (e) => {
    const b = e.target.closest('button'); if (!b || b.hasAttribute('data-aiw')) return;
    const used = ta.dataset.caret === '1' || document.activeElement === ta;
    const s = used ? ta.selectionStart : ta.value.length, en = used ? ta.selectionEnd : ta.value.length;
    if (b.dataset.f) { const f = b.dataset.f; const sel = ta.value.slice(s, en) || (f === '*' ? 'bold text' : 'italic text'); ta.value = ta.value.slice(0, s) + f + sel + f + ta.value.slice(en); ta.setSelectionRange(s + 1, s + 1 + sel.length); }
    else if (b.dataset.e) { insertAtCaret(ta, b.dataset.e, true); }
    ta.focus(); onChange();
  };
}
/* Remember which text boxes the user has clicked or typed in. A box that was never focused reports its caret at 0,
   so "👤 Their name" would glue {name} to the start of the message. */
document.addEventListener('focusin', (e) => { const t = e.target; if (t && t.tagName === 'TEXTAREA') t.dataset.caret = '1'; });
/* Put text where the cursor is, or at the end if the box was never clicked into. {name} gets a space around it when
   it would touch a word. quiet = don't fire an input event (the caller handles it). */
function insertAtCaret(ta, text, quiet) {
  if (!ta) return;
  const used = ta.dataset.caret === '1' || document.activeElement === ta;
  const v = ta.value;
  const s = used ? ta.selectionStart : v.length, en = used ? ta.selectionEnd : v.length;
  const before = v.slice(0, s), after = v.slice(en);
  let ins = text;
  if (text.startsWith('{')) {
    if (before && !/[\s(\[]$/.test(before)) ins = ' ' + ins;
    if (after && /^[\p{L}\p{N}]/u.test(after)) ins += ' ';
  }
  ta.value = before + ins + after;
  ta.focus();
  const at = before.length + ins.length;
  ta.setSelectionRange(at, at);
  ta.dataset.caret = '1';
  if (!quiet) ta.dispatchEvent(new Event('input', { bubbles: true }));
}
function counterHtml(text, hasMedia) {
  const lim = hasMedia ? 1024 : 4096, n = visibleLength(text);
  const tip = hasNameTag(text) ? '<span class="nmtip">👤 <b>{name}</b> becomes each person\'s first name, like “Hi Tunde”. No name, or a channel or group post: “there”.</span>' : '';
  return '<span>' + (hasMedia ? 'With a photo or video, Telegram allows 1,024 characters' : 'Telegram allows 4,096 characters per message') + '</span><span class="tnum">' + fmt(n) + ' / ' + fmt(lim) + '</span>' + tip;
}
/* Button rows editor (label + link). */
function btnRows(list) {
  return list.map((b, i) => '<div class="btnrow"><input class="inp" data-bl="' + i + '" value="' + esc(b.label) + '" maxlength="40" placeholder="Button text" aria-label="Button ' + (i + 1) + ' text"><input class="inp" data-bu="' + i + '" value="' + esc(b.url) + '" placeholder="https://your-link.com" inputmode="url" aria-label="Button ' + (i + 1) + ' link"><button type="button" class="x" data-bx="' + i + '" aria-label="Remove button">×</button></div>').join('');
}
function checkButtons(list) {
  for (const [i, b] of list.entries()) {
    const l = (b.label || '').trim(), u = fixUrl(b.url);
    if (!l && !u) continue;
    if (!l) return 'Button ' + (i + 1) + ' needs some text.';
    if (!u || !/^https?:\/\/[^\s.]+\.[^\s]+/.test(u)) return 'Button "' + l + '" needs a link, like https://your-shop.com';
  }
  return '';
}
const cleanButtons = (list) => list.filter((b) => (b.label || '').trim() || (b.url || '').trim()).map((b) => ({ label: b.label.trim(), url: fixUrl(b.url) }));

/* ---------- History table ---------- */
function castWhen(b) {
  if (b.status === 'scheduled' || (b.status === 'pending_approval' && b.send_at)) return 'For ' + fmtDate(b.send_at);
  if (b.send_mode === 'local9' && b.status === 'sending') return '9am local time';
  return fmtDate(b.started_at || b.created_at);
}
function castActions(b) {
  const a = [];
  const owner = isOwner(), sender = canSend();
  const old = b.started_at && Date.now() - new Date(b.started_at).getTime() > 47.5 * 3600000;
  if (b.status === 'draft') { if (sender) a.push(['send', 'Send', 'send']); a.push(['edit', 'Edit', 'pencil']); a.push(['cancel', 'Discard', 'x']); }
  if (b.status === 'pending_approval') { if (owner) a.push(['approve', 'Approve', 'check']); a.push(['edit', 'Edit', 'pencil']); a.push(['cancel', 'Cancel', 'x']); }
  if (b.status === 'scheduled') { if (sender) a.push(['edit', 'Edit', 'pencil']); a.push(['cancel', 'Cancel', 'x']); }
  if (b.status === 'sending' || b.status === 'sent') {
    if (sender && b.status === 'sent') a.push(['edit', 'Edit', 'pencil']);
    a.push(['pin', 'Pin', 'pin']);
    if (sender) a.push(old ? ['delete', 'Delete', 'trash', 'Telegram only lets bots delete messages for 48 hours after sending'] : ['delete', 'Delete', 'trash']);
    if (b.status === 'sending') a.push(['cancel', 'Stop', 'stop']);
  }
  return '<span class="acts2">' + a.map((x) => '<button type="button" class="btn b-ghost" data-ba="' + x[0] + '" data-id="' + b.id + '"' + (x[3] ? ' disabled title="' + esc(x[3]) + '"' : '') + '>' + x[1] + '</button>').join('') + '<button type="button" class="btn b-ghost" data-report="' + b.id + '">Report</button></span>';
}
function castTable(rows, opts = {}) {
  return '<table class="tbl rsp"><thead><tr><th>Message</th>' + (opts.compact ? '' : '<th>Audience</th>') + '<th>Delivered</th><th>Clicks</th><th>Status</th>' + (opts.compact ? '' : '<th></th>') + '</tr></thead><tbody>' + rows.map((b) => '<tr>' +
    td('', '<button type="button" class="tlink" data-report="' + b.id + '"><b>' + esc(b.title || (b.body || '').slice(0, 60)) + '</b></button><small>' + TG + esc(b.kind === 'bot' ? '@' + (b.conn_username || b.conn_title) : (b.conn_title || '')) + ' · ' + esc(castWhen(b)) + '</small>', 'first') +
    (opts.compact ? '' : td('Audience', esc(b.kind === 'bot' ? (b.segment_name || 'Everyone') : 'Everyone in it'))) +
    td('Delivered', '<span class="tnum">' + (b.total ? fmt(b.sent) + ' / ' + fmt(b.total) : '—') + '</span>' + (b.failed ? '<small class="bad">' + fmt(b.failed) + ' failed</small>' : '')) +
    td('Clicks', '<span class="tnum">' + (b.clicks ? fmt(b.clicks) + (b.kind === 'bot' && b.clickers ? ' <small>· ' + plural(b.clickers, 'person', 'people') + '</small>' : '') : '—') + '</span>') +
    td('Status', b.send_mode === 'local9' && b.status === 'sending' ? '<span class="pill p-blue">9am local time</span>' : bPill(b.status)) +
    (opts.compact ? '' : td('', castActions(b))) + '</tr>').join('') + '</tbody></table>';
}
/* Make the buttons in a castTable work. reload() redraws after a change. */
function wireCastTable(box, reload) {
  if (!box) return;
  box.onclick = async (e) => {
    const r = e.target.closest('[data-report]'); if (r) { openReport(+r.dataset.report, reload); return; }
    const b = e.target.closest('[data-ba]'); if (!b || b.disabled) return;
    const id = +b.dataset.id, act = b.dataset.ba;
    try {
      if (act === 'edit') { openEdit(id, reload); return; }
      if (act === 'delete' && !(await confirmBox('Delete this message?', 'It is removed from Telegram for everyone who got it. This can\'t be undone.', 'Delete it', true))) return;
      if (act === 'cancel' && !(await confirmBox('Stop this message?', 'Anyone who hasn\'t received it yet won\'t get it.', 'Yes, stop it', true))) return;
      if (act === 'send' && !(await confirmBox('Send this draft now?', 'It goes out to everyone in its audience straight away.', 'Send now'))) return;
      btnBusy(b, true, '');
      const res = await POST('/api/broadcasts/' + id + '/' + act, {});
      toast({ approve: res.status === 'scheduled' ? 'Approved. It goes out at its scheduled time.' : 'Approved. Sending now.', send: 'Sending now.', cancel: 'Stopped.', pin: 'Pinning it in Telegram.', delete: 'Deleting it from Telegram.' }[act] || 'Done.');
      refreshState();
      reload();
    } catch (ex) { btnBusy(b, false); apiErr(ex); }
  };
}

/* Edit a message (drafts and scheduled change here; sent ones are edited in Telegram). */
async function openEdit(id, reload) {
  let d;
  try { d = (await GET('/api/broadcasts/' + id)).broadcast; } catch (e) { apiErr(e); return; }
  const sent = ['sent', 'sending'].includes(d.status);
  const h = sheet('Edit message', '<span class="spk">' + icon('pencil') + '</span>',
    (sent ? '<div class="note2"><span>✏️</span><span>Your change is made in Telegram for everyone who already got it. Buttons and the photo stay the same.</span></div>' : '') +
    '<div class="field"><textarea class="inp" id="edT" rows="8">' + esc(d.body) + '</textarea><div class="cc" id="edC"></div></div><p class="ferr" id="edE" hidden></p>' +
    '<div class="row2b"><button type="button" class="btn b-ghost" data-shx2>Cancel</button><button type="button" class="btn b-blue" id="edGo">Save change</button></div>');
  const t = $('#edT', h), c = $('#edC', h);
  const upd = () => { const lim = d.media_id ? 1024 : 4096; c.className = 'cc' + (visibleLength(t.value) > lim ? ' bad' : ''); c.innerHTML = counterHtml(t.value, !!d.media_id); };
  t.oninput = upd; upd();
  $('[data-shx2]', h).onclick = closeModal;
  $('#edGo', h).onclick = async (e) => {
    const b = e.currentTarget;
    if (!t.value.trim()) { $('#edE', h).textContent = 'The message can\'t be empty.'; $('#edE', h).hidden = false; return; }
    btnBusy(b, true, 'Saving…');
    try { const r = await POST('/api/broadcasts/' + id + '/edit', { body: t.value }); closeModal(); toast(r.editing ? 'Updating it in Telegram for everyone.' : 'Saved.'); if (reload) reload(); } catch (ex) { btnBusy(b, false); $('#edE', h).textContent = ex.message; $('#edE', h).hidden = false; }
  };
}

/* Report for one message: delivery, clicks per button, errors. */
const ERR_TEXT = [[/blocked/i, 'Blocked the bot (removed from your list automatically)'], [/deactivated/i, 'Deleted their Telegram account'], [/chat not found/i, 'Chat not found (they may have left)'], [/not enough rights|administrator|rights/i, 'The bot is missing admin rights in this chat'], [/too many requests|retry after/i, 'Telegram asked us to slow down (retried)'], [/cancel/i, 'Stopped before sending'], [/deleted/i, 'Deleted before sending']];
const errText = (e) => { for (const [re, t] of ERR_TEXT) if (re.test(e || '')) return t; return e || 'Unknown error'; };
async function openReport(id, reload) {
  const h = sheet('Message report', '<span class="spk">' + icon('chart') + '</span>', loadingBox('Loading the report…'), { wide: true });
  let d;
  try { d = await GET('/api/broadcasts/' + id); } catch (e) { $('.sb', h).innerHTML = errorBox(e); return; }
  if (!$('.sb', h)) return;
  const b = d.broadcast, links = d.links || [], errs = d.errors || [];
  const clicks = links.reduce((a, l) => a + l.clicks, 0), mx = Math.max(1, ...links.map((l) => l.clicks));
  const done = b.total ? Math.min(1, (b.sent + b.failed) / b.total) : 0;
  $('.sb', h).innerHTML = '<div class="rephd"><div style="min-width:0;flex:1"><b class="ell" style="font-size:17px;display:block">' + esc(b.title || 'Message') + '</b><small class="muted">' + esc(castWhen(b)) + '</small></div>' + bPill(b.status) + '</div>' +
    '<div class="rate"><div><b class="tnum">' + fmt(b.sent) + '</b><small>Delivered</small></div><div><b class="tnum">' + fmt(b.failed) + '</b><small>Not delivered</small></div><div><b class="tnum">' + fmt(clicks) + '</b><small>Button clicks</small></div></div>' +
    (b.status === 'sending' ? '<div><div class="prog2"><i style="width:' + Math.round(done * 100) + '%"></i></div><small class="muted">' + fmt(d.queued) + ' still to send' + (d.next_due && new Date(d.next_due) > new Date() ? ' · next at ' + fmtDate(d.next_due) : '') + '</small></div>' : '') +
    '<div class="field"><label>Buttons</label>' + (links.length ? links.map((l) => '<div class="barr"><span class="ell">' + esc(l.label) + '</span><div class="prog2"><i style="width:' + Math.round(l.clicks / mx * 100) + '%"></i></div><span class="tnum" style="text-align:right">' + fmt(l.clicks) + '</span></div>').join('') : '<p class="muted" style="font-size:14px">This message had no buttons.</p>') + '</div>' +
    (errs.length ? '<div class="field"><label>Why some were not delivered</label>' + errs.map((x) => '<div class="errr"><span>' + esc(errText(x.error)) + '</span><b class="tnum">' + fmt(x.n) + '</b></div>').join('') + '</div>' : '') +
    '<div class="field"><label>Message</label><div class="aio">' + fmtMsg(b.body) + '</div></div>' +
    '<p class="hint">Telegram doesn\'t tell anyone who read a message, so Castvoo shows deliveries and clicks. Channel views are visible inside Telegram.</p>';
  void reload;
}

/* Sending progress (real numbers, checked every 2 seconds). */
function sendProgress(id, total) {
  const h = sheet('Sending on Telegram', '<span class="spk">' + icon('send') + '</span>', '<div class="mh"><div class="ca" data-cas="wave"></div><div class="mt"><small class="muted">You can close this. Sending carries on, and Home shows the progress.</small></div></div><div class="bigc tnum" id="spN">0</div><small class="muted" style="margin-top:-10px">of <span id="spT">' + fmt(total) + '</span> delivered</small><div class="prog2"><i id="spB" style="width:0"></i></div><div class="rate"><div><b class="tnum" id="spD">0</b><small>Delivered</small></div><div><b class="tnum" id="spF">0</b><small>Not delivered</small></div><div><b class="tnum" id="spQ">' + fmt(total) + '</b><small>Waiting</small></div></div><span class="hint">About 25 messages a second, inside Telegram\'s limits.</span><button type="button" class="btn b-blue full" id="spC">Close</button>');
  $('#spC', h).onclick = closeModal;
  let stop = false;
  onModalClose = () => { stop = true; };
  const tick = async () => {
    if (stop) return;
    try {
      const d = await GET('/api/broadcasts/' + id);
      const b = d.broadcast; if (stop || !$('#spN')) return;
      const tot = b.total || total;
      $('#spN').textContent = fmt(b.sent); $('#spT').textContent = fmt(tot); $('#spD').textContent = fmt(b.sent); $('#spF').textContent = fmt(b.failed); $('#spQ').textContent = fmt(d.queued);
      $('#spB').style.width = (tot ? Math.min(100, (b.sent + b.failed) / tot * 100) : 100) + '%';
      if (b.status !== 'sending') {
        $('#shT').textContent = b.status === 'sent' ? 'Message delivered 🎉' : 'Sending stopped';
        const ca = $('.modal .ca, .sheet .ca'); if (ca) ca.innerHTML = cas('happy');
        $('#spC').textContent = 'Done';
        if (b.status === 'sent') confetti();
        refreshState();
        return;
      }
    } catch (_) { /* try again */ }
    setTimeout(tick, 2000);
  };
  tick();
}

/* ---------- The page ---------- */
PAGES.broadcast = {
  title: 'Send a message', sub: 'Write, preview and send to Telegram',
  async render(el, q, alive) {
    el.innerHTML = skel(1, 300);
    const s = APP.state;
    if (!(s.plan.features || []).includes('broadcasts')) {
      // Free plan: say so up front instead of showing the whole composer and refusing at Send.
      el.innerHTML = emptyBox({ cas: 'wave', title: 'Broadcasts are on Starter and up', text: 'Your plan runs your welcome bot for people who ask to join. Upgrade to send messages to everyone who started your bot, or post to your channel.', action: '<div class="row2b" style="max-width:420px"><button type="button" class="btn b-blue" data-upgrade-bc>' + icon('up') + 'See plans</button><button type="button" class="btn b-ghost" data-go="flows">Welcome Flows</button></div>' });
      $('[data-upgrade-bc]', el).onclick = () => openUpgrade({ title: 'Send broadcasts', text: 'Broadcasts, scheduling and 9am sending are on Starter and up.', feature: 'broadcasts' });
      return;
    }
    const conns = s.connections.filter((c) => c.status === 'active');
    if (!s.connections.length) {
      el.innerHTML = emptyBox({ cas: 'wave', title: 'Connect Telegram first', text: 'Add a bot, channel or group, then you can send your first message from here.', action: '<div class="row2b" style="max-width:420px"><button type="button" class="btn b-blue" data-connect>' + icon('plus') + 'Connect Telegram</button><button type="button" class="btn b-ghost" data-vguide="connect-bot">' + icon('play') + 'Watch how</button></div>' });
      return;
    }
    if (CFG.features.broadcasts === false) { el.innerHTML = emptyBox({ cas: 'think', title: 'Sending is switched off for a moment', text: 'The Castvoo team has paused broadcasts. Please check back soon.' }); return; }
    if (!conns.some((c) => String(c.id) === String(COMP.conn))) COMP.conn = (conns.find((c) => String(c.id) === q.conn) || conns[0] || s.connections[0]).id;
    if (q.conn && conns.some((c) => String(c.id) === q.conn)) COMP.conn = +q.conn;
    const approval = s.workspace.role === 'drafter' || (s.workspace.require_approval && s.workspace.role !== 'owner');
    const conn = () => s.connections.find((c) => c.id === COMP.conn);
    let segs = null, est = null, estT = 0;

    el.innerHTML = '<div class="compose"><div class="flds">' +
      (approval ? '<div class="note2"><span>👀</span><span><b>Your messages wait for approval.</b> The workspace owner checks and sends them.</span></div>' : '') +
      '<div class="box"><div class="field"><label>Send from</label><div class="chips" id="cBot">' + s.connections.map((c) => '<button type="button" class="chb ' + (c.id === COMP.conn ? 'on' : '') + '" data-i="' + c.id + '"' + (c.status !== 'active' ? ' disabled title="This connection needs attention"' : '') + '>' + TG + esc(connName(c)) + '<small style="opacity:.7;font-weight:700">' + (KIND[c.kind] || KIND.bot).n + '</small></button>').join('') + '</div></div>' +
      '<div class="field" id="cAudF"><label>Who gets it</label><div class="note2" id="cSegN" hidden></div><div class="chips" id="cSeg"></div><span class="hint" id="cAud" style="font-weight:700;color:var(--blue-t)"></span></div></div>' +
      '<div class="box"><div class="field"><div class="bh"><label for="cTxt" style="font-weight:700;font-size:14px">Message</label>' + fmtButtons('cFmt') + '</div>' +
      '<textarea class="inp" id="cTxt" rows="7" placeholder="Write your message. Use *stars* for bold and _underscores_ for italic.">' + esc(COMP.text) + '</textarea><div class="cc" id="cCnt"></div>' + aiChips('cAi') + '</div>' +
      '<div class="field" data-feat="media"><label for="cFile">Photo or video <span class="hint">(optional)</span></label><label class="drop" id="cDrop"><input type="file" id="cFile" accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime" hidden><div id="cMed"></div></label><span class="hint">' + MEDIA_RULES + ' You can also drag a file in or paste it.</span></div>' +
      '<div class="field"><label>Buttons <span class="hint">(optional, up to 6)</span></label><div id="cBtns" class="btnl"></div><button type="button" class="btn b-ghost xs" id="cAddB" style="align-self:flex-start">' + icon('plus') + 'Add a button</button><span class="hint">Every button link is tracked, so you can see the clicks.</span></div></div>' +
      '<div class="box"><div class="field"><label>When</label><div class="seg2" id="cWhen"><button type="button" data-w="now">Send now</button><button type="button" data-w="at">Schedule</button><button type="button" data-w="local9" data-feat="local_time">9am local time</button></div>' +
      '<div class="note2" id="cLocN" hidden><span>🌍</span><span>Goes out at the next 9am in your workspace time zone (' + esc(s.workspace.timezone) + '). Your audience somewhere else? Change the time zone in Settings.</span></div>' +
      '<input class="inp" id="cDate" type="datetime-local" hidden style="max-width:300px" aria-label="Date and time"></div>' +
      '<div class="tg" id="cStopR"><span><b style="font-size:14.5px">Add a "Stop these messages" button</b><br><small class="muted">Lets people opt out in one tap. Fewer spam reports, safer bot.</small></span>' + toggleBtn('cStop', COMP.stop, 'Stop these messages button') + '</div>' +
      '<p class="ferr" id="cErr" hidden></p>' +
      '<button type="button" class="btn b-blue full" id="cSend">' + icon('send') + '<span id="cSendT">Send</span></button>' +
      '<div class="row2b"><button type="button" class="btn b-ghost sm" id="cTest">' + icon('test') + 'Send me a test</button><button type="button" class="btn b-ghost sm" id="cDraft">Save as draft</button></div></div>' +
      '</div><div class="pvw"><div class="phone2"><div class="notch"></div><div class="scr" id="pvS"></div></div><p class="hint" style="text-align:center;margin-top:10px">Live preview of how it looks in Telegram</p></div></div>' +
      '<div class="box" id="cHist"><div class="bh"><h3>Your messages</h3><button type="button" class="btn b-ghost xs" id="cHR">' + icon('refresh') + 'Refresh</button></div><div id="cHT">' + skel(3, 48) + '</div></div>';

    const txt = $('#cTxt');
    const hasMedia = () => !!COMP.media;
    const pv = () => { $('#pvS').innerHTML = phonePreview(conn(), txt.value, COMP.media, COMP.btns, COMP.stop); };
    const cnt = () => { const n = visibleLength(txt.value), lim = hasMedia() ? 1024 : 4096; const c = $('#cCnt'); c.className = 'cc' + (n > lim ? ' bad' : ''); c.innerHTML = counterHtml(txt.value, hasMedia()); };
    const onText = () => { COMP.text = txt.value; store.set('cv_draft', COMP.text || null); cnt(); const p = $('#pvS .px'); if (p) p.innerHTML = fmtMsg(COMP.text, { name: isBot(conn()) ? 'Tunde' : null }) || '<span style="color:#9AA3B2">Your message appears here</span>'; else pv(); };
    txt.oninput = onText;
    wireFmt($('#cFmt'), txt, onText);
    const aiw = $('[data-aiw]', $('#cFmt')); if (aiw) aiw.onclick = () => openAIWrite((t) => { txt.value = t; onText(); }, hasMedia());
    wireAiChips($('#cAi'), () => txt.value, (t) => { txt.value = t; onText(); }, hasMedia);

    // Audience + estimate
    const sendLabel = () => {
      const c = conn(); const n = est ? est.audience : null;
      const who = n == null ? '' : isBot(c) ? ' to ' + plural(n, 'person', 'people') : ' to ' + connName(c);
      $('#cSendT').textContent = approval ? 'Send for approval' : COMP.when === 'now' ? 'Send now' + who : COMP.when === 'at' ? 'Schedule' + who : 'Schedule for 9am local time';
    };
    const estimate = async () => {
      const c = conn(); const my = ++estT;
      $('#cAud').textContent = 'Counting…';
      try {
        est = await GET('/api/broadcasts/estimate?connection_id=' + c.id + (isBot(c) && COMP.seg ? '&segment_id=' + COMP.seg : ''));
        if (my !== estT || !alive()) return;
        const mins = Math.max(1, Math.ceil(est.seconds / 60));
        $('#cAud').textContent = isBot(c) ? (est.audience ? plural(est.audience, 'person', 'people') + ' will get this · about ' + plural(mins, 'minute') + ' to send' : 'Nobody matches yet. People appear here after they start your bot.') : 'Posts once to ' + connName(c) + (c.member_count != null ? ' · ' + fmt(c.member_count) + ' ' + KIND[c.kind].w : '');
      } catch (e) { if (my === estT) $('#cAud').textContent = ''; est = null; }
      sendLabel();
    };
    const drawAudience = async () => {
      const c = conn();
      const bot = isBot(c);
      $('#cSeg').hidden = !bot; $('#cSegN').hidden = bot;
      $('#cStopR').hidden = !bot;
      const loc = $('#cWhen [data-w="local9"]'); if (loc) loc.hidden = !bot || CFG.features.local_time === false;
      if (!bot && COMP.when === 'local9') COMP.when = 'now';
      if (!bot) {
        $('#cSegN').innerHTML = '<span>ℹ️</span><span><b>' + (c.kind === 'channel' ? 'Channel posts go to everyone in the channel.' : 'Group messages go to everyone in the group.') + '</b> Telegram doesn\'t let bots pick people inside a ' + c.kind + '. To send to an audience, send from a bot.</span>';
        COMP.seg = '';
      } else if (CFG.features.segments !== false) {
        if (!segs) { $('#cSeg').innerHTML = '<span class="spin"></span>'; try { segs = await GET('/api/segments'); } catch (_) { segs = { segments: [] }; } if (!alive()) return; }
        if (COMP.seg && !segs.segments.some((x) => String(x.id) === String(COMP.seg))) COMP.seg = '';
        $('#cSeg').innerHTML = '<button type="button" class="chb ' + (!COMP.seg ? 'on' : '') + '" data-s="">Everyone</button>' + segs.segments.map((x) => '<button type="button" class="chb ' + (String(x.id) === String(COMP.seg) ? 'on' : '') + '" data-s="' + x.id + '">' + esc(x.name) + '</button>').join('') + '<button type="button" class="chb add" data-go="audiences">' + icon('plus') + 'New audience</button>';
      } else $('#cSeg').innerHTML = '<span class="hint">Everyone who started this bot.</span>';
      drawWhen();
      pv(); estimate();
    };
    const drawWhen = () => {
      $$('#cWhen button').forEach((x) => x.classList.toggle('on', x.dataset.w === COMP.when));
      $('#cDate').hidden = COMP.when !== 'at'; $('#cLocN').hidden = COMP.when !== 'local9';
      if (COMP.when === 'at' && !$('#cDate').value) { const d = new Date(Date.now() + 3600000); d.setMinutes(0, 0, 0); $('#cDate').value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
      sendLabel();
    };
    $('#cBot').onclick = (e) => { const b = e.target.closest('[data-i]'); if (!b || b.disabled) return; COMP.conn = +b.dataset.i; $$('#cBot .chb').forEach((x) => x.classList.toggle('on', x === b)); drawAudience(); };
    $('#cSeg').onclick = (e) => { const b = e.target.closest('[data-s]'); if (!b) return; COMP.seg = b.dataset.s; $$('#cSeg [data-s]').forEach((x) => x.classList.toggle('on', x === b)); estimate(); };
    $('#cWhen').onclick = (e) => { const b = e.target.closest('[data-w]'); if (!b) return; COMP.when = b.dataset.w; drawWhen(); };
    $('#cStop').onclick = (e) => { COMP.stop = !COMP.stop; setToggle(e.currentTarget, COMP.stop); pv(); };

    // Media
    const drawMed = () => {
      const box = $('#cMed'); if (!box) return;
      const m = COMP.media;
      box.innerHTML = m ? '<div class="mrow"><span class="mth">' + mediaThumb(m) + '</span><span class="mt2"><b>' + esc(m.filename) + '</b><small>' + (m.kind === 'video' ? 'Video' : 'Photo') + ' · ' + fsize(m.size) + ' · ready</small></span><span class="ma"><button type="button" class="btn b-ghost xs" data-mr>Replace</button><button type="button" class="x" data-mx aria-label="Remove">×</button></span></div>'
        : '<div class="emp"><span class="ic">🖼️</span><span><b>Add a photo or video</b><small>Tap to choose, or drag it here</small></span></div>';
    };
    const take = async (f) => { const m = await pickAndUpload(f, $('#cMed')); if (m) { COMP.media = m; toast((m.kind === 'video' ? 'Video' : 'Photo') + ' added'); } drawMed(); cnt(); pv(); };
    const drop = $('#cDrop'), fin = $('#cFile');
    drop.addEventListener('click', (e) => { if (e.target.closest('[data-mx]')) { e.preventDefault(); COMP.media = null; drawMed(); cnt(); pv(); return; } if (e.target.closest('[data-mr]')) { e.preventDefault(); fin.click(); } });
    fin.onchange = () => { if (fin.files[0]) take(fin.files[0]); fin.value = ''; };
    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) take(f); });
    txt.addEventListener('paste', (e) => { const f = [...((e.clipboardData && e.clipboardData.files) || [])][0]; if (f && /^(image|video)\//.test(f.type)) { e.preventDefault(); take(f); } });
    drawMed();

    // Buttons
    const drawBtns = () => { $('#cBtns').innerHTML = btnRows(COMP.btns); $('#cAddB').hidden = COMP.btns.length >= 6; pv(); };
    $('#cBtns').oninput = (e) => { const t = e.target; if (t.dataset.bl != null) COMP.btns[t.dataset.bl].label = t.value; if (t.dataset.bu != null) COMP.btns[t.dataset.bu].url = t.value; pv(); };
    $('#cBtns').onclick = (e) => { const x = e.target.closest('[data-bx]'); if (x) { COMP.btns.splice(+x.dataset.bx, 1); drawBtns(); } };
    $('#cAddB').onclick = () => { if (COMP.btns.length >= 6) return; COMP.btns.push({ label: '', url: '' }); drawBtns(); const i = $$('#cBtns [data-bl]').pop(); if (i) i.focus(); };
    drawBtns(); cnt();

    // Send
    const showErr = (m) => { const e = $('#cErr'); e.textContent = m; e.hidden = !m; if (m) e.scrollIntoView({ block: 'center', behavior: 'smooth' }); };
    const payload = () => {
      const c = conn();
      const body = { connection_id: c.id, body: txt.value, media_id: COMP.media ? COMP.media.id : null, buttons: cleanButtons(COMP.btns) };
      if (isBot(c)) { body.include_stop = COMP.stop; if (COMP.seg) body.segment_id = +COMP.seg; }
      return body;
    };
    const validate = () => {
      if (!txt.value.trim()) return 'Write a message first.';
      const lim = hasMedia() ? 1024 : 4096;
      if (visibleLength(txt.value) > lim) return hasMedia() ? 'With a photo or video, Telegram allows 1,024 characters. Shorten the message or remove the file.' : 'Telegram allows 4,096 characters per message. Shorten it to send.';
      return checkButtons(COMP.btns);
    };
    const reset = () => { COMP.text = ''; COMP.media = null; COMP.btns = []; COMP.when = 'now'; store.set('cv_draft', null); txt.value = ''; drawMed(); drawBtns(); drawWhen(); cnt(); pv(); };
    const submit = async (asDraft, btn) => {
      showErr('');
      const v = validate(); if (v) { showErr(v); return; }
      const body = payload();
      if (asDraft) body.draft = true;
      else {
        body.send_mode = COMP.when;
        if (COMP.when === 'at') {
          const d = new Date($('#cDate').value);
          if (!$('#cDate').value || Number.isNaN(d.getTime())) { showErr('Pick a date and time to send.'); return; }
          if (d.getTime() < Date.now() - 60000) { showErr('That time has already passed. Pick a time in the future.'); return; }
          body.send_at = d.toISOString();
        }
        if (COMP.when === 'now' && !approval) {
          const c = conn();
          const who = isBot(c) ? (est ? plural(est.audience, 'person', 'people') : 'your subscribers') : 'everyone in ' + connName(c);
          if (!(await confirmBox('Send it now?', 'Your message goes to ' + esc(who) + ' straight away.', 'Send now'))) return;
        }
      }
      btnBusy(btn, true, asDraft ? 'Saving…' : 'Sending…');
      try {
        const r = await POST('/api/broadcasts', body);
        btnBusy(btn, false);
        reset();
        if (r.status === 'draft') toast('Saved as a draft.');
        else if (r.status === 'pending_approval') toast('Sent to the owner for approval.');
        else if (r.status === 'scheduled') toast('Scheduled for ' + fmtDate(body.send_at) + '.');
        else if (body.send_mode === 'local9') toast('Scheduled for the next 9am in your workspace time zone.');
        else if (r.status === 'sent' && !r.queued) toast('Nobody matched this audience yet, so nothing was sent.', { kind: 'info' });
        else sendProgress(r.id, r.queued);
        refreshState(); loadHist();
      } catch (e) { btnBusy(btn, false); showErr(e.message); apiErr(e, { silent: true }); }
    };
    $('#cSend').onclick = (e) => submit(false, e.currentTarget);
    $('#cDraft').onclick = (e) => submit(true, e.currentTarget);
    $('#cTest').onclick = async (e) => {
      const v = validate(); if (v) { showErr(v); return; }
      showErr('');
      const b = e.currentTarget; btnBusy(b, true, 'Sending test…');
      try { await POST('/api/broadcasts/test', payload()); toast('Test sent. Check your Telegram.'); } catch (ex) { showErr(ex.message); apiErr(ex, { silent: true }); }
      btnBusy(b, false);
    };

    // History
    const loadHist = async () => {
      try {
        const r = await GET('/api/broadcasts');
        if (!alive()) return;
        const rows = r.broadcasts || [];
        $('#cHT').innerHTML = rows.length ? '<div class="tw">' + castTable(rows) + '</div>' : emptyBox({ plain: 1, emoji: '📭', title: 'No messages yet', text: 'Messages you send, schedule or save appear here.' });
        if (rows.some((x) => x.status === 'sending' && x.send_mode !== 'local9')) later(5000, loadHist);
      } catch (e) { if (alive()) $('#cHT').innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; }
    };
    wireCastTable($('#cHT'), loadHist);
    $('#cHR').onclick = loadHist;
    drawAudience();
    loadHist();
  },
};

/* ---------- Calendar ---------- */
let CAL = null;
PAGES.calendar = {
  title: 'Calendar', sub: 'What goes out and when',
  async render(el, q, alive) {
    el.innerHTML = skel(1, 420);
    const r = await GET('/api/broadcasts');
    if (!alive()) return;
    // "9am local time" broadcasts have no send_at; they show at their next (or first) 9am delivery, not at the time they were made.
    const when = (b) => (b.status === 'scheduled' || (b.status === 'pending_approval' && b.send_at) ? b.send_at : b.send_mode === 'local9' && (b.next_due || b.first_due) ? (b.next_due || b.first_due) : (b.started_at || b.created_at));
    const items = (r.broadcasts || []).filter((b) => b.status !== 'draft' && b.status !== 'cancelled').map((b) => ({ b, at: new Date(when(b)) })).filter((x) => !Number.isNaN(x.at.getTime()));
    if (!CAL) { const n = new Date(); CAL = new Date(n.getFullYear(), n.getMonth(), 1); }
    const draw = () => {
      const y = CAL.getFullYear(), m = CAL.getMonth();
      const first = new Date(y, m, 1), days = new Date(y, m + 1, 0).getDate();
      const lead = (first.getDay() + 6) % 7; // Monday first
      const today = new Date();
      let cells = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => '<div class="dh">' + d + '</div>').join('');
      for (let i = 0; i < lead; i++) cells += '<div class="cd mute"></div>';
      for (let d = 1; d <= days; d++) {
        const ev = items.filter((x) => x.at.getFullYear() === y && x.at.getMonth() === m && x.at.getDate() === d).sort((a, b) => a.at - b.at);
        const isT = today.getFullYear() === y && today.getMonth() === m && today.getDate() === d;
        cells += '<div class="cd' + (isT ? ' today' : '') + '"><span>' + d + '</span>' + ev.slice(0, 3).map((x) => '<button type="button" class="ev ' + (x.b.status === 'sent' ? 'd' : x.b.status === 'scheduled' ? 'b' : 'w') + '" data-report="' + x.b.id + '" title="' + esc(x.b.title) + '">' + esc(x.at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ' ' + x.b.title) + '</button>').join('') + (ev.length > 3 ? '<small class="more">+' + (ev.length - 3) + ' more</small>' : '') + '</div>';
      }
      const tail = (7 - ((lead + days) % 7)) % 7;
      for (let i = 0; i < tail; i++) cells += '<div class="cd mute"></div>';
      const upcoming = items.filter((x) => x.at > new Date() && (['scheduled', 'pending_approval'].includes(x.b.status) || (x.b.status === 'sending' && x.b.send_mode === 'local9'))).sort((a, b) => a.at - b.at).slice(0, 8);
      el.innerHTML = '<div class="box"><div class="bh"><div class="calnav"><button type="button" class="ib" data-cm="-1" aria-label="Previous month">' + icon('chev').replace('<svg', '<svg style="transform:rotate(180deg)"') + '</button><h3>' + first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) + '</h3><button type="button" class="ib" data-cm="1" aria-label="Next month">' + icon('chev') + '</button></div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="pill p-blue">Scheduled</span><span class="pill p-ok">Sent</span><span class="pill p-tg">Waiting</span><button type="button" class="btn b-blue xs" data-go="broadcast">' + icon('plus') + 'Schedule</button></div></div><div class="calg">' + cells + '</div></div>' +
        '<div class="box"><div class="bh"><h3>Coming up</h3></div>' + (upcoming.length ? upcoming.map((x) => '<button type="button" class="upr tlink" data-report="' + x.b.id + '"><span style="min-width:0;text-align:left"><b class="ell">' + esc(x.b.title) + '</b><small class="muted">' + fmtDate(x.at) + ' · ' + esc(x.b.kind === 'bot' ? '@' + (x.b.conn_username || '') : x.b.conn_title || '') + '</small></span>' + bPill(x.b.status) + '</button>').join('') : emptyBox({ plain: 1, emoji: '🗓️', title: 'Nothing scheduled', text: 'Schedule a message and it shows up here and on the calendar.', action: '<button type="button" class="btn b-blue sm" data-go="broadcast">Schedule a message</button>' })) + '<p class="hint">Auto follow-ups send by themselves when people join, so they are not shown on the calendar.</p></div>';
    };
    draw();
    el.onclick = (e) => {
      const c = e.target.closest('[data-cm]'); if (c) { CAL = new Date(CAL.getFullYear(), CAL.getMonth() + +c.dataset.cm, 1); draw(); return; }
      const rp = e.target.closest('[data-report]'); if (rp) openReport(+rp.dataset.report);
    };
  },
};

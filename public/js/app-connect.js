'use strict';
/*
 * app-connect.js: "Channels & bots" page, the connect wizard, Telegram account linking and start links.
 * API: GET/DELETE /api/connections, POST /api/connections/bot, POST /api/connections/request,
 *      POST /api/me/telegram-link, GET/POST/DELETE /api/connections/:id/start-links
 */

const KIND_TXT = {
  channel: ['A channel', 'Post updates to everyone who follows you. Great for news, offers and daily posts.', 'Most popular'],
  group: ['A group', 'Send messages into a group chat where your members talk.', ''],
  bot: ['A bot', 'Message people one-to-one and run auto follow-ups when they start it.', 'Best for follow-ups'],
};

function fixText(err) {
  const e = String(err || '');
  if (/unauthorized|401|token/i.test(e)) return 'The bot token stopped working (it may have been changed in @BotFather). Remove this bot and connect it again with the new token.';
  if (/kicked|not a member|chat not found|rights|administrator|403/i.test(e)) return 'Castvoo lost access to this chat. Add @' + esc(platformBot()) + ' as an admin again, with the "Post messages" right.';
  if (/webhook/i.test(e)) return 'Telegram could not reach Castvoo. Remove the bot and connect it again. If it keeps happening, chat with us.';
  return 'Try removing it and connecting it again. If it keeps happening, chat with us from the Help page.';
}

/* ---------- Link the user's Telegram account (needed for channels, groups and test messages) ---------- */
function linkTelegram(onLinked) {
  if (!CFG.bot_username) { toast('Telegram linking is being switched on. Please check back soon.', { kind: 'info' }); return; }
  const h = sheet('Link your Telegram', '<svg width="36" height="36" style="flex:none"><use href="#i-tg"/></svg>',
    '<p class="muted" style="font-size:15px;margin-top:-6px">So Castvoo knows which channels and groups are yours, and can send you test messages.</p>' +
    '<div class="cst"><div class="cs"><span class="n">1</span><span class="tx"><b>Tap "Open Telegram"</b><small>It opens @' + esc(CFG.bot_username) + '.</small></span></div><div class="cs"><span class="n">2</span><span class="tx"><b>Tap Start</b><small>That\'s it. Come back here, it updates by itself.</small></span></div></div>' +
    '<div id="lkBox">' + loadingBox('Getting your link…') + '</div>');
  let stop = false; onModalClose = () => { stop = true; };
  POST('/api/me/telegram-link').then((r) => {
    if (stop || !$('#lkBox')) return;
    $('#lkBox').innerHTML = '<a class="btn b-blue full" id="lkGo" href="' + esc(r.url) + '" target="_blank" rel="noopener">' + icon('tg') + 'Open Telegram</a><div id="lkWait"></div>';
    $('#lkGo').onclick = () => {
      $('#lkWait').innerHTML = '<div class="wait" style="margin-top:12px"><span class="rad"><i></i><i></i><svg><use href="#i-tg"/></svg></span><span><b>Waiting for you to tap Start…</b><br><small class="muted">This updates by itself.</small></span></div>';
    };
    const t0 = Date.now();
    const poll = async () => {
      if (stop) return;
      try {
        const me = await GET('/api/me');
        if (me.user && me.user.tg_linked) {
          ME = me; stop = true; onModalClose = null; closeModal();
          toast('Telegram linked' + (me.user.tg_username ? ' as @' + me.user.tg_username : '') + '.'); confetti();
          if (onLinked) onLinked();
          return;
        }
      } catch (_) { /* keep trying */ }
      if (Date.now() - t0 < 15 * 60000) setTimeout(poll, 3000);
      else if ($('#lkWait')) $('#lkWait').innerHTML = '<p class="ferr">The link expired. Close this and try again.</p>';
    };
    setTimeout(poll, 3000);
  }).catch((e) => { if ($('#lkBox')) $('#lkBox').innerHTML = '<p class="ferr">' + esc(e.message) + '</p>'; });
}

/* ---------- Connect wizard ---------- */
/* openConnect('' | 'channel' | 'group' | 'bot', { onConnected(conn) }) */
function openConnect(type, opts = {}) {
  if (!APP.state) { refreshState().then((st) => { if (st) openConnect(type, opts); else toast('Please try again in a moment.', { kind: 'err' }); }); return; }
  if (!type) {
    const h = sheet('Connect Telegram', '<svg width="36" height="36" style="flex:none"><use href="#i-tg"/></svg>',
      '<p class="muted" style="font-size:15px;margin-top:-6px">What should Castvoo send messages to?</p><div class="ckl">' +
      ['channel', 'group', 'bot'].map((t) => { const k = KIND[t], x = KIND_TXT[t]; return '<button type="button" class="ckc" style="--c:' + k.c + '" data-t="' + t + '"><span class="ci" style="background:' + k.b + '">' + k.e + '<span class="tb"><svg><use href="#i-tg"/></svg></span></span><span class="ct"><b>' + x[0] + (x[2] ? ' <span class="pill" style="background:' + k.b + ';color:' + k.c + '">' + x[2] + '</span>' : '') + '</b><small>' + x[1] + '</small></span><svg class="chv"><use href="#i-chev"/></svg></button>'; }).join('') +
      '</div><div class="helpline"><div class="ca" data-cas="happy"></div><span><b style="color:var(--ink)">Not sure?</b> Most people start with their channel. You can add more any time.</span></div><button type="button" class="btn b-ghost full" id="cgW">' + icon('play') + 'Watch the 40-second guide</button>');
    $('.ckl', h).onclick = (e) => { const b = e.target.closest('[data-t]'); if (b) openConnect(b.dataset.t, opts); };
    $('#cgW', h).onclick = () => openGuide(0, () => openConnect('', opts));
    return;
  }
  const k = KIND[type];
  const ic = '<span class="ci" style="width:44px;height:44px;border-radius:14px;background:' + k.b + ';display:grid;place-items:center;font-size:21px;flex:none">' + k.e + '</span>';
  const back = '<div class="row2b"><button type="button" class="btn b-ghost sm" data-cback>' + icon('chev').replace('<svg', '<svg style="transform:rotate(180deg)"') + 'Back</button><button type="button" class="btn b-ghost sm" data-cwatch>' + icon('play') + 'Show me how</button></div>';
  const wireBack = (h, ch) => { $('[data-cback]', h).onclick = () => openConnect('', opts); $('[data-cwatch]', h).onclick = () => openGuide(ch, () => openConnect(type, opts)); };
  if (!isOwner()) { sheet('Add a ' + type, ic, '<div class="note2"><span>🔒</span><span>Only the workspace owner can connect bots, channels and groups.</span></div>'); return; }

  if (type === 'bot') {
    const h = sheet('Add a bot', ic, '<div class="cst" style="--c:' + k.c + '">' +
      '<div class="cs" style="--c:' + k.c + '"><span class="n">1</span><span class="tx"><b>Open @BotFather in Telegram</b><small>Send this to create a bot (or pick one you already have with /mybots):</small><div class="codebox"><span>/newbot</span><button type="button" class="btn b-blue xs" data-copy="/newbot" data-msg="/newbot copied">' + icon('copy') + 'Copy</button></div><a class="btn b-ghost xs" href="https://t.me/BotFather" target="_blank" rel="noopener" style="align-self:flex-start">' + icon('tg') + 'Open @BotFather</a></span></div>' +
      '<div class="cs" style="--c:' + k.c + '"><span class="n">2</span><span class="tx"><b>Copy the token it gives you</b><small>It looks like 123456789:AAH… Keep it private.</small></span></div>' +
      '<div class="cs" style="--c:' + k.c + '"><span class="n">3</span><span class="tx"><b>Paste the token here</b><small>Castvoo checks it with Telegram in seconds.</small></span></div></div>' +
      '<form id="cnF" novalidate class="su-pick"><div class="field"><label for="cnT">Bot token</label><input class="inp mono" id="cnT" placeholder="123456789:AAH…" autocomplete="off" spellcheck="false" style="font-size:14px"></div>' +
      '<div class="note2"><span>ℹ️</span><span>If this bot already runs another service, connecting it here takes over its updates. Bot already here but shows "Needs attention"? Paste its new token: subscribers and follow-ups are kept.</span></div>' +
      '<p class="ferr" id="cnE" hidden></p><button type="submit" class="btn b-blue full" id="cnGo">Connect bot</button></form>' + back);
    wireBack(h, 0);
    $('#cnF', h).onsubmit = async (e) => {
      e.preventDefault();
      const v = $('#cnT', h).value.trim(), err = $('#cnE', h);
      if (!/^\d{5,}:[\w-]{20,}$/.test(v)) { err.textContent = 'That doesn\'t look like a bot token. It looks like 123456789:AAH… Copy it again from @BotFather.'; err.hidden = false; return; }
      err.hidden = true; const b = $('#cnGo', h); btnBusy(b, true, 'Checking your bot with Telegram…');
      try { const r = await POST('/api/connections/bot', { token: v }); connected({ ...r.connection, kind: 'bot' }, opts); }
      catch (ex) { btnBusy(b, false); err.textContent = ex.message; err.hidden = false; apiErr(ex, { silent: true }); }
    };
    setTimeout(() => { const t = $('#cnT'); if (t) t.focus(); }, 80);
    return;
  }

  // Channel or group: one tap through @CastvooBot.
  const word = type;
  if (!CFG.bot_username) { const h = sheet('Add a ' + word, ic, '<div class="note2"><span>🔧</span><span>Channel and group connections are being switched on. Please check back soon. You can connect a bot right now.</span></div><button type="button" class="btn b-blue full" data-cbot>Connect a bot instead</button>' + back); wireBack(h, 3); $('[data-cbot]', h).onclick = () => openConnect('bot', opts); return; }
  if (!ME.user.tg_linked) {
    const h = sheet('Add a ' + word, ic, '<div class="stepdots"><i class="on"></i><i></i></div><div class="onetap"><b style="font-size:16px">First, link your Telegram</b><small>Castvoo needs to know the ' + word + ' is yours. It takes one tap.</small><button type="button" class="btn b-blue full" id="cnLk">' + icon('tg') + 'Link my Telegram</button></div>' + back);
    wireBack(h, 3);
    $('#cnLk', h).onclick = () => linkTelegram(() => openConnect(type, opts));
    return;
  }
  const h = sheet('Add a ' + word, ic, '<div class="stepdots"><i></i><i class="on"></i></div>' +
    '<div class="onetap"><div id="cnReq">' + loadingBox('Preparing Telegram…') + '</div><small>Telegram opens with @' + esc(CFG.bot_username) + ' ready. Pick your ' + word + ' and confirm. Castvoo connects it by itself.</small></div>' +
    '<div id="cnSt"></div>' +
    '<details class="man"><summary>Prefer to do it by hand?</summary><div class="cst">' +
      '<div class="cs"><span class="n">1</span><span class="tx"><b>Open your ' + word + ' in Telegram</b><small>Tap its name, then ' + (word === 'channel' ? '<b>Administrators</b>' : '<b>Add members</b>') + '.</small></span></div>' +
      '<div class="cs"><span class="n">2</span><span class="tx"><b>Add our bot ' + (word === 'channel' ? 'as an admin' : '') + '</b><small>Search for:</small><div class="codebox"><span>@' + esc(CFG.bot_username) + '</span><button type="button" class="btn b-blue xs" data-copy="@' + esc(CFG.bot_username) + '" data-msg="Copied">' + icon('copy') + 'Copy</button></div></span></div>' +
      '<div class="cs"><span class="n">3</span><span class="tx"><b>' + (word === 'channel' ? 'Switch on "Post messages"' : 'Make it an admin') + '</b><small>' + (word === 'channel' ? 'Castvoo needs it to post for you.' : 'Needed to pin and delete messages.') + ' Then come back here. It connects by itself within a minute.</small></span></div>' +
    '</div></details>' + back);
  wireBack(h, 3);
  let stop = false; onModalClose = () => { stop = true; };
  const before = new Set(APP.state.connections.map((c) => c.id));
  POST('/api/connections/request', { kind: word }).then((r) => {
    if (stop || !$('#cnReq')) return;
    $('#cnReq').innerHTML = '<a class="btn b-blue full" id="cn1" href="' + esc(r.url) + '" target="_blank" rel="noopener">' + icon('tg') + 'Add @' + esc(r.bot || CFG.bot_username) + ' to my ' + word + '</a>';
    const startWatch = () => {
      $('#cnSt').innerHTML = '<div class="wait"><span class="rad"><i></i><i></i><svg><use href="#i-tg"/></svg></span><span><b>Looking for your ' + word + '…</b><br><small class="muted">Finish in Telegram. This updates by itself.</small></span></div>';
    };
    $('#cn1').onclick = startWatch;
    const t0 = Date.now();
    const poll = async () => {
      if (stop) return;
      try {
        const d = await GET('/api/connections');
        const fresh = d.connections.find((c) => !before.has(c.id) && c.kind === word);
        if (fresh) { stop = true; onModalClose = null; await refreshState(); connected(fresh, opts); return; }
      } catch (_) { /* keep trying */ }
      if (Date.now() - t0 < 120000) setTimeout(poll, 3000);
      else if ($('#cnSt')) $('#cnSt').innerHTML = '<div class="note2"><span>⏳</span><span>We haven\'t seen it yet. Make sure you picked the ' + word + ' and confirmed in Telegram, then <a href="#" data-cretry>check again</a>.</span></div>';
    };
    setTimeout(poll, 3000);
    $('#cnSt').addEventListener('click', (e) => { if (e.target.closest('[data-cretry]')) { e.preventDefault(); openConnect(type, opts); } });
  }).catch((e) => { if ($('#cnReq')) $('#cnReq').innerHTML = '<p class="ferr">' + esc(e.message) + '</p>'; });
}

async function connected(c, opts = {}) {
  await refreshState();
  const conn = (APP.state && APP.state.connections.find((x) => x.id === c.id)) || c;
  confetti();
  const k = KIND[conn.kind] || KIND.bot;
  const h = sheet('Connected!', '<span class="spk" style="background:var(--ok)">' + icon('check') + '</span>',
    '<div class="succ" style="padding:0"><div style="width:120px" data-cas="happy"></div></div><div class="okc">' + kIcon(conn.kind) + '<div style="min-width:0;flex:1"><b style="font-size:16px;display:block" class="ell">' + esc(connName(conn)) + '</b><small class="muted">Telegram ' + k.n.toLowerCase() + (conn.member_count != null && conn.kind !== 'bot' ? ' · ' + fmt(conn.member_count) + ' ' + k.w : '') + '</small></div><span class="pill p-ok"><span class="dl"></span>Live</span></div>' +
    '<p class="muted" style="font-size:14.5px;text-align:center">' + (conn.kind === 'bot' ? 'Share t.me/' + esc(conn.username || '') + ' so people can start it. Switch on a welcome follow-up so each one is greeted.' : 'You can now send messages to this ' + conn.kind + ' from Castvoo.') + '</p>' +
    (opts.onConnected ? '<button type="button" class="btn b-blue full" id="okN">Continue' + icon('arrow') + '</button>' : '<button type="button" class="btn b-blue full" id="okS">' + icon('send') + 'Send your first message</button>' + (conn.kind === 'bot' ? '<button type="button" class="btn b-ghost full" id="okD">' + icon('drip') + 'Switch on a welcome follow-up</button>' : '') + '<button type="button" class="btn b-ghost full" id="okA">' + icon('plus') + 'Connect another</button>'));
  if (opts.onConnected) { $('#okN', h).onclick = () => { closeModal(); opts.onConnected(conn); }; return; }
  $('#okS', h).onclick = () => { closeModal(); COMP.conn = conn.id; appGo('broadcast'); };
  const d = $('#okD', h); if (d) d.onclick = () => { closeModal(); appGo('drips', { new: '1' }); };
  $('#okA', h).onclick = () => openConnect('');
  if (!$('#v-app').hidden && (APP.page === 'bots' || APP.page === 'overview')) renderPage(APP.page, APP.q);
}

/* ---------- Channels & bots page ---------- */
PAGES.bots = {
  title: 'Channels & bots', sub: 'Your Telegram connections',
  async render(el, q, alive) {
    el.innerHTML = skel(1, 120) + '<div class="dg"><div class="c4">' + skel(1, 220) + '</div><div class="c4">' + skel(1, 220) + '</div><div class="c4">' + skel(1, 220) + '</div></div>';
    const d = await GET('/api/connections');
    if (!alive()) return;
    const p = APP.state.plan;
    const owner = isOwner();
    el.innerHTML = '<div class="addrow">' + ['channel', 'group', 'bot'].map((t) => { const k = KIND[t]; return '<button type="button" class="addc" style="--c:' + k.c + '" data-connect="' + t + '"><span class="ci" style="background:' + k.b + '">' + k.e + '<span class="tb"><svg><use href="#i-tg"/></svg></span></span><b>Add a ' + t + '</b><small>' + KIND_TXT[t][1] + '</small><span class="go">Connect →</span></button>'; }).join('') + '</div>' +
      '<div class="insight"><svg width="44" height="44" style="flex:none"><use href="#i-tg"/></svg><p style="flex:1"><b>New here?</b> Watch the 40-second guide: from @BotFather to a connected bot and channel.</p><button type="button" class="btn b-blue sm" data-guide>' + icon('play') + 'Play guide</button></div>' +
      (!d.tg_linked && CFG.bot_username ? '<div class="note2"><span>' + icon('tg') + '</span><span style="flex:1"><b>Link your Telegram</b> to add channels and groups in one tap and get test messages.</span><button type="button" class="btn b-ghost xs" id="bLk">Link Telegram</button></div>' : '') +
      '<div class="bh"><h3 style="font-size:18px">Connected</h3><span class="hint">' + fmt(p.usage.connections) + ' of ' + fmt(p.limits.connections) + ' on your ' + esc(p.plan_name) + ' plan</span></div>' +
      (d.connections.length ? '<div class="dg">' + d.connections.map((c) => {
        const ok = c.status === 'active';
        const deliv = c.sent_30d + c.failed_30d ? Math.round(c.sent_30d / (c.sent_30d + c.failed_30d) * 1000) / 10 : null;
        return '<div class="box c4 connb"><div class="cbh">' + kIcon(c.kind) + '<div style="min-width:0;flex:1"><b class="ell" style="display:block">' + esc(connName(c)) + '</b><small class="muted">Telegram ' + (KIND[c.kind] || KIND.bot).n.toLowerCase() + ' · added ' + fmtDate(c.created_at, false) + '</small></div>' + (ok ? '<span class="pill p-ok"><span class="dl"></span>Working</span>' : '<span class="pill p-bad">Needs attention</span>') + '</div>' +
          '<div class="cstats"><div><small>' + (c.kind === 'bot' ? 'Can reach' : 'Members') + '</small><b class="tnum">' + (c.reach != null ? fmt(c.reach) : '—') + '</b></div><div><small>Sent · 30 days</small><b class="tnum">' + fmt(c.sent_30d) + '</b></div><div><small>Delivered</small><b class="tnum">' + (deliv == null ? '—' : deliv + '%') + '</b></div></div>' +
          (c.kind === 'bot' ? '<small class="muted">' + (c.blocked ? plural(c.blocked, 'person', 'people') + ' blocked the bot and were removed for you' : 'Nobody has blocked this bot') + (c.failed_30d ? ' · ' + fmt(c.failed_30d) + ' not delivered' : '') + '</small>' : '<small class="muted">' + (c.kind === 'channel' ? 'Posts are made by @' + esc(d.platform_bot || platformBot()) + ' as a channel admin.' : 'Messages are sent by @' + esc(d.platform_bot || platformBot()) + ' in the group.') + '</small>') +
          (c.last_error ? '<div class="errbox sm">' + icon('stop') + '<span><b>' + esc(c.last_error) + '</b><br>' + fixText(c.last_error) + '</span></div>' : '') +
          '<div class="cact">' + (c.kind === 'bot' ? '<a class="btn b-ghost xs" href="https://t.me/' + esc(c.username) + '" target="_blank" rel="noopener">' + icon('ext') + 'Open</a><button type="button" class="btn b-ghost xs" data-copy="https://t.me/' + esc(c.username) + '" data-msg="Bot link copied">' + icon('copy') + 'Copy link</button>' : '') + (ok ? '<button type="button" class="btn b-ghost xs" data-go="broadcast" data-q="conn=' + c.id + '">' + icon('send') + 'Send</button>' : '') + (owner ? '<button type="button" class="btn b-ghost xs danger" data-rm="' + c.id + '">' + icon('trash') + 'Remove</button>' : '') + '</div></div>';
      }).join('') + '</div>' : emptyBox({ cas: 'wave', title: 'Nothing connected yet', text: 'Pick a channel, group or bot above. It takes about a minute.' })) +
      '<div id="slWrap"></div>';
    const lk = $('#bLk'); if (lk) lk.onclick = () => linkTelegram(() => renderPage('bots', {}));
    el.addEventListener('click', async (e) => {
      const rm = e.target.closest('[data-rm]'); if (!rm) return;
      const c = d.connections.find((x) => x.id === +rm.dataset.rm);
      if (!(await confirmBox('Remove ' + connName(c) + '?', c.kind === 'bot' ? 'Castvoo stops sending from this bot and its follow-ups stop. Its subscriber list stays until you delete your data.' : 'Castvoo stops posting here. You can connect it again later.', 'Remove', true))) return;
      try { await api('DELETE', '/api/connections/' + c.id); toast('Removed.'); await refreshState(); renderPage('bots', {}); } catch (ex) { apiErr(ex); }
    });
    const bots = d.connections.filter((c) => c.kind === 'bot');
    if (bots.length && CFG.features.start_links !== false) startLinks($('#slWrap'), bots, alive);
  },
};

/* Start links: t.me/<bot>?start=<tag> so you know which ad brought each subscriber. */
async function startLinks(host, bots, alive, selId) {
  const bot = bots.find((b) => b.id === selId) || bots[0];
  host.innerHTML = '<div class="box"><div class="bh"><h3>🔗 Start links for your ads and posts</h3>' + (bots.length > 1 ? '<select class="inp sm" id="slBot" aria-label="Bot">' + bots.map((b) => '<option value="' + b.id + '"' + (b.id === bot.id ? ' selected' : '') + '>@' + esc(b.username) + '</option>').join('') + '</select>' : '<span class="pill p-blue">@' + esc(bot.username) + '</span>') + '</div><p class="muted" style="font-size:14px;max-width:70ch">Put a different link in each ad or post. Everyone who starts your bot through it is tagged with that name, so you can see what works and send to them later.</p><div class="slnew"><input class="inp" id="slN" maxlength="64" placeholder="Name it, like tiktok_ad5" aria-label="Start link name"><button type="button" class="btn b-blue sm" id="slAdd">' + icon('plus') + 'Create link</button></div><p class="ferr" id="slE" hidden></p><div id="slL">' + skel(2, 44) + '</div></div>';
  const sel = $('#slBot'); if (sel) sel.onchange = () => startLinks(host, bots, alive, +sel.value);
  const load = async () => {
    let d;
    try { d = await GET('/api/connections/' + bot.id + '/start-links'); } catch (e) { $('#slL').innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; return; }
    if (!alive()) return;
    $('#slL').innerHTML = (d.links.length ? d.links.map((l) => '<div class="slrow"><span style="min-width:0"><b>' + esc(l.tag) + '</b><code>' + esc(l.url.replace(/^https:\/\//, '')) + '</code></span><span class="tags2"><span class="pill p-grey">tag: ' + esc(l.tag) + '</span></span><span><b class="tnum">' + fmt(l.starts) + '</b> <small>starts</small></span><span class="slact"><button type="button" class="btn b-ghost xs" data-copy="' + esc(l.url) + '" data-msg="Start link copied">' + icon('copy') + 'Copy</button><button type="button" class="x" data-sld="' + esc(l.tag) + '" aria-label="Delete ' + esc(l.tag) + '"><svg width="14" height="14"><use href="#i-trash"/></svg></button></span></div>').join('') : '<p class="muted" style="font-size:14px;padding:6px 0">No start links yet. Create one above for your next ad.</p>') +
      (d.untracked && d.untracked.length ? '<p class="hint" style="margin-top:8px">Also seen: ' + d.untracked.map((u) => esc(u.tag) + ' (' + fmt(u.starts) + ')').join(', ') + '</p>' : '');
  };
  $('#slAdd').onclick = async (e) => {
    const v = $('#slN').value.trim().replace(/\s+/g, '_'), err = $('#slE');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(v)) { err.textContent = 'Use only letters, numbers, _ and - (no spaces), like meta_ad14.'; err.hidden = false; return; }
    err.hidden = true; btnBusy(e.currentTarget, true, 'Creating…');
    try { const r = await POST('/api/connections/' + bot.id + '/start-links', { tag: v }); $('#slN').value = ''; copyText(r.url, 'Start link created and copied'); await load(); } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    btnBusy(e.currentTarget, false);
  };
  $('#slL').onclick = async (e) => {
    const d = e.target.closest('[data-sld]'); if (!d) return;
    if (!(await confirmBox('Delete this start link?', 'The link keeps working in old ads, but it won\'t be listed here. People already tagged keep their tag.', 'Delete', true))) return;
    try { await api('DELETE', '/api/connections/' + bot.id + '/start-links/' + encodeURIComponent(d.dataset.sld)); load(); } catch (ex) { apiErr(ex); }
  };
  load();
}

'use strict';
/* app-home.js: the dashboard home page (#app). Every number comes from GET /api/app/state. */

function planBanner(p) {
  if (!p) return '';
  const days = p.trial_ends_at ? Math.max(0, Math.ceil((new Date(p.trial_ends_at) - Date.now()) / 86400000)) : 0;
  if (p.status === 'trial') {
    const next = p.pending_plan_code ? ((p.plans || []).find((x) => x.code === p.pending_plan_code) || {}).name : null;
    return '<div class="pban info"><span class="pbi">🎁</span><div style="flex:1;min-width:0"><b>Free trial · ' + (days ? plural(days, 'day') + ' left' : 'ends today') + '</b><p>' + (next ? esc(next) + ' starts when the trial ends, paid from your wallet.' : 'Pick the plan you want after the trial. It is paid from your wallet.') + '</p></div><button type="button" class="btn b-blue xs" data-go="wallet">' + (next ? 'See plan' : 'Choose a plan') + '</button></div>';
  }
  if (p.status === 'paused') return '<div class="pban bad"><span class="pbi">⏸️</span><div style="flex:1;min-width:0"><b>Sending is paused</b><p>Top up your wallet and your plan restarts by itself. Nothing was deleted.</p></div><button type="button" class="btn b-blue xs" data-topup>Top up to restart</button></div>';
  if (p.status === 'cancelled') return '<div class="pban bad"><span class="pbi">⏹️</span><div style="flex:1;min-width:0"><b>No active plan</b><p>Choose a plan to start sending again. Your data is kept for a while after a plan ends.</p></div><button type="button" class="btn b-blue xs" data-go="wallet">Choose a plan</button></div>';
  if (p.cancel_at_period_end && p.period_end) return '<div class="pban warn"><span class="pbi">📅</span><div style="flex:1;min-width:0"><b>' + esc(p.plan_name) + ' ends on ' + fmtDate(p.period_end, false) + '</b><p>Changed your mind? Keep your plan running.</p></div><button type="button" class="btn b-blue xs" data-go="wallet">Manage plan</button></div>';
  return '';
}

function connStrip(conns) {
  return '<div class="box" style="gap:12px"><div class="bh"><h3>' + icon('tg') + 'Your Telegram</h3><button type="button" class="btn b-ghost xs" data-go="bots">Manage</button></div><div class="conns">' +
    conns.map((c) => '<button type="button" class="cnc" data-go="bots">' + kIcon(c.kind) + '<span style="text-align:left"><b>' + esc(connName(c)) + '</b><small>' + (KIND[c.kind] || KIND.bot).n + (c.kind !== 'bot' && c.member_count != null ? ' · ' + fmt(c.member_count) + ' ' + KIND[c.kind].w : '') + (c.status !== 'active' ? ' · <span style="color:var(--bad)">needs attention</span>' : '') + '</small></span></button>').join('') +
    '<button type="button" class="cnadd" data-connect><span class="p"><svg><use href="#i-plus"/></svg></span>Add channel, group or bot</button></div></div>';
}

function kpiChange(now, prev) {
  if (!now && !prev) return '<span class="d mu">No messages yet</span>';
  if (!prev) return '<span class="d">New this period</span>';
  const pct = Math.round((now - prev) / prev * 100);
  return '<span class="d' + (pct < 0 ? ' dn' : '') + '">' + (pct >= 0 ? '↑ ' : '↓ ') + Math.abs(pct) + '% vs the 14 days before</span>';
}

function activityRow(a) {
  const when = ago(a.at);
  if (a.kind === 'start') return '<div class="fi"><span class="bdg">' + ava(a.who || 'Someone', 38) + '<i>' + icon('tg') + '</i></span><p><b>' + esc(a.who || 'Someone') + '</b> joined ' + esc(a.place || 'your Telegram') + '<small>' + (a.detail ? 'From start link ' + esc(a.detail) + ' · ' : '') + when + '</small></p></div>';
  if (a.kind === 'click') return '<div class="fi"><span class="bdg">' + ava(a.who || 'Someone', 38) + '<i>🔘</i></span><p><b>' + esc(a.who || 'Someone') + '</b> tapped "' + esc(a.detail) + '"<small>Tracked click · ' + when + '</small></p></div>';
  return '<div class="fi"><span class="bdg"><span class="mav ini" style="width:38px;height:38px;background:var(--blue-s);color:var(--blue)">' + icon('send') + '</span></span><p>"' + esc(a.who) + '" ' + (a.detail === 'sending' ? 'is sending' : 'was sent') + '<small>Message · ' + when + '</small></p></div>';
}

function sendingBox(s) {
  const up = (APP.state.upcoming || []);
  let h = '<div class="bh"><h3>' + (s ? '<span class="dl"></span>Sending now' : 'Sending') + '</h3>' + (s ? '<span class="pill p-tg">' + icon('tg') + '~25 a second</span>' : '') + '</div>';
  if (s) {
    const p = s.total ? Math.min(1, (s.sent + s.failed) / s.total) : 0;
    h += '<div class="sendnow"><div class="ring" style="width:110px;height:110px"><svg viewBox="0 0 108 108"><defs><linearGradient id="rgl"><stop offset="0" stop-color="#6EC3FF"/><stop offset="1" stop-color="#2F6BFF"/></linearGradient></defs><circle cx="54" cy="54" r="46" fill="none" stroke="#E9EEF9" stroke-width="10"/><circle class="rv2" cx="54" cy="54" r="46" fill="none" stroke="url(#rgl)" stroke-width="10" stroke-linecap="round" stroke-dasharray="289" stroke-dashoffset="' + (289 * (1 - p)).toFixed(1) + '"/></svg><b class="tnum">' + Math.round(p * 100) + '%</b></div>' +
      '<div style="min-width:0"><b class="ell" style="font-size:15px;display:block;letter-spacing:-.02em">' + esc(s.title) + '</b><small class="muted ell" style="display:flex;align-items:center;gap:5px">' + TG + esc(s.conn || '') + '</small><div class="tnum" style="font-weight:800;margin-top:8px">' + fmt(s.sent) + ' of ' + fmt(s.total) + ' delivered</div>' + (s.failed ? '<small class="muted">' + fmt(s.failed) + ' could not be delivered</small>' : '') + '<button type="button" class="btn b-ghost xs" data-report="' + s.id + '" style="margin-top:8px">Details</button></div></div>';
  } else {
    h += '<p class="muted" style="font-size:14px">Nothing is sending right now.</p>';
  }
  h += '<div class="upc"><b style="font-size:14px">Coming up</b>' + (up.length ? up.map((r) => '<div class="upr"><span style="min-width:0"><b class="ell">' + esc(r.title) + '</b><small class="muted">' + fmtDate(r.send_at) + '</small></span>' + (r.total ? '<span class="pill p-blue">' + fmt(r.total) + '</span>' : '') + '</div>').join('') : '<p class="muted" style="font-size:13.5px">Nothing scheduled. <a href="#app/broadcast">Schedule a message</a></p>') + '</div>';
  return h;
}

PAGES.overview = {
  title: 'Home', sub: 'Your Telegram at a glance',
  async render(el, q, alive) {
    el.innerHTML = skel(1, 180) + '<div class="dg">' + '<div class="c6">' + skel(1, 220) + '</div><div class="c6">' + skel(1, 220) + '</div></div>';
    const s = await refreshState();
    if (!alive() || !s) return;
    const u = ME.user || {};
    const st = s.stats;
    const hr = new Date().getHours();
    const greet = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
    const first = (u.name || '').split(' ')[0];
    const nConn = s.connections.length;
    const line = !nConn ? 'Let\'s connect your Telegram first. It takes about a minute, and then Castvoo can start welcoming people for you.'
      : st.new_subscribers_24h ? plural(st.new_subscribers_24h, 'new subscriber') + ' in the last 24 hours' + (s.sending ? ', and a message is sending right now.' : '.')
      : s.sending ? 'A message is sending right now. You can watch it below.'
      : st.delivered_14d ? fmt(st.delivered_14d) + ' messages delivered in the last 14 days.' : 'Everything is connected. Send your first message whenever you\'re ready.';
    const done = s.checklist.filter((c) => c.done).length, pct = Math.round(done / s.checklist.length * 100);
    const aiOn = CFG.ai_available && CFG.features.ai !== false;
    const series = st.series || [];
    el.innerHTML = '<div class="box hello"><div class="mesh" style="width:360px;height:360px;right:10%;top:-60%;background:rgba(110,195,255,.5)"></div>' +
      '<div style="display:flex;flex-direction:column;gap:12px;min-width:0;padding-bottom:4px"><div class="who">' + ava(u.name || u.email || '?', 44) + '<small>' + (nConn ? '<span class="dl" style="margin-right:6px"></span>' + plural(nConn, 'Telegram connection') + ' · ' + esc(s.workspace.name) : esc(s.workspace.name)) + '</small></div>' +
      '<h2>' + greet + (first ? ', ' + esc(first) : '') + ' 👋</h2><p>' + esc(line) + '</p>' +
      (aiOn && nConn ? '<div class="qchips"><button type="button" data-go="ai" data-q="ask=' + encodeURIComponent('How did my last broadcast do?') + '">How did my last message do?</button><button type="button" data-go="ai" data-q="ask=' + encodeURIComponent('What should I send next?') + '">What should I send next?</button></div>' : '') +
      '<div class="acts">' + (nConn ? '<button type="button" class="btn b-w" data-go="broadcast">' + icon('send') + 'Send a message</button><button type="button" class="btn b-g" data-connect>' + icon('plus') + 'Connect</button>' : '<button type="button" class="btn b-w" data-connect>' + icon('plus') + 'Connect Telegram</button>') + '<button type="button" class="btn b-g" data-guide>' + icon('play') + 'Setup guide</button></div></div>' +
      '<div class="hart" data-cas="wave"></div></div>' +
      planBanner(s.plan) +
      connStrip(s.connections) +
      '<div class="dg">' +
      '<div class="box c5"><div class="bh"><h3>Launch checklist</h3><span class="pill p-blue">' + done + '/' + s.checklist.length + '</span></div><div class="chk"><div class="ring"><svg viewBox="0 0 108 108"><defs><linearGradient id="rgc"><stop offset="0" stop-color="#6EC3FF"/><stop offset="1" stop-color="#2F6BFF"/></linearGradient></defs><circle cx="54" cy="54" r="46" fill="none" stroke="#E9EEF9" stroke-width="10"/><circle class="rv2" id="ckR" cx="54" cy="54" r="46" fill="none" stroke="url(#rgc)" stroke-width="10" stroke-linecap="round" stroke-dasharray="289" stroke-dashoffset="289"/></svg><b>' + pct + '%</b></div>' +
      '<div class="cl">' + s.checklist.map((c) => { const act = c.done ? '' : c.go === 'connect' ? 'data-connect' : c.go === 'topup' ? 'data-topup' : c.go === 'ai' ? 'data-go="ai" data-q="tab=train"' : c.go === 'settings' ? 'data-go="settings" data-q="tab=team"' : c.go === 'drips' ? 'data-go="drips" data-q="new=1"' : c.go ? 'data-go="' + c.go + '"' : ''; return '<button type="button" class="cli ' + (c.done ? 'done' : '') + '" ' + act + (c.done ? ' disabled' : '') + '><span class="ck">' + (c.done ? '<svg width="12" height="12"><use href="#i-check"/></svg>' : '') + '</span><span>' + esc(c.label) + '</span>' + (c.done ? '' : '<span class="go">Start →</span>') + '</button>'; }).join('') + '</div></div></div>' +
      '<div class="c7 dg kpis">' +
      '<div class="box kpi"><div class="kh"><small>Delivered · 14 days</small><span class="ki" style="background:var(--tg-s)"><svg style="width:22px;height:22px"><use href="#i-tg"/></svg></span></div><b class="tnum" data-count="' + st.delivered_14d + '">0</b>' + kpiChange(st.delivered_14d, st.delivered_prev_14d) + spark(series.map((d) => d.sent), '#2F6BFF') + '</div>' +
      '<div class="box kpi"><div class="kh"><small>Replies · 14 days</small><span class="ki" style="background:#E6F7FF;color:#0B8CC4"><svg><use href="#i-chat"/></svg></span></div><b class="tnum" data-count="' + st.replies_14d + '">0</b><span class="d mu">Messages people sent to your bots</span></div>' +
      '<div class="box kpi"><div class="kh"><small>Button clicks · 14 days</small><span class="ki" style="background:var(--warn-s);color:var(--warn)"><svg><use href="#i-tap"/></svg></span></div><b class="tnum" data-count="' + st.clicks_14d + '">0</b><span class="d mu">Taps on your tracked links</span></div>' +
      '<div class="box kpi"><div class="kh"><small>People who clicked</small><span class="ki" style="background:var(--ok-s);color:var(--ok)"><svg><use href="#i-users"/></svg></span></div><b class="tnum" data-count="' + st.clickers_14d + '">0</b><span class="d mu">Bot subscribers, last 14 days</span></div>' +
      '<div class="box kpi"><div class="kh"><small>New subscribers · 24 h</small><span class="ki" style="background:#F1ECFF;color:#7048E8"><svg><use href="#i-plus"/></svg></span></div><b class="tnum" data-count="' + st.new_subscribers_24h + '">0</b><span class="d mu">Started a bot or joined</span></div>' +
      '<div class="box kpi"><div class="kh"><small>Subscribers you can reach</small><span class="ki" style="background:var(--blue-s);color:var(--blue)"><svg><use href="#i-seg"/></svg></span></div><b class="tnum" data-count="' + (s.plan.usage.subscribers || 0) + '">0</b><span class="d mu">of ' + fmt(s.plan.limits.subscribers) + ' on your plan</span></div>' +
      '</div>' +
      '<div class="box c8"><div class="bh"><h3>Messages delivered, last 14 days</h3><div class="legend"><span><i style="background:var(--blue)"></i>Last 14 days</span><span><i style="background:var(--sky)"></i>14 days before</span></div></div><div id="ovCh" class="chartw"></div>' + (st.delivered_14d || st.delivered_prev_14d ? '' : '<p class="hint" style="text-align:center">Your chart fills in after your first message goes out.</p>') + '</div>' +
      '<div class="box c4" id="ovSend">' + sendingBox(s.sending) + '</div>' +
      '<div class="box c5"><div class="bh"><h3>Latest activity</h3>' + (s.activity.length ? '<span class="hint">Newest first</span>' : '') + '</div><div class="feed">' + (s.activity.length ? s.activity.map(activityRow).join('') : emptyBox({ plain: 1, emoji: '🌱', title: 'No activity yet', text: nConn ? 'When someone starts your bot or taps a button, it shows up here.' : 'Connect a bot, channel or group to get started.', action: nConn ? '' : '<button type="button" class="btn b-blue sm" data-connect>Connect Telegram</button>' })) + '</div></div>' +
      '<div class="box c7"><div class="bh"><h3>Recent messages</h3><button type="button" class="btn b-ghost xs" data-go="broadcast">See all</button></div><div id="ovRecent">' + skel(3, 44) + '</div></div>' +
      '</div>' + (typeof xsBlock === 'function' ? xsBlock() : '');
    later(200, () => { const r = $('#ckR'); if (r) r.style.strokeDashoffset = 289 * (1 - pct / 100); });
    $$('[data-count]', el).forEach((b) => countTo(b, +b.dataset.count, 1000));
    lineChart($('#ovCh'), series.map((d) => dayLabel(d.day)), series.map((d) => d.sent), series.map((d) => d.prev), { label: 'Messages delivered per day', id: 'ov' });
    el.addEventListener('click', (e) => { const r = e.target.closest('[data-report]'); if (r) openReport(+r.dataset.report); });
    if (typeof xsStart === 'function') xsStart();
    // Recent messages (separate call so the page shows fast)
    GET('/api/broadcasts').then((r) => {
      if (!alive()) return;
      const rows = (r.broadcasts || []).slice(0, 4);
      $('#ovRecent').innerHTML = rows.length ? '<div class="tw">' + castTable(rows, { compact: true }) + '</div>' : emptyBox({ plain: 1, emoji: '📨', title: 'No messages yet', text: 'Your first broadcast will appear here.', action: nConn ? '<button type="button" class="btn b-blue sm" data-go="broadcast">' + icon('send') + 'Send a message</button>' : '' });
      wireCastTable($('#ovRecent'), () => renderPage('overview', {}));
    }).catch(() => { if (alive()) $('#ovRecent').innerHTML = '<p class="muted">Could not load messages.</p>'; });
    // While something is sending, check every 5 seconds.
    if (s.sending) {
      const iv = every(5000, async () => {
        const ns = await refreshState();
        if (!alive() || !ns) return;
        $('#ovSend').innerHTML = sendingBox(ns.sending);
        if (!ns.sending) { clearInterval(iv); toast('Your message finished sending.'); }
      });
    }
  },
};

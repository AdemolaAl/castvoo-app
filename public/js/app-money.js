'use strict';
/*
 * app-money.js: Wallet and plan page, the top-up sheet (card / local methods / Gatevoo / manual crypto /
 * the team's own manual methods like bank transfer), payment return check, and the Earn (referrals) page.
 * API: GET /api/wallet, POST /api/wallet/topup, /api/wallet/check, /api/wallet/crypto-txid,
 *      GET /api/wallet/manual/:ref, POST /api/wallet/manual/:ref/screenshot, /api/wallet/manual/:ref/submit,
 *      GET/POST /api/app/plan, /api/app/plan/cancel, /api/app/coupon, GET /api/referrals, /use, /withdraw
 */

const TX_ICON = { topup: ['↓', '#E2F6EE'], bonus: ['🎁', '#FCF2DE'], plan: ['↑', '#F0F3FA'], refund: ['↩', '#E5F4FC'], referral_credit: ['🎁', '#EFEBFF'], adjustment: ['±', '#F0F3FA'] };
const TX_NAME = { topup: 'Top up', bonus: 'Top-up bonus', plan: 'Plan payment', refund: 'Refund', referral_credit: 'Referral earnings', adjustment: 'Adjustment' };
const PROVIDER = { paystack: 'Paystack', flutterwave: 'Flutterwave', gatevoo: 'Gatevoo (crypto)', manual_crypto: 'Crypto', manual: 'Manual payment' };
/* Colours come from the admin. Only #RRGGBB goes into a style attribute. */
const safeColor = (c, d = '#0B1430') => (/^#[0-9a-fA-F]{6}$/.test(String(c || '')) ? c : d);
function planPrice(p, plan) { const x = (p.plans || []).find((y) => y.code === (plan || p.plan_code)); return x ? (p.cycle === 'year' ? x.price_year : x.price_month) : null; }
function localMoney(amount, cur) { try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(amount); } catch (_) { return cur + ' ' + fmt(amount); } }

/* ---------- Wallet page ---------- */
PAGES.wallet = {
  title: 'Wallet and plan', sub: 'Balance, top-ups and your plan',
  async render(el, q, alive) {
    el.innerHTML = skel(1, 230) + '<div class="dg"><div class="c7">' + skel(1, 300) + '</div><div class="c5">' + skel(1, 300) + '</div></div>';
    if (q.ref) { checkPayment(q.ref); history.replaceState(null, '', '#app/wallet'); }
    const [w, p] = await Promise.all([GET('/api/wallet'), GET('/api/app/plan')]);
    if (!alive()) return;
    APP.state.plan = p; APP.state.wallet = { cash: w.cash, bonus: w.bonus, total: w.total }; shellUI();
    const planOnly = planPrice(p);
    // Extra team seats renew with the plan, in the same wallet payment.
    const SX = p.seats || {};
    const seatsRenew = p.status === 'active' && !p.free ? Number(SX.renews) || 0 : 0;
    const price = planOnly != null ? planOnly + seatsRenew : null;
    const pend = (p.plans || []).find((x) => x.code === p.pending_plan_code);
    const status = p.free ? ['Free plan', 'p-blue'] : ({ trial: ['Free trial', 'p-blue'], active: ['Active', 'p-ok'], paused: ['Paused', 'p-bad'], cancelled: ['No plan', 'p-grey'] }[p.status] || [p.status, 'p-grey']);
    let renew = '';
    if (p.free) renew = 'You are on the Free plan: your welcome bot keeps running. ' + (p.dropped_from ? 'Top up and your ' + esc(((p.plans || []).find((x) => x.code === p.dropped_from) || {}).name || 'old') + ' plan starts again by itself.' : 'Pick a plan for follow-ups, broadcasts and Cas.');
    else if (p.status === 'trial') renew = 'Trial ends ' + fmtDate(p.trial_ends_at, false) + '. ' + (pend ? pend.name + ' then starts, paid from your wallet.' : 'Pick a plan to keep going after that.');
    else if (p.status === 'active') renew = p.cancel_at_period_end ? esc(p.plan_name) + ' ends on ' + fmtDate(p.period_end, false) + '. It won\'t renew.' : esc(p.plan_name) + (SX.next ? ' and ' + plural(SX.next, 'extra seat') : '') + ' renew' + (SX.next ? '' : 's') + ' on ' + fmtDate(p.period_end, false) + (price != null ? ' for ' + usd(price) : '') + ', paid from your wallet.';
    else if (p.status === 'paused') renew = 'Sending is paused because the wallet was short. Top up and it restarts by itself.';
    else renew = 'You don\'t have an active plan. Choose one to start sending again.';
    const short = p.status === 'active' && !p.cancel_at_period_end && price != null && w.total < price;
    const rows = (w.transactions || []);
    el.innerHTML = '<div class="box balc"><div class="money" aria-hidden="true" data-money="12" data-h="260"></div><div class="mesh" style="width:300px;height:300px;right:-6%;top:-50%;background:rgba(110,195,255,.5)"></div>' +
      '<div class="bl"><small>Wallet balance</small><div class="bal tnum" id="wB">$0.00</div><small>' + money(w.cash) + ' cash' + (w.bonus ? ' · ' + money(w.bonus) + ' bonus credit (for plans only)' : '') + '</small><small>' + renew + '</small>' +
      '<div class="ac">' + (CFG.features.topups !== false ? '<button type="button" class="btn b-w" data-topup>' + icon('plus') + 'Top up</button>' : '') + (CFG.features.referrals !== false ? '<button type="button" class="btn b-g" data-go="earn">' + icon('gift') + 'Earn ' + (CFG.referral.rates || [10])[0] + '%+</button>' : '') + '</div></div><div class="wart" data-art="wallet"></div></div>' +
      (short ? '<div class="pban warn"><span class="pbi">⚠️</span><div style="flex:1"><b>Your next renewal needs ' + usd(price) + '</b><p>You have ' + money(w.total) + '. Top up before ' + fmtDate(p.period_end, false) + ' so sending doesn\'t pause.</p></div><button type="button" class="btn b-blue xs" data-topup>Top up</button></div>' : '') +
      ((w.pending || []).length ? '<div class="box"><div class="bh"><h3>Payments in progress</h3></div>' + w.pending.map((x) => '<div class="txr"><span class="ti" style="background:var(--warn-s)">⏳</span><div class="tx"><b>' + money(x.amount) + ' · ' + esc(x.provider === 'manual' ? x.method_label || PROVIDER.manual : PROVIDER[x.provider] || x.provider) + (x.coin ? ' ' + esc(x.coin) : '') + '</b><small>Started ' + ago(x.created_at) + (x.provider === 'manual_crypto' ? (x.txid ? ' · transaction ID sent, the team is checking it' : ' · waiting for your transaction ID') : x.provider === 'manual' ? (x.submitted ? ' · sent, the team is checking it' : ' · waiting for your payment') : '') + '</small></div>' + (x.provider === 'manual_crypto' ? (x.txid ? '' : '<button type="button" class="btn b-blue xs" data-txid="' + esc(x.reference) + '">Add transaction ID</button>') : x.provider === 'manual' ? (x.submitted ? '' : '<button type="button" class="btn b-blue xs" data-man="' + esc(x.reference) + '">Finish payment</button>') : '<button type="button" class="btn b-ghost xs" data-chk="' + esc(x.reference) + '">Check now</button>') + '</div>').join('') + '</div>' : '') +
      '<div class="dg"><div class="box c7"><div class="bh"><h3>Wallet activity</h3><span class="hint">Newest first</span></div><div>' + (rows.length ? rows.map((t) => { const ic = TX_ICON[t.kind] || ['•', '#F0F3FA']; const pos = t.amount > 0; return '<div class="txr"><span class="ti" style="background:' + ic[1] + ';color:' + (pos ? 'var(--ok)' : 'var(--mut)') + ';font-weight:800">' + ic[0] + '</span><div class="tx"><b>' + esc(t.note || TX_NAME[t.kind] || t.kind) + '</b><small>' + fmtDate(t.created_at) + (t.method ? ' · ' + esc(t.method) : '') + '</small></div><span class="am" style="color:' + (pos ? 'var(--ok)' : 'var(--ink)') + '">' + (pos ? '+' : '−') + money(Math.abs(t.amount)) + '</span></div>'; }).join('') : emptyBox({ plain: 1, emoji: '👛', title: 'No wallet activity yet', text: 'Top-ups and plan payments show up here.' })) + '</div></div>' +
      '<div class="box c5" id="planBox"><div class="bh"><h3>Your plan</h3><span class="pill ' + status[1] + '">' + status[0] + '</span></div><b style="font-size:24px;letter-spacing:-.04em">' + esc(p.plan_name) + (planOnly != null && p.status !== 'trial' && !p.free ? ' · ' + usd(planOnly) + '/' + (p.cycle === 'year' ? 'year' : 'month') : '') + '</b>' +
      (p.status === 'active' && !p.free && (SX.extra || SX.next) ? '<div class="seatln"><span>' + icon('users') + '<b>' + plural(SX.extra, 'extra team seat') + '</b>' + (SX.pending != null ? ' · ' + SX.pending + ' from your next renewal' : '') + '</span><span class="tnum">' + usd(seatsRenew) + '/' + (p.cycle === 'year' ? 'year' : 'month') + '</span></div>' +
        (p.status === 'active' && price != null ? '<p class="muted" style="font-size:13.5px;margin:0">Next renewal: plan ' + usd(planOnly) + ' + seats ' + usd(seatsRenew) + ' = <b style="color:var(--ink)">' + usd(price) + '</b></p>' : '') : '') +
      (pend ? '<p class="muted" style="font-size:14px">Changes to <b>' + esc(pend.name) + '</b> ' + (p.status === 'trial' ? 'when your trial ends' : 'at your next renewal') + '.</p>' : '') +
      (p.coupon ? '<p class="muted" style="font-size:14px">Coupon ' + esc(p.coupon.code) + ': ' + p.coupon.percent + '% off the next ' + plural(p.coupon.months_left, 'payment') + '.</p>' : '') +
      '<div class="usage">' + usageRows(p).map((r) => { const unl = r[2] < 0; const pct = unl ? 0 : r[2] ? Math.min(100, r[1] / r[2] * 100) : 0; return '<div><div class="ush"><span>' + r[0] + '</span><span class="muted">' + (r[3] || (unl ? fmt(r[1]) + ' · no limit' : fmt(r[1]) + ' / ' + fmt(r[2]))) + '</span></div>' + (r[3] ? '' : '<div class="prog2' + (pct >= 80 ? ' hot' : '') + '"><i style="width:' + pct + '%"></i></div>') + '</div>'; }).join('') + '</div>' +
      (p.join && p.join.no_welcome ? '<p class="wf-mw"><b>' + plural(p.join.no_welcome, 'person', 'people') + ' joined without your welcome</b> this month. <button type="button" class="lnk" data-upg="join">Get more join requests</button></p>' : '') +
      (p.branding ? '<div class="note2"><span>⚡</span><span>Your welcome ends with "Free welcome bot by Castvoo.com". <button type="button" class="lnk" data-upg="brand">Remove it from ' + usd(((p.plans || []).find((x) => x.price_month > 0) || { price_month: 19 }).price_month) + '/month</button></span></div>' : '') +
      (p.suggest_yearly ? '<div class="note2"><span>💡</span><span><b>Switch to yearly and save ' + usd(p.suggest_yearly.save) + '.</b> Pay for 10 months, get 12. <button type="button" class="lnk" data-upg="yearly">Switch to yearly</button></span></div>' : '') +
      (canBilling() ? '<button type="button" class="btn b-blue sm" id="pChange">' + icon('up') + ((p.status === 'trial' && !pend) || p.free ? 'Choose a plan' : 'Change plan') + '</button>' +
        (isOwner() && p.status === 'active' && !p.free ? '<div class="tg"><span><b style="font-size:14.5px">Renew automatically</b><br><small class="muted">' + (p.cancel_at_period_end ? 'Off: the plan ends on ' + fmtDate(p.period_end, false) : 'Paid from your wallet. If it\'s short, we email you a few days before.') + '</small></span>' + toggleBtn('pRenew', !p.cancel_at_period_end, 'Renew automatically') + '</div>' : '') +
        '<form class="slnew" id="cpF"><input class="inp" id="cpI" maxlength="40" placeholder="Coupon code" aria-label="Coupon code"><button type="submit" class="btn b-ghost sm">Apply</button></form>'
        : '<p class="hint">' + (isHelper() ? 'Only the owner can change the plan. They can allow it for you in Settings → Team. You can still top up the wallet.' : 'Only the workspace owner can change the plan.') + '</p>') +
      '<p class="hint">Unused top-ups can be refunded within ' + fmt(CFG.billing.refund_days || 14) + ' days. See the <a href="/legal/refunds" target="_blank" rel="noopener">refund policy</a>.</p></div></div>';
    countTo($('#wB'), w.total, 900, money);
    const pc = $('#pChange'); if (pc) pc.onclick = () => planSheet(p);
    $('#planBox').addEventListener('click', (e) => {
      const u = e.target.closest('[data-upg]'); if (!u) return;
      if (u.dataset.upg === 'yearly') { planSheet({ ...p, cycle: 'year' }, 'year'); return; }
      openUpgrade(u.dataset.upg === 'brand' ? { title: 'Remove "by Castvoo" from your welcome', text: 'Paid plans send your welcome without the Castvoo line, and add follow-ups, broadcasts and Cas.', plan: p } : { title: 'Welcome more people each month', text: 'Bigger plans include more join requests a month.', limit: 'join_requests', plan: p });
    });
    const pr = $('#pRenew'); if (pr) pr.onclick = async () => {
      // N-5: lock the toggle before the confirm box opens, so a double tap opens one box, not two.
      if (pr.dataset.busy || pr.dataset.asking) return;
      const turnOff = !p.cancel_at_period_end;
      pr.dataset.asking = '1';
      let go;
      try { go = !turnOff || (await confirmBox('Stop renewing?', 'Your plan keeps working until ' + fmtDate(p.period_end, false) + ', then sending stops. You can turn this back on any time before then.', 'Stop renewing', true)); } finally { delete pr.dataset.asking; }
      if (!go) return;
      await busy(pr, '', async () => {
        try { await POST('/api/app/plan/cancel', { resume: !turnOff }); toast(turnOff ? 'Your plan won\'t renew.' : 'Your plan will renew automatically.'); } catch (ex) { apiErr(ex); }
      });
      renderPage('wallet', {}, { keepScroll: true });
    };
    const cf = $('#cpF'); if (cf) cf.onsubmit = async (e) => {
      e.preventDefault(); const code = $('#cpI').value.trim(); if (!code) return;
      try { const r = await POST('/api/app/coupon', { code }); toast(r.message); renderPage('wallet', {}, { keepScroll: true }); } catch (ex) { apiErr(ex); }
    };
    el.addEventListener('click', (e) => {
      const c = e.target.closest('[data-chk]'); if (c) { checkPayment(c.dataset.chk, true); return; }
      const mm = e.target.closest('[data-man]'); if (mm) { openManual(mm.dataset.man); return; }
      const t = e.target.closest('[data-txid]'); if (t) { const x = (w.pending || []).find((y) => y.reference === t.dataset.txid); cryptoTxid({ reference: x.reference, coin: x.coin, amount_usd: x.amount }); }
    });
  },
};

/* Change plan sheet */
function planSheet(p, cycleWant) {
  let cycle = cycleWant || p.cycle || 'month', sel = p.pending_plan_code || (p.free ? ((p.plans || []).find((x) => x.popular) || {}).code || p.plan_code : p.plan_code);
  // AUD-8: on a move to a plan with fewer Welcome Flows, the owner picks which live flows stay on (keep_flows).
  let live = null, keep = null;
  if (!p.free && (p.status === 'active' || p.status === 'trial')) {
    GET('/api/flows').then((r) => { live = (r.flows || []).filter((x) => x.active).sort((a, b) => a.id - b.id); if (keepPicker()) draw(); }).catch(() => {});
  }
  const keepPicker = () => {
    const x = (p.plans || []).find((y) => y.code === sel);
    if (!x || !live || x.flows == null || x.flows < 0 || live.length <= x.flows) return null;
    const lim = Number(x.flows);
    // keep.pref: the owner's picks, most recent last. They survive switching between plans; a plan with room for
    // fewer flows shows the most recent picks.
    if (!keep) keep = { pref: live.slice(0, lim).map((f) => String(f.id)) };
    keep.lim = lim; keep.ids = keep.pref.slice(-lim);
    return { x, lim };
  };
  const pickerHtml = () => {
    const k = keepPicker(); if (!k) return '';
    const full = keep.ids.length >= k.lim;
    return '<div class="kf" id="psKeep"><b class="kf-t">Which Welcome Flows stay on?</b><p class="muted kf-p">' + esc(k.x.name) + ' has room for ' + plural(k.lim, 'live flow') + '. You have ' + live.length + ' on. Pick ' + (k.lim === 1 ? 'the one' : 'up to ' + k.lim) + ' to keep live. The others are switched off when ' + esc(k.x.name) + ' starts. They are kept, not deleted, and you can swap them later in Welcome Flows.</p>' +
      live.map((f) => { const on = keep.ids.includes(String(f.id)); return '<label class="kf-r' + (on ? ' on' : '') + '"><input type="checkbox" data-keep="' + esc(String(f.id)) + '"' + (on ? ' checked' : '') + (!on && full ? ' disabled' : '') + '><span><b>' + esc(f.name || 'Welcome Flow') + '</b><small>' + esc(f.chat_title || 'Channel or group') + (f.bot_username ? ' · @' + esc(f.bot_username) : '') + ' · ' + plural(f.welcomed || 0, 'person', 'people') + ' welcomed</small></span></label>'; }).join('') +
      '<small class="muted kf-n" id="psKeepN">' + keep.ids.length + ' of ' + k.lim + ' picked' + (keep.ids.length < k.lim ? '. The oldest fill the rest.' : '') + '</small></div>';
  };
  const draw = () => {
    const h = sheet('Choose your plan', '<span class="spk">' + icon('up') + '</span>',
      '<div class="seg2" id="psCy"><button type="button" data-c="month" class="' + (cycle === 'month' ? 'on' : '') + '">Monthly</button><button type="button" data-c="year" class="' + (cycle === 'year' ? 'on' : '') + '">Yearly' + (yearSaveText() ? ' · ' + yearSaveText() : '') + '</button></div>' +
      '<div style="display:grid;gap:10px" id="psL">' + (p.plans || []).map((x) => '<button type="button" class="pp' + (x.code === sel ? ' on' : '') + '" data-p="' + esc(x.code) + '"><div><b>' + esc(x.name) + (x.code === p.plan_code && p.status === 'active' ? ' <span class="pill p-ok">Current</span>' : '') + (x.popular ? ' <span class="pill p-blue">Popular</span>' : '') + '</b><small>' + esc(!Number(x.price_month) && !Number(x.price_year) && typeof suPlanLine === 'function' ? suPlanLine(x) : plural(x.connections, 'connection') + ' · ' + fmt(x.subscribers) + ' bot subscribers · ' + fmt(x.ai_writes) + ' AI writes · ' + plural(x.seats, 'seat')) + '</small></div><span class="pr">' + usd(cycle === 'year' ? x.price_year : x.price_month) + '<small>/' + (cycle === 'year' ? 'yr' : 'mo') + '</small></span></button>').join('') + '</div>' +
      (p.status === 'trial' ? '<label class="chkl"><input type="checkbox" id="psNow"> Start it now instead of after the trial (paid from your wallet today)</label>' : '') +
      '<div class="note2"><span>ℹ️</span><span>' + (p.status === 'trial' ? 'Your pick starts when the free trial ends and is paid from your wallet. If you pick nothing, or the wallet is short, you move to the Free plan.' : p.free ? 'Your plan starts now and is paid from your wallet.' : p.status === 'active' ? 'Upgrades start now (you pay the difference for the rest of this period). Downgrades and billing changes start at your next renewal.' : 'Your plan starts now and is paid from your wallet.') + '</span></div>' +
      pickerHtml() +
      '<p class="ferr" id="psE" hidden></p><button type="button" class="btn b-blue full" id="psGo">Confirm</button>');
    const kp = $('#psKeep', h);
    if (kp) kp.onchange = (e) => {
      const c = e.target.closest('[data-keep]'); if (!c) return;
      const id = c.dataset.keep;
      keep.pref = c.checked ? [...keep.pref.filter((x) => x !== id), id] : keep.pref.filter((x) => x !== id);
      keep.ids = keep.pref.slice(-keep.lim);
      const full = keep.ids.length >= keep.lim;
      $$('[data-keep]', kp).forEach((b) => { const on = keep.ids.includes(b.dataset.keep); b.checked = on; b.disabled = !on && full; b.closest('.kf-r').classList.toggle('on', on); });
      $('#psKeepN', kp).textContent = keep.ids.length + ' of ' + keep.lim + ' picked' + (keep.ids.length < keep.lim ? '. The oldest fill the rest.' : '');
    };
    $('#psCy', h).onclick = (e) => { const b = e.target.closest('[data-c]'); if (b) { cycle = b.dataset.c; draw(); } };
    $('#psL', h).onclick = (e) => { const b = e.target.closest('[data-p]'); if (b) { sel = b.dataset.p; draw(); } };
    $('#psGo', h).onclick = (e) => busy(e.currentTarget, 'Saving…', async () => {
      try { const n = $('#psNow', h); const r = await POST('/api/app/plan', { plan: sel, cycle, start_now: n && n.checked ? true : undefined, keep_flows: keepPicker() ? keep.ids.map(Number) : undefined }); closeModal(); toast(r.message || 'Saved.'); await refreshState(); renderPage('wallet', {}, { keepScroll: true }); }
      catch (ex) { $('#psE', h).textContent = ex.message; $('#psE', h).hidden = false; apiErr(ex, { silent: true }); }
    });
  };
  draw();
}

/* One line about what a plan includes. */
function planLine(x) {
  const lim = (v, one, many) => (v < 0 ? 'unlimited ' + many : plural(v, one, many));
  if (!x.price_month) return [x.join_requests != null ? fmt(x.join_requests) + ' join requests a month' : '', '1 welcome message', '1 channel or group + its bot'].filter(Boolean).join(' · ');
  return [plural(x.connections, 'connection'), x.join_requests != null ? (x.join_requests < 0 ? 'unlimited' : fmt(x.join_requests)) + ' join requests' : '', x.flows != null ? lim(x.flows, 'flow', 'flows') : '', fmt(x.subscribers) + ' bot subscribers', fmt(x.ai_writes) + ' AI writes', plural(x.seats, 'seat')].filter(Boolean).join(' · ');
}
/* Usage bars on the plan card: [label, used, limit, text instead of a bar]. */
function usageRows(p) {
  const L = p.limits, U = p.usage;
  const rows = [];
  if (L.join_requests != null) rows.push([p.free ? 'Free joins this month' : 'Join requests this month', U.join_requests || 0, L.join_requests]);
  rows.push(['Telegram connections', U.connections, L.connections, p.welcome_only ? fmt(U.connections - (U.bots || 0)) + ' / ' + fmt(L.connections) + ' + welcome bot' : '']);
  if (L.flows != null) rows.push(['Welcome Flows', U.flows || 0, L.flows]);
  rows.push(['Bot subscribers', U.subscribers, L.subscribers, L.subscribers === 0 ? 'On Starter and up' : '']);
  rows.push(['AI writes this month', U.ai_writes, L.ai_writes, L.ai_writes === 0 ? 'On Starter and up' : '']);
  if (L.seats > 1 || !p.free) rows.push([L.extra_seats ? 'Team seats (' + fmt(L.plan_seats) + ' + ' + fmt(L.extra_seats) + ' extra)' : 'Team seats', U.seats, L.seats]);
  return rows;
}

/*
 * The upgrade sheet: why, the plan(s) that unlock it, and one tap to switch.
 * o: { title, text, feature (plan feature key it needs), limit ('flows' | 'flow_steps' | 'join_requests'), plan (planState) }
 */
function openUpgrade(o = {}) {
  const st = o.plan && o.plan.plans ? o.plan : (APP.state && APP.state.plan) || {};
  const all = (st.plans || []).filter((x) => x.price_month > 0).sort((a, b) => a.price_month - b.price_month);
  const cur = (st.plans || []).find((x) => x.code === st.plan_code) || { price_month: 0 };
  const L = st.limits || {};
  const better = (x) => {
    if (o.feature && !(x.features || []).includes(o.feature)) return false;
    if (o.limit === 'flows' && !(x.flows < 0 || x.flows > (L.flows ?? 0))) return false;
    if (o.limit === 'flow_steps' && !(x.flow_steps < 0 || x.flow_steps > (L.flow_steps ?? 0))) return false;
    if (o.limit === 'join_requests' && !(x.join_requests < 0 || x.join_requests > (L.join_requests ?? 0))) return false;
    return st.status === 'trial' || x.price_month > (cur.price_month || 0);
  };
  const list = all.filter(better).slice(0, 2);
  const facts = (x) => {
    const f = [];
    if (x.join_requests != null) f.push((x.join_requests < 0 ? 'Unlimited' : fmt(x.join_requests)) + ' join requests a month');
    if (x.flows != null) f.push((x.flows < 0 ? 'Unlimited' : fmt(x.flows)) + ' Welcome Flows, ' + (x.flow_steps < 0 ? 'unlimited' : fmt(x.flow_steps)) + ' steps each');
    const F = x.features || [];
    if (F.includes('ab_welcome_4')) f.push('A/B welcome with up to 4 versions'); else if (F.includes('ab_welcome_2')) f.push('A/B welcome and click conditions');
    else if (F.includes('tap_to_start')) f.push('"Tap to start" button and follow-ups');
    f.push(plural(x.connections, 'bot, channel or group', 'bots, channels or groups'));
    if (!x.branding) f.push('No Castvoo line on your welcome');
    return f.slice(0, 5);
  };
  const owner = canBilling();
  const h = sheet(esc(o.title || 'Upgrade your plan'), '<span class="spk">' + icon('up') + '</span>',
    (o.text ? '<p class="muted" style="font-size:15px">' + esc(o.text) + '</p>' : '') +
    (list.length ? '<div class="upg">' + list.map((x, i) => '<div class="upgc' + (i === 0 ? ' on' : '') + '"><div class="upgh"><b>' + esc(x.name) + '</b>' + (x.popular ? '<span class="pill p-blue">Popular</span>' : '') + '<span class="upgp">' + usd(x.price_month) + '<small>/month</small></span></div><ul>' + facts(x).map((f) => '<li>' + icon('check') + esc(f) + '</li>').join('') + '</ul>' +
      (owner ? '<button type="button" class="btn ' + (i === 0 ? 'b-blue' : 'b-ghost') + ' sm full" data-pick="' + esc(x.code) + '">Choose ' + esc(x.name) + '</button>' : '') + '</div>').join('') + '</div>'
      : '<div class="note2"><span>ℹ️</span><span>You are on the biggest plan. For more, talk to us in Help.</span></div>') +
    (owner ? '' : '<p class="hint">Only the workspace owner can change the plan.</p>') +
    '<p class="ferr" id="upE" hidden></p><button type="button" class="btn b-ghost sm" id="upAll">Compare all plans</button>');
  $('#upAll', h).onclick = () => { closeModal(); appGo('wallet'); };
  $$('[data-pick]', h).forEach((b) => { b.onclick = async () => {
    btnBusy(b, true, 'Switching…');
    try { const r = await POST('/api/app/plan', { plan: b.dataset.pick, cycle: 'month' }); closeModal(); toast(r.message || 'Done.'); confetti(); await refreshState(); renderPage(APP.page, APP.q, { keepScroll: true }); }
    catch (ex) { btnBusy(b, false); if (ex.code === 'wallet_short') { closeModal(); toast(ex.message, { kind: 'err', action: { label: 'Top up', onClick: () => openTopup((ex.data && ex.data.needed) || undefined) } }); return; } const e2 = $('#upE', h); e2.textContent = ex.message; e2.hidden = false; }
  }; });
}

/* ---------- Top-up sheet ---------- */
async function openTopup(preset) {
  if (CFG.features.topups === false) { toast('Top-ups are paused right now. Please try again later.', { kind: 'info' }); return; }
  let h = sheet('Top up wallet', '<span class="spk">' + icon('wallet') + '</span>', loadingBox('Loading payment options…'));
  let w;
  try { w = await GET('/api/wallet'); } catch (e) { if ($('.sb', h)) $('.sb', h).innerHTML = errorBox(e); return; }
  const st = { amt: preset || 100, pm: null };
  const ms = w.methods || [];
  if (ms.length) st.pm = ms[0].key;
  const min = w.min_topup || 10, max = w.max_topup || 5000;
  const bonusFor = (a) => (w.bonuses || []).reduce((b, x) => (a >= x.min && x.bonus > b ? x.bonus : b), 0);
  const presets = [20, 50, 100, 200, 500, 1000].filter((a) => a >= min && a <= max);
  const ctry = w.country;
  /* The total box. Redrawn on its own while typing a custom amount, so the sheet (and the button the user is about to tap) is not replaced on blur. */
  const sumHtml = () => {
    const m = ms.find((x) => x.key === st.pm);
    const b = bonusFor(st.amt);
    const local = m && m.currency && m.currency !== 'USD' ? localMoney(st.amt * Number(m.usd_rate || 1), m.currency) : '';
    return '<div class="sum"><div><span class="muted">Top up</span><b>' + money(st.amt) + '</b></div>' + (b ? '<div><span class="muted">Bonus (plans only)</span><b style="color:var(--ok)">+' + money(b) + '</b></div>' : '') + '<div class="t"><span>Added to wallet</span><span>' + money(st.amt + b) + '</span></div>' + (local ? '<div><span class="muted">You pay about</span><b>' + local + '</b></div><small class="muted">' + (m.manual ? 'The exact amount is shown on the next step.' : 'At ' + esc(m.label) + '\'s rate, shown at checkout.') + '</small>' : '') + '</div>';
  };
  const draw = () => {
    if (!$('#modalHost').innerHTML) return;
    const m = ms.find((x) => x.key === st.pm);
    h = sheet('Top up wallet', '<span class="spk">' + icon('wallet') + '</span>',
      '<div class="field"><label>Choose an amount</label><div class="amts">' + presets.map((a) => '<button type="button" class="amt ' + (a === st.amt ? 'on' : '') + '" data-a="' + a + '">' + usd(a) + (bonusFor(a) ? '<small>+' + usd(bonusFor(a)) + ' bonus</small>' : '<small class="nb">&nbsp;</small>') + '</button>').join('') + '</div></div>' +
      '<div class="field"><label for="tuC">Or enter your own</label><div class="cust"><span>$</span><input id="tuC" inputmode="decimal" value="' + st.amt + '" aria-label="Amount in dollars"></div><span class="hint">From ' + usd(min) + ' to ' + usd(max) + '.</span></div>' +
      '<div class="field"><label>Pay with' + (ctry ? ' <span class="hint" style="font-weight:600">· methods for ' + esc(ctry.flag + ' ' + ctry.name) + ' · <a href="#app/settings">change</a></span>' : '') + '</label>' +
      (ms.length ? '<div class="pms">' + ms.map((x) => '<button type="button" class="pm ' + (x.key === st.pm ? 'on' : '') + '" data-p="' + esc(x.key) + '"><span class="pmi" style="background:' + esc(x.color || '#0B1430') + '">' + esc(x.icon || '•') + '</span><span style="min-width:0;flex:1"><b>' + esc(x.label) + '</b><small>' + esc(x.detail || '') + '</small>' + (x.gatevoo ? gatevooBadge(true) : '') + '</span><span class="rd"></span></button>').join('') + '</div>'
        : '<div class="note2"><span>🔧</span><span>Payments are being switched on. Please check back soon.</span></div>') + '</div>' +
      sumHtml() +
      '<div id="tuMsg"></div><p class="ferr" id="tuE" hidden></p>' +
      '<button type="button" class="btn b-blue full" id="tuGo"' + (ms.length ? '' : ' disabled') + '>' + (m && (m.key === 'usdt' || m.key === 'btc') ? 'Show payment address' : m && m.manual ? 'Show payment details' : m ? 'Continue to ' + esc(m.gatevoo ? 'crypto checkout' : m.label) : 'Continue') + icon('arrow') + '</button>' +
      '<p class="hint" style="text-align:center">' + icon('lock').replace('<svg', '<svg width="13" height="13" style="vertical-align:-2px"') + ' ' + (m && m.manual ? 'You pay ' + esc(m.label) + ' yourself. Our team checks it and adds the money to your wallet.' : 'Payments are processed securely by our payment partners. Card details never touch Castvoo.') + '</p>');
    $('.amts', h).onclick = (e) => { const x = e.target.closest('[data-a]'); if (x) { st.amt = +x.dataset.a; draw(); } };
    const pms = $('.pms', h); if (pms) pms.onclick = (e) => { const x = e.target.closest('[data-p]'); if (x) { st.pm = x.dataset.p; draw(); } };
    $('#tuC', h).oninput = (e) => {
      st.amt = Math.round((parseFloat(String(e.target.value).replace(/[^0-9.]/g, '')) || 0) * 100) / 100;
      $$('.amt', h).forEach((x) => x.classList.toggle('on', +x.dataset.a === st.amt));
      const sm = $('.sum', h); if (sm) sm.outerHTML = sumHtml();
    };
    $('#tuGo', h).onclick = (e) => startTopup(st, w, e.currentTarget);
  };
  draw();
}
async function startTopup(st, w, btn) {
  const err = $('#tuE');
  const min = w.min_topup || 10, max = w.max_topup || 5000;
  if (!(st.amt >= min)) { err.textContent = 'The smallest top-up is ' + usd(min) + '.'; err.hidden = false; return; }
  if (st.amt > max) { err.textContent = 'The largest single top-up is ' + usd(max) + '. Split it into smaller top-ups.'; err.hidden = false; return; }
  const pm = (w.methods || []).find((x) => x.key === st.pm);
  if (pm && pm.manual && pm.min != null && st.amt < pm.min) { err.textContent = 'With ' + pm.label + ' the smallest top-up is ' + usd(pm.min) + '.'; err.hidden = false; return; }
  if (pm && pm.manual && pm.max != null && st.amt > pm.max) { err.textContent = 'With ' + pm.label + ' the largest top-up is ' + usd(pm.max) + '.'; err.hidden = false; return; }
  err.hidden = true;
  btnBusy(btn, true, 'Starting payment…');
  let r;
  try { r = await POST('/api/wallet/topup', { amount: st.amt, method: st.pm }); }
  catch (e) {
    btnBusy(btn, false);
    if (e.code === 'email_needed') { emailMini($('#tuMsg'), () => startTopup(st, w, btn)); return; }
    err.textContent = e.message; err.hidden = false; return;
  }
  const m = (w.methods || []).find((x) => x.key === st.pm) || {};
  if (r.kind === 'redirect') {
    sheet('Opening ' + esc(m.label || 'checkout'), '<span class="spk">' + icon('lock') + '</span>', '<div class="succ"><div style="width:110px" data-cas="think"></div><b style="font-size:20px">' + (r.currency && r.currency !== 'USD' ? esc(localMoney(r.amount_local, r.currency)) + ' for ' + usd(st.amt) : usd(st.amt)) + '</b><p class="muted" style="font-size:14px">Finish the payment on ' + esc(m.label || 'the checkout page') + '. You\'ll come straight back here and your wallet updates as soon as it\'s confirmed.</p><a class="btn b-blue full" href="' + esc(r.url) + '">Continue to ' + esc(m.label || 'checkout') + icon('arrow') + '</a></div>', { sticky: true });
    setTimeout(() => { location.href = r.url; }, 1600);
    return;
  }
  if (r.kind === 'gatevoo') {
    const watch = () => waitForPayment(r.reference, st.amt);
    if (CFG.gatevoo_url) {
      try {
        await loadScript(CFG.gatevoo_url.replace(/\/$/, '') + '/gatevoo.js');
        if (window.Gatevoo && typeof window.Gatevoo.open === 'function') {
          closeModal();
          window.Gatevoo.open(r.invoice_id, { onPaid: () => checkPayment(r.reference, true) });
          watch();
          return;
        }
      } catch (_) { /* fall back to the checkout page */ }
    }
    sheet('Crypto checkout', '<span class="spk" style="background:#111">G</span>', '<div class="succ">' + gatevooBadge() + '<p class="muted" style="font-size:14px">Pay ' + usd(st.amt) + ' in USDT or Bitcoin on the Gatevoo checkout page. Come back here when you\'re done.</p><a class="btn b-blue full" href="' + esc(r.url) + '" target="_blank" rel="noopener">Open crypto checkout' + icon('ext') + '</a><button type="button" class="btn b-ghost full" data-chk2>I\'ve paid, check now</button></div>');
    $('[data-chk2]').onclick = () => checkPayment(r.reference, true);
    return;
  }
  if (r.kind === 'crypto') { cryptoPay(r); return; }
  if (r.kind === 'manual') { manualPay(r); return; }
  toast('Something unexpected happened. Please try again.', { kind: 'err' });
}

/* Manual crypto: address + QR, then the customer pastes the transaction ID. */
function cryptoPay(r) {
  const usdt = r.coin === 'USDT';
  const h = sheet('Pay with ' + (usdt ? 'USDT' : 'Bitcoin'), '<span class="spk" style="background:' + (usdt ? '#26A17B' : '#F7931A') + '">' + (usdt ? '₮' : '₿') + '</span>',
    '<div class="sum" style="text-align:center;align-items:center"><small class="muted" style="font-weight:700">Send exactly</small><b style="font-size:26px;letter-spacing:-.04em">' + (usdt ? Number(r.amount_usd).toFixed(2) + ' USDT' : 'Bitcoin worth ' + usd(r.amount_usd)) + '</b><small class="muted">' + (usdt ? 'On the TRON (TRC20) network only' : 'On the Bitcoin network, at the rate when you send') + '</small>' + (r.exact ? '<small class="muted" style="margin-top:4px">The exact cents tell us the payment is yours, so please don\'t round it. All of it goes into your wallet.</small>' : '') + '</div>' +
    '<div class="qr" id="qrBox" aria-label="QR code of the address"></div>' +
    '<div class="addr"><code>' + esc(r.address) + '</code><button type="button" class="btn b-blue xs" data-copy="' + esc(r.address) + '" data-msg="Address copied">' + icon('copy') + 'Copy</button></div>' +
    '<div class="note2 warn"><span>⚠️</span><span><b>' + (usdt ? 'Only send USDT on TRON (TRC20).' : 'Only send Bitcoin (BTC).') + '</b> Other coins or networks are lost and can\'t be refunded.</span></div>' +
    '<form id="txF" class="su-pick" novalidate><div class="field"><label for="txI">After sending, paste the transaction ID (hash)</label><input class="inp mono" id="txI" autocomplete="off" spellcheck="false" placeholder="Transaction ID from your wallet app" style="font-size:13px"></div><p class="ferr" id="txE" hidden></p><button type="submit" class="btn b-blue full">I\'ve sent it</button></form>' +
    '<p class="hint" style="text-align:center">Our team confirms crypto payments, usually within a few hours. Your wallet updates by itself.</p>');
  try { $('#qrBox', h).innerHTML = qrSvg(r.address, { label: 'Wallet address QR code' }); } catch (_) { $('#qrBox', h).hidden = true; }
  wireTxid(h, r.reference);
}
function cryptoTxid(r) {
  const h = sheet('Add transaction ID', '<span class="spk">' + icon('check') + '</span>', '<p class="muted" style="font-size:14px">For your ' + usd(r.amount_usd) + (r.coin ? ' ' + esc(r.coin) : '') + ' payment.</p><form id="txF" class="su-pick" novalidate><div class="field"><label for="txI">Transaction ID (hash)</label><input class="inp mono" id="txI" autocomplete="off" spellcheck="false" style="font-size:13px"></div><p class="ferr" id="txE" hidden></p><button type="submit" class="btn b-blue full">Send it to the team</button></form>');
  wireTxid(h, r.reference);
}
function wireTxid(h, reference) {
  $('#txF', h).onsubmit = async (e) => {
    e.preventDefault();
    const v = $('#txI', h).value.replace(/\s+/g, ''), err = $('#txE', h);
    if (v.length < 20 || !/^[A-Za-z0-9]+$/.test(v)) { err.textContent = 'A transaction ID is a long code of letters and numbers. Copy it again from your wallet app.'; err.hidden = false; return; }
    const b = $('button[type=submit]', h); btnBusy(b, true, 'Sending…');
    try {
      await POST('/api/wallet/crypto-txid', { reference, txid: v });
      sheet('Thank you!', '<span class="spk" style="background:var(--ok)">' + icon('check') + '</span>', '<div class="succ"><div style="width:110px" data-cas="happy"></div><b style="font-size:19px">We got your transaction ID</b><p class="muted" style="font-size:14px">Our team checks it, usually within a few hours, and adds the money to your wallet. We\'ll email you when it\'s done.</p><button type="button" class="btn b-blue full" data-shx>Done</button></div>');
      if (APP.page === 'wallet') renderPage('wallet', {}, { keepScroll: true });
    } catch (ex) { btnBusy(b, false); err.textContent = ex.message; err.hidden = false; }
  };
}

/* ---------- The team's own methods (bank transfer, mobile money, a crypto wallet...) ---------- */
/* Everything here comes from the admin, so every value is escaped. "Label: value" lines get a copy button. */
function instructionsHtml(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = /^([^:]{1,40}):\s*(.+)$/.exec(l);
    if (!m) return '<p class="mi-p">' + esc(l) + '</p>';
    return '<div class="mi-r"><span>' + esc(m[1]) + '</span><b>' + esc(m[2]) + '</b><button type="button" class="btn b-ghost xs" data-copy="' + esc(m[2]) + '" data-msg="' + esc(m[1]) + ' copied" aria-label="Copy ' + esc(m[1]) + '">' + icon('copy') + '</button></div>';
  }).join('');
}
function dueText(r) {
  const n = Number(r.amount_due);
  return r.currency === 'USD' ? '$' + n.toFixed(2) : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + esc(r.currency);
}
async function openManual(ref) {
  sheet('Finish your payment', '<span class="spk">' + icon('wallet') + '</span>', loadingBox('Loading…'));
  try { manualPay(await GET('/api/wallet/manual/' + encodeURIComponent(ref))); } catch (e) { const b = $('.sb'); if (b) b.innerHTML = errorBox(e); }
}
function manualPay(r) {
  const m = r.method || {};
  if (r.status !== 'pending' || r.submitted) {
    sheet(esc(m.label || 'Payment'), '<span class="spk">' + icon('check') + '</span>', '<div class="succ"><b style="font-size:19px">' + (r.status === 'paid' ? 'This payment is done' : r.status === 'pending' ? 'The team is checking it' : 'This payment was closed') + '</b><p class="muted" style="font-size:14px">' + (r.status === 'pending' ? 'We\'ll email you as soon as your wallet is credited.' : 'Start a new top-up from your wallet if you need one.') + '</p><button type="button" class="btn b-blue full" data-shx>Done</button></div>');
    return;
  }
  const askRef = m.proof_ref !== 'off', askImg = m.proof_image !== 'off';
  const h = sheet('Pay with ' + esc(m.label), '<span class="spk" style="background:' + safeColor(m.color) + '">' + esc(m.icon || '$') + '</span>',
    '<div class="sum" style="text-align:center;align-items:center"><small class="muted" style="font-weight:700">Send exactly</small><b style="font-size:26px;letter-spacing:-.04em">' + dueText(r) + '</b>' +
      '<button type="button" class="btn b-ghost xs" data-copy="' + esc(Number(r.amount_due).toFixed(2)) + '" data-msg="Amount copied">' + icon('copy') + 'Copy amount</button>' +
      '<small class="muted" style="margin-top:4px">The exact cents tell us the payment is yours, so please don\'t round it. ' + money(r.amount_usd) + ' goes into your wallet once the team confirms it.</small></div>' +
    '<div class="minst">' + instructionsHtml(m.instructions) + '<div class="mi-r"><span>Your top-up code</span><b class="mono">' + esc(r.reference) + '</b><button type="button" class="btn b-ghost xs" data-copy="' + esc(r.reference) + '" data-msg="Code copied" aria-label="Copy top-up code">' + icon('copy') + '</button></div></div>' +
    '<form id="mpF" class="su-pick" novalidate>' +
      (askRef ? '<div class="field"><label for="mpR">Transaction reference' + (m.proof_ref === 'optional' ? ' <span class="hint">(optional)</span>' : '') + '</label><input class="inp" id="mpR" maxlength="120" autocomplete="off" spellcheck="false" placeholder="From your bank or wallet app" value="' + esc(r.proof_ref_sent || '') + '"></div>' : '') +
      (askImg ? '<div class="field"><label for="mpI">Screenshot of the payment' + (m.proof_image === 'optional' ? ' <span class="hint">(optional)</span>' : '') + '</label><input class="inp" id="mpI" type="file" accept="image/jpeg,image/png,image/webp"><span class="hint" id="mpIs">' + (r.proof_image_sent ? '✓ Screenshot added. Pick another to replace it.' : 'JPG, PNG or WEBP, up to 10 MB.') + '</span></div>' : '') +
      '<p class="ferr" id="mpE" hidden></p><button type="submit" class="btn b-blue full">I\'ve paid</button></form>' +
    '<p class="hint" style="text-align:center">Our team checks payments by hand, usually within a few hours. Your wallet updates by itself.</p>');
  let hasImg = !!r.proof_image_sent, uploading = null;
  const err = $('#mpE', h);
  const fi = $('#mpI', h);
  if (fi) fi.onchange = () => {
    const f = fi.files && fi.files[0]; if (!f) return;
    err.hidden = true;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) { err.textContent = 'Use a JPG, PNG or WEBP image.'; err.hidden = false; fi.value = ''; return; }
    if (f.size > 10 * 1024 * 1024) { err.textContent = 'Screenshots can be up to 10 MB.'; err.hidden = false; fi.value = ''; return; }
    const st = $('#mpIs', h); st.textContent = 'Uploading…';
    uploading = uploadProof(r.reference, f, (p) => { st.textContent = 'Uploading… ' + Math.round(p * 100) + '%'; })
      .then(() => { hasImg = true; st.textContent = '✓ Screenshot added.'; })
      .catch((e) => { st.textContent = 'JPG, PNG or WEBP, up to 10 MB.'; err.textContent = e.message; err.hidden = false; fi.value = ''; })
      .finally(() => { uploading = null; });
  };
  $('#mpF', h).onsubmit = async (e) => {
    e.preventDefault();
    const b = $('button[type=submit]', h);
    if (uploading) { btnBusy(b, true, 'Uploading…'); await uploading; btnBusy(b, false); }
    const ref = askRef ? $('#mpR', h).value.trim() : '';
    if (m.proof_ref === 'required' && ref.length < 3) { err.textContent = 'Add the transaction reference from your bank or wallet app.'; err.hidden = false; return; }
    if (m.proof_image === 'required' && !hasImg) { err.textContent = 'Add a screenshot of the payment first.'; err.hidden = false; return; }
    err.hidden = true; btnBusy(b, true, 'Sending…');
    try {
      await POST('/api/wallet/manual/' + encodeURIComponent(r.reference) + '/submit', { proof_ref: ref });
      sheet('Thank you!', '<span class="spk" style="background:var(--ok)">' + icon('check') + '</span>', '<div class="succ"><div style="width:110px" data-cas="happy"></div><b style="font-size:19px">We got your payment details</b><p class="muted" style="font-size:14px">Our team checks it, usually within a few hours, and adds the money to your wallet. We\'ll email you when it\'s done.</p><button type="button" class="btn b-blue full" data-shx>Done</button></div>');
      if (APP.page === 'wallet') renderPage('wallet', {}, { keepScroll: true });
    } catch (ex) { btnBusy(b, false); err.textContent = ex.message; err.hidden = false; }
  };
}
/* Send a screenshot for a manual payment (the raw image is the body, like photo uploads). */
function uploadProof(reference, file, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api/wallet/manual/' + encodeURIComponent(reference) + '/screenshot');
    x.withCredentials = true;
    x.setRequestHeader('Content-Type', file.type);
    x.setRequestHeader('x-cv', '1');
    const ws = WS.get(); if (ws) x.setRequestHeader('x-ws', ws);
    x.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    x.onload = () => {
      let d = null; try { d = JSON.parse(x.responseText); } catch (_) { d = null; }
      if (x.status >= 200 && x.status < 300 && d && d.ok) resolve(d);
      else reject(new ApiError(x.status, (d && d.error) || (x.status === 413 ? 'Screenshots can be up to 10 MB.' : 'Upload failed. Please try again.'), d && d.code));
    };
    x.onerror = () => reject(new ApiError(0, 'Upload failed. Check your internet and try again.', 'offline'));
    x.send(file);
  });
}

/* Add an email before a card payment (the provider sends the receipt there). */
function emailMini(box, then) {
  box.innerHTML = '<div class="emini"><b>Add your email first</b><p class="muted" style="font-size:13.5px">The payment provider sends your receipt there.</p><div class="slnew"><input class="inp" id="emI" type="email" placeholder="you@company.com" autocomplete="email"><button type="button" class="btn b-blue sm" id="emS">Send code</button></div><div id="emC" hidden class="slnew"><input class="inp codein sm" id="emK" inputmode="numeric" maxlength="6" placeholder="6-digit code"><button type="button" class="btn b-blue sm" id="emV">Verify</button></div><p class="ferr" id="emE" hidden></p></div>';
  const err = $('#emE', box);
  $('#emS', box).onclick = (e) => {
    const v = $('#emI', box).value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { err.textContent = 'Enter a valid email.'; err.hidden = false; return; }
    return busy(e.currentTarget, '', async () => {
      try { await POST('/api/me/email/start', { email: v }); $('#emC', box).hidden = false; err.hidden = true; $('#emK', box).focus(); toast('Code sent to ' + v); } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    });
  };
  $('#emV', box).onclick = (e) => busy(e.currentTarget, '', async () => {
    let ok = false;
    try { ME = await POST('/api/me/email/verify', { email: $('#emI', box).value.trim(), code: $('#emK', box).value }); ok = true; }
    catch (ex) { err.textContent = ex.message; err.hidden = false; }
    if (ok) { box.innerHTML = ''; toast('Email added.'); then(); }
  });
}

/* After returning from a checkout (#app/wallet?ref=...) or pressing "Check now". */
async function checkPayment(ref, manual) {
  let r;
  try { r = await POST('/api/wallet/check', { reference: ref }); } catch (e) { if (e.status === 404) { toast('We couldn\'t find that payment.', { kind: 'err' }); return; } apiErr(e); return; }
  if (r.status === 'paid') {
    await refreshState();
    const h = sheet('Payment received', '<span class="spk" style="background:var(--ok)">' + icon('check') + '</span>', '<div class="succ"><div class="money" aria-hidden="true" data-money="16" data-h="300"></div><div class="sc"><svg><use href="#i-check"/></svg></div><b style="font-size:22px;letter-spacing:-.03em">Money added to your wallet</b><p class="muted">New balance <b class="tnum" style="color:var(--ink)">' + money(APP.state ? APP.state.wallet.total : 0) + '</b></p><div style="width:110px" data-cas="happy"></div><button type="button" class="btn b-blue full" data-shx>Done</button></div>');
    paintMoney(h); confetti();
    if (APP.page === 'wallet') renderPage('wallet', {}, { keepScroll: true });
  } else if (r.status === 'pending') {
    if (manual) toast('Still processing. Your wallet updates as soon as the payment is confirmed.', { kind: 'info' });
    else sheet('Almost there', '<span class="spk">⏳</span>', '<div class="succ"><div style="width:110px" data-cas="think"></div><b style="font-size:19px">Your payment is still processing</b><p class="muted" style="font-size:14px">This can take a minute. Your wallet updates by itself as soon as it\'s confirmed. We\'ll also email you.</p><button type="button" class="btn b-blue full" id="ckA">' + icon('refresh') + 'Check again</button></div>');
    const a = $('#ckA'); if (a) a.onclick = () => { closeModal(); checkPayment(ref, true); };
  } else toast('That payment did not go through. Nothing was taken from your wallet. Please try again.', { kind: 'err' });
}
/* Quietly check a payment every 5 seconds for a few minutes (used with the Gatevoo pop-up). */
function waitForPayment(ref, amount) {
  void amount;
  let n = 0;
  const tick = async () => { n++; try { const r = await POST('/api/wallet/check', { reference: ref }); if (r.status === 'paid') { checkPayment(ref); return; } if (r.status !== 'pending') return; } catch (_) { /* keep trying */ } if (n < 60) setTimeout(tick, 5000); };
  setTimeout(tick, 5000);
}

/* ---------- Earn (referrals) ---------- */
function shareLinks(link) {
  const text = 'I use Castvoo for Telegram broadcasts and follow-ups. Try it free for ' + fmt(CFG.trial.days) + ' days:';
  return [['Telegram', '#29A9EB', 'tg', 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent(text)], ['WhatsApp', '#25D366', 'W', 'https://wa.me/?text=' + encodeURIComponent(text + ' ' + link)], ['X', '#0B1430', 'X', 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(text) + '&url=' + encodeURIComponent(link)], ['Email', '#2F6BFF', '@', 'mailto:?subject=' + encodeURIComponent('Try Castvoo') + '&body=' + encodeURIComponent(text + '\n\n' + link)]];
}
PAGES.earn = {
  title: 'Earn', sub: 'Invite friends, get paid every month',
  async render(el, q, alive) {
    el.innerHTML = skel(1, 280) + '<div class="dg"><div class="c7">' + skel(1, 260) + '</div><div class="c5">' + skel(1, 260) + '</div></div>';
    if (CFG.features.referrals === false) { el.innerHTML = emptyBox({ cas: 'think', title: 'The referral program is paused', text: 'Your earnings are safe. Please check back soon.' }); return; }
    if (isHelper()) { el.innerHTML = emptyBox({ cas: 'wave', title: 'Earnings live in your own workspace', text: 'You are the setup helper here, so this workspace\'s referral earnings stay with the owner. Switch to your own workspace to see yours.', action: (ME.workspaces || []).length > 1 ? '<button type="button" class="btn b-blue sm" data-ws-switch>' + icon('swap') + 'Switch workspace</button>' : '' }); return; }
    const d = await GET('/api/referrals');
    if (!alive()) return;
    const b = d.balance, min = d.min_withdraw;
    const tierI = d.tiers.reduce((a, t, i) => (d.paying >= t.min ? i : a), 0);
    const tierName = ['Bronze partner', 'Silver partner', 'Gold partner'][tierI] || 'Partner';
    const openW = (d.withdrawals || []).some((x) => x.status === 'requested');
    const canW = d.withdrawals_on && b.available >= min && !openW;
    el.innerHTML = '<div class="box refh"><div class="money" aria-hidden="true" data-money="14" data-h="380"></div><div class="bh"><b style="font-size:16px">Ready to use or withdraw</b><span class="pill" style="background:rgba(255,255,255,.16);color:#fff">⚡ ' + tierName + ' · ' + d.rate + '%</span></div><div class="bal tnum" id="rB">$0.00</div>' +
      '<div class="rtiles"><div><small>Ready</small><b class="tnum">' + money(b.available) + '</b></div><div><small>Settling · ' + fmt(d.settle_days) + ' days</small><b class="tnum">' + money(b.pending) + '</b></div><div><small>Earned all time</small><b class="tnum">' + money(b.earned) + '</b></div></div>' +
      (b.available < min ? '<div><div class="prog2" style="background:rgba(255,255,255,.18)"><i style="width:' + Math.min(100, b.available / min * 100) + '%;background:#fff"></i></div><div class="rprog"><span>' + money(Math.max(0, min - b.available)) + ' more to withdraw</span><span>' + usd(min) + '</span></div></div>' : '') +
      '<div class="lockn"><span class="li">' + icon('lock') + '</span><span><b>Withdraw from ' + usd(min) + ' in USDT or Bitcoin</b><br><small style="opacity:.8">Earnings settle ' + fmt(d.settle_days) + ' days after each payment. You can use settled earnings on your own plan at any time.</small></span></div>' +
      '<div class="ac2"><button type="button" class="btn b-w" id="rUse"' + (b.available >= 1 ? '' : ' disabled') + '>Use on my plan</button>' + (d.withdrawals_on ? '<button type="button" class="btn b-g" id="rWd"' + (canW ? '' : ' disabled') + ' title="' + (openW ? 'A withdrawal is already being processed' : b.available < min ? 'Withdrawals start at ' + usd(min) : '') + '">Withdraw</button>' : '<span class="pill" style="background:rgba(255,255,255,.14);color:#fff">Withdrawals are paused right now</span>') + '</div></div>' +
      '<div class="dg"><div class="box c7"><div class="bh"><h3>Your referral link</h3></div><div class="copy"><code>' + esc(d.link) + '</code><button type="button" class="btn b-blue xs" data-copy="' + esc(d.link) + '" data-msg="Referral link copied">' + icon('copy') + 'Copy</button></div>' +
      '<div class="share">' + shareLinks(d.link).map((s) => '<a href="' + esc(s[3]) + '" target="_blank" rel="noopener"><span class="si2" style="background:' + s[1] + '">' + (s[2] === 'tg' ? '<svg width="34" height="34"><use href="#i-tg"/></svg>' : s[2]) + '</span>' + s[0] + '</a>').join('') + '</div>' +
      '<div class="bh" style="margin-top:4px"><h3>How it works</h3></div><div class="steps3"><div><span class="n">1</span><b>Share your link</b><small>Friends get the normal ' + fmt(CFG.trial.days) + '-day free trial.</small></div><div><span class="n">2</span><b>They pay for a plan</b><small>Every month they pay, you earn.</small></div><div><span class="n">3</span><b>You get ' + d.tiers[0].rate + ' to ' + d.tiers[d.tiers.length - 1].rate + '%</b><small>For as long as they keep paying.</small></div></div>' +
      '<p class="hint">No self-referrals, fake accounts, spam or ads on the word "Castvoo". See the <a href="/legal/referral-terms" target="_blank" rel="noopener">referral terms</a>.</p></div>' +
      '<div class="box c5"><div class="bh"><h3>Your rate</h3><span class="hint">' + plural(d.paying, 'paying referral') + ' · ' + plural(d.signups, 'sign-up') + '</span></div><div class="ladder">' + d.tiers.map((t, i) => { const next = d.tiers[i + 1]; return '<div class="' + (i === tierI ? 'on' : '') + '"><small>' + (next ? t.min + ' to ' + (next.min - 1) : t.min + '+') + ' paying</small><b' + (i === tierI ? ' style="color:var(--blue)"' : '') + '>' + t.rate + '%</b><small>' + (i === tierI ? 'You\'re here' : i > tierI ? (t.min - d.paying) + ' to go' : 'Done') + '</small></div>'; }).join('') + '</div>' +
      '<div class="bh"><h3>People you invited</h3></div><div>' + ((d.people || []).length ? d.people.map((p) => '<div class="txr">' + ava(p.name, 40) + '<div class="tx"><b>' + esc(p.name) + '</b><small><span class="pill ' + (p.status === 'Paying' ? 'p-ok' : p.status === 'Trial' ? 'p-warn' : 'p-grey') + '" style="font-size:11px">' + esc(p.status) + '</span> · joined ' + fmtDate(p.joined, false) + '</small></div><span class="am" style="color:var(--ok)">' + (p.earned ? money(p.earned) : '—') + '</span></div>').join('') : '<p class="muted" style="font-size:14px">Nobody yet. Share your link to get started.</p>') + '</div></div></div>' +
      ((d.withdrawals || []).length ? '<div class="box"><div class="bh"><h3>Withdrawals</h3></div>' + d.withdrawals.map((x) => '<div class="txr"><span class="ti" style="background:' + (x.status === 'paid' ? 'var(--ok-s)' : x.status === 'rejected' ? 'var(--bad-s)' : 'var(--warn-s)') + '">' + (x.coin === 'BTC' ? '₿' : '₮') + '</span><div class="tx"><b>' + money(x.amount) + ' in ' + esc(x.coin) + '</b><small>' + fmtDate(x.created_at) + ' · ' + esc(x.address.slice(0, 8) + '…' + x.address.slice(-6)) + (x.reason ? ' · ' + esc(x.reason) : '') + '</small></div><span class="pill ' + (x.status === 'paid' ? 'p-ok' : x.status === 'rejected' ? 'p-bad' : 'p-warn') + '">' + ({ requested: 'Processing', paid: 'Paid', rejected: 'Rejected' }[x.status] || x.status) + '</span></div>').join('') + '</div>' : '');
    countTo($('#rB'), b.available, 1000, money);
    $('#rUse').onclick = () => {
      const h = sheet('Use earnings on your plan', '<span class="spk">' + icon('gift') + '</span>', '<p class="muted" style="font-size:14px">The amount moves into your wallet as plan credit. You have ' + money(b.available) + ' ready.</p><div class="field"><label for="ruA">Amount</label><div class="cust"><span>$</span><input id="ruA" inputmode="decimal" value="' + Math.floor(b.available * 100) / 100 + '"></div></div><p class="ferr" id="ruE" hidden></p><button type="button" class="btn b-blue full" id="ruGo">Move to my wallet</button>');
      $('#ruGo', h).onclick = (e) => {
        const a = parseFloat($('#ruA', h).value) || 0;
        if (a < 1 || a > b.available) { $('#ruE', h).textContent = 'Enter between $1 and ' + money(b.available) + '.'; $('#ruE', h).hidden = false; return; }
        return busy(e.currentTarget, 'Moving…', async () => {
          try { const r = await POST('/api/referrals/use', { amount: a }); closeModal(); toast(r.message); refreshState(); renderPage('earn', {}, { keepScroll: true }); } catch (ex) { $('#ruE', h).textContent = ex.message; $('#ruE', h).hidden = false; }
        });
      };
    };
    const wd = $('#rWd'); if (wd) wd.onclick = () => {
      let coin = 'USDT';
      const h = sheet('Withdraw earnings', '<span class="spk">' + icon('down') + '</span>', '<div class="seg2" id="wdC"><button type="button" class="on" data-c="USDT">USDT · TRC20</button><button type="button" data-c="BTC">Bitcoin</button></div><div class="field"><label for="wdA" id="wdAL">Your USDT (TRC20) address</label><input class="inp mono" id="wdA" autocomplete="off" spellcheck="false" style="font-size:13px" placeholder="T…"></div><div class="field"><label for="wdM">Amount</label><div class="cust"><span>$</span><input id="wdM" inputmode="decimal" value="' + Math.floor(b.available * 100) / 100 + '"></div><span class="hint">From ' + usd(min) + ' up to ' + money(b.available) + '. Paid within 5 business days.</span></div><div class="note2 warn"><span>⚠️</span><span>Check the address carefully. Crypto sent to a wrong address can\'t be recovered.</span></div><p class="ferr" id="wdE" hidden></p><button type="button" class="btn b-blue full" id="wdGo">Request withdrawal</button>');
      $('#wdC', h).onclick = (e) => { const x = e.target.closest('[data-c]'); if (!x) return; coin = x.dataset.c; $$('#wdC button', h).forEach((y) => y.classList.toggle('on', y === x)); $('#wdAL', h).textContent = coin === 'USDT' ? 'Your USDT (TRC20) address' : 'Your Bitcoin address'; $('#wdA', h).placeholder = coin === 'USDT' ? 'T…' : 'bc1…'; };
      $('#wdGo', h).onclick = async (e) => {
        const address = $('#wdA', h).value.trim(), amount = parseFloat($('#wdM', h).value) || 0, err = $('#wdE', h);
        if (coin === 'USDT' ? !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address) : !/^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(address)) { err.textContent = coin === 'USDT' ? 'That is not a TRON (TRC20) address. It starts with T and has 34 characters.' : 'That is not a Bitcoin address. It starts with bc1, 1 or 3.'; err.hidden = false; return; }
        if (amount < min || amount > b.available) { err.textContent = 'Enter between ' + usd(min) + ' and ' + money(b.available) + '.'; err.hidden = false; return; }
        if (!(await confirmBox('Send ' + money(amount) + ' in ' + coin + '?', 'To <span class="mono" style="word-break:break-all">' + esc(address) + '</span>', 'Yes, withdraw'))) return;
        try { await POST('/api/referrals/withdraw', { coin, address, amount }); toast('Withdrawal requested. We\'ll email you when it\'s paid.'); renderPage('earn', {}, { keepScroll: true }); } catch (ex) { apiErr(ex); }
      };
    };
  },
};

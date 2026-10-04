'use strict';
/*
 * app-zedapex.js: "More from Zedapex" cards and the Joinvoo / Replyvoo pages.
 * Claims here stay general and honest: no prices, no discounts, no live-looking numbers.
 * Animations are labelled "Example". Buttons open the product sites in a new tab.
 */

const ZX = { joinvoo: 'https://joinvoo.com', replyvoo: 'https://replyvoo.com' };
const ARW = '<svg><use href="#i-arrow"/></svg>';
const EXT = (name, label, cls, style) => '<a class="btn ' + (cls || 'b-w') + '" href="' + ZX[name] + '" target="_blank" rel="noopener"' + (style ? ' style="' + style + '"' : '') + '>' + label + '<svg><use href="#i-ext"/></svg></a>';

function stFilter() {
  let d = '<span class="fbar"></span>';
  const ks = ['tunde', 'wanjiku', 'kwame', 'thandi', 'sipho', 'fatou'];
  for (let i = 0; i < 8; i++) { const bot = i % 3 === 1; d += '<span class="fd' + (bot ? ' bot' : '') + '" style="--y:' + (12 + ((i * 29) % 74)) + 'px;animation-delay:-' + (i * 0.8).toFixed(1) + 's">' + (bot ? '🤖' : moji(ks[i % ks.length])) + '</span>'; }
  return '<div class="stg st-f">' + d + '<span class="fl fr">Real people ✓</span><span class="fl fx">Bots left out</span><span class="exl dark" style="right:8px;bottom:8px;left:auto;top:auto">Example</span></div>';
}
function stAds() {
  return '<div class="stg st-c"><small>Real joins per ad</small><div class="adbars"><span><i style="--w:86%"></i>Ad A</span><span><i style="--w:52%"></i>Ad B</span><span><i style="--w:24%"></i>Ad C</span></div><span class="exl" style="right:12px;top:12px;left:auto">Example</span></div>';
}
function stChat() {
  return '<div class="stg st-r"><div class="rb in">Hi, is the black dress still available? 👗</div><div class="rb ty"><i></i><i></i><i></i></div><div class="rb out">Yes! Sizes 10 and 12 are left. Here\'s the link to order 💛</div><div class="rb pay">👍 Thank you!</div><span class="exl dark" style="left:10px;top:8px">Example</span></div>';
}
function stAlways() {
  return '<div class="stg st-n"><b>Day and night</b><small>Replies don\'t wait for office hours</small><div class="bubs"><span>Is it available?</span><span>Yes! 💛</span></div></div>';
}
const XC = [
  { c: 'j', lg: 'jvLogo', k: 'Joinvoo · Tracking', t: 'See which ads bring real people.', p: 'Joinvoo tracks the Telegram joins your ads bring in, and leaves out bots and misclicks.', st: stFilter, go: 'joinvoo' },
  { c: 'r', lg: 'rvLogo', k: 'Replyvoo · AI replies', t: 'Answer every chat, fast.', p: 'Replyvoo\'s AI helper replies to the people who message you on Telegram.', st: stChat, go: 'replyvoo' },
  { c: 'jl', lg: 'jvLogo', k: 'Joinvoo · Smarter ads', t: 'Know which ad is worth it.', p: 'Compare your ads by the real subscribers they bring, not just clicks.', st: stAds, go: 'joinvoo' },
  { c: 'ry', lg: 'rvLogo', k: 'Replyvoo · Always on', t: 'Never leave a reply waiting.', p: 'Your broadcasts start conversations. Replyvoo can help answer them.', st: stAlways, go: 'replyvoo' },
];
function xCard(x) { return '<button type="button" class="xc ' + x.c + '" data-go="' + x.go + '"><span class="xh"><svg><use href="#' + x.lg + '"/></svg><span class="xk">' + x.k + '</span></span><h4>' + x.t + '</h4><p>' + x.p + '</p>' + x.st() + '<span class="lm3">Learn more' + ARW + '</span></button>'; }
function xsBlock() { const cards = XC.map(xCard).join(''); return '<div class="xsw"><div class="bh"><h3><svg width="22" height="22"><use href="#logo"/></svg>More from Zedapex</h3><button type="button" class="btn b-ghost xs" data-go="apps">See all apps</button></div><div class="xsm"><div class="xsm-in">' + cards + cards + '</div></div></div>'; }
function xsStart() { /* the cards animate with CSS only */ }

PAGES.apps = {
  title: 'Zedapex apps', sub: 'More tools for your Telegram business',
  async render(el) {
    el.innerHTML = '<div class="apps">' +
      '<div class="appc" style="background:radial-gradient(120% 100% at 0% 0%,#7B62FF,#5B3DF5 45%,#3B22C8);color:#fff"><span class="xh" style="display:flex;align-items:center;gap:10px"><svg width="42" height="42"><use href="#jvLogo"/></svg><b style="font-size:22px;letter-spacing:-.05em">Joinvoo</b><span class="pill" style="background:rgba(255,255,255,.16);color:#fff;margin-left:auto">Tracking</span></span><h3>Track every lead. Leave out the fakes.</h3><p>Joinvoo tracks the real Telegram joins your ads bring in, so you know which ads are worth paying for.</p>' + stFilter() + '<div class="row"><button type="button" class="btn b-w" data-go="joinvoo">Learn more' + ARW + '</button>' + EXT('joinvoo', 'Visit joinvoo.com', 'b-g') + '</div></div>' +
      '<div class="appc" style="background:#121110;color:#fff"><span class="xh" style="display:flex;align-items:center;gap:10px"><svg width="42" height="42"><use href="#rvLogo"/></svg><b style="font-size:22px;letter-spacing:-.05em">Replyvoo</b><span class="pill" style="background:#FFC21A;color:#121110;margin-left:auto">AI replies</span></span><h3>Reply to every chat. Fast.</h3><p>Replyvoo puts an AI helper on your Telegram chats that answers questions about your products, day and night.</p>' + stChat() + '<div class="row"><button type="button" class="btn" style="background:#FFC21A;color:#121110;padding:12px 18px" data-go="replyvoo">Learn more' + ARW + '</button>' + EXT('replyvoo', 'Visit replyvoo.com', 'b-g') + '</div></div></div>' +
      '<div class="trio"><div class="bh"><h3>Better together</h3><span class="pill p-blue">Separate tools from Zedapex</span></div><p class="muted" style="font-size:15px;max-width:62ch">Joinvoo shows which ads bring real people. Castvoo follows up with the right message. Replyvoo helps answer the replies. Each one works on its own, so use only what you need.</p>' +
      '<div class="trio-row"><div class="tnode on"><svg><use href="#jvLogo"/></svg><b>Joinvoo</b><small>Tracks real subscribers from ads</small></div><span class="tarr"></span><div class="tnode on"><svg><use href="#logo"/></svg><b>Castvoo</b><small>Broadcasts and follow-ups</small></div><span class="tarr"></span><div class="tnode on"><svg><use href="#rvLogo"/></svg><b>Replyvoo</b><small>AI replies to chats</small></div></div></div>';
  },
};

PAGES.joinvoo = {
  title: 'Joinvoo', sub: 'Lead tracking for media buyers',
  async render(el, q, alive) {
    el.innerHTML = '<div class="spg jvp"><button type="button" class="spback" data-go="apps">' + ARW + 'Zedapex apps</button>' +
      '<div class="sph"><div class="mesh" style="width:380px;height:380px;right:-10%;top:-30%;background:rgba(143,123,255,.45)"></div><div class="sc"><span class="brand"><svg><use href="#jvLogo"/></svg>Joinvoo</span><span class="chipx" style="background:#fff;border:1px solid #E4DEFF"><b style="background:#121110;color:#fff"><span class="dl" style="background:#C8F169"></span>Built for</b>people who buy ads for Telegram</span>' +
      '<h1>Track every lead. <span>Leave out the fakes.</span></h1><p class="lead">Ad platforms count clicks, including bots and accidental taps. <b style="color:var(--ink)">Joinvoo tracks the people who really join</b> your channel, group or bot, and which ad brought them.</p>' +
      '<div class="ctas">' + EXT('joinvoo', 'Visit joinvoo.com', 'b-jv') + '<button type="button" class="btn b-ghost" id="jvSee">Watch it work</button></div></div>' +
      '<div style="position:relative"><div class="pipe" id="jvPipe"></div><div class="sentm" id="jvSent"><i>✓</i>Counted for Ad 14</div></div></div>' +
      '<div class="sps" id="jvLive"><div class="hh"><span class="kk">Example</span><h2>Watch Joinvoo sort real people from fakes.</h2><p class="muted">Each click from your ad is checked. Real joins count for the ad that brought them. Bots and misclicks don\'t.</p></div><div class="sp2"><div class="ffeed" id="jvFeed"></div><div style="display:flex;flex-direction:column;gap:14px"><div class="fcount"><div><small>Real joins</small><b class="tnum" id="jvR" style="color:#2E7D57">0</b></div><div><small>Left out</small><b class="tnum" id="jvF" style="color:var(--bad)">0</b></div><div><small>Ads compared</small><b class="tnum">4</b></div></div>' + stFilter().replace('stg st-f', 'stg st-f" style="height:170px;background:linear-gradient(150deg,#5B3DF5,#3B22C8)') + '<span class="spx">Example animation. Not real data.</span></div></div></div>' +
      '<div class="sps"><div class="hh"><span class="kk">What it does</span><h2>Numbers a media buyer can trust.</h2></div><div class="fgrid">' + [['🎯', '#EFEBFF', 'Real joins', 'Channel joins, group joins and bot starts, matched to the ad.'], ['🚫', '#FFE3E3', 'Fakes left out', 'Bots and misclicks don\'t count.'], ['📊', '#E5F4FC', 'Compare ads', 'See which ad brings the most real people.'], ['🔗', '#FFF4D6', 'Tracking links', 'A link for each ad, set up in minutes.'], ['👛', '#E3F3EA', 'Simple wallet', 'Top up and pay as you go.'], ['🎁', '#EFEBFF', 'Referrals', 'Invite other buyers and earn.']].map((f) => '<div><span class="fi2" style="background:' + f[1] + '">' + f[0] + '</span><b>' + f[2] + '</b><small>' + f[3] + '</small></div>').join('') + '</div>' +
      '<div class="insight" style="background:linear-gradient(160deg,#fff,#EFEBFF);border-color:#E4DEFF"><svg width="40" height="40" style="flex:none"><use href="#logo"/></svg><p><b style="color:#4A2FE0">Using Castvoo already?</b> Castvoo start links show which ad brought each bot subscriber. Joinvoo goes further for people who spend on ads. They are separate tools with separate accounts and prices.</p></div></div>' +
      '<div class="endcta" style="background:radial-gradient(120% 120% at 0% 0%,#7B62FF,#5B3DF5 45%,#3B22C8);color:#fff"><div class="mesh" style="width:360px;height:360px;right:0;top:-50%;background:rgba(200,241,105,.25)"></div><div style="position:relative;display:flex;flex-direction:column;gap:12px"><h2>If you buy traffic, see what it really brings.</h2><p style="opacity:.85">Learn more and get started on joinvoo.com.</p></div>' + EXT('joinvoo', 'Go to Joinvoo', 'b-w', 'position:relative') + '</div></div>';
    $('#jvSee').onclick = () => $('#jvLive').scrollIntoView({ behavior: 'smooth', block: 'start' });
    const steps = [['📣', '#E5EDFF', '#2F6BFF', 'Clicked your ad', 'Example · Ad 14'], ['tg', '#E5F4FC', '', 'Joined your channel', 'Telegram'], ['✓', '#E3F3EA', '#2E7D57', 'Checked: real person', 'Not a bot, not a misclick']];
    const ks = ['tunde', 'wanjiku', 'kwame', 'thandi', 'sipho', 'fatou', 'emeka', 'ama'];
    const pipe = $('#jvPipe');
    pipe.innerHTML = steps.map((s) => '<div class="pst"><span class="pi" style="background:' + s[1] + ';color:' + s[2] + '">' + (s[0] === 'tg' ? '<svg width="38" height="38"><use href="#i-tg"/></svg>' : s[0]) + '</span><span class="pt"><b>' + s[3] + '</b><small>' + s[4] + '</small></span><span class="mav who"></span></div>').join('');
    const sts = $$('.pst', pipe);
    let si = 0, pk = 0;
    const pstep = () => {
      if (!alive()) return;
      if (si === 0) { const k = ks[pk++ % ks.length]; sts.forEach((x) => { x.classList.remove('on', 'done'); $('.who', x).innerHTML = moji(k); }); $('#jvSent').classList.remove('on'); }
      sts.forEach((x, i) => { x.classList.toggle('on', i === si); x.classList.toggle('done', i < si); });
      if (si === sts.length - 1) later(500, () => { const s = $('#jvSent'); if (s) s.classList.add('on'); });
      si = (si + 1) % sts.length;
      later(si === 0 ? 2600 : 1300, pstep);
    };
    pstep();
    let r = 0, f = 0, fi = 0;
    const feed = $('#jvFeed'), names = ['Tunde A.', 'Wanjiku K.', 'Kwame O.', 'Thandi N.', 'Sipho D.', 'Fatou N.', 'Emeka E.', 'Ama M.'], ads = ['Ad 14', 'Ad 5', 'Ad 9', 'Ad 2'];
    const frow = () => {
      if (!alive()) return;
      const bot = fi % 3 === 2, k = ks[fi % ks.length];
      const d = document.createElement('div'); d.className = 'frow';
      d.innerHTML = (bot ? '<span class="botf">🤖</span>' : mav(k, 36)) + '<span class="tx"><b>' + (bot ? 'Unknown click' : names[fi % names.length]) + '</b><small>Example · ' + ads[fi % ads.length] + '</small></span><span class="pill p-grey"><span class="spin" style="width:12px;height:12px;border-width:2px"></span>Checking</span>';
      feed.prepend(d); if (feed.children.length > 6) feed.lastChild.remove();
      later(700, () => { const pl = $('.pill', d); if (!pl) return; if (bot) { d.classList.add('bad'); pl.className = 'pill p-bad'; pl.textContent = 'Bot · left out'; f++; $('#jvF').textContent = fmt(f); } else { pl.className = 'pill p-ok'; pl.textContent = 'Real · counted ✓'; r++; $('#jvR').textContent = fmt(r); } });
      fi++; later(1300, frow);
    };
    frow();
  },
};

PAGES.replyvoo = {
  title: 'Replyvoo', sub: 'AI replies for your chats',
  async render(el, q, alive) {
    el.innerHTML = '<div class="spg rvp"><button type="button" class="spback" data-go="apps">' + ARW + 'Zedapex apps</button>' +
      '<div class="sph"><div class="sc"><span class="brand"><svg><use href="#rvLogo"/></svg>Replyvoo</span><span class="rvlive"><b><i></i>AI replies</b>for your Telegram chats</span>' +
      '<h1>Reply to every chat. <em>Even at 2am.</em></h1><p class="lead" style="color:#5E5A50">Slow replies lose sales. Replyvoo puts an AI helper on your chats that answers questions about your products and points people to the next step, while you get on with your day.</p>' +
      '<div class="ctas"><a class="btn b-rv" href="' + ZX.replyvoo + '" target="_blank" rel="noopener">Visit replyvoo.com<span class="ar"><svg><use href="#i-ext"/></svg></span></a><button type="button" class="btn b-rvg" id="rvSee">▶ Watch an example</button></div>' +
      '<div class="chs"><span><svg width="16" height="16"><use href="#i-tg"/></svg>Works with Telegram</span></div></div>' +
      '<div class="rvph" id="rvDemo"><div class="notch" style="background:#121110"></div><div class="scr"><div class="rv-top"><span class="tg-ava" style="background:#F6D9E6;color:#A3376B">AC</span><div style="flex:1;min-width:0"><b id="rvShop">Ada\'s Closet</b><small>● AI helper on · example</small></div><svg width="22" height="22"><use href="#i-tg"/></svg></div><div class="rv-bg" id="rvChat"></div></div></div></div>' +
      '<div class="sps"><div class="hh"><span class="kk">For Castvoo users</span><h2>Your broadcasts start conversations. Replyvoo helps finish them.</h2><p class="muted">Every broadcast brings replies like "How much?", "Is it available?" or "How do I pay?". Replyvoo can answer them quickly, in your customer\'s language.</p></div>' +
      '<div class="flow3"><div class="f3"><span class="fi3"><svg width="26" height="26"><use href="#logo"/></svg></span><b style="font-size:17px">You send</b><small>A broadcast from Castvoo</small></div><span class="tarr"></span><div class="f3"><span class="fi3">💬</span><b style="font-size:17px">They reply</b><small>Questions about your offer</small></div><span class="tarr"></span><div class="f3"><span class="fi3">⚡</span><b style="font-size:17px">AI answers</b><small>Using what you taught it</small></div><span class="tarr"></span><div class="f3"><span class="fi3">🙋</span><b style="font-size:17px">You step in</b><small>Whenever you want</small></div></div></div>' +
      '<div class="sps"><div class="fgrid">' + [['🤖', '#FFF4D6', 'AI helper', 'Learns your products, prices and tone.'], ['⚡', '#E3F3EA', 'Quick replies', 'Answers in seconds, not hours.'], ['🌍', '#EFEBFF', 'Many languages', 'Replies in the language people write in.'], ['🙋', '#E5F4FC', 'Take over any time', 'Jump into a chat yourself when it matters.'], ['🌙', '#FFE3E3', 'Day and night', 'People get answers outside office hours.'], ['🧠', '#FFF4D6', 'Gets better', 'Add answers to common questions as you go.']].map((f) => '<div><span class="fi2" style="background:' + f[1] + '">' + f[0] + '</span><b>' + f[2] + '</b><small>' + f[3] + '</small></div>').join('') + '</div><span class="spx">Replyvoo is a separate Zedapex tool with its own account and prices.</span></div>' +
      '<div class="endcta" style="background:#121110;color:#fff"><div style="display:flex;flex-direction:column;gap:12px"><h2>Let your chats answer themselves.</h2><p class="lead" style="color:#C9C3B4">Learn more and get started on replyvoo.com.</p></div><a class="btn" style="background:#FFC21A;color:#121110;padding:14px 22px" href="' + ZX.replyvoo + '" target="_blank" rel="noopener">Go to Replyvoo<svg><use href="#i-ext"/></svg></a></div></div>';
    $('#rvSee').onclick = () => $('#rvDemo').scrollIntoView({ behavior: 'smooth', block: 'center' });
    const SC = [
      { shop: 'Ada\'s Closet', ini: 'AC', col: '#F6D9E6', tc: '#A3376B', lines: [['c', 'Hi, is the black dress still available?'], ['t'], ['a', 'Yes! 💛 Sizes 10 and 12 are left. Would you like the link to order?'], ['c', 'Size 12 please'], ['t'], ['a', 'Great choice ✅ Here\'s the order page:', 'Order the black dress'], ['p', '👍 Thank you!']] },
      { shop: 'Nairobi Fit', ini: 'NF', col: '#DFF3E8', tc: '#2E7D57', lines: [['c', 'What\'s in the 30-day plan?'], ['t'], ['a', 'Daily workouts and a simple meal plan 💪 Want the sign-up link?'], ['c', 'Yes'], ['t'], ['a', 'Here you go 👇', 'Start the 30-day plan'], ['p', '🙌 Thanks!']] },
    ];
    let sci = 0;
    const play = () => {
      if (!alive()) return;
      const sc = SC[sci++ % SC.length], box = $('#rvChat'); if (!box) return;
      box.innerHTML = ''; $('#rvShop').textContent = sc.shop;
      const av = $('#rvDemo .tg-ava'); av.textContent = sc.ini; av.style.background = sc.col; av.style.color = sc.tc;
      let i = 0;
      const nx = () => {
        if (!alive() || !box.isConnected) return;
        $$('.rtyp', box).forEach((t) => t.remove());
        if (i >= sc.lines.length) { later(2600, play); return; }
        const l = sc.lines[i++]; let d;
        if (l[0] === 't') { d = document.createElement('div'); d.className = 'rtyp'; d.innerHTML = '<i></i><i></i><i></i>'; }
        else if (l[0] === 'p') { d = document.createElement('div'); d.className = 'rpaid'; d.textContent = l[1]; }
        else { d = document.createElement('div'); d.className = 'rm ' + l[0]; d.innerHTML = (l[0] === 'a' ? '<span class="who3">AI helper</span>' : '') + esc(l[1]) + (l[2] ? '<span class="lnk"><i>🔗</i>' + esc(l[2]) + '</span>' : ''); }
        box.appendChild(d);
        while (box.children.length > 9) box.firstChild.remove();
        later(l[0] === 't' ? 1100 : l[0] === 'c' ? 900 : 1500, nx);
      };
      nx();
    };
    play();
  },
};

'use strict';
/*
 * site.js: the public website (the "#" pages).
 *   siteInit()        draws everything once with the built-in defaults and starts the example animations
 *   siteApplyConfig() replaces prices, texts, FAQ, banners... with the values from /api/public/config
 *   siteAuthUI()      shows "Open dashboard" instead of "Log in" when someone is logged in
 * Animated phones and cards on this page are clearly labelled "Example". Never put live-looking
 * numbers here that are not inside a labelled example.
 */

const siteOn = () => !$('#v-site').hidden && !document.hidden;
let siteGuide = null;

/* "2 months free" (or "save 15%") worked out from the real plan prices. */
function yearSaveText() {
  const p0 = (CFG.plans || [])[0];
  if (!p0 || !p0.price_month || !p0.price_year) return '';
  const free = Math.round((p0.price_month * 12 - p0.price_year) / p0.price_month * 10) / 10;
  if (free < 0.5) return '';
  return Number.isInteger(free) ? free + ' months free' : 'save ' + Math.round((1 - p0.price_year / (p0.price_month * 12)) * 100) + '%';
}
/* "*word*" in admin texts = gradient emphasis. */
const emph = (s) => esc(s).replace(/\*([^*]+)\*/g, '<em class="gtext">$1</em>');

/* ---------- Language switcher (marketing texts only) ---------- */
const LANGS = { en: ['🇬🇧', 'English'], fr: ['🇫🇷', 'Français'], pt: ['🇵🇹', 'Português'], es: ['🇪🇸', 'Español'], ru: ['🇷🇺', 'Русский'] };
const SITE_T = {
  fr: { nf: 'Fonctionnalités', nh: 'Guide', na: 'IA', np: 'Tarifs', nq: 'FAQ', nl: 'Connexion', ns: 'Essai gratuit', hc: 'Diffusions, relances et IA au même endroit', h2c: 'Voir la mise en route en 40 s', t1: 'Sans carte bancaire', t2: 'Prêt en 5 minutes environ', t3: 'Annulable à tout moment',
    h1: 'Faites de votre Telegram <em class="gtext">une machine à vendre.</em>', hs: 'Castvoo accueille chaque nouvel abonné, relance au bon moment et envoie à chaque groupe le message écrit pour lui. Vos bots et canaux vendent, même pendant que vous dormez.', cta: 'Essai gratuit · 7 jours offerts' },
  pt: { nf: 'Recursos', nh: 'Guia', na: 'IA', np: 'Preços', nq: 'FAQ', nl: 'Entrar', ns: 'Começar grátis', hc: 'Transmissões, follow-ups e IA num só lugar', h2c: 'Ver a configuração em 40 s', t1: 'Sem cartão', t2: 'Pronto em cerca de 5 minutos', t3: 'Cancele quando quiser',
    h1: 'Transforme seu Telegram <em class="gtext">numa máquina de vendas.</em>', hs: 'O Castvoo dá boas-vindas a cada novo inscrito, faz follow-up na hora certa e envia a cada grupo a mensagem feita para ele. Seus bots e canais vendem até enquanto você dorme.', cta: 'Grátis · 7 dias por nossa conta' },
  es: { nf: 'Funciones', nh: 'Guía', na: 'IA', np: 'Precios', nq: 'FAQ', nl: 'Entrar', ns: 'Empezar gratis', hc: 'Difusiones, seguimientos e IA en un solo lugar', h2c: 'Ver la configuración en 40 s', t1: 'Sin tarjeta', t2: 'Listo en unos 5 minutos', t3: 'Cancela cuando quieras',
    h1: 'Convierte tu Telegram <em class="gtext">en una máquina de ventas.</em>', hs: 'Castvoo da la bienvenida a cada nuevo suscriptor, hace seguimiento a tiempo y envía a cada grupo el mensaje escrito para él. Tus bots y canales venden incluso mientras duermes.', cta: 'Gratis · 7 días por nuestra cuenta' },
  ru: { nf: 'Возможности', nh: 'Инструкция', na: 'ИИ', np: 'Цены', nq: 'FAQ', nl: 'Войти', ns: 'Начать бесплатно', hc: 'Рассылки, цепочки и ИИ в одном месте', h2c: 'Настройка за 40 секунд', t1: 'Без карты', t2: 'Запуск примерно за 5 минут', t3: 'Отмена в любой момент',
    h1: 'Превратите Telegram <em class="gtext">в машину продаж.</em>', hs: 'Castvoo приветствует каждого нового подписчика, вовремя напоминает и отправляет каждой группе написанное для неё сообщение. Ваши боты и каналы продают, даже пока вы спите.', cta: 'Бесплатно · 7 дней' },
};
const SITE_EN = {};
let siteLang = 'en';
function applyLang() {
  const d = siteLang === 'en' ? SITE_EN : SITE_T[siteLang];
  $$('[data-k]').forEach((e) => { if (d[e.dataset.k] != null) e.innerHTML = d[e.dataset.k]; });
  document.documentElement.lang = siteLang;
  siteHero();
  renderLsw();
}
function renderLsw() {
  const b = $('#lsw');
  b.innerHTML = '<button type="button" class="lsw-b" aria-haspopup="listbox" aria-expanded="false" aria-label="Language"><span class="f">' + LANGS[siteLang][0] + '</span><span class="n">' + LANGS[siteLang][1] + '</span></button><div class="lsw-m" hidden role="listbox">' +
    Object.keys(LANGS).map((k) => '<button type="button" data-l="' + k + '" class="' + (k === siteLang ? 'on' : '') + '"><span class="f">' + LANGS[k][0] + '</span>' + LANGS[k][1] + '</button>').join('') + '</div>';
  const btn = $('.lsw-b', b), m = $('.lsw-m', b);
  btn.onclick = (e) => { e.stopPropagation(); m.hidden = !m.hidden; btn.setAttribute('aria-expanded', String(!m.hidden)); };
  m.onclick = (e) => { const t = e.target.closest('[data-l]'); if (!t) return; siteLang = t.dataset.l; store.set('cv_lang', siteLang); applyLang(); };
}

/* ---------- Texts from the config ---------- */
function siteHero() {
  const c = CFG.content;
  const tr = siteLang === 'en' ? null : SITE_T[siteLang];
  $('#heroTitle').innerHTML = tr ? tr.h1 : emph(c.hero_title);
  $('#heroSub').textContent = tr ? tr.hs.replace(/<[^>]+>/g, '') : c.hero_subtitle;
  const cta = tr ? tr.cta : c.hero_cta;
  $('#heroCtaT').textContent = cta;
  $$('[data-ctat]').forEach((a) => { a.firstChild.nodeType === 3 ? (a.firstChild.textContent = cta) : (a.textContent = cta); });
}

let billYear = false;
function planFacts(p) {
  return [
    plural(p.connections, 'bot, channel or group', 'bots, channels or groups'),
    fmt(p.subscribers) + ' bot subscribers (channel members free)',
    fmt(p.ai_writes) + ' AI writes a month',
    plural(p.seats, 'team seat'),
  ];
}
function sitePlans() {
  const plans = CFG.plans || [];
  const box = $('#plansBox');
  const hot = plans.find((p) => p.popular) ? null : (plans[1] || plans[0] || {}).code;
  const loggedIn = !!(ME && ME.user);
  box.className = 'plans n' + Math.min(plans.length, 4);
  box.innerHTML = plans.map((p) => {
    const isHot = p.popular || p.code === hot;
    const price = billYear ? p.price_year : p.price_month;
    const perMonth = billYear && p.price_year ? usd(Math.round(p.price_year / 12 * 100) / 100) : '';
    const extra = (p.bullets || []).filter((b) => !/^\d/.test(String(b).trim()) && !/AI writes|team seat/i.test(b));
    return '<div class="plan' + (isHot ? ' hot' : '') + '">' + (isHot ? '<span class="pill badge">Most popular</span>' : '') +
      '<h3>' + esc(p.name) + '</h3><p class="desc">' + esc(p.tagline || '') + '</p>' +
      '<div class="price"><b class="tnum">' + usd(price) + '</b><span>/' + (billYear ? 'year' : 'month') + '</span></div>' +
      '<p class="note">' + (billYear ? 'Works out at ' + perMonth + ' a month' : '&nbsp;') + '</p>' +
      '<ul>' + planFacts(p).map((f) => '<li><svg><use href="#i-check"/></svg><b>' + esc(f) + '</b></li>').join('') +
      extra.map((b) => '<li><svg><use href="#i-check"/></svg>' + esc(b) + '</li>').join('') + '</ul>' +
      (loggedIn ? '<a class="btn ' + (isHot ? 'b-blue' : 'b-ghost') + ' full" href="#app/wallet">Choose in my dashboard</a>' : '<a class="btn ' + (isHot ? 'b-blue' : 'b-ghost') + ' full" href="#signup">Start free trial</a>') + '</div>';
  }).join('');
  // Yearly toggle label from the real prices
  const ys = yearSaveText();
  $('#billTog [data-b="y"]').innerHTML = 'Yearly' + (ys ? ' <small>' + ys + '</small>' : '');
  const trialPlan = (plans.find((p) => p.code === CFG.trial.plan) || {}).name || 'Growth';
  const bon = (CFG.topup_bonuses || []).filter((b) => b.bonus > 0);
  $('#prNotes').innerHTML =
    '<div class="prn"><span class="prni">' + icon('check') + '</span><span><b>Every plan:</b> unlimited broadcasts, auto follow-ups, tracked clicks and Cas the AI helper. No add-on fees.</span></div>' +
    '<div class="prn"><span class="prni">' + icon('gift') + '</span><span><b>' + fmt(CFG.trial.days) + '-day free trial of ' + esc(trialPlan) + '.</b> No card needed. Pick a plan any time.</span></div>' +
    '<div class="prn pay"><span class="prni">' + icon('wallet') + '</span><span><b>Pay from your Castvoo wallet</b> with the payment methods for your country' + (CFG.features.crypto !== false ? ', or crypto (USDT or Bitcoin)' : '') + '. Plans renew from the wallet.' +
      (bon.length ? '<span class="bonl">' + bon.map((b) => '<span class="pill p-ok">Top up ' + usd(b.min) + ', get ' + usd(b.bonus) + ' extra</span>').join('') + '</span>' : '') + '</span>' + (CFG.gatevoo ? gatevooBadge() : '') + '</div>';
}

function siteFaq() {
  let list = [];
  try { list = JSON.parse(CFG.content.faq || '[]'); } catch (_) { list = []; }
  if (!Array.isArray(list)) list = [];
  if (CFG.gatevoo) list = list.map((f) => (/how do i pay/i.test(f.q) && !/gatevoo/i.test(f.a) ? { ...f, a: f.a + ' Crypto payments go through Gatevoo, our secure crypto checkout.' } : f));
  const box = $('#faqBox');
  if (!list.length) { box.innerHTML = '<p class="muted" style="text-align:center">Questions? Email <a href="mailto:' + esc(CFG.support.email) + '">' + esc(CFG.support.email) + '</a>.</p>'; return; }
  box.innerHTML = list.map((f, i) => '<details' + (i === 0 ? ' open' : '') + '><summary>' + esc(f.q) + '<i>+</i></summary><p>' + esc(f.a) + '</p></details>').join('');
}

function siteReferral() {
  const r = CFG.referral || {};
  const rates = r.rates || [10, 20, 30];
  const sec = $('#refer');
  sec.hidden = CFG.features.referrals === false;
  $('#refText').textContent = 'Earn ' + rates[0] + ' to ' + rates[rates.length - 1] + '% of every plan payment made by people you invite, every month, for as long as they pay. Use your earnings on your own plan, or withdraw from ' + usd(r.min_withdraw || 300) + ' in USDT or Bitcoin.';
  const t2 = r.tier2_min || 5, t3 = r.tier3_min || 20;
  const rows = [[(t2 > 2 ? '1 to ' + (t2 - 1) : '1') + ' paying referral' + (t2 > 2 ? 's' : ''), 'Starter partner', rates[0]], [t2 + ' to ' + (t3 - 1) + ' paying referrals', 'Pro partner', rates[1]], [t3 + ' or more paying referrals', 'Elite partner', rates[2]]];
  $('#refTiers').innerHTML = rows.map((x) => '<div class="tier"><div><span>' + esc(x[0]) + '</span><small>' + x[1] + '</small></div><b>' + x[2] + '%</b></div>').join('');
}

function siteBanners() {
  const b = (CFG.banners || []).filter((x) => x.title || x.text);
  const box = $('#banners');
  box.innerHTML = b.map((x) => '<div class="banr rv"><span class="spk">' + icon('gift') + '</span><div style="flex:1;min-width:0"><b>' + esc(x.title) + '</b>' + (x.text ? '<p class="muted">' + esc(x.text) + '</p>' : '') + '</div>' + (x.link ? '<a class="btn b-blue sm" href="' + esc(safeLink(x.link)) + '">See offer</a>' : '') + '</div>').join('');
  box.className = 'wrap' + (b.length ? ' has' : '');
}
/* Only allow site anchors and http(s) links from admin texts. */
function safeLink(u) { const s = String(u || '').trim(); return /^(https?:\/\/|#|\/)/i.test(s) ? s : '#'; }

function siteAnnouncement() {
  const c = CFG.content;
  const on = String(c.announcement_on) === '1' && c.announcement_text;
  $('#annBar').hidden = !on;
  if (on) {
    $('#annText').textContent = c.announcement_text;
    const a = $('#annLink');
    a.hidden = !c.announcement_link;
    if (c.announcement_link) a.setAttribute('href', safeLink(c.announcement_link));
  }
}

function siteFooter() {
  $('#footTag').textContent = CFG.content.footer_tagline || '';
  const m = CFG.support.email || 'support@castvoo.com';
  $('#footMail').setAttribute('href', 'mailto:' + m);
  $('#footMail span').textContent = m;
  $('#footCopy').textContent = '© ' + new Date().getFullYear() + ' ' + (CFG.company.name || 'Zedapex');
}

function maintenanceBar() {
  const on = !!(CFG.features && CFG.features.maintenance);
  const bar = $('#maintBar');
  bar.hidden = !on;
  if (on) $('#maintText').textContent = CFG.content.maintenance_message || 'Castvoo is getting an upgrade. Sending is paused for a few minutes.';
}

function siteApplyConfig() {
  siteHero(); siteAnnouncement(); sitePlans(); siteFaq(); siteReferral(); siteBanners(); siteFooter(); maintenanceBar();
  $('#prTitle').innerHTML = emph(CFG.content.pricing_title || '');
  $('#prSub').textContent = CFG.content.pricing_subtitle || '';
}

function siteAuthUI() {
  const inn = !!(ME && ME.user);
  $$('[data-in]').forEach((e) => { e.hidden = !inn; });
  $$('[data-out]').forEach((e) => { e.hidden = inn; });
  $('#refCta').setAttribute('href', inn ? '#app/earn' : '#signup');
  sitePlans();
}

/* ---------- Help bubble ---------- */
function renderHelp(view) {
  const h = $('#helpHost');
  if (view !== 'site') { h.innerHTML = ''; return; }
  if ($('#helpB')) return;
  h.innerHTML = '<button type="button" class="help" id="helpB" aria-label="Help and support"><span class="mav hcas" data-cas="mini"></span><span class="hb"><svg><use href="#i-chat"/></svg></span></button>';
  paintCas(h);
  $('#helpB').onclick = () => {
    const c = $('.helpc'); if (c) { c.remove(); return; }
    const s = CFG.support || {};
    const d = document.createElement('div');
    d.className = 'helpc'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Help');
    d.innerHTML = '<div style="display:flex;align-items:center;gap:10px"><span style="width:44px" data-cas="happy"></span><div style="flex:1"><b style="font-size:17px;letter-spacing:-.02em">Need a hand?</b><br><small class="muted">The Castvoo team is here to help.</small></div><button type="button" class="ib" data-hx aria-label="Close"><svg><use href="#i-x"/></svg></button></div>' +
      '<p class="muted" style="font-size:14px">' + esc(s.reply_time || '') + '</p>' +
      (ME && ME.user ? '<a class="btn b-blue full" href="#app/help" data-hgo>' + icon('chat') + 'Chat with us</a>' : '') +
      '<a class="btn b-ghost full" href="mailto:' + esc(s.email) + '">' + icon('mail') + esc(s.email) + '</a>' +
      (s.telegram ? '<a class="btn b-ghost full" href="https://t.me/' + esc(String(s.telegram).replace(/^@/, '')) + '" target="_blank" rel="noopener">' + icon('tg') + '@' + esc(String(s.telegram).replace(/^@/, '')) + '</a>' : '') +
      (ME && ME.user ? '' : '<p class="hint" style="text-align:center">Have an account? <a href="#login" data-hgo>Log in</a> to chat with us.</p>');
    document.body.appendChild(d);
    paintCas(d);
    d.onclick = (e) => { if (e.target.closest('[data-hx]') || e.target.closest('[data-hgo]')) d.remove(); };
  };
}

/* ---------- Example animations ---------- */
const HP = [
  { img: '🔥 NEW IN', sub: 'New collection', t: '*The new collection is live* 🔥\nTap below to see it before anyone else.', b: ['See the collection', 'Best sellers'] },
  { img: '🎓 MODULE 4', sub: 'New lesson', t: '*New lesson is live* 🎓\nModule 4 is up. Start it in 2 minutes.', b: ['Start lesson', 'All modules'] },
  { img: '☀️ 3 TIPS', sub: 'Good morning', t: '*Good morning, family* ☀️\nToday\'s 3 tips are inside.', b: ['Read today\'s tips', 'Join the bot'] },
];
let hpi = 0;
function heroPhone() {
  const p = HP[hpi % HP.length];
  $('#heroScr').innerHTML = '<div class="tg-top"><span class="bk">‹</span><div class="tt"><b>Brand Updates ' + VF + '</b><small>channel</small></div><span class="tg-ava" style="background:var(--grad)"><svg viewBox="0 0 40 40"><use href="#logo"/></svg></span></div><div class="tg-bg" id="hpBg"><div class="tm in" style="opacity:.55"><b>Brand Updates</b><br>Yesterday\'s recap is pinned 📌<span class="ti">Yesterday</span></div></div><div class="tg-in"><span class="pc0">🔇</span><span class="fld" style="text-align:center">Mute</span></div>';
  setTimeout(() => {
    const bg = $('#hpBg'); if (!bg) return;
    const d = document.createElement('div'); d.className = 'tm in';
    d.innerHTML = '<div class="img shn"><div>' + p.img + '<small>' + p.sub + '</small></div></div>' + fmtMsg(p.t) + '<div class="meta"><span>Sent by Castvoo</span><span>09:00</span></div>';
    bg.appendChild(d);
    const bt = document.createElement('div'); bt.className = 'tbtns'; bt.innerHTML = p.b.map((x) => '<span>' + esc(x) + ' ↗</span>').join(''); bg.appendChild(bt);
    $('#heroSay').textContent = 'Posted at 9:00 ✅';
  }, 700);
  hpi++;
}
const HC = [['tunde', 'Tunde started your bot', 'Welcome sent instantly'], ['wanjiku', 'Wanjiku tapped a button', '"See the collection" · tracked'], ['thandi', 'Thandi came from your ad', 'Start link meta_ad14 · tagged'], ['kwame', 'Kwame got day 3', 'Auto follow-up · sent'], ['zainab', 'Zainab tapped a button', '"Best sellers" · tracked']];
let hci = 0;
function heroCards() {
  ['pc1', 'pc2', 'pc3'].forEach((id, j) => {
    const el = $('#' + id); el.classList.remove('on');
    setTimeout(() => { const c = HC[(hci + j) % HC.length]; el.innerHTML = mav(c[0]) + '<div><b>' + c[1] + '</b><small>' + c[2] + '</small></div>'; el.classList.add('on'); }, 350 + j * 500);
  });
  hci++;
}
const NC = [['tunde', 'Welcome sent to Tunde', '02:14 · <b>delivered</b>'], ['wanjiku', 'Day 3 follow-up sent', '03:00 · <b>delivered</b>'], ['kwame', 'Kwame tapped "See the collection"', '03:12 · <b>tracked click</b>'], ['thandi', 'Thandi started your bot', '04:40 · <b>welcome sent</b>'], ['zainab', 'Morning post scheduled', '06:00 · <b>9am local time</b>']];
let nci = 0;
function nightTick() {
  ['nc1', 'nc2'].forEach((id, j) => {
    const el = $('#' + id); el.classList.remove('on');
    setTimeout(() => { const c = NC[(nci + j) % NC.length]; el.innerHTML = mav(c[0]) + '<div>' + c[1] + '<small>' + c[2] + '</small></div>'; el.classList.add('on'); }, 400 + j * 600);
  });
  nci++;
}
const B_AI = [
  ['"Welcome message for new members, warm, one button"', 'Welcome in 👋 Every morning you get one useful tip here.\n\nStart with our most-saved post below.\n\n[ Read the top post → ]'],
  ['"Translate it to French"', 'Bienvenue 👋 Chaque matin, tu reçois ici une astuce utile.\n\nCommence par notre post le plus enregistré.\n\n[ Lire le meilleur post → ]'],
  ['"Make it shorter"', 'Welcome 👋 One useful tip every morning. Start with our top post below.\n\n[ Read it → ]'],
];
let bk = 0, bkIv = null;
function bAiTick() {
  const q = B_AI[bk % 3][0], t = B_AI[bk % 3][1];
  $('#bAiQ').textContent = q;
  const o = $('#bAiT'); let k = 0; o.textContent = ''; bk++;
  clearInterval(bkIv);
  if (RM) { o.textContent = t; return; }
  o.classList.add('typing');
  bkIv = setInterval(() => { k += 2; o.textContent = t.slice(0, k); if (k >= t.length) { clearInterval(bkIv); o.classList.remove('typing'); } }, 24);
}
const AIX = [
  { p: 'Write a broadcast for our new collection. Short, exciting, one button.', o: '🔥 The new collection is live.\n\nTwelve new pieces, made in small batches. Last time the favourites were gone in two days.\n\n[ See the collection → ]' },
  { p: 'A welcome follow-up for my fitness coaching bot. Goal: book a paid plan.', o: 'Instantly · "Welcome in 💪 Here\'s your free 10-minute starter workout."\nDay 1 · The 3 habits that matter more than the gym\nDay 3 · What a member changed in 30 days\nDay 5 · How the coaching plan works\nDay 7 · "Ready to start? Book your plan" + button\n\n✓ 5 messages ready to check and switch on.' },
  { p: 'Translate the welcome message to French, keep it warm.', o: 'Bienvenue dans la famille 👋\n\nIci, tu reçois chaque matin un conseil simple et utile. Commence par notre post le plus enregistré.\n\n[ Lire le post → ]' },
  { p: 'Make this friendlier: "Payment is due today. Pay now."', o: 'Hi there 👋 Just a friendly reminder that your payment is due today.\n\nIt only takes a minute: tap below and you\'re all set. Thank you! 💙\n\n[ Pay now → ]' },
];
let aiT = null, aiAuto = 0;
function aiShow(i) {
  $$('#aiTabs .aitab').forEach((b, j) => b.classList.toggle('on', j === i));
  $('#aiPrompt').textContent = AIX[i].p;
  const o = $('#aiOut'); clearInterval(aiT);
  const full = AIX[i].o;
  if (RM) { o.textContent = full; return; }
  let k = 0; o.textContent = ''; o.classList.add('typing');
  aiT = setInterval(() => { k += 3; o.textContent = full.slice(0, k); if (k >= full.length) { clearInterval(aiT); o.classList.remove('typing'); } }, 22);
}

function siteInit() {
  $$('[data-k]').forEach((e) => { SITE_EN[e.dataset.k] = e.innerHTML; });
  const s = store.get('cv_lang'); if (LANGS[s]) siteLang = s;
  applyLang();
  siteApplyConfig();
  paintAll($('#v-site'));

  addEventListener('scroll', () => { $('#hdr').classList.toggle('sc', scrollY > 8); const hb = $('#helpB'); if (hb) hb.classList.toggle('show', scrollY > 600); }, { passive: true });
  $('#burger').onclick = () => $('#mnav').classList.add('open');
  $('#mnav').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) $('#mnav').classList.remove('open'); });
  document.addEventListener('click', () => { const m = $('#lsw .lsw-m'); if (m) m.hidden = true; });

  $('#billTog').onclick = (e) => { const b = e.target.closest('[data-b]'); if (!b) return; $$('#billTog button').forEach((x) => x.classList.toggle('on', x === b)); billYear = b.dataset.b === 'y'; sitePlans(); };
  $('#aiTabs').onclick = (e) => { const b = e.target.closest('[data-i]'); if (b) { aiAuto = +b.dataset.i; aiShow(aiAuto); } };

  // Example animations (they pause when the site is hidden)
  heroPhone(); heroCards(); nightTick();
  setInterval(() => { if (siteOn()) heroCards(); }, 3200);
  setInterval(() => { if (siteOn()) { $('#heroSay').textContent = 'Posting to your channel 📣'; heroPhone(); } }, 9600);
  setInterval(() => { if (siteOn()) nightTick(); }, 4000);
  $('#bcList').innerHTML = [['tunde', 'Tunde'], ['wanjiku', 'Wanjiku'], ['kwame', 'Kwame'], ['thandi', 'Thandi']].map((x) => '<div class="bc-row">' + mav(x[0]) + x[1] + '<span class="ck">✓✓</span></div>').join('');
  let bi = 0; const bcRows = $$('#bcList .bc-row');
  setInterval(() => { if (!siteOn()) return; bcRows.forEach((r, i) => r.classList.toggle('on', i < bi)); bi = (bi + 1) % (bcRows.length + 2); }, 650);
  const sgSets = [[0, 1], [2], [3], [4], [5]], sgCounts = [3912, 1806, 1288, 964, 2140]; let sk = 0; const sgEls = $$('#sgx span');
  const sgTick = () => { sgEls.forEach((e, i) => e.classList.toggle('on', sgSets[sk].includes(i))); countTo($('#sgN'), sgCounts[sk], 700); sk = (sk + 1) % sgSets.length; };
  sgTick(); setInterval(() => { if (siteOn()) sgTick(); }, 2200);
  $('#clks').innerHTML = ['Lagos shop', 'Nairobi shop', 'Joburg shop'].map((c, i) => '<div class="clk"><svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="21" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="2.5"/><line class="hh" x1="24" y1="24" x2="24" y2="13" stroke="#fff" stroke-width="3" stroke-linecap="round" style="animation-delay:-' + (i * 12) + 's"/><line class="hm" x1="24" y1="24" x2="24" y2="8" stroke="#CFE0FF" stroke-width="2" stroke-linecap="round" style="animation-delay:-' + (i * 2) + 's"/><circle cx="24" cy="24" r="2.5" fill="#fff"/></svg>' + c + '<small>09:00</small></div>').join('');
  bAiTick(); setInterval(() => { if (siteOn()) bAiTick(); }, 8000);
  $('#teamStack').innerHTML = mav('ejiro', 36) + mav('zainab', 36) + mav('emeka', 36);
  $('#teamRq').innerHTML = mav('zainab', 34) + '<div><b>Zainab</b><br><span class="muted">wants to send "New collection"</span></div><span class="act"><span class="apb">Approve</span></span>';
  setInterval(() => { if (!siteOn()) return; const a = $('#teamRq .act'); a.innerHTML = '<span class="pill p-ok" style="animation:pop .4s var(--ease)">✓ Approved</span>'; setTimeout(() => { a.innerHTML = '<span class="apb">Approve</span>'; }, 2200); }, 5000);
  aiShow(0); setInterval(() => { if (!siteOn()) return; aiAuto = (aiAuto + 1) % AIX.length; aiShow(aiAuto); }, 9500);
  siteGuide = guide($('#siteGuide'));
}

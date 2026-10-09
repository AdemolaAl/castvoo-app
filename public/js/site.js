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

/* "2 months free" (or "save 15%") worked out from the real plan prices (the first paid plan). */
function yearSaveText() {
  const p0 = (CFG.plans || []).find((p) => p.price_month > 0);
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
  fr: { nf: 'Fonctionnalités', nh: 'Guide', na: 'IA', np: 'Tarifs', nb: 'Blog', nq: 'FAQ', nl: 'Connexion', ns: 'Essai gratuit', hc: 'Accueil · Diffusions · Relances', hw: 'Voir comment ça marche', h2c: 'Voir la mise en route en 40 s', t1: 'Sans carte bancaire', t2: 'Offre gratuite pour 1 canal', t3: 'Prêt en 5 minutes environ',
    h1: 'Accueillez. Diffusez. Relancez. <em class="gtext">Tout en pilote automatique.</em>', hs: 'Accueillez chaque personne qui demande à rejoindre, envoyez des diffusions à tous vos abonnés et créez des relances programmées avec boutons et liens dans un éditeur simple. Cas, l\'assistant IA, écrit les messages.', cta: 'Essai gratuit de 7 jours', f1: 'Bot d\'accueil', f2: 'Diffusions', f3: 'Relances programmées', f4: 'Éditeur de flux', f5: 'Rédacteur IA' },
  pt: { nf: 'Recursos', nh: 'Guia', na: 'IA', np: 'Preços', nb: 'Blog', nq: 'FAQ', nl: 'Entrar', ns: 'Começar grátis', hc: 'Boas-vindas · Transmissões · Follow-ups', hw: 'Ver como funciona', h2c: 'Ver a configuração em 40 s', t1: 'Sem cartão', t2: 'Plano grátis para 1 canal', t3: 'Pronto em cerca de 5 minutos',
    h1: 'Dê boas-vindas. Transmita. Faça follow-up. <em class="gtext">Tudo no automático.</em>', hs: 'Dê boas-vindas a todos que pedem para entrar, envie transmissões para todos os seus inscritos e crie follow-ups programados com botões e links num editor simples. Cas, o assistente de IA, escreve as mensagens.', cta: 'Teste grátis de 7 dias', f1: 'Bot de boas-vindas', f2: 'Transmissões', f3: 'Follow-ups', f4: 'Editor de fluxos', f5: 'Redator IA' },
  es: { nf: 'Funciones', nh: 'Guía', na: 'IA', np: 'Precios', nb: 'Blog', nq: 'FAQ', nl: 'Entrar', ns: 'Empezar gratis', hc: 'Bienvenida · Difusiones · Seguimientos', hw: 'Ver cómo funciona', h2c: 'Ver la configuración en 40 s', t1: 'Sin tarjeta', t2: 'Plan gratis para 1 canal', t3: 'Listo en unos 5 minutos',
    h1: 'Saluda. Difunde. Haz seguimiento. <em class="gtext">Todo en automático.</em>', hs: 'Da la bienvenida a quien pide unirse, envía difusiones a todos tus suscriptores y crea seguimientos programados con botones y enlaces en un editor sencillo. Cas, el asistente de IA, escribe los mensajes.', cta: 'Prueba gratis de 7 días', f1: 'Bot de bienvenida', f2: 'Difusiones', f3: 'Seguimientos', f4: 'Editor de flujos', f5: 'Redactor IA' },
  ru: { nf: 'Возможности', nh: 'Инструкция', na: 'ИИ', np: 'Цены', nb: 'Блог', nq: 'FAQ', nl: 'Войти', ns: 'Начать бесплатно', hc: 'Приветствие · Рассылки · Цепочки', hw: 'Как это работает', h2c: 'Настройка за 40 секунд', t1: 'Без карты', t2: 'Бесплатный план для 1 канала', t3: 'Запуск примерно за 5 минут',
    h1: 'Приветствуйте. Рассылайте. Напоминайте. <em class="gtext">Всё на автопилоте.</em>', hs: 'Приветствуйте каждого, кто подал заявку, отправляйте рассылки всем подписчикам и собирайте цепочки сообщений по расписанию с кнопками и ссылками в простом конструкторе. Cas, ИИ-помощник, пишет тексты.', cta: '7 дней бесплатно', f1: 'Бот-приветствие', f2: 'Рассылки', f3: 'Цепочки', f4: 'Конструктор', f5: 'ИИ-копирайтер' },
};
const SITE_EN = {};
let siteLang = 'en';
/*
 * The first language on a first visit: the browser's languages (navigator.languages, in the visitor's order), the
 * first one we have by its main part ("pt-BR" → pt, "fr-CA" → fr), else English. Pure, so it is unit tested.
 * A language picked in the switcher (localStorage cv_lang) always wins. Never the country or the IP address.
 */
function browserLang(langs, supported) {
  const list = Array.isArray(langs) ? langs : langs ? [langs] : [];
  for (const l of list) {
    const p = String(l || '').trim().toLowerCase().split(/[-_]/)[0];
    if (p && Object.prototype.hasOwnProperty.call(supported, p)) return p;
  }
  return 'en';
}
function navLangs() {
  try { return (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || navigator.userLanguage || '']); } catch (_) { return []; }
}
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
  const lim = (v, one, many) => (v < 0 ? 'Unlimited ' + many : plural(v, one, many));
  if (!p.price_month && !p.price_year) {
    return [
      plural(p.connections, 'channel or group', 'channels or groups') + ' + your welcome bot',
      fmt(p.join_requests ?? 500) + ' join requests a month',
      '1 welcome message, auto-approve',
    ];
  }
  return [
    plural(p.connections, 'bot, channel or group', 'bots, channels or groups'),
    (p.join_requests < 0 ? 'Unlimited' : fmt(p.join_requests ?? 0)) + ' join requests a month',
    p.flows != null ? lim(p.flows, 'Welcome Flow', 'Welcome Flows') + (p.flow_steps != null ? ', ' + (p.flow_steps < 0 ? 'unlimited' : fmt(p.flow_steps)) + ' steps each' : '') : '',
    fmt(p.subscribers) + ' bot subscribers (channel members free)',
    fmt(p.ai_writes) + ' AI writes a month',
    plural(p.seats, 'team seat'),
  ].filter(Boolean);
}
function sitePlans() {
  const plans = CFG.plans || [];
  const box = $('#plansBox');
  const hot = plans.find((p) => p.popular) ? null : (plans[1] || plans[0] || {}).code;
  const loggedIn = !!(ME && ME.user);
  box.className = 'plans n' + Math.min(plans.length, 4);
  box.innerHTML = plans.map((p) => {
    const isHot = p.popular || p.code === hot;
    const free = !p.price_month && !p.price_year;
    const price = billYear ? p.price_year : p.price_month;
    const perMonth = billYear && p.price_year ? usd(Math.round(p.price_year / 12 * 100) / 100) : '';
    const facts = planFacts(p);
    const extra = (p.bullets || []).filter((b) => !/^\d/.test(String(b).trim()) && !/AI writes|team seat|join requests|welcome message|welcome bot|auto-approve|Welcome Flows/i.test(b));
    if (free) extra.push('Ends with "Free welcome bot by Castvoo.com"');
    return '<div class="plan' + (isHot ? ' hot' : '') + (free ? ' free' : '') + '">' + (isHot ? '<span class="pill badge">Most popular</span>' : '') +
      '<h3>' + esc(p.name) + '</h3><p class="desc">' + esc(p.tagline || '') + '</p>' +
      '<div class="price"><b class="tnum">' + usd(price) + '</b><span>' + (free ? ' forever' : '/' + (billYear ? 'year' : 'month')) + '</span></div>' +
      '<p class="note">' + (free ? 'No card. No trial clock.' : billYear ? 'Works out at ' + perMonth + ' a month' : '&nbsp;') + '</p>' +
      '<ul>' + facts.map((f) => '<li><svg><use href="#i-check"/></svg><b>' + esc(f) + '</b></li>').join('') +
      extra.map((b) => '<li><svg><use href="#i-check"/></svg>' + esc(b) + '</li>').join('') + '</ul>' +
      (loggedIn ? '<a class="btn ' + (isHot ? 'b-blue' : 'b-ghost') + ' full" href="#app/wallet">' + (free ? 'See my plan' : 'Choose in my dashboard') + '</a>' : '<a class="btn ' + (isHot ? 'b-blue' : 'b-ghost') + ' full" href="#signup">' + (free ? 'Start free' : 'Start free trial') + '</a>') + '</div>';
  }).join('');
  // Yearly toggle label from the real prices
  const ys = yearSaveText();
  $('#billTog [data-b="y"]').innerHTML = 'Yearly' + (ys ? ' <small>' + ys + '</small>' : '');
  const trialPlan = (plans.find((p) => p.code === CFG.trial.plan) || {}).name || 'Growth';
  const bon = (CFG.topup_bonuses || []).filter((b) => b.bonus > 0);
  $('#prNotes').innerHTML =
    '<div class="prn"><span class="prni">' + icon('check') + '</span><span><b>Every paid plan:</b> Welcome Flows with follow-ups, unlimited broadcasts, tracked clicks and Cas the AI helper. No setup fees.</span></div>' +
    (CFG.billing && Number(CFG.billing.seat_price) > 0 ? '<div class="prn"><span class="prni">' + icon('plus') + '</span><span><b>Extra team seats ' + usd(CFG.billing.seat_price) + '/month on any paid plan.</b> Add them in Settings → Team, paid from your wallet with your plan. Lower the number any time.</span></div>' : '') +
    '<div class="prn"><span class="prni">' + icon('gift') + '</span><span><b>' + fmt(CFG.trial.days) + '-day free trial of ' + esc(trialPlan) + '.</b> No card needed. Pick a plan any time, or stay on Free when the trial ends: your welcome keeps running.</span></div>' +
    '<div class="prn"><span class="prni">' + icon('users') + '</span><span><b>1 setup helper included on every plan, Free too.</b> Invite your media buyer or a friend to set up your account with their own login. No password sharing, no seat used, and you remove them any time.</span></div>' +
    '<div class="prn"><span class="prni">' + icon('chat') + '</span><span><b>24/7 customer support on every plan.</b> AI support agents answer in your dashboard in seconds, day and night, and our human team steps in whenever you need a person. The Free plan includes a few instant AI chats a month.</span></div>' +
    '<div class="prn"><span class="prni">' + icon('clock') + '</span><span><b>Join requests reset every month.</b> Over your plan\'s number (plus a little extra), people are still let in, but your welcome pauses until next month or an upgrade.</span></div>' +
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
  $('#refText').textContent = 'Earn ' + rates[0] + ' to ' + rates[rates.length - 1] + '% of every plan payment made by people you invite, every month, for as long as they pay. Use it on your plan, or withdraw from ' + usd(r.min_withdraw || 300) + ' in USDT or Bitcoin.';
  const t2 = r.tier2_min || 5, t3 = r.tier3_min || 20;
  const rows = [[(t2 > 2 ? '1 to ' + (t2 - 1) : '1') + ' paying referral' + (t2 > 2 ? 's' : ''), 'Bronze partner', rates[0]], [t2 + ' to ' + (t3 - 1) + ' paying referrals', 'Silver partner', rates[1]], [t3 + ' or more paying referrals', 'Gold partner', rates[2]]];
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

/* "From the blog": the 3 newest posts (GET /api/public/blog/latest), as plain links crawlers can follow. */
let blogLoaded = false;
function siteBlog() {
  const sec = $('#fromBlog');
  if (!sec || blogLoaded || !CFG.features || !CFG.features.blog) { if (sec && CFG.features && CFG.features.blog === false) sec.hidden = true; return; }
  blogLoaded = true;
  fetch('/api/public/blog/latest', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : { posts: [] })).then((d) => {
    const posts = (d && d.posts) || [];
    if (!posts.length) return;
    const day = (x) => { const t = new Date(x); return isNaN(t) ? '' : t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); };
    $('#blogLatest').innerHTML = posts.map((p) => '<article class="hbc"><a class="hbc-i" href="' + esc(p.url) + '" tabindex="-1" aria-hidden="true"><img src="' + esc(p.image) + '" alt="" width="1200" height="630" loading="lazy" decoding="async"></a>' +
      '<div class="hbc-b">' + (p.category ? '<span class="hbc-c">' + esc(p.category) + '</span>' : '') + '<h3><a href="' + esc(p.url) + '">' + esc(p.title) + '</a></h3><p>' + esc(p.description) + '</p>' +
      '<span class="hbc-m">' + esc(day(p.date)) + ' · ' + esc(p.reading_time) + ' min read</span></div></article>').join('');
    sec.hidden = false;
  }).catch(() => {});
}

function siteApplyConfig() {
  siteBlog();
  siteHero(); siteAnnouncement(); sitePlans(); siteFaq(); siteReferral(); siteBanners(); siteFooter(); maintenanceBar(); vooLinks();
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

/* ---------- VooSquare: "Part of VooSquare" links and the shared support widget ---------- */
function vooLinks() {
  const v = CFG.voo;
  $$('[data-voo-app]').forEach((a) => { a.hidden = !v; if (v) a.href = v.app_url; });
}
/*
 * On the public website the VooSquare support widget (one inbox for every Zedapex tool) replaces our help bubble.
 * Inside the dashboard, Help is our own support chat, which is copied into the same VooSquare inbox.
 * Returns true when the widget is in use.
 */
function vooWidget(show) {
  const v = CFG.voo;
  if (!v || !v.widget_src) return false;
  if (window.__cvVsWidget === 'failed') return false; // blocked or down: fall back to our own help bubble
  if (!window.__cvVsWidget && show) {
    window.__cvVsWidget = true;
    const before = new Set(document.body.children);
    const sc = document.createElement('script');
    sc.src = v.widget_src; sc.defer = true;
    sc.setAttribute('data-product', 'castvoo');
    sc.setAttribute('data-color', '#2F6BFF');
    if (ME && ME.user) { if (ME.user.email) sc.setAttribute('data-email', ME.user.email); if (ME.user.name) sc.setAttribute('data-name', ME.user.name); }
    const fail = () => { if (window.__cvVsWidget === 'failed') return; window.__cvVsWidget = 'failed'; renderHelp(VIEW); };
    const tag = () => { let found = false; for (const el of document.body.children) if (!before.has(el) && el.tagName === 'DIV' && el.shadowRoot && !el.id) { el.setAttribute('data-vs-widget', ''); el.hidden = VIEW !== 'site'; found = true; } return found; };
    // The widget may draw a moment after its script runs. If nothing appears, show our own bubble.
    sc.onload = () => { if (!tag()) setTimeout(() => { if (!tag()) fail(); }, 4000); };
    sc.onerror = fail;
    document.body.appendChild(sc);
  }
  $$('[data-vs-widget]').forEach((el) => { el.hidden = !show; });
  return true;
}

/* ---------- Help bubble ---------- */
function renderHelp(view) {
  const h = $('#helpHost');
  if (vooWidget(view === 'site')) { h.innerHTML = ''; return; }
  if (view !== 'site') { h.innerHTML = ''; return; }
  const ag = CFG.site_chat && CFG.site_chat.agent && CFG.site_chat.agent.avatar ? CFG.site_chat.agent : null;
  if ($('#helpB')) {
    // The site config may arrive after the button was drawn: show the agent's face once we know it.
    const cas = $('#helpB .hcas');
    if (ag && cas) { const im = document.createElement('img'); im.className = 'mav hface'; im.src = ag.avatar; im.alt = ''; im.width = 44; im.height = 44; cas.replaceWith(im); }
    return;
  }
  h.innerHTML = '<button type="button" class="help" id="helpB" aria-label="Help and 24/7 support">' + (ag ? '<img class="mav hface" src="' + esc(ag.avatar) + '" alt="" width="44" height="44">' : '<span class="mav hcas" data-cas="mini"></span>') + '<span class="hb"><svg><use href="#i-chat"/></svg></span></button>';
  paintCas(h);
  $('#helpB').onclick = () => {
    const c = $('.helpc'); if (c) { c.remove(); return; }
    if (CFG.site_chat) return openSiteChat();
    const s = CFG.support || {};
    const d = document.createElement('div');
    d.className = 'helpc'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Help');
    d.innerHTML = '<div style="display:flex;align-items:center;gap:10px"><span style="width:44px" data-cas="happy"></span><div style="flex:1"><b style="font-size:17px;letter-spacing:-.02em">Need a hand?</b><br><small class="muted">24/7 customer support, with our human team on call.</small></div><button type="button" class="ib" data-hx aria-label="Close"><svg><use href="#i-x"/></svg></button></div>' +
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

/* ---------- Website chat (visitors): product and pricing answers, no account access ---------- */
const SITECHAT = { msgs: [], busy: false };
function openSiteChat() {
  const s = CFG.support || {};
  const ag = (CFG.site_chat && CFG.site_chat.agent) || { name: 'Castvoo', avatar: null };
  const d = document.createElement('div');
  d.className = 'helpc sitechat'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Chat with Castvoo');
  const face = (cls) => ag.avatar ? '<img class="' + cls + '" src="' + esc(ag.avatar) + '" alt="" width="40" height="40">' : '<span class="' + cls + '" data-cas="mini"></span>';
  d.innerHTML = '<div class="sc-h">' + face('sc-ava') + '<div style="flex:1;min-width:0"><b>' + esc(ag.name) + ' from Castvoo</b><small><span class="sdot"></span><span><b>24/7 customer support</b> · AI assistant · replies in seconds</span></small></div><button type="button" class="ib" data-hx aria-label="Close"><svg><use href="#i-x"/></svg></button></div>' +
    '<div class="sc-l" id="scL" aria-live="polite"></div>' +
    '<div class="sc-q" id="scQ">' + ['What does Castvoo do?', 'How much does it cost?', 'How do I pay from Nigeria?', 'Can I see who read my message?'].map((q) => '<button type="button" data-q>' + esc(q) + '</button>').join('') + '</div>' +
    '<form class="sc-f" id="scF"><input class="inp" id="scI" maxlength="1000" placeholder="Ask about Castvoo…" aria-label="Your question" autocomplete="off"><button type="submit" class="btn b-blue" aria-label="Send"><svg><use href="#i-send"/></svg></button></form>' +
    '<div class="sc-foot"><a class="btn b-blue sm" href="#signup" data-hgo>Start free</a>' + (ME && ME.user ? '<a href="#app/help" data-hgo>Account question? Open Help</a>' : '<a href="mailto:' + esc(s.email) + '">' + esc(s.email) + '</a>') + '</div>' +
    (CFG.site_chat && CFG.site_chat.powered_by ? '<div class="sc-pwr">' + poweredBy(CFG.site_chat.powered_by) + '</div>' : '');
  document.body.appendChild(d);
  paintCas(d);
  const L = $('#scL', d);
  const draw = () => {
    const intro = '<div class="scm a">' + '<div class="cb">Hi! I\'m ' + esc(ag.name) + '. Ask me anything about Castvoo: what it does, prices, payments or setup.</div></div>';
    L.innerHTML = intro + SITECHAT.msgs.map((m) => '<div class="scm ' + (m.role === 'user' ? 'u' : 'a') + '"><div class="cb">' + esc(m.content).replace(/\n/g, '<br>') + '</div></div>').join('') +
      (SITECHAT.busy ? '<div class="scm a"><div class="cb"><span class="tg-typing in"><i></i><i></i><i></i></span></div></div>' : '');
    $('#scQ', d).hidden = SITECHAT.msgs.length > 0;
    L.scrollTop = L.scrollHeight;
  };
  const ask = async (text) => {
    const t = String(text || '').trim();
    if (!t || SITECHAT.busy) return;
    const history = SITECHAT.msgs.slice(-10);
    SITECHAT.msgs.push({ role: 'user', content: t });
    SITECHAT.busy = true; draw();
    try {
      const r = await POST('/api/public/chat', { message: t, history });
      SITECHAT.busy = false;
      for (const [i, b] of r.bubbles.entries()) {
        if (i) { SITECHAT.busy = true; draw(); await new Promise((ok) => setTimeout(ok, Math.min(1800, 500 + b.length * 12))); SITECHAT.busy = false; }
        SITECHAT.msgs.push({ role: 'assistant', content: b }); draw();
      }
    } catch (ex) {
      SITECHAT.busy = false;
      SITECHAT.msgs.push({ role: 'assistant', content: (ex && ex.message) || 'Sorry, chat is busy. Email us and we\'ll help.' });
      draw();
    }
  };
  draw();
  $('#scF', d).onsubmit = (e) => { e.preventDefault(); const i = $('#scI', d); const v = i.value; i.value = ''; ask(v); };
  d.onclick = (e) => {
    if (e.target.closest('[data-hx]') || e.target.closest('[data-hgo]')) { d.remove(); return; }
    const q = e.target.closest('[data-q]'); if (q) ask(q.textContent);
  };
  setTimeout(() => { const i = $('#scI', d); if (i && window.matchMedia('(pointer:fine)').matches) i.focus(); }, 50);
}

/* ---------- Example animations ---------- */
/* Hero phone: join request -> welcome -> "Tap to start" -> let in, then a broadcast and a Day 2 follow-up.
   The three floating cards and the dark bubble follow the same timeline. Clearly labelled "Example". */
const HJ = [['tunde', 'Tunde', 'meta_ad14'], ['wanjiku', 'Wanjiku', 'tiktok_ad5'], ['thandi', 'Thandi', 'meta_ad9'], ['kwame', 'Kwame', 'ads_gh2']];
let hji = 0, hjT = [];
function heroJoin() {
  hjT.forEach(clearTimeout); hjT = [];
  const scr = $('#heroScr'); if (!scr) return;
  const [face, name, src] = HJ[hji++ % HJ.length];
  const card = (id, html) => { const el = $('#' + id); el.innerHTML = mav(face) + '<div>' + html + '</div>'; el.classList.add('on'); };
  const say = (t) => { $('#heroSay').textContent = t; };
  ['pc1', 'pc2', 'pc3'].forEach((id) => $('#' + id).classList.remove('on'));
  scr.innerHTML = '<div class="tg-top"><span class="bk">‹</span><div class="tt"><b>Brand Updates</b><small>bot</small></div><span class="tg-ava lg"><svg viewBox="0 0 40 40"><use href="#logo"/></svg></span></div>' +
    '<div class="tg-bg" id="hpBg"></div><div class="tg-start" id="hpStart">START</div>';
  const bg = $('#hpBg', scr);
  const add = (html, cls) => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; bg.appendChild(d); return d; };
  const steps = [
    [250, () => { add('👤 <b>' + esc(name) + '</b> asked to join Brand Updates', 'tg-sys'); card('pc1', '<b>' + esc(name) + ' asked to join</b><small>Join request · from ' + src + '</small>'); say('New join request 🔔'); }],
    [900, () => { add('<i></i><i></i><i></i>', 'tg-typing'); }],
    [1700, () => {
      const ty = $('.tg-typing', bg); if (ty) ty.remove();
      add('Hi ' + esc(name) + ' 👋 Welcome to <b>Brand Updates</b>! Tap below and I\'ll send you today\'s free tips.<span class="ti">09:41</span>', 'tm in');
      add('▶ Tap to start', 'tkb');
      card('pc2', '<b>Welcome sent</b><small>In 1 second · by your bot</small>'); say('Welcome sent in 1s ⚡');
    }],
    [3100, () => { const k = $('.tkb', bg); if (!k) return; k.classList.add('tap'); const t = document.createElement('i'); t.className = 'touch'; k.appendChild(t); }],
    [3600, () => { const k = $('.tkb', bg); if (k) k.classList.remove('tap'); const st = $('#hpStart', scr); if (st) st.outerHTML = '<div class="tg-in"><span class="pc0">📎</span><span class="fld">Message</span><span class="sb">➤</span></div>'; add('/start<span class="ti">09:41 ✓✓</span>', 'tm out'); }],
    [4300, () => { add('✓ <b>' + esc(name) + '</b> was let in', 'tg-sys ok'); card('pc3', '<b>' + esc(name) + ' is now a subscriber</b><small>Tapped Start · ready for broadcasts</small>'); say('Let in · now a subscriber ✅'); }],
    // Then the rest of the story: a broadcast to everyone, and a timed follow-up.
    [5900, () => {
      add('<div class="img sm shn"><div>📣 TODAY\'S TIPS<small>Broadcast</small></div></div><b>Today\'s tips are live</b> 📣 Three quick wins inside.<span class="ti">10:00</span>', 'tm in');
      add('Read today\'s tips ↗', 'tkb');
      card('pc2', '<b>Broadcast sent</b><small>To all 1,240 subscribers · example</small>'); say('Broadcast sent 📣');
    }],
    [7900, () => {
      add('Day 2 · 09:00', 'tg-sys day');
      add('Quick win for day 2 💡 The one tip members save most.<span class="ti">09:00</span>', 'tm in');
      add('See the tip ↗', 'tkb');
      card('pc3', '<b>Day 2 follow-up sent</b><small>Auto follow-up · on time</small>'); say('Day 2 follow-up ✅');
    }],
  ];
  if (RM) { steps.forEach((x) => x[1]()); const k = $('.tkb', bg); if (k) k.classList.remove('tap'); bg.querySelectorAll('.touch').forEach((t) => t.remove()); return; }
  steps.forEach(([ms, fn]) => hjT.push(setTimeout(fn, ms)));
  hjT.push(setTimeout(() => { if (siteOn()) heroJoin(); else hjT.push(setTimeout(heroJoin, 2000)); }, 11500));
}
const NC = [['tunde', 'Welcome sent to Tunde', '02:14 · <b>delivered</b>'], ['wanjiku', 'Day 3 follow-up sent', '03:00 · <b>delivered</b>'], ['kwame', 'Kwame tapped "See the collection"', '03:12 · <b>tracked click</b>'], ['thandi', 'Thandi started your bot', '04:40 · <b>welcome sent</b>'], ['zainab', 'Zainab asked to join', '05:52 · <b>welcome sent in 1s</b>']];
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

/* Scroll reveal: only blocks that start below the fold are hidden, and only when motion is allowed (css: .rv-w / .rv-in). */
function siteReveal() {
  if (RM || !('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((es) => es.forEach((e) => {
    if (!e.isIntersecting && e.boundingClientRect.top > 0) return;
    e.target.classList.remove('rv-w'); e.target.classList.add('rv-in'); io.unobserve(e.target);
  }), { rootMargin: '0px 0px -6% 0px' });
  $$('#v-site .rv').forEach((el) => { if (el.getBoundingClientRect().top > innerHeight) { el.classList.add('rv-w'); io.observe(el); } });
}
/* Phones: the sticky "Log in / Start" bar appears once the hero button has scrolled out of view. */
function siteStickyBar() {
  const bar = $('#mbar'), cta = $('#heroCta');
  if (!bar) return;
  if (!cta || !('IntersectionObserver' in window)) { bar.classList.add('show'); return; }
  new IntersectionObserver(([e]) => bar.classList.toggle('show', !e.isIntersecting && e.boundingClientRect.top < 0)).observe(cta);
}

function siteInit() {
  $$('[data-k]').forEach((e) => { SITE_EN[e.dataset.k] = e.innerHTML; });
  // A saved manual choice wins; otherwise the browser's language. store.get never throws (private windows).
  const s = store.get('cv_lang');
  siteLang = LANGS[s] ? s : browserLang(navLangs(), LANGS);
  applyLang();
  siteApplyConfig();
  paintAll($('#v-site'));

  // Scroll can happen on the window or on <body> (some embedded/iOS web views), so read every source.
  const scrolledBy = () => Math.max(window.scrollY || 0, (document.scrollingElement && document.scrollingElement.scrollTop) || 0, document.documentElement.scrollTop || 0, document.body.scrollTop || 0);
  // One read and at most one class change per frame (scroll fires many times a frame on iOS); classes only change
  // when the state really flips, so nothing near the scroll position is re-laid out while the finger moves.
  let scQ = false, scS = null, hbS = null;
  const onScroll = () => {
    if (scQ) return; scQ = true;
    requestAnimationFrame(() => {
      scQ = false;
      const y = scrolledBy(), s = y > 8, h = y > 600;
      if (s !== scS) { scS = s; $('#hdr').classList.toggle('sc', s); }
      const hb = $('#helpB'); if (hb && h !== hbS) { hbS = h; hb.classList.toggle('show', h); }
    });
  };
  document.addEventListener('scroll', onScroll, { passive: true, capture: true });
  addEventListener('scroll', onScroll, { passive: true });
  if ('IntersectionObserver' in window) {
    const top = document.createElement('div'); top.setAttribute('aria-hidden', 'true'); top.style.cssText = 'height:8px;margin-bottom:-8px;pointer-events:none';
    const hdr = $('#hdr'); hdr.parentNode.insertBefore(top, hdr);
    new IntersectionObserver((es) => { scS = !es[0].isIntersecting; $('#hdr').classList.toggle('sc', scS); }).observe(top);
  }
  onScroll();
  $('#burger').onclick = () => $('#mnav').classList.add('open');
  $('#mnav').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) $('#mnav').classList.remove('open'); });
  document.addEventListener('click', () => { const m = $('#lsw .lsw-m'); if (m) m.hidden = true; });

  $('#billTog').onclick = (e) => { const b = e.target.closest('[data-b]'); if (!b) return; $$('#billTog button').forEach((x) => x.classList.toggle('on', x === b)); billYear = b.dataset.b === 'y'; sitePlans(); };
  $('#aiTabs').onclick = (e) => { const b = e.target.closest('[data-i]'); if (b) { aiAuto = +b.dataset.i; aiShow(aiAuto); } };

  siteReveal();
  siteStickyBar();
  // Example animations (they pause when the site is hidden)
  heroJoin(); nightTick();
  setInterval(() => { if (siteOn()) nightTick(); }, 4000);
  $('#bcList').innerHTML = [['tunde', 'Tunde'], ['wanjiku', 'Wanjiku'], ['kwame', 'Kwame'], ['thandi', 'Thandi']].map((x) => '<div class="bc-row">' + mav(x[0]) + x[1] + '<span class="ck">✓✓</span></div>').join('');
  let bi = 0; const bcRows = $$('#bcList .bc-row');
  setInterval(() => { if (!siteOn()) return; bcRows.forEach((r, i) => r.classList.toggle('on', i < bi)); bi = (bi + 1) % (bcRows.length + 2); }, 650);
  const sgSets = [[0, 1], [2], [3], [4], [5]], sgCounts = [3912, 1806, 1288, 964, 2140]; let sk = 0; const sgEls = $$('#sgx span');
  const sgTick = () => { sgEls.forEach((e, i) => e.classList.toggle('on', sgSets[sk].includes(i))); countTo($('#sgN'), sgCounts[sk], 700); sk = (sk + 1) % sgSets.length; };
  sgTick(); setInterval(() => { if (siteOn()) sgTick(); }, 2200);
  $('#clks').innerHTML = ['Mon', 'Tue', 'Wed'].map((c, i) => '<div class="clk"><svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="21" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="2.5"/><line class="hh" x1="24" y1="24" x2="24" y2="13" stroke="#fff" stroke-width="3" stroke-linecap="round" style="animation-delay:-' + (i * 12) + 's"/><line class="hm" x1="24" y1="24" x2="24" y2="8" stroke="#CFE0FF" stroke-width="2" stroke-linecap="round" style="animation-delay:-' + (i * 2) + 's"/><circle cx="24" cy="24" r="2.5" fill="#fff"/></svg>' + c + '<small>09:00</small></div>').join('');
  bAiTick(); setInterval(() => { if (siteOn()) bAiTick(); }, 8000);
  $('#teamStack').innerHTML = mav('ejiro', 36) + mav('zainab', 36) + mav('emeka', 36) + mav('wanjiku', 36) + '<span class="more">+6</span>';
  aiShow(0); setInterval(() => { if (!siteOn()) return; aiAuto = (aiAuto + 1) % AIX.length; aiShow(aiAuto); }, 9500);
  siteGuide = guide($('#siteGuide'));
}

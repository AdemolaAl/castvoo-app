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
  fr: { tk1: 'Vérification d\'abonnement', tk2: 'Formulaires de prospects', tk3: 'Bots de parrainage', tk4: 'Cas IA', tk5: 'Support 24/7', nf: 'Fonctionnalités', nh: 'Guide', na: 'IA', np: 'Tarifs', nb: 'Blog', nq: 'FAQ', nl: 'Connexion', ns: 'Essai gratuit', hc: 'Créateur de bots · IA Cas · Support 24/7', hw: 'Voir comment ça marche', h2c: 'Voir la mise en route en 40 s', t1: 'Sans carte bancaire', t2: 'Offre gratuite avec 2 bots', t3: 'Prêt en 5 minutes environ',
    h1: 'Diffusez, automatisez et créez des bots sur Telegram. <em class="gtext">Tout en pilote automatique.</em>', hs: 'Accueillez chaque nouveau membre, envoyez un message à tous vos abonnés, et laissez les relances et les bots travailler pour vous, même pendant votre sommeil.', hf1: 'Demandes acceptées automatiquement', hf2: 'Diffusions', hf3: 'Relances automatiques', hf4: 'Créateur de bots', hf5: 'Cas IA les crée pour vous', cta: 'Essai gratuit de 7 jours', f1: 'Bot d\'accueil', f2: 'Diffusions', f3: 'Relances programmées', f4: 'Éditeur de flux', f5: 'Rédacteur IA' },
  pt: { tk1: 'Verificação de entrada', tk2: 'Formulários de leads', tk3: 'Bots de indicação', tk4: 'Cas IA', tk5: 'Suporte 24/7', nf: 'Recursos', nh: 'Guia', na: 'IA', np: 'Preços', nb: 'Blog', nq: 'FAQ', nl: 'Entrar', ns: 'Começar grátis', hc: 'Criador de bots · IA Cas · Suporte 24/7', hw: 'Ver como funciona', h2c: 'Ver a configuração em 40 s', t1: 'Sem cartão', t2: 'Plano grátis com 2 bots', t3: 'Pronto em cerca de 5 minutos',
    h1: 'Transmita, automatize e crie bots no Telegram. <em class="gtext">Tudo no automático.</em>', hs: 'Dê boas-vindas a quem entra, envie uma mensagem para todos os inscritos e deixe os follow-ups e bots trabalharem por você, até enquanto dorme.', hf1: 'Aceita pedidos de entrada sozinho', hf2: 'Transmissões', hf3: 'Follow-ups automáticos', hf4: 'Criador de bots', hf5: 'A IA Cas cria por você', cta: 'Teste grátis de 7 dias', f1: 'Bot de boas-vindas', f2: 'Transmissões', f3: 'Follow-ups', f4: 'Editor de fluxos', f5: 'Redator IA' },
  es: { tk1: 'Verificación de canal', tk2: 'Formularios de leads', tk3: 'Bots de referidos', tk4: 'Cas IA', tk5: 'Soporte 24/7', nf: 'Funciones', nh: 'Guía', na: 'IA', np: 'Precios', nb: 'Blog', nq: 'FAQ', nl: 'Entrar', ns: 'Empezar gratis', hc: 'Creador de bots · IA Cas · Soporte 24/7', hw: 'Ver cómo funciona', h2c: 'Ver la configuración en 40 s', t1: 'Sin tarjeta', t2: 'Plan gratis con 2 bots', t3: 'Listo en unos 5 minutos',
    h1: 'Difunde, automatiza y crea bots en Telegram. <em class="gtext">Todo en automático.</em>', hs: 'Da la bienvenida a quien se une, envía un mensaje a todos tus suscriptores y deja que los seguimientos y los bots trabajen por ti, incluso mientras duermes.', hf1: 'Acepta solicitudes solo', hf2: 'Difusiones', hf3: 'Seguimientos automáticos', hf4: 'Creador de bots', hf5: 'Cas IA los crea por ti', cta: 'Prueba gratis de 7 días', f1: 'Bot de bienvenida', f2: 'Difusiones', f3: 'Seguimientos', f4: 'Editor de flujos', f5: 'Redactor IA' },
  ru: { tk1: 'Проверка подписки', tk2: 'Формы заявок', tk3: 'Реферальные боты', tk4: 'Cas ИИ', tk5: 'Поддержка 24/7', nf: 'Возможности', nh: 'Инструкция', na: 'ИИ', np: 'Цены', nb: 'Блог', nq: 'FAQ', nl: 'Войти', ns: 'Начать бесплатно', hc: 'Конструктор ботов · ИИ Cas · Поддержка 24/7', hw: 'Как это работает', h2c: 'Настройка за 40 секунд', t1: 'Без карты', t2: 'Бесплатный план с 2 ботами', t3: 'Запуск примерно за 5 минут',
    h1: 'Рассылки, автоматизация и боты в Telegram. <em class="gtext">Всё на автопилоте.</em>', hs: 'Приветствуйте каждого нового участника, отправляйте одно сообщение всем подписчикам, а напоминания и боты пусть работают за вас — даже пока вы спите.', hf1: 'Автоприём заявок', hf2: 'Рассылки', hf3: 'Автонапоминания', hf4: 'Конструктор ботов', hf5: 'Cas ИИ соберёт за вас', cta: '7 дней бесплатно', f1: 'Бот-приветствие', f2: 'Рассылки', f3: 'Цепочки', f4: 'Конструктор', f5: 'ИИ-копирайтер' },
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
  if ($('.hst-n')) heroCardsPaint();
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
/* Bots per plan (public config plans[].bots from services/billing.js BOT_PLANS): how many, and the bot types each plan adds. */
const BOT_TYPE_NAMES = { welcome: 'welcome', join_check: 'join-check', lead_magnet: 'free gift', menu: 'menu', broadcast: 'broadcast to bot subscribers', lead_questions: 'lead questions', referral: 'invite-a-friend referral bots' };
function botFact(p, prev) {
  const b = p.bots;
  if (!b || !Array.isArray(b.types)) return '';
  const n = b.max < 0 ? 'Unlimited active bots (fair use)' : plural(b.max, 'active bot');
  const names = (ts) => { const l = ts.map((t) => BOT_TYPE_NAMES[t] || t.replace(/_/g, ' ')); return l.length > 1 ? l.slice(0, -1).join(', ') + ' and ' + l[l.length - 1] : l[0] || ''; };
  if (!prev || !prev.bots) return n + ': ' + names(b.types);
  const added = b.types.filter((t) => !prev.bots.types.includes(t));
  return n + (added.length ? ', adds ' + names(added) : ', every bot type');
}
function planFacts(p, prev) {
  const lim = (v, one, many) => (v < 0 ? 'Unlimited ' + many : plural(v, one, many));
  if (!p.price_month && !p.price_year) {
    return [
      plural(p.connections, 'channel or group', 'channels or groups') + ' + your welcome bot',
      botFact(p, null),
      fmt(p.join_requests ?? 500) + ' join requests a month',
      '1 welcome message, auto-approve',
      p.cas_builds ? 'Your first bot built with Cas' : '',
    ].filter(Boolean);
  }
  return [
    botFact(p, prev),
    plural(p.connections, 'Telegram bot, channel or group', 'Telegram bots, channels or groups') + ' connected',
    (p.join_requests < 0 ? 'Unlimited' : fmt(p.join_requests ?? 0)) + ' join requests a month',
    p.flows != null ? lim(p.flows, 'welcome bot', 'welcome bots') + (p.flow_steps != null ? ', ' + (p.flow_steps < 0 ? 'unlimited' : fmt(p.flow_steps)) + ' messages each' : '') : '',
    fmt(p.subscribers) + ' bot subscribers (channel members free)',
    fmt(p.ai_writes) + ' AI writes a month',
    p.cas_builds < 0 ? 'Unlimited bots built with Cas' : p.cas_builds ? plural(p.cas_builds, 'bot') + ' built with Cas a month' : '',
    plural(p.seats, 'team seat'),
  ].filter(Boolean);
}
function sitePlans() {
  const plans = CFG.plans || [];
  const box = $('#plansBox');
  const hot = plans.find((p) => p.popular) ? null : (plans[1] || plans[0] || {}).code;
  const loggedIn = !!(ME && ME.user);
  box.className = 'plans n' + Math.min(plans.length, 4);
  box.innerHTML = plans.map((p, pi) => {
    const isHot = p.popular || p.code === hot;
    const free = !p.price_month && !p.price_year;
    const price = billYear ? p.price_year : p.price_month;
    const perMonth = billYear && p.price_year ? usd(Math.round(p.price_year / 12 * 100) / 100) : '';
    const facts = planFacts(p, plans[pi - 1]);
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
    '<div class="prn"><span class="prni">' + icon('check') + '</span><span><b>Every paid plan:</b> more bots and bot types, follow-ups, unlimited broadcasts, tracked clicks and Cas the AI helper. No setup fees.</span></div>' +
    (CFG.billing && Number(CFG.billing.seat_price) > 0 ? '<div class="prn"><span class="prni">' + icon('plus') + '</span><span><b>Extra team seats ' + usd(CFG.billing.seat_price) + '/month on any paid plan.</b> Add them in Settings → Team, paid from your wallet with your plan. Lower the number any time.</span></div>' : '') +
    '<div class="prn"><span class="prni">' + icon('spark') + '</span><span><b>Cas Builder on every plan.</b> Tell Cas what you want and Cas builds your bot with you in a chat. Free includes your first build; ' + plans.filter((p) => Number(p.cas_builds) && (p.price_month || p.price_year)).map((p) => esc(p.name) + ' ' + (Number(p.cas_builds) < 0 ? 'unlimited (fair use)' : fmt(p.cas_builds) + ' a month')).join(', ') + '. Changing a bot by chat is always free' + (CFG.cas_builder && CFG.cas_builder.pack ? ', and extra builds are ' + plural(CFG.cas_builder.pack.builds, 'build') + ' for ' + usd(CFG.cas_builder.pack.price) + ' from your wallet' : '') + '.</span></div>' +
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
  const rates = r.rates || [5, 10, 15];
  const sec = $('#refer');
  sec.hidden = CFG.features.referrals === false;
  $('#refText').textContent = 'Earn up to ' + Math.max(...rates) + '% of every plan payment made by people you invite, every month, for as long as they pay. Use it on your plan, or withdraw from ' + usd(r.min_withdraw || 300) + ' in USDT or Bitcoin.';
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
 * Only when VOO_SITE_WIDGET=on (off by default): the VooSquare support widget replaces our help bubble on the public
 * website for LOGGED-OUT visitors. Logged in, and inside the dashboard, it is always our own support chat (copied
 * into the VooSquare inbox). Returns true when the widget is in use.
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
    const tag = () => { let found = false; for (const el of document.body.children) if (!before.has(el) && el.tagName === 'DIV' && el.shadowRoot && !el.id) { el.setAttribute('data-vs-widget', ''); el.hidden = VIEW !== 'site' || !!(ME && ME.user); found = true; } return found; };
    // The widget may draw a moment after its script runs. If nothing appears, show our own bubble.
    sc.onload = () => { if (!tag()) setTimeout(() => { if (!tag()) fail(); }, 4000); };
    sc.onerror = fail;
    document.body.appendChild(sc);
  }
  $$('[data-vs-widget]').forEach((el) => { el.hidden = !show; });
  return true;
}

/* ---------- Support widget ----------
 * The floating support widget (widget.js) on the website and in the dashboard. On the website the VooSquare widget
 * (when switched on) takes its place; if it fails to load, ours comes back.
 */
function renderHelp(view) {
  const h = $('#helpHost'); if (h) h.innerHTML = '';
  // Logged in: always our widget with the person's real support conversation, on the website too.
  const useVoo = view === 'site' && !(ME && ME.user);
  const voo = vooWidget(useVoo);
  swSync(useVoo && voo ? null : view);
}

/* ---------- Example animations ---------- */
/* Hero photo stage: three example notifications around the person pop in one after another, then one changes every
   3 seconds. Slot i shows HN[i] or HN[i + 3]. {n} counts up. Labelled "Example"; reduced motion = the first three, still. */
const HN = {
  en: [['g', '🎉', 'New subscriber', 'Amaka joined VIP Signals'], ['c', '📣', 'Broadcast delivered', 'To {n} people', 2418], ['g', '✅', 'Join-check bot is live', 'Checks every new member'], ['v', '💬', 'Cas built your bot', 'Ready to switch on'], ['b', '👆', 'Button tapped', '“Get the free guide”'], ['c', '⏱', 'Day 3 follow-up sent', 'On time, by itself']],
  fr: [['g', '🎉', 'Nouvel abonné', 'Amaka a rejoint VIP Signals'], ['c', '📣', 'Diffusion envoyée', 'À {n} personnes', 2418], ['g', '✅', 'Bot de vérification actif', 'Vérifie chaque nouveau membre'], ['v', '💬', 'Cas a créé votre bot', 'Prêt à activer'], ['b', '👆', 'Bouton touché', '« Recevoir le guide gratuit »'], ['c', '⏱', 'Relance du jour 3 envoyée', 'À l\'heure, toute seule']],
  pt: [['g', '🎉', 'Novo inscrito', 'Amaka entrou no VIP Signals'], ['c', '📣', 'Transmissão entregue', 'Para {n} pessoas', 2418], ['g', '✅', 'Bot de verificação ativo', 'Verifica cada novo membro'], ['v', '💬', 'Cas criou seu bot', 'Pronto para ativar'], ['b', '👆', 'Botão tocado', '“Quero o guia grátis”'], ['c', '⏱', 'Follow-up do dia 3 enviado', 'Na hora certa, sozinho']],
  es: [['g', '🎉', 'Nuevo suscriptor', 'Amaka se unió a VIP Signals'], ['c', '📣', 'Difusión entregada', 'A {n} personas', 2418], ['g', '✅', 'Bot de verificación activo', 'Revisa a cada nuevo miembro'], ['v', '💬', 'Cas creó tu bot', 'Listo para activar'], ['b', '👆', 'Botón pulsado', '«Recibir la guía gratis»'], ['c', '⏱', 'Seguimiento del día 3 enviado', 'A tiempo, solo']],
  ru: [['g', '🎉', 'Новый подписчик', 'Амака вступила в VIP Signals'], ['c', '📣', 'Рассылка доставлена', '{n} людям', 2418], ['g', '✅', 'Бот проверки подписки', 'Проверяет каждого участника'], ['v', '💬', 'Cas собрал ваш бот', 'Готов к запуску'], ['b', '👆', 'Нажата кнопка', '«Получить бесплатный гайд»'], ['c', '⏱', 'Напоминание 3-го дня', 'Отправлено вовремя, само']],
};
const hnAt = [0, 1, 2];
function hnPaint(el, it, count) {
  const n = (v) => Math.round(v).toLocaleString(siteLang === 'en' ? 'en-US' : siteLang);
  el.innerHTML = '<span class="hst-ic ' + it[0] + '">' + it[1] + '</span><span class="hst-tx"><b>' + esc(it[2]) + '</b><small>' + esc(it[3]).replace('{n}', '<span class="tnum">' + n(it[4] || 0) + '</span>') + '</small></span>';
  const num = $('.tnum', el);
  if (num && count) countTo(num, it[4], 1100, n);
}
function heroCardsPaint() {
  const list = HN[siteLang] || HN.en;
  $$('.hst-n').forEach((c, i) => hnPaint(c, list[hnAt[i]]));
}
function heroCards() {
  const st = $('#hst'); if (!st) return;
  const cards = $$('.hst-n', st);
  heroCardsPaint();
  if (RM) return;
  st.classList.add('js');
  cards.forEach((c, i) => setTimeout(() => c.classList.add('on'), 450 + i * 700));
  let k = 0;
  setInterval(() => {
    if (!siteOn() || st.closest('.hl-off')) return;
    const i = k++ % 3, c = cards[i];
    c.classList.remove('on');
    setTimeout(() => { hnAt[i] = (hnAt[i] + 3) % 6; hnPaint(c, (HN[siteLang] || HN.en)[hnAt[i]], true); c.classList.add('on'); }, 480);
  }, 3000);
}
/* Pause a block's CSS animations while it is off screen (css: .hl-off). */
function siteLive() {
  if (!('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((es) => es.forEach((e) => e.target.classList.toggle('hl-off', !e.isIntersecting)), { rootMargin: '80px 0px' });
  $$('#top, #v-site .htk, #bots, #pricing, #v-site .hl-cl').forEach((el) => io.observe(el));
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
/*
 * The typing demos change length all the time. Without a reserved height their box grows and shrinks every few
 * seconds and everything under it moves, and Safari (no scroll anchoring) moves the page under the reader: the
 * "website shakes" on iPhone. reserveHeight measures every text the box will show (on an invisible copy at the same
 * width) and keeps the box at the tallest one. Measured again when the width changes and when the web font arrives.
 */
function reserveHeight(box, n, fill) {
  if (!box) return;
  let w = -1;
  const measure = (force) => {
    const cw = box.clientWidth;
    if (!cw || (cw === w && !force)) return;
    w = cw;
    const c = box.cloneNode(true);
    c.removeAttribute('id'); $$('[id]', c).forEach((x) => x.removeAttribute('id'));
    c.setAttribute('aria-hidden', 'true');
    c.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none;min-height:0;height:auto;width:' + box.getBoundingClientRect().width + 'px';
    box.parentNode.appendChild(c);
    let h = 0;
    for (let i = 0; i < n; i++) { fill(c, i); h = Math.max(h, c.getBoundingClientRect().height); }
    c.remove();
    box.style.minHeight = Math.ceil(h) + 'px';
  };
  measure();
  if ('ResizeObserver' in window) new ResizeObserver(() => measure()).observe(box);
  else addEventListener('resize', () => measure());
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => measure(true)).catch(() => {});
}
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
/* "Bots you can build": the example chat plays one message at a time while it is on screen (css: .byb-chat.play).
   Reduced motion or no IntersectionObserver: the whole chat simply shows. */
function siteBots() {
  const box = $('#bybChat');
  if (!box || RM || !('IntersectionObserver' in window)) return;
  const ms = $$('.byb-m', box);
  const typ = document.createElement('div');
  typ.className = 'byb-typ'; typ.hidden = true; typ.innerHTML = '<i></i><i></i><i></i>';
  box.appendChild(typ);
  box.classList.add('play');
  let i = 0, seen = false, typing = false;
  const step = () => {
    if (!seen || !siteOn()) return setTimeout(step, 700);
    if (i >= ms.length) { ms.forEach((m) => m.classList.remove('on')); i = 0; return setTimeout(step, 700); }
    const m = ms[i];
    if (!typing && !m.classList.contains('me') && !m.classList.contains('sys')) { typing = true; typ.hidden = false; box.appendChild(typ); return setTimeout(step, 800); }
    typing = false; typ.hidden = true;
    m.classList.add('on'); i++;
    return setTimeout(step, i >= ms.length ? 4200 : 1100);
  };
  new IntersectionObserver(([e]) => { seen = e.isIntersecting; }).observe(box);
  step();
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
  let scQ = false, scS = null;
  const onScroll = () => {
    if (scQ) return; scQ = true;
    requestAnimationFrame(() => {
      scQ = false;
      const y = scrolledBy(), s = y > 8;
      if (s !== scS) { scS = s; $('#hdr').classList.toggle('sc', s); }
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
  siteBots();
  // Example animations (they pause when the site is hidden)
  heroCards(); siteLive(); nightTick();
  setInterval(() => { if (siteOn()) nightTick(); }, 4000);
  $('#bcList').innerHTML = [['tunde', 'Tunde'], ['wanjiku', 'Wanjiku'], ['kwame', 'Kwame'], ['thandi', 'Thandi']].map((x) => '<div class="bc-row">' + mav(x[0]) + x[1] + '<span class="ck">✓✓</span></div>').join('');
  let bi = 0; const bcRows = $$('#bcList .bc-row');
  setInterval(() => { if (!siteOn()) return; bcRows.forEach((r, i) => r.classList.toggle('on', i < bi)); bi = (bi + 1) % (bcRows.length + 2); }, 650);
  const sgSets = [[0, 1], [2], [3], [4], [5]], sgCounts = [3912, 1806, 1288, 964, 2140]; let sk = 0; const sgEls = $$('#sgx span');
  const sgTick = () => { sgEls.forEach((e, i) => e.classList.toggle('on', sgSets[sk].includes(i))); countTo($('#sgN'), sgCounts[sk], 700); sk = (sk + 1) % sgSets.length; };
  sgTick(); setInterval(() => { if (siteOn()) sgTick(); }, 2200);
  $('#clks').innerHTML = ['Mon', 'Tue', 'Wed'].map((c, i) => '<div class="clk"><svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="21" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="2.5"/><line class="hh" x1="24" y1="24" x2="24" y2="13" stroke="#fff" stroke-width="3" stroke-linecap="round" style="animation-delay:-' + (i * 12) + 's"/><line class="hm" x1="24" y1="24" x2="24" y2="8" stroke="#CFE0FF" stroke-width="2" stroke-linecap="round" style="animation-delay:-' + (i * 2) + 's"/><circle cx="24" cy="24" r="2.5" fill="#fff"/></svg>' + c + '<small>09:00</small></div>').join('');
  reserveHeight($('#bAiT') && $('#bAiT').parentNode, B_AI.length, (c, i) => { $('.q', c).textContent = B_AI[i][0]; const o = $('.q', c).nextElementSibling; o.textContent = B_AI[i][1]; o.classList.add('typing'); });
  reserveHeight($('#aiPrompt') && $('#aiPrompt').parentNode, AIX.length, (c, i) => { c.lastElementChild.textContent = AIX[i].p; });
  reserveHeight($('#aiOut'), AIX.length, (c, i) => { c.textContent = AIX[i].o; c.classList.add('typing'); });
  bAiTick(); setInterval(() => { if (siteOn()) bAiTick(); }, 8000);
  $('#teamStack').innerHTML = mav('dayo', 36) + mav('zainab', 36) + mav('emeka', 36) + mav('wanjiku', 36) + '<span class="more">+6</span>';
  aiShow(0); setInterval(() => { if (!siteOn()) return; aiAuto = (aiAuto + 1) % AIX.length; aiShow(aiAuto); }, 9500);
  siteGuide = guide($('#siteGuide'));
}

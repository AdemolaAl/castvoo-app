'use strict';
/*
 * Link cards the support agents can send (the share_link tool, or a [[link:KEY]] marker in a reply).
 *
 * The model never sends a raw URL to the customer: it names a KEY from the catalogue below (or passes a URL that maps
 * exactly onto one), and this file builds the card. Everything else is refused, so a customer can never be sent to a
 * look-alike or phishing page by a confused or manipulated model.
 *
 * Card: { key, kind, label, sub, href, guide?, text? }
 *   kind 'app'      a dashboard page (#app/...). In the dashboard it navigates in place; on the website a logged-out
 *                   visitor goes to log in first and then lands on that page (app.js keeps cv_back).
 *   kind 'guide'    a video guide (data-vguide id): plays inline in the dashboard, else opens the Guides page.
 *   kind 'article'  a help article (knowledge key): the card opens and shows the article right in the chat.
 *   kind 'blog'     a live castvoo.com blog post (/blog/<slug>), new tab.
 *   kind 'legal'    /legal/<page>, new tab.
 *   kind 'external' a Zedapex / Voo site from BRANDS (https only, exact host), new tab.
 *
 * Bot links (bot:<id>, bot_leads:<id>...) are checked against the customer's own workspace (scope.workspaceId).
 */

const db = require('../db');

// Dashboard pages: key → [label, small line, hash].
const APP = {
  home: ['Home', 'Your dashboard', '#app'],
  wallet: ['Wallet and plan', 'Balance, payments and your plan', '#app/wallet'],
  topup: ['Top up your wallet', 'Opens the top-up window', '#app/wallet?topup=1'],
  plans: ['Plans and upgrade', 'Compare plans and switch', '#app/wallet?plans=1'],
  bots: ['🤖 Bots', 'Your Welcome bots and Chat bots', '#app/flows'],
  new_bot: ['Make a new bot', 'Welcome bot or Chat bot', '#app/flows?newbot=1'],
  cas_builder: ['Build a bot with Cas', 'Cas asks a few questions and builds it', '#app/flows?cas=1'],
  channels: ['Channels & bots', 'Connect or fix your Telegram bots, channels and groups', '#app/bots'],
  send: ['Send a message', 'Broadcast now, later or at 9am', '#app/broadcast'],
  calendar: ['Scheduled messages', 'Your sending calendar', '#app/calendar'],
  follow_ups: ['Auto follow-ups', 'Messages your bot sends by itself', '#app/drips'],
  audiences: ['Audiences', 'Saved groups of bot subscribers', '#app/audiences'],
  subscribers: ['Subscribers', 'People who started your bots', '#app/subscribers'],
  clicks: ['Clicks', 'Who tapped your buttons', '#app/clicks'],
  cas: ['Ask Cas', 'Your AI writing helper', '#app/ai'],
  train_cas: ['Train Cas', 'Teach Cas your business', '#app/ai'],
  settings: ['Settings', 'Profile, workspace, team and security', '#app/settings'],
  profile: ['Settings → Profile', 'Name, email, country, avatar', '#app/settings'],
  team: ['Settings → Team', 'Teammates and seats', '#app/settings?tab=team'],
  setup_helper: ['Invite a setup helper', 'Free on every plan, no password sharing', '#app/settings?tab=helper'],
  security: ['Active devices', 'Settings → Security', '#app/settings?tab=security'],
  guides: ['Video guides', 'Short tutorials with voice and captions', '#app/guides'],
  earn: ['Earn page', 'Your referral link, tier and earnings', '#app/earn'],
  help: ['Help', 'This support chat', '#app/help'],
  apps: ['Zedapex apps', 'More tools from the Voo family', '#app/apps'],
  joinvoo_page: ['Joinvoo', 'See which ads bring real joins', '#app/joinvoo'],
  replyvoo_page: ['Replyvoo', 'AI that answers your Telegram chats', '#app/replyvoo'],
};
// A bot of the customer's own workspace: key → [label, tab].
const BOT = { bot: ['Open the bot', null], bot_leads: ['Leads', 'leads'], bot_invites: ['Invites', 'invites'], bot_requests: ['Join requests', 'requests'], bot_stats: ['Stats', 'stats'] };

// Video guides on the Guides page (public/js/app-guides.js VGUIDES ids; a test checks they all exist there).
const GUIDES = {
  'connect-bot': 'Connect your Telegram bot', 'add-channel': 'Add a channel or group', 'cas-builder': 'Build a welcome bot with Cas',
  'welcome-flow': 'Build a welcome bot yourself', 'bots-with-cas': 'Build any bot with Cas', 'bots-yourself': 'Build a bot yourself',
  'bots-leads-invites': 'Leads, invites & broadcasts', 'send-broadcast': 'Send a broadcast', 'auto-follow-ups': 'Auto follow-ups',
  'audiences-start-links': 'Audiences & start links', 'wallet-plans': 'Wallet, plans & the Free plan', 'referrals-help': 'Earn with referrals & get help',
  'setup-helper': 'Invite a setup helper',
};

const LEGAL = { terms: 'Terms of service', privacy: 'Privacy policy', refunds: 'Refund policy', 'acceptable-use': 'Acceptable use policy', cookies: 'Cookie policy' };

// The Zedapex family. Only these exist. url null = no site of its own to link: the card opens VooSquare, the hub.
const BRANDS = {
  voosquare: { label: 'VooSquare', sub: 'Media buying, squared. One Voo ID for every Voo tool', url: 'https://voosquare.com' },
  voosquare_affiliate: { label: 'VooSquare affiliate program', sub: 'affiliate.voosquare.com', url: 'https://affiliate.voosquare.com' },
  voosquare_academy: { label: 'VooSquare Academy', sub: 'Free media buying school', url: 'https://voosquareacademy.com' },
  joinvoo: { label: 'Joinvoo', sub: 'Track which ads bring Telegram joins', url: 'https://joinvoo.com' },
  replyvoo: { label: 'Replyvoo', sub: 'AI agent that answers your Telegram chats', url: 'https://replyvoo.com' },
  glicto: { label: 'Glicto AI', sub: 'AI that runs your Meta, TikTok and Google ads', url: 'https://glicto.com' },
  affleego: { label: 'Affleego', sub: 'Affiliate deals platform', url: 'https://affleego.com' },
  gatevoo: { label: 'Gatevoo', sub: 'Zedapex crypto checkout (waitlist)', url: 'https://gatevoo.com' },
  vooads: { label: 'Vooads on VooSquare', sub: 'AI ad creatives: videos, images and copy', url: 'https://voosquare.com' },
  spyvoo: { label: 'Spyvoo on VooSquare', sub: 'Live ad spy: see what\'s winning', url: 'https://voosquare.com' },
  castvoo: { label: 'Castvoo', sub: 'castvoo.com', url: 'https://castvoo.com' },
};
const HOSTS = new Set(Object.values(BRANDS).map((b) => new URL(b.url).host));

const KEY_RX = /^[a-z_]{2,24}(:[A-Za-z0-9_-]{1,80})?$/;

/** Every key the model may use, for the prompt and the tool description. */
function keysText() {
  return [
    'Dashboard: ' + Object.keys(APP).join(', '),
    'One of their bots: bot:<id>, bot_leads:<id>, bot_invites:<id>, bot_requests:<id>, bot_stats:<id> (id from get_bots)',
    'Video guides: ' + Object.keys(GUIDES).map((g) => 'guide:' + g).join(', '),
    'Help article: article:<key> (knowledge key, e.g. article:connect-bot)',
    'Blog post: blog:<slug>',
    'Legal: ' + Object.keys(LEGAL).map((l) => 'legal:' + l).join(', '),
    'Zedapex sites: ' + Object.keys(BRANDS).map((b) => 'site:' + b).join(', '),
  ].join('\n');
}

/** Turn a URL the model passed into a key, or null. Only exact matches of what the catalogue offers. */
function keyFromUrl(raw) {
  const u = String(raw || '').trim();
  if (!u || u.length > 300 || /[\s<>"'`\\]/.test(u)) return null;
  if (u.startsWith('#app')) {
    const appHit = Object.entries(APP).find(([, v]) => v[2] === u);
    if (appHit) return appHit[0];
    const m = u.match(/^#app\/flows\?id=(\d{1,12})(?:&tab=(leads|invites|requests|stats))?$/);
    if (m) return (m[2] ? 'bot_' + m[2] : 'bot') + ':' + m[1];
    return null;
  }
  let url;
  try { url = new URL(u); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !HOSTS.has(url.host)) return null;
  if (url.host === 'castvoo.com' || url.host === 'www.castvoo.com') {
    const b = url.pathname.match(/^\/blog\/([a-z0-9-]{1,120})\/?$/);
    if (b) return 'blog:' + b[1];
    const l = url.pathname.match(/^\/legal\/([a-z-]{3,20})\/?$/);
    if (l && LEGAL[l[1]]) return 'legal:' + l[1];
  }
  if (url.pathname !== '/' || url.search || url.hash) return null; // brand home pages only
  const hit = Object.entries(BRANDS).find(([k, v]) => new URL(v.url).host === url.host && !['vooads', 'spyvoo'].includes(k));
  return hit ? 'site:' + hit[0] : null;
}

/**
 * Build one card. scope: { workspaceId } (null on the website chat). Returns { ok: true, card } or { ok: false, reason }.
 * Never throws.
 */
async function resolve(input, scope = {}) {
  try {
    let key = typeof input === 'string' ? input : input && (input.key || null);
    if (!key && input && input.url) key = keyFromUrl(input.url);
    key = String(key || '').trim();
    if (!KEY_RX.test(key)) return { ok: false, reason: 'Unknown link. Use one of the keys from the list; other web addresses are never sent.' };
    const [kind, arg] = key.split(':');
    const label = input && typeof input === 'object' && input.label ? String(input.label).replace(/[\r\n<>]/g, ' ').trim().slice(0, 60) : null;
    if (!arg && APP[kind]) { const [l, s, href] = APP[kind]; return { ok: true, card: { key, kind: 'app', label: label || l, sub: s, href } }; }
    if (arg && BOT[kind]) {
      if (!scope.workspaceId) return { ok: false, reason: 'Bot links need the customer to be logged in.' };
      const id = Number(arg);
      const q = Number.isInteger(id) && id > 0 ? await db.one('select id, name, trigger_type from sequences where id = $1 and workspace_id = $2', [id, scope.workspaceId]) : null;
      if (!q) return { ok: false, reason: 'No bot with that id in this workspace. Use get_bots for the real ids.' };
      const [l, tab] = BOT[kind];
      if ((tab === 'leads' || tab === 'invites') && q.trigger_type !== 'bot_start') return { ok: false, reason: 'Leads and Invites are tabs of Chat bots only.' };
      if (tab === 'requests' && q.trigger_type !== 'join_request') return { ok: false, reason: 'Join requests are a tab of Welcome bots only.' };
      return { ok: true, card: { key, kind: 'app', label: label || `${l}: ${String(q.name).slice(0, 40)}`, sub: '🤖 Bots', href: `#app/flows?id=${q.id}${tab ? '&tab=' + tab : ''}` } };
    }
    if (kind === 'guide' && GUIDES[arg]) return { ok: true, card: { key, kind: 'guide', label: label || GUIDES[arg], sub: 'Video guide', href: '#app/guides', guide: arg } };
    if (kind === 'legal' && LEGAL[arg]) return { ok: true, card: { key, kind: 'legal', label: LEGAL[arg], sub: 'castvoo.com', href: '/legal/' + arg } };
    if (kind === 'site' && BRANDS[arg]) { const b = BRANDS[arg]; return { ok: true, card: { key, kind: 'external', label: b.label, sub: b.sub, href: b.url } }; }
    if (kind === 'article' && arg) {
      const a = await db.one('select key, title, body from knowledge where key = $1 and active', [arg]);
      if (!a) return { ok: false, reason: 'No help article with that key.' };
      return { ok: true, card: { key, kind: 'article', label: a.title.slice(0, 80), sub: 'Help article', href: null, text: a.body.slice(0, 2500) } };
    }
    if (kind === 'blog' && arg) {
      const p = await require('./blog').bySlug(arg).catch(() => null);
      if (!p) return { ok: false, reason: 'No live blog post with that slug.' };
      return { ok: true, card: { key, kind: 'blog', label: String(p.title).slice(0, 90), sub: 'Castvoo blog', href: '/blog/' + p.slug } };
    }
    return { ok: false, reason: 'Unknown link. Use one of the keys from the list; other web addresses are never sent.' };
  } catch { return { ok: false, reason: 'That link could not be checked just now.' }; }
}

/** [[link:KEY]] markers in a reply: removed from the text, returned as keys (at most 3). */
const MARKER = /\[\[\s*link\s*:\s*([A-Za-z0-9_:-]{2,110})\s*\]\]/g;
function extractMarkers(text) {
  const keys = [];
  const out = String(text || '').replace(MARKER, (_, k) => { if (!keys.includes(k)) keys.push(k); return ''; }).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: out, keys: keys.slice(0, 3) };
}

/** Cards for a list of keys, checked; duplicates and failures dropped; at most 3. */
async function cardsFor(keys, scope) {
  const out = [];
  for (const k of keys) {
    if (out.length >= 3) break;
    const r = await resolve(k, scope);
    if (r.ok && !out.some((c) => c.key === r.card.key)) out.push(r.card);
  }
  return out;
}

/** A card read back from the database is shown only if it still passes the same checks (defence in depth). */
function safeCard(c) {
  if (!c || typeof c !== 'object') return null;
  const href = c.href == null ? null : String(c.href);
  const okHref = href === null ? c.kind === 'article' : c.kind === 'app' || c.kind === 'guide' ? /^#app(\/[a-z]+)?(\?[a-z]+=[A-Za-z0-9_-]+(&[a-z]+=[A-Za-z0-9_-]+)?)?$/.test(href)
    : c.kind === 'blog' ? /^\/blog\/[a-z0-9-]+$/.test(href) : c.kind === 'legal' ? /^\/legal\/[a-z-]+$/.test(href) : c.kind === 'external' ? Object.values(BRANDS).some((b) => b.url === href) : false;
  if (!okHref) return null;
  return { key: String(c.key || '').slice(0, 110), kind: c.kind, label: String(c.label || '').slice(0, 90), sub: String(c.sub || '').slice(0, 90), href,
    ...(c.kind === 'guide' && GUIDES[c.guide] ? { guide: c.guide } : {}), ...(c.kind === 'article' ? { text: String(c.text || '').slice(0, 2500) } : {}) };
}
const safeCards = (list) => (Array.isArray(list) ? list.map(safeCard).filter(Boolean).slice(0, 3) : []);

/**
 * Web addresses typed into a reply: only Zedapex / Castvoo sites and Telegram (t.me start links, @BotFather) stay;
 * any other address is taken out, so a reply can never carry a phishing link.
 */
function scrubUrls(text, appUrl = '') {
  let appHost = '';
  try { appHost = appUrl ? new URL(appUrl).host : ''; } catch { /* none */ }
  const okHost = (h) => HOSTS.has(h) || h === 'www.castvoo.com' || h === 't.me' || h === 'telegram.me' || (appHost && h === appHost);
  return String(text || '').replace(/\b(?:https?:\/\/|www\.)[^\s<>()]+/gi, (m) => {
    const trail = m.match(/[.,!?;:]+$/);
    const core = trail ? m.slice(0, -trail[0].length) : m;
    let host = '';
    try { host = new URL(/^www\./i.test(core) ? 'https://' + core : core).host.toLowerCase(); } catch { return '(link removed)' + (trail ? trail[0] : ''); }
    return (okHost(host) ? core : '(link removed)') + (trail ? trail[0] : '');
  });
}

module.exports = { scrubUrls, APP, BOT, GUIDES, LEGAL, BRANDS, HOSTS, keysText, keyFromUrl, resolve, extractMarkers, cardsFor, safeCard, safeCards };

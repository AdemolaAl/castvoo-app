'use strict';
/*
 * api.js: talking to the Castvoo server.
 *   CFG           site settings from GET /api/public/config (prices, texts, switches). Starts with safe defaults.
 *   ME            { user, workspaces } from GET /api/me (user is null when logged out)
 *   api(method, path, body)   returns the JSON, or throws an ApiError { status, code, message }
 *   apiErr(err)   shows a friendly message (with a Wallet / Plan button for money problems)
 *   upload(file, onProgress)  sends a photo or video to /api/media
 */

/* Defaults so the site can draw straight away. Replaced as soon as /api/public/config answers. */
let CFG = {
  loaded: false,
  features: { signups: true, login_email: true, broadcasts: true, drips: true, join_welcome: true, segments: true, media: true, local_time: true, start_links: true, ai: true, topups: true, crypto: true, referrals: true, withdrawals: true, support_chat: true, support_ai: true, site_chat: false, maintenance: false },
  content: {
    announcement_on: '0', announcement_text: '', announcement_link: '',
    hero_title: 'Welcome. Broadcast. Follow up. *All on autopilot.*',
    hero_subtitle: 'Greet everyone who asks to join, send broadcasts to all your subscribers, and build timed follow-up flows with buttons and links in a simple builder. Cas, the AI helper, writes the messages.',
    hero_cta: 'Start my 7-day free trial',
    pricing_title: 'Simple prices. *Start free.*',
    pricing_subtitle: 'Free welcomes 500 join requests a month on one channel. Paid plans from $19 add follow-ups, broadcasts, tracked clicks and Cas. No setup or add-on fees.',
    footer_tagline: 'Every Telegram join, greeted and followed up.',
    maintenance_message: '', faq: '[]',
  },
  plans: [
    { code: 'starter', name: 'Starter', tagline: 'For one bot or channel getting started.', price_month: 19, price_year: 190, connections: 1, subscribers: 5000, ai_writes: 300, seats: 1, bullets: ['Unlimited broadcasts', 'Auto follow-ups', 'Tracked clicks'], popular: false },
    { code: 'growth', name: 'Growth', tagline: 'For buyers running several channels.', price_month: 49, price_year: 490, connections: 5, subscribers: 25000, ai_writes: 2000, seats: 3, bullets: ['Everything in Starter', 'Audiences and start links'], popular: true },
    { code: 'scale', name: 'Scale', tagline: 'For big audiences and teams.', price_month: 99, price_year: 990, connections: 20, subscribers: 100000, ai_writes: 5000, seats: 10, bullets: ['Everything in Growth', 'Priority support'], popular: false },
  ],
  trial: { days: 7, plan: 'growth' },
  countries: [],
  login: { email: true, telegram: false, voosquare: false },
  bot_username: null, bot_id: null, gatevoo: false, gatevoo_url: null,
  referral: { rates: [10, 20, 30], tier2_min: 5, tier3_min: 20, min_withdraw: 300, settle_days: 30 },
  billing: { min_topup: 10, max_topup: 5000, refund_days: 14 },
  topup_bonuses: [], banners: [],
  support: { reply_time: 'We usually reply within a few hours.', email: 'support@castvoo.com', telegram: null },
  company: { name: 'Zedapex', address: 'Lagos, Nigeria' },
  ai_available: true,
};
let ME = { user: null, workspaces: [] };
let ME_LOADED = false;

class ApiError extends Error {
  constructor(status, message, code, data) { super(message); this.status = status; this.code = code || ''; this.data = data || {}; }
}

/* The workspace this browser is looking at (only matters for people in more than one). */
const WS = {
  get() { const v = store.get('cv_ws'); return v && /^\d+$/.test(v) ? v : null; },
  set(id) { store.set('cv_ws', id == null ? null : String(id)); },
  /** Forget the saved workspace if this person is no longer in it. */
  check() {
    const id = WS.get();
    if (id && !(ME.workspaces || []).some((w) => String(w.id) === id)) WS.set(null);
  },
  current() {
    const id = WS.get();
    const list = ME.workspaces || [];
    return list.find((w) => String(w.id) === id) || list.find((w) => w.role === 'owner') || list[0] || null;
  },
};

async function api(method, path, body, opts = {}) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') { headers['Content-Type'] = 'application/json'; headers['x-cv'] = '1'; }
  const ws = WS.get();
  if (ws) headers['x-ws'] = ws;
  let res;
  try {
    res = await fetch(path, { method, headers, credentials: 'same-origin', body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body), signal: opts.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(0, 'No connection. Check your internet and try again.', 'offline');
  }
  let data = null;
  try { data = await res.json(); } catch (_) { data = null; }
  if (!res.ok) {
    const msg = (data && data.error) || (res.status >= 500 ? 'Something went wrong on our side. Please try again.' : 'That did not work. Please try again.');
    const err = new ApiError(res.status, msg, data && data.code, data);
    if (res.status === 401 && !opts.quiet401 && typeof onLoggedOut === 'function') onLoggedOut();
    if (err.code === 'access_removed' && typeof onAccessRemoved === 'function') onAccessRemoved(msg);
    throw err;
  }
  return data || {};
}
const GET = (p, o) => api('GET', p, undefined, o);
const POST = (p, b, o) => api('POST', p, b || {}, o);

async function loadConfig() {
  try {
    const c = await GET('/api/public/config');
    CFG = { ...CFG, ...c, content: { ...CFG.content, ...(c.content || {}) }, loaded: true };
  } catch (_) { /* keep defaults; the site still works */ }
  return CFG;
}
async function loadMe() {
  try { ME = await GET('/api/me', { quiet401: true }); } catch (_) { ME = { user: null, workspaces: [] }; }
  if (!ME.workspaces) ME.workspaces = [];
  ME_LOADED = true;
  WS.check();
  return ME;
}

/* Money problems: the server answers 402 with one of these codes. */
const MONEY_CODES = {
  plan_paused: 'wallet', trial_over: 'wallet', wallet_short: 'wallet',
  limit_connections: 'plan', limit_subscribers: 'plan', limit_seats: 'plan', ai_limit: 'plan',
  plan_feature: 'upgrade', limit_flows: 'upgrade', limit_flow_steps: 'upgrade',
};
/* Show an error nicely. Returns the message so callers can also show it inline. */
function apiErr(err, opts = {}) {
  if (!err || err.name === 'AbortError') return '';
  const msg = err.message || 'Something went wrong. Please try again.';
  if (err.status === 401) return msg; // onLoggedOut already sent them to the login screen
  const where = MONEY_CODES[err.code] || (err.status === 402 ? 'wallet' : null);
  // "This is on a bigger plan": the upgrade sheet explains it and switches plan in one tap.
  if (where === 'upgrade' && typeof openUpgrade === 'function' && APP.booted) {
    openUpgrade({ title: 'Upgrade to use this', text: msg, feature: (err.data && err.data.feature) || null, limit: err.code === 'limit_flows' ? 'flows' : err.code === 'limit_flow_steps' ? 'flow_steps' : null });
    return msg;
  }
  if (where && typeof appGo === 'function') {
    toast(msg, { kind: 'err', action: { label: where === 'plan' ? 'See plans' : 'Open wallet', onClick: () => { closeModal(); appGo('wallet'); } } });
    return msg;
  }
  if (err.code === 'tg_not_linked' && typeof appGo === 'function') {
    toast(msg, { kind: 'err', action: { label: 'Link Telegram', onClick: () => { closeModal(); linkTelegram(); } } });
    return msg;
  }
  if (!opts.silent) toast(msg, { kind: 'err' });
  return msg;
}

/* Upload a photo or video. Resolves { id, kind, filename, size_bytes }. */
function upload(file, onProgress) { return uploadTo('/api/media', 'media', file, onProgress); }
/* Upload a file as the raw body to `url`; resolves the response's `key` (e.g. 'media', 'attachment'). */
function uploadTo(url, key, file, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.withCredentials = true;
    x.setRequestHeader('Content-Type', file.type);
    x.setRequestHeader('X-Filename', (file.name || 'file').replace(/[^\w.\- ]/g, '').slice(0, 80) || 'file');
    x.setRequestHeader('x-cv', '1');
    const ws = WS.get(); if (ws) x.setRequestHeader('x-ws', ws);
    x.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    x.onload = () => {
      let d = null; try { d = JSON.parse(x.responseText); } catch (_) { d = null; }
      if (x.status >= 200 && x.status < 300 && d && d[key]) resolve(d[key]);
      else reject(new ApiError(x.status, (d && d.error) || (x.status === 413 ? 'That file is too big.' : 'Upload failed. Please try again.'), d && d.code));
    };
    x.onerror = () => reject(new ApiError(0, 'Upload failed. Check your internet and try again.', 'offline'));
    x.send(file);
  });
}
/* A URL the browser can show for a stored file (adds the workspace, since <img> can't send headers). */
function mediaUrl(id) { const ws = WS.get() || (WS.current() || {}).id; return '/api/media/' + encodeURIComponent(id) + (ws ? '?ws=' + ws : ''); }

/* Referral code from the link (?ref=), kept for this visit. */
function refCode() {
  // Castvoo's own referral code. A VooSquare affiliate click (?ref=...&vclick=...) is NOT one: the server keeps it
  // for VooSquare (voo_attr cookie) and VooSquare credits the affiliate.
  const sq = parseQuery(location.search), hq = parseQuery((location.hash.split('?')[1]) || '');
  const q = sq.cvref || hq.cvref || (sq.vclick || hq.vclick ? '' : sq.ref || hq.ref);
  if (q) store.sset('cv_ref', String(q).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40));
  return store.sget('cv_ref') || '';
}

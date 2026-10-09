'use strict';
/*
 * All settings that come from the environment (Railway → Variables).
 * Every variable is explained in .env.example. Nothing else in the code reads process.env.
 */

const env = process.env;

function bool(v, d = false) {
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}
function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && v !== '' && v !== undefined ? n : d;
}
function trimSlash(s) { return String(s || '').replace(/\/+$/, ''); }

const config = {
  env: env.NODE_ENV || 'development',
  isProd: (env.NODE_ENV || '') === 'production',
  port: num(env.PORT, 3000),
  appUrl: trimSlash(env.APP_URL || 'http://localhost:3000'),
  databaseUrl: env.DATABASE_URL || '',
  dbPoolMax: num(env.DB_POOL_MAX, 15),
  appSecret: env.APP_SECRET || '',
  ownerEmail: (env.OWNER_EMAIL || '').trim().toLowerCase(),
  uploadDir: env.UPLOAD_DIR || require('node:path').join(__dirname, '..', 'data', 'uploads'),
  // ENG-23: where Railway mounted the volume (set by Railway when a volume is attached). In production on Railway the
  // uploads folder must be on it, or every deploy would wipe payment proofs, support screenshots and photos.
  volumeMount: env.RAILWAY_VOLUME_MOUNT_PATH || '',
  // Set to true only to start in production without a volume on purpose (uploads are lost on every deploy).
  allowNoVolume: bool(env.ALLOW_NO_VOLUME, false),
  runWorkers: bool(env.RUN_WORKERS, true),
  // Trust X-Forwarded-For only behind a proxy that appends the real address: on by default on Railway, off elsewhere
  // (without a proxy the header is whatever the visitor sends, and per-IP rate limits could be dodged).
  trustProxy: bool(env.TRUST_PROXY, !!env.RAILWAY_ENVIRONMENT),
  // SEC-7: tracked links of accounts younger than this (that never paid) show a "You are leaving Castvoo" page before
  // going to a site outside Telegram and Castvoo. 0 = off.
  linkWarnNewDays: Math.max(0, num(env.LINK_WARN_NEW_DAYS, 7)),

  // Country from the visitor's address (lib/geoip.js): the free DB-IP "IP to Country Lite" file, kept in
  // UPLOAD_DIR/geo/. GEOIP_AUTO_DOWNLOAD (default on in production) fetches the new monthly file from db-ip.com.
  // GEOIP_DOWNLOAD_BASE is for tests only and is ignored in production.
  geoip: {
    autoDownload: bool(env.GEOIP_AUTO_DOWNLOAD, (env.NODE_ENV || '') === 'production'),
    downloadBase: trimSlash(((env.NODE_ENV || '') !== 'production' && env.GEOIP_DOWNLOAD_BASE) || 'https://download.db-ip.com'),
  },

  telegram: {
    apiBase: trimSlash(env.TELEGRAM_API_BASE || 'https://api.telegram.org'),
    botToken: env.CASTVOO_BOT_TOKEN || '',
    botUsername: (env.CASTVOO_BOT_USERNAME || '').replace(/^@/, ''),
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || '',
    sendPerSecond: num(env.TG_SEND_PER_SECOND, 25),
  },

  email: {
    provider: env.EMAIL_PROVIDER || (env.RESEND_API_KEY ? 'resend' : 'log'),
    resendKey: env.RESEND_API_KEY || '',
    resendBase: trimSlash(env.RESEND_API_BASE || 'https://api.resend.com'),
    from: env.EMAIL_FROM || 'Castvoo <hello@castvoo.com>',
    replyTo: env.EMAIL_REPLY_TO || 'support@castvoo.com',
  },

  // Cas AI. AI_PROVIDER picks who answers: anthropic (default, Claude direct), openrouter (one key, many models) or
  // openai. Admin → Cas AI can override the provider, the OpenRouter model and the key. OPENROUTER_BASE_URL and
  // OPENAI_BASE_URL are for tests/mocks only and are ignored in production.
  ai: {
    provider: String(env.AI_PROVIDER || 'anthropic').trim().toLowerCase(),
    apiKey: env.ANTHROPIC_API_KEY || '',
    apiBase: trimSlash(env.ANTHROPIC_API_BASE || 'https://api.anthropic.com'),
    openrouter: {
      apiKey: env.OPENROUTER_API_KEY || '',
      model: env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.5',
      fallbacks: env.OPENROUTER_FALLBACK_MODELS || '',
      apiBase: trimSlash(((env.NODE_ENV || '') !== 'production' && env.OPENROUTER_BASE_URL) || 'https://openrouter.ai/api/v1'),
    },
    openai: {
      apiKey: env.OPENAI_API_KEY || '',
      model: env.OPENAI_MODEL || 'gpt-4o-mini',
      apiBase: trimSlash(((env.NODE_ENV || '') !== 'production' && env.OPENAI_BASE_URL) || 'https://api.openai.com/v1'),
    },
    timeoutMs: num(env.AI_TIMEOUT_MS, 60000),
    retries: Math.max(0, Math.min(5, Math.floor(num(env.AI_RETRIES, 2)))),
    retryBaseMs: num(env.AI_RETRY_BASE_MS, 800),
  },

  // VooSquare (the Zedapex account hub). All values come from VooSquare → Admin → Products → Castvoo → Credentials.
  voosquare: {
    base: trimSlash(env.VOO_BASE || env.VOO_ISSUER || ''),   // e.g. https://voosquare.com
    clientId: env.VOO_CLIENT_ID || '',
    clientSecret: env.VOO_CLIENT_SECRET || '',
    apiKey: env.VOO_API_KEY || '',                            // Castvoo → VooSquare calls, and VooSquare → Castvoo calls
    serviceKey: env.VOO_SERVICE_KEY || '',                    // optional second key VooSquare may use to call Castvoo
    // Voo Connect kit (./voo-connect): Voo ID login, affiliate hand-off, money events, support widget.
    // VOO_CONNECT=off switches all of it off at once (the email and Telegram logins keep working).
    connect: bool(env.VOO_CONNECT, true),
    signalSecret: env.VOO_SIGNAL_SECRET || '',                // hashes fraud hints; make once, never change
    serverBase: trimSlash(env.VOO_SERVER_BASE || ''),         // optional private address for server-to-server calls
    widget: bool(env.VOO_SUPPORT_WIDGET, true),               // VooSquare support widget on the public website
  },

  paystack: {
    secretKey: env.PAYSTACK_SECRET_KEY || '',
    apiBase: trimSlash(env.PAYSTACK_API_BASE || 'https://api.paystack.co'),
  },

  flutterwave: {
    secretKey: env.FLW_SECRET_KEY || '',
    webhookHash: env.FLW_WEBHOOK_HASH || '',
    apiBase: trimSlash(env.FLW_API_BASE || 'https://api.flutterwave.com'),
  },

  gatevoo: {
    url: trimSlash(env.GATEVOO_URL || ''),
    key: env.GATEVOO_KEY || '',
    webhookSecret: env.GATEVOO_WEBHOOK_SECRET || '',
  },
};

/** Voo ID login + affiliate hand-off: switched on by VOO_CONNECT (default on) and the login credentials. */
config.vooConnectOn = () => !!(config.voosquare.connect && config.voosquare.base && config.voosquare.clientId && config.voosquare.clientSecret);
/** Money and activity events to VooSquare: VOO_CONNECT on, plus the address and the API key. */
config.vooEventsOn = () => !!(config.voosquare.connect && config.voosquare.base && config.voosquare.apiKey);

/** Cas has a key for the provider in use. services/llm.js replaces this with one that also sees Admin → Cas AI. */
config.aiReady = () => !!({ openrouter: config.ai.openrouter.apiKey, openai: config.ai.openai.apiKey }[config.ai.provider] ?? config.ai.apiKey);

config.integrations = () => ({
  telegram: !!config.telegram.botToken,
  email: config.email.provider === 'resend' && !!config.email.resendKey,
  ai: config.aiReady(),
  voosquare_login: config.vooConnectOn(),
  voosquare_api: !!(config.voosquare.apiKey || config.voosquare.serviceKey),
  voosquare_events: config.vooEventsOn(),
  voo_connect: config.vooConnectOn(),
  paystack: !!config.paystack.secretKey,
  flutterwave: !!(config.flutterwave.secretKey && config.flutterwave.webhookHash),
  gatevoo: !!(config.gatevoo.url && config.gatevoo.key && config.gatevoo.webhookSecret),
});

/** Problems that must be fixed before the app can safely serve real users. */
config.problems = () => {
  const p = [];
  if (!config.databaseUrl) p.push('DATABASE_URL is missing. Add a PostgreSQL database in Railway.');
  if (!config.appSecret || config.appSecret.length < 32) p.push('APP_SECRET must be at least 32 random characters.');
  if (config.isProd && !config.appUrl.startsWith('https://')) p.push('APP_URL must start with https:// in production.');
  return p;
};

module.exports = config;

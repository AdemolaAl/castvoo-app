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
  runWorkers: bool(env.RUN_WORKERS, true),
  trustProxy: bool(env.TRUST_PROXY, true),

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

  ai: {
    apiKey: env.ANTHROPIC_API_KEY || '',
    apiBase: trimSlash(env.ANTHROPIC_API_BASE || 'https://api.anthropic.com'),
  },

  google: {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
    // Only change this for tests (a fake login provider). Real logins always use Google.
    issuer: trimSlash(env.GOOGLE_ISSUER || 'https://accounts.google.com'),
  },

  // VooSquare (the Zedapex account hub). All values come from VooSquare → Admin → Products → Castvoo → Credentials.
  voosquare: {
    base: trimSlash(env.VOO_BASE || env.VOO_ISSUER || ''),   // e.g. https://voosquare.com
    clientId: env.VOO_CLIENT_ID || '',
    clientSecret: env.VOO_CLIENT_SECRET || '',
    apiKey: env.VOO_API_KEY || '',                            // Castvoo → VooSquare calls, and VooSquare → Castvoo calls
    serviceKey: env.VOO_SERVICE_KEY || '',                    // optional second key VooSquare may use to call Castvoo
    eventsUrl: env.VOO_EVENTS_URL || '',                      // optional override; default <VOO_BASE>/api/v1/events
    webhookSecret: env.VOO_WEBHOOK_SECRET || '',              // optional: also sign events with X-Voo-Signature
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

config.integrations = () => ({
  telegram: !!config.telegram.botToken,
  email: config.email.provider === 'resend' && !!config.email.resendKey,
  ai: !!config.ai.apiKey,
  google: !!(config.google.clientId && config.google.clientSecret),
  voosquare_login: !!(config.voosquare.base && config.voosquare.clientId && config.voosquare.clientSecret),
  voosquare_api: !!(config.voosquare.apiKey || config.voosquare.serviceKey),
  voosquare_events: !!((config.voosquare.base || config.voosquare.eventsUrl) && config.voosquare.apiKey),
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

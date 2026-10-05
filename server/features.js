'use strict';
/*
 * Feature switches. Each one can be turned on or off in Admin → Features,
 * without a deploy. The website and dashboard hide switched-off features,
 * and the server refuses them.
 *
 * To add a switch: add a line here. It appears in the admin panel automatically.
 * In a route:      await requireFeature('my_key');
 * In the browser:  if (CFG.features.my_key) { ... }
 */

const FEATURES = [
  { key: 'signups',        group: 'Accounts',  name: 'New sign-ups',            about: 'Let new people create accounts.', default: true },
  { key: 'login_email',    group: 'Accounts',  name: 'Email code login',        about: 'Sign in with a 6-digit code sent by email.', default: true },
  { key: 'login_telegram', group: 'Accounts',  name: 'Telegram login',          about: 'Sign in with Telegram (needs CASTVOO_BOT_TOKEN).', default: true },
  { key: 'login_google',   group: 'Accounts',  name: 'Google login',            about: 'Sign in with Google (needs GOOGLE_CLIENT_ID).', default: true },
  { key: 'login_voosquare',group: 'Accounts',  name: 'VooSquare login',         about: 'Continue with Voo ID: VooSquare login and affiliate hand-off (needs VOO_BASE, VOO_CLIENT_ID, VOO_CLIENT_SECRET; VOO_CONNECT on).', default: true },
  { key: 'broadcasts',     group: 'Sending',   name: 'Broadcasts',              about: 'Send messages to bots, channels and groups.', default: true },
  { key: 'drips',          group: 'Sending',   name: 'Auto follow-ups',         about: 'Message sequences that send themselves.', default: true },
  { key: 'join_welcome',   group: 'Sending',   name: 'Join-request welcome',    about: 'Message people who ask to join a channel or group.', default: true },
  { key: 'segments',       group: 'Sending',   name: 'Audiences',               about: 'Send to part of a bot audience.', default: true },
  { key: 'media',          group: 'Sending',   name: 'Photos and videos',       about: 'Attach a photo or video to messages.', default: true },
  { key: 'local_time',     group: 'Sending',   name: 'Send at 9am local time',  about: 'Deliver at 9am in each subscriber\'s time zone.', default: true },
  { key: 'start_links',    group: 'Sending',   name: 'Start links',             about: 'Tagged bot links to see which ad brought each subscriber.', default: true },
  { key: 'ai',             group: 'AI',        name: 'Cas AI',                  about: 'AI writing, rewriting, translating and answers.', default: true },
  { key: 'topups',         group: 'Money',     name: 'Wallet top-ups',          about: 'Let users add money to their wallet.', default: true },
  { key: 'crypto',         group: 'Money',     name: 'Crypto top-ups',          about: 'USDT and Bitcoin (through Gatevoo when connected).', default: true },
  { key: 'referrals',      group: 'Money',     name: 'Referral program',        about: 'Referral links and earnings.', default: true },
  { key: 'withdrawals',    group: 'Money',     name: 'Referral withdrawals',    about: 'Let users request crypto payouts of referral earnings.', default: true },
  { key: 'support_chat',   group: 'Support',   name: 'Support chat',            about: 'Chat with the team from the dashboard.', default: true },
  { key: 'sales_emails',   group: 'Emails',    name: 'Trial follow-up emails',  about: 'The 7 helpful sales emails during and after the trial.', default: true },
  { key: 'maintenance',    group: 'Platform',  name: 'Maintenance mode',        about: 'Pause all sending and sign-ups and show the maintenance message.', default: false },
];

const DEFAULTS = Object.fromEntries(FEATURES.map((f) => [f.key, f.default]));
module.exports = { FEATURES, DEFAULTS };

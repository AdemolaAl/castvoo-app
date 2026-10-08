'use strict';

// Castvoo email templates.
// Each body is an HTML fragment that goes inside layout(). Only {{var}}
// variables are used. Global vars (always available, not listed in
// `vars`): first_name, app_url, site_url, support_email, company_name,
// company_address, unsubscribe_url, billing_email, privacy_email,
// data_retention_days.
//
// Copy rules (docs/PRODUCT-FACTS.md is the source of truth): every claim must
// be true, no made-up numbers, deadlines, discounts or testimonials, no
// promises of results. Login, security, legal and data emails stay plain:
// no selling in them.

const { h1, p, small, button, infoBox, receipt, steps, codeBox, mono, signoff } = require('./layout');

const TEAM = 'The Castvoo team';
const CAS = 'Cas from Castvoo';

// Small copy helpers (inline styles only, like layout.js).
const B = (t) => `<strong style="color:#0B1430;">${t}</strong>`;
const link = (url, label) => `<a href="${url}" target="_blank" style="color:#2F6BFF;font-weight:600;">${label}</a>`;
const lead = (t) => p(B(t), 'margin-bottom:12px;');
const ps = (t) => p(`${B('P.S.')} ${t}`, 'margin:20px 0 0 0;font-size:15px;');
// "Still running / Paused" style box: groups = [[title, [line, ...]], ...]
const listBox = (groups) => infoBox(groups.map(([title, lines]) => `${B(title)}<br>${lines.map((l) => `&bull;&nbsp; ${l}`).join('<br>')}`).join('<br><br>'));
const listText = (groups) => groups.map(([title, lines]) => `${title}\n${lines.map((l) => `- ${l}`).join('\n')}`).join('\n\n');

const FREE_KEEPS = ['Your first live Welcome Flow: it still welcomes people and lets them in', 'Its welcome now ends with a short "Free welcome bot by Castvoo.com" line'];
const FREE_PAUSES = ['Follow-up steps in your Welcome Flows', 'Auto follow-ups', 'Broadcasts', 'Cas, your AI helper', 'Your other flows and your stats'];

const templates = {
  // ------------------------------------------------------------------
  // TRANSACTIONAL
  // ------------------------------------------------------------------

  login_code: {
    category: 'transactional',
    name: 'Login code',
    when: 'Sent when someone asks to log in with their email address.',
    subject: 'Your Castvoo login code: {{code}}',
    preheader: 'Enter this code to log in. It expires in 10 minutes.',
    vars: ['code'],
    body: [
      h1('Your login code'),
      p('Hi {{first_name}}, enter this code on the Castvoo login screen:'),
      codeBox('{{code}}'),
      p('The code expires in 10 minutes and works only once.'),
      infoBox('<strong>Keep it to yourself.</strong> Anyone with this code can open your account. The Castvoo team will never ask you for it.'),
      small("Didn't ask for this? You can ignore this email. Nobody can log in without the code."),
      signoff(TEAM),
    ].join('\n'),
    text: `Your login code

Hi {{first_name}}, enter this code on the Castvoo login screen:

{{code}}

The code expires in 10 minutes and works only once.

Keep it to yourself. Anyone with this code can open your account. The Castvoo team will never ask you for it.

Didn't ask for this? You can ignore this email. Nobody can log in without the code.

${TEAM}`,
  },

  welcome: {
    category: 'transactional',
    name: 'Welcome',
    when: 'Sent right after a new account is created and the free trial starts.',
    subject: 'Welcome to Castvoo, {{first_name}} 👋 Your trial is live',
    preheader: 'The full Growth plan is yours until {{trial_end_date}}. No card. Here is how to get your first welcome live today.',
    vars: ['trial_end_date', 'guide_url'],
    body: [
      h1(`You're in, {{first_name}}. Let's get your first welcome live.`),
      p(`Every person who asks to join your channel is a warm lead. Most channels let them in and never say a word.`),
      p(`With Castvoo, your own bot greets each one by name, lets them in and follows up later. All by itself, day and night.`),
      p(`Your trial gives you the full ${B('Growth plan until {{trial_end_date}}')}. No card needed.`),
      lead('Get your first win today:'),
      steps([
        ['Connect Telegram', 'Add @CastvooBot as an admin to your channel or group. Then connect your own bot by pasting its token from BotFather.'],
        ['Switch on a Welcome Flow', 'Open Welcome Flows and pick a template, like "Welcome + VIP link button". Change the words, then make it live. Castvoo checks your setup and tells you what to fix.'],
        ['Send your first broadcast', 'Reach everyone who started your bot at once. Send it now, schedule it, or send it at 9am.'],
      ]),
      button('{{app_url}}/flows', 'Set up my first Welcome Flow'),
      infoBox(`${B('Stuck on words? Ask Cas.')}<br>Cas, your AI helper, writes, rewrites and translates your messages, and can plan a whole follow-up series. Need a hand with setup? The support chat in your dashboard is open 24/7, with our team as back-up.`),
      p(`Like to read first? The ${link('{{guide_url}}', 'quick start guide')} shows every step.`),
      signoff(CAS),
      ps(`Your trial includes A/B welcomes. Test two versions of your welcome and keep the one that gets more clicks.`),
    ].join('\n'),
    text: `You're in, {{first_name}}. Let's get your first welcome live.

Every person who asks to join your channel is a warm lead. Most channels let them in and never say a word.

With Castvoo, your own bot greets each one by name, lets them in and follows up later. All by itself, day and night.

Your trial gives you the full Growth plan until {{trial_end_date}}. No card needed.

Get your first win today:

1. Connect Telegram
   Add @CastvooBot as an admin to your channel or group. Then connect your own bot by pasting its token from BotFather.

2. Switch on a Welcome Flow
   Open Welcome Flows and pick a template, like "Welcome + VIP link button". Change the words, then make it live. Castvoo checks your setup and tells you what to fix.

3. Send your first broadcast
   Reach everyone who started your bot at once. Send it now, schedule it, or send it at 9am.

Set up my first Welcome Flow: {{app_url}}/flows

Stuck on words? Ask Cas. Cas, your AI helper, writes, rewrites and translates your messages, and can plan a whole follow-up series. Need a hand with setup? The support chat in your dashboard is open 24/7, with our team as back-up.

Like to read first? Quick start guide: {{guide_url}}

${CAS}

P.S. Your trial includes A/B welcomes. Test two versions of your welcome and keep the one that gets more clicks.`,
  },

  team_invite: {
    category: 'transactional',
    name: 'Team invite',
    when: 'Sent when a workspace member invites someone to join their workspace.',
    // The workspace name is the owner's own text, so it stays out of the subject line (SEC-12).
    subject: '{{inviter_name}} invited you to their team on Castvoo',
    preheader: 'Accept the invite to start working together on Castvoo.',
    vars: ['inviter_name', 'workspace_name', 'invite_url'],
    body: [
      h1("You've been invited to {{workspace_name}}"),
      p('Hi there,'),
      p('<strong>{{inviter_name}}</strong> wants you to help run <strong>{{workspace_name}}</strong> on Castvoo. Castvoo welcomes new Telegram members, sends broadcasts and runs follow-up messages by itself.'),
      p('Tap the button to accept. If you are new to Castvoo, you will create your login first.'),
      button('{{invite_url}}', 'Accept invite'),
      small('This invite is just for you, so please do not forward it. Not expecting it? You can ignore this email. Nothing happens unless you accept.'),
      signoff(CAS),
    ].join('\n'),
    text: `You've been invited to {{workspace_name}}

Hi there,

{{inviter_name}} wants you to help run {{workspace_name}} on Castvoo. Castvoo welcomes new Telegram members, sends broadcasts and runs follow-up messages by itself.

Open the link to accept. If you are new to Castvoo, you will create your login first.

Accept invite: {{invite_url}}

This invite is just for you, so please do not forward it. Not expecting it? You can ignore this email. Nothing happens unless you accept.

${CAS}`,
  },

  staff_invite: {
    category: 'transactional',
    name: 'Staff invite',
    when: 'Sent when an admin invites someone to the Castvoo staff team.',
    subject: "You're invited to the Castvoo staff team",
    preheader: '{{inviter_name}} added you as {{role_name}}. Accept to get access.',
    vars: ['inviter_name', 'role_name', 'admin_url'],
    body: [
      h1('Join the Castvoo staff team'),
      p('Hi there,'),
      p('<strong>{{inviter_name}}</strong> has invited you to the Castvoo staff team with the role <strong>{{role_name}}</strong>.'),
      p('Your role decides what you can see and do in the admin area. Every staff action is recorded in an audit log, which keeps our customers and our team safe.'),
      button('{{admin_url}}', 'Open the admin area'),
      infoBox('<strong>Please keep your login safe.</strong> Staff accounts can see customer information. Never share your login code, and log out on shared devices.'),
      small('Not expecting this? Do not open the link. Write to {{support_email}} so we can check.'),
      signoff(TEAM),
    ].join('\n'),
    text: `Join the Castvoo staff team

Hi there,

{{inviter_name}} has invited you to the Castvoo staff team with the role {{role_name}}.

Your role decides what you can see and do in the admin area. Every staff action is recorded in an audit log, which keeps our customers and our team safe.

Open the admin area: {{admin_url}}

Please keep your login safe. Staff accounts can see customer information. Never share your login code, and log out on shared devices.

Not expecting this? Do not open the link. Write to {{support_email}} so we can check.

${TEAM}`,
  },

  trial_ending: {
    category: 'transactional',
    name: 'Trial ending soon',
    when: 'Sent when the free trial has less than 2 days left.',
    subject: 'Your trial ends on {{trial_end_date}}: keep it running',
    preheader: 'Top up {{plan_price}} and your welcomes, follow-ups and broadcasts keep going without a gap.',
    vars: ['trial_end_date', 'plan_name', 'plan_price', 'wallet_balance', 'topup_url'],
    body: [
      h1('Your trial ends on {{trial_end_date}}'),
      p(`Hi {{first_name}}, your Castvoo trial is nearly over. Here is all you need to keep everything running:`),
      receipt([
        ['Plan', '{{plan_name}}'],
        ['Price', '{{plan_price}}'],
        ['Your wallet balance', '{{wallet_balance}}'],
      ]),
      p(`${B('If your wallet covers the price,')} nothing changes. Your plan starts by itself, paid from your wallet.`),
      p(`${B('If it is short,')} you move to the Free plan. Your first live Welcome Flow keeps welcoming people, with a Castvoo line added. Your follow-ups, broadcasts and Cas pause. Nothing is deleted.`),
      button('{{topup_url}}', 'Top up and keep {{plan_name}}'),
      small('Pay with the local options for your country, or with crypto. Want a different plan? Pick one in your wallet before {{trial_end_date}}.'),
      signoff(TEAM),
    ].join('\n'),
    text: `Your trial ends on {{trial_end_date}}

Hi {{first_name}}, your Castvoo trial is nearly over. Here is all you need to keep everything running:

Plan: {{plan_name}}
Price: {{plan_price}}
Your wallet balance: {{wallet_balance}}

If your wallet covers the price, nothing changes. Your plan starts by itself, paid from your wallet.

If it is short, you move to the Free plan. Your first live Welcome Flow keeps welcoming people, with a Castvoo line added. Your follow-ups, broadcasts and Cas pause. Nothing is deleted.

Top up and keep {{plan_name}}: {{topup_url}}

Pay with the local options for your country, or with crypto. Want a different plan? Pick one in your wallet before {{trial_end_date}}.

${TEAM}`,
  },

  trial_ended: {
    category: 'transactional',
    name: 'Trial ended, sending paused',
    when: 'Sent when the free trial ends, the wallet could not pay for the plan and there is no Free plan to move to (old rule).',
    subject: 'Your trial has ended. Everything is saved',
    preheader: 'Sending is paused for now. Top up and pick up right where you stopped.',
    vars: ['plan_name', 'plan_price', 'topup_url'],
    body: [
      h1('Your trial has ended'),
      p('Hi {{first_name}}, your free trial is over. Your wallet did not have enough to start the <strong>{{plan_name}}</strong> plan ({{plan_price}}), so sending is paused.'),
      p(`That means your welcomes, follow-ups and broadcasts are on hold right now. The good news: nothing is deleted. Your bots, channels, flows, messages and subscribers are all still here.`),
      button('{{topup_url}}', 'Top up and switch it back on'),
      p('As soon as your wallet covers {{plan_name}}, your plan starts and sending picks up again.'),
      infoBox(`${B('How long we keep your data')}<br>We keep your data for {{data_retention_days}} days after a plan ends. After that, it is deleted for good.`),
      signoff(TEAM),
    ].join('\n'),
    text: `Your trial has ended

Hi {{first_name}}, your free trial is over. Your wallet did not have enough to start the {{plan_name}} plan ({{plan_price}}), so sending is paused.

That means your welcomes, follow-ups and broadcasts are on hold right now. The good news: nothing is deleted. Your bots, channels, flows, messages and subscribers are all still here.

Top up and switch it back on: {{topup_url}}

As soon as your wallet covers {{plan_name}}, your plan starts and sending picks up again.

How long we keep your data: we keep your data for {{data_retention_days}} days after a plan ends. After that, it is deleted for good.

${TEAM}`,
  },

  payment_receipt: {
    category: 'transactional',
    name: 'Plan payment receipt',
    when: 'Sent each time a plan is paid from the wallet.',
    subject: 'Receipt for your {{plan_name}} plan',
    preheader: 'We paid {{amount}} from your wallet. Receipt {{receipt_id}}. You are all set.',
    vars: ['plan_name', 'amount', 'period_start', 'period_end', 'receipt_id', 'wallet_balance', 'billing_url'],
    body: [
      h1('Thanks, your {{plan_name}} plan is paid'),
      p('Hi {{first_name}}, we paid for your <strong>{{plan_name}}</strong> plan from your Castvoo wallet. Your welcomes and follow-ups keep running. Here is your receipt.'),
      receipt([
        ['Receipt', '{{receipt_id}}'],
        ['Plan', '{{plan_name}}'],
        ['Period', '{{period_start}} to {{period_end}}'],
        ['Wallet balance now', '{{wallet_balance}}'],
        ['Paid from wallet', '{{amount}}'],
      ], { boldLast: true }),
      button('{{billing_url}}', 'View billing'),
      infoBox(`${B('Tip: pay yearly and get 2 months free.')}<br>A yearly plan costs 10 months and runs for 12. You can switch to yearly in your wallet.`),
      small('Plan payments cannot be refunded once a billing period starts. If you were charged twice or something looks wrong, write to {{support_email}} with your receipt number and we will put it right.'),
      signoff(TEAM),
    ].join('\n'),
    text: `Thanks, your {{plan_name}} plan is paid

Hi {{first_name}}, we paid for your {{plan_name}} plan from your Castvoo wallet. Your welcomes and follow-ups keep running. Here is your receipt.

Receipt: {{receipt_id}}
Plan: {{plan_name}}
Period: {{period_start}} to {{period_end}}
Wallet balance now: {{wallet_balance}}
Paid from wallet: {{amount}}

View billing: {{billing_url}}

Tip: pay yearly and get 2 months free. A yearly plan costs 10 months and runs for 12. You can switch to yearly in your wallet.

Plan payments cannot be refunded once a billing period starts. If you were charged twice or something looks wrong, write to {{support_email}} with your receipt number and we will put it right.

${TEAM}`,
  },

  renewal_low_balance: {
    category: 'transactional',
    name: 'Renewal coming, low balance',
    when: 'Sent a few days before renewal (Settings → Billing → reminder days) when the wallet is too low to pay for the plan.',
    subject: 'Top up before {{renewal_date}} to keep {{plan_name}}',
    preheader: 'Your wallet has {{wallet_balance}}. Your plan needs {{amount}}. A quick top-up keeps everything on.',
    vars: ['plan_name', 'amount', 'renewal_date', 'wallet_balance', 'topup_url'],
    body: [
      h1('Your plan renews on {{renewal_date}}'),
      p('Hi {{first_name}}, your <strong>{{plan_name}}</strong> plan renews soon, and your wallet is a little short.'),
      receipt([
        ['Renewal date', '{{renewal_date}}'],
        ['Renewal price', '{{amount}}'],
        ['Your wallet balance', '{{wallet_balance}}'],
      ]),
      p(`${B('Top up before {{renewal_date}}')} and nothing changes.`),
      p(`If the wallet is still short that day, you move to the Free plan. Your first live Welcome Flow keeps welcoming people, but your follow-ups, broadcasts and Cas pause. Nothing is deleted, and {{plan_name}} starts again by itself once a top-up covers it.`),
      button('{{topup_url}}', 'Top up now'),
      small('Paying in your local currency? You will see the amount before you pay. Not planning to continue? You can cancel in Settings. Your plan runs until the end of the period you already paid for.'),
      signoff(TEAM),
    ].join('\n'),
    text: `Your plan renews on {{renewal_date}}

Hi {{first_name}}, your {{plan_name}} plan renews soon, and your wallet is a little short.

Renewal date: {{renewal_date}}
Renewal price: {{amount}}
Your wallet balance: {{wallet_balance}}

Top up before {{renewal_date}} and nothing changes.

If the wallet is still short that day, you move to the Free plan. Your first live Welcome Flow keeps welcoming people, but your follow-ups, broadcasts and Cas pause. Nothing is deleted, and {{plan_name}} starts again by itself once a top-up covers it.

Top up now: {{topup_url}}

Paying in your local currency? You will see the amount before you pay. Not planning to continue? You can cancel in Settings. Your plan runs until the end of the period you already paid for.

${TEAM}`,
  },

  price_change: {
    category: 'transactional',
    name: 'Price change notice',
    when: 'Sent to people already paying for a plan when the team raises its price. They keep the old price for 30 days.',
    subject: 'Your {{plan_name}} price is changing on {{start_date}}',
    preheader: 'Nothing changes for the next 30 days. Here is what happens after that.',
    vars: ['plan_name', 'old_price', 'new_price', 'billing_period', 'start_date', 'billing_url'],
    body: [
      h1('A price change, with 30 days\' notice'),
      p('Hi {{first_name}}, we are changing the price of the <strong>{{plan_name}}</strong> plan from <strong>{{old_price}}</strong> to <strong>{{new_price}}</strong> a {{billing_period}}.'),
      p('Nothing changes for you until <strong>{{start_date}}</strong>. Any renewal before then is still charged at {{old_price}}. From that date, renewals use the new price.'),
      p('If you would like a different plan, or to cancel, you can do that any time in your dashboard. Cancelling keeps your plan running until the end of the period you already paid for.'),
      button('{{billing_url}}', 'See my plan'),
      signoff(TEAM),
    ].join('\n'),
    text: `A price change, with 30 days' notice

Hi {{first_name}}, we are changing the price of the {{plan_name}} plan from {{old_price}} to {{new_price}} a {{billing_period}}.

Nothing changes for you until {{start_date}}. Any renewal before then is still charged at {{old_price}}. From that date, renewals use the new price.

If you would like a different plan, or to cancel, you can do that any time in your dashboard. Cancelling keeps your plan running until the end of the period you already paid for.

See my plan: {{billing_url}}

${TEAM}`,
  },

  plan_paused: {
    category: 'transactional',
    name: 'Plan paused, renewal failed',
    when: 'Sent when a plan could not renew because the wallet balance was too low and there is no Free plan to move to (old rule).',
    subject: 'We could not renew your {{plan_name}} plan',
    preheader: 'Sending is paused, but everything is saved. Top up to switch it back on.',
    vars: ['plan_name', 'amount', 'topup_url'],
    body: [
      h1('Sending is paused'),
      p('Hi {{first_name}}, we tried to renew your <strong>{{plan_name}}</strong> plan for <strong>{{amount}}</strong>, but your wallet did not have enough.'),
      p('So right now your welcomes, follow-ups and broadcasts are on hold. Your account is safe, and nothing has been deleted.'),
      button('{{topup_url}}', 'Top up and restart'),
      p('Once your wallet covers {{amount}}, your plan renews and sending picks up again.'),
      infoBox(`${B('How long we keep your data')}<br>We keep your data for {{data_retention_days}} days after a plan ends. After that, it is deleted for good.`),
      signoff(TEAM),
    ].join('\n'),
    text: `Sending is paused

Hi {{first_name}}, we tried to renew your {{plan_name}} plan for {{amount}}, but your wallet did not have enough.

So right now your welcomes, follow-ups and broadcasts are on hold. Your account is safe, and nothing has been deleted.

Top up and restart: {{topup_url}}

Once your wallet covers {{amount}}, your plan renews and sending picks up again.

How long we keep your data: we keep your data for {{data_retention_days}} days after a plan ends. After that, it is deleted for good.

${TEAM}`,
  },

  topup_received: {
    category: 'transactional',
    name: 'Wallet top-up received',
    when: 'Sent when money is added to the wallet.',
    subject: 'Your wallet was topped up with {{amount}}',
    preheader: 'Your new Castvoo wallet balance is {{new_balance}}. Nothing else to do.',
    vars: ['amount', 'bonus', 'method', 'new_balance', 'receipt_id', 'wallet_url'],
    body: [
      h1('Your wallet is topped up'),
      p('Hi {{first_name}}, thanks. Your top-up is in your Castvoo wallet.'),
      receipt([
        ['Receipt', '{{receipt_id}}'],
        ['Paid with', '{{method}}'],
        ['Top-up', '{{amount}}'],
        ['Bonus credit', '{{bonus}}'],
        ['New balance', '{{new_balance}}'],
      ], { boldLast: true }),
      p('Your plan is paid from your wallet when it is due, so there is nothing else to do.'),
      button('{{wallet_url}}', 'View my wallet'),
      infoBox(`${B('Know other channel owners?')}<br>Share your referral link from the Referrals page. You earn a share of every plan they pay for, every month, for as long as they pay.`),
      small('Bonus credit can only be spent on plans. It cannot be refunded or withdrawn.'),
      signoff(TEAM),
    ].join('\n'),
    text: `Your wallet is topped up

Hi {{first_name}}, thanks. Your top-up is in your Castvoo wallet.

Receipt: {{receipt_id}}
Paid with: {{method}}
Top-up: {{amount}}
Bonus credit: {{bonus}}
New balance: {{new_balance}}

Your plan is paid from your wallet when it is due, so there is nothing else to do.

View my wallet: {{wallet_url}}

Know other channel owners? Share your referral link from the Referrals page. You earn a share of every plan they pay for, every month, for as long as they pay.

Bonus credit can only be spent on plans. It cannot be refunded or withdrawn.

${TEAM}`,
  },

  crypto_submitted: {
    category: 'transactional',
    name: 'Crypto payment submitted',
    when: 'Sent when a user pastes a crypto transaction ID for a wallet top-up.',
    subject: 'We got your {{coin}} transaction ID',
    preheader: 'Our team is confirming your payment. This usually takes a few hours.',
    vars: ['amount', 'coin', 'txid'],
    body: [
      h1('We are checking your payment'),
      p('Hi {{first_name}}, thanks. We received the transaction ID for your {{coin}} top-up. Our team is confirming it now. This usually takes a few hours.'),
      receipt([
        ['Top-up', '{{amount}}'],
        ['Coin', '{{coin}}'],
        ['Transaction ID', mono('{{txid}}')],
      ]),
      p('You do not need to do anything else. We will email you as soon as your wallet is credited.'),
      small('Spotted a mistake in the transaction ID? Write to {{support_email}} and include the correct one.'),
      signoff(TEAM),
    ].join('\n'),
    text: `We are checking your payment

Hi {{first_name}}, thanks. We received the transaction ID for your {{coin}} top-up. Our team is confirming it now. This usually takes a few hours.

Top-up: {{amount}}
Coin: {{coin}}
Transaction ID: {{txid}}

You do not need to do anything else. We will email you as soon as your wallet is credited.

Spotted a mistake in the transaction ID? Write to {{support_email}} and include the correct one.

${TEAM}`,
  },

  crypto_rejected: {
    category: 'transactional',
    name: 'Crypto payment not confirmed',
    when: 'Sent when the team cannot confirm a crypto top-up.',
    subject: 'We could not confirm your {{coin}} payment',
    preheader: 'Your wallet was not credited yet. Here is why, and how to fix it.',
    vars: ['amount', 'coin', 'txid', 'reason'],
    body: [
      h1('We could not confirm your payment'),
      p('Hi {{first_name}}, we checked your {{coin}} top-up but could not confirm it, so your wallet has not been credited yet.'),
      infoBox(`${B('Reason')}<br>{{reason}}`),
      receipt([
        ['Top-up', '{{amount}}'],
        ['Coin', '{{coin}}'],
        ['Transaction ID', mono('{{txid}}')],
      ]),
      p(`${B('How to fix it:')} check that the transaction ID is correct and that the coins went to the address shown in your wallet. Then submit it again from your wallet page.`),
      button('{{app_url}}', 'Open my wallet'),
      small('Sure you sent the payment? Write to {{support_email}} with the transaction ID and we will look again.'),
      signoff(TEAM),
    ].join('\n'),
    text: `We could not confirm your payment

Hi {{first_name}}, we checked your {{coin}} top-up but could not confirm it, so your wallet has not been credited yet.

Reason: {{reason}}

Top-up: {{amount}}
Coin: {{coin}}
Transaction ID: {{txid}}

How to fix it: check that the transaction ID is correct and that the coins went to the address shown in your wallet. Then submit it again from your wallet page.

Open my wallet: {{app_url}}

Sure you sent the payment? Write to {{support_email}} with the transaction ID and we will look again.

${TEAM}`,
  },

  topup_submitted: {
    category: 'transactional',
    name: 'Manual top-up sent for checking',
    when: 'Sent when a user says they paid with one of the team\'s manual methods (bank transfer, mobile money...).',
    subject: 'We are checking your {{method}} payment',
    preheader: 'Our team is confirming your payment. This usually takes a few hours.',
    vars: ['amount', 'method', 'reference'],
    body: [
      h1('We are checking your payment'),
      p('Hi {{first_name}}, thanks. We got your {{method}} top-up details. Our team is confirming the payment now. This usually takes a few hours.'),
      receipt([
        ['Top-up', '{{amount}}'],
        ['Paid with', '{{method}}'],
        ['Reference', mono('{{reference}}')],
      ]),
      p('You do not need to do anything else. We will email you as soon as your wallet is credited.'),
      small('Spotted a mistake in the reference? Write to {{support_email}} and include the correct one.'),
      signoff(TEAM),
    ].join('\n'),
    text: `We are checking your payment

Hi {{first_name}}, thanks. We got your {{method}} top-up details. Our team is confirming the payment now. This usually takes a few hours.

Top-up: {{amount}}
Paid with: {{method}}
Reference: {{reference}}

You do not need to do anything else. We will email you as soon as your wallet is credited.

Spotted a mistake in the reference? Write to {{support_email}} and include the correct one.

${TEAM}`,
  },

  topup_rejected: {
    category: 'transactional',
    name: 'Manual top-up not confirmed',
    when: 'Sent when the team cannot confirm a top-up made with one of their manual methods.',
    subject: 'We could not confirm your {{method}} payment',
    preheader: 'Your wallet was not credited yet. Here is why, and how to fix it.',
    vars: ['amount', 'method', 'reference', 'reason'],
    body: [
      h1('We could not confirm your payment'),
      p('Hi {{first_name}}, we checked your {{method}} top-up but could not confirm it, so your wallet has not been credited yet.'),
      infoBox(`${B('Reason')}<br>{{reason}}`),
      receipt([
        ['Top-up', '{{amount}}'],
        ['Paid with', '{{method}}'],
        ['Reference', mono('{{reference}}')],
      ]),
      p(`${B('How to fix it:')} check that you paid the exact amount to the account shown in your wallet, then start a new top-up.`),
      button('{{app_url}}', 'Open my wallet'),
      small('Sure you paid? Write to {{support_email}} with the reference and a screenshot, and we will look again.'),
      signoff(TEAM),
    ].join('\n'),
    text: `We could not confirm your payment

Hi {{first_name}}, we checked your {{method}} top-up but could not confirm it, so your wallet has not been credited yet.

Reason: {{reason}}

Top-up: {{amount}}
Paid with: {{method}}
Reference: {{reference}}

How to fix it: check that you paid the exact amount to the account shown in your wallet, then start a new top-up.

Open my wallet: {{app_url}}

Sure you paid? Write to {{support_email}} with the reference and a screenshot, and we will look again.

${TEAM}`,
  },

  referral_earned: {
    category: 'transactional',
    name: 'Referral earning',
    when: 'Sent when someone the user referred pays for a plan.',
    subject: 'You earned {{amount}} from a referral 🎉',
    preheader: '{{referral_name}} paid for their plan. Your share settles on {{settle_date}}. And it repeats.',
    vars: ['amount', 'referral_name', 'settle_date', 'referrals_url'],
    body: [
      h1('You just earned {{amount}}'),
      p('Nice one, {{first_name}}. <strong>{{referral_name}}</strong> signed up through your link and just paid for their plan. Your share is <strong>{{amount}}</strong>.'),
      receipt([
        ['Earned', '{{amount}}'],
        ['Settles on', '{{settle_date}}'],
      ]),
      p(`${B('Here is the best part:')} this is not a one-off. You earn every time {{referral_name}} pays, every month, for as long as they stay on a paid plan.`),
      p('And your share grows as you go: 10% with 1 to 4 paying referrals, 20% from 5, and 30% from 20.'),
      button('{{referrals_url}}', 'Share my link again'),
      small('Once earnings settle, use them to pay for your own plan, or withdraw them in USDT (TRC20) or Bitcoin from $300. We hold new earnings for 30 days in case of refunds or chargebacks.'),
      signoff(CAS),
      ps(`Good places to share: your channel, a pinned post in your group, or your Telegram bio. Just no paid ads on the word "Castvoo".`),
    ].join('\n'),
    text: `You just earned {{amount}}

Nice one, {{first_name}}. {{referral_name}} signed up through your link and just paid for their plan. Your share is {{amount}}.

Earned: {{amount}}
Settles on: {{settle_date}}

Here is the best part: this is not a one-off. You earn every time {{referral_name}} pays, every month, for as long as they stay on a paid plan.

And your share grows as you go: 10% with 1 to 4 paying referrals, 20% from 5, and 30% from 20.

Share my link again: {{referrals_url}}

Once earnings settle, use them to pay for your own plan, or withdraw them in USDT (TRC20) or Bitcoin from $300. We hold new earnings for 30 days in case of refunds or chargebacks.

${CAS}

P.S. Good places to share: your channel, a pinned post in your group, or your Telegram bio. Just no paid ads on the word "Castvoo".`,
  },

  withdrawal_requested: {
    category: 'transactional',
    name: 'Withdrawal requested',
    when: 'Sent when a user asks to withdraw settled referral earnings.',
    subject: 'We got your withdrawal request for {{amount}}',
    preheader: 'We pay withdrawals within 5 business days.',
    vars: ['amount', 'coin', 'address'],
    body: [
      h1('Your withdrawal request is in'),
      p('Hi {{first_name}}, we received your request to withdraw your referral earnings.'),
      receipt([
        ['Amount', '{{amount}}'],
        ['Paid in', '{{coin}}'],
        ['To address', mono('{{address}}')],
      ]),
      p('We pay withdrawals within 5 business days. We will email you the transaction ID once it is sent.'),
      infoBox(`${B('Please check the address above.')} Crypto sent to a wrong address cannot be brought back. If anything is wrong, write to {{support_email}} right away.`),
      signoff(TEAM),
    ].join('\n'),
    text: `Your withdrawal request is in

Hi {{first_name}}, we received your request to withdraw your referral earnings.

Amount: {{amount}}
Paid in: {{coin}}
To address: {{address}}

We pay withdrawals within 5 business days. We will email you the transaction ID once it is sent.

Please check the address above. Crypto sent to a wrong address cannot be brought back. If anything is wrong, write to {{support_email}} right away.

${TEAM}`,
  },

  withdrawal_paid: {
    category: 'transactional',
    name: 'Withdrawal paid',
    when: 'Sent when a referral withdrawal has been sent to the user.',
    subject: 'Your {{amount}} withdrawal has been sent',
    preheader: 'Your {{coin}} is on its way. Here is the transaction ID.',
    vars: ['amount', 'coin', 'address', 'txid'],
    body: [
      h1('Your withdrawal is on its way'),
      p('Hi {{first_name}}, we have sent your referral earnings.'),
      receipt([
        ['Amount', '{{amount}}'],
        ['Paid in', '{{coin}}'],
        ['To address', mono('{{address}}')],
        ['Transaction ID', mono('{{txid}}')],
      ]),
      p('The network may take a little while to confirm it. You can look up the transaction ID in any {{coin}} block explorer to follow it.'),
      p('Thank you for sharing Castvoo.'),
      signoff(TEAM),
    ].join('\n'),
    text: `Your withdrawal is on its way

Hi {{first_name}}, we have sent your referral earnings.

Amount: {{amount}}
Paid in: {{coin}}
To address: {{address}}
Transaction ID: {{txid}}

The network may take a little while to confirm it. You can look up the transaction ID in any {{coin}} block explorer to follow it.

Thank you for sharing Castvoo.

${TEAM}`,
  },

  withdrawal_rejected: {
    category: 'transactional',
    name: 'Withdrawal not approved',
    when: 'Sent when a referral withdrawal request is turned down.',
    subject: 'We could not process your {{amount}} withdrawal',
    preheader: 'Here is why, and what you can do next.',
    vars: ['amount', 'reason', 'referrals_url'],
    body: [
      h1('Your withdrawal was not approved'),
      p('Hi {{first_name}}, we could not process your request to withdraw <strong>{{amount}}</strong>.'),
      infoBox(`${B('Reason')}<br>{{reason}}`),
      p('You can check your earnings and send a new request from your Referrals page.'),
      button('{{referrals_url}}', 'Go to my referrals'),
      small('Think we got this wrong? Write to {{support_email}} and we will take another look.'),
      signoff(TEAM),
    ].join('\n'),
    text: `Your withdrawal was not approved

Hi {{first_name}}, we could not process your request to withdraw {{amount}}.

Reason: {{reason}}

You can check your earnings and send a new request from your Referrals page.

Go to my referrals: {{referrals_url}}

Think we got this wrong? Write to {{support_email}} and we will take another look.

${TEAM}`,
  },

  support_reply: {
    category: 'transactional',
    name: 'Support reply',
    when: 'Sent when Castvoo support replies in the support chat and the user is away.',
    subject: '{{agent_name}} replied to your support message',
    preheader: '{{message_preview}}',
    vars: ['agent_name', 'message_preview', 'support_url'],
    body: [
      h1('You have a reply from support'),
      p('Hi {{first_name}}, <strong>{{agent_name}}</strong> from Castvoo support replied to you:'),
      infoBox('<span style="color:#33405C;">{{message_preview}}</span>'),
      button('{{support_url}}', 'Read and reply'),
      small('Please reply in the support chat so the whole conversation stays in one place.'),
      signoff(TEAM),
    ].join('\n'),
    text: `You have a reply from support

Hi {{first_name}}, {{agent_name}} from Castvoo support replied to you:

"{{message_preview}}"

Read and reply: {{support_url}}

Please reply in the support chat so the whole conversation stays in one place.

${TEAM}`,
  },

  broadcast_finished: {
    category: 'transactional',
    name: 'Broadcast finished',
    when: 'Sent when a broadcast has finished sending.',
    subject: '"{{broadcast_title}}" has finished sending',
    preheader: '{{delivered}} delivered, {{clicks}} clicks so far. See who tapped.',
    vars: ['broadcast_title', 'delivered', 'failed', 'clicks', 'report_url'],
    body: [
      h1('Your broadcast is out'),
      p('Hi {{first_name}}, <strong>{{broadcast_title}}</strong> has finished sending. Here is how it went:'),
      receipt([
        ['Delivered', '{{delivered}}'],
        ['Could not deliver', '{{failed}}'],
        ['Button clicks so far', '{{clicks}}'],
      ]),
      button('{{report_url}}', 'See the full report'),
      p('A message that could not be delivered is often to someone who blocked your bot. Castvoo removes blocked users for you, so your list stays clean.'),
      infoBox(`${B('Make the next one work by itself.')}<br>Set up an auto follow-up and every new person who starts your bot gets your welcome and your next messages, without you pressing send. ${link('{{app_url}}/drips', 'Set one up')}`),
      small('Castvoo cannot see who read a message, so button clicks are your best sign of interest. For channel posts, you can see views and reactions inside Telegram.'),
      signoff(CAS),
    ].join('\n'),
    text: `Your broadcast is out

Hi {{first_name}}, {{broadcast_title}} has finished sending. Here is how it went:

Delivered: {{delivered}}
Could not deliver: {{failed}}
Button clicks so far: {{clicks}}

See the full report: {{report_url}}

A message that could not be delivered is often to someone who blocked your bot. Castvoo removes blocked users for you, so your list stays clean.

Make the next one work by itself. Set up an auto follow-up and every new person who starts your bot gets your welcome and your next messages, without you pressing send: {{app_url}}/drips

Castvoo cannot see who read a message, so button clicks are your best sign of interest. For channel posts, you can see views and reactions inside Telegram.

${CAS}`,
  },

  limit_reached: {
    category: 'transactional',
    name: 'Plan limit reached',
    when: 'Sent when a workspace reaches its subscriber or connection limit.',
    subject: 'You reached the {{limit_name}} limit on {{plan_name}}',
    preheader: 'A good problem to have. Nothing is deleted. Upgrade to keep growing.',
    vars: ['limit_name', 'plan_name', 'upgrade_url'],
    body: [
      h1('You are growing. Nice.'),
      p('Hi {{first_name}}, your workspace has reached the <strong>{{limit_name}}</strong> limit on the <strong>{{plan_name}}</strong> plan.'),
      p('Anything over the limit waits until you upgrade, so sending is paused there. Nothing has been deleted, and everything inside your limit keeps running.'),
      button('{{upgrade_url}}', 'See bigger plans'),
      small('No setup fees and no add-on fees. A bigger plan is paid from your wallet like any other. Need more than our biggest plan? Write to {{support_email}} and we will talk.'),
      signoff(TEAM),
    ].join('\n'),
    text: `You are growing. Nice.

Hi {{first_name}}, your workspace has reached the {{limit_name}} limit on the {{plan_name}} plan.

Anything over the limit waits until you upgrade, so sending is paused there. Nothing has been deleted, and everything inside your limit keeps running.

See bigger plans: {{upgrade_url}}

No setup fees and no add-on fees. A bigger plan is paid from your wallet like any other. Need more than our biggest plan? Write to {{support_email}} and we will talk.

${TEAM}`,
  },

  data_export_ready: {
    category: 'transactional',
    name: 'Data export ready',
    when: 'Sent when a requested data export is ready to download.',
    subject: 'Your Castvoo data export is ready',
    preheader: 'Download it within 7 days.',
    vars: ['download_url'],
    body: [
      h1('Your data export is ready'),
      p('Hi {{first_name}}, the copy of your Castvoo data you asked for is ready.'),
      button('{{download_url}}', 'Download my data'),
      p('The link works for 7 days. After that, you can ask for a new export in Settings.'),
      infoBox('This file holds personal information, including details of your subscribers. Please store it somewhere safe.'),
      small('Did not ask for this? Write to {{support_email}} right away so we can secure your account.'),
      signoff(TEAM),
    ].join('\n'),
    text: `Your data export is ready

Hi {{first_name}}, the copy of your Castvoo data you asked for is ready.

Download my data: {{download_url}}

The link works for 7 days. After that, you can ask for a new export in Settings.

This file holds personal information, including details of your subscribers. Please store it somewhere safe.

Did not ask for this? Write to {{support_email}} right away so we can secure your account.

${TEAM}`,
  },

  account_deleted: {
    category: 'transactional',
    name: 'Account deleted',
    when: 'Sent after an account has been deleted.',
    subject: 'Your Castvoo account has been deleted',
    preheader: 'This confirms your account and its data have been removed.',
    vars: [],
    body: [
      h1('Your account has been deleted'),
      p('Hi {{first_name}}, as you asked, we have deleted your Castvoo account. Your workspace, messages, follow-ups and subscriber data have been removed.'),
      p('We keep only the records the law asks us to keep, such as payment records.'),
      infoBox(`${B('One thing to tidy up in Telegram')}<br>Your bots still exist in Telegram. You can manage or delete them with BotFather. If @CastvooBot is still an admin in any of your channels or groups, you can remove it there.`),
      p('Thank you for trying Castvoo.'),
      small('Did not ask for this? Write to {{support_email}} right away.'),
      signoff(TEAM),
    ].join('\n'),
    text: `Your account has been deleted

Hi {{first_name}}, as you asked, we have deleted your Castvoo account. Your workspace, messages, follow-ups and subscriber data have been removed.

We keep only the records the law asks us to keep, such as payment records.

One thing to tidy up in Telegram: your bots still exist in Telegram. You can manage or delete them with BotFather. If @CastvooBot is still an admin in any of your channels or groups, you can remove it there.

Thank you for trying Castvoo.

Did not ask for this? Write to {{support_email}} right away.

${TEAM}`,
  },

  inactive_free_warning: {
    category: 'transactional',
    name: 'Inactive Free workspace: data will be deleted',
    when: 'Sent 30 days and again 7 days before the content of a Free workspace nobody has used for a long time is deleted (no owner login, no join requests, no money in the wallet). Logging in keeps everything.',
    subject: 'Your Castvoo workspace will be cleared on {{delete_date}}',
    preheader: 'Log in before then and everything stays. Nothing else to do.',
    vars: ['workspace_name', 'delete_date', 'days_left', 'login_url'],
    body: [
      h1('Do you still need this workspace?'),
      p('Hi {{first_name}}, nobody has used your Castvoo workspace <strong>{{workspace_name}}</strong> for a long time. It is on the Free plan, with no logins, no join requests and no money in the wallet.'),
      p(`So in ${B('{{days_left}} days, on {{delete_date}}')}, we will delete its content: bots and channels, subscribers, messages, flows and media. Your account and payment records stay.`),
      button('{{login_url}}', 'Keep my account'),
      p('Logging in is all it takes. Then everything stays as it is.'),
      small('If you do not need it any more, you do not have to do anything.'),
      signoff(TEAM),
    ].join('\n'),
    text: `Do you still need this workspace?

Hi {{first_name}}, nobody has used your Castvoo workspace {{workspace_name}} for a long time. It is on the Free plan, with no logins, no join requests and no money in the wallet.

So in {{days_left}} days, on {{delete_date}}, we will delete its content: bots and channels, subscribers, messages, flows and media. Your account and payment records stay.

Keep my account: {{login_url}}

Logging in is all it takes. Then everything stays as it is.

If you do not need it any more, you do not have to do anything.

${TEAM}`,
  },

  // ------------------------------------------------------------------
  // MARKETING (trial follow-up sequence)
  // ------------------------------------------------------------------

  sales_connect_nudge: {
    category: 'marketing',
    name: 'Sales day 1: connect a bot or channel',
    when: 'Sent on day 1 of the trial if nothing has been connected yet.',
    subject: 'One step left: connect your Telegram',
    preheader: 'Your trial is running. Connect a channel, group or bot and Castvoo gets to work.',
    vars: ['connect_url', 'guide_url'],
    body: [
      h1('One step, and Castvoo starts working'),
      p(`Hi {{first_name}}, you haven't connected Telegram yet. Until you do, Castvoo can't welcome anyone for you.`),
      p(`Every person who joins your channel without a hello is a chance that slips by. Let's fix that today.`),
      lead('Pick the way that fits you:'),
      steps([
        ['A channel or group', 'Add @CastvooBot as an admin. One tap.'],
        ['Your own bot', 'Open BotFather in Telegram, copy your bot token and paste it into Castvoo.'],
      ]),
      button('{{connect_url}}', 'Connect Telegram now'),
      infoBox(`${B('Running a channel? Connect both.')}<br>With your channel and your own bot connected, your bot can welcome every person who asks to join, by name, and let them in. That is a Welcome Flow, and it runs day and night.`),
      p(`Like to see it step by step first? Read the ${link('{{guide_url}}', 'quick start guide')}.`),
      signoff(CAS),
      ps('Stuck? Open the support chat in your dashboard. It is open 24/7.'),
    ].join('\n'),
    text: `One step, and Castvoo starts working

Hi {{first_name}}, you haven't connected Telegram yet. Until you do, Castvoo can't welcome anyone for you.

Every person who joins your channel without a hello is a chance that slips by. Let's fix that today.

Pick the way that fits you:

1. A channel or group
   Add @CastvooBot as an admin. One tap.

2. Your own bot
   Open BotFather in Telegram, copy your bot token and paste it into Castvoo.

Connect Telegram now: {{connect_url}}

Running a channel? Connect both. With your channel and your own bot connected, your bot can welcome every person who asks to join, by name, and let them in. That is a Welcome Flow, and it runs day and night.

Like to see it step by step first? Quick start guide: {{guide_url}}

${CAS}

P.S. Stuck? Open the support chat in your dashboard. It is open 24/7.`,
  },

  sales_first_message: {
    category: 'marketing',
    name: 'Sales day 2: send a first message',
    when: 'Sent on day 2 of the trial.',
    subject: "Send your first broadcast today (it's easy)",
    preheader: 'One message, one button, and you see exactly who tapped.',
    vars: ['broadcast_url'],
    body: [
      h1('Send your first broadcast today'),
      p('Hi {{first_name}}, the fastest way to see what Castvoo can do is to send one real message. Here is a simple one to copy.'),
      infoBox(`${B('Say you run a trading or tips channel.')}<br>Send your bot subscribers: <em>"Hi {name}, today's update is ready. Tap below to read it."</em> Castvoo puts in each person's first name. Add a button with your link, and Castvoo shows you exactly who tapped.`),
      lead('Three tricks that save you time:'),
      steps([
        ['Send at 9am', 'Pick "9am" and Castvoo sends at the next 9am in your workspace time zone. Set it to where your audience lives in Settings.'],
        ['Schedule ahead', 'Write it now, choose a day and time, and let Castvoo send it for you.'],
        ['Ask Cas for a draft', 'Stuck on words? Cas writes the message, or makes yours shorter and clearer.'],
      ]),
      button('{{broadcast_url}}', 'Write my first broadcast'),
      small('Every bot broadcast has a "Stop these messages" button by default. People stay in control, and your list stays full of people who want to hear from you.'),
      signoff(CAS),
      ps('People who tap your button are your warmest leads. On bots, Castvoo knows which subscriber clicked, so you know who to follow up with.'),
    ].join('\n'),
    text: `Send your first broadcast today

Hi {{first_name}}, the fastest way to see what Castvoo can do is to send one real message. Here is a simple one to copy.

Say you run a trading or tips channel. Send your bot subscribers: "Hi {name}, today's update is ready. Tap below to read it." Castvoo puts in each person's first name. Add a button with your link, and Castvoo shows you exactly who tapped.

Three tricks that save you time:

1. Send at 9am
   Pick "9am" and Castvoo sends at the next 9am in your workspace time zone. Set it to where your audience lives in Settings.

2. Schedule ahead
   Write it now, choose a day and time, and let Castvoo send it for you.

3. Ask Cas for a draft
   Stuck on words? Cas writes the message, or makes yours shorter and clearer.

Write my first broadcast: {{broadcast_url}}

Every bot broadcast has a "Stop these messages" button by default. People stay in control, and your list stays full of people who want to hear from you.

${CAS}

P.S. People who tap your button are your warmest leads. On bots, Castvoo knows which subscriber clicked, so you know who to follow up with.`,
  },

  sales_followups: {
    category: 'marketing',
    name: 'Sales day 3: Welcome Flows and auto follow-ups',
    when: 'Sent on day 3 of the trial if no Welcome Flow or follow-up has been made yet.',
    subject: 'Let your bot welcome every new member for you',
    preheader: 'Telegram gives your bot 5 minutes to say hello. A Welcome Flow never misses it.',
    vars: ['drips_url'],
    body: [
      h1('Your new members are waiting for a hello'),
      p('Hi {{first_name}}, when someone asks to join your channel, Telegram lets your bot message them for just 5 minutes. Miss that window and the moment is gone.'),
      p(`A Welcome Flow never misses it. Your own bot greets each person by name, right away, lets them in, and can follow up later. You set it up once.`),
      infoBox(`${B('Say you run a VIP signals channel.')}<br>Someone asks to join from your ad. At once they get: <em>"Hi Tunde, welcome! Tap below to get started."</em> They tap, press Start, and they are in. A day later, your bot sends them your free guide. You did nothing.`),
      lead('Live in three steps:'),
      steps([
        ['Pick a template', 'Try "Welcome + 3-day follow-up" or "Free gift / lead magnet".'],
        ['Make it yours', 'Change the words, or ask Cas to write them.'],
        ['Switch it on', 'Castvoo checks your channel settings and tells you what to fix.'],
      ]),
      button('{{app_url}}/flows', 'Build my Welcome Flow'),
      p(`Have bot subscribers too? ${link('{{drips_url}}', 'Set up an auto follow-up')} so everyone who starts your bot gets a welcome and your next messages on their own.`),
      signoff(CAS),
      ps('Your trial includes A/B welcomes. Run two versions side by side and see which one gets more clicks.'),
    ].join('\n'),
    text: `Your new members are waiting for a hello

Hi {{first_name}}, when someone asks to join your channel, Telegram lets your bot message them for just 5 minutes. Miss that window and the moment is gone.

A Welcome Flow never misses it. Your own bot greets each person by name, right away, lets them in, and can follow up later. You set it up once.

Say you run a VIP signals channel. Someone asks to join from your ad. At once they get: "Hi Tunde, welcome! Tap below to get started." They tap, press Start, and they are in. A day later, your bot sends them your free guide. You did nothing.

Live in three steps:

1. Pick a template
   Try "Welcome + 3-day follow-up" or "Free gift / lead magnet".

2. Make it yours
   Change the words, or ask Cas to write them.

3. Switch it on
   Castvoo checks your channel settings and tells you what to fix.

Build my Welcome Flow: {{app_url}}/flows

Have bot subscribers too? Set up an auto follow-up so everyone who starts your bot gets a welcome and your next messages on their own: {{drips_url}}

${CAS}

P.S. Your trial includes A/B welcomes. Run two versions side by side and see which one gets more clicks.`,
  },

  sales_cas: {
    category: 'marketing',
    name: 'Sales day 4: meet Cas',
    when: 'Sent on day 4 of the trial.',
    subject: 'Meet Cas: your messages, written for you',
    preheader: 'Teach Cas about your channel once. Then it writes in your voice.',
    vars: ['train_url'],
    body: [
      h1('Hi, I am Cas'),
      p('Hi {{first_name}}, I am the AI helper inside your Castvoo dashboard. Blank page? That is my job. Here is what I do:'),
      steps([
        ['Write a message', 'Tell me what you want to say and I write it.'],
        ['Rewrite or translate', 'Make a message shorter, warmer or clearer, or put it in another language.'],
        ['Plan a follow-up series', 'I write each message in a series, ready for you to edit.'],
        ['Answer questions', 'Ask me about your workspace, like how a broadcast went.'],
      ]),
      p(`${B('I get much better when you teach me.')} On the Train Cas page, tell me what you offer, who it is for, how you talk and the questions your members ask.`),
      infoBox(`${B('Say you run a betting tips channel.')}<br>Tell me your style is friendly and short, and that you always remind people to bet responsibly. Then ask: <em>"Write a welcome for new members."</em> I come back with something that sounds like you, not like a robot.`),
      button('{{train_url}}', 'Train Cas now'),
      small('Each plan comes with a set number of AI writes each month. If they run out, I take a break until your next billing date. There is never an extra charge. Always read what I write before you send it.'),
      signoff(CAS),
      ps('Got members who speak French, like in Cameroon? Ask me to translate your welcome and send it in their language.'),
    ].join('\n'),
    text: `Hi, I am Cas

Hi {{first_name}}, I am the AI helper inside your Castvoo dashboard. Blank page? That is my job. Here is what I do:

1. Write a message
   Tell me what you want to say and I write it.

2. Rewrite or translate
   Make a message shorter, warmer or clearer, or put it in another language.

3. Plan a follow-up series
   I write each message in a series, ready for you to edit.

4. Answer questions
   Ask me about your workspace, like how a broadcast went.

I get much better when you teach me. On the Train Cas page, tell me what you offer, who it is for, how you talk and the questions your members ask.

Say you run a betting tips channel. Tell me your style is friendly and short, and that you always remind people to bet responsibly. Then ask: "Write a welcome for new members." I come back with something that sounds like you, not like a robot.

Train Cas now: {{train_url}}

Each plan comes with a set number of AI writes each month. If they run out, I take a break until your next billing date. There is never an extra charge. Always read what I write before you send it.

${CAS}

P.S. Got members who speak French, like in Cameroon? Ask me to translate your welcome and send it in their language.`,
  },

  sales_trial_last_day: {
    category: 'marketing',
    name: 'Sales day 6: trial almost over',
    when: 'Sent when the trial has about a day left.',
    subject: 'Your trial is almost over. Keep your follow-ups?',
    preheader: 'Top up {{plan_price}} and nothing stops. Skip it and your follow-ups pause.',
    vars: ['plan_name', 'plan_price', 'pricing_url', 'topup_url'],
    body: [
      h1(`Don't let your follow-ups stop`),
      p(`Hi {{first_name}}, your free trial ends soon. If your wallet covers {{plan_name}}, it all keeps running. If not, you move to the Free plan. Here is what that means:`),
      listBox([['Keeps running on Free', FREE_KEEPS], ['Pauses (saved, not deleted)', FREE_PAUSES]]),
      receipt([
        ['Your plan', '{{plan_name}}'],
        ['Price', '{{plan_price}}'],
      ]),
      button('{{topup_url}}', 'Top up and keep it all'),
      p(`Want to start smaller? ${link('{{pricing_url}}', 'Compare the plans')}. No setup fees, no add-on fees, and you can cancel any time in Settings.`),
      signoff(CAS),
      ps('Nothing is deleted on Free. Top up later, pick a plan, and switch your flows and follow-ups back on.'),
    ].join('\n'),
    text: `Don't let your follow-ups stop

Hi {{first_name}}, your free trial ends soon. If your wallet covers {{plan_name}}, it all keeps running. If not, you move to the Free plan. Here is what that means:

${listText([['Keeps running on Free:', FREE_KEEPS], ['Pauses (saved, not deleted):', FREE_PAUSES]])}

Your plan: {{plan_name}}
Price: {{plan_price}}

Top up and keep it all: {{topup_url}}

Want to start smaller? Compare the plans: {{pricing_url}}
No setup fees, no add-on fees, and you can cancel any time in Settings.

${CAS}

P.S. Nothing is deleted on Free. Top up later, pick a plan, and switch your flows and follow-ups back on.`,
  },

  sales_winback: {
    category: 'marketing',
    name: 'Sales: come back offer after the trial (day 8 and day 14)',
    when: 'Sent on day 8 and again on day 14 after sign-up to people whose trial ended without a paid plan (they are on the Free plan, or paused under the old rules), while the COMEBACK20 coupon is active.',
    subject: 'Come back with {{coupon_percent}}% off your first month',
    preheader: 'Your setup is still saved. Use {{coupon_code}} before {{coupon_expiry}}.',
    vars: ['coupon_code', 'coupon_percent', 'coupon_expiry', 'pricing_url', 'plan_now', 'data_note'],
    body: [
      h1('Your setup is still here'),
      p('Hi {{first_name}}, your Castvoo trial ended a little while ago. Your bots, flows, messages and subscribers are all saved. {{plan_now}}'),
      p(`Let's switch the rest back on. Here is ${B('{{coupon_percent}}% off your first month')}:`),
      codeBox('{{coupon_code}}', { size: 26, spacing: 4 }),
      p('Enter it when you choose your plan. The code works until <strong>{{coupon_expiry}}</strong>.'),
      button('{{pricing_url}}', 'Claim my {{coupon_percent}}% off'),
      signoff(CAS),
      ps('{{data_note}}'),
    ].join('\n'),
    text: `Your setup is still here

Hi {{first_name}}, your Castvoo trial ended a little while ago. Your bots, flows, messages and subscribers are all saved. {{plan_now}}

Let's switch the rest back on. Here is {{coupon_percent}}% off your first month:

{{coupon_code}}

Enter it when you choose your plan. The code works until {{coupon_expiry}}.

Claim my {{coupon_percent}}% off: {{pricing_url}}

${CAS}

P.S. {{data_note}}`,
  },

  sales_feedback: {
    category: 'marketing',
    name: 'Sales day 21: what stopped you?',
    when: 'Sent 21 days after sign-up to people who did not start a paid plan.',
    subject: 'Can I ask you one quick question?',
    preheader: 'What stopped you from using Castvoo? One line is plenty.',
    vars: ['reply_url'],
    body: [
      h1('What stopped you?'),
      p('Hi {{first_name}}, you tried Castvoo but did not stay. That is completely fine. I would just love to know why.'),
      p('Was something missing? Too hard to set up? The price? Just not the right time? One line is plenty, and it helps us make Castvoo better.'),
      button('{{reply_url}}', 'Share my answer'),
      p('Our team reads every answer. And if setup was the problem, say so. We will help you get your first Welcome Flow live.'),
      signoff(CAS),
    ].join('\n'),
    text: `What stopped you?

Hi {{first_name}}, you tried Castvoo but did not stay. That is completely fine. I would just love to know why.

Was something missing? Too hard to set up? The price? Just not the right time? One line is plenty, and it helps us make Castvoo better.

Share my answer: {{reply_url}}

Our team reads every answer. And if setup was the problem, say so. We will help you get your first Welcome Flow live.

${CAS}`,
  },

  // ------------------------------------------------------------------
  // FREE PLAN AND JOIN-REQUEST METER
  // ------------------------------------------------------------------

  join_limit_80: {
    category: 'transactional',
    name: 'Join requests at 80%',
    when: 'Sent once a month when a workspace has used 80% of its join requests.',
    subject: `Busy month: you've used {{used}} of {{limit}} join requests`,
    preheader: 'Your welcomes are working. Upgrade before the limit so nobody misses one.',
    vars: ['used', 'limit', 'reset_date', 'plans_url'],
    body: [
      h1('Your welcomes are in demand'),
      p('Hi {{first_name}}, people keep asking to join. That is a great sign. Here is where you are this month:'),
      receipt([
        ['Join requests used', '{{used}} of {{limit}}'],
        ['Resets on', '{{reset_date}}'],
      ]),
      p(`Past the limit (plus a small extra), people are still let in, but they ${B('stop getting your welcome and follow-ups')} until {{reset_date}}.`),
      p('A bigger plan gives you more join requests each month, so every new member keeps getting your hello.'),
      button('{{plans_url}}', 'See bigger plans'),
      small('Already on our biggest plan? Write to {{support_email}} and we will talk about more.'),
      signoff(TEAM),
    ].join('\n'),
    text: `Your welcomes are in demand

Hi {{first_name}}, people keep asking to join. That is a great sign. Here is where you are this month:

Join requests used: {{used}} of {{limit}}
Resets on: {{reset_date}}

Past the limit (plus a small extra), people are still let in, but they stop getting your welcome and follow-ups until {{reset_date}}.

A bigger plan gives you more join requests each month, so every new member keeps getting your hello.

See bigger plans: {{plans_url}}

Already on our biggest plan? Write to {{support_email}} and we will talk about more.

${TEAM}`,
  },

  join_limit_reached: {
    category: 'transactional',
    name: 'Join requests used up',
    when: 'Sent once a month when a workspace reaches its join requests for the month.',
    subject: `You've reached {{limit}} join requests. Welcomes pause soon`,
    preheader: 'People are still let in, but soon without your welcome. Upgrade to keep it on.',
    vars: ['used', 'limit', 'reset_date', 'plans_url'],
    body: [
      h1('You hit your join requests for the month'),
      p('Hi {{first_name}}, {{used}} people have asked to join this month, and your plan includes {{limit}}.'),
      p(`You have a small extra allowance left. After that, people are still let in, but they ${B('do not get your welcome or follow-ups')}. Your dashboard counts how many joined without it.`),
      p('This resets on {{reset_date}}, or straight away when you upgrade.'),
      button('{{plans_url}}', 'Upgrade and keep welcoming'),
      small('Flows set to "I decide" keep waiting for you to approve people, as before.'),
      signoff(TEAM),
    ].join('\n'),
    text: `You hit your join requests for the month

Hi {{first_name}}, {{used}} people have asked to join this month, and your plan includes {{limit}}.

You have a small extra allowance left. After that, people are still let in, but they do not get your welcome or follow-ups. Your dashboard counts how many joined without it.

This resets on {{reset_date}}, or straight away when you upgrade.

Upgrade and keep welcoming: {{plans_url}}

Flows set to "I decide" keep waiting for you to approve people, as before.

${TEAM}`,
  },

  trial_dropped_to_free: {
    category: 'transactional',
    name: 'Trial ended, now on Free',
    when: 'Sent when the free trial ends and the workspace moves to the Free plan.',
    subject: 'Your trial has ended. Your follow-ups are paused',
    preheader: 'Your welcome still runs on Free. Bring the rest back with {{plan_name}}, {{plan_price}} a month.',
    vars: ['welcomed', 'plan_name', 'plan_price', 'topup_url'],
    body: [
      h1('You are on the Free plan now'),
      p('Hi {{first_name}}, your free trial is over. During your trial, your Welcome Flows welcomed <strong>{{welcomed}}</strong> people.'),
      p('Your wallet did not cover a plan, so you moved to Free. Here is what that means:'),
      listBox([['Still running', FREE_KEEPS], ['Paused (saved, not deleted)', FREE_PAUSES]]),
      button('{{topup_url}}', 'Restart my follow-ups'),
      p(`${B('{{plan_name}} is {{plan_price}} a month.')} It brings back your follow-ups, broadcasts and Cas, and removes the Castvoo line from your welcome.`),
      signoff(TEAM),
      ps('After you pick a plan, you choose which flows and follow-ups to switch back on. Nothing was deleted.'),
    ].join('\n'),
    text: `You are on the Free plan now

Hi {{first_name}}, your free trial is over. During your trial, your Welcome Flows welcomed {{welcomed}} people.

Your wallet did not cover a plan, so you moved to Free. Here is what that means:

${listText([['Still running:', FREE_KEEPS], ['Paused (saved, not deleted):', FREE_PAUSES]])}

Restart my follow-ups: {{topup_url}}

{{plan_name}} is {{plan_price}} a month. It brings back your follow-ups, broadcasts and Cas, and removes the Castvoo line from your welcome.

${TEAM}

P.S. After you pick a plan, you choose which flows and follow-ups to switch back on. Nothing was deleted.`,
  },

  plan_dropped_to_free: {
    category: 'transactional',
    name: 'Renewal failed, now on Free',
    when: 'Sent when a plan could not renew because the wallet was short, and the workspace moved to the Free plan.',
    subject: 'We could not renew your {{plan_name}} plan',
    preheader: 'Your welcome still runs, but follow-ups and broadcasts are paused. Top up to restart.',
    vars: ['plan_name', 'amount', 'topup_url'],
    body: [
      h1('You are on the Free plan for now'),
      p('Hi {{first_name}}, we tried to renew your <strong>{{plan_name}}</strong> plan for <strong>{{amount}}</strong>, but your wallet did not have enough. So you moved to Free:'),
      listBox([['Still running', FREE_KEEPS], ['Paused (saved, not deleted)', FREE_PAUSES]]),
      button('{{topup_url}}', 'Top up and restart {{plan_name}}'),
      p(`Once your wallet covers {{amount}}, ${B('{{plan_name}} starts again by itself')}. Then switch your paused flows and follow-ups back on in a tap.`),
      signoff(TEAM),
    ].join('\n'),
    text: `You are on the Free plan for now

Hi {{first_name}}, we tried to renew your {{plan_name}} plan for {{amount}}, but your wallet did not have enough. So you moved to Free:

${listText([['Still running:', FREE_KEEPS], ['Paused (saved, not deleted):', FREE_PAUSES]])}

Top up and restart {{plan_name}}: {{topup_url}}

Once your wallet covers {{amount}}, {{plan_name}} starts again by itself. Then switch your paused flows and follow-ups back on in a tap.

${TEAM}`,
  },
};

module.exports = templates;

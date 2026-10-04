'use strict';

// Castvoo email templates.
// Each body is an HTML fragment that goes inside layout(). Only {{var}}
// variables are used. Global vars (always available, not listed in
// `vars`): first_name, app_url, site_url, support_email, company_name,
// company_address, unsubscribe_url.

const { h1, p, small, button, infoBox, receipt, steps, codeBox, mono, signoff } = require('./layout');

const TEAM = 'The Castvoo team';
const CAS = 'Cas from Castvoo';

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
    subject: 'Welcome to Castvoo, {{first_name}} 👋',
    preheader: 'Your free trial is on until {{trial_end_date}}. Here are your first three steps.',
    vars: ['trial_end_date', 'guide_url'],
    body: [
      h1('Welcome to Castvoo, {{first_name}}'),
      p("You're in. Castvoo helps you send Telegram broadcasts and lets follow-up messages go out on their own, so you can stay in touch with your people without doing it all by hand."),
      p('Your free trial gives you the full Growth plan until <strong>{{trial_end_date}}</strong>. No card needed.'),
      p('<strong style="color:#0B1430;">Your first three steps:</strong>', 'margin-bottom:12px;'),
      steps([
        ['Connect a bot or channel', 'Paste your bot token from BotFather, or add @CastvooBot as an admin to your channel or group.'],
        ['Send your first message', 'Write it, add a button with a link if you like, then send it now or schedule it for later.'],
        ['Set up a welcome follow-up', 'Choose a trigger, like someone starting your bot or asking to join your channel. Castvoo sends your welcome for you, every time.'],
      ]),
      button('{{app_url}}', 'Open my dashboard'),
      infoBox('<strong style="color:#0B1430;">You have help on hand.</strong><br>Cas, your AI helper, can write a message for you, rewrite it, translate it or plan a whole follow-up sequence. And if you get stuck, open the support chat in your dashboard. A person from our team will answer.'),
      p('Like to read first? Our <a href="{{guide_url}}" target="_blank" style="color:#2F6BFF;font-weight:600;">quick start guide</a> walks you through each step.'),
      signoff(CAS),
    ].join('\n'),
    text: `Welcome to Castvoo, {{first_name}}

You're in. Castvoo helps you send Telegram broadcasts and lets follow-up messages go out on their own, so you can stay in touch with your people without doing it all by hand.

Your free trial gives you the full Growth plan until {{trial_end_date}}. No card needed.

Your first three steps:

1. Connect a bot or channel
   Paste your bot token from BotFather, or add @CastvooBot as an admin to your channel or group.

2. Send your first message
   Write it, add a button with a link if you like, then send it now or schedule it for later.

3. Set up a welcome follow-up
   Choose a trigger, like someone starting your bot or asking to join your channel. Castvoo sends your welcome for you, every time.

Open my dashboard: {{app_url}}

You have help on hand. Cas, your AI helper, can write a message for you, rewrite it, translate it or plan a whole follow-up sequence. And if you get stuck, open the support chat in your dashboard. A person from our team will answer.

Like to read first? Quick start guide: {{guide_url}}

${CAS}`,
  },

  team_invite: {
    category: 'transactional',
    name: 'Team invite',
    when: 'Sent when a workspace member invites someone to join their workspace.',
    subject: '{{inviter_name}} invited you to {{workspace_name}} on Castvoo',
    preheader: 'Accept the invite to start working together on Castvoo.',
    vars: ['inviter_name', 'workspace_name', 'invite_url'],
    body: [
      h1("You've been invited to {{workspace_name}}"),
      p('Hi there,'),
      p('<strong>{{inviter_name}}</strong> wants you to help run <strong>{{workspace_name}}</strong> on Castvoo. Castvoo is a tool for sending Telegram broadcasts and automatic follow-up messages.'),
      p('Tap the button to accept. If you are new to Castvoo, you will create your login first.'),
      button('{{invite_url}}', 'Accept invite'),
      small('This invite is just for you, so please do not forward it. Not expecting it? You can ignore this email. Nothing happens unless you accept.'),
      signoff(CAS),
    ].join('\n'),
    text: `You've been invited to {{workspace_name}}

Hi there,

{{inviter_name}} wants you to help run {{workspace_name}} on Castvoo. Castvoo is a tool for sending Telegram broadcasts and automatic follow-up messages.

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
    when: 'Sent 2 days before the free trial ends.',
    subject: 'Your Castvoo trial ends on {{trial_end_date}}',
    preheader: 'Top up your wallet so your messages keep going without a break.',
    vars: ['trial_end_date', 'plan_name', 'plan_price', 'wallet_balance', 'topup_url'],
    body: [
      h1('Your trial ends in 2 days'),
      p('Hi {{first_name}}, your free trial ends on <strong>{{trial_end_date}}</strong>. On that day, we pay for your plan from your Castvoo wallet.'),
      receipt([
        ['Plan', '{{plan_name}}'],
        ['Price', '{{plan_price}}'],
        ['Your wallet balance', '{{wallet_balance}}'],
      ]),
      p('If your wallet covers the price, nothing changes. Your messages and follow-ups keep going.'),
      p('If it is short, sending pauses until you top up. Nothing is deleted.'),
      button('{{topup_url}}', 'Top up my wallet'),
      small('You can top up with the payment options for your country, or with USDT (TRC20) or Bitcoin. Want a different plan? You can choose one in your dashboard before your trial ends.'),
      signoff(TEAM),
    ].join('\n'),
    text: `Your trial ends in 2 days

Hi {{first_name}}, your free trial ends on {{trial_end_date}}. On that day, we pay for your plan from your Castvoo wallet.

Plan: {{plan_name}}
Price: {{plan_price}}
Your wallet balance: {{wallet_balance}}

If your wallet covers the price, nothing changes. Your messages and follow-ups keep going.

If it is short, sending pauses until you top up. Nothing is deleted.

Top up my wallet: {{topup_url}}

You can top up with the payment options for your country, or with USDT (TRC20) or Bitcoin. Want a different plan? You can choose one in your dashboard before your trial ends.

${TEAM}`,
  },

  trial_ended: {
    category: 'transactional',
    name: 'Trial ended, sending paused',
    when: 'Sent when the free trial ends and the wallet could not pay for the plan.',
    subject: 'Your Castvoo trial has ended',
    preheader: 'Sending is paused, but everything is saved. Top up to pick up where you left off.',
    vars: ['plan_name', 'plan_price', 'topup_url'],
    body: [
      h1('Your trial has ended'),
      p('Hi {{first_name}}, your free trial is over. Your wallet did not have enough to start the <strong>{{plan_name}}</strong> plan ({{plan_price}}), so sending is paused for now.'),
      p('Nothing has been deleted. Your bots, channels, messages, follow-ups and subscribers are all still in your account.'),
      button('{{topup_url}}', 'Top up and continue'),
      p('As soon as your wallet covers {{plan_name}}, your plan starts and sending picks up again.'),
      infoBox('<strong style="color:#0B1430;">How long we keep your data</strong><br>We keep your data for {{data_retention_days}} days after a plan ends. After that, it is deleted for good.'),
      signoff(TEAM),
    ].join('\n'),
    text: `Your trial has ended

Hi {{first_name}}, your free trial is over. Your wallet did not have enough to start the {{plan_name}} plan ({{plan_price}}), so sending is paused for now.

Nothing has been deleted. Your bots, channels, messages, follow-ups and subscribers are all still in your account.

Top up and continue: {{topup_url}}

As soon as your wallet covers {{plan_name}}, your plan starts and sending picks up again.

How long we keep your data: we keep your data for {{data_retention_days}} days after a plan ends. After that, it is deleted for good.

${TEAM}`,
  },

  payment_receipt: {
    category: 'transactional',
    name: 'Plan payment receipt',
    when: 'Sent each time a plan is paid from the wallet.',
    subject: 'Receipt for your {{plan_name}} plan',
    preheader: 'We paid {{amount}} from your wallet. Receipt {{receipt_id}}.',
    vars: ['plan_name', 'amount', 'period_start', 'period_end', 'receipt_id', 'wallet_balance', 'billing_url'],
    body: [
      h1('Thanks, your plan is paid'),
      p('Hi {{first_name}}, we paid for your <strong>{{plan_name}}</strong> plan from your Castvoo wallet. Here is your receipt.'),
      receipt([
        ['Receipt', '{{receipt_id}}'],
        ['Plan', '{{plan_name}}'],
        ['Period', '{{period_start}} to {{period_end}}'],
        ['Wallet balance now', '{{wallet_balance}}'],
        ['Paid from wallet', '{{amount}}'],
      ], { boldLast: true }),
      button('{{billing_url}}', 'View billing'),
      small('Plan payments cannot be refunded once a billing period starts. If you were charged twice or something looks wrong, write to {{support_email}} with your receipt number and we will put it right.'),
      signoff(TEAM),
    ].join('\n'),
    text: `Thanks, your plan is paid

Hi {{first_name}}, we paid for your {{plan_name}} plan from your Castvoo wallet. Here is your receipt.

Receipt: {{receipt_id}}
Plan: {{plan_name}}
Period: {{period_start}} to {{period_end}}
Wallet balance now: {{wallet_balance}}
Paid from wallet: {{amount}}

View billing: {{billing_url}}

Plan payments cannot be refunded once a billing period starts. If you were charged twice or something looks wrong, write to {{support_email}} with your receipt number and we will put it right.

${TEAM}`,
  },

  renewal_low_balance: {
    category: 'transactional',
    name: 'Renewal coming, low balance',
    when: 'Sent a few days before renewal (Settings → Billing → reminder days) when the wallet is too low to pay for the plan.',
    subject: 'Top up before {{renewal_date}} to keep sending',
    preheader: 'Your {{plan_name}} plan renews soon and your wallet is short.',
    vars: ['plan_name', 'amount', 'renewal_date', 'wallet_balance', 'topup_url'],
    body: [
      h1('Your plan renews in 3 days'),
      p('Hi {{first_name}}, your <strong>{{plan_name}}</strong> plan renews on <strong>{{renewal_date}}</strong>. Right now your wallet does not have enough to pay for it.'),
      receipt([
        ['Renewal date', '{{renewal_date}}'],
        ['Renewal price', '{{amount}}'],
        ['Your wallet balance', '{{wallet_balance}}'],
      ]),
      p('Top up before {{renewal_date}} and everything keeps running. If the wallet is still short on that day, sending pauses until you top up. Nothing is deleted.'),
      button('{{topup_url}}', 'Top up my wallet'),
      small('Not planning to continue? You can cancel in Settings. Your plan will run until the end of the period you already paid for.'),
      signoff(TEAM),
    ].join('\n'),
    text: `Your plan renews in 3 days

Hi {{first_name}}, your {{plan_name}} plan renews on {{renewal_date}}. Right now your wallet does not have enough to pay for it.

Renewal date: {{renewal_date}}
Renewal price: {{amount}}
Your wallet balance: {{wallet_balance}}

Top up before {{renewal_date}} and everything keeps running. If the wallet is still short on that day, sending pauses until you top up. Nothing is deleted.

Top up my wallet: {{topup_url}}

Not planning to continue? You can cancel in Settings. Your plan will run until the end of the period you already paid for.

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

The Castvoo team`,
  },

  plan_paused: {
    category: 'transactional',
    name: 'Plan paused, renewal failed',
    when: 'Sent when a plan could not renew because the wallet balance was too low.',
    subject: 'We could not renew your {{plan_name}} plan',
    preheader: 'Sending is paused. Top up to start again. Nothing has been deleted.',
    vars: ['plan_name', 'amount', 'topup_url'],
    body: [
      h1('Sending is paused'),
      p('Hi {{first_name}}, we tried to renew your <strong>{{plan_name}}</strong> plan for <strong>{{amount}}</strong>, but your wallet did not have enough. So sending is paused for now.'),
      p('Your account is safe. Nothing has been deleted.'),
      button('{{topup_url}}', 'Top up and restart'),
      p('Once your wallet covers {{amount}}, your plan renews and sending picks up again.'),
      infoBox('<strong style="color:#0B1430;">How long we keep your data</strong><br>We keep your data for {{data_retention_days}} days after a plan ends. After that, it is deleted for good.'),
      signoff(TEAM),
    ].join('\n'),
    text: `Sending is paused

Hi {{first_name}}, we tried to renew your {{plan_name}} plan for {{amount}}, but your wallet did not have enough. So sending is paused for now.

Your account is safe. Nothing has been deleted.

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
    preheader: 'Your new Castvoo wallet balance is {{new_balance}}.',
    vars: ['amount', 'bonus', 'method', 'new_balance', 'receipt_id', 'wallet_url'],
    body: [
      h1('Your wallet is topped up'),
      p('Hi {{first_name}}, thanks. We added your top-up to your Castvoo wallet.'),
      receipt([
        ['Receipt', '{{receipt_id}}'],
        ['Paid with', '{{method}}'],
        ['Top-up', '{{amount}}'],
        ['Bonus credit', '{{bonus}}'],
        ['New balance', '{{new_balance}}'],
      ], { boldLast: true }),
      button('{{wallet_url}}', 'View my wallet'),
      small('Bonus credit can only be spent on plans. It cannot be refunded or withdrawn. Your plan is paid from your wallet automatically when it is due.'),
      signoff(TEAM),
    ].join('\n'),
    text: `Your wallet is topped up

Hi {{first_name}}, thanks. We added your top-up to your Castvoo wallet.

Receipt: {{receipt_id}}
Paid with: {{method}}
Top-up: {{amount}}
Bonus credit: {{bonus}}
New balance: {{new_balance}}

View my wallet: {{wallet_url}}

Bonus credit can only be spent on plans. It cannot be refunded or withdrawn. Your plan is paid from your wallet automatically when it is due.

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
    preheader: 'Your wallet was not credited. Here is why and what to do next.',
    vars: ['amount', 'coin', 'txid', 'reason'],
    body: [
      h1('We could not confirm your payment'),
      p('Hi {{first_name}}, we checked your {{coin}} top-up but could not confirm it, so your wallet has not been credited.'),
      infoBox('<strong style="color:#0B1430;">Reason</strong><br>{{reason}}'),
      receipt([
        ['Top-up', '{{amount}}'],
        ['Coin', '{{coin}}'],
        ['Transaction ID', mono('{{txid}}')],
      ]),
      p('<strong style="color:#0B1430;">What to do next:</strong> check that the transaction ID is correct and that the coins went to the address shown in your wallet. Then submit it again from your wallet page.'),
      button('{{app_url}}', 'Open my wallet'),
      small('Sure you sent the payment? Write to {{support_email}} with the transaction ID and we will look again.'),
      signoff(TEAM),
    ].join('\n'),
    text: `We could not confirm your payment

Hi {{first_name}}, we checked your {{coin}} top-up but could not confirm it, so your wallet has not been credited.

Reason: {{reason}}

Top-up: {{amount}}
Coin: {{coin}}
Transaction ID: {{txid}}

What to do next: check that the transaction ID is correct and that the coins went to the address shown in your wallet. Then submit it again from your wallet page.

Open my wallet: {{app_url}}

Sure you sent the payment? Write to {{support_email}} with the transaction ID and we will look again.

${TEAM}`,
  },

  referral_earned: {
    category: 'transactional',
    name: 'Referral earning',
    when: 'Sent when someone the user referred pays for a plan.',
    subject: 'You earned {{amount}} from a referral 🎉',
    preheader: '{{referral_name}} paid for their plan. Your share settles on {{settle_date}}.',
    vars: ['amount', 'referral_name', 'settle_date', 'referrals_url'],
    body: [
      h1('You earned {{amount}}'),
      p('Nice one, {{first_name}}. <strong>{{referral_name}}</strong>, who signed up through your link, just paid for their plan. Your share is <strong>{{amount}}</strong>.'),
      receipt([
        ['Earned', '{{amount}}'],
        ['Settles on', '{{settle_date}}'],
      ]),
      p('We hold new earnings for a short time in case of refunds or chargebacks. Once they settle, you can use them to pay for your own plan, or withdraw them when you reach the minimum shown on your Referrals page.'),
      button('{{referrals_url}}', 'See my referrals'),
      p('You earn a share every time they pay, for as long as they stay on a paid plan. Keep sharing your link.'),
      signoff(CAS),
    ].join('\n'),
    text: `You earned {{amount}}

Nice one, {{first_name}}. {{referral_name}}, who signed up through your link, just paid for their plan. Your share is {{amount}}.

Earned: {{amount}}
Settles on: {{settle_date}}

We hold new earnings for a short time in case of refunds or chargebacks. Once they settle, you can use them to pay for your own plan, or withdraw them when you reach the minimum shown on your Referrals page.

See my referrals: {{referrals_url}}

You earn a share every time they pay, for as long as they stay on a paid plan. Keep sharing your link.

${CAS}`,
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
      infoBox('<strong style="color:#0B1430;">Please check the address above.</strong> Crypto sent to a wrong address cannot be brought back. If anything is wrong, write to {{support_email}} right away.'),
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
      infoBox('<strong style="color:#0B1430;">Reason</strong><br>{{reason}}'),
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
    when: 'Sent when the Castvoo team replies in the support chat and the user is away.',
    subject: '{{agent_name}} replied to your support message',
    preheader: '{{message_preview}}',
    vars: ['agent_name', 'message_preview', 'support_url'],
    body: [
      h1('You have a reply from support'),
      p('Hi {{first_name}}, <strong>{{agent_name}}</strong> from the Castvoo team replied to you:'),
      infoBox('<span style="color:#33405C;">{{message_preview}}</span>'),
      button('{{support_url}}', 'Read and reply'),
      small('Please reply in the support chat so the whole conversation stays in one place.'),
      signoff(TEAM),
    ].join('\n'),
    text: `You have a reply from support

Hi {{first_name}}, {{agent_name}} from the Castvoo team replied to you:

"{{message_preview}}"

Read and reply: {{support_url}}

Please reply in the support chat so the whole conversation stays in one place.

${TEAM}`,
  },

  broadcast_finished: {
    category: 'transactional',
    name: 'Broadcast finished',
    when: 'Sent when a broadcast has finished sending.',
    subject: 'Your broadcast "{{broadcast_title}}" has finished sending',
    preheader: '{{delivered}} delivered, {{clicks}} clicks so far. See the full report.',
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

Castvoo cannot see who read a message, so button clicks are your best sign of interest. For channel posts, you can see views and reactions inside Telegram.

${CAS}`,
  },

  limit_reached: {
    category: 'transactional',
    name: 'Plan limit reached',
    when: 'Sent when a workspace reaches its subscriber or connection limit.',
    subject: 'You reached the {{limit_name}} limit on your plan',
    preheader: 'Nothing is deleted. Upgrade to keep growing.',
    vars: ['limit_name', 'plan_name', 'upgrade_url'],
    body: [
      h1('You reached a plan limit'),
      p('Hi {{first_name}}, good news first: you are growing. Your workspace has reached the <strong>{{limit_name}}</strong> limit on the <strong>{{plan_name}}</strong> plan.'),
      p('Anything above the limit is on hold until you upgrade, so sending is paused there. Nothing has been deleted.'),
      button('{{upgrade_url}}', 'See bigger plans'),
      small('Plans have no setup fees and no add-on fees. A bigger plan is paid from your wallet like any other.'),
      signoff(TEAM),
    ].join('\n'),
    text: `You reached a plan limit

Hi {{first_name}}, good news first: you are growing. Your workspace has reached the {{limit_name}} limit on the {{plan_name}} plan.

Anything above the limit is on hold until you upgrade, so sending is paused there. Nothing has been deleted.

See bigger plans: {{upgrade_url}}

Plans have no setup fees and no add-on fees. A bigger plan is paid from your wallet like any other.

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
      infoBox('<strong style="color:#0B1430;">One thing to tidy up in Telegram</strong><br>Your bots still exist in Telegram. You can manage or delete them with BotFather. If @CastvooBot is still an admin in any of your channels or groups, you can remove it there.'),
      p('Thank you for trying Castvoo. You are always welcome back.'),
      small('Did not ask for this? Write to {{support_email}} right away.'),
      signoff(TEAM),
    ].join('\n'),
    text: `Your account has been deleted

Hi {{first_name}}, as you asked, we have deleted your Castvoo account. Your workspace, messages, follow-ups and subscriber data have been removed.

We keep only the records the law asks us to keep, such as payment records.

One thing to tidy up in Telegram: your bots still exist in Telegram. You can manage or delete them with BotFather. If @CastvooBot is still an admin in any of your channels or groups, you can remove it there.

Thank you for trying Castvoo. You are always welcome back.

Did not ask for this? Write to {{support_email}} right away.

${TEAM}`,
  },

  // ------------------------------------------------------------------
  // MARKETING (trial follow-up sequence)
  // ------------------------------------------------------------------

  sales_connect_nudge: {
    category: 'marketing',
    name: 'Sales day 1: connect a bot or channel',
    when: 'Sent on day 1 of the trial if nothing has been connected yet.',
    subject: 'One step to get Castvoo working for you',
    preheader: 'Connect a bot, channel or group. Everything else starts there.',
    vars: ['connect_url', 'guide_url'],
    body: [
      h1('Let us connect your first bot or channel'),
      p('Hi {{first_name}}, you have not connected anything to Castvoo yet. This is the one step that makes everything else work, and it is quick.'),
      p('<strong style="color:#0B1430;">Pick the way that fits you:</strong>', 'margin-bottom:12px;'),
      steps([
        ['A Telegram bot', 'Open BotFather in Telegram, copy your bot token and paste it into Castvoo.'],
        ['A channel or group', 'Add @CastvooBot as an admin. That is it.'],
      ]),
      button('{{connect_url}}', 'Connect now'),
      infoBox('<strong style="color:#0B1430;">Not sure which one?</strong><br>A bot messages each person one-to-one. You can pick who gets what and see exactly who clicked. A channel or group post reaches everyone in it at once, and you see how many clicked.'),
      p('Want to see it step by step first? Read the <a href="{{guide_url}}" target="_blank" style="color:#2F6BFF;font-weight:600;">quick start guide</a>, or ask us in the support chat.'),
      signoff(CAS),
    ].join('\n'),
    text: `Let us connect your first bot or channel

Hi {{first_name}}, you have not connected anything to Castvoo yet. This is the one step that makes everything else work, and it is quick.

Pick the way that fits you:

1. A Telegram bot
   Open BotFather in Telegram, copy your bot token and paste it into Castvoo.

2. A channel or group
   Add @CastvooBot as an admin. That is it.

Connect now: {{connect_url}}

Not sure which one? A bot messages each person one-to-one. You can pick who gets what and see exactly who clicked. A channel or group post reaches everyone in it at once, and you see how many clicked.

Want to see it step by step first? Quick start guide: {{guide_url}}
Or ask us in the support chat.

${CAS}`,
  },

  sales_first_message: {
    category: 'marketing',
    name: 'Sales day 2: send a first message',
    when: 'Sent on day 2 of the trial.',
    subject: 'Your first Castvoo message, made easy',
    preheader: 'A simple idea you can send today, plus three handy tricks.',
    vars: ['broadcast_url'],
    body: [
      h1('Send your first message today'),
      p('Hi {{first_name}}, the best way to see what Castvoo can do is to send one real message. Here is a simple idea.'),
      infoBox('<strong style="color:#0B1430;">Say you run a shoe shop.</strong><br>You could send: <em>"New sneakers just landed. Tap below to see them before they sell out."</em> Add a button that links to your store. Castvoo then shows you how many people tapped it.'),
      p('<strong style="color:#0B1430;">Three handy tricks:</strong>', 'margin-bottom:12px;'),
      steps([
        ['Send at 9am their time', 'Pick "9am local time" and Castvoo sends at the next 9am in your workspace time zone. Set it to where your audience lives in Settings.'],
        ['Schedule ahead', 'Write it now, choose a day and time, and let Castvoo send it for you.'],
        ['Ask Cas for a draft', 'Stuck on words? Cas can write the message, or make yours shorter and clearer.'],
      ]),
      button('{{broadcast_url}}', 'Write my first message'),
      small('Every bot broadcast has a "Stop these messages" button by default. People stay in control, and your list stays full of people who want to hear from you.'),
      signoff(CAS),
    ].join('\n'),
    text: `Send your first message today

Hi {{first_name}}, the best way to see what Castvoo can do is to send one real message. Here is a simple idea.

Say you run a shoe shop. You could send: "New sneakers just landed. Tap below to see them before they sell out." Add a button that links to your store. Castvoo then shows you how many people tapped it.

Three handy tricks:

1. Send at 9am their time
   Pick "9am local time" and Castvoo sends at the next 9am in your workspace time zone. Set it to where your audience lives in Settings.

2. Schedule ahead
   Write it now, choose a day and time, and let Castvoo send it for you.

3. Ask Cas for a draft
   Stuck on words? Cas can write the message, or make yours shorter and clearer.

Write my first message: {{broadcast_url}}

Every bot broadcast has a "Stop these messages" button by default. People stay in control, and your list stays full of people who want to hear from you.

${CAS}`,
  },

  sales_followups: {
    category: 'marketing',
    name: 'Sales day 3: auto follow-ups',
    when: 'Sent on day 3 of the trial.',
    subject: 'Let your follow-ups send themselves',
    preheader: 'Welcome new people the moment they arrive, without lifting a finger.',
    vars: ['drips_url'],
    body: [
      h1('Follow up with everyone, automatically'),
      p('Hi {{first_name}}, many people do not buy the first time they hear from you. A few friendly follow-ups often help. The trouble is remembering to send them.'),
      p('With Castvoo, you write them once and they go out on their own.'),
      infoBox('<strong style="color:#0B1430;">Say you run a shoe shop.</strong><br>Someone starts your bot from your Instagram ad. Right away they get a welcome and your size guide. Two days later, your best sellers. Five days later, a reminder about free delivery. You set it up once. Castvoo sends it to every new person.'),
      p('<strong style="color:#0B1430;">What can start a follow-up:</strong>', 'margin-bottom:12px;'),
      steps([
        ['Someone starts your bot', 'Greet every new subscriber the moment they arrive.'],
        ['A join request to your channel or group', 'Your bot can message them within 5 minutes of their request, while they are still interested.'],
        ['A start link or a tag', 'Use a start link in each ad or post, so you see which one brought each person and can send them the right follow-up.'],
      ]),
      button('{{drips_url}}', 'Set up a follow-up'),
      small('Do not want to write them yourself? Ask Cas to write the whole sequence for you, then edit it to sound like you.'),
      signoff(CAS),
    ].join('\n'),
    text: `Follow up with everyone, automatically

Hi {{first_name}}, many people do not buy the first time they hear from you. A few friendly follow-ups often help. The trouble is remembering to send them.

With Castvoo, you write them once and they go out on their own.

Say you run a shoe shop. Someone starts your bot from your Instagram ad. Right away they get a welcome and your size guide. Two days later, your best sellers. Five days later, a reminder about free delivery. You set it up once. Castvoo sends it to every new person.

What can start a follow-up:

1. Someone starts your bot
   Greet every new subscriber the moment they arrive.

2. A join request to your channel or group
   Your bot can message them within 5 minutes of their request, while they are still interested.

3. A start link or a tag
   Use a start link in each ad or post, so you see which one brought each person and can send them the right follow-up.

Set up a follow-up: {{drips_url}}

Do not want to write them yourself? Ask Cas to write the whole sequence for you, then edit it to sound like you.

${CAS}`,
  },

  sales_cas: {
    category: 'marketing',
    name: 'Sales day 4: meet Cas',
    when: 'Sent on day 4 of the trial.',
    subject: 'Meet Cas, your AI writing helper',
    preheader: 'Teach Cas about your business and it writes in your voice.',
    vars: ['train_url'],
    body: [
      h1('Hi, I am Cas'),
      p('Hi {{first_name}}, I am the AI helper inside your Castvoo dashboard. Here is what I can do for you:'),
      steps([
        ['Write a message', 'Tell me what you want to say and I write it.'],
        ['Rewrite or translate', 'Make a message shorter, warmer or clearer, or put it in another language.'],
        ['Plan a follow-up sequence', 'I write each message in a series, ready for you to edit.'],
        ['Answer questions', 'Ask me about your workspace, like how a broadcast went.'],
      ]),
      p('<strong style="color:#0B1430;">I get much better when you teach me.</strong> On the Train Cas page, tell me what you sell, your prices, how you like to talk and the questions your customers ask.'),
      infoBox('<strong style="color:#0B1430;">Say you run a shoe shop.</strong><br>Tell me your sizes, where you deliver and that you keep things friendly and short. Then ask: <em>"Write a Friday sale message."</em> I come back with something that sounds like your shop, not like a robot.'),
      button('{{train_url}}', 'Train Cas'),
      small('Each plan comes with a set number of AI writes each month. If they run out, I take a break until your next billing date. There is never an extra charge. Always read what I write before you send it.'),
      signoff(CAS),
    ].join('\n'),
    text: `Hi, I am Cas

Hi {{first_name}}, I am the AI helper inside your Castvoo dashboard. Here is what I can do for you:

1. Write a message
   Tell me what you want to say and I write it.

2. Rewrite or translate
   Make a message shorter, warmer or clearer, or put it in another language.

3. Plan a follow-up sequence
   I write each message in a series, ready for you to edit.

4. Answer questions
   Ask me about your workspace, like how a broadcast went.

I get much better when you teach me. On the Train Cas page, tell me what you sell, your prices, how you like to talk and the questions your customers ask.

Say you run a shoe shop. Tell me your sizes, where you deliver and that you keep things friendly and short. Then ask: "Write a Friday sale message." I come back with something that sounds like your shop, not like a robot.

Train Cas: {{train_url}}

Each plan comes with a set number of AI writes each month. If they run out, I take a break until your next billing date. There is never an extra charge. Always read what I write before you send it.

${CAS}`,
  },

  sales_trial_last_day: {
    category: 'marketing',
    name: 'Sales day 6: trial almost over',
    when: 'Sent on day 6 of the trial.',
    subject: 'Your Castvoo trial is almost over',
    preheader: 'Top up your wallet to keep your messages and follow-ups running.',
    vars: ['plan_name', 'plan_price', 'pricing_url', 'topup_url'],
    body: [
      h1('Keep everything running'),
      p('Hi {{first_name}}, your free trial is nearly over. To keep going, your wallet needs enough to cover your plan.'),
      receipt([
        ['Your plan', '{{plan_name}}'],
        ['Price', '{{plan_price}}'],
      ]),
      p('When your plan is paid, your connected bots and channels stay connected, your follow-ups keep sending on their own, and Cas keeps helping you write.'),
      button('{{topup_url}}', 'Top up my wallet'),
      p('Not sure {{plan_name}} is right? <a href="{{pricing_url}}" target="_blank" style="color:#2F6BFF;font-weight:600;">Compare the plans</a>. There are no setup fees and no add-on fees, and you can cancel any time in Settings.'),
      infoBox('If you do not top up, sending simply pauses. Nothing is deleted, and we keep your data for {{data_retention_days}} days after a plan ends.'),
      signoff(CAS),
    ].join('\n'),
    text: `Keep everything running

Hi {{first_name}}, your free trial is nearly over. To keep going, your wallet needs enough to cover your plan.

Your plan: {{plan_name}}
Price: {{plan_price}}

When your plan is paid, your connected bots and channels stay connected, your follow-ups keep sending on their own, and Cas keeps helping you write.

Top up my wallet: {{topup_url}}

Not sure {{plan_name}} is right? Compare the plans: {{pricing_url}}
There are no setup fees and no add-on fees, and you can cancel any time in Settings.

If you do not top up, sending simply pauses. Nothing is deleted, and we keep your data for {{data_retention_days}} days after a plan ends.

${CAS}`,
  },

  sales_winback: {
    category: 'marketing',
    name: 'Sales day 10 after trial: come back offer',
    when: 'Sent 10 days after a trial ended without a paid plan.',
    subject: 'Come back to Castvoo with {{coupon_percent}}% off',
    preheader: 'Your account is still saved. Use code {{coupon_code}} before {{coupon_expiry}}.',
    vars: ['coupon_code', 'coupon_percent', 'coupon_expiry', 'pricing_url'],
    body: [
      h1('Your account is still here'),
      p('Hi {{first_name}}, your Castvoo trial ended a little while ago. Your bots, messages, follow-ups and subscribers are still saved, so you can pick up right where you left off.'),
      p('To make coming back easier, here is a discount on your plan:'),
      codeBox('{{coupon_code}}', { size: 26, spacing: 4 }),
      p('Enter it when you choose your plan to get <strong>{{coupon_percent}}% off</strong>. The code works until <strong>{{coupon_expiry}}</strong>.', 'text-align:left;'),
      button('{{pricing_url}}', 'Choose my plan'),
      small('We keep your data for {{data_retention_days}} days after a plan ends. After that, it is deleted for good.'),
      signoff(CAS),
    ].join('\n'),
    text: `Your account is still here

Hi {{first_name}}, your Castvoo trial ended a little while ago. Your bots, messages, follow-ups and subscribers are still saved, so you can pick up right where you left off.

To make coming back easier, here is a discount on your plan:

{{coupon_code}}

Enter it when you choose your plan to get {{coupon_percent}}% off. The code works until {{coupon_expiry}}.

Choose my plan: {{pricing_url}}

We keep your data for {{data_retention_days}} days after a plan ends. After that, it is deleted for good.

${CAS}`,
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
      p('Was something missing? Too hard to set up? The price? Just not the right time? Whatever it is, one line helps us make Castvoo better.'),
      button('{{reply_url}}', 'Share my answer'),
      p('Our team reads every answer. And if you would like help getting set up, say so and we will help.'),
      signoff(CAS),
    ].join('\n'),
    text: `What stopped you?

Hi {{first_name}}, you tried Castvoo but did not stay. That is completely fine. I would just love to know why.

Was something missing? Too hard to set up? The price? Just not the right time? Whatever it is, one line helps us make Castvoo better.

Share my answer: {{reply_url}}

Our team reads every answer. And if you would like help getting set up, say so and we will help.

${CAS}`,
  },
};

module.exports = templates;

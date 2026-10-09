---
title: "How to Auto-Approve Telegram Join Requests (and Welcome Every New Member)"
slug: "auto-approve-telegram-join-requests"
description: "Auto-approve Telegram join requests and DM every new member inside Telegram's 5-minute window. Step-by-step setup, approve modes and fixes."
seo_title: "How to Auto-Approve Telegram Join Requests (2026)"
focus_keyword: "auto approve telegram join requests"
category: "Guides"
tags: ["join requests", "telegram channel", "welcome message", "telegram bot", "how to"]
author: "castvoo-team"
date: "2026-10-09"
updated: "2026-10-09"
featured: false
takeaways:
  - "Turn on 'Approve new members' on your invite link, add a bot as admin with the Add members right, and the bot can approve requests for you."
  - "Telegram lets the bot message a person for 5 minutes after they ask to join, until the request is handled. Send the welcome first, then let them in."
  - "After that window, the bot can only reach people who pressed Start. A 'Tap to start' button is how you keep talking to them."
  - "Choose your approve mode on purpose: after the welcome, straight away, after they tap Start, or by hand."
faq:
  - q: "Can Telegram auto-approve join requests without a bot?"
    a: "No. Telegram itself does not auto-approve. Without a bot, an admin must approve each request by hand in the channel's member requests list. A bot with the Add members admin right can approve them automatically."
  - q: "Why does my bot fail to send the welcome to some people?"
    a: "Usually because the 5-minute window passed, the request was already handled, or the person has strict privacy settings. Send the welcome the moment the request arrives, before you approve it."
  - q: "Does auto-approving join requests stop spam bots?"
    a: "Not on its own. If you approve everyone at once, fake accounts get in too. A 'Tap to join' step, where people must press Start in your bot before they are let in, filters out most automated accounts."
  - q: "Can I approve join requests for a public channel?"
    a: "Join requests work on any invite link with 'Approve new members' turned on, so give people that link instead of your public username. Public groups can also be set to require approval for everyone who joins directly. Check your channel or group settings."
  - q: "What happens to requests I never approve?"
    a: "They stay open until a bot or admin approves or declines them, or the person cancels. Nothing is approved automatically by Telegram after a time limit."
  - q: "Is there a free tool to auto-approve Telegram join requests?"
    a: "Yes. Castvoo's Free plan auto-approves join requests for 1 channel or group, up to 500 a month, and sends one welcome message. No card is needed."
---

If your Telegram channel uses join requests, you already know the pain. People tap your link, ask to join, and then sit in a queue. Some wait hours. Some give up. This guide shows you how to **auto-approve Telegram join requests** and send every new member a private welcome, step by step, in plain words.

It takes about 10 minutes. You need a Telegram channel or group, a bot, and a tool to run it (we use Castvoo in the examples, but the Telegram rules are the same for any tool).

## What a join request is (and why it is worth using)

A join request is what happens when your invite link has **"Approve new members"** turned on. Instead of joining at once, the person sends a request. An admin, or a bot that is an admin, then approves or declines it.

Why channel owners use them:

- **You get a moment to talk to each person.** This is the big one. More on it below.
- **You can filter out spam accounts** before they join.
- **You can see who is asking** before they get in.

The downside is the queue. If nobody approves requests quickly, people leave. Auto-approving fixes that.

## The Telegram rule that changes everything: the 5-minute window

Normally, a bot cannot send a private message to someone who has never pressed Start in it. That is a core Telegram rule.

Join requests have one exception. When someone asks to join, Telegram gives your bot a short window to message them. The [Bot API docs](https://core.telegram.org/bots/api#chatjoinrequest) say the bot "can use this identifier for 5 minutes to send messages until the join request is processed."

Read that last part twice. The window ends at 5 minutes **or** when the request is handled, whichever comes first. So:

1. **Welcome first.** Send the private welcome the second the request arrives.
2. **Approve second.** Then let them in.

If you approve first, you may lose your only chance to message them.

[[note]]
**After the window closes,** your bot can only message this person again if they press Start in your bot. That is why a good welcome includes a "Tap to start" button. One tap, and they become a bot subscriber you can follow up with.
[[/note]]

## What you need before you start

- A **Telegram channel or group** you own or admin.
- A **bot** made with @BotFather. It takes two minutes: send `/newbot`, pick a name and a username, and copy the token BotFather gives you.
- **Your bot added as an admin** in the channel or group, with the right to add people ("Add Subscribers" in channels, "Add Members" in groups). Without this right, the bot cannot see or approve requests.
- An **invite link with "Approve new members" turned on.**

## Step by step: how to auto-approve Telegram join requests with a welcome

### Step 1. Create your bot

Open @BotFather in Telegram, send `/newbot`, and follow the prompts. Give it a friendly name people will recognise, like "Ada from Lagos FX Community". Copy the token.

Tip: set a profile photo and a short description with `/setuserpic` and `/setdescription`. People are more likely to press Start on a bot that looks real.

### Step 2. Add the bot as an admin

In your channel: **Settings → Administrators → Add Admin**, search your bot, and turn on the right to add people. Telegram labels it **"Add Subscribers"** in channels and **"Add Members"** in groups; in the Bot API it is called "invite users". For a channel, posting rights are only needed if you want the bot to post too.

### Step 3. Turn on join requests for your invite link

In your channel: **Settings → Invite Links**. Open the link you share (or create a new one) and turn on **"Approve new members"** (sometimes shown as "Request admin approval").

Use this link in your ads, bio and posts. Anyone who uses it will now send a request instead of joining at once.

### Step 4. Connect the channel and bot to your tool

In Castvoo, you paste your BotFather token to connect the bot, then connect the channel. Castvoo checks that your bot is an admin with the right permission before a flow goes live, and tells you how to fix it if not.

### Step 5. Write the welcome

Keep it short. The person just asked to join; they are curious, not ready for an essay. A simple pattern:

> Hi {name}, welcome! 👋 You're in. Here's what to do first:
> 1. Read the pinned post.
> 2. Tap below so I can send you the free starter guide.
> [Tap to start] [Open the channel]

`{name}` becomes their Telegram first name. If it is unknown, it becomes "there".

### Step 6. Choose how people are let in

This is the decision most people skip. Castvoo gives four modes, and the same choices apply in most tools:

| Approve mode | What happens | Best for |
|---|---|---|
| After the welcome is sent (default) | Bot sends the welcome, then approves. If Telegram refuses the welcome, the person waits in your Requests list. | Most channels |
| Straight away | Approved at once, even if the welcome fails. | When speed matters more than the welcome |
| When they tap "Tap to join" and press Start | Only let in after they open the bot and press Start. | Filtering bots and spam; building your bot list |
| By hand | Requests wait in a list; you approve or decline many at once. | Paid, VIP or invite-only groups |

### Step 7. Turn it on and test

Use a second Telegram account (or a friend's phone). Tap your invite link, request to join, and check:

- Did the welcome arrive within a few seconds?
- Did the buttons work?
- Were you let in?

[[cta]]

## Which approve mode should you choose?

If you are not sure, answer these three questions.

**1. Is your channel free and open to anyone?**
Use **after the welcome is sent**. Everyone gets a welcome first and is let in a second later. You lose nobody, and nobody waits.

**2. Do you get lots of fake or spam accounts (common with cheap ad traffic)?**
Use **"Tap to join"**. People are only let in after they open your bot and press Start. Real people do it in seconds. Automated accounts mostly do not. Bonus: everyone who gets in is now a bot subscriber you can follow up with.

**3. Is it a paid, VIP or invite-only group?**
Use **by hand**. Requests wait in your list, and you approve or decline in bulk, for example after checking a payment.

Use **straight away** only if speed is everything and the welcome is optional for you, for example during a live event when hundreds of people request at once and you want them inside immediately.

You can also mix modes. In Castvoo, each Welcome Flow can have its own invite link. So your public ad link can use "Tap to join", while the link you give to existing customers uses "after the welcome is sent".

## Join requests in channels vs groups

Join requests work in both, with small differences.

| | Channel | Group |
|---|---|---|
| Admin right the bot needs | Add Subscribers | Add Members |
| Where approved people land | The channel feed | The group chat |
| Welcome DM in the 5-minute window | Yes | Yes |
| Public option | Use a private invite link with approval | Public groups can require approval for everyone who joins directly |

In a group, a welcome DM is much nicer than a public "Welcome @user!" post in the chat. It does not clutter the group, and the new member can read it quietly.

## Privacy and safety notes

- **Your bot token is a password.** Anyone with it controls your bot. Only paste it into tools you trust, and revoke it in @BotFather (`/revoke`) if it leaks. Castvoo encrypts bot tokens at rest.
- **Only message people who asked.** The 5-minute window exists so you can greet people who requested to join you. Do not use it for anything they did not ask for.
- **Keep the welcome honest.** If you run a trading, betting or crypto channel, never promise profits or "sure wins" in your welcome. Say what you share.
- **Make leaving easy.** If people later get bot messages from you, give them a clear way to stop.

## Common problems and fixes

| Problem | Likely cause | Fix |
|---|---|---|
| Requests are not approved | Bot is not an admin, or lacks the Add members right | Re-add the bot as admin with Add members on |
| Welcome never arrives | Request was approved before the welcome was sent | Use "after the welcome is sent" mode |
| Some people never get the welcome | 5-minute window passed, or they cancelled | Make sure your tool reacts instantly; check that the bot is connected |
| Fake accounts getting in | Approving everyone at once | Use "Tap to join" mode |
| Follow-ups do not reach people | They never pressed Start | Add a clear "Tap to start" button with a reason to tap |

## Make the welcome do real work

Approving people is the minimum. The welcome is where the value is.

- **Give one clear next step.** "Read the pinned post" or "Tap for the free guide". Not five options.
- **Give a reason to press Start.** A checklist, a starter guide, a schedule of live sessions. Something they actually want.
- **Follow up later.** A message 3 hours later and another the next day work better than one long welcome. Our [guide to Telegram drip campaigns](/blog/telegram-drip-campaigns) shows example sequences.

For the full picture of welcome messages, button ideas and templates, read the [Telegram welcome bot guide](/blog/telegram-welcome-bot).

## How many join requests can you handle?

Telegram does not cap how many join requests a channel can receive. Your tool might. On Castvoo:

| Plan | Join requests a month | Welcome Flows |
|---|---|---|
| Free | 500 | 1 (a single welcome message) |
| Starter ($19) | 5,000 | 3 |
| Growth ($49) | 30,000 | 15 |
| Scale ($99) | 150,000 | Unlimited |

If you pass your limit (plus 10% extra), people are still let in automatically. Only the welcome messages pause until next month or an upgrade, and the dashboard tells you how many people joined without your welcome.

## A quick word on growth

Auto-approving join requests does not bring people in. It stops you losing the ones who already came. If you want more requests in the first place, see [how to grow a Telegram channel without fake members](/blog/grow-telegram-channel).

If you pay for that traffic, the welcome matters even more. Our media buying lead explains why in [running Facebook ads to a Telegram channel](/blog/facebook-ads-to-telegram).

[[cta]]

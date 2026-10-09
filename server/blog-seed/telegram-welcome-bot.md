---
title: "Telegram Welcome Bot: The Complete Guide (2026)"
slug: "telegram-welcome-bot"
description: "A Telegram welcome bot greets every new member in private, lets them in and follows up. Learn the 3 types, Telegram's rules, and 6 ready templates."
seo_title: "Telegram Welcome Bot: The Complete Guide (2026)"
focus_keyword: "telegram welcome bot"
category: "Guides"
tags: ["welcome bot", "welcome message", "join requests", "telegram channel", "telegram group", "onboarding"]
author: "castvoo-team"
date: "2026-10-09"
updated: "2026-10-09"
featured: true
takeaways:
  - "There are three kinds of Telegram welcome: a message in the group, a reply when someone starts your bot, and a private DM to someone asking to join your channel."
  - "Only the private DM to a join request works for channels, and only for 5 minutes after the request, until it is handled."
  - "A welcome has one job: get one next action. The best next action is pressing Start in your bot, because that lets you follow up."
  - "Short welcome plus timed follow-ups beats one long message. Test two versions and keep the winner."
faq:
  - q: "What is a Telegram welcome bot?"
    a: "It is a bot that automatically greets new people. In a group it can post a welcome in the chat. For a channel or group with join requests, it can send each person a private message, let them in, and follow up later."
  - q: "Can a bot send a welcome message to new channel subscribers?"
    a: "Only if they join through a join request, or if they already pressed Start in your bot. Bots cannot message people who never pressed Start. With join requests, the bot can DM the person for 5 minutes, until the request is handled."
  - q: "How do I add a welcome message to my Telegram group?"
    a: "Add a welcome bot to the group as an admin and set the message. For a private welcome that also works for channels, turn on 'Approve new members' on your invite link and use a tool that welcomes join requests."
  - q: "What should a Telegram welcome message say?"
    a: "Greet the person by first name, tell them in one line what the channel gives them, and give one clear next step, ideally a button that opens your bot. Keep it under about 60 words."
  - q: "Is a welcome bot against Telegram's rules?"
    a: "No. Welcoming people who asked to join you is normal and allowed. What is not allowed is messaging people who never contacted you, buying lists, or adding people without consent."
  - q: "Do I need to code a Telegram welcome bot?"
    a: "No. You create a bot with @BotFather in two minutes, then connect it to a no-code tool. Castvoo's Free plan includes one welcome message and auto-approve for one channel or group."
---

A **Telegram welcome bot** is the first thing a new member hears from you. Done well, it turns a curious stranger into someone who reads, clicks and comes back. Done badly, or not at all, it lets people slip in and forget why they came.

This is our complete guide. You will learn the three kinds of Telegram welcome, the rules Telegram sets for each, what to write, and how to keep the conversation going after "hello". No coding needed.

## The three kinds of Telegram welcome

People often mix these up, and it causes a lot of confusion.

| Type | Where it appears | Works for | Who sees it |
|---|---|---|---|
| Group welcome post | Inside the group chat | Groups only | Everyone in the group |
| Bot /start welcome | Private chat with your bot | Anyone who presses Start in your bot | Only that person |
| Join-request welcome DM | Private chat with your bot | Channels and groups with join requests | Only that person |

### 1. The group welcome post

Classic group bots post "Welcome, Tunde!" in the group when someone joins. It is fine for small communities. But in a busy group it becomes noise, and it does nothing for channels, because channels have no chat.

### 2. The bot /start welcome

When someone presses Start in your bot, the bot replies. That reply is a welcome. It works well, but only for people who already found your bot.

### 3. The join-request welcome DM

This is the one that matters most for channel owners. Turn on "Approve new members" on your invite link. Now each person who taps it sends a join request, and your bot gets a short chance to message them privately before they are let in.

The [Telegram Bot API](https://core.telegram.org/bots/api#chatjoinrequest) says the bot can use this chat "for 5 minutes to send messages until the join request is processed." So the welcome must go first, fast, before approval.

[[note]]
**Why channels need join requests for a welcome.** Bots cannot start a private chat with someone who never pressed Start. So when a stranger joins your channel directly, your bot has no way to say hello. Join requests are the only built-in way to greet every new channel member in private.
[[/note]]

For the exact setup, follow our step-by-step guide: [how to auto-approve Telegram join requests](/blog/auto-approve-telegram-join-requests).

## What a welcome bot should actually do

A good Telegram welcome bot does four jobs, in this order:

1. **Greets** the person by name, at once.
2. **Lets them in** (or decides not to).
3. **Gets one action**, ideally pressing Start in your bot.
4. **Follows up** over the next hours and days.

Most bots stop at step 2. The money, the trust and the retention are in steps 3 and 4.

### Why "press Start" is the goal

Once the 5-minute window closes, your bot can only message people who pressed Start. So the most valuable thing your welcome can do is earn that tap. In Castvoo this is a **"Tap to start"** button: it opens your bot with a special link, and when the person presses Start, they become a bot subscriber. Now your later steps can reach them.

People who never tap stay channel members. You can still reach them with channel posts, just not in private. In Castvoo, later flow steps wait up to 7 days for someone to tap Start, then stop.

## How to write a welcome that works

### Keep it short

Under about 60 words. The person just arrived. They want to know they are in the right place, and what to do next.

### Use their name

"Hi Amaka" beats "Hi there". In Castvoo, `{name}` becomes each person's Telegram first name, and falls back to "there" if unknown. You can set your own fallback with `{name|friend}`.

### Make one promise and one ask

- **Promise:** what they get here. "Daily market notes at 8am." "New drops every Friday."
- **Ask:** one action, as a button. "Tap to get the starter guide."

### Use buttons, not long links

Buttons are easier to tap on a phone and can be tracked. In Castvoo you can add up to 6 link buttons per message, up to 2 side by side, and see who clicked.

### Respect the rules of your niche

If you run a trading, betting or crypto channel, do not promise profits or "guaranteed wins" in a welcome. It is misleading, it breaks most ad and platform rules, and it attracts the wrong people. Say what you share, not what people will earn.

## 6 welcome message templates you can copy

Swap the details for your own. `{name}` is the person's first name.

### 1. Simple welcome

> Hi {name}, welcome to [Channel] 👋 You're in. Start with the pinned post, it explains everything in 2 minutes.

### 2. Welcome + starter guide (best for building your bot list)

> Hi {name}! Glad you're here. I put together a free 1-page starter guide for new members.
> [Tap to get the guide]

### 3. Welcome + VIP link

> Welcome, {name}. The main channel is open to everyone. Members who want more detail join our VIP group here:
> [See VIP details]

### 4. Welcome + schedule

> Hi {name}, you're in ✅ Here's when we post:
> • Mon to Fri, 8am: daily notes
> • Sunday, 6pm: weekly recap
> Tap below so I can remind you before live sessions.
> [Remind me]

### 5. Welcome for a store

> Hi {name}, welcome to [Store] on Telegram. New stock lands here first. Want this week's drops in your DMs?
> [Yes, send them]

### 6. Welcome + filter ("Tap to join")

> Hi {name}, one quick step: tap the button and press Start to confirm you're a real person. You'll be let in at once.
> [Tap to join]

This last one only lets people in after they press Start in your bot. It filters out most fake accounts and builds your bot subscriber list at the same time.

## After the welcome: follow-ups

One message is a greeting. A short sequence is a relationship. A simple sequence that works for most channels:

| When | Message idea |
|---|---|
| At once | Welcome + "Tap to start" |
| 3 hours later | "Did you see the pinned post? Here's the one thing to read first." |
| Next day | A useful tip, story or resource |
| Day 3 | Your offer, or an invite to your VIP group, with a button |

In Castvoo, a Welcome Flow is just a stack of steps: messages and waits ("Wait 3 hours"). On Growth and up, you can send a later message only to people who clicked, or did not click, a button in an earlier message.

Want more sequence ideas? See [Telegram drip campaigns that convert](/blog/telegram-drip-campaigns).

[[cta]]

## Measure it: what to look at

You cannot improve what you cannot see. The numbers that matter:

- **Asked to join:** how many requests came in.
- **Welcomed:** how many got the welcome.
- **Tapped Start:** how many became bot subscribers.
- **Let in:** how many joined.
- **Clicked:** how many tapped your main button.

Castvoo shows per-step deliveries and clicks on Starter, and the full funnel (asked → welcomed → tapped Start → let in → clicked) on Growth and up.

One honest limit: Telegram does not give bots read receipts. No tool can tell you who read a message. Clicks are the signal you can trust.

### Test two versions

Small changes in the first line or button text can change your tap rate a lot. On Castvoo Growth you can run an A/B welcome with 2 versions (Scale: up to 4). People are split evenly, and you see deliveries and clicks per version. Run it for at least a few hundred joins before you pick a winner.

## Welcome bots for media buyers

If you pay for traffic, the welcome bot is not a nice extra. It is where you either keep or lose what you paid for. Every person who asks to join and never hears from you is a paid lead with no follow-up.

Two things to set up:

1. **Track the source.** Use a different invite link or start link per ad, so you know which ad brought which people. See [how to track which ad brought each Telegram subscriber](/blog/track-telegram-subscribers-from-ads).
2. **Do not let the welcome be your only message.** A follow-up the next day often does more than the welcome itself.

## Choosing a Telegram welcome bot tool

Look for:

- Private welcome DMs for **join requests**, not only group posts.
- **Approve modes** you control (after welcome, straight away, after Start, by hand).
- A way to turn joiners into **bot subscribers**.
- **Timed follow-ups**.
- **Click tracking** per button.

We compare the main options in [the best Telegram broadcast bots in 2026](/blog/best-telegram-broadcast-bots). Castvoo is our product, so we say so there and point out where others are stronger.

If you are new to all of this, start with the bigger picture: [Telegram marketing for beginners](/blog/telegram-marketing-for-beginners).

## Start free

Castvoo's Free plan gives you one channel or group, 500 join requests a month, auto-approve, and one welcome message with up to 3 buttons. No card needed. When you need follow-ups, broadcasts and "Tap to start", Starter is $19 a month.

[[cta]]

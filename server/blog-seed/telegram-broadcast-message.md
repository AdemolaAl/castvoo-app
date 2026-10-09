---
title: "How to Send a Broadcast Message on Telegram to All Subscribers"
slug: "telegram-broadcast-message"
description: "How to send a broadcast message on Telegram to all your subscribers: channel posts vs bot broadcasts, step-by-step setup, real limits and best times."
seo_title: "How to Send a Broadcast Message on Telegram (2026)"
focus_keyword: "send a broadcast message on telegram"
category: "Guides"
tags: ["telegram broadcast", "bot broadcast", "telegram channel", "mass message", "how to"]
author: "castvoo-team"
date: "2026-10-09"
updated: "2026-10-09"
featured: false
takeaways:
  - "There are two real ways to broadcast on Telegram: post in a channel (reaches every member) or send from a bot (reaches everyone who pressed Start, in private)."
  - "Never mass-DM from your personal account. Telegram limits accounts that do it, and it annoys people."
  - "Telegram lets bots send about 30 messages per second in bulk. A good tool stays under that, so 10,000 people take a few minutes."
  - "Every bot broadcast should have an easy way to stop, a clear button, and a reason to exist."
faq:
  - q: "Does Telegram have a broadcast list like WhatsApp?"
    a: "Not in the same way. Telegram's built-in one-to-many tool is the channel. For private one-to-one broadcasts, you use a bot, which can message everyone who pressed Start in it."
  - q: "How many people can I broadcast to on Telegram?"
    a: "A Telegram channel has no subscriber limit. A bot can message everyone who started it; the only practical limit is speed, about 30 messages per second, and your tool's plan."
  - q: "Can I send a Telegram broadcast with each person's name?"
    a: "Yes, from a bot. Each private message can include the person's first name. Channel posts are one message for everyone, so they cannot be personal."
  - q: "Can I schedule a Telegram broadcast?"
    a: "Yes. Telegram channels have scheduled posts built in. Bot broadcast tools, including Castvoo, let you schedule for a date and time, or send at the next 9am in your workspace time zone."
  - q: "Why did some people not receive my bot broadcast?"
    a: "Usually because they blocked the bot, deleted their account, or never pressed Start. Good tools mark blocked users automatically and stop messaging them."
---

You have an audience on Telegram and something to tell them. How do you **send a broadcast message on Telegram** to all of them at once, without spamming and without getting your account limited?

This guide shows you the two methods that actually work, when to use each one, and how to set up a bot broadcast step by step. It also covers the real limits Telegram sets, so you know what to expect.

## The two real ways to broadcast on Telegram

| | Channel post | Bot broadcast |
|---|---|---|
| Who gets it | Everyone in the channel | Everyone who pressed Start in your bot |
| Where it lands | The channel feed | Each person's private chat with your bot |
| Personal (first name) | No | Yes |
| Buttons | Yes (via a bot or tool) | Yes |
| Per-person click tracking | No (total clicks only, with a tool) | Yes, with a tool |
| Notification | Normal or silent | Normal |
| Limit | Unlimited subscribers | About 30 messages per second |

**Rule of thumb:** use the channel for updates everyone should see. Use the bot for messages that feel personal, need a click, or go to a specific group of people.

[[note]]
**Do not mass-DM from your personal account.** Sending the same message to lots of people who did not message you first is treated as spam. Telegram can limit your account so you can only message mutual contacts. Use a channel or a bot instead.
[[/note]]

## Method 1: Post in your Telegram channel

If you have a channel, this is the simplest broadcast there is.

1. Open your channel.
2. Type your message, add a photo or video if you like.
3. Tap and hold the send button for more options: **Send without sound** (silent) or **Schedule message**.
4. Send.

Every subscriber sees it in the channel. It is free and has no subscriber limit.

What a plain channel post cannot do: greet people by name, land in their private chats, or tell you who clicked. For that, you need a bot.

## Method 2: Send a broadcast message on Telegram from a bot

A bot broadcast goes into each person's private chat with your bot. It feels like a personal message, and it gets attention for exactly that reason, so use it with care.

### The rule that decides who you can reach

A bot can only message people who pressed **Start** in it. That is Telegram's rule, and no tool can get around it.

So your bot broadcast list is only as big as the number of people who started your bot. If most of your audience is in a channel and never started your bot, build that list first. The easiest way is a welcome with a "Tap to start" button for every new joiner. See the [Telegram welcome bot guide](/blog/telegram-welcome-bot).

### Step-by-step: bot broadcast with Castvoo

We use Castvoo here (our product). Other tools follow similar steps; see [the best Telegram broadcast bots](/blog/best-telegram-broadcast-bots) for alternatives.

**Step 1. Create a bot.** In Telegram, open @BotFather, send `/newbot`, pick a name and username, and copy the token.

**Step 2. Connect it.** Paste the token into Castvoo. You can also connect channels and groups with one tap by adding @CastvooBot as an admin, so you can post to them from the same place.

**Step 3. Write the message.** Text can be up to 4,096 characters. A photo or video caption can be up to 1,024 characters. Photos up to 10 MB, videos up to 50 MB. Use `{name}` to insert each subscriber's first name.

**Step 4. Add a button.** One clear button beats three links. Buttons are tracked, so you see which subscriber clicked.

**Step 5. Pick who gets it.** Everyone, or (on Growth and up) an audience, for example only people who came from a certain ad.

**Step 6. Pick when.** Send now, schedule for a date and time, or send at the next 9am in your workspace time zone.

**Step 7. Send and watch.** Castvoo sends about 25 messages per second per bot, so 10,000 people take roughly 7 minutes.

Broadcasts are on Castvoo's paid plans, from Starter at $19 a month (unlimited broadcasts, up to 5,000 bot subscribers). Channel and group members never count toward that limit, because a channel post is one message.

[[cta]]

## Telegram's broadcast limits, explained simply

These come from Telegram's own [Bots FAQ](https://core.telegram.org/bots/faq):

- **About 30 messages per second** for bulk sends to different people.
- **About 1 message per second** to the same chat.
- **No more than 20 messages per minute** to the same group.
- **Paid broadcasts** let large bots send up to 1,000 messages per second, at 0.1 Telegram Stars per message above the free 30 per second. They need at least 100,000 Stars and 100,000 monthly active users, so most bots will never need them.

Go faster than the limits and Telegram returns "too many requests" errors. Good tools pace themselves for you.

## Write broadcasts people want to open

### One message, one job

Every broadcast should have one purpose: read this, watch this, join this, buy this. If you need two jobs, send two messages on two days.

### Front-load the point

On a phone notification, people see the first line or two. Put the reason to open there.

| Weak first line | Stronger first line |
|---|---|
| "Hello everyone, hope you are having a great week!" | "{name}, tonight's live session starts at 7pm WAT." |
| "We have some exciting news to share with you." | "New drop: 40 pieces, restocked once." |

### Make stopping easy

People who want to leave and cannot will block your bot or report it. Castvoo adds a **"Stop these messages"** button to bot broadcasts by default, and `/stop` also works. People who block the bot are marked as blocked and never messaged again.

### Send at a sensible time

Pick a time that suits your audience's day. If most of your people are in one time zone, "next 9am" is a safe default. Note that Castvoo uses your workspace time zone; it does not detect each subscriber's own time zone.

### Do not overdo it

There is no magic number, but every message should earn its place. If your block rate climbs after a broadcast, you sent too much, too often, or the wrong thing.

## 5 broadcast templates you can adapt

`{name}` becomes each subscriber's first name in bot broadcasts. In channel posts, leave it out.

**1. The live session reminder**
> {name}, we go live in 1 hour (7pm WAT). Topic: how to read a price chart in 10 minutes. Bring questions.
> [Set a reminder]

**2. The new drop**
> New in: 3 colours, 40 pieces, restocked once. Members see it first.
> [See the drop]

**3. The useful tip**
> Quick tip, {name}: before you share your screen on a call, close your banking app. Small habit, big safety win.
> [More safety tips]

**4. The "we missed you"**
> Hi {name}, it's been a while. Here's the one post from this month worth your 2 minutes.
> [Read it]

**5. The honest offer**
> Our beginner course opens on Monday: 12 short lessons and a weekly Q&A. It's for people starting from zero. Here's everything inside, including the price.
> [See the course]

Each one has one job, one button, and a first line that makes sense on a lock screen.

## Segment before you send

Not every message is for everyone. Sending a "beginner course" broadcast to people who already bought it is how block rates climb.

Simple segments that make broadcasts better:

- **By source:** people who came from your TikTok vs your partner channel often want different things.
- **By action:** people who clicked last week's offer vs people who did not.
- **By newness:** people who started your bot this week vs long-time subscribers.

In Castvoo, audiences apply to bot subscribers and are on the Growth plan and up. A channel or group post always reaches everyone in it, so keep channel posts general and use bot broadcasts for targeted messages.

## Fixing mistakes after you send

- **Edit:** fix a typo in a sent message.
- **Pin:** keep an important message at the top of a channel or group.
- **Delete:** Telegram only lets bots delete messages less than 48 hours old, so if you need to pull something, do it quickly.

## Broadcast vs follow-up: what is the difference?

A **broadcast** is one message you send to many people at a time you choose.

A **follow-up** (or drip) is a message that sends itself to each person at a set time after they did something, like starting your bot. For example, "Day 2 tip" goes to each person on their own Day 2.

Most good Telegram setups use both: drips for onboarding, broadcasts for news. Read [Telegram drip campaigns that convert](/blog/telegram-drip-campaigns) to set one up.

## Telegram or WhatsApp for broadcasts?

If you are choosing where to build, the platforms work very differently. WhatsApp broadcast lists only reach people who saved your number, and the business API charges per marketing message. Telegram channels and bots do not. Full breakdown: [Telegram vs WhatsApp for broadcasting](/blog/telegram-vs-whatsapp-broadcast).

[[cta]]

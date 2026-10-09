---
title: "How to Track Which Ad Brought Each Telegram Subscriber"
slug: "track-telegram-subscribers-from-ads"
description: "Track which ad brought each Telegram subscriber with start links, named invite links and UTM-style tags. A media buyer's attribution setup, step by step."
seo_title: "Track Which Ad Brought Each Telegram Subscriber"
focus_keyword: "track which ad brought each telegram subscriber"
category: "Media Buying"
tags: ["attribution", "start links", "telegram tracking", "utm", "media buying", "dchessking"]
author: "dchessking"
date: "2026-10-09"
updated: "2026-10-09"
featured: false
takeaways:
  - "Telegram gives you two free tracking tools: start links for your bot (person-level) and named invite links for your channel (count-level)."
  - "A start link is t.me/yourbot?start=tag. The tag can be up to 64 characters of letters, numbers, underscores and hyphens."
  - "Use one naming system everywhere: ad platform, country, campaign, creative. Same name in Ads Manager and in Telegram."
  - "Attribution is only useful if it changes decisions. Review cost per banked lead by tag every week."
faq:
  - q: "How do I track Telegram channel joins from Facebook ads?"
    a: "Create a separate named invite link for each ad in your channel settings and use it as that ad's link. Telegram counts how many people joined through each one. For person-level tracking, send ads to your bot with a start link per ad."
  - q: "What is a Telegram start parameter?"
    a: "It is the text after ?start= in a bot link, such as t.me/yourbot?start=fb_ad1. When someone presses Start, the bot receives that text, so you know where they came from. Telegram allows up to 64 characters: A-Z, a-z, 0-9, underscore and hyphen."
  - q: "Can I use UTM parameters in Telegram links?"
    a: "Not as normal UTMs. Telegram ignores them in t.me links. Put UTMs on your landing page URL for web analytics, and put a short UTM-style tag in the start parameter for the bot."
  - q: "Can Meta see Telegram joins?"
    a: "Not by itself. Meta only sees events your pixel or Conversions API reports. To send Telegram joins back to Meta you need a tool that posts those events to the Conversions API."
  - q: "Which Castvoo plan includes start links?"
    a: "Start links, audiences built from them and the flow funnel stats are on the Growth plan ($49 a month) and up. The 7-day free trial is on Growth, so you can test them first."
---

If you cannot say which ad brought which subscriber, you are not media buying. You are donating to Meta and hoping.

This post is my practical setup to **track which ad brought each Telegram subscriber**. It uses free Telegram features, a naming system you can copy, and a weekly review that turns the data into decisions.

## Why it is hard to track which ad brought each Telegram subscriber

On a website, the pixel follows the user from click to purchase. On Telegram, the trail goes cold the moment the app opens. Meta does not see inside Telegram. Telegram does not report to Meta.

So you need to carry the source with the person. Telegram gives you two ways to do it.

## Tool 1: Start links (person-level tracking)

A start link opens your bot with a hidden label:

```
https://t.me/yourbot?start=fb_ng_video3
```

When someone taps it and presses Start, your bot receives `fb_ng_video3`. Your tool saves it on that subscriber. Now you know that Amaka came from the Nigeria video 3 ad, forever.

Telegram's rules for the tag ([Bot features docs](https://core.telegram.org/bots/features#deep-linking)):

- Up to **64 characters**.
- Only **A-Z, a-z, 0-9, underscore (_) and hyphen (-)**.
- No spaces, no dots, no equals signs. So `utm_source=facebook` will not work. Use `fb`.

**Best for:** ads that send people to your bot, or landing pages that link to your bot.

## Tool 2: Named invite links (count-level tracking)

In your channel: **Settings → Invite Links → Create a new link.** Give it a name like `FB KE Carousel 2`. Telegram shows admins how many people joined through each link.

You can create many links for one channel. Turn on "Approve new members" on each one if you want join requests (and a welcome).

**Best for:** ads that send people straight to the channel, partner shout-outs, influencer posts.

**Limit:** the numbers live inside the Telegram app. They are not joined up with your bot subscribers, button clicks or follow-ups, and you cannot message channel members privately unless they press Start in your bot.

[[note]]
**In Castvoo,** each Welcome Flow can have its own invite link (the bot can create one for you). People who ask to join through that link get that flow, and the flow stats show their results. That gives you a separate welcome, and separate numbers, per ad or partner.
[[/note]]

## The naming system I use

Bad names kill attribution. Six months later, nobody remembers what "test2" was. I use one pattern everywhere:

```
platform_country_campaign_creative
```

| Part | Examples |
|---|---|
| platform | fb, ig, tt (TikTok), gg (Google), tg (Telegram Ads), inf (influencer), prt (partner channel) |
| country | ng, ke, gh, za, cm |
| campaign | guide, live, vip |
| creative | v1, v2, car3 (carousel 3) |

Examples:

- `fb_ng_guide_v2`
- `tt_ke_live_v1`
- `prt_gh_cryptodaily`

Same name in Ads Manager (ad name), in the start tag, and in the invite link name. When a report says `fb_ng_guide_v2` did well, everyone knows exactly which ad to scale.

Keep a simple sheet that maps each tag to the ad, the date it started and the budget.

## Step-by-step setup

### Step 1. Decide your funnel

- Ad → bot: use start links.
- Ad → channel: use named invite links.
- Ad → landing page → bot or channel: UTMs on the landing page for web analytics, plus a start link or invite link on the button.

My preference is landing page → channel with join requests, with a welcome that asks for the Start tap. More on why in [running Facebook ads to a Telegram channel](/blog/facebook-ads-to-telegram).

### Step 2. Create one link per ad

Do it before launch. Duplicating an ad? Duplicate the link too.

### Step 3. Connect the source to the welcome

If you send ads to the channel with a flow-specific invite link, the welcome can match the ad. Someone who clicked a "free checklist" ad should get the checklist in the welcome, not a generic hello.

### Step 4. Turn joiners into tagged bot subscribers

The welcome's "Tap to start" button opens your bot. Once they press Start, they are a bot subscriber you can follow up with.

### Step 5. Build audiences by source

On Castvoo Growth and up, you can build audiences from start link tags. Send a follow-up only to people from `tt_ke_live`, or a broadcast only to people who came from partner channels.

You can also trigger different auto follow-ups by start link tag, so each ad gets its own sequence.

### Step 6. Pull the numbers weekly

For each tag, write down:

| Tag | Spend | Joins | Bot subscribers | Bank rate | Cost per banked lead | 30-day value |
|---|---|---|---|---|---|---|
| fb_ng_guide_v2 | from Ads Manager | invite link or flow stats | from your tool | subs ÷ joins | spend ÷ subs | from your offer data |

Then decide: scale, fix or kill.

[[cta]]

## Setting it up in Castvoo

If you use Castvoo (built by Zedapex, my company, so weigh my view accordingly), here is where each piece lives:

- **Start links** (Growth and up): create a link per ad, like `t.me/yourbot?start=fb_ng_guide_v2`. Every subscriber who starts through it is saved with that tag.
- **Audiences** (Growth and up): build a segment from a start link tag, then broadcast or follow up only to that group.
- **Auto follow-ups by tag:** trigger a different sequence for each start link, so each ad gets the message that matches its promise.
- **Invite link per Welcome Flow:** give a partner or ad its own channel link with its own welcome.
- **Funnel stats** (Growth and up): asked → welcomed → tapped Start → let in → clicked, per flow.
- **CSV export:** download your bot subscribers (on every plan, for the workspace owner) to join with your spend sheet.

The 7-day trial is on the Growth plan with no card, so you can set up start links and see real data before paying.

## A worked example

Here is how the weekly review looks with three ads. The numbers are made up to show the method, not a benchmark.

| Tag | Spend | Joins | Bot subscribers | Bank rate | Cost per join | Cost per banked lead |
|---|---|---|---|---|---|---|
| fb_ng_guide_v1 | $100 | 400 | 60 | 15% | $0.25 | $1.67 |
| fb_ng_guide_v2 | $100 | 250 | 125 | 50% | $0.40 | $0.80 |
| fb_ke_live_v1 | $100 | 180 | 90 | 50% | $0.56 | $1.11 |

Without tags, you would see "830 joins for $300" and move on. With tags, three decisions jump out:

1. **v1 looks cheapest per join but is the most expensive per banked lead.** Pause it or fix its promise.
2. **v2 is the winner.** Same audience, better creative. Shift budget there.
3. **Kenya live is solid.** Worth a test with a second creative.

Then check 30-day value by tag before you scale hard. A source with great bank rate but no sales later is still not a winner.

## Tracking partners, influencers and organic posts

Attribution is not only for paid ads. Use the same system for every source:

- **Partner channel shout-outs:** a named invite link per partner (`prt_gh_cryptodaily`). Now you know which swaps are worth repeating, and which partners to pay again.
- **Influencer posts:** a start link per influencer (`inf_za_thandi`). Pay for results you can see, not follower counts.
- **Your own socials:** different links in your Instagram bio, TikTok bio and YouTube description (`ig_bio`, `tt_bio`, `yt_desc`).
- **Offline:** a QR code on a flyer or packaging that opens a start link (`qr_flyer_oct`).

When every source has a label, your monthly report stops being "we grew 3,000 members" and becomes "TikTok bio brought 1,200, partner swaps 900, ads 900, and ads had the best bank rate". That is a report you can act on.

## Sending Telegram events back to Meta

Everything above tells **you** what works. It does not tell **Meta's algorithm**.

If you want Meta to optimise for joins or bot starts, you need a server-side setup that sends those events to Meta's Conversions API. Tools like TG Tracker specialise in this. Castvoo does not send events to Meta today; it shows attribution in your dashboard.

For many buyers, especially with a landing page that carries the pixel, dashboard attribution is enough to make good scaling decisions. If you run high volume and want the algorithm to learn from Telegram events, look at a CAPI tool.

## Honest limits of Telegram attribution

- **Forwarded links.** If someone forwards your start link to a friend, the friend gets the same tag. Your "ad" gets credit for word of mouth. Usually a small effect, but know it exists.
- **People who never press Start.** Channel joiners through an invite link are counted per link, but you cannot follow them up privately until they tap Start.
- **Multiple touches.** Someone might see a TikTok, then click a Facebook ad. Start links record the last click.
- **No read receipts.** Telegram does not tell bots who read a message. Clicks on tracked buttons are your best engagement signal.

## The point of all this

Tracking is not for pretty reports. It is so you can stop spending on ads that bring people who never bank, and put that money into ads that do. If you want the full list of ways buyers waste Telegram budgets, read [the 7 mistakes that waste your Telegram ad budget](/blog/telegram-ad-budget-mistakes).

And if you have not set up a welcome yet, start with the [Telegram welcome bot guide](/blog/telegram-welcome-bot). Tracking a leak is useful. Plugging it is better.

**Dchessking**

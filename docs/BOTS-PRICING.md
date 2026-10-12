# Castvoo Bots: plans, limits, credits and anti-sharing (10 Oct 2026)

**Short version:** keep the same 4 prices: Free $0, Starter $19, Growth $49, Scale $99. Bots fit inside the plans you already have, so no new tier is needed. Each plan gets more **active bots**, unlocks more **bot types**, and raises the **bot subscribers / leads / paid members** caps. The Sales bot takes **no percentage**: it is unlocked by plan and capped by **active paid members**. **Cas builds stay the only thing paid with credits.** Sharing is stopped mainly by tying channels, bots and payment accounts to **Telegram accounts and seats**. A simple session cap is a second line of defence.

Based on: `docs/PRICING-RECOMMENDATION.md`, `docs/PRODUCT-FACTS.md`, `server/services/billing.js`, `server/seed.js` (PLANS, FEATURE_SETS), `server/services/cas-builder.js`, `server/services/security.js`. No code was changed.

---

## 1. Facts from the code that shape this

- Plans today (`seed.js`): connections 1 / 2 / 5 / 20, bot subscribers 0 / 5k / 25k / 100k, join requests 500 / 5k / 30k / 150k, flows 1 / 3 / 15 / unlimited, steps 1 / 5 / 20 / unlimited, seats 1 / 1 / 3 / 10, `cas_builds` 1 (lifetime) / 10 / 50 / -1 (fair use 500).
- Features: Free `auto_approve, welcome_message`. Starter adds `welcome_flows, tap_to_start, broadcasts, schedule, drips, tracked_buttons, basic_stats, ai`. Growth adds `ab_welcome_2, condition_clicked, start_another_flow, audiences, start_links, flow_funnel_stats`. Scale adds `ab_welcome_4, onboarding_call`.
- Only **bot subscribers** count toward the plan (`billing.js`). Channel and group members are free. Broadcasts pause above the cap, and nothing is deleted.
- Telegram sending costs $0. The only real variable cost is **AI (Cas)**. Hosting grows slowly with incoming bot updates.
- Seats are $5/month, active devices and new-login alerts exist, and **nothing is blocked today** ("the goal is that people who share one login notice it").
- Cas credits are 20 builds for $5, paid from wallet cash, and never expire. Cas Builder taps cost nothing. Only AI text and typed instructions cost money.

## 2. Two words to keep apart (important for limits and for the UI)

| Word | What it means | Meter |
|---|---|---|
| **Telegram bot** (connection) | A BotFather token the customer pastes in. It counts toward the existing **connections** limit. | `connections` (unchanged) |
| **Bot** (in the new Bots section) | One automation that runs on a Telegram bot: a welcome bot, lead magnet, menu, sales bot and so on. **One Telegram bot can run several Bots**, each reached by its own start link (`t.me/yourbot?start=gift`), join request or command. | `max_bots` (new) |

So a Free user with one channel and one BotFather bot can run the welcome bot plus one more Bot (for example a lead magnet) **on the same Telegram bot**, with no extra connection. This keeps the connection rule from the earlier pricing work.

**Bot subscriber counting:** one person who taps Start on a Telegram bot counts as **1 subscriber for that Telegram bot**, however many Bots on it they use. The same person on 2 different Telegram bots counts as 2. This matches how the subscribers meter already works.

## 3. Plan table

| | **Free** | **Starter** | **Growth** ⭐ | **Scale** |
|---|---|---|---|---|
| Monthly / yearly | $0 | $19 / $190 | $49 / $490 | $99 / $990 |
| Telegram bots, channels, groups (connections) | 1 channel/group + its bot | 2 | 5 | 20 |
| **Active Bots** | 2 (welcome + 1) | 5 | 15 | Unlimited (fair use 100) |
| Bot types unlocked | Welcome, Join-check, Lead magnet, Menu | + Broadcast, Lead questions, Sales (lite) | + Referral, full Sales | Everything |
| **Bot subscribers** | **100** (new, was 0) | 5,000 | 25,000 | 100,000 |
| Messages per Bot (steps) | 1 per reply (menu up to 4 buttons) | 5 | 20 | Unlimited |
| **Leads collected / month** (Lead question bot) | none | 1,000 | 10,000 | 100,000 |
| Questions per lead form | none | 5 | 15 | Unlimited |
| Lead export | none | CSV (owner) | CSV + live webhook / Google Sheet* | Same as Growth + API* |
| **Referral bots** | none | none | 2 | Unlimited (fair use 20) |
| **Sales / VIP bots** | none | 1 | 5 | Unlimited (fair use 50) |
| **Active paid members** (Sales bot) | none | 50 | 1,000 | 10,000 (more: talk to us) |
| Customer payment accounts (Flutterwave) | none | 1 | 1 | 3 |
| **Sales fee to Castvoo** | n/a | **0%** | **0%** | **0%** |
| Cas builds (bots and flows share one pool) | 1 lifetime | 10 / month | 50 / month | Unlimited (fair use 500) |
| Seats (+$5 each) | 1 | 1 | 3 | 10 |
| Linked Telegram accounts | 1 | = seats | = seats | = seats |
| Logged-in devices at once, per seat | 2 | 2 | 2 | 3 |
| Branding line | Yes (first message of each Bot) | No | No | No |

\* Live webhook / Google Sheet and API export are not built yet. List them as "coming soon" or leave them off until they exist (PRODUCT-FACTS rule: only list things that really work).

### Why the same 4 prices
- Bots run at almost zero cost (Telegram is free, and only Cas costs money). The value is already covered by the existing meters (subscribers, connections). A new tier would make the pricing page harder for beginners and is not needed for margin.
- $19 / $49 / $99 matches the market (ManyChat, Metricgram, InviteMember all sit at these points). InviteMember alone charges $19 for ≤ $500 sales a month. Castvoo Growth at $49 includes 1,000 paid members **plus** all the broadcast and welcome tools, which is a strong selling line.
- **One change:** Free goes from 0 to **100 bot subscribers**. A lead magnet bot is the best free hook for media buyers, and 100 is too small to run a business on. SendPulse gives 500 free and ManyChat gives 25. Each Free Bot's first message carries the "by Castvoo.com" referral line, so Free users keep spreading the brand. Extra cost is close to $0.

## 4. What each plan gets for Bots

**Free: try it.**
- Welcome bot (as today) plus **1** extra Bot: Join-check, Lead magnet **or** Menu, on the same Telegram bot.
- 100 bot subscribers. 1 message per reply (Lead magnet: 1 gift message. Menu: up to 4 buttons, 1 answer each). No follow-ups, no broadcast.
- The first message of each Bot ends with `⚡ Free bot by Castvoo.com` (the referral link). The line can't be removed.

**Starter $19: run one funnel properly.**
- 5 active Bots. Adds **Broadcast to bot subscribers**, **Lead question bot** (up to 5 questions: name, phone, country and so on, with phone and email format checks done without AI) and the **Sales bot (lite)**: 1 sales bot, up to 50 active paid members.
- Follow-ups inside Bots (up to 5 messages), CSV export of leads (owner only, like subscribers today).
- Each Lead magnet bot comes with **its own start link** for ads. Growth's "Start links" feature (many tagged links per ad with stats) stays on Growth.

**Growth $49: grow and earn (most popular).**
- 15 active Bots, every type. Adds **Referral bot** (2): "invite N friends to unlock" a reward the customer picks (a link, file, message, or extra VIP days when paired with the Sales bot).
- Sales bot: 5 bots, 1,000 active paid members. Lead forms up to 15 questions, 10,000 leads a month.
- Conditions (clicked / didn't click), "Start another Bot", audiences and funnel stats work on Bots too.

**Scale $99: agencies and big signal rooms.**
- Bots without a set limit (fair use 100), referral and sales bots up to fair use, 10,000 active paid members, up to 3 Flutterwave accounts (for example NGN, GHS and KES businesses), 10 seats, priority support.

### Sales / VIP access bot: plan limit, not a percentage
Castvoo never touches the money. The subscriber pays through the **customer's own Flutterwave** account (the customer's keys, the customer's settlement). The bot only reads the payment result, sends the private group link, and removes the member when access runs out.

Why **0%** and plan limits instead of a fee:
1. **Trust and law.** Taking a cut means Castvoo works out and collects money based on someone else's payments. It starts to look like a payment business (bills, disputes, "you charged me 3% on a refund") and goes against the clean message "Castvoo holds nothing".
2. **African buyers dislike a percentage fee.** It feels like a tax on success, and sellers would route payments around the bot (manual transfers) to avoid it, which kills usage.
3. **The plan cap already grows with success.** "Active paid members" goes up as the seller earns more. A signal room with 300 members at $20 is $6,000 a month, which needs Growth ($49 = 0.8%). One with 3,000 members needs Scale. That works like a percentage without collecting one.
4. Billing stays simple: one wallet payment a month.

If the owner still wants a fee later, the only safe version is **1% on Starter only, charged from the wallet once a week from the sales the bot recorded, capped at $19 a month**. That nudges people to Growth. Not recommended for launch.

Sales bot rules:
- **Active paid member** = a person whose access is live right now. Expired, refunded or removed members don't count.
- At the cap: new sales pause (the buy button says "VIP is full right now"). Renewals of existing members **always** go through, and removal on expiry **always** keeps running, so a seller is never left with free riders.
- Downgrade or unpaid plan: no new buyers. Renewals and removal on expiry keep working for **30 days**, then the bot stops selling (members in the group are never kicked by Castvoo for a plan problem, only for their own expiry).
- The customer stays the merchant of record. Their Flutterwave fees, refunds and chargebacks are theirs. State this in the Terms and in the bot setup screen.

### Referral bot rules (fraud matters because rewards have value)
- A referral counts only if the invited person is **new to that Telegram bot**, is not a bot or deleted account, and (if the reward needs a channel join) **stays joined 24 hours**.
- Each person can count once per referral bot. At most 50 counted referrals per referrer per day. The owner sees a "suspicious" list (many joins at the same time that left soon after).
- Growth+ only, because of the fraud tooling and support load.

## 5. Credits: what is metered

| Item | How it's paid | Why |
|---|---|---|
| **Cas builds** (new flow **or** new Bot built with Cas Builder / Cas AI) | Plan builds first, then **Cas credits: 20 builds for $5** | The only real AI cost. **One shared pool** for flows and Bots so the rule stays simple. Editing an existing Bot by chat never counts (same as flows). |
| Cas "write it for me" inside a Bot message | Existing **AI writes** allowance (0 / 150 / 600 / 1,500) | Already metered, so nothing new is needed |
| Messages, broadcasts, menu taps, join checks, lead answers, referrals, sales | **Subscription only**, never credits | Telegram costs $0. Metering them would scare beginners and add no profit |

Do **not** meter anything else. Credits stay "AI only", which is easy to explain: "Credits pay for Cas building things for you. Everything else is in your plan."

Fair-use guard (not shown as a price): each Telegram bot may handle up to **100,000 incoming updates a day** on Starter, 500,000 on Growth and unlimited on Scale (abuse alert only, no block at first). This protects hosting against spam floods on menu bots.

Trial (7 days of Growth): Growth's Bot limits, but **Sales bot capped at 20 paid members** and **300 leads**, so nobody runs a paid VIP room for a week for free. At the end, the workspace drops to Free as today: the welcome bot and 1 Bot keep working, and the rest is paused and kept.

## 6. Anti-sharing (stop 5 people paying for 1 account)

The real risk is not 5 people logging in. It is **5 different businesses** running their channels on one $49 account. So the main limits follow **businesses** (Telegram accounts, channels, payment accounts), not just logins.

| # | Measure | Plan values | How it stops sharing | Honest teams |
|---|---|---|---|---|
| 1 | **Linked Telegram accounts = seats.** Each seat links one Telegram account (already supported for alerts). A channel or group can only be connected if a **linked** account is its creator or an admin with "add members" (checked with `getChatMember`, as Welcome Flows already do). A BotFather bot must be confirmed by a linked account pressing Start on it once. | Free 1, Starter 1, Growth 3, Scale 10 (+1 per extra seat) | A friend's channel needs a linked Telegram account. To link it, they need a seat ($5) | Each teammate links their own Telegram |
| 2 | **One payment account per business.** Sales bot Flutterwave accounts are limited per plan, and one Flutterwave account can be connected to only one Castvoo workspace. | 0 / 1 / 1 / 3 | Each seller has their own Flutterwave, so 5 sellers can't share a Growth plan | Scale covers multi-country businesses |
| 3 | **Connection swap limit.** Removing a channel or bot and adding a **different** one: limited per month (re-adding the same one is free). | Free 1, Starter 2, Growth 5, Scale 20 per month | Stops rotating many people's channels through few slots | Normal cleanup is never blocked |
| 4 | **One workspace per channel / bot token.** The same channel or BotFather token can't be live in two workspaces at once. | All plans | Stops splitting one channel across accounts to stack Free plans | none |
| 5 | **Logged-in devices per seat.** Logging in on one device too many logs out the oldest session (not a block) and sends the new-login alert. | 2 per seat (Scale 3) | The 3rd person keeps kicking the others out, which is annoying enough to buy a seat | Phone + laptop is fine. The setup helper uses their own login |
| 6 | **Travel check.** Active sessions in 2 countries more than 1,500 km apart within 2 hours → the next login needs an email code. | All plans | Lagos + Manila on one seat gets a code prompt every time | A traveller enters the code once |
| 7 | **Free plan stacking.** Free bots need a linked Telegram account, and one Telegram account can link to only one Free workspace. | Free | Stops 10 Free accounts for one person | none |

Tone in the product: never call people cheats. Messages say: "This channel is managed by a Telegram account that isn't on your team. Add a seat ($5) so they can log in themselves." Seats and the free setup helper are the friendly way out.

## 7. Limits behaviour (same soft rules as today)

| Limit hit | What happens |
|---|---|
| Active Bots | Can't switch on another. On downgrade the extras pause (kept), and the owner picks which stay on (oldest by default) |
| Bot subscribers | 10% grace. New subscribers are still saved and the Bots still answer them. Broadcasts pause (`limit_subscribers`). On Scale the 402 offers a subscriber pack (+50,000 for $29/month, up to 8 = 500,000); above that, "Talk to us" (custom plan) |
| Leads / month | 10% grace, then the form still says thank you, but answers beyond the cap are hidden until the next month or an upgrade (kept, never deleted) |
| Paid members | New sales pause. Renewals and removal on expiry always run (section 4) |
| Referral / sales bot count | Can't add more. Existing ones keep running |
| Cas builds | Build by hand (free), buy 20 for $5, or upgrade |

Upsell moments: leads at 80%, "VIP is full" (show what Growth or Scale allows), trying to add a 3rd Bot on Free or a Referral bot on Starter, and a "This channel needs a seat" prompt.

### Subscriber packs (Scale, approved Oct 2026)

- Pack = **+50,000 bot subscribers for $29/month** (yearly: 12 × $29), **Scale only**, quantity **1 to 8** self-serve (500,000 total). Starter and Growth are told to upgrade to Scale first.
- Charged from the wallet exactly like extra seats: prorated for the rest of the current period on purchase, then renewed with the plan in the same payment. Fewer packs start at the next renewal and never delete data. Wallet short at renewal: the workspace moves to Free like seats (packs end). Commission and VooSquare spend events: the same as seats (one commission per payment, 5 to 15%).
- Limit math: Scale subscribers = 100,000 + 50,000 × packs, and `bots.max_bot_subscribers` likewise. Admin can set packs or a **custom subscriber limit** per workspace (Admin → Users → workspace) for custom deals.
- Settings: `billing.sub_pack_size` 50000, `billing.sub_pack_price_cents` 2900 (0 = not sold), `billing.sub_pack_max` 8 (Admin → Settings → Billing). Migration `029_subscriber_packs.sql` adds `workspaces.subscriber_packs`, `pending_subscriber_packs`, `custom_subscriber_limit`.
- Above 500,000 or for any custom deal: **"Need more than 500,000? Talk to us"** opens the support chat with a prefilled message, plus an email link. Pricing card line under Scale: "Bigger audience? Add 50,000 subscribers for $29/month, or talk to us for a custom plan."
- Margin (rough estimate, same basis as section 8): 50,000 extra bot subscribers add about as much hosting as the Scale estimate below (a few dollars a month at full broadcast use), so $29 a pack keeps a high margin while costing far less than a second Scale plan.

## 8. Cost and margin check

- Extra hosting from Bots (webhooks, menu taps, lead storage): about **+$0.02 Free, +$0.25 Starter, +$0.75 Growth, +$2.00 Scale** per workspace per month. This is a rough estimate on top of the Railway figures in the pricing recommendation.
- Cas builds for Bots come from the same pool, so AI cost doesn't change. Packs ($5 for 20) stay above cost while the per-build AI spend stays under $0.20 (the Cas Builder daily cap protects the rest).
- Margins from `PRICING-RECOMMENDATION.md` §9 move by about 1 to 2 points. Every plan is still profitable at a 50% commission.
- 1,000 Free users with Bots: about $130 a month in total, covered by 7 Starter payments.

## 9. Machine-readable limits (`-1` = unlimited, `fair_use` = soft cap for abuse alerts)

```json
{
  "bot_types_all": ["welcome", "join_check", "lead_magnet", "menu", "broadcast", "lead_questions", "referral", "sales"],
  "credits": {
    "metered": ["cas_builds"],
    "cas_build_counts": "new flow or new bot made with Cas Builder / Cas AI; edits never count",
    "pack": { "builds": 20, "price_cents": 500, "expires": false, "pay_with": "wallet_cash" }
  },
  "trial": { "plan": "growth", "days": 7, "max_paid_members": 20, "lead_answers": 300 },
  "plans": {
    "free": {
      "price_month_cents": 0,
      "max_bots": 2,
      "bot_types": ["welcome", "join_check", "lead_magnet", "menu"],
      "max_bot_subscribers": 100,
      "bot_steps": 1,
      "menu_buttons": 4,
      "lead_answers_per_month": 0,
      "lead_questions_per_form": 0,
      "lead_export": "none",
      "referral_bots": 0,
      "sales_bot": false,
      "sales_bots": 0,
      "max_active_paid_members": 0,
      "payment_accounts": 0,
      "sales_fee_pct": 0,
      "cas_builds": 1,
      "cas_builds_period": "lifetime",
      "connections": 1,
      "seats": 1,
      "linked_telegram_accounts": 1,
      "concurrent_sessions_per_seat": 2,
      "connection_swaps_per_month": 1,
      "branding": true,
      "updates_per_bot_per_day_fair_use": 20000
    },
    "starter": {
      "price_month_cents": 1900,
      "max_bots": 5,
      "bot_types": ["welcome", "join_check", "lead_magnet", "menu", "broadcast", "lead_questions", "sales"],
      "max_bot_subscribers": 5000,
      "bot_steps": 5,
      "menu_buttons": 8,
      "lead_answers_per_month": 1000,
      "lead_questions_per_form": 5,
      "lead_export": "csv",
      "referral_bots": 0,
      "sales_bot": true,
      "sales_bots": 1,
      "max_active_paid_members": 50,
      "payment_accounts": 1,
      "sales_fee_pct": 0,
      "cas_builds": 10,
      "cas_builds_period": "month",
      "connections": 2,
      "seats": 1,
      "linked_telegram_accounts": "seats",
      "concurrent_sessions_per_seat": 2,
      "connection_swaps_per_month": 2,
      "branding": false,
      "updates_per_bot_per_day_fair_use": 100000
    },
    "growth": {
      "price_month_cents": 4900,
      "max_bots": 15,
      "bot_types": ["welcome", "join_check", "lead_magnet", "menu", "broadcast", "lead_questions", "referral", "sales"],
      "max_bot_subscribers": 25000,
      "bot_steps": 20,
      "menu_buttons": 12,
      "lead_answers_per_month": 10000,
      "lead_questions_per_form": 15,
      "lead_export": "csv_webhook",
      "referral_bots": 2,
      "sales_bot": true,
      "sales_bots": 5,
      "max_active_paid_members": 1000,
      "payment_accounts": 1,
      "sales_fee_pct": 0,
      "cas_builds": 50,
      "cas_builds_period": "month",
      "connections": 5,
      "seats": 3,
      "linked_telegram_accounts": "seats",
      "concurrent_sessions_per_seat": 2,
      "connection_swaps_per_month": 5,
      "branding": false,
      "updates_per_bot_per_day_fair_use": 500000
    },
    "scale": {
      "price_month_cents": 9900,
      "max_bots": -1,
      "max_bots_fair_use": 100,
      "bot_types": ["welcome", "join_check", "lead_magnet", "menu", "broadcast", "lead_questions", "referral", "sales"],
      "max_bot_subscribers": 100000,
      "bot_steps": -1,
      "menu_buttons": -1,
      "lead_answers_per_month": 100000,
      "lead_questions_per_form": -1,
      "lead_export": "csv_webhook_api",
      "referral_bots": -1,
      "referral_bots_fair_use": 20,
      "sales_bot": true,
      "sales_bots": -1,
      "sales_bots_fair_use": 50,
      "max_active_paid_members": 10000,
      "payment_accounts": 3,
      "sales_fee_pct": 0,
      "cas_builds": -1,
      "cas_builds_fair_use": 500,
      "cas_builds_period": "month",
      "connections": 20,
      "seats": 10,
      "linked_telegram_accounts": "seats",
      "concurrent_sessions_per_seat": 3,
      "connection_swaps_per_month": 20,
      "branding": false,
      "updates_per_bot_per_day_fair_use": -1
    }
  },
  "rules": {
    "bot_subscriber_unit": "per person per connected Telegram bot",
    "limit_grace_pct": 10,
    "on_session_limit": "log_out_oldest_and_alert",
    "travel_check": { "km": 1500, "hours": 2, "action": "email_code" },
    "one_workspace_per_channel_or_token": true,
    "one_workspace_per_payment_account": true,
    "free_one_workspace_per_telegram_account": true,
    "referral_count_rules": { "new_to_bot": true, "stay_joined_hours": 24, "max_per_referrer_per_day": 50 },
    "sales_on_cap": "pause_new_sales_keep_renewals_and_expiry_removal",
    "sales_on_downgrade_grace_days": 30,
    "castvoo_holds_money": false
  }
}
```

## 10. Decisions for the owner (please confirm before building)
1. Free gets **100 bot subscribers** and 1 extra Bot (recommended), or stays at 0 as today.
2. Sales bot on **Starter (lite, 50 members)** (recommended, because signal sellers start small), or Growth+ only.
3. **0% sales fee** (recommended), or the fallback of 1% on Starter only, capped at $19.
4. Linked-Telegram-account check for channels (the strongest anti-sharing step): turn it on at launch, or after one month of warnings only.
5. Webhook / Google Sheet lead export: build it now, or leave it off the pricing page until it exists.

## 11. Plain-English summary for Ejiro
1. Keep the same prices: Free, $19, $49 and $99. Bots fit inside them.
2. Bigger plans get more bots, more bot types, and more people they can hold.
3. Free can try 1 bot with 100 people. Starter gets lead forms and a small VIP sales bot. Growth adds referral bots and bigger VIP rooms.
4. We take no cut of sales. The money goes straight to the customer, and bigger VIP rooms just need a bigger plan.
5. Only Cas (the AI builder) uses credits: 20 builds for $5. Everything else is in the plan.
6. To stop account sharing, every channel and payment account must belong to someone on the team, and each seat can be logged in on only 2 devices at once.

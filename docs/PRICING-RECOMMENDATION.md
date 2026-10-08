# Castvoo pricing recommendation (8 Oct 2026)

**Short version:** keep $19 / $49 / $99. Add the Free plan with the owner's limits. Make **join requests per month** the main meter for Welcome Flows. Cut the AI write allowances (the current ones lose money if people use them all). Allow only one commission per payment. Show fixed, rounded Naira and other local prices.

Based on: `docs/PRODUCT-FACTS.md`, `server/seed.js`, `server/services/billing.js`, `llm.js`, `referrals.js`, `bot-updates.js`, `README.md`. No code was changed.

## 1. What the code does today (facts that affect pricing)
- Plans: Starter $19 (1 connection, 5k subs, 300 AI, 1 seat), Growth $49 (5, 25k, 2,000, 3), Scale $99 (20, 100k, 5,000, 10). Yearly = 10x monthly.
- Trial: 7 days of Growth, 100 AI writes, no card. Referral 10/20/30% of the **cash** part of each plan payment (bonus credit pays no commission), settles after 30 days.
- The join-request welcome runs through **the customer's own connected bot** (`onJoinRequest` uses `conn` = the bot). A channel can also be its own connection. So "1 connection" on Starter cannot run bot + channel. Fix this below.
- People who send a join request are saved as `status='joinreq'`, so they do **not** count as bot subscribers. Join requests need their own meter.
- AI: the seed default is Claude Haiku 4.5. The README default on OpenRouter is Sonnet 4.5, about 1 to 2 cents per write. The model below assumes Sonnet, the expensive case.

## 2. Competitor prices (checked 8 Oct 2026)
| Tool | What it is | Price | Source |
|---|---|---|---|
| ManyChat (has a Telegram channel) | Chat automation | Free (25 active contacts) · Essential $17 (250) · Pro $39 (2,500, AI included) · Business $99 (7,500) · Advanced $199 (25,000). Yearly about 15 to 30% off | [featurebase.app](https://www.featurebase.app/blog/manychat-pricing) |
| SendPulse Chatbots | Multi-messenger bots, Telegram join trigger | Free up to 500 subscribers, 3 bots, 10k msgs/mo · Pro from $12/mo ($9.60 yearly). $507/yr at 120k subs up to $3,215/yr at 1M | [sendpulse.com](https://sendpulse.com/de/prices/messengers), [trigger docs](https://sendpulse.com/en/knowledge-base/chatbot/telegram/telegram-triggers) |
| TG Tracker | Meta→Telegram tracking, smart welcome bots, auto-approve, flows | Pay as you go: **$0.03 to $0.09 per unique tracked user**, no monthly fee. Custom plan on request | [tgtracker.io](https://tgtracker.io) |
| Metricgram | Telegram group tools: welcomes, auto-replies, AI | Basic €19.95 (1 group) · Pro €49.95 (3) · Elite €99.95 (unlimited). Yearly = 10x monthly | [metricgram.com/pricing](https://metricgram.com/pricing) |
| InviteMember | Paid Telegram memberships | $19 (≤$500 sales/mo) · $39 · $79 · $149 · $269 · $469 · $899 · $1,499 | [invitemember.com/pricing](https://www.invitemember.com/pricing) |
| Chatfuel | AI chatbots | No free plan, 7-day trial. Fuely Super $39 (150 contacts) to $279 (5,000). Fuely Max $59+ | [setsmart.io](https://setsmart.io/blog/chatfuel-pricing) |
| BotHelp | Bot builder with Telegram join auto-reply | PRO from 1,599 ₽/mo (about $20), priced by subscriber count. 14-day trial up to 3k | [bothelp.io](https://bothelp.io/ru/pricing), [auto-reply](https://help.bothelp.io/en/?p=3966) |
| Combot | Group moderation and analytics | Free under 200 members. Paid one-time licence about $3 to $42 (low-confidence listing) | [metricgram](https://www.metricgram.com/alternatives/combot), [alternativeto](https://alternativeto.net/software/combot/about) |
| Open-source join bots | Auto-approve only | $0, self-hosted, no flows or stats | [ChannelActionsBot](https://github.com/Sam78699/ChannelActionsBot) |

What the competitor prices show:
1. $19/$49/$99 is the normal price ladder in this market (Metricgram, ManyChat, InviteMember). Customers will not see it as expensive.
2. TG Tracker, the closest direct rival for media buyers, charges 3 to 9 cents per user. A Starter customer with 5,000 joins would pay $150 to $450 there. On Castvoo they pay $19 (0.4 cents per join). That gap is the selling line.
3. ManyChat and SendPulse both give a free plan. A free tier is expected in this market.

## 3. Cost inputs
| Item | Number used | Basis |
|---|---|---|
| Telegram sending | $0 | Bot API is free. About 30 msg/s per bot. Telegram's paid broadcast option is not used. |
| AI write (Sonnet 4.5) | **1.5 cents** each. Expected use is 50% of the allowance | $3/M in, $15/M out with prompt caching, per the README. Haiku would be about 0.5 cents. |
| AI support chat | **3 cents** per conversation (worst case) | Free 2/mo, Starter 5, Growth 10, Scale 20. Fair-use cap: Free 5/mo, paid 100/mo |
| Hosting (Railway) | Free $0.05 · Starter $0.50 · Growth $1.50 · Scale $4.00 per workspace per month | $10/GB RAM, $20/vCPU, $0.15/GB volume, $0.05/GB egress ([Railway](https://docs.railway.com/pricing/plans)). Base stack (app + worker + Postgres 2 GB + 50 GB volume + Resend) is about $120/mo, shared by load (join requests, media, sends) |
| Payment fees + FX | **4.5% of price** (blended, conservative) | Paystack NG 1.5% + ₦100 (waived under ₦2,500, capped at ₦2,000), intl 3.9%, GH 1.95%, ZA 2.9% + R1, KE 2.9% ([Paystack](https://support2.paystack.com/hc/en-us/articles/360009881920-What-are-Paystack-s-transaction-charges)). Flutterwave NG 2.0%, intl 4.8%, plus 7.5% VAT on fees ([Flutterwave](https://flutterwave.com/ng/pricing)). Crypto about 0.5%. The likely mix comes to about 2.5%; the rest covers VAT, FX drift and chargebacks |
| Commission | 0% / 25% / 50% of price | Castvoo referral 10 to 30%. VooSquare RevShare 20 to 35% typical, 50% at high volume |

## 4. Final plans
| | **Free** | **Starter** | **Growth** ⭐ | **Scale** |
|---|---|---|---|---|
| Plan code | `free` | `starter` | `growth` | `scale` |
| Monthly USD | $0 | **$19** | **$49** | **$99** |
| Yearly USD (10 months) | $0 | $190 | $490 | $990 |
| Connections (bots, channels, groups) | 1 channel/group + its welcome bot | 2 | 5 | 20 |
| Bot subscribers | 0 (no tap-to-start capture) | 5,000 | 25,000 | 100,000 |
| Join requests / month | 500 | 5,000 | 30,000 | 150,000 |
| Welcome Flows | 1 (welcome only) | 3 | 15 | Unlimited |
| Steps per flow | 1 | 5 | 20 | Unlimited |
| AI writes / month | 0 | 150 | 600 | 1,500 |
| Team seats | 1 | 1 | 3 | 10 |
| Branding line | **Yes** | No | No | No |
| Support | Help centre + AI chat (5 conv/mo) | AI chat 24/7 + human email within 24h | AI chat 24/7 + human chat, same day | AI chat 24/7 + **priority** human chat within 4h (8am to 10pm WAT) + onboarding call |

**Connection rule:** the bot that only welcomes a connected channel does not count as a separate connection. That is how Free gets "1 channel + its bot". Without this rule, Starter needs 2 connections just to run the core funnel.

Features by plan. Each plan includes everything in the plan before it.
- **Free:** auto-approve join requests. One welcome DM (text or 1 photo, up to 3 plain link buttons, {name}). A meter showing "approved this month: X / 500". Nothing else.
- **Starter:** Welcome Flows builder (timed steps, delays, buttons). Tap-to-start capture into the bot. Unlimited broadcasts. Schedule and 9am send. Auto follow-ups. Tracked buttons. Basic stats (delivered, clicks, blocked). Cas AI. Branding removed.
- **Growth:** A/B welcome (2 variants). "Only if they didn't click" and "only if they clicked" conditions. Audiences. Start links (ad attribution). Per-flow funnel stats. 3 seats.
- **Scale:** A/B with up to 4 variants. Tag-based branching. CSV export. 10 seats. Priority support. Above Scale: "Talk to us" custom quote (no 4th public tier). The $299 Inner Circle stays separate.

Changes from today: Starter goes from 1 to 2 connections. AI writes go from 300/2,000/5,000 to 150/600/1,500. The join-request meter and flow limits are new. Grandfather anyone who already pays.

## 5. Free plan exact limits
- 1 channel **or** group, plus the customer's own BotFather bot as admin. Do **not** use the shared @CastvooBot: one spammer could get it banned for every Free user.
- 500 join requests per calendar month, auto-approved. 1 welcome message, 1 step. No follow-ups, broadcasts, tap-to-start capture, audiences, start links, stats, AI, or extra seats.
- Every welcome ends with: `⚡ Free welcome bot by Castvoo.com`, linking to `castvoo.com/r/<their code>`. Free users earn referral commission from it, so the viral loop pays them too. The line cannot be edited or removed on Free.
- Cost to Zedapex: about $0.11 per Free workspace per month. 1,000 Free users cost about $110/mo, which 6 Starter payments cover.

## 6. Trial
- Keep **7 days of Growth, no card**. Cut AI writes to **50** and cap join requests at **3,000**. This stops people running a full week of paid traffic on the trial for free.
- Day 5 email and dashboard banner: "Your flows welcomed N people. Keep them running for $19." Day 7, if unpaid: the workspace **drops to Free**, not paused. The first active join-request flow's step 1 becomes the Free welcome, with the branding line. Everything else is paused and kept.
- Win-back: the existing `COMEBACK20` coupon (20% off the first month), sent on day 8 and day 14.

## 7. At the limit: soft pause, never delete
| Limit | What happens |
|---|---|
| Join requests | 10% grace. Then **auto-approve keeps working**, because blocking a customer's channel growth would damage trust. Welcome and flow messages pause until the next month or an upgrade. The dashboard counts "N people joined without your welcome". |
| Bot subscribers | New subscribers are still saved. Broadcasts pause (current `limit_subscribers` behaviour). Follow-ups already running keep going for 7 days of grace. |
| AI writes | Cas pauses until refill. Never an extra charge (current rule). |
| Connections / seats / flows / steps | You can't add more. Existing ones keep running. On downgrade, the extras become **paused (read-only)** and you choose which stay active. |
| Plan unpaid or trial ended | Drops to Free (above). Paused data is kept while the account is active (Free bot running or a login in the last 90 days). The existing 60-day deletion applies only to inactive accounts, after 2 warning emails. |

## 8. Upsell triggers to show in the dashboard
1. Join requests at 80% and 100% (show the date they will run out at the current pace).
2. Free: a count of "people who joined but got no follow-up this month", plus a preview of a 3-step flow with "Unlock for $19".
3. On Free, trying to add step 2, a broadcast, or tap-to-start → upgrade sheet. Same for the A/B or "didn't click" toggle on Starter.
4. Bot subscribers at 80%. AI writes at 80% (show the refill date and the next plan's number).
5. Adding a connection or seat over the limit.
6. After the 2nd monthly payment: "Switch to yearly, save 2 months ($98 on Growth)".
7. A low wallet before renewal: offer a one-tap top-up of exactly 1 month in local currency.
8. Free branding: "Remove 'by Castvoo' from your welcome. Starter $19."

## 9. Margin per plan (monthly price, AI at Sonnet 1.5 cents, expected 50% use)
Costs = AI + support AI + hosting + 4.5% fees + commission. Profit is per workspace per month.

| Plan | AI (exp / full) | Support | Hosting | Fees | **0% comm.** | **25% comm.** | **50% comm.** | 25% comm. with full AI use |
|---|---|---|---|---|---|---|---|---|
| Free | $0 | $0.06 | $0.05 | $0 | −$0.11 | −$0.11 | −$0.11 | n/a |
| Starter $19 | $1.13 / $2.25 | $0.15 | $0.50 | $0.86 | $16.37 (**86%**) | $11.62 (**61%**) | $6.87 (36%) | $10.50 (55%) |
| Growth $49 | $4.50 / $9.00 | $0.30 | $1.50 | $2.21 | $40.49 (**83%**) | $28.24 (**58%**) | $15.99 (33%) | $23.74 (48%) |
| Scale $99 | $11.25 / $22.50 | $0.60 | $4.00 | $4.46 | $78.70 (**79%**) | $53.95 (**54%**) | $29.20 (29%) | $42.70 (43%) |

Yearly (price ÷ 12, 25% commission): Starter 59%, Growth 55%, Scale 51%. Every plan stays **profitable at 50% commission**.

**About the 70% target.** A 25% commission plus about 4.5% fees already takes 29.5% of every referred payment. So 70% after commission is only possible if AI and hosting cost close to zero. Two ways to read the target:
- **Gross margin** (AI, hosting, support and fees; commission counted as a marketing cost, the normal SaaS convention): **79 to 86%. Target met.**
- **Blended across all customers:** if 40% of revenue comes in through referrals or affiliates at an average 25%, blended commission is 10%. Blended margin is then about **69 to 76%. Target met on Starter and Growth, about 69% on Scale.**
- With the old AI allowances, Growth used in full would cost $30 of AI on a $49 plan, which is negative after a 50% commission. That is why the allowances were cut.

Guardrails that keep the 50% case safe:
- **One commission per payment.** Castvoo referral **or** VooSquare affiliate, never both. Use the first attribution. Hard cap 50%.
- Pay commission on **cash minus the processor fee**, not on the gross price. Bonus credit already pays no commission.
- Allow 50% only for affiliates with 50 or more active paying customers, and on monthly plans only. Cap yearly payments at 35%.
- Route rewrites and translations to Haiku (about 0.5 cents). Use Sonnet only for writing sequences. This cuts AI cost by about 40%.
- Top-up bonus at $1,000 → +$100 is a 10% discount. Lower it to +$60 (6%). Keep $200 → +$10 and $500 → +$40.

## 10. Local price psychology (shown as fixed, rounded amounts; the wallet stays in USD)
| | Starter | Growth | Scale | Yearly (Starter/Growth/Scale) |
|---|---|---|---|---|
| 🇳🇬 NGN (rate 1,550) | ₦29,500 | ₦75,000 | ₦150,000 | ₦295k / ₦750k / ₦1.5m |
| 🇰🇪 KES (129) | KSh 2,450 | KSh 6,300 | KSh 12,700 | ×10 |
| 🇬🇭 GHS (12.5) | GH₵240 | GH₵615 | GH₵1,240 | ×10 |
| 🇿🇦 ZAR (18) | R349 | R899 | R1,799 | ×10 |
| 🇨🇲 XAF (570) | 10,900 F | 27,900 F | 56,500 F | ×10 |

- Show the local price first ("₦29,500/month · about $19"). Offer a top-up button for exactly 1 month or 1 year.
- Review the rates monthly. Change the local list only when FX moves more than 5%, so prices don't change every week.
- Naira rounding to ₦75k and ₦150k gives a 1 to 2% discount, which is fine.
- Message for Africa: "Less than one day of ad spend." For example, $19 is less than ₦30k, about what one day of Meta ads costs.

## 11. JSON for developers (cents; `-1` = unlimited)
```json
{
  "trial": { "days": 7, "plan": "growth", "ai_writes": 50, "join_requests": 3000, "on_end": "free" },
  "limit_grace_pct": 10,
  "plans": [
    { "code": "free", "name": "Free", "price_month_cents": 0, "price_year_cents": 0, "connections": 1, "subscribers": 0,
      "join_requests": 500, "flows": 1, "flow_steps": 1, "ai_writes": 0, "seats": 1, "branding": true, "support": "ai_basic",
      "features": ["auto_approve", "welcome_message"] },
    { "code": "starter", "name": "Starter", "price_month_cents": 1900, "price_year_cents": 19000, "connections": 2, "subscribers": 5000,
      "join_requests": 5000, "flows": 3, "flow_steps": 5, "ai_writes": 150, "seats": 1, "branding": false, "support": "ai_email_24h",
      "features": ["auto_approve", "welcome_flows", "tap_to_start", "broadcasts", "schedule", "drips", "tracked_buttons", "basic_stats", "ai"] },
    { "code": "growth", "name": "Growth", "popular": true, "price_month_cents": 4900, "price_year_cents": 49000, "connections": 5, "subscribers": 25000,
      "join_requests": 30000, "flows": 15, "flow_steps": 20, "ai_writes": 600, "seats": 3, "branding": false, "support": "ai_chat_same_day",
      "features": ["...starter", "ab_welcome_2", "condition_clicked", "audiences", "start_links", "flow_funnel_stats"] },
    { "code": "scale", "name": "Scale", "price_month_cents": 9900, "price_year_cents": 99000, "connections": 20, "subscribers": 100000,
      "join_requests": 150000, "flows": -1, "flow_steps": -1, "ai_writes": 1500, "seats": 10, "branding": false, "support": "priority_4h",
      "features": ["...growth", "ab_welcome_4", "tag_branching", "csv_export", "onboarding_call"] }
  ],
  "commission": { "one_per_payment": true, "max_pct": 50, "base": "cash_minus_processor_fee", "yearly_max_pct": 35 },
  "topup_bonus": [ [20000, 1000], [50000, 4000], [100000, 6000] ]
}
```

## 12. Open decisions for the owner (please discuss before building)
1. The connection rule: a welcome bot counts as free next to its channel, **or** Starter gets 2 connections (both are proposed here).
2. Should Free keep auto-approving above 500 (proposed: yes), or hold requests pending?
3. One commission per payment, and commission paid on net-of-fee cash: these need a change in `billing.payCommission` and in the VooSquare hand-off.

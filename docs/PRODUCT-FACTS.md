# Castvoo product facts (single source of truth)

Every email, policy, page and AI prompt must agree with this file. Numbers here are the
defaults seeded into the database; the owner can change them later in the admin panel.

## Company
- Product: Castvoo (castvoo.com), a Telegram welcome, broadcast and auto follow-up tool.
- Operated by: Zedapex, Lagos, Nigeria. (Admin setting `company_name`, `company_address`.)
- Support email: support@castvoo.com. Privacy email: privacy@castvoo.com. Billing: billing@castvoo.com.
- Part of the Zedapex family of tools (Joinvoo, Replyvoo, Castvoo). Shared account hub: VooSquare.
- Castvoo is independent and not affiliated with, endorsed by or sponsored by Telegram.
- Governing law: Federal Republic of Nigeria; courts of Lagos State. Data law: Nigeria Data Protection Act 2023 (NDPA); GDPR rights honoured for EU/UK users.

## What Castvoo does (only things that really work)
- Connect a Telegram bot (paste BotFather token), a channel or a group (one tap: add @CastvooBot as admin).
- Personal messages: {name} becomes each bot subscriber's Telegram first name ("Hi {name}" → "Hi Tunde"); "there" when unknown or in channel/group posts; custom word with {name|friend}. Names are cut to 20 characters.
- Send a message now, schedule it, or send at the next 9am in the workspace time zone (set in Settings). Castvoo does not detect each subscriber's own time zone.
- Text up to 4,096 characters; photo or video caption up to 1,024 characters. Photos up to 10 MB (JPG, PNG, GIF, WEBP), videos up to 50 MB (MP4, MOV).
- Buttons with tracked links: Castvoo knows which subscriber clicked (bots) or how many clicks (channels/groups).
- Audiences (segments) apply to bot subscribers only. A channel or group post reaches everyone in it.
- Auto follow-ups (drips): triggered by bot start, a start link tag, or a tag. (Join requests are handled by Welcome Flows.)
- Welcome Flows (dashboard → Welcome Flows): when someone asks to join a channel or group, the customer's own connected bot welcomes them, lets them in, and can follow up later.
  - Needs: the channel or group connected to Castvoo, its invite link set to "Approve new members" (join requests), and the customer's own bot as an admin there with the "Add members" (invite users) right. Castvoo checks this (getChatMember) before a flow goes live and says how to fix it. The shared @CastvooBot never sends welcomes.
  - A flow is a stack of steps: messages (text with {name}, a photo or video, up to 6 link buttons, up to 2 side by side, tracked like other buttons) and waits ("Wait 3 hours"). Steps can be added, moved (drag, or up/down), copied and deleted. The first step is always a message.
  - Ways to let people in: after the welcome is sent (default; if Telegram refuses the welcome they wait in the Requests list), straight away (even if the welcome fails), when they tap a "Tap to join" button and press Start in the bot, or by hand (Requests list, approve or decline many at once).
  - "Tap to start" button: opens the bot (t.me/<bot>?start=<code>); pressing Start makes the person a bot subscriber, so later steps can reach them.
  - Click conditions (Growth and up): send a later message only to people who clicked, or did not click, a button in the last earlier message that has buttons.
  - A/B welcome (Growth: 2 versions, Scale: up to 4): people are split evenly between versions; stats show deliveries and clicks per version.
  - Optional invite link per flow (the bot can make one): people who ask to join through it get that flow; everyone else gets the channel's main flow.
  - Many flows can be made (plan limit); one flow can be live per channel (and per invite link), the others are drafts.
  - Stats: Starter shows per-step deliveries and clicks; Growth and up show the funnel (asked → welcomed → tapped Start → let in → clicked) and A/B results. Free has no stats, only the join-request meter.
  - Templates: "Simple welcome + let them in", "Welcome + VIP link button", "Tap to join (filters bots)", "Welcome + 3-day follow-up", "Free gift / lead magnet". Templates start as drafts.
  - The same join request arriving twice is handled once.
- Telegram rules for join requests (explained in the dashboard):
  - After someone asks to join, Telegram lets the bot message them for 5 minutes, until the request is handled. So the welcome is always sent first, at once, before they are let in.
  - Bots cannot message people who never pressed Start in the bot. Later steps only reach people who tapped Start; they wait for up to 7 days for that, then stop.
  - A request stays open until a bot or admin approves or declines it (or the person cancels it).
- Start links: t.me/<bot>?start=<tag> to see which ad or post brought each subscriber.
- "Stop these messages" button on bot broadcasts (on by default); /stop also works. People who block the bot are marked blocked automatically and never messaged again (they stay in the list as blocked).
- Edit, pin and delete sent messages; Telegram only lets bots delete messages less than 48 hours old.
- Sending speed: about 25 messages per second per bot (roughly 7 minutes per 10,000 people).
- Castvoo cannot see who read a message. No read receipts. Views and reactions on channel posts are visible inside Telegram only.
- Cas, the AI assistant: writes and rewrites messages, translates, writes follow-up sequences, answers questions about your workspace. It learns your business from the "Train Cas" page.
- Support chat inside the dashboard, answered 24/7 by AI support agents (named personas, first names only) with the human team as back-up. The agents check the customer's own account with safe, read-mostly tools, can ask Paystack, Flutterwave or Gatevoo again whether a payment went through (credited only when the provider confirms), and can re-point a bot's webhook (workspace owners only, as in the dashboard). They can also read the customer's referral earnings and tier, referral withdrawals (status, end of the address and transaction id) and the coupons and top-up bonuses on the account, read-only. One conversation per person per workspace: the agents only ever check the workspace the customer writes from, and only while they are still a member of it. They never approve, credit, refund or discount anything, and hand over to a person for refunds, chargebacks, manual payment checks, legal, data deletion, ownership, account closure, upset customers or when asked. If asked, they say they are AI assistants.
- "24/7 customer support" means exactly this: AI support agents answer in the dashboard chat (Help) at any hour, usually within seconds, and the human team is the back-up (they reply when an agent hands over, within the reply time for the plan: Free within 24 hours; paid plans within one business day; Scale (priority) within 4 business hours. The team works 8am to 10pm West Africa Time every day; outside those hours the business-hours promises count from 8am WAT). Use the label "24/7 customer support · replies in seconds" only together with that. Email support@castvoo.com is answered by people.
- AI resolution rate (Admin → Support AI): conversations the AI solved with no handoff and no teammate reply, out of all conversations the AI took part in, for the last 7 and 30 days, against the goal (default 99%).
- Free plan workspaces get a monthly number of AI support conversations (Admin → Support AI, default 5), then the team and email; paid plans: unlimited, fair use.
- Images in the support chat: customers and staff can send up to 3 images per message (JPG, PNG or WEBP, up to 10 MB each). The AI agents can read them (for example a payment receipt or an error screenshot). Text inside an image is never treated as an instruction, and a screenshot is never proof that money moved: only the payment provider or the finance team confirms payments. For a pending manual top-up with no proof yet, the AI saves the customer's screenshot as that payment's proof and hands it to Finance. Images are private: only the customer of that conversation and the support team can open them. Photo metadata (GPS, camera details) is removed when an image is uploaded. The website chat (logged out) takes text only.
- Agents have illustrated faces (8 built-in faces) or a photo the team uploads.
- "Powered by Replyvoo" appears under the support chat and the website chat (can be switched off in Admin → Support AI). Replyvoo is a separate Zedapex AI support product; it is a badge only and receives no data.
- Website chat on castvoo.com: visitors can ask product and pricing questions (knowledge only, no account access, no images). Can be switched off. Limits (shared by every server): 40 answers per visitor and per IP address a day, 500 a day in total; after 60% of the daily total only visitors who opened the site at least 5 minutes earlier (security cookie cv_vis) are answered.
- Tracked links from new accounts (under 7 days old, never paid) that go outside Telegram and Castvoo show a short "You are leaving Castvoo" page first. The team can switch any tracked link off.

## Plans (USD per month; yearly = pay 10 months, get 12)
| Plan | Price | Connections (bots, channels, groups) | Bot subscribers | Join requests / month | Welcome Flows | Steps per flow | AI writes per month | Team seats |
|---|---|---|---|---|---|---|---|---|
| Free | $0 | 1 | 0 | 500 | 1 | 1 | 0 | 1 |
| Starter | $19 | 2 | 5,000 | 5,000 | 3 | 5 | 150 | 1 |
| Growth | $49 | 5 | 25,000 | 30,000 | 15 | 20 | 600 | 3 |
| Scale | $99 | 20 | 100,000 | 150,000 | Unlimited | Unlimited | 1,500 | 10 |

Yearly: Starter $190, Growth $490, Scale $990. Each plan includes everything in the plan before it.
- **Free:** 1 channel or group plus its own welcome bot (the bot does not count as a second connection on Free). Auto-approve join requests. One welcome message (text or 1 photo, up to 3 link buttons, {name}). A meter: "312 / 500 free joins this month". No follow-ups, broadcasts, tap-to-start, stats, audiences, start links, AI or extra seats. Every Free welcome ends with the line "⚡ Free welcome bot by Castvoo.com", linking to castvoo.com/r/<the owner's referral code>; it cannot be removed on Free (the owner earns referral commission from it). No card needed.
- **Starter:** Welcome Flows builder (steps, waits, buttons, manual approval, invite links), "Tap to start" capture, unlimited broadcasts, scheduling and 9am sending, auto follow-ups, tracked buttons, basic stats, Cas. No Castvoo line.
- **Growth:** A/B welcome (2 versions), "only if they clicked / didn't click" conditions, audiences, start links, flow funnel stats, 3 seats.
- **Scale:** A/B with up to 4 versions, 10 seats, priority support (a person replies within 4 business hours, 8am to 10pm WAT, when the AI hands over). Above Scale: talk to us.
- CSV export of bot subscribers (Subscribers → Export) is on every plan, for the workspace owner. There is no tag-based branching.
- An "AI write" = one time Cas writes, rewrites or translates a message, or answers one question. A follow-up sequence counts one write per message in it.
- When AI writes run out, Cas pauses until the next billing date. No extra charge, ever.
- Subscribers = people who started your bots. Channel and group members do not count and are unlimited (a channel post is one message). Above the limit, sending pauses and the dashboard asks you to upgrade. Nothing is deleted.
- Join requests = people who asked to join a channel or group that has a live Welcome Flow, counted per calendar month (UTC). At 80% and 100% the owner gets an email and the dashboard shows it. After the limit plus 10% extra, people are still let in automatically, but welcome and flow messages pause until next month or an upgrade; the dashboard counts "N people joined without your welcome". Flows set to "I decide" keep waiting for the owner.
- Connections, seats, flows and steps: you can't add more than the plan allows; existing ones keep running. After a move to a smaller plan, the live Welcome Flows above the new plan's limit are switched off and kept (the owner can pick which flows stay live when choosing the smaller plan; otherwise the oldest stay), and the owner can swap them later in Welcome Flows. Steps beyond the new plan's steps per flow are not sent.
- No add-on fees. No setup fees.
- Free trial: 7 days of Growth, no card needed, with 50 AI writes and 3,000 join requests during the trial. At the end, the chosen plan is paid from the wallet. If no plan is picked or the wallet is short, the workspace moves to the Free plan (not paused): the first live Welcome Flow keeps sending its welcome (with the Castvoo line) and letting people in; everything else is paused and kept.
- Plans renew every month (or year) from the wallet. Reminder email 3 days before renewal if the balance is too low. If the wallet is still short, the workspace moves to the Free plan the same way, and the plan starts again by itself when a top-up covers it.
- Cancel any time in Settings; the plan runs until the end of the paid period, then the workspace moves to the Free plan.
- Data is kept while the workspace is on Free and in use. A Free workspace nobody has used for 12 months (no owner login, no join requests, no money in the wallet) is inactive. The owner gets an email 30 days and again 7 days before the delete date (logging in, or a dashboard visit, keeps everything); then its content (bots, channels, subscribers, messages, flows, media, join requests, links and clicks, replies) is deleted; the account and payment records stay. Owners with no email address are never cleared this way. Workspaces paused or cancelled under the old rules were moved to the Free plan on 8 October 2026. Only if the team removes the Free plan does an ended plan pause instead, and then its data is deleted 60 days after the plan ended.
- People who were paying on 8 October 2026 keep their AI writes and features while they stay on the same plan, and the join-request meter starts for them after the period they had already paid for.

## Wallet and payments
- Prepaid wallet in USD. Plans are paid from it.
- Payment methods depend on the country chosen at sign-up (changeable in Settings), set by the admin:
  - Nigeria: Paystack (card, bank transfer, USSD)
  - Ghana: Paystack (card, mobile money)
  - South Africa: Paystack (card, instant EFT)
  - Kenya: Flutterwave (card, M-Pesa)
  - Cameroon: Flutterwave (card, MTN and Orange mobile money)
  - Everywhere else: card through Flutterwave
  - Everyone: USDT (TRC20) and Bitcoin. With Gatevoo connected, the crypto checkout confirms automatically (USDT about a minute, Bitcoin about 10 minutes). Without Gatevoo: USDT only. Send the exact amount shown (it has unique cents) to the address shown, paste the transaction ID, and the team confirms it, usually within a few hours.
  - The team can add more local methods in the admin (for example a bank transfer, a mobile money number or a crypto wallet) for one country or for everyone. With these, the customer sees the team's payment instructions and an exact amount (with unique cents), pays, sends the transaction reference and/or a screenshot, and the team confirms it by hand, usually within a few hours. The wallet is credited only after the team confirms it.
- Local-currency payments: Castvoo shows the local amount for the USD top-up before you pay (rate set by the team in Admin → Countries). The USD amount lands in the wallet.
- Top-up bonuses (an offer the admin can switch off): $200 → +$10, $500 → +$40, $1,000 → +$60. Bonus credit can only be spent on plans; it is not refundable or withdrawable.
- Minimum top-up: $10.

## Refunds
- Unused wallet top-ups (not bonus credit) can be refunded within 14 days of the top-up if none of that money has been spent. Email billing@castvoo.com. Refunds go back to the original payment method (crypto: to an address you give, in the same coin). Processor or network fees are not refundable.
- Plan payments are not refundable once a billing period starts, except for duplicate charges or billing errors, which are always refunded in full.
- If Castvoo suspends an account for breaking the Acceptable Use Policy, unused wallet balance (not bonus) is refunded, minus fees.
- Chargebacks: if a top-up is charged back (disputed with the bank or card provider), the disputed amount (and what is left of that top-up's bonus) is taken out of the wallet at once, even if that makes the balance negative. A paid plan then moves to the Free plan (nothing is deleted) until a top-up covers the balance and the plan. Referral earnings from that customer that have not settled are cancelled. If Castvoo wins the dispute, the money is put back in the wallet.

## Referrals
- Every user has a link: castvoo.com/r/<code>.
- Earn a share of every plan payment made by people who sign up through your link, every month, for as long as they pay:
  - 1 to 4 paying referrals: 10%
  - 5 to 19: 20%
  - 20 or more: 30%
- One commission per payment: a plan payment pays either the Castvoo referral or a VooSquare affiliate, never both. The first attribution wins (the Castvoo referral link the person signed up through, or the VooSquare affiliate link they came from, whichever was first; at the same moment the Castvoo link wins).
- Commission is paid on the cash part of the plan payment minus the payment processor's fee when the provider reports it (bonus credit never pays commission), at most 50% (and at most 35% on yearly payments). The team sets these caps in Admin → Settings → Referral.
- Earnings settle 30 days after the payment (to cover refunds and chargebacks).
- Earnings that look like a self-referral (the referred account shares a Telegram account, email mailbox, VooSquare account, sign-up IP address or payment card/payer with the referrer) are held for the finance team to review, and are cancelled if it is a self-referral.
- Settled earnings can pay for your own plan at any time, or be withdrawn once they reach $300. Withdrawals are paid in USDT (TRC20) or Bitcoin within 5 business days.
- No self-referrals, fake accounts, spam, or paid ads bidding on the word "Castvoo". Breaking these rules cancels unpaid earnings.
- Referred people get the normal 7-day free trial.
- Free plan welcomes carry the owner's referral link (castvoo.com/r/<code>) in their "Free welcome bot by Castvoo.com" line.

## Telegram rules users must follow (Acceptable Use)
- Only message people who started your bot or joined your channel/group. No bought lists, no scraping, no adding people to groups without consent.
- No illegal content, scams, fake investment returns, adult content involving minors, hate, harassment, malware, phishing, or impersonation.
- Financial, trading and betting promotions must be legal where you and your audience are, and must not promise guaranteed profits.
- Follow Telegram's Terms of Service and Bot Platform rules.

## Data
- We store: account details (name, email, Telegram ID, country), workspace content (messages, sequences, audiences), subscriber data your bots receive from Telegram (Telegram user ID, first name, username, language, start tag, join and click history), payment records (not full card numbers), support chats (including images you send in them), AI training notes you write.
- Sub-processors: Railway (hosting, database), Telegram (message delivery), Anthropic (AI writing and AI support answers), OpenRouter or OpenAI (only if the team switches the AI provider to them; they then get the same data as Anthropic), Paystack and Flutterwave (payments), Gatevoo (Zedapex crypto checkout), VooSquare (Zedapex account hub: account ID and totals if the person signs in with VooSquare; and, when the VooSquare support inbox is on, a copy of every support message with the customer's name, email and the subject, for everyone), Resend (email delivery). Replyvoo gets no data.
- Deleting an account removes its workspaces' bots, subscribers, messages, flows, media, join requests, links and clicks, replies, the support AI's tool log and support chats, and removes every teammate from those workspaces. Payment records, AI cost rows (no text, no name) and the staff audit log are kept.
- Customers are the controllers of their subscribers' data; Castvoo is the processor for it.
- Users can export or delete their data from Settings or by emailing privacy@castvoo.com; we reply within 30 days.
- Security: bot tokens encrypted at rest (AES-256-GCM), HTTPS everywhere, staff access by role, audit log.
- Cookies: cv_session (login), cv_ref (referral, 60 days), voo_attr (VooSquare partner link, 60 days), voo_state and cv_voolink (VooSquare login, 10 minutes), cv_vis (website-chat security cookie, no personal data, 90 days). No advertising or tracking cookies.

## Brand
- Colours: blue #2F6BFF, gradient #5A8CFF → #2F6BFF → #1846DB, night #060C26, Telegram blue #29A9EB, white.
- Fonts: Plus Jakarta Sans (UI), Instrument Serif italic (accent words), JetBrains Mono (codes).
- Mascot: Cas, a friendly round blue bot.
- Voice: warm, short sentences, plain words a 12-year-old understands. No hype, no fake numbers, no fake testimonials.

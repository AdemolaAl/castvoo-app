# Castvoo product facts (single source of truth)

Every email, policy, page and AI prompt must agree with this file. Numbers here are the
defaults seeded into the database; the owner can change them later in the admin panel.

## Company
- Product: Castvoo (castvoo.com), a Telegram broadcast and auto follow-up tool.
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
- Auto follow-ups (drips): triggered by bot start, a start link tag, a channel/group join request, or a tag.
- Join-request welcome: the bot may message a person within 5 minutes of their join request.
- Start links: t.me/<bot>?start=<tag> to see which ad or post brought each subscriber.
- "Stop these messages" button on bot broadcasts (on by default); /stop also works. Blocked users are removed automatically.
- Edit, pin and delete sent messages; Telegram only lets bots delete messages less than 48 hours old.
- Sending speed: about 25 messages per second per bot (roughly 7 minutes per 10,000 people).
- Castvoo cannot see who read a message. No read receipts. Views and reactions on channel posts are visible inside Telegram only.
- Cas, the AI assistant: writes and rewrites messages, translates, writes follow-up sequences, answers questions about your workspace. It learns your business from the "Train Cas" page.
- Support chat inside the dashboard; answered by the Castvoo team.

## Plans (USD per month; yearly = pay 10 months, get 12)
| Plan | Price | Connections (bots, channels, groups) | Subscribers | AI writes per month | Team seats |
|---|---|---|---|---|---|
| Starter | $19 | 1 | 5,000 | 300 | 1 |
| Growth | $49 | 5 | 25,000 | 2,000 | 3 |
| Scale | $99 | 20 | 100,000 | 5,000 | 10 |

- An "AI write" = one time Cas writes, rewrites or translates a message, or answers one question. A follow-up sequence counts one write per message in it.
- When AI writes run out, Cas pauses until the next billing date. No extra charge, ever.
- Subscribers = people who started your bots. Channel and group members do not count and are unlimited (a channel post is one message). Above the limit, sending pauses and the dashboard asks you to upgrade. Nothing is deleted.
- No add-on fees. No setup fees.
- Free trial: 7 days of Growth, no card needed, with 100 AI writes during the trial. At the end, the chosen plan is paid from the wallet. If the wallet is short, sending pauses until it is topped up. Data is kept for 60 days after a plan ends, then deleted.
- Plans renew every month (or year) from the wallet. Reminder email 3 days before renewal if the balance is too low.
- Cancel any time in Settings; the plan runs until the end of the paid period.

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
- Local-currency payments: Castvoo shows the local amount for the USD top-up before you pay (rate set by the team in Admin → Countries). The USD amount lands in the wallet.
- Top-up bonuses (an offer the admin can switch off): $200 → +$10, $500 → +$40, $1,000 → +$100. Bonus credit can only be spent on plans; it is not refundable or withdrawable.
- Minimum top-up: $10.

## Refunds
- Unused wallet top-ups (not bonus credit) can be refunded within 14 days of the top-up if none of that money has been spent. Email billing@castvoo.com. Refunds go back to the original payment method (crypto: to an address you give, in the same coin). Processor or network fees are not refundable.
- Plan payments are not refundable once a billing period starts, except for duplicate charges or billing errors, which are always refunded in full.
- If Castvoo suspends an account for breaking the Acceptable Use Policy, unused wallet balance (not bonus) is refunded, minus fees.

## Referrals
- Every user has a link: castvoo.com/r/<code>.
- Earn a share of every plan payment made by people who sign up through your link, every month, for as long as they pay:
  - 1 to 4 paying referrals: 10%
  - 5 to 19: 20%
  - 20 or more: 30%
- Earnings settle 30 days after the payment (to cover refunds and chargebacks).
- Settled earnings can pay for your own plan at any time, or be withdrawn once they reach $300. Withdrawals are paid in USDT (TRC20) or Bitcoin within 5 business days.
- No self-referrals, fake accounts, spam, or paid ads bidding on the word "Castvoo". Breaking these rules cancels unpaid earnings.
- Referred people get the normal 7-day free trial.

## Telegram rules users must follow (Acceptable Use)
- Only message people who started your bot or joined your channel/group. No bought lists, no scraping, no adding people to groups without consent.
- No illegal content, scams, fake investment returns, adult content involving minors, hate, harassment, malware, phishing, or impersonation.
- Financial, trading and betting promotions must be legal where you and your audience are, and must not promise guaranteed profits.
- Follow Telegram's Terms of Service and Bot Platform rules.

## Data
- We store: account details (name, email, Telegram ID, country), workspace content (messages, sequences, audiences), subscriber data your bots receive from Telegram (Telegram user ID, first name, username, language, start tag, join and click history), payment records (not full card numbers), support chats, AI training notes you write.
- Sub-processors: Railway (hosting, database), Telegram (message delivery), Anthropic (AI writing), Paystack and Flutterwave (payments), Gatevoo (Zedapex crypto checkout), VooSquare (Zedapex account hub, only if used), Resend (email delivery), Google (optional sign-in).
- Customers are the controllers of their subscribers' data; Castvoo is the processor for it.
- Users can export or delete their data from Settings or by emailing privacy@castvoo.com; we reply within 30 days.
- Security: bot tokens encrypted at rest (AES-256-GCM), HTTPS everywhere, staff access by role, audit log.
- Cookies: one essential login cookie, one referral cookie (60 days). No advertising or tracking cookies.

## Brand
- Colours: blue #2F6BFF, gradient #5A8CFF → #2F6BFF → #1846DB, night #060C26, Telegram blue #29A9EB, white.
- Fonts: Plus Jakarta Sans (UI), Instrument Serif italic (accent words), JetBrains Mono (codes).
- Mascot: Cas, a friendly round blue bot.
- Voice: warm, short sentences, plain words a 12-year-old understands. No hype, no fake numbers, no fake testimonials.

# Connecting outside services

Each service is optional except the database. Add its variables in Railway, redeploy, then press
**Test** in Admin → Settings & connections. A feature whose service is missing simply stays hidden.

## Telegram: @CastvooBot (channels, groups, Telegram login)
1. Telegram → @BotFather → `/newbot` → name "Castvoo", username e.g. `CastvooBot`.
2. Copy the token into `CASTVOO_BOT_TOKEN`, the username into `CASTVOO_BOT_USERNAME`.
3. In @BotFather: `/setdomain` → choose the bot → `castvoo.com` (needed for "Log in with Telegram").
4. Optional polish in @BotFather: `/setuserpic` (Castvoo logo), `/setdescription`, `/setabouttext`.
5. On start, Castvoo points the bot's webhook at `https://castvoo.com/tg/platform` by itself.

Customers' own bots: they paste their BotFather token in the dashboard. Castvoo sets that bot's webhook to
`/tg/b/<id>` with a secret. (If their bot was used by another service, that service stops getting updates.
The dashboard says so before they connect.)

## Email: Resend
1. resend.com → add and verify your domain (DNS records).
2. API Keys → create → `RESEND_API_KEY`.
3. `EMAIL_FROM=Castvoo <hello@castvoo.com>` (must be on the verified domain), `EMAIL_REPLY_TO=support@castvoo.com`.
All 28 emails (login codes, welcome, receipts, reminders, sales follow-ups) are edited in Admin → Emails.

## AI: Anthropic (Cas)
1. console.anthropic.com → API keys → `ANTHROPIC_API_KEY`. Add billing credit there.
2. Model, answer length, creativity and house rules: Admin → AI settings. Default model `claude-haiku-4-5-20251001`
   (fast and cheap: roughly $0.003–0.006 per AI write, so even a Scale plan using all 5,000 writes costs about $15–30).
   The shared part of Cas's instructions (persona, house rules, knowledge, plans) is sent with prompt caching, so
   repeat calls within a few minutes pay about a tenth for it. The model only caches it once it is long enough
   (a few thousand words of knowledge); below that it simply isn't cached and nothing breaks.
3. Cas's knowledge (help articles it reads before answering): Admin → Cas knowledge. Customers teach Cas
   about their own business in Dashboard → Ask Cas → Train Cas.

## Paystack (Nigeria, Ghana, South Africa)
1. dashboard.paystack.com → Settings → API Keys & Webhooks → copy the **Secret key** → `PAYSTACK_SECRET_KEY`
   (use the test key first: `sk_test_...`).
2. Webhook URL: `https://castvoo.com/pay/paystack`. Castvoo checks the `x-paystack-signature` and then asks
   Paystack directly before adding money, so a fake webhook can never credit a wallet.
3. Your Paystack account must be enabled for each currency you sell in (NGN, GHS, ZAR). Set the exchange
   rate per country in Admin → Countries & payments ("local money per $1"). Customers see the local amount
   before paying.

## Flutterwave (Kenya, Cameroon, cards everywhere)
1. dashboard.flutterwave.com → Settings → API Keys → **Secret key** → `FLW_SECRET_KEY`.
2. Settings → Webhooks → URL `https://castvoo.com/pay/flutterwave`, and type a long random **Secret hash**.
   Put the same value in `FLW_WEBHOOK_HASH`.
3. Enable M-Pesa (KES) and Francophone mobile money (XAF) in Flutterwave if you sell in Kenya/Cameroon.

## Gatevoo (crypto checkout, USDT TRC20 + Bitcoin)
1. In Gatevoo: **Connect → Add an app** → name "Castvoo". Copy the API key and webhook secret (shown once).
2. `GATEVOO_URL=https://gatevoo.com`, `GATEVOO_KEY=...`, `GATEVOO_WEBHOOK_SECRET=...`
3. Webhook URL in Gatevoo: `https://castvoo.com/pay/gatevoo`. Press **Send test** in Gatevoo: Castvoo answers 200.
4. Add `https://castvoo.com` to Gatevoo's `EMBED_ORIGINS` so the checkout can open as a pop-up.
5. Admin → Settings → Gatevoo card → "Use Gatevoo for crypto top-ups" ON.
6. Make one real $1–2 top-up in USDT and in Bitcoin and check the wallet is credited.

How it works: the customer picks "USDT or Bitcoin" → Castvoo creates a Gatevoo invoice
(`POST /api/v1/invoices`, `order_id` = Castvoo payment reference) → the Gatevoo checkout opens →
Gatevoo sends a signed `invoice.paid` webhook (HMAC-SHA256 of `<timestamp>.<raw body>`, rejected if older
than 5 minutes) → Castvoo re-reads the invoice (`GET /api/v1/invoices/:id`), checks it is `paid` for the
right amount, and credits the wallet once. Castvoo checks three things on the invoice before crediting:
`status` is `paid`, `order_id` equals the Castvoo payment reference, and the paid USD amount
(`amount_paid_usd`, else `paid_usd`, else `amount_usd`) is at least the top-up amount.

**Without Gatevoo** (or with the switch off), crypto still works in manual mode, **USDT (TRC20) only**: the
Owner puts the USDT receiving address in Admin → Settings (only the Owner can change where crypto goes).
Each top-up gets its own exact amount (the amount plus 1–99 unique cents, e.g. $50.37), so Finance can match
every transfer to one customer. The customer sends exactly that, pastes the transaction ID, and Finance
approves it in Admin → Payments after checking it on tronscan.org. Approve works only for manual crypto
payments that have a transaction ID; card and Gatevoo payments are only ever credited by the provider's
confirmation (use **Recheck**). Bitcoin is offered only through Gatevoo, because its price moves too much for
exact-amount matching.

## Google login (optional)
console.cloud.google.com → APIs & Services → OAuth consent screen (External, app name Castvoo) →
Credentials → Create OAuth client ID (Web application) → Authorized redirect URI
`https://castvoo.com/api/auth/google/callback` → copy `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

## VooSquare (the Zedapex account hub)
In VooSquare: **Admin → Products → Add Castvoo**. Set its URL, switch SSO on, and fill in:
- Redirect URI: `https://castvoo.com/api/auth/voosquare/callback`
- Support webhook: `https://castvoo.com/api/voosquare/support/webhook`
- Summary URL: `https://castvoo.com/api/voosquare/summary`

Copy the credentials into Railway: `VOO_BASE=https://voosquare.com`, `VOO_CLIENT_ID`, `VOO_CLIENT_SECRET`, `VOO_API_KEY`.

What then works:
- **Login**: "Continue with VooSquare" on the sign-up page (VooSquare's `/oauth/authorize` → `/oauth/token`; the
  person's `voo_id`, email, name and country come back). Logging out of Castvoo also logs out of VooSquare.
- **Support in VooSquare's HQ inbox**: every message a customer writes in Castvoo's Help chat is copied to
  `POST <VOO_BASE>/api/v1/support/messages` with `external_ref = castvoo-<conversation id>`, so one Castvoo conversation
  is one VooSquare ticket. When someone answers in VooSquare, VooSquare posts `{type: "support.reply", external_ref, body, agent}`
  to the Support webhook and the answer appears in the customer's Castvoo chat (VooSquare emails the customer itself, so
  Castvoo doesn't send a second email). Answers written in Castvoo's own Admin → Support also reach the customer. Both
  places work; each message shows where it was written.
- **Two-way desk** (VooSquare's "Support HQ" plan, Part 5 of the spec): Castvoo already exposes
  ```
  GET  /api/voosquare/support/boxes
  GET  /api/voosquare/support/tickets?status=active|open|pending|closed|all&view=mine|unassigned&q=&voo_id=
  GET  /api/voosquare/support/tickets/:ref
  POST /api/voosquare/support/tickets/:ref/reply    {voo_id, text, note}
  POST /api/voosquare/support/tickets/:ref/update   {status, assignee_voo_id}
  GET/POST /api/voosquare/staff                      {voo_id, email, name, role: admin|support|finance|content|viewer, active}
  Header on every call: Authorization: Bearer <VOO_API_KEY>   (or VOO_SERVICE_KEY if you set one)
  ```
  VooSquare can add, change or remove Castvoo team members (never owners; owners are managed in Castvoo).
- **Dashboard numbers**: `GET /api/voosquare/summary?voo_id=&period=1d|7d|30d` returns messages sent, broadcasts,
  active follow-ups, subscribers and clicks.
- **Live feed**: Castvoo sends `broadcast_sent`, `channel_connected`, `plan_started`, `plan_cancelled` and `spend`
  events in batches to `<VOO_BASE>/api/v1/events` with `Authorization: Bearer <VOO_API_KEY>`, retried for up to a day.
  No subscriber personal data is ever sent.

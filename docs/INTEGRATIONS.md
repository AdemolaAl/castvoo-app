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
All 31 emails (login codes, welcome, receipts, reminders, sales follow-ups) are edited in Admin → Emails.

## AI: Anthropic (Cas)
1. console.anthropic.com → API keys → `ANTHROPIC_API_KEY`. Add billing credit there.
2. Model, answer length, creativity and house rules: Admin → AI settings. Default model `claude-haiku-4-5-20251001`
   (fast and cheap: roughly $0.003–0.006 per AI write, so even a Scale plan using all 5,000 writes costs about $15–30).
   The shared part of Cas's instructions (persona, house rules, knowledge, plans) is sent with prompt caching, so
   repeat calls within a few minutes pay about a tenth for it. The model only caches it once it is long enough
   (a few thousand words of knowledge); below that it simply isn't cached and nothing breaks.
3. Cas's knowledge (help articles it reads before answering): Admin → Cas knowledge. Customers teach Cas
   about their own business in Dashboard → Ask Cas → Train Cas.

## AI: OpenRouter (Cas, optional)

OpenRouter lets Cas run on almost any AI model (Claude, GPT, Gemini, Llama…) with one key and one bill.
Claude direct (`ANTHROPIC_API_KEY`) stays the default; nothing changes unless you switch.

1. Make an account at [openrouter.ai](https://openrouter.ai), add some credit, then **Keys → Create key**.
2. In Railway → Castvoo service → **Variables**, add:
   ```
   AI_PROVIDER=openrouter
   OPENROUTER_API_KEY=sk-or-...
   OPENROUTER_MODEL=anthropic/claude-sonnet-4.5
   # optional, tried in order when the main model is down or busy:
   OPENROUTER_FALLBACK_MODELS=openai/gpt-4o-mini
   ```
   Or skip the variables and do it in **Admin → Cas AI → Who answers for Cas** (Owner or Admin). The key is stored
   encrypted, only its last 4 characters are ever shown, every change is in the audit log (without the key), and
   switching provider means pasting the key again.
3. **Pick a model**: copy its id from [openrouter.ai/models](https://openrouter.ai/models), e.g.
   `anthropic/claude-sonnet-4.5` (the default) or `openai/gpt-4o-mini` (much cheaper).
4. Press **Test** next to Cas AI in **Settings & connections**, or ask Cas something in Admin → Cas AI.

**Costs.** You pay per token at the price on each model's page, from prepaid OpenRouter credit.
`anthropic/claude-sonnet-4.5` is $3 per million input tokens and $15 per million output, about 3 times Claude Haiku
direct, so roughly 1–2 cents per AI write. Customers' AI write allowances work the same on every provider, and
Admin → Cas AI shows the last 24 hours of tokens and cost.

**Privacy.** The privacy page (`server/legal/privacy.html`) and `docs/PRODUCT-FACTS.md` name Anthropic as the AI
sub-processor. Before you switch Cas to OpenRouter, add OpenRouter (and the model's maker) there.

## Paystack (Nigeria, Ghana, South Africa)
Paystack checkout is disabled by default. Enable **Admin → Features → Paystack payments** before offering it to customers.
1. dashboard.paystack.com → Settings → API Keys & Webhooks → copy the **Secret key** → `PAYSTACK_SECRET_KEY`
   (use the test key first: `sk_test_...`).
2. Webhook URL: `https://castvoo.com/pay/paystack`. Castvoo checks the `x-paystack-signature` and then asks
   Paystack directly before adding money, so a fake webhook can never credit a wallet.
3. Your Paystack account must be enabled for each currency you sell in (NGN, GHS, ZAR). Set the exchange
   rate per country in Admin → Countries & payments ("local money per $1"). Customers see the local amount
   before paying.

## Flutterwave (Kenya, Cameroon, cards everywhere)
Flutterwave checkout is disabled by default. Enable **Admin → Features → Flutterwave payments** before offering it to customers.
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

## Your own payment methods (bank transfer, mobile money, a crypto wallet...)
No keys and no code. In **Admin → Countries & payments → Your own payment methods → Add payment method**
(Owner, Admin or Finance: permission `countries.edit`):
- **Name, kind, short detail, icon and colour**: what customers see on the top-up screen. The key is made from the name.
- **Instructions**: one thing per line, e.g. `Bank: GTBank`, `Account number: 0123456789`, `Account name: Zedapex Limited`.
  Lines like `Label: value` get a copy button for the customer. Everything typed here is shown as plain text (never HTML).
- **Currency** (empty = US dollars) and **per $1** rate (empty = the rate of the customer's country, set in the Countries list;
  the method is then only offered in countries that use that currency). **Smallest / largest** top-up (optional, in USD).
- **Proof**: transaction reference and/or screenshot, each off, optional or required. Screenshots: JPG, PNG or WEBP up to
  10 MB, checked by file signature, stored in `UPLOAD_DIR/proofs/<workspace>/` and only visible to staff with `payments.view`.
- **Where it is offered**: all countries, or the countries you tick. **Order** and an **on/off** switch.

How it works: the customer picks the method → Castvoo creates a pending payment with an exact amount (the top-up plus
1–99 unique cents, like manual USDT; in a local currency the cents are added to the local amount and the USD amount the
customer asked for is credited) → they see your instructions and the amount, pay, add the reference and/or screenshot and
press **I've paid** (email `topup_submitted`) → the payment shows in **Admin → Payments → To check** → Finance checks the
account and presses **Approve** (wallet credited once with the usual top-up bonuses, email `topup_received`, VooSquare
`wallet_topup`) or **Reject** with a reason (email `topup_rejected`). The customer can never change the amount; only the
person approving can credit a different USD amount. Approving twice credits once. A reference can't be used for two top-ups
with the same method.

Editing and deleting: built-in methods (Paystack, Flutterwave, crypto) can be renamed and switched off, never deleted.
Your own methods can be edited and deleted; one that payments already use is switched off and hidden instead, so payment
history keeps its name. A method with open (pending) payments can't be deleted until they are approved or rejected.
Every add, change and delete is in the audit log.

## Adding a payment gateway (automatic, needs code)
For a provider that confirms payments by itself (for example Stripe or another local gateway):
1. `server/config.js`: read its keys, add `yourgateway: !!key` to `integrations()`, and document them in `.env.example`.
2. A new migration: allow the provider name in `payment_methods_provider_check` and insert its method row(s)
   (or add them to `METHODS` in `server/seed.js`).
3. `server/payments/index.js`: write `startYourGateway(ctx, m, base)` (insert the payment with `insert()`, call the provider,
   return `{ kind: 'redirect', url, reference }`) and `verifyYourGateway(reference)` (ask the provider server to server whether
   it is paid, check the currency and amount, then call `credit(reference)`). Add both to `GATEWAYS`. The steps are also at the
   top of that file.
4. `server/services/settings.js` → `methodsFor()`: offer the method only when `integ.yourgateway` is true.
5. `server/routes/payment-webhooks.js`: a webhook that checks the provider's signature and calls `payments.verify(reference)`.
6. `test/helpers/fakes.js`: a fake of the provider, and tests in `test/e2e/payments.test.js` (paid, wrong amount, bad signature,
   paid twice).
Then pick the method per country in Admin → Countries & payments.

## VooSquare (the Zedapex account hub) · Voo Connect

Castvoo connects to VooSquare with **Voo Connect**, the kit VooSquare publishes in its repo at `sdk/voo-connect/`. It is
copied **unchanged** into `voo-connect/` here (never edit it: copy the new folder over it when VooSquare publishes a new
version). Castvoo's own code around it: `server/lib/voo.js` (creates the kit), `server/routes/voo-connect.js` (login,
logout), `server/services/voosquare.js` (events), `server/routes/voosquare.js` (calls from VooSquare). The contract is
VooSquare's `docs/VOO_CONNECT.md` (Castvoo sheet) and `docs/INTEGRATION.md`.

### Set it up (once per VooSquare: staging and live have separate credentials)
In VooSquare: **Admin → Products → Castvoo**:
- URL `https://castvoo.com` · **SSO on**
- Launch path `/dashboard` (the page VooSquare's launcher opens after login; empty also means `/dashboard`, the Castvoo dashboard)
- Redirect URIs, two lines, exact: `https://castvoo.com/auth/voosquare/callback` and `https://castvoo.com/`
- Summary URL `https://castvoo.com/api/voosquare/summary`
- Support webhook `https://castvoo.com/hooks/voosquare/support` (the older `/api/voosquare/support/webhook` also works)

Railway → Variables: `VOO_BASE=https://voosquare.com`, `VOO_CLIENT_ID`, `VOO_CLIENT_SECRET`, `VOO_API_KEY` (from
Credentials), `VOO_SIGNAL_SECRET` (`openssl rand -hex 32`, made once, never changed). `VOO_CONNECT=off` switches all of
it off at once (the other logins keep working); `VOO_SUPPORT_WIDGET=off` keeps our own help bubble on the website.

Then check every setting against VooSquare (changes nothing there):
```bash
node voo-connect/check.js --base "$VOO_BASE" --client-id "$VOO_CLIENT_ID" --client-secret "$VOO_CLIENT_SECRET" \
  --api-key "$VOO_API_KEY" --redirect-uri https://castvoo.com/auth/voosquare/callback --logout-uri https://castvoo.com/ \
  --summary-url https://castvoo.com/api/voosquare/summary
```
Every line must say PASS. Add `--voo-id <your Voo ID>` to prove the API key and the client ID are the same product.

### What then works
- **Continue with Voo ID** on the sign-up and log-in page. "Start free" opens VooSquare's sign-up view
  (`/auth/voosquare?signup=1` → `prompt=signup`). The kit checks a signed state cookie (10 minutes), exchanges the code
  server side and verifies the `id_token` (HS256 with the client secret, `aud`, `iss`, expiry). VooSquare's launcher
  opens `/auth/voosquare?return_to=/dashboard`, which lands on the dashboard (`/#app`).
- **Who is who.** A Castvoo account is found by its `voo_id`. The existing logins (email code, Telegram) stay.
  An existing Castvoo account is linked to a Voo ID when (a) the person presses **Settings → VooSquare → Connect**
  while logged in (a POST from our page; a link from another website cannot do it), or (b) owner's rule: the email is
  verified on **both** sides (VooSquare says `email_verified`, and Castvoo verified it with a code or a provider) and
  the account has no Voo ID yet. An unverified email never joins accounts. A Voo ID login while someone else is logged
  in on the same browser switches account; it never links. New accounts get the free trial, the country VooSquare
  sends and VooSquare's referral code (`users.voo_ref`, saved once).
- **Affiliate hand-off.** An affiliate link (`voosquare.com/a/<code>?p=castvoo`) lands on Castvoo with
  `?ref=&vclick=`; every page keeps `ref`, `vclick` and `coupon` in the first-party cookie `voo_attr` (60 days, last
  click wins; `server/app.js`), and the login replays them to VooSquare, which decides the attribution. The browser
  snippet `/voo-connect-browser.js` is on the website and legal pages too. Castvoo's own referral links (`/r/<code>`)
  now land with `?cvref=` so they are never mistaken for an affiliate click.
- **Log out everywhere.** `/logout` (and the Log out buttons) end the Castvoo session, then VooSquare's, then come back
  to `https://castvoo.com/`.
- **Money events** (commission is calculated by VooSquare from these). Castvoo is a wallet: top-ups add money, plans
  are paid from the wallet. The workspace owner's Voo ID is the customer.

  | When | Event | Id | Commission |
  |---|---|---|---|
  | A top-up is paid | `wallet_topup` | `cv_topup_<payment id>` | none |
  | A plan is paid from the wallet (start or renewal) | `spend` (the cash part; bonus credit is not money) | `cv_pay_<wallet_tx id>` | yes |
  | The first paid plan | `plan_started` (plan, price) | `cv_plan_<wallet_tx id>` | none (plan sync) |
  | Every later plan payment | `plan_renewed` | `cv_renew_<wallet_tx id>` | none |
  | An upgrade paid for the rest of the period | `spend` | `cv_pay_<wallet_tx id>` | yes |
  | The plan ends after renewal was switched off | `plan_cancelled` | `cv_cancel_<workspace>_<date>` | none |
  | Admin → Users → wallet → **refund** of cash | `refund` | `cv_rf_<wallet_tx id>` | never reversed |
  | A top-up is charged back (Paystack `charge.dispute.create`, or **Admin → Payments → Chargeback** for other providers) | one `chargeback` per plan payment that used that money (oldest money is spent first), `original_event_id = cv_pay_<wallet_tx id>` | `cv_cb_<payment id>_<wallet_tx id>` | reversed |

  Activity: `broadcast_sent` (`cv_bc_<broadcast>`, label "<title>: N messages"), `channel_connected`
  (`cv_conn_<connection>`), `drip_step_sent` (one per workspace per finished hour, `cv_drip_<workspace>_<hour>`).
  Never sent: subscribers' Telegram IDs, usernames, names, phone numbers, emails; read receipts (bots get none).
- **How events travel.** Each event is checked by the kit when it is queued and written to our `outbox` table in the
  same database transaction as the money. Every 10 s the worker hands due rows to the kit's sender (batches of 100,
  resend when VooSquare asks, backoff on network trouble). Ids are stable, so a retry or a second run never counts
  twice. Events VooSquare refuses for good are kept with `failed_at` and shown in **Admin → System**.
- **Support in VooSquare's inbox**: every message a customer writes in Castvoo's Help chat is copied to VooSquare with
  `external_ref = castvoo-<conversation id>` (one Castvoo conversation = one ticket). Replies written in VooSquare come
  back through the support webhook and appear in the customer's chat. On the public website the VooSquare support
  widget (`data-product="castvoo"`) replaces our help bubble; inside the dashboard, Help stays our own chat.
- **Two-way desk** (VooSquare's "Support HQ"): Castvoo exposes
  ```
  GET  /api/voosquare/support/boxes
  GET  /api/voosquare/support/tickets?status=active|open|pending|closed|all&view=mine|unassigned&q=&voo_id=
  GET  /api/voosquare/support/tickets/:ref
  POST /api/voosquare/support/tickets/:ref/reply    {voo_id, text, note}
  POST /api/voosquare/support/tickets/:ref/update   {status, assignee_voo_id}
  GET/POST /api/voosquare/staff                      {voo_id, email, name, role: admin|support|finance|content|viewer, active}
  Header on every call: Authorization: Bearer <VOO_API_KEY>   (or VOO_SERVICE_KEY if you set one)
  Staff sync (/api/voosquare/staff) accepts ONLY VOO_SERVICE_KEY (inbound-only), and never matches a staff member to an
  existing customer account by email (the person links their Voo ID in Castvoo first). Every sync is in the audit log.
  ```
- **Dashboard card**: `GET /api/voosquare/summary?voo_id=&period=1d|7d|30d` returns messages sent, broadcasts,
  active follow-ups, subscribers (and clicks).
- **"Part of VooSquare"** link in the website footer, the dashboard sidebar and the legal pages.

### Tests
`test/e2e/voo-connect.test.js` (against a fake VooSquare, always runs) and `test/e2e/voo-connect-hub.test.js` (against
the **real** VooSquare: it boots VooSquare from its repo, registers Castvoo, runs `check.js`, and goes affiliate link →
sign-up → money → commission → refund → chargeback → summary → support → logout). The second one runs when the
VooSquare repo is found (`VOOSQUARE_DIR`, or `../voosquare-app` next to this repo) and is skipped otherwise. Point
`VOOSQUARE_DIR` at a fresh **copy** of the current VooSquare (without its `data/` folder), never at the live repo
folder: the test boots it with `NODE_ENV=test` on `127.0.0.1` (VooSquare only hands out login codes in the response
then) and its own temporary database. Ports: the first free pair in 4863–4869.

The Playwright run of the same journey in a real browser (screens at 1440 and 390) is described in
[CHANGES-FROM-TESTS.md](CHANGES-FROM-TESTS.md), "Voo Connect and audit, October 2026".

### What VooSquare enforces (checked against the current VooSquare, October 2026)
- Every money event (`spend`, `refund`, `chargeback`, `plan_started`, `plan_renewed`, `wallet_topup`) needs an
  `event_id` of at most 80 characters; malformed or id-less events come back in `rejected`. Castvoo's ids are at most
  ~40 characters, the kit refuses a bad one before it is queued, and anything VooSquare still refuses is kept as
  "refused by VooSquare" in Admin → System (never retried, never dropped silently).
- Logout may return to any page on Castvoo's own site (the product URL's origin) or a registered Redirect URI. We
  return to `<APP_URL>/`, which is both.
- VooSquare logout also revokes the access tokens it gave Castvoo; Castvoo does not keep or reuse them (the
  `id_token` is read once at login).

### Not done on purpose (owner decisions)
- VooSquare's sheet asks tools to drop their own referral balances and withdrawals. Castvoo's referral program
  (wallet credit and crypto withdrawals) is still on, because removing a live feature is the owner's call.
- A chargeback reverses commission in VooSquare and unsettled Castvoo referral earnings, but does not take the
  disputed money out of the customer's wallet (Paystack's event is the dispute opening, which can still be won).

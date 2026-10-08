# Launch checklist

Tick every line before opening Castvoo to the public.

## Code
- [ ] `npm run check` passes
- [ ] `npm test` passes (511 tests)

## Railway
- [ ] PostgreSQL added, daily backups ON
- [ ] Volume mounted at `/data`, `UPLOAD_DIR=/data/uploads`, and volume backups ON (payment proofs are financial evidence)
- [ ] Before the first deploy of a new version: download a PostgreSQL backup (Postgres → Backups → Backup now)
- [ ] The volume marker `/data/uploads/.castvoo-volume` is written by Castvoo itself on start (also on an existing
      volume with files). Do not set `ALLOW_NO_VOLUME` unless the logs say the uploads folder is empty but the database
      lists saved files and you accept losing them (see DEPLOY-RAILWAY.md §6)
- [ ] `APP_SECRET` is 64 random characters and saved in your password manager (never change it)
- [ ] `APP_URL=https://castvoo.com` and the custom domain shows a padlock
- [ ] `NODE_ENV=production`
- [ ] `/health` answers `{"ok":true}`

## Services (Admin → Settings & connections → Test)
- [ ] Telegram: @CastvooBot test passes, `/setdomain` done in @BotFather
- [ ] Email: test email arrives (check spam). SPF/DKIM verified in Resend
- [ ] Cas AI: test passes, Anthropic account has credit and a monthly spend limit
- [ ] Paystack: LIVE secret key, webhook URL saved, NGN/GHS/ZAR enabled
- [ ] Flutterwave: LIVE secret key, webhook URL + secret hash saved, M-Pesa / XAF enabled
- [ ] Gatevoo: key + webhook secret set, "Send test" from Gatevoo succeeds, castvoo.com in EMBED_ORIGINS
- [ ] VooSquare: Admin → Products → Castvoo filled in (SSO on, both redirect URIs, summary URL, support webhook),
      `VOO_BASE`, `VOO_CLIENT_ID`, `VOO_CLIENT_SECRET`, `VOO_API_KEY` and `VOO_SIGNAL_SECRET` set, and
      `node voo-connect/check.js ...` (docs/INTEGRATIONS.md) prints only PASS
- [ ] `VOO_SERVICE_KEY` set (`openssl rand -hex 32`, different from `VOO_API_KEY`) and given to VooSquare: the staff sync
      (`/api/voosquare/staff`) accepts only this key. Until VooSquare sends it, staff sync answers 401 (summary and the
      support desk keep working with `VOO_API_KEY`)
- [ ] Confirm with VooSquare in writing that `plan_started` / `plan_renewed` events do **not** pay a second commission
      (Castvoo sends them even when a Castvoo referrer is the one paid)
- [ ] VooSquare: open a test affiliate link, "Continue with Voo ID" with a new email, top up, start a plan: the affiliate
      sees the sale; refund (commission stays); Log out lands on castvoo.com logged out of VooSquare too
- [ ] Manual crypto fallback addresses (USDT TRC20 + BTC) entered and double-checked

## Settings to check (Admin)
- [ ] **Countries & payments**: exchange rates for NGN, KES, GHS, ZAR, XAF are today's rates
- [ ] **Pricing**: Free (1 channel, 500 free joins a month, welcome only, Castvoo line) / Starter $19 / Growth $49 /
      Scale $99 (yearly = 10 months), limits as you want them
- [ ] **Offers**: top-up bonuses ($200 → +$10, $500 → +$40, $1,000 → +$60) and the COMEBACK20 coupon ON or OFF as you want
- [ ] **Settings**: company name and address, support/privacy/billing emails exist and are read by someone
- [ ] **Settings → Referral**: 10 / 20 / 30 %, tiers at 5 and 20, settle after 30 days, minimum withdrawal $300
- [ ] **Settings → Trial**: 7 days of Growth, 50 AI writes and 3,000 join requests; then the chosen plan from the wallet,
      or the Free plan (not paused)
- [ ] **Website text**: hero, FAQ, footer read well; announcement bar on/off
- [ ] **Features**: everything you want ON, Maintenance OFF
- [ ] **Team**: add your support and finance people with the right roles

## Real-money tests (do these yourself, on the live site)
See also [DEPLOY-NOTES-OCT-2026.md](DEPLOY-NOTES-OCT-2026.md) for the October 2026 deploy steps and live tests.
- [ ] Sign up with a new email, a new Telegram account and a Voo ID: each lands in the dashboard
- [ ] Connect a real bot, press Start on it from another phone, send a broadcast with a photo and a button, tap the button: the click appears in Clicks
- [ ] Add @CastvooBot to a test channel with one tap; post to it
- [ ] Create a follow-up and receive step 1 and step 2
- [ ] Join-request welcome on a test channel with "approve new members" on
- [ ] Top up $10 with Paystack (card), $10 with Flutterwave, $2 with Gatevoo USDT: wallet credited, receipt emails arrive
- [ ] Look at one paid Gatevoo invoice's JSON and confirm it has `order_id` and a paid USD amount (`amount_paid_usd`, `paid_usd` or `amount_usd`): Castvoo needs both to credit
- [ ] If you use manual USDT: top up $10, send the exact amount shown (with its cents), paste the txid, approve it in Admin → Payments
- [ ] On Railway, upload a photo in a broadcast, redeploy, and check the photo is still there (proves the `/data` volume works)
- [ ] Pick a plan and start it now: wallet charged, receipt email
- [ ] Use a referral link in a private window, sign up, pay: the referrer sees pending earnings
- [ ] Send a support message as a customer; answer it from Admin → Support; the customer gets the email
- [ ] Ask Cas to write a message and to answer "how did my last broadcast do?"
- [ ] Open the site on an Android phone and an iPhone

## Legal
- [ ] Read the six policies at /legal/... once, and that "Last updated" (Admin → Settings) is today
- [ ] Your payment providers' merchant agreements allow your products/countries

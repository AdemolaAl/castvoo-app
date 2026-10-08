# Server changes made because of the end-to-end tests

> Note: Google sign-in was later removed from Castvoo (migration `008_remove_google.sql`). Rows below that mention Google, `GOOGLE_ISSUER` or `oidc.js` are kept as history.

Every change below was found by a test in `test/e2e/`. API request/response shapes and
route paths were NOT changed unless a line says so.

| # | File | What was wrong | How it was fixed |
|---|------|----------------|------------------|
| 1 | `package.json` | `npm test` ran `node --test test/`, which Node 22 rejects ("Cannot find module .../test"), so no test ran. | Script is now `node --test --test-concurrency=1 "test/**/*.test.js"`. |
| 2 | `server/config.js` | The Google issuer was hard-coded, so Google login could not be tested. | New optional `GOOGLE_ISSUER` env var, defaulting to `https://accounts.google.com`. |
| 3 | `server/lib/router.js` | A broken escape in a path parameter (`/l/%E0%A4%A`) threw `URIError` and answered **500**. | Decoding errors now answer **400** `bad_url`. |
| 4 | `server/app.js` | With `TRUST_PROXY` on, the client IP was the **first** `X-Forwarded-For` entry, which the visitor controls. Anyone could dodge every per-IP rate limit (login codes, AI, top-ups) by sending a random header. | Use the **last** entry (the one our proxy added). |
| 5 | `server/routes/auth.js` (`checkCode`) | Wrong login-code tries were counted *after* the check, so parallel guesses all read "0 tries" and got past the 5-try lock (test saw 6+ guesses checked). The code was also marked used non-atomically. | The try is counted first with `update ... where attempts < 5 returning id`; marking used is `where used = false returning id`. Same messages and codes as before. |
| 6 | `server/migrations/002_safety_nets.sql`, `server/services/connections.js` | Two workspaces pasting the same bot token at the same moment both succeeded (the "taken" check and the insert were separate), and then fought over the bot's webhook. | New unique index `connections_one_live_bot` (one live row per bot). `connectBot` turns the unique-violation into the normal **409** `bot_taken`. |
| 7 | `server/routes/drips.js`, `server/services/drips.js` | Tags are stored lowercase, but a "tag" follow-up trigger was stored as typed (`VIP`), so tagging someone `vip` never started it. | Tag triggers are saved lowercase; matching for `tag` triggers is case-insensitive (covers rows saved before the fix). `start_tag` stays exact (Telegram payloads are case-sensitive). |
| 8 | `server/routes/subscribers.js` (CSV export) | Formula protection missed cells starting with a tab or carriage return (`\t=1+1`), and a `\r` inside a name was not quoted. | `'` prefix for `= + - @ \t \r`, and `\r` triggers quoting. |
| 9 | `server/routes/broadcasts.js`, `server/routes/admin/index.js` | `GET /api/links` and `GET /api/admin/overview` crashed with **500** (`syntax error at or near "day"`): `to_char(...) day` needs `as day` in PostgreSQL. | Added `as`. Response shape unchanged. |
| 10 | `server/services/broadcasts.js`, `server/routes/broadcasts.js` | The 6,000 limit on the message text counted JS string units, so 4,096 emoji (a valid Telegram message) were refused. | Rough guard raised to 20,000 units; the real limit is still `visibleLength()` (4,096 / 1,024 with media). Edits now refuse a blank body. |
| 11 | `server/services/broadcasts.js` (`next9`) | "9am local time" was sent at **9:01** when the job ran after hh:mm:30 (offset rounded from a time without seconds), and at 8:00/10:00 on DST-change days (today's offset used for tomorrow). | Offset computed with seconds, and re-computed for the target day. |
| 12 | `server/services/broadcasts.js` (`enqueue`), `server/workers/jobs.js` | **Double sending.** "Send now" inserted the broadcast as `scheduled` and then queued it; the broadcast job (every 5 s, on every server) could claim the same row in between and queue it again, so every subscriber got the message twice (likely with large audiences, where queueing takes seconds). Two clicks on Approve did the same. Test: two `enqueue` calls + two ticks at once queued 600 rows for 300 people. | `enqueue` claims the broadcast (`status -> sending where status in (scheduled, draft, pending_approval)`) inside its own transaction; a second caller gets nothing to claim and returns the first call's total. Plus a unique index `deliveries_once_per_broadcast` and `on conflict do nothing` as a last safety net. The tick no longer claims separately. |
| 13 | `server/workers/sender.js`, migration 002 | **Double sending between servers.** Batches were read with a plain `select`; the 30 s lease was only renewed between batches of 200, so a slow batch or a long 429 pause let the lease expire, another server took over and re-sent the same queued rows. | Batches are claimed with `update ... set status = 'sending' ... for update skip locked`; un-sent rows are put back; the lease is renewed every 5 s inside the batch and the runner stops if it lost it; rows stuck in `sending` (crashed server) return to the queue after 10 minutes. New status value `sending` (constraint updated). `broadcastsTick` treats `sending` rows as not finished. |
| 14 | `server/workers/sender.js`, `server/workers/jobs.js` | Maintenance mode ("pause all sending") did not pause anything already queued, nor follow-ups. | `sender.tick`, each sender batch and `dripsTick` stop while maintenance is on. Scheduled broadcasts are pushed back 5 minutes (as before). |
| 15 | `server/routes/broadcasts.js`, `server/workers/jobs.js` | With Broadcasts switched off in admin, drafts could still be sent (`/send`), approved (`/approve`), test-sent, and scheduled broadcasts still went out. | Those routes call `requireFeature('broadcasts')`; the job postpones scheduled broadcasts while it is off. |
| 16 | `server/routes/broadcasts.js` | A **drafter** could pin sent messages and cancel scheduled / going-out broadcasts (edit and delete were already owner/sender only). | Pin needs sender or owner; drafters may only cancel drafts and messages waiting for approval. |
| 17 | `server/services/bot-updates.js` | The join-request welcome was sent even when the trial had ended or maintenance was on (the follow-up job holds back in both cases). | Same "can send" rule as the follow-up job. |
| 18 | `server/services/billing.js` (`activate`), `server/workers/jobs.js`, `server/payments/index.js`, `server/routes/workspace.js` | **Double charging.** The billing job says it is safe on several servers, but trial conversion and renewal were not: two servers (or a top-up's auto-restart racing the customer's "start plan" click) both called `activate`, which charged again and moved the period. Test: two `billingTick()` at once charged $49 twice. | `activate(..., { expect })` re-checks the expected state after locking the workspace row and returns `{ skipped: true }` without charging. Trial: still a trial that ended. Renewal: still active, not cancelling, period over. Top-up restart: still paused. Routes answer **409** `plan_changed` if a click lost the race. `upgradeNow` refuses if the plan is no longer active. |
| 19 | `server/workers/jobs.js` | Trial-ending and low-balance reminder emails could go out twice with two servers; the cancel-at-period-end step could fire twice. | Conditional updates (`... where reminded_at is null returning id`, `... and cancel_at_period_end returning id`); only the winner sends. |
| 20 | `server/routes/workspace.js` (coupon), migration 002 | A coupon could be **reused** once its discount ran out: "already used" looked at `workspaces.coupon_id`, which is cleared when the months are used up. The same person could also redeem twice in parallel. | New `coupon_redemptions` table (primary key offer + user). Redeeming inserts there, bumps `uses` and sets the workspace in one transaction. |
| 21 | `server/services/media-files.js` (new), `server/workers/jobs.js`, `server/routes/auth.js` | Data purge after the retention period and account deletion deleted the media **rows** but left the uploaded photos/videos on disk forever. Purge also left saved audiences. | Files are unlinked first (only inside `UPLOAD_DIR`); purge also deletes segments. |
| 22 | `server/routes/wallet.js` | Two payments pasting the same crypto txid at the same moment: the loser hit the unique index and got a **500**. | Unique violation answers the normal **400** "already used"; the update also requires the payment to still be pending. |
| 23 | `server/routes/voosquare.js` | `GET /api/voosquare/summary?period=constructor` (or `toString`, `__proto__`) read `Object.prototype` and crashed with a **500**. | `Object.hasOwn` check; anything unknown means `1d` (as documented). |
| 24 | `server/services/support.js` | `before=<not a date>` on the support thread list (VooSquare API) sent `Invalid Date` to the database: **500**. | **400** with a clear message. |
| 25 | `server/routes/admin/catalog.js` | `PUT /api/admin/content/:key` without `value` crashed with a **500**. | **400** "Send the new text as value". |
| 26 | `server/routes/admin/users.js` | An **admin could suspend another admin** (only owners were protected), which also logs them out and cancels their broadcasts. The Team page already forbids acting on equal or higher ranks. | Same rank rule: non-owners can only suspend staff ranked below them. |
| 27 | `server/app.js`, `server/lib/router.js`, `server/routes/auth.js` | **Login CSRF.** The CSRF header was only checked for logged-in users, and the router accepts form-encoded bodies, so a hidden form on any site could log a visitor into the attacker's account (they might then paste their own bot token into it). | New route option `csrf: true` requires `x-cv: 1` even when logged out; set on `/api/auth/email/start`, `/api/auth/email/verify`, `/api/auth/telegram`. Both front-end API helpers (`public/js/api.js`, `public/admin/js/core.js`) already send it. |
| 28 | `server/routes/auth.js` (Google/VooSquare login) | **OAuth login CSRF.** The OIDC `state` was checked against the database but not tied to the browser, so a callback URL produced in the attacker's browser, opened by a victim, logged the victim into the attacker's account. | `/start` sets an HttpOnly `cv_oauth` cookie (path `/api/auth/`, 15 min) with the state; the callback requires it to match and clears it. |
| 29 | `server/routes/auth.js` (`/api/me/email/verify`) | A unique-email collision at save time would answer 500. | Answers **409** `email_taken` (defensive; hard to reach because codes are single-use). |
| 30 | `server/services/email.js` | **HTML injection in emails.** Template variables were put into the HTML unescaped. Names and workspace names are typed by users, and the team invite goes to any address, so `<a href="https://evil...">Verify your account</a>` as a name became a real link in a Castvoo-branded email (phishing). A value like `{{unsubscribe_url}}` was also expanded. | The HTML version escapes every value (and `{`/`}`); subject and plain text are unchanged. URLs still work (`&` becomes `&amp;`, correct in HTML). |
| 31 | migration 002 (indexes only) | **Launch-scale slowness.** No index on `deliveries.subscriber_id`, `sequence_runs.subscriber_id`, `clicks.subscriber_id`, `deliveries.step_id`, `links.broadcast_id/step_id`, or due queued rows. Measured with only 200k delivery rows: the daily-cap check for 2,000 subscribers took **22 s** (vs 50 ms) and deleting 1,000 subscribers **17 s** (vs 0.2 s): every FK check scanned all deliveries. At real volume a capped broadcast would hit the 30 s statement timeout and fail; purges and account deletions would stall; every block/stop scanned all follow-up runs. | Added `deliveries_subscriber`, `deliveries_step`, `deliveries_due`, `sequence_runs_subscriber`, `clicks_subscriber`, `links_broadcast`, `links_step`. Test `throughput.test.js › scale` (20k subscribers, 200k deliveries, 5k clickers) fails without them and passes in about 6 s with them. |

## API behaviour the front-end should know about

No request or response shapes and no route paths changed. Only these behaviours are new:

- `POST /api/auth/email/start`, `/api/auth/email/verify`, `/api/auth/telegram` now require the `x-cv: 1` header (403 `csrf` without it). `public/js/api.js` and `public/admin/js/core.js` already send it on every non-GET request.
- Google / VooSquare login sets a short-lived `cv_oauth` cookie on `/start`; the callback must happen in the same browser.
- New error `409 plan_changed` from `POST /api/app/plan` when another action changed the plan a moment before (show "refresh and try again").
- Drafters now get 403 on `/api/broadcasts/:id/pin` and on cancelling broadcasts that are scheduled or going out.
- `/approve`, `/send` (draft) and `/test` answer 403 when Broadcasts is switched off, and 503 in maintenance mode.
- A broken `%` escape in a URL gives 400 `bad_url` instead of 500.
- Deliveries can now have status `sending` (in flight). Admin → System's queue counts only `queued`, as before.

## Risks I could not fix (or chose not to)

1. **Rate limits are per server and in memory.** With several servers each one allows the full limit, and a restart resets them. For strict limits (login codes, top-ups) move them to PostgreSQL or Redis.
2. **Admin switches take up to 15 s on other servers.** Settings are cached for 15 s per instance, so "maintenance" or "feature off" reaches other servers with a delay.
3. **One lane for every channel and group.** All channel/group posts for all customers go through the single `platform` queue at `TG_SEND_PER_SECOND` (25/s). At 100k users with many channels this will back up; consider sharding channel posts over several platform bots.
4. **At-least-once on crashes.** If a server dies after Telegram accepted a message but before it was recorded, the row stays `sending` and is re-sent after 10 minutes. Rare duplicates are possible only in that case.
5. **Lease takeover can briefly double one bot's rate.** If a server stalls for more than 30 s, another takes over; for up to 5 s both may send (different rows). Telegram may answer 429, which is handled.
6. **Tracked links redirect anywhere.** `/l/<code>` sends visitors to any URL a customer typed, so the Castvoo domain can be abused for phishing redirects. Consider a URL blocklist or abuse review.
7. **Team invites are not tied to the invited email.** Whoever has the link (24-byte random token) can join.
8. **Account deletion keeps support threads and messages**, which can hold personal data. Decide the policy (anonymise or delete).
9. **The VooSquare outbox flush holds one DB transaction while calling VooSquare** (up to 100 calls × 10 s timeout). During a VooSquare outage this ties up a pool connection for a long time.
10. **Real providers were not called.** All tests use fakes built from what the code expects (Telegram, Paystack, Flutterwave, Gatevoo, Resend, Anthropic, Google). Field names for Gatevoo especially should be checked against its real API before launch.
11. **Commission tiers count the converting workspace itself.** A referrer with 4 paying referrals earns 20% on the 5th one's first payment. Product decision; the test documents current behaviour.
12. **Migration 002 adds unique indexes.** It will fail on a database that already has the same bot live in two workspaces or duplicate broadcast deliveries. Fine before launch; check first if data exists.
13. Legal pages and admin-edited text are inserted as HTML without escaping. Only staff can edit them.
14. **Sending is at-least-once on a network timeout.** If Telegram receives a message but the answer is lost (20 s timeout), the delivery is retried up to 4 times, so that one subscriber can get it twice. Queueing itself is exactly once (each follow-up step is queued and the run advanced in one locked transaction; one delivery per broadcast and subscriber is enforced by a unique index).

## Running the tests

```
npm test                                  # everything, one file at a time (about 1–2.5 minutes)
node --test test/e2e/broadcasts.test.js   # one file
node --test --test-name-pattern="coupon" test/e2e/billing.test.js
```

Each test file starts its own throwaway PostgreSQL (`test/helpers/pgserver.js`), a fake for every outside
service (`test/helpers/fakes.js`) and the real Castvoo server in-process (`test/helpers/app.js`). Background
jobs are called directly (`app.jobs.billingTick()`, `app.drain()` for the sender) so tests are deterministic.
Everything is stopped and deleted after each file, also when a test fails or the run is interrupted (Ctrl+C).

## Fixes from the independent pre-launch review

| # | Where | Problem | Fix |
|---|---|---|---|
| R1 | `payments/index.js`, wallet | Manual crypto: two customers sending the same amount could not be told apart; Bitcoin amounts can't be matched exactly | Manual mode is USDT only; each top-up gets its own exact amount (+1–99 unique cents) |
| R2 | `payments/index.js` | Gatevoo invoice was not checked against our order and paid amount | `order_id` must equal our reference and the paid USD must cover the top-up |
| R3 | `admin/money.js` | Approve could credit card or Gatevoo payments by hand, or crypto with no txid | Approve only for pending manual crypto with a txid |
| R4 | `jobs.js`, `billing.js` | Yearly plans got their AI writes only once a year | Refilled every 30 days; the refill date is shown |
| R5 | `routes/broadcasts.js` | Editing while sending mixed old and new text | Blocked until sending finishes |
| R6 | `routes/drips.js`, migration 004 | Editing a follow-up replaced its short links (sent buttons broke) and button order was random | Links keep their codes and a `position`; removed ones keep redirecting |
| R7 | `connections.js` | Pasting the same bot again (new token) was refused | Reconnects in place; subscribers and follow-ups kept |
| R8 | site, emails, Cas | "9am in each subscriber's own time" was not true | Says "9am in your workspace time zone" everywhere |
| R9 | `Dockerfile`, `index.js` | Uploads could fail on a root-owned Railway volume | Runs as root, `UPLOAD_DIR=/data/uploads`, startup write check |
| R10 | drips, tags, audiences | Drafters could switch/delete follow-ups and change tags | Blocked for drafters (API and UI) |
| R11 | `platform-bot.js`, migration 004 | One channel could be connected to two workspaces | One live workspace per channel; the bot no longer leaves a chat another workspace uses |
| R12 | `connections.js` | Member counts refreshed only the first 200 chats | Refreshed in turns, oldest first |
| R13 | `jobs.js` | Sales emails looked at 500 users only, and two servers could double-send | Pages through everyone; one server at a time (`job_locks`) |
| R14 | admin overview | Old exchange rates went unnoticed | Warning when a rate wasn't updated for 7 days |
| R15 | `routes/auth.js` | Per-IP login limits too low for shared mobile IPs | 150 code requests / 300 logins per IP per 10 minutes |
| R16 | refunds, Paystack disputes | Refunded or disputed money still paid referral commission | Unsettled earnings from that customer are reversed |
| R17 | `billing.js`, pricing copy | Channel members counted toward the plan, though a channel post is one message | Only bot subscribers count |
| R18 | admin settings | Any finance/admin could change the crypto address | Owner only |
| R19 | `oidc.js` | Google email trusted without an explicit "verified" | Must be `email_verified: true` |
| R20 | `ai.js` | Full instructions paid for on every call; provider error text shown to users | Prompt caching on the shared part; errors logged, users see a plain message |

## Added after the review

| What | Where |
|---|---|
| Home-page story: tired seller vs relaxed seller, and the chat that plays like a video | `public/index.html` (#story), `public/js/site-story.js`, "Story" block in `public/css/castvoo.css` |
| Personal messages: `{name}` becomes each bot subscriber's first name (`{name\|friend}` sets the word used when there is no name) | `server/services/telegram.js` (`personalize`), `send.js`, `workers/sender.js`; composer "👤 Name" button; tests in `test/e2e/personal-names.test.js` |
| Admin → Users: "Total spent" column, "Top spenders" sort, and a money strip on each user (total spent, paid in, spent on plans, refunded, wallet) | `server/routes/admin/users.js`, `public/admin/js/people.js`, migration `005_spend.sql`; test in `test/e2e/admin-spend.test.js` |

## Voo Connect and audit, October 2026

VooSquare connection through the Voo Connect kit (`voo-connect/`, details in [INTEGRATIONS.md](INTEGRATIONS.md)), and
fixes from a security, billing and scheduler audit. Tests: `test/e2e/voo-connect.test.js`, `test/e2e/voo-connect-hub.test.js`
(real VooSquare), `test/e2e/audit-fixes.test.js`.

| # | Where | Problem | Fix |
|---|---|---|---|
| V1 | `services/voosquare.js` | Event ids were random, so a retry or a second run counted money twice in VooSquare | Stable ids (`cv_pay_<wallet_tx id>`, ...), a unique index on the outbox, sent through the kit |
| V2 | `services/auth.js` | A `plan_started` event without plan or price was sent for every free trial (VooSquare refuses it) | Removed; plan_started is sent for the first PAID plan, with plan and price |
| V3 | `services/billing.js` | `spend` was the full plan price, including bonus credit that was never paid, and sent after the transaction | `spend` = cash part, queued in the same transaction; plus `plan_started` / `plan_renewed`, upgrades, `wallet_topup` |
| V4 | refunds, disputes | No `refund` / `chargeback` events, so affiliate commission on disputed money was never reversed | `refund` (commission stays) and one `chargeback` per plan payment that used the disputed top-up (FIFO), with `original_event_id` |
| V5 | `routes/workspace.js` | `plan_cancelled` was sent when renewal was switched off (and again when it ended), even if it was switched back on | Sent once, when the plan really ends |
| V6 | `lib/oidc.js`, `routes/auth.js` | VooSquare login: `id_token` not verified, no affiliate hand-off, callback not at the registered `/auth/voosquare/callback` | The kit's login: signed state, verified `id_token`, `prompt=signup`, `ref`/`vclick`/`coupon` hand-off, launcher `return_to` |
| V7 | `services/auth.js` | A VooSquare login joined any account with the same email, verified or not | Linked only when the email is verified on both sides, or from Settings → Connect |
| V8 | `routes/pages.js` | Castvoo referral links used `?ref=`, the same name as VooSquare's affiliate code | `?cvref=` |
| A1 | `app.js` | Ids or numbers the database cannot read (`?connection_id=abc`, `1e20`) answered 500 | 400 `bad_value` |
| A2 | `lib/util.js` (`safeEqual`) | Two empty values compared equal: a bot connection with an empty webhook secret accepted updates with no secret header | Empty never matches |
| A3 | `workers/jobs.js` | Renewal switched off during the trial was ignored: the plan started and the wallet was charged at the end of the trial | The trial ends without a charge (status cancelled) |
| A4 | `services/auth.js` | Team members added by an admin stayed "email not verified" after logging in with an emailed code | Code login marks the email verified |
| A5 | `routes/voo-connect.js` | (new code) "Connect your VooSquare account" must not be startable from another website | A POST with our `x-cv` header; a plain Voo ID login while someone is logged in switches account, never links |
| A6 | `routes/media.js`, `services/media-files.js` | No storage limit: one account could fill the shared disk (60 × 50 MB every 10 minutes); unused uploads kept forever | 2 GB / 1,000 files per workspace; uploads no message uses are removed after 3 days |
| A7 | `app-connect.js`, `app-drips.js` | Names with `&` or `<` showed as `&amp;` in the Remove / Delete questions (escaped twice) | Escaped once |
| A8 | Admin → System | Refused VooSquare events were counted as "waiting" | Shown separately ("refused by VooSquare") |
| A9 | Admin → Payments | The chargeback route existed but had no button, so non-Paystack disputes could only be recorded through the API | **Chargeback** button on paid Flutterwave / Gatevoo / crypto top-ups (reason required, once per payment); disputed top-ups show "Charged back <date>" |
| A10 | `config.js` (`TRUST_PROXY`) | Trusted `X-Forwarded-For` by default everywhere; without a proxy in front, a visitor picks their own IP and dodges every per-IP limit | Default on only when `RAILWAY_ENVIRONMENT` is set (like VooSquare); `TRUST_PROXY` still overrides |
| A11 | `services/support.js` | The copy of a Help message for VooSquare's inbox was queued fire-and-forget, so a flush right after could miss it (flaky test, a 10 s delay in production) | Queued before the request answers |
| A12 | tests | `admin.test.js` did not list the new chargeback route; `public.test.js` still expected `?ref=` from `/r/<code>` (V8 changed it to `?cvref=`) | Both updated |

### How the connection was proved (October 5, 2026)
- `npm test` twice in a row, all green; `npm run check` all passed.
- `test/e2e/voo-connect-hub.test.js` against a fresh copy of the **current** VooSquare (`VOOSQUARE_DIR=<copy>`).
- Playwright, Castvoo on 4862 and VooSquare on 4861: affiliate link → Castvoo landing (`ref`, `vclick` kept) →
  Continue with Voo ID (`prompt=signup`) → VooSquare sign-up → back in Castvoo, logged in → attribution in VooSquare
  → mock Paystack top-up → Growth plan from the wallet → `wallet_topup` + `spend` + `plan_started` in VooSquare →
  RevShare commission → refund (commission stays) → Paystack dispute (clawback of exactly that commission) → log out
  everywhere → 390 px: login with the same Voo ID; no horizontal scroll; no console errors. `check.js`: 12/12 PASS.
- Every customer and admin page at 1440 and 390 with hostile names (`<img onerror>`) in every field: no overflow,
  no console errors, no script ran.


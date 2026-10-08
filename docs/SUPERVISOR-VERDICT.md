# Castvoo: supervisor go/no-go verdict

Commit checked: **bfb35bc** ("Fix supervisor findings") on master. The first review was of **cecfa9b**; the re-check of my own findings N-1 to N-5 is in section 0. My copy is `/home/claude/sup`, which I did not change. Baseline for the upgrade test: **05c5e5a** (worktree `/home/claude/sup-base`).
Date: 8 Oct 2026. I did all of these checks myself. My scripts are in `/home/claude/sup-work/` and my screenshots are in `/home/claude/review/supervisor-shots/`.

---

## VERDICT: SAFE TO DEPLOY AFTER THESE STEPS

There are no blocking code defects left. The upgrade-blocking volume problem (N-1) is fixed, and I re-tested it on a baseline database. **The upgrade no longer needs a manual marker step, and `ALLOW_NO_VOLUME` must NOT be set.** The steps left are configuration and live tests that only the owner or developer can do.

**Before deploy (required):**
1. Check that the Railway volume is attached at **/data** (`UPLOAD_DIR=/data/uploads`). Download a PostgreSQL backup and turn on volume backups.
2. Add **`VOO_SERVICE_KEY`** (`openssl rand -hex 32`, different from `VOO_API_KEY`). VooSquare must send it on the staff sync, which otherwise answers 401. Summary and the support desk keep working with `VOO_API_KEY`.
3. Leave `APP_SECRET`, `NODE_ENV=production` and the `https://` `APP_URL` as they are. Do **not** set `ALLOW_NO_VOLUME`.

**Right after deploy (required, same day):**
- The logs show `migrations applied` (008 to 015) and `Castvoo is running`. One warning line, `uploads volume marker was missing; existing files found, marker written`, is normal.
- `/health` answers ok. Log in to `/admin` with the OWNER_EMAIL **email code**.
- Open one old payment proof screenshot and one old photo in admin, to prove the volume survived.
- Live tests:
  - a real Telegram bot and join request, including the Free line;
  - live **Paystack, Flutterwave (never tested by QA) and Gatevoo** top-ups, each credited once;
  - a manual top-up approved by a different staff member;
  - a **real AI key quality pass** in Admin → Support AI → Sandbox;
  - VooSquare login, one affiliate sale, and a staff sync with the new key;
  - real Android and iPhone, including guide video playback.
- Get **written confirmation from VooSquare** that the `plan_started` / `plan_renewed` events pay no second commission.

The full step-by-step list is in `docs/DEPLOY-NOTES-OCT-2026.md`. I checked it and it is accurate. A plain-words copy is in section 8 below.

---

## 0. Re-verification of the supervisor's findings (commit bfb35bc)

| ID | Fix | How I checked | Result |
|---|---|---|---|
| **N-1** (High) | `server/lib/volume-check.js` runs **before** `db.migrate()`. A missing marker plus files in the folder means an existing volume: it writes the marker, logs a warning and starts. An empty folder with database references gives a refusal in production. A missing table or column on an old schema counts as 0. | `sup-work/upgrade2.js`, against a baseline-created DB with real data and an upload file on the volume, in production with the Railway variables. **A:** no marker, folder has files: migrations 008 to 015 applied, marker written, healthy. **A2:** second start is idempotent. Data intact: payments, members, subscribers, media, messages and ledger all equal; wallets equal. **C:** after the upgrade, the DB lists a media row and a payment proof, and the volume is replaced by an empty one: **refused** ("database lists 2 saved files"), no marker written. With `ALLOW_NO_VOLUME=true` it starts. **B:** a baseline (007) DB with a media row and an empty volume is **refused before migrating** (`schema_migrations` still 7, ending at 007). **D:** fresh DB and fresh volume: 001 to 015 applied, marker written, second start clean. | **Verified fixed** |
| N-2 (Low) | `link()` keeps `voo_linked_at` when the same `voo_id` is linked again (`case when voo_id = $2 then coalesce(voo_linked_at, now()) else now() end`; the SET reads the old row value). A new test is in `voo-connect.test.js`. | Code read, and the test passes in the full run. | **Verified fixed** |
| N-3 (Low, test) | Rows are put at `date_trunc('hour', now() - 2 min) - 30 min`. | Checked against the rollup window `[trunc(now)-3h, trunc(now-2min))`: at hh:01 the rows are at hh-2:30, which is inside the window; at hh:30 they are at hh-0:30, also inside. | **Verified fixed** |
| N-4 / AUD-18 (docs) | LAUNCH-CHECKLIST: 511 tests, +$60 bonus, the Free plan, trial with 50 AI writes and 3,000 joins then Free, `VOO_SERVICE_KEY`, the volume marker explanation, and the VooSquare commission confirmation. New `docs/DEPLOY-NOTES-OCT-2026.md`, and DEPLOY-RAILWAY §6 rewritten. | Compared with `seed.js` (trial `ai_writes: 50, join_requests: 3000, on_end: 'free'`; bonus 6000 cents at $1,000), `.env.example` and the new volume code. | **Verified fixed** |
| N-5 (Info) | The renew toggle is locked (`dataset.asking`) while the confirm box is open. | Code read. | **Verified fixed** |
| Extra (SEC-7) | An admin **Links** tab in the user detail can switch off a link (`/api/admin/users/:id` now returns `links`). | Code read; covered by the test run. | Done (not re-tested in the browser) |

**Gates on bfb35bc:** `npm run check` **PASS** (all checks). `npm test` **511 / 511 pass, 0 fail** (one full run, as asked).

---

## 1. Build gates

| Gate | Result |
|---|---|
| `npm run check` | **PASS**: 144 files, 36 email templates, 6 legal pages, 54 env vars, 209 routes, 291 migration statements |
| `npm test`, run 1 | **504 / 505**. One failure: `voo-connect.test.js:327` "drip_step_sent". It ran at about 18:00:20 UTC (see N-3). |
| `npm test`, run 2 | **505 / 505 pass**, 0 fail |

**About the run-1 failure:** the failure is in the test, not the product.
- The test inserts deliveries at `date_trunc('hour', now()) - 30 min`.
- The rollup only counts rows before `date_trunc('hour', now() - 2 min)`.
- So in the **first 2 minutes of every hour** the rows fall outside the window, and the test fails. That is roughly a 3% chance on any run.
- The product behaviour (waiting 2 minutes after the hour) is intended. ENG-REPORT said this test was "not flaky", which is wrong.

---

## 2. Verification of fixes

"Repro" means my own script against a live app on port 3401 (`sup-work/repro.js` for the API, `sup-work/browser.js` for Playwright). I wrote the scenarios to differ from the engineers' tests: more concurrency, other code paths, and the `upgradeNow` path.

### High / Blocker findings

| ID | What | How I checked | Result |
|---|---|---|---|
| SEC-1 | Removed teammate keeps AI-support access | **Repro, 3 cases.** (1) The teammate is removed after the thread exists, then writes again: a new thread is made in their own workspace, the tools run only on their own workspace, nothing of B leaks (wallet, bot name), B's webhook is not touched, and the old B thread is not visible. A stale `x-ws` header falls back to a workspace they belong to (`currentWorkspace` is filtered by membership). (2) A message is queued while still a member, then they are removed before the tick: 0 tools and 0 model calls. (3) A drafter asks for `repair_webhook`: `not_allowed`, and setWebhook is not called. | **Verified fixed** |
| ENG-1 | fd leak on aborted video and Range requests | **Repro:** 40 aborted downloads (full and Range) across all 8 videos: fds 60 → 60. A Range request still returns 206. There is no `.pipe(` left in `server/`; everything goes through `sendFile()`, which uses `pipeline`. | **Verified fixed** |
| ENG-2 | Dedupe query has no index; meter recount; no retention | **Repro:** with 200k rows in `join_requests`, EXPLAIN uses `Index Scan using join_requests_recent`. The meter is one atomic counter row (see ENG-26). The retention code is in `cleanupTick` (read). | **Verified fixed** |
| QA-1 | Telegram-login user stuck on "add your email" | **Playwright, 390 and 1280.** I logged in with Telegram only, went to Top up, and got the email form. After Send code, the button comes back. After a wrong code, the error shows and Verify comes back. Resend works. The right code starts Paystack (1 initialize call). | **Verified fixed** |
| QA-2 | Buttons stuck on "Saving…" | **Playwright:** Save profile and Save workspace both come back on success. Save audience comes back on a forced 500. I also read every `e.currentTarget` in `public/js`: each one is read before any await, and `busy()` resets the button in `finally`. | **Verified fixed** |
| AUD-1 | Double commission (Castvoo referral plus VooSquare affiliate) | **Repro on the `activate` and `upgradeNow` paths.** VooSquare first: 0 Castvoo earnings, 2 `spend` events, `commission_to=voosquare` on both payments. Castvoo first: 2 earnings and **no** `spend` event (only `plan_started`). I read the code for the net-of-fee base and the 50% / 35% caps (`payCommission`), and the engineers' test covers them. | **Verified fixed** (see N-2 for one edge case) |
| AUD-2 | Privacy under-discloses OpenRouter, OpenAI and VooSquare | Read `privacy.html` §6: OpenRouter and OpenAI are listed as optional, and the VooSquare support-inbox copy (name and email) is described. | **Verified fixed** |
| AUD-3 | "tag_branching" sold but does not exist | No code references it. Migration 013 removes `tag_branching` and `csv_export` from existing plans. `check.js` fails if a plan lists a feature no code uses. | **Verified fixed** |

### Medium findings: security, billing and money

| ID | What | How I checked | Result |
|---|---|---|---|
| SEC-3 / ENG-17 | Approve vs reject race | **Repro:** 12 rounds of 2 approves (one with an amount override) plus 1 reject, sent at the same moment by 3 finance users. Every round ended consistent: 6 paid with exactly one topup tx and the right wallet, 6 rejected with wallet 0, and exactly one 200 per round. A late approve after a reject gives 400. A direct `credit(ref, {allowFailed:true})` on a rejected payment gives `refused: rejected`. | **Verified fixed** |
| SEC-11 | Self-approval | **Repro:** a finance user approving or charging back a top-up of their own workspace gets 403 on both. | **Verified fixed** (a second reviewer above a threshold is not built) |
| Double credit | Concurrent confirmations | **Repro:** 6 Paystack webhooks, `/pay/return` and 2× `/api/wallet/check`, all at once: wallet 3000 (one credit), 1 topup tx, 1 receipt email. | **Verified fixed** |
| SEC-2 | Self-referral pays commission | **Repro:** a Gmail alias (`jo.hn…@gmail.com` and `john…+cv@googlemail.com`) is held as "same email mailbox". The balance is 0 available, and a withdraw attempt gives 400. The same Telegram username is held. A genuine referral is paid (not held). The engineers' test covers the IP signal. | **Verified fixed** (no device cookie, by design) |
| SEC-4 | Prompt injection through the name | Read: `cleanName()` strips Cc/Cf/Co/Cs and folds all `\p{Z}` whitespace. The prompt carries `First name: "<json>"`, capped at 30 characters. | **Verified fixed** |
| SEC-5 | AI calls that fail are not counted; in-memory limits | Read `routes/ai.js`: after a paid call, `<kind>_failed` usage is logged and the writes are kept. Shared limits use `rate_buckets` in PostgreSQL (the test checks this). | **Verified fixed** |
| SEC-6 / ENG-5 | `/api/drips` bypasses flow limits | Read: `join_request` sequences go through `cleanFlow`, `assertCanGoLive` and `liveClash`, and a PUT on a builder-only flow gives 409 `edit_in_flows`. The test covers it. | **Verified fixed** |
| ENG-26 | Meter overshoot under parallel webhooks | **Repro:** 60 parallel join requests on a plan with a limit of 20 + 10%: exactly **22** welcomed, counter = 60, 60 rows, all 60 approved. | **Verified fixed** |
| ENG-4 / AUD-14 | Free rules not applied at send time | Read `freeWelcome()`. **Repro (browser run):** a Free flow's welcome went out with `⚡ Free welcome bot by Castvoo.com` and the `/r/` link. | **Verified fixed** |
| ENG-7 / ENG-8 | Support-AI double reply; one job at a time | Read the lease and heartbeat check before posting, and the concurrency of 4. The tests cover "lost lease posts nothing" and "parallel". | **Verified fixed** (code + tests) |
| ENG-9 | Trial requests counted against Free | Read `meterStart`, which uses `dropped_at` and `trial_ends_at`. The test covers it. | **Verified fixed** |
| ENG-23 | Missing volume not detected | **Repro:** in production on Railway with no volume, the app refuses to start (intended). An empty replacement volume is refused before migrating (re-checked on bfb35bc, section 0). | **Verified fixed** (after N-1) |
| AUD-5 | Chargeback does not debit the wallet | Read `payments.chargeback()` and `disputeWon()`. The test asserts −4900 wallet, a drop to Free, and the money put back once. | **Verified fixed** |
| AUD-6 | Retention contradicts itself; warning email | Read `inactiveFreeTick()`: first warning, last warning, then purge; the test covers it. The legal pages agree. | **Verified fixed** |
| AUD-8 | Downgrade keeps extra flows | Read `trimFlows()` in `activate`, plus the `keep_flows` picker. The test covers it. | **Verified fixed** |
| AUD-4 | Win-back never reaches trial users | Read `salesBatch` (Free + `dropped_at`, day 8 and day 14). | **Verified fixed** (code read) |
| AUD-10 | Scale ETA too aggressive | Read `support-hours.js`: 4 business hours, 8am to 10pm WAT. | **Verified fixed** |
| ENG-15 | AI replies in threads a human handles | **Upgrade repro:** the baseline thread with a staff reply became `ai_paused=true, reason=staff_reply`. The thread without one stayed active. | **Verified fixed** |
| ENG-19 | Paused workspaces not moved to Free | **Upgrade repro:** the paused Starter became `free`, with `dropped_from=starter`. | **Verified fixed** |

### Low findings spot-checked (14)

| ID | Check | Result |
|---|---|---|
| ENG-18 | Migration 013: `payments_proof_ref_open ... where status in ('pending','paid')` | Verified fixed |
| ENG-20 | `send.js` uses `link_preview_options` when the footer is present | Verified fixed |
| ENG-21 | Meter alert key built from `meter.since` | Verified fixed |
| ENG-27 | Truncated invite-link match in `flows.js` | Verified fixed |
| ENG-28 | Each migration file in its own transaction, with `statement_timeout=0` and `lock_timeout=10s`; the upgrade ran cleanly | Verified fixed |
| SEC-9 | Account deletion calls `purgeRows(..., {members:true})` | Verified fixed |
| SEC-13 | `Sec-Fetch-Site` confirm page plus `POST /logout`; `/pay/return` only for pending top-ups under 24 h | Verified fixed |
| SEC-19 | `escHtml(err.message)` on the error page | Verified fixed |
| QA-5 | Browser: the guide player closes when you leave the page | Verified fixed |
| QA-10 | Browser: "1 hour" / "2 hours" | Verified fixed |
| QA-15 | `publicStaffName()` shows "Castvoo team" for a staff account with no name | Verified fixed |
| QA-23 | Throughput limit is 20 s (env override) | Verified fixed |
| AUD-17 | Cookie policy and PRODUCT-FACTS list every cookie, including `cv_vis` | Verified fixed |
| AUD-18 | LAUNCH-CHECKLIST now says $1,000 → +$60 (bfb35bc) | Verified fixed |

---

## 3. Production upgrade path

> These results are from the first review (cecfa9b). On **bfb35bc** the N-1 row is fixed: the upgrade starts with no manual step. The re-run is in section 0.

Script: `/home/claude/sup-work/upgrade.js`. These steps ran in order:
1. The **baseline server** (05c5e5a) started on a fresh database, ran migrations 001–007, then stopped.
2. I added production-like rows: a paid Growth workspace (wallet plus bonus), a trial, a paused Starter, a referred paying Starter with a pending manual-crypto payment, a teammate, a bot and a channel, two live join-request sequences on one chat plus a start sequence, subscribers and runs, an uploaded photo (a `media` row plus the file on the volume), support threads (one with a staff reply), a paid Paystack payment, wallet_tx, a referral earning and a session.
3. The **new code** started on that database with `NODE_ENV=production`, Railway variables and fake live keys.

| Step | Result |
|---|---|
| Migrations 008 → 015 | Applied cleanly, in one start |
| Data intact | Same wallets, bonuses and `ai_used`; payments unchanged (the paid one stays paid, the pending one stays pending); members, subscribers, media, messages and the referral ledger are all the same |
| Expected changes | Paid Growth is grandfathered (`legacy_plan_code=growth`, `legacy_ai_writes=2000`); the paused workspace moved to Free; the duplicate live join flow was switched off; `approve_join` became `after_welcome` / `manual`; the staff-reply thread was paused; `referred_at` was backfilled; plans Free / $19 / $49 / $99 |
| First production start on an existing volume with uploads | **FAILS (N-1):** `setup problem: The uploads folder … is empty but the database has 1 saved files`. Exit 1, **after** the migrations ran. |
| Same start with `ALLOW_NO_VOLUME=true` once | Starts, writes the marker; later starts without the variable work |
| Second start | Idempotent: no migrations, `/health` returns 200 `{"ok":true}` |
| Production on Railway with **no** volume | Refuses to start (intended) |
| Fresh database, new code, production, twice | 001–015 run on the first start, nothing on the second; healthy |
| Rollback: the baseline code restarted on the migrated database | Starts and serves `/health`. It re-inserts the harmless `login_google` flag. The new code starts again afterwards. |

---

## 4. Deploy readiness

| Item | Finding |
|---|---|
| Dockerfile | Sound: `node:22-slim`, no npm install (no dependencies), copies `server`, `voo-connect`, `public` (the 8 videos and captions are included and not excluded by `.dockerignore`), `check.js`, PRODUCT-FACTS and `.env.example`. `UPLOAD_DIR=/data/uploads`, CMD `node server/index.js`. I could not run docker here. |
| railway.json | Builder DOCKERFILE, `/health` healthcheck, 1 replica, overlap 20 s, draining 15 s. The safety exit is 12 s, which fits inside the 15 s. |
| /health | Returns 200 `{"ok":true,"time":…}` |
| Production start with fake keys | Starts. The only warning is the platform webhook setup failing on the fake token, which is caught. It refuses to start only when there is no volume, or (N-1) when the marker is missing. |
| Videos served | `/videos/*.mp4` returns 206 for a Range request, and the player opens in Chromium |
| `.env.example` | Documents `VOO_SERVICE_KEY` (inbound only, required for staff sync, must differ from `VOO_API_KEY`), `LINK_WARN_NEW_DAYS`, the AI keys and provider, `AI_TIMEOUT_MS` / `AI_RETRIES`, `RAILWAY_VOLUME_MOUNT_PATH` and `ALLOW_NO_VOLUME`. `check.js` confirms all 54 variables are documented. |
| docs/DEPLOY-RAILWAY.md | Accurate on the volume (it lists everything stored there and says it needs backups), the marker, shared rate limits and one replica. In bfb35bc §6 explains the marker logic correctly. |
| docs/LAUNCH-CHECKLIST.md | **Fixed in bfb35bc** (section 0). Was stale at cecfa9b (N-4): it says "313 tests" (now 505), "$1,000 → +$100" (now +$60), "Trial: 7 days, Growth, 100 AI writes" (now 50 AI writes and 3,000 joins, then Free), the pricing line leaves out the Free plan, and it says "four VOO_* variables" with no mention of `VOO_SERVICE_KEY` or the staff-sync key change. |

---

## 5. Owner requirements smoke test (browser, 390 px and 1280 px)

All PASS at both widths. There were **0 page errors** and **no horizontal scroll** on Overview, Flows, Wallet, Help, Guides, Settings, Bots, Subscribers or Earn. The screenshots are in `supervisor-shots/` (`*-390.png` and `*-1280.png`).

| Requirement | Evidence |
|---|---|
| Welcome Flows builder | From scratch: welcome, then 4 × (wait + message), so 9 blocks. Waits of 1–4 hours, labelled "hour" / "hours". A "Join VIP" link button was added. Saved with status 200: 5 steps with delays 0/60/120/180/240 minutes, and the button is stored as a tracked link. (`flows-builder`, `flows-saved`) |
| Free plan branding line | A real join request on a Free flow sent "Hi Bo, welcome! ⚡ Free welcome bot by Castvoo.com" (with the `/r/` link). (`free-flows`) |
| AI support chat | The "24/7 customer support" label, cartoon faces (8 images), a "Powered by Replyvoo" link to replyvoo.com in a new tab, an image upload (1 attachment saved), and an AI reply shown with the agent's name. (`help-chat`) |
| Guides videos page | 8 video guides; the player opens and the video streams (206); it closes when you leave the page. (`guides`, `guide-player`) |
| No Google login | No "google" text on the website, login, signup, settings or admin (fonts excluded); `/auth/google` returns 404. (`login`, `signup`) |
| Admin adds a payment method | Admin → Countries & payments → Add: created `gtbank_transfer_*` as an active bank method. (`admin-add-method-form`, `admin-methods`) |
| Pricing page | Free / Starter $19 / Growth $49 / Scale $99, 500 free joins and the 24/7 label are visible. (`pricing`) |

---

## 6. New defects found by the supervisor (first review, cecfa9b; all fixed in bfb35bc)

### N-1 · High · The volume marker check refuses a correct upgrade · **FIXED in bfb35bc (section 0)**
- **Where:** `server/index.js:42-54`. The check runs **after** `db.migrate()`. If `.castvoo-volume` is missing and `payments.proof_path` or `media` has rows, the app exits in production. Only the marker's existence is checked, so the message's claim that the folder "is empty" is never actually tested. The baseline never writes this marker, so every existing volume lacks it.
- **Reproduce:** `node /home/claude/sup-work/upgrade.js`. Start the baseline, add one `media` row with its file on the volume, then start the new code with `NODE_ENV=production RAILWAY_ENVIRONMENT=production RAILWAY_VOLUME_MOUNT_PATH=<vol>`. Result: exit 1, `"The uploads folder (…/uploads) is empty but the database has 1 saved files…"`. The schema is already migrated to 015 by then.
- **Impact:** the deploy fails its health check, and Railway keeps the **old** code running on the **new** schema. The baseline does start on it, but this state was never meant to run. Restarts loop 10 times.
- **Workaround (deploy step 1):** `touch /data/uploads/.castvoo-volume` before the deploy, or `ALLOW_NO_VOLUME=true` for the first deploy only.
- **Proper fix (small):** run the marker check before the migrations. Treat "marker missing but the upload folder holds files" as healthy and write the marker; refuse only when the folder is really empty. Document it in DEPLOY-RAILWAY.

### N-2 · Low · **FIXED in bfb35bc** · Re-linking the same VooSquare account resets `voo_linked_at`, which can flip commission attribution
- **Where:** `server/services/auth.js:159` (`link()` sets `voo_linked_at = now()` even when `voo_id` is already the same).
- **Reproduce:**
  1. A customer has a Castvoo `referred_by` and a VooSquare `voo_ref`, and VooSquare came first, so attribution is `voosquare`.
  2. While logged in, the customer presses "Connect VooSquare" again with the same Voo ID.
  3. `voo_linked_at` moves to now, `attributionOf()` returns `castvoo_referral`, and the next plan payment pays the Castvoo referrer instead of the VooSquare affiliate.
- **Fix:** `voo_linked_at = coalesce(voo_linked_at, now())`.

### N-3 · Low (test only) · **FIXED in bfb35bc** · `voo-connect.test.js` "drip_step_sent" fails in the first 2 minutes of every hour
- **Reproduce:** run `npm test` so that this test runs between hh:00:00 and hh:02:00 UTC. That is what happened in my run 1 (`0 !== 1` at line 340).
- **Fix:** insert rows at `date_trunc('hour', now() - interval '2 minutes') - interval '30 minutes'`.

### N-4 · Low (docs) · LAUNCH-CHECKLIST is out of date · **FIXED in bfb35bc**
- It still has the wrong bonus (AUD-18, not fixed), the old test count, the old trial wording, no Free plan, no `VOO_SERVICE_KEY` or staff-sync key step, and no first-upgrade marker step. Details are in section 4.

### N-5 · Info · **FIXED in bfb35bc** · Wallet "Stop renewing" can open two confirm boxes
- **Where:** `public/js/app-money.js:63-66`. `pr.dataset.busy` is set only after `confirmBox` resolves, so a quick double tap opens two dialogs. It does no harm: the second one just repeats the same action.

---

## 7. Residual risks: what is not done or only partly done

**Not built, or partly built (from the reports, confirmed in code):**
- SEC-7: no Google Safe Browsing and no separate link domain (the admin switch-off is now in Admin → Users → Links).
- SEC-10: the dashboard confirmation was dropped on purpose. The protections are the stronger warning and the 7-day Unlink button.
- SEC-11: no second reviewer above a money threshold.
- SEC-2: no device-cookie signal. Self-referrals from a different IP, email, Telegram account and card are not caught.
- ENG-10: join requests are acknowledged and then processed **in memory**. On shutdown the app waits only 3 s, so a request in progress during a deploy can be lost. The person can ask again, and ENG-3 handles that. There is no media pre-upload when a flow is saved, and no progress UI for bulk approvals.
- ENG-24: the typing-delay timing test and the month-boundary tests are still timing-sensitive.
- AUD-11: fixed rounded local prices, the "no follow-up" upsell on Free, and the day-5 email are not built. These need an owner decision.
- AUD-10: there is no admin editor for `support_ai.team_hours` (the defaults apply).
- AUD-1: Castvoo cannot cap **VooSquare's own** affiliate rate. It also assumes VooSquare pays nothing on `plan_started` / `plan_renewed` events, which still go out when the Castvoo referral earns. **Confirm this with VooSquare.**
- QA-16: Viewer and Support can still open the read-only setup pages (only the wording was fixed).

**Never tested against the real services** (everything ran against fakes):
- the real Telegram Bot API (join requests, 5-minute window, link previews, invite links);
- live Paystack, Flutterwave (not tested at all by QA) and Gatevoo;
- the real Anthropic, OpenRouter and OpenAI responses and the quality of the support AI's answers;
- VooSquare SSO, events and staff sync;
- H.264 video playback with captions on a real phone (open-source Chromium cannot play H.264);
- drag-to-reorder in the flow builder.

---

## 8. Pre-deploy checklist for Ademola (plain words, for bfb35bc)

The same steps, in more detail, are in `docs/DEPLOY-NOTES-OCT-2026.md`.

**Before you press deploy**
1. In Railway, open Castvoo → Volumes. Check that a volume is attached at **/data**, and that `UPLOAD_DIR` is `/data/uploads`.
2. Download a PostgreSQL backup (Postgres → Backups → Backup now) and turn on daily backups. Turn on backups for the volume too.
3. **The volume marker needs nothing from you.** The new version writes it by itself. Do **not** set `ALLOW_NO_VOLUME`.
4. Add a new variable **`VOO_SERVICE_KEY`**. Make it with `openssl rand -hex 32`, and make it different from `VOO_API_KEY`. Send it to VooSquare for the staff sync.
5. Optional: `LINK_WARN_NEW_DAYS=7` (already the default).
6. Do not change `APP_SECRET`. Keep `NODE_ENV=production`, and keep `APP_URL` starting with https://.

**Deploy, then check straight away**
7. The logs show `migrations applied` (008 to 015) and `Castvoo is running`. One warning, "uploads volume marker was missing; existing files found, marker written", is normal. If you see `setup problem ... is empty but the database lists N saved files`, **stop**: the wrong volume is attached, or none is. Railway keeps the old version running, and the database has not been changed.
8. `https://castvoo.com/health` must show `{"ok":true}`.
9. Log in at `/admin` **with the email code** (OWNER_EMAIL).
10. Admin → Settings & connections → press **Test** on each service.
11. Open one old payment proof and one old photo in admin.

**Live tests (same day)**
12. A real Telegram bot: Welcome Flow, join request from a second phone, welcome, let in, Start, next message. Do it once on Free and check the Castvoo line is there.
13. Top up $10 with Paystack (live), $10 with Flutterwave (live; QA never tested it) and $2 with Gatevoo USDT. Each must be credited once, with one receipt. Then a manual bank top-up, approved by a different staff member.
14. AI support quality pass with the real key: Admin → Support AI → Sandbox, about 10 real questions. Then one real support message with a screenshot.
15. VooSquare: Voo ID login through an affiliate link, top up, start a plan. Check there is one sale and no double commission. Then a staff sync with the new key.
16. A real Android phone and a real iPhone, including one guide video with captions.
17. Get written confirmation from VooSquare that `plan_started` / `plan_renewed` events pay no second commission.

**Later (not blockers)**
18. A second reviewer for large manual payments, the `team_hours` editor, Safe Browsing for links, and a device signal against self-referrals.

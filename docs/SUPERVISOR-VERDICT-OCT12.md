# Castvoo Oct 12 release: supervisor go/no-go verdict

Commits reviewed (since fc1c974): **966108d** (subscriber packs for Scale, migration 029), **5b435eb** (iPhone shake fixes,
front-end only), **4a75e2e** + **799c64a** (repeating messages with rotating versions, voice notes and round videos with
ffmpeg conversion and browser recording, auto-delete, auto-pin, byte-range media previews, migration 030, Dockerfile
ffmpeg, `Permissions-Policy` camera/mic). Date: 12 Oct 2026. Team: bug hunter, security reviewer, Telegram-rules
auditor, billing/limits auditor (one pass each, findings merged below). Fixes are in the commit that adds this file.
Front-end files were not changed (another engineer is working on the guide videos); nothing found in the front-end
needed a change.

---

## VERDICT: SAFE TO DEPLOY: YES, with the conditions below

No blocking defect is left open. Three Medium findings (cancelling a message lost its auto-delete / unpin, deleting an
audience silently widened a repeating message to every subscriber, and ffmpeg could be steered by a crafted upload)
are fixed and covered by tests. Migrations 029 and 030 are additive and were re-run twice on a database that already
had packs, repeats, runs and auto actions: nothing changed.

**Conditions:**
1. Deploy this commit (not 799c64a alone): it contains the fixes SV-1 to SV-7.
2. Do the ffmpeg check from docs/DEPLOY-NOTES-OCT-2026.md after deploy: the logs show `ffmpeg ready` and Admin → System
   says "ffmpeg ready". The Railway image is Debian (node:22-slim, ffmpeg 5.1); the new input options used by SV-5
   (`-protocol_whitelist`, `-format_whitelist`, `-max_pixels`) exist there, but upload one voice note and one round
   video on the live site to be sure (a conversion error shows "We couldn't turn that ... into ...").
3. Run the live Telegram pass already listed in the deploy notes before announcing: voice note recorded on an iPhone
   (Safari) and on Android (Chrome), a round video with text (round video, then the text with buttons), a daily repeat
   for 2 days, a channel post with "Pin it" + "Unpin after 1 hour", a bot broadcast with "Delete after 1 hour". Add one
   step: start a bot broadcast with "Delete after 1 hour" to a few test accounts, press **Cancel** while it is going
   out, and check the copies that arrived are still deleted after an hour (SV-1).
4. Ask Ademola to confirm the Dockerfile build on Railway (the image grows by about 100 MB).

---

## 1. Gates

| Gate | Result |
|---|---|
| `node scripts/check.js` | **PASS** (all checks) |
| `npm test` (full suite, after the fixes) | **892 / 892 pass, 0 fail** (883 before + 9 new) |
| New regression tests | `test/e2e/supervisor-oct12.test.js`: **9 tests**. The 8 for SV-1 to SV-5 and SV-7 fail on 799c64a and pass with the fixes (checked by stashing the server changes); the migration test is coverage (passes on both). The existing test "voice notes and round videos work in Chat bot steps" failed about half the time on 799c64a (it was catching SV-7); it now passes every time. |

---

## 2. Findings fixed (by severity)

| ID | Sev | Area | What was wrong | Fix | Test |
|---|---|---|---|---|---|
| **SV-1** | **Medium** | Auto-delete / pin | Cancelling a message while it was going out marked **every** queued delivery of it as skipped, including the auto-delete, pin and unpin of the copies that had already reached people; and the sender skipped any delivery of a cancelled message. So "Flash sale, delete after 1 hour" + Cancel left the delivered copies up for good, and "Pin it, unpin after 1 hour" left them pinned forever. | Cancel only skips the sends not yet made (`action = 'send'`). The sender skips only `send` / `edit` deliveries of a cancelled message; its delete / pin / unpin still run. | SV-1 |
| **SV-2** | **Medium** | Repeating messages | `repeat_series.segment_id` is `on delete set null`. Deleting an audience used by a repeating message silently turned every later run into a message to **all** of the bot's subscribers, day after day. | Deleting an audience pauses the active (or waiting) repeating messages sent to it, in the same transaction, with the reason ("Paused: its audience "X" was deleted. Edit it to pick who gets it, then resume."). The delete answers `paused_repeats`. | SV-2 |
| **SV-5** | **Medium** | Security / ffmpeg | ffmpeg picks the format from the file's content, not its type. An upload that passes the MP3 check (an `ID3` tag) followed by an `ffconcat` list made ffmpeg open **another file** in the same uploads folder and convert it (reproduced with the real ffmpeg 6.1 here; HLS playlists were already refused by this ffmpeg version, older builds are weaker). Impact was limited to the workspace's own folder (random file names), but the input was not fenced. Also: no frame-size cap (a tiny video declaring a huge frame could ask for gigabytes of memory), no length cap on voice notes (a 20 MB low-bitrate file of several hours became a 100+ MB voice note that Telegram refuses, filling the workspace's storage), and conversions waiting for the 2 slots could pile up without limit. | Every conversion now runs with `-protocol_whitelist file`, `-format_whitelist` (voice: ogg, mp3, mov/mp4/m4a, matroska/webm, wav, aac; round: mov/mp4, matroska/webm), `-max_pixels 16777216` (4096 × 4096; phone 4K passes, checked), `-nostats`, and `-sn -dn`. Voice notes are cut at 60 minutes (about 22 MB, under Telegram's 50 MB; PRODUCT-FACTS updated) and the saved duration is clamped. More than 8 conversions waiting answers 503 `conversion_busy` ("Many recordings are being converted right now. Please try again in a minute."); the upload's file is removed. All formats the UI records or accepts still convert (mp3, m4a, webm, ogg, aac, wav, mp4, mov checked with the real ffmpeg). | SV-5 (3 tests) |
| **SV-3** | Low | Time math | A run time that daylight saving skips at **midnight** (Chile, Paraguay, Cuba, Egypt: clocks go 00:00 → 01:00) was placed on the **evening before** (23:00). That run then clashed with the previous day's run (one run per date) and was silently lost, and a "Sundays at 00:00" run would have gone out on Saturday. | `zonedInstant` tries the zone's offset before and after that day: an existing time is exact (a doubled time is the first one), a skipped time is the same moment after the jump on that day (00:00 → 01:00, 02:30 → 03:30). Fuzzed 11 zones (incl. Lord Howe, Chatham, Santiago, Apia, Tehran, St John's) × 7 times × 4 frequencies × 420 runs: one run per date, right weekday, right wall time. | SV-3 |
| **SV-4** | Low | Plan limits | Approving a waiting repeating message did not check the plan's limit, and a teammate who needs approval could edit a **paused** one into "waiting" (which counts) without a free slot. A Starter workspace could show 4+ "running". The scheduler still only sent the oldest 3 (the rank check), so no extra sends happened, but the page said otherwise. | Approve checks `assertSlot` (it can also have become full after a move to a smaller plan); an edit that moves a paused one to "waiting for approval" checks it too. Friendly 402 `limit_repeats` as on create. | SV-4 |
| SV-7 | Low | Telegram order | The sender works on up to 2 × rate messages at once, also for the **same chat**. A Chat bot / follow-up step sent right after another (no wait) could overtake it: a round video + text step (two Telegram calls) followed by a voice step arrived as round video, voice, **then** the text; the same could happen after any first-time file upload (slow). | Messages to the same chat in a batch now go one after another, in queue order; if a 429 pause starts while one waits, it is put back in the queue instead of being sent into the pause. Other chats still go in parallel at the bot's rate. | SV-7 |
| SV-6 | Info | Robustness | `routes/media.js` had lost its `'use strict'` line. `wallClock` built a new `Intl.DateTimeFormat` on every call; the repeats calendar calls it thousands of times (up to about 300,000 for a workspace at the 200-series list cap). | `'use strict'` restored. One cached formatter per zone (about 4× faster; same results). | (whole suite) |

---

## 3. Checked and fine (no change needed)

**Scheduler idempotency, restarts, concurrency.** Each run is made in one transaction with the series row locked
(`FOR UPDATE SKIP LOCKED`) and re-checked (`status = 'active' and next_run_at <= now()`); the broadcast insert uses the
unique `(series_id, run_date)` index with `on conflict do nothing`, so a restarted worker, two instances or a time moved
to later the same day never make a second run for a date (the existing test runs `runOne` 3× in parallel). The run's
broadcast is a normal broadcast, queued by `enqueue`, which claims it (`scheduled → sending`) before queuing deliveries.
A run more than 3 h late is skipped, never sent late; the next time is worked out from `max(run time, now)`, so nothing
floods after downtime, maintenance or a paused plan.

**End conditions.** End date is inclusive (`nextRun` returns null after it); "after N sends" ends when `runs >= end_count`
(skipped runs don't count); an edit that lowers N below the runs made ends it at once. Pause clears `next_run_at`;
resume / approve use `nextFresh` (no second run today, said gently).

**Rotation.** In order wraps; random never repeats a version until all were used and never the same twice in a row
(also across rounds); a shrunk version list clamps `next_version` and drops out-of-range used indexes; editing the
versions resets the round.

**Money (packs).** Scale only (`isTopPlan`), active paid plan only (not the trial, not Free), custom limit blocks
buying (409). More packs: prorated `round(add × unit × min(1, left))` from the wallet (bonus first, a negative wallet pays
nothing), one commission (Castvoo referral or VooSquare, AUD-1 path via `settleCommission`; `packsPaid` sends a spend
only when cash ≥ 1 cent). Fewer: `pending_subscriber_packs`, nothing refunded, nothing deleted; same number cancels the
pending one. Renewal (`activate`) charges plan + seats + packs in one payment, clamps to the current most packs, and sets
packs to 0 on any non-top plan; `dropToFree` clears them; `renewalCost` matches. Rows locked (`for update`) so two clicks
can't double charge. Limit = plan + packs × size, or the custom limit; 10% grace now also in Send a message (documented).

**Telegram rules.** Voice caption ≤ 1,024 (empty caption omitted); round video has no caption: text + buttons follow as a
second message (≤ 4,096), buttons sit under the round video when there is no text; retry after a text failure sends only
the text (`message_id` saved on first part); edit edits the second message; delete removes both; pin / unpin use the text
message. Round videos are square, ≤ 640 px, ≤ 60 s, H.264 Main + AAC (`sendVideoNote` limits); without ffmpeg only files
already right are accepted. Pin rights are checked at save (channel: "Edit messages of others" = `can_edit_messages`;
group: `can_pin_messages`); Telegram refusing later is reported, never undoes the delivery. Auto-delete is 1 to 47 h and
skipped past 47.9 h since the send (48 h rule); manual delete keeps its 47.5 h guard. Auto actions (priority 4) go before
broadcast sends (priority 5), so a big send can't starve them past 48 h; one auto action per message (unique index).

**Workspace isolation.** Every repeats route loads the series with `workspace_id = $ws` (404 otherwise); the form checks
the connection, the audience and each version's media belong to the workspace; `GET /api/media/:id` (and its ranges)
checks the workspace; the report's series lookup is scoped; support links `message:<id>` are scoped. Permissions: view
routes `ws.view`, changes `ws.run`, approve `ws.approve` + owner check.

**Uploads.** Type from Content-Type + `?as=` and magic bytes; the file name on disk is random (the user's name is only a
label, sanitised); ffmpeg gets absolute paths through `execFile` (no shell), output next to the input, removed on failure;
the input is removed after conversion; quota re-checked with the real (converted) size under the workspace lock;
120 s timeout per conversion, 2 at a time. Range route: single ranges only, 416 for unsatisfiable, suffix ranges, HEAD,
`nosniff`, private cache.

**Permissions-Policy.** `camera=(self), microphone=(self), geolocation=()`: only Castvoo's own pages can ask; no iframe
gets them (`self` excludes other origins, and Castvoo pages can't be framed: `X-Frame-Options: DENY`,
`frame-ancestors 'none'`).

**XSS.** Series titles, schedules, version texts, history dates, last errors, connection names and next labels are all
escaped (`esc`) in `app-send.js`; admin uses the escaping `html` template; pack amounts are numbers.

**Server-side plan limits.** Repeats: Free 0 (no broadcasts), Starter 3, Growth 20 (and the trial), Scale unlimited with
the fair-use 100 enforced, on create, resume, approve (SV-4) and at every run (only the oldest `cap` send after a
downgrade). Subscriber limit (+10%) enforced at send and at every run (`assertCanSend`).

**Migrations 029 / 030.** Additive (`if not exists`), constraints dropped and re-added with a superset of the old values
(`media_kind_check`, `deliveries_action_check`, the 001 names), saved `billing` keys kept (`jsonb_build_object(...) || value`),
partial indexes; no back-fill. Re-run twice on populated data in a test: no change.

**Storage growth.** Auto actions add at most 3 delivery rows per sent message; deliveries older than 120 days are
cleaned; `media_conversions` older than 30 days are cleaned; unused media (not in broadcasts, steps or repeat versions)
after 3 days.

---

## 4. Open items (accepted for this release, follow-ups)

| ID | Sev | Issue |
|---|---|---|
| O-1 | Low | Same pattern as SV-2 for **one-off** scheduled or waiting broadcasts (pre-existing): deleting their audience makes them go to every subscriber. Suggest refusing the delete (or moving them to draft) when a scheduled / waiting broadcast uses it. |
| O-2 | Low | Resuming a repeating message paused by SV-2 without editing it sends to the whole bot audience (the reason shown says to edit first). The Repeats cards only show `last_error` for running ones; the detail sheet shows it. Designer: show the reason on paused cards, or ask for an audience on resume. |
| O-3 | Low | Round video + text: if the text part fails for good (e.g. a 400), the delivery is marked failed although the round video arrived, and its auto-delete / pin are not queued. |
| O-4 | Low | A server restart in the middle of a conversion leaves the upload (and a partial output) in the workspace folder with no database row; nothing removes such orphan files. A sweep of files not in `media` older than a day would fix it. |
| O-5 | Info | After a move to a plan without Audiences, repeating messages keep sending to their saved audience (as scheduled one-off broadcasts do). |
| O-6 | Info | Packs are prorated like seats: bought on the last day they cost almost nothing, then renew at full price. Yearly packs are 12 × the monthly price (no yearly discount). Product choices, documented. |
| O-7 | Info | Pause does not cancel a run broadcast made in the same few seconds (it goes out); Stop does cancel a scheduled one. |
| O-8 | Info | Voice notes are now cut at 60 minutes (SV-5). If longer ones are wanted, raise `VOICE.seconds` in `services/media-convert.js` (stay under Telegram's 50 MB: about 2 h 15 min at 48 kbit/s). |

---

## 5. Files changed by this review

- `server/routes/broadcasts.js`: cancel skips only unsent sends (SV-1).
- `server/workers/sender.js`: a cancelled message skips only send / edit deliveries (SV-1); same-chat messages in order (SV-7).
- `server/routes/segments.js`: deleting an audience pauses its repeating messages (SV-2).
- `server/services/repeats.js`: `zonedInstant` handles skipped and doubled times (SV-3).
- `server/routes/repeats.js`: slot check on approve and on a paused → waiting edit (SV-4).
- `server/services/media-convert.js`: input whitelists, frame cap, voice 60 min, `-nostats`, busy queue (SV-5).
- `server/services/broadcasts.js`: cached formatter per zone (SV-6).
- `server/routes/media.js`: `'use strict'` restored (SV-6).
- `docs/PRODUCT-FACTS.md`: voice notes at most 60 minutes.
- `test/helpers/fake-ffmpeg.js`: `FAKE_FFMPEG_SLEEP_MS`.
- `test/e2e/supervisor-oct12.test.js`: 9 regression tests.

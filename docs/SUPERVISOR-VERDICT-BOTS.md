# Castvoo Bots release: supervisor go/no-go verdict

Commits reviewed: **c1b93ed** (Bots: Welcome bots + Chat bots, check_join / ask / referral, migration 026, `services/bots.js`,
`routes/bots.js`, runtime / bot-updates / send / billing / auth changes, session cap), **71c3729** (homepage),
**2c4ca6d** (Cas Builder builds every bot type, `flows.cleanAiBot`), **7827a2f** (cache versions).
Date: 10 Oct 2026. Team: bug hunter, security reviewer, Telegram-rules auditor, billing/limits auditor (one pass each,
findings merged below). Fixes are in the commit that adds this file. Front-end files were not touched (a designer is
editing them); front-end findings are listed for the designer in section 4.

---

## VERDICT: SAFE TO DEPLOY: YES, with the conditions below

No blocking defect is left open. The two billing holes (a smaller plan kept running Chat bots it does not include, and
hidden lead answers never came back as promised) are fixed and covered by tests. Migration 026 is additive and safe on
existing data; old Welcome Flows and old routes behave as before (all their tests pass).

**Conditions:**
1. Deploy this commit (not c1b93ed..7827a2f alone): it contains the fixes S-1 to S-9.
2. Run one live Telegram pass on a real bot before announcing: a Chat bot start link, plain /start on the default bot,
   "I've joined" on a **private** channel (the bot an admin) for a member and a non-member, one question of each kind
   (text, shared phone, choice), and one invite link from a second account (it counts once; the inviter gets the reward).
3. The designer fixes F-1 (menu buttons per plan in the builder) before Chat bot menus are marketed as "up to 8 / 12 buttons".
4. Single app instance (as today on Railway): the duplicate-update guard (S-7) is per process. With several instances
   it still works per instance, but a resend landing on another instance would not be caught (rare; harmless except for
   the case S-7 describes).

---

## 1. Gates

| Gate | Result |
|---|---|
| `node scripts/check.js` | **PASS** (all checks) |
| `npm test` (full suite, after the fixes) | **806 / 806 pass, 0 fail** (796 before + 10 new) |
| New regression tests | `test/e2e/bots-supervisor.test.js`: **10 tests**, each fails on 7827a2f and passes with the fixes (checked by stashing the server changes) |

---

## 2. Findings fixed (by severity)

| ID | Sev | Area | What was wrong | Fix | Test |
|---|---|---|---|---|---|
| **S-1** | **High** | Billing | A move to a smaller plan left Chat bots running that the plan does not include. `trimBots` only looked at the live-bot count and referral bots, and the runtime never re-checks Chat bots (`planGate` returns early for `bot_start`, "checked when saved"). A Starter question bot or a 5-message bot kept running on Free (answers saved, follow-ups sent). Worse, `activate()` (a paid renewal or switch to a smaller paid plan, e.g. Growth → Starter) never called `trimBots` at all, so referral bots and bots over Starter's limits kept running. | `billing.trimBots` now also pauses (kept, `paused_by_plan`) Chat bots that use a step type the plan lacks, or have more questions, messages or menu buttons than it allows; `activate()` calls it after `trimFlows`. | S-1 (2 tests) |
| **S-2** | **Medium** | Billing / promise | Answers over the month's limit (+10%) were stored with `hidden = true` and **never** shown again, although BOTS.md, BOTS-PRICING.md, PRODUCT-FACTS.md and the Leads tab all promise "shown again next month or after an upgrade". Also a person answering the same question again while the month was over flipped their already visible answer to hidden. | `bots.revealAnswers(ws)` runs before the Leads view / CSV: earlier months' hidden answers come back, and this month's oldest hidden ones while the current plan (+grace) has room (visible answers never exceed the cap). The upsert no longer changes `hidden` on a re-answer. | S-2 |
| **S-3** | **Medium** | Runtime | Two Chat bots on the same Telegram bot both waiting on a choice question for one person: tapping a choice of the **older** question answered "This question was answered already" and dropped the answer (`onChoice` only looked at the most recent waiting question). | `waitingQuestion(conn, sub, stepId)` finds the run waiting on that exact step. | S-3 |
| **S-4** | Low | Runtime | Any /start wakes every `awaiting` run of the person (`flow-runtime.onStarted`) to `active` until the next tick. An answer typed in that window was ignored (`waitingQuestion` required `awaiting`). | `waitingQuestion` accepts `active` too when the question was sent and is still open (`sent_position = next_position`); `advanceRun` already accepts both. | S-4 |
| **S-5** | Low | Telegram rules | getChatMember answering "Bad Request: user not found" / PARTICIPANT_ID_INVALID (someone never in that chat) was treated as a temporary error: the person saw "I couldn't check right now, try again in a minute" on every tap, forever. | Those answers mean "not joined": the gentle nudge popup. Other errors keep "couldn't check" (and now log the chat id). | S-5 |
| **S-6** | Low | Telegram rules | An "Invite friends" message is checked at 4,096 (or 1,024 with a photo) characters, but the invite link (~60 characters) and the numbers are filled in at send time, so a long text failed in Telegram ("message is too long") for every person. | Save refuses it with a friendly message, using the real bot username and the Free line when it applies. | S-6 |
| **S-7** | Low | Idempotency | No update_id de-duplication. A Telegram resend of a typed answer (slow answer or network blip) arriving after the next question was sent answered the **next** question too. | `bot-updates.handleSoon` drops an update_id already seen from the same bot (last 500 per bot, in memory). | S-7 |
| **S-8** | Info | Robustness | The "📊 My progress" callback (`cvr:<id>`) of any Chat bot on the same Telegram bot (a crafted callback) made invite codes for a bot with no invite step and sent "0 of 0". | Only bots with an "Invite friends" step answer it. | S-8 |
| **S-9** | Info | CSV | The Username column was written as `@name`, which the formula guard (correctly) prefixed with `'`, so every username showed as `'@name` in Excel. | Plain username in that column; the guard (`= + - @ tab CR` prefixed with `'`) is unchanged and still covers names and answers. | S-9 |

The CSV export row cap was also raised from 20,000 to 500,000 answer rows (Scale allows 100,000 answers a month; the
export used to stop silently at 20,000). The Leads view stays at 500 people.

---

## 3. Checked and fine (no change needed)

**Start links.** `/start <code>` (case-insensitive), plain `/start` → the one live default bot, unknown code → default.
Codes starting `j_`, `cvf_`, `cvt`, `r_`, `cv_` are refused at save (and in `cleanAiBot`), and the runtime skips `j_`,
`cvf_`, `cvt` payloads, so Welcome Flow "Tap to start" / "Tap to join" (`j_`), "Start another flow" (`cvf_`) and flow
tests (`cvt_`, handled first) never start a Chat bot. Live code / default uniqueness is enforced by `botClash` and the
two partial unique indexes (a race gives a friendly 409).

**check_join.** member / administrator / creator, and restricted with `is_member: true`, pass; left, kicked and
restricted without membership get the nudge; channel and group behave the same; private channels get a bot-made invite
link at save. The bot must be admin at save time (409 `bot_not_admin_check`). Double taps advance once (`advanceRun`
is guarded by `next_position`). `answerCallbackQuery` is called on every path of `cvj:`, `cva:`, `cvr:` and `cvb:`.

**ask.** Text / number / email / phone / choice validation; a `/command` is never an answer (and commands are not routed
to `onText`); stickers or photos get the retry text; someone else's contact is refused; a reminder fires once and is
cancelled when answered; a /start while waiting re-sends the question.

**Referrals.** Self-invites ignored; counted only for people new to that Telegram bot (`sub.inserted && !before`), once
per invited person per bot (unique index, so retries or races can't double count), max 50 counted per inviter per 24 h
(a race can exceed it by a few, acceptable); the goal wakes the reward once (`reached_at is null` guard); invite links
are per bot and per person; an invite code only works on its own Telegram bot.

**Workspace isolation.** Every new route resolves the bot with `flows.getOwn(ctx.workspace.id, id)` (404 otherwise);
`POST /api/bots/check-join` checks both connections belong to the workspace; Telegram callbacks check the step's or
bot's `connection_id` against the bot the update came in on. Workspace A cannot read B's answers, CSV, referrals or
check B's channels. CSV is owner-only (`ws.export` + role check) and rate limited (20 / hour).

**XSS / injection.** The Leads and Invites tabs escape names, usernames, answers and labels (`esc`, `td`). Bot texts go
through `tg.toHtml` (escaped). `cleanAiBot` refuses unknown fields at every level, HTML tags and `javascript:`, non-https
links, `bot_id` (dropped), and keeps `chat_id` only as a number that `cleanFlow` re-checks against the workspace; the
result is a draft checked again by `cleanFlow` + the plan on save.

**Billing server-side.** Live bots (Welcome + Chat), bot types, messages per bot, menu buttons, questions per bot and live
referral bots are enforced in `cleanFlow` / `assertBotPlan` / `assertBotSlots` on create, update, switch-on, copy and the
Cas save path (Cas uses the same `createFlow` / `updateFlow` / `switchOn`). The 10% grace on lead answers is applied.
Cas builds: consumed once per new-bot session (`counted_at`, row lock), edits free, failed saves don't double count.

**Session cap.** Never deletes the current session, only the oldest beyond the cap, and forces the new-login alert
(still rate limited 3 / hour). It can't log out other users.

**Migration 026.** Additive (`if not exists`, constraints dropped then re-added with a superset of the old values),
fast defaults, partial indexes match no existing rows; `bot_type = 'welcome'` back-fill only. Safe to re-run.

---

## 4. Open items

### For the product designer (front-end, not changed here)

| ID | Sev | File | Issue |
|---|---|---|---|
| **F-1** | Medium | `public/js/app-flows.js` ~line 1777 | "Add button" caps every message at 3 buttons on Free and 6 on paid plans. For **Chat bots** the plan allows 4 / 8 / 12 menu buttons (`plan.limits.bots.menu_buttons`), so the builder blocks what is sold. Note the server still allows at most **6 Link buttons** per message (`broadcasts.checkMessage`); the rest must be Reply buttons. Suggested: for Chat bots use `menu_buttons` (12 max) and keep Link buttons ≤ 6 with a clear hint. |
| F-2 | Low | `public/js/app-flows.js` | The builder does not count the invite link when checking an "Invite friends" text; the server now refuses texts that won't fit (S-6). A counter that adds ~60 characters for `{invite_link}` would avoid the surprise. |
| F-3 | Info | Leads tab | The "kept safe and shown again next month or after an upgrade" line is now true (S-2); no change needed, just re-check the copy. |

### Server (accepted for this release, follow-ups)

| ID | Sev | Issue |
|---|---|---|
| O-1 | Low | If the bot loses admin rights in the channel after saving, every "I've joined" tap says "couldn't check, try again in a minute" and the owner is not told (only a log line). Suggest an owner alert / dashboard banner. |
| O-2 | Low | Retry texts and the "share your own number" reply are sent straight away (not through the sender queue), so a person spamming wrong answers makes the bot reply to each one; Telegram's per-chat limit (about 1/s) then answers 429 and those replies are dropped. No harm beyond the dropped replies; a per-person throttle would be cleaner. |
| O-3 | Low | A Welcome bot with a check step on the same channel and "How people get in" = manual or Tap Start: people can't pass the check until they are let in. Consider refusing that combination at save. |
| O-4 | Low | Leads (names, phones, emails) are visible to every teammate role, including drafters (`GET /api/bots/:id/answers` is `ws.view`); only the CSV is owner-only. Decide whether drafters should see leads. |
| O-5 | Low | Deleting a Chat bot deletes its answers and referral history (`on delete cascade`). The UI confirms, but an export reminder in that confirm would help. |
| O-6 | Info | Cas Builder has no per-session AI call cap ("Something else" can be asked again and again before the one counted save); the daily spend cap and "resting" protect cost. Pre-existing design. |
| O-7 | Info | The "stays joined 24 hours" referral rule from the pricing doc is not built (already stated in BOTS.md). |
| O-8 | Info | The daily referral cap (50) is checked before insert without a lock; a burst can exceed it by a few. |

---

## 5. Files changed by this review

- `server/services/billing.js`: `trimBots` (types, questions, messages, buttons), called from `activate()`.
- `server/services/bots.js`: `revealAnswers`, upsert keeps `hidden`, `waitingQuestion(…, stepId)` + `active`, `onChoice`,
  getChatMember "user not found", `onProgress` needs an invite step, CSV username and row cap.
- `server/services/flows.js`: invite text must fit after the link is filled in.
- `server/services/bot-updates.js`: duplicate update_id guard.
- `test/helpers/fakes.js`: `tg.chatMemberError` (getChatMember failing for a person).
- `test/e2e/bots-supervisor.test.js`: 10 regression tests (S-1 to S-9).

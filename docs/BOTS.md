# Bots (🤖 Bots section)

One menu item, **🤖 Bots**, replaced "Welcome Flows". It holds two kinds of bot that share one builder
(`public/js/app-flows.js`), one save API (`/api/flows`) and one runtime (`server/services/flow-runtime.js`).
Pricing and the reasons behind the limits: `docs/BOTS-PRICING.md`. What support and Cas may say: `docs/PRODUCT-FACTS.md`.

| Kind | Starts when | `sequences.trigger_type` | Code |
|---|---|---|---|
| 👋 Welcome bot | someone asks to join a channel or group | `join_request` (the Welcome Flows, unchanged) | `services/flows.js` |
| 💬 Chat bot | someone opens the customer's own bot and taps Start: `t.me/<bot>?start=<code>`, or a plain `/start` when the bot has **is_default** | `bot_start` (`trigger_value` = the code) | `services/bots.js` |

Old URLs keep working: the page key is still `flows` (`#app/flows`, `#app/flows?id=…`). New: `#app/flows?bot=<template>`,
`#app/flows?newbot=1`, tabs `leads` and `invites` on a Chat bot.

## Step types (`sequence_steps.step_type` + `config`)

| Type | What the person sees | Runtime |
|---|---|---|
| `message` | as before | as before |
| `check_join` | the message, `[📣 Open the channel]` (link) and `[I've joined ✅]` (callback `cvj:<step id>`) | sent once (`sequence_runs.sent_position`), run `awaiting`. The tap calls `getChatMember` (bot token) for that person: member/admin/creator (or restricted with `is_member`) → `advanceRun`; otherwise a popup (`answerCallbackQuery show_alert`) with the nudge. Optional reminder = a `flow_step_runs` row of the step itself, cancelled once passed. |
| `ask` | the question; `choice` → inline buttons `cva:<step id>:<n>`; `phone` → a one-time reply keyboard with `request_contact` | sent once, run `awaiting`. The next text / contact from that person (`bot-updates.js` → `bots.onText`) is checked by `validateAnswer` (no AI): ok → saved in `bot_answers` (upsert per bot/step/person) and the run goes on; not ok → a kind "try again". A contact must be their own (`contact.user_id`). Optional reminder. |
| `referral` | their invite link and progress: `{invite_link}` `{invites}` `{goal}` (the link is added if the text has none), `[📤 Share my link]`, `[📊 My progress]` (`cvr:<bot id>`) | sends, then goes on. The next message with trigger `on_goal` waits (`awaiting`) until the goal is reached. |

New trigger: **`on_goal`** (🏆 When they reach their invite goal), needs a `referral` step above.
Rules (checked in `flows.cleanFlow` + `bots.cleanSpecial` / `assertBotPlan`): special steps have no buttons of their own
and come `after_previous` or `wait`; `ask` and `referral` are Chat bots only; `check_join` can't be the welcome of a
Welcome bot; Chat bots never use `on_start` and have no A/B versions; one `referral` step per bot.

## Saving: the JSON (also for Cas later)

`POST /api/flows`, `PUT /api/flows/:id`, `POST /api/flows/tests` take the builder's format. The AI-facing schema is
`AI_BOT_KEYS` in `server/services/flows.js` (documented there):

```json
{ "start_type": "bot_start", "bot_id": 12, "name": "Free gift", "start_code": "gift", "is_default": false,
  "steps": [
    { "type": "message", "body": "Hi {name} 👋", "buttons": [{ "id": "vip", "label": "⭐ VIP", "kind": "reply" }] },
    { "type": "check_join", "body": "Join first 👇", "check": { "chat_id": 34, "remind": { "value": 10, "unit": "min" } } },
    { "type": "ask", "body": "Your email?", "ask": { "answer": "email", "label": "Email" } },
    { "type": "referral", "body": "Invite {goal}: {invite_link}", "referral": { "goal": 3 } },
    { "type": "message", "body": "🎉 Reward", "trigger": { "type": "on_goal" } } ] }
```

`GET /api/flows/:id` gives the same shape back (`type`, `check` / `ask` / `referral`, `start_type`, `start_code`,
`is_default`, `start_url`, `bot_type`). Welcome bots: no `start_type` (or `join_request`), exactly as before.
A check step's `link` is made once (the channel's @username, the link given, or `createChatInviteLink`) and sent back.

## Routes

| Route | What |
|---|---|
| `GET /api/flows` | now also `chatbots`, `bot_templates`, `bot_usage` (live bots, lead answers meter), `ownership`, and `plan.limits.bots` |
| `POST/PUT/DELETE /api/flows…`, `/toggle`, `/duplicate`, `/stats`, `/audience` | work for both kinds (`/invite-link` is Welcome bots only) |
| `GET /api/bots` | Welcome bots, Chat bots, templates, limits, usage, ownership tips |
| `POST /api/bots/check-join` | `{ bot_id, chat_id }` → `{ ok, message }`: can the bot check who joined (admin there)? |
| `GET /api/bots/:id/answers` | the Leads view (one row per person, a column per question; hidden answers are `null`) |
| `GET /api/bots/:id/answers.csv` | owner only (`ws.export`), Starter and up; formula-safe cells |
| `GET /api/bots/:id/referrals` | leaderboard, totals, the invites that did not count by reason |
| `POST /api/bots/:id/audience` | the segment "Started <bot>" (rule `bot_started`) for Send a message |

Telegram callback data: `cvj:` (I've joined), `cva:` (choice), `cvr:` (progress); flow tests add `cvt:<code>:cvjoin`,
`cvt:<code>:cva<n>`, `cvt:<code>:cvref`. Commands: `/invite`, `/mylink`.

## Referral counting (anti-abuse)

Recorded in `bot_referrals` once per invited Telegram user per bot (`unique (sequence_id, referred_tg_user_id)`),
counted only when: the person is **new to that Telegram bot** (their subscriber row was just created), not the inviter,
not a bot, and the inviter has fewer than **50 counted in the last 24 hours**. Otherwise kept with `reason`
(`not_new`, `daily_limit`, `bot`; a self-invite is ignored). Reaching the goal sets `bot_invites.reached_at` and wakes
the inviter's reward. Not built yet: the "stays joined 24 hours" rule from the pricing doc.

## Plan limits (`server/services/billing.js` `BOT_PLANS`, data, enforced server-side)

| | Free | Starter | Growth | Scale |
|---|---|---|---|---|
| `max_bots` (live, Welcome + Chat) | 2 | 5 | 15 | -1 (fair use 100) |
| `bot_types` | welcome, join_check, lead_magnet, menu | + broadcast, lead_questions | + referral | all |
| `max_bot_subscribers` | 100 | 5,000 | 25,000 | 100,000 |
| `bot_steps` (messages per Chat bot; menu answers and check/question steps don't count) | 1 | 5 | 20 | -1 |
| `menu_buttons` | 4 | 8 | 12 | -1 (12 per message) |
| `lead_questions_per_form` | 0 | 5 | 15 | -1 |
| `lead_answers_per_month` | 0 | 1,000 | 10,000 | 100,000 |
| `lead_export` | none | csv | csv | csv |
| `referral_bots` (live) | 0 | 0 | 2 | -1 (fair use 20) |
| `branding` ("⚡ Free bot by Castvoo.com" on the first message) | yes | no | no | no |
| `concurrent_sessions_per_seat` | 2 | 2 | 2 | 3 |

Grace: 10% on meters (`withGrace`). Lead answers past `limit + 10%` are saved with `hidden = true` (shown again next month
or after an upgrade). `max_bot_subscribers` is checked before a broadcast to a Chat bot's audience (Free has no
broadcasts, so it has no effect there today). Trial: Growth's bot limits with 300 lead answers. A custom admin plan gets
the limits of the built-in plan whose features it has (`botPlanOf`). Friendly 402 codes: `limit_bots`, `plan_bot_type`,
`limit_bot_steps`, `limit_menu_buttons`, `limit_lead_questions`, `limit_referral_bots`, `limit_subscribers`.
A drop to Free (`dropToFree` → `trimBots`) pauses the Chat bots that don't fit (the live Welcome bot first, then the
oldest Chat bots; invite bots can't run on Free).

**Logged-in devices** (`auth.capSessions`): after a login, sessions beyond `concurrent_sessions_per_seat` (the biggest of
the person's workspaces) are deleted oldest first, and the new-login alert is sent (`security.onLogin` with `force`).

**Linked Telegram ownership** (warn only, `bots.ownershipWarnings`): a connected Telegram bot that no teammate's linked
Telegram account has started shows a tip on the Bots page. Nothing is blocked yet (channels already need a linked
account to connect, through @CastvooBot).

Cas builds stay the only metered credit; bots and flows share the existing Cas build count (one build per new bot,
edits free). Cas Builder builds every kind of bot: see "Cas Builder" below.

## Cas Builder (`public/js/cas-engine.js`, `services/cas-builder.js`)

The first question is "What do you want your bot to do?" (`st.kind`: `welcome` | `join_check` | `lead_magnet` | `menu` |
`lead_questions` | `referral` | "something else"). `welcome` runs the Welcome Flow chat as before. The others ask one
question at a time (answers in `st.bk`) and `buildBot()` makes the whole Chat bot from them with no AI; "✨ Just build it
for me" fills the rest with the defaults. The draft is this save API's JSON (`start_type: 'bot_start'`, `steps[].type`,
`check` / `ask` / `referral`, waits in seconds) and `engine.problems()` checks it with the same rules and plan limits
(`ctx.plan.bots` from `BOT_PLANS`, plus `unlock`: the plan that has each missing type). `POST /api/cas-builder/sessions`
takes `{ kind }` to skip the first question.

- Join check: the engine returns `check { bot_id, chat_id }`; the server answers with `bots.checkCanCheck` (the
  `POST /api/bots/check-join` check) through `engine.checkDone()`; not an admin → a soft explanation and
  "✅ I've made it an admin" (checks again) / "I'll do it later".
- "Something else": guessed from the words first (`guessKind`, no AI); otherwise `ai { kind: 'bot' }` →
  `buildBotAI` (prompt `BOT_FORMAT`) → `flows.cleanAiBot` (strict, AI_BOT_KEYS) → `engine.aiDone({ bot })`, checked again
  for the plan. Bad or no answer: Cas asks them to pick the closest kind.
- Plan gating: a locked kind (or a full Welcome Flow allowance) → which plan unlocks it and a similar allowed kind
  (`ALT`). `limit_bots` / `limit_referral_bots` when switching on → saved as a draft, switched off, explained.
- Saving uses the builder's save path (`routes/flows.js createFlow` → `createBot`, `switchOn`). One build per new bot.
- Typed changes on a built Chat bot use the same tool operations; welcome-only ones (how people get in, the Tap Start
  button, starting another bot) are refused for Chat bots.

## Data (migration `026_bots.sql`)

`sequences.is_default`, `sequences.bot_type`, `trigger_type 'bot_start'` (+ unique live code / default per Telegram
bot); `sequence_steps.step_type`, `config`, trigger `on_goal`; `sequence_runs.sent_position`; tables `bot_answers`,
`bot_invites`, `bot_referrals`; `deliveries.extra` (`{ kind, brand, reminder }` for the sender, which builds the bot
parts in `bots.deliveryParts`). Feature switch: `bots` (Admin → Features).

## Extension point

`START_TYPES` and `STEP_TYPES` in `services/bots.js` are the only lists to grow. Paid memberships / sales and an AI chat
bot are separate products: there is no code or UI for them here.

## Tests

`test/e2e/bots.test.js`: answer checks, saving and the JSON round trip, friendly refusals, the admin check at save time,
start links / plain Start / Welcome Tap Start links, join check (not joined, joined, double tap, reminder), questions
(typed, shared number, choice, retry, someone else's contact, reminder, Leads, CSV, hidden answers over the month),
referrals (own link, new people only, once each, self, 50 a day, goal → reward, /invite, progress), plan limits on
every plan, a drop to Free, the broadcast audience, the devices cap, the ownership tip, the flow-test engine, a real
Telegram test of a Chat bot, and the builder's preview of the new steps in a sandbox.

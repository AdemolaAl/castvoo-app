# Developer guide

Castvoo is deliberately simple: **plain Node.js 22, plain PostgreSQL, plain HTML/CSS/JS. No frameworks,
no npm packages, no build step.** If you can read JavaScript and SQL, you can work on all of it.

## How a request flows

```
browser ──► server/app.js ──► server/routes/<area>.js ──► server/services/*.js ──► PostgreSQL
                │                        │
                │ checks login, team      └─ returns an object → sent back as JSON
                │ permission, CSRF,          or throws httpError(400, 'Friendly message')
                │ rate limits
                └─ files in public/ are served as they are
```

Background work (sending messages, follow-ups, billing, emails) runs in `server/workers/` inside the
same process, in loops that never overlap.

## The 10 rules

1. **Money is always cents** (integers). `$49.00` is `4900`. Use `cents()` and `fmtUSD()` from `lib/util.js`.
2. **Always use `$1, $2` parameters in SQL.** Never build SQL by gluing strings with user input.
3. **Every workspace query filters by `workspace_id = ctx.workspace.id`.** That is what stops one customer
   seeing another's data. Tests check this.
4. **Errors people see are friendly sentences**: `throw badRequest('Write a message first.')`.
5. **Admin routes name a permission** (`{ staff: 'pricing.edit' }`) and call `audit(...)` for every change.
6. **Never trust the browser about money.** Payments are credited only after the provider confirms it
   server-to-server, inside a transaction, and crediting twice does nothing.
7. **Anything the owner may want to change goes in the admin panel**, not in code: prices (plans table),
   offers, countries, website text (site_content), emails (email_templates), Cas knowledge, settings, features.
8. **Only promise what works.** Copy, emails and policies must agree with `docs/PRODUCT-FACTS.md`;
   `npm run check` catches common slips.
9. **Database changes = a new migration file** (`server/migrations/003_what_it_does.sql`). Never edit an old one
   after launch.
10. **Run `npm run check` and `npm test` before every push.**

## Common changes (no code needed)
| Want to… | Where |
|---|---|
| Change a price or plan limit | Admin → Pricing |
| Run a promo / coupon / banner | Admin → Offers |
| Switch a feature off | Admin → Features |
| Change website headline, FAQ, announcement | Admin → Website text |
| Reword an email | Admin → Emails |
| Teach Cas something | Admin → Cas knowledge (also read by the AI support team and the website chat) |
| Change the AI support agents, their photos, rules and limits | Admin → Support AI |
| Pick payment methods for a country | Admin → Countries & payments |
| Add a bank transfer, mobile money or wallet method | Admin → Countries & payments → Add payment method |
| Write, schedule or edit a blog post | Admin → Blog ([BLOG.md](BLOG.md)) |
| Give someone admin access | Admin → Team |

## Common changes (code)
- **New API endpoint**: add it to the right file in `server/routes/`. Pick `{ auth: 'workspace' }` for
  customer data, `{ staff: '<permission>' }` for admin. See [ADD-A-FEATURE.md](ADD-A-FEATURE.md).
- **New dashboard page**: see `public/js/README.md`.
- **New admin page**: `public/admin/js/` (one file per menu group) and the menu list in `public/admin/js/core.js`.
- **New email**: add a template to `server/emails/templates.js` (with `vars`), then
  `require('./services/email').send('your_key', user, { ...vars })`. It appears in Admin → Emails automatically.
- **New feature switch**: one line in `server/features.js`; check it with `await settings.requireFeature('key')`
  on the server and `CFG.features.key` in the browser.
- **New team permission**: one line in `server/permissions.js`.
- **New workspace route** (`{ auth: 'workspace' }`): add `'METHOD /pattern': 'ws.<perm>'` to `WS_ROUTES` in `server/permissions.js`.
  The router checks it for every role (owner, sender, drafter, setup helper) before the handler; a route missing from
  the map is owner-only and `npm run check` fails. `test/e2e/setup-helper.test.js` calls every workspace route as a
  setup helper and checks the answer against the map. Changes a setup helper makes are written to `workspace_activity`
  (`services/activity.js`; add a plain-words line for your route in `LINES`).
- **New payment method checked by hand** (bank, mobile money...): no code, Admin → Countries & payments → Add payment method.
- **New automatic payment gateway**: `server/payments/index.js` (start + verify, added to `GATEWAYS`), a webhook in
  `server/routes/payment-webhooks.js`, a row in `payment_methods` (migration or seed), then pick it per country in admin.
  Step by step: [INTEGRATIONS.md → Adding a payment gateway](INTEGRATIONS.md#adding-a-payment-gateway-automatic-needs-code).

## Telegram facts the code relies on
- ~30 messages/second per bot (we send 25), 1 message/second per chat, 20/minute per group.
- Text 4,096 characters; photo/video caption 1,024. Photos 10 MB, videos 50 MB (our limits).
- Bots get no read receipts and cannot list channel members.
- A file uploaded once gives a `file_id` that the same bot can reuse.
- Bots can delete their messages for 48 hours.
- After a join request, the bot may message that person for 5 minutes (`user_chat_id`), until the request is
  approved or declined. So Welcome Flows send the welcome first, then approve (`services/flows.js`).
- Quick steps: later Welcome Flow messages due within `flows.QUICK_SECONDS` (280 s) of the welcome also go through
  `user_chat_id` while the request is open (`deliveries.join_request_id`, priority 1). Approving ends the window, so
  "after_welcome" / "instant" flows hold the approval (`join_requests.hold_position`, `approve_at`) until the last
  quick delivery is done (`deliveries.then_approve` → `flows.quickStepDone` → `releaseHeld`), or `approve_at` passes.
- Bots can't message people who never pressed Start: after that window, later Welcome Flow steps wait (`sequence_runs.status = 'waiting'`)
  until `/start` (the welcome's "Tap to start" button sends `?start=j_<code>`), and stop after 7 days.
- Waits are seconds (`sequence_steps.delay_seconds`; `delay_minutes` is kept in step by a trigger for older code).
  The drips job polls every 10 s; steps due within 60 s are fired on time by `workers/soon.js` (call `soon.at(dueAt)`
  wherever you set a near due time). Row claims (`for update skip locked`) keep it safe on several servers.
- Plans: limits and features live in the `plans` table (Admin → Pricing). Check them with `billing.limits(ws)`,
  `billing.hasFeature(ws, key)` / `requirePlanFeature(ws, key)` (402 `plan_feature`) and `billing.joinMeter(ws)`.
  A workspace whose trial or plan ends unpaid drops to the Free plan (`billing.dropToFree`), it is not paused.
- @CastvooBot (`services/platform-bot.js`): only one program may use a bot token. `selfHeal()` runs at start-up and every
  10 minutes (workers): `getWebhookInfo`, and if the URL is not `APP_URL/tg/platform` or Telegram reports a delivery
  error newer than our last `setWebhook`, it sets the webhook again and logs a warning. `getMe`'s username replaces
  `CASTVOO_BOT_USERNAME` in every link (warning when they differ). Admin → Settings & connections → "Castvoo bot" card
  (`/api/admin/platform-bot`, `/fix`, `/test`). Tests: `test/e2e/platform-bot.test.js` (`fakes.tg.webhookInfo`).
- `t.me/<bot>?start=<tag>` passes `<tag>` to `/start`. `?startchannel&admin=...` / `?startgroup&admin=...`
  open Telegram's "add as admin" screen.

## Cas and the AI providers
`server/services/llm.js` has one `complete({ system, messages, maxTokens, temperature, json })`; `services/ai.js`
calls it. It sends to the provider in Admin → Cas AI (`ai_provider` setting) or `AI_PROVIDER`:
- `anthropic` (default): the original request to `ANTHROPIC_API_BASE/v1/messages`, one try, system as cached blocks.
- `openrouter`: `POST https://openrouter.ai/api/v1/chat/completions` with `Authorization: Bearer`,
  `HTTP-Referer` (APP_URL) and `X-Title: Castvoo`. The system prompt becomes a `system` message (its
  `cache_control` marks are kept, so prompt caching still works), fallbacks go in `models`, `json: true` adds
  `response_format: { type: "json_object" }` (the sequence writer asks for a JSON array, so it does not use it).
- `openai`: the same format to `https://api.openai.com/v1`.
OpenRouter/OpenAI calls retry 408/429/5xx twice with backoff (honouring `Retry-After`), time out after 60 s
(`AI_TIMEOUT_MS`, `AI_RETRIES`, `AI_RETRY_BASE_MS`) and treat an `{ error }` inside a 200 as a failure.
`OPENROUTER_BASE_URL` / `OPENAI_BASE_URL` are for tests only: ignored in production, where keys only go to
`openrouter.ai` / `api.openai.com`. A key saved in the admin is bound to its provider and address and is never sent
anywhere else. `ai_usage` records provider, model, tokens and (OpenRouter) `cost_usd`. Tests:
`test/e2e/openrouter.test.js` with the mock in `test/helpers/mock-openrouter.js` (ports 4971–4979).

## The 24/7 AI support team
Files: `services/support-ai.js` (queue, persona, prompt, handoff, sandbox, website chat), `services/support-tools.js`
(the tools and redaction), `routes/admin/support-ai.js` (Admin → Support AI), `public/admin/js/support-ai.js`.
- A customer message (`support.userMessage`) only queues a job in `support_ai_jobs`; the `support-ai` worker loop
  (every second) answers it. Replies are 1–3 bubbles in `support_messages` (`author_type 'ai'`, `persona_id`) with a
  future `visible_at`, so the dashboard shows "Mia is typing…" and then the bubbles. `GET /api/support` only returns
  visible bubbles plus `typing`.
- Tools get `scope = { userId, workspaceId, threadId, sandbox }` from the thread, never from the model. Every id the
  model passes is looked up with `workspace_id = scope.workspaceId`. Outputs go through `redact()` (keys like token /
  secret / password / code / api_key are dropped; bot tokens and keys in text are masked) and are logged in
  `support_ai_tool_log` for staff.
- Money: `recheck_payment` only calls `payments.verify()` (credited only when the provider confirms; idempotent). Manual
  methods are read-only and hand over to Finance. No tool approves, credits, refunds or discounts. A reply that claims
  money moved when no provider confirmed it is replaced and handed over (`MONEY_CLAIM`).
- Handoff (`handoff()`): code rules (`classify()`: asks for a human, refund, chargeback, legal, data deletion,
  ownership, closing the account, anger, 3 failed tries), the model's `create_handoff`, manual payments, tool or AI
  errors, daily caps and the Free allowance. It sets `needs_human`, priority, queue, an internal note and pauses the AI.
  A staff reply or "Take over" also pauses it; "Hand back to AI" resumes.
- Cas (`POST /api/ai/ask`) uses the read-only `CAS_TOOLS` with the same scope rules.
- Knowledge: `server/knowledge-defaults.js` (every default has a `key`) reaches every database through ONE path,
  `seed.syncKnowledge()` on each start: new defaults are inserted, defaults nobody edited are updated, edited ones are
  never overwritten, deleted ones never come back, `RETIRED` keys are removed if unedited, and old untitled rows are
  adopted by title (or a `formerly` title). No prices or per-plan limits in knowledge text: Cas, the support agents and
  the website chat read them from the plans table through `ai.formatPlans()` (prices, connections, subscribers, join
  requests, flows, steps per flow, AI writes, seats, features, trial); `npm run check` checks that output against seed.js.
- `get_usage` and `get_flows` cover Welcome Flows: the join-request meter (`billing.joinMeter`), flows made / live /
  plan limit, and per flow the channel, approve mode, requests, welcomed, let in and people waiting to press Start.
- `llm.complete({ tools })` speaks one neutral tool format and translates it for Claude, OpenRouter and OpenAI.
- Faces: `support_personas.face` picks one of the illustrated faces in `public/img/agents/<face>.svg` (16 built in,
  `supportAi.FACES`; Admin → Support AI → Face). An uploaded photo shows first; with neither, the initials avatar.
  All three come from the same URL, `/api/public/personas/:id/photo`. To add a face: add it to `scripts/agent-faces.js`
  (the generator for all 16, same flat style), run `node scripts/agent-faces.js`, and add the key to `FACES` in
  `services/support-ai.js`. Migration 020 added agents 5–16 to existing databases (only names and faces nobody uses yet).
- Images (`services/support-images.js`): customers upload with `POST /api/support/attachments` (raw body, JPG / PNG / WEBP,
  10 MB, checked by signature and by reading the header; EXIF/XMP/comments and PNG text chunks are removed, JPG
  rotation kept), then send the ids with `POST /api/support { body, attachments }` (max 3). Staff use
  `/api/admin/support/:id/attachments`. Files live in `UPLOAD_DIR/support/<workspace>/`; `GET /api/support/attachments/:id`
  only serves the thread's own customer (never internal notes), `/api/admin/support/attachments/:id` needs
  `support.view`. Unsent uploads go after a day (cleanup worker); files go with the workspace (`media-files.removeFiles`).
- The AI sees up to 4 recent customer images: `historyFrom(messages, imageParts)` turns those messages into
  `[{ type: 'text' }, { type: 'image', mime, data }]` and `llm.js` sends Claude base64 image blocks and OpenRouter/OpenAI
  `image_url` data URLs. No image library in plain Node, so images over 3.75 MB (Claude's 5 MB base64 limit) or 8,000 px
  are described in text and the agent asks for a smaller screenshot. Text inside images is untrusted like any customer text.
- Receipt screenshots: when `recheck_payment` finds the customer's OWN pending manual top-up in a turn where they sent an
  image, `images.linkAsProof()` copies it to that payment's proof (only if it has none and the method takes
  screenshots) and the Finance handoff note gets a copy. Nothing is approved or credited.
- The website chat (logged out) refuses images (`images_not_allowed`). "Powered by Replyvoo" under both chats:
  `support_ai.powered_by` / `powered_by_text`.
- Tests: `test/e2e/support-ai.test.js`; the fake Anthropic plays tool calls with `fakes.ai.script`, the OpenRouter mock
  with `mock.script`. Call `require('server/services/support-ai').tick()` to run the worker once.

## The floating support widget
`public/js/widget.js`, mounted from `renderHelp(view)` (site.js) on every view change. Logged in it uses the same
routes as Help (`GET/POST /api/support`, `/api/support/attachments`); logged out it uses `POST /api/public/chat`
(no account tools, no images). While closed it polls `GET /api/support/unread` (every 25 s, visible tab only; it never
marks anything seen). `GET /api/support` sets `support_threads.user_seen_at`. Faces come from `CFG.support_team`
(public config: the first 4 active agents when the AI support team is on). Hidden on `#app/help`, during sign-up and
while the VooSquare widget is used on the website. Phones: full-screen sheet sized to `visualViewport`, body locked with
`position:fixed` + restored `scrollY` (no jump). Root class is `.swg` (`.sw` and `.app` are taken).

## Customer avatars and nicknames
`public/js/avatar.js` is ONE module for both sides: the browser draws with `AV.render(cfg)`, the server checks with
`AV.clean(cfg, true)` through `server/lib/avatar.js` (unknown keys or values → 400). It is stored in `users.avatar`
(jsonb, ≤ 2,000 chars) and `users.nickname` (≤ 24, letters/numbers/emoji/space . _ - '). Saved with `POST /api/me
{ avatar, nickname }`; `{ avatar_prompt_done: true }` remembers the one-time prompt (`users.avatar_prompted_at`).
`/api/me` returns `nickname`, `avatar`, `avatar_prompt`. Builder, prompt and helpers (`myAva`, `userAva`, `greetName`):
`public/js/app-avatar.js`. Greeting name: nickname > first name > email prefix (`AV.greetName`). To add an option, add it
to `OPTIONS` and draw it in the matching part function; old saved avatars keep working.

## Logins, devices, seats and country
- **Sessions** (`services/auth.js`, `services/security.js`): `sessions` keeps the token hash, `id` (public), `ip_hash`
  (HMAC of the address with APP_SECRET), `ip_country`, `user_agent`, `device_key` ("os|browser", `lib/device.js`) and
  `last_seen_at` (written at most every 5 minutes). Never the raw address (`user_ips` keeps it only for the SEC-2
  self-referral check). Logging a device out deletes its row, so its next request is 401. Routes: `GET /api/me/sessions`,
  `POST /api/me/sessions/:id/revoke`, `POST /api/me/sessions/revoke-others` (Settings → Security). `ctx.session` holds
  `{ tokenHash, sessionId }` of the current request.
- **New-login alerts** (`security.onLogin`, called by `createSession(ctx, user, { created })`): a device + country pair not
  in `user_devices` for 90 days sends `new_login` (email) and a @CastvooBot DM (unless `users.login_alert_tg` is off). Not
  for a new account or the first recorded login. 3 an hour / 10 a day (`rl.hitShared`). The signed link
  `/security/logout-all?u&e&s` (7 days) shows one button (scanners open links); its POST deletes every session.
- **Extra seats** (`billing.setExtraSeats`, `POST /api/app/team/seats`, owner only): `workspaces.extra_seats` +
  `pending_extra_seats`; price `settings.billing.seat_price_cents` (Admin → Settings → Billing; 0 = not sold; yearly = 12×).
  `activate()` charges plan + `seatsNext(ws) × seatPrice(cycle)` in one payment; `dropToFree` clears seats.
  `limits().seats` = plan + extra; invites check `limits().seats_for_invites` against `seatsTaken()` (helper never counts).
- **Country from IP** (`lib/geoip.js`): `countryOf(ctx)` = `CF-IPCountry` header, else the DB-IP Lite CSV loaded from
  `UPLOAD_DIR/geo/dbip-country-lite.csv.gz` (IPv4 Uint32Array, IPv6 BigUint64Array pairs, binary search). The `geoip`
  worker (every 6 h, `GEOIP_AUTO_DOWNLOAD`, default on in production) downloads the new monthly file, validates it and
  renames it over the old one; other instances reload when the file's mtime changes. The address is `ctx.ip`: with
  `TRUST_PROXY` (on by default on Railway) the LAST X-Forwarded-For address, i.e. the one Railway's proxy added; the
  first one is whatever the visitor sent. Used for the sign-up pre-select (`GET /api/public/geo`, not cached), the device
  list and alerts. Never for language: the marketing site picks it from `navigator.languages` (`browserLang` in site.js).
  Attribution (CC BY 4.0) is on the privacy page. Test fixture: `test/fixtures/dbip-country-lite-sample.csv`.

## Guide videos (public/videos)

The Guides page plays the 9 videos listed in `VGUIDES` (public/js/app-guides.js). Each guide needs `<id>.mp4`,
`<id>.vtt` (captions) and `<id>.jpg` (poster). They are part of the app: deploy them with the code (one zip, or git).
A start-up warning ("guide videos missing") and `npm run check` (section 11) catch a deploy without them.

Encode every video like this, so it plays on every iPhone and Android phone and stays about 2 to 3 MB:

```
ffmpeg -i source.mp4 -map 0:v:0 -map 0:a:0 -vf "scale=1280:720:flags=lanczos,format=yuv420p" \
  -c:v libx264 -preset veryslow -profile:v main -level:v 3.1 -crf 28 -x264-params "keyint=300:min-keyint=30:ref=5:bframes=5" \
  -c:a aac -b:a 96k -ar 48000 -ac 2 -map_metadata -1 -movflags +faststart public/videos/<id>.mp4
```

`+faststart` matters: iPhones first ask for 2 bytes (`Range: bytes=0-1`), then need the index at the start of the file.
The server answers those 206 requests itself (server/app.js serveStatic; never compressed). After replacing a video,
bump `GUIDE_V` in app-guides.js so browsers fetch the new file.

## Tests
- `test/e2e/*.test.js` run the real server against a real throwaway PostgreSQL, with fake Telegram,
  Resend, Anthropic, Paystack, Flutterwave, Gatevoo and VooSquare (`test/helpers/fakes.js`).
- Add a test for every bug you fix. Copy the style of the nearest test file.
- `node --test test/e2e/broadcasts.test.js` runs one file.

## Security in place
Sessions are random tokens stored hashed (device list with log out, new-login alerts, no raw IP kept); HttpOnly + SameSite=Lax cookies; CSRF header on every change;
strict Content-Security-Policy (no inline scripts); bot tokens AES-256-GCM encrypted; webhook signatures
checked (Telegram secret token, Paystack HMAC-SHA512, Flutterwave hash, Gatevoo HMAC-SHA256 + 5-minute
window, VooSquare API key, Voo ID `id_token`); rate limits on logins, codes, AI and payments (cost-related ones are
shared by every instance: `rl.hitShared` / route option `shared: true`, table `rate_buckets`); server-to-server routes use
`{ auth: 'service' }` (the router checks the key); the support AI only uses a workspace the person is a member of now,
with owner-only write tools; login codes hashed with
5-try lock; team roles with ranks; audit log; uploads checked by file signature; CSV export protected
against formula injection; tracked-link clicks signed per subscriber.

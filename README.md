# Castvoo

Telegram Welcome Flows (greet, let in and follow up everyone who asks to join a channel), broadcasts,
auto follow-ups, tracked clicks and Cas (the AI helper), with a Free plan, a wallet, referrals, 24/7 AI support (the team takes over when needed)
and an admin panel. Made by Zedapex.

- Website, sign-up and customer dashboard: `/`, `/#signup`, `/#app`
- Admin panel for the team: `/admin`
- Legal pages: `/legal/terms`, `/legal/privacy`, `/legal/refunds`, `/legal/acceptable-use`, `/legal/referral-terms`, `/legal/cookies`

**No npm packages, no build step.** It is plain Node.js 22 + PostgreSQL. `npm install` is not needed.

---

## Put it live on Railway (about 20 minutes)

Full click-by-click guide: [docs/DEPLOY-RAILWAY.md](docs/DEPLOY-RAILWAY.md). Short version:

1. Push this folder to a private GitHub repo.
2. Railway → New Project → Deploy from GitHub repo → pick it. Railway finds the `Dockerfile`.
3. In the project: **+ New → Database → PostgreSQL**.
4. In the Castvoo service: **Settings → Volumes → Add volume**, mount path `/data`.
5. **Variables**: copy the REQUIRED block from `.env.example`
   (`DATABASE_URL=${{Postgres.DATABASE_URL}}`, `APP_SECRET`, `APP_URL`, `OWNER_EMAIL`, `NODE_ENV=production`)
   plus `RESEND_API_KEY` (so login codes arrive) and `CASTVOO_BOT_TOKEN` + `CASTVOO_BOT_USERNAME`.
6. **Settings → Networking → Custom domain** → `castvoo.com`, and add the DNS record Railway shows.
7. Deploy. Open `https://castvoo.com/health` → `{"ok":true}`.
8. Log in at `https://castvoo.com/admin` with your `OWNER_EMAIL`. Go to **Settings & connections** and press
   **Test** next to each service. Then follow [docs/LAUNCH-CHECKLIST.md](docs/LAUNCH-CHECKLIST.md).

The database tables are created automatically on the first start, and updated automatically on every deploy.

---

## Run it on your computer

```bash
npm run dev        # starts a throwaway PostgreSQL + the app on http://localhost:3000
```
Needs PostgreSQL 16 installed (the `postgres` and `initdb` programs). Log in with `owner@example.com`:
the login code is printed in the terminal because no email key is set.

Already have a database? `DATABASE_URL=postgres://... APP_SECRET=$(openssl rand -hex 32) npm start`

## Before every deploy

```bash
npm run check      # 30 seconds: syntax, prices agree everywhere, no unfinished copy, every route protected, env documented
npm test           # 3-4 minutes: 410+ tests against a real database and fake Telegram/Paystack/Flutterwave/Gatevoo/AI/email,
                   # plus the real VooSquare when its repo is next to this one (VOOSQUARE_DIR)
```
Both must pass. (Tests need PostgreSQL 16 installed locally; they start and stop their own.)

---

## Use OpenRouter (optional)

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

---

## Where things are

```
server/
  index.js            starts everything (read this first)
  app.js              web server: turns requests into route calls
  config.js           every environment variable (nothing else reads process.env)
  features.js         feature switches shown in Admin → Features
  permissions.js      team roles, ranks and what each can do
  seed.js             starting prices, countries, payment methods, settings, website text
  knowledge-defaults.js  starting knowledge for Cas, the AI support team and the website chat (editable in Admin → Cas knowledge)
  migrations/         database changes, run automatically in order (001, 002, ...)
  routes/             one file per area of the API (auth, broadcasts, wallet, admin/...)
  services/           the logic: telegram, flows (Welcome Flows), billing (plans, limits, Free plan), email, ai (Cas),
                      llm (Claude / OpenRouter / OpenAI), support, support-ai + support-tools (the 24/7 AI support team), voosquare ...
  payments/index.js   Paystack, Flutterwave, Gatevoo, manual crypto and the team's own manual methods
  workers/            background loops: sending queue, follow-ups, billing, emails, cleanup
  emails/             email layout + all 35 templates
  legal/              the 6 policy pages
  lib/                small tools: our PostgreSQL client, router, helpers
voo-connect/          VooSquare's Voo Connect kit, copied unchanged (login, affiliate hand-off, events). Never edit it.
public/
  index.html, css/, js/   website + sign-up + dashboard (see public/js/README.md)
  admin/                   admin panel
test/                 automated tests (e2e = full flows with fake outside services)
docs/                 guides (start with DEVELOPER-GUIDE.md)
```

## Guides

| Guide | For |
|---|---|
| [docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md) | How the code fits together, the rules, common changes |
| [docs/ADD-A-FEATURE.md](docs/ADD-A-FEATURE.md) | Step-by-step example: adding a new feature end to end |
| [docs/API.md](docs/API.md) | Every API endpoint |
| [docs/DEPLOY-RAILWAY.md](docs/DEPLOY-RAILWAY.md) | Going live, scaling, backups |
| [docs/LAUNCH-CHECKLIST.md](docs/LAUNCH-CHECKLIST.md) | What to check before opening to the public |
| [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) | Telegram, Resend, Anthropic or OpenRouter, Paystack, Flutterwave, Gatevoo, VooSquare (Voo Connect) |
| [docs/PRODUCT-FACTS.md](docs/PRODUCT-FACTS.md) | What Castvoo promises. Copy, emails and policies must agree with it |
| [docs/CHANGES-FROM-TESTS.md](docs/CHANGES-FROM-TESTS.md) | Bugs the tests caught and how they were fixed |

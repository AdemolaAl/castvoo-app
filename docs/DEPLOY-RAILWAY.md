# Deploy Castvoo on Railway

## 1. Create the project
1. Put the code in a **private** GitHub repository.
2. railway.com → **New Project** → **Deploy from GitHub repo** → choose the repo.
   Railway reads `railway.json` and builds the `Dockerfile` (Node 22, no packages to install).
3. **+ New → Database → Add PostgreSQL.**
4. Open the Castvoo service → **Settings → Volumes → + New Volume**, mount path **`/data`**.
   Uploaded photos and videos are stored there (`UPLOAD_DIR=/data/uploads`).

## 2. Variables (Castvoo service → Variables → Raw editor)
Start from `.env.example`. The minimum to start:

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
APP_SECRET=<openssl rand -hex 32>          # never change after launch
APP_URL=https://castvoo.com
OWNER_EMAIL=you@yourdomain.com
NODE_ENV=production
UPLOAD_DIR=/data/uploads
RESEND_API_KEY=re_...                       # login codes are emailed
EMAIL_FROM=Castvoo <hello@castvoo.com>
CASTVOO_BOT_TOKEN=123456:AA...
CASTVOO_BOT_USERNAME=CastvooBot
```
Add the others (AI, payments, Gatevoo, VooSquare) when you have the keys; each one switches
its feature on. See [INTEGRATIONS.md](INTEGRATIONS.md).

`DATABASE_URL` from Railway's private network needs no SSL. If you ever use the public database URL,
add `?sslmode=require` to it.

### Use OpenRouter for Cas (optional)

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

## 3. Domain
Service → **Settings → Networking → Custom Domain** → `castvoo.com` (and `www.castvoo.com` if you like).
Add the CNAME record Railway shows at your DNS provider. HTTPS is automatic.
`APP_URL` must be exactly this address (Telegram, Paystack, Flutterwave and Gatevoo send webhooks to it).

## 4. First start
- Deploy logs show `Castvoo is running` and which integrations are connected.
- `https://castvoo.com/health` answers `{"ok":true}` (Railway also uses it as the health check).
- Log in at `/admin` with `OWNER_EMAIL`. You become the Owner automatically.
- Admin → **Settings & connections** → press **Test** on each service.
- Work through [LAUNCH-CHECKLIST.md](LAUNCH-CHECKLIST.md).

## 5. Updates
Push to GitHub → Railway builds and deploys. New database migrations (`server/migrations/00X_*.sql`)
run automatically on start. `overlapSeconds` in `railway.json` keeps the old version serving until
the new one is healthy, so deploys have no downtime.

Run `npm run check` and `npm test` before pushing.

## 6. Backups
Railway PostgreSQL → **Backups** → turn on daily backups. Also download a manual backup before big changes.
The `/data` volume must be backed up too (Railway → the volume → **Backups**). It holds:
- **payment proofs** (screenshots customers send for manual top-ups): financial evidence, keep them,
- support chat images (customers' and staff screenshots) and the support agents' photos,
- uploaded photos and videos for messages (Telegram keeps its own copy after the first send).

Castvoo checks the volume when it starts, **before** it runs the database migrations (so a refused start never
leaves a half-upgraded database):
- On Railway in production it refuses to start if `UPLOAD_DIR` is not inside `RAILWAY_VOLUME_MOUNT_PATH` (no volume attached).
- It keeps a marker file, `UPLOAD_DIR/.castvoo-volume`. If the marker is missing:
  - and the uploads folder already holds files (photos, payment proofs, support images): this is an existing volume
    from a version that did not write the marker yet. Castvoo writes the marker, logs a warning
    (`uploads volume marker was missing; existing files found`) and starts. **Upgrades need no manual step.**
  - and the folder is empty and the database lists no saved files: a fresh volume. The marker is written; it starts.
  - and the folder is empty but the database lists saved files: the volume was replaced or is not attached. In
    production Castvoo refuses to start with `setup problem: The uploads folder (...) is empty but the database lists N
    saved files`. Re-attach the right volume at `/data`. Set `ALLOW_NO_VOLUME=true` only if you accept the missing files
    (it then starts, writes the marker, and you remove the variable again).

## 7. How much it can handle, and how to grow
One Railway service (1–2 vCPU, 1–2 GB RAM) with the web server and workers together comfortably handles
tens of thousands of customers and **100,000+ messages an hour**. What limits sending is Telegram itself:
about 25 messages a second **per bot** (each customer's bot has its own queue, so many customers send at
the same time).

**The shared channel lane.** Every channel and group post goes out through one bot, @CastvooBot, so all
customers share its 25 posts a second (90,000 an hour). A post reaches the whole channel, so this is a lot,
but if thousands of customers schedule a post for exactly 9:00, the last ones go out a few minutes later.
Admin → System shows this queue as "platform". If it is often long, a later version can add more platform
bots; nothing else needs to change.

When you outgrow one service:
1. Raise the service's CPU/RAM first (Railway → Settings → Resources).
2. Only then think about more replicas. The sending and job code is ready for it (database leases and row
   locks, so no message is sent twice), **but uploaded photos and videos are saved on the `/data` volume, and a
   Railway volume belongs to one replica.** So stay on one replica (the default in `railway.json`) until uploads
   move to object storage such as Cloudflare R2 or S3. Uploads are touched in these places:
   `server/routes/media.js` (save and preview), `server/services/telegram.js` (the first send reads the file;
   after that Telegram's file_id is reused), `server/services/media-files.js` (delete),
   `server/services/payment-proofs.js` (manual top-up proofs), `server/services/support-images.js` (support chat
   images) and `server/services/support-ai.js` (agent photos).
   Rate limits that protect money or AI cost (login codes, Cas, the support chat, the website chat, payment rechecks)
   are counted in PostgreSQL (`rate_buckets`), so they hold across replicas and restarts; other per-route limits are per replica.
3. Watch Admin → **System**: queue size, oldest waiting message, failures.

## 8. If something goes wrong
| Symptom | Check |
|---|---|
| Service won't start | Deploy logs: a `setup problem` line says which variable is missing |
| Login codes don't arrive | `RESEND_API_KEY`, and the sending domain verified in Resend. Admin → Settings → Test email |
| Channels won't connect | `CASTVOO_BOT_TOKEN`; Admin → System → Platform bot webhook shows the last Telegram error |
| Payments stay "pending" | The webhook URL in Paystack/Flutterwave/Gatevoo; Admin → Payments → Recheck |
| Messages queue up | Admin → System → queue per bot; a bot whose token was revoked shows in "Broken connections" |

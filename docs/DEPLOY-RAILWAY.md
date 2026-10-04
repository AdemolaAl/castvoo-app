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
Add the others (AI, payments, Google, Gatevoo, VooSquare) when you have the keys; each one switches
its feature on. See [INTEGRATIONS.md](INTEGRATIONS.md).

`DATABASE_URL` from Railway's private network needs no SSL. If you ever use the public database URL,
add `?sslmode=require` to it.

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
The `/data` volume holds only uploaded media (Telegram keeps its own copy after the first send).

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
   move to object storage such as Cloudflare R2 or S3. Uploads are touched in three places:
   `server/routes/media.js` (save and preview), `server/services/telegram.js` (the first send reads the file;
   after that Telegram's file_id is reused) and `server/services/media-files.js` (delete), so that change is small.
   Also note: login and AI rate limits are kept in memory, so with N replicas each limit is N times looser.
3. Watch Admin → **System**: queue size, oldest waiting message, failures.

## 8. If something goes wrong
| Symptom | Check |
|---|---|
| Service won't start | Deploy logs: a `setup problem` line says which variable is missing |
| Login codes don't arrive | `RESEND_API_KEY`, and the sending domain verified in Resend. Admin → Settings → Test email |
| Channels won't connect | `CASTVOO_BOT_TOKEN`; Admin → System → Platform bot webhook shows the last Telegram error |
| Payments stay "pending" | The webhook URL in Paystack/Flutterwave/Gatevoo; Admin → Payments → Recheck |
| Messages queue up | Admin → System → queue per bot; a bot whose token was revoked shows in "Broken connections" |

# Deploy notes: October 2026 release (for Ademola)

This release adds migrations 008 to 015 (Free plan, Welcome Flows, AI support, security and billing fixes).
The upgrade keeps all data. Follow these steps in order. Tick each one.

## Before you press deploy

1. **Check the volume.** In Railway, open Castvoo → Volumes. A volume must be attached at **/data**.
   `UPLOAD_DIR` must be `/data/uploads`.
2. **Make backups.**
   - Postgres → Backups → **Backup now**, and download it. Turn on daily backups if they are off.
   - Turn on backups for the `/data` volume too. Payment proof screenshots on it are financial evidence.
3. **Volume marker: nothing to do.** Older versions never wrote the file `/data/uploads/.castvoo-volume`.
   This version writes it by itself on the first start when the uploads folder already has files. You will see one
   warning line in the logs: `uploads volume marker was missing; existing files found, marker written`. That is normal.
   - Do **not** set `ALLOW_NO_VOLUME`. Only if the logs say `The uploads folder (...) is empty but the database lists N
     saved files` should you stop and check the volume (it is the wrong volume, or none is attached).
4. **Add `VOO_SERVICE_KEY`.** Make it with `openssl rand -hex 32`. It must be different from `VOO_API_KEY`.
   Send it to whoever runs VooSquare: the VooSquare staff sync (`/api/voosquare/staff`) must now send this key.
   Until they change it, staff sync answers 401. The summary and the support desk keep working with `VOO_API_KEY`.
5. Optional: `LINK_WARN_NEW_DAYS=7`. That is already the default, so you can leave it out.
6. Check these did **not** change:
   - `NODE_ENV=production`
   - `APP_URL` starts with `https://`
   - `APP_SECRET` is the **same** as before. Never change it (it would log everyone out and break saved secrets).

## Deploy, then check straight away

7. The deploy logs show `migrations applied` (008 to 015), then `Castvoo is running`. There must be no `setup problem` line.
8. Open `https://castvoo.com/health`. It must show `{"ok":true}`.
9. Log in at `/admin` **with the email code** for `OWNER_EMAIL`. VooSquare and Telegram logins no longer make you the owner.
10. Admin → Settings & connections → press **Test** on Telegram, Email, AI and each payment provider.
11. In admin, open one old payment proof screenshot and one old uploaded photo. That proves the volume and its files survived.

## Live tests (real money and real accounts, same day)

Everything before this release was tested against fake services. These must be done once on the live site.

12. **Telegram bot and join request.** Connect a real bot. Make a Welcome Flow on a test channel with "approve new
    members" on. From a second phone, ask to join. Check: you get the welcome, you are let in, you tap Start, and you get
    the next message. Do it once on a **Free** workspace and check the line "⚡ Free welcome bot by Castvoo.com" is there.
13. **Payments.**
    - Top up $10 with **Paystack** (live key).
    - Top up $10 with **Flutterwave** (live key). Flutterwave was never tested by QA, so watch this one closely.
    - Top up $2 with **Gatevoo USDT**.
    - Each must credit the wallet **once** and send **one** receipt email.
    - Then make one manual bank top-up and approve it from a **different** staff account (you cannot approve your own).
14. **AI support quality pass.** Admin → Support AI → **Sandbox**, with the real AI key. Ask about 10 real questions,
    for example: payment not showing, how to add a channel, where is my withdrawal, refund, talk to a human.
    Check that the answers are correct, short, never promise money, and hand over to a person when they should.
    Then send one real support message with a screenshot from a customer account and check it arrives.
15. **VooSquare login and staff sync.**
    - "Continue with Voo ID" from a test affiliate link, then top up and start a plan.
    - Check the affiliate sees **one** sale and that a Castvoo referrer is **not** also paid.
    - Ask VooSquare to run one staff sync with the new `VOO_SERVICE_KEY` and check the staff list in admin.
16. **Phones.** Open the site and the dashboard on a real Android phone and a real iPhone. Play one guide video with
    captions on each (automated tests could not play H.264 video).
17. **Commission check with VooSquare.** Ask VooSquare to confirm in writing that the `plan_started` and `plan_renewed`
    events do **not** pay a second commission. Castvoo still sends these events when a Castvoo referrer is the one paid,
    and Castvoo cannot cap VooSquare's own affiliate rate.

## If something goes wrong

- **The new version does not start:** Railway keeps the old version running. Read the `setup problem` line in the
  deploy logs. Fix the variable or the volume, then redeploy. Do not delete the database.
- **A payment credited twice or not at all:** do not fix the wallet by hand first. Note the payment reference and check
  Admin → Payments, then use Admin → user → Wallet correction (it is recorded in the audit log).
- **A tracked link points at a bad page:** Admin → Users → the owner → **Links** tab → **Switch off**. People who tap it
  then see a short notice. You can switch it on again from the same place.

## Still open after this release (not blockers)

- A second reviewer for large manual payments is not built.
- There is no admin editor for the support team hours (`support_ai.team_hours`); the defaults (8am to 10pm WAT) apply.
- Join requests in progress during a deploy can be lost (the person can ask again).

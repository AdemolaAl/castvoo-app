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
| Teach Cas something | Admin → Cas knowledge |
| Add a payment method for a country | Admin → Countries & payments |
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
- **New payment provider**: `server/payments/index.js` (start + verify), a webhook in
  `server/routes/payment-webhooks.js`, a row in `payment_methods` (seed or SQL), then pick it per country in admin.

## Telegram facts the code relies on
- ~30 messages/second per bot (we send 25), 1 message/second per chat, 20/minute per group.
- Text 4,096 characters; photo/video caption 1,024. Photos 10 MB, videos 50 MB (our limits).
- Bots get no read receipts and cannot list channel members.
- A file uploaded once gives a `file_id` that the same bot can reuse.
- Bots can delete their messages for 48 hours.
- After a join request, the bot may message that person for 5 minutes (`user_chat_id`).
- `t.me/<bot>?start=<tag>` passes `<tag>` to `/start`. `?startchannel&admin=...` / `?startgroup&admin=...`
  open Telegram's "add as admin" screen.

## Tests
- `test/e2e/*.test.js` run the real server against a real throwaway PostgreSQL, with fake Telegram,
  Resend, Anthropic, Paystack, Flutterwave, Gatevoo, Google and VooSquare (`test/helpers/fakes.js`).
- Add a test for every bug you fix. Copy the style of the nearest test file.
- `node --test test/e2e/broadcasts.test.js` runs one file.

## Security in place
Sessions are random tokens stored hashed; HttpOnly + SameSite=Lax cookies; CSRF header on every change;
strict Content-Security-Policy (no inline scripts); bot tokens AES-256-GCM encrypted; webhook signatures
checked (Telegram secret token, Paystack HMAC-SHA512, Flutterwave hash, Gatevoo HMAC-SHA256 + 5-minute
window, VooSquare API key, Voo ID `id_token`); rate limits on logins, codes, AI and payments; login codes hashed with
5-try lock; team roles with ranks; audit log; uploads checked by file signature; CSV export protected
against formula injection; tracked-link clicks signed per subscriber.

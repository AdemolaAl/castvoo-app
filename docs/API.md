# API reference

Generated from the code by `node scripts/api-docs.js` (209 routes).

Rules: JSON in and out. Every non-GET request from the browser must send the header `x-cv: 1`. A user in several workspaces sends `x-ws: <workspace id>`. Errors look like `{"error": "Friendly message", "code": "machine_code"}`.
Each route has a comment above it in `server/routes/` explaining its input and output.

## App and website

| Method | Path | Who can call it |
|---|---|---|
| GET | `/api/public/config` | anyone |
| GET | `/api/public/methods` | anyone |
| GET | `/api/public/personas/:id/photo` | anyone |
| POST | `/api/public/chat` | anyone · max 20 per 600s per IP (shared by all servers) |
| POST | `/api/auth/email/start` | anyone · max 150 per 600s per IP (shared by all servers) |
| POST | `/api/auth/email/verify` | anyone · max 300 per 600s per IP (shared by all servers) |
| POST | `/api/auth/telegram` | anyone · max 300 per 600s per IP |
| POST | `/api/auth/logout` | anyone |
| GET | `/api/me` | anyone |
| POST | `/api/me` | logged in |
| POST | `/api/me/email/start` | logged in · max 10 per 600s per account (shared by all servers) |
| POST | `/api/me/email/verify` | logged in · max 20 per 600s per account (shared by all servers) |
| POST | `/api/me/telegram` | logged in |
| GET | `/api/me/export` | logged in · max 5 per 3600s per account |
| POST | `/api/me/delete` | logged in · max 5 per 3600s per account |
| GET | `/api/app/state` | logged in + workspace |
| POST | `/api/app/settings` | logged in + workspace |
| GET | `/api/app/team` | logged in + workspace |
| POST | `/api/app/team/invite` | logged in + workspace · max 30 per 3600s per account |
| POST | `/api/app/team/remove` | logged in + workspace |
| POST | `/api/app/team/role` | logged in + workspace |
| POST | `/api/invites/accept` | logged in |
| GET | `/api/app/plan` | logged in + workspace |
| POST | `/api/app/plan` | logged in + workspace |
| POST | `/api/app/plan/cancel` | logged in + workspace |
| POST | `/api/app/coupon` | logged in + workspace · max 20 per 3600s per account |
| GET | `/api/app/ai-profile` | logged in + workspace |
| POST | `/api/app/ai-profile` | logged in + workspace |
| GET | `/api/connections` | logged in + workspace |
| POST | `/api/connections/bot` | logged in + workspace · max 20 per 600s per account |
| POST | `/api/connections/request` | logged in + workspace |
| DELETE | `/api/connections/:id` | logged in + workspace |
| POST | `/api/me/telegram-link` | logged in · max 20 per 600s per account |
| GET | `/api/connections/:id/start-links` | logged in + workspace |
| POST | `/api/connections/:id/start-links` | logged in + workspace |
| DELETE | `/api/connections/:id/start-links/:tag` | logged in + workspace |
| GET | `/api/subscribers` | logged in + workspace |
| POST | `/api/subscribers/tag` | logged in + workspace |
| GET | `/api/subscribers/export.csv` | logged in + workspace · max 10 per 3600s per account |
| GET | `/api/segments` | logged in + workspace |
| POST | `/api/segments/preview` | logged in + workspace |
| POST | `/api/segments` | logged in + workspace |
| DELETE | `/api/segments/:id` | logged in + workspace |
| POST | `/api/media` | logged in + workspace · max 60 per 600s per account |
| GET | `/api/media/:id` | logged in + workspace |
| GET | `/api/broadcasts` | logged in + workspace |
| GET | `/api/links` | logged in + workspace |
| GET | `/api/broadcasts/estimate` | logged in + workspace |
| GET | `/api/broadcasts/:id` | logged in + workspace |
| POST | `/api/broadcasts` | logged in + workspace · max 60 per 600s per account |
| POST | `/api/broadcasts/:id/approve` | logged in + workspace |
| POST | `/api/broadcasts/:id/send` | logged in + workspace |
| POST | `/api/broadcasts/:id/cancel` | logged in + workspace |
| POST | `/api/broadcasts/:id/edit` | logged in + workspace |
| POST | `/api/broadcasts/:id/pin` | logged in + workspace |
| POST | `/api/broadcasts/:id/delete` | logged in + workspace |
| POST | `/api/broadcasts/test` | logged in + workspace · max 30 per 600s per account |
| GET | `/api/drips` | logged in + workspace |
| POST | `/api/drips` | logged in + workspace |
| PUT | `/api/drips/:id` | logged in + workspace |
| POST | `/api/drips/:id/toggle` | logged in + workspace |
| DELETE | `/api/drips/:id` | logged in + workspace |
| GET | `/api/flows` | logged in + workspace |
| POST | `/api/flows` | logged in + workspace · max 120 per 600s per account |
| POST | `/api/flows/check` | logged in + workspace · max 60 per 60s per account |
| GET | `/api/flows/requests` | logged in + workspace |
| POST | `/api/flows/requests/decide` | logged in + workspace · max 60 per 600s per account |
| GET | `/api/flows/:id` | logged in + workspace |
| GET | `/api/flows/:id/stats` | logged in + workspace |
| PUT | `/api/flows/:id` | logged in + workspace · max 240 per 600s per account |
| POST | `/api/flows/:id/toggle` | logged in + workspace |
| POST | `/api/flows/:id/duplicate` | logged in + workspace · max 60 per 600s per account |
| DELETE | `/api/flows/:id` | logged in + workspace |
| POST | `/api/flows/:id/invite-link` | logged in + workspace · max 20 per 600s per account |
| POST | `/api/ai/write` | logged in + workspace · max 40 per 600s per account (shared by all servers) |
| POST | `/api/ai/rewrite` | logged in + workspace · max 40 per 600s per account (shared by all servers) |
| POST | `/api/ai/translate` | logged in + workspace · max 40 per 600s per account (shared by all servers) |
| POST | `/api/ai/sequence` | logged in + workspace · max 20 per 600s per account (shared by all servers) |
| POST | `/api/ai/ask` | logged in + workspace · max 40 per 600s per account (shared by all servers) |
| GET | `/api/ai/my-examples` | logged in + workspace |
| GET | `/api/wallet` | logged in + workspace |
| POST | `/api/wallet/topup` | logged in + workspace · max 20 per 600s per account |
| POST | `/api/wallet/crypto-txid` | logged in + workspace · max 20 per 600s per account |
| GET | `/api/wallet/manual/:ref` | logged in + workspace |
| POST | `/api/wallet/manual/:ref/screenshot` | logged in + workspace · max 20 per 600s per account |
| POST | `/api/wallet/manual/:ref/submit` | logged in + workspace · max 20 per 600s per account |
| POST | `/api/wallet/check` | logged in + workspace · max 60 per 600s per account |
| GET | `/api/referrals` | logged in + workspace |
| POST | `/api/referrals/use` | logged in + workspace · max 20 per 3600s per account |
| POST | `/api/referrals/withdraw` | logged in + workspace · max 10 per 3600s per account |
| GET | `/api/support` | logged in + workspace |
| POST | `/api/support` | logged in + workspace · max 30 per 600s per account (shared by all servers) |
| POST | `/api/support/attachments` | logged in + workspace · max 20 per 600s per account (shared by all servers) |
| GET | `/api/support/attachments/:id` | logged in |
| GET | `/api/auth/voosquare/start` | anyone |
| GET | `/api/auth/voosquare/callback` | anyone |

## Pages

| Method | Path | Who can call it |
|---|---|---|
| GET | `/health` | anyone |
| GET | `/dashboard` | anyone |
| GET | `/voo-connect-browser.js` | anyone |
| GET | `/legal` | anyone |
| GET | `/legal/:slug` | anyone |
| GET | `/r/:code` | anyone |
| GET | `/l/:code` | anyone |
| GET | `/email/unsubscribe` | anyone |
| GET | `/robots.txt` | anyone |
| GET | `/sitemap.xml` | anyone |

## Webhooks

| Method | Path | Who can call it |
|---|---|---|
| POST | `/tg/platform` | Telegram secret header |
| POST | `/tg/b/:id` | Telegram secret header |
| POST | `/pay/paystack` | provider signature |
| POST | `/pay/flutterwave` | provider signature |
| POST | `/pay/gatevoo` | provider signature |
| GET | `/pay/return` | anyone · max 30 per 600s per IP (shared by all servers) |

## VooSquare (server to server)

| Method | Path | Who can call it |
|---|---|---|
| GET | `/api/voosquare/summary` | Bearer VOO_API_KEY (or VOO_SERVICE_KEY) |
| POST | `/api/voosquare/support/webhook` | Bearer VOO_API_KEY (or VOO_SERVICE_KEY) |
| POST | `/hooks/voosquare/support` | Bearer VOO_API_KEY (or VOO_SERVICE_KEY) |
| GET | `/api/voosquare/support/boxes` | Bearer VOO_API_KEY (or VOO_SERVICE_KEY) |
| GET | `/api/voosquare/support/tickets` | Bearer VOO_API_KEY (or VOO_SERVICE_KEY) |
| GET | `/api/voosquare/support/tickets/:ref` | Bearer VOO_API_KEY (or VOO_SERVICE_KEY) |
| POST | `/api/voosquare/support/tickets/:ref/reply` | Bearer VOO_API_KEY (or VOO_SERVICE_KEY) |
| POST | `/api/voosquare/support/tickets/:ref/update` | Bearer VOO_API_KEY (or VOO_SERVICE_KEY) |
| GET | `/api/voosquare/staff` | Bearer VOO_SERVICE_KEY only |
| POST | `/api/voosquare/staff` | Bearer VOO_SERVICE_KEY only |
| GET | `/api/voosquare/support/threads` | Bearer VOO_API_KEY (or VOO_SERVICE_KEY) |
| GET | `/api/voosquare/support/threads/:id` | Bearer VOO_API_KEY (or VOO_SERVICE_KEY) |
| POST | `/api/voosquare/support/threads/:id/reply` | Bearer VOO_API_KEY (or VOO_SERVICE_KEY) |
| POST | `/api/voosquare/support/threads/:id/status` | Bearer VOO_API_KEY (or VOO_SERVICE_KEY) |

## Voo Connect (VooSquare login)

| Method | Path | Who can call it |
|---|---|---|
| GET | `/auth/voosquare` | anyone · max 300 per 600s per IP |
| POST | `/api/auth/voosquare/link` | logged in · max 20 per 600s per account |
| GET | `/auth/voosquare/callback` | anyone |
| GET | `/logout` | anyone |
| POST | `/logout` | anyone |

## Admin (team only)

| Method | Path | Who can call it |
|---|---|---|
| GET | `/api/admin/me` | staff: `overview.view` |
| GET | `/api/admin/overview` | staff: `overview.view` |
| GET | `/api/admin/users` | staff: `users.view` |
| GET | `/api/admin/users/:id` | staff: `users.view` |
| POST | `/api/admin/users/:id/status` | staff: `users.edit` |
| POST | `/api/admin/workspaces/:id/plan` | staff: `users.edit` |
| POST | `/api/admin/workspaces/:id/wallet` | staff: `wallet.adjust` |
| POST | `/api/admin/links/:code/disable` | staff: `users.edit` |
| GET | `/api/admin/payments` | staff: `payments.view` |
| GET | `/api/admin/payments/:ref/screenshot` | staff: `payments.view` |
| POST | `/api/admin/payments/:ref/approve` | staff: `payments.review` |
| POST | `/api/admin/payments/:ref/reject` | staff: `payments.review` |
| POST | `/api/admin/payments/:ref/chargeback` | staff: `payments.review` |
| POST | `/api/admin/payments/:ref/dispute-won` | staff: `payments.review` |
| GET | `/api/admin/referrals/held` | staff: `payments.view` |
| POST | `/api/admin/referrals/held/:id` | staff: `withdrawals.review` |
| POST | `/api/admin/payments/:ref/recheck` | staff: `payments.review` |
| GET | `/api/admin/withdrawals` | staff: `payments.view` |
| POST | `/api/admin/withdrawals/:id/paid` | staff: `withdrawals.review` |
| POST | `/api/admin/withdrawals/:id/reject` | staff: `withdrawals.review` |
| GET | `/api/admin/plans` | staff: `users.view` |
| GET | `/api/admin/plan-features` | staff: `users.view` |
| POST | `/api/admin/plans` | staff: `pricing.edit` |
| PUT | `/api/admin/plans/:code` | staff: `pricing.edit` |
| GET | `/api/admin/offers` | staff: `users.view` |
| POST | `/api/admin/offers` | staff: `offers.edit` |
| PUT | `/api/admin/offers/:id` | staff: `offers.edit` |
| POST | `/api/admin/offers/:id/toggle` | staff: `offers.edit` |
| DELETE | `/api/admin/offers/:id` | staff: `offers.edit` |
| GET | `/api/admin/countries` | staff: `users.view` |
| PUT | `/api/admin/countries/:code` | staff: `countries.edit` |
| POST | `/api/admin/methods` | staff: `countries.edit` |
| PUT | `/api/admin/methods/:key` | staff: `countries.edit` |
| DELETE | `/api/admin/methods/:key` | staff: `countries.edit` |
| GET | `/api/admin/features` | staff: `overview.view` |
| POST | `/api/admin/features/:key` | staff: `features.edit` |
| GET | `/api/admin/content` | staff: `overview.view` |
| PUT | `/api/admin/content/:key` | staff: `content.edit` |
| GET | `/api/admin/settings` | staff: `overview.view` |
| PUT | `/api/admin/settings/:key` | staff: `settings.save` |
| GET | `/api/admin/support` | staff: `support.view` |
| GET | `/api/admin/support/:id` | staff: `support.view` |
| POST | `/api/admin/support/:id/ai` | staff: `support.reply` |
| POST | `/api/admin/support/:id/reply` | staff: `support.reply` |
| POST | `/api/admin/support/:id/attachments` | staff: `support.reply` · max 60 per 600s per account |
| GET | `/api/admin/support/attachments/:id` | staff: `support.view` |
| POST | `/api/admin/support/:id/status` | staff: `support.reply` |
| POST | `/api/admin/support/:id/assign` | staff: `support.reply` |
| POST | `/api/admin/support/:id/suggest` | staff: `support.reply` · max 60 per 600s per account |
| GET | `/api/admin/emails` | staff: `overview.view` |
| GET | `/api/admin/emails/:key` | staff: `overview.view` |
| PUT | `/api/admin/emails/:key` | staff: `emails.edit` |
| POST | `/api/admin/emails/:key/reset` | staff: `emails.edit` |
| POST | `/api/admin/emails/:key/preview` | staff: `overview.view` |
| POST | `/api/admin/emails/:key/test` | staff: `emails.edit` · max 20 per 600s per account |
| GET | `/api/admin/knowledge` | staff: `overview.view` |
| POST | `/api/admin/knowledge` | staff: `knowledge.edit` |
| PUT | `/api/admin/knowledge/:id` | staff: `knowledge.edit` |
| DELETE | `/api/admin/knowledge/:id` | staff: `knowledge.edit` |
| GET | `/api/admin/ai/provider` | staff: `overview.view` |
| PUT | `/api/admin/ai/provider` | staff: `ai.edit` · max 30 per 600s per account |
| POST | `/api/admin/ai/test` | staff: `knowledge.edit` · max 60 per 600s per account |
| GET | `/api/admin/support-ai` | staff: `support.view` |
| PUT | `/api/admin/support-ai/settings` | staff: `support_ai.edit` · max 60 per 600s per account |
| POST | `/api/admin/support-ai/personas` | staff: `support_ai.edit` |
| PUT | `/api/admin/support-ai/personas/:id` | staff: `support_ai.edit` |
| DELETE | `/api/admin/support-ai/personas/:id` | staff: `support_ai.edit` |
| POST | `/api/admin/support-ai/personas/:id/photo` | staff: `support_ai.edit` · max 30 per 600s per account |
| PUT | `/api/admin/support-ai/personas/:id/face` | staff: `support_ai.edit` |
| DELETE | `/api/admin/support-ai/personas/:id/photo` | staff: `support_ai.edit` |
| GET | `/api/admin/support-ai/workspaces` | staff: `support_ai.test` |
| POST | `/api/admin/support-ai/sandbox` | staff: `support_ai.test` · max 60 per 600s per account |
| GET | `/api/admin/team` | staff: `overview.view` |
| POST | `/api/admin/team` | staff: `team.manage` |
| POST | `/api/admin/team/:id/role` | staff: `team.manage` |
| GET | `/api/admin/audit` | staff: `audit.view` |
| GET | `/api/admin/system` | staff: `system.view` |
| POST | `/api/admin/integrations/:name/test` | staff: `system.view` · max 30 per 600s per account |


'use strict';
/*
 * Payment providers tell us about payments here. We always re-check with the provider's
 * API before crediting, and crediting is idempotent, so retries and duplicates are safe.
 *   Paystack     POST /pay/paystack     header x-paystack-signature = HMAC-SHA512(raw body, secret key)
 *   Flutterwave  POST /pay/flutterwave  header verif-hash = FLW_WEBHOOK_HASH (set the same value in Flutterwave)
 *   Gatevoo      POST /pay/gatevoo      headers x-gatevoo-timestamp + x-gatevoo-signature = HMAC-SHA256("<ts>.<raw body>")
 *   Return page  GET  /pay/return?ref=  where customers land after paying
 */

const config = require('../config');
const db = require('../db');
const log = require('../lib/log');
const payments = require('../payments');
const { hmac, safeEqual } = require('../lib/util');

const json = (ctx) => { try { return JSON.parse(ctx.rawBody.toString('utf8')); } catch { return null; } };

module.exports = (r) => {
  r.post('/pay/paystack', async (ctx) => {
    if (!config.paystack.secretKey) return ctx.send(404, 'off');
    const sig = String(ctx.req.headers['x-paystack-signature'] || '');
    if (!safeEqual(sig, hmac(config.paystack.secretKey, ctx.rawBody, 'sha512'))) return ctx.send(401, 'bad signature');
    const ev = json(ctx);
    if (ev && ev.event === 'charge.success' && ev.data && ev.data.reference) {
      await payments.verifyPaystack(String(ev.data.reference)).catch((e) => log.error('paystack webhook verify failed', { err: e }));
    }
    // A card payment was disputed (chargeback): cancel unsettled referral earnings from that customer and tell
    // VooSquare (chargeback events reverse the affiliate commission). Once per payment, however often Paystack sends it.
    if (ev && ev.event === 'charge.dispute.create' && ev.data) {
      const ref = String((ev.data.transaction && ev.data.transaction.reference) || ev.data.reference || '').slice(0, 60);
      const p = ref ? await db.one("select reference from payments where reference = $1 and provider = 'paystack' and status = 'paid'", [ref]) : null;
      if (p) {
        const r = await payments.chargeback(p.reference, { disputeRef: ev.data.id ? 'paystack:' + ev.data.id : 'paystack' });
        log.warn('paystack dispute opened', { reference: ref, workspace: r.workspace_id, referral_reversed_cents: r.reversed_cents, voo_events: r.events.length, already: r.already });
      }
    }
    ctx.send(200, 'ok');
  }, { raw: true });

  r.post('/pay/flutterwave', async (ctx) => {
    if (!config.flutterwave.webhookHash) return ctx.send(404, 'off');
    if (!safeEqual(String(ctx.req.headers['verif-hash'] || ''), config.flutterwave.webhookHash)) return ctx.send(401, 'bad hash');
    const ev = json(ctx);
    const d = ev && (ev.data || ev);
    if (d && d.tx_ref && (d.status === 'successful' || ev.event === 'charge.completed')) {
      await payments.verifyFlutterwave(String(d.tx_ref), d.id).catch((e) => log.error('flutterwave webhook verify failed', { err: e }));
    }
    ctx.send(200, 'ok');
  }, { raw: true });

  r.post('/pay/gatevoo', async (ctx) => {
    if (!config.gatevoo.webhookSecret) return ctx.send(404, 'off');
    const ts = String(ctx.req.headers['x-gatevoo-timestamp'] || '');
    const sig = String(ctx.req.headers['x-gatevoo-signature'] || '');
    const good = hmac(config.gatevoo.webhookSecret, `${ts}.${ctx.rawBody.toString('utf8')}`);
    if (!safeEqual(sig, good) || !/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return ctx.send(401, 'bad signature');
    const ev = json(ctx);
    if (ev && ev.type === 'invoice.paid' && ev.data && ev.data.order_id) {
      await payments.verifyGatevoo(String(ev.data.order_id)).catch((e) => log.error('gatevoo webhook verify failed', { err: e }));
    }
    ctx.send(200, 'ok'); // invoice.test and other events are simply acknowledged
  }, { raw: true });

  // The page a checkout sends people back to. It asks the provider only for a top-up that is still pending and less
  // than a day old, and is rate-limited per IP (SEC-13), so it can't be used to make us call the providers in a loop.
  r.get('/pay/return', async (ctx) => {
    const ref = String(ctx.query.ref || ctx.query.reference || ctx.query.tx_ref || '').slice(0, 40);
    const open = ref ? await db.one("select 1 from payments where reference = $1 and status = 'pending' and created_at > now() - interval '24 hours'", [ref]) : null;
    if (open) await payments.verify(ref, { transaction_id: ctx.query.transaction_id }).catch(() => false);
    ctx.redirect('/#app/wallet?ref=' + encodeURIComponent(ref));
  }, { rate: [30, 600], shared: true });
};

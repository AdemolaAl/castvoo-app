-- Paystack is no longer a payment method (October 2026). Never edits older migrations.
--
-- Nigeria, Ghana and South Africa now pay through Flutterwave (card, bank transfer and USSD in Nigeria; card and
-- mobile money in Ghana; card in South Africa), plus crypto (Gatevoo) and the team's own methods, as before.
--
-- Old Paystack payments keep working: their rows, the method records (switched off and hidden, not deleted, so the
-- payment history keeps its name), the webhook (/pay/paystack) and the provider check stay, so a pending or old
-- Paystack reference can still be verified. No new Paystack top-up can start (payments/index.js refuses it).

-- 1. The Flutterwave methods that replace Paystack (only added when missing; an existing row is never changed).
insert into payment_methods(key, provider, label, detail, color, icon, sort) values
  ('flw_ng', 'flutterwave', 'Flutterwave', 'Card, bank transfer, USSD', '#F5A623', 'F', 1),
  ('flw_gh', 'flutterwave', 'Flutterwave', 'Card, mobile money', '#F5A623', 'F', 2),
  ('flw_za', 'flutterwave', 'Flutterwave', 'Card', '#F5A623', 'F', 3)
on conflict (key) do nothing;

-- 2. Every country: each Paystack method is replaced by the matching Flutterwave one (in the same place in the list),
--    other Paystack methods are dropped, duplicates are removed, and everything else (crypto, other methods) stays.
update countries c set methods = coalesce((
    select jsonb_agg(k order by first_ord) from (
      select k, min(ord) as first_ord from (
        select case x.e when 'paystack_ng' then 'flw_ng' when 'paystack_gh' then 'flw_gh' when 'paystack_za' then 'flw_za' else x.e end as k, x.ord
        from jsonb_array_elements_text(c.methods) with ordinality as x(e, ord)
        where x.e not in (select key from payment_methods where provider = 'paystack' and key not in ('paystack_ng', 'paystack_gh', 'paystack_za'))
      ) mapped group by k
    ) uniq
  ), '[]'::jsonb)
where jsonb_typeof(c.methods) = 'array'
  and exists (select 1 from jsonb_array_elements_text(c.methods) e(k) join payment_methods m on m.key = e.k and m.provider = 'paystack');

-- 3. Paystack methods: off and hidden in Admin → Countries & payments (kept for the payment history).
update payment_methods set active = false, deleted_at = coalesce(deleted_at, now()) where provider = 'paystack';

-- 4. Website FAQ: the default "How do I pay?" answer named Paystack. Only that exact default sentence changes.
update site_content set value = replace(value, 'like Paystack in Nigeria or M-Pesa in Kenya', 'like card, bank transfer or USSD in Nigeria or M-Pesa in Kenya')
where key = 'faq' and value like '%like Paystack in Nigeria or M-Pesa in Kenya%';

-- Castvoo referral program is now 5 to 15% (Oct 2026): 5% with 1 to 4 paying referrals, 10% from 5, 15% from 20.
-- No tier rate and no cap is ever above 15% (billing.js HARD_CAP_PCT; settings.js clamps the row on load too).
--   settings 'referral'   rates [10,20,30] (the old default) become [5,10,15]; any other rate above 15 becomes 15.
--                         commission_cap_pct and yearly_cap_pct become 15 when missing or above 15 (yearly never above
--                         the commission cap). Other keys (tiers, settle days, minimum withdrawal...) are left alone.
--   knowledge             Cas's "Referral program" article, when it still has the old tier lines, gets the new ones
--                         (articles not edited by hand are also refreshed from knowledge-defaults.js on start).
-- Past earnings in the ledger are NOT changed. Safe to run more than once.

update settings set value = jsonb_set(value, '{rates}', '[5, 10, 15]'::jsonb)
  where key = 'referral' and value->'rates' = '[10, 20, 30]'::jsonb;

update settings set value = jsonb_set(value, '{rates}', (
    select coalesce(jsonb_agg(to_jsonb(least(15, (r.x)::numeric)) order by r.i), '[]'::jsonb)
    from jsonb_array_elements_text(value->'rates') with ordinality as r(x, i)))
  where key = 'referral' and jsonb_typeof(value->'rates') = 'array'
    and exists (select 1 from jsonb_array_elements_text(value->'rates') x where (x)::numeric > 15);

update settings set value = value || jsonb_build_object(
    'commission_cap_pct', least(15, coalesce((value->>'commission_cap_pct')::numeric, 15)),
    'yearly_cap_pct', least(15, coalesce((value->>'commission_cap_pct')::numeric, 15), coalesce((value->>'yearly_cap_pct')::numeric, 15)))
  where key = 'referral';

update knowledge set body = replace(replace(replace(body,
    '- 1 to 4 paying referrals: 10%', '- 1 to 4 paying referrals: 5%'),
    '- 5 to 19: 20%', '- 5 to 19: 10%'),
    '- 20 or more: 30%', '- 20 or more: 15%'), updated_at = now()
  where body like '%- 20 or more: 30%%';

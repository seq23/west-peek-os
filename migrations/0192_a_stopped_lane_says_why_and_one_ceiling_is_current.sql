-- A STOPPED LANE SAYS WHY, AND ONLY ONE CEILING IS CURRENT (18 Sep 2026).
--
-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- WHAT THE OWNER SAW, AND WHAT WAS ACTUALLY TRUE
--
-- On her Home, at 14:10 UTC:
--
--   Pax — Operations Manager · "What the workforce cost today"
--   $0.1768 of $2.5 cap · NORMAL/FRONTIER · 2 blocked run(s)
--
-- Every figure on that line was defensible and two of them were misleading.
--
--   · $0.1768 is correct, and it is committed cost over this firm's own runs today. Nine of the ten
--     Sonnet-5 runs behind it happened between 00:48 and 01:09, BEFORE the deploys at 03:06-07:28.
--     Nothing has reached Sonnet-5 since.
--   · "NORMAL/FRONTIER" was `budget_policy.cost_mode` + `privacy_mode`. `cost_mode` is DERIVED from
--     the spend lever by runAi and never read back; `privacy_mode` is a statement about privacy. The
--     firm was in fact at MODERATE on the lever and CAUTIOUS on the gradient — $9.57 month-to-date
--     against a pro-rated $10 line of $5.87 — with free-first already switched on. The page said
--     NORMAL on a morning the router was economising. Fixed in src/worker/services/mpHome.ts.
--   · "2 blocked run(s)" was a count with no cause and no clock, over a hand-typed list of five
--     statuses that omitted PREFLIGHT_BLOCKED — the status of every named stop the spend lever
--     raises — so a run her own lever had stopped was invisible here while the Cockpit counted it.
--     Fixed in src/worker/ai/spend.ts (`stoppedRuns`, derived from the schema).
--
-- THE TWO RUNS THEMSELVES, named: Parker's card "Draft event kit: October workshop with Kirx Diaz",
-- step 2, at 00:57:48 and 01:03:48. Both attempted `openrouter / anthropic/claude-sonnet-5`, which
-- TIMED OUT, failed over to the direct `anthropic / claude-sonnet-5` lane, and got HTTP 400 back:
-- the Anthropic account has no credit. Neither is still happening; the chain that would now carry
-- them to a working lane shipped later the same morning.
--
-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- 1. A LANE SWITCHED OFF BY HAND SAYS WHY IT WAS SWITCHED OFF.
--
-- `prov_anthropic` is `enabled = 0` and `WP_ANTHROPIC_API_KEY` is set and valid. The Cockpit
-- rendered that as a DISABLED badge beside a green "WP_ANTHROPIC_API_KEY configured" badge and
-- nothing else, which reads as an oversight somebody should correct. Correcting it would have sent
-- Parker's card straight back into the same refusal.
--
-- The key is not the problem and never was; the ACCOUNT IS EMPTY. That sentence belongs on the
-- screen, so it goes where the screen can read it. `providerRouter.ts` now returns it as
-- `unavailable_reason` and `AiOpsPage.tsx` renders it — the field was computed and displayed
-- nowhere until today.
UPDATE provider_registry
   SET cost_metadata_json = json_set(
         CASE WHEN json_valid(cost_metadata_json) THEN cost_metadata_json ELSE '{}' END,
         '$.stood_down_reason',
         'Stood down 18 Sep 2026. The key is valid; the ACCOUNT HAS NO CREDIT — this lane answered '
         || 'HTTP 400 "your credit balance is too low" to both of Parker''s steps at 00:57 and 01:03, '
         || 'and each one stopped a work card. Add credit to the Anthropic account before re-enabling. '
         || 'Nothing is lost while it is off: the same model is served through OpenRouter, which is '
         || 'where every ordinary call goes anyway, and this lane exists only as its outage fallback.')
 WHERE provider_key = 'anthropic';

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- 2. ONLY ONE MONTHLY CEILING IS CURRENT.
--
-- `firm_spend_budget` held TWO rows marked `active = 1` for the MONTHLY window: v1 at $50 (0178)
-- and v2 at $75 (the owner's real ladder, 17 Sep). Every reader in the code today resolves this the
-- same way — `ORDER BY version_no DESC LIMIT 1`, and `MAX(version_no)` in the enforcement gate — so
-- $75 is and was the ceiling in force, and no run was ever measured against the wrong number.
--
-- It is still wrong, and for the reason spend.ts states in its own words: "'retired' is a row with
-- active = 0 rather than a delete". A superseded row left active is a live claim that two ceilings
-- apply, and the first query written without the version subquery — `WHERE active = 1`, which is
-- the obvious thing to write — silently gets $50 and starts refusing work $25 early. Retiring it
-- costs nothing today and removes that tomorrow.
UPDATE firm_spend_budget
   SET active = 0,
       reason = reason || ' — RETIRED 18 Sep 2026: superseded by v2 ($75 hard stop, $50 notify). '
             || 'It was never the ceiling in force; every reader takes the highest version. Left active '
             || 'it was a second answer waiting for the first query that forgot the version subquery.'
 WHERE budget_window = 'MONTHLY' AND active = 1
   AND version_no < (SELECT MAX(version_no) FROM firm_spend_budget b2 WHERE b2.budget_window = 'MONTHLY');

-- Every migration records itself. An unrecorded one is invisible to anything that reasons about
-- schema state, and `tests/policy.test.ts` and `tests/api.test.ts` both go red for it — correctly.
INSERT OR IGNORE INTO schema_version (migration) VALUES ('0192_a_stopped_lane_says_why_and_one_ceiling_is_current');

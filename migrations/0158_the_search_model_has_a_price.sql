-- 0158 — The search model has a price, so it can be chosen.
--
-- FOUND 14 Sep 2026, the first hour the work sweep ran. Every "search" an employee made came back
-- "I don't have live web search or browsing tools in this session" — from `auto`, a general model.
-- loop: liveSearch.ts asks for `perplexity/sonar` (a search-grounded model, the whole reason the
-- module exists), migration 0042 registered it ACTIVE on OpenRouter, and it had NO ROW in
-- provider_pricing_snapshot. runAi only routes to a priced model, so the registry's search model
-- could never be selected: "preferred model perplexity/sonar unavailable, fell to cheapest
-- adequate", on every search, for as long as the model had existed. Wyatt "found" that companies
-- did not exist because the model that answered had never looked.
--
-- A registered model with no price is an inert row wearing an ACTIVE badge. This gives it the
-- price the perplexity-direct row already carried (0004: $1 / $1 per Mtok), and
-- tests/modelRegistry.test.ts now fails the build for any ACTIVE model with no price.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0158_the_search_model_has_a_price');

INSERT INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, captured_at)
SELECT 'pps_openrouter_perplexity_sonar', 'prov_openrouter', 'perplexity/sonar', 1.00, 1.00, '2026-09-14T00:00:00.000Z'
WHERE NOT EXISTS (
  SELECT 1 FROM provider_pricing_snapshot WHERE provider_id = 'prov_openrouter' AND model = 'perplexity/sonar'
);

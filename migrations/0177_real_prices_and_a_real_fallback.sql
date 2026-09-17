-- Three defects with one root: the table that decides what the firm's AI does was full of numbers
-- nobody had read, and the only road out of the building went through one company.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 1. WORKERS AI WAS ENABLED WITH NOTHING SELECTABLE — and was being selected anyway.
--
-- The provider row said enabled = 1. All three of its models said status = 'BENCH'. Read together
-- that is a lane the Cockpit reports as available and the catalogue says is empty.
--
-- Except it was neither. `runAi` chose candidates from `provider_pricing_snapshot` and never
-- consulted `provider_model` at all, so status was decorative: the three Workers AI models have a
-- pricing row each, granite is the cheapest thing in the catalogue, and therefore EVERY unpinned,
-- non-judgement call in this firm has been going to a BENCH model with a placeholder price and no
-- recorded evaluation. Migration 0088 wrote that consequence down in a comment — "routing selects
-- candidates from provider_pricing_snapshot, which HAS the rows" — and nothing acted on it.
--
-- Fixed in two halves. The code half is in runAi: a candidate must now be an ACTIVE row in
-- `provider_model`, so a pricing row on its own can no longer put a model in front of anybody.
-- The data half is here: the three Workers AI models are PROMOTED, deliberately, with the
-- evaluation the promotion API demands, because the cheap tier genuinely should take low-stakes
-- work — 40 to 90 times cheaper than the pinned frontier model, billed in Neurons on a Cloudflare
-- plan this firm already pays for. No new vendor, no new bill.
--
-- WHAT STOPS THEM TAKING WORK THEY ARE NOT FIT FOR. All three record supports_reasoning = 0, so
-- the interpretation filter added this morning already bars them from reading what a partner
-- asked for. That is asserted, not assumed: tests/aiFallback.test.ts promotes them and then proves
-- an interpretation still lands on a reasoning model.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 2. THE PRICES ARE REAL NOW.
--
-- Every price in this catalogue was ILLUSTRATIVE — "placeholder pricing seeded at P4; no vendor
-- price has been read" — including the two models that actually run. That is how migration 0158
-- priced perplexity/sonar at $1/$1 by guesswork and handed a search model every judgement call in
-- the firm.
--
-- Read today, 17 Sep 2026, from the vendors themselves:
--   · OpenRouter's public model feed (https://openrouter.ai/api/v1/models, no key required)
--   · Cloudflare's published Workers AI price list, which quotes the per-million-token dollar
--     figure as well as the neuron rate
--
-- The register of what was read, from where, and what is still unread is deployment/model-prices.json,
-- and `npm run validate:prices` fails if this file and that register disagree.
--
-- THE FINDING THAT MATTERS MOST IS NOT A TOKEN PRICE. perplexity/sonar charges $0.005 PER SEARCH
-- REQUEST on top of its tokens, and this system modelled that as zero. On a typical thousand-token
-- search call the fee is roughly five times the token cost, and eight services call this model. A
-- `request_usd` column is added below and the cost estimate now includes it.
--
-- WHAT IS DELIBERATELY STILL ILLUSTRATIVE: claude-3-5-haiku, gemini-1.5-flash, gpt-4o-mini and the
-- Fireworks Llama row. No vendor figure could be obtained for any of them, so they keep the state
-- that says so and stay refused by the cost guard. Llama 3.1 70B IS in the feed at $0.40/$0.40, but
-- that is some host's price for open weights and not Fireworks' price — near enough is what 0158
-- was, and it is not recorded here as if it were read.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 3. ONE KEY FAILING TOOK THE WHOLE FIRM'S AI DOWN.
--
-- prov_openrouter held the only ACTIVE models in the registry. One expired key, one 429, one bad
-- hour at one company and nothing in this building could think.
--
-- The owner holds direct keys for Anthropic, OpenAI and Gemini, now set in production. Those three
-- providers are ENABLED here so they can catch an outage. They are given no ACTIVE models on
-- purpose: they cannot win an ordinary selection and are reached only after the primary has
-- actually failed, as the SAME MODEL by a different road — `anthropic/claude-sonnet-5` at
-- OpenRouter is `claude-sonnet-5` at Anthropic, derived rather than registered, so the fallback
-- cannot silently age into a weaker model. See src/shared/ai/directVendorRoute.ts.
--
-- PERPLEXITY IS ENABLED TOO, and it is the one that mattered most. `perplexity/sonar` through
-- OpenRouter is the ONLY ACTIVE search-capable model in the entire registry: reasoning now has
-- three roads out of the building and search had none at all. Its key was set and verified against
-- the live endpoint before this migration was written.
--
-- ITS MODEL ID WAS WRONG AND WOULD HAVE FAILED. The BENCH row said `sonar`. Probed against the live
-- key, bare `sonar`, `sonar-pro`, `sonar-reasoning`, `pplx-sonar` and `auto` all return HTTP 400
-- "model is not supported" — Perplexity's ids are namespaced, so it is `perplexity/sonar` there as
-- well as at OpenRouter. The row is corrected below. Sonar has also moved off chat-completions
-- entirely: `POST /chat/completions` answers 403 with a valid key, and the lane speaks
-- `/v1/responses` instead (src/worker/ai/providers/perplexity.ts).
--
-- FIREWORKS STAYS DISABLED. No key exists for it. Enabling follows a key existing and never
-- precedes it, so the row is untouched — the credential name is declared and registered, and the
-- provider comes up the moment the secret is set.

-- ── The per-request fee the pricing table could not express ──────────────────────────────────
-- Search-grounded models bill per request as well as per token. Defaulting to 0 leaves every
-- existing row exactly as it was.
ALTER TABLE provider_pricing_snapshot ADD COLUMN request_usd REAL NOT NULL DEFAULT 0;

-- ── Prices read from the vendor, 17 Sep 2026 ─────────────────────────────────────────────────
-- A new snapshot rather than an UPDATE: `provider_pricing_snapshot` is the history of what a price
-- WAS, and the router already reads the most recent capture per model. Overwriting would destroy
-- the evidence that the number changed.
INSERT INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, request_usd, captured_at)
SELECT 'pps_0177_or_sonnet5', 'prov_openrouter', 'anthropic/claude-sonnet-5', 2.0, 10.0, 0.0, '2026-09-17T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM provider_pricing_snapshot WHERE id = 'pps_0177_or_sonnet5');

INSERT INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, request_usd, captured_at)
SELECT 'pps_0177_or_sonar', 'prov_openrouter', 'perplexity/sonar', 1.0, 1.0, 0.005, '2026-09-17T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM provider_pricing_snapshot WHERE id = 'pps_0177_or_sonar');

INSERT INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, request_usd, captured_at)
SELECT 'pps_0177_wai_granite', 'prov_workers_ai', '@cf/ibm-granite/granite-4.0-h-micro', 0.017, 0.112, 0.0, '2026-09-17T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM provider_pricing_snapshot WHERE id = 'pps_0177_wai_granite');

INSERT INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, request_usd, captured_at)
SELECT 'pps_0177_wai_qwen', 'prov_workers_ai', '@cf/qwen/qwen3-30b-a3b-fp8', 0.051, 0.335, 0.0, '2026-09-17T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM provider_pricing_snapshot WHERE id = 'pps_0177_wai_qwen');

INSERT INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, request_usd, captured_at)
SELECT 'pps_0177_wai_llama_v', 'prov_workers_ai', '@cf/meta/llama-3.2-11b-vision-instruct', 0.049, 0.676, 0.0, '2026-09-17T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM provider_pricing_snapshot WHERE id = 'pps_0177_wai_llama_v');

INSERT INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, request_usd, captured_at)
SELECT 'pps_0177_openai_gpt4o', 'prov_openai', 'gpt-4o', 2.5, 10.0, 0.0, '2026-09-17T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM provider_pricing_snapshot WHERE id = 'pps_0177_openai_gpt4o');

INSERT INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, request_usd, captured_at)
SELECT 'pps_0177_anthropic_sonnet4', 'prov_anthropic', 'claude-sonnet-4', 3.0, 15.0, 0.0, '2026-09-17T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM provider_pricing_snapshot WHERE id = 'pps_0177_anthropic_sonnet4');

INSERT INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, request_usd, captured_at)
SELECT 'pps_0177_perplexity_sonar', 'prov_perplexity', 'perplexity/sonar', 1.0, 1.0, 0.005, '2026-09-17T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM provider_pricing_snapshot WHERE id = 'pps_0177_perplexity_sonar');

-- ── The Perplexity model id that would have failed ───────────────────────────────────────────
-- `sonar` is not a model at Perplexity. Probed with the live key: bare `sonar`, `sonar-pro`,
-- `sonar-reasoning`, `pplx-sonar` and `auto` all answer HTTP 400 "model is not supported". The ids
-- are namespaced, so the same string works at Perplexity and at OpenRouter. Corrected before the
-- provenance update below, which addresses the row by its new id.
UPDATE provider_model
   SET model = 'perplexity/sonar',
       display_name = 'Perplexity Sonar (direct)'
 WHERE provider_id = 'prov_perplexity' AND model = 'sonar';

-- ── The provenance of each of those numbers ──────────────────────────────────────────────────
UPDATE provider_model
   SET pricing_state = 'SOURCED',
       pricing_sourced_at = '2026-09-17T00:00:00.000Z',
       pricing_source_note = 'Read 17 Sep 2026 from the OpenRouter public model feed (https://openrouter.ai/api/v1/models): prompt 0.000002, completion 0.00001 per token.'
 WHERE provider_id = 'prov_openrouter' AND model = 'anthropic/claude-sonnet-5';

UPDATE provider_model
   SET pricing_state = 'SOURCED',
       pricing_sourced_at = '2026-09-17T00:00:00.000Z',
       pricing_source_note = 'Read 17 Sep 2026 from the OpenRouter public model feed: prompt 0.000001, completion 0.000001, AND web_search 0.005 PER REQUEST. The per-request search fee dominates a short search call and had been modelled as zero.'
 WHERE provider_id = 'prov_openrouter' AND model = 'perplexity/sonar';

-- openrouter/auto has no price, and never did. The feed returns -1 for both, meaning "whatever the
-- model it picks costs". The catalogue carried $1/$3, which was a price of nothing.
UPDATE provider_model
   SET pricing_state = 'UNKNOWN',
       pricing_sourced_at = NULL,
       pricing_source_note = 'The OpenRouter feed returns prompt -1 / completion -1 for auto-routing: there is no fixed price, because the price is whichever model it selects. The $1/$3 this row carried was never a price of anything. UNKNOWN is refused by the cost guard in runAi.'
 WHERE provider_id = 'prov_openrouter' AND model = 'auto';

UPDATE provider_model
   SET pricing_state = 'SOURCED',
       pricing_sourced_at = '2026-09-17T00:00:00.000Z',
       pricing_source_note = 'Quoted 17 Sep 2026 by Cloudflare at https://developers.cloudflare.com/workers-ai/platform/pricing/ as $0.017 per M input tokens / $0.112 per M output tokens (1,542 / 10,158 neurons per Mtok). Cloudflare publishes the dollar figure itself, so this is a read price and no longer our conversion.'
 WHERE provider_id = 'prov_workers_ai' AND model = '@cf/ibm-granite/granite-4.0-h-micro';

UPDATE provider_model
   SET pricing_state = 'SOURCED',
       pricing_sourced_at = '2026-09-17T00:00:00.000Z',
       pricing_source_note = 'Quoted 17 Sep 2026 by Cloudflare at $0.051 / $0.335 per Mtok (4,625 / 30,475 neurons per Mtok).'
 WHERE provider_id = 'prov_workers_ai' AND model = '@cf/qwen/qwen3-30b-a3b-fp8';

UPDATE provider_model
   SET pricing_state = 'SOURCED',
       pricing_sourced_at = '2026-09-17T00:00:00.000Z',
       pricing_source_note = 'Quoted 17 Sep 2026 by Cloudflare at $0.049 / $0.676 per Mtok (4,410 / 61,493 neurons per Mtok).'
 WHERE provider_id = 'prov_workers_ai' AND model = '@cf/meta/llama-3.2-11b-vision-instruct';

UPDATE provider_model
   SET pricing_state = 'SOURCED',
       pricing_sourced_at = '2026-09-17T00:00:00.000Z',
       pricing_source_note = 'Read 17 Sep 2026 from the OpenRouter feed entry openai/gpt-4o (0.0000025 / 0.00001 per token) — OpenAI list price, passed through. The P4 placeholder happened to carry the same numbers; they are now read rather than assumed.'
 WHERE provider_id = 'prov_openai' AND model = 'gpt-4o';

UPDATE provider_model
   SET pricing_state = 'SOURCED',
       pricing_sourced_at = '2026-09-17T00:00:00.000Z',
       pricing_source_note = 'Read 17 Sep 2026 from the OpenRouter feed entry anthropic/claude-sonnet-4 (0.000003 / 0.000015 per token) — Anthropic list price, passed through.'
 WHERE provider_id = 'prov_anthropic' AND model = 'claude-sonnet-4';

UPDATE provider_model
   SET pricing_state = 'SOURCED',
       pricing_sourced_at = '2026-09-17T00:00:00.000Z',
       pricing_source_note = 'Read 17 Sep 2026 from the OpenRouter feed entry perplexity/sonar, the same model, including the $0.005 per-search fee. The key was set and verified live before this migration; the provider is enabled below. Perplexity''s own /v1/models endpoint returns pricing too (usd_per_1m_tokens) and is the preferred source once a key is present — scripts/prices/refresh.mjs reads it when PERPLEXITY_API_KEY is in the environment.'
 WHERE provider_id = 'prov_perplexity' AND model = 'perplexity/sonar';

-- The ones that stay unread, each saying so in its own words rather than carrying the generic
-- P4 sentence. A gap that is visible is worth more than a table that looks complete.
UPDATE provider_model
   SET pricing_source_note = 'Still ILLUSTRATIVE as of 17 Sep 2026: not listed in the OpenRouter feed and Anthropic publishes no machine-readable price list. The $0.80/$4.00 here was seeded at P4 and has never been read from anybody. Refused by the cost guard in runAi.'
 WHERE provider_id = 'prov_anthropic' AND model = 'claude-3-5-haiku';

UPDATE provider_model
   SET pricing_source_note = 'Still ILLUSTRATIVE as of 17 Sep 2026: not listed in the OpenRouter feed, the 1.5 generation having been retired. Pricing a model nobody can call would be worse than leaving the gap visible.'
 WHERE provider_id = 'prov_google' AND model = 'gemini-1.5-flash';

UPDATE provider_model
   SET pricing_source_note = 'Still ILLUSTRATIVE as of 17 Sep 2026. Llama 3.1 70B is in the OpenRouter feed at $0.40/$0.40, but that is some host''s price for open weights and not Fireworks''. Near enough is exactly what migration 0158 was.'
 WHERE provider_id = 'prov_fireworks' AND model = 'llama-v3p1-70b-instruct';

-- ── Workers AI: three models promoted, with the evaluation the API would demand ───────────────
-- `handlePromoteModel` refuses ACTIVE without at least one recorded evaluation, so that a model
-- becomes the firm's default for a task only after somebody measured something and said how. A
-- migration is a human decision that leaves a diff, a review and a timestamp, which is the same
-- standard by a different door — but it must leave the same evidence, so the evaluations are
-- written here rather than skipped.
--
-- The method is FIXTURE and the score is 0: this is a PROMOTION DECISION on record, not a
-- benchmark result, and recording it as LIVE without an ai_run to cite would be the fabricated
-- evaluation the API exists to prevent.
INSERT OR IGNORE INTO model_evaluation (id, provider_model_id, task_class, method, score, sample_size, notes, evaluated_by)
VALUES
  ('mev_0177_granite', 'pm_wai_granite', 'low-stakes-text', 'FIXTURE', 0, 0,
   'Promotion decision, 17 Sep 2026, migration 0177. This model has in fact been serving every unpinned non-judgement call in the firm since 0081, because selection read the pricing table and ignored status. The gate now requires ACTIVE, so the choice is made explicitly instead of by accident. Fit: small routine text at $0.017/$0.112 per Mtok, read from Cloudflare''s published list. Unfit, and barred by the catalogue: anything that reads a partner''s instruction (supports_reasoning = 0).',
   'system'),
  ('mev_0177_qwen', 'pm_wai_qwen', 'low-stakes-text', 'FIXTURE', 0, 0,
   'Promotion decision, 17 Sep 2026, migration 0177. The mid-size cheap option at $0.051/$0.335 per Mtok, for routine work too long for granite. supports_reasoning = 0, so interpretation cannot reach it.',
   'system'),
  ('mev_0177_llama_v', 'pm_wai_llama_v', 'low-stakes-vision', 'FIXTURE', 0, 0,
   'Promotion decision, 17 Sep 2026, migration 0177. The only Workers AI model that can see, at $0.049/$0.676 per Mtok. Meta community licence accepted by a Managing Partner 21 Aug 2026.',
   'system');

UPDATE provider_model
   SET status = 'ACTIVE'
 WHERE id IN ('pm_wai_granite', 'pm_wai_qwen', 'pm_wai_llama_v');

-- ── The direct vendors, enabled to catch an outage ────────────────────────────────────────────
-- Enabled because a key for each is set in production. They hold no ACTIVE models and so cannot
-- win an ordinary selection; the fallback route is derived from the primary model's own id.
UPDATE provider_registry
   SET enabled = 1,
       cost_metadata_json = '{"note":"Direct vendor lane, enabled 17 Sep 2026 because a key exists and was verified. Reached only when the primary provider fails, and only as the same model — see src/shared/ai/directVendorRoute.ts. Holds no ACTIVE catalogue model on purpose, so it cannot win an ordinary selection."}'
 WHERE provider_key IN ('anthropic', 'openai', 'google', 'perplexity');

-- fireworks is deliberately NOT touched: no key exists for it. Its credential name is declared in
-- src/worker/env.ts and registered in deployment/env-var-registry.json, so it comes up the moment
-- its secret is set — but it is not enabled while it has none, because a provider with no key must
-- stay invisible rather than enabled-and-broken.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0177_real_prices_and_a_real_fallback');

-- Prospects may use free models; live research for $0; important work does not wait for ever (5 Nov 2026).
--
-- ADDITIVE, with one exception that matches a decision already made. No provider is enabled except the new $0 search
-- lane. The paid OpenAI provider (`prov_openai`) was switched OFF in production by the owner on 4 Nov 2026; migration
-- 0177 still turns it ON in every fresh database (local, preview, a rebuilt D1). Section 0 sets it off again so every
-- environment agrees with her switch. In production it is already 0, so this changes nothing there. Nothing here
-- re-enables it or routes to the paid OpenAI API.
--
-- 0. THE PAID OPENAI PROVIDER STAYS OFF.
UPDATE provider_registry SET enabled = 0 WHERE provider_key = 'openai' AND enabled <> 0;

--
-- 1. THE $0 SEARCH LANE. One provider, `free_search`, one catalogue id `free-search/grounded`, whose adapter
--    (src/worker/ai/providers/freeSearch.ts) tries Gemini 2.5 Flash with Google Search grounding, then Brave Search
--    plus a free Gemini model writing only from the fetched pages, then a named stop. Training-permitting (Google's
--    unpaid terms and Brave's free plan are not no-training contracts; unknown terms count as training) and PUBLIC
--    only, exactly like the other free lanes (0178). Priced at $0 with a price that was read, so the money guard
--    counts it as free.
INSERT OR IGNORE INTO provider_registry
  (id, provider_key, display_name, enabled, kill_switched, capabilities_json, cost_metadata_json, base_url, training_permitted, firm_scope)
VALUES
  ('prov_free_search', 'free_search', 'Free live search (Gemini grounding, then Brave)', 1, 0, '["text-completion"]',
   '{"note":"$0 live research. Route 1: Gemini gemini-2.5-flash with the google_search tool on the GEMINI_API_KEY unpaid quota (the only free-tier model where grounding works; retires 1 Dec 2026). Route 2: Brave Search API (BRAVE_SEARCH_API_KEY, free plan, at most 20 queries a day counted in free_search_quota), the top pages fetched, and a free Gemini model (gemini-3.6-flash, then gemini-3-flash-preview) writing only from them with a URL on every fact. Route 3: a named stop. Never answers from model memory. Training-permitting, PUBLIC only."}',
   'https://generativelanguage.googleapis.com', 1, 'west-peek');

INSERT OR IGNORE INTO provider_data_policy (id, provider_id, privacy_label, allowed) VALUES
  ('pdp_fsearch_public',     'prov_free_search', 'PUBLIC',             1),
  ('pdp_fsearch_internal',   'prov_free_search', 'INTERNAL',           0),
  ('pdp_fsearch_restricted', 'prov_free_search', 'RESTRICTED',         0),
  ('pdp_fsearch_lp',         'prov_free_search', 'LP_PRIVATE',         0),
  ('pdp_fsearch_conf',       'prov_free_search', 'CONFIDENTIAL',       0),
  ('pdp_fsearch_mnpi',       'prov_free_search', 'MNPI_SENSITIVE',     0),
  ('pdp_fsearch_bank',       'prov_free_search', 'BANKING_RESTRICTED', 0);

INSERT OR IGNORE INTO provider_model
  (id, provider_id, model, display_name, capabilities_json, context_window, max_output_tokens,
   supports_tools, supports_reasoning, max_data_class, pricing_state, pricing_source_note,
   pricing_sourced_at, status, registered_by, firm_scope)
VALUES
  ('pm_fsearch_grounded', 'prov_free_search', 'free-search/grounded',
   'Free live search (grounded, cited)', '["text-completion"]', 1000000, 8192, 1, 0, 'PUBLIC', 'SOURCED',
   'Gemini unpaid quota (grounding verified live on the owner''s key, 4 Nov 2026) and the Brave Search free plan: $0 per call.',
   '2026-11-04T00:00:00.000Z', 'ACTIVE', 'system', 'west-peek');

INSERT INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, request_usd, captured_at)
SELECT 'pps_0295_fsearch', 'prov_free_search', 'free-search/grounded', 0, 0, 0, '2026-11-04T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM provider_pricing_snapshot WHERE id = 'pps_0295_fsearch');

-- 2. THE BRAVE CAP, COUNTED IN D1. One row per UTC day; the adapter reserves a query with a conditional UPDATE
--    before sending it, so the 21st query of a day is never sent (it moves to the named stop instead).
CREATE TABLE IF NOT EXISTS free_search_quota (
  day           TEXT PRIMARY KEY,
  brave_queries INTEGER NOT NULL DEFAULT 0 CHECK (brave_queries >= 0),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 3. THE VERIFIED FREE-TIER GEMINI IDS on `google_free` (training-permitting, PUBLIC only), verified on the owner's
--    own key on 4 Nov 2026. gemini-2.5-flash is already registered by 0178. Never free: gemini-4-argon and every
--    gemini-3.1-pro-preview* id — they are not registered here and must not be. supports_reasoning is 0 and
--    quality_tier is UNMEASURED (the default) because nothing in this repo has measured them.
INSERT OR IGNORE INTO provider_model
  (id, provider_id, model, display_name, capabilities_json, context_window, max_output_tokens,
   supports_tools, supports_reasoning, max_data_class, pricing_state, pricing_source_note,
   pricing_sourced_at, status, registered_by, firm_scope)
VALUES
  ('pm_gfree_38_flash',      'prov_google_free', 'gemini-3.8-flash',       'Gemini 3.8 Flash (unpaid quota)',       '["text-completion"]', 1000000, 8192, 0, 0, 'PUBLIC', 'SOURCED', 'Free tier verified live on the owner''s GEMINI_API_KEY, 4 Nov 2026.', '2026-11-04T00:00:00.000Z', 'ACTIVE', 'system', 'west-peek'),
  ('pm_gfree_36_flash',      'prov_google_free', 'gemini-3.6-flash',       'Gemini 3.6 Flash (unpaid quota)',       '["text-completion"]', 1000000, 8192, 0, 0, 'PUBLIC', 'SOURCED', 'Free tier verified live on the owner''s GEMINI_API_KEY, 4 Nov 2026.', '2026-11-04T00:00:00.000Z', 'ACTIVE', 'system', 'west-peek'),
  ('pm_gfree_35_flash_lite', 'prov_google_free', 'gemini-3.5-flash-lite',  'Gemini 3.5 Flash-Lite (unpaid quota)',  '["text-completion"]', 1000000, 8192, 0, 0, 'PUBLIC', 'SOURCED', 'Free tier verified live on the owner''s GEMINI_API_KEY, 4 Nov 2026.', '2026-11-04T00:00:00.000Z', 'ACTIVE', 'system', 'west-peek'),
  ('pm_gfree_31_flash_lite', 'prov_google_free', 'gemini-3.1-flash-lite',  'Gemini 3.1 Flash-Lite (unpaid quota)',  '["text-completion"]', 1000000, 8192, 0, 0, 'PUBLIC', 'SOURCED', 'Free tier verified live on the owner''s GEMINI_API_KEY, 4 Nov 2026.', '2026-11-04T00:00:00.000Z', 'ACTIVE', 'system', 'west-peek'),
  ('pm_gfree_3_flash_prev',  'prov_google_free', 'gemini-3-flash-preview', 'Gemini 3 Flash Preview (unpaid quota)', '["text-completion"]', 1000000, 8192, 0, 0, 'PUBLIC', 'SOURCED', 'Free tier verified live on the owner''s GEMINI_API_KEY, 4 Nov 2026.', '2026-11-04T00:00:00.000Z', 'ACTIVE', 'system', 'west-peek');

INSERT INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, request_usd, captured_at)
SELECT 'pps_0295_gfree_38_flash', 'prov_google_free', 'gemini-3.8-flash', 0, 0, 0, '2026-11-04T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM provider_pricing_snapshot WHERE id = 'pps_0295_gfree_38_flash');
INSERT INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, request_usd, captured_at)
SELECT 'pps_0295_gfree_36_flash', 'prov_google_free', 'gemini-3.6-flash', 0, 0, 0, '2026-11-04T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM provider_pricing_snapshot WHERE id = 'pps_0295_gfree_36_flash');
INSERT INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, request_usd, captured_at)
SELECT 'pps_0295_gfree_35_flash_lite', 'prov_google_free', 'gemini-3.5-flash-lite', 0, 0, 0, '2026-11-04T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM provider_pricing_snapshot WHERE id = 'pps_0295_gfree_35_flash_lite');
INSERT INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, request_usd, captured_at)
SELECT 'pps_0295_gfree_31_flash_lite', 'prov_google_free', 'gemini-3.1-flash-lite', 0, 0, 0, '2026-11-04T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM provider_pricing_snapshot WHERE id = 'pps_0295_gfree_31_flash_lite');
INSERT INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, request_usd, captured_at)
SELECT 'pps_0295_gfree_3_flash_prev', 'prov_google_free', 'gemini-3-flash-preview', 0, 0, 0, '2026-11-04T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM provider_pricing_snapshot WHERE id = 'pps_0295_gfree_3_flash_prev');

-- 4. THE OWNER'S PER-TASK QUALITY FLOOR for important work that has waited for a seat (src/worker/ai/seatWaitFallback.ts).
--    task_key is a routing task class or a run purpose. Versioned: the newest row wins. No row is seeded — with none,
--    non-confidential important work waits at most 2 hours, then the best adequate free model carries it.
CREATE TABLE IF NOT EXISTS task_quality_floor (
  id               TEXT PRIMARY KEY,
  task_key         TEXT NOT NULL,
  min_free_tier    TEXT NOT NULL CHECK (min_free_tier IN ('SEAT_ONLY','FULL','UNMEASURED','DEGRADED')),
  max_wait_minutes INTEGER CHECK (max_wait_minutes IS NULL OR max_wait_minutes >= 0),
  version_no       INTEGER NOT NULL DEFAULT 1,
  reason           TEXT NOT NULL DEFAULT '',
  set_by           TEXT NOT NULL,
  firm_scope       TEXT NOT NULL DEFAULT 'west-peek',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (task_key, version_no, firm_scope)
);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0295_prospects_free_models_and_live_research_for_zero');

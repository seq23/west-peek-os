-- 0042_live_search_model.sql — P49: register Perplexity Sonar for live web search.
--
-- WHAT THIS UNBLOCKS. Market mapping and Research both read only what the firm has already swept,
-- so a topic nobody has swept produces a thin answer. Both declare a WEB_SEARCH source that nothing
-- populated. Sonar is a search-grounded model: it answers from live results and returns the URLs it
-- used, which is the property that matters here — an ordinary model asked "who else is in this
-- space" produces plausible companies that do not exist.
--
-- ROUTED THROUGH THE EXISTING BOUNDARY. This is a model row on a provider that is already enabled
-- and already carries a key. There is no new credential, no new call path, and no new egress
-- exemption: search happens inside run_ai, so it inherits budget preflight, the kill switch, the
-- privacy policy and the ai_run ledger like everything else.
--
-- max_data_class PUBLIC is the important field. Sonar sends the query to a search engine, so a
-- CONFIDENTIAL prompt must never reach it — and the run_ai policy layer enforces that from this
-- row rather than from anyone remembering.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0042_live_search_model');

INSERT OR IGNORE INTO provider_model
  (id, provider_id, model, display_name, capabilities_json, context_window, max_output_tokens,
   supports_tools, supports_reasoning, max_data_class, pricing_state, pricing_source_note,
   status, registered_by, firm_scope)
SELECT
  'pmd_sonar', p.id, 'perplexity/sonar', 'Perplexity Sonar (live web search)',
  '["search","citations"]', 127000, 4000,
  0, 0,
  -- Queries leave for a search engine. Nothing above PUBLIC may be routed here.
  'PUBLIC',
  'ILLUSTRATIVE', 'Per-request search pricing; confirm against OpenRouter before relying on cost figures.',
  'ACTIVE', 'system', 'west-peek'
FROM provider_registry p
WHERE p.provider_key = 'openrouter';

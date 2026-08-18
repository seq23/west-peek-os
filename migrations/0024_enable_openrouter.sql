-- 0024_enable_openrouter.sql — P26 phase 2: OpenRouter becomes the one enabled AI lane.
--
-- Operator decision (2026-08-17, Managing Partner): all AI work flows through OpenRouter for now,
-- and West Peek OS is authorised to share the Repo Operator OpenRouter credential.
--
-- This migration changes ONE FLAG. Everything else OpenRouter needs was already seeded at 0004 and
-- is deliberately left alone:
--
--   base_url            'https://openrouter.ai' — already correct. The adapter appends
--                       `/api/v1/chat/completions`, so a base of '.../api/v1' would double the path.
--   data-class policy   PUBLIC=1, INTERNAL=1 and CONFIDENTIAL / RESTRICTED / LP_PRIVATE /
--                       MNPI_SENSITIVE / BANKING_RESTRICTED all 0. Default-deny on everything
--                       sensitive. Enabling a lane is NOT permission to widen egress, so this
--                       migration does not touch a single data-class row.
--   model               'auto' via pm_openrouter_auto, capped at INTERNAL.
--
-- Forward-compatible and reversible: the inverse is `SET enabled = 0`. No table, column, row or
-- constraint is added or removed, and no other provider is altered — the remaining seven stay
-- disabled, so this does not quietly open a second lane.
--
-- Enabling the provider does NOT by itself make AI work. `OPENROUTER_API_KEY` must be present in
-- the Worker environment; without it the adapter throws `credential_missing:openrouter` and the
-- run fails closed, which is the intended behaviour rather than a silent fallback to another vendor.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0024_enable_openrouter');

UPDATE provider_registry
   SET enabled = 1
 WHERE provider_key = 'openrouter'
   AND kill_switched = 0;

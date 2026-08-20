-- 0004_ai_cost_privacy.sql — P4 governed AI layer (D8 privacy modes, D9 providers-as-config,
-- D10 AI employee lifecycle). Convention: lowercase snake_case, CREATE IF NOT EXISTS /
-- INSERT OR IGNORE so re-application is a no-op. firm_scope on every firm-data table (§11.7).
--
-- The ai_employee seed rows are GENERATED from the single TypeScript registry source
-- (src/shared/registry/aiEmployees.ts) by:
--   node scripts/seed/generate-ai-employee-seed.mjs
-- Do not hand-edit between the GENERATED SEEDS markers; edit the registry and re-run.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0004_ai_cost_privacy');

-- ── Action vocabulary additions (P4) ──
-- The registry source (src/shared/registry/actionTypes.ts) carries these keys and the
-- 0003 generated seed section includes them for fresh databases. These compensating
-- INSERT OR IGNORE statements cover databases that applied 0003 before P4 existed.

INSERT OR IGNORE INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('ai.run', 'Run AI task', 'Run an AI task through the governed run_ai boundary (privacy/cost/egress pipeline).', 0, 0),
  ('ai_employee.tool_scope.grant', 'Grant AI tool scope', 'Grant a tool to an AI employee. An employee can never grant scope to itself.', 0, 0),
  ('ai_output.accept', 'Accept quarantined AI output', 'Promote a quarantined external-provider AI output into governed state (human only).', 0, 0);

-- ── AI employee roster (reference data; D10) ──
-- 31 rows, all INACTIVE. Activation requires the reserved action ai_employee.activate
-- backed by an approved approval card; ≤5 ACTIVE at any time. No route may set status
-- directly — every lifecycle change goes through the service + status history.

CREATE TABLE IF NOT EXISTS ai_employee (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL UNIQUE,
  role                  TEXT NOT NULL,
  layer                 TEXT NOT NULL,
  primary_machines_json TEXT NOT NULL DEFAULT '[]',
  status                TEXT NOT NULL DEFAULT 'INACTIVE'
                        CHECK (status IN ('INACTIVE','CANDIDATE','ACTIVE','PAUSED','RESTRICTED','RETIRED')),
  purpose               TEXT NOT NULL DEFAULT '',
  prompt_version        TEXT NOT NULL DEFAULT 'v0-unactivated',
  tool_allowlist_json   TEXT NOT NULL DEFAULT '[]',
  data_scope_json       TEXT NOT NULL DEFAULT '{}',
  cost_policy_json      TEXT NOT NULL DEFAULT '{}',
  activated_by          TEXT,
  activated_at          TEXT,
  firm_scope            TEXT NOT NULL DEFAULT 'west-peek',
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- BEGIN GENERATED SEEDS (scripts/seed/generate-ai-employee-seed.mjs) — do not hand-edit
-- Registry provenance: AI employee roster v4.0 (Revised v3.0 roster + Whitney, ADR-002).
-- All 19 rows seed INACTIVE; activation is human-reserved (ai_employee.activate), never seed-time.
INSERT OR IGNORE INTO ai_employee (id, name, role, layer, primary_machines_json, status, purpose) VALUES
  ('aie_walker', 'Walker', 'Scooter''s Chief of Staff', 'MP Support', '["command_center","mp_personal_office"]', 'INACTIVE', 'Scooter''s Chief of Staff'),
  ('aie_wren', 'Wren', 'Sequoia''s Chief of Staff', 'MP Support', '["command_center","mp_personal_office"]', 'INACTIVE', 'Sequoia''s Chief of Staff'),
  ('aie_porter', 'Porter', 'Systems & Intake Operator', 'Firm operations', '["global_capture_routing","network_os_sync_verification","systems_data_integration"]', 'INACTIVE', 'Systems & Intake Operator'),
  ('aie_waverly', 'Waverly', 'Relationships & Community', 'Firm operations', '["relationship_intelligence","community_intelligence"]', 'INACTIVE', 'Relationships & Community'),
  ('aie_wells', 'Wells', 'Knowledge Manager', 'Firm operations', '["knowledge_memory_promotion"]', 'INACTIVE', 'Knowledge Manager'),
  ('aie_willow', 'Willow', 'Compliance & Privacy', 'Firm operations', '["legal_compliance_rules","model_governance_privacy_airlock"]', 'INACTIVE', 'Compliance & Privacy'),
  ('aie_pierce', 'Pierce', 'Investment Lead', 'Investment', '["early_stage_deal","ic_decision","secondaries_investment"]', 'INACTIVE', 'Investment Lead'),
  ('aie_wyatt', 'Wyatt', 'Analyst & Scout', 'Investment', '["research_intelligence","investment_mandate_exclusion","venturedeals_deal_math"]', 'INACTIVE', 'Analyst & Scout'),
  ('aie_poppy', 'Poppy', 'IC Facilitator', 'Investment', '["ic_decision"]', 'INACTIVE', 'IC Facilitator'),
  ('aie_walter', 'Walter', 'Meeting Buddy', 'Investment', '["meeting_intelligence"]', 'INACTIVE', 'Meeting Buddy'),
  ('aie_piper', 'Piper', 'LP Sourcing', 'LP & fundraising', '["lp_fundraising"]', 'INACTIVE', 'LP Sourcing'),
  ('aie_wesley', 'Wesley', 'LP Relations', 'LP & fundraising', '["lp_fundraising"]', 'INACTIVE', 'LP Relations'),
  ('aie_winter', 'Winter', 'Portfolio Support', 'Portfolio & operations', '["portfolio_support"]', 'INACTIVE', 'Portfolio Support'),
  ('aie_parker', 'Parker', 'Event Marketing Coordinator', 'Portfolio & operations', '["west_peek_live_events","brand_sponsorship_revenue"]', 'INACTIVE', 'Event Marketing Coordinator'),
  ('aie_pippa', 'Pippa', 'Communications', 'Portfolio & operations', '["marketing_pr_content"]', 'INACTIVE', 'Communications'),
  ('aie_pax', 'Pax', 'Operations Manager', 'Portfolio & operations', '["continuity_maintenance"]', 'INACTIVE', 'Operations Manager'),
  ('aie_preston', 'Preston', 'Finance & Fund Admin', 'Portfolio & operations', '["finance_fund_admin"]', 'INACTIVE', 'Finance & Fund Admin'),
  ('aie_percy', 'Percy', 'UX Design & Growth', 'Portfolio & operations', '["marketing_pr_content","taste_layer"]', 'INACTIVE', 'UX Design & Growth'),
  ('aie_whitney', 'Whitney', 'Professor, West Peek University', 'Learning', '["ic_learning_loop"]', 'INACTIVE', 'Professor, West Peek University');
-- END GENERATED SEEDS

-- ── AI employee lifecycle history (append-only; D15) ──
-- Every status change lands here with actor + reason. Activation/reactivation rows
-- carry the approval receipt id — no silent activation.

CREATE TABLE IF NOT EXISTS ai_employee_status_history (
  id                  TEXT PRIMARY KEY,
  ai_employee_id      TEXT NOT NULL REFERENCES ai_employee (id),
  from_status         TEXT,
  to_status           TEXT NOT NULL,
  actor_type          TEXT NOT NULL
                      CHECK (actor_type IN ('HUMAN','AI','SYSTEM')),
  actor_id            TEXT NOT NULL,
  reason              TEXT NOT NULL,
  approval_receipt_id TEXT,
  firm_scope          TEXT NOT NULL DEFAULT 'west-peek',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_employee_status_history_employee ON ai_employee_status_history (ai_employee_id);

CREATE TRIGGER IF NOT EXISTS ai_employee_status_history_reject_update
BEFORE UPDATE ON ai_employee_status_history
BEGIN
  SELECT RAISE(ABORT, 'ai_employee_status_history is append-only: UPDATE rejected (D15)');
END;

CREATE TRIGGER IF NOT EXISTS ai_employee_status_history_reject_delete
BEFORE DELETE ON ai_employee_status_history
BEGIN
  SELECT RAISE(ABORT, 'ai_employee_status_history is append-only: DELETE rejected (D15)');
END;

-- ── AI employee tool scope ──
-- An employee can never expand its own scope: grants are HUMAN-only, enforced in
-- src/worker/services/aiEmployees.ts (service level), never by the employee itself.

CREATE TABLE IF NOT EXISTS ai_employee_tool_scope (
  id             TEXT PRIMARY KEY,
  ai_employee_id TEXT NOT NULL REFERENCES ai_employee (id),
  tool_key       TEXT NOT NULL,
  granted_by     TEXT NOT NULL,
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (ai_employee_id, tool_key)
);

-- ── Provider registry (D9: providers are configuration, not architecture) ──
-- Seeded DISABLED placeholders. An adapter's existence is not a verified vendor:
-- live provider use is UNPROVEN — CREDENTIAL GATE. base_url is operator config.

CREATE TABLE IF NOT EXISTS provider_registry (
  id                 TEXT PRIMARY KEY,
  provider_key       TEXT NOT NULL UNIQUE,
  display_name       TEXT NOT NULL,
  enabled            INTEGER NOT NULL DEFAULT 0,
  kill_switched      INTEGER NOT NULL DEFAULT 0,
  capabilities_json  TEXT NOT NULL DEFAULT '[]',
  cost_metadata_json TEXT NOT NULL DEFAULT '{}',
  base_url           TEXT,
  firm_scope         TEXT NOT NULL DEFAULT 'west-peek',
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR IGNORE INTO provider_registry (id, provider_key, display_name, enabled, kill_switched, capabilities_json, cost_metadata_json, base_url) VALUES
  ('prov_openai', 'openai', 'OpenAI', 0, 0, '["text-completion"]', '{"note":"ILLUSTRATIVE placeholder entry — operator-maintained config (D9); not a verified vendor"}', 'https://api.openai.com'),
  ('prov_anthropic', 'anthropic', 'Anthropic', 0, 0, '["text-completion"]', '{"note":"ILLUSTRATIVE placeholder entry — operator-maintained config (D9); not a verified vendor"}', 'https://api.anthropic.com'),
  ('prov_google', 'google', 'Google', 0, 0, '["text-completion"]', '{"note":"ILLUSTRATIVE placeholder entry — operator-maintained config (D9); not a verified vendor"}', 'https://generativelanguage.googleapis.com'),
  ('prov_perplexity', 'perplexity', 'Perplexity', 0, 0, '["text-completion"]', '{"note":"ILLUSTRATIVE placeholder entry — operator-maintained config (D9); not a verified vendor"}', 'https://api.perplexity.ai'),
  ('prov_openrouter', 'openrouter', 'OpenRouter', 0, 0, '["text-completion"]', '{"note":"ILLUSTRATIVE placeholder entry — operator-maintained config (D9); not a verified vendor"}', 'https://openrouter.ai');

-- ── Provider pricing snapshots ──
-- ILLUSTRATIVE placeholder pricing only. Real pricing is operator-maintained config,
-- captured as dated snapshots; the latest snapshot per provider/model drives estimates.

CREATE TABLE IF NOT EXISTS provider_pricing_snapshot (
  id                  TEXT PRIMARY KEY,
  provider_id         TEXT NOT NULL REFERENCES provider_registry (id),
  model               TEXT NOT NULL,
  input_per_mtok_usd  REAL NOT NULL,
  output_per_mtok_usd REAL NOT NULL,
  captured_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_provider_pricing_provider ON provider_pricing_snapshot (provider_id, model, captured_at);

-- ILLUSTRATIVE placeholder pricing (NOT verified vendor pricing; operator maintains real snapshots):
INSERT OR IGNORE INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, captured_at) VALUES
  ('pps_openai_gpt4o_mini', 'prov_openai', 'gpt-4o-mini', 0.15, 0.60, '2026-01-01T00:00:00.000Z'),
  ('pps_openai_gpt4o', 'prov_openai', 'gpt-4o', 2.50, 10.00, '2026-01-01T00:00:00.000Z'),
  ('pps_anthropic_haiku', 'prov_anthropic', 'claude-3-5-haiku', 0.80, 4.00, '2026-01-01T00:00:00.000Z'),
  ('pps_anthropic_sonnet', 'prov_anthropic', 'claude-sonnet-4', 3.00, 15.00, '2026-01-01T00:00:00.000Z'),
  ('pps_google_flash', 'prov_google', 'gemini-1.5-flash', 0.075, 0.30, '2026-01-01T00:00:00.000Z'),
  ('pps_perplexity_sonar', 'prov_perplexity', 'sonar', 1.00, 1.00, '2026-01-01T00:00:00.000Z'),
  ('pps_openrouter_auto', 'prov_openrouter', 'auto', 1.00, 3.00, '2026-01-01T00:00:00.000Z');

-- ── Provider data policy (DEFAULT DENY) ──
-- Absence of an allowing row = denied. Sensitive labels (CONFIDENTIAL, RESTRICTED,
-- LP_PRIVATE, MNPI_SENSITIVE, BANKING_RESTRICTED) are denied for every external
-- provider; only PUBLIC/INTERNAL may be allowed, per provider.

CREATE TABLE IF NOT EXISTS provider_data_policy (
  id            TEXT PRIMARY KEY,
  provider_id   TEXT NOT NULL REFERENCES provider_registry (id),
  privacy_label TEXT NOT NULL,
  allowed       INTEGER NOT NULL DEFAULT 0,
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (provider_id, privacy_label)
);

INSERT OR IGNORE INTO provider_data_policy (id, provider_id, privacy_label, allowed) VALUES
  ('pdp_openai_public', 'prov_openai', 'PUBLIC', 1),
  ('pdp_openai_internal', 'prov_openai', 'INTERNAL', 1),
  ('pdp_openai_confidential', 'prov_openai', 'CONFIDENTIAL', 0),
  ('pdp_openai_restricted', 'prov_openai', 'RESTRICTED', 0),
  ('pdp_openai_lp_private', 'prov_openai', 'LP_PRIVATE', 0),
  ('pdp_openai_mnpi', 'prov_openai', 'MNPI_SENSITIVE', 0),
  ('pdp_openai_banking', 'prov_openai', 'BANKING_RESTRICTED', 0),
  ('pdp_anthropic_public', 'prov_anthropic', 'PUBLIC', 1),
  ('pdp_anthropic_internal', 'prov_anthropic', 'INTERNAL', 1),
  ('pdp_anthropic_confidential', 'prov_anthropic', 'CONFIDENTIAL', 0),
  ('pdp_anthropic_restricted', 'prov_anthropic', 'RESTRICTED', 0),
  ('pdp_anthropic_lp_private', 'prov_anthropic', 'LP_PRIVATE', 0),
  ('pdp_anthropic_mnpi', 'prov_anthropic', 'MNPI_SENSITIVE', 0),
  ('pdp_anthropic_banking', 'prov_anthropic', 'BANKING_RESTRICTED', 0),
  ('pdp_google_public', 'prov_google', 'PUBLIC', 1),
  ('pdp_google_internal', 'prov_google', 'INTERNAL', 1),
  ('pdp_google_confidential', 'prov_google', 'CONFIDENTIAL', 0),
  ('pdp_google_restricted', 'prov_google', 'RESTRICTED', 0),
  ('pdp_google_lp_private', 'prov_google', 'LP_PRIVATE', 0),
  ('pdp_google_mnpi', 'prov_google', 'MNPI_SENSITIVE', 0),
  ('pdp_google_banking', 'prov_google', 'BANKING_RESTRICTED', 0),
  ('pdp_perplexity_public', 'prov_perplexity', 'PUBLIC', 1),
  ('pdp_perplexity_internal', 'prov_perplexity', 'INTERNAL', 1),
  ('pdp_perplexity_confidential', 'prov_perplexity', 'CONFIDENTIAL', 0),
  ('pdp_perplexity_restricted', 'prov_perplexity', 'RESTRICTED', 0),
  ('pdp_perplexity_lp_private', 'prov_perplexity', 'LP_PRIVATE', 0),
  ('pdp_perplexity_mnpi', 'prov_perplexity', 'MNPI_SENSITIVE', 0),
  ('pdp_perplexity_banking', 'prov_perplexity', 'BANKING_RESTRICTED', 0),
  ('pdp_openrouter_public', 'prov_openrouter', 'PUBLIC', 1),
  ('pdp_openrouter_internal', 'prov_openrouter', 'INTERNAL', 1),
  ('pdp_openrouter_confidential', 'prov_openrouter', 'CONFIDENTIAL', 0),
  ('pdp_openrouter_restricted', 'prov_openrouter', 'RESTRICTED', 0),
  ('pdp_openrouter_lp_private', 'prov_openrouter', 'LP_PRIVATE', 0),
  ('pdp_openrouter_mnpi', 'prov_openrouter', 'MNPI_SENSITIVE', 0),
  ('pdp_openrouter_banking', 'prov_openrouter', 'BANKING_RESTRICTED', 0);

-- ── Budget / privacy / cost policy (versioned, immutable) ──
-- Policy change = a NEW row (latest row per firm_scope wins); UPDATE/DELETE are
-- rejected by trigger. Firmwide changes require the reserved action
-- governance.policy_change via authorize() + approval receipt (P3 mechanism).
-- privacy_mode default LOCKDOWN: fail closed — no external provider egress until an
-- MP deliberately changes policy.

CREATE TABLE IF NOT EXISTS budget_policy (
  id                   TEXT PRIMARY KEY,
  firm_scope           TEXT NOT NULL DEFAULT 'west-peek',
  cost_mode            TEXT NOT NULL DEFAULT 'NORMAL'
                       CHECK (cost_mode IN ('NORMAL','CHEAPO','CRITICAL_ONLY','STRATEGIC_SURGE')),
  privacy_mode         TEXT NOT NULL DEFAULT 'LOCKDOWN'
                       CHECK (privacy_mode IN ('LOCAL','FRONTIER','LOCKDOWN')),
  daily_cap_usd        REAL NOT NULL DEFAULT 0,
  per_run_cap_usd      REAL NOT NULL DEFAULT 0,
  strategic_surge_json TEXT,
  set_by               TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER IF NOT EXISTS budget_policy_reject_update
BEFORE UPDATE ON budget_policy
BEGIN
  SELECT RAISE(ABORT, 'budget_policy is immutable: UPDATE rejected (policy versioning)');
END;

CREATE TRIGGER IF NOT EXISTS budget_policy_reject_delete
BEFORE DELETE ON budget_policy
BEGIN
  SELECT RAISE(ABORT, 'budget_policy is immutable: DELETE rejected (policy versioning)');
END;

-- Default firmwide policy: NORMAL cost, LOCKDOWN privacy (fail closed), placeholder caps.
INSERT OR IGNORE INTO budget_policy (id, firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, strategic_surge_json, set_by) VALUES
  ('bp_default_west_peek', 'west-peek', 'NORMAL', 'LOCKDOWN', 25.0, 2.0, NULL, 'system');

-- ── AI run ledger ──
-- EVERY run lands here, including blocked ones (no silent spend): trace_id, cost
-- estimate, terminal status, and failure reason. External-provider outputs are
-- quarantined (output_quarantine = 1) until an explicit human accept step.

CREATE TABLE IF NOT EXISTS ai_run (
  id                     TEXT PRIMARY KEY,
  purpose                TEXT NOT NULL,
  actor_type             TEXT NOT NULL
                         CHECK (actor_type IN ('HUMAN','AI','SYSTEM')),
  actor_id               TEXT NOT NULL,
  ai_employee_id         TEXT REFERENCES ai_employee (id),
  capability_requirement TEXT,
  sensitivity            TEXT NOT NULL,
  privacy_mode           TEXT NOT NULL,
  cost_mode              TEXT NOT NULL,
  provider_id            TEXT REFERENCES provider_registry (id),
  model                  TEXT,
  status                 TEXT NOT NULL
                         CHECK (status IN ('PREFLIGHT_BLOCKED','BUDGET_BLOCKED','EGRESS_BLOCKED','KILL_SWITCHED','PROVIDER_DISABLED','QUEUED','RUNNING','COMPLETED','FAILED','BLOCKED_DEFERRED')),
  cost_estimate_json     TEXT NOT NULL DEFAULT '{}',
  actual_usage_json      TEXT,
  input_hash             TEXT NOT NULL,
  output_quarantine      INTEGER NOT NULL DEFAULT 0,
  output_text            TEXT,
  trace_id               TEXT NOT NULL UNIQUE,
  failure_reason         TEXT,
  firm_scope             TEXT NOT NULL DEFAULT 'west-peek',
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at           TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_run_created ON ai_run (created_at);
CREATE INDEX IF NOT EXISTS idx_ai_run_status ON ai_run (status, firm_scope);
CREATE INDEX IF NOT EXISTS idx_ai_run_employee ON ai_run (ai_employee_id);

-- ── Eval + value ledgers ──

CREATE TABLE IF NOT EXISTS eval_record (
  id             TEXT PRIMARY KEY,
  ai_employee_id TEXT NOT NULL REFERENCES ai_employee (id),
  eval_set       TEXT NOT NULL,
  score_json     TEXT NOT NULL DEFAULT '{}',
  run_id         TEXT REFERENCES ai_run (id),
  recorded_by    TEXT NOT NULL,
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_eval_record_employee ON eval_record (ai_employee_id);

CREATE TABLE IF NOT EXISTS value_outcome (
  id           TEXT PRIMARY KEY,
  ai_run_id    TEXT NOT NULL REFERENCES ai_run (id),
  outcome_type TEXT NOT NULL,
  value_note   TEXT NOT NULL,
  recorded_by  TEXT NOT NULL,
  firm_scope   TEXT NOT NULL DEFAULT 'west-peek',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_value_outcome_run ON value_outcome (ai_run_id);

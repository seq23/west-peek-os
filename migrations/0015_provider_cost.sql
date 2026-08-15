-- 0015_provider_cost.sql — P16 Provider/Model Router + AI Cost Command Center
-- (task §9 P16; GAP-02, GAP-03).
--
-- Extends the P4 governed AI layer; it does not replace it. `provider_registry`,
-- `provider_pricing_snapshot`, `provider_data_policy`, `budget_policy`, and `ai_run` are
-- untouched, and every AI call still goes through `run_ai()`.
--
-- Two honesty rules are encoded as columns rather than left to prose:
-- - `provider_model.pricing_state` — a price is SOURCED, ILLUSTRATIVE, STALE, or UNKNOWN, with the
--   note and date that justify it. The seeded catalogue is ILLUSTRATIVE, matching the placeholder
--   pricing 0004 already carries, and the UI prints the state beside every number.
-- - `provider_health_check.mode` — LOCAL_FIXTURE or LIVE. A health row can never imply a live check
--   that did not happen.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0015_provider_cost');

-- ── Action vocabulary additions (P16) ──

INSERT OR IGNORE INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('provider_model.register', 'Register a provider model', 'Add or update a model in the provider catalogue with its capability, context, latency, and pricing provenance.', 0, 0),
  ('provider_model.promote', 'Promote or demote a model', 'Move a model between ACTIVE, BENCH, and DEPRECATED.', 0, 0),
  ('provider_health.check', 'Run a provider health check', 'Record a provider reachability check, stamped LOCAL_FIXTURE or LIVE.', 0, 0),
  ('model_evaluation.record', 'Record a model evaluation', 'Record a benchmark or evaluation result with the method that produced it.', 0, 0),
  ('routing_policy.set', 'Set a task routing policy', 'Publish a new version of the ordered provider/model routing policy for a task class.', 0, 0),
  ('machine_model_policy.set', 'Set a machine model policy', 'Set the preferred provider/model and maximum data class for one machine.', 0, 0),
  ('budget_scope.set', 'Set a scoped AI budget', 'Publish a new version of a per-employee/machine/provider/model/category budget.', 0, 0),
  ('cost_alert.decide', 'Acknowledge a cost alert', 'Acknowledge or resolve a budget-threshold alert.', 0, 0);

-- ── Model catalogue ──

CREATE TABLE IF NOT EXISTS provider_model (
  id                  TEXT PRIMARY KEY,
  provider_id         TEXT NOT NULL REFERENCES provider_registry (id),
  model               TEXT NOT NULL,
  display_name        TEXT NOT NULL,
  capabilities_json   TEXT NOT NULL DEFAULT '["text-completion"]',
  context_window      INTEGER,
  max_output_tokens   INTEGER,
  supports_tools      INTEGER NOT NULL DEFAULT 0,
  supports_reasoning  INTEGER NOT NULL DEFAULT 0,
  latency_p50_ms      INTEGER,
  latency_source      TEXT NOT NULL DEFAULT 'UNKNOWN'
                      CHECK (latency_source IN ('UNKNOWN','VENDOR_PUBLISHED','MEASURED_LOCAL','MEASURED_LIVE')),
  max_data_class      TEXT NOT NULL DEFAULT 'INTERNAL',
  pricing_state       TEXT NOT NULL DEFAULT 'UNKNOWN'
                      CHECK (pricing_state IN ('SOURCED','ILLUSTRATIVE','STALE','UNKNOWN')),
  pricing_source_note TEXT NOT NULL DEFAULT '',
  pricing_sourced_at  TEXT,
  status              TEXT NOT NULL DEFAULT 'BENCH' CHECK (status IN ('ACTIVE','BENCH','DEPRECATED')),
  registered_by       TEXT NOT NULL,
  firm_scope          TEXT NOT NULL DEFAULT 'west-peek',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (provider_id, model)
);

-- Catalogue rows for the models 0004 already priced. pricing_state is ILLUSTRATIVE for every one
-- of them, because that is exactly what the seeded pricing is: placeholder configuration, not
-- vendor-sourced fact. Nothing here may be presented to an operator as a current price.
INSERT OR IGNORE INTO provider_model
  (id, provider_id, model, display_name, capabilities_json, context_window, supports_tools, supports_reasoning,
   max_data_class, pricing_state, pricing_source_note, status, registered_by)
VALUES
  ('pm_openai_gpt4o_mini', 'prov_openai', 'gpt-4o-mini', 'GPT-4o mini', '["text-completion"]', 128000, 1, 0, 'INTERNAL', 'ILLUSTRATIVE', 'Placeholder pricing seeded at P4; no vendor price has been read.', 'BENCH', 'system'),
  ('pm_openai_gpt4o', 'prov_openai', 'gpt-4o', 'GPT-4o', '["text-completion"]', 128000, 1, 0, 'INTERNAL', 'ILLUSTRATIVE', 'Placeholder pricing seeded at P4; no vendor price has been read.', 'BENCH', 'system'),
  ('pm_anthropic_haiku', 'prov_anthropic', 'claude-3-5-haiku', 'Claude 3.5 Haiku', '["text-completion"]', 200000, 1, 0, 'INTERNAL', 'ILLUSTRATIVE', 'Placeholder pricing seeded at P4; no vendor price has been read.', 'BENCH', 'system'),
  ('pm_anthropic_sonnet', 'prov_anthropic', 'claude-sonnet-4', 'Claude Sonnet 4', '["text-completion"]', 200000, 1, 1, 'INTERNAL', 'ILLUSTRATIVE', 'Placeholder pricing seeded at P4; no vendor price has been read.', 'BENCH', 'system'),
  ('pm_google_flash', 'prov_google', 'gemini-1.5-flash', 'Gemini 1.5 Flash', '["text-completion"]', 1000000, 1, 0, 'INTERNAL', 'ILLUSTRATIVE', 'Placeholder pricing seeded at P4; no vendor price has been read.', 'BENCH', 'system'),
  ('pm_perplexity_sonar', 'prov_perplexity', 'sonar', 'Perplexity Sonar', '["text-completion","web-search"]', 128000, 0, 0, 'PUBLIC', 'ILLUSTRATIVE', 'Placeholder pricing seeded at P4; no vendor price has been read.', 'BENCH', 'system'),
  ('pm_openrouter_auto', 'prov_openrouter', 'auto', 'OpenRouter auto-route', '["text-completion"]', 128000, 1, 0, 'INTERNAL', 'ILLUSTRATIVE', 'Placeholder pricing seeded at P4; no vendor price has been read.', 'BENCH', 'system');

-- ── Provider health ──
-- LOCAL_FIXTURE is the only mode this runtime can honestly produce: it records that the
-- configuration is present and coherent, NOT that the vendor answered.

CREATE TABLE IF NOT EXISTS provider_health_check (
  id          TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES provider_registry (id),
  mode        TEXT NOT NULL CHECK (mode IN ('LOCAL_FIXTURE','LIVE')),
  ok          INTEGER NOT NULL,
  latency_ms  INTEGER,
  detail      TEXT NOT NULL DEFAULT '',
  checked_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_provider_health ON provider_health_check (provider_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS provider_health_check_reject_update
BEFORE UPDATE ON provider_health_check
BEGIN
  SELECT RAISE(ABORT, 'provider_health_check is append-only: UPDATE rejected (D15)');
END;

-- ── Model evaluation ──
-- `method` prevents a fixture score from ever reading as a live benchmark.

CREATE TABLE IF NOT EXISTS model_evaluation (
  id                TEXT PRIMARY KEY,
  provider_model_id TEXT NOT NULL REFERENCES provider_model (id),
  task_class        TEXT NOT NULL,
  method            TEXT NOT NULL CHECK (method IN ('FIXTURE','OFFLINE_DETERMINISTIC','LIVE')),
  score             REAL NOT NULL,
  sample_size       INTEGER NOT NULL DEFAULT 0,
  notes             TEXT NOT NULL DEFAULT '',
  evaluated_by      TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_model_evaluation ON model_evaluation (provider_model_id, task_class);

CREATE TRIGGER IF NOT EXISTS model_evaluation_reject_update
BEFORE UPDATE ON model_evaluation
BEGIN
  SELECT RAISE(ABORT, 'model_evaluation is append-only: UPDATE rejected (D15)');
END;

-- ── Routing policy (versioned, immutable) ──
-- `candidates_json` is an ORDERED list of {provider_key, model}. The router tries them in order
-- and records what it tried. A task class with no policy keeps the P4 behaviour exactly
-- (cheapest priced capable model, no fallback) — routing is opt-in per task class.

CREATE TABLE IF NOT EXISTS routing_policy (
  id              TEXT PRIMARY KEY,
  task_class      TEXT NOT NULL,
  version_no      INTEGER NOT NULL,
  candidates_json TEXT NOT NULL DEFAULT '[]',
  require_capability TEXT NOT NULL DEFAULT 'text-completion',
  max_data_class  TEXT NOT NULL DEFAULT 'INTERNAL',
  allow_fallback  INTEGER NOT NULL DEFAULT 1,
  notes           TEXT NOT NULL DEFAULT '',
  set_by          TEXT NOT NULL,
  firm_scope      TEXT NOT NULL DEFAULT 'west-peek',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (task_class, version_no)
);

CREATE TRIGGER IF NOT EXISTS routing_policy_reject_update
BEFORE UPDATE ON routing_policy
BEGIN
  SELECT RAISE(ABORT, 'routing_policy is versioned/immutable: UPDATE rejected — publish a new version');
END;

CREATE TABLE IF NOT EXISTS machine_model_policy (
  machine_id            INTEGER PRIMARY KEY REFERENCES machine (id),
  preferred_provider_key TEXT,
  preferred_model       TEXT,
  max_data_class        TEXT NOT NULL DEFAULT 'INTERNAL',
  notes                 TEXT NOT NULL DEFAULT '',
  set_by                TEXT NOT NULL,
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ── Routing explanation, recorded per run ──
-- Answers "why this model?" from stored fact rather than reconstruction.

CREATE TABLE IF NOT EXISTS ai_run_routing (
  ai_run_id             TEXT PRIMARY KEY REFERENCES ai_run (id),
  task_class            TEXT,
  policy_id             TEXT REFERENCES routing_policy (id),
  selected_provider_key TEXT,
  selected_model        TEXT,
  attempts_json         TEXT NOT NULL DEFAULT '[]',
  fallback_used         INTEGER NOT NULL DEFAULT 0,
  explanation           TEXT NOT NULL DEFAULT '',
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER IF NOT EXISTS ai_run_routing_reject_update
BEFORE UPDATE ON ai_run_routing
BEGIN
  SELECT RAISE(ABORT, 'ai_run_routing is the recorded explanation of a run: UPDATE rejected');
END;

-- ── Cost attribution ──
-- ai_run already records the employee. This adds machine / work / category so spend can be read
-- by the dimensions an operator actually manages.

CREATE TABLE IF NOT EXISTS ai_run_attribution (
  ai_run_id    TEXT PRIMARY KEY REFERENCES ai_run (id),
  machine_id   INTEGER REFERENCES machine (id),
  work_card_id TEXT REFERENCES work_card (id),
  category     TEXT NOT NULL DEFAULT 'OTHER'
               CHECK (category IN ('PROACTIVE','RESEARCH','LEGAL','COMPLIANCE','OPERATIONS','INTELLIGENCE','OTHER')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_run_attribution_machine ON ai_run_attribution (machine_id);

-- ── Scoped budgets (versioned, immutable; latest active version per scope wins) ──
-- The firmwide daily/per-run caps in `budget_policy` are unchanged and still enforced first.
-- These are ADDITIONAL ceilings: a run must satisfy every scope it falls inside.

CREATE TABLE IF NOT EXISTS budget_scope (
  id          TEXT PRIMARY KEY,
  scope_type  TEXT NOT NULL
              CHECK (scope_type IN ('FIRM','EMPLOYEE','MACHINE','PROVIDER','MODEL','CATEGORY')),
  scope_id    TEXT NOT NULL,
  period      TEXT NOT NULL CHECK (period IN ('DAILY','WEEKLY','MONTHLY')),
  cap_usd     REAL NOT NULL,
  version_no  INTEGER NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  reason      TEXT NOT NULL DEFAULT '',
  set_by      TEXT NOT NULL,
  firm_scope  TEXT NOT NULL DEFAULT 'west-peek',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (scope_type, scope_id, period, version_no)
);

CREATE INDEX IF NOT EXISTS idx_budget_scope_lookup ON budget_scope (scope_type, scope_id, period, version_no DESC);

CREATE TRIGGER IF NOT EXISTS budget_scope_reject_update
BEFORE UPDATE ON budget_scope
BEGIN
  SELECT RAISE(ABORT, 'budget_scope is versioned/immutable: UPDATE rejected — publish a new version');
END;

CREATE TRIGGER IF NOT EXISTS budget_scope_reject_delete
BEFORE DELETE ON budget_scope
BEGIN
  SELECT RAISE(ABORT, 'budget_scope is versioned/immutable: DELETE rejected');
END;

CREATE TABLE IF NOT EXISTS cost_alert (
  id            TEXT PRIMARY KEY,
  scope_type    TEXT NOT NULL,
  scope_id      TEXT NOT NULL,
  period        TEXT NOT NULL,
  threshold_pct INTEGER NOT NULL,
  cap_usd       REAL NOT NULL,
  observed_usd  REAL NOT NULL,
  severity      TEXT NOT NULL CHECK (severity IN ('WARNING','BREACH')),
  status        TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED')),
  dedupe_key    TEXT NOT NULL UNIQUE,
  decided_by    TEXT,
  decided_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_cost_alert_status ON cost_alert (status, created_at DESC);

-- ── Fireworks provider row (D9: providers are configuration) ──
-- Registered DISABLED with no credential, exactly like every other provider seeded at P4.
-- Registering a vendor is configuration; using it is a credential gate that has not been passed.

INSERT OR IGNORE INTO provider_registry (id, provider_key, display_name, enabled, kill_switched, capabilities_json, cost_metadata_json, base_url) VALUES
  ('prov_fireworks', 'fireworks', 'Fireworks AI', 0, 0, '["text-completion"]', '{"note":"ILLUSTRATIVE placeholder entry — operator-maintained config (D9); not a verified vendor"}', 'https://api.fireworks.ai');

INSERT OR IGNORE INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, captured_at) VALUES
  ('pps_fireworks_llama_70b', 'prov_fireworks', 'llama-v3p1-70b-instruct', 0.90, 0.90, '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO provider_model
  (id, provider_id, model, display_name, capabilities_json, context_window, supports_tools, supports_reasoning,
   max_data_class, pricing_state, pricing_source_note, status, registered_by)
VALUES
  ('pm_fireworks_llama_70b', 'prov_fireworks', 'llama-v3p1-70b-instruct', 'Llama 3.1 70B Instruct (Fireworks)', '["text-completion"]', 128000, 1, 0, 'INTERNAL', 'ILLUSTRATIVE', 'Placeholder pricing registered at P16; no vendor price has been read.', 'BENCH', 'system');

-- Default deny stays default deny: no provider_data_policy row is created for Fireworks, so no
-- label may egress to it until an operator explicitly allows one.

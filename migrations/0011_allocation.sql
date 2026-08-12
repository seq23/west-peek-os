-- 0011_allocation.sql — P11 fund construction, cross-sleeve allocation, reserves,
-- and follow-on review: scenarios pinned to policy VERSIONS, comparable capital
-- options, deterministic comparison runs, constraint violations, reserve
-- allocations, and follow-on reviews.
-- Convention: lowercase snake_case (P1); CREATE IF NOT EXISTS / INSERT OR IGNORE so
-- re-application is a no-op. firm_scope on every firm-data table (§11.7).
--
-- Law (plan §8/P11):
-- - Every scenario PINS the mandate, sleeve, reserve, and concentration policy
--   version ids plus the calculation model version. Policy rows are already
--   immutable (0002 triggers), so a scenario's inputs can never be rewritten
--   underneath a recorded decision.
-- - A comparison run is a stored snapshot of deterministic arithmetic over those
--   pinned inputs. It ranks nothing and recommends nothing.
-- - AI can never approve. Reserve, follow-on, and cross-sleeve allocation each
--   require their own approved receipt (reserve_allocation.approve,
--   follow_on.approve, capital_allocation_cross_sleeve.approve).
-- - NO TABLE HERE MOVES MONEY. Approving an option records a human decision; the
--   actual capital movement stays a human/banking act outside this system.
-- - Modelled outcomes are SCENARIOS, never expected returns (§12.4).

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0011_allocation');

-- ── Action vocabulary additions (P11) ──

INSERT OR IGNORE INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('fund_scenario.create', 'Create fund construction scenario', 'Open a scenario pinned to specific mandate/sleeve/reserve/concentration policy versions.', 0, 0),
  ('fund_scenario.add_assumption', 'Record scenario assumption', 'Record a stated, visible assumption on a scenario (append-only).', 0, 0),
  ('allocation_option.create', 'Add capital allocation option', 'Add an initial, follow-on, reserve, secondary, or exit option to a scenario for comparison.', 0, 0),
  ('allocation_comparison.run', 'Run cross-sleeve comparison', 'Compute the deterministic constraint/concentration/reserve effects of every option in a scenario.', 0, 0),
  ('follow_on_review.create', 'Open follow-on review', 'Open a governed follow-on review for a portfolio position.', 0, 0);

-- ── Scenarios: policy versions are PINNED, never referenced loosely ──

CREATE TABLE IF NOT EXISTS fund_construction_scenario (
  id                            TEXT PRIMARY KEY,
  fund_id                       TEXT NOT NULL REFERENCES fund (id),
  name                          TEXT NOT NULL,
  status                        TEXT NOT NULL DEFAULT 'DRAFT'
                                CHECK (status IN ('DRAFT','COMPARED','UNDER_REVIEW','DECIDED','ARCHIVED')),
  -- Pinned policy versions (§8/P11 "required stored versions").
  mandate_version_id            TEXT NOT NULL REFERENCES investment_mandate_version (id),
  sleeve_version_id             TEXT NOT NULL REFERENCES sleeve_policy_version (id),
  reserve_version_id            TEXT NOT NULL REFERENCES reserve_policy_version (id),
  concentration_version_id      TEXT NOT NULL REFERENCES concentration_policy_version (id),
  -- Pinned calculation model (src/shared/allocation ALLOCATION_MODEL_VERSION).
  model_version                 TEXT NOT NULL,
  -- Fund state the scenario was opened against, in fund currency. Stated inputs,
  -- not derived truth: a scenario is only as good as the numbers it names.
  fund_size                     REAL NOT NULL,
  investable                    REAL NOT NULL,
  fund_deployed                 REAL NOT NULL DEFAULT 0,
  reserve_committed             REAL NOT NULL DEFAULT 0,
  reserve_modeled_need          REAL NOT NULL DEFAULT 0,
  notes                         TEXT,
  privacy_label                 TEXT NOT NULL DEFAULT 'CONFIDENTIAL',
  firm_scope                    TEXT NOT NULL DEFAULT 'west-peek',
  created_by                    TEXT NOT NULL,
  created_at                    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_fund_scenario_fund ON fund_construction_scenario (fund_id, status);

-- Assumptions are VISIBLE and append-only: a scenario never quietly changes what it
-- assumed after someone reviewed it.
CREATE TABLE IF NOT EXISTS scenario_assumption (
  id            TEXT PRIMARY KEY,
  scenario_id   TEXT NOT NULL REFERENCES fund_construction_scenario (id),
  assumption_key TEXT NOT NULL,
  assumption_value TEXT NOT NULL,
  basis         TEXT NOT NULL,
  stated_by     TEXT NOT NULL,
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_scenario_assumption_scenario ON scenario_assumption (scenario_id);

CREATE TRIGGER IF NOT EXISTS scenario_assumption_reject_update
BEFORE UPDATE ON scenario_assumption
BEGIN
  SELECT RAISE(ABORT, 'scenario_assumption is append-only: UPDATE rejected (assumptions stay visible as stated)');
END;

CREATE TRIGGER IF NOT EXISTS scenario_assumption_reject_delete
BEFORE DELETE ON scenario_assumption
BEGIN
  SELECT RAISE(ABORT, 'scenario_assumption is append-only: DELETE rejected (assumptions stay visible as stated)');
END;

-- ── Comparable capital options ──
-- One shape for every kind of capital call on the fund, so initial, follow-on,
-- reserve, secondary, and exit options are compared in ONE framework (§8/P11).

CREATE TABLE IF NOT EXISTS capital_allocation_option (
  id                    TEXT PRIMARY KEY,
  scenario_id           TEXT NOT NULL REFERENCES fund_construction_scenario (id),
  option_type           TEXT NOT NULL
                        CHECK (option_type IN ('INITIAL','FOLLOW_ON','RESERVE','SECONDARY_PURCHASE','SECONDARY_SALE','EXIT')),
  label                 TEXT NOT NULL,
  company_id            TEXT REFERENCES canonical_company (id),
  position_id           TEXT REFERENCES position (id),
  sleeve_key            TEXT NOT NULL,
  sleeve_target_pct     REAL NOT NULL,
  sleeve_deployed       REAL NOT NULL DEFAULT 0,
  capital               REAL NOT NULL,
  reserve_draw          REAL NOT NULL DEFAULT 0,
  existing_company_cost REAL NOT NULL DEFAULT 0,
  mandate_exclusions_json TEXT NOT NULL DEFAULT '[]',
  -- Human-decided outcome. AI can never write this (service-enforced), and it is
  -- only set behind an approved receipt for the option type's reserved action.
  decision              TEXT NOT NULL DEFAULT 'UNDECIDED'
                        CHECK (decision IN ('UNDECIDED','APPROVED','REJECTED')),
  decided_by            TEXT,
  decided_at            TEXT,
  approval_card_id      TEXT REFERENCES approval_card (id),
  proposed_by_type      TEXT NOT NULL DEFAULT 'HUMAN' CHECK (proposed_by_type IN ('HUMAN','AI')),
  proposed_by_id        TEXT NOT NULL,
  ai_run_id             TEXT REFERENCES ai_run (id),
  firm_scope            TEXT NOT NULL DEFAULT 'west-peek',
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_allocation_option_scenario ON capital_allocation_option (scenario_id, option_type);

-- ── Comparison runs: a stored snapshot of deterministic arithmetic ──

CREATE TABLE IF NOT EXISTS cross_sleeve_comparison_run (
  id                       TEXT PRIMARY KEY,
  scenario_id              TEXT NOT NULL REFERENCES fund_construction_scenario (id),
  model_version            TEXT NOT NULL,
  -- The policy versions are re-recorded ON THE RUN, so a run remains readable and
  -- self-explaining even if the scenario is later archived or re-pointed.
  mandate_version_id       TEXT NOT NULL REFERENCES investment_mandate_version (id),
  sleeve_version_id        TEXT NOT NULL REFERENCES sleeve_policy_version (id),
  reserve_version_id       TEXT NOT NULL REFERENCES reserve_policy_version (id),
  concentration_version_id TEXT NOT NULL REFERENCES concentration_policy_version (id),
  option_count             INTEGER NOT NULL,
  breach_count             INTEGER NOT NULL,
  -- Honest labelling: these are modelled scenarios, never expected returns.
  outcome_label            TEXT NOT NULL DEFAULT 'MODELLED SCENARIO — NOT AN EXPECTED RETURN',
  run_by                   TEXT NOT NULL,
  firm_scope               TEXT NOT NULL DEFAULT 'west-peek',
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_comparison_run_scenario ON cross_sleeve_comparison_run (scenario_id, created_at);

CREATE TRIGGER IF NOT EXISTS comparison_run_reject_update
BEFORE UPDATE ON cross_sleeve_comparison_run
BEGIN
  SELECT RAISE(ABORT, 'cross_sleeve_comparison_run is immutable: UPDATE rejected (a run is a snapshot of stated inputs)');
END;

CREATE TRIGGER IF NOT EXISTS comparison_run_reject_delete
BEFORE DELETE ON cross_sleeve_comparison_run
BEGIN
  SELECT RAISE(ABORT, 'cross_sleeve_comparison_run is immutable: DELETE rejected');
END;

CREATE TABLE IF NOT EXISTS comparison_run_option_result (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES cross_sleeve_comparison_run (id),
  option_id           TEXT NOT NULL REFERENCES capital_allocation_option (id),
  sleeve_budget       REAL NOT NULL,
  sleeve_remaining_after REAL NOT NULL,
  sleeve_fits         INTEGER NOT NULL,
  concentration_pct_before REAL NOT NULL,
  concentration_pct_after  REAL NOT NULL,
  concentration_within_limit INTEGER NOT NULL,
  reserve_uncommitted_after REAL NOT NULL,
  reserve_coverage_pct_after REAL NOT NULL,
  reserve_sufficient  INTEGER NOT NULL,
  undeployed_after    REAL NOT NULL,
  breach_count        INTEGER NOT NULL,
  firm_scope          TEXT NOT NULL DEFAULT 'west-peek',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_run_option_result_run ON comparison_run_option_result (run_id);

CREATE TRIGGER IF NOT EXISTS run_option_result_reject_update
BEFORE UPDATE ON comparison_run_option_result
BEGIN
  SELECT RAISE(ABORT, 'comparison_run_option_result is immutable: UPDATE rejected');
END;

CREATE TRIGGER IF NOT EXISTS run_option_result_reject_delete
BEFORE DELETE ON comparison_run_option_result
BEGIN
  SELECT RAISE(ABORT, 'comparison_run_option_result is immutable: DELETE rejected');
END;

-- Violations are RECORDED, not hidden behind a boolean: a reviewer sees exactly
-- which policy an option breaches and by how much.
CREATE TABLE IF NOT EXISTS constraint_violation (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES cross_sleeve_comparison_run (id),
  option_id   TEXT NOT NULL REFERENCES capital_allocation_option (id),
  kind        TEXT NOT NULL
              CHECK (kind IN ('SLEEVE_CAPACITY','CONCENTRATION_LIMIT','RESERVE_SHORTFALL','MANDATE_EXCLUSION','UNDEPLOYED_CAPITAL')),
  severity    TEXT NOT NULL CHECK (severity IN ('BREACH','WARNING')),
  detail      TEXT NOT NULL,
  limit_value REAL,
  observed    REAL NOT NULL,
  firm_scope  TEXT NOT NULL DEFAULT 'west-peek',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_constraint_violation_run ON constraint_violation (run_id, option_id);

CREATE TRIGGER IF NOT EXISTS constraint_violation_reject_update
BEFORE UPDATE ON constraint_violation
BEGIN
  SELECT RAISE(ABORT, 'constraint_violation is immutable: UPDATE rejected (a breach is never edited away)');
END;

CREATE TRIGGER IF NOT EXISTS constraint_violation_reject_delete
BEFORE DELETE ON constraint_violation
BEGIN
  SELECT RAISE(ABORT, 'constraint_violation is immutable: DELETE rejected (a breach is never edited away)');
END;

-- ── Reserve allocations and follow-on reviews ──
-- A reserve allocation is a RESERVATION against the reserve pool, recorded behind an
-- approved receipt. It commits nothing outside this system and moves no money.

CREATE TABLE IF NOT EXISTS reserve_allocation (
  id                 TEXT PRIMARY KEY,
  fund_id            TEXT NOT NULL REFERENCES fund (id),
  company_id         TEXT NOT NULL REFERENCES canonical_company (id),
  option_id          TEXT REFERENCES capital_allocation_option (id),
  reserve_version_id TEXT NOT NULL REFERENCES reserve_policy_version (id),
  amount             REAL NOT NULL,
  status             TEXT NOT NULL DEFAULT 'COMMITTED'
                     CHECK (status IN ('COMMITTED','RELEASED')),
  approval_card_id   TEXT NOT NULL REFERENCES approval_card (id),
  committed_by       TEXT NOT NULL,
  released_by        TEXT,
  released_at        TEXT,
  release_reason     TEXT,
  firm_scope         TEXT NOT NULL DEFAULT 'west-peek',
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_reserve_allocation_fund ON reserve_allocation (fund_id, status);

CREATE TABLE IF NOT EXISTS follow_on_review (
  id                TEXT PRIMARY KEY,
  scenario_id       TEXT NOT NULL REFERENCES fund_construction_scenario (id),
  company_id        TEXT NOT NULL REFERENCES canonical_company (id),
  position_id       TEXT REFERENCES position (id),
  option_id         TEXT REFERENCES capital_allocation_option (id),
  -- The follow-on path math (dealmath computeFollowOn) as run, stored whole so the
  -- review is readable later without re-running anything.
  path_json         TEXT NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'OPEN'
                    CHECK (status IN ('OPEN','REVIEWED','CLOSED')),
  reviewed_by       TEXT,
  reviewed_at       TEXT,
  review_note       TEXT,
  privacy_label     TEXT NOT NULL DEFAULT 'CONFIDENTIAL',
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_follow_on_review_scenario ON follow_on_review (scenario_id, status);

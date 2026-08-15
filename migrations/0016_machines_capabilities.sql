-- 0016_machines_capabilities.sql — P17 Machine Control Center + Capability Intelligence
-- (task §9 P17; GAP-06, GAP-07).
--
-- The 45-machine registry (D14) stays exactly as seeded from `src/shared/registry/machines.ts`.
-- This migration adds the OPERATIONAL state around it, in a separate table, so the registry
-- remains the one versioned source and re-application stays a no-op.
--
-- Pause has teeth: `machine_state.status = 'PAUSED'` is enforced in TWO places (capture routing
-- and the run_ai boundary), not merely rendered in the UI. A paused machine cannot be given work
-- and cannot spend money.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0016_machines_capabilities');

-- ── Action vocabulary additions (P17) ──

INSERT OR IGNORE INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('machine_state.configure', 'Configure a machine', 'Set a machine''s owner, SLA, priority, allowed tools, data access, or evidence expectation.', 0, 0),
  ('machine_state.pause', 'Pause or resume a machine', 'Stop or restart work routing and AI spend for one machine.', 0, 0),
  ('machine_dependency.declare', 'Declare a machine dependency', 'Record that one machine depends on another.', 0, 0),
  ('machine_memory.append', 'Append machine memory', 'Append a durable operating note to a machine''s memory.', 0, 0),
  ('capability.register', 'Register a capability', 'Register an internal firm capability with its maturity, dependencies, and tested state.', 0, 0),
  ('capability.transition', 'Move a capability between Active, Bench, and Archive', 'Change a capability''s operating state.', 0, 0),
  ('capability.assign', 'Assign a capability', 'Assign a capability to an AI employee or a machine.', 0, 0),
  ('capability_after_action.record', 'Record capability after-action', 'Record what actually happened when a capability was used.', 0, 0),
  ('build_vs_buy.decide', 'Record a build-vs-buy decision', 'Record a build, buy, or defer decision for a capability with its rationale.', 0, 0);

-- ── Machine operating state ──

CREATE TABLE IF NOT EXISTS machine_state (
  machine_id           INTEGER PRIMARY KEY REFERENCES machine (id),
  owner_firm_user_id   TEXT REFERENCES firm_user (id),
  status               TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED')),
  priority             TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','CRITICAL')),
  sla_target           TEXT NOT NULL DEFAULT '',
  allowed_tools_json   TEXT NOT NULL DEFAULT '[]',
  data_access_json     TEXT NOT NULL DEFAULT '[]',
  evidence_expectation TEXT NOT NULL DEFAULT '',
  notes                TEXT NOT NULL DEFAULT '',
  paused_by            TEXT,
  paused_at            TEXT,
  pause_reason         TEXT,
  updated_by           TEXT NOT NULL DEFAULT 'system',
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Every registry machine starts ACTIVE with no operator configuration, so the control centre
-- shows the real fleet on first load instead of an empty table.
INSERT OR IGNORE INTO machine_state (machine_id, status, updated_by)
SELECT id, 'ACTIVE', 'system' FROM machine;

CREATE TABLE IF NOT EXISTS machine_state_change (
  id          TEXT PRIMARY KEY,
  machine_id  INTEGER NOT NULL REFERENCES machine (id),
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  reason      TEXT NOT NULL,
  actor_id    TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER IF NOT EXISTS machine_state_change_reject_update
BEFORE UPDATE ON machine_state_change
BEGIN
  SELECT RAISE(ABORT, 'machine_state_change is append-only: UPDATE rejected (D15)');
END;

CREATE TABLE IF NOT EXISTS machine_dependency (
  id                    TEXT PRIMARY KEY,
  machine_id            INTEGER NOT NULL REFERENCES machine (id),
  depends_on_machine_id INTEGER NOT NULL REFERENCES machine (id),
  kind                  TEXT NOT NULL DEFAULT 'DATA' CHECK (kind IN ('DATA','APPROVAL','SCHEDULE','TOOL')),
  note                  TEXT NOT NULL DEFAULT '',
  declared_by           TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (machine_id, depends_on_machine_id, kind),
  CHECK (machine_id <> depends_on_machine_id)
);

-- Durable operating memory for a machine: what it learned, what broke, what an operator must
-- know next time. Append-only, because a machine's history is evidence.
CREATE TABLE IF NOT EXISTS machine_memory (
  id          TEXT PRIMARY KEY,
  machine_id  INTEGER NOT NULL REFERENCES machine (id),
  kind        TEXT NOT NULL CHECK (kind IN ('OPERATING_NOTE','FAILURE','CONFIG_CHANGE','LESSON')),
  body        TEXT NOT NULL,
  author_type TEXT NOT NULL CHECK (author_type IN ('HUMAN','AI','SYSTEM')),
  author_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_machine_memory ON machine_memory (machine_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS machine_memory_reject_update
BEFORE UPDATE ON machine_memory
BEGIN
  SELECT RAISE(ABORT, 'machine_memory is append-only: UPDATE rejected (D15)');
END;

CREATE TRIGGER IF NOT EXISTS machine_memory_reject_delete
BEFORE DELETE ON machine_memory
BEGIN
  SELECT RAISE(ABORT, 'machine_memory is append-only: DELETE rejected (D15)');
END;

-- ── Capability registry (GAP-07) ──
-- The INTERNAL firm operating registry the task asks for — deliberately not a commercial
-- marketplace. `tested_state` is separate from `maturity`: a capability can be well designed and
-- still never have been proven, and the surface must be able to say both.

CREATE TABLE IF NOT EXISTS capability (
  id                     TEXT PRIMARY KEY,
  capability_key         TEXT NOT NULL UNIQUE,
  name                   TEXT NOT NULL,
  description            TEXT NOT NULL DEFAULT '',
  maturity               TEXT NOT NULL DEFAULT 'EXPERIMENTAL'
                         CHECK (maturity IN ('EXPERIMENTAL','DEVELOPING','MATURE')),
  confidence             TEXT NOT NULL DEFAULT 'LOW' CHECK (confidence IN ('LOW','MEDIUM','HIGH')),
  state                  TEXT NOT NULL DEFAULT 'BENCH' CHECK (state IN ('ACTIVE','BENCH','ARCHIVE')),
  tested_state           TEXT NOT NULL DEFAULT 'UNTESTED'
                         CHECK (tested_state IN ('UNTESTED','FIXTURE_TESTED','PROVEN_LOCAL','PROVEN_LIVE')),
  model_dependencies_json TEXT NOT NULL DEFAULT '[]',
  tool_dependencies_json  TEXT NOT NULL DEFAULT '[]',
  cost_estimate_usd      REAL,
  cost_basis             TEXT NOT NULL DEFAULT '',
  owner_firm_user_id     TEXT REFERENCES firm_user (id),
  registered_by          TEXT NOT NULL,
  firm_scope             TEXT NOT NULL DEFAULT 'west-peek',
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS capability_assignment (
  id            TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL REFERENCES capability (id),
  target_kind   TEXT NOT NULL CHECK (target_kind IN ('EMPLOYEE','MACHINE')),
  target_id     TEXT NOT NULL,
  assigned_by   TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (capability_id, target_kind, target_id)
);

-- What actually happened when the capability was used. This is the only evidence base the
-- "recommended stack" is allowed to reason from.
CREATE TABLE IF NOT EXISTS capability_after_action (
  id            TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL REFERENCES capability (id),
  work_card_id  TEXT REFERENCES work_card (id),
  ai_run_id     TEXT REFERENCES ai_run (id),
  outcome       TEXT NOT NULL CHECK (outcome IN ('SUCCESS','PARTIAL','FAILURE')),
  note          TEXT NOT NULL,
  cost_usd      REAL,
  recorded_by   TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_capability_after_action ON capability_after_action (capability_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS capability_after_action_reject_update
BEFORE UPDATE ON capability_after_action
BEGIN
  SELECT RAISE(ABORT, 'capability_after_action is append-only: UPDATE rejected (D15)');
END;

CREATE TABLE IF NOT EXISTS build_vs_buy_decision (
  id            TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL REFERENCES capability (id),
  decision      TEXT NOT NULL CHECK (decision IN ('BUILD','BUY','DEFER')),
  vendor        TEXT,
  cost_estimate_usd REAL,
  rationale     TEXT NOT NULL,
  decided_by    TEXT NOT NULL REFERENCES firm_user (id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER IF NOT EXISTS build_vs_buy_decision_reject_update
BEFORE UPDATE ON build_vs_buy_decision
BEGIN
  SELECT RAISE(ABORT, 'build_vs_buy_decision is append-only: UPDATE rejected (D15)');
END;

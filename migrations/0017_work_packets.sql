-- 0017_work_packets.sql — P18 Intent-to-Execution + Institutional Lens Bench
-- (task §9 P18; GAP-08, GAP-09).
--
-- Upgrades +Capture from "text plus a machine dropdown" into a governed work packet:
--   rough thought → interpretation → ambiguities → assumptions → risks → output definition →
--   acceptance criteria → lens stack → employee → machine → capability → model → cost → execute
--
-- Two structural guarantees:
-- 1. THE ORIGINAL TEXT IS NEVER OVERWRITTEN. A trigger rejects any UPDATE that changes
--    `original_text`, so enhancement can never quietly replace what the human actually wrote.
-- 2. NO CHAIN-OF-THOUGHT IS PERSISTED. `lens_output` has columns for verdict, critique,
--    evidence references, and summary — and no column a reasoning trace could be written to.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0017_work_packets');

-- ── Action vocabulary additions (P18) ──

INSERT OR IGNORE INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('work_packet.create', 'Create a work packet', 'Capture a rough intent and open a governed work packet around it.', 0, 0),
  ('work_packet.enhance', 'Enhance a work packet', 'Derive interpretation, ambiguities, assumptions, risks, and acceptance criteria without replacing the original text.', 0, 0),
  ('work_packet.update', 'Revise a work packet', 'Change packet fields; every change appends a revision.', 0, 0),
  ('work_packet.execute', 'Execute a work packet', 'Run an accepted work packet through the governed AI boundary and open its work card.', 0, 0),
  ('lens.run', 'Run an institutional lens', 'Record a lens verdict, critique, evidence references, and summary for a work packet.', 0, 0);

CREATE TABLE IF NOT EXISTS work_packet (
  id                     TEXT PRIMARY KEY,
  capture_id             TEXT REFERENCES capture (id),
  -- What the human actually wrote. Immutable by trigger.
  original_text          TEXT NOT NULL,
  enhancement_strength   TEXT NOT NULL DEFAULT 'STANDARD'
                         CHECK (enhancement_strength IN ('NONE','LIGHT','STANDARD','DEEP')),
  interpretation         TEXT NOT NULL DEFAULT '',
  ambiguities_json       TEXT NOT NULL DEFAULT '[]',
  assumptions_json       TEXT NOT NULL DEFAULT '[]',
  risks_json             TEXT NOT NULL DEFAULT '[]',
  output_definition      TEXT NOT NULL DEFAULT '',
  acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
  lens_stack_json        TEXT NOT NULL DEFAULT '[]',
  recommended_employee_id TEXT REFERENCES ai_employee (id),
  machine_id             INTEGER REFERENCES machine (id),
  capability_keys_json   TEXT NOT NULL DEFAULT '[]',
  task_class             TEXT,
  cost_estimate_usd      REAL,
  cost_basis             TEXT NOT NULL DEFAULT '',
  privacy_label          TEXT NOT NULL DEFAULT 'INTERNAL',
  status                 TEXT NOT NULL DEFAULT 'DRAFT'
                         CHECK (status IN ('DRAFT','READY','BLOCKED_BY_LENS','EXECUTING','COMPLETE','FAILED','CANCELLED')),
  work_card_id           TEXT REFERENCES work_card (id),
  ai_run_id              TEXT REFERENCES ai_run (id),
  enhancement_origin     TEXT NOT NULL DEFAULT 'NONE'
                         CHECK (enhancement_origin IN ('NONE','DETERMINISTIC','AI_ACCEPTED','AI_QUARANTINED')),
  created_by             TEXT NOT NULL,
  firm_scope             TEXT NOT NULL DEFAULT 'west-peek',
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_work_packet_status ON work_packet (status, created_at DESC);

-- The human's own words survive every enhancement, revision, and execution.
CREATE TRIGGER IF NOT EXISTS work_packet_original_text_immutable
BEFORE UPDATE ON work_packet
WHEN NEW.original_text <> OLD.original_text
BEGIN
  SELECT RAISE(ABORT, 'work_packet.original_text is immutable: enhancement never replaces what the human wrote');
END;

CREATE TABLE IF NOT EXISTS work_packet_revision (
  id          TEXT PRIMARY KEY,
  packet_id   TEXT NOT NULL REFERENCES work_packet (id),
  version_no  INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  changed_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (packet_id, version_no)
);

CREATE TRIGGER IF NOT EXISTS work_packet_revision_reject_update
BEFORE UPDATE ON work_packet_revision
BEGIN
  SELECT RAISE(ABORT, 'work_packet_revision is append-only: UPDATE rejected (D15)');
END;

CREATE TRIGGER IF NOT EXISTS work_packet_revision_reject_delete
BEFORE DELETE ON work_packet_revision
BEGIN
  SELECT RAISE(ABORT, 'work_packet_revision is append-only: DELETE rejected (D15)');
END;

-- ── Lens outputs (GAP-09) ──
-- Structured reasoning PRODUCTS only. There is deliberately no `reasoning`, `chain_of_thought`,
-- `scratchpad`, or `trace` column, and the service writes only the columns below.

CREATE TABLE IF NOT EXISTS lens_output (
  id                 TEXT PRIMARY KEY,
  packet_id          TEXT NOT NULL REFERENCES work_packet (id),
  lens_key           TEXT NOT NULL
                     CHECK (lens_key IN ('LEAD','SUPPORTING','COUNTER','HOSTILE_REVIEWER','TRUTH_COMPLIANCE_GATE','NO_PEDESTAL')),
  verdict            TEXT NOT NULL CHECK (verdict IN ('PASS','CONCERN','ADVERSE')),
  critique           TEXT NOT NULL,
  summary            TEXT NOT NULL DEFAULT '',
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  produced_by_type   TEXT NOT NULL CHECK (produced_by_type IN ('HUMAN','AI','DETERMINISTIC')),
  produced_by_id     TEXT NOT NULL,
  ai_run_id          TEXT REFERENCES ai_run (id),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (packet_id, lens_key)
);

CREATE INDEX IF NOT EXISTS idx_lens_output_packet ON lens_output (packet_id);

CREATE TRIGGER IF NOT EXISTS lens_output_reject_update
BEFORE UPDATE ON lens_output
BEGIN
  SELECT RAISE(ABORT, 'lens_output is append-only: UPDATE rejected — re-run the lens instead of editing its finding');
END;

CREATE TRIGGER IF NOT EXISTS lens_output_reject_delete
BEFORE DELETE ON lens_output
BEGIN
  SELECT RAISE(ABORT, 'lens_output is append-only: DELETE rejected (D15)');
END;

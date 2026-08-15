-- 0014_workforce.sql — P15 Employee Lounge, Digital Office, Performance Management
-- (task §9 P15; GAP-01, GAP-10, GAP-11).
--
-- The 31-employee roster already exists as governed reference data (0004). This migration adds the
-- OPERATING layer around it and does not touch `ai_employee` itself: the roster, its status
-- vocabulary, its ≤5-ACTIVE cap (D10), and its activation-by-receipt path are preserved exactly.
--
-- Authority rules encoded here:
-- - Raising authority (→ ACTIVE) still runs the reserved `ai_employee.activate` receipt path in
--   0004. This migration adds only the LOWERING moves (PAUSED / RESTRICTED / RETIRED), which
--   reduce what an employee may do and are therefore human-only ordinary actions that fail safe.
-- - An AI employee can never change its own lifecycle, grant itself scope, accept a handoff, or
--   record its own review — enforced in services/workforce.ts, not by UI.
-- - Collaboration maps to work: a room message must reference a work card, an AI run, a handoff,
--   or be a human announcement. There is no free-floating agent chatter.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0014_workforce');

-- ── Action vocabulary additions (P15) ──

INSERT OR IGNORE INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('ai_employee.profile.update', 'Update AI employee profile', 'Set an employee''s department, manager, avatar, or brief (human only).', 0, 0),
  ('ai_employee.assign_machine', 'Assign machine to AI employee', 'Assign or unassign an operating machine for an AI employee (human only).', 0, 0),
  ('ai_employee.lifecycle_change', 'Lower AI employee lifecycle state', 'Pause, restrict, or retire an AI employee. Raising to ACTIVE stays on the reserved ai_employee.activate receipt path.', 0, 0),
  ('employee_room.post', 'Post to a department room', 'Post a governed message that references work, a run, or a firm announcement.', 0, 0),
  ('employee_handoff.propose', 'Propose a work handoff', 'Propose moving a work card from one employee to another.', 0, 0),
  ('employee_handoff.decide', 'Decide a work handoff', 'Accept or reject a proposed handoff (human only).', 0, 0),
  ('internal_memo.create', 'Write an internal memo', 'Publish an internal memo to a department or the firm.', 0, 0),
  ('governance_update.acknowledge', 'Acknowledge a governance update', 'Record that an actor has read and acknowledged an MP governance update.', 0, 0),
  ('employee_performance.compute', 'Compute an employee scorecard', 'Compute a deterministic performance snapshot from run and approval history.', 0, 0),
  ('employee_review.record', 'Record a manager review', 'Record a manager review, improvement plan, or retraining decision for an employee.', 0, 0);

-- ── Employee operating profile ──
-- A separate table rather than new columns on `ai_employee`: the roster stays exactly as seeded
-- from the single registry source, and re-applying this migration remains a no-op.

CREATE TABLE IF NOT EXISTS ai_employee_profile (
  ai_employee_id      TEXT PRIMARY KEY REFERENCES ai_employee (id),
  department          TEXT NOT NULL,
  manager_employee_id TEXT REFERENCES ai_employee (id),
  manager_firm_user_id TEXT REFERENCES firm_user (id),
  avatar_initials     TEXT NOT NULL DEFAULT '',
  brief               TEXT NOT NULL DEFAULT '',
  updated_by          TEXT,
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Seed each employee's department from the roster layer it was seeded with, so the lounge has a
-- real org shape on first load instead of an empty configuration screen.
INSERT OR IGNORE INTO ai_employee_profile (ai_employee_id, department, avatar_initials, brief, updated_by)
SELECT id, layer, upper(substr(name, 1, 2)), role, 'system' FROM ai_employee;

CREATE TABLE IF NOT EXISTS ai_employee_assignment (
  id             TEXT PRIMARY KEY,
  ai_employee_id TEXT NOT NULL REFERENCES ai_employee (id),
  machine_id     INTEGER NOT NULL REFERENCES machine (id),
  assigned_by    TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1,
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (ai_employee_id, machine_id)
);

-- ── Digital office: department rooms ──

CREATE TABLE IF NOT EXISTS department_room (
  id         TEXT PRIMARY KEY,
  room_key   TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  department TEXT NOT NULL,
  purpose    TEXT NOT NULL DEFAULT '',
  firm_scope TEXT NOT NULL DEFAULT 'west-peek',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- One room per department that actually has employees in it.
INSERT OR IGNORE INTO department_room (id, room_key, name, department, purpose)
SELECT
  'droom_' || lower(replace(replace(replace(layer, ' ', '_'), '/', '_'), '+', 'and')),
  lower(replace(replace(replace(layer, ' ', '_'), '/', '_'), '+', 'and')),
  layer || ' room',
  layer,
  'Governed collaboration for the ' || layer || ' department. Every message references work, a run, a handoff, or a firm announcement.'
FROM (SELECT DISTINCT layer FROM ai_employee);

CREATE TABLE IF NOT EXISTS room_message (
  id           TEXT PRIMARY KEY,
  room_id      TEXT NOT NULL REFERENCES department_room (id),
  author_type  TEXT NOT NULL CHECK (author_type IN ('HUMAN','AI','SYSTEM')),
  author_id    TEXT NOT NULL,
  context_kind TEXT NOT NULL CHECK (context_kind IN ('WORK_CARD','AI_RUN','HANDOFF','ANNOUNCEMENT')),
  context_id   TEXT,
  body         TEXT NOT NULL,
  mentions_json TEXT NOT NULL DEFAULT '[]',
  privacy_label TEXT NOT NULL DEFAULT 'INTERNAL',
  firm_scope   TEXT NOT NULL DEFAULT 'west-peek',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Only a human announcement may exist without a work/run/handoff reference.
  CHECK (context_kind = 'ANNOUNCEMENT' OR context_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_room_message_room ON room_message (room_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS room_message_reject_update
BEFORE UPDATE ON room_message
BEGIN
  SELECT RAISE(ABORT, 'room_message is append-only: UPDATE rejected (D15)');
END;

CREATE TRIGGER IF NOT EXISTS room_message_reject_delete
BEFORE DELETE ON room_message
BEGIN
  SELECT RAISE(ABORT, 'room_message is append-only: DELETE rejected (D15)');
END;

-- ── Handoffs: AI may propose, a human decides ──

CREATE TABLE IF NOT EXISTS employee_handoff (
  id                TEXT PRIMARY KEY,
  work_card_id      TEXT NOT NULL REFERENCES work_card (id),
  from_owner_type   TEXT NOT NULL CHECK (from_owner_type IN ('HUMAN','AI','UNASSIGNED')),
  from_owner_id     TEXT,
  to_employee_id    TEXT NOT NULL REFERENCES ai_employee (id),
  reason            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','ACCEPTED','REJECTED')),
  proposed_by_type  TEXT NOT NULL CHECK (proposed_by_type IN ('HUMAN','AI','SYSTEM')),
  proposed_by_id    TEXT NOT NULL,
  decided_by        TEXT,
  decided_at        TEXT,
  decision_note     TEXT,
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_employee_handoff_status ON employee_handoff (status, created_at DESC);

-- ── Internal memos + governance acknowledgement ──

CREATE TABLE IF NOT EXISTS internal_memo (
  id            TEXT PRIMARY KEY,
  author_type   TEXT NOT NULL CHECK (author_type IN ('HUMAN','AI','SYSTEM')),
  author_id     TEXT NOT NULL,
  audience      TEXT NOT NULL CHECK (audience IN ('FIRM','DEPARTMENT')),
  department    TEXT,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  privacy_label TEXT NOT NULL DEFAULT 'INTERNAL',
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (audience = 'FIRM' OR department IS NOT NULL)
);

CREATE TRIGGER IF NOT EXISTS internal_memo_reject_update
BEFORE UPDATE ON internal_memo
BEGIN
  SELECT RAISE(ABORT, 'internal_memo is append-only: UPDATE rejected (D15)');
END;

CREATE TABLE IF NOT EXISTS governance_acknowledgement (
  id                    TEXT PRIMARY KEY,
  governance_update_id  TEXT NOT NULL REFERENCES governance_update (id),
  actor_type            TEXT NOT NULL CHECK (actor_type IN ('HUMAN','AI')),
  actor_id              TEXT NOT NULL,
  note                  TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (governance_update_id, actor_type, actor_id)
);

CREATE TRIGGER IF NOT EXISTS governance_acknowledgement_reject_update
BEFORE UPDATE ON governance_acknowledgement
BEGIN
  SELECT RAISE(ABORT, 'governance_acknowledgement is append-only: UPDATE rejected (D15)');
END;

-- ── Performance ──
-- A snapshot is a COMPUTED, dated artifact: it records the window, the counts, the cost, AND the
-- definition used, so a scorecard can always be re-derived and argued with. `value_note` is
-- deliberately absent: no subjective "value generated" figure is stored as if it were money
-- (task §8 GAP-11).

CREATE TABLE IF NOT EXISTS employee_performance_snapshot (
  id                      TEXT PRIMARY KEY,
  ai_employee_id          TEXT NOT NULL REFERENCES ai_employee (id),
  period_start            TEXT NOT NULL,
  period_end              TEXT NOT NULL,
  runs_total              INTEGER NOT NULL DEFAULT 0,
  runs_completed          INTEGER NOT NULL DEFAULT 0,
  runs_blocked            INTEGER NOT NULL DEFAULT 0,
  outputs_accepted        INTEGER NOT NULL DEFAULT 0,
  outputs_quarantined     INTEGER NOT NULL DEFAULT 0,
  approvals_requested     INTEGER NOT NULL DEFAULT 0,
  approvals_rejected      INTEGER NOT NULL DEFAULT 0,
  cost_usd                REAL NOT NULL DEFAULT 0,
  cost_per_accepted_output REAL,
  failure_patterns_json   TEXT NOT NULL DEFAULT '[]',
  definition_json         TEXT NOT NULL DEFAULT '{}',
  computed_by             TEXT NOT NULL,
  firm_scope              TEXT NOT NULL DEFAULT 'west-peek',
  computed_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_employee_snapshot ON employee_performance_snapshot (ai_employee_id, computed_at DESC);

CREATE TRIGGER IF NOT EXISTS employee_performance_snapshot_reject_update
BEFORE UPDATE ON employee_performance_snapshot
BEGIN
  SELECT RAISE(ABORT, 'employee_performance_snapshot is an immutable computed artifact: UPDATE rejected');
END;

CREATE TABLE IF NOT EXISTS employee_review (
  id                 TEXT PRIMARY KEY,
  ai_employee_id     TEXT NOT NULL REFERENCES ai_employee (id),
  reviewer_id        TEXT NOT NULL REFERENCES firm_user (id),
  snapshot_id        TEXT REFERENCES employee_performance_snapshot (id),
  finding            TEXT NOT NULL,
  disposition        TEXT NOT NULL
                     CHECK (disposition IN ('CONTINUE','IMPROVEMENT_PLAN','RETRAIN','RESTRICT','RETIRE')),
  note               TEXT,
  firm_scope         TEXT NOT NULL DEFAULT 'west-peek',
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_employee_review ON employee_review (ai_employee_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS employee_review_reject_update
BEFORE UPDATE ON employee_review
BEGIN
  SELECT RAISE(ABORT, 'employee_review is append-only: UPDATE rejected (D15)');
END;

CREATE TRIGGER IF NOT EXISTS employee_review_reject_delete
BEFORE DELETE ON employee_review
BEGIN
  SELECT RAISE(ABORT, 'employee_review is append-only: DELETE rejected (D15)');
END;

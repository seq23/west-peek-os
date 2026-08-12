-- 0012_reporting_reconciliation.sql — P12 LP reporting and fund-administration
-- reconciliation: reporting periods, versioned packets, required review states,
-- distribution receipts, reconciliation runs, exceptions, and resolutions.
-- Convention: lowercase snake_case (P1); CREATE IF NOT EXISTS / INSERT OR IGNORE so
-- re-application is a no-op. firm_scope on every firm-data table (§11.7).
--
-- Law (plan §8/P12 + §11.6 + §12.4):
-- - The ADMINISTRATOR/ACCOUNTANT remains authoritative for their domain. West Peek
--   OS imports their figures as evidence and NEVER writes back to them. The imported
--   administrator value on an exception is immutable at the database layer, so no
--   resolution — by any role — can quietly restate what the administrator reported.
-- - A discrepancy creates an EXCEPTION. It never silently overwrites either side.
-- - A packet cannot be distributed until every REQUIRED review is completed, and
--   distribution additionally needs the reserved LP-communication receipt.
-- - No table here certifies financial, accounting, or valuation correctness. The
--   system records process, review, and discrepancy — nothing more.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0012_reporting_reconciliation');

-- ── Action vocabulary additions (P12) ──

INSERT OR IGNORE INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('reporting_period.create', 'Open LP reporting period', 'Open a reporting period for a fund.', 0, 0),
  ('reporting_packet.create', 'Draft LP reporting packet', 'Draft a versioned LP reporting packet for a period.', 0, 0),
  ('reporting_packet.submit', 'Submit reporting packet for review', 'Move a packet into review, opening its required review rows.', 0, 0),
  ('reporting_review.record', 'Record a reporting review', 'Record a required finance/compliance/MP review decision on a packet.', 0, 0),
  ('reconciliation_run.import', 'Import administrator records for reconciliation', 'Import an administrator/accounting export and compare it against internal records (read-only import).', 0, 0),
  ('reconciliation_exception.resolve', 'Resolve a reconciliation exception', 'Record a human disposition of a discrepancy (never an overwrite of the administrator record).', 0, 0);

-- ── Reporting periods and packets ──

CREATE TABLE IF NOT EXISTS lp_reporting_period (
  id            TEXT PRIMARY KEY,
  fund_id       TEXT NOT NULL REFERENCES fund (id),
  label         TEXT NOT NULL,
  period_start  TEXT NOT NULL,
  period_end    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  privacy_label TEXT NOT NULL DEFAULT 'LP_PRIVATE',
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (fund_id, label)
);

CREATE TABLE IF NOT EXISTS lp_reporting_packet (
  id                TEXT PRIMARY KEY,
  period_id         TEXT NOT NULL REFERENCES lp_reporting_period (id),
  version           INTEGER NOT NULL DEFAULT 1,
  title             TEXT NOT NULL,
  document_id       TEXT REFERENCES document (id),
  summary           TEXT,
  status            TEXT NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT','IN_REVIEW','APPROVED','DISTRIBUTED','WITHDRAWN')),
  -- Set only by the service, only when every required review is COMPLETED and a
  -- reserved lp_sensitive_communication.send receipt was presented.
  distributed_at    TEXT,
  approval_card_id  TEXT REFERENCES approval_card (id),
  drafted_by_type   TEXT NOT NULL DEFAULT 'HUMAN' CHECK (drafted_by_type IN ('HUMAN','AI')),
  drafted_by_id     TEXT NOT NULL,
  ai_run_id         TEXT REFERENCES ai_run (id),
  privacy_label     TEXT NOT NULL DEFAULT 'LP_PRIVATE',
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (period_id, version)
);

CREATE INDEX IF NOT EXISTS idx_reporting_packet_period ON lp_reporting_packet (period_id, status);

-- Every required review is a ROW, opened when the packet is submitted. Distribution
-- reads these rows; it does not trust a flag someone could set.
CREATE TABLE IF NOT EXISTS reporting_review (
  id           TEXT PRIMARY KEY,
  packet_id    TEXT NOT NULL REFERENCES lp_reporting_packet (id),
  review_type  TEXT NOT NULL
               CHECK (review_type IN ('FINANCE','COMPLIANCE','MANAGING_PARTNER')),
  status       TEXT NOT NULL DEFAULT 'PENDING'
               CHECK (status IN ('PENDING','COMPLETED','REJECTED')),
  reviewer_id  TEXT,
  reviewed_at  TEXT,
  note         TEXT,
  firm_scope   TEXT NOT NULL DEFAULT 'west-peek',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (packet_id, review_type)
);

CREATE INDEX IF NOT EXISTS idx_reporting_review_packet ON reporting_review (packet_id, status);

-- One row per recipient per distribution: who received which packet VERSION, when,
-- under which receipt. Append-only — a distribution is an event that happened.
CREATE TABLE IF NOT EXISTS distribution_receipt (
  id               TEXT PRIMARY KEY,
  packet_id        TEXT NOT NULL REFERENCES lp_reporting_packet (id),
  packet_version   INTEGER NOT NULL,
  lp_record_id     TEXT REFERENCES lp_record (id),
  recipient_label  TEXT NOT NULL,
  approval_card_id TEXT NOT NULL REFERENCES approval_card (id),
  distributed_by   TEXT NOT NULL,
  distributed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- The actual delivery is a P3 external effect or an external system; this row is
  -- the governed record that it was authorized and to whom.
  delivery_note    TEXT,
  firm_scope       TEXT NOT NULL DEFAULT 'west-peek',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_distribution_receipt_packet ON distribution_receipt (packet_id);

CREATE TRIGGER IF NOT EXISTS distribution_receipt_reject_update
BEFORE UPDATE ON distribution_receipt
BEGIN
  SELECT RAISE(ABORT, 'distribution_receipt is append-only: UPDATE rejected (a distribution is an event that happened)');
END;

CREATE TRIGGER IF NOT EXISTS distribution_receipt_reject_delete
BEFORE DELETE ON distribution_receipt
BEGIN
  SELECT RAISE(ABORT, 'distribution_receipt is append-only: DELETE rejected');
END;

-- ── Fund-administration reconciliation ──
-- A run imports the administrator's figures and compares them to internal records.
-- The import is READ-ONLY with respect to the administrator: no West Peek OS code
-- path writes to an administrator/accounting system.

CREATE TABLE IF NOT EXISTS fund_reconciliation_run (
  id                  TEXT PRIMARY KEY,
  fund_id             TEXT NOT NULL REFERENCES fund (id),
  period_id           TEXT REFERENCES lp_reporting_period (id),
  -- Which administrator export contract/version produced the imported rows.
  source_system       TEXT NOT NULL,
  source_contract_version TEXT NOT NULL,
  source_reference    TEXT,
  -- LOCAL_FIXTURE until a real administrator source contract exists (§7.2 gate).
  source_mode         TEXT NOT NULL DEFAULT 'LOCAL_FIXTURE'
                      CHECK (source_mode IN ('LOCAL_FIXTURE','LIVE')),
  record_count        INTEGER NOT NULL DEFAULT 0,
  matched_count       INTEGER NOT NULL DEFAULT 0,
  exception_count     INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'COMPLETED'
                      CHECK (status IN ('COMPLETED','FAILED')),
  failure_reason      TEXT,
  run_by              TEXT NOT NULL,
  firm_scope          TEXT NOT NULL DEFAULT 'west-peek',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_run_fund ON fund_reconciliation_run (fund_id, created_at);

CREATE TRIGGER IF NOT EXISTS reconciliation_run_reject_update
BEFORE UPDATE ON fund_reconciliation_run
BEGIN
  SELECT RAISE(ABORT, 'fund_reconciliation_run is immutable: UPDATE rejected (a run is a dated comparison)');
END;

CREATE TRIGGER IF NOT EXISTS reconciliation_run_reject_delete
BEFORE DELETE ON fund_reconciliation_run
BEGIN
  SELECT RAISE(ABORT, 'fund_reconciliation_run is immutable: DELETE rejected');
END;

-- An exception is a DISCREPANCY, not a correction. Both sides are recorded as they
-- were observed. `status` is the only mutable column (see the trigger below).
CREATE TABLE IF NOT EXISTS fund_reconciliation_exception (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES fund_reconciliation_run (id),
  fund_id             TEXT NOT NULL REFERENCES fund (id),
  record_kind         TEXT NOT NULL
                      CHECK (record_kind IN ('POSITION','CAPITAL_ACCOUNT','DISTRIBUTION','CAPITAL_CALL','NAV','OTHER')),
  record_key          TEXT NOT NULL,
  field               TEXT NOT NULL,
  -- The administrator's reported value, as imported. IMMUTABLE.
  administrator_value TEXT,
  -- The West Peek OS value at comparison time, as observed. IMMUTABLE.
  internal_value      TEXT,
  difference          REAL,
  exception_kind      TEXT NOT NULL
                      CHECK (exception_kind IN ('VALUE_MISMATCH','MISSING_INTERNAL','MISSING_ADMINISTRATOR','UNPARSEABLE')),
  status              TEXT NOT NULL DEFAULT 'OPEN'
                      CHECK (status IN ('OPEN','RESOLVED','ESCALATED')),
  privacy_label       TEXT NOT NULL DEFAULT 'BANKING_RESTRICTED',
  firm_scope          TEXT NOT NULL DEFAULT 'west-peek',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_exception_run ON fund_reconciliation_exception (run_id, status);

-- NO-OVERWRITE ENFORCEMENT: the only column a resolution may change is `status`.
-- The administrator's reported value and the observed internal value are frozen for
-- every actor, including a Managing Partner and including direct SQL.
CREATE TRIGGER IF NOT EXISTS reconciliation_exception_freeze_values
BEFORE UPDATE ON fund_reconciliation_exception
WHEN OLD.administrator_value IS NOT NEW.administrator_value
  OR OLD.internal_value IS NOT NEW.internal_value
  OR OLD.record_key IS NOT NEW.record_key
  OR OLD.field IS NOT NEW.field
  OR OLD.run_id IS NOT NEW.run_id
  OR OLD.exception_kind IS NOT NEW.exception_kind
BEGIN
  SELECT RAISE(ABORT, 'fund_reconciliation_exception values are immutable: the administrator record is never overwritten (only status may change)');
END;

CREATE TRIGGER IF NOT EXISTS reconciliation_exception_reject_delete
BEFORE DELETE ON fund_reconciliation_exception
BEGIN
  SELECT RAISE(ABORT, 'fund_reconciliation_exception is append-only: DELETE rejected (a discrepancy is never deleted away)');
END;

-- A resolution records what a human DECIDED about a discrepancy. It is append-only
-- and it never alters either recorded value.
CREATE TABLE IF NOT EXISTS reconciliation_resolution (
  id             TEXT PRIMARY KEY,
  exception_id   TEXT NOT NULL REFERENCES fund_reconciliation_exception (id),
  resolution     TEXT NOT NULL
                 CHECK (resolution IN ('ACCEPT_ADMINISTRATOR','CORRECT_INTERNAL','ESCALATE_TO_ADMINISTRATOR','NO_ACTION')),
  note           TEXT NOT NULL,
  resolved_by    TEXT NOT NULL,
  -- Present only when the disposition changes an OFFICIAL figure, which is reserved.
  approval_card_id TEXT REFERENCES approval_card (id),
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reconciliation_resolution_exception ON reconciliation_resolution (exception_id);

CREATE TRIGGER IF NOT EXISTS reconciliation_resolution_reject_update
BEFORE UPDATE ON reconciliation_resolution
BEGIN
  SELECT RAISE(ABORT, 'reconciliation_resolution is append-only: UPDATE rejected');
END;

CREATE TRIGGER IF NOT EXISTS reconciliation_resolution_reject_delete
BEFORE DELETE ON reconciliation_resolution
BEGIN
  SELECT RAISE(ABORT, 'reconciliation_resolution is append-only: DELETE rejected');
END;

-- 0009_network_adapter.sql — P9 Network OS integration: declared adapter contract,
-- sync cursors, external identity mappings, idempotent sync receipts, and conflict
-- resolver cards.
-- Convention: lowercase snake_case (P1); CREATE IF NOT EXISTS / INSERT OR IGNORE so
-- re-application is a no-op. firm_scope on every firm-data table (§11.7).
--
-- Boundary law (D5): Network OS stays authoritative for contacts, relationship
-- metadata, touches, and Gmail-derived relationship records. West Peek OS never
-- reads another system's storage directly — every crossing is an adapter call with
-- a receipt, and a divergence creates a resolver card instead of overwriting.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0009_network_adapter');

-- ── Action vocabulary additions (P9) ──

INSERT OR IGNORE INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('network_adapter_contract.declare', 'Declare adapter contract', 'Publish a versioned Network OS adapter contract (ownership, direction, keys, freshness, conflict, idempotency, retry, audit, failure).', 0, 0),
  ('network_sync.pull', 'Pull from Network OS', 'Pull relationship records through the declared adapter (read-only; idempotent by delivery key).', 0, 0),
  ('network_conflict.resolve', 'Resolve sync conflict', 'Human disposition of a Network OS/WP OS divergence (never a silent overwrite).', 0, 0),
  ('network_os.writeback', 'network_os.writeback', 'Write a West Peek OS record back into Network OS (live integration is a named human gate).', 0, 1);

INSERT OR IGNORE INTO human_reserved_action (key, category, description, approver_roles_json) VALUES
  ('network_os.writeback', 'RELATIONSHIP_PUBLIC', 'Write a West Peek OS record back into Network OS (live integration is a named human gate).', '["MANAGING_PARTNER"]');

-- ── The declared contract (versioned; one ACTIVE version at a time) ──
-- declaration_json must carry every clause the plan requires; the service refuses
-- to activate a contract that is missing one.

CREATE TABLE IF NOT EXISTS network_adapter_contract (
  id               TEXT PRIMARY KEY,
  version          INTEGER NOT NULL,
  declaration_json TEXT NOT NULL,
  active           INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  firm_scope       TEXT NOT NULL DEFAULT 'west-peek',
  declared_by      TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_network_contract_version ON network_adapter_contract (version, firm_scope);

CREATE TRIGGER IF NOT EXISTS network_adapter_contract_reject_declaration_update
BEFORE UPDATE OF declaration_json, version, declared_by ON network_adapter_contract
BEGIN
  SELECT RAISE(ABORT, 'network_adapter_contract is versioned: declare a new version instead of editing one');
END;

-- ── Sync cursors (freshness is explicit, per resource) ──

CREATE TABLE IF NOT EXISTS network_sync_cursor (
  id            TEXT PRIMARY KEY,
  resource      TEXT NOT NULL,
  cursor_value  TEXT,
  last_sync_at  TEXT,
  last_status   TEXT NOT NULL DEFAULT 'NEVER_RUN'
                CHECK (last_status IN ('NEVER_RUN','OK','DEGRADED_READ_ONLY','FAILED')),
  failure_reason TEXT,
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_network_cursor_resource ON network_sync_cursor (resource, firm_scope);

-- ── External identity mapping (the declared identity keys; no duplicate truth) ──

CREATE TABLE IF NOT EXISTS network_external_mapping (
  id             TEXT PRIMARY KEY,
  resource       TEXT NOT NULL,
  external_id    TEXT NOT NULL,
  identity_key   TEXT NOT NULL,
  internal_type  TEXT,
  internal_id    TEXT,
  snapshot_json  TEXT NOT NULL DEFAULT '{}',
  first_seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_network_mapping_external ON network_external_mapping (resource, external_id, firm_scope);

-- ── Sync receipts: APPEND-ONLY, idempotent by delivery key ──
-- Every crossing (inbound or outbound, applied or refused) leaves one row.

CREATE TABLE IF NOT EXISTS network_sync_receipt (
  id               TEXT PRIMARY KEY,
  direction        TEXT NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  resource         TEXT NOT NULL,
  external_id      TEXT,
  idempotency_key  TEXT NOT NULL,
  request_json     TEXT NOT NULL DEFAULT '{}',
  response_json    TEXT NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL
                   CHECK (status IN ('APPLIED','DUPLICATE_IGNORED','CONFLICT','FAILED','REFUSED')),
  attempt          INTEGER NOT NULL DEFAULT 1,
  failure_reason   TEXT,
  provider_version TEXT,
  approval_card_id TEXT REFERENCES approval_card (id),
  actor_id         TEXT NOT NULL,
  firm_scope       TEXT NOT NULL DEFAULT 'west-peek',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_network_receipt_idempotency ON network_sync_receipt (idempotency_key, firm_scope);
CREATE INDEX IF NOT EXISTS idx_network_receipt_resource ON network_sync_receipt (resource, direction, created_at);

CREATE TRIGGER IF NOT EXISTS network_sync_receipt_reject_update
BEFORE UPDATE ON network_sync_receipt
BEGIN
  SELECT RAISE(ABORT, 'network_sync_receipt is append-only: UPDATE rejected (D15)');
END;

CREATE TRIGGER IF NOT EXISTS network_sync_receipt_reject_delete
BEFORE DELETE ON network_sync_receipt
BEGIN
  SELECT RAISE(ABORT, 'network_sync_receipt is append-only: DELETE rejected (D15)');
END;

-- ── Conflicts: a divergence NEVER overwrites; it opens a resolver card ──

CREATE TABLE IF NOT EXISTS network_conflict (
  id             TEXT PRIMARY KEY,
  resource       TEXT NOT NULL,
  external_id    TEXT NOT NULL,
  field          TEXT NOT NULL,
  external_value TEXT,
  internal_value TEXT,
  status         TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  resolution     TEXT CHECK (resolution IN ('KEEP_EXTERNAL','KEEP_INTERNAL','MANUAL_MERGE')),
  resolution_note TEXT,
  resolved_by    TEXT,
  resolved_at    TEXT,
  work_card_id   TEXT REFERENCES work_card (id),
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_network_conflict_status ON network_conflict (status, resource);

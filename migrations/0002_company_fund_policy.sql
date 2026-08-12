-- 0002_company_fund_policy.sql — P2 canonical identity + fund/policy substrate.
-- Convention: lowercase snake_case table names (P1). Defensive by construction:
-- CREATE TABLE IF NOT EXISTS / CREATE TRIGGER IF NOT EXISTS so re-application is a no-op.
-- Every table carries firm_scope TEXT NOT NULL DEFAULT 'west-peek' (tenant/firm isolation, §11.7).

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0002_company_fund_policy');

-- ── Canonical identity (D3: CanonicalCompany-first; no parallel company-shaped entities) ──

CREATE TABLE IF NOT EXISTS canonical_company (
  id             TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  legal_name     TEXT,
  website        TEXT,
  description    TEXT,
  privacy_label  TEXT NOT NULL DEFAULT 'INTERNAL',
  status         TEXT NOT NULL DEFAULT 'ACTIVE',
  created_by     TEXT NOT NULL,
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_canonical_company_name ON canonical_company (canonical_name);

-- Aliases NEVER create companies; they only resolve to an existing canonical company.
CREATE TABLE IF NOT EXISTS company_alias (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES canonical_company (id),
  alias       TEXT NOT NULL,
  alias_type  TEXT NOT NULL DEFAULT 'COMMON',
  source      TEXT,
  firm_scope  TEXT NOT NULL DEFAULT 'west-peek',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_company_alias_company ON company_alias (company_id);
CREATE INDEX IF NOT EXISTS idx_company_alias_alias ON company_alias (alias);

CREATE TABLE IF NOT EXISTS company_external_identity (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES canonical_company (id),
  system       TEXT NOT NULL,
  external_key TEXT NOT NULL,
  source       TEXT,
  firm_scope   TEXT NOT NULL DEFAULT 'west-peek',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (system, external_key)
);

CREATE INDEX IF NOT EXISTS idx_company_external_identity_company ON company_external_identity (company_id);

-- person: firm-side reference ONLY. Network OS stays authoritative for
-- relationship/contact/touch records (D5); rows here are imported references,
-- never the system of record.
CREATE TABLE IF NOT EXISTS person (
  id            TEXT PRIMARY KEY,
  full_name     TEXT NOT NULL,
  email         TEXT,
  organization  TEXT,
  source        TEXT,
  privacy_label TEXT NOT NULL DEFAULT 'INTERNAL',
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS organization_relationship (
  id                TEXT PRIMARY KEY,
  person_id         TEXT NOT NULL REFERENCES person (id),
  company_id        TEXT NOT NULL REFERENCES canonical_company (id),
  relationship_type TEXT NOT NULL,
  note              TEXT,
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_organization_relationship_company ON organization_relationship (company_id);
CREATE INDEX IF NOT EXISTS idx_organization_relationship_person ON organization_relationship (person_id);

-- Human/AI-proposed duplicate candidates. ACCEPTED marks review outcome only —
-- it never merges; merge is a separate human-reserved action (P3 approval card).
CREATE TABLE IF NOT EXISTS identity_resolution_candidate (
  id           TEXT PRIMARY KEY,
  company_id_a TEXT NOT NULL REFERENCES canonical_company (id),
  company_id_b TEXT NOT NULL REFERENCES canonical_company (id),
  match_basis  TEXT NOT NULL,
  score        REAL,
  status       TEXT NOT NULL DEFAULT 'PENDING'
               CHECK (status IN ('PENDING','ACCEPTED','REJECTED')),
  proposed_by  TEXT NOT NULL,
  firm_scope   TEXT NOT NULL DEFAULT 'west-peek',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_by  TEXT,
  resolved_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_identity_candidate_a ON identity_resolution_candidate (company_id_a);
CREATE INDEX IF NOT EXISTS idx_identity_candidate_b ON identity_resolution_candidate (company_id_b);

-- Merge receipt: complete moved-reference detail + pre-merge snapshot + SHA-256 hash.
-- This is the provenance that makes reversal exact.
CREATE TABLE IF NOT EXISTS identity_merge_receipt (
  id                       TEXT PRIMARY KEY,
  source_company_id        TEXT NOT NULL,
  target_company_id        TEXT NOT NULL,
  actor_id                 TEXT NOT NULL,
  approved_by              TEXT NOT NULL,
  moved_references_json    TEXT NOT NULL,
  pre_merge_snapshot_json  TEXT NOT NULL,
  pre_merge_hash           TEXT NOT NULL,
  firm_scope               TEXT NOT NULL DEFAULT 'west-peek',
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS identity_split_receipt (
  id                       TEXT PRIMARY KEY,
  merge_receipt_id         TEXT NOT NULL REFERENCES identity_merge_receipt (id),
  restored_company_id      TEXT NOT NULL,
  actor_id                 TEXT NOT NULL,
  restored_references_json TEXT NOT NULL,
  firm_scope               TEXT NOT NULL DEFAULT 'west-peek',
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ── Fund / policy substrate ──
-- NO hardcoded fund sizes, sleeve targets, or strategies anywhere: policy content
-- lives only in versioned JSON rows created by humans.

CREATE TABLE IF NOT EXISTS fund (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'ACTIVE',
  firm_scope TEXT NOT NULL DEFAULT 'west-peek',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Affiliated legal entities stay distinct; never collapsed into the fund or each other.
CREATE TABLE IF NOT EXISTS fund_entity (
  id                TEXT PRIMARY KEY,
  fund_id           TEXT NOT NULL REFERENCES fund (id),
  legal_entity_name TEXT NOT NULL,
  entity_type       TEXT NOT NULL,
  jurisdiction      TEXT,
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_fund_entity_fund ON fund_entity (fund_id);

CREATE TABLE IF NOT EXISTS investment_mandate_version (
  id             TEXT PRIMARY KEY,
  fund_id        TEXT NOT NULL REFERENCES fund (id),
  version_no     INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  mandate_json   TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (fund_id, version_no)
);

CREATE TABLE IF NOT EXISTS sleeve_policy_version (
  id             TEXT PRIMARY KEY,
  fund_id        TEXT NOT NULL REFERENCES fund (id),
  version_no     INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  sleeve_json    TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (fund_id, version_no)
);

CREATE TABLE IF NOT EXISTS reserve_policy_version (
  id             TEXT PRIMARY KEY,
  fund_id        TEXT NOT NULL REFERENCES fund (id),
  version_no     INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  reserve_json   TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (fund_id, version_no)
);

CREATE TABLE IF NOT EXISTS concentration_policy_version (
  id                 TEXT PRIMARY KEY,
  fund_id            TEXT NOT NULL REFERENCES fund (id),
  version_no         INTEGER NOT NULL,
  effective_from     TEXT NOT NULL,
  concentration_json TEXT NOT NULL,
  created_by         TEXT NOT NULL,
  firm_scope         TEXT NOT NULL DEFAULT 'west-peek',
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (fund_id, version_no)
);

-- POLICY IMMUTABILITY: policy change = a new version row; history is never rewritten.
-- UPDATE and DELETE are rejected at the database layer for every role, including MPs.
CREATE TRIGGER IF NOT EXISTS investment_mandate_version_reject_update
BEFORE UPDATE ON investment_mandate_version
BEGIN
  SELECT RAISE(ABORT, 'investment_mandate_version is immutable: UPDATE rejected (policy versioning)');
END;

CREATE TRIGGER IF NOT EXISTS investment_mandate_version_reject_delete
BEFORE DELETE ON investment_mandate_version
BEGIN
  SELECT RAISE(ABORT, 'investment_mandate_version is immutable: DELETE rejected (policy versioning)');
END;

CREATE TRIGGER IF NOT EXISTS sleeve_policy_version_reject_update
BEFORE UPDATE ON sleeve_policy_version
BEGIN
  SELECT RAISE(ABORT, 'sleeve_policy_version is immutable: UPDATE rejected (policy versioning)');
END;

CREATE TRIGGER IF NOT EXISTS sleeve_policy_version_reject_delete
BEFORE DELETE ON sleeve_policy_version
BEGIN
  SELECT RAISE(ABORT, 'sleeve_policy_version is immutable: DELETE rejected (policy versioning)');
END;

CREATE TRIGGER IF NOT EXISTS reserve_policy_version_reject_update
BEFORE UPDATE ON reserve_policy_version
BEGIN
  SELECT RAISE(ABORT, 'reserve_policy_version is immutable: UPDATE rejected (policy versioning)');
END;

CREATE TRIGGER IF NOT EXISTS reserve_policy_version_reject_delete
BEFORE DELETE ON reserve_policy_version
BEGIN
  SELECT RAISE(ABORT, 'reserve_policy_version is immutable: DELETE rejected (policy versioning)');
END;

CREATE TRIGGER IF NOT EXISTS concentration_policy_version_reject_update
BEFORE UPDATE ON concentration_policy_version
BEGIN
  SELECT RAISE(ABORT, 'concentration_policy_version is immutable: UPDATE rejected (policy versioning)');
END;

CREATE TRIGGER IF NOT EXISTS concentration_policy_version_reject_delete
BEFORE DELETE ON concentration_policy_version
BEGIN
  SELECT RAISE(ABORT, 'concentration_policy_version is immutable: DELETE rejected (policy versioning)');
END;

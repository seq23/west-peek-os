-- 0001_runtime_identity.sql — P1 runtime identity + schema versioning + event spine base.
-- Convention: lowercase snake_case table names; later phases follow this convention.
-- Defensive by construction: CREATE TABLE IF NOT EXISTS / INSERT OR IGNORE so a repeated
-- application never corrupts (wrangler also tracks applied migrations in d1_migrations).

CREATE TABLE IF NOT EXISTS schema_version (
  migration   TEXT PRIMARY KEY,
  applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0001_runtime_identity');

-- Runtime identity (ADR-006): app-level FirmUser + Role + AuthorityScope records are
-- always enforced server-side. Cloudflare Access is the private-ingress layer (config,
-- not code); these records are the application authority substrate.
CREATE TABLE IF NOT EXISTS firm_user (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  full_name   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS role (
  id    TEXT PRIMARY KEY,
  key   TEXT NOT NULL UNIQUE,
  name  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS firm_user_role (
  firm_user_id  TEXT NOT NULL REFERENCES firm_user (id),
  role_id       TEXT NOT NULL REFERENCES role (id),
  PRIMARY KEY (firm_user_id, role_id)
);

CREATE TABLE IF NOT EXISTS authority_scope (
  id            TEXT PRIMARY KEY,
  firm_user_id  TEXT NOT NULL REFERENCES firm_user (id),
  scope_key     TEXT NOT NULL,
  scope_value   TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_authority_scope_user ON authority_scope (firm_user_id, scope_key);

-- Event spine base (D15): one append-only typed event record feeds Activity, Audit,
-- and Diagnostics in later phases. UPDATE and DELETE are rejected at the database layer.
CREATE TABLE IF NOT EXISTS event_record (
  id           TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  actor_type   TEXT NOT NULL,
  actor_id     TEXT NOT NULL,
  object_type  TEXT NOT NULL,
  object_id    TEXT NOT NULL,
  firm_scope   TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_event_record_object ON event_record (object_type, object_id);
CREATE INDEX IF NOT EXISTS idx_event_record_created ON event_record (created_at);

CREATE TRIGGER IF NOT EXISTS event_record_reject_update
BEFORE UPDATE ON event_record
BEGIN
  SELECT RAISE(ABORT, 'event_record is append-only: UPDATE rejected (D15)');
END;

CREATE TRIGGER IF NOT EXISTS event_record_reject_delete
BEFORE DELETE ON event_record
BEGIN
  SELECT RAISE(ABORT, 'event_record is append-only: DELETE rejected (D15)');
END;

-- Seed roles (application authority vocabulary).
INSERT OR IGNORE INTO role (id, key, name) VALUES
  ('role_managing_partner',    'MANAGING_PARTNER',    'Managing Partner'),
  ('role_investment_team',     'INVESTMENT_TEAM',     'Investment Team'),
  ('role_counsel',             'COUNSEL',             'Counsel'),
  ('role_compliance_officer',  'COMPLIANCE_OFFICER',  'Compliance Officer'),
  ('role_fund_administrator',  'FUND_ADMINISTRATOR',  'Fund Administrator'),
  ('role_finance_authority',   'FINANCE_AUTHORITY',   'Finance Authority'),
  ('role_accountant_auditor',  'ACCOUNTANT_AUDITOR',  'Accountant / Auditor'),
  ('role_operations',          'OPERATIONS',          'Operations');

-- Seed firm users: the two Managing Partners (D10 — MPs are human; never AI employees).
INSERT OR IGNORE INTO firm_user (id, email, full_name, status) VALUES
  ('fu_scooter_taylor', 'scooter@westpeek.ventures', 'Scooter Taylor', 'ACTIVE'),
  ('fu_sequoia_taylor', 'sequoia@westpeek.ventures', 'Sequoia Taylor', 'ACTIVE');

INSERT OR IGNORE INTO firm_user_role (firm_user_id, role_id) VALUES
  ('fu_scooter_taylor', 'role_managing_partner'),
  ('fu_sequoia_taylor', 'role_managing_partner');

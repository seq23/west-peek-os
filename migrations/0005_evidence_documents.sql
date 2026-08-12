-- 0005_evidence_documents.sql — P5 evidence/provenance substrate (D16): documents
-- (R2 binary + D1 metadata), diligence claims with mandatory source provenance,
-- contradictions, knowledge promotion, and source-of-truth resolution.
-- Convention: lowercase snake_case (P1); CREATE IF NOT EXISTS / INSERT OR IGNORE so
-- re-application is a no-op. firm_scope on every firm-data table (§11.7).

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0005_evidence_documents');

-- ── Action vocabulary additions (P5) ──
-- The registry sources (src/shared/registry/actionTypes.ts + reservedActions.ts)
-- carry these keys and the 0003 generated seed section includes them for fresh
-- databases. These compensating INSERT OR IGNORE statements cover databases that
-- applied 0003 before P5 existed.

INSERT OR IGNORE INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('document.upload', 'Upload document', 'Store a governed document binary in R2 with D1 metadata/provenance and a SHA-256 version row.', 0, 0),
  ('claim.create', 'Create diligence claim', 'Record a diligence claim with mandatory source provenance (source/date/location/method/confidence/status).', 0, 0),
  ('claim.extract', 'Extract claims from document', 'Run AI extraction over a document through the run_ai boundary; candidates land AI_INFERRED/UNVERIFIED, quarantined until human accept.', 0, 0),
  ('claim.verify', 'Verify claim', 'Set a claim VERIFIED (human only, requires a DOCUMENT or HUMAN_STATEMENT source; the self-promotion ban is structural).', 0, 0),
  ('claim.accept', 'Accept extracted claim', 'Human accept of an AI-extracted (quarantined) claim with a qualifying source; re-attributes the claim to the accepting human.', 0, 0),
  ('claim.supersede', 'Supersede claim', 'Replace a claim with a new one; the superseded claim stays readable and linked.', 0, 0),
  ('contradiction.create', 'Create contradiction', 'Open a contradiction record between conflicting claims (AI may propose; it enters OPEN with proposed-by recorded).', 0, 0),
  ('contradiction.update', 'Update contradiction', 'Assign an owner or move a contradiction to INVESTIGATING.', 0, 0),
  ('contradiction.resolve', 'Resolve contradiction', 'Human-only disposition of a contradiction (RESOLVED/ACCEPTED_RISK/INVALID) with evidence.', 0, 0),
  ('knowledge_promotion.propose', 'Propose knowledge promotion', 'Propose promoting claims into durable institutional memory; creates an approval card (humans decide).', 0, 0),
  ('knowledge.promote', 'knowledge.promote', 'Promote evidence into durable institutional memory (knowledge_record).', 0, 1),
  ('source_conflict.create', 'Create source conflict', 'Record a cross-system source-of-truth conflict.', 0, 0),
  ('source_conflict.resolve', 'Resolve source conflict', 'Resolve a source conflict with an append-only resolution decision (human only).', 0, 0);

INSERT OR IGNORE INTO human_reserved_action (key, category, description, approver_roles_json) VALUES
  ('knowledge.promote', 'LEGAL_COMPLIANCE', 'Promote evidence into durable institutional memory (knowledge_record).', '["MANAGING_PARTNER"]');

-- ── Documents (§9.1: binary content in R2 binding WP_OS_DOCUMENTS; D1 holds
-- metadata/provenance ONLY — no binary content in D1) ──

CREATE TABLE IF NOT EXISTS document (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  doc_type           TEXT NOT NULL,
  privacy_label      TEXT NOT NULL DEFAULT 'INTERNAL',
  firm_scope         TEXT NOT NULL DEFAULT 'west-peek',
  current_version_id TEXT,
  uploaded_by        TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_document_scope ON document (firm_scope, created_at);

-- Document versions are IMMUTABLE: a stored version is evidence and is never
-- rewritten or deleted. UPDATE/DELETE are rejected at the database layer.
CREATE TABLE IF NOT EXISTS document_version (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES document (id),
  version_no   INTEGER NOT NULL,
  r2_key       TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  firm_scope   TEXT NOT NULL DEFAULT 'west-peek',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (document_id, version_no)
);

CREATE INDEX IF NOT EXISTS idx_document_version_doc ON document_version (document_id, version_no);

CREATE TRIGGER IF NOT EXISTS document_version_reject_update
BEFORE UPDATE ON document_version
BEGIN
  SELECT RAISE(ABORT, 'document_version is immutable: UPDATE rejected (D16 evidence)');
END;

CREATE TRIGGER IF NOT EXISTS document_version_reject_delete
BEFORE DELETE ON document_version
BEGIN
  SELECT RAISE(ABORT, 'document_version is immutable: DELETE rejected (D16 evidence)');
END;

-- ── Diligence claims (ADR-004 six-value claim-status enum) ──
-- Every claim carries provenance: extractor (HUMAN|AI), optional ai_run link,
-- mandatory claim_source rows (enforced in the service layer), confidence, status.
-- SELF-PROMOTION BAN (structural): an AI-extracted claim can never hold
-- claim_status='VERIFIED' — enforced here by CHECK and in the service layer on
-- create AND on every status transition. The only path out of AI extraction is a
-- human accept that attaches a DOCUMENT/HUMAN_STATEMENT source and re-attributes
-- the claim to the accepting human (the AI origin stays recorded in ai_run_id).

CREATE TABLE IF NOT EXISTS diligence_claim (
  id                TEXT PRIMARY KEY,
  company_id        TEXT REFERENCES canonical_company (id),
  subject_type      TEXT NOT NULL,
  subject_id        TEXT NOT NULL,
  claim_text        TEXT NOT NULL,
  metric_key        TEXT,
  metric_value      TEXT,
  period_start      TEXT,
  period_end        TEXT,
  claim_status      TEXT NOT NULL DEFAULT 'UNVERIFIED'
                    CHECK (claim_status IN ('VERIFIED','FOUNDER_STATED','THIRD_PARTY_SOURCED','AI_INFERRED','UNVERIFIED','MISSING')),
  confidence        REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  privacy_label     TEXT NOT NULL DEFAULT 'INTERNAL',
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  extracted_by_type TEXT NOT NULL
                    CHECK (extracted_by_type IN ('HUMAN','AI')),
  extracted_by_id   TEXT NOT NULL,
  ai_run_id         TEXT REFERENCES ai_run (id),
  superseded_by     TEXT REFERENCES diligence_claim (id),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (NOT (extracted_by_type = 'AI' AND claim_status = 'VERIFIED'))
);

CREATE INDEX IF NOT EXISTS idx_diligence_claim_company ON diligence_claim (company_id, claim_status);
CREATE INDEX IF NOT EXISTS idx_diligence_claim_metric ON diligence_claim (company_id, metric_key);
CREATE INDEX IF NOT EXISTS idx_diligence_claim_run ON diligence_claim (ai_run_id);

-- Claim sources are evidence: appended, never rewritten or deleted.
CREATE TABLE IF NOT EXISTS claim_source (
  id                  TEXT PRIMARY KEY,
  claim_id            TEXT NOT NULL REFERENCES diligence_claim (id),
  source_type         TEXT NOT NULL
                      CHECK (source_type IN ('DOCUMENT','TRANSCRIPT','WEB','VENDOR','HUMAN_STATEMENT','MODEL_OUTPUT','OTHER')),
  document_version_id TEXT REFERENCES document_version (id),
  location            TEXT NOT NULL,
  source_date         TEXT NOT NULL,
  method              TEXT NOT NULL,
  note                TEXT,
  created_by          TEXT NOT NULL,
  firm_scope          TEXT NOT NULL DEFAULT 'west-peek',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_claim_source_claim ON claim_source (claim_id);

CREATE TRIGGER IF NOT EXISTS claim_source_reject_update
BEFORE UPDATE ON claim_source
BEGIN
  SELECT RAISE(ABORT, 'claim_source is append-only: UPDATE rejected (D16 evidence)');
END;

CREATE TRIGGER IF NOT EXISTS claim_source_reject_delete
BEFORE DELETE ON claim_source
BEGIN
  SELECT RAISE(ABORT, 'claim_source is append-only: DELETE rejected (D16 evidence)');
END;

-- ── Contradictions ──
-- AI may PROPOSE (status OPEN, proposed_by recorded); only a HUMAN disposes
-- (RESOLVED/ACCEPTED_RISK/INVALID with disposition + evidence). Unresolved
-- material contradictions (OPEN/INVESTIGATING at HIGH/CRITICAL) are structurally
-- un-hidable from the company evidence summary.

CREATE TABLE IF NOT EXISTS contradiction_record (
  id                      TEXT PRIMARY KEY,
  contradiction_type      TEXT NOT NULL
                          CHECK (contradiction_type IN ('VALUE','PERIOD','DEFINITION','VERSION','SOURCE','OTHER')),
  topic                   TEXT NOT NULL,
  company_id              TEXT REFERENCES canonical_company (id),
  materiality             TEXT NOT NULL
                          CHECK (materiality IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status                  TEXT NOT NULL DEFAULT 'OPEN'
                          CHECK (status IN ('OPEN','INVESTIGATING','RESOLVED','ACCEPTED_RISK','INVALID')),
  required_question       TEXT,
  assigned_owner          TEXT,
  proposed_by_type        TEXT NOT NULL DEFAULT 'HUMAN'
                          CHECK (proposed_by_type IN ('HUMAN','AI','SYSTEM')),
  proposed_by_id          TEXT NOT NULL,
  resolution_evidence_json TEXT,
  human_disposition_by    TEXT,
  human_disposition_at    TEXT,
  firm_scope              TEXT NOT NULL DEFAULT 'west-peek',
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_contradiction_company ON contradiction_record (company_id, status, materiality);

CREATE TABLE IF NOT EXISTS contradiction_claim_link (
  contradiction_id TEXT NOT NULL REFERENCES contradiction_record (id),
  claim_id         TEXT NOT NULL REFERENCES diligence_claim (id),
  side_label       TEXT NOT NULL,
  firm_scope       TEXT NOT NULL DEFAULT 'west-peek',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (contradiction_id, claim_id)
);

-- ── Knowledge promotion (durable institutional memory) ──
-- Candidates may be proposed by anyone (AI prepares); applying a promotion is the
-- reserved action knowledge.promote — an approved approval card receipt is
-- required. Superseded knowledge records stay readable (traceable).

CREATE TABLE IF NOT EXISTS knowledge_promotion_candidate (
  id                    TEXT PRIMARY KEY,
  candidate_type        TEXT NOT NULL,
  payload_json          TEXT NOT NULL DEFAULT '{}',
  source_claim_ids_json TEXT NOT NULL DEFAULT '[]',
  status                TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  proposed_by_type      TEXT NOT NULL
                        CHECK (proposed_by_type IN ('HUMAN','AI','SYSTEM')),
  proposed_by_id        TEXT NOT NULL,
  approval_card_id      TEXT,
  firm_scope            TEXT NOT NULL DEFAULT 'west-peek',
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at           TEXT
);

CREATE INDEX IF NOT EXISTS idx_knowledge_candidate_status ON knowledge_promotion_candidate (status, firm_scope);

CREATE TABLE IF NOT EXISTS knowledge_record (
  id                       TEXT PRIMARY KEY,
  title                    TEXT NOT NULL,
  body                     TEXT NOT NULL,
  provenance_json          TEXT NOT NULL DEFAULT '{}',
  confidence               REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  version_no               INTEGER NOT NULL DEFAULT 1,
  supersedes_id            TEXT REFERENCES knowledge_record (id),
  privacy_label            TEXT NOT NULL DEFAULT 'INTERNAL',
  firm_scope               TEXT NOT NULL DEFAULT 'west-peek',
  promoted_via_candidate_id TEXT NOT NULL REFERENCES knowledge_promotion_candidate (id),
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_knowledge_record_scope ON knowledge_record (firm_scope, created_at);

-- ── Source-of-truth conflicts + append-only resolution decisions ──

CREATE TABLE IF NOT EXISTS source_conflict (
  id           TEXT PRIMARY KEY,
  conflict_key TEXT NOT NULL,
  system_a     TEXT NOT NULL,
  system_b     TEXT NOT NULL,
  record_ref_a TEXT NOT NULL,
  record_ref_b TEXT NOT NULL,
  field        TEXT NOT NULL,
  value_a      TEXT NOT NULL,
  value_b      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'OPEN'
               CHECK (status IN ('OPEN','RESOLVED')),
  resolution   TEXT,
  resolved_by  TEXT,
  firm_scope   TEXT NOT NULL DEFAULT 'west-peek',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_source_conflict_key ON source_conflict (conflict_key, status);

-- Resolution decisions are append-only: UPDATE/DELETE rejected at the DB layer.
CREATE TABLE IF NOT EXISTS source_resolution_decision (
  id                 TEXT PRIMARY KEY,
  source_conflict_id TEXT NOT NULL REFERENCES source_conflict (id),
  winning_source     TEXT NOT NULL,
  rationale          TEXT NOT NULL,
  decided_by         TEXT NOT NULL,
  firm_scope         TEXT NOT NULL DEFAULT 'west-peek',
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_source_resolution_conflict ON source_resolution_decision (source_conflict_id);

CREATE TRIGGER IF NOT EXISTS source_resolution_decision_reject_update
BEFORE UPDATE ON source_resolution_decision
BEGIN
  SELECT RAISE(ABORT, 'source_resolution_decision is append-only: UPDATE rejected (D15/D16)');
END;

CREATE TRIGGER IF NOT EXISTS source_resolution_decision_reject_delete
BEFORE DELETE ON source_resolution_decision
BEGIN
  SELECT RAISE(ABORT, 'source_resolution_decision is append-only: DELETE rejected (D15/D16)');
END;

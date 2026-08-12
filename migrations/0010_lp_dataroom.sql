-- 0010_lp_dataroom.sql — P10 LP / fundraising / claims / data-room control:
-- LP records and links, LP opportunities and diligence requests, evidence-backed LP
-- claims, and the data-room artifact/access/revocation ledger.
-- Convention: lowercase snake_case (P1); CREATE IF NOT EXISTS / INSERT OR IGNORE so
-- re-application is a no-op. firm_scope on every firm-data table (§11.7).
--
-- Law: an LP-facing claim cannot be published without APPROVED evidence and an
-- approved lp_marketing_claim.approve receipt. Sharing material is a human-gated
-- act that logs recipient, artifact VERSION, time, permission, and expiry. The data
-- room itself stays EXTERNAL (D-plan §10: no native VDR); these tables hold the
-- governed record of what was shared, never the delivery mechanism.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0010_lp_dataroom');

-- ── Action vocabulary additions (P10) ──

INSERT OR IGNORE INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('lp_record.create', 'Create LP record', 'Record an LP entity (LP_PRIVATE by default).', 0, 0),
  ('lp_opportunity.create', 'Create LP opportunity', 'Track a fundraising conversation with an LP.', 0, 0),
  ('lp_opportunity.transition', 'Transition LP opportunity', 'Move an LP opportunity through its governed stages.', 0, 0),
  ('lp_diligence_request.create', 'Record LP diligence request', 'Record a diligence question or document request from an LP.', 0, 0),
  ('lp_diligence_request.respond', 'Respond to LP diligence request', 'Record the firm response to an LP diligence request.', 0, 0),
  ('lp_claim.draft', 'Draft LP claim', 'Draft an LP-facing claim. AI may draft; publication needs approved evidence and a compliance receipt.', 0, 0),
  ('lp_claim.link_evidence', 'Link evidence to LP claim', 'Attach approved evidence (VERIFIED diligence claim, knowledge record, or governed document) to an LP claim.', 0, 0),
  ('lp_claim.submit', 'Submit LP claim for review', 'Submit an LP claim for the reserved marketing-claim approval.', 0, 0),
  ('data_room_artifact.create', 'Register data-room artifact', 'Register a versioned artifact intended for the EXTERNAL data room.', 0, 0),
  ('data_room_access.revoke', 'Revoke data-room access', 'Revoke a recorded data-room access grant (append-only revocation).', 0, 0);

-- ── LP records (LP_PRIVATE by default; relationship truth stays in Network OS) ──

CREATE TABLE IF NOT EXISTS lp_record (
  id                 TEXT PRIMARY KEY,
  legal_name         TEXT NOT NULL,
  lp_type            TEXT NOT NULL
                     CHECK (lp_type IN ('INDIVIDUAL','FAMILY_OFFICE','INSTITUTION','FUND_OF_FUNDS','CORPORATE','OTHER')),
  status             TEXT NOT NULL DEFAULT 'PROSPECT'
                     CHECK (status IN ('PROSPECT','ENGAGED','COMMITTED','DECLINED','CLOSED')),
  relationship_owner TEXT,
  privacy_label      TEXT NOT NULL DEFAULT 'LP_PRIVATE',
  firm_scope         TEXT NOT NULL DEFAULT 'west-peek',
  created_by         TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_lp_record_status ON lp_record (status, firm_scope);

-- Contacts are NOT duplicated here: the link points at the Network OS mapping (D5).
CREATE TABLE IF NOT EXISTS lp_contact_link (
  id                    TEXT PRIMARY KEY,
  lp_record_id          TEXT NOT NULL REFERENCES lp_record (id),
  network_external_id   TEXT,
  contact_label         TEXT NOT NULL,
  contact_role          TEXT,
  firm_scope            TEXT NOT NULL DEFAULT 'west-peek',
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_lp_contact_link_lp ON lp_contact_link (lp_record_id);

CREATE TABLE IF NOT EXISTS lp_opportunity (
  id                TEXT PRIMARY KEY,
  lp_record_id      TEXT NOT NULL REFERENCES lp_record (id),
  fund_id           TEXT REFERENCES fund (id),
  stage             TEXT NOT NULL DEFAULT 'INTRODUCED'
                    CHECK (stage IN ('INTRODUCED','MATERIALS_SHARED','DILIGENCE','TERMS','COMMITTED','PASSED','WITHDRAWN')),
  target_commitment REAL,
  notes             TEXT,
  privacy_label     TEXT NOT NULL DEFAULT 'LP_PRIVATE',
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_lp_opportunity_lp ON lp_opportunity (lp_record_id, stage);

CREATE TABLE IF NOT EXISTS lp_diligence_request (
  id                TEXT PRIMARY KEY,
  lp_opportunity_id TEXT NOT NULL REFERENCES lp_opportunity (id),
  request_text      TEXT NOT NULL,
  requested_at      TEXT NOT NULL,
  due_date          TEXT,
  status            TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ANSWERED','WITHDRAWN')),
  response_note     TEXT,
  responded_by      TEXT,
  responded_at      TEXT,
  privacy_label     TEXT NOT NULL DEFAULT 'LP_PRIVATE',
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_lp_diligence_opportunity ON lp_diligence_request (lp_opportunity_id, status);

-- ── LP claims: evidence-backed or unpublishable ──
-- published_at is set ONLY by the service, behind an approved lp_marketing_claim
-- receipt, and only when every linked evidence item is itself approved/verified.

CREATE TABLE IF NOT EXISTS lp_claim (
  id               TEXT PRIMARY KEY,
  claim_text       TEXT NOT NULL,
  claim_type       TEXT NOT NULL
                   CHECK (claim_type IN ('TRACK_RECORD','STRATEGY','TEAM','PORTFOLIO','PROCESS','OTHER')),
  status           TEXT NOT NULL DEFAULT 'DRAFT'
                   CHECK (status IN ('DRAFT','PENDING_REVIEW','APPROVED','PUBLISHED','REJECTED','WITHDRAWN')),
  drafted_by_type  TEXT NOT NULL CHECK (drafted_by_type IN ('HUMAN','AI')),
  drafted_by_id    TEXT NOT NULL,
  ai_run_id        TEXT REFERENCES ai_run (id),
  approval_card_id TEXT REFERENCES approval_card (id),
  published_at     TEXT,
  privacy_label    TEXT NOT NULL DEFAULT 'LP_PRIVATE',
  firm_scope       TEXT NOT NULL DEFAULT 'west-peek',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_lp_claim_status ON lp_claim (status, firm_scope);

CREATE TABLE IF NOT EXISTS lp_claim_evidence (
  id              TEXT PRIMARY KEY,
  lp_claim_id     TEXT NOT NULL REFERENCES lp_claim (id),
  evidence_type   TEXT NOT NULL
                  CHECK (evidence_type IN ('DILIGENCE_CLAIM','KNOWLEDGE_RECORD','DOCUMENT')),
  evidence_ref_id TEXT NOT NULL,
  note            TEXT,
  linked_by       TEXT NOT NULL,
  firm_scope      TEXT NOT NULL DEFAULT 'west-peek',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_lp_claim_evidence_claim ON lp_claim_evidence (lp_claim_id);

-- ── Data room: the EXTERNAL room's governed record ──
-- provider_ref points at the external VDR object. West Peek OS does not serve,
-- stream, or host data-room delivery; it records what was shared and to whom.

CREATE TABLE IF NOT EXISTS data_room_artifact (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1,
  document_id    TEXT REFERENCES document (id),
  provider       TEXT NOT NULL DEFAULT 'EXTERNAL_VDR_UNSELECTED',
  provider_ref   TEXT,
  lp_claim_ids_json TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','READY','SUPERSEDED')),
  privacy_label  TEXT NOT NULL DEFAULT 'LP_PRIVATE',
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_data_room_artifact_version ON data_room_artifact (title, version, firm_scope);

-- Access grants are APPEND-ONLY: the ledger of who could see what, at which
-- version, with what permission, from when until when.
CREATE TABLE IF NOT EXISTS data_room_access_record (
  id               TEXT PRIMARY KEY,
  artifact_id      TEXT NOT NULL REFERENCES data_room_artifact (id),
  artifact_version INTEGER NOT NULL,
  lp_record_id     TEXT REFERENCES lp_record (id),
  recipient_label  TEXT NOT NULL,
  recipient_ref    TEXT,
  permission       TEXT NOT NULL CHECK (permission IN ('VIEW','DOWNLOAD')),
  granted_by       TEXT NOT NULL,
  granted_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at       TEXT,
  approval_card_id TEXT NOT NULL REFERENCES approval_card (id),
  external_vdr_ref TEXT,
  firm_scope       TEXT NOT NULL DEFAULT 'west-peek',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_data_room_access_artifact ON data_room_access_record (artifact_id, granted_at);

CREATE TRIGGER IF NOT EXISTS data_room_access_reject_update
BEFORE UPDATE ON data_room_access_record
BEGIN
  SELECT RAISE(ABORT, 'data_room_access_record is append-only: UPDATE rejected (access history is evidence)');
END;

CREATE TRIGGER IF NOT EXISTS data_room_access_reject_delete
BEFORE DELETE ON data_room_access_record
BEGIN
  SELECT RAISE(ABORT, 'data_room_access_record is append-only: DELETE rejected (access history is evidence)');
END;

CREATE TABLE IF NOT EXISTS data_room_revocation (
  id               TEXT PRIMARY KEY,
  access_record_id TEXT NOT NULL REFERENCES data_room_access_record (id),
  reason           TEXT NOT NULL,
  revoked_by       TEXT NOT NULL,
  revoked_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  firm_scope       TEXT NOT NULL DEFAULT 'west-peek',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_data_room_revocation_access ON data_room_revocation (access_record_id);

CREATE TRIGGER IF NOT EXISTS data_room_revocation_reject_update
BEFORE UPDATE ON data_room_revocation
BEGIN
  SELECT RAISE(ABORT, 'data_room_revocation is append-only: UPDATE rejected');
END;

CREATE TRIGGER IF NOT EXISTS data_room_revocation_reject_delete
BEFORE DELETE ON data_room_revocation
BEGIN
  SELECT RAISE(ABORT, 'data_room_revocation is append-only: DELETE rejected');
END;

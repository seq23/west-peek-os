-- 0007_meetings.sql — P7 meeting intelligence: meetings, participants, consent,
-- prep packets, transcript imports, notes, commitments, debriefs.
-- Convention: lowercase snake_case (P1); CREATE IF NOT EXISTS / INSERT OR IGNORE so
-- re-application is a no-op. firm_scope on every firm-data table (§11.7).
-- Governing law: a conversation is never institutional truth. Transcript ingestion
-- needs BOTH an activated recording policy (MP-reserved receipt) and a GRANTED
-- consent record; transcript-derived material stays sourced/unverified until a human
-- promotes it through the P5 evidence path.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0007_meetings');

-- ── Action vocabulary additions (P7) ──
-- Registry sources: src/shared/registry/actionTypes.ts + reservedActions.ts.
-- The 0003 generated seed section carries these for fresh databases; these
-- compensating rows cover databases that applied 0003 before P7 existed.

INSERT OR IGNORE INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('meeting.create', 'Create meeting', 'Record a meeting (scheduled or historical) with its participants.', 0, 0),
  ('meeting.update', 'Update meeting', 'Update meeting fields or lifecycle status.', 0, 0),
  ('meeting.participant.add', 'Add meeting participant', 'Attach an internal or external participant to a meeting.', 0, 0),
  ('meeting.consent.record', 'Record consent', 'Append a consent state for recording/transcription/note-sharing (human only; append-only).', 0, 0),
  ('meeting.prep.assemble', 'Assemble meeting prep packet', 'Assemble a prep packet from company evidence and open questions. AI may draft.', 0, 0),
  ('meeting.transcript.import', 'Import transcript', 'Import a transcript for a meeting. Requires an activated recording policy AND granted consent.', 0, 0),
  ('meeting.note.add', 'Add meeting note', 'Add a manual, off-record, or transcript-derived meeting note.', 0, 0),
  ('meeting.commitment.create', 'Record meeting commitment', 'Record a commitment made in a meeting.', 0, 0),
  ('meeting.commitment.convert', 'Convert commitment to work card', 'Turn a meeting commitment into a governed work card.', 0, 0),
  ('meeting.debrief.create', 'Create meeting debrief', 'Record a post-meeting debrief. AI may draft; it is never evidence by itself.', 0, 0),
  ('meeting.debrief.promote_claim', 'Promote debrief line to claim candidate', 'Create a diligence claim candidate from a debrief/note with TRANSCRIPT/HUMAN_STATEMENT provenance (never VERIFIED).', 0, 0),
  ('meeting.recording_policy.activate', 'meeting.recording_policy.activate', 'Activate recording/transcription policy for a meeting (human-reserved gate).', 0, 1);

INSERT OR IGNORE INTO human_reserved_action (key, category, description, approver_roles_json) VALUES
  ('meeting.recording_policy.activate', 'LEGAL_COMPLIANCE', 'Activate recording/transcription policy for a meeting (human-reserved gate).', '["MANAGING_PARTNER","COMPLIANCE_OFFICER"]');

-- ── Meetings ──
-- recording_enabled flips ONLY through an approved meeting.recording_policy.activate
-- receipt (service layer); consent is a separate, independent gate.

CREATE TABLE IF NOT EXISTS meeting (
  id                          TEXT PRIMARY KEY,
  company_id                  TEXT REFERENCES canonical_company (id),
  title                       TEXT NOT NULL,
  meeting_type                TEXT NOT NULL
                              CHECK (meeting_type IN ('FOUNDER','DILIGENCE','PORTFOLIO','LP','INTERNAL','BROKER','OTHER')),
  scheduled_at                TEXT,
  occurred_at                 TEXT,
  location                    TEXT,
  status                      TEXT NOT NULL DEFAULT 'SCHEDULED'
                              CHECK (status IN ('SCHEDULED','HELD','CANCELLED')),
  recording_enabled           INTEGER NOT NULL DEFAULT 0 CHECK (recording_enabled IN (0,1)),
  recording_policy_receipt_id TEXT,
  privacy_label               TEXT NOT NULL DEFAULT 'INTERNAL',
  firm_scope                  TEXT NOT NULL DEFAULT 'west-peek',
  created_by                  TEXT NOT NULL,
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_meeting_company ON meeting (company_id);
CREATE INDEX IF NOT EXISTS idx_meeting_status ON meeting (status, firm_scope);

CREATE TABLE IF NOT EXISTS meeting_participant (
  id               TEXT PRIMARY KEY,
  meeting_id       TEXT NOT NULL REFERENCES meeting (id),
  participant_type TEXT NOT NULL CHECK (participant_type IN ('FIRM_USER','EXTERNAL')),
  firm_user_id     TEXT REFERENCES firm_user (id),
  display_name     TEXT NOT NULL,
  organization     TEXT,
  participant_role TEXT,
  firm_scope       TEXT NOT NULL DEFAULT 'west-peek',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_meeting_participant_meeting ON meeting_participant (meeting_id);

-- ── Consent records: APPEND-ONLY. Current consent = latest row per (meeting, type). ──

CREATE TABLE IF NOT EXISTS consent_record (
  id           TEXT PRIMARY KEY,
  meeting_id   TEXT NOT NULL REFERENCES meeting (id),
  consent_type TEXT NOT NULL CHECK (consent_type IN ('RECORDING','TRANSCRIPTION','NOTE_SHARING')),
  state        TEXT NOT NULL CHECK (state IN ('REQUESTED','GRANTED','DENIED','REVOKED')),
  basis        TEXT NOT NULL,
  granted_by   TEXT,
  recorded_by  TEXT NOT NULL,
  firm_scope   TEXT NOT NULL DEFAULT 'west-peek',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_consent_record_meeting ON consent_record (meeting_id, consent_type);

CREATE TRIGGER IF NOT EXISTS consent_record_reject_update
BEFORE UPDATE ON consent_record
BEGIN
  SELECT RAISE(ABORT, 'consent_record is append-only: UPDATE rejected (consent history is evidence)');
END;

CREATE TRIGGER IF NOT EXISTS consent_record_reject_delete
BEFORE DELETE ON consent_record
BEGIN
  SELECT RAISE(ABORT, 'consent_record is append-only: DELETE rejected (consent history is evidence)');
END;

-- ── Prep packets (AI may draft; unresolved material contradictions never filtered) ──

CREATE TABLE IF NOT EXISTS meeting_prep_packet (
  id                             TEXT PRIMARY KEY,
  meeting_id                     TEXT NOT NULL REFERENCES meeting (id),
  company_id                     TEXT REFERENCES canonical_company (id),
  evidence_summary_json          TEXT NOT NULL DEFAULT '{}',
  unresolved_contradictions_json TEXT NOT NULL DEFAULT '[]',
  open_questions_json            TEXT NOT NULL DEFAULT '[]',
  drafted_by_type                TEXT NOT NULL CHECK (drafted_by_type IN ('HUMAN','AI')),
  drafted_by_id                  TEXT NOT NULL,
  ai_run_id                      TEXT,
  firm_scope                     TEXT NOT NULL DEFAULT 'west-peek',
  created_at                     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_meeting_prep_packet_meeting ON meeting_prep_packet (meeting_id);

-- ── Transcript imports ──
-- A REFUSED row is written when the gates are not satisfied, so the refusal itself
-- is auditable. document_id points at the governed R2-backed document (P5).

CREATE TABLE IF NOT EXISTS transcript_import (
  id                 TEXT PRIMARY KEY,
  meeting_id         TEXT NOT NULL REFERENCES meeting (id),
  document_id        TEXT REFERENCES document (id),
  consent_record_id  TEXT REFERENCES consent_record (id),
  source             TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('IMPORTED','REFUSED')),
  refusal_reason     TEXT,
  imported_by        TEXT NOT NULL,
  firm_scope         TEXT NOT NULL DEFAULT 'west-peek',
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_transcript_import_meeting ON transcript_import (meeting_id);

-- ── Notes: manual, off-record, and transcript-derived ──
-- OFF_RECORD notes are never a promotion source (enforced in the service).

CREATE TABLE IF NOT EXISTS meeting_note (
  id                   TEXT PRIMARY KEY,
  meeting_id           TEXT NOT NULL REFERENCES meeting (id),
  note_type            TEXT NOT NULL CHECK (note_type IN ('MANUAL','OFF_RECORD','TRANSCRIPT_DERIVED')),
  body                 TEXT NOT NULL,
  author_type          TEXT NOT NULL CHECK (author_type IN ('HUMAN','AI')),
  author_id            TEXT NOT NULL,
  ai_run_id            TEXT,
  transcript_import_id TEXT REFERENCES transcript_import (id),
  privacy_label        TEXT NOT NULL DEFAULT 'INTERNAL',
  firm_scope           TEXT NOT NULL DEFAULT 'west-peek',
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_meeting_note_meeting ON meeting_note (meeting_id);

-- ── Commitments → governed work cards ──

CREATE TABLE IF NOT EXISTS meeting_commitment (
  id               TEXT PRIMARY KEY,
  meeting_id       TEXT NOT NULL REFERENCES meeting (id),
  commitment_text  TEXT NOT NULL,
  owner_side       TEXT NOT NULL CHECK (owner_side IN ('FIRM','COUNTERPARTY')),
  owner_id         TEXT,
  due_date         TEXT,
  status           TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CONVERTED','DROPPED')),
  work_card_id     TEXT REFERENCES work_card (id),
  firm_scope       TEXT NOT NULL DEFAULT 'west-peek',
  created_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_meeting_commitment_meeting ON meeting_commitment (meeting_id);

-- ── Debriefs (a debrief is a record of judgment, never evidence by itself) ──

CREATE TABLE IF NOT EXISTS meeting_debrief (
  id               TEXT PRIMARY KEY,
  meeting_id       TEXT NOT NULL REFERENCES meeting (id),
  summary          TEXT NOT NULL,
  signal_notes     TEXT,
  drafted_by_type  TEXT NOT NULL CHECK (drafted_by_type IN ('HUMAN','AI')),
  drafted_by_id    TEXT NOT NULL,
  ai_run_id        TEXT,
  firm_scope       TEXT NOT NULL DEFAULT 'west-peek',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_meeting_debrief_meeting ON meeting_debrief (meeting_id);

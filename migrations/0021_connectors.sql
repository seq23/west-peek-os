-- 0021_connectors.sql — P22 Live relationship + meeting integrations (task §9 P22; GAP-16, GAP-17).
--
-- P9 already implements the Network OS ADAPTER CONTRACT (ownership, cursors, idempotency,
-- conflicts, receipted writeback) and P7 already implements the meeting substrate. What was
-- missing is the OPERATOR STATUS surface: which connectors exist, whether their credential name is
-- populated, what scopes they would need, whether consent is required, and when they were last
-- checked.
--
-- Every connector ships NOT_CONFIGURED. A connector row is configuration, not a working
-- integration, and this schema keeps those two ideas apart on purpose.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0021_connectors');

INSERT OR IGNORE INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('connector.check', 'Check a connector', 'Run a configuration check on an external connector and record the result.', 0, 0),
  ('meeting_prep.queue', 'Read the meeting prep queue', 'List upcoming meetings with their prep and consent state.', 0, 0);

CREATE TABLE IF NOT EXISTS connector (
  id                TEXT PRIMARY KEY,
  connector_key     TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL
                    CHECK (kind IN ('NETWORK_OS','CALENDAR','EMAIL','TRANSCRIPTION','VDR','FUND_ADMIN')),
  owns              TEXT NOT NULL DEFAULT '',
  direction         TEXT NOT NULL DEFAULT 'READ' CHECK (direction IN ('READ','WRITE','BIDIRECTIONAL')),
  credential_name   TEXT,
  scopes_json       TEXT NOT NULL DEFAULT '[]',
  consent_required  INTEGER NOT NULL DEFAULT 0,
  approval_gate     TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'NOT_CONFIGURED'
                    CHECK (status IN ('NOT_CONFIGURED','CONFIGURED','GATED','FAILED')),
  detail            TEXT NOT NULL DEFAULT '',
  last_checked_at   TEXT,
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS connector_check (
  id           TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL REFERENCES connector (id),
  mode         TEXT NOT NULL CHECK (mode IN ('LOCAL_FIXTURE','LIVE')),
  ok           INTEGER NOT NULL,
  detail       TEXT NOT NULL DEFAULT '',
  checked_by   TEXT NOT NULL,
  firm_scope   TEXT NOT NULL DEFAULT 'west-peek',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_connector_check ON connector_check (connector_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS connector_check_reject_update
BEFORE UPDATE ON connector_check
BEGIN
  SELECT RAISE(ABORT, 'connector_check is append-only: UPDATE rejected (D15)');
END;

-- The six external systems West Peek OS is designed to reach, every one NOT_CONFIGURED, each
-- naming the credential it would need, the scopes it would ask for, and the human gate in front
-- of it. Registering them is how an operator sees what is missing; it is not integration.
INSERT OR IGNORE INTO connector (id, connector_key, name, kind, owns, direction, credential_name, scopes_json, consent_required, approval_gate, status, detail) VALUES
  ('conn_network_os', 'network_os', 'Network OS', 'NETWORK_OS',
   'Contacts, relationships, touches, and Gmail-derived relationship truth. Network OS is authoritative for its own domain and West Peek OS never mirrors it.',
   'READ', 'NETWORK_OS_API_TOKEN', '["contacts:read","relationships:read"]', 0,
   'network_os.writeback is MP-reserved; a pull needs the declared adapter contract',
   'NOT_CONFIGURED',
   'The adapter contract, sync cursors, idempotent receipts, conflict rows, and receipted writeback are implemented (P9). No client is configured, so live calls fail closed.'),
  ('conn_calendar', 'calendar', 'Calendar', 'CALENDAR',
   'Scheduled meetings used to build the prep queue.', 'READ', 'CALENDAR_OAUTH_TOKEN',
   '["calendar.events.readonly"]', 0, 'operator OAuth consent', 'NOT_CONFIGURED',
   'No OAuth consent has been given. Meetings are created in West Peek OS by hand until it is.'),
  ('conn_email', 'email', 'Email', 'EMAIL',
   'Outbound and inbound mail. Sending is an external effect and always needs an approved receipt.',
   'BIDIRECTIONAL', 'EMAIL_OAUTH_TOKEN', '["mail.send","mail.readonly"]', 0,
   'every send is an external effect requiring an approved receipt (P3)', 'NOT_CONFIGURED',
   'No mailbox is connected. External-effect execution remains a local simulation.'),
  ('conn_transcription', 'transcription', 'Meeting transcription', 'TRANSCRIPTION',
   'Recording and transcript capture for meetings.', 'READ', 'TRANSCRIPTION_API_KEY', '["recording:read"]', 1,
   'meeting.recording_policy.activate is MP/compliance-reserved AND counterparty consent is a second, independent gate (P7)',
   'NOT_CONFIGURED',
   'No transcription provider is configured. Transcripts are imported by hand and only behind an activated recording policy plus granted consent.'),
  ('conn_vdr', 'vdr', 'Virtual data room', 'VDR',
   'External data-room delivery and access revocation.', 'WRITE', 'VDR_API_KEY', '["documents:write","access:manage"]', 0,
   'data-room access grants and revocations are recorded and receipted (P10)', 'NOT_CONFIGURED',
   'No VDR provider has been selected. West Peek OS records what was shared; it has never delivered anything.'),
  ('conn_fund_admin', 'fund_admin', 'Fund administrator', 'FUND_ADMIN',
   'Administrator/accounting records used for reconciliation. The administrator is authoritative and is never overwritten.',
   'READ', 'FUND_ADMIN_SFTP_KEY', '["export:read"]', 0,
   'no source contract has been agreed; every reconciliation run is stamped LOCAL_FIXTURE (P12)',
   'NOT_CONFIGURED',
   'No administrator system has been read. The import contract is written in docs/IMPORT_CONTRACTS.md and awaits an agreed export format.');

-- 0203 — Recording is the firm's default on Google Meet, decided once. (Phase Meet; 18 Sep 2026.)
--
-- THE GATE THAT COULD NOT BE AUTOMATED, AND HOW IT IS NOT. `meeting.recording_policy.activate` is
-- human-reserved, per meeting, behind an approval card. That is right for a meeting somebody typed
-- in and decided to record. It cannot be the shape for a calendar that produces ten Meet calls a
-- week: nobody will approve ten cards, and a job cannot approve them for her — reserved actions are
-- never delegable, and `liveStandingGrant` says why in SQL.
--
-- The owner's decision (18 Sep 2026) was different in kind: transcription ON BY POLICY for every
-- Meet the firm hosts. That is ONE decision, so it is ONE reserved action with ONE approval card,
-- recorded once per firm in `meet_recording_policy`. Every meeting the ingest then reads carries
-- `recording_policy_receipt_id` = that card, so the audit trail from any transcript leads back to
-- the human decision that permitted it — the same trail a hand-activated meeting has, one hop longer.
--
-- CONSENT IS STILL A SEPARATE GATE and this migration does not touch it. Google Meet announces
-- recording and transcription to every participant when they start, and a participant who stays is
-- consenting on the platform's terms; `meetIngest.ts` records that as a GRANTED row with basis
-- 'google_meet_announced' and says in code where that reasoning does NOT apply.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0203_recording_is_the_firm_default_on_meet');

-- ── Action vocabulary (Phase Meet). Registry: src/shared/registry/actionTypes.ts +
--    reservedActions.ts; the 0003 generated block carries these for fresh databases. ──

INSERT OR IGNORE INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('calendar.sync', 'Sync a partner calendar', 'Read a partner''s Google Calendar and create or update one meeting per event with a Meet link. Internal record only; reads nothing it cannot see and writes nothing to Google.', 0, 0),
  ('meet.ingest', 'Read an ended Google Meet', 'Read the participants, transcript entries and recording pointer of a conference that ended, and ingest the transcript through the governed import. Never runs a model.', 0, 0),
  ('meet.consent.platform_announced', 'Record platform-announced consent', 'Record TRANSCRIPTION and RECORDING consent as GRANTED for a Meet-native transcript, on the basis that Google Meet announced both to every participant. Never for a transcript uploaded by hand.', 0, 0),
  ('meet.recording_policy.firm_default', 'meet.recording_policy.firm_default', 'Turn the recording/transcription policy on by default for every Google Meet the firm hosts (human-reserved; one decision per firm).', 0, 1);

INSERT OR IGNORE INTO human_reserved_action (key, category, description, approver_roles_json) VALUES
  ('meet.recording_policy.firm_default', 'LEGAL_COMPLIANCE', 'Turn the recording/transcription policy on by default for every Google Meet the firm hosts (human-reserved; one decision per firm).', '["MANAGING_PARTNER","COMPLIANCE_OFFICER"]');

-- One row per firm. `receipt_id` is the consumed approval card, and every meeting the ingest
-- activates points its recording_policy_receipt_id at it.
CREATE TABLE IF NOT EXISTS meet_recording_policy (
  firm_scope    TEXT PRIMARY KEY,
  active        INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  receipt_id    TEXT,
  activated_by  TEXT,
  activated_at  TEXT,
  deactivated_by TEXT,
  deactivated_at TEXT,
  note          TEXT
);

-- ── The two jobs. INTERVAL rather than DAILY_AT, deliberately: a Meet invitation that arrives at
--    ten is a meeting at eleven, and a transcript is generated within minutes of a call ending.
--    A daily read would put the Join affordance on tomorrow's card and the After-face a day late.
--    Each tick is a handful of GETs; nothing here runs a model. `WHERE NOT EXISTS` for the reason
--    0152 gives: a bad column aborts rather than producing a job that quietly never runs. ──

INSERT INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, interval_minutes, target_kind, task_class, budget_usd,
   data_class, status, created_by, firm_scope)
SELECT
  'sjb_calendar_sync', 'calendar_sync', 'Reading the partners'' calendars for Meet calls',
  'INTELLIGENCE', 'INTERVAL', 60, 'SYSTEM', 'DERIVATION', 0,
  'INTERNAL', 'ACTIVE', 'system', 'west-peek'
WHERE NOT EXISTS (SELECT 1 FROM scheduled_job WHERE job_key = 'calendar_sync');

INSERT INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, interval_minutes, target_kind, task_class, budget_usd,
   data_class, status, created_by, firm_scope)
SELECT
  'sjb_meet_ingest', 'meet_ingest', 'Reading Meet calls that ended',
  'INTELLIGENCE', 'INTERVAL', 60, 'SYSTEM', 'DERIVATION', 0,
  'INTERNAL', 'ACTIVE', 'system', 'west-peek'
WHERE NOT EXISTS (SELECT 1 FROM scheduled_job WHERE job_key = 'meet_ingest');

CREATE TABLE migration_guard_0203 (matched INTEGER NOT NULL CHECK (matched = 2));
INSERT INTO migration_guard_0203 (matched)
SELECT COUNT(*) FROM scheduled_job WHERE job_key IN ('calendar_sync','meet_ingest') AND status = 'ACTIVE';
DROP TABLE migration_guard_0203;

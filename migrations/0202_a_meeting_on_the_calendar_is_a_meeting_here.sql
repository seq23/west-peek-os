-- 0202 — A meeting on the calendar is a meeting here. (Phase Meet, tier 1 and 2; 18 Sep 2026.)
--
-- Owner-approved: make Google Meet seamless. Until now a meeting existed in this system only when
-- somebody typed it in, and a transcript existed only when somebody pasted one. Both partners run
-- their calls on Google Meet, which already knows when the call starts, who was invited, when it
-- ended, and — with transcription on — what was said. This migration gives `meeting` the columns
-- that let a calendar event and a Meet conference be recognised as the SAME meeting on every sync,
-- and adds the two tables the sync and the ingest keep their own state in.
--
-- IDEMPOTENCY IS A COLUMN, NOT A HOPE. A calendar event exists here as exactly one meeting because
-- (calendar_key, google_event_id) is UNIQUE. A sync that runs twice updates; it cannot duplicate.
-- `validate:calendar-sync` proves it against a fixture and hard-fails on zero events examined.
--
-- THE BYTES STAY IN DRIVE. `recording_ref` is a Drive file id and `transcript_ref` is a Docs id.
-- Nothing here copies a recording into this system; the pointer is the record.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0202_a_meeting_on_the_calendar_is_a_meeting_here');

-- Which calendar produced it. NULL for meetings somebody typed in.
ALTER TABLE meeting ADD COLUMN calendar_key TEXT;
-- The Calendar API event id (instance id for a recurring series — one row per occurrence).
ALTER TABLE meeting ADD COLUMN google_event_id TEXT;
-- The Meet meeting code ("abc-defg-hjk"), which is what a conference record is looked up by.
ALTER TABLE meeting ADD COLUMN meet_conference_id TEXT;
-- The link a partner clicks to join. Kept verbatim from the event's conference entry point.
ALTER TABLE meeting ADD COLUMN meet_link TEXT;
-- 'manual' is what every existing row was. 'google_calendar' rows are owned by the sync: title,
-- time and attendees follow the calendar; type and company are inferred once and then a person's.
ALTER TABLE meeting ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual','google_calendar'));
-- How meeting_type was arrived at when the sync chose it. NULL when a person chose it.
--   FIRM_ONLY      — every attendee is on a firm domain → INTERNAL
--   LP_CONTACT     — an attendee is a known LP contact → LP (privacy LP_PRIVATE)
--   COMPANY_DOMAIN — an attendee's domain matches canonical_company.website → FOUNDER, linked
--   UNKNOWN_CHECK_IT — none of the above → FOUNDER, and the card says "type inferred, check it"
ALTER TABLE meeting ADD COLUMN type_inference TEXT
  CHECK (type_inference IS NULL OR type_inference IN ('FIRM_ONLY','LP_CONTACT','COMPANY_DOMAIN','UNKNOWN_CHECK_IT'));
-- Drive file id of the Meet recording, when one was made. The file stays in Drive.
ALTER TABLE meeting ADD COLUMN recording_ref TEXT;
-- Docs id of the Meet transcript document, when one was generated. The doc stays in Drive.
ALTER TABLE meeting ADD COLUMN transcript_ref TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_calendar_event
  ON meeting (calendar_key, google_event_id) WHERE google_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_meeting_conference ON meeting (meet_conference_id) WHERE meet_conference_id IS NOT NULL;

-- One row per calendar the firm reads. The sync's own ledger: when it last ran, through which
-- door (the API under impersonation, or the private iCal URL when the API path fails), what it
-- saw, and the Workspace Events subscription that covers this calendar's Meet spaces when one
-- could be created. `subscription_state` names the stop when one could not.
CREATE TABLE IF NOT EXISTS google_calendar_sync (
  calendar_key          TEXT PRIMARY KEY,
  subject_email         TEXT NOT NULL,
  firm_scope            TEXT NOT NULL,
  last_synced_at        TEXT,
  last_status           TEXT CHECK (last_status IS NULL OR last_status IN ('OK','FAILED')),
  last_detail           TEXT,
  last_via              TEXT CHECK (last_via IS NULL OR last_via IN ('api','ics')),
  events_seen           INTEGER NOT NULL DEFAULT 0,
  meetings_created      INTEGER NOT NULL DEFAULT 0,
  meetings_updated      INTEGER NOT NULL DEFAULT 0,
  subscription_name     TEXT,
  subscription_expires  TEXT,
  subscription_state    TEXT NOT NULL DEFAULT 'NONE'
                        CHECK (subscription_state IN ('NONE','ACTIVE','SCOPE_MISSING','FAILED')),
  subscription_detail   TEXT,
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Every Meet conference this system has heard about, however it heard. One row per conference
-- record; the UNIQUE is what makes "exactly one ingest per ended call" a property of the schema
-- rather than of the code path that happened to run. `validate:meet-ingest` proves it.
--   RECEIVED      — known, not yet read (transcript may not be generated yet; retried each tick)
--   INGESTED      — participants and transcript read, notes written, meeting HELD
--   REFUSED       — the governed import refused (the reason is on transcript_import too)
--   NO_TRANSCRIPT — the call ended and Meet produced no transcript within the window
--   NO_MEETING    — a conference this system could not match to a calendar meeting
--   FAILED        — an error; detail says what, and the row is retried
CREATE TABLE IF NOT EXISTS meet_event_inbox (
  id                    TEXT PRIMARY KEY,
  conference_record     TEXT NOT NULL UNIQUE,
  meeting_id            TEXT REFERENCES meeting (id),
  calendar_key          TEXT,
  meeting_code          TEXT,
  delivered_via         TEXT NOT NULL CHECK (delivered_via IN ('poll','pubsub')),
  event_type            TEXT,
  conference_started_at TEXT,
  conference_ended_at   TEXT,
  state                 TEXT NOT NULL DEFAULT 'RECEIVED'
                        CHECK (state IN ('RECEIVED','INGESTED','REFUSED','NO_TRANSCRIPT','NO_MEETING','FAILED')),
  detail                TEXT,
  attempts              INTEGER NOT NULL DEFAULT 0,
  transcript_import_id  TEXT REFERENCES transcript_import (id),
  transcript_ref        TEXT,
  recording_ref         TEXT,
  participants_json     TEXT NOT NULL DEFAULT '[]',
  turns                 INTEGER NOT NULL DEFAULT 0,
  unattributed_turns    INTEGER NOT NULL DEFAULT 0,
  firm_scope            TEXT NOT NULL DEFAULT 'west-peek',
  received_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_meet_event_inbox_state ON meet_event_inbox (state, received_at);
CREATE INDEX IF NOT EXISTS idx_meet_event_inbox_meeting ON meet_event_inbox (meeting_id);

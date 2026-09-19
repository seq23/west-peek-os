-- 0215 — The room hears the Meet LIVE. (Phase Meet, tier 4; owner-approved 19 Sep 2026.)
--
-- THE OWNER'S QUESTION, verbatim: "If I push Join on Meet what happens? Is it recording? Are my AI
-- employees there from Join on Meet alone?" Before this migration the honest answer was no: Join
-- opened a tab, and the room heard nothing until the call ended and the official transcript was
-- read in (tier 2). This is the live path — the OS joins the firm-hosted Meet as a participant
-- through the Meet Media API, and its audio goes down the SAME chunk → Nova-3 → governed import
-- path the laptop microphone uses (Phase C), so the rolling draft, ask-the-room and the seated
-- employees hear the call with no new UI.
--
-- WHERE THE WEBRTC PEER LIVES, and why it is not this Worker. The Media API is a WebRTC session:
-- DTLS, SRTP, ICE over UDP, Opus at 48 kHz, held for the length of the call. A Cloudflare Worker
-- has `fetch` and nothing of that; a Durable Object has the same runtime; a Container could hold it
-- but would be a new Cloudflare product, a paid one, with a Chromium image inside it. The
-- reference client Google ships runs in Chrome. So the peer is the seat already on her Mac
-- (`scripts/claimer/` is the pattern; `scripts/meet/live-listener.mjs` is the program): headless
-- Chromium through Playwright, which the repo already carries for e2e, joining as the firm under
-- the same service-account grant tier 2 reads with. The Worker keeps every decision — the gates,
-- the consent record, the import, the state on the meeting — and the Mac is a pair of ears.
--
-- WHAT THE LISTENER MAY AND MAY NOT DO, in the shape of the tables below:
--   · it may ask which calendar meetings are due, say that it is awake, open a session on a meeting
--     the Worker has already gated, post audio slices to that session, and say how the session
--     ended. Every one of those goes through a route that checks the gates again.
--   · it may NOT open a session on a manual meeting, on a meeting without a Meet conference, or
--     while the firm's recording default is off — `meetLive.ts` refuses each by name and the
--     refusal is a state on the meeting a partner can read.
--   · it never chooses a model, never writes a note itself, never talks to anything but Google and
--     this Worker. `npm run validate:meet-live` reads the program and the service and fails the
--     build if any of that stops being true.
--
-- STATES ON THE MEETING ROW — what the During face renders (the sibling branch renders them):
--   meet_live_listening            the OS is in the call and slices are arriving
--   meet_live_joining              a session is open; the peer is connecting
--   meet_live_ended                the call ended; the live notes are on the record
--   meet_not_started               a firm-hosted Meet on the calendar that has not begun
--   meet_live_no_listener          the call is live but no listener has been heard from
--   meet_live_unavailable_scope    the delegation grant lacks the Media API scope (the named stop)
--   meet_live_unavailable_preview  Google answers "Method not found" on v2beta: the project is not
--                                  enrolled in the Workspace Developer Preview (the second stop)
--   meet_live_unavailable_edition  Google refused the join (the exact API error is in the detail)
--   meet_live_unavailable_policy   the firm's Meet recording default is off
--   meet_live_failed               the peer failed for a reason that is not one of the above
--   NULL                           a manual meeting, or one without a Meet conference: not applicable
--
-- TWO SOURCES OF ONE CALL, decided here. The live notes (`transcript_import.provider_name =
-- 'GOOGLE_MEET_LIVE'`) and the official Meet transcript tier 2 reads after the call
-- ('GOOGLE_MEET') describe the same conversation. The OFFICIAL transcript is authoritative for
-- the After face: Google attributes every entry to a named participant and it is one complete
-- document; the live notes are sliced, diarised by index, and exist so the room can hear DURING.
-- When the official transcript lands, every live import for the meeting has `superseded_by` set
-- to it, and the note readers that feed the After draft and the room's context skip superseded
-- imports — the live notes stay on the record as corroboration, never deleted, never read twice.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0215_the_room_hears_the_meet_live');

-- ── Action vocabulary. Registry: src/shared/registry/actionTypes.ts; the 0003 generated block
--    carries this for fresh databases. Internal, not reserved: joining a firm-hosted call under the
--    firm's own recording default is the mechanism of the ONE reserved decision 0203 recorded
--    (`meet.recording_policy.firm_default`), and Meet announces the participant to everyone in the
--    call. Without that decision the join is refused, in code, every time. ──
INSERT OR IGNORE INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('meet.live.join', 'Join a firm-hosted Google Meet live', 'Open a live listening session on a calendar-synced meeting whose Meet conference is running, under the firm''s activated recording default, with platform-announced consent recorded. The audio goes only to Workers AI speech-to-text and the words through the governed transcript import. Never for a manual meeting.', 0, 0);

-- ── The meeting row carries the live state the During face renders. ──
ALTER TABLE meeting ADD COLUMN meet_live_state TEXT
  CHECK (meet_live_state IS NULL OR meet_live_state IN (
    'meet_not_started','meet_live_joining','meet_live_listening','meet_live_ended','meet_live_no_listener',
    'meet_live_unavailable_scope','meet_live_unavailable_preview','meet_live_unavailable_edition',
    'meet_live_unavailable_policy','meet_live_failed'));
ALTER TABLE meeting ADD COLUMN meet_live_detail TEXT;
ALTER TABLE meeting ADD COLUMN meet_live_updated_at TEXT;

-- ── One live session per conference. UNIQUE on the conference record: however many times the
--    listener notices the same running call, it is one session and one consent record. ──
CREATE TABLE IF NOT EXISTS meet_live_session (
  id                     TEXT PRIMARY KEY,
  meeting_id             TEXT NOT NULL REFERENCES meeting (id),
  conference_record      TEXT NOT NULL,
  meeting_code           TEXT NOT NULL,
  listener_device        TEXT NOT NULL,
  state                  TEXT NOT NULL DEFAULT 'JOINING'
                         CHECK (state IN ('JOINING','LISTENING','ENDED','FAILED','REFUSED')),
  detail                 TEXT,
  join_identity          TEXT,
  consent_transcription_id TEXT REFERENCES consent_record (id),
  consent_recording_id   TEXT REFERENCES consent_record (id),
  chunks                 INTEGER NOT NULL DEFAULT 0,
  turns                  INTEGER NOT NULL DEFAULT 0,
  seconds_heard          REAL NOT NULL DEFAULT 0,
  neurons                REAL NOT NULL DEFAULT 0,
  drafts_rolled          INTEGER NOT NULL DEFAULT 0,
  last_draft_at          TEXT,
  official_import_id     TEXT REFERENCES transcript_import (id),
  joined_at              TEXT,
  ended_at               TEXT,
  firm_scope             TEXT NOT NULL DEFAULT 'west-peek',
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meet_live_session_conference ON meet_live_session (conference_record);
CREATE INDEX IF NOT EXISTS idx_meet_live_session_meeting ON meet_live_session (meeting_id, created_at);

-- ── The listener says it is awake. One row per device; the Worker reads `last_seen_at` to tell
--    "the call is live and nobody is listening" from "the call is live and the peer is joining". ──
CREATE TABLE IF NOT EXISTS meet_live_listener (
  device_id      TEXT PRIMARY KEY,
  last_seen_at   TEXT NOT NULL,
  version        TEXT,
  media_scope    TEXT NOT NULL DEFAULT 'UNKNOWN'
                 CHECK (media_scope IN ('UNKNOWN','GRANTED','SCOPE_MISSING','PREVIEW_MISSING','REFUSED')),
  detail         TEXT,
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek'
);

-- ── A live import is superseded by the official one. ──
ALTER TABLE transcript_import ADD COLUMN superseded_by TEXT REFERENCES transcript_import (id);

CREATE TABLE migration_guard_0215 (matched INTEGER NOT NULL CHECK (matched = 4));
INSERT INTO migration_guard_0215 (matched)
SELECT
  (SELECT COUNT(*) FROM pragma_table_info('meeting') WHERE name IN ('meet_live_state','meet_live_detail','meet_live_updated_at')) - 2
  + (SELECT COUNT(*) FROM pragma_table_info('transcript_import') WHERE name = 'superseded_by')
  + (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('meet_live_session','meet_live_listener'));
DROP TABLE migration_guard_0215;

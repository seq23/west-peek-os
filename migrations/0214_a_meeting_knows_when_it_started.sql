-- 0214 — A meeting knows when it started, so "in progress" is derived from events and never pressed.
--
-- Owner, 19 Sep 2026, on the "It is happening now" button: "wtf is that button". It flipped nothing
-- on the server — it opened the During face — and so "in progress" was a face a person had chosen,
-- not a fact about the meeting. Retired. The meeting is in progress when one of the things that
-- start a meeting has happened, each recorded HERE, in one place (`markMeetingStarted`):
--
--   · a partner joined the call from the app — Join on Meet, Beside the call, or the laptop-mic path
--   · capture began — their yes was recorded and the recording switch went on
--   · Google reported the conference started (the live path on feat/meet-media-live writes the same
--     column when it sees it)
--
-- `started_at` is the moment; `started_via` names which of those it was, so the row is evidence and
-- not a flag. A SCHEDULED meeting with a `started_at` is "happening now": off Coming up, on the record
-- with that reading, and the masthead's "next one" skips it. HELD is unchanged — it is set when the
-- call is read in or a person finishes the room, as before.
--
-- ADD COLUMN, NOT A TABLE REBUILD: nullable, and `meeting` is a root many tables point at.
ALTER TABLE meeting ADD COLUMN started_at TEXT;
ALTER TABLE meeting ADD COLUMN started_via TEXT
  CHECK (started_via IS NULL OR started_via IN ('join_on_meet','laptop_mic','capture','conference_started'));

CREATE TABLE migration_guard_0214 (matched INTEGER NOT NULL CHECK (matched = 2));
INSERT INTO migration_guard_0214 (matched)
SELECT COUNT(*) FROM pragma_table_info('meeting') WHERE name IN ('started_at', 'started_via');
DROP TABLE migration_guard_0214;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0214_a_meeting_knows_when_it_started');

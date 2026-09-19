-- 0216 — The call ended is ONE signal on the meeting row. (Phase Meet, tier 3; 19 Sep 2026.)
--
-- Two things now know a Meet call ended: the live listener (tier 4, when the peer is disconnected
-- or the space has no active conference) and the ended-call ingest (tier 2, when Google's
-- conference record carries an end time). The Meet add-on side panel (tier 3) and the During face
-- both need to say "the call is over — open what came out of it", and they must read the SAME
-- fact rather than each inferring it from a different table. So the fact lives once, here:
--
--   meeting.call_ended_at   ISO time the conference ended, written by whichever of the two learns
--                           it first (COALESCE — never overwritten), NULL while the call has not
--                           ended or was never a Meet call.
--
-- The name is published in the tier 3/4 PR so the sibling branch renders from it. A manual
-- meeting never gets one: "held" is a status a person sets; "the call ended" is a fact Google or
-- the listener reports.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0216_the_call_ended_is_one_signal');

ALTER TABLE meeting ADD COLUMN call_ended_at TEXT;

CREATE TABLE migration_guard_0216 (matched INTEGER NOT NULL CHECK (matched = 1));
INSERT INTO migration_guard_0216 (matched)
SELECT COUNT(*) FROM pragma_table_info('meeting') WHERE name = 'call_ended_at';
DROP TABLE migration_guard_0216;

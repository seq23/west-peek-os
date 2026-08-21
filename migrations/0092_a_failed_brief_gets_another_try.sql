-- A brief that failed this morning should not cost the partner their whole day.
--
-- The chunked brief treats a partner as finished for the day once their report reaches READY or
-- FAILED. READY is obviously finished. FAILED was wrong: Scooter's brief failed at 06:45 on
-- 21 Aug 2026, and under that rule he would have received nothing until the following morning —
-- from one transient failure, on the surface he reads first.
--
-- The opposite extreme is worse. The job now fires every fifteen minutes, so retrying a failing
-- brief unconditionally is ninety-six attempts a day, each one paying for two AI calls. That is
-- real money spent re-failing.
--
-- So: a bounded retry. `attempts` counts how many times generation has started for that partner on
-- that date, and a FAILED report is due again until it has been tried MAX_BRIEF_ATTEMPTS times.
-- Three attempts across a morning survives a provider blip and a bad feed; a fourth would be the
-- system insisting rather than trying.
--
-- Existing rows default to 1: they have been tried once, which is true of every report that exists.

ALTER TABLE intelligence_report ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0092_a_failed_brief_gets_another_try');

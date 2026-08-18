-- 0025_briefing_synthesis.sql — P30: the Daily Brief becomes a written synthesis.
--
-- The briefing already selects and ranks items per Managing Partner. What it never had is the
-- thing an operator actually wants at 7am: a short written read across ALL sources, in their lens,
-- instead of a list of headlines to scan.
--
-- Additive and reversible: three nullable columns on an existing table. No column is dropped, no
-- constraint changed, no row rewritten. A briefing with no synthesis renders exactly as it does
-- today, so an un-synthesised day degrades to the current behaviour rather than to an error.
--
-- WHY THE PROSE IS STORED RATHER THAN GENERATED ON READ: a brief is a dated artifact. Two people
-- opening the same day's brief must see the same words, and re-reading tomorrow must not silently
-- reword yesterday. Storing it also means one model call per person per day, not one per page view.
--
-- `synthesis_ai_run_id` keeps the provenance link: the brief is MODEL OUTPUT, and the run it came
-- from carries the cost, the provider, the quarantine state and the audit trail. Prose with no
-- traceable origin is exactly what this system refuses to produce elsewhere.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0025_briefing_synthesis');

ALTER TABLE briefing ADD COLUMN synthesis_md TEXT;
ALTER TABLE briefing ADD COLUMN synthesis_ai_run_id TEXT REFERENCES ai_run (id);
ALTER TABLE briefing ADD COLUMN synthesis_state TEXT NOT NULL DEFAULT 'NONE'
  CHECK (synthesis_state IN ('NONE','READY','FAILED','REFUSED'));

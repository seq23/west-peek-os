-- 0087 — one way to point at an AI employee.
--
-- THE INCONSISTENCY, which the value-shape validator surfaced the moment it existed:
--
--   scheduled_job.target_id → ai_employee.name   ("Parker")
--   work_card.owner_id      → ai_employee.id     ("aie_wyatt")
--   ai_run.ai_employee_id   → ai_employee.id     ("aie_wyatt")
--
-- Same concept, two conventions, and a lookup written against the wrong one refused Parker's job
-- twice a day for a week. Fixing that lookup made it work; it did not make the codebase coherent,
-- and the operator asked for coherence.
--
-- THE RULE FROM HERE: a REFERENCE to an employee is their id. A BYLINE is their name.
--
-- That distinction is not a compromise, it is the actual difference between the two things.
-- `work_card.owner_id` points at a row and must survive a retitle; `deliverable.prepared_by` is a
-- signature — "Wren prepared this" — and must survive the employee being retired and their row
-- changing underneath it. Bylines therefore stay names on purpose, as their own comments already
-- say, and every column that points at a row becomes an id.
--
-- LATENT BUG THIS ALSO CLOSES. `jobs.ts` passed `target_id` straight through as the run's
-- `aiEmployeeId`, so a successful scheduled job would have written "Parker" into
-- `ai_run.ai_employee_id`, where every other writer puts "aie_parker". Nobody had seen it because
-- the job had never once succeeded — the broken lookup refused it first. Repairing the lookup
-- without this would have swapped a visible refusal for silently split spend attribution.

UPDATE scheduled_job
   SET target_id = (SELECT e.id FROM ai_employee e WHERE e.name = scheduled_job.target_id)
 WHERE target_kind = 'EMPLOYEE'
   AND target_id IS NOT NULL
   -- Only rows still carrying a name. Anything already an id is left exactly as it is, so this
   -- migration is safe to have run twice and safe to run against a database that never diverged.
   AND EXISTS (SELECT 1 FROM ai_employee e WHERE e.name = scheduled_job.target_id)
   AND NOT EXISTS (SELECT 1 FROM ai_employee e WHERE e.id = scheduled_job.target_id);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0087_employee_references_are_ids');

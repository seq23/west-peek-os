-- Proving the diagnostics monitor exists, rather than assuming it landed.
--
-- Migrations `0112` and `0113` seeded `diagnostics_sweep` with `INSERT OR IGNORE`, which is the
-- exact pattern this repo has been removing everywhere else — and the exact pattern that, twice,
-- reported a successful migration while silently dropping the row on a CHECK failure. That is how
-- the firm ended up with a monitor that was not there and nothing anywhere saying so. `0113` is even
-- named "the diagnostics job actually lands", and it used the swallowing form to land it.
--
-- Those two are applied and migrations are append-only, so they cannot be edited. This compensates
-- instead: `INSERT … SELECT … WHERE NOT EXISTS` inserts the job only if it is genuinely absent, and
-- ANY constraint failure now aborts the migration loudly rather than being forgiven. On a database
-- where the row already landed this is a no-op; on one where it was silently swallowed, the row is
-- created — and if it cannot be created, the deploy stops and says why.
--
-- `tests/seededJobs.test.ts` grandfathers `0112` and `0113` on the strength of this file. It is a
-- narrower exemption than it looks: the rule still binds every future migration, and the two
-- exempted ones are now covered by a check that fails loudly.
INSERT INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, interval_minutes, target_kind, target_id,
   budget_usd, data_class, status, created_by)
SELECT
  'sjob_diagnostics_sweep', 'diagnostics_sweep', 'Diagnostics sweep', 'EMPLOYEE_TASK',
  'INTERVAL', 15,
  'SYSTEM', NULL,
  -- No budget, for the same reason as before: the checks are COUNT queries, not model calls, and a
  -- monitor a spend ceiling can stop is a monitor that goes quiet exactly when the firm is in trouble.
  0, 'INTERNAL', 'ACTIVE', 'system'
WHERE NOT EXISTS (SELECT 1 FROM scheduled_job WHERE job_key = 'diagnostics_sweep');

-- OR IGNORE here and NOWHERE else in this file: the version marker is the one row where a re-apply
-- is genuinely a no-op rather than a swallowed failure.
INSERT OR IGNORE INTO schema_version (migration) VALUES ('0127_the_diagnostics_job_is_provably_there');

-- The diagnostics sweep, on the schedule.
--
-- INTERVAL 15 to match the cron already in wrangler.toml. Item 22 asked for the interval to be
-- decided and documented, so: every tick. The checks are a handful of COUNT queries against D1 and
-- cost nothing, and the failures they catch sit unnoticed for days otherwise. There is no argument
-- for checking the system's own health less often than the cheapest job on the schedule.
--
-- ACTIVE from the start, unlike most seeded jobs. A monitor that ships switched off is a monitor
-- nobody switches on, and this one is the thing that would have told the firm about the last four
-- silent failures.

INSERT OR IGNORE INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, interval_minutes, target_kind, target_id,
   budget_usd, data_class, status, created_by)
VALUES
  ('sjob_diagnostics_sweep', 'diagnostics_sweep', 'Diagnostics sweep', 'OPERATIONS',
   'INTERVAL', 15,
   -- SYSTEM, not MACHINE: this checks the whole system rather than one machine's work, and the
   -- table's own CHECK requires a target_id for anything that is not SYSTEM.
   'SYSTEM', NULL,
   -- No budget: the checks are COUNT queries, not model calls. A monitor that can be stopped by a
   -- spend ceiling is a monitor that goes quiet exactly when the firm is in trouble.
   0, 'INTERNAL', 'ACTIVE', 'system');

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0112_diagnostics_runs_on_the_clock');

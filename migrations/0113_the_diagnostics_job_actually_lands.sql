-- 0112 inserted nothing, and said nothing about it.
--
-- `scheduled_job.kind` carries CHECK (kind IN ('INTELLIGENCE','PORTFOLIO_EVALUATION','EMPLOYEE_TASK'))
-- and 0112 used 'OPERATIONS'. The row was rejected — and because the statement was INSERT OR IGNORE,
-- the migration reported success and the monitor simply was not there. Worth recording: this is the
-- same failure mode the job itself exists to catch, arriving in the migration that creates it.
--
-- EMPLOYEE_TASK, and it is the least wrong of the three rather than the right one. None of the
-- kinds describes the system checking itself. Widening the CHECK means rebuilding the table in
-- SQLite, which is real risk against a live table for a column that drives display and nothing else
-- — dispatch is on `job_key`. Recorded as schema debt rather than fixed under a deploy.

INSERT OR IGNORE INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, interval_minutes, target_kind, target_id,
   budget_usd, data_class, status, created_by)
VALUES
  ('sjob_diagnostics_sweep', 'diagnostics_sweep', 'Diagnostics sweep', 'EMPLOYEE_TASK',
   'INTERVAL', 15,
   -- SYSTEM: this checks the whole system rather than one machine's work.
   'SYSTEM', NULL,
   -- No budget: the checks are COUNT queries, not model calls. A monitor that a spend ceiling can
   -- stop is a monitor that goes quiet exactly when the firm is in trouble.
   0, 'INTERNAL', 'ACTIVE', 'system');

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0113_the_diagnostics_job_actually_lands');

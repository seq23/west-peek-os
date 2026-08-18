-- 0043_scheduled_briefings.sql — P51: the weekly review gets a schedule.
--
-- WHAT WAS ACTUALLY WRONG, corrected from the backlog. `daily_intelligence` was already an ACTIVE
-- DAILY_AT job — but it runs the SWEEP, which gathers items. The BRIEFING that reads those items
-- had no schedule. Two different things sharing one name, which is how the gap survived a review.
--
-- The briefing is not given its own job. It is chained after the sweep in the same run
-- (services/jobs.ts): the brief reads what the sweep just gathered, and two independent jobs could
-- fire in either order — a brief that ran first would brief on yesterday.
--
-- WHY THIS JOB IS REGISTERED AS 'INTELLIGENCE' AND DISPATCHED BY job_key. `kind` is a CHECK
-- constraint, SQLite cannot alter one in place, and the table cannot be rebuilt here: job_run holds
-- foreign keys into it, and `PRAGMA foreign_keys=OFF` is a NO-OP inside a transaction, which is what
-- D1 wraps each migration in. Attempted and confirmed, not assumed.
--
-- So the dispatcher branches on job_key before kind, with the reason recorded at the branch. The
-- alternative — dropping the CHECK — would remove the thing that stops a typo becoming a job that
-- silently never runs, which is a worse trade than one documented special case.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0043_scheduled_briefings');

-- Starts PAUSED. Recurring work is opt-in here, and an agenda nobody asked for arriving every
-- Monday is how a useful artefact becomes noise.
INSERT OR IGNORE INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, daily_at_utc, target_kind, task_class, budget_usd,
   data_class, status, pause_reason, created_by, firm_scope)
VALUES
  ('sjb_weekly_review', 'weekly_mp_review', 'Weekly MP operating review',
   'INTELLIGENCE', 'DAILY_AT', '12:00', 'SYSTEM', 'DERIVATION', 0.10,
   'INTERNAL', 'PAUSED',
   'Starts paused: recurring work is opt-in. Generates the week''s agenda from live records; it decides nothing.',
   'system', 'west-peek');

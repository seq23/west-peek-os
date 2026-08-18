-- 0047 — actually register the monthly Room proposal.
--
-- Migration 0046 tried and silently failed: it omitted scheduled_job.created_by, which is NOT NULL,
-- and `INSERT OR IGNORE` turned the constraint violation into a no-op. The migration reported
-- success, schema_version advanced, and the job did not exist in any database.
--
-- THIS IS THE SECOND TIME `INSERT OR IGNORE` HAS HIDDEN A CONSTRAINT FAILURE in this repo. Do not
-- use it for seeding. The idiom below is idempotent the honest way: the WHERE NOT EXISTS skips a
-- row that is already there, while any real constraint violation still raises and fails the
-- migration — which is the entire point of running migrations.
--
-- 0046 is left as it is rather than edited: an applied migration does not re-run, so editing it
-- would fix nothing and would only make the history lie about what happened.
INSERT INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, daily_at_utc, target_kind, target_id, capability_key,
   task_class, budget_usd, data_class, payload_json, status, created_by)
SELECT
  'sj_monthly_room_proposal', 'monthly_room_proposal', 'Monthly Room proposal (Parker)',
  'EMPLOYEE_TASK', 'DAILY_AT', '13:00', 'EMPLOYEE', 'Parker', 'room_packet.manage',
  'INTELLIGENCE', 1.50, 'PUBLIC', '{"city":"New York"}', 'PAUSED', 'system'
WHERE NOT EXISTS (SELECT 1 FROM scheduled_job WHERE job_key = 'monthly_room_proposal');

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0047_room_proposal_job_fix');

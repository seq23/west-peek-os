-- 0046 — register Parker's monthly Room proposal.
--
-- Runs DAILY and generates only when the current month has no proposal yet, matching
-- weekly_mp_review. schedule_kind has no MONTHLY value, and widening that CHECK would mean
-- rebuilding scheduled_job while job_run holds foreign keys into it.
--
-- kind is EMPLOYEE_TASK because the CHECK cannot be widened either; dispatch keys off job_key
-- before kind (see executeJobBody).
--
-- STARTS PAUSED. Recurring work is opt-in, and this one spends money on a live search plus a
-- synthesis every month. Switch it on from Scheduled Work.
INSERT OR IGNORE INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, daily_at_utc, target_kind, target_id, capability_key,
   task_class, budget_usd, data_class, payload_json, status)
VALUES
  ('sj_monthly_room_proposal', 'monthly_room_proposal', 'Monthly Room proposal (Parker)',
   'EMPLOYEE_TASK', 'DAILY_AT', '13:00', 'EMPLOYEE', 'Parker', 'room_packet.manage',
   'INTELLIGENCE', 1.50, 'PUBLIC', '{"city":"New York"}', 'PAUSED');

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0046_monthly_room_proposal');

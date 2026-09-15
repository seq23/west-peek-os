-- 0167 · one Productions email a month (15 Sep 2026)
--
-- "why is scooter getting 2 emails?" — the customer list and the press drafts were two jobs and two
-- emails. One job now opens one card that does both and sends one note. The two earlier jobs are
-- paused with the reason, not deleted: their past runs and cards stay readable.
INSERT INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, daily_at_utc, target_kind, target_id, capability_key,
   task_class, budget_usd, data_class, payload_json, status, created_by, firm_scope, next_run_at)
SELECT
  'sjb_productions_monthly', 'productions_monthly',
  'West Peek Productions: the month in one note (Walker, for Scooter)',
  'EMPLOYEE_TASK', 'DAILY_AT', '14:00', 'EMPLOYEE', 'Walker', 'work_card.create',
  'INTELLIGENCE', 1.50, 'PUBLIC', '{"for":"scooter@westpeek.ventures","business":"West Peek Productions","one_card_a_month":true}', 'ACTIVE',
  'system', 'west-peek', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (SELECT 1 FROM scheduled_job WHERE job_key = 'productions_monthly');

UPDATE scheduled_job
   SET status = 'PAUSED',
       pause_reason = 'Folded into productions_monthly on 15 Sep 2026: one email a month, not two.'
 WHERE job_key IN ('productions_customer_ideas', 'productions_press_pitches') AND status = 'ACTIVE';

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0166_one_productions_email_a_month');

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0167_one_productions_email_a_month');

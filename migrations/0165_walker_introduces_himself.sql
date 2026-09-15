-- 0165 · Walker introduces himself to Scooter, once (15 Sep 2026)
--
-- The operator, after the first Productions run: "send scooter another email acknowledging the
-- first one was bad and maybe walker should introduce himself in that email too if he did not that
-- he is the chief of staff and a reminder that any emails scooter wants to send should be to
-- os@joinwestpeek.com and those get routed via Porter." A one-off job, dispatched by key, that
-- sends the note through the partner-email path and pauses itself — so it is on the record like
-- every other thing an employee sends, and cannot fire twice.
INSERT INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, interval_minutes, target_kind, target_id, capability_key,
   task_class, budget_usd, data_class, payload_json, status, created_by, firm_scope, next_run_at)
SELECT
  'sjb_productions_intro_note', 'productions_intro_note',
  'West Peek Productions: Walker introduces himself to Scooter (once)',
  'EMPLOYEE_TASK', 'INTERVAL', 1440, 'EMPLOYEE', 'Walker', 'work_card.create',
  'OPERATIONS', 0, 'PUBLIC', '{"for":"scooter@westpeek.ventures","once":true}', 'ACTIVE',
  'system', 'west-peek', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (SELECT 1 FROM scheduled_job WHERE job_key = 'productions_intro_note');

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0165_walker_introduces_himself');

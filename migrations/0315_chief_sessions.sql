ALTER TABLE partner_session ADD COLUMN source TEXT NOT NULL DEFAULT 'EMAIL' CHECK (source IN ('EMAIL', 'PAGE', 'SCHEDULE'));

UPDATE ai_employee_profile
   SET manager_employee_id = 'aie_wren'
 WHERE ai_employee_id <> 'aie_wren';

INSERT INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, daily_at_utc, daily_at_tz, target_kind, target_id, capability_key,
   task_class, budget_usd, data_class, status, created_by, firm_scope, payload_json)
SELECT 'sjb_' || job_key, job_key, name, 'EMPLOYEE_TASK', 'DAILY_AT', '10:00', 'America/Chicago', 'EMPLOYEE', employee_id,
       'work_card.create', 'INTELLIGENCE', 0, 'INTERNAL', 'ACTIVE', 'system', 'west-peek', '{"session":"DAILY_WAKE"}'
  FROM (SELECT 'wren_daily_wake' AS job_key, 'Wren daily session' AS name, 'aie_wren' AS employee_id
        UNION ALL SELECT 'walker_daily_wake', 'Walker daily session', 'aie_walker') AS chiefs
 WHERE NOT EXISTS (SELECT 1 FROM scheduled_job AS existing WHERE existing.job_key = chiefs.job_key);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0315_chief_sessions');

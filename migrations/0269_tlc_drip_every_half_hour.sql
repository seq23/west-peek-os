-- THE LEARNING CLUB: THE DRIP EVERY HALF HOUR (owner, 24 Oct 2026: "get them going now today").
-- Before this the brand emails moved only on tlc_daily (13:30 UTC), and a club ready to sell waited for
-- the Monday batch. tlc_drip runs the drip every 30 minutes and opens the first batch for a club that has
-- no brand at all (services/learningClub.ts runDripPass). Every brand email still waits for her approval.
INSERT INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, interval_minutes, target_kind, target_id, capability_key,
   task_class, budget_usd, data_class, status, created_by, firm_scope)
SELECT 'sjb_tlc_drip', 'tlc_drip', 'The Learning Club: drip every half hour (Wynn)',
       'EMPLOYEE_TASK', 'INTERVAL', 30, 'EMPLOYEE', 'aie_wynn', 'work_card.create',
       'INTELLIGENCE', 0, 'INTERNAL', 'ACTIVE', 'system', 'west-peek'
WHERE NOT EXISTS (SELECT 1 FROM scheduled_job WHERE job_key = 'tlc_drip');

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0269_tlc_drip_every_half_hour');

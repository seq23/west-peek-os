-- 0287_preston_first_close_readiness.sql — Preston's weekly duty: Fund I first-close readiness.
--
-- 31 Oct 2026. Twelve employees had no work; the owner's first fund priority is the first close.
-- Preston (Finance & Fund Admin) owns the records a first close is measured from and had no card or
-- run in six weeks. Every Tuesday 14:00 UTC (before the Wednesday sync) the job reads the fund
-- records and opens the week's card on his desk (services/fundFirstClose.ts); the employee sweep
-- writes the note. ACTIVE on arrival: one cheap card a week, owner-approved idle-employee pass.
--
-- Seeded with INSERT … SELECT … WHERE NOT EXISTS, never INSERT OR IGNORE (tests/seededJobs.test.ts).

INSERT INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, daily_at_utc, day_of_week, target_kind, target_id, capability_key,
   task_class, budget_usd, data_class, status, created_by, firm_scope)
SELECT 'sjb_fund_first_close_readiness', 'fund_first_close_readiness', 'Fund I: first-close readiness, weekly (Preston)',
       'EMPLOYEE_TASK', 'WEEKLY', '14:00', 2, 'EMPLOYEE', 'aie_preston', 'work_card.create',
       'INTELLIGENCE', 1.00, 'INTERNAL', 'ACTIVE', 'system', 'west-peek'
WHERE NOT EXISTS (SELECT 1 FROM scheduled_job WHERE job_key = 'fund_first_close_readiness');

-- Pippa's machine (`marketing_pr_content`, retired in 0286) is seated on Wynn, who writes the firm's
-- outward words. 0004 is generated from the registry and never re-applies, so the live row is set here.
UPDATE ai_employee
   SET primary_machines_json = '["brand_sponsorship_revenue","marketing_pr_content"]'
 WHERE id = 'aie_wynn' AND primary_machines_json NOT LIKE '%marketing_pr_content%';

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0287_preston_first_close_readiness');

-- 0162 · Walker helps West Peek Productions — Scooter's own agency, not the fund (15 Sep 2026)
--
-- Operator: "Help him with west peek productions his agency… find customers for west peek
-- productions and find press opportunities to grow that business. westpeekproductions.com…
-- 'Community as a service' is big for them… his chief of staff should search for potential
-- customers who can benefit and send him an email 1x per month of potential customer ideas and…
-- pitch him to journalists to discuss what he is offering." And later: "press pitches should be
-- drafts for Scooter to send (include the journalist name and email for him to quickly copy paste
-- send)".
--
-- Two jobs on Walker's desk, each a personal-agency duty inside Scooter's office: they open ONE work
-- card a month for Walker, the employee sweep works it (a live search, a liveness check on every
-- URL, one email to scooter@westpeek.ventures only), and nothing ever leaves the system for a
-- prospect or a journalist. They fire daily and open the month's card only when it is not already
-- open, the same DAILY_AT-with-a-month-check shape as weekly_mp_review — schedule_kind has no
-- MONTHLY value and widening that CHECK would mean rebuilding scheduled_job.
--
-- ACTIVE from the start, on the operator's instruction that this runs monthly; the spend is one
-- search per card. Seeded the loud way (WHERE NOT EXISTS), never INSERT OR IGNORE.
INSERT INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, daily_at_utc, target_kind, target_id, capability_key,
   task_class, budget_usd, data_class, payload_json, status, created_by, firm_scope, next_run_at)
SELECT
  'sjb_productions_customer_ideas', 'productions_customer_ideas',
  'West Peek Productions: 10 customer ideas a month (Walker, for Scooter)',
  'EMPLOYEE_TASK', 'DAILY_AT', '14:00', 'EMPLOYEE', 'Walker', 'work_card.create',
  'INTELLIGENCE', 1.00, 'PUBLIC', '{"for":"scooter@westpeek.ventures","business":"West Peek Productions"}', 'ACTIVE',
  'system', 'west-peek', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (SELECT 1 FROM scheduled_job WHERE job_key = 'productions_customer_ideas');

INSERT INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, daily_at_utc, target_kind, target_id, capability_key,
   task_class, budget_usd, data_class, payload_json, status, created_by, firm_scope, next_run_at)
SELECT
  'sjb_productions_press_pitches', 'productions_press_pitches',
  'West Peek Productions: 5 press pitch drafts a month (Walker, for Scooter)',
  'EMPLOYEE_TASK', 'DAILY_AT', '14:10', 'EMPLOYEE', 'Walker', 'work_card.create',
  'INTELLIGENCE', 1.00, 'PUBLIC', '{"for":"scooter@westpeek.ventures","business":"West Peek Productions"}', 'ACTIVE',
  'system', 'west-peek', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (SELECT 1 FROM scheduled_job WHERE job_key = 'productions_press_pitches');

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0162_walker_helps_west_peek_productions');

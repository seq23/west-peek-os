-- 0211 — The brief is on demand, on Sonnet, any day; the button is a request the clock serves.
--
-- WHAT PRODUCTION SHOWED, 19 Sep 2026 (a Saturday), CONFIRMED from the rows themselves:
--
--   · No `intelligence_report` row existed for either partner between 06:15 and 09:29 ET. All
--     twelve scheduled ticks in that window read sources ("SUCCEEDED: 0 item(s) kept, 10
--     duplicate…"). The schedule's own gate (`weekends = 0` on both profiles — a column default,
--     never chosen) skipped Saturday, and the partner woke up to nothing.
--
--   · At 13:29:30Z she pressed the button. Her request gathered and read the market in six
--     seconds, then opened the write stage's model call INSIDE the HTTP request on a free lane
--     (`deepseek/deepseek-v4-flash-0731:free`). That `ai_run` was still RUNNING fifteen minutes
--     later with the row at GENERATING under a ten-minute lease: the request had ended and no code
--     of ours ran to close either. Her second press met its own dead lease ("Another run holds it").
--
--   · The day before, both briefs FAILED "incomplete" three times each — twelve model calls, every
--     one to `@cf/ibm-granite/granite-4.0-h-micro` under the free-first ladder, every one 256
--     output tokens. Sonnet, which wrote 38 of 38 accepted briefs between 20 Aug and 17 Sep, was
--     never reached because a truncated reply is a "success" to the chain.
--
-- THE OWNER'S DECISION, verbatim: "fix why the free tiers are failing! … Make the briefs on demand
-- and make them use Sonnet — that is the new solution. On demand + Sonnet for briefs only. On
-- demand any day of the week!"
--
-- ── 1 · THE SCHEDULED BRIEF IS RETIRED — recorded the way 0198 retired the weekly review ─────────
--
-- The morning schedule never had a `scheduled_job` row of its own: it rode inside the sweep job's
-- tick (`daily_intelligence`, INTERVAL 15), gated by each profile's `earliest_start_local` and
-- `weekends`. Its retirement is written here as a RETIRED row so that the Jobs page says so, the
-- `/run` and `/status` routes answer 409 `retired`, and no later seed can open a job of this key
-- as ACTIVE (`WHERE NOT EXISTS` finds this row). The code path that started a brief on the clock
-- (`runDailyForAll`, the owed-brief gate) is gone from `dailyIntelligence.ts`; the tick now only
-- ADVANCES a brief a person asked for. The profile's `weekends` and `earliest_start_local` columns
-- no longer bear on a brief at all — a request is served on any day at any hour — and are left as
-- they are because rows exist and nothing is served by rewriting history.
INSERT INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, target_kind, task_class, budget_usd, data_class, status,
   pause_reason, next_run_at, created_by, firm_scope)
SELECT
  'sjb_morning_brief_schedule', 'morning_brief_schedule', 'The morning brief on a schedule',
  'INTELLIGENCE', 'ON_REQUEST', 'SYSTEM', 'DERIVATION', 0, 'INTERNAL', 'RETIRED',
  'Retired 19 Sep 2026 on the owner''s decision ("Make the briefs on demand … On demand + Sonnet for briefs only. On demand any day of the week!"). The brief is built when a partner presses Build on Home, on claude-sonnet-5, any day; nothing starts one on the clock. Every brief already written is kept.',
  NULL, 'system', 'west-peek'
WHERE NOT EXISTS (SELECT 1 FROM scheduled_job WHERE job_key = 'morning_brief_schedule');

-- ── 2 · THE ROW CARRIES THE REQUEST AND THE RETRY, so no state is inferred from silence ─────────
--
-- `requested_at` / `requested_by`: the button no longer runs a model call inside an HTTP request;
-- it writes these two columns and (re)opens the row, and the clock — which fires every minute and
-- has fifteen minutes of wall time — does the work on its next tick. Home reads the row every few
-- seconds while it moves and shows the named stage, the elapsed time and the measured usual
-- duration. A second press while a row is moving changes nothing and says so ("already building —
-- started 1m 20s ago"), from the row, not from a guess. Only rows with `requested_at` are ever
-- advanced: there is no other way a brief starts now.
--
-- `retry_after`: written by every path that closes a row FAILED with attempts left, so the card
-- can say "retrying at 07:05" as a fact rather than "it will retry". Twenty minutes: long enough
-- for a provider blip to clear, short enough that three attempts for one press fit in an hour.
ALTER TABLE intelligence_report ADD COLUMN requested_at TEXT;
ALTER TABLE intelligence_report ADD COLUMN requested_by TEXT;
ALTER TABLE intelligence_report ADD COLUMN retry_after TEXT;

-- ── 3 · THE SWEEP JOB SAYS WHAT IT DOES ─────────────────────────────────────────────────────────
--
-- `daily_intelligence` never builds a brief again; it reads sources. Its name said "brief" and its
-- runs said "10 duplicate" — two components each keeping their own story.
UPDATE scheduled_job SET name = 'Reading the intelligence sources' WHERE job_key = 'daily_intelligence';

-- A migration that reported success while changing nothing is a defect this repo has shipped twice
-- (0193). The guard is on the three columns and the retired row, which must exist afterwards on
-- every database this reaches.
CREATE TABLE migration_guard_0211 (matched INTEGER NOT NULL CHECK (matched = 4));
INSERT INTO migration_guard_0211 (matched)
SELECT (SELECT COUNT(*) FROM pragma_table_info('intelligence_report') WHERE name IN ('requested_at', 'requested_by', 'retry_after'))
     + (SELECT COUNT(*) FROM scheduled_job WHERE job_key = 'morning_brief_schedule' AND status = 'RETIRED');
DROP TABLE migration_guard_0211;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0211_the_brief_is_on_demand_on_sonnet');

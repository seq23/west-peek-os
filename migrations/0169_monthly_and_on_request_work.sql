-- 0169 · Scheduled work: MONTHLY and ON_REQUEST are real schedule kinds (15 Sep 2026)
--
-- WHAT WAS WRONG. `schedule_kind` allowed only INTERVAL and DAILY_AT, so every monthly duty was a
-- DAILY_AT job that fired every day and opened nothing 29 days out of 30 (the card is month-unique
-- by title), while the Work page said "Every day at 14:00 UTC". `deck_rebuild` was DAILY_AT with
-- the page hard-coded to display "On request". A one-off introduction and two folded duties sat
-- PAUSED on the page as if somebody might switch them back on.
--
-- SQLite cannot widen a CHECK in place, so `scheduled_job` is rebuilt. `job_run` holds a foreign
-- key into it; 0043 recorded that `PRAGMA foreign_keys=OFF` is a no-op inside D1's migration
-- transaction. `defer_foreign_keys` is the pragma that DOES work inside a transaction — with one
-- subtlety that decides the ORDER below. SQLite keeps a COUNTER of deferred violations: the
-- implicit DELETE behind DROP TABLE adds one per orphaned run, and only an INSERT into the PARENT
-- the child references by name subtracts them. A RENAME never touches the counter, so the usual
-- create-copy-drop-rename dance fails at COMMIT even though the data is fine. So: copy the rows
-- aside, DROP, CREATE the new table under the SAME name, INSERT the rows back (each one re-parents
-- its runs and the counter returns to zero), drop the copy. Proven in tests/monthlyWork.test.ts by
-- replaying this over a database that has runs.
PRAGMA defer_foreign_keys = TRUE;

CREATE TABLE scheduled_job_copy AS SELECT * FROM scheduled_job;
DROP TABLE scheduled_job;

CREATE TABLE scheduled_job (
  id                TEXT PRIMARY KEY,
  job_key           TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL
                    CHECK (kind IN ('INTELLIGENCE','PORTFOLIO_EVALUATION','EMPLOYEE_TASK')),
  -- INTERVAL: every N minutes. DAILY_AT: once a day at an hour/minute in UTC. MONTHLY: once a
  -- month on day_of_month at daily_at_utc. ON_REQUEST: no timer; runs only when a person or a
  -- card asks (the deck rebuild).
  schedule_kind     TEXT NOT NULL CHECK (schedule_kind IN ('INTERVAL','DAILY_AT','MONTHLY','ON_REQUEST')),
  interval_minutes  INTEGER,
  daily_at_utc      TEXT,
  day_of_month      INTEGER CHECK (day_of_month IS NULL OR (day_of_month BETWEEN 1 AND 28)),
  target_kind       TEXT NOT NULL CHECK (target_kind IN ('SYSTEM','MACHINE','EMPLOYEE')),
  target_id         TEXT,
  capability_key    TEXT,
  task_class        TEXT,
  budget_usd        REAL NOT NULL DEFAULT 0,
  data_class        TEXT NOT NULL DEFAULT 'INTERNAL',
  payload_json      TEXT NOT NULL DEFAULT '{}',
  max_attempts      INTEGER NOT NULL DEFAULT 3,
  -- RETIRED: a job that will never run again and is kept only so its runs and cards still
  -- resolve. Hidden from the Work page; never due.
  status            TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','RETIRED')),
  next_run_at       TEXT,
  last_run_at       TEXT,
  pause_reason      TEXT,
  created_by        TEXT NOT NULL,
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (schedule_kind <> 'INTERVAL' OR interval_minutes IS NOT NULL),
  CHECK (schedule_kind <> 'DAILY_AT' OR daily_at_utc IS NOT NULL),
  CHECK (schedule_kind <> 'MONTHLY' OR (day_of_month IS NOT NULL AND daily_at_utc IS NOT NULL)),
  CHECK (schedule_kind <> 'ON_REQUEST' OR next_run_at IS NULL),
  CHECK (target_kind = 'SYSTEM' OR target_id IS NOT NULL)
);

INSERT INTO scheduled_job (
  id, job_key, name, kind, schedule_kind, interval_minutes, daily_at_utc, target_kind, target_id,
  capability_key, task_class, budget_usd, data_class, payload_json, max_attempts, status,
  next_run_at, last_run_at, pause_reason, created_by, firm_scope, created_at
)
SELECT
  id, job_key, name, kind, schedule_kind, interval_minutes, daily_at_utc, target_kind, target_id,
  capability_key, task_class, budget_usd, data_class, payload_json, max_attempts, status,
  next_run_at, last_run_at, pause_reason, created_by, firm_scope, created_at
FROM scheduled_job_copy;

DROP TABLE scheduled_job_copy;
CREATE INDEX IF NOT EXISTS idx_scheduled_job_due ON scheduled_job (status, next_run_at);

-- Walker's Productions note: on the 1st of every month at 14:00 UTC, and due on the next 1st.
-- (This is the one DAILY_AT clock that is moved, and it is moved because the job is no longer
-- DAILY_AT. Every other job's next_run_at is left exactly where the scheduler put it.)
UPDATE scheduled_job
   SET schedule_kind = 'MONTHLY',
       day_of_month = 1,
       daily_at_utc = '14:00',
       next_run_at = CASE
         WHEN strftime('%Y-%m-01T14:00:00.000Z','now') > strftime('%Y-%m-%dT%H:%M:%fZ','now')
           THEN strftime('%Y-%m-01T14:00:00.000Z','now')
         ELSE strftime('%Y-%m-01T14:00:00.000Z','now','start of month','+1 month')
       END
 WHERE job_key = 'productions_monthly';

-- The deck is rebuilt when somebody asks, not on a clock. It was seeded PAUSED to keep it off the
-- timer; ON_REQUEST has no timer, so "paused" would only mean "may not be asked" — it is ACTIVE.
UPDATE scheduled_job
   SET schedule_kind = 'ON_REQUEST', daily_at_utc = NULL, interval_minutes = NULL, next_run_at = NULL,
       status = 'ACTIVE', pause_reason = NULL
 WHERE job_key = 'deck_rebuild';

-- Retired, not deleted: their runs and cards stay readable. The introduction was sent once; the
-- two duties were folded into productions_monthly on 15 Sep 2026.
UPDATE scheduled_job
   SET status = 'RETIRED',
       next_run_at = NULL,
       pause_reason = COALESCE(pause_reason, '') || ' Retired 15 Sep 2026.'
 WHERE job_key IN ('productions_intro_note', 'productions_customer_ideas', 'productions_press_pitches');

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0169_monthly_and_on_request_work');

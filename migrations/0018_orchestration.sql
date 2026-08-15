-- 0018_orchestration.sql — P19 Governed orchestration + scheduled AI employees
-- (task §9 P19; GAP-21, GAP-22).
--
-- Architecture (ADR-017): D1 for durable job/run state, ONE Cloudflare Cron Trigger for the
-- clock, and a manual run route so the whole path is provable offline. No Queues and no Durable
-- Objects: the real workload is a handful of coarse-grained recurring jobs with durable history,
-- and D1 already provides the durability. Adding a distributed queue would add failure modes the
-- workload does not justify (AGENTS.md: do not add Cloudflare products without a real requirement).
--
-- Laws encoded here:
-- - A job targeting an AI employee cannot run unless that employee is ACTIVE (D10). "Employee
--   exists" is not "employee runs on a schedule".
-- - A job targeting a PAUSED machine cannot run.
-- - Every run carries an idempotency key that is UNIQUE, so the same scheduled window can never
--   execute twice however often the trigger fires.
-- - Failures retry up to the job's own limit, then land in DEAD_LETTER — visible, not silent.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0018_orchestration');

-- ── Action vocabulary additions (P19) ──

INSERT OR IGNORE INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('scheduled_job.create', 'Create a scheduled job', 'Define a recurring governed job with its schedule, target, budget, and data policy.', 0, 0),
  ('scheduled_job.pause', 'Pause or resume a scheduled job', 'Stop or restart a recurring job.', 0, 0),
  ('job_run.execute', 'Run a scheduled job', 'Execute one occurrence of a scheduled job (scheduled trigger or manual operator run).', 0, 0),
  ('job_run.cancel', 'Cancel a job run', 'Cancel a queued or running job occurrence.', 0, 0);

CREATE TABLE IF NOT EXISTS scheduled_job (
  id                TEXT PRIMARY KEY,
  job_key           TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL
                    CHECK (kind IN ('INTELLIGENCE','PORTFOLIO_EVALUATION','EMPLOYEE_TASK')),
  -- INTERVAL: every N minutes. DAILY_AT: once a day at an hour/minute in UTC.
  schedule_kind     TEXT NOT NULL CHECK (schedule_kind IN ('INTERVAL','DAILY_AT')),
  interval_minutes  INTEGER,
  daily_at_utc      TEXT,
  target_kind       TEXT NOT NULL CHECK (target_kind IN ('SYSTEM','MACHINE','EMPLOYEE')),
  target_id         TEXT,
  capability_key    TEXT,
  task_class        TEXT,
  budget_usd        REAL NOT NULL DEFAULT 0,
  data_class        TEXT NOT NULL DEFAULT 'INTERNAL',
  payload_json      TEXT NOT NULL DEFAULT '{}',
  max_attempts      INTEGER NOT NULL DEFAULT 3,
  status            TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED')),
  next_run_at       TEXT,
  last_run_at       TEXT,
  pause_reason      TEXT,
  created_by        TEXT NOT NULL,
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (schedule_kind <> 'INTERVAL' OR interval_minutes IS NOT NULL),
  CHECK (schedule_kind <> 'DAILY_AT' OR daily_at_utc IS NOT NULL),
  CHECK (target_kind = 'SYSTEM' OR target_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_scheduled_job_due ON scheduled_job (status, next_run_at);

CREATE TABLE IF NOT EXISTS job_run (
  id               TEXT PRIMARY KEY,
  job_id           TEXT NOT NULL REFERENCES scheduled_job (id),
  idempotency_key  TEXT NOT NULL UNIQUE,
  trigger_kind     TEXT NOT NULL CHECK (trigger_kind IN ('SCHEDULED','MANUAL')),
  status           TEXT NOT NULL
                   CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','DEAD_LETTER','CANCELLED','REFUSED')),
  attempt          INTEGER NOT NULL DEFAULT 1,
  started_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at      TEXT,
  error            TEXT,
  outcome_summary  TEXT NOT NULL DEFAULT '',
  ai_run_id        TEXT REFERENCES ai_run (id),
  requested_by     TEXT NOT NULL,
  firm_scope       TEXT NOT NULL DEFAULT 'west-peek',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_job_run_job ON job_run (job_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_run_status ON job_run (status, started_at DESC);

CREATE TABLE IF NOT EXISTS job_run_artifact (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES job_run (id),
  kind       TEXT NOT NULL,
  ref_type   TEXT,
  ref_id     TEXT,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_job_run_artifact ON job_run_artifact (run_id);

CREATE TRIGGER IF NOT EXISTS job_run_artifact_reject_update
BEFORE UPDATE ON job_run_artifact
BEGIN
  SELECT RAISE(ABORT, 'job_run_artifact is append-only: UPDATE rejected (D15)');
END;

-- One seeded job so the surface is real on first load: the Daily Intelligence engine, which
-- runs entirely offline against MANUAL and INTERNAL sources. It starts PAUSED — a recurring job
-- that begins running on its own the moment a migration is applied would be exactly the kind of
-- silent activation this system forbids.
INSERT OR IGNORE INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, daily_at_utc, target_kind, target_id, task_class, budget_usd, data_class, status, pause_reason, created_by)
VALUES
  ('sjob_daily_intelligence', 'daily_intelligence', 'Daily Intelligence brief', 'INTELLIGENCE', 'DAILY_AT', '06:00',
   'SYSTEM', NULL, 'intelligence-synthesis', 1.0, 'INTERNAL', 'PAUSED',
   'Seeded paused: an operator must switch recurring work on deliberately.', 'system');

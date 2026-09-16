-- 0172 · WEEKLY is a real schedule kind; Walker's weekly hire search for West Peek Productions (16 Sep 2026)
--
-- Operator: West Peek Productions wants to hire a senior experiential producer, freelance, to bring
-- in more brand deals. Every week Walker searches live public sources for candidates, checks every
-- profile URL, judges each against the written archetype, and emails Scooter ONE note. The OS never
-- contacts a candidate. Candidates are remembered across weeks so a note never repeats one Scooter
-- has already contacted or passed on.
--
-- THREE THINGS HERE, IN ORDER:
--   1. `scheduled_job` learns WEEKLY (day_of_week 0–6, Sunday = 0, at daily_at_utc). Not an INTERVAL
--      of 10080 minutes: an interval drifts with every manual run and has no idea what "Monday" is,
--      and the occurrence key for a week must be the ISO week so two ticks in one week are one run.
--      SQLite cannot widen a CHECK in place, so the table is rebuilt the 0169 way (copy aside, DROP,
--      CREATE under the same name, INSERT back, drop the copy — `defer_foreign_keys` is what lets
--      job_run's foreign key survive the DROP inside D1's transaction).
--   2. `productions_candidate` — one row per profile URL, first_seen / last_seen / the week it was
--      last reported, and a status Scooter sets from Home: NEW, SEEN (reported more than once),
--      CONTACTED, PASSED. A CONTACTED or PASSED candidate never appears in a note again.
--   3. `deliverable` learns the kind `productions_hire_search`, rebuilt the 0170 way.
PRAGMA defer_foreign_keys = TRUE;

-- ── 1 · scheduled_job: WEEKLY ────────────────────────────────────────────────────────────────
CREATE TABLE scheduled_job_copy AS SELECT * FROM scheduled_job;
DROP TABLE scheduled_job;

CREATE TABLE scheduled_job (
  id                TEXT PRIMARY KEY,
  job_key           TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL
                    CHECK (kind IN ('INTELLIGENCE','PORTFOLIO_EVALUATION','EMPLOYEE_TASK')),
  -- INTERVAL: every N minutes. DAILY_AT: once a day at an hour/minute in UTC. WEEKLY: once a week
  -- on day_of_week (0 = Sunday … 6 = Saturday) at daily_at_utc. MONTHLY: once a month on
  -- day_of_month at daily_at_utc. ON_REQUEST: no timer; runs only when a person or a card asks.
  schedule_kind     TEXT NOT NULL CHECK (schedule_kind IN ('INTERVAL','DAILY_AT','WEEKLY','MONTHLY','ON_REQUEST')),
  interval_minutes  INTEGER,
  daily_at_utc      TEXT,
  day_of_week       INTEGER CHECK (day_of_week IS NULL OR (day_of_week BETWEEN 0 AND 6)),
  day_of_month      INTEGER CHECK (day_of_month IS NULL OR (day_of_month BETWEEN 1 AND 28)),
  target_kind       TEXT NOT NULL CHECK (target_kind IN ('SYSTEM','MACHINE','EMPLOYEE')),
  target_id         TEXT,
  capability_key    TEXT,
  task_class        TEXT,
  budget_usd        REAL NOT NULL DEFAULT 0,
  data_class        TEXT NOT NULL DEFAULT 'INTERNAL',
  payload_json      TEXT NOT NULL DEFAULT '{}',
  max_attempts      INTEGER NOT NULL DEFAULT 3,
  status            TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','RETIRED')),
  next_run_at       TEXT,
  last_run_at       TEXT,
  pause_reason      TEXT,
  created_by        TEXT NOT NULL,
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (schedule_kind <> 'INTERVAL' OR interval_minutes IS NOT NULL),
  CHECK (schedule_kind <> 'DAILY_AT' OR daily_at_utc IS NOT NULL),
  CHECK (schedule_kind <> 'WEEKLY' OR (day_of_week IS NOT NULL AND daily_at_utc IS NOT NULL)),
  CHECK (schedule_kind <> 'MONTHLY' OR (day_of_month IS NOT NULL AND daily_at_utc IS NOT NULL)),
  CHECK (schedule_kind <> 'ON_REQUEST' OR next_run_at IS NULL),
  CHECK (target_kind = 'SYSTEM' OR target_id IS NOT NULL)
);

INSERT INTO scheduled_job (
  id, job_key, name, kind, schedule_kind, interval_minutes, daily_at_utc, day_of_month, target_kind, target_id,
  capability_key, task_class, budget_usd, data_class, payload_json, max_attempts, status,
  next_run_at, last_run_at, pause_reason, created_by, firm_scope, created_at
)
SELECT
  id, job_key, name, kind, schedule_kind, interval_minutes, daily_at_utc, day_of_month, target_kind, target_id,
  capability_key, task_class, budget_usd, data_class, payload_json, max_attempts, status,
  next_run_at, last_run_at, pause_reason, created_by, firm_scope, created_at
FROM scheduled_job_copy;

DROP TABLE scheduled_job_copy;
CREATE INDEX IF NOT EXISTS idx_scheduled_job_due ON scheduled_job (status, next_run_at);

-- Walker's weekly hire search: every Monday at 14:00 UTC, due on the next Monday (today, if it is a
-- Monday and 14:00 has not passed). `'weekday 1'` moves a date forward to the next Monday and leaves
-- a Monday where it is, hence the CASE. ACTIVE from the start on the operator's instruction; the
-- spend is one search and one judgement per week. Seeded the loud way (WHERE NOT EXISTS).
INSERT INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, daily_at_utc, day_of_week, target_kind, target_id, capability_key,
   task_class, budget_usd, data_class, payload_json, status, created_by, firm_scope, next_run_at)
SELECT
  'sjb_productions_hire_search', 'productions_hire_search',
  'West Peek Productions: the weekly hire search (Walker, for Scooter)',
  'EMPLOYEE_TASK', 'WEEKLY', '14:00', 1, 'EMPLOYEE', 'aie_walker', 'work_card.create',
  'INTELLIGENCE', 1.50, 'PUBLIC',
  '{"for":"scooter@westpeek.ventures","business":"West Peek Productions","role":"senior experiential producer, freelance"}',
  'ACTIVE', 'system', 'west-peek',
  CASE
    WHEN strftime('%Y-%m-%dT14:00:00.000Z', 'now', 'weekday 1') > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      THEN strftime('%Y-%m-%dT14:00:00.000Z', 'now', 'weekday 1')
    ELSE strftime('%Y-%m-%dT14:00:00.000Z', 'now', 'weekday 1', '+7 days')
  END
WHERE NOT EXISTS (SELECT 1 FROM scheduled_job WHERE job_key = 'productions_hire_search');

-- An employee REFERENCE is their id (0087); the earlier Productions rows were seeded with the
-- byline. `validate:value-shapes` flagged it against production. The scheduler resolves either
-- form, so this changes nothing it does — only what the column says it holds.
UPDATE scheduled_job SET target_id = 'aie_walker' WHERE target_kind = 'EMPLOYEE' AND target_id = 'Walker';

-- ── 2 · the candidates Walker has already shown Scooter ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS productions_candidate (
  id                TEXT PRIMARY KEY,
  -- The profile URL is the identity: the same person found again is the same row.
  url               TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  title             TEXT NOT NULL DEFAULT '',
  company           TEXT NOT NULL DEFAULT '',
  city              TEXT NOT NULL DEFAULT '',
  -- The page that supports the fit, when it is not the profile itself (a team page, a speaker
  -- listing, a portfolio, an award list).
  evidence_url      TEXT,
  why               TEXT NOT NULL DEFAULT '',
  opening_line      TEXT NOT NULL DEFAULT '',
  fit_score         INTEGER NOT NULL DEFAULT 0 CHECK (fit_score BETWEEN 0 AND 10),
  first_seen        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- The ISO week (YYYY-Www) of the note this candidate was last reported in, and that card.
  week              TEXT NOT NULL,
  last_card_id      TEXT,
  status            TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','SEEN','CONTACTED','PASSED')),
  status_changed_at TEXT,
  status_changed_by TEXT,
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek'
);
CREATE INDEX IF NOT EXISTS idx_productions_candidate_week ON productions_candidate (firm_scope, week, status);
CREATE INDEX IF NOT EXISTS idx_productions_candidate_card ON productions_candidate (last_card_id);

-- ── 3 · deliverable: the kind `productions_hire_search` ──────────────────────────────────────
CREATE TABLE deliverable_copy AS SELECT * FROM deliverable;
DROP TABLE deliverable;

CREATE TABLE deliverable (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL
                CHECK (kind IN ('daily_brief','weekly_review','research_packet','ask_brief','meeting_prep','discrepancy_list','blog_help','productions_hire_search')),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  prepared_by   TEXT NOT NULL,
  prepared_for  TEXT NOT NULL REFERENCES firm_user (id),
  source_type   TEXT,
  source_id     TEXT,
  document_id   TEXT REFERENCES document (id),
  privacy_label TEXT NOT NULL DEFAULT 'INTERNAL',
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  acknowledged_at TEXT,
  acknowledged_by TEXT REFERENCES firm_user (id),
  dismissed_at    TEXT,
  dismissed_by    TEXT REFERENCES firm_user (id),
  restored_at     TEXT
);

INSERT INTO deliverable (
  id, kind, title, body, prepared_by, prepared_for, source_type, source_id, document_id,
  privacy_label, firm_scope, created_at, acknowledged_at, acknowledged_by, dismissed_at, dismissed_by, restored_at
)
SELECT
  id, kind, title, body, prepared_by, prepared_for, source_type, source_id, document_id,
  privacy_label, firm_scope, created_at, acknowledged_at, acknowledged_by, dismissed_at, dismissed_by, restored_at
FROM deliverable_copy;

DROP TABLE deliverable_copy;

CREATE UNIQUE INDEX IF NOT EXISTS idx_deliverable_source
  ON deliverable (source_type, source_id)
  WHERE source_type IS NOT NULL AND source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deliverable_for ON deliverable (prepared_for, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliverable_kind ON deliverable (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliverable_open ON deliverable (firm_scope, dismissed_at, created_at DESC);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0172_weekly_hire_search');

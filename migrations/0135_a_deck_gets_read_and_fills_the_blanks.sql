-- A deck arrives, an employee reads it, and the company record fills in.
--
-- Operator, 22 Aug 2026: "the whole point is if we snd a deck the employee extracts all relevant
-- info and fills in gaps in the deal flow tab's company card. if its a new company they create a new
-- one. if existing they update it."
--
-- WHAT WAS MISSING WAS THE MIDDLE. `deckReader.ts` could read a PDF and had been able to since it
-- shipped; `#wpdeck` routed mail meaning "the substance is in the attachment"; and nothing extracted
-- an attachment or handed one over. Wyatt's own prompt told him to read a deck he was never given.
--
-- WHY A QUEUE RATHER THAN READING IT ON ARRIVAL. Reading a deck is a model call and the email
-- handler has 10ms of CPU — the same constraint that made a 7MB message unparseable. So the bytes
-- are stored on arrival, which is I/O and nearly free, and a job reads them with its own budget.
-- Store now, read later.
--
-- ONLY THE BLANKS, which is `deckReader`'s own rule and is preserved here rather than restated: a
-- deck is NEWER, not more authoritative, and a PDF quietly replacing something a partner typed is
-- the worst possible version of helpful. `applied_json` records what was filled and what was kept,
-- so the choice is auditable rather than assumed.
CREATE TABLE IF NOT EXISTS pending_deck (
  id            TEXT PRIMARY KEY,
  -- NULLABLE, and that is the point. An emailed deck for a company nobody has opened yet has no
  -- company to belong to: the EMAIL route deliberately does not write the pipeline — it raises a
  -- card for the analyst, who decides. Requiring a company here meant the bytes were discarded for
  -- exactly the case the operator described ("if its a new company they create a new one"), while
  -- the card raised in the same breath told the analyst to read a deck that had been thrown away.
  -- The deck is kept against the card until a company exists; the reader fills a record once there
  -- is one to fill.
  company_id    TEXT REFERENCES canonical_company (id),
  work_card_id  TEXT REFERENCES work_card (id),
  filename      TEXT NOT NULL,
  -- The R2 key. Bytes never live in D1: a 12MB base64 blob in a row is a row nothing can read.
  object_key    TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  state         TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','READ','FAILED')),
  -- Why it could not be read, when it could not. Never blank on FAILED.
  detail        TEXT,
  applied_json  TEXT,
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  read_at       TEXT,
  CHECK (state <> 'FAILED' OR IFNULL(length(trim(detail)), 0) > 0)
);

CREATE INDEX IF NOT EXISTS idx_pending_deck_state ON pending_deck (state, created_at);

-- Runs every fifteen minutes, like the other cheap jobs. A deck that arrived overnight is on the
-- record by the time the partners read the morning brief.
--
-- WHERE NOT EXISTS rather than INSERT OR IGNORE: this repo has twice shipped a migration that
-- reported success while silently dropping the row it existed to add.
INSERT INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, interval_minutes, target_kind, target_id,
   budget_usd, data_class, status, created_by)
SELECT
  'sjob_deck_reading', 'deck_reading', 'Reading decks that arrived', 'EMPLOYEE_TASK',
  'INTERVAL', 15,
  'SYSTEM', NULL,
  -- Reading a deck IS a model call, so unlike the diagnostics sweep this one has a budget and is
  -- allowed to be stopped by a spend ceiling.
  0.50, 'INTERNAL', 'ACTIVE', 'system'
WHERE NOT EXISTS (SELECT 1 FROM scheduled_job WHERE job_key = 'deck_reading');

-- OR IGNORE here and NOWHERE else in this file: the version marker is the one row where a re-apply
-- is genuinely a no-op rather than a swallowed failure.
INSERT OR IGNORE INTO schema_version (migration) VALUES ('0135_a_deck_gets_read_and_fills_the_blanks');

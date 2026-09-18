-- 0193 — The deck lane checks once a day, on her clock, and its health check stops crying wolf.
--
-- Operator, 18 Sep 2026, looking at her live Home:
--   "decks arriving is not broken. we just dont get decks every day. he should not check every 15
--    min. he should check once per day at some point in the day ----maybe like after 11am"
--
-- WHAT SHE WAS LOOKING AT. Home rendered "Decks arriving · Needs a look · nothing has arrived for
-- 25 days · last on 2026-08-23" — an amber light over a business where decks arrive a few times a
-- month, sitting next to a check that was genuinely failing. A board that calls a normal quiet
-- fortnight a fault teaches its reader to skim past the fault that is real. The health half of this
-- lives in `src/worker/services/health.ts`; this file is the cadence half.
--
-- NINETY-SIX CHECKS A DAY FOR SOMETHING THAT HAPPENS TWICE A MONTH. In the seven days to 9 Sep the
-- job succeeded 310 times and every one of them reported "no decks waiting". Two decks have ever
-- been enqueued. That is the runaway shape this portfolio already paid for once.
--
-- ── 1 · A JOB CAN NOW BE PINNED TO A REAL CLOCK, NOT A UTC ONE ───────────────────────────────────
--
-- Her 11am is 16:00Z under CDT and 17:00Z under CST. A job written as `daily_at_utc = '16:00'` reads
-- as 11:00 for her today and as 10:00 for her from 1 November — before 11am, which is the one thing
-- her sentence asked for. Raising it to '17:00' instead is right in winter and noon in summer. Both
-- are a guess dressed as a schedule, and both drift on a date nobody will be watching.
--
-- So the zone is stored. `daily_at_tz` NULL keeps the old meaning exactly — the hour is UTC — and
-- every job written before today is untouched and recomputes identically. Where it is set,
-- `computeNextRun` reads `daily_at_utc` as a wall clock in that zone and takes the offset from the
-- platform's own timezone database at the instant in question, so the clocks changing is not an
-- event this scheduler has to know about. `src/shared/time/zonedClock.ts` is the conversion and
-- `npm run validate:deck-cadence` is what stops the column being quietly dropped again.
--
-- ADD COLUMN, NOT A TABLE REBUILD. 0169 and 0172 rebuilt `scheduled_job` because they changed a
-- CHECK; a nullable column needs none of that, and a rebuild here would have to re-create the
-- foreign keys every other table points at it with.
ALTER TABLE scheduled_job ADD COLUMN daily_at_tz TEXT;

-- ── 2 · THE DECK LANE MOVES TO ONCE A DAY AT 11:15 HER TIME ──────────────────────────────────────
--
-- 11:15 rather than 11:00: "after 11am" in her words, and a quarter past the hour keeps it off the
-- minute every other cron in this account fires on. It exists on every day of the year in Chicago —
-- the DST transitions are at 02:00 local, so there is no spring-forward hour for it to fall into.
--
-- next_run_at IS SET TO NULL DELIBERATELY. A literal instant baked in here is correct on the day it
-- is written and stale for ever after, and this migration may not reach production for days. NULL
-- reads as due on the first tick after deploy: the lane runs once, `computeNextRun` then writes the
-- real zone-aware instant, and it is on her clock from that moment. One extra run, no rotting
-- literal. (The due query excludes ON_REQUEST precisely because NULL means due; DAILY_AT is in.)
UPDATE scheduled_job
   SET schedule_kind    = 'DAILY_AT',
       interval_minutes = NULL,
       daily_at_utc     = '11:15',
       daily_at_tz      = 'America/Chicago',
       next_run_at      = NULL,
       name             = 'Reading decks that arrived'
 WHERE job_key = 'deck_reading';

-- A migration that reported success while changing nothing is a defect this repo has shipped twice.
-- The lane is named in `RARE_LANES` in `scripts/validate/a-rare-lane-is-checked-daily.mjs`, which
-- replays every migration in order and fails if this row ever goes back under a day.
-- The guard is a CHECK rather than a RAISE: RAISE() is legal only inside a trigger body, and a bare
-- SELECT that finds nothing still exits 0. Writing the count into a column that only accepts 1 makes
-- "the UPDATE matched no row" an error the migration runner reports instead of a silent success.
CREATE TABLE migration_guard_0193 (matched INTEGER NOT NULL CHECK (matched = 1));
INSERT INTO migration_guard_0193 (matched)
SELECT COUNT(*) FROM scheduled_job
 WHERE job_key = 'deck_reading'
   AND schedule_kind = 'DAILY_AT'
   AND daily_at_utc = '11:15'
   AND daily_at_tz = 'America/Chicago'
   AND interval_minutes IS NULL;
DROP TABLE migration_guard_0193;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0193_decks_are_read_once_a_day_on_her_clock');

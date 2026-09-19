-- 0211 — The brief arrives every morning, and the button is a request the clock serves.
--
-- WHAT PRODUCTION SHOWED, 19 Sep 2026 (a Saturday), CONFIRMED from the rows themselves:
--
--   · No `intelligence_report` row existed for either partner between 06:15 and 09:29 ET. All
--     twelve scheduled ticks in that window read sources ("SUCCEEDED: 0 item(s) kept, 10
--     duplicate…"). `briefsOwedToday` returned false because both `partner_intelligence_profile`
--     rows carried `weekends = 0` — the column's default, never chosen — and the day was Saturday.
--     The schedule behaved exactly as configured, and the partner woke up to nothing.
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
-- ── 1 · A BRIEF IS BUILT EVERY DAY OF THE WEEK ──────────────────────────────────────────────────
--
-- The owner's instruction that morning is the evidence: a brief was expected on a Saturday. The
-- weekday-only default was chosen by a schema in August and never by a person. Both partners'
-- profiles are turned on; the code default (`COALESCE(p.weekends, …)`) moves to 1 with it so a
-- partner with no profile row gets the same rule. The setting stays a per-partner column.
UPDATE partner_intelligence_profile SET weekends = 1 WHERE weekends = 0;

-- ── 2 · THE ROW CARRIES THE REQUEST AND THE RETRY, so no state is inferred from silence ─────────
--
-- `requested_at` / `requested_by`: the button no longer runs a model call inside an HTTP request;
-- it writes these two columns and (re)opens the row, and the clock — which fires every minute and
-- has fifteen minutes of wall time — does the work on its next tick. Home reads the row every few
-- seconds while it moves and shows the named stage, the elapsed time and the measured usual
-- duration. A second press while a row is moving changes nothing and says so ("already building —
-- started 1m 20s ago"), from the row, not from a guess.
--
-- `retry_after`: written by every path that closes a row FAILED with attempts left, so the card
-- can say "retrying at 07:05" as a fact rather than "it will retry". Twenty minutes: long enough
-- for a provider blip to clear, short enough that three attempts still fit inside the morning.
ALTER TABLE intelligence_report ADD COLUMN requested_at TEXT;
ALTER TABLE intelligence_report ADD COLUMN requested_by TEXT;
ALTER TABLE intelligence_report ADD COLUMN retry_after TEXT;

-- ── 3 · THE SWEEP JOB SAYS WHAT IT DOES ─────────────────────────────────────────────────────────
--
-- `daily_intelligence` no longer builds the brief; the tick serves brief work directly, every
-- minute, outside any job's fifteen-minute interval. The job's name said "brief" and its runs
-- said "10 duplicate" — two components each keeping their own story. It is now named for the one
-- thing it does.
UPDATE scheduled_job SET name = 'Reading the intelligence sources' WHERE job_key = 'daily_intelligence';

-- A migration that reported success while changing nothing is a defect this repo has shipped twice
-- (0193). The profile UPDATE may legitimately match zero rows on a fresh database, so the guard is
-- on the columns, which must exist afterwards on every database this reaches.
CREATE TABLE migration_guard_0211 (matched INTEGER NOT NULL CHECK (matched = 3));
INSERT INTO migration_guard_0211 (matched)
SELECT COUNT(*) FROM pragma_table_info('intelligence_report') WHERE name IN ('requested_at', 'requested_by', 'retry_after');
DROP TABLE migration_guard_0211;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0211_the_brief_arrives_every_morning');

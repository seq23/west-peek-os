-- The morning brief fires on the tick and decides for itself whether today's work is done.
--
-- WHY THIS HAS TO CHANGE. `daily_intelligence` was DAILY_AT 06:00 — one fire, one invocation, and
-- everything had to finish inside it. On the Workers Free plan a Cron Trigger gets **10 ms of CPU**
-- (Paid gets 30 seconds), and parsing feeds for every source and then building a brief for every
-- partner is far past that. The invocation was killed mid-flight, which is why four of the last
-- eight briefs failed and every one that succeeded was a human pressing the button — a different
-- path, which generates for one partner and is not on the cron's budget.
--
-- The work is now chunked: two sources per tick, least recently checked first, and at most one
-- partner's brief per tick. That only works if the job fires more than once a day, so it moves to
-- INTERVAL 15, matching the Cron Trigger already in wrangler.toml.
--
-- WHAT STOPS IT BRIEFING ALL NIGHT. Two guards, both already in the data:
--   * A partner is only due once their own local clock passes `deliver_at_local` (default 06:45)
--     in their own timezone. The 06:00 schedule used to be that gate; now it is explicit, and it is
--     per partner rather than one hour for the firm.
--   * A partner with a READY or FAILED report for their local date today is finished, so later
--     ticks skip them. `UNIQUE (firm_scope, firm_user_id, report_date)` makes that exact.
--
-- So a tick outside anyone's window sweeps two sources and briefs nobody. This is the same shape as
-- `monthly_room_proposal`, which fires daily and decides for itself whether the month already has a
-- proposal — an established pattern in this repo rather than a new one.
--
-- NOT A NEW CLOUDFLARE PRODUCT. Queues, Workflows and Durable Objects are all available on the free
-- plan and none of them raises the 10 ms CPU ceiling — Workflows re-grants 10 ms per step, which is
-- what the existing */15 cron already does for nothing. There is no requirement here that would
-- satisfy AGENTS.md's bar for adding one.

UPDATE scheduled_job
   SET schedule_kind  = 'INTERVAL',
       interval_minutes = 15,
       daily_at_utc   = NULL,
       -- Due immediately, so the first tick after deploy picks it up rather than waiting a day.
       next_run_at    = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE job_key = 'daily_intelligence';

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0091_daily_intelligence_runs_on_the_tick');

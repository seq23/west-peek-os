-- 0288 · THE WEEKLY SCHEDULE REBALANCE (owner-approved 1 Nov 2026), on her clock.
--
-- Monday 08:00 Central had three West Peek jobs in the same minute: Wynn's brand batch, Wynn's
-- roundup and Walker's hire search for West Peek Productions. The approved week:
--   · The Learning Club brand batch STAYS Monday 08:00 Central;
--   · Wynn's roundup moves to Monday 08:30 Central (code: services/tlcRoundup.ts ROUNDUP_LOCAL);
--   · the West Peek Productions weekly hire search moves to TUESDAY 09:00 Central.
--
-- Both rows were written as bare UTC hours (14:00Z), which is 09:00 Central in summer and 08:00 in
-- winter. They now carry `daily_at_tz = 'America/Chicago'` (the 0193 column), so `daily_at_utc` is a
-- wall clock in Chicago and `nextRunAt` computes it on that clock: the clock change no longer moves
-- them. `day_of_week` is then the Chicago weekday (zonedClock.nextInZone).
--
-- next_run_at is set to the next occurrence rather than NULL, so the deploy does not fire either job
-- early. The literal hour is the Central STANDARD offset (UTC-6), right for a migration applied this
-- winter; after the first run the scheduler recomputes it from the zone.
-- What each job does is unchanged.

UPDATE scheduled_job
   SET daily_at_utc = '08:00',
       daily_at_tz  = 'America/Chicago',
       day_of_week  = 1,
       next_run_at  = CASE
         WHEN strftime('%Y-%m-%dT14:00:00.000Z', 'now', 'weekday 1') > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           THEN strftime('%Y-%m-%dT14:00:00.000Z', 'now', 'weekday 1')
         ELSE strftime('%Y-%m-%dT14:00:00.000Z', 'now', 'weekday 1', '+7 days')
       END
 WHERE job_key = 'tlc_brand_batch';

UPDATE scheduled_job
   SET daily_at_utc = '09:00',
       daily_at_tz  = 'America/Chicago',
       day_of_week  = 2,
       next_run_at  = CASE
         WHEN strftime('%Y-%m-%dT15:00:00.000Z', 'now', 'weekday 2') > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           THEN strftime('%Y-%m-%dT15:00:00.000Z', 'now', 'weekday 2')
         ELSE strftime('%Y-%m-%dT15:00:00.000Z', 'now', 'weekday 2', '+7 days')
       END
 WHERE job_key = 'productions_hire_search';

-- Loud, not silent: a database without both rows in their new shape fails the migration.
CREATE TABLE migration_guard_0288 (matched INTEGER NOT NULL CHECK (matched = 2));
INSERT INTO migration_guard_0288 (matched)
SELECT COUNT(*) FROM scheduled_job
 WHERE (job_key = 'tlc_brand_batch' AND schedule_kind = 'WEEKLY' AND day_of_week = 1 AND daily_at_utc = '08:00' AND daily_at_tz = 'America/Chicago')
    OR (job_key = 'productions_hire_search' AND schedule_kind = 'WEEKLY' AND day_of_week = 2 AND daily_at_utc = '09:00' AND daily_at_tz = 'America/Chicago');
DROP TABLE migration_guard_0288;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0288_schedule_rebalance_on_her_clock');

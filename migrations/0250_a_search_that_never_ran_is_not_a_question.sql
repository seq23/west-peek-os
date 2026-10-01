-- 0250 — A card stopped because its live search never ran goes back in the queue.
--
-- WHY (1 Oct 2026). Walker's monthly Productions search failed — the spend setting refused the search call and no seat
-- could search — and the runner turned "the live search failed" into "no customer lead survived", a block asking
-- Scooter where to look. Nothing had been looked at. The runners now fail the attempt instead (so the sweep classifies
-- the lane's own words, retries, and resumes by itself when the setting or a search seat changes). This puts the cards
-- that were already stopped the old way back in the queue once, so they meet the fixed runner rather than wait for a
-- person to press a button for a question that had no answer.
--
-- ONLY a card that is BLOCKED, not held, stopped as "nothing good enough to send", and whose own sentence says the
-- live search failed. A card stopped because the search RAN and found nothing says something else and is not touched.
-- Same write the sweep's own release makes (work_attempts and the lease cleared, the answer marked AUTO-RETRY).
UPDATE work_card
   SET state = 'OPEN', work_attempts = 0, work_steps = 0, lease_until = NULL,
       work_last_failure = NULL, work_last_failure_at = NULL,
       next_action = 'Back in the queue: the live search never ran, so nothing had been looked at. It is being tried again.',
       block_answer = 'AUTO-RETRY: the live search never ran, so nothing had been looked at',
       block_answered_by = 'migration_0250', block_answered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       block_nag_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE state = 'BLOCKED'
   AND held_at IS NULL
   AND block_reason = 'nothing_good_enough_to_send'
   AND block_needed LIKE '%the live search failed%';

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0250_a_search_that_never_ran_is_not_a_question');

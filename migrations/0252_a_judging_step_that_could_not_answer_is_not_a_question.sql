-- 0252 — A card stopped because its JUDGING step could not answer goes back in the queue.
--
-- WHY (1 Oct 2026). Walker's monthly Productions card stopped with "no customer lead survived (the judgement pass failed: …)".
-- The search had run; the second step — a model judging each lead — was refused (the spend setting, or a lane down), and the
-- runner reported that as "no lead survived", a question for Scooter with no answer. 0250 fixed the search half of this; the
-- runners now fail the attempt for the judging half too. This puts the cards already stopped that way back in the queue once,
-- so they meet the fixed runner. Same conditions and the same write as 0250: BLOCKED, not held, stopped as "nothing good
-- enough to send", and whose own sentence says the judgement pass failed.
UPDATE work_card
   SET state = 'OPEN', work_attempts = 0, work_steps = 0, lease_until = NULL,
       work_last_failure = NULL, work_last_failure_at = NULL,
       next_action = 'Back in the queue: the judging step could not answer, so nothing had been judged. It is being tried again.',
       block_answer = 'AUTO-RETRY: the judging step could not answer, so nothing had been judged',
       block_answered_by = 'migration_0252', block_answered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       block_nag_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE state = 'BLOCKED'
   AND held_at IS NULL
   AND block_reason = 'nothing_good_enough_to_send'
   AND block_needed LIKE '%the judgement pass failed%';

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0252_a_judging_step_that_could_not_answer_is_not_a_question');

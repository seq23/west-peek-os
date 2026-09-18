-- 0194 · Spending every attempt is a terminal state (18 Sep 2026)
--
-- Production, this morning:
--
--   Draft event kit: October workshop with Kirx Diaz, on leveling up your creator process
--   state = OPEN, work_attempts = 3, last touched 2026-09-18T01:15:09
--
-- `claimNextCard` takes OPEN and IN_PROGRESS cards with `work_attempts < 3`. So that card is
-- UNCLAIMABLE. And because it is not BLOCKED, none of PR #94's machinery reaches it: no
-- `block_stopped` sentence, no doors, no nag. On the Work page it reads as ordinary open work. It
-- sat there for fourteen hours, and it was the thing the owner most wanted that day.
--
-- WHY IT FAILED IS NOT WHAT THIS FIXES, and is already fixed. Two runs, 00:57:48 and 01:03:48,
-- went `openrouter/claude-sonnet-5` → timeout → failover to direct `anthropic/claude-sonnet-5` →
-- HTTP 400, because that account had no credit. The lane was stood down at ~01:10 and the
-- thirteen-rung ladder shipped the same morning. THE BUG IS THAT RUNNING OUT OF ATTEMPTS DID NOT
-- STOP THE CARD.
--
-- ─── THE RULE, AND WHY IT IS ONLY ABOUT `OPEN` ────────────────────────────────────────────────
--
-- OPEN means "waiting for an employee to pick this up". At the attempt ceiling nothing can pick it
-- up. The two statements are contradictory, and there is no legitimate writer of that pair: every
-- door that puts a card back — `answerBlock` and `reopen` in services/blocks.ts, the preview
-- lane's "send it back", 0173's own backfill — already writes `work_attempts = 0`. The one path
-- that did not was `handleUpdateWorkCard`, whose `ALLOWED_TRANSITIONS` permits BLOCKED → OPEN and
-- IN_PROGRESS → OPEN from the Work page; that is fixed in the same change, and this is the part
-- that survives the next service to forget.
--
-- `IN_PROGRESS` AT THE CEILING IS DELIBERATELY NOT REFUSED, and the reason matters. It is the
-- state of a card BEING WORKED RIGHT NOW on its final attempt — `claimNextCard` writes exactly
-- that pair on every third claim. Worse, `releaseLease` nulls the lease in the sweep's `finally`
-- BEFORE the failure branch writes the block, so a trigger covering IN_PROGRESS would abort the
-- ordinary end of every third tick. Whether such a card is dead or merely busy is a question about
-- TIME — has its lease expired — and a row-level trigger cannot ask it without breaking the
-- writer. That half lives in `settleAbandonedCards`, which now catches both the OPEN case and the
-- NULL-lease case the old query missed, and blocks them with the failure the card already carries.
--
-- THIS IS 0173'S PRECEDENT, DELIBERATELY. The same argument applies word for word: a rule that
-- lives only in a service is outrun by the next service, and the thing that must be true of every
-- row belongs at the row. 0173 refuses a BLOCKED card with no sentences; this refuses a claimable
-- card with no attempts left. Both are conditions no correct writer can hit.
--
-- THE NUMBER 3 IS `MAX_WORK_ATTEMPTS` in src/worker/services/workSweep.ts. It is written here in
-- SQL because a trigger cannot import TypeScript, and the two are pinned together by
-- `scripts/validate/spent-attempts-are-terminal.mjs`, which fails the build if either moves
-- without the other. A ceiling in code and a ceiling in the database with no link between them is
-- this repo's recurring defect and is exactly how this bug would come back.

CREATE TRIGGER IF NOT EXISTS work_card_spent_attempts_cannot_be_open_insert
BEFORE INSERT ON work_card
WHEN NEW.state = 'OPEN'
BEGIN
  SELECT RAISE(ABORT, 'a card with no attempts left cannot be OPEN: nothing can pick it up and nothing would say why, so put it back with its attempts reset or block it with a reason (0194)')
   WHERE COALESCE(NEW.work_attempts, 0) >= 3;
END;

CREATE TRIGGER IF NOT EXISTS work_card_spent_attempts_cannot_be_open_update
BEFORE UPDATE ON work_card
WHEN NEW.state = 'OPEN'
BEGIN
  SELECT RAISE(ABORT, 'a card with no attempts left cannot be OPEN: nothing can pick it up and nothing would say why, so put it back with its attempts reset or block it with a reason (0194)')
   WHERE COALESCE(NEW.work_attempts, 0) >= 3;
END;

-- The index `settleAbandonedCards` reads. Without it, the every-five-minutes sweep scans the whole
-- board to answer "is anything at the ceiling", which on day 200 is 531 rows and climbing.
CREATE INDEX IF NOT EXISTS idx_work_card_spent_attempts
  ON work_card (state, work_attempts)
  WHERE state IN ('OPEN', 'IN_PROGRESS');

-- ── The cards already in that state ──────────────────────────────────────────────────────────
--
-- REPAIRED HERE RATHER THAN BY HAND, and rather than left for the next sweep. A hand-written
-- UPDATE against production is a fix nobody can review and nothing records; doing it in the
-- migration means the repair ships with the code that prevents a recurrence, runs exactly once,
-- and is reviewable in the diff. Waiting for the sweep would also work — `settleAbandonedCards`
-- now catches these — but the triggers above are created BEFORE this statement runs, so a stuck
-- row would make every later `UPDATE ... SET state = 'OPEN'` on it abort. Fixing them here means
-- the database is never left holding a row its own rule forbids.
--
-- THEY BECOME BLOCKED, NOT RE-QUEUED. Re-queueing would hide the failure a second time: the card
-- would run, fail on whatever is still wrong, and come back here. BLOCKED is what puts the reason,
-- the doors and the nag in front of the owner, which is the entire point of PR #94.
--
-- THE FOUR SENTENCES ARE SUPPLIED because 0173's trigger refuses a BLOCKED row without them, and
-- `block_stopped` is held to ONE plain sentence with no error codes, table names or stage names in
-- it. `block_needed` leads with `work_last_failure` when the card kept one — it is written for a
-- partner already ("Attempt 3 of 3 was refused by the Anthropic lane — the account behind it has
-- run out of credit.") — and falls back to the plain ask when it did not.
--
-- The doors match `stopped_part_way` in src/shared/work/blocks.ts exactly, because the page renders
-- what is stored: ANSWER, DROP, ESCALATE. Every key is in `BLOCK_ACTIONS` and in `actionTypes.ts`,
-- so each button reaches an authorised route rather than 403ing.
UPDATE work_card
   SET state = 'BLOCKED',
       block_reason = 'stopped_part_way',
       block_trying = substr(title, 1, 400),
       block_stopped = 'This used every attempt it had and stopped without reporting.',
       block_needed = CASE
         WHEN IFNULL(length(trim(work_last_failure)), 0) > 0
           THEN trim(work_last_failure) || ' Say whether to try it again now, or drop it.'
         ELSE 'Say whether this should be tried again now, or dropped.'
       END,
       block_who = 'SEQUOIA',
       block_actions_json = '[{"key":"ANSWER","label":"Answer it","hint":"Type anything you want done differently, and this is picked up again."},{"key":"DROP","label":"Drop it","hint":"Decide it is not worth doing. Kept on the record with your reason, and they stop asking."},{"key":"ESCALATE","label":"Send it to an engineer","hint":"Nobody here can answer this one. It goes to whoever maintains the system, with what they need to fix it."}]',
       blocked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       -- It rings in 48 hours if nobody acts. `TECHNICAL_BLOCK_NAG_HOURS`; `stopped_part_way` is a
       -- fault rather than a question, and she cannot act on one at two in the morning.
       block_nag_at = strftime('%Y-%m-%dT%H:%M:%fZ','now', '+48 hours'),
       block_nags = 0,
       next_action = 'This used every attempt it had and stopped. Answer it, or drop it.',
       lease_until = NULL,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE state = 'OPEN'
   AND COALESCE(work_attempts, 0) >= 3;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0194_spending_every_attempt_is_a_terminal_state');

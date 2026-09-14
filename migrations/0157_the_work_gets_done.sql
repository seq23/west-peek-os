-- 0157 — The work gets done: a rejected deck becomes Preston's card, waiting cards get worked,
--        and the deck rebuild stops pretending to be a daily.
--
-- WHAT THE OPERATOR FOUND, 14 Sep 2026. Four cards owned by Wyatt had read "in progress" since
-- 9 Sep and nothing had touched them: an employee's card is only ever worked when somebody presses
-- the button, and nobody did. She rejected Preston's deck v10 with a reason and nothing happened —
-- rejection wrote a row and an event and stopped. And the "Rebuild the LP deck" job had been
-- switched to daily and was producing a new empty version every morning ("no PDF attached"), v6
-- through v10, each one waiting on a decision about nothing.
--
-- THREE CHANGES, ALL DATA:
--
--   1. `work_card.kind` — a card can say what sort of work it is, so the sweep below knows that a
--      DECK_REWORK card means "build the deck" rather than "look things up". Nullable: every card
--      that exists is ordinary work and stays so.
--   2. `employee_work_sweep` — a job, every five minutes, that picks ONE waiting AI-owned card and
--      works it, the same code path the button runs. One per tick because the cron tick has a CPU
--      budget (see jobs.ts) and a card's steps are model calls. A card finishes DONE with its
--      findings as a note, or BLOCKED with its question — never "in progress" and silent.
--   3. `deck_rebuild` goes back to PAUSED, which is what 0154 seeded it as. The deck is rebuilt when
--      a partner rejects a version — that opens Preston's card, and the sweep does the work — not on
--      a timer. The job row stays so it can still be run by hand from Work.
--
-- Idempotent: the column add is guarded by the migration marker (D1 has no ADD COLUMN IF NOT
-- EXISTS), the job insert uses WHERE NOT EXISTS, and the pause is an UPDATE.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0157_the_work_gets_done');

ALTER TABLE work_card ADD COLUMN kind TEXT;
-- The claim and the count the sweep needs. `lease_until` is the lock between the button and the
-- sweep; `work_attempts` is what turns "retry for ever" into "three strikes, then a person".
ALTER TABLE work_card ADD COLUMN work_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE work_card ADD COLUMN lease_until TEXT;

INSERT INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, interval_minutes, target_kind, target_id, task_class,
   budget_usd, data_class, status, pause_reason, created_by, firm_scope, next_run_at)
SELECT
  'sjb_employee_work_sweep', 'employee_work_sweep', 'Working the cards employees own',
  'EMPLOYEE_TASK', 'INTERVAL', 5, 'SYSTEM', NULL, 'OPERATIONS',
  0, 'INTERNAL', 'ACTIVE', NULL,
  'system', 'west-peek', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (SELECT 1 FROM scheduled_job WHERE job_key = 'employee_work_sweep');

UPDATE scheduled_job
   SET status = 'PAUSED',
       pause_reason = 'Rebuilt when a partner sends a version back — that opens a card for Preston and the sweep does the work — not on a timer. Run it by hand from here if you want a fresh version now.'
 WHERE job_key = 'deck_rebuild' AND status = 'ACTIVE';

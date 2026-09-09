-- 0154 — Preston can be ASSIGNED the deck, not just asked for it by hand.
--
-- Operator, 9 Sep 2026: "when we want to make updates to it we can assign the same employee to do
-- so and changes are tracked". `scripts/deck/build.mjs` already renders the PDF from the records,
-- which was the hard part — but a command she has to run herself is a chore with a nicer name, not
-- a duty. This is the row that makes it assignable.
--
-- PAUSED, and for the ordinary reason recorded in 0043: recurring work is opt-in. A deck is rebuilt
-- when the records move or when a partner asks, not on a timer. The schedule exists so it CAN be
-- made periodic without a migration; the path an assignment takes today is
-- `POST /api/jobs/deck_rebuild/run`.
--
-- SEEDED THE LOUD WAY. `INSERT OR IGNORE` swallows a constraint failure — that is how 0046
-- registered a job that existed in no database at all — so this uses WHERE NOT EXISTS, which is
-- idempotent without being deaf.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0154_preston_can_be_asked_to_rebuild_the_deck');

INSERT INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, daily_at_utc, target_kind, target_id, task_class,
   budget_usd, data_class, status, pause_reason, created_by, firm_scope)
SELECT
  'sjb_deck_rebuild', 'deck_rebuild', 'Rebuild the LP deck from the fund records',
  'EMPLOYEE_TASK', 'DAILY_AT', '10:00', 'EMPLOYEE', 'aie_preston', 'DERIVATION',
  0, 'INTERNAL', 'PAUSED',
  'Rebuilt when the records move or when a partner asks, not on a timer. Run it from Work, or POST /api/jobs/deck_rebuild/run.',
  'system', 'west-peek'
WHERE NOT EXISTS (SELECT 1 FROM scheduled_job WHERE job_key = 'deck_rebuild');

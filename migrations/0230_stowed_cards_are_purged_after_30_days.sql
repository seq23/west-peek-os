-- 0230 — Stowed (NO_ACTION_NEEDED) cards are purged after 30 days (Addendum 10, 22 Sep 2026).
--
-- Her decision: unlike real finished work (a decision, a shipped change — kept forever), a
-- confirmed joke or acknowledgment carries near-zero lasting value once nobody has disputed the
-- classification. A daily job purges the `work_card` row (and any stored raw `.eml` in
-- `inbound_message`/R2) for a card still `state = 'CANCELLED' AND auto_resolution =
-- 'NO_ACTION_NEEDED'` more than 30 days after `created_at`. A card that was reopened (the existing
-- put-back door, or a dispute) is no longer in that state, so it is excluded by the same WHERE
-- clause that selects the rest — no separate "disputed" flag needed. `event_record` is append-only
-- and is NEVER deleted (migration 0008's triggers already refuse an UPDATE or DELETE on it): the
-- `work_card.auto_resolved_no_action` event this card's classification wrote survives the purge as
-- the permanent trace of what happened, when, and why.
--
-- SEEDED THE WAY `0127_the_diagnostics_job_is_provably_there.sql` DOCUMENTS RATHER THAN THE WAY
-- `0112`/`0113` DID IT FIRST. Those two used `INSERT OR IGNORE`, which swallowed a CHECK failure on
-- `scheduled_job.kind` silently and reported a successful migration while the monitor was not
-- there. `INSERT … SELECT … WHERE NOT EXISTS` is used here instead: idempotent on a re-apply, and
-- any real constraint failure aborts loudly rather than being forgiven.

INSERT INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, daily_at_utc, target_kind, target_id,
   budget_usd, data_class, status, created_by)
SELECT
  'sjob_no_action_purge', 'no_action_card_purge', 'Stowed card purge', 'EMPLOYEE_TASK',
  'DAILY_AT', '09:20',
  -- SYSTEM: this purges across the whole firm's cards, not one machine's work.
  'SYSTEM', NULL,
  -- No budget: the job is a handful of DELETEs against D1 and an R2 delete per stored message —
  -- no model call, so a spend ceiling must never be the reason a purge silently stops running.
  0, 'INTERNAL', 'ACTIVE', 'system'
WHERE NOT EXISTS (SELECT 1 FROM scheduled_job WHERE job_key = 'no_action_card_purge');

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0230_stowed_cards_are_purged_after_30_days');

-- 0146 — Nothing ever pulled Network OS on a schedule.
--
-- Operator, 23 Aug 2026: "i added all our contacts into network OS and the community tab should
-- begin processing them."
--
-- Every part of the pull was built: the adapter contract, the live client, the sync cursor, the
-- idempotent receipts, the conflict rows, and a Community page with a progress bar that reads
-- "Reading your community from Network OS — N of M so far. It carries on by itself; nothing needs
-- to stay open." It does not carry on by itself. `scheduled_job` held no row for it, so the only
-- pull that had ever run was the one triggered by hand on 22 Aug to prove the connection — and the
-- community would have sat at zero for ever while the page said it was loading.
--
-- That sentence on the page is the tell, and it is the same defect this repo keeps producing: a
-- surface describing machinery that is not running.
--
-- INTERVAL 15, matching the other cheap jobs. A pull is bounded per tick by the adapter's own page
-- size and advances a cursor, so a large community loads across ticks rather than trying to arrive
-- in one — the same shape as the deck reader, for the same CPU reason.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0146_the_community_loads_on_a_schedule');

-- WHERE NOT EXISTS rather than INSERT OR IGNORE: this repo has twice shipped a migration that
-- reported success while silently dropping the row it existed to add.
INSERT INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, interval_minutes, target_kind, target_id,
   budget_usd, data_class, status, created_by)
SELECT
  'sjob_network_sync', 'network_sync', 'Loading the community from Network OS', 'EMPLOYEE_TASK',
  'INTERVAL', 15,
  'SYSTEM', NULL,
  -- No budget: a pull is HTTP and SQL, never a model call. Giving it one would let a spend ceiling
  -- stop the firm learning who its own community is.
  0.0, 'INTERNAL', 'ACTIVE', 'system'
WHERE NOT EXISTS (SELECT 1 FROM scheduled_job WHERE job_key = 'network_sync');

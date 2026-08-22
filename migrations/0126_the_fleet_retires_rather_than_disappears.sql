-- The fleet and the roster both shrink, and NOTHING IS DELETED.
--
-- Operator decisions, 21 Aug 2026 (issues list items 17 and 24): merge the LP Sourcing seat into LP
-- Relations, give the Professor a teaching machine to sit on, and retire three machines that either
-- duplicate something better or assume an engineer this firm does not employ.
--
-- WHY A FLAG AND NEVER A DELETE — this is the whole point of the migration.
--
-- Machines are referenced by `work_card`, `ai_run` and `ai_run_attribution`; AI employees are
-- referenced by those plus meeting seating and the status history. Migrations here are append-only
-- and the seed generators only ever INSERT, so removing a row from the TypeScript registry does not
-- remove it from any database that already exists — it just leaves a ghost that no code will ever
-- claim again. Deleting the row instead would be worse: a work card from June would lose the name of
-- the machine that produced it, and an ai_run would lose its attribution.
--
-- So the row stays and gains a REASON. `MACHINE_REGISTRY` keeps all 46 rows as the historical list
-- and `ACTIVE_MACHINES` (43) is what anything may be seated on, scheduled to or routed to. RETIRED
-- is already the lifecycle's word for an employee whose seat no longer exists, so Piper takes that
-- and keeps everything she is attached to.
--
-- WHAT MOVED, and why each one:
--   +46 venture_teaching   The Professor was seated on `ic_learning_loop`, which is the committee's
--                          3/6/12/24-month post-mortem, so two of her three methods were investment
--                          methods and there was no teaching machine in the registry at all. The
--                          post-mortem goes back to Poppy, who keeps the committee record.
--    -7 developer_diagnostics   Assumes an engineer on a roster that has none.
--   -42 prompt_enhancer_intent  Duplicates src/shared/work/askToCard.ts, which turns a partner's
--                          sentence into GO / WORK / TELL / BRIEF and does it better. Two front
--                          doors for one intent is the failure that file was written to end.
--   -43 builder_repo_product    Same as 7: repo work is done against this repo's own authority.
--
-- Nine machines that had nobody also gained a seat in the same change. That is registry work and
-- needs no schema, but the seating is copied into `ai_employee.primary_machines_json` below, because
-- the Employee Lounge reads that column and would otherwise show yesterday's seating for ever — the
-- role/layer backfill generator does not touch it.

-- ── 1 · A machine can be retired ─────────────────────────────────────────────────────────────
-- Presence of a reason IS the flag, exactly as `retiredReason` works in the registry. One column
-- rather than two, so there is no way for a boolean and a reason to disagree.
ALTER TABLE machine ADD COLUMN retired_reason TEXT;

-- ── 2 · The new machine ──────────────────────────────────────────────────────────────────────
-- ON CONFLICT (key) DO NOTHING, and ONLY here: the seed generator legitimately emits this same row
-- into migration 0003, so a fresh database will already have it by the time this file runs, while an
-- existing database has never seen it. Everywhere else in this file a plain statement is used —
-- INSERT OR IGNORE has twice shipped a swallowed CHECK failure in this repo.
INSERT INTO machine (id, key, name, domain_id, purpose, in_initial_scope) VALUES
  (46, 'venture_teaching', 'Venture Teaching Machine', 'KNOWLEDGE_OS',
   'West Peek University: teaching venture to the partners themselves — explanation at a chosen depth, assessment that marks honestly, and case work run against real firm decisions rather than invented companies.',
   0)
ON CONFLICT (key) DO NOTHING;

-- Every machine starts ACTIVE with no operator configuration (the rule migration 0016 set), so the
-- control centre shows the real fleet rather than a row with no state. Guarded by NOT EXISTS rather
-- than OR IGNORE so a genuine failure would still be a failure.
INSERT INTO machine_state (machine_id, status, updated_by)
SELECT m.id, 'ACTIVE', 'migration:0126'
  FROM machine m
 WHERE m.key = 'venture_teaching'
   AND NOT EXISTS (SELECT 1 FROM machine_state s WHERE s.machine_id = m.id);

-- ── 3 · The three retirements ────────────────────────────────────────────────────────────────
UPDATE machine
   SET retired_reason = 'Retired 21 Aug 2026: duplicates src/shared/work/askToCard.ts (GO / WORK / TELL / BRIEF), which does the same job better. Two front doors for one intent is the failure that file was written to end.'
 WHERE key = 'prompt_enhancer_intent'
   AND retired_reason IS NULL;

UPDATE machine
   SET retired_reason = 'Retired 21 Aug 2026: assumes an engineer on a roster that has none. The operator debugs this repo with Claude Code, and Diagnostics reports the system''s health without a seat behind it.'
 WHERE key = 'developer_diagnostics'
   AND retired_reason IS NULL;

UPDATE machine
   SET retired_reason = 'Retired 21 Aug 2026: assumes an in-house engineer. Repo work is done by the operator with Claude Code against this repo''s own written authority, not routed to a machine inside the product.'
 WHERE key = 'builder_repo_product'
   AND retired_reason IS NULL;

-- Retirement with teeth in the RUNNING system, not only in the registry. `machine_state.status =
-- PAUSED` is already enforced in two independent places — capture routing refuses a paused machine
-- with 409 machine_paused, and run_ai refuses to spend anything attributed to it — so pausing is how
-- a retired machine stops taking new work today without any UI change. The reason string opens with
-- RETIRED so nobody reads it as a temporary hold and clicks Resume.
UPDATE machine_state
   SET status = 'PAUSED',
       paused_by = 'migration:0126',
       paused_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       pause_reason = 'RETIRED — this machine no longer takes work. See machine.retired_reason and ACTIVE_MACHINES in src/shared/registry/machines.ts.',
       updated_by = 'migration:0126',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE machine_id IN (SELECT id FROM machine WHERE key IN ('prompt_enhancer_intent','developer_diagnostics','builder_repo_product'))
   AND status <> 'PAUSED';

-- A status change with no history row is the kind that later looks like it was always that way.
INSERT INTO machine_state_change (id, machine_id, from_status, to_status, reason, actor_id)
SELECT 'msc_0126_' || m.key, m.id, 'ACTIVE', 'PAUSED',
       'Retired by operator decision (issues list item 24). The row stays because work cards and ai_run attribution point at it.',
       'migration:0126'
  FROM machine m
 WHERE m.key IN ('prompt_enhancer_intent','developer_diagnostics','builder_repo_product')
   AND NOT EXISTS (SELECT 1 FROM machine_state_change c WHERE c.id = 'msc_0126_' || m.key);

-- ── 4 · The merged seat ──────────────────────────────────────────────────────────────────────
-- Piper (LP Sourcing) and Wesley (LP Relations) both sat on `lp_fundraising` and nothing else, with
-- byte-identical guidance — two seats working the same LP prospect at a fund with roughly forty
-- limited partners. Her judgement (rule a name out early rather than carry it a quarter) is now in
-- Wesley's biography and persona voice; her ROW stays and goes RETIRED, because ai_run attribution
-- and meeting seating point at it and what she did actually happened.
--
-- The roster generator will also emit its own `_ai_employee_retire.sql` expressing the same thing as
-- "anybody not on the roster". That file is guarded on `status <> 'RETIRED'`, so after this it is a
-- no-op rather than a contradiction.
UPDATE ai_employee
   SET status = 'RETIRED'
 WHERE name = 'Piper'
   AND status <> 'RETIRED';

INSERT INTO ai_employee_status_history (id, ai_employee_id, from_status, to_status, actor_type, actor_id, reason)
SELECT 'aesh_piper_merged_0126', id, 'INACTIVE', 'RETIRED', 'SYSTEM', 'migration:0126',
       'LP Sourcing merged into LP Relations (Wesley). Both seats sat on lp_fundraising ONLY and read '
       || 'identical guidance, so they were two people working the same prospect. The qualifying '
       || 'instinct moved to Wesley; the row is kept because history references it.'
  FROM ai_employee
 WHERE name = 'Piper'
   AND NOT EXISTS (SELECT 1 FROM ai_employee_status_history WHERE id = 'aesh_piper_merged_0126');

-- ── 5 · Seating, as the Lounge reads it ──────────────────────────────────────────────────────
-- `primary_machines_json` is seeded by 0004 with INSERT OR IGNORE, so an existing row keeps its
-- original seating no matter how often 0004 is regenerated — the same trap that kept calling Parker
-- an Event Planner in production. Each UPDATE is guarded on the value still differing, so a database
-- already carrying it is untouched. These are the eleven seats this change moved.
UPDATE ai_employee SET primary_machines_json = '["lp_fundraising","lp_diligence_request","lp_proof_engine"]'
 WHERE name = 'Wesley' AND primary_machines_json <> '["lp_fundraising","lp_diligence_request","lp_proof_engine"]';

UPDATE ai_employee SET primary_machines_json = '["knowledge_memory_promotion","research_data_license_quality","data_room_control"]'
 WHERE name = 'Wells' AND primary_machines_json <> '["knowledge_memory_promotion","research_data_license_quality","data_room_control"]';

UPDATE ai_employee SET primary_machines_json = '["relationship_intelligence","community_intelligence","relationship_capital_budget"]'
 WHERE name = 'Waverly' AND primary_machines_json <> '["relationship_intelligence","community_intelligence","relationship_capital_budget"]';

UPDATE ai_employee SET primary_machines_json = '["legal_compliance_rules","model_governance_privacy_airlock","activity_audit_ledger"]'
 WHERE name = 'Willow' AND primary_machines_json <> '["legal_compliance_rules","model_governance_privacy_airlock","activity_audit_ledger"]';

UPDATE ai_employee SET primary_machines_json = '["meeting_intelligence","meeting_capture_adapter"]'
 WHERE name = 'Walter' AND primary_machines_json <> '["meeting_intelligence","meeting_capture_adapter"]';

UPDATE ai_employee SET primary_machines_json = '["finance_fund_admin","fund_construction_allocation","external_helper_coordination"]'
 WHERE name = 'Preston' AND primary_machines_json <> '["finance_fund_admin","fund_construction_allocation","external_helper_coordination"]';

UPDATE ai_employee SET primary_machines_json = '["continuity_maintenance","ai_employee_performance_lifecycle","governance_center_broadcast","approval_center"]'
 WHERE name = 'Pax' AND primary_machines_json <> '["continuity_maintenance","ai_employee_performance_lifecycle","governance_center_broadcast","approval_center"]';

-- Pierce loses `ic_decision` on the firm's own method: the committee machine says the champion may
-- not write the kill case, and this seat is always the champion. Poppy keeps it, and takes the
-- post-mortem back from the Professor.
UPDATE ai_employee SET primary_machines_json = '["early_stage_deal","secondaries_investment","investment_mandate_exclusion"]'
 WHERE name = 'Pierce' AND primary_machines_json <> '["early_stage_deal","secondaries_investment","investment_mandate_exclusion"]';

UPDATE ai_employee SET primary_machines_json = '["ic_decision","ic_learning_loop"]'
 WHERE name = 'Poppy' AND primary_machines_json <> '["ic_decision","ic_learning_loop"]';

-- Percy off `marketing_pr_content` entirely: he was on it only because his page-conversion rubric
-- happened to be filed there, which left the firm's press machine holding a method about buttons.
UPDATE ai_employee SET primary_machines_json = '["taste_layer"]'
 WHERE name = 'Percy' AND primary_machines_json <> '["taste_layer"]';

UPDATE ai_employee SET primary_machines_json = '["venture_teaching"]'
 WHERE name = 'Whitney' AND primary_machines_json <> '["venture_teaching"]';

-- OR IGNORE here and NOWHERE else in this file: the version marker is the one row where a re-apply
-- is genuinely a no-op rather than a swallowed failure.
INSERT OR IGNORE INTO schema_version (migration) VALUES ('0126_the_fleet_retires_rather_than_disappears');

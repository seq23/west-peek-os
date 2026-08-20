-- Undo the activation in 0069. Not the un-retirement — the ACTIVE.
--
-- 0069 set Whitney to ACTIVE on the reasoning that a page naming a teacher should not then refuse
-- to teach. That reasoning was wrong on the facts: University never consults the employee table at
-- all. The professor is a persona on the teaching prompt, so the lesson runs whatever her status
-- says, and setting ACTIVE bought exactly nothing.
--
-- What it cost was D10. Activation requires an approved Managing Partner receipt, and a migration
-- has no receipt — that is the entire point of the law, and `tests/ai.test.ts` caught it inside a
-- minute ("seeds exactly the roster, all INACTIVE, no Managing Partner names"). A governance test
-- that fires the first time somebody routes around the rule is a test doing its job, and the right
-- response is to stop routing around it rather than to widen the test.
--
-- 0069 is left as it stands rather than edited: it has been applied, migrations are append-only,
-- and a migration whose recorded text differs from what actually ran is worse than a visible
-- correction. She keeps the new role, layer and department; only the status returns to where every
-- other seat starts. Activation now goes through the ordinary route, with a receipt.

UPDATE ai_employee
SET status = 'INACTIVE', activated_at = NULL, activated_by = NULL
WHERE name = 'Whitney' AND status = 'ACTIVE';

-- The 0069 row STAYS. `ai_employee_status_history` is append-only (D15) and the trigger rejected
-- the delete this migration first attempted — correctly. A governance ledger you can quietly edit
-- when you regret an entry is not a ledger. The record now reads: retired → active → inactive,
-- which is what actually happened, including the mistake.

INSERT INTO ai_employee_status_history (id, ai_employee_id, from_status, to_status, actor_type, actor_id, reason)
SELECT 'aesh_whitney_unretired_0070', id, 'ACTIVE', 'INACTIVE', 'SYSTEM', 'migration:0070',
       'Reversing the activation in 0069. She stays un-retired as Professor, West Peek University, '
       || 'but returns to INACTIVE like every other seat: activation needs a Managing Partner '
       || 'receipt (D10) and a migration cannot carry one.'
FROM ai_employee WHERE name = 'Whitney';

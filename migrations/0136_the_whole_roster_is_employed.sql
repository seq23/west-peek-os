-- Everybody is employed. Who is ON DUTY is a different question, and the roster already answers it.
--
-- Operator, 22 Aug 2026: "letes just turn all employees on to active then to start. all employees on
-- and they can go on and off duty as you wish with various rotating hours if u want."
--
-- TWO IDEAS THAT WERE ONE NUMBER. Employment is whether a seat exists and may be given work; DUTY is
-- who is covering the hours right now. Conflating them meant hiring somebody just to hear from them
-- and firing them to get quiet, which is why the workforce had one employee who had ever run
-- anything. `dutyRoster.ts` already models shifts; this makes employment stop competing with it.
--
-- WHY A MIGRATION AND NOT THE SEED. `generate-ai-employee-seed.mjs` writes every employee INACTIVE
-- and `validate:ai-boundary` enforces it. That guard is about the GENERATOR: nobody may quietly
-- pre-staff the roster by editing a seed. A migration is the opposite — a dated, reversible decision
-- with history rows naming who took it.
--
-- Said plainly, because the comment here first claimed otherwise: a database built fresh from these
-- migrations DOES end up with the roster employed, since migrations run there too. That is correct
-- for this repository, which is West Peek's own operating system rather than a product other firms
-- install. The decision below is West Peek's, and a rebuild of West Peek's system should inherit it.
--
-- ONLY THE ONES OFF FOR NO REASON. A RETIRED seat stays retired — the Piper merge is a decision, not
-- a gap — and anything already ACTIVE or PAUSED is left exactly as it is, because a partner who
-- paused somebody yesterday did that on purpose.
INSERT INTO ai_employee_status_history (id, ai_employee_id, from_status, to_status, actor_type, actor_id, reason)
SELECT
  'aesh_' || lower(hex(randomblob(8))),
  id,
  status,
  'ACTIVE',
  'HUMAN',
  'fu_sequoia_taylor',
  'Whole roster employed on the partners'' direction, 22 Aug 2026. Duty hours govern who is actually on.'
FROM ai_employee
WHERE status = 'INACTIVE';

UPDATE ai_employee
   SET status = 'ACTIVE'
 WHERE status = 'INACTIVE';

-- OR IGNORE here and NOWHERE else in this file: the version marker is the one row where a re-apply
-- is genuinely a no-op rather than a swallowed failure.
INSERT OR IGNORE INTO schema_version (migration) VALUES ('0136_the_whole_roster_is_employed');

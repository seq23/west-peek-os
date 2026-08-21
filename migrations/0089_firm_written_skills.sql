-- Skills the firm writes for itself, in plain English, translated into a method its employees follow.
--
-- WHAT EXISTS ALREADY. `src/shared/skills/library.ts` holds eleven methods across seven of the
-- forty-five machines. It is CODE: there is no skill table anywhere in the first eighty-eight
-- migrations, so adding a method has meant a pull request and a deploy. The operator asked to write
-- one in plain English and have it become something the machine's employees actually follow.
--
-- WHY A SECOND SOURCE RATHER THAN MOVING THE FIRST. The library is reviewed, tested and frozen into
-- the repository, and `tests/skills.test.ts` asserts things about it that a database cannot promise
-- — no orphan machine keys, every skill-bearing machine seated by somebody. Copying it into D1
-- would produce two roughly-equal copies and the usual drift. So the library stays canonical, this
-- table holds what the firm adds afterwards, and every surface shows which is which. A reader must
-- never have to guess whether a method was reviewed in a pull request or typed into a form.
--
-- WHY A DRAFT STATE. A skill is read by every employee on that machine, on every run. Letting a
-- sentence typed into a box become a live instruction that nobody read in its final form is the
-- same class of mistake as an approval that approves itself. So: the operator writes plainly, an
-- employee drafts the method, the operator reads THAT and adopts it. Only ADOPTED skills reach a
-- prompt.
--
-- WHY IT IS NOT append-only. A skill is guidance, not a record of something that happened. Retiring
-- one is an ordinary act and the trail lives in the event spine, which is where "what did the firm
-- change and when" belongs.

CREATE TABLE IF NOT EXISTS firm_skill (
  id                TEXT PRIMARY KEY,
  -- machine.key from the machine registry. Not a foreign key: the registry is code, not a table
  -- this can reference. Validated by the service against MACHINE_REGISTRY before insert.
  machine_key       TEXT NOT NULL,
  title             TEXT NOT NULL,
  -- When this applies, so an employee can tell whether to use it. Mirrors Skill.when in the library.
  when_to_use       TEXT NOT NULL,
  -- The method itself: a JSON array of lines. Mirrors Skill.guidance.
  guidance_json     TEXT NOT NULL DEFAULT '[]',
  -- EXACTLY WHAT THE OPERATOR TYPED, kept for ever. When a drafted method turns out to say
  -- something the partner did not mean, this is the only way to tell whether the translation was
  -- wrong or the instruction was.
  source_text       TEXT NOT NULL,
  -- Which run drafted it, so a bad method can be traced to the call that wrote it.
  drafted_by_run_id TEXT,
  status            TEXT NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT','ADOPTED','RETIRED')),
  adopted_by        TEXT,
  adopted_at        TEXT,
  created_by        TEXT NOT NULL,
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- The lookup every prompt makes: adopted methods for the machines this employee sits on.
CREATE INDEX IF NOT EXISTS idx_firm_skill_machine
  ON firm_skill (firm_scope, machine_key, status);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0089_firm_written_skills');

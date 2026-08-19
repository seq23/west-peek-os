-- Make the stored layer and department match the roster the firm actually has.
--
-- The lounge groups people by department, and the departments in the database were the vocabulary
-- of a roster that no longer exists: 'Intake/Relationship/Memory/Governance + LP',
-- 'Market Intelligence (deferred product)'. Those are machine-layer names from an earlier design,
-- and no one looking for a person thinks in them. Worse, `layer` had drifted too — some employees
-- carried the current registry value and some the old one, so grouping by either produced a list
-- with the same team appearing twice under two spellings.
--
-- The registry is the source of truth for who works here and where they sit, so both columns are
-- set from it. Retired employees are deliberately untouched: their record should keep saying where
-- they sat when they sat there, and nothing groups them any more.
--
-- Generated from src/shared/registry/aiEmployees.ts. If the roster changes, regenerate rather than
-- hand-editing, or these drift apart again.

UPDATE ai_employee SET layer = 'MP Support' WHERE name = 'Walker' AND status != 'RETIRED';
UPDATE ai_employee_profile SET department = 'MP Support' WHERE ai_employee_id IN (SELECT id FROM ai_employee WHERE name = 'Walker' AND status != 'RETIRED');
UPDATE ai_employee SET layer = 'MP Support' WHERE name = 'Wren' AND status != 'RETIRED';
UPDATE ai_employee_profile SET department = 'MP Support' WHERE ai_employee_id IN (SELECT id FROM ai_employee WHERE name = 'Wren' AND status != 'RETIRED');
UPDATE ai_employee SET layer = 'Firm operations' WHERE name = 'Porter' AND status != 'RETIRED';
UPDATE ai_employee_profile SET department = 'Firm operations' WHERE ai_employee_id IN (SELECT id FROM ai_employee WHERE name = 'Porter' AND status != 'RETIRED');
UPDATE ai_employee SET layer = 'Firm operations' WHERE name = 'Waverly' AND status != 'RETIRED';
UPDATE ai_employee_profile SET department = 'Firm operations' WHERE ai_employee_id IN (SELECT id FROM ai_employee WHERE name = 'Waverly' AND status != 'RETIRED');
UPDATE ai_employee SET layer = 'Firm operations' WHERE name = 'Wells' AND status != 'RETIRED';
UPDATE ai_employee_profile SET department = 'Firm operations' WHERE ai_employee_id IN (SELECT id FROM ai_employee WHERE name = 'Wells' AND status != 'RETIRED');
UPDATE ai_employee SET layer = 'Firm operations' WHERE name = 'Willow' AND status != 'RETIRED';
UPDATE ai_employee_profile SET department = 'Firm operations' WHERE ai_employee_id IN (SELECT id FROM ai_employee WHERE name = 'Willow' AND status != 'RETIRED');
UPDATE ai_employee SET layer = 'Investment' WHERE name = 'Pierce' AND status != 'RETIRED';
UPDATE ai_employee_profile SET department = 'Investment' WHERE ai_employee_id IN (SELECT id FROM ai_employee WHERE name = 'Pierce' AND status != 'RETIRED');
UPDATE ai_employee SET layer = 'Investment' WHERE name = 'Wyatt' AND status != 'RETIRED';
UPDATE ai_employee_profile SET department = 'Investment' WHERE ai_employee_id IN (SELECT id FROM ai_employee WHERE name = 'Wyatt' AND status != 'RETIRED');
UPDATE ai_employee SET layer = 'Investment' WHERE name = 'Poppy' AND status != 'RETIRED';
UPDATE ai_employee_profile SET department = 'Investment' WHERE ai_employee_id IN (SELECT id FROM ai_employee WHERE name = 'Poppy' AND status != 'RETIRED');
UPDATE ai_employee SET layer = 'Investment' WHERE name = 'Walter' AND status != 'RETIRED';
UPDATE ai_employee_profile SET department = 'Investment' WHERE ai_employee_id IN (SELECT id FROM ai_employee WHERE name = 'Walter' AND status != 'RETIRED');
UPDATE ai_employee SET layer = 'LP & fundraising' WHERE name = 'Piper' AND status != 'RETIRED';
UPDATE ai_employee_profile SET department = 'LP & fundraising' WHERE ai_employee_id IN (SELECT id FROM ai_employee WHERE name = 'Piper' AND status != 'RETIRED');
UPDATE ai_employee SET layer = 'LP & fundraising' WHERE name = 'Wesley' AND status != 'RETIRED';
UPDATE ai_employee_profile SET department = 'LP & fundraising' WHERE ai_employee_id IN (SELECT id FROM ai_employee WHERE name = 'Wesley' AND status != 'RETIRED');
UPDATE ai_employee SET layer = 'Portfolio & operations' WHERE name = 'Winter' AND status != 'RETIRED';
UPDATE ai_employee_profile SET department = 'Portfolio & operations' WHERE ai_employee_id IN (SELECT id FROM ai_employee WHERE name = 'Winter' AND status != 'RETIRED');
UPDATE ai_employee SET layer = 'Portfolio & operations' WHERE name = 'Parker' AND status != 'RETIRED';
UPDATE ai_employee_profile SET department = 'Portfolio & operations' WHERE ai_employee_id IN (SELECT id FROM ai_employee WHERE name = 'Parker' AND status != 'RETIRED');
UPDATE ai_employee SET layer = 'Portfolio & operations' WHERE name = 'Pippa' AND status != 'RETIRED';
UPDATE ai_employee_profile SET department = 'Portfolio & operations' WHERE ai_employee_id IN (SELECT id FROM ai_employee WHERE name = 'Pippa' AND status != 'RETIRED');
UPDATE ai_employee SET layer = 'Portfolio & operations' WHERE name = 'Pax' AND status != 'RETIRED';
UPDATE ai_employee_profile SET department = 'Portfolio & operations' WHERE ai_employee_id IN (SELECT id FROM ai_employee WHERE name = 'Pax' AND status != 'RETIRED');
UPDATE ai_employee SET layer = 'Portfolio & operations' WHERE name = 'Preston' AND status != 'RETIRED';
UPDATE ai_employee_profile SET department = 'Portfolio & operations' WHERE ai_employee_id IN (SELECT id FROM ai_employee WHERE name = 'Preston' AND status != 'RETIRED');

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0064_employee_layers_match_registry');

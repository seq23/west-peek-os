-- A pass is a decision, and a decision without its reason is worth nothing later.
--
-- The lifecycle already allows PASS and WITHDRAWN from every live stage — the machine was right.
-- What was missing was any way to reach it and anywhere to put the reason, so the operator could
-- not record that the firm had declined a company, and the "Passed" filter on Dealflow was
-- permanently zero.
--
-- For a venture fund the record of what it declined is half the value of the pipeline. "We passed
-- on this in August" is a fact; "we passed on this in August because the second founder had already
-- left and nobody would say why" is the thing you want in front of you when they come back raising.
--
-- The event spine carries the same reason, which is where the trail lives. This column exists so a
-- list of passed companies can show WHY without joining to events for every row.

ALTER TABLE investment_opportunity ADD COLUMN exit_reason TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0096_a_pass_carries_its_reason');

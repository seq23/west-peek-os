-- An employee can say "scrap this". Only a partner can scrap it.
--
-- Operator rule, 21 Aug 2026: "every arrival survives until i've seen it but it comes with a
-- recommendation to scrap it. however his proactive scout work he is allowed to scrap things on his
-- own. but never scrap our inbound stuff without our input."
--
-- WHY A FIELD ON THE DEAL AND NOT A PASS. The obvious implementation was to let the analyst pass it
-- outright and rely on the passed pile staying visible. That is one transition and no schema at
-- all — but it inverts the operator's rule. A pass means the deal has LEFT the funnel, so seeing
-- what was turned away becomes something you have to remember to go and look for, and the thing you
-- forget to look at is the thing that gets decided by nobody.
--
-- A recommendation keeps the deal exactly where a partner is already looking, carrying the analyst's
-- view and his reason, with the decision still theirs and one press either way. The judgement is
-- delivered; the authority is not moved.
--
-- `recommended_by` is a seat name rather than an id: this is a record of who advised, and it is read
-- by a person deciding, not joined to anything.
--
-- Nothing here changes the status spine. A deal carrying "pass" is still at whatever stage it was
-- at, because a recommendation is not a state.

ALTER TABLE investment_opportunity ADD COLUMN recommendation TEXT
  CHECK (recommendation IS NULL OR recommendation IN ('PASS','LOOK_CLOSER'));
ALTER TABLE investment_opportunity ADD COLUMN recommendation_note TEXT;
ALTER TABLE investment_opportunity ADD COLUMN recommended_by TEXT;
ALTER TABLE investment_opportunity ADD COLUMN recommended_at TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0103_a_recommendation_is_not_a_decision');

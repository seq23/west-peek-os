-- Let a weekly-review item point at the work it produced.
--
-- The six exits canon §8 defines — DECISION, OWNER, DEADLINE, DELEGATED_ACTION, DEFERRED,
-- CLOSED — updated a column and stopped there. So a partner made a real call in a real meeting,
-- marked it DELEGATED_ACTION, and the system forgot by Thursday. OWNER, DEADLINE and
-- DELEGATED_ACTION now raise a work card, and the item records which one, so the review is
-- traceable forward to the work as well as backward to the evidence.
--
-- Nullable, because three of the six exits correctly raise nothing: a DECISION is itself the
-- artifact, CLOSED is the absence of further work, and DEFERRED returns on next week's agenda
-- rather than becoming a task.
ALTER TABLE weekly_review_item ADD COLUMN work_card_id TEXT REFERENCES work_card (id);

-- How many consecutive weeks this item has been deferred.
--
-- Deferred items now carry forward automatically, which is what the operator asked for and is the
-- honest behaviour: an item nobody decided has not gone away. But automatic carry-forward without a
-- count is how an agenda silently accumulates — "deferred three times" is itself the finding, and
-- is far more useful than the item's own text by that point.
ALTER TABLE weekly_review_item ADD COLUMN deferred_count INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0066_weekly_review_followthrough');

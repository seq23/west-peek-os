-- 0231 — a plan lives on the card, not in Documents (Addendum 2/4.3, 22 Sep 2026).
--
-- Her words: "plans for work to be done are not like real documents, like an LP deck or
-- something." Decided in Addendum 4.3: a card's PLAN stops being filed to `document`/Documents at
-- all — not hidden-but-kept, removed from that pipeline entirely. It lives where the card's own
-- trail already shows it.
--
-- BEFORE THIS MIGRATION, the PLAN text existed in exactly one queryable place: the `deliverable`
-- row `applyPlan()` filed (kind `employee_finding`, `source_type = 'work_card_plan'`), which
-- `deliver()` then uploaded as a `document` with `doc_type = 'BRIEF'` — the write this plan stops.
-- Reading the plan back for the block/ask email and the BUILD job's payload went through
-- `plan_deliverable_id → deliverable.body`, which is gone the moment the deliverable stops being
-- filed. So the plan's own text moves onto `web_property_change` directly: one column, always
-- readable from the row that already carries every other fact about this phase, with no second
-- table and no filing step that can fail silently (`deliver()`'s own comment: "filing is
-- best-effort and visible" — the plan no longer needs that hedge because it is not filed).
--
-- `plan_deliverable_id` and `plan_document_id` are UNTOUCHED and kept: additive-only, and a card
-- planned before this migration still has its Document and can still open it — old data is not
-- rewritten. New PLAN runs after this migration leave both columns null and write `plan_text`
-- instead; `WebPropertyChangePanel.tsx` reads whichever one the row actually has.

ALTER TABLE web_property_change ADD COLUMN plan_text TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0231_a_plan_lives_on_the_card_not_in_documents');

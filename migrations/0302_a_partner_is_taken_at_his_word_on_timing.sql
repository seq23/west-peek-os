-- 0302 — A partner is taken at his word on timing (owner, 13 Nov 2026).
--
-- A partner answered a preview: "i will come back with edits this weekend." The card would still
-- have reminded him the next morning. When the partner who asked says when he will be back, the
-- card records it (the time, and his words) and no reminder about the block goes out before that
-- time has passed (`resurfaceStaleBlocks` in src/worker/services/blocks.ts reads these columns;
-- `partnerBackIn` in src/shared/work/partnerBackBy.ts reads his sentence).

ALTER TABLE work_card ADD COLUMN partner_back_at TEXT;
ALTER TABLE work_card ADD COLUMN partner_back_words TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0302_a_partner_is_taken_at_his_word_on_timing');

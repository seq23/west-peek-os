-- 0275 · ONE BRAND PER CATEGORY AT A TIME, AND 25–40 GUESTS (owner, 26 Oct 2026). services/learningClub.ts.
-- Two brands in the same category for the same club are never pitched at the same time: the second waits until the
-- first declines or goes quiet after its one follow-up (`categoryRival`). And every club's room is the standard
-- 25–40 guests, flexible to the partners' goals; the records that said otherwise are aligned.
INSERT OR IGNORE INTO tlc_wynn_rule (id, code, rule, source) VALUES
  ('wr_one_per_category', 'ONE_PER_CATEGORY',
   'Two brands in the same category for the same event are never pitched at the same time. Hold the second until the first declines or goes quiet after its one follow-up.',
   'her rule to the coordinator, 26 Oct 2026');

UPDATE tlc_event SET seats_min = 25, seats_max = 40 WHERE seats_min IS NOT NULL OR seats_max IS NOT NULL;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0275_wynn_one_brand_per_category');

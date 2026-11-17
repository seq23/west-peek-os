-- 0312 · WHAT THE BUILD ANSWERED GOES IN THE PARTNER'S PREVIEW EMAIL (17 Nov 2026, wc_c548d043).
--
-- Scooter asked Porter to confirm what was done, what was left and the estimate, and whether there was a better
-- approach for the logo strip. The BUILD answered in its notes; the preview email carried only the link and the
-- technical proof. The answers are kept on the row and printed in the preview email.
--
-- Additive: one new nullable column. Nothing is rewritten.
ALTER TABLE web_property_change ADD COLUMN build_answers TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0312_porter_build_answers');

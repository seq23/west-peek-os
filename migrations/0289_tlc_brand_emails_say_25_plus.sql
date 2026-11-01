-- 0289 · AN EMAIL TO A BRAND SAYS "ROOMS OF 25+ GUESTS" (owner, 1 Nov 2026). shared/tlc/learningClub.ts
-- (BRAND_EMAIL_ROOM_WORDS), services/tlcBrandReply.ts (draftProblems). Data only.
--   · Wynn's standing rule (GUESTS_25_40, last set by 0281 to "25 to 100+") now says 25+ for every email to a brand:
--     pitches, the follow-up and every answer. Our materials (the samples PDF, the brand pitch PDF) keep 25 to 100+.
--   · Same release: every brand email ends with our mailing address (shared/tlc/brandFooter.ts); no data change.
UPDATE tlc_wynn_rule SET rule = 'Every email to a brand says rooms of 25+ guests, sized to the brand''s goals; never a range such as 25 to 100+, 25–40 or 60–150 (the samples and pitch PDFs say 25 to 100+).'
 WHERE code = 'GUESTS_25_40';

-- Loud, not silent: any GUESTS_25_40 row still in its old words fails the migration.
CREATE TABLE migration_guard_0289 (stale INTEGER NOT NULL CHECK (stale = 0));
INSERT INTO migration_guard_0289 (stale)
SELECT COUNT(*) FROM tlc_wynn_rule WHERE code = 'GUESTS_25_40' AND rule NOT LIKE 'Every email to a brand says rooms of 25+ guests%';
DROP TABLE migration_guard_0289;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0289_tlc_brand_emails_say_25_plus');

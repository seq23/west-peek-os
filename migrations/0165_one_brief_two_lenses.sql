-- 0165 · one brief, two lenses (15 Sep 2026)
--
-- THE AUDIT. The operator asked whether Scooter's daily brief is built to the same standard as
-- Sequoia's. In code it always was: one template, one required-section list, one verifier, no
-- partner-specific branch anywhere. What differed on the page that morning was the PROMPT VERSION —
-- Scooter's 2026-09-15 brief was written by daily-intelligence-v4 at 12:29 UTC, six hours before the
-- staged v5 pipeline shipped; Sequoia's was v5 at 19:03. His had no numbered citations, no dashboard
-- table, no capital-markets section, no watchlist, no Sources footer, and the old headings.
--
-- THE ONLY INTENDED DIFFERENCE IS EMPHASIS, and until now it was implicit: it fell out of whatever
-- sectors and themes a partner had typed into their interests, and the prompt said nothing about
-- which way the brief should lean. Now it is a named LENS on the profile — `investing` (markets,
-- VC and private markets, secondaries, legal, AI) or `growth` (marketing, growth, brand, creator
-- economy, community, events, go-to-market) — said to the model as "this partner's lens" and
-- printed on the report's header as "Edition: Scooter — marketing & growth lens". The section set,
-- the dashboard, the Top 5 and the West Peek read-throughs are identical for every partner.
--
-- Scooter's lens is seeded because the operator named it; every other partner defaults to the
-- fund's own lens and can change it on the Home page under "What my brief covers".
ALTER TABLE partner_intelligence_profile ADD COLUMN lens TEXT NOT NULL DEFAULT 'investing'
  CHECK (lens IN ('investing', 'growth'));

INSERT OR IGNORE INTO partner_intelligence_profile (firm_user_id, timezone, lens)
  SELECT id, 'America/New_York', 'growth' FROM firm_user WHERE id = 'fu_scooter_taylor';
UPDATE partner_intelligence_profile SET lens = 'growth' WHERE firm_user_id = 'fu_scooter_taylor';

-- The header line, written by the system at the moment the brief is persisted, so the page and the
-- filed copy both say whose edition it is without re-deriving it from a profile that may since
-- have changed.
ALTER TABLE intelligence_report ADD COLUMN edition TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0165_one_brief_two_lenses');

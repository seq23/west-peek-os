-- 0257 — The preview email links the pages that changed, not only the site root (9 Oct 2026).
--
-- WHAT WENT WRONG. Scooter's "New preview ready" email for voting.topbarz.xyz linked only
-- https://work-wpc-739461bd.topbarz-voting.pages.dev — the root — when the pages that changed were
-- /entry and /rules. Sequoia had to send a follow-up note with the two links by hand.
--
-- WHAT THIS ADDS. The Mac now reports the PR's changed files (`gh pr view --json files`); the Worker
-- reads them into public page paths (`pagePathsFrom`: public/entry.html → /entry, functions/* → no
-- page) and keeps them here, so every preview line carries the root plus one link per changed page.
-- NULL on a row built before this (the root link alone, as before).

ALTER TABLE web_property_change ADD COLUMN changed_pages_json TEXT;
ALTER TABLE web_property_change_part ADD COLUMN changed_pages_json TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0257_the_preview_links_the_changed_pages');

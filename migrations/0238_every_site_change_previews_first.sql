-- 0238 — Every web property change previews first (owner, 23 Sep 2026).
--
-- HER DECISION: "we should default to preview first for all repo work". From this migration on,
-- `openWebPropertyChange` writes `web_property_change.preview_only = 1` on every open, whatever the
-- request said; the only way past the preview is the named force ("approved to production" →
-- `recordForce`, which sets `forced_by` and leaves `preview_only` alone). This backfills the same
-- default onto every change not yet merged, so work already in flight stops at a preview link too.
--
-- A MERGED ROW IS NEVER TOUCHED: its landing is history, and 0220's trigger (BEFORE UPDATE OF
-- merge_sha) keys on this column. This UPDATE does not touch merge_sha or forced_by, so neither
-- 0220 trigger fires; a row already forced keeps `forced_by` and still lands on green.
--
-- NOT `work_card.preview_first`. That column is "hold the finished result for me before it goes to
-- the recipient" on every kind; setting it on these cards would route Porter's RECEIVED / PLAN /
-- PREVIEW / QUESTION / STUCK notices into the preview lane (see webPropertyChange.ts `tellRequester`).
UPDATE web_property_change SET preview_only = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE merge_sha IS NULL AND preview_only = 0;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0238_every_site_change_previews_first');

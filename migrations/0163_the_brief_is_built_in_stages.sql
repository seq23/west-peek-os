-- 0163 · the brief is built in stages, and the numbers on it are fetched, not remembered
--        (15 Sep 2026)
--
-- WHAT PRODUCTION SHOWED TODAY. Sequoia's brief failed seven ticks in a row, 14:14–16:04 UTC:
-- "abandoned part-way", no ai_run behind any attempt — the invocation died BEFORE the model was
-- ever called, in gather → dedupe → rank over 462 items, which is O(n²) title similarity on a
-- 10 ms CPU budget. Scooter's succeeded at 12:26 only because fewer items had accrued by then.
--
-- THE FIX IS SHAPE, NOT SPEED. A brief is now three stages, each one cron tick:
--   GATHERING → (ranked; candidates stored on the row)      status RANKING
--            → (levels fetched and read; stored on the row) status GENERATING
--            → (written, verified, persisted)               status READY
-- `candidates_json` and `market_json` carry the work between ticks; `stage_at` is when the row
-- last moved, so an abandoned run is judged by its last movement rather than its start; and
-- `stage_lease_until` is the lock — the cron fires every minute and a stage that calls a model
-- takes longer than that.
--
-- THE NUMBERS. The operator's example brief carries a dashboard — 10-year, Brent, WTI, Fed odds,
-- futures, dollar, bitcoin. Those must be fetched, not remembered: `macro_reading` holds each
-- figure with the URL it was read from and the date it is AS OF. Where a figure cannot be
-- fetched the brief says so rather than inventing one.
ALTER TABLE intelligence_report ADD COLUMN candidates_json TEXT;
ALTER TABLE intelligence_report ADD COLUMN market_json TEXT;
ALTER TABLE intelligence_report ADD COLUMN stage_at TEXT;
ALTER TABLE intelligence_report ADD COLUMN stage_lease_until TEXT;

CREATE TABLE IF NOT EXISTS macro_reading (
  id             TEXT PRIMARY KEY,
  -- A short key: US10Y, BRENT, WTI, DXY_BROAD, BTC_USD. The label a partner reads is in code.
  instrument     TEXT NOT NULL,
  -- As displayed, verbatim from the source: "4.12" / "67.34". Never rounded here.
  value          TEXT NOT NULL,
  numeric_value  REAL,
  -- The date the source says the figure is AS OF (a FRED daily series lags a business day).
  as_of          TEXT NOT NULL,
  source_url     TEXT NOT NULL,
  source_name    TEXT NOT NULL,
  fetched_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  UNIQUE (firm_scope, instrument, as_of)
);
CREATE INDEX IF NOT EXISTS idx_macro_reading_latest ON macro_reading (firm_scope, instrument, fetched_at);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0163_the_brief_is_built_in_stages');

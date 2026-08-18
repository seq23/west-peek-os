-- 0040_market_mapping.sql — P46: the Market Mapping Room (V1 #33).
--
-- Renamed from "Market Intelligence Room" on operator direction, 17 Aug 2026, and the new name is
-- the clearer brief: a partner needs to know WHICH COMPANIES EXIST in a sector or subsector and HOW
-- BIG THEY ARE — raised, stage, valuation.
--
-- THE RULE THIS SCHEMA ENFORCES: every figure carries where it came from, and an unknown stays
-- unknown. A market map with three confident invented valuations is worse than one with three
-- blanks, because the blanks get checked and the inventions get quoted in a partner meeting. Hence
-- `*_source` beside each fact and nullable numbers throughout — NULL means "we do not know", which
-- is a real and common answer.
--
-- COVERAGE IS STATED, NOT IMPLIED. `coverage_note` records what the map could not see. Free sources
-- reach maybe 60–80% of a US sector and less internationally; a map that hides that reads as
-- exhaustive and gets used as if it were.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0040_market_mapping');

CREATE TABLE IF NOT EXISTS mkt_map (
  id             TEXT PRIMARY KEY,
  sector         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'BUILDING'
                 CHECK (status IN ('BUILDING','READY','FAILED')),
  -- The subsegments the sector was divided into, as a JSON array of strings. The panels of the map.
  segments_json  TEXT NOT NULL DEFAULT '[]',
  company_count  INTEGER NOT NULL DEFAULT 0,
  -- What this map could NOT see. Always populated on a READY map.
  coverage_note  TEXT,
  sources_used   TEXT NOT NULL DEFAULT '[]',
  ai_run_id      TEXT REFERENCES ai_run (id),
  error_message  TEXT,
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_mkt_map_created ON mkt_map (created_at DESC);

CREATE TABLE IF NOT EXISTS mkt_map_company (
  id             TEXT PRIMARY KEY,
  map_id         TEXT NOT NULL REFERENCES mkt_map (id),
  name           TEXT NOT NULL,
  -- Which panel of the map this company sits in.
  segment        TEXT NOT NULL DEFAULT 'Unsegmented',
  description    TEXT,
  -- Every one of these may be NULL. Unknown is a legitimate value and the UI renders it as such.
  stage          TEXT,
  total_raised_usd  REAL,
  last_round_usd    REAL,
  last_round_date   TEXT,
  valuation_usd     REAL,
  investors      TEXT,
  website        TEXT,
  -- Where each fact came from: 'FIRM_RECORD' | 'SWEPT_NEWS' | 'SEC_FORM_D' | 'WEB_SEARCH'.
  -- A figure with no source is not displayed as a figure.
  funding_source TEXT,
  source_url     TEXT,
  -- Links to the firm's own record when this is a company we already know.
  company_id     TEXT REFERENCES canonical_company (id),
  -- True when the firm holds a position or has an open opportunity. Worth seeing on the map.
  is_ours        INTEGER NOT NULL DEFAULT 0 CHECK (is_ours IN (0,1)),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (map_id, name)
);

CREATE INDEX IF NOT EXISTS idx_mkt_map_company ON mkt_map_company (map_id, segment);

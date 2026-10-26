-- 0277 · MORE SPONSOR VOLUME FOR THE LEARNING CLUB (owner, 26 Oct 2026). shared/tlc/volume.ts, services/tlcVolume.ts.
-- Parker's list of about 35 brands per club (about 5 Title/Presenting candidates, about 30 Partner/Lead/Product),
-- each address checked with NeverBounce before any first email; Wynn starts about 10 new brands per club per week,
-- nearest club first, and stops a club's outreach once its committed sponsor cash reaches $25,000.
-- No brand row is written here: the list lives only in the production database (public repo).

CREATE TABLE IF NOT EXISTS tlc_prospect (
  id                 TEXT PRIMARY KEY,
  event_id           TEXT NOT NULL REFERENCES tlc_event(id),
  brand              TEXT NOT NULL,
  band               TEXT NOT NULL CHECK (band IN ('TITLE','PARTNER')),
  category           TEXT,
  contact_name       TEXT,
  contact_email      TEXT NOT NULL,
  contact_source_url TEXT NOT NULL,
  why_fit            TEXT,
  rank               INTEGER NOT NULL DEFAULT 100,
  added_by           TEXT NOT NULL DEFAULT 'aie_parker',
  added_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deal_id            TEXT,
  promoted_at        TEXT,
  dropped_reason     TEXT,
  firm_scope         TEXT NOT NULL DEFAULT 'west-peek',
  UNIQUE (event_id, brand)
);
CREATE INDEX IF NOT EXISTS idx_tlc_prospect_ready ON tlc_prospect (event_id, promoted_at, dropped_reason);

-- One row per address: NeverBounce's answer, or 'bounced' for good once a real email to it bounced.
CREATE TABLE IF NOT EXISTS tlc_address_check (
  email      TEXT PRIMARY KEY,
  result     TEXT NOT NULL CHECK (result IN ('valid','invalid','disposable','catchall','unknown','bounced')),
  source     TEXT NOT NULL CHECK (source IN ('neverbounce','bounce')),
  checked_at TEXT NOT NULL,
  detail     TEXT
);

INSERT OR IGNORE INTO tlc_wynn_rule (id, code, rule, source) VALUES
  ('wr_ten_a_week', 'TEN_A_WEEK',
   'Pitch about 10 new brands per event per week, the nearest event first, from Parker''s list of about 35 (about 5 Title or Presenting candidates, about 30 Partner, Lead or Product).',
   'her goal to the coordinator, 26 Oct 2026'),
  ('wr_stop_at_goal', 'STOP_AT_GOAL',
   'Once an event''s agreed sponsor cash reaches $25,000, stop that event''s outreach.',
   'her goal to the coordinator, 26 Oct 2026'),
  ('wr_verify_address', 'VERIFY_ADDRESS',
   'Check every address with NeverBounce before the first email. Never write to an invalid or unknown address, and never follow up to a bounce.',
   'her goal to the coordinator, 26 Oct 2026');

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0277_tlc_sponsor_volume');

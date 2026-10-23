-- 0266_tlc_brands_we_must_pitch.sql — "Brands we must pitch", per Learning Club month.
--
-- Owner, 23 Oct 2026: "are we reaching out to anthropic i think that is important and google?"
-- Until now Wynn's Monday brand batch let the model choose up to five brands per club and dropped any
-- brand whose address was not printed on a live page, so a brand she named was never guaranteed.
--
--   1. tlc_must_pitch — her list, one row per (month, brand), with a one-line reason. Every brand
--      batch handles these FIRST, outside the five-per-club cap. Removing one keeps the row, marked
--      with who removed it and when.
--   2. tlc_way_in — one row per brand that has no public address yet ("Needs a way in"). It names
--      the months and the pages Wynn checked. She may add a name and an address herself, which skips
--      the page check because she supplied it. Re-checked each weekly batch; it resurfaces only when
--      something changes (changed_at), never on a timer.
--   3. tlc_must_pitch_log — every add, remove, contact and finding, who and when. Append only.
--
-- The address check (read off the page, never guessed) and the send path (drip, gate, per-email
-- approval) are unchanged. Additive only. The seeds are the owner's own targets: brand names and a
-- reason, no contact, no amount.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0266_tlc_brands_we_must_pitch');

CREATE TABLE IF NOT EXISTS tlc_must_pitch (
  id          TEXT PRIMARY KEY,
  month       TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  brand       TEXT NOT NULL,
  reason      TEXT NOT NULL,
  added_by    TEXT NOT NULL,
  added_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  removed_by  TEXT,
  removed_at  TEXT,
  firm_scope  TEXT NOT NULL DEFAULT 'west-peek'
);
-- One live row per brand per month; a removed row stays and does not block adding it back.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tlc_must_pitch_live ON tlc_must_pitch (firm_scope, month, lower(brand)) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS tlc_way_in (
  brand_key          TEXT NOT NULL,
  brand              TEXT NOT NULL,
  firm_scope         TEXT NOT NULL DEFAULT 'west-peek',
  state              TEXT NOT NULL CHECK (state IN ('OPEN','CONTACT_ADDED','FOUND')),
  months_json        TEXT NOT NULL DEFAULT '[]',
  pages_checked_json TEXT NOT NULL DEFAULT '[]',
  why                TEXT,
  opened_at          TEXT NOT NULL,
  checked_at         TEXT NOT NULL,
  changed_at         TEXT NOT NULL,
  hidden_at          TEXT,          -- the changed_at of the version she hid; it is back on Approvals once changed_at moves past it
  hidden_by          TEXT,
  contact_name       TEXT,
  contact_email      TEXT,
  note               TEXT,
  supplied_by        TEXT,
  supplied_at        TEXT,
  PRIMARY KEY (firm_scope, brand_key)
);

CREATE TABLE IF NOT EXISTS tlc_must_pitch_log (
  id          TEXT PRIMARY KEY,
  brand       TEXT NOT NULL,
  month       TEXT,
  action      TEXT NOT NULL CHECK (action IN ('ADDED','REMOVED','NO_ADDRESS','FOUND','CONTACT_ADDED','QUEUED')),
  by_who      TEXT NOT NULL,
  at          TEXT NOT NULL,
  detail      TEXT,
  firm_scope  TEXT NOT NULL DEFAULT 'west-peek'
);
CREATE INDEX IF NOT EXISTS idx_tlc_must_pitch_log_at ON tlc_must_pitch_log (firm_scope, at);

CREATE TRIGGER IF NOT EXISTS tlc_must_pitch_never_deleted BEFORE DELETE ON tlc_must_pitch
BEGIN
  SELECT RAISE(ABORT, 'a must-pitch brand is removed by marking it, never deleted');
END;
CREATE TRIGGER IF NOT EXISTS tlc_must_pitch_log_append_only BEFORE DELETE ON tlc_must_pitch_log
BEGIN
  SELECT RAISE(ABORT, 'the must-pitch log is append only');
END;

-- The owner's own targets (23 Oct 2026). Fragrance Lab (Feb) keeps its AI segment and AI partner category;
-- FORVR Mood is a sponsor target beside them, not a change to the club.
INSERT OR IGNORE INTO tlc_must_pitch (id, month, brand, reason, added_by, added_at) VALUES
  ('tmp_seed_202701_anthropic', '2027-01', 'Anthropic', 'AI partner for The Longevity Reset; Title partner if the backup club, AI Tools for Your Work, runs.', 'Sequoia', '2026-10-23T00:00:00.000Z'),
  ('tmp_seed_202702_forvr_mood', '2027-02', 'FORVR Mood', 'Owner''s pick: a scrappy challenger fragrance brand competing with the big houses. Title or Presenting.', 'Sequoia', '2026-10-23T00:00:00.000Z'),
  ('tmp_seed_202703_anthropic', '2027-03', 'Anthropic', 'The AI model for Build Your Own AI Agent.', 'Sequoia', '2026-10-23T00:00:00.000Z'),
  ('tmp_seed_202703_google', '2027-03', 'Google', 'Google for Startups / Google Cloud: startup cloud credits and the host venue for Build Your Own AI Agent.', 'Sequoia', '2026-10-23T00:00:00.000Z');

INSERT OR IGNORE INTO tlc_must_pitch_log (id, brand, month, action, by_who, at, detail) VALUES
  ('tmpl_seed_202701_anthropic', 'Anthropic', '2027-01', 'ADDED', 'Sequoia', '2026-10-23T00:00:00.000Z', 'AI partner; Title partner if the backup runs'),
  ('tmpl_seed_202702_forvr_mood', 'FORVR Mood', '2027-02', 'ADDED', 'Sequoia', '2026-10-23T00:00:00.000Z', 'Title or Presenting'),
  ('tmpl_seed_202703_anthropic', 'Anthropic', '2027-03', 'ADDED', 'Sequoia', '2026-10-23T00:00:00.000Z', 'AI model'),
  ('tmpl_seed_202703_google', 'Google', '2027-03', 'ADDED', 'Sequoia', '2026-10-23T00:00:00.000Z', 'Google for Startups / Google Cloud');

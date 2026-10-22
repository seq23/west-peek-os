-- 0262_tlc_research_library.sql — the Learning Club's research library, on the Rooms page.
--
-- Owner, 22 Oct 2026: "can we find a section in rooms to keep this kind of research to pull from in
-- created TLC edition rooms?" Wynn's trend story (each fact with its source and date), brand-spend
-- findings, trend and curiosity notes, and regulatory checks are kept here, dated and labelled by kind.
-- Parker and Wynn read it whenever they build a TLC room, a booking pack or a brand batch. Background
-- material, not a decision: it is never emailed on its own. Rows are never deleted.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0262_tlc_research_library');

CREATE TABLE tlc_research (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('TREND_STORY','BRAND_SPEND','TREND','REGULATORY')),
  title         TEXT NOT NULL,
  body          TEXT,
  topic         TEXT,
  source_title  TEXT,
  source_url    TEXT,
  published_on  TEXT,
  found_at      TEXT NOT NULL,
  found_by      TEXT NOT NULL,
  card_id       TEXT,
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_tlc_research_kind ON tlc_research (firm_scope, kind, found_at);

CREATE TRIGGER tlc_research_never_deleted BEFORE DELETE ON tlc_research
BEGIN
  SELECT RAISE(ABORT, 'the research library keeps every entry; nothing is deleted');
END;

-- Every trend-story fact already on file becomes a library entry, with its source and date.
INSERT INTO tlc_research (id, kind, title, body, source_title, source_url, published_on, found_at, found_by, card_id, firm_scope)
SELECT 'tlr_' || s.id, 'TREND_STORY', s.claim, NULL, s.title || CASE WHEN s.publisher IS NOT NULL THEN ', ' || s.publisher ELSE '' END, s.url, s.published_on, s.checked_at, 'Wynn', t.card_id, 'west-peek'
  FROM tlc_source s JOIN tlc_story t ON t.id = s.story_id;

-- And each story itself, whole, as the entry the facts above belong to.
INSERT INTO tlc_research (id, kind, title, body, found_at, found_by, card_id, firm_scope)
SELECT 'tlr_' || id, 'TREND_STORY', 'Trend story ' || quarter, story, created_at, 'Wynn', card_id, 'west-peek' FROM tlc_story;

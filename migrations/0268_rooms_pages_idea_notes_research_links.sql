-- 0268_rooms_pages_idea_notes_research_links.sql — the Rooms & Events redesign (owner approved the
-- v8 mock-up, 23 Oct 2026). Additive only: two new tables, and seed rows that are added only where the
-- idea they belong to already exists (so a fresh test database gets none). Nothing is deleted or
-- rewritten.
--
--   1. tlc_idea_note — a note under an idea, with who wrote it and when. Never edited, never deleted.
--      Seeded with the owner's 23 Oct 2026 angles, each on the closest idea already on the list, and
--      two notes from the title-sponsor research that fold into ideas already there (no duplicates).
--   2. tlc_research_link — the Research library's "Research pages": a title and an https:// link.
--      Seeded with the two research pages of 23 Oct 2026.
--   3. Three ideas from the title-sponsor research that are not on the list under any name, added
--      only on a firm that already has the list.
--
-- Room sponsors now wait PARKED until the Room is scheduled (src/worker/services/roomPacket.ts);
-- the live rows were parked by hand on 23 Oct 2026, so no data change is needed for that here.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0268_rooms_pages_idea_notes_research_links');

CREATE TABLE IF NOT EXISTS tlc_idea_note (
  id          TEXT PRIMARY KEY,
  idea_id     TEXT NOT NULL REFERENCES tlc_idea(id),
  body        TEXT NOT NULL CHECK (length(body) BETWEEN 2 AND 600),
  author      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  firm_scope  TEXT NOT NULL DEFAULT 'west-peek'
);
CREATE INDEX IF NOT EXISTS tlc_idea_note_by_idea ON tlc_idea_note (idea_id, created_at);

CREATE TRIGGER IF NOT EXISTS tlc_idea_note_never_deleted BEFORE DELETE ON tlc_idea_note
BEGIN
  SELECT RAISE(ABORT, 'a note on a TLC idea is never deleted');
END;

CREATE TABLE IF NOT EXISTS tlc_research_link (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  url         TEXT NOT NULL CHECK (url LIKE 'https://%'),
  added_by    TEXT NOT NULL,
  added_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  firm_scope  TEXT NOT NULL DEFAULT 'west-peek'
);

INSERT OR IGNORE INTO tlc_research_link (id, title, url, added_by, added_at) VALUES
  ('trl_seed_title_sponsors', 'Title sponsors: who pays $25K alone', 'https://claude.ai/artifact/7632jc1TJSg7wbMzMrYkbA', 'Sequoia', '2026-10-23T12:00:00.000Z'),
  ('trl_seed_fragrance_ai', 'Fragrance & AI sponsors', 'https://claude.ai/artifact/8iuxFJ3KbmPrcUCeWbTkxW', 'Sequoia', '2026-10-23T12:05:00.000Z');

-- The owner's angles, 23 Oct 2026, each on the closest idea already listed (matched by topic_key).
-- One statement per note: D1 caps the terms in a compound SELECT.
INSERT OR IGNORE INTO tlc_idea_note (id, idea_id, body, author, created_at, firm_scope)
  SELECT 'tln_seed_20261023_matcha', id, 'Matcha making.', 'Sequoia', '2026-10-23T12:00:00.000Z', firm_scope
    FROM tlc_idea WHERE topic_key = 'matcha and tea' AND firm_scope = 'west-peek';
INSERT OR IGNORE INTO tlc_idea_note (id, idea_id, body, author, created_at, firm_scope)
  SELECT 'tln_seed_20261023_grow_food', id, 'Growing food in any size space.', 'Sequoia', '2026-10-23T12:00:00.000Z', firm_scope
    FROM tlc_idea WHERE topic_key = 'grow your own food security in a nyc apartment' AND firm_scope = 'west-peek';
INSERT OR IGNORE INTO tlc_idea_note (id, idea_id, body, author, created_at, firm_scope)
  SELECT 'tln_seed_20261023_ai_trading', id, 'AI for trading stocks, bonds and crypto, and how hands-off it can be.', 'Sequoia', '2026-10-23T12:00:00.000Z', firm_scope
    FROM tlc_idea WHERE topic_key = 'trading and investing money reset' AND firm_scope = 'west-peek';
INSERT OR IGNORE INTO tlc_idea_note (id, idea_id, body, author, created_at, firm_scope)
  SELECT 'tln_seed_20261023_longevity', id, 'Biohacking and peptides (glutathione, NAD+) for getting healthy and hot.', 'Sequoia', '2026-10-23T12:00:00.000Z', firm_scope
    FROM tlc_idea WHERE topic_key = 'the longevity reset' AND firm_scope = 'west-peek';
INSERT OR IGNORE INTO tlc_idea_note (id, idea_id, body, author, created_at, firm_scope)
  SELECT 'tln_seed_20261023_ai_agents', id, 'Everyday AI agents for your own life.', 'Sequoia', '2026-10-23T12:00:00.000Z', firm_scope
    FROM tlc_idea WHERE topic_key = 'build your own ai agent' AND firm_scope = 'west-peek';
INSERT OR IGNORE INTO tlc_idea_note (id, idea_id, body, author, created_at, firm_scope)
  SELECT 'tln_seed_20261023_sewing', id, 'Sewing for survival.', 'Sequoia', '2026-10-23T12:00:00.000Z', firm_scope
    FROM tlc_idea WHERE topic_key = 'sewing and visible mending' AND firm_scope = 'west-peek';
INSERT OR IGNORE INTO tlc_idea_note (id, idea_id, body, author, created_at, firm_scope)
  SELECT 'tln_seed_20261023_mahjong', id, 'Mahjong: it''s trendy.', 'Sequoia', '2026-10-23T12:00:00.000Z', firm_scope
    FROM tlc_idea WHERE topic_key = 'mahjong learn to play' AND firm_scope = 'west-peek';

-- The title-sponsor research (23 Oct 2026): two of its ideas are ideas already listed.
INSERT OR IGNORE INTO tlc_idea_note (id, idea_id, body, author, created_at, firm_scope)
  SELECT 'tln_seed_20261023_film_night', id, 'The research''s "Make a Film in a Night" is this idea: Runway is the title brand to pitch.', 'Research (title sponsors, 23 Oct)', '2026-10-23T12:10:00.000Z', firm_scope
    FROM tlc_idea WHERE topic_key = 'make a music video in a night' AND firm_scope = 'west-peek';
INSERT OR IGNORE INTO tlc_idea_note (id, idea_id, body, author, created_at, firm_scope)
  SELECT 'tln_seed_20261023_sleep_lab', id, 'The research''s "Sleep Lab" is this idea: Eight Sleep is the title brand to pitch.', 'Research (title sponsors, 23 Oct)', '2026-10-23T12:10:00.000Z', firm_scope
    FROM tlc_idea WHERE topic_key = 'sleep and recovery' AND firm_scope = 'west-peek';

-- Three research ideas not on the list under any name. Only on a firm that already has the list.
INSERT OR IGNORE INTO tlc_idea (id, topic, topic_key, note, origin, suggested_by, suggested_at, source_ref, status, firm_scope)
  SELECT 'tli_seed_ai_glasses', 'AI Glasses Night', 'ai glasses night', 'Title brand to pitch: Meta (its AI glasses). From the title-sponsor research, 23 Oct.', 'BRANDS_SPENDING', 'Research (title sponsors, 23 Oct)', '2026-10-23T12:10:00.000Z', 'trl_seed_title_sponsors', 'LATER', 'west-peek'
   WHERE EXISTS (SELECT 1 FROM tlc_idea WHERE topic_key = 'the longevity reset' AND firm_scope = 'west-peek');
INSERT OR IGNORE INTO tlc_idea (id, topic, topic_key, note, origin, suggested_by, suggested_at, source_ref, status, firm_scope)
  SELECT 'tli_seed_ai_sales', 'Your AI Sales Machine', 'your ai sales machine', 'Title brand to pitch: Clay. From the title-sponsor research, 23 Oct.', 'BRANDS_SPENDING', 'Research (title sponsors, 23 Oct)', '2026-10-23T12:10:00.000Z', 'trl_seed_title_sponsors', 'LATER', 'west-peek'
   WHERE EXISTS (SELECT 1 FROM tlc_idea WHERE topic_key = 'the longevity reset' AND firm_scope = 'west-peek');
INSERT OR IGNORE INTO tlc_idea (id, topic, topic_key, note, origin, suggested_by, suggested_at, source_ref, status, firm_scope)
  SELECT 'tli_seed_run_life', 'Run Your Life Like a Company', 'run your life like a company', 'Title brand to pitch: Ramp. From the title-sponsor research, 23 Oct.', 'BRANDS_SPENDING', 'Research (title sponsors, 23 Oct)', '2026-10-23T12:10:00.000Z', 'trl_seed_title_sponsors', 'LATER', 'west-peek'
   WHERE EXISTS (SELECT 1 FROM tlc_idea WHERE topic_key = 'the longevity reset' AND firm_scope = 'west-peek');

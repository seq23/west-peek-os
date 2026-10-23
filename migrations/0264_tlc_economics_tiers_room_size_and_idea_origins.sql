-- 0264_tlc_economics_tiers_room_size_and_idea_origins.sql — owner rulings, 22 Oct 2026.
--
-- 1. Tiers: Title $25,000, Partner $5,000, Lead $10,000, Presenting $15,000, and Product partner
--    (in kind). `tlc_deal.tier` was added in 0263 with only two values and is still empty
--    everywhere (checked before this shipped), so it is dropped and re-added with all five.
-- 2. Room size and sponsor goal per club: NULL means the defaults (25–40 people, $25,000 goal,
--    so a $15,000 cost budget). The partners set them on the event.
-- 3. Idea origins: SUGGESTED_LIST, "Suggested list (written by the assistant, 22 Oct)". The eleven
--    topics on the planning-document list that was emailed from the owner's address on 22 Oct were
--    recorded as the partners' own ideas, credited to "Sequoia and Scooter". Neither partner wrote
--    that list. They are relabelled here, matched on the exact source card AND the exact note the
--    mislabelling wrote, so nothing else moves. Ideas in the owner's own words stay OWNER_IDEA.
--    The table is rebuilt only to widen its CHECKs (SUGGESTED_LIST; a MERGED status with `merged_into`,
--    for an idea folded into a bigger one rather than dropped; `earliest_month` and an idea's own
--    `packet_json` with its AI angle and slate); every row and the trigger carry over.
-- 4. Every month has a primary and a backup topic with a dated switch: `backup_json` (the backup club)
--    and `switch_deadline`. On the deadline, fewer than 2 cash yeses and no Title partner switch the
--    month to its backup automatically, and the owner is told. Sponsor names live only in those rows.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0264_tlc_economics_tiers_room_size_and_idea_origins');

ALTER TABLE tlc_deal DROP COLUMN tier;
ALTER TABLE tlc_deal ADD COLUMN tier TEXT CHECK (tier IS NULL OR tier IN ('TITLE','PARTNER','LEAD','PRESENTING','PRODUCT'));

ALTER TABLE tlc_event ADD COLUMN seats_min INTEGER;
ALTER TABLE tlc_event ADD COLUMN seats_max INTEGER;
ALTER TABLE tlc_event ADD COLUMN sponsor_goal_usd REAL;
ALTER TABLE tlc_event ADD COLUMN backup_json TEXT;
ALTER TABLE tlc_event ADD COLUMN switch_deadline TEXT;

CREATE TABLE tlc_idea_0264 (
  id              TEXT PRIMARY KEY,
  topic           TEXT NOT NULL,
  topic_key       TEXT NOT NULL,
  note            TEXT,
  origin          TEXT NOT NULL CHECK (origin IN ('OWNER_IDEA','BRANDS_SPENDING','TREND','SUGGESTED_LIST')),
  suggested_by    TEXT NOT NULL,
  suggested_at    TEXT NOT NULL,
  source_ref      TEXT,
  preferred_month TEXT,
  status          TEXT NOT NULL DEFAULT 'LATER' CHECK (status IN ('LATER','PICKED','ALTERNATIVE','DROPPED','MERGED')),
  status_month    TEXT,
  status_card_id  TEXT,
  dropped_by      TEXT,
  dropped_at      TEXT,
  merged_into     TEXT,
  earliest_month  TEXT,
  packet_json     TEXT,
  firm_scope      TEXT NOT NULL DEFAULT 'west-peek',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (firm_scope, topic_key)
);
INSERT INTO tlc_idea_0264 (id, topic, topic_key, note, origin, suggested_by, suggested_at, source_ref, preferred_month, status, status_month, status_card_id, dropped_by, dropped_at, firm_scope, created_at, updated_at)
  SELECT id, topic, topic_key, note, origin, suggested_by, suggested_at, source_ref, preferred_month, status, status_month, status_card_id, dropped_by, dropped_at, firm_scope, created_at, updated_at FROM tlc_idea;
DROP TABLE tlc_idea;
ALTER TABLE tlc_idea_0264 RENAME TO tlc_idea;
CREATE TRIGGER tlc_idea_never_deleted BEFORE DELETE ON tlc_idea
BEGIN
  SELECT RAISE(ABORT, 'a TLC idea is never deleted; a partner marks it DROPPED and it stays listed');
END;

UPDATE tlc_idea
   SET origin = 'SUGGESTED_LIST',
       suggested_by = 'Assistant (planning doc)',
       note = 'Suggested list written by the assistant in a planning document and emailed from the owner''s address on 22 Oct. Not a partner idea.',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE source_ref = 'wc_b6177490-bd4f-4d71-9783-edb42e918253'
   AND note = 'On the partners'' starting list (os@ email, 22 Oct).'
   AND topic IN ('Fragrance Lab','Matcha & Tea','Zero-Proof Home Bar','Home Espresso & Coffee','Skincare Science','Knife Skills & Home Cooking','Sleep & Recovery','Film Photography','Sewing & Visible Mending','AI Tools for Your Work','Buying Your First NYC Home');

INSERT INTO event_record (id, event_type, actor_type, actor_id, object_type, object_id, firm_scope, payload_json)
  VALUES ('evt_0264_idea_relabel', 'tlc.idea_relabelled', 'system', 'migration_0264', 'tlc_idea', 'wc_b6177490-bd4f-4d71-9783-edb42e918253', 'west-peek',
          '{"to":"SUGGESTED_LIST","suggested_by":"Assistant (planning doc)","why":"the list was written by the assistant, not the partners","topics":11}');

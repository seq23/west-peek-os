-- 0256 — A Google Drive share is the sharing partner's material, never an "unclear email" (9 Oct 2026).
--
-- WHAT WENT WRONG. At 13:29Z Scooter shared "Official Rules - Top Barz CultureCon Song Contest - Draft II"
-- with os@. The notice comes from drive-shares-dm-noreply@google.com, so the door saw a stranger: it opened
-- an "Unclear email" card, Porter's loop could not open the document, and Sequoia got a question essay
-- claiming nothing was on record about Top Barz. Two minutes later Scooter's "New site build:
-- voting.topbarz.xyz/entry" opened the very job the document belonged to.
--
-- WHAT THIS ADDS
--   card_drive_file — a shared Drive file on a card: who shared it (the partner Google's signed Reply-To
--     and the Drive API name), its title and link, and its text as read through the firm's delegation
--     (impersonating the sharer, drive.readonly), so every employee — and Porter's Mac brief — can read it.
--   inbound_clarification.kind / card_id — the ask-once question now also covers "what should I do with
--     this document?" (kind SHARE), asked about the card the share opened.

CREATE TABLE IF NOT EXISTS card_drive_file (
  id           TEXT PRIMARY KEY,
  work_card_id TEXT NOT NULL REFERENCES work_card (id),
  file_id      TEXT NOT NULL,
  url          TEXT NOT NULL,
  title        TEXT NOT NULL,
  mime_type    TEXT,
  shared_by    TEXT,
  shared_at    TEXT,
  -- The document's text (a Doc as text, a Sheet as CSV, a folder as its file list), capped; NULL when it
  -- could not be read, with the reason beside it.
  text         TEXT,
  read_error   TEXT,
  firm_scope   TEXT NOT NULL DEFAULT 'west-peek',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (work_card_id, file_id)
);
CREATE INDEX IF NOT EXISTS idx_card_drive_file_card ON card_drive_file (work_card_id);

ALTER TABLE inbound_clarification ADD COLUMN kind TEXT NOT NULL DEFAULT 'EMAIL';
ALTER TABLE inbound_clarification ADD COLUMN card_id TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0256_a_shared_doc_is_the_partners_material');

-- THE LEARNING CLUB: ONE EMAIL A WEEK (owner, 24 Oct 2026). The notice goes once per finished weekly brand batch
-- (batch_card_id), and an answer to her reply is threaded under the first notice of the week (root_ref).
ALTER TABLE tlc_draft_notice ADD COLUMN batch_card_id TEXT;
ALTER TABLE tlc_draft_notice ADD COLUMN root_ref TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0271_tlc_one_weekly_email');

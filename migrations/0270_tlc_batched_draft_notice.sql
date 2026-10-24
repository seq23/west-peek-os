-- THE LEARNING CLUB: ONE NOTICE EMAIL FOR A BATCH OF DRAFTS, APPROVED BY REPLY (owner, 24 Oct 2026).
-- Every brand draft waiting for her approval goes into ONE email, numbered, with its full copy; her reply
-- ("approve all", "approve 1, 3", "skip 2", "change 2: ...") decides only the drafts listed in that notice.
CREATE TABLE IF NOT EXISTS tlc_draft_notice (
  ref         TEXT PRIMARY KEY,
  items_json  TEXT NOT NULL,
  firm_scope  TEXT NOT NULL DEFAULT 'west-peek',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
ALTER TABLE tlc_drip_message ADD COLUMN notice_ref TEXT;
ALTER TABLE tlc_drip_message ADD COLUMN redraft_note TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0270_tlc_batched_draft_notice');

-- Removing a deal record that should not exist.
--
-- A pass and a withdrawal are DECISIONS about a real company, and both are kept for ever — the
-- record of what the firm declined is half the value of a pipeline. This is a different act: the
-- row itself was wrong. A duplicate, a typo, a company entered twice under two spellings.
--
-- ARCHIVE RATHER THAN DELETE, for the same reason as documents: transactions, deal math packets,
-- IC packets and the event spine all reference an opportunity by id, and destroying the row would
-- break those references and erase the history the operator asked to keep. The record leaves every
-- board and list; who took it off, when, and why survives.

ALTER TABLE investment_opportunity ADD COLUMN archived_at TEXT;
ALTER TABLE investment_opportunity ADD COLUMN archived_by TEXT;
ALTER TABLE investment_opportunity ADD COLUMN archive_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_opportunity_board ON investment_opportunity (firm_scope, archived_at);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0098_a_deal_record_can_be_taken_off_the_board');

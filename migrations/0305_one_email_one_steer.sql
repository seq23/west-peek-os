-- 0305 · ONE EMAIL, ONE STEER (15 Nov 2026, wc_bd8b68cb).
--
-- A partner's reply read through the door more than once (re-reads of the stored message) was filed into
-- work_steer once per read: Scooter's 14 Nov reply four times, and every copy rode to the model that reads
-- his words. The reply's own Message-ID now goes on the row, and a second row for the same message is
-- refused by the unique index (the door inserts OR IGNORE). Rows filed before this have no Message-ID and
-- are untouched; the readers also keep each body once.
--
-- Additive: a nullable column and a partial unique index. Nothing is rewritten.
ALTER TABLE work_steer ADD COLUMN message_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_steer_message ON work_steer (message_id) WHERE message_id IS NOT NULL;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0305_one_email_one_steer');

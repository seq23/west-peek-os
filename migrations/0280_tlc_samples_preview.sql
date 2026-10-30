-- 0280 · THE SAMPLES ARE A LIVE PAGE; THE PDF IS MADE ONCE, AT HER "APPROVED" (owner, 30 Oct 2026: "consistently
-- creating a new pdf each time seems wasteful"). services/tlcSamples.ts, services/tlcBrandReply.ts.
--   · tlc_samples.preview_token: the 128-bit credential of the private preview page
--     (/api/tlc-pitch/samples/:token). Rows already SENT are left exactly as they are (no token).
--   · tlc_samples_revision: one plain line per change she made, shown at the top of the preview page.
--   · tlc_brand_reply.send_retry_due / send_tries: an approved send whose PDF could not be made yet is retried on
--     its own; her "approved" is never asked for twice.
ALTER TABLE tlc_samples ADD COLUMN preview_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tlc_samples_preview_token ON tlc_samples (preview_token) WHERE preview_token IS NOT NULL;
UPDATE tlc_samples SET preview_token = lower(hex(randomblob(16))) WHERE preview_token IS NULL AND state != 'SENT';

CREATE TABLE IF NOT EXISTS tlc_samples_revision (
  id           TEXT PRIMARY KEY,
  samples_id   TEXT NOT NULL REFERENCES tlc_samples(id),
  what_changed TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_tlc_samples_revision ON tlc_samples_revision (samples_id, created_at);

ALTER TABLE tlc_brand_reply ADD COLUMN send_retry_due TEXT;
ALTER TABLE tlc_brand_reply ADD COLUMN send_tries INTEGER NOT NULL DEFAULT 0;
INSERT OR IGNORE INTO schema_version (migration) VALUES ('0280_tlc_samples_preview');

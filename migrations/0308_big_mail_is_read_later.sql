-- 0308 · A PARTNER'S BIG EMAIL IS ROUTED FROM ITS HEADERS AND READ LATER (15 Nov 2026).
--
-- Two 6 MB and 11 MB partner replies were killed by the email handler's CPU limit (exceededCpu at 2,010 ms) while
-- their bodies were decoded at the door; the dedupe claim stayed behind, so Email Routing's redelivery was dropped
-- as "already handled" and nothing was ever said.
--
-- inbound_message.read_later: NULL (read at the door) | PENDING | READING | DONE | FAILED. A message over the cap is
-- stored untouched and marked PENDING; the per-minute sweep reads it (inboundEmail.readStoredMail).
-- inbound_email_seen.handled: 0 while the door is running, 1 once it finished. A claim left at 0 (the invocation was
-- killed) no longer blocks a redelivery. DEFAULT 1, so every existing claim stays exactly what it was.
--
-- Additive: three new columns. Nothing is rewritten.
ALTER TABLE inbound_message ADD COLUMN read_later TEXT;
ALTER TABLE inbound_message ADD COLUMN read_detail TEXT;
ALTER TABLE inbound_email_seen ADD COLUMN handled INTEGER NOT NULL DEFAULT 1;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0308_big_mail_is_read_later');

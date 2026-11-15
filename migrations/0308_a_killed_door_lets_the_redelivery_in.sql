-- 0308 · A KILLED EMAIL DOOR NO LONGER EATS THE REDELIVERY (15 Nov 2026).
--
-- Two partner replies (6 MB and 11 MB) were killed by the email handler's CPU limit mid-read. The dedupe claim in
-- inbound_email_seen was written first and never given back (a killed invocation runs no catch), so Email Routing's
-- redelivery five minutes later was dropped as "already handled" and nothing was ever said.
--
-- handled: 0 while the door is running, 1 once it finished. A claim still at 0 after a few minutes belongs to a door
-- that died; a redelivery takes it over, and the sweep raises it on Sequoia's desk. DEFAULT 1, so every existing
-- claim stays exactly what it was.
--
-- attempts: how many deliveries' doors have started on this message. After INLINE_READ_ATTEMPTS failed or expired
-- claims the Worker does not read it inline again (the same work hits the same wall): it is handed on and raised.
-- handled = 2 marks that hand-off.
--
-- Additive: two new columns. Nothing is rewritten.
ALTER TABLE inbound_email_seen ADD COLUMN handled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE inbound_email_seen ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0308_a_killed_door_lets_the_redelivery_in');

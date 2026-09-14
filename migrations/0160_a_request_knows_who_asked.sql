-- 0160 · a work card knows who asked for it, and where it was handed from (14 Sep 2026)
--
-- A partner emails os@joinwestpeek.com with a request. It authenticates, becomes a card on their
-- chief of staff's desk, is handed to whichever employee's job it is, and gets done. Until now the
-- partner learned of that only by opening Work: the card did not remember it had come from an
-- email, so nothing could answer the email. `requested_by_email` is the authenticated address the
-- request came from — set at the door, inherited by every card handed on from it — and the sweep
-- replies to it when the work is DONE or BLOCKED. `assigned_from_card_id` is the hand-off trail.
ALTER TABLE work_card ADD COLUMN requested_by_email TEXT;
ALTER TABLE work_card ADD COLUMN assigned_from_card_id TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0160_a_request_knows_who_asked');

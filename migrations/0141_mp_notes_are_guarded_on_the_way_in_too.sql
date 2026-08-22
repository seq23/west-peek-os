-- The guard on the partners' own notes had a hole: it watched UPDATE and not INSERT.
--
-- `0138` added `mp_notes_are_the_firms_own`, a BEFORE UPDATE OF trigger refusing any write that does
-- not name its author — `mp_notes_by` being NULL is what distinguishes a partner from an automatic
-- process, because no job has a `firm_user` to put there.
--
-- IT ONLY COVERED UPDATE. A row INSERTed with `mp_notes` set and `mp_notes_by` NULL slipped straight
-- past, so anything creating a company could have written the one field that is supposed to be
-- unwritable by anything automatic. Found by an end-to-end test that set the notes at creation and
-- read back NULL — the create path was quietly dropping them, which hid the hole rather than causing
-- it.
--
-- Worth recording as a shape rather than a one-off: **a guard that covers one verb is a guard with a
-- door in it.** The same mistake would be `BEFORE DELETE` without `BEFORE UPDATE`, or a check on the
-- API that the database does not hold.
CREATE TRIGGER IF NOT EXISTS mp_notes_are_the_firms_own_on_insert
BEFORE INSERT ON canonical_company
FOR EACH ROW WHEN IFNULL(length(trim(NEW.mp_notes)), 0) > 0 AND IFNULL(NEW.mp_notes_by, '') = ''
BEGIN
  SELECT RAISE(ABORT, 'mp_notes belongs to the partners: it cannot be written without naming who wrote it');
END;

-- OR IGNORE here and NOWHERE else in this file: the version marker is the one row where a re-apply
-- is genuinely a no-op rather than a swallowed failure.
INSERT OR IGNORE INTO schema_version (migration) VALUES ('0141_mp_notes_are_guarded_on_the_way_in_too');

-- A meeting can be taken off the record, and the trail of who did it survives.
--
-- Operator, 22 Aug 2026: "the call with scooter meeting has no way to delete it. it was a test and
-- some meetings i want to delete....we need a way to delete them and we can have an audit trail if
-- someone deletes."
--
-- ARCHIVE, NOT DELETE — the document pattern (0095) and the deal-record pattern (0098), and the
-- argument is stronger here than in either. A meeting is referenced by its consent records, its
-- transcript imports, its notes, its seated employees, its commitments and any work card a
-- close-out turned one of those commitments into. Destroying the row would break every one of
-- those references and erase the very history an audit trail exists to keep. So the meeting leaves
-- every list, and everything already taken out of it stays exactly where it is.
--
-- A REASON IS REQUIRED, enforced in the handler rather than here because a CHECK cannot see an
-- UPDATE's intent. "It was a test" is a perfectly good reason; typing it is the half second that
-- stops an accidental press.
--
-- HUMAN ONLY. `meeting.archive` is an ordinary action in the registry, and the handler refuses an
-- AI actor outright: removing the firm's record of a conversation is not a thing an employee does.

ALTER TABLE meeting ADD COLUMN archived_at TEXT;
ALTER TABLE meeting ADD COLUMN archived_by TEXT;
ALTER TABLE meeting ADD COLUMN archive_reason TEXT;

-- The list query. Everything still on the record, newest first.
CREATE INDEX IF NOT EXISTS idx_meeting_on_the_record ON meeting (firm_scope, archived_at);

-- The P4 compensating seed for the one new action key, so authorize() knows the vocabulary on a
-- database that is already live rather than only on one built from the generated 0003 block.
--
-- ON CONFLICT DO NOTHING and not INSERT OR IGNORE, following 0131: the generator legitimately
-- re-emits the same key, so a duplicate key is a genuine no-op — but OR IGNORE would ALSO swallow
-- a CHECK failure silently, which has shipped a bug in this repo twice.
INSERT INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('meeting.archive',
   'Archive a meeting',
   'Take a meeting off the record, keeping who removed it, when, and why. Nothing already taken out of it is removed.',
   0, 0)
ON CONFLICT (key) DO NOTHING;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0140_a_meeting_can_be_taken_off_the_record');

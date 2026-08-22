-- A partner telling an employee something WHILE the work is being done.
--
-- Operator, 22 Aug 2026: "can the MPs give feedback on a work card that we want the ai employee to
-- acknowledge while they are doing the work?"
--
-- WHAT MAKES THIS REAL RATHER THAN A COMMENT BOX. The note reaches the employee's PROMPT on their
-- next step for that card. `employeeWork.ts` already carries the line that governs this: "a method
-- that is displayed on a page and never reaches a prompt is decoration." A feedback field that only
-- rendered on a page would be exactly that — a partner typing into a box and a machine carrying on
-- as though nothing had been said.
--
-- ACKNOWLEDGEMENT IS THE POINT, and it is not a checkbox. The employee must say back HOW the note
-- changes what they are doing — or why it does not, which is a legitimate answer and more useful
-- than silent compliance. An acknowledgement that could be satisfied by a flag would let an employee
-- mark a note read without it touching the work, which is the failure this table exists to prevent.
--
-- WHILE THE WORK IS BEING DONE, so this is deliberately not the approval queue. Approving is a
-- decision at a moment; this is steering something already in motion, and it must not stop the work
-- to wait for a round trip.
CREATE TABLE IF NOT EXISTS work_card_note (
  id              TEXT PRIMARY KEY,
  work_card_id    TEXT NOT NULL REFERENCES work_card (id),
  -- Human only. An employee talking to itself in this table would pollute its own instructions.
  author_id       TEXT NOT NULL REFERENCES firm_user (id),
  body            TEXT NOT NULL CHECK (length(trim(body)) >= 2),
  -- Set when the employee has taken it in AND said what it changes. Never set by the partner.
  acknowledged_at TEXT,
  -- What the employee said back. NOT NULL whenever acknowledged_at is set — the CHECK below makes
  -- "acknowledged" and "answered" the same event, so neither can happen without the other.
  response        TEXT,
  firm_scope      TEXT NOT NULL DEFAULT 'west-peek',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- IFNULL, and it is load-bearing. SQLite passes a CHECK that evaluates to NULL — only an explicit
  -- FALSE fails it — so `length(trim(response)) > 0` against a NULL response yields NULL and the
  -- constraint silently does not constrain. Caught by its own test, which set acknowledged_at with
  -- no response and watched the write succeed. Every three-valued comparison in a CHECK needs this.
  CHECK (
    (acknowledged_at IS NULL AND response IS NULL)
    OR (acknowledged_at IS NOT NULL AND IFNULL(length(trim(response)), 0) > 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_work_card_note ON work_card_note (work_card_id, created_at);

-- What was said is append-only. A partner's steering note is part of the record of how a piece of
-- work came out the way it did, and editing it afterwards would rewrite that.
CREATE TRIGGER IF NOT EXISTS work_card_note_body_is_fixed
BEFORE UPDATE ON work_card_note
FOR EACH ROW WHEN NEW.body <> OLD.body OR NEW.author_id <> OLD.author_id OR NEW.work_card_id <> OLD.work_card_id
BEGIN
  SELECT RAISE(ABORT, 'a note cannot be rewritten after it is left — add another');
END;

CREATE TRIGGER IF NOT EXISTS work_card_note_no_delete
BEFORE DELETE ON work_card_note
BEGIN
  SELECT RAISE(ABORT, 'work_card_note is append-only');
END;

-- OR IGNORE here and NOWHERE else in this file: the version marker is the one row where a re-apply
-- is genuinely a no-op rather than a swallowed failure.
INSERT OR IGNORE INTO schema_version (migration) VALUES ('0134_the_partners_can_steer_work_in_flight');

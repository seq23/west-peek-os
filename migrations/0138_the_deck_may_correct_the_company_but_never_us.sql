-- A newer deck corrects what the COMPANY says about itself. It never touches what WE think.
--
-- Operator, 22 Aug 2026, overruling an earlier decision of mine: "i think the updated deck should
-- overwrite us....coming from the company. overwriting us is fine. maybe each company card has a
-- field for MP notes that cannot be overwritten."
--
-- SHE IS RIGHT AND THE ORIGINAL RULE WAS SPLIT ON THE WRONG AXIS. `deckQueue` filled only BLANKS,
-- on the reasoning that a PDF must not replace something a partner typed. But "a partner typed it"
-- and "a partner judged it" are not the same thing, and conflating them is what made the rule wrong.
--
-- The right axis is WHOSE FACT IT IS:
--
--   * Sector, one-liner, website, stage, what they are raising — the COMPANY is the authority on
--     these. Our copy is a transcription of something they told us earlier. A deck sent later is a
--     more recent statement from the same source, so it should win. Keeping a stale transcription
--     because a human typed it is how a register slowly stops describing reality.
--
--   * What the firm believes, doubts, or has decided — that is OURS. No deck, no model and no
--     automatic process may touch it, ever. That is what this column is for.
--
-- NOTHING IS LOST WHEN A FIELD IS OVERWRITTEN. The previous value travels on the `company.deck_read`
-- event with the new one, so "what did we think their sector was in July" is still answerable. An
-- overwrite that erased the prior reading would trade one kind of staleness for a worse one.
ALTER TABLE canonical_company ADD COLUMN mp_notes TEXT;

-- Who last wrote them, so the note is attributable like everything else here.
ALTER TABLE canonical_company ADD COLUMN mp_notes_by TEXT REFERENCES firm_user (id);
ALTER TABLE canonical_company ADD COLUMN mp_notes_at TEXT;

-- The guarantee, held at the database rather than by every future caller remembering.
--
-- A trigger and not a convention: `mp_notes` is the one field on this row that carries the firm's
-- own judgement, and the whole value of it is that a partner can write there knowing nothing else
-- will. A rule enforced only in TypeScript is a rule that survives until somebody adds a service.
--
-- `mp_notes_by` NULL is the tell: every partner-facing write sets it, and no automatic process has a
-- firm_user to put there. IFNULL because SQLite passes a CHECK or a WHEN that evaluates to NULL —
-- only an explicit FALSE stops it — and this repo hit that exact trap yesterday.
CREATE TRIGGER IF NOT EXISTS mp_notes_are_the_firms_own
BEFORE UPDATE OF mp_notes ON canonical_company
FOR EACH ROW WHEN IFNULL(NEW.mp_notes_by, '') = ''
BEGIN
  SELECT RAISE(ABORT, 'mp_notes belongs to the partners: it cannot be written without naming who wrote it');
END;

-- OR IGNORE here and NOWHERE else in this file: the version marker is the one row where a re-apply
-- is genuinely a no-op rather than a swallowed failure.
INSERT OR IGNORE INTO schema_version (migration) VALUES ('0138_the_deck_may_correct_the_company_but_never_us');

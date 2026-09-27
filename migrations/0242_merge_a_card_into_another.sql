-- 0242 — Merge one work card into another (owner, 27 Sep 2026).
--
-- WHY. On 27 Sep two of Scooter's replies were too large for the reply matcher and opened NEW cards
-- instead of steering the one he was answering. The desk then showed four cards for one job — the
-- original community-site card (BLOCKED on a preview it will never need), two Walker intakes that
-- had already finished, and the live one Porter is actually building on. Nothing could fold them
-- together: "Stop this work" cancels a card but leaves its emails, its attachments and its hand-off
-- history stranded on a dead row, and the survivor's trail starts mid-conversation.
--
-- WHAT THIS ADDS.
--
--   1 · `work_card.merged_into_card_id` — set on the card that was folded in (the FROM card). A
--       card with this set is CANCELLED and stays CANCELLED: its history now reads on the survivor.
--   2 · `work_card_merge` — the history: which card went into which, who did it (a firm_user id, or
--       'system:script' for the checked-in one-off), why, and when.
--   3 · Triggers that hold the rule at the row, whatever the code does:
--         a · a card never merges into itself;
--         b · a merged card cannot leave CANCELLED — "Reopen" on it would resurrect the duplicate
--             the merge removed. The way back is to open the survivor.
--
-- THE ONE WRITER of the column and the history table is `services/mergeCards.ts`. It moves the
-- from card's `inbound_message`, `email_thread` (object_type work_card) and `request_attachment`
-- rows to the survivor so a late reply on the old thread steers the live card, and the survivor's
-- message trail (`requestMessage.ts`) reads the merged-in cards' notices and hand-offs as its own.
--
-- Additive: no existing row is rewritten; the triggers fire only on rows the new code writes.
ALTER TABLE work_card ADD COLUMN merged_into_card_id TEXT REFERENCES work_card (id);
CREATE INDEX IF NOT EXISTS idx_work_card_merged_into ON work_card (merged_into_card_id);

CREATE TABLE IF NOT EXISTS work_card_merge (
  id             TEXT PRIMARY KEY,
  from_card_id   TEXT NOT NULL REFERENCES work_card (id),
  into_card_id   TEXT NOT NULL REFERENCES work_card (id),
  -- A firm_user id (the signed-in partner), or 'system:script' for a checked-in one-off.
  by             TEXT NOT NULL,
  reason         TEXT,
  -- What moved, as counts, so the trail bullet and this row cannot disagree about it.
  moved_messages INTEGER NOT NULL DEFAULT 0,
  moved_threads  INTEGER NOT NULL DEFAULT 0,
  moved_files    INTEGER NOT NULL DEFAULT 0,
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (from_card_id <> into_card_id)
);
CREATE INDEX IF NOT EXISTS idx_work_card_merge_into ON work_card_merge (into_card_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_card_merge_from ON work_card_merge (from_card_id);

CREATE TRIGGER IF NOT EXISTS trg_work_card_never_merges_into_itself
BEFORE UPDATE OF merged_into_card_id ON work_card
WHEN NEW.merged_into_card_id IS NOT NULL AND NEW.merged_into_card_id = NEW.id
BEGIN
  SELECT RAISE(ABORT, 'a card cannot be merged into itself (0242)');
END;

CREATE TRIGGER IF NOT EXISTS trg_work_card_merged_stays_cancelled
BEFORE UPDATE OF state ON work_card
WHEN NEW.merged_into_card_id IS NOT NULL AND NEW.state <> 'CANCELLED'
BEGIN
  SELECT RAISE(ABORT, 'this card was merged into another; open the survivor instead (0242)');
END;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0242_merge_a_card_into_another');

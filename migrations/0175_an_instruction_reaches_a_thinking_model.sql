-- 0175 · Everything she says reaches a thinking model, and she can see what it turned into
--
-- Operator, twice: "when I give a task, the agent should use an LLM that is highly intelligent to
-- interpret the ask" and "make sure everything I say reaches a thinking model." Then, afterwards:
-- "tell me what my instructions turned into."
--
-- ─── What was true before this migration ──────────────────────────────────────────────────────
--
-- A work card can carry human prose in four places: `prompt` (how she wants it done), the card's
-- own request text, `work_card_note` (a steering note left while the work is running), and
-- `block_answer` (what she typed to clear a block). The general employee loop reads all of them.
--
-- The SPECIALISED CHAINS — dispatched by `work_card.kind` in services/workSweep.ts, which is how
-- Parker's Room and Workshop packets, Walker's Productions duties and hire search, a partner's
-- blog help and Preston's deck rework are all run — read NONE of them. Confirmed by reading every
-- one of those services: not one referenced `work_card.prompt`, `work_card_note` or `block_answer`.
--
-- So on a chain card she could type an instruction, press send, and it went into a column that
-- nothing ever read. Parker's workshops packet is the case that surfaced it: she asked for "a
-- packet on workshops, much like he does for rooms" and that sentence reached no model at all.
--
-- ─── What this table is ───────────────────────────────────────────────────────────────────────
--
-- The RECEIPT. One row per interpretation: exactly what she typed (unedited, with where each piece
-- came from), what the model made of it, and the governed run that did it — so "which model read
-- my words, and what did it think I meant" is answerable from the product rather than from an
-- agent reading a database.
--
-- WHY THE ORIGINAL TEXT IS STORED RATHER THAN JOINED. The pieces come from four different tables
-- and two of them are mutable: a note can be acknowledged, a block answer overwritten by the next
-- block. A receipt that re-derives its own left-hand side is a receipt that changes after the
-- fact, which is the one thing a receipt may not do. P18's rule — the original text is immutable —
-- is the same rule, and the trigger below enforces it here the way 0118 does there.
--
-- WHY `ai_run_id` IS NOT NULLABLE-BY-HABIT. A row with no run behind it would mean an
-- interpretation nothing actually interpreted, which is precisely the defect being closed. It is
-- nullable only because a run that was BLOCKED by the AI boundary (budget, kill switch, egress)
-- still produces a row so the failure is visible; `interpreted_json` is then NULL and the card
-- blocks rather than proceeding.

CREATE TABLE IF NOT EXISTS work_card_instruction (
  id                TEXT PRIMARY KEY,
  work_card_id      TEXT NOT NULL REFERENCES work_card (id),
  -- The chain this was interpreted for, e.g. 'ROOM_PACKET'. NULL for the general employee loop,
  -- which carries the words into its own step prompt and needs no separate pass.
  card_kind         TEXT,
  -- Exactly what the humans typed: [{source, text, who}]. Immutable, see the trigger below.
  said_json         TEXT NOT NULL,
  -- {understood, steer[], cannot[]} — or NULL when the model could not be read or never ran.
  interpreted_json  TEXT,
  -- Why there is no interpretation, when there is none. A row may not be silently empty.
  failure_reason    TEXT,
  ai_run_id         TEXT REFERENCES ai_run (id),
  model             TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  -- A receipt that says nothing is not a receipt. Either the model answered, or the row says why
  -- it did not; a row carrying neither is the "exists but does nothing" shape Rule 0 forbids.
  CHECK (interpreted_json IS NOT NULL OR IFNULL(length(trim(failure_reason)), 0) > 0)
);

CREATE INDEX IF NOT EXISTS idx_work_card_instruction_card
  ON work_card_instruction (work_card_id, created_at DESC);

-- ── Her words are not editable, by anybody ────────────────────────────────────────────────────
--
-- The same rule as P18's immutable original text, enforced the same way. An UPDATE that changed
-- `said_json` would let the record of what she asked for be rewritten to match what was built,
-- which is the exact failure the receipt exists to make impossible.
CREATE TRIGGER IF NOT EXISTS work_card_instruction_said_is_immutable
BEFORE UPDATE ON work_card_instruction
WHEN NEW.said_json IS NOT OLD.said_json
BEGIN
  SELECT RAISE(ABORT, 'what a partner typed cannot be edited after the fact (0175)');
END;

CREATE TRIGGER IF NOT EXISTS work_card_instruction_is_append_only
BEFORE DELETE ON work_card_instruction
BEGIN
  SELECT RAISE(ABORT, 'a record of what a partner asked for cannot be deleted (0175)');
END;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0175_an_instruction_reaches_a_thinking_model');

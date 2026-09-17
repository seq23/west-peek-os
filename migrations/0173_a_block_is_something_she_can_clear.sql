-- 0173 · A block is something she can clear herself (16 Sep 2026)
--
-- Operator: "parker is blocked on an assignment i gave him and i dont understand what he is
-- blocked on and how to help him myself … the reasoning sounds too technical."
--
-- WHAT A BLOCK WAS. One column: `next_action`, holding whatever sentence the service that gave up
-- happened to write. Parker's October Workshop held "Could not finish after 3 attempts. Last
-- attempt: DISCOVER: the judgement pass failed: the judgement was routed to the search model." No
-- structure, so nothing could be asked of it, and no way to act on it from a page.
--
-- WHAT A BLOCK IS NOW. Four sentences and at least one door, each in its own column so the
-- database can refuse a block that does not carry them:
--
--   block_trying   what the employee was doing, in the words the work was given in;
--   block_stopped  ONE plain sentence, held to shared/work/blocks.ts `plainLanguageProblems`;
--   block_needed   the specific thing that would clear it;
--   block_who      who can provide it — her, Scooter, or an engineer.
--
-- THE TRIGGERS ARE THE POINT. A reason written for a partner is the kind of thing that decays the
-- moment somebody adds a thirteenth place a card can stop, and a validator that reads source can
-- be outrun by a service that builds its SQL differently. A CHECK at the row is not: a card that
-- reaches BLOCKED without the four sentences and an action never lands, whoever wrote the UPDATE.
-- The prose standard (no stack traces, no column names) stays in TypeScript where a regex belongs;
-- what lives here is the part that must be true of every row.
--
-- NOTHING STAYS STUCK SILENTLY. `block_nag_at` is when the block resurfaces if nobody has acted.
-- The existing rule in this repo is that employees cannot drop owned work; a block that quietly
-- aged out of a queue would be exactly that, done by the system instead of the employee.

ALTER TABLE work_card ADD COLUMN block_reason      TEXT;
ALTER TABLE work_card ADD COLUMN block_trying      TEXT;
ALTER TABLE work_card ADD COLUMN block_stopped     TEXT;
ALTER TABLE work_card ADD COLUMN block_needed      TEXT;
ALTER TABLE work_card ADD COLUMN block_who         TEXT
  CHECK (block_who IS NULL OR block_who IN ('SEQUOIA','SCOOTER','ENGINEER'));
-- The doors offered on this particular block, as written by the catalogue. Stored rather than
-- re-derived so a card blocked last week still offers the buttons it was blocked with.
ALTER TABLE work_card ADD COLUMN block_actions_json TEXT;
ALTER TABLE work_card ADD COLUMN blocked_at        TEXT;
-- When it resurfaces if nobody has acted. Cleared when somebody does.
ALTER TABLE work_card ADD COLUMN block_nag_at      TEXT;
ALTER TABLE work_card ADD COLUMN block_nags        INTEGER NOT NULL DEFAULT 0;
-- What the owner typed, and who typed it. Read by the employee's NEXT run — an answer that is
-- recorded and never read is worse than no button at all.
ALTER TABLE work_card ADD COLUMN block_answer      TEXT;
ALTER TABLE work_card ADD COLUMN block_answered_by TEXT;
ALTER TABLE work_card ADD COLUMN block_answered_at TEXT;

CREATE INDEX IF NOT EXISTS idx_work_card_block_nag ON work_card (state, block_nag_at);

-- ── A block must be readable and actionable, at the row ──────────────────────────────────────
--
-- One condition, written twice because SQLite has no shared trigger body. RAISE inside a SELECT
-- with a WHERE fires only when the WHERE matches, which is how a trigger says "abort, but only
-- if". `IFNULL(length(trim(x)), 0) = 0` rather than `x IS NULL OR x = ''`: a CHECK-style
-- comparison against NULL evaluates to NULL, not FALSE, and would silently not constrain (the
-- lesson 0134 paid for).

CREATE TRIGGER IF NOT EXISTS work_card_block_must_be_readable_insert
BEFORE INSERT ON work_card
WHEN NEW.state = 'BLOCKED'
BEGIN
  SELECT RAISE(ABORT, 'a block must say what was being done, what stopped it, what would clear it, who can clear it, and offer a way to act (0173)')
   WHERE IFNULL(length(trim(NEW.block_trying)), 0) = 0
      OR IFNULL(length(trim(NEW.block_stopped)), 0) = 0
      OR IFNULL(length(trim(NEW.block_needed)), 0) = 0
      OR NEW.block_who IS NULL
      OR IFNULL(length(trim(NEW.block_actions_json)), 0) < 3;
END;

CREATE TRIGGER IF NOT EXISTS work_card_block_must_be_readable_update
BEFORE UPDATE ON work_card
WHEN NEW.state = 'BLOCKED'
BEGIN
  SELECT RAISE(ABORT, 'a block must say what was being done, what stopped it, what would clear it, who can clear it, and offer a way to act (0173)')
   WHERE IFNULL(length(trim(NEW.block_trying)), 0) = 0
      OR IFNULL(length(trim(NEW.block_stopped)), 0) = 0
      OR IFNULL(length(trim(NEW.block_needed)), 0) = 0
      OR NEW.block_who IS NULL
      OR IFNULL(length(trim(NEW.block_actions_json)), 0) < 3;
END;

-- ── Clearing the blocks that were written before any of this ────────────────────────────────
--
-- One card in production is blocked right now, and it is the card that started this: Parker's
-- October Workshop packet. Its stored reason is "Could not finish after 3 attempts. Last attempt:
-- DISCOVER: the judgement pass failed: the judgement was routed to the search model" — a sentence
-- nobody outside this file can act on, attached to a fault that no answer of hers could have
-- fixed. The fault itself is fixed in code (the judge is no longer routed to the search model, and
-- the Workshop's research stage degrades instead of dying), so what is left is a card sitting at
-- its attempt cap with a reason that predates the standard.
--
-- Left alone it would stay blocked for ever: `claimNextCard` only takes OPEN and IN_PROGRESS, and
-- the new page renders no doors for a block with no sentences. So a block written before there was
-- a standard goes back in the queue, with its attempts reset. If it stops again it stops with a
-- reason she can read and four buttons — which is the entire point.
UPDATE work_card
   SET state = 'OPEN', work_attempts = 0, work_steps = 0, lease_until = NULL,
       next_action = 'Being tried again — the reason this stopped last time was written for an engineer and has been fixed.',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE state = 'BLOCKED' AND block_stopped IS NULL;

-- Parker's packet itself is at its first stage with a stale error on it; clearing that is what
-- lets the chain start rather than resume into a fault that no longer exists.
UPDATE evt_room_packet
   SET build_error = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE status = 'DRAFT' AND build_error IS NOT NULL;

-- The `work_card.unblock` action key is seeded from src/shared/registry/actionTypes.ts — it lands
-- in 0003 for a fresh database and in the generated backfill (0174) for one already applied.
-- authorize() denies an unknown key, so a door with no row here 403s in production.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0173_a_block_is_something_she_can_clear');

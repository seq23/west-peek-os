-- 0227 — HELD: she can pull a card and save it for later, with a note (Wave D, 22 Sep 2026).
--
-- HER WORDS: "I should be able to pull a work card and save for later with a note — 'I want to
-- make sure I'm at my desk when this one is being done since it's a big job' — and the owner of
-- that card can relay that to anyone else who asks about it."
--
-- WHY A FLAG AND NOT A SIXTH VALUE ON `state` — RECONSIDERED WHILE WRITING THIS MIGRATION. The
-- first draft added `'HELD'` as a sixth value and discovered, by running it, that `work_card.state`
-- carries a CHECK constraint from 0003 — `CHECK (state IN ('OPEN','IN_PROGRESS','BLOCKED','DONE',
-- 'CANCELLED'))` — that SQLite cannot widen in place. The only way to widen a CHECK is the
-- create-copy-drop-rename recipe, and `work_card` is referenced by roughly twenty other tables'
-- `REFERENCES work_card (id)`. This repo has already been bitten by exactly that rebuild once:
-- 0189 renamed `deliverable` and found, a day later, that migration 0180 had silently rewritten
-- `deliverable_feedback.deliverable_id` to reference the renamed-away shadow table — a defect
-- nobody saw until CI happened to catch it. Rebuilding `work_card` blind, under one migration,
-- across ~twenty dependents accumulated over 227 migrations, is precisely that failure class at a
-- much larger scale, for a feature that does not need it.
--
-- So HELD is never written to `work_card.state` at all. `state` keeps whatever value the card
-- legitimately had when she paused it (OPEN, IN_PROGRESS, or BLOCKED) — it does not matter which,
-- because `releaseHeldCard` always forces it back to OPEN regardless, per her own rule that release
-- re-queues fresh rather than resuming mid-step. "Held" is answered by `held_at IS NOT NULL`, the
-- same shape this repo already uses everywhere else for a secondary state that layers onto a
-- primary one without widening it — `blocked_at`/`block_answered_at`, `dismissed_at`,
-- `acknowledged_at`, `withdrawn_at`, `landed_at`. The server (`services/workCards.ts`) synthesises
-- `state: "HELD"` in every card it hands to the client whenever `held_at` is set, so nothing about
-- the PAGE, the DESK, the BADGE or the SHARED `CARD_STATES` union changes — the client never knows
-- or needs to know that the database itself did not widen a column to hold the word.
--
-- WHY HELD_REASON IS STILL REQUIRED AT THE ROW, not only in the API layer that writes it. A held
-- card's whole purpose is that the owning employee can relay WHY it is paused to anyone who asks.
-- A row with `held_at` set and no reason is the empty state this feature exists to prevent, and the
-- block trigger in 0173 already proved that a check written only in TypeScript drifts the moment a
-- second caller writes the columns directly — so the same shape is used here, keyed on `held_at`
-- rather than on a `state` value that no longer changes.
--
-- THE SINGLE MOST IMPORTANT CORRECTNESS RULE IN THIS WAVE, at the row: a card cannot be marked held
-- while it still holds a live lease. Holding an already-claimed card (picked up, `lease_until` in
-- the future, mid-`work_attempts`) must release the claim in the SAME write, or the Mac keeps
-- executing a card that now reads "held" — the exact contradiction the feature exists to prevent.
-- A trigger makes this true of every row, whoever writes it, rather than true of the one call site
-- that remembered.
--
-- AND THE SWEEP HAS TO BE TOLD EXPLICITLY, which it did not before this reconsideration. When HELD
-- was going to be its own `state` value, `claimNextCard`, `settleAbandonedCards` and
-- `resurfaceStaleBlocks` — all filtered to `state IN (...)` or `state = 'BLOCKED'` — would have
-- excluded a held card for free. Now that `state` stays OPEN/IN_PROGRESS/BLOCKED underneath, each of
-- those three queries gets an explicit `AND held_at IS NULL` (see `services/workSweep.ts` and
-- `services/blocks.ts`) — the silence this feature promises is enforced there, not here, and
-- `tests/hold.test.ts` proves the resurfacing case negatively: a card blocked, then held, with its
-- stale pre-hold nag clock still due, is never resurfaced.

ALTER TABLE work_card ADD COLUMN held_reason TEXT;
ALTER TABLE work_card ADD COLUMN held_by     TEXT;
ALTER TABLE work_card ADD COLUMN held_at     TEXT;

CREATE INDEX IF NOT EXISTS idx_work_card_held ON work_card (held_at);

-- ── A held card must carry the reason she held it for ────────────────────────────────────────

CREATE TRIGGER IF NOT EXISTS work_card_hold_must_have_a_reason_insert
BEFORE INSERT ON work_card
WHEN NEW.held_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a held card must carry the reason she held it for, so the owner can relay it to anyone who asks (0227)')
   WHERE IFNULL(length(trim(NEW.held_reason)), 0) = 0;
END;

CREATE TRIGGER IF NOT EXISTS work_card_hold_must_have_a_reason_update
BEFORE UPDATE ON work_card
WHEN NEW.held_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a held card must carry the reason she held it for, so the owner can relay it to anyone who asks (0227)')
   WHERE IFNULL(length(trim(NEW.held_reason)), 0) = 0;
END;

-- ── A held card cannot hold a live lease ──────────────────────────────────────────────────────
--
-- Proved negatively in `tests/hold.test.ts`: mark a leased card held, assert the write is refused
-- unless the lease is cleared in the same statement. This is what makes "the Mac keeps executing a
-- card that now reads held" impossible rather than merely discouraged.

CREATE TRIGGER IF NOT EXISTS work_card_hold_releases_the_lease_insert
BEFORE INSERT ON work_card
WHEN NEW.held_at IS NOT NULL AND NEW.lease_until IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a card cannot be held while it still holds a live lease — clear lease_until in the same write (0227)');
END;

CREATE TRIGGER IF NOT EXISTS work_card_hold_releases_the_lease_update
BEFORE UPDATE ON work_card
WHEN NEW.held_at IS NOT NULL AND NEW.lease_until IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a card cannot be held while it still holds a live lease — clear lease_until in the same write (0227)');
END;

-- ── A finished or dropped card cannot also be held ────────────────────────────────────────────
--
-- Belt and suspenders beside `services/workCards.ts`'s own refusal to hold a DONE or CANCELLED
-- card: "nothing to pull" is a row-level fact as well as an API-level one.

CREATE TRIGGER IF NOT EXISTS work_card_hold_not_on_finished_work_insert
BEFORE INSERT ON work_card
WHEN NEW.held_at IS NOT NULL AND NEW.state IN ('DONE', 'CANCELLED')
BEGIN
  SELECT RAISE(ABORT, 'a finished or dropped card cannot be held — there is nothing left to pull (0227)');
END;

CREATE TRIGGER IF NOT EXISTS work_card_hold_not_on_finished_work_update
BEFORE UPDATE ON work_card
WHEN NEW.held_at IS NOT NULL AND NEW.state IN ('DONE', 'CANCELLED')
BEGIN
  SELECT RAISE(ABORT, 'a finished or dropped card cannot be held — there is nothing left to pull (0227)');
END;

-- The `work_card.hold` and `work_card.release` action keys are seeded from
-- src/shared/registry/actionTypes.ts — this lands in 0003 for a fresh database and is repeated
-- here as the compensating insert for one already applied (the P4 convention).
INSERT OR IGNORE INTO action_type (key, name, description, is_reserved, is_external_effect) VALUES
  ('work_card.hold', 'Hold a work card for later', 'Pull a card off the board with a reason, releasing any live claim on it in the same write.', 0, 0),
  ('work_card.release', 'Release a held work card', 'Put a held card back to OPEN with its attempts reset — it re-queues fresh, never mid-step.', 0, 0);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0227_a_held_card_is_silent_and_its_lease_is_gone');

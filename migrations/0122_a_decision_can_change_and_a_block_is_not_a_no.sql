-- A decision can be changed after it is made, and a block is not a rejection.
--
-- Operator, item 3: "reject/block/send-back/draft, changing state after a decision". Send-back and
-- draft already existed (`revise_requested`, `drafted`). The two that did not are the two this
-- migration carries.
--
-- ── CHANGING A DECISION ON AN APPEND-ONLY SPINE ────────────────────────────────────────────────
-- `approval_decision` rejects UPDATE and DELETE at the DB layer (0003, D15), and that is not
-- negotiable: the point of an approval trail is that a partner cannot go back and make it say
-- something else. So "change your mind" cannot mean editing the decision. It means recording a NEW
-- decision that SUPERSEDES the earlier one, with its own actor, its own timestamp and a required
-- reason — and the original stays exactly where it was, readable forever.
--
-- `supersedes_decision_id` is that link. Without it the trail is a pile of rows in time order and
-- nobody can tell "the partner reconsidered Tuesday's approval" from "two people decided the same
-- card twice". With it, the reversal points at what it reversed and the pair reads as one story.
--
-- ── A BLOCK IS NOT A REJECTION, AND THE DIFFERENCE IS `waiting_on` ─────────────────────────────
-- Reject means "no, not this". It is a verdict on the thing in front of you and it ends there.
-- Block means "nothing here proceeds until something else is resolved" — it is a verdict on the
-- firm's readiness, not on the request. Those are different sentences and collapsing them loses
-- real information: a rejected card tells the requester to stop, a blocked one tells them what to
-- go and get.
--
-- So a block is NOT NULL on `waiting_on`. A block that cannot say what it is waiting for is a
-- rejection with better manners, and it would rot in the queue with nobody able to tell whether it
-- was still true. Naming the blocker is also what makes a block RELEASABLE: somebody can look at
-- the sentence, decide it is resolved, and say so.
--
-- `state_before` is the other half of releasable. Blocking is not a decision on the merits, so
-- releasing must not silently become one. The card goes back to exactly where it was standing when
-- the block landed — a card that was waiting on a partner is waiting on them again, and a card that
-- had already been approved is approved again and still needs executing.
--
-- firm_scope is deliberately absent: it lives on the aggregate root (`approval_card`) and this row
-- inherits it through the foreign key, so a scope can never disagree with itself.

ALTER TABLE approval_decision ADD COLUMN supersedes_decision_id TEXT REFERENCES approval_decision (id);

CREATE TABLE IF NOT EXISTS approval_block (
  id               TEXT PRIMARY KEY,
  approval_card_id TEXT NOT NULL REFERENCES approval_card (id),
  -- The entire distinction from a rejection lives in this column, which is why it is NOT NULL.
  waiting_on       TEXT NOT NULL,
  -- Where the card returns to when the block is released. Blocking pauses; it never decides.
  state_before     TEXT NOT NULL
                   CHECK (state_before IN ('drafted','pending_review','revise_requested','approved')),
  -- Plain TEXT, matching `approval_decision.decided_by` — actor ids in this system are not all
  -- firm_user rows, and an FK here would reject the system and browser actors that column accepts.
  blocked_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Null while the block still stands.
  released_by      TEXT,
  released_at      TEXT,
  -- What resolved it. Required by the service: "released" with no account of why is how a block
  -- becomes a shrug.
  release_note     TEXT
);

CREATE INDEX IF NOT EXISTS idx_approval_block_card ON approval_block (approval_card_id, created_at);

-- One open block per card, enforced here rather than only in code. Two live blocks on one card
-- means releasing one leaves the card looking free while the other still stands, and the partner
-- has no way to see it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_block_one_open
  ON approval_block (approval_card_id) WHERE released_at IS NULL;

CREATE TRIGGER IF NOT EXISTS approval_block_reject_delete
BEFORE DELETE ON approval_block
BEGIN
  SELECT RAISE(ABORT, 'approval_block is append-only: DELETE rejected (D15)');
END;

-- A released block is finished. Reopening the same row would let one release be rewritten into
-- another; place a new block instead, so the card carries both and the sequence survives.
CREATE TRIGGER IF NOT EXISTS approval_block_release_is_final
BEFORE UPDATE ON approval_block
WHEN OLD.released_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'approval_block: a released block is final — place a new block rather than editing this one (D15)');
END;

-- The release columns are the ONLY thing an UPDATE may set. What a block was waiting on, who placed
-- it and where the card came from are the facts somebody will read back in a year.
CREATE TRIGGER IF NOT EXISTS approval_block_reason_is_immutable
BEFORE UPDATE ON approval_block
WHEN NEW.waiting_on <> OLD.waiting_on
   OR NEW.blocked_by <> OLD.blocked_by
   OR NEW.approval_card_id <> OLD.approval_card_id
   OR NEW.state_before <> OLD.state_before
   OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'approval_block: what a block was waiting on and who placed it cannot be rewritten (D15)');
END;

-- ── The three action keys these paths speak ────────────────────────────────────────────────────
--
-- NOT `INSERT OR IGNORE`. That form swallows a CHECK or NOT NULL failure and reports success, which
-- is how migration 0112 created a scheduled job that was never there. An explicit NOT EXISTS guard
-- skips exactly one thing — a key some other migration already inserted — and lets every other
-- failure abort the migration where somebody will see it.
--
-- The guard is needed because the seed generator writes these same keys into 0003. A database
-- created after that run gets them from 0003 and this statement correctly does nothing; a database
-- that applied 0003 months ago gets them here, which is the whole reason this block exists —
-- authorize() denies an unknown key, so a feature with no row here 403s in production while passing
-- every local test.

INSERT INTO action_type (key, name, description, is_external_effect, is_reserved)
SELECT 'approval.reopen', 'Change a decision already made',
       'Record a new decision that supersedes an earlier one on the same card, with a required reason. The original decision is never edited or erased, and something already carried out can never be reopened.',
       0, 0
WHERE NOT EXISTS (SELECT 1 FROM action_type WHERE key = 'approval.reopen');

INSERT INTO action_type (key, name, description, is_external_effect, is_reserved)
SELECT 'approval.block', 'Block an approval',
       'Stop an approval proceeding until a named blocker is resolved. Unlike a rejection this is not a verdict on the request: it names what the firm is waiting for, and it can be released.',
       0, 0
WHERE NOT EXISTS (SELECT 1 FROM action_type WHERE key = 'approval.block');

INSERT INTO action_type (key, name, description, is_external_effect, is_reserved)
SELECT 'approval.block_release', 'Release a block',
       'Record that what an approval was waiting on is resolved, returning the card to exactly the state it was in when the block landed.',
       0, 0
WHERE NOT EXISTS (SELECT 1 FROM action_type WHERE key = 'approval.block_release');

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0122_a_decision_can_change_and_a_block_is_not_a_no');

-- 0032_weekly_review.sql — P37: the weekly MP operating review (V1 #18, canon §8).
--
-- Canon §8: the two dedicated Chiefs of Staff each prepare a partner-specific brief, then the
-- orchestration layer "merges them into one shared agenda, removes duplicates, surfaces
-- disagreements, and preserves both partners' positions". Sixteen headings, and every agenda item
-- exits as Decision, Owner, Deadline, Delegated Action, Deferred Item, or Closed Item.
--
-- THE ACCEPTANCE CRITERION IS THE DESIGN CONSTRAINT: §33 requires the review to be "generated from
-- live system state". So items are DERIVED from records that already exist — pending approvals,
-- open commitments, portfolio alerts, failing jobs — not written by a model. A model asked to
-- summarise the week would produce something readable and unfalsifiable; a derived item can be
-- clicked through to the row it came from.
--
-- WHY "PRESERVES BOTH PARTNERS' POSITIONS" NEEDS ITS OWN COLUMN. The obvious merge dedupes
-- identical items and moves on. Canon asks for more than that: where the two briefs disagree, the
-- disagreement is the useful output. `raised_by` records which partner's brief an item came from,
-- and BOTH when they agreed — so a merged agenda can still answer "was this only Scooter's
-- concern?" A dedupe that forgets provenance destroys exactly the signal the review exists for.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0032_weekly_review');

CREATE TABLE IF NOT EXISTS weekly_review (
  id           TEXT PRIMARY KEY,
  -- ISO week start (Monday), so re-running for the same week updates rather than duplicates.
  week_start   TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'DRAFT'
               CHECK (state IN ('DRAFT','REVIEWED')),
  generated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reviewed_by  TEXT REFERENCES firm_user (id),
  reviewed_at  TEXT,
  firm_scope   TEXT NOT NULL DEFAULT 'west-peek',
  created_by   TEXT NOT NULL,
  UNIQUE (firm_scope, week_start)
);

CREATE TABLE IF NOT EXISTS weekly_review_item (
  id              TEXT PRIMARY KEY,
  review_id       TEXT NOT NULL REFERENCES weekly_review (id),
  -- One of the sixteen canon §8 headings. Not CHECK-constrained: the heading list belongs to the
  -- canon module in code, and a schema that must be migrated to add a heading discourages keeping
  -- the two in step.
  heading         TEXT NOT NULL,
  body            TEXT NOT NULL,
  -- The six exits canon §8 allows. UNRESOLVED is the seventh and is the DEFAULT, because an item
  -- that has not been decided yet must not masquerade as one that has.
  exit_type       TEXT NOT NULL DEFAULT 'UNRESOLVED'
                  CHECK (exit_type IN ('UNRESOLVED','DECISION','OWNER','DEADLINE','DELEGATED_ACTION','DEFERRED_ITEM','CLOSED_ITEM')),
  exit_note       TEXT,
  owner_id        TEXT,
  deadline        TEXT,
  -- 'SCOOTER' | 'SEQUOIA' | 'BOTH' — see the header note on why a dedupe must not lose this.
  raised_by       TEXT NOT NULL DEFAULT 'BOTH',
  -- Where the item came from, so every line is clickable back to its evidence.
  source_type     TEXT,
  source_id       TEXT,
  firm_scope      TEXT NOT NULL DEFAULT 'west-peek',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_weekly_review_item_review ON weekly_review_item (review_id, heading);

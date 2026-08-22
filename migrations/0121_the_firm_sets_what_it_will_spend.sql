-- The firm sets what it will spend, and the quarantine gets an exit.
--
-- Operator, items 21 and 23: "i need to be able to set a firmwide budget very easily and have it
-- change, show up and persist"; and "cockpit is about controlling the app and how much the app
-- spends". Three schema changes, each closing a defect the operator hit on the deployed system.
--
-- WHY NOT `budget_scope` WITH scope_type = 'FIRM'. That table already carries DAILY/WEEKLY/MONTHLY
-- scoped caps and it is the right home for "cap Wyatt" or "cap research". It cannot express an
-- ALL-TIME ceiling — there is no period that means "ever" — and the operator asked for both halves.
-- A separate, deliberately tiny table says the firmwide ceiling is its own thing rather than one
-- more row in a list of thirty.

-- ── 1. The firmwide ceiling ──
--
-- MONEY IS CENTS. `budget_scope.cap_usd` is a REAL and predates this rule; a cap is the one number
-- where a rounding artefact turns into work being refused a fraction early or a fraction late, so
-- this table stores an integer count of cents and only display divides.
--
-- Versioned, never edited in place: changing a cap writes the next version with who and why, and
-- retiring one is `active = 0`. The highest version for a window wins, so the answer is the same
-- whatever order the rows were written in — which is what "deterministic" has to mean here.

CREATE TABLE IF NOT EXISTS firm_spend_budget (
  id            TEXT PRIMARY KEY,
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  -- Not `window`: that is a reserved word in SQLite's window-function grammar and quoting it
  -- everywhere forever is a worse trade than naming it plainly here.
  budget_window TEXT NOT NULL CHECK (budget_window IN ('MONTHLY','ALL_TIME')),
  cap_cents     INTEGER NOT NULL CHECK (cap_cents >= 0),
  version_no    INTEGER NOT NULL CHECK (version_no > 0),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  -- Required. A ceiling with no stated reason is one nobody can argue with later.
  reason        TEXT NOT NULL,
  set_by        TEXT NOT NULL REFERENCES firm_user (id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_firm_spend_budget_version
  ON firm_spend_budget (firm_scope, budget_window, version_no);

-- DELIBERATELY NO SEED ROW. A cap nobody chose is a cap nobody believes, and inventing one here
-- would make the page report a ceiling the operator never set. No row means no ceiling, and the
-- page says exactly that in words.

-- ── 2. "Best available" has to mean something ──
--
-- The four spend postures wrote three distinct policies. "Balanced" and "Best available" both wrote
-- cost_mode NORMAL with pins honoured — byte-identical rows — so a partner who chose the expensive
-- setting got the cheap behaviour and the page then displayed "Balanced" back at them. Two choices
-- producing one policy means one of them is a lie.
--
-- `cost_mode` cannot carry this. It says how careful to be about money; this says which way to lean
-- when nothing has been pinned, which is the opposite question. Defaults to 0 so every policy
-- version already written keeps behaving exactly as it did.

ALTER TABLE budget_policy ADD COLUMN prefers_frontier INTEGER NOT NULL DEFAULT 0;

-- ── 3. A quarantine with an exit ──
--
-- 51 completed AI outputs sat quarantined in production and could not be accepted, because the
-- accept route existed with no button and there was no reject at all. A queue with no exit only
-- grows, and every run in it is counted as rework cost forever.
--
-- Accept already flips `ai_run.output_quarantine` to 0. Discard must NOT: the whole point is that
-- the text never becomes usable. So the decision lives here instead, which also gives accept the
-- thing it never had — a reason, and a row rather than only an event.
--
-- The output text itself is kept on the run either way. A discarded output that vanished would
-- leave "why did we throw this away" unanswerable, and the firm already decided (document delete,
-- 21 Aug 2026) that removal is a tombstone and the trail survives.

CREATE TABLE IF NOT EXISTS ai_output_decision (
  id         TEXT PRIMARY KEY,
  ai_run_id  TEXT NOT NULL UNIQUE REFERENCES ai_run (id),
  decision   TEXT NOT NULL CHECK (decision IN ('ACCEPTED','DISCARDED')),
  -- Optional on accept, required by the handler on discard: throwing work away is the decision that
  -- somebody later needs explained.
  reason     TEXT,
  decided_by TEXT NOT NULL REFERENCES firm_user (id),
  decided_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  firm_scope TEXT NOT NULL DEFAULT 'west-peek'
);

CREATE INDEX IF NOT EXISTS idx_ai_output_decision_run ON ai_output_decision (ai_run_id);

-- ── 4. The two new action keys ──
--
-- authorize() denies an unknown key, so a feature whose key is missing here works locally and 403s
-- in production. `ON CONFLICT DO NOTHING` and not `INSERT OR IGNORE`: the seed generator also emits
-- these into 0003, so a fresh database inserts them before this file runs and a plain INSERT would
-- fail on the primary key. OR IGNORE would swallow a CHECK failure too — which is how a scheduled
-- job silently failed to exist twice in this repo — whereas this only forgives the duplicate key.

INSERT INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('ai_output.discard', 'Throw away a quarantined AI output',
   'Refuse a completed AI output so it is never used, with a stated reason. The run and its text stay on the record.', 0, 0),
  ('firm_budget.set', 'Set what the firm will spend',
   'Publish a new version of the firmwide monthly or all-time spending ceiling. Enforced at the AI boundary, not just displayed.', 0, 0)
ON CONFLICT (key) DO NOTHING;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0121_the_firm_sets_what_it_will_spend');

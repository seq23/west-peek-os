-- ONE LEVER, A GRADIENT MEASURED AGAINST THE MONTH ELAPSED, AND MODELS JUDGED ON WHAT THEY DID.
--
-- The owner set the real targets on 17 Sep 2026 and they supersede what 0178 shipped this morning:
--
--   under $5    normal
--   $5 – $10    starts making cheaper choices
--   over $10    moves cautiously — free-first hard, paid only for protected work
--   $50         NOTIFY her, with the bypass decision in front of her
--   $75         HARD STOP, bypass available
--
-- Three things change in this file, and they are three because they are three different questions.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 1. THE CEILING MOVES TO $75 AND $50 STOPS BEING A STOP
--
-- 0178 set the first monthly ceiling this firm ever had, at $50, because that was the worst case
-- she had named at the time. She has now named two numbers instead of one, and they do different
-- jobs: $50 is where she wants to be TOLD, $75 is where the firm stops. A single number could only
-- ever be one of those, and making $50 the stop meant the first she heard of it was work failing.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 2. `cost_mode` WAS FOUR VALUES ANSWERING THREE UNRELATED QUESTIONS
--
-- NORMAL / CHEAPO / CRITICAL_ONLY / STRATEGIC_SURGE sat in one column, and reading down them:
--
--   NORMAL, CHEAPO    → how much money
--   CRITICAL_ONLY     → what work runs at all
--   STRATEGIC_SURGE   → lift the caps, temporarily
--
-- Those are not four settings of one thing. They are three things wearing one column, and this
-- morning's near-miss came straight out of that conflation: CHEAPO means "spend less", and because
-- it was also the switch that answered "how good", it silently ignored `preferredModel` — so all
-- eight search call sites would have gone to a model with no web access, which does not error, it
-- answers from memory.
--
-- Boss OS already separates these and its comment states the rule: "how good" and "how much money"
-- are different decisions, the lever never moves the mode and the mode never moves the lever. That
-- separation is ADOPTED here and the code is written fresh — copied and diverged, never imported.
-- boss-os is a different product with a different chassis; a shared import would couple them.
--
-- So: one lever the owner touches, three positions.
--
--   FREE_ONLY   nothing paid, at all
--   MODERATE    the default; the gradient above runs inside this position
--   OPEN        spend what is needed up to the ceiling; the gradient stops tightening
--
-- And everything else stops being a lever position:
--   · the $75 hard stop is automatic (firm_spend_budget), not something she selects;
--   · bypass is an EVENT with an expiry and her name on it (spend_bypass), not a lever left pulled;
--   · protected work is governed by the judgement/interpretation marking, never by lever position;
--   · "what work runs at all" keeps its own column, `defer_non_critical`, because it is its own
--     question and merging it back in is the defect this migration exists to undo.
--
-- HER HAND ALWAYS WINS. The gradient never writes to `spend_lever`. FREE_ONLY stays free at $0
-- spent; OPEN stays open at $40. The gradient decides behaviour BETWEEN her instructions, and the
-- only way the stored lever changes is a person changing it.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 3. WHICH MODELS ACTUALLY DO WHICH JOBS
--
-- Selection judges "cheapest adequate" on paper specs, and that is exactly how a single pricing row
-- (0158, perplexity/sonar at $1/$1) won a judging job for a model that then refused its own answer
-- three times. `model_job_outcome` records what happened, by (task kind, model), so the router can
-- prefer the cheapest model that has ACTUALLY DONE THIS JOB WELL over the cheapest that merely
-- looks adequate on a spec sheet.
--
-- THE HONEST LIMIT, BUILT IN RATHER THAN NOTED. There are a few hundred runs of history in this
-- system. An UNPROVEN model is UNKNOWN, not good, and unknown must never win a job that matters —
-- so evidence below the threshold reports INSUFFICIENT_EVIDENCE and the router falls back to the
-- capability-and-price rule it uses today rather than guessing from three data points.

-- ── The lever ────────────────────────────────────────────────────────────────────────────────
-- NULLABLE, WITH NO DEFAULT, AND THAT IS THE WHOLE DESIGN OF THIS COLUMN.
--
-- The obvious migration was `NOT NULL DEFAULT 'MODERATE'` plus an UPDATE backfilling each historic
-- row with the lever it behaved as. `budget_policy` refused the UPDATE, correctly: it is immutable
-- by trigger, because a versioned policy table whose history can be rewritten is not a history.
--
-- That refusal is right on more than a technicality. A default of 'MODERATE' would have written a
-- claim into every historic row — including the CHEAPO/honours_pins=0 rows that were the "free
-- only" posture — and the claim would have been FALSE for exactly the rows a person would go back
-- and read. A column that lies about the past is worse than a column that is empty about it.
--
-- So the column is NULL for every row written before this migration, and NULL means "this row
-- predates the lever; read it the old way". `leverFromPolicy()` in src/shared/ai/spendLever.ts does
-- that translation, through the same `translateLegacyCostMode` the API uses for old callers — one
-- tested function rather than a copy of the mapping in SQL that could drift from the copy in TS.
ALTER TABLE budget_policy ADD COLUMN spend_lever TEXT;

-- "What work runs at all", extracted from the enum it never belonged in. NULL on historic rows for
-- the same reason, and read as `cost_mode = 'CRITICAL_ONLY'` when absent.
ALTER TABLE budget_policy ADD COLUMN defer_non_critical INTEGER;

-- ── What the old values become ───────────────────────────────────────────────────────────────
-- Not written here, because nothing may be written to a historic row. The mapping is applied on
-- READ, and it is the one the routing code actually implemented — read off runAi.ts rather than
-- inferred from the value names:
--
--   cost_mode        honours_pins  prefers_frontier  →  spend_lever  defer_non_critical
--   ─────────────────────────────────────────────────────────────────────────────────────
--   CHEAPO           0             –                 →  FREE_ONLY    0
--   CHEAPO           1             –                 →  MODERATE     0
--   NORMAL           –             1                 →  OPEN         0
--   NORMAL           –             0                 →  MODERATE     0
--   CRITICAL_ONLY    –             –                 →  MODERATE     1
--   STRATEGIC_SURGE  –             –                 →  OPEN         0   (+ a bypass, below)
--
-- CHEAPO with honours_pins = 0 is the posture the UI called "Free only", and it is the only one
-- that was ever allowed to override a pin. It reads as FREE_ONLY, which is the same intent stated
-- as a lever position rather than as two columns nobody could read together.

-- ── The live default ─────────────────────────────────────────────────────────────────────────
-- A new policy row, because budget_policy is immutable by trigger and the latest row wins.
--
-- SAME CARE AS 0178 AND FOR THE SAME REASON. Privacy is COPIED from the policy currently in force,
-- never restated as a literal: a firm that has never been configured is on LOCKDOWN, and hard-coding
-- FRONTIER here would switch it to "external calls are fine" as a side effect of a spend change.
-- A COST MIGRATION CHANGES COST.
--
-- `cost_mode` is still written because the column is NOT NULL and older readers still select it.
-- It is written as NORMAL and it is now DERIVED, not consulted: see legacyCostModeFor() in
-- src/shared/ai/spendLever.ts, and the validator that fails if any routing decision reads it.
-- The caps are restated because a new row inherits nothing: daily $2.50 and per-run $0.75 stay,
-- exactly as the owner left them.
INSERT INTO budget_policy
  (id, firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, honours_pins, prefers_frontier, spend_lever, defer_non_critical, set_by)
SELECT 'bp_0179_moderate', 'west-peek', 'NORMAL', b.privacy_mode, 2.5, 0.75, 1, 0, 'MODERATE', 0, 'fu_sequoia_taylor'
  FROM budget_policy b
 WHERE b.firm_scope = 'west-peek'
   AND NOT EXISTS (SELECT 1 FROM budget_policy WHERE id = 'bp_0179_moderate')
 ORDER BY b.created_at DESC, b.rowid DESC
 LIMIT 1;

-- ── The ceiling moves to $75 ─────────────────────────────────────────────────────────────────
-- Versioned, like every other policy here: a new row at version MAX+1, the old one stays readable.
-- Guarded so it can only ever RAISE an existing ceiling — a firm that has not set one gets nothing,
-- because inventing a ceiling for somebody who never asked for one is the ambush this table exists
-- to avoid.
INSERT INTO firm_spend_budget (id, firm_scope, budget_window, cap_cents, version_no, active, reason, set_by)
SELECT 'fsb_0179_monthly_75', 'west-peek', 'MONTHLY', 7500, MAX(version_no) + 1, 1,
  'The owner set the real ladder on 17 Sep 2026: $50 is where she is NOTIFIED with the bypass decision in front of her, $75 is where the firm stops. 0178 had one number doing both jobs, so the first she would have heard of $50 was work failing.',
  'fu_sequoia_taylor'
  FROM firm_spend_budget
 WHERE firm_scope = 'west-peek' AND budget_window = 'MONTHLY'
   AND NOT EXISTS (SELECT 1 FROM firm_spend_budget WHERE id = 'fsb_0179_monthly_75')
HAVING COUNT(*) > 0;

-- ── Bypass: an event with an expiry and a name, not a lever left pulled ──────────────────────
-- STRATEGIC_SURGE was a lever position, which meant "lift the caps" was a state somebody could
-- leave the firm in indefinitely by forgetting about it. A bypass is a decision taken at a moment,
-- for a reason, by a person, until a time — so it is a row with all four of those and it expires on
-- its own. Nothing renews it but another decision.
CREATE TABLE IF NOT EXISTS spend_bypass (
  id            TEXT PRIMARY KEY,
  firm_scope    TEXT NOT NULL,
  -- Which ceiling is being bypassed. Only the firmwide monthly one today; named rather than assumed
  -- so a second ceiling cannot be lifted by a row that predates it.
  budget_window TEXT NOT NULL CHECK (budget_window IN ('MONTHLY','ALL_TIME')),
  -- What the firm may spend WHILE the bypass stands, in cents. Not "unlimited": a bypass with no
  -- number is the same unbounded state STRATEGIC_SURGE was, wearing a better name.
  ceiling_cents INTEGER NOT NULL CHECK (ceiling_cents > 0),
  reason        TEXT NOT NULL,
  -- Her name. A bypass authorised by "system" is a bypass nobody decided.
  granted_by    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  revoked_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_spend_bypass_live ON spend_bypass (firm_scope, budget_window, expires_at DESC);

-- ── What each model actually did, by task kind ───────────────────────────────────────────────
-- One row per outcome, never a running total. A counter cannot be audited, cannot be corrected, and
-- cannot answer "which runs was that" — and this table exists precisely because a single unaudited
-- number (a price) was allowed to decide which model read a partner's words.
--
-- `task_kind` is the classification marker the call site already carries — interpretation,
-- judgement, search, mechanical — so the cells are four per model rather than one per purpose
-- string. That matters for a system with a few hundred runs: 4 kinds x ~6 models is a grid that can
-- reach evidence, and one cell per purpose string never would.
CREATE TABLE IF NOT EXISTS model_job_outcome (
  id          TEXT PRIMARY KEY,
  task_kind   TEXT NOT NULL CHECK (task_kind IN ('interpretation','judgement','search','mechanical')),
  provider_id TEXT NOT NULL,
  model       TEXT NOT NULL,
  -- SUCCEEDED  a human accepted the output
  -- REWORKED   the run needed a fallback to a different model to produce anything
  -- REJECTED   a human threw the output away
  outcome     TEXT NOT NULL CHECK (outcome IN ('SUCCEEDED','REWORKED','REJECTED')),
  ai_run_id   TEXT NOT NULL,
  firm_scope  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- One outcome per (run, model, kind of outcome). A human cannot accept the same run twice, and a
  -- re-delivery must not look like a second success.
  --
  -- MODEL IS IN THE KEY, and it has to be: a run that failed over twice touched two models, and a
  -- key of (run, outcome) alone would silently keep the first REWORKED row and drop the second —
  -- the second model's failure would vanish into an INSERT OR IGNORE. That is exactly the "counts
  -- but quietly loses some" defect this table exists to replace.
  UNIQUE (ai_run_id, model, outcome)
);
CREATE INDEX IF NOT EXISTS idx_model_job_outcome_cell ON model_job_outcome (task_kind, provider_id, model);

-- The marker, on the run, so an outcome recorded at accept time knows which job it was.
-- Nullable: runs made before this migration carry no marker and are honestly absent from the
-- evidence rather than assigned a guess.
ALTER TABLE ai_run ADD COLUMN task_kind TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0179_one_lever_a_prorated_gradient_and_learned_models');

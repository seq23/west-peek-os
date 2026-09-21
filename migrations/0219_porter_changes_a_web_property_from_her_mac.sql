-- 0219 — Porter changes a web property from her Mac (owner, 20 Sep 2026; Plan A).
--
-- THE ASK. Scooter or Sequoia emails os@joinwestpeek.com a Google Drive folder and instructions
-- ("update the ventures site with this package"). The card lands on their chief of staff's desk
-- and is handed to Porter, and Porter then does on her Mac what a Claude Code session did by hand
-- on 20 Sep: pull the package, read the target repo's RUNBOOK.md, write a PLAN as a Document on
-- the card with the decisions split into DECIDED and ASK, go BLOCKED with the asks emailed to the
-- requesting partner, resume on the reply, BUILD in a git worktree with the repo's own validators,
-- open a PR, LAND on green with ~/bin/land, and prove it live.
--
-- THE WORKER CANNOT RUN CLAUDE CODE, so this reuses the ONE claim mechanism that already exists
-- (0187: heartbeat → claim → report) rather than building a second one. What 0187 could not say
-- was the KIND of run: every row was an answer to a prompt, run with no tools. This migration adds
-- the kind, so a machine that only answers questions is never handed a job that needs a worktree,
-- and a job that needs a worktree is never handed to a machine that cannot give it one.
--
-- FOUR THINGS ARE ADDED, each a guard at the row rather than a sentence in a prompt:
--
--   1 · `subscription_seat_run.run_kind` — ANSWER (0187's rows, the default) or LOCAL_JOB, with
--       `job_json` (what to do, which phase, which model) and `progressed_at` (a long job says it
--       is alive every minute; the reaper reads this rather than 0187's five-minute silence rule,
--       which would return a thirty-minute build to the pool on the first `npm run validate`).
--   2 · ONE LIVE RUN PER CARD, as a partial unique index. A card can have exactly one QUEUED or
--       CLAIMED job at a time. Her rule of 16 Sep — "never iterate in production when a pass
--       emails the partners" — is what this pins: a second run cannot be parked while the first
--       is out, whatever any sweep, button or retry tries.
--   3 · `web_property_change` — the state of one such card: the folder, the phase, the plan
--       document, what was decided and what was asked, the partner's answers and approval, the PR
--       and its check, the merge and the live proof. One row per card, keyed on the card.
--   4 · A CARD OF THIS KIND CANNOT GO DONE WITHOUT A PR LINK AND A RECORDED GREEN CHECK, as a
--       trigger. "Never take an agent's word that CI is green" (her rule, 19 Sep): the green is
--       observed by the Mac script from `gh pr checks`, written here, and the row refuses DONE
--       until it is there. A model cannot claim its way past this.
--
-- And the STANDING RULES of the kind are rows, not prose: `work_kind_rule` holds land-on-green
-- (ON, her decision of 20 Sep), the model per phase, the one-live-run cap and the no-iteration
-- rule, shown on the Work page and flippable by a Managing Partner where the row says so.

-- ── 1 · The kind of run ──────────────────────────────────────────────────────────────────────

ALTER TABLE subscription_seat_run ADD COLUMN run_kind TEXT NOT NULL DEFAULT 'ANSWER'
  CHECK (run_kind IN ('ANSWER', 'LOCAL_JOB'));
ALTER TABLE subscription_seat_run ADD COLUMN job_json TEXT;
ALTER TABLE subscription_seat_run ADD COLUMN progressed_at TEXT;
ALTER TABLE subscription_seat_run ADD COLUMN progress_note TEXT;

CREATE INDEX IF NOT EXISTS idx_seat_run_kind_status ON subscription_seat_run (run_kind, status, created_at);

-- ── 2 · One live run per card ────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS idx_seat_run_one_live_job_per_card
  ON subscription_seat_run (work_card_id)
  WHERE run_kind = 'LOCAL_JOB' AND status IN ('QUEUED', 'CLAIMED') AND work_card_id IS NOT NULL;

-- ── 3 · The state of a web property change ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS web_property_change (
  work_card_id      TEXT PRIMARY KEY REFERENCES work_card (id),
  -- The repo under ~/GitHub on her Mac. From shared/work/webProperties.ts, never from the email.
  target_repo       TEXT NOT NULL,
  property_host     TEXT,
  drive_folder_id   TEXT,
  drive_folder_url  TEXT,
  -- The partner's instructions, verbatim, as the runner hands them to each phase.
  ask               TEXT NOT NULL DEFAULT '',
  phase             TEXT NOT NULL DEFAULT 'PLAN' CHECK (phase IN ('PLAN', 'BUILD', 'LAND', 'DONE')),
  -- PLAN: the Document on the card, and the two lists.
  plan_deliverable_id TEXT,
  plan_document_id  TEXT,
  plan_filed_at     TEXT,
  decided_json      TEXT NOT NULL DEFAULT '[]',
  asks_json         TEXT NOT NULL DEFAULT '[]',
  -- The partner's answers (the reply, or the card), and the approval they amount to.
  answers_json      TEXT NOT NULL DEFAULT '[]',
  plan_approved_at  TEXT,
  plan_approved_by  TEXT,
  -- BUILD: the PR and what `gh pr checks` said, observed by the script, never by the model.
  pr_url            TEXT,
  pr_number         INTEGER,
  branch            TEXT,
  check_state       TEXT CHECK (check_state IS NULL OR check_state IN ('PENDING', 'GREEN', 'RED')),
  check_url         TEXT,
  check_green_at    TEXT,
  build_proof       TEXT,
  -- LAND: the merge and the curl proof the DONE email carries.
  merge_sha         TEXT,
  landed_at         TEXT,
  live_proof        TEXT,
  -- The lease: the run the Mac holds right now, so the sweep never double-claims the card.
  current_run_id    TEXT,
  run_history_json  TEXT NOT NULL DEFAULT '[]',
  last_report       TEXT,
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_web_property_change_phase ON web_property_change (phase, updated_at);

-- ── 4 · DONE needs a PR link, a green check and a merge ──────────────────────────────────────

DROP TRIGGER IF EXISTS trg_web_property_change_done_needs_proof;
CREATE TRIGGER trg_web_property_change_done_needs_proof
BEFORE UPDATE OF state ON work_card
WHEN NEW.state = 'DONE' AND OLD.state <> 'DONE' AND NEW.kind = 'WEB_PROPERTY_CHANGE'
  AND NOT EXISTS (
    SELECT 1 FROM web_property_change w
     WHERE w.work_card_id = NEW.id
       AND w.pr_url IS NOT NULL AND length(trim(w.pr_url)) > 0
       AND w.check_green_at IS NOT NULL
       AND w.merge_sha IS NOT NULL AND length(trim(w.merge_sha)) > 0
  )
BEGIN
  SELECT RAISE(ABORT, 'a web property change cannot be DONE without a PR link, a recorded green check and a merge — the proof is the finish (0219)');
END;

-- ── Standing rules, as rows ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS work_kind_rule (
  kind        TEXT NOT NULL,
  rule_key    TEXT NOT NULL,
  label       TEXT NOT NULL,
  value       TEXT NOT NULL,
  -- 1: a Managing Partner may change it on the Work page. 0: a fact about how the kind runs,
  -- shown so nobody has to read code to know it, changed only in a commit.
  editable    INTEGER NOT NULL DEFAULT 0 CHECK (editable IN (0, 1)),
  note        TEXT NOT NULL DEFAULT '',
  set_by      TEXT,
  set_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (kind, rule_key)
);

INSERT OR IGNORE INTO work_kind_rule (kind, rule_key, label, value, editable, note, set_by) VALUES
  ('WEB_PROPERTY_CHANGE', 'land_on_green', 'Land on green', 'on', 1,
   'Once the PR''s checks are green, Porter merges and deploys without a further reply. Her decision, 20 Sep 2026. Off means the card asks first.', 'fu_sequoia_taylor'),
  ('WEB_PROPERTY_CHANGE', 'model_plan', 'Model for the plan', 'opus', 1,
   'The phase that reads the package and the RUNBOOK and writes the plan. Judgement work.', 'fu_sequoia_taylor'),
  ('WEB_PROPERTY_CHANGE', 'model_build', 'Model for the build', 'sonnet', 1,
   'The phase that edits the repo in a worktree, runs its validators, takes the screenshots and opens the PR.', 'fu_sequoia_taylor'),
  ('WEB_PROPERTY_CHANGE', 'model_land', 'Model for the landing', 'haiku', 1,
   'The phase that lands on green and writes up the live proof. Mechanical; the cheapest model does it.', 'fu_sequoia_taylor'),
  ('WEB_PROPERTY_CHANGE', 'one_live_run', 'One live run per card', '1', 0,
   'A card has at most one run queued or on the Mac at a time — a unique index on the queue, not a promise.', NULL),
  ('WEB_PROPERTY_CHANGE', 'no_production_iteration', 'Never iterate in production when a pass emails the partners', 'on', 0,
   'Each phase runs once per attempt and emails at most once. Iteration happens against the repo''s validators in the worktree, never by re-running a live pass.', NULL);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0219_porter_changes_a_web_property_from_her_mac');

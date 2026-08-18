-- 0027_meeting_delegation.sql — P33: a meeting hands back work instead of notes.
--
-- Canon §3.3 (Meeting Buddy Layer) says the buddy produces "commitments, decision log, follow-up
-- tasks" after every meeting, and V1 #29 requires Walter to "route follow-ups". The schema for that
-- has existed since 0007 — meeting_commitment already carries owner_id, due_date, work_card_id and
-- a CONVERTED state. Nothing ever filled those fields except a human typing them in, so the
-- meeting system stored notes and gave nothing back.
--
-- WHAT CHANGES: commitments can now ORIGINATE from extraction, and an extracted commitment must
-- carry where it came from and who it is for.
--
-- ASSIGNMENT POLICY (operator direction, 17 Aug 2026): AI employees are the default assignee for
-- everything. Work is never silently handed to a person. Where a human genuinely needs to act or be
-- present, that is recorded as a RECOMMENDATION for the operator to accept — never as an assignment.
-- Hence three assignee kinds and not two:
--
--   AI_EMPLOYEE          — an active AI employee owns it. The default.
--   AI_WITH_HUMAN_TOUCH  — an AI employee owns the work, AND a human should be involved
--                          (the partner makes the call personally, the founder hears a human voice).
--                          Still assigned; the human involvement is advice attached to it.
--   HUMAN_RECOMMENDED    — only a person can do this. PROPOSED, never auto-assigned, because
--                          assigning work to a human being without them agreeing is not delegation.
--
-- Counterparty commitments are tracked and never assigned to anyone: what a founder promised us is
-- not our task list.
--
-- PROVENANCE IS NOT OPTIONAL. source_quote holds the words the commitment was read out of, and
-- extraction_ai_run_id links the model run that proposed it — carrying cost, provider and audit
-- trail. A follow-up task with no traceable origin is exactly the unsourced output this system
-- refuses to produce everywhere else. Both are nullable ONLY so that hand-entered commitments
-- (origin = 'MANUAL') keep working unchanged.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0027_meeting_delegation');

ALTER TABLE meeting_commitment ADD COLUMN origin TEXT NOT NULL DEFAULT 'MANUAL'
  CHECK (origin IN ('MANUAL','EXTRACTED'));

ALTER TABLE meeting_commitment ADD COLUMN assignee_kind TEXT NOT NULL DEFAULT 'UNASSIGNED'
  CHECK (assignee_kind IN ('AI_EMPLOYEE','AI_WITH_HUMAN_TOUCH','HUMAN_RECOMMENDED','UNASSIGNED'));

-- Which AI employee owns it. Named separately from owner_id because owner_id predates this and is
-- used for humans on manually entered commitments; conflating them would rewrite existing rows'
-- meaning.
ALTER TABLE meeting_commitment ADD COLUMN ai_employee_id TEXT REFERENCES ai_employee (id);

-- Why a human is wanted. Required in practice for the two human-touch kinds (enforced in the
-- service, not here — SQLite cannot express a conditional NOT NULL on ALTER).
ALTER TABLE meeting_commitment ADD COLUMN human_touch_reason TEXT;

ALTER TABLE meeting_commitment ADD COLUMN source_quote TEXT;
ALTER TABLE meeting_commitment ADD COLUMN extraction_ai_run_id TEXT REFERENCES ai_run (id);

-- ── Close-out digest ────────────────────────────────────────────────────────
--
-- "Tell me what deliverables were gathered and who was given which task." That is a dated artifact
-- like the daily brief: stored rather than regenerated, so re-reading it next week shows what was
-- said at the time and not a fresh model's opinion of it.
--
-- INTERNAL ONLY, and structurally so. There is no recipient address column and no send state. The
-- digest is delivered in-app and by push; anything leaving the building goes through
-- external_effect_request and an approval card, which is a different table on purpose.

CREATE TABLE IF NOT EXISTS meeting_closeout (
  id               TEXT PRIMARY KEY,
  meeting_id       TEXT NOT NULL REFERENCES meeting (id),
  digest_md        TEXT NOT NULL,
  commitment_count INTEGER NOT NULL DEFAULT 0,
  assigned_count   INTEGER NOT NULL DEFAULT 0,
  recommended_count INTEGER NOT NULL DEFAULT 0,
  unresolved_count INTEGER NOT NULL DEFAULT 0,
  state            TEXT NOT NULL DEFAULT 'READY'
                   CHECK (state IN ('READY','FAILED','REFUSED')),
  detail           TEXT,
  ai_run_id        TEXT REFERENCES ai_run (id),
  firm_scope       TEXT NOT NULL DEFAULT 'west-peek',
  created_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_meeting_closeout_meeting ON meeting_closeout (meeting_id);

-- Append-only (D15): a close-out is a record of what was gathered at a point in time. Re-running
-- extraction writes a NEW digest rather than editing the old one, so the history of what the
-- meeting was understood to have produced stays intact.
CREATE TRIGGER IF NOT EXISTS meeting_closeout_reject_update
BEFORE UPDATE ON meeting_closeout
BEGIN
  SELECT RAISE(ABORT, 'meeting_closeout is append-only: UPDATE rejected (D15)');
END;

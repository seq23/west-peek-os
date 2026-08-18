-- 0041_approval_centre.sql — P47: the Approval Centre gets what canon §24.2 asks for (V1 #37).
--
-- Cards and decisions already worked. What was missing is everything that lets an approver decide
-- WELL rather than merely decide: the risk, the evidence, the impact, who should be deciding, when
-- it goes stale, and somewhere to ask a question before committing.
--
-- WHY THIS MATTERS MORE THAN IT SOUNDS. An approval queue whose items cannot be evaluated in place
-- trains the approver to click approve — they either go hunting for context in four other pages or
-- they stop looking. Either way the gate becomes ceremony, and the whole governance model in this
-- system rests on that gate being real.
--
-- RISK IS DERIVED, NOT TYPED. It comes from the action key (shared/approvals/risk.ts), so an
-- external send is HIGH whoever raised it and nobody can lower their own request's risk to get a
-- faster look. A self-assessed risk field would be worse than none.
--
-- EXPIRY IS ADVISORY. A stale card is flagged, never auto-approved and never auto-rejected — both
-- would be the system making a decision it has no authority to make. Canon §22A.7 puts external
-- actions behind a human, and silence is not a human.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0041_approval_centre');

ALTER TABLE approval_card ADD COLUMN risk_level TEXT NOT NULL DEFAULT 'UNCLASSIFIED'
  CHECK (risk_level IN ('UNCLASSIFIED','LOW','MEDIUM','HIGH','RESERVED'));

-- What happens if this is wrong, in the approver's terms — money, a relationship, a commitment.
ALTER TABLE approval_card ADD COLUMN impact_note TEXT;

-- Who this most belongs to. Advisory: it does not restrict who MAY decide, which is governed by
-- required_approver_roles_json and unchanged here.
ALTER TABLE approval_card ADD COLUMN recommended_approver TEXT;

-- After this the card is shown as stale. Nothing happens automatically.
ALTER TABLE approval_card ADD COLUMN expires_at TEXT;

-- ── Evidence behind a card ──────────────────────────────────────────────────
--
-- A link table rather than a JSON blob, so the evidence a decision rested on can still be found
-- from the other end: "what did we approve on the strength of this claim" is a question the audit
-- trail should be able to answer.

CREATE TABLE IF NOT EXISTS approval_evidence (
  id               TEXT PRIMARY KEY,
  approval_card_id TEXT NOT NULL REFERENCES approval_card (id),
  kind             TEXT NOT NULL
                   CHECK (kind IN ('CLAIM','DOCUMENT','INTELLIGENCE_ITEM','MEETING','CONTRADICTION','OTHER')),
  ref_id           TEXT,
  label            TEXT NOT NULL,
  detail           TEXT,
  added_by         TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_approval_evidence_card ON approval_evidence (approval_card_id);

-- ── Comments ────────────────────────────────────────────────────────────────
--
-- So an approver can ask before deciding rather than rejecting for want of an answer. Append-only:
-- the conversation that led to a decision is part of the decision's record, and an editable thread
-- is one where the reasoning can be quietly rewritten afterwards.

CREATE TABLE IF NOT EXISTS approval_comment (
  id               TEXT PRIMARY KEY,
  approval_card_id TEXT NOT NULL REFERENCES approval_card (id),
  author_type      TEXT NOT NULL CHECK (author_type IN ('HUMAN','AI')),
  author_id        TEXT NOT NULL,
  body             TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_approval_comment_card ON approval_comment (approval_card_id, created_at);

CREATE TRIGGER IF NOT EXISTS approval_comment_reject_update
BEFORE UPDATE ON approval_comment
BEGIN
  SELECT RAISE(ABORT, 'approval_comment is append-only: UPDATE rejected (D15)');
END;

-- The IC packet names its own gaps, and each gap is owed by somebody. ADR-019.
--
-- Operator, 22 Aug 2026: "the IC flow ----who makes the packet how does that get done? how do we
-- get thru the pipeline and what happens to the page once a deal is at the IC stage?"
--
-- POPPY MAKES IT, AND SHE DOES NOT FILL IN WHAT THE FIRM DOES NOT KNOW. The packet is drafted from
-- records that already exist — verified claims, diligence answers, portfolio metrics, deal math —
-- and everything missing becomes a QUESTION rather than a paragraph. A packet that invents its
-- missing half is worse than a short one: it reads as complete, so nobody goes looking. That is the
-- whole reason this table exists instead of a longer text column on ic_packet.
--
-- `because` IS NOT DECORATION AND IS NOT NULLABLE. A question with no account of what was looked at
-- reads as an oversight rather than a gap, and the first thing anybody asks about it is "did you
-- check X" — which is exactly what this field answers in advance.
--
-- WHO OWES IT is on the row because a question with nobody against it is one nobody has agreed to
-- answer. The bear case is owed by a partner who is NOT carrying the deal, which is the same rule
-- icPortal.ts already enforces on the diligence sections: the champion cannot argue against his own
-- investment, or IC becomes a sales meeting for it.
CREATE TABLE IF NOT EXISTS ic_open_question (
  id             TEXT PRIMARY KEY,
  ic_packet_id   TEXT NOT NULL REFERENCES ic_packet (id),
  -- The part of the packet the gap sits in, when there is one. NULL for a gap that belongs to the
  -- whole deal rather than to a section — no deal math, an unresolved contradiction.
  section_id     TEXT,
  question       TEXT NOT NULL CHECK (length(trim(question)) >= 8),
  because        TEXT NOT NULL CHECK (length(trim(because)) >= 8),
  owed_by_kind   TEXT NOT NULL
                 CHECK (owed_by_kind IN ('PARTNER','CHAMPION','AI_EMPLOYEE','COUNTERPARTY','UNASSIGNED')),
  -- A roster first name or a person's name, in plain words. Deliberately not a foreign key: the
  -- answer to "who owes this" is sometimes a founder, and a founder is not a row in firm_user.
  owed_by        TEXT,
  state          TEXT NOT NULL DEFAULT 'OPEN'
                 CHECK (state IN ('OPEN','ANSWERED','WITHDRAWN')),
  answer         TEXT,
  answered_by    TEXT,
  answered_at    TEXT,
  -- Withdrawing is not answering. A question the firm decided it does not need is a different fact
  -- from one it answered, and collapsing the two would let a packet close its gaps by shrugging.
  withdrawn_reason TEXT,
  raised_by_type TEXT NOT NULL CHECK (raised_by_type IN ('HUMAN','AI','SYSTEM')),
  raised_by_id   TEXT NOT NULL,
  ai_run_id      TEXT,
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- One row per gap. Re-drafting a packet tops up rather than duplicating, which is what makes it
  -- safe to run the draft again after more diligence has landed.
  UNIQUE (ic_packet_id, question)
);

CREATE INDEX IF NOT EXISTS idx_ic_open_question_packet ON ic_open_question (ic_packet_id, state);

-- Where a transcript actually came from, by name (ADR-019).
--
-- Operator, 22 Aug 2026: "i sometimes have fireflies meeting notes so the meetings should have
-- fireflies and whisper capabilities to transfer those notes and transcripts."
--
-- `source` already said PROVIDER / NATIVE / MANUAL / UPLOAD, which is the right shape and the wrong
-- resolution: "PROVIDER" does not tell a reader whether the firm made this recording or somebody
-- else did. That distinction is evidential rather than cosmetic. A turn West Peek captured itself
-- was recorded with permission this firm asked for and logged; a turn arriving in a Fireflies export
-- was recorded under conditions nobody here witnessed, and importing it is never the same act as
-- obtaining consent. Both are usable. Only one is something the firm can vouch for.
ALTER TABLE transcript_import ADD COLUMN provider_name TEXT;

-- Compensating action-type rows (the P4 convention). These keys are in the TS registry
-- (src/shared/registry/actionTypes.ts) and belong in the generated 0003 seed block, which reaches
-- new databases only; this reaches the database that is already live. Without it authorize()
-- denies the key and the surface 403s in production while every local test passes.
--
-- ON CONFLICT DO NOTHING and not INSERT OR IGNORE: the generator legitimately re-emits the same
-- key, so a duplicate key is a genuine no-op — but OR IGNORE would ALSO swallow a CHECK failure
-- silently, which has shipped a bug in this repo twice. This form ignores exactly one thing.
INSERT INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('ic_packet.question.raise',
   'Name a gap in the IC packet',
   'Record something the packet does not know as a question, with what was looked at and who owes the answer. Naming a gap is never the same as filling it in.',
   0, 0),
  ('ic_packet.question.answer',
   'Answer or withdraw an IC question',
   'Answer an open question on an IC packet, or withdraw one the firm decided it does not need, with a reason. Withdrawing is recorded as withdrawing and never as answered.',
   0, 0)
ON CONFLICT (key) DO NOTHING;

-- OR IGNORE here and NOWHERE else in this file: the version marker is the one row where a re-apply
-- is genuinely a no-op rather than a swallowed failure.
INSERT OR IGNORE INTO schema_version (migration) VALUES ('0131_the_packet_says_what_it_does_not_know');

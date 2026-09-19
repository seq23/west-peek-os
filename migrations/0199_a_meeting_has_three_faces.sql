-- 0199 — A meeting has three faces, and the third one was missing.
--
-- Owner-approved design, 18 Sep 2026. A meeting is ONE object with three faces: BEFORE (the brief),
-- DURING (capture, the live room — Phase C) and AFTER (what came out). P7 built the record and the
-- during-face; P33 built extraction of firm-side commitments; nothing ever wrote down what was
-- SETTLED, what is still UNKNOWN, what the OTHER side owes us, or what a deal meeting means for the
-- deal's stage. Those four are first-class here, for every meeting type — not only IC.
--
-- NOTHING HERE IS A RECORD UNTIL A PARTNER SAYS SO. An AI employee drafts the After face from the
-- notes and the transcript into `meeting_after_draft`; approving the draft is a human-only act
-- (meeting.after.approve, enforced in code) and is the only path by which a draft's contents reach
-- the four tables below. A stage proposal is a proposal: accepting it calls the ordinary
-- `opportunity.transition` path under authorize(), and nothing transitions on its own.
--
-- NEW TABLES RATHER THAN NEW KINDS. `deliverable.kind` is a CHECK that D1 cannot widen (0189 and
-- 0196 each rebuilt the table to add one word), so a saved block on a meeting gets its own table,
-- `meeting_artifact`, keyed by the meeting it belongs to.
--
-- Phase C (the live room) writes `meeting_artifact` rows and calls the drafter on a rolling basis;
-- a sibling migration (0202/0203) adds the Google Meet columns to `meeting`. Neither is touched here.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0199_a_meeting_has_three_faces');

-- ── The meeting, and the two things it can be about ───────────────────────────────────────────
--
-- A meeting could name a company but never an LP, so "what did we say to this LP last time" had no
-- join to follow. Nullable, like company_id: an internal sync is about neither.
ALTER TABLE meeting ADD COLUMN lp_record_id TEXT REFERENCES lp_record (id);
CREATE INDEX IF NOT EXISTS idx_meeting_lp ON meeting (lp_record_id) WHERE lp_record_id IS NOT NULL;

-- A card raised from a meeting returns to it. Nullable; every existing caller of
-- createWorkCardInternal is unchanged.
ALTER TABLE work_card ADD COLUMN meeting_id TEXT REFERENCES meeting (id);
CREATE INDEX IF NOT EXISTS idx_work_card_meeting ON work_card (meeting_id) WHERE meeting_id IS NOT NULL;

-- ── BEFORE: the brief lives on the prep packet P7 already had ─────────────────────────────────
--
-- `meeting_prep_packet` was the IC-shaped prep (evidence summary, contradictions, open questions).
-- Generalised rather than duplicated: the same row now carries the whole brief for every type —
-- why the meeting exists, what to find out, what both sides said last time, the record, the
-- diligence framework marked answered/unanswered — as structured JSON plus the rendered text, and
-- the COVERAGE block that makes an empty brief believable. Older rows keep NULL here and are simply
-- not briefs.
ALTER TABLE meeting_prep_packet ADD COLUMN brief_json TEXT;
ALTER TABLE meeting_prep_packet ADD COLUMN body_md TEXT;
ALTER TABLE meeting_prep_packet ADD COLUMN coverage_json TEXT;
-- The roster name of the employee who prepared it (the type's lead), for the by-line.
ALTER TABLE meeting_prep_packet ADD COLUMN prepared_by TEXT;

-- ── AFTER: what was settled ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meeting_decision (
  id                    TEXT PRIMARY KEY,
  meeting_id            TEXT NOT NULL REFERENCES meeting (id),
  decision_text         TEXT NOT NULL CHECK (length(trim(decision_text)) >= 3),
  -- Who settled it, in plain words: "both partners", "the founder", "Scooter". Not a foreign key,
  -- because the deciding party is often not a row in firm_user.
  decided_by            TEXT,
  -- Where it came from. Either may be null on a hand-typed decision; a drafted one quotes the line.
  source_note_id        TEXT REFERENCES meeting_note (id),
  source_quote          TEXT,
  recorded_by_type      TEXT NOT NULL CHECK (recorded_by_type IN ('HUMAN','AI','SYSTEM')),
  recorded_by_id        TEXT NOT NULL,
  -- The run that drafted it, when a draft was the origin. Provenance is not optional for AI output.
  ai_run_id             TEXT,
  after_draft_id        TEXT,
  firm_scope            TEXT NOT NULL DEFAULT 'west-peek',
  recorded_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_meeting_decision_meeting ON meeting_decision (meeting_id, recorded_at);

-- ── AFTER: what is owed, on BOTH sides ────────────────────────────────────────────────────────
--
-- `meeting_commitment` already carries owner_side FIRM|COUNTERPARTY, due_date, status and the
-- convert-to-work-card path for FIRM. Extended, not superseded: two additions make the counterparty
-- side chaseable.
--
--   owed_by      who holds it, in plain words ("Deana Oliver", "Acme's CFO", "Wyatt"). owner_id
--                stays what it was — a firm_user id on hand-entered firm commitments.
--   honoured_at  when a commitment was delivered on. The status CHECK (OPEN|CONVERTED|DROPPED)
--                cannot be widened in D1, and DROPPED means "we stopped tracking it", which is a
--                different fact from "they did it". So OPEN + honoured_at IS NULL is what "still
--                owed" means, and the brief and the ledger read it that way.
ALTER TABLE meeting_commitment ADD COLUMN owed_by TEXT;
ALTER TABLE meeting_commitment ADD COLUMN honoured_at TEXT;
ALTER TABLE meeting_commitment ADD COLUMN honoured_note TEXT;
ALTER TABLE meeting_commitment ADD COLUMN after_draft_id TEXT;
CREATE INDEX IF NOT EXISTS idx_meeting_commitment_open ON meeting_commitment (owner_side, status, honoured_at);

-- ── AFTER: what is still unknown ──────────────────────────────────────────────────────────────
--
-- Opened in one meeting, resolved (or withdrawn) in a later one — or never. Rolls forward into the
-- next brief for the same company or LP until it is. The owed_by vocabulary is ic_open_question's,
-- so "who owes this" means the same thing in a committee packet and in a founder call.
CREATE TABLE IF NOT EXISTS meeting_open_question (
  id                      TEXT PRIMARY KEY,
  meeting_id              TEXT NOT NULL REFERENCES meeting (id),
  question                TEXT NOT NULL CHECK (length(trim(question)) >= 8),
  owed_by_kind            TEXT NOT NULL
                          CHECK (owed_by_kind IN ('PARTNER','AI_EMPLOYEE','COUNTERPARTY','UNASSIGNED')),
  owed_by                 TEXT,
  state                   TEXT NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','ANSWERED','WITHDRAWN')),
  answer                  TEXT,
  resolved_in_meeting_id  TEXT REFERENCES meeting (id),
  resolved_by             TEXT,
  resolved_at             TEXT,
  withdrawn_reason        TEXT,
  raised_by_type          TEXT NOT NULL CHECK (raised_by_type IN ('HUMAN','AI','SYSTEM')),
  raised_by_id            TEXT NOT NULL,
  source_quote            TEXT,
  ai_run_id               TEXT,
  after_draft_id          TEXT,
  firm_scope              TEXT NOT NULL DEFAULT 'west-peek',
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_meeting_open_question_meeting ON meeting_open_question (meeting_id, state);

-- ── AFTER: what this means for the deal — a PROPOSAL, one click from a partner ────────────────
CREATE TABLE IF NOT EXISTS meeting_stage_proposal (
  id                TEXT PRIMARY KEY,
  meeting_id        TEXT NOT NULL REFERENCES meeting (id),
  opportunity_id    TEXT NOT NULL REFERENCES investment_opportunity (id),
  from_status       TEXT NOT NULL,
  to_status         TEXT NOT NULL,
  rationale         TEXT NOT NULL CHECK (length(trim(rationale)) >= 8),
  state             TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (state IN ('PROPOSED','ACCEPTED','DECLINED')),
  proposed_by_type  TEXT NOT NULL CHECK (proposed_by_type IN ('HUMAN','AI','SYSTEM')),
  proposed_by_id    TEXT NOT NULL,
  ai_run_id         TEXT,
  after_draft_id    TEXT,
  -- Filled by the partner who accepted or declined. Never by the proposer.
  decided_by        TEXT,
  decided_at        TEXT,
  decision_note     TEXT,
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_meeting_stage_proposal_meeting ON meeting_stage_proposal (meeting_id, state);
CREATE INDEX IF NOT EXISTS idx_meeting_stage_proposal_opportunity ON meeting_stage_proposal (opportunity_id, state);

-- ── A saved block on the meeting ──────────────────────────────────────────────────────────────
--
-- Phase C's "ask the room" produces answers, tables, charts, packets and summaries during the
-- meeting. They are saved here, on the meeting, read-only on the record. This phase creates the
-- table and the list route; Phase C writes the rows.
CREATE TABLE IF NOT EXISTS meeting_artifact (
  id                TEXT PRIMARY KEY,
  meeting_id        TEXT NOT NULL REFERENCES meeting (id),
  kind              TEXT NOT NULL CHECK (kind IN ('answer','table','chart','packet','summary')),
  title             TEXT NOT NULL CHECK (length(trim(title)) >= 1),
  body_json         TEXT NOT NULL DEFAULT '{}',
  produced_by_type  TEXT NOT NULL CHECK (produced_by_type IN ('HUMAN','AI','SYSTEM')),
  produced_by_id    TEXT NOT NULL,
  ai_run_id         TEXT,
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_meeting_artifact_meeting ON meeting_artifact (meeting_id, created_at);

-- ── The After draft: a proposal, and the only door into the four tables above ─────────────────
--
-- `source_hash` fingerprints the notes and transcript the draft was read from. Drafting again over
-- the same input returns the same draft instead of paying for a second run, which is what lets
-- Phase C call the drafter on a rolling basis without producing a pile of identical drafts.
-- Append-only by convention: a draft that failed says why in `detail` and stays as the record that
-- the attempt was made.
CREATE TABLE IF NOT EXISTS meeting_after_draft (
  id                 TEXT PRIMARY KEY,
  meeting_id         TEXT NOT NULL REFERENCES meeting (id),
  draft_json         TEXT NOT NULL DEFAULT '{}',
  source_hash        TEXT NOT NULL,
  notes_read         INTEGER NOT NULL DEFAULT 0,
  -- The roster name of the employee who drafted it — the type's lead from meetingTypes.ts.
  drafted_by         TEXT NOT NULL,
  ai_run_id          TEXT,
  state              TEXT NOT NULL DEFAULT 'DRAFTED'
                     CHECK (state IN ('DRAFTED','APPROVED','DISCARDED','FAILED','REFUSED')),
  detail             TEXT,
  approved_by        TEXT,
  approved_at        TEXT,
  firm_scope         TEXT NOT NULL DEFAULT 'west-peek',
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_meeting_after_draft_meeting ON meeting_after_draft (meeting_id, created_at);

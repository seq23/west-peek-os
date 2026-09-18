-- Finished work reaches her.
--
-- WHAT HAPPENED. The owner asked for a one-off: Parker drafts an event kit for an October workshop
-- with Kirx Diaz, previewed to her for approval before it goes to Scooter. Parker did the work —
-- five COMPLETED `ai_run` rows on a free reasoning lane at $0, the last carrying a complete kit.
-- Then the card went to DONE with no `deliverable` row, no `work_packet`, no `preview_approval` and
-- no email. The kit existed only inside `ai_run.output_text`, which no page renders.
--
-- The generic employee loop in `services/employeeWork.ts` recorded a `finding` on the card and
-- closed it. It has never filed anything. `shared/work/finishedWork.ts` carries the full account and
-- the two rules that replace it; this migration is the half of that fix the database has to hold.
--
-- WHAT THIS MIGRATION DOES. Widens `deliverable.kind` to accept `work_result`, the kind a finished
-- generic card now files under. `DELIVERABLE_KINDS` gained it in the same change, and
-- `validate:deliverable-kinds` fails the build when the TypeScript union and this CHECK disagree —
-- which is exactly the defect 0189 existed to repair, so it is not being recreated here by
-- widening one list and forgetting the other.
--
-- WHY THE TABLE IS REBUILT RATHER THAN ALTERED, and why the order below is not the obvious one:
-- both reasons are set out at length in 0189 and are unchanged. SQLite cannot widen a CHECK in
-- place; `DROP TABLE deliverable` crashes D1; and renaming `deliverable` away rewrites every other
-- table's foreign key to follow it, so `preview_approval` and `deliverable_feedback` are rebuilt
-- afterwards to pin their references back to the real table regardless of what the rename did.
-- 0189 found `deliverable_feedback` already silently repointed at a rollback copy by 0180. The
-- rebuild is correct whether or not any pragma took effect, and
-- `validate:deliverable-kinds` asserts the end state rather than trusting it.
--
-- THE REBUILT SHAPES ARE 0190'S AND 0189'S, COPIED FROM THOSE FILES AND NOT FROM MEMORY. The first
-- draft of this migration reproduced 0189's `preview_approval`, and would have silently dropped
-- `owner_firm_user_id`, `last_nagged_at`, `nag_count` and the `SEND_FAILED` state that 0190 added
-- the following night — destroying the preview lane's ownership, its nag and its send-failure
-- state while appearing to do nothing but widen an unrelated CHECK on a different table. Rebuilding
-- a table to reach a neighbouring one is the dangerous half of this recipe, and "I copied the
-- previous rebuild" is not sufficient when two rebuilds have happened. Every column below was read
-- out of the migration that last defined it, and the end state is asserted by replaying the whole
-- directory rather than trusted.

PRAGMA foreign_keys = OFF;

CREATE TABLE deliverable_0196 (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL
                CHECK (kind IN ('daily_brief','weekly_review','research_packet','ask_brief','meeting_prep','discrepancy_list','blog_help','productions_hire_search','event_kit','approval_preview','work_result')),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  prepared_by   TEXT NOT NULL,
  prepared_for  TEXT NOT NULL REFERENCES firm_user (id),
  source_type   TEXT,
  source_id     TEXT,
  document_id   TEXT REFERENCES document (id),
  privacy_label TEXT NOT NULL DEFAULT 'INTERNAL',
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  acknowledged_at TEXT,
  acknowledged_by TEXT REFERENCES firm_user (id),
  dismissed_at    TEXT,
  dismissed_by    TEXT REFERENCES firm_user (id),
  restored_at     TEXT
);

-- Columns named explicitly. `SELECT *` would silently reorder if the two definitions ever drift,
-- and a column-order bug in a copy is invisible until somebody reads the wrong field.
INSERT INTO deliverable_0196 (
  id, kind, title, body, prepared_by, prepared_for, source_type, source_id, document_id,
  privacy_label, firm_scope, created_at, acknowledged_at, acknowledged_by, dismissed_at,
  dismissed_by, restored_at
)
SELECT
  id, kind, title, body, prepared_by, prepared_for, source_type, source_id, document_id,
  privacy_label, firm_scope, created_at, acknowledged_at, acknowledged_by, dismissed_at,
  dismissed_by, restored_at
FROM deliverable;

DROP INDEX IF EXISTS idx_deliverable_source;
DROP INDEX IF EXISTS idx_deliverable_for;
DROP INDEX IF EXISTS idx_deliverable_kind;
DROP INDEX IF EXISTS idx_deliverable_open;

ALTER TABLE deliverable RENAME TO deliverable_pre_0196;
ALTER TABLE deliverable_0196 RENAME TO deliverable;

-- The partial unique index is load-bearing: `deliver()` upserts on (source_type, source_id) and
-- SQLite requires the conflict target to match a real index INCLUDING its predicate. A finished
-- card sources on (work_card, <card id>), so finishing the same card twice corrects the page the
-- partner already has a link to rather than stacking a second, contradictory copy beside it.
CREATE UNIQUE INDEX idx_deliverable_source
  ON deliverable (source_type, source_id)
  WHERE source_type IS NOT NULL AND source_id IS NOT NULL;
CREATE INDEX idx_deliverable_for ON deliverable (prepared_for, created_at DESC);
CREATE INDEX idx_deliverable_kind ON deliverable (kind, created_at DESC);
CREATE INDEX idx_deliverable_open ON deliverable (firm_scope, dismissed_at, created_at DESC);

-- ── preview_approval, pinned back to the real table ──────────────────────────────────────────────
--
-- The rename above rewrites `preview_approval.deliverable_id` to point at `deliverable_pre_0196`.
-- Confirmed by 0189, not assumed. Rebuilt outright so the end state is correct either way.

CREATE TABLE preview_approval_0196 (
  id                TEXT PRIMARY KEY,
  work_card_id      TEXT REFERENCES work_card (id),
  card_kind         TEXT,
  employee          TEXT NOT NULL,
  what              TEXT NOT NULL,
  subject           TEXT NOT NULL,
  body_text         TEXT NOT NULL,
  body_html         TEXT,
  recipient         TEXT NOT NULL,
  recipient_set_by  TEXT NOT NULL DEFAULT 'EMPLOYEE'
                    CHECK (recipient_set_by IN ('EMPLOYEE','PARTNER')),
  proposed_recipient TEXT NOT NULL,
  lane_reason       TEXT NOT NULL
                    CHECK (lane_reason IN ('DEFAULT_OUTSIDE_FIRM','ASKED_FOR')),
  owner_firm_user_id TEXT NOT NULL REFERENCES firm_user (id),
  state             TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (state IN ('PENDING','SENT','SEND_FAILED','RETURNED','DISMISSED')),
  token_sha256      TEXT NOT NULL UNIQUE,
  expires_at        TEXT NOT NULL,
  used_at           TEXT,
  decided_by        TEXT REFERENCES firm_user (id),
  decided_at        TEXT,
  decided_via       TEXT CHECK (decided_via IN ('HOME','EMAIL')),
  note              TEXT,
  send_detail       TEXT,
  provider_message_id TEXT,
  deliverable_id    TEXT REFERENCES deliverable (id),
  last_nagged_at    TEXT,
  nag_count         INTEGER NOT NULL DEFAULT 0,
  archive_error     TEXT,
  archive_failed_at TEXT,
  privacy_label     TEXT NOT NULL DEFAULT 'INTERNAL',
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO preview_approval_0196 (
  id, work_card_id, card_kind, employee, what, subject, body_text, body_html, recipient,
  recipient_set_by, proposed_recipient, lane_reason, owner_firm_user_id, state, token_sha256,
  expires_at, used_at, decided_by, decided_at, decided_via, note, send_detail,
  provider_message_id, deliverable_id, last_nagged_at, nag_count, archive_error,
  archive_failed_at, privacy_label, firm_scope, created_at, updated_at
)
SELECT
  id, work_card_id, card_kind, employee, what, subject, body_text, body_html, recipient,
  recipient_set_by, proposed_recipient, lane_reason, owner_firm_user_id, state, token_sha256,
  expires_at, used_at, decided_by, decided_at, decided_via, note, send_detail,
  provider_message_id, deliverable_id, last_nagged_at, nag_count, archive_error,
  archive_failed_at, privacy_label, firm_scope, created_at, updated_at
FROM preview_approval;

DROP INDEX IF EXISTS idx_preview_approval_state;
DROP INDEX IF EXISTS idx_preview_approval_card;
DROP INDEX IF EXISTS idx_preview_approval_owner;
DROP INDEX IF EXISTS idx_preview_approval_nag;

DROP TABLE preview_approval;
ALTER TABLE preview_approval_0196 RENAME TO preview_approval;

CREATE INDEX idx_preview_approval_state ON preview_approval (state, created_at DESC);
CREATE INDEX idx_preview_approval_card  ON preview_approval (work_card_id);
CREATE INDEX idx_preview_approval_owner
  ON preview_approval (owner_firm_user_id, state, created_at DESC);
CREATE INDEX idx_preview_approval_nag
  ON preview_approval (state, created_at)
  WHERE state = 'PENDING';

-- ── deliverable_feedback, pinned back for the same reason ────────────────────────────────────────

CREATE TABLE deliverable_feedback_0196 (
  id             TEXT PRIMARY KEY,
  deliverable_id TEXT NOT NULL REFERENCES deliverable (id),
  to_employee    TEXT NOT NULL,
  from_user_id   TEXT NOT NULL REFERENCES firm_user (id),
  note           TEXT NOT NULL,
  verdict        TEXT NOT NULL DEFAULT 'NOTE'
                 CHECK (verdict IN ('GOOD','NOT_WHAT_I_WANTED','TOO_LONG','WRONG_FOCUS','NOTE')),
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO deliverable_feedback_0196 (
  id, deliverable_id, to_employee, from_user_id, note, verdict, firm_scope, created_at
)
SELECT
  id, deliverable_id, to_employee, from_user_id, note, verdict, firm_scope, created_at
FROM deliverable_feedback;

DROP INDEX IF EXISTS idx_deliverable_feedback_employee;
DROP TABLE deliverable_feedback;
ALTER TABLE deliverable_feedback_0196 RENAME TO deliverable_feedback;

CREATE INDEX idx_deliverable_feedback_employee
  ON deliverable_feedback (to_employee, created_at DESC);

-- Every migration records itself. An unrecorded migration is invisible to anything that reasons
-- about schema state, and it is what turned `tests/policy.test.ts` red when 0189 first omitted it.
INSERT OR IGNORE INTO schema_version (migration) VALUES ('0196_finished_work_reaches_her');

PRAGMA foreign_keys = ON;

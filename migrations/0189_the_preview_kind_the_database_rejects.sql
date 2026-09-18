-- The preview lane's own artifact could not be saved.
--
-- `DELIVERABLE_KINDS` in src/shared/deliverables/deliverable.ts has offered `approval_preview`
-- since migration 0183 added the preview lane. 0183 never widened `deliverable.kind`'s CHECK, so
-- production has been rejecting the one row the feature exists to write. Nothing failed loudly:
-- previews reach her by email, and the insert that files the copy is the part that dies. It is why
-- `validate:value-shapes` is red on `main`, and it was red before any of tonight's work.
--
-- WHY THE TABLE IS REBUILT RATHER THAN ALTERED. SQLite cannot widen a CHECK in place. The usual
-- recipe is create-copy-drop-rename, and `DROP TABLE deliverable` is known to crash D1 — it did on
-- 17 Sep 2026, repeatedly, even after its indexes were dropped first. `ALTER TABLE ... RENAME TO`
-- is the move that works on this database.
--
-- WHY THE ORDER BELOW IS NOT THE OBVIOUS ONE. `preview_approval.deliverable_id` carries a foreign
-- key to `deliverable`. Modern SQLite rewrites such references when a table is renamed, so the
-- obvious sequence — rename the old table out of the way, rename the new one in — would silently
-- repoint the preview lane's own foreign key at the rollback copy. The preview feature would then
-- be referencing a table nothing writes to, which is a worse bug than the one being fixed and a
-- completely silent one. So the new table is renamed INTO place only after the old one is gone
-- from the schema under that name, and `preview_approval` is rebuilt afterwards to pin its
-- reference back to `deliverable` regardless of what the rename did.
--
-- Guarded by `validate:deliverable-kinds`, which fails when a kind exists in TypeScript and not in
-- the CHECK, or the reverse. A list in code and a list in the database with no link between them is
-- this repo's recurring defect, and it is what let this sit.

PRAGMA foreign_keys = OFF;

CREATE TABLE deliverable_0189 (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL
                CHECK (kind IN ('daily_brief','weekly_review','research_packet','ask_brief','meeting_prep','discrepancy_list','blog_help','productions_hire_search','event_kit','approval_preview')),
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
INSERT INTO deliverable_0189 (
  id, kind, title, body, prepared_by, prepared_for, source_type, source_id, document_id,
  privacy_label, firm_scope, created_at, acknowledged_at, acknowledged_by, dismissed_at,
  dismissed_by, restored_at
)
SELECT
  id, kind, title, body, prepared_by, prepared_for, source_type, source_id, document_id,
  privacy_label, firm_scope, created_at, acknowledged_at, acknowledged_by, dismissed_at,
  dismissed_by, restored_at
FROM deliverable;

-- The old table's indexes hold the canonical names and would collide with the new ones.
DROP INDEX IF EXISTS idx_deliverable_source;
DROP INDEX IF EXISTS idx_deliverable_for;
DROP INDEX IF EXISTS idx_deliverable_kind;
DROP INDEX IF EXISTS idx_deliverable_open;

ALTER TABLE deliverable RENAME TO deliverable_pre_0189;
ALTER TABLE deliverable_0189 RENAME TO deliverable;

CREATE UNIQUE INDEX idx_deliverable_source
  ON deliverable (source_type, source_id)
  WHERE source_type IS NOT NULL AND source_id IS NOT NULL;
CREATE INDEX idx_deliverable_for ON deliverable (prepared_for, created_at DESC);
CREATE INDEX idx_deliverable_kind ON deliverable (kind, created_at DESC);
CREATE INDEX idx_deliverable_open ON deliverable (firm_scope, dismissed_at, created_at DESC);

-- ── preview_approval, pinned back to the real table ──────────────────────────────────────────────
--
-- The rename above rewrites `preview_approval.deliverable_id`'s reference to point at
-- `deliverable_pre_0189`. Confirmed, not assumed: renaming `deliverable` away turns
-- `REFERENCES deliverable (id)` into `REFERENCES "deliverable_pre_0189" (id)` on the spot. The
-- preview lane's foreign key would then address the rollback copy — a table nothing writes to —
-- and nothing would ever say so.
--
-- `PRAGMA legacy_alter_table=ON` suppresses the rewrite, and it works in SQLite. It is NOT relied
-- on here: if D1 quietly ignores an unsupported pragma, the failure is silent and permanent, which
-- is exactly the shape of bug this migration exists to fix. So the table is rebuilt outright. The
-- rebuild is correct whether the pragma took effect or not, and `validate:deliverable-kinds`
-- asserts the end state rather than trusting either path.
--
-- Cheap to do: `preview_approval` holds 0 rows today and no table references it. The copy is still
-- written column-by-column so it stays correct if that changes.

CREATE TABLE preview_approval_0189 (
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
  state             TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (state IN ('PENDING','SENT','RETURNED','DISMISSED')),
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
  privacy_label     TEXT NOT NULL DEFAULT 'INTERNAL',
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO preview_approval_0189 (
  id, work_card_id, card_kind, employee, what, subject, body_text, body_html, recipient,
  recipient_set_by, proposed_recipient, lane_reason, state, token_sha256, expires_at, used_at,
  decided_by, decided_at, decided_via, note, send_detail, provider_message_id, deliverable_id,
  privacy_label, firm_scope, created_at, updated_at
)
SELECT
  id, work_card_id, card_kind, employee, what, subject, body_text, body_html, recipient,
  recipient_set_by, proposed_recipient, lane_reason, state, token_sha256, expires_at, used_at,
  decided_by, decided_at, decided_via, note, send_detail, provider_message_id, deliverable_id,
  privacy_label, firm_scope, created_at, updated_at
FROM preview_approval;

DROP INDEX IF EXISTS idx_preview_approval_state;
DROP INDEX IF EXISTS idx_preview_approval_card;

DROP TABLE preview_approval;
ALTER TABLE preview_approval_0189 RENAME TO preview_approval;

CREATE INDEX idx_preview_approval_state ON preview_approval (state, created_at DESC);
CREATE INDEX idx_preview_approval_card  ON preview_approval (work_card_id);


-- ── deliverable_feedback, dragged onto a rollback copy back on 0180 ──────────────────────────────
--
-- Found by CI on this branch, not by the sweep that should have caught it. In production right now:
--
--   deliverable_feedback.deliverable_id TEXT NOT NULL REFERENCES "deliverable_old_0180" (id)
--
-- Migration 0180 renamed `deliverable` out of the way on 17 Sep 2026 and SQLite rewrote this
-- reference to follow it. Nobody noticed. Every piece of feedback the owner leaves on a deliverable
-- has since been validated against a FROZEN 56-row snapshot, so feedback on anything created after
-- 0180 fails the foreign key outright. That is the exact bug the preview_approval rebuild above
-- exists to prevent — already shipped, in a second table, silently, and it is why this migration
-- also repairs history rather than only guarding the future.
--
-- The one existing row is preserved. `validate:deliverable-kinds` now refuses ANY reference to a
-- rollback copy anywhere in the schema, not just this column, because the reason this sat unseen
-- for a day is that the check was written for one table somebody happened to think of.

CREATE TABLE deliverable_feedback_0189 (
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

INSERT INTO deliverable_feedback_0189 (
  id, deliverable_id, to_employee, from_user_id, note, verdict, firm_scope, created_at
)
SELECT
  id, deliverable_id, to_employee, from_user_id, note, verdict, firm_scope, created_at
FROM deliverable_feedback;

DROP INDEX IF EXISTS idx_deliverable_feedback_employee;
DROP TABLE deliverable_feedback;
ALTER TABLE deliverable_feedback_0189 RENAME TO deliverable_feedback;

CREATE INDEX idx_deliverable_feedback_employee
  ON deliverable_feedback (to_employee, created_at DESC);

-- Every migration records itself. Missing this is what turned `tests/policy.test.ts`'s
-- latest-migration assertion red — correctly: an unrecorded migration is invisible to anything that
-- reasons about schema state.
INSERT OR IGNORE INTO schema_version (migration) VALUES ('0189_the_preview_kind_the_database_rejects');

PRAGMA foreign_keys = ON;

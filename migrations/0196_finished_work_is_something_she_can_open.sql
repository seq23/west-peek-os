-- An employee finished the work and she never got it.
--
-- 18 Sep 2026. She asked Parker for a one-off: draft the October workshop event kit with Kirx Diaz,
-- and PREVIEW IT TO HER before anything reaches Scooter. Parker did the work — five COMPLETED
-- `ai_run` rows, all on a free lane at $0, the last carrying a finished kit: three angles, a
-- recommendation with its reasoning, a full run of show, a discussion guide, social drafts.
--
-- Then the card went DONE and produced NOTHING anybody could open. No `deliverable`. No
-- `preview_approval`. No email. The kit existed only inside `ai_run.output_text`, and the copy
-- `appendFinding` wrote into `work_card.description` was TRUNCATED AT 8,000 CHARACTERS mid-sentence.
-- Her words: "preview means he was supposed to fucking email me the workshop packet".
--
-- The generic employee loop's `done` branch appended a `finding` to the card's description and
-- closed the card. `eventKit.ts` and the `event_kit` deliverable kind both exist and were never
-- reached. That is Rule 0 — "no stage may exit 0 having done nothing" — on the one card she wanted.
--
-- WHY A NEW KIND. Filing the finding as a deliverable is what makes it openable, and a deliverable
-- needs a kind. The card that produced this one carries `kind = NULL`, so nothing can be inferred.
-- `employee_finding` names honestly what it is: the output of a card whose work does not belong to
-- one of the named packet shapes. Reusing `ask_brief` or `research_packet` for it would put a lie in
-- a column, and `validate:deliverable-kinds` would be satisfied by the lie.
--
-- The rebuild follows 0189's proven path exactly: SQLite cannot widen a CHECK in place, and
-- `DROP TABLE deliverable` crashes D1 (17 Sep, repeatedly). Renaming is what works here, and the two
-- tables carrying a foreign key to `deliverable` are rebuilt with it so the rename cannot drag them
-- onto the rollback copy — the defect 0189 found already shipped once, in `deliverable_feedback`.

PRAGMA foreign_keys = OFF;

CREATE TABLE deliverable_0196 (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL
                CHECK (kind IN ('daily_brief','weekly_review','research_packet','ask_brief','meeting_prep','discrepancy_list','blog_help','productions_hire_search','event_kit','approval_preview','employee_finding')),
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

CREATE UNIQUE INDEX idx_deliverable_source
  ON deliverable (source_type, source_id)
  WHERE source_type IS NOT NULL AND source_id IS NOT NULL;
CREATE INDEX idx_deliverable_for ON deliverable (prepared_for, created_at DESC);
CREATE INDEX idx_deliverable_kind ON deliverable (kind, created_at DESC);
CREATE INDEX idx_deliverable_open ON deliverable (firm_scope, dismissed_at, created_at DESC);

-- ── The two tables that carry a foreign key to `deliverable` ─────────────────────────────────────
--
-- Renaming `deliverable` rewrites their references to follow it, onto the rollback copy. Confirmed
-- by experiment on 18 Sep; `deliverable_feedback` had already been dragged onto `deliverable_old_0180`
-- that way and nobody noticed for a day. So both are rebuilt with their references pinned back.
--
-- THESE DEFINITIONS ARE READ FROM THE LIVE SCHEMA, NOT COPIED FROM 0189. The first draft of this
-- migration derived them mechanically from 0189's text, which predates migration 0190 — so it
-- silently dropped `preview_approval.owner_firm_user_id`, the column that makes a preview belong to
-- one partner rather than both. The unit suite caught it as `no such column: owner_firm_user_id`.
-- Copying a schema is the same class of mistake as resolving a conflict with a script: it looks
-- right and quietly loses whatever arrived in between.

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
  id, work_card_id, card_kind, employee, what, subject, body_text, body_html, recipient, recipient_set_by, proposed_recipient, lane_reason, owner_firm_user_id, state, token_sha256, expires_at, used_at, decided_by, decided_at, decided_via, note, send_detail, provider_message_id, deliverable_id, last_nagged_at, nag_count, archive_error, archive_failed_at, privacy_label, firm_scope, created_at, updated_at
)
SELECT
  id, work_card_id, card_kind, employee, what, subject, body_text, body_html, recipient, recipient_set_by, proposed_recipient, lane_reason, owner_firm_user_id, state, token_sha256, expires_at, used_at, decided_by, decided_at, decided_via, note, send_detail, provider_message_id, deliverable_id, last_nagged_at, nag_count, archive_error, archive_failed_at, privacy_label, firm_scope, created_at, updated_at
FROM preview_approval;

DROP TABLE preview_approval;

ALTER TABLE preview_approval_0196 RENAME TO preview_approval;

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

DROP TABLE deliverable_feedback;

ALTER TABLE deliverable_feedback_0196 RENAME TO deliverable_feedback;

CREATE INDEX idx_preview_approval_state ON preview_approval (state, created_at DESC);
CREATE INDEX idx_preview_approval_card  ON preview_approval (work_card_id);
CREATE INDEX idx_deliverable_feedback_employee ON deliverable_feedback (to_employee, created_at DESC);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0196_finished_work_is_something_she_can_open');

PRAGMA foreign_keys = ON;

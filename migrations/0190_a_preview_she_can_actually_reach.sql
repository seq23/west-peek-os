-- 0190 — THE PREVIEW LANE, REACHABLE (18 Sep 2026).
--
-- `preview_approval` holds ZERO rows. The lane built on 17 Sep is real, guarded at the send
-- boundary, and has never run once, because nothing can reach it:
--
--   · `CreateWorkCardInput` carries neither `preview_first` nor `result_recipient`. Migration 0183
--     added both columns and nothing in the codebase has ever written either.
--   · `sendOrPreview` is called from one file. Every other employee reaches a transport another way.
--   · `/api/preview-approvals` and `/api/preview-approvals/:id/decide` exist and no client file
--     calls them. There is no UI.
--
-- This migration is the database half of making it reachable. The four things it changes:
--
-- ─── 1 · A PREVIEW HAS AN OWNER, AND IT IS NOT ALWAYS HER ──────────────────────────────────────
--
-- Operator, 18 Sep 2026: the preview goes to WHOEVER TICKED THE BOX. Scooter's previews are
-- Scooter's to answer. Until now `filePreview` hard-coded `PREVIEW_PARTNER.firmUserId` as the
-- deliverable's `prepared_for`, the list endpoint asked "are you A partner?" and then returned the
-- WHOLE FIRM'S previews, and `decide` asked the same question — so Scooter could read, approve or
-- dismiss hers, and she his. Both endpoints were authorising a ROLE where the thing being
-- authorised is a PERSON.
--
-- `owner_firm_user_id` is that person. NOT NULL, because "nobody owns this" is the state that put
-- every row in front of both partners. It is resolved by `previewOwnerFor` in
-- `src/shared/work/previewLane.ts`, which asks `registry/partners.ts` and can therefore only ever
-- yield a partner — the guarantee `PREVIEW_PARTNER` gave for free while it was a constant, kept
-- now that it is dynamic. `scripts/validate/one-partner-registry.mjs` fails the build on a typed
-- partner address, so there is no way to write one here either.
--
-- `work_card.preview_owner_id` is the other end: the partner who ticked "Show me first?" on the
-- card. A scheduled job has nobody who ticked anything, so the resolution falls to the card's
-- `requested_by_email` (migration 0160 — the authenticated address the request came from), and
-- only then to her, which is today's behaviour.
--
-- ─── 2 · NOTHING EXPIRES INTO SILENCE ─────────────────────────────────────────────────────────
--
-- `handleListPreviewApprovals` filtered `expires_at > now`, so an unanswered preview VANISHED from
-- Home after 72 hours with nobody told. The work was gone and the only trace was a row. Blocked
-- cards nag at 48h; previews never did.
--
-- `last_nagged_at` and `nag_count` carry the nag, on the blocked-card cadence. Quiet hours are
-- honoured by the notification layer, so they are not repeated here. An expired preview is no
-- longer filtered out of the list — it surfaces, saying it lapsed and how to get a fresh one.
--
-- ─── 3 · A SEND THAT FAILS AFTER SHE APPROVES IS NOT A SEND ───────────────────────────────────
--
-- `decidePreview` claimed the row as 'SENT' BEFORE calling the transport, then wrote the
-- transport's answer into `send_detail` whether it worked or not. A refused key, a blocked lane, a
-- provider outage: the row said SENT, Home said SENT, and nothing reached the recipient. The
-- `state` CHECK gains 'SEND_FAILED' so that failure is a STATE rather than a sentence in a text
-- column nothing reads.
--
-- SEND_FAILED IS NOT TERMINAL. She said yes; the machinery failed. The row stays answerable so she
-- can send it again or dismiss it, and it surfaces on her Home until she does.
--
-- ─── 4 · THE ARCHIVE FAILURE IS RECORDED, NOT SWALLOWED ───────────────────────────────────────
--
-- `previewApproval.ts` filed her Home copy inside `try { … } catch { deliverableId = null; }`. That
-- empty catch is why the `approval_preview` CHECK bug (migration 0189) survived a full day unseen:
-- production rejected every one of those inserts and the code threw the reason away.
--
-- THE BEHAVIOUR IS KEPT — an archive outage must not lose her approval. What changes is that the
-- reason is written down. `archive_error` and `archive_failed_at` hold it, and the event spine
-- counts it.
--
-- ─── WHY THE TABLE IS REBUILT ─────────────────────────────────────────────────────────────────
--
-- SQLite cannot widen a CHECK in place, and `state` gains a value. 0189 rebuilt this same table
-- the previous night and `DROP TABLE preview_approval` worked (it is `deliverable` that crashes
-- D1 on DROP, and this table is not referenced by anything). The same recipe is used, columns
-- named explicitly so a drift in definitions cannot silently reorder them, and the foreign key to
-- `deliverable` is written out fresh so no earlier rename can leave it addressing a rollback copy.

PRAGMA foreign_keys = OFF;

CREATE TABLE preview_approval_0190 (
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

  -- WHOSE PREVIEW THIS IS. The partner who ticked the box; the only person who may read it,
  -- answer it, or be nagged about it. Resolved by `previewOwnerFor`, which asks the registry.
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

  -- The nag, on the blocked-card cadence. Quiet hours belong to the notification layer.
  last_nagged_at    TEXT,
  nag_count         INTEGER NOT NULL DEFAULT 0,

  -- The archive failure that used to be discarded by an empty catch.
  archive_error     TEXT,
  archive_failed_at TEXT,

  privacy_label     TEXT NOT NULL DEFAULT 'INTERNAL',
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- The table holds zero rows in production. The copy is written anyway, column by column, because
-- "it is empty today" is a fact about today and this file runs against whatever is there.
-- `fu_sequoia_taylor` is the backfill owner because it is exactly what the hard-coded
-- `PREVIEW_PARTNER.firmUserId` meant for every row written before this migration.
INSERT INTO preview_approval_0190 (
  id, work_card_id, card_kind, employee, what, subject, body_text, body_html, recipient,
  recipient_set_by, proposed_recipient, lane_reason, owner_firm_user_id, state, token_sha256,
  expires_at, used_at, decided_by, decided_at, decided_via, note, send_detail,
  provider_message_id, deliverable_id, privacy_label, firm_scope, created_at, updated_at
)
SELECT
  id, work_card_id, card_kind, employee, what, subject, body_text, body_html, recipient,
  recipient_set_by, proposed_recipient, lane_reason, 'fu_sequoia_taylor', state, token_sha256,
  expires_at, used_at, decided_by, decided_at, decided_via, note, send_detail,
  provider_message_id, deliverable_id, privacy_label, firm_scope, created_at, updated_at
FROM preview_approval;

DROP INDEX IF EXISTS idx_preview_approval_state;
DROP INDEX IF EXISTS idx_preview_approval_card;
DROP INDEX IF EXISTS idx_preview_approval_owner;

DROP TABLE preview_approval;
ALTER TABLE preview_approval_0190 RENAME TO preview_approval;

CREATE INDEX idx_preview_approval_state ON preview_approval (state, created_at DESC);
CREATE INDEX idx_preview_approval_card  ON preview_approval (work_card_id);
-- The list query's own index. It reads one owner's live previews, newest first, and without this
-- it scans the whole table to answer "mine".
CREATE INDEX idx_preview_approval_owner
  ON preview_approval (owner_firm_user_id, state, created_at DESC);
-- The nag sweep reads PENDING rows by age. Partial, because a decided row is never nagged.
CREATE INDEX idx_preview_approval_nag
  ON preview_approval (state, created_at)
  WHERE state = 'PENDING';

-- ── THE OTHER END: WHO TICKED THE BOX ────────────────────────────────────────────────────────
--
-- Two fields on every work card, in her words:
--
--     Who is this for?     [ Scooter          ]
--     Show me first?       [✓]
--
-- `result_recipient` (0183) is the first. `preview_first` (0183) is the second. Neither had ever
-- been written by anything. The checkbox is ALWAYS present and ALWAYS hers to change; the
-- recipient only sets its STARTING POSITION — someone outside her and Scooter starts it ticked,
-- either partner starts it unticked. It is a checkbox with a smart default, NOT a rule derived
-- from the recipient: "something for Scooter that I want to see first" is her real case and it
-- must not be unrepresentable.
--
-- This column records WHO ticked it, which is the only honest answer to "whose preview is this".
ALTER TABLE work_card ADD COLUMN preview_owner_id TEXT REFERENCES firm_user (id);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0190_a_preview_she_can_actually_reach');

PRAGMA foreign_keys = ON;

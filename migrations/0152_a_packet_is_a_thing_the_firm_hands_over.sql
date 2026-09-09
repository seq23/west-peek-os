-- 0152 — A Wednesday prep packet is a deliverable, and the table would not hold one.
--
-- Operator, 9 Sep 2026: "1 employee for each me and scooter needs to send me and scooter prep
-- packets for the wednesday meetings of things we have completed and what is needed."
--
-- The firm already had exactly one Wednesday artifact — the joint weekly operating review, signed
-- "Walker and Wren" and prepared ONCE for whichever partner sorts first by id. That is the right
-- shape for an agenda two people work through together and the wrong shape for the thing being
-- asked for here, which is per-person: what YOU finished, and what is waiting on YOU. Two partners
-- cannot prepare for a sync from one shared list of the firm's open items.
--
-- `meeting_prep` is therefore a new kind rather than a second weekly_review: they have different
-- audiences (one person, not the firm), different bylines (that partner's own Chief of Staff, not
-- the joint one), and different contents. Filing them under one kind would make "my packet" and
-- "our agenda" indistinguishable in Documents, which is the distinction the operator is asking for.
--
-- `discrepancy_list` is the second kind, and it is deliberately not `ask_brief`. A brief is an
-- answer to a question asked once. This is a standing register of contradictions between what the
-- firm has written down in its own policies and what its fund deck says — regenerated, compared
-- against last time, and expected to shrink. Giving it its own kind is what lets the list be found
-- again next month instead of being one more brief in a stack.
--
-- SQLite cannot alter a CHECK, so `deliverable` is rebuilt — the standard twelve-step dance. Every
-- existing row is copied, including the acknowledgement and dismissal columns added by 0086 and the
-- document_id filled in by 0073's filing path. The partial unique index on (source_type, source_id)
-- is recreated afterwards and is LOAD-BEARING: `deliver()` names it as an ON CONFLICT target, and
-- SQLite requires the predicate to match, so losing the WHERE here would take every handover in the
-- system down with a "does not match any PRIMARY KEY or UNIQUE constraint" error.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0152_a_packet_is_a_thing_the_firm_hands_over');

CREATE TABLE deliverable_new (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL
                CHECK (kind IN ('daily_brief','weekly_review','research_packet','ask_brief','meeting_prep','discrepancy_list')),
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
  dismissed_by    TEXT REFERENCES firm_user (id)
);

INSERT INTO deliverable_new (
  id, kind, title, body, prepared_by, prepared_for, source_type, source_id, document_id,
  privacy_label, firm_scope, created_at, acknowledged_at, acknowledged_by, dismissed_at, dismissed_by
)
SELECT
  id, kind, title, body, prepared_by, prepared_for, source_type, source_id, document_id,
  privacy_label, firm_scope, created_at, acknowledged_at, acknowledged_by, dismissed_at, dismissed_by
FROM deliverable;

DROP TABLE deliverable;

ALTER TABLE deliverable_new RENAME TO deliverable;

-- PARTIAL, and the predicate is part of the contract. See the header.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deliverable_source
  ON deliverable (source_type, source_id)
  WHERE source_type IS NOT NULL AND source_id IS NOT NULL;

-- Every index DROP TABLE took with it, restored by name. Missing one here would not fail anything
-- visibly; it would just make a page slower and slower with nothing saying why.
CREATE INDEX IF NOT EXISTS idx_deliverable_for ON deliverable (prepared_for, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliverable_kind ON deliverable (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliverable_open ON deliverable (firm_scope, dismissed_at, created_at DESC);

-- ── The schedule ──────────────────────────────────────────────────────────────────────────────
--
-- 09:00 UTC on the meeting day: 05:00 New York, two hours before the 11:00 sync in summer and
-- three in winter. Early is the point. A packet that lands at 11:05 is a minute of the meeting
-- rather than preparation for it, and the daily job below only produces a packet on a Wednesday
-- because `prepWindow` computes the meeting date — so this fires every morning and does real work
-- once a week, exactly like `monthly_room_proposal` fires daily and produces monthly.
--
-- REGISTERED AS 'INTELLIGENCE' AND DISPATCHED BY job_key, for the reason migration 0043 records at
-- length: `kind` is a CHECK, SQLite cannot alter one in place, and `job_run` holds foreign keys
-- into `scheduled_job` so the table cannot be rebuilt here either.
--
-- ACTIVE, NOT PAUSED — and that is a deliberate departure from 0043's "recurring work is opt-in".
-- This one was asked for by name, for a meeting series that already exists on the calendar, and a
-- prep packet that has to be switched on before the first Wednesday is a prep packet that misses
-- the first Wednesday.
INSERT OR IGNORE INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, daily_at_utc, target_kind, task_class, budget_usd,
   data_class, status, created_by, firm_scope)
VALUES
  ('sjb_wednesday_prep', 'wednesday_prep', 'Wednesday sync prep packets',
   'INTELLIGENCE', 'DAILY_AT', '09:00', 'SYSTEM', 'DERIVATION', 0,
   'INTERNAL', 'ACTIVE', 'system', 'west-peek');

-- 0180 · A draft proposed event kit with every monthly proposal (17 Sep 2026)
--
-- Scooter got one by hand for the September livestream: the header, the published description, the
-- run of show with an On Screen column, the discussion guide, and two social posts. It is what
-- makes a proposal something to react to rather than a menu — so Parker now writes ONE with every
-- monthly proposal, Rooms AND Workshops, for the single angle he would run.
--
-- `event_kit_json` holds the kit itself (see shared/events/eventKit.ts `EventKit`). One nullable
-- column rather than nine tables, for the same reason `workshop_json` is one: nothing else reads
-- its parts, and a kit is rewritten whole whenever the chain rebuilds.
--
-- `event_kit_deliverable_id` is the LINK, and the link is the point. The owner's own product says
-- it in West Peek Live's instruction pages: "The email never carries the text, so correcting a page
-- corrects it for everyone who already has the link." A draft changes; an attachment cannot. So the
-- kit is filed as a deliverable on the partners' Home, the email carries the TL;DR and the link,
-- and a rebuild rewrites the same deliverable rather than sending a second copy of a stale one.
ALTER TABLE evt_room_packet ADD COLUMN event_kit_json TEXT;
ALTER TABLE evt_room_packet ADD COLUMN event_kit_deliverable_id TEXT;


-- ── deliverable: the kind `event_kit`, rebuilt the 0172 way ──────────────────────────────────
--
-- `deliverable.kind` carries a CHECK list, so a new kind is a table rebuild, not an INSERT. It
-- FAILS SILENTLY WITHOUT THIS, which is the half worth writing down: `deliver()` is wrapped in a
-- try/catch by every caller so a filing failure cannot take down the work it belongs to, so a kind
-- missing from this list produces a kit that is generated, stored on the packet, never filed, and
-- an email offering a link to nothing — with the constraint error visible only in the swallowed
-- ledger. It was found by running the chain end to end and asserting the deliverable row exists.
CREATE TABLE deliverable_copy AS SELECT * FROM deliverable;
DROP TABLE deliverable;

CREATE TABLE deliverable (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL
                CHECK (kind IN ('daily_brief','weekly_review','research_packet','ask_brief','meeting_prep','discrepancy_list','blog_help','productions_hire_search','event_kit')),
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

INSERT INTO deliverable (
  id, kind, title, body, prepared_by, prepared_for, source_type, source_id, document_id,
  privacy_label, firm_scope, created_at, acknowledged_at, acknowledged_by, dismissed_at, dismissed_by, restored_at
)
SELECT
  id, kind, title, body, prepared_by, prepared_for, source_type, source_id, document_id,
  privacy_label, firm_scope, created_at, acknowledged_at, acknowledged_by, dismissed_at, dismissed_by, restored_at
FROM deliverable_copy;

DROP TABLE deliverable_copy;

-- PARTIAL, and the predicate is load-bearing: `deliver()` names this index as an ON CONFLICT
-- target and SQLite requires the WHERE to match. Losing it takes every handover in the system down.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deliverable_source
  ON deliverable (source_type, source_id)
  WHERE source_type IS NOT NULL AND source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deliverable_for ON deliverable (prepared_for, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliverable_kind ON deliverable (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliverable_open ON deliverable (firm_scope, dismissed_at, created_at DESC);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0180_a_draft_event_kit_with_every_proposal');

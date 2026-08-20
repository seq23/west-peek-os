-- Deliverables: the things the firm hands you.
--
-- WHY A TABLE RATHER THAN FOUR MORE COLUMNS SOMEWHERE. The firm already produces four written
-- artifacts — the morning brief, the Wednesday agenda, a brief from Ask, and a research packet.
-- Every one was built separately, lives on its own page, and can be neither downloaded nor emailed.
-- Four near-identical gaps is the signature of a missing concept, not four missing features.
--
-- The operator's ask was download and email on research. Adding two buttons there would have left
-- the other three unable to do it, and the fifth artifact — whatever gets built next — would have
-- arrived with the same gap again.
--
-- WHAT IT HOLDS AND WHAT IT POINTS AT. The rendered body lives here so a deliverable is readable
-- without reassembling it from the records it came from; those records move on, and a brief that
-- silently changed after it was handed over would be worse than one that is slightly stale.
-- `document_id` is the durable filed copy in R2 — one record, two views, nothing migrating between
-- Research and Documents as it ages.
--
-- PREPARED_BY IS A ROSTER NAME, not a user id: these are signed by employees. PREPARED_FOR is the
-- firm user who asked, which is what puts it on the right Home page.

CREATE TABLE IF NOT EXISTS deliverable (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL
                CHECK (kind IN ('daily_brief','weekly_review','research_packet','ask_brief')),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  -- Roster name of whoever signs it. Not a foreign key: an employee can retire, and a deliverable
  -- they prepared still says they prepared it.
  prepared_by   TEXT NOT NULL,
  prepared_for  TEXT NOT NULL REFERENCES firm_user (id),
  -- What it came from, so the live version is one click away. Deliberately loose: the source is a
  -- research_packet, an intelligence_report, a weekly_review or a work_packet.
  source_type   TEXT,
  source_id     TEXT,
  -- The filed copy. Null only if filing failed, which is visible rather than silent.
  document_id   TEXT REFERENCES document (id),
  privacy_label TEXT NOT NULL DEFAULT 'INTERNAL',
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_deliverable_for ON deliverable (prepared_for, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliverable_kind ON deliverable (kind, created_at DESC);
-- One deliverable per source. Re-delivering the same research packet should update the row rather
-- than stack duplicates on somebody's Home page.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deliverable_source ON deliverable (source_type, source_id)
  WHERE source_type IS NOT NULL AND source_id IS NOT NULL;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0073_deliverables');

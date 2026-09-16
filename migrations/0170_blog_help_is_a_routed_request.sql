-- 0170 · a work card can carry the parsed ask behind it (16 Sep 2026)
--
-- The partners are starting blogs. "Help me make an outline for a blog post on X and do research",
-- "write a blog post on X", "help me come up with a phrase I can repeat across posts" each arrive
-- at os@joinwestpeek.com as an ordinary assignment. Porter now reads the ask at the door and,
-- when it is blog help, marks the card `kind = 'BLOG_HELP'` and writes what was parsed here —
-- the modes (OUTLINE, DRAFT, PHRASE, in any combination) and the topic — so the runner works from
-- one recorded reading of the request rather than re-reading the email each tick and possibly
-- reading it differently. Plain JSON, one column, nullable: every other card leaves it NULL.
ALTER TABLE work_card ADD COLUMN request_json TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0170_blog_help_is_a_routed_request');

-- ── `deliverable` learns the kind `blog_help` ─────────────────────────────────────────────────
--
-- The result is a deliverable: on the partner's Home under their chief of staff, filed in
-- Documents, emailed once. `deliverable.kind` is a CHECK (0073, widened in 0152), and SQLite cannot
-- widen a CHECK in place, so the table is rebuilt. `deliverable_feedback` holds a foreign key into
-- it, which is why this follows 0169's order rather than 0152's: copy the rows aside, DROP, CREATE
-- under the SAME name, INSERT the rows back (each one re-parents its feedback and the deferred
-- violation counter returns to zero), drop the copy. A create-copy-drop-RENAME would fail at
-- COMMIT on any database that has feedback rows, because RENAME never touches that counter.
PRAGMA defer_foreign_keys = TRUE;

CREATE TABLE deliverable_copy AS SELECT * FROM deliverable;
DROP TABLE deliverable;

CREATE TABLE deliverable (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL
                CHECK (kind IN ('daily_brief','weekly_review','research_packet','ask_brief','meeting_prep','discrepancy_list','blog_help')),
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

-- PARTIAL, and the predicate is part of the contract: `deliver()` names it as an ON CONFLICT
-- target and SQLite requires the WHERE to match (see 0152).
CREATE UNIQUE INDEX IF NOT EXISTS idx_deliverable_source
  ON deliverable (source_type, source_id)
  WHERE source_type IS NOT NULL AND source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deliverable_for ON deliverable (prepared_for, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliverable_kind ON deliverable (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliverable_open ON deliverable (firm_scope, dismissed_at, created_at DESC);

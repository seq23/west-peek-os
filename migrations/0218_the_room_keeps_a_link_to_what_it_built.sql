-- 0218 — The room keeps a link block to what it built (owner, 19 Sep 2026).
--
-- Door A of artifacts on demand (0217): "make this a dashboard", "add this to the deck", "write me
-- a one-pager on X", said in the live room. The artifact itself lives in `artifact`, attached to
-- the company, deal, fund, LP or meeting it is about — never only on the meeting. What the room
-- keeps is a LINK BLOCK: one `meeting_artifact` row of kind 'artifact' whose body names the
-- artifact id, so the During face shows it in the stream with its state and opens it.
--
-- `meeting_artifact.kind` is a CHECK (0199) and D1 cannot widen a CHECK in place, so the table is
-- rebuilt on 0196's proven path: create under a temporary name, copy column by column, rename the
-- old table out of the way, rename the new one in, recreate the indexes. Nothing carries a foreign
-- key TO meeting_artifact (checked across every migration on 19 Sep 2026), so no sibling table can
-- be dragged onto the rollback copy — but `validate:deliverable-kinds` asserts that end state for
-- the whole schema regardless. The columns below are read from the live schema (0199 + 0204),
-- not copied from an older migration's text — 0196's own lesson.

PRAGMA foreign_keys = OFF;

CREATE TABLE meeting_artifact_0218 (
  id                TEXT PRIMARY KEY,
  meeting_id        TEXT NOT NULL REFERENCES meeting (id),
  kind              TEXT NOT NULL CHECK (kind IN ('answer','table','chart','packet','summary','artifact')),
  title             TEXT NOT NULL CHECK (length(trim(title)) >= 1),
  body_json         TEXT NOT NULL DEFAULT '{}',
  produced_by_type  TEXT NOT NULL CHECK (produced_by_type IN ('HUMAN','AI','SYSTEM')),
  produced_by_id    TEXT NOT NULL,
  ai_run_id         TEXT,
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  asked_text        TEXT,
  asked_via         TEXT CHECK (asked_via IS NULL OR asked_via IN ('TEXT','VOICE','SYSTEM')),
  work_card_id      TEXT REFERENCES work_card (id)
);

INSERT INTO meeting_artifact_0218 (
  id, meeting_id, kind, title, body_json, produced_by_type, produced_by_id, ai_run_id, firm_scope,
  created_at, asked_text, asked_via, work_card_id
)
SELECT
  id, meeting_id, kind, title, body_json, produced_by_type, produced_by_id, ai_run_id, firm_scope,
  created_at, asked_text, asked_via, work_card_id
FROM meeting_artifact;

DROP INDEX IF EXISTS idx_meeting_artifact_meeting;
DROP INDEX IF EXISTS idx_meeting_artifact_card;

ALTER TABLE meeting_artifact RENAME TO meeting_artifact_pre_0218;
ALTER TABLE meeting_artifact_0218 RENAME TO meeting_artifact;

CREATE INDEX IF NOT EXISTS idx_meeting_artifact_meeting ON meeting_artifact (meeting_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_artifact_card ON meeting_artifact (work_card_id) WHERE work_card_id IS NOT NULL;

-- ── The action key (P4 convention): in the TS registry, the 0003 generated seed, and here. ──
INSERT OR IGNORE INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('artifact.build', 'Build an artifact on demand', 'Build a dashboard, a deck or a document from the firm''s record, asked for in the live room or on a work card. Read-only on the record: every panel is a plan against the room''s allowlist, every figure cites its rows, and the result is a proposal she opens — it changes no record and sends nothing.', 0, 0);

-- The rebuild must have happened: the new CHECK admits 'artifact', the rollback copy exists, and
-- the key is seeded. A migration that changed nothing would fail here rather than report success.
CREATE TABLE migration_guard_0218 (matched INTEGER NOT NULL CHECK (matched = 3));
INSERT INTO migration_guard_0218 (matched)
SELECT (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'meeting_artifact' AND sql LIKE '%''artifact''%')
     + (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'meeting_artifact_pre_0218')
     + (SELECT COUNT(*) FROM action_type WHERE key = 'artifact.build');
DROP TABLE migration_guard_0218;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0218_the_room_keeps_a_link_to_what_it_built');

PRAGMA foreign_keys = ON;

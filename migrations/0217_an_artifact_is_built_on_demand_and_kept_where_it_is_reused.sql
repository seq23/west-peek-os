-- 0217 — An artifact is built on demand and kept where it would be reused (owner, 19 Sep 2026).
--
-- "Build me a dashboard / deck / doc on demand — yes I still want this; they need to live where we
-- would reuse them. Outside a meeting, isn't this just a work card? Work cards solve this."
--
-- ONE PRODUCER, TWO DOORS. `services/artifacts.ts` is the only code that turns a brief into a
-- dashboard, a deck or a document. The live room asks it (door A, `askRoom`'s `build` intent) and a
-- work card asks it (door B, `card.kind = 'ARTIFACT'` in the sweep). Both write a row HERE, in the
-- same shape, and the same function advances it. The read-only plan compiler (`roomQuery.ts`) is
-- the only query surface either door has: an artifact is N plans against the allowlist, run in
-- code, every row cited.
--
-- WHY ITS OWN TABLE AND NOT A `deliverable.kind`. Two reasons, and the second stands alone.
--   1 · `deliverable.kind` is a CHECK that D1 cannot widen in place. 0189 and 0196 each rebuilt the
--       table to add ONE word, renaming it out of the way and rebuilding the two tables whose
--       foreign keys the rename dragged onto the rollback copy. That path is proven and it is not
--       free: a third rebuild for a fourth word is the wrong trade when the object is a different
--       shape anyway.
--   2 · A deliverable is a title and a Markdown body, prepared by one person for one person. An
--       artifact is a structured spec (panels, plans, rows, cites, slides), attached to the OBJECT
--       it is about, versioned on every rebuild, with a build state that moves. None of that fits
--       a body column, and every column below is a column the shelf, the room and the card read.
--   A finished CARD build still files an `employee_finding` deliverable pointing at the artifact
--   (source_type 'artifact'), so the road 0196 built — Home, the preview lane, the email — is
--   reused unchanged and nothing she already relies on learns a new shape.
--
-- IT LIVES WHERE SHE WOULD REUSE IT: at least one of company / opportunity / meeting / fund / LP is
-- required by CHECK. "Never only on a meeting" is the owner's rule; a meeting is allowed, alone,
-- only because a meeting is itself attached to a company or an LP and the shelf follows that link.
--
-- STATES ARE NAMED ON THE ROW, like the brief (0211): REQUESTED → BUILDING (with the stage in
-- words) → READY | FAILED (with the reason). Nothing is inferred from silence; the card and the
-- room block read this row.
--
-- VERSIONED ON REBUILD. A refresh is a new `artifact_version`; the old one stays. The artifact row
-- carries `current_version_no`; the shelf shows the current one and the page lists the rest.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0217_an_artifact_is_built_on_demand_and_kept_where_it_is_reused');

CREATE TABLE IF NOT EXISTS artifact (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL CHECK (kind IN ('dashboard','deck','document')),
  title               TEXT NOT NULL CHECK (length(trim(title)) >= 1),
  brief               TEXT NOT NULL,
  -- What it is ABOUT. At least one. The shelf lists it under each of these it names.
  company_id          TEXT REFERENCES canonical_company (id),
  opportunity_id      TEXT REFERENCES investment_opportunity (id),
  meeting_id          TEXT REFERENCES meeting (id),
  fund_id             TEXT REFERENCES fund (id),
  lp_record_id        TEXT REFERENCES lp_record (id),
  -- Which door asked, and the card when it was a card. The room's link block carries the artifact
  -- id in its body; the room reads state from this row.
  door                TEXT NOT NULL CHECK (door IN ('ROOM','CARD')),
  work_card_id        TEXT REFERENCES work_card (id),
  requested_by        TEXT NOT NULL REFERENCES firm_user (id),
  requested_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- The employee whose name goes on it. A roster name, as `deliverable.prepared_by` is.
  built_by            TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (state IN ('REQUESTED','BUILDING','READY','FAILED')),
  stage               TEXT CHECK (stage IS NULL OR stage IN ('planning','reading','writing','rendering')),
  stage_at            TEXT,
  stage_lease_until   TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0,
  error_code          TEXT,
  error_message       TEXT,
  -- The plans the build starts from, when the door supplied them (the room's own table and chart
  -- blocks). NULL means the planning stage asks a model to propose them from the brief.
  plans_json          TEXT,
  -- Whether any table read names LPs, deal terms or fund figures, or the object is an LP. Derived
  -- in code from the allowlist and the meeting, never typed; it decides the lane of every model
  -- call the build makes.
  confidential        INTEGER NOT NULL DEFAULT 0 CHECK (confidential IN (0, 1)),
  current_version_no  INTEGER NOT NULL DEFAULT 0,
  privacy_label       TEXT NOT NULL DEFAULT 'INTERNAL',
  firm_scope          TEXT NOT NULL DEFAULT 'west-peek',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (company_id IS NOT NULL OR opportunity_id IS NOT NULL OR meeting_id IS NOT NULL OR fund_id IS NOT NULL OR lp_record_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_artifact_company     ON artifact (company_id, created_at DESC)     WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_artifact_opportunity ON artifact (opportunity_id, created_at DESC) WHERE opportunity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_artifact_meeting     ON artifact (meeting_id, created_at DESC)     WHERE meeting_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_artifact_fund        ON artifact (fund_id, created_at DESC)        WHERE fund_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_artifact_lp          ON artifact (lp_record_id, created_at DESC)   WHERE lp_record_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_card ON artifact (work_card_id) WHERE work_card_id IS NOT NULL;
-- What the tick reads: anything requested and not yet terminal, oldest first.
CREATE INDEX IF NOT EXISTS idx_artifact_moving      ON artifact (firm_scope, state, requested_at) WHERE state IN ('REQUESTED','BUILDING');
CREATE INDEX IF NOT EXISTS idx_artifact_shelf       ON artifact (firm_scope, created_at DESC);

CREATE TABLE IF NOT EXISTS artifact_version (
  id              TEXT PRIMARY KEY,
  artifact_id     TEXT NOT NULL REFERENCES artifact (id),
  version_no      INTEGER NOT NULL CHECK (version_no >= 1),
  -- The whole rendered spec: panels with their plans, columns, rows and cites; the sections; the
  -- sources. The in-app page and both exports are rendered from THIS, so they cannot disagree.
  spec_json       TEXT NOT NULL,
  cites_count     INTEGER NOT NULL CHECK (cites_count >= 0),
  built_by        TEXT NOT NULL,
  built_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Wall seconds from request to READY, so "usually about N minutes" is measured, not typed.
  build_seconds   REAL,
  ai_run_ids_json TEXT NOT NULL DEFAULT '[]',
  firm_scope      TEXT NOT NULL DEFAULT 'west-peek',
  UNIQUE (artifact_id, version_no)
);

CREATE INDEX IF NOT EXISTS idx_artifact_version_artifact ON artifact_version (artifact_id, version_no DESC);

-- A migration that reports success while changing nothing is a defect this repo has shipped
-- (0193). The guard is on the two tables and the CHECK that makes "about" mandatory.
CREATE TABLE migration_guard_0217 (matched INTEGER NOT NULL CHECK (matched = 2));
INSERT INTO migration_guard_0217 (matched)
SELECT (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('artifact', 'artifact_version'));
DROP TABLE migration_guard_0217;

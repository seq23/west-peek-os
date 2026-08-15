-- 0020_research.sql — P21 Research / Analyst Workstation (task §9 P21; GAP-14).
--
-- The console the firm was missing. It deliberately does NOT create a second evidence store:
-- a research finding becomes institutional truth only by being promoted into the EXISTING P5
-- `diligence_claim` substrate, through `createClaim`, with its source provenance intact and the
-- self-promotion ban still enforced. `research_finding.promoted_claim_id` is the one link.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0020_research');

-- ── Action vocabulary additions (P21) ──

INSERT OR IGNORE INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('research_project.create', 'Open a research project', 'Open a governed research project around a question.', 0, 0),
  ('research_question.add', 'Add a research question', 'Add a question the project must answer.', 0, 0),
  ('research_source.add', 'Record a research source', 'Record a source consulted, with its reliability stated.', 0, 0),
  ('research_finding.record', 'Record a research finding', 'Record a finding against a question and the source that supports it.', 0, 0),
  ('research_finding.promote', 'Promote a finding into evidence', 'Promote a research finding into the governed diligence-claim substrate.', 0, 0),
  ('market_map.create', 'Create a market map', 'Record a segmented market map produced by a research project.', 0, 0),
  ('research_packet.assemble', 'Assemble a research packet', 'Assemble findings, sources, and open contradictions into an IC-ready packet.', 0, 0);

CREATE TABLE IF NOT EXISTS research_project (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  question      TEXT NOT NULL,
  company_id    TEXT REFERENCES canonical_company (id),
  status        TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','PACKAGED','CLOSED')),
  owner_id      TEXT NOT NULL REFERENCES firm_user (id),
  privacy_label TEXT NOT NULL DEFAULT 'INTERNAL',
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS research_question (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_project (id),
  question   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ANSWERED','UNANSWERABLE')),
  answer     TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_research_question ON research_question (project_id, status);

-- Reliability is the RESEARCHER's stated judgement, recorded so a later reader can disagree
-- with it explicitly rather than inheriting it invisibly.
CREATE TABLE IF NOT EXISTS research_source (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES research_project (id),
  kind         TEXT NOT NULL
               CHECK (kind IN ('DOCUMENT','URL','HUMAN','INTELLIGENCE_ITEM','INTERNAL_RECORD')),
  ref_id       TEXT,
  title        TEXT NOT NULL,
  url          TEXT,
  reliability  TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (reliability IN ('HIGH','MEDIUM','LOW','UNKNOWN')),
  reliability_basis TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  added_by     TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_research_source ON research_source (project_id);

CREATE TABLE IF NOT EXISTS research_finding (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES research_project (id),
  question_id       TEXT REFERENCES research_question (id),
  source_id         TEXT NOT NULL REFERENCES research_source (id),
  statement         TEXT NOT NULL,
  confidence        REAL NOT NULL DEFAULT 0.5,
  -- Set only when the finding has been promoted into the governed evidence substrate (P5).
  promoted_claim_id TEXT REFERENCES diligence_claim (id),
  promoted_at       TEXT,
  promoted_by       TEXT,
  recorded_by_type  TEXT NOT NULL CHECK (recorded_by_type IN ('HUMAN','AI')),
  recorded_by_id    TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_research_finding ON research_finding (project_id);

CREATE TRIGGER IF NOT EXISTS research_finding_statement_immutable
BEFORE UPDATE ON research_finding
WHEN NEW.statement <> OLD.statement
BEGIN
  SELECT RAISE(ABORT, 'research_finding.statement is immutable: record a new finding rather than rewriting one');
END;

CREATE TABLE IF NOT EXISTS market_map (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES research_project (id),
  name          TEXT NOT NULL,
  segments_json TEXT NOT NULL DEFAULT '[]',
  note          TEXT NOT NULL DEFAULT '',
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS research_packet (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES research_project (id),
  title              TEXT NOT NULL,
  summary            TEXT NOT NULL DEFAULT '',
  findings_json      TEXT NOT NULL DEFAULT '[]',
  open_questions_json TEXT NOT NULL DEFAULT '[]',
  contradictions_json TEXT NOT NULL DEFAULT '[]',
  ic_ready           INTEGER NOT NULL DEFAULT 0,
  ic_readiness_note  TEXT NOT NULL DEFAULT '',
  assembled_by       TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER IF NOT EXISTS research_packet_reject_update
BEFORE UPDATE ON research_packet
BEGIN
  SELECT RAISE(ABORT, 'research_packet is an assembled artifact: UPDATE rejected — assemble a new one');
END;

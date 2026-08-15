-- 0013_intelligence_command.sql — P14 MP Command Center + Daily Intelligence Engine
-- (task §9 P14; GAP-04, GAP-05, GAP-23).
--
-- Convention (unchanged from 0001–0012): lowercase snake_case, CREATE IF NOT EXISTS /
-- INSERT OR IGNORE so re-application is a no-op, firm_scope on every firm-data table (§11.7),
-- append-only tables defended by triggers rather than by application discipline.
--
-- Boundaries this migration encodes:
-- - Intelligence is EVIDENCE-SHAPED but is NOT the evidence substrate: an item becomes a
--   diligence_claim only through the existing P5 path. No second truth store (task §10).
-- - Personal intelligence (astrology/transit/timing) is a SEPARATE owner-private domain.
--   It is explicitly NOT institutional truth and is never joined to firm evidence.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0013_intelligence_command');

-- ── Action vocabulary additions (P14) ──
-- Registry source: src/shared/registry/actionTypes.ts. The 0003 generated seed section
-- carries these for fresh databases; these compensating rows cover databases that applied
-- 0003 before P14 existed (same pattern as 0004).

INSERT OR IGNORE INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('intelligence_source.register', 'Register intelligence source', 'Register a daily-intelligence source with its kind, data class, and credential requirement.', 0, 0),
  ('intelligence_source.update', 'Update intelligence source', 'Enable, disable, or re-describe a registered intelligence source.', 0, 0),
  ('watchlist.manage', 'Manage watchlist', 'Add, deactivate, or reactivate a personal or firm watchlist entry.', 0, 0),
  ('mp_home_preference.set', 'Set MP home + briefing preferences', 'Record a new version of a user''s home module layout and briefing preferences.', 0, 0),
  ('intelligence_run.execute', 'Run the daily intelligence engine', 'Acquire, dedupe, score, and archive intelligence items through the governed engine.', 0, 0),
  ('intelligence_item.archive', 'Archive intelligence item', 'Remove an intelligence item from active briefings (the record is preserved).', 0, 0),
  ('intelligence_item.synthesize', 'Synthesize intelligence item', 'Run the governed AI boundary over one item to draft why-it-matters (quarantine rules apply).', 0, 0),
  ('intelligence_feedback.record', 'Record intelligence feedback', 'Record an operator relevance signal on an intelligence item.', 0, 0),
  ('personal_intelligence.configure', 'Configure personal intelligence', 'Configure the private, non-institutional personal-intelligence layer for the acting user only.', 0, 0),
  ('personal_intelligence.record', 'Record personal intelligence entry', 'Record a private personal-intelligence entry for the acting user only.', 0, 0);

-- ── Intelligence sources ──
-- kind:
--   MANUAL    — an operator pastes items in. Always available, always honest.
--   INTERNAL  — derived from West Peek's own governed state (alerts, opportunities, LP moves).
--   HTTP_FEED — a real external feed. Requires network egress the local runtime does not have;
--               acquisition fails closed with EGRESS_GATED unless a fetch implementation is
--               explicitly injected. A configured feed is never presented as a proven feed.

CREATE TABLE IF NOT EXISTS intelligence_source (
  id                  TEXT PRIMARY KEY,
  source_key          TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('MANUAL','INTERNAL','HTTP_FEED')),
  url                 TEXT,
  category            TEXT NOT NULL DEFAULT 'OTHER',
  data_class          TEXT NOT NULL DEFAULT 'PUBLIC',
  enabled             INTEGER NOT NULL DEFAULT 1,
  requires_credential INTEGER NOT NULL DEFAULT 0,
  credential_name     TEXT,
  status              TEXT NOT NULL DEFAULT 'CONFIGURED'
                      CHECK (status IN ('CONFIGURED','UNCONFIGURED','EGRESS_GATED','FAILED')),
  status_detail       TEXT,
  last_checked_at     TEXT,
  registered_by       TEXT NOT NULL,
  firm_scope          TEXT NOT NULL DEFAULT 'west-peek',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_intelligence_source_enabled ON intelligence_source (enabled, kind);

-- Two sources exist from day one so the engine is never an empty shell:
-- the operator's own desk, and West Peek's own governed state.
INSERT OR IGNORE INTO intelligence_source (id, source_key, name, kind, category, data_class, registered_by, status, status_detail) VALUES
  ('isrc_operator_desk', 'operator_desk', 'Operator desk (manual entry)', 'MANUAL', 'OTHER', 'INTERNAL', 'system', 'CONFIGURED', 'Items entered by a firm user. Always available offline.'),
  ('isrc_firm_state', 'firm_state', 'West Peek firm state', 'INTERNAL', 'PORTFOLIO', 'CONFIDENTIAL', 'system', 'CONFIGURED', 'Derived from governed West Peek records (portfolio alerts, opportunities, LP movement, allocation constraints).');

-- ── Watchlists ──
-- Owned by a firm user. Watchlist matches drive the deterministic relevance score,
-- and the score's reason string names which entry matched.

CREATE TABLE IF NOT EXISTS watchlist_entry (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL REFERENCES firm_user (id),
  kind           TEXT NOT NULL CHECK (kind IN ('COMPANY','TOPIC','SECTOR','PERSON')),
  label          TEXT NOT NULL,
  company_id     TEXT REFERENCES canonical_company (id),
  keywords_json  TEXT NOT NULL DEFAULT '[]',
  active         INTEGER NOT NULL DEFAULT 1,
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_watchlist_owner ON watchlist_entry (owner_id, active);

CREATE TABLE IF NOT EXISTS watchlist_change (
  id           TEXT PRIMARY KEY,
  watchlist_id TEXT NOT NULL REFERENCES watchlist_entry (id),
  action       TEXT NOT NULL CHECK (action IN ('ADD','DEACTIVATE','REACTIVATE')),
  actor_id     TEXT NOT NULL,
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER IF NOT EXISTS watchlist_change_reject_update
BEFORE UPDATE ON watchlist_change
BEGIN
  SELECT RAISE(ABORT, 'watchlist_change is append-only: UPDATE rejected (D15)');
END;

CREATE TRIGGER IF NOT EXISTS watchlist_change_reject_delete
BEFORE DELETE ON watchlist_change
BEGIN
  SELECT RAISE(ABORT, 'watchlist_change is append-only: DELETE rejected (D15)');
END;

-- ── MP home + briefing preferences (versioned; change history is the row history) ──
-- Same immutability contract as budget_policy: a change is a NEW row, latest wins.

CREATE TABLE IF NOT EXISTS mp_home_preference (
  id                TEXT PRIMARY KEY,
  firm_user_id      TEXT NOT NULL REFERENCES firm_user (id),
  version_no        INTEGER NOT NULL,
  modules_json      TEXT NOT NULL DEFAULT '[]',
  briefing_json     TEXT NOT NULL DEFAULT '{}',
  set_by            TEXT NOT NULL,
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (firm_user_id, version_no)
);

CREATE TRIGGER IF NOT EXISTS mp_home_preference_reject_update
BEFORE UPDATE ON mp_home_preference
BEGIN
  SELECT RAISE(ABORT, 'mp_home_preference is versioned/immutable: UPDATE rejected — write a new version');
END;

CREATE TRIGGER IF NOT EXISTS mp_home_preference_reject_delete
BEFORE DELETE ON mp_home_preference
BEGIN
  SELECT RAISE(ABORT, 'mp_home_preference is versioned/immutable: DELETE rejected');
END;

-- What the operator has already seen, so "what changed" is a real diff and not a guess.
CREATE TABLE IF NOT EXISTS mp_home_view_state (
  firm_user_id   TEXT PRIMARY KEY REFERENCES firm_user (id),
  last_viewed_at TEXT NOT NULL,
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek'
);

-- ── Intelligence runs ──
-- Idempotency: a run carries a caller-supplied idempotency_key. Re-running the same key
-- returns the ORIGINAL run instead of acquiring twice (task §8 GAP-05 failure/retry law).

CREATE TABLE IF NOT EXISTS intelligence_run (
  id                TEXT PRIMARY KEY,
  trigger_kind      TEXT NOT NULL CHECK (trigger_kind IN ('MANUAL','SCHEDULED')),
  idempotency_key   TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','PARTIAL','FAILED')),
  requested_by_type TEXT NOT NULL CHECK (requested_by_type IN ('HUMAN','AI','SYSTEM')),
  requested_by_id   TEXT NOT NULL,
  sources_attempted INTEGER NOT NULL DEFAULT 0,
  sources_failed    INTEGER NOT NULL DEFAULT 0,
  items_acquired    INTEGER NOT NULL DEFAULT 0,
  items_duplicate   INTEGER NOT NULL DEFAULT 0,
  items_kept        INTEGER NOT NULL DEFAULT 0,
  source_report_json TEXT NOT NULL DEFAULT '[]',
  failure_reason    TEXT,
  started_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at      TEXT,
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek'
);

CREATE INDEX IF NOT EXISTS idx_intelligence_run_started ON intelligence_run (started_at DESC);

-- ── Intelligence items ──
-- dedupe_hash is UNIQUE across the firm: the same story acquired from two sources or on two
-- days lands once. relevance_score is HEURISTIC and relevance_reason must always say why.

CREATE TABLE IF NOT EXISTS intelligence_item (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES intelligence_run (id),
  source_id           TEXT NOT NULL REFERENCES intelligence_source (id),
  external_id         TEXT,
  title               TEXT NOT NULL,
  url                 TEXT,
  body                TEXT NOT NULL DEFAULT '',
  published_at        TEXT,
  dedupe_hash         TEXT NOT NULL UNIQUE,
  category            TEXT NOT NULL DEFAULT 'OTHER'
                      CHECK (category IN ('MARKET','SECONDARIES','FUNDING_MA','WATCHLIST','AI_TECH','REGULATORY','PORTFOLIO','COMPETITOR','LP_SIGNAL','OPPORTUNITY','OTHER')),
  company_id          TEXT REFERENCES canonical_company (id),
  relevance_score     REAL NOT NULL DEFAULT 0,
  relevance_reason    TEXT NOT NULL DEFAULT 'no watchlist or category match',
  why_matters         TEXT,
  why_matters_origin  TEXT NOT NULL DEFAULT 'DETERMINISTIC'
                      CHECK (why_matters_origin IN ('DETERMINISTIC','AI_ACCEPTED','AI_QUARANTINED','NONE')),
  what_changed        TEXT,
  synthesis_run_id    TEXT REFERENCES ai_run (id),
  privacy_label       TEXT NOT NULL DEFAULT 'INTERNAL',
  archived            INTEGER NOT NULL DEFAULT 0,
  archived_by         TEXT,
  archived_at         TEXT,
  firm_scope          TEXT NOT NULL DEFAULT 'west-peek',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_intelligence_item_active ON intelligence_item (archived, relevance_score DESC);
CREATE INDEX IF NOT EXISTS idx_intelligence_item_run ON intelligence_item (run_id);
CREATE INDEX IF NOT EXISTS idx_intelligence_item_company ON intelligence_item (company_id);

-- Claim-level provenance. Every item carries at least one citation naming where it came
-- from; an item with no citation cannot be created (enforced in the service).
CREATE TABLE IF NOT EXISTS intelligence_citation (
  id         TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL REFERENCES intelligence_item (id),
  source_id  TEXT NOT NULL REFERENCES intelligence_source (id),
  locator    TEXT NOT NULL,
  quote      TEXT,
  url        TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_intelligence_citation_item ON intelligence_citation (item_id);

CREATE TRIGGER IF NOT EXISTS intelligence_citation_reject_update
BEFORE UPDATE ON intelligence_citation
BEGIN
  SELECT RAISE(ABORT, 'intelligence_citation is append-only: UPDATE rejected (provenance)');
END;

CREATE TRIGGER IF NOT EXISTS intelligence_citation_reject_delete
BEFORE DELETE ON intelligence_citation
BEGIN
  SELECT RAISE(ABORT, 'intelligence_citation is append-only: DELETE rejected (provenance)');
END;

CREATE TABLE IF NOT EXISTS intelligence_feedback (
  id           TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL REFERENCES intelligence_item (id),
  firm_user_id TEXT NOT NULL REFERENCES firm_user (id),
  signal       TEXT NOT NULL CHECK (signal IN ('USEFUL','NOT_RELEVANT','MORE_LIKE_THIS','LESS_LIKE_THIS')),
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_intelligence_feedback_item ON intelligence_feedback (item_id);

CREATE TRIGGER IF NOT EXISTS intelligence_feedback_reject_update
BEFORE UPDATE ON intelligence_feedback
BEGIN
  SELECT RAISE(ABORT, 'intelligence_feedback is append-only: UPDATE rejected (D15)');
END;

CREATE TRIGGER IF NOT EXISTS intelligence_feedback_reject_delete
BEFORE DELETE ON intelligence_feedback
BEGIN
  SELECT RAISE(ABORT, 'intelligence_feedback is append-only: DELETE rejected (D15)');
END;

-- ── Daily briefing (the archived, addressable artifact) ──

CREATE TABLE IF NOT EXISTS briefing (
  id                  TEXT PRIMARY KEY,
  briefing_date       TEXT NOT NULL,
  firm_user_id        TEXT NOT NULL REFERENCES firm_user (id),
  run_id              TEXT REFERENCES intelligence_run (id),
  status              TEXT NOT NULL DEFAULT 'READY' CHECK (status IN ('READY','VIEWED')),
  item_ids_json       TEXT NOT NULL DEFAULT '[]',
  one_thing_to_watch  TEXT,
  selection_rule      TEXT NOT NULL DEFAULT '',
  generated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  viewed_at           TEXT,
  firm_scope          TEXT NOT NULL DEFAULT 'west-peek',
  UNIQUE (briefing_date, firm_user_id)
);

-- ── Private personal intelligence (task §8 GAP-04 "private personal intelligence boundary") ──
--
-- NOT INSTITUTIONAL TRUTH. Owner-private: reads are filtered by owner_firm_user_id in the
-- service and the Managing Partner role does NOT bypass it — the other MP cannot read it
-- either. Never joined to diligence_claim/knowledge_record/lp_claim. calculation_state is
-- honest about whether anything actually calculated the entry.

CREATE TABLE IF NOT EXISTS personal_intelligence_profile (
  id                   TEXT PRIMARY KEY,
  owner_firm_user_id   TEXT NOT NULL UNIQUE REFERENCES firm_user (id),
  config_json          TEXT NOT NULL DEFAULT '{}',
  calculation_source   TEXT NOT NULL DEFAULT 'NONE',
  calculation_state    TEXT NOT NULL DEFAULT 'UNPROVEN_NO_SOURCE'
                       CHECK (calculation_state IN ('UNPROVEN_NO_SOURCE','MANUAL_ENTRY','EXTERNAL_PROVEN')),
  enabled              INTEGER NOT NULL DEFAULT 0,
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS personal_intelligence_entry (
  id                 TEXT PRIMARY KEY,
  owner_firm_user_id TEXT NOT NULL REFERENCES firm_user (id),
  entry_date         TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('TRANSIT','LUNAR','TIMING_WINDOW','NOTE')),
  headline           TEXT NOT NULL,
  body               TEXT NOT NULL DEFAULT '',
  calculation_state  TEXT NOT NULL DEFAULT 'MANUAL_ENTRY'
                     CHECK (calculation_state IN ('UNPROVEN_NO_SOURCE','MANUAL_ENTRY','EXTERNAL_PROVEN')),
  source_note        TEXT NOT NULL DEFAULT 'operator-entered; no ephemeris source is configured',
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_personal_intel_owner ON personal_intelligence_entry (owner_firm_user_id, entry_date DESC);

CREATE TRIGGER IF NOT EXISTS personal_intelligence_entry_reject_update
BEFORE UPDATE ON personal_intelligence_entry
BEGIN
  SELECT RAISE(ABORT, 'personal_intelligence_entry is append-only: UPDATE rejected');
END;

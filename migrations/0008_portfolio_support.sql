-- 0008_portfolio_support.sql — P8 portfolio monitoring: metric definitions, dated
-- snapshots, updates, alerts (with escalation-safe de-duplication), suppression
-- rules, support requests/matches/outcomes.
-- Convention: lowercase snake_case (P1); CREATE IF NOT EXISTS / INSERT OR IGNORE so
-- re-application is a no-op. firm_scope on every firm-data table (§11.7).
--
-- Thresholds and severity bands are OPERATOR CONFIGURATION on the metric definition
-- (plan §6: portfolio alert thresholds are an unresolved human decision). No
-- illustrative threshold is seeded as policy, and no alert-quality/precision claim
-- is made anywhere from fixtures.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0008_portfolio_support');

-- ── Action vocabulary additions (P8) ──

INSERT OR IGNORE INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('portfolio_metric_definition.create', 'Define portfolio metric', 'Define a tracked portfolio metric with its direction and operator-set severity bands.', 0, 0),
  ('portfolio_metric_snapshot.create', 'Record metric snapshot', 'Record a dated portfolio metric value with its source.', 0, 0),
  ('portfolio_update.create', 'Record portfolio update', 'Record a received portfolio update for a period.', 0, 0),
  ('portfolio_alert.evaluate', 'Evaluate portfolio alerts', 'Run the deterministic alert evaluation (deterioration, stale update, missing metric).', 0, 0),
  ('portfolio_alert.decide', 'Decide portfolio alert', 'Acknowledge or resolve an alert (human disposition).', 0, 0),
  ('alert_suppression_rule.create', 'Create alert suppression rule', 'Suppress low-severity noise; a suppression can never hide a higher severity.', 0, 0),
  ('support_request.create', 'Create support request', 'Record a portfolio-company support request.', 0, 0),
  ('support_match.propose', 'Propose support match', 'Propose a match for a support request (AI may propose; it can never contact anyone).', 0, 0),
  ('support_match.decide', 'Decide support match', 'Human accept/reject of a proposed support match. Acting on it still needs the reserved introduction approval.', 0, 0),
  ('support_outcome.record', 'Record support outcome', 'Record what actually happened after support, including relationship and value notes.', 0, 0);

-- ── Metric definitions (operator configuration; no seeded illustrative policy) ──

CREATE TABLE IF NOT EXISTS portfolio_metric_definition (
  id                  TEXT PRIMARY KEY,
  metric_key          TEXT NOT NULL,
  name                TEXT NOT NULL,
  unit                TEXT,
  direction           TEXT NOT NULL CHECK (direction IN ('HIGHER_IS_BETTER','LOWER_IS_BETTER')),
  -- Operator-set severity bands, e.g. {"MEDIUM":5,"HIGH":15,"CRITICAL":30} as
  -- percent deterioration period-over-period. Empty {} = no severity opinion.
  severity_bands_json TEXT NOT NULL DEFAULT '{}',
  -- Days after which a missing update/snapshot is stale. NULL = not monitored.
  stale_after_days    INTEGER,
  description         TEXT,
  firm_scope          TEXT NOT NULL DEFAULT 'west-peek',
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_metric_definition_key ON portfolio_metric_definition (metric_key, firm_scope);

-- ── Portfolio updates (the thing whose absence makes data stale) ──

CREATE TABLE IF NOT EXISTS portfolio_update (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES canonical_company (id),
  period_label  TEXT,
  received_at   TEXT NOT NULL,
  summary       TEXT,
  source        TEXT NOT NULL,
  document_id   TEXT REFERENCES document (id),
  privacy_label TEXT NOT NULL DEFAULT 'INTERNAL',
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_portfolio_update_company ON portfolio_update (company_id, received_at);

-- ── Dated metric snapshots (metrics are ALWAYS dated) ──

CREATE TABLE IF NOT EXISTS portfolio_metric_snapshot (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES canonical_company (id),
  metric_key    TEXT NOT NULL,
  as_of_date    TEXT NOT NULL,
  period_label  TEXT,
  value         REAL NOT NULL,
  source        TEXT NOT NULL,
  update_id     TEXT REFERENCES portfolio_update (id),
  privacy_label TEXT NOT NULL DEFAULT 'INTERNAL',
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_metric_snapshot_company ON portfolio_metric_snapshot (company_id, metric_key, as_of_date);

-- ── Alerts ──
-- De-duplication is escalation-safe: a repeat at the same or lower severity
-- increments occurrence_count on the OPEN alert; a WORSE severity always creates a
-- new row linked by escalated_from. Severity is never rewritten in place.

CREATE TABLE IF NOT EXISTS portfolio_alert (
  id               TEXT PRIMARY KEY,
  company_id       TEXT NOT NULL REFERENCES canonical_company (id),
  alert_type       TEXT NOT NULL
                   CHECK (alert_type IN ('METRIC_DETERIORATION','STALE_UPDATE','MISSING_METRIC','THRESHOLD_BREACH')),
  metric_key       TEXT,
  severity         TEXT NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status           TEXT NOT NULL DEFAULT 'OPEN'
                   CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED','SUPPRESSED')),
  dedupe_key       TEXT NOT NULL,
  detail_json      TEXT NOT NULL DEFAULT '{}',
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  escalated_from   TEXT REFERENCES portfolio_alert (id),
  decided_by       TEXT,
  decision_note    TEXT,
  suppression_rule_id TEXT,
  firm_scope       TEXT NOT NULL DEFAULT 'west-peek',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_portfolio_alert_company ON portfolio_alert (company_id, status);
CREATE INDEX IF NOT EXISTS idx_portfolio_alert_dedupe ON portfolio_alert (dedupe_key, status);

-- Suppression rules cap noise, never severity: max_severity is the HIGHEST severity
-- the rule may suppress; anything worse always surfaces.
CREATE TABLE IF NOT EXISTS alert_suppression_rule (
  id           TEXT PRIMARY KEY,
  company_id   TEXT REFERENCES canonical_company (id),
  alert_type   TEXT,
  metric_key   TEXT,
  max_severity TEXT NOT NULL DEFAULT 'LOW' CHECK (max_severity IN ('LOW','MEDIUM','HIGH')),
  reason       TEXT NOT NULL,
  expires_at   TEXT,
  firm_scope   TEXT NOT NULL DEFAULT 'west-peek',
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_alert_suppression_company ON alert_suppression_rule (company_id, alert_type);

-- ── Support: request → match (AI may propose) → human-gated action → outcome ──

CREATE TABLE IF NOT EXISTS support_request (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES canonical_company (id),
  request_type TEXT NOT NULL
               CHECK (request_type IN ('HIRING','CUSTOMER_INTRO','FUNDRAISE','OPERATIONS','LEGAL','OTHER')),
  description  TEXT NOT NULL,
  urgency      TEXT NOT NULL DEFAULT 'NORMAL' CHECK (urgency IN ('LOW','NORMAL','HIGH')),
  status       TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','MATCHED','CLOSED','WITHDRAWN')),
  alert_id     TEXT REFERENCES portfolio_alert (id),
  firm_scope   TEXT NOT NULL DEFAULT 'west-peek',
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_support_request_company ON support_request (company_id, status);

CREATE TABLE IF NOT EXISTS support_match (
  id                 TEXT PRIMARY KEY,
  support_request_id TEXT NOT NULL REFERENCES support_request (id),
  match_type         TEXT NOT NULL CHECK (match_type IN ('PERSON','COMPANY','RESOURCE')),
  target_label       TEXT NOT NULL,
  target_ref         TEXT,
  rationale          TEXT NOT NULL,
  proposed_by_type   TEXT NOT NULL CHECK (proposed_by_type IN ('HUMAN','AI')),
  proposed_by_id     TEXT NOT NULL,
  ai_run_id          TEXT REFERENCES ai_run (id),
  status             TEXT NOT NULL DEFAULT 'PROPOSED'
                     CHECK (status IN ('PROPOSED','ACCEPTED','REJECTED','ACTED')),
  approval_card_id   TEXT REFERENCES approval_card (id),
  decided_by         TEXT,
  firm_scope         TEXT NOT NULL DEFAULT 'west-peek',
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_support_match_request ON support_match (support_request_id, status);

-- Outcomes are APPEND-ONLY: what happened after support is history, not a field to
-- overwrite. Relationship and value notes are preserved verbatim.
CREATE TABLE IF NOT EXISTS support_outcome (
  id                 TEXT PRIMARY KEY,
  support_request_id TEXT NOT NULL REFERENCES support_request (id),
  support_match_id   TEXT REFERENCES support_match (id),
  outcome_type       TEXT NOT NULL
                     CHECK (outcome_type IN ('HELPED','PARTIALLY_HELPED','NO_EFFECT','HARMED','UNKNOWN')),
  value_note         TEXT,
  relationship_note  TEXT,
  recorded_by        TEXT NOT NULL,
  firm_scope         TEXT NOT NULL DEFAULT 'west-peek',
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_support_outcome_request ON support_outcome (support_request_id);

CREATE TRIGGER IF NOT EXISTS support_outcome_reject_update
BEFORE UPDATE ON support_outcome
BEGIN
  SELECT RAISE(ABORT, 'support_outcome is append-only: UPDATE rejected (D15)');
END;

CREATE TRIGGER IF NOT EXISTS support_outcome_reject_delete
BEFORE DELETE ON support_outcome
BEGIN
  SELECT RAISE(ABORT, 'support_outcome is append-only: DELETE rejected (D15)');
END;

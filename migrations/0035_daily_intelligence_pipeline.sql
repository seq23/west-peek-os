-- 0035_daily_intelligence_pipeline.sql — P41: the Daily Executive Intelligence Report.
--
-- WHAT ALREADY EXISTED AND IS REUSED RATHER THAN REBUILT. `intelligence_source`, `intelligence_run`,
-- `intelligence_item` (with dedupe_hash, category, relevance_score, relevance_reason, what_changed),
-- `intelligence_citation` and `briefing` (with synthesis_md / synthesis_state) all exist and work.
-- The operator's brief asked for a proper pipeline rather than a parallel system, so this migration
-- adds only the four things genuinely absent.
--
-- 1 · CONTINUITY. The single thing that makes a morning note feel like a morning note is knowing
--     what it said yesterday. `tracked_narrative` holds the running stories — a Fed path, an
--     ongoing regulatory proceeding, a portfolio event — so today's report can answer "what
--     changed" instead of re-reporting an unchanged story as if it were new.
--
-- 2 · PERSONALISATION. Two Managing Partners with different mandates should not get the same
--     report. `partner_intelligence_profile` holds the sectors, companies and depth preferences
--     that shift ranking. Deliberately a general model with no hard-coded names: a partner covering
--     fintech gets more fintech because of what is in their row, not because of a branch in code.
--
-- 3 · A STRUCTURED REPORT, NOT A WALL OF MARKDOWN. `briefing.synthesis_md` holds prose, which
--     cannot be rendered differently for web and email, and cannot be checked section by section.
--     `intelligence_report` + `intelligence_report_section` store the report AS DATA. Generation
--     produces data; presentation renders it.
--
-- 4 · DELIVERY IS NOT GENERATION. A report that generated perfectly and failed to send is not a
--     failed report. `intelligence_delivery` tracks delivery separately so it can be retried
--     without regenerating, which also means a retry cannot produce a second, different report.
--
-- IDEMPOTENCY: `UNIQUE (firm_scope, firm_user_id, report_date)` is the guard the brief asks for.
-- A scheduler that fires twice, or a manual rerun on the same day, updates one row rather than
-- delivering two reports.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0035_daily_intelligence_pipeline');

-- ── Running stories, so tomorrow knows what today said ──────────────────────

CREATE TABLE IF NOT EXISTS tracked_narrative (
  id                TEXT PRIMARY KEY,
  topic             TEXT NOT NULL,
  summary           TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE','RESOLVED','DORMANT')),
  -- What would move this story on. Nullable: most narratives have no scheduled next beat.
  next_catalyst_at  TEXT,
  last_seen_date    TEXT NOT NULL,
  first_seen_date   TEXT NOT NULL,
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (firm_scope, topic)
);

CREATE INDEX IF NOT EXISTS idx_tracked_narrative_status ON tracked_narrative (status, last_seen_date);

-- ── Who each partner is, for ranking ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS partner_intelligence_profile (
  firm_user_id      TEXT PRIMARY KEY REFERENCES firm_user (id),
  timezone          TEXT NOT NULL DEFAULT 'America/Chicago',
  -- Delivery window. Weekends off by default; canon's operating rhythm is weekday-first.
  deliver_at_local  TEXT NOT NULL DEFAULT '06:45',
  weekends          INTEGER NOT NULL DEFAULT 0 CHECK (weekends IN (0,1)),
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  -- JSON arrays: what this partner covers. Ranking reads these; nothing is hard-coded per person.
  sectors_json      TEXT NOT NULL DEFAULT '[]',
  companies_json    TEXT NOT NULL DEFAULT '[]',
  themes_json       TEXT NOT NULL DEFAULT '[]',
  -- Depth dials, 0–3 per area. A partner who never reads macro should stop being sent it.
  depth_json        TEXT NOT NULL DEFAULT '{}',
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ── The report, as data ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS intelligence_report (
  id                TEXT PRIMARY KEY,
  firm_user_id      TEXT NOT NULL REFERENCES firm_user (id),
  report_date       TEXT NOT NULL,
  -- The pipeline's own progress. Distinct from delivery state on purpose.
  status            TEXT NOT NULL DEFAULT 'QUEUED'
                    CHECK (status IN ('QUEUED','GATHERING','RANKING','GENERATING','VERIFYING','READY','FAILED')),
  -- Reproducibility: which model and which prompt produced this. Without both, a quality
  -- regression months from now is unattributable.
  model             TEXT,
  prompt_version    TEXT,
  ai_run_id         TEXT REFERENCES ai_run (id),
  -- Funnel counts, so the shape of a bad report is visible without re-running it.
  source_count      INTEGER NOT NULL DEFAULT 0,
  raw_count         INTEGER NOT NULL DEFAULT 0,
  deduped_count     INTEGER NOT NULL DEFAULT 0,
  candidate_count   INTEGER NOT NULL DEFAULT 0,
  verification_flags INTEGER NOT NULL DEFAULT 0,
  error_code        TEXT,
  error_message     TEXT,
  started_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at      TEXT,
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  UNIQUE (firm_scope, firm_user_id, report_date)
);

CREATE INDEX IF NOT EXISTS idx_intelligence_report_date ON intelligence_report (report_date DESC, firm_user_id);

CREATE TABLE IF NOT EXISTS intelligence_report_section (
  id            TEXT PRIMARY KEY,
  report_id     TEXT NOT NULL REFERENCES intelligence_report (id),
  section_key   TEXT NOT NULL,
  position      INTEGER NOT NULL DEFAULT 0,
  heading       TEXT NOT NULL,
  body_md       TEXT NOT NULL,
  -- intelligence_item ids this section rests on. The UI turns these into clickable sources, and
  -- the verifier uses them to check that nothing was asserted without a record behind it.
  item_ids_json TEXT NOT NULL DEFAULT '[]',
  importance    REAL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (report_id, section_key)
);

CREATE INDEX IF NOT EXISTS idx_report_section ON intelligence_report_section (report_id, position);

-- ── Delivery, tracked apart from generation ─────────────────────────────────

CREATE TABLE IF NOT EXISTS intelligence_delivery (
  id           TEXT PRIMARY KEY,
  report_id    TEXT NOT NULL REFERENCES intelligence_report (id),
  channel      TEXT NOT NULL CHECK (channel IN ('IN_APP','PUSH','EMAIL')),
  status       TEXT NOT NULL CHECK (status IN ('DELIVERED','HELD','FAILED','UNAVAILABLE')),
  detail       TEXT NOT NULL DEFAULT '',
  attempt      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_intelligence_delivery ON intelligence_delivery (report_id);

-- Append-only: a delivery attempt is a historical fact. Retrying writes a new row with a higher
-- attempt number rather than overwriting the failure, so a flaky channel is visible as a pattern.
CREATE TRIGGER IF NOT EXISTS intelligence_delivery_reject_update
BEFORE UPDATE ON intelligence_delivery
BEGIN
  SELECT RAISE(ABORT, 'intelligence_delivery is append-only: UPDATE rejected (D15)');
END;

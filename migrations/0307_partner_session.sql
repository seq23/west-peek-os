-- 0307 · A PARTNER'S EMAIL IS WORKED AS ONE SESSION (14 Nov 2026, "emailing the OS feels like typing to Claude").
--
-- An email no fixed door claims becomes a PARTNER_SESSION card: one full Claude Code session on the Mac (a LOCAL_JOB
-- run, no router stopwatch). This row is the session's own record: the partner's words, the run the Mac holds, every
-- correction he sent (newest first, placed above the brief), his answers to its questions, the last report read, and
-- the questions already asked, so a question is emailed once.
--
-- Additive: one new table. Nothing is rewritten.
CREATE TABLE IF NOT EXISTS partner_session (
  work_card_id TEXT PRIMARY KEY REFERENCES work_card(id),
  firm_scope TEXT NOT NULL DEFAULT 'west-peek',
  requested_by TEXT NOT NULL,
  request_text TEXT NOT NULL,
  current_run_id TEXT,
  applied_run_id TEXT,
  run_count INTEGER NOT NULL DEFAULT 0,
  corrections_json TEXT NOT NULL DEFAULT '[]',
  answers_json TEXT NOT NULL DEFAULT '[]',
  report_json TEXT,
  asked_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0307_partner_session');

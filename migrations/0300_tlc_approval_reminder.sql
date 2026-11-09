-- 0300 · WYNN REMINDS ON AN UNANSWERED APPROVAL (owner, 9 Nov 2026; services/tlcApprovalReminder.ts).
--   One row per approval email (its ref and the time that version's email went): how many reminders it has had and
--   when the last went. A new version email has a new time, so its count starts again at 0.
-- Additive only; no row changes.
CREATE TABLE IF NOT EXISTS tlc_approval_reminder (
  ref              TEXT NOT NULL,
  for_sent_at      TEXT NOT NULL,
  reminder_count   INTEGER NOT NULL DEFAULT 0,
  last_reminded_at TEXT NOT NULL,
  last_day         TEXT NOT NULL,
  sent_to_json     TEXT,
  PRIMARY KEY (ref, for_sent_at)
);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0300_tlc_approval_reminder');

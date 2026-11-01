-- 0282 · TLC PIPELINE REPAIRS AND THE WEEKLY ROUNDUP (31 Oct 2026). Additive only.
--   · GO / NO-GO DATE PER CLUB (owner's ask): 7 weeks before the event, moved back to the Friday when it falls on a
--     weekend (Sat 23 Jan 2027 → Fri 4 Dec 2026). Stored as data on the club. No sponsor committed in writing by then
--     → the club is DROPPED: status CANCELLED with dropped_at / dropped_reason (never deleted), its topic goes back on
--     the ideas list, and Wynn says so in the Monday roundup. services/learningClub.ts `applyGoNoGo`.
--   · tlc_way_in.found_email: the address Wynn found for a must-pitch brand that was not on the page it named, kept so
--     the fallback can put it through NeverBounce instead of leaving the brand waiting on her.
--   · tlc_roundup: one Monday roundup per ISO week (services/tlcRoundup.ts).
ALTER TABLE tlc_event ADD COLUMN go_no_go_date TEXT;
ALTER TABLE tlc_event ADD COLUMN dropped_at TEXT;
ALTER TABLE tlc_event ADD COLUMN dropped_reason TEXT;

UPDATE tlc_event
   SET go_no_go_date = CASE strftime('%w', date(substr(event_date, 1, 10), '-49 days'))
                         WHEN '6' THEN date(substr(event_date, 1, 10), '-50 days')
                         WHEN '0' THEN date(substr(event_date, 1, 10), '-51 days')
                         ELSE date(substr(event_date, 1, 10), '-49 days') END
 WHERE go_no_go_date IS NULL;

ALTER TABLE tlc_way_in ADD COLUMN found_email TEXT;
ALTER TABLE tlc_way_in ADD COLUMN fallback_checked_at TEXT;

CREATE TABLE IF NOT EXISTS tlc_roundup (
  week        TEXT NOT NULL,
  firm_scope  TEXT NOT NULL DEFAULT 'west-peek',
  sent_at     TEXT NOT NULL,
  summary     TEXT,
  PRIMARY KEY (firm_scope, week)
);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0282_tlc_go_no_go_roundup_way_in');

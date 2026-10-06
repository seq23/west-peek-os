-- 0254 — The partner service rules for every employee and every card kind (owner, 6 Oct 2026).
--
-- HER WORDS. "we should form a full list of things porter needed and make sure all ai agents who do
-- work on work cards couldn't benefit from some of them (even if they do no repo work)."
--
-- WHAT WAS WRONG. #227 (0253) wrote the list — docs/PARTNER_SERVICE_RULES.md — and eleven rules
-- tagged ALL-KINDS still lived only in Porter's Mac prompt. Two of them need rows:
--
--   partner_constraint — R19. A partner's standing constraints ("voter emails are private", "Scooter's
--     own track is never in the vote", "test data preview-only") were kept per REPO, so Walker or
--     Parker working for the same partner never saw them. A register per partner, read into every
--     job prompt by services/partnerConstraints.ts. Grows; a later read never shrinks it.
--
--   drive_watch — R21 (addendum item 10). An ask that names a Drive folder which is still empty used
--     to stop the card; the partner then had to email again when the files were in. Now the door
--     records every folder the ask names, the Mac's claimer maps each one on its heartbeat
--     (scripts/drive/pull.mjs --map), the card loads them on arrival with no new email, and "still
--     empty" is said to the partner ONCE (`empty_told_at`).

CREATE TABLE IF NOT EXISTS partner_constraint (
  id            TEXT PRIMARY KEY,
  partner_email TEXT NOT NULL CHECK (partner_email = lower(partner_email) AND partner_email LIKE '%@%'),
  body          TEXT NOT NULL CHECK (length(trim(body)) >= 4),
  source        TEXT NOT NULL DEFAULT 'job',
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (firm_scope, partner_email, body)
);
CREATE INDEX IF NOT EXISTS idx_partner_constraint_partner ON partner_constraint (firm_scope, partner_email);

CREATE TABLE IF NOT EXISTS drive_watch (
  id              TEXT PRIMARY KEY,
  work_card_id    TEXT NOT NULL REFERENCES work_card (id),
  folder_id       TEXT NOT NULL CHECK (length(folder_id) >= 10),
  folder_url      TEXT NOT NULL,
  requested_by    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'WATCHING' CHECK (status IN ('WATCHING', 'ARRIVED', 'CLOSED')),
  files_seen      INTEGER NOT NULL DEFAULT 0,
  empty_told_at   TEXT,
  arrived_at      TEXT,
  last_checked_at TEXT,
  firm_scope      TEXT NOT NULL DEFAULT 'west-peek',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (work_card_id, folder_id)
);
CREATE INDEX IF NOT EXISTS idx_drive_watch_open ON drive_watch (status, last_checked_at);
INSERT OR IGNORE INTO schema_version (migration) VALUES ('0254_partner_service_rules_for_every_kind');

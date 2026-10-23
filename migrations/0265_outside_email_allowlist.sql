-- 0265_outside_email_allowlist.sql — "Outside email: what may send" (owner ruling, 23 Oct 2026).
--
-- Owner, verbatim: "We need a universal narrow switch and i can easily go in the ui and tell it
-- which jobs or work cards to allow".
--
-- Until now one deployment variable (WP_OS_AI_EMAIL_EXTERNAL) decided whether ANY employee could
-- email outside the firm: all or nothing, and only by a deploy. It is replaced by:
--   1. outside_email_mode — the master switch, two states only: OFF, or ONLY_ALLOWED ("only what I
--      allow", the default written here). There is no "everything" state, and the CHECK refuses one.
--   2. outside_email_allow — the list. One row per named job (or job kind) or work card she has
--      allowed or stopped. No row means not allowed: default deny.
--   3. outside_email_audit — every Allow, Stop and mode change, who and when. Append only.
-- The break-glass kill switch stays in wrangler.toml (WP_OS_OUTSIDE_EMAIL_BREAK_GLASS = "off-hard").
--
-- The one function every outward employee send asks is `outsideEmailAllowed` in
-- src/worker/services/outsideEmail.ts. Additive only: nothing here changes an existing row's
-- meaning, and NOTHING is allowed by this migration.

CREATE TABLE IF NOT EXISTS outside_email_mode (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  mode        TEXT NOT NULL CHECK (mode IN ('OFF','ONLY_ALLOWED')),
  changed_by  TEXT NOT NULL,
  changed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO outside_email_mode (id, mode, changed_by) VALUES (1, 'ONLY_ALLOWED', 'migration 0265');

CREATE TABLE IF NOT EXISTS outside_email_allow (
  item_type   TEXT NOT NULL CHECK (item_type IN ('JOB','CARD')),
  item_id     TEXT NOT NULL,
  allowed     INTEGER NOT NULL DEFAULT 0 CHECK (allowed IN (0,1)),
  changed_by  TEXT NOT NULL,
  changed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (item_type, item_id)
);

CREATE TABLE IF NOT EXISTS outside_email_audit (
  id          TEXT PRIMARY KEY,
  item_type   TEXT NOT NULL CHECK (item_type IN ('JOB','CARD','MODE')),
  item_id     TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('ALLOW','STOP','MODE_OFF','MODE_ONLY_ALLOWED')),
  changed_by  TEXT NOT NULL,
  changed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_outside_email_audit_item ON outside_email_audit (item_type, item_id, changed_at);

-- Which job or card an employee's email.send belongs to, so the executor can ask the list.
ALTER TABLE external_effect_request ADD COLUMN outside_job TEXT;
ALTER TABLE external_effect_request ADD COLUMN work_card_id TEXT;

-- Brand emails already composed by the Learning Club belong to its job.
UPDATE external_effect_request SET outside_job = 'tlc_brand_sales'
 WHERE outside_job IS NULL AND id IN (SELECT effect_request_id FROM tlc_drip_message WHERE effect_request_id IS NOT NULL
                                    UNION SELECT effect_request_id FROM tlc_pitch_followup WHERE effect_request_id IS NOT NULL);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0265_outside_email_allowlist');

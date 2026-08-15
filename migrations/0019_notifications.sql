-- 0019_notifications.sql — P20 Notifications (task §9 P20; GAP-19).
--
-- In-app notification is the FLOOR, not an afterthought: it works with no external channel, no
-- credential, and no network beyond the app itself. Push is an optional channel on top, and its
-- absence is recorded rather than hidden.
--
-- Quiet hours suppress DELIVERY, never the record. A suppressed notification still exists, is
-- still readable in the centre, and says it was held — an operator can always find out what
-- happened while they were not looking. CRITICAL severity is never suppressed.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0019_notifications');

-- ── Action vocabulary additions (P20) ──

INSERT OR IGNORE INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('notification.read', 'Read a notification', 'Mark a notification read for the acting user.', 0, 0),
  ('notification.acknowledge', 'Acknowledge a notification', 'Acknowledge a notification, recording that a human saw and accepted it.', 0, 0),
  ('notification_preference.set', 'Set notification preferences', 'Set quiet hours and per-kind notification preferences for the acting user.', 0, 0);

CREATE TABLE IF NOT EXISTS notification (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL
                 CHECK (kind IN ('APPROVAL','EMPLOYEE_EXCEPTION','PORTFOLIO_RISK','BUDGET_THRESHOLD',
                                 'PROVIDER_FAILURE','MEETING','INTELLIGENCE_BRIEF','LP_ISSUE',
                                 'RECONCILIATION_DISCREPANCY','URGENT_DEAL_EVENT')),
  severity       TEXT NOT NULL CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  title          TEXT NOT NULL,
  body           TEXT NOT NULL DEFAULT '',
  object_type    TEXT,
  object_id      TEXT,
  -- Recipient. NULL means firm-wide: visible to every user whose privacy scope allows it.
  firm_user_id   TEXT REFERENCES firm_user (id),
  privacy_label  TEXT NOT NULL DEFAULT 'INTERNAL',
  dedupe_key     TEXT NOT NULL UNIQUE,
  delivery_status TEXT NOT NULL DEFAULT 'DELIVERED_IN_APP'
                 CHECK (delivery_status IN ('DELIVERED_IN_APP','HELD_QUIET_HOURS','SUPPRESSED_BY_PREFERENCE')),
  read_at        TEXT,
  read_by        TEXT,
  acked_at       TEXT,
  acked_by       TEXT,
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_notification_unread ON notification (firm_user_id, read_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_kind ON notification (kind, severity, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_preference (
  firm_user_id     TEXT PRIMARY KEY REFERENCES firm_user (id),
  quiet_hours_json TEXT NOT NULL DEFAULT '{}',
  kinds_json       TEXT NOT NULL DEFAULT '{}',
  push_enabled     INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Every delivery attempt on every channel, including the ones that could not be attempted.
CREATE TABLE IF NOT EXISTS notification_delivery (
  id              TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL REFERENCES notification (id),
  channel         TEXT NOT NULL CHECK (channel IN ('IN_APP','PUSH')),
  status          TEXT NOT NULL CHECK (status IN ('DELIVERED','HELD','UNAVAILABLE','FAILED')),
  detail          TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_notification_delivery ON notification_delivery (notification_id);

CREATE TRIGGER IF NOT EXISTS notification_delivery_reject_update
BEFORE UPDATE ON notification_delivery
BEGIN
  SELECT RAISE(ABORT, 'notification_delivery is append-only: UPDATE rejected (D15)');
END;

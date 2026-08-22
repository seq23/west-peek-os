-- Diagnostics tells somebody.
--
-- Operator, item 22: "escalate unresolved items to both MPs, with a table showing what was escalated
-- and whether it is being worked." The review corrected the premise and found something worse than
-- the operator assumed: Diagnostics DOES detect, and detects accurately. It runs only when somebody
-- opens the page, and it tells nobody. A monitor that checks while you are watching is a mirror.
--
-- THIS TABLE IS THE MEMORY BETWEEN RUNS, and it exists so three different things can be told apart:
-- a fault seen once (usually a blip), a fault still down since Tuesday, and a fault that recovered.
-- Without it every run would either alert on everything or on nothing.
--
-- Escalation waits for a SECOND consecutive sighting. Alerting on the first trains a partner to
-- ignore the alert, which is worse than not sending it.

CREATE TABLE IF NOT EXISTS health_fault (
  id            TEXT PRIMARY KEY,
  check_key     TEXT NOT NULL,
  label         TEXT NOT NULL,
  reading       TEXT,
  remedy        TEXT,
  first_seen_at TEXT NOT NULL,
  -- Null until a partner has been told. Set once, so a fault lasting a week does not send hundreds.
  escalated_at  TEXT,
  -- Null while it is still down. Set when a later run finds it healthy again.
  resolved_at   TEXT,
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- One open fault per check. A second row for something already down would double-count and
-- double-alert.
CREATE UNIQUE INDEX IF NOT EXISTS idx_health_fault_open
  ON health_fault (check_key, firm_scope) WHERE resolved_at IS NULL;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0111_diagnostics_tells_somebody');

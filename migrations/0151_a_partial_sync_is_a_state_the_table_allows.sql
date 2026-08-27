-- 0151 — The community sync could never get past its first 250 contacts.
--
-- `pullResource` applies one page and writes `last_status = 'IN_PROGRESS'` when more remain. The
-- CHECK on `network_sync_cursor` allows only NEVER_RUN, OK, DEGRADED_READ_ONLY and FAILED. So every
-- partial sync threw on the write that records where it got to:
--
--   D1_ERROR: CHECK constraint failed: last_status IN ('NEVER_RUN','OK','DEGRADED_READ_ONLY','FAILED')
--
-- The cursor therefore never advanced. `cursor_value` stayed NULL, `readProgress` returned offset 0,
-- and every run re-applied the same first 250 records for ever. **The paging has never worked.** It
-- looked fine only because no sync had yet exceeded one page.
--
-- Operator, 24 Aug 2026, asking how long a full sync would take. The honest answer before this fix
-- was: it never finishes. It stops at 250 and repeats.
--
-- SQLite cannot alter a CHECK, so the table is rebuilt — the standard twelve-step dance, with the
-- unique index recreated after. One row, and it is a cursor rather than institutional truth, but it
-- is copied rather than reset: throwing it away would restart a sync that has already applied 250.
--
-- 'IN_PROGRESS' is added rather than the code being made to write 'OK', because a partial sync IS a
-- distinct state and the Community page reads this column to decide what to tell a partner. Saying
-- OK at 250 of 4,000 would be the machinery reporting success again.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0151_a_partial_sync_is_a_state_the_table_allows');

CREATE TABLE network_sync_cursor_new (
  id            TEXT PRIMARY KEY,
  resource      TEXT NOT NULL,
  cursor_value  TEXT,
  last_sync_at  TEXT,
  last_status   TEXT NOT NULL DEFAULT 'NEVER_RUN'
                CHECK (last_status IN ('NEVER_RUN','OK','IN_PROGRESS','DEGRADED_READ_ONLY','FAILED')),
  failure_reason TEXT,
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO network_sync_cursor_new (id, resource, cursor_value, last_sync_at, last_status, failure_reason, firm_scope, updated_at)
SELECT id, resource, cursor_value, last_sync_at, last_status, failure_reason, firm_scope, updated_at
  FROM network_sync_cursor;

DROP TABLE network_sync_cursor;

ALTER TABLE network_sync_cursor_new RENAME TO network_sync_cursor;

CREATE UNIQUE INDEX IF NOT EXISTS idx_network_cursor_resource ON network_sync_cursor (resource, firm_scope);

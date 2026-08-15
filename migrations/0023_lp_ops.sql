-- 0023_lp_ops.sql — P24 LP / fund-admin / VDR operating integration (task §9 P24; GAP-18).
--
-- P10 built the LP substrate and P12 built reporting + reconciliation. What was missing is the
-- OPERATING layer: where the administrator's data comes from, whether a source contract exists at
-- all, when reconciliation is next due, how fresh the last import was, and what state each LP
-- relationship is in.
--
-- The authority rule from P12 is unchanged and reinforced here: the administrator, the accountant,
-- and the VDR are authoritative for their own domains. `admin_source` records what West Peek OS
-- has AGREED with them; it never becomes a place to restate their numbers.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0023_lp_ops');

INSERT OR IGNORE INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('admin_source.register', 'Register an administrator source', 'Record an administrator, accounting, or VDR source with its contract state and freshness expectation.', 0, 0),
  ('reconciliation_schedule.set', 'Schedule reconciliation', 'Set the cadence on which a fund is reconciled against its administrator.', 0, 0),
  ('lp_engagement.update', 'Update LP engagement state', 'Record the current state of an LP relationship and its next step.', 0, 0);

CREATE TABLE IF NOT EXISTS admin_source (
  id                 TEXT PRIMARY KEY,
  source_key         TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('FUND_ADMIN','ACCOUNTING','VDR')),
  -- NO_CONTRACT: nobody has agreed an export format. FORMAT_AGREED: a format exists but nothing
  -- has been read. LIVE: a real import has happened. Only an actual import may set LIVE.
  contract_state     TEXT NOT NULL DEFAULT 'NO_CONTRACT'
                     CHECK (contract_state IN ('NO_CONTRACT','FORMAT_AGREED','LIVE')),
  export_format      TEXT NOT NULL DEFAULT '',
  freshness_sla_days INTEGER NOT NULL DEFAULT 30,
  last_import_at     TEXT,
  last_run_id        TEXT REFERENCES fund_reconciliation_run (id),
  note               TEXT NOT NULL DEFAULT '',
  registered_by      TEXT NOT NULL,
  firm_scope         TEXT NOT NULL DEFAULT 'west-peek',
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- The two sources the firm needs and does not have. Recorded so the gap is visible in the
-- product rather than only in a document.
INSERT OR IGNORE INTO admin_source (id, source_key, name, kind, contract_state, freshness_sla_days, note, registered_by) VALUES
  ('asrc_fund_admin', 'fund_administrator', 'Fund administrator of record', 'FUND_ADMIN', 'NO_CONTRACT', 30,
   'No administrator system has been read and no export format has been agreed. Every reconciliation run is stamped LOCAL_FIXTURE, and West Peek OS has no code path that writes to an administrator.',
   'system'),
  ('asrc_vdr', 'virtual_data_room', 'Virtual data room', 'VDR', 'NO_CONTRACT', 30,
   'No VDR provider has been selected. West Peek OS records what was shared and what was revoked; it has never delivered a document to an external room.',
   'system');

CREATE TABLE IF NOT EXISTS reconciliation_schedule (
  id           TEXT PRIMARY KEY,
  fund_id      TEXT NOT NULL REFERENCES fund (id),
  cadence      TEXT NOT NULL CHECK (cadence IN ('MONTHLY','QUARTERLY')),
  next_due_at  TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  last_run_id  TEXT REFERENCES fund_reconciliation_run (id),
  created_by   TEXT NOT NULL,
  firm_scope   TEXT NOT NULL DEFAULT 'west-peek',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (fund_id)
);

CREATE TABLE IF NOT EXISTS lp_engagement (
  lp_record_id  TEXT PRIMARY KEY REFERENCES lp_record (id),
  state         TEXT NOT NULL DEFAULT 'NOT_ENGAGED'
                CHECK (state IN ('NOT_ENGAGED','IN_CONVERSATION','IN_DILIGENCE','AWAITING_DECISION','COMMITTED','DECLINED')),
  owner_id      TEXT REFERENCES firm_user (id),
  next_step     TEXT NOT NULL DEFAULT '',
  last_touch_at TEXT,
  privacy_label TEXT NOT NULL DEFAULT 'LP_PRIVATE',
  updated_by    TEXT NOT NULL,
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS lp_engagement_change (
  id           TEXT PRIMARY KEY,
  lp_record_id TEXT NOT NULL REFERENCES lp_record (id),
  from_state   TEXT NOT NULL,
  to_state     TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  actor_id     TEXT NOT NULL,
  firm_scope   TEXT NOT NULL DEFAULT 'west-peek',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER IF NOT EXISTS lp_engagement_change_reject_update
BEFORE UPDATE ON lp_engagement_change
BEGIN
  SELECT RAISE(ABORT, 'lp_engagement_change is append-only: UPDATE rejected (D15)');
END;

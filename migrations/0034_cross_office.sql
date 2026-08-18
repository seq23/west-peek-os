-- 0034_cross_office.sql — P38: cross-office reconciliation (V1 #8, canon §7.5).
--
-- Canon's coordination law names exactly four things the orchestration service must detect:
-- "duplicate requests, contradictory instructions, resource conflicts, and overlapping outbound
-- drafts". Those four are the CHECK list below, not a taxonomy I invented, so a fifth kind is a
-- deliberate change to the law rather than a quiet addition.
--
-- WHY A TABLE AND NOT A LIVE QUERY. The ledgers in 0035 are pure reads because their sources are
-- append-only and cannot drift. A conflict is different: it has a LIFECYCLE. Someone looks at it,
-- decides the two partners are in fact asking for the same thing, and resolves it — and that
-- resolution has to survive the next detection run. A live query would re-raise the same conflict
-- every time anyone opened the page, which is how a warning surface becomes noise people stop
-- reading. Hence `dedupe_key`: detection is idempotent, and a resolved conflict stays resolved.
--
-- SCOOTER'S FINAL AUTHORITY (§7.5) is recorded, not enforced by code. Canon says his authority
-- "remains controlling for unresolved material decisions" — that is a statement about who decides,
-- not a rule the database should apply on his behalf. So `resolved_by` captures who actually
-- resolved it and the event log carries the override; the system does not auto-resolve in anyone's
-- favour.
--
-- NO PRIVATE CONTENT CROSSES. §7.5 keeps partner-private working notes private, and the memory
-- boundaries section makes that a hard scope. So a conflict row stores the OBJECT the two offices
-- collided over and never the private note that led either of them there.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0034_cross_office');

CREATE TABLE IF NOT EXISTS cross_office_conflict (
  id            TEXT PRIMARY KEY,
  conflict_type TEXT NOT NULL
                CHECK (conflict_type IN ('DUPLICATE_REQUEST','CONTRADICTORY_INSTRUCTION','RESOURCE_CONFLICT','OVERLAPPING_OUTBOUND')),
  -- What the two offices collided over.
  object_type   TEXT NOT NULL,
  object_id     TEXT NOT NULL,
  summary       TEXT NOT NULL,
  detail_json   TEXT NOT NULL DEFAULT '{}',
  -- Stable across detection runs so the same collision is raised once, not once per refresh.
  dedupe_key    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'OPEN'
                CHECK (status IN ('OPEN','RESOLVED','ACCEPTED')),
  -- ACCEPTED means "yes, both offices are working this, and that is fine" — a real outcome that
  -- differs from RESOLVED (the collision was removed) and must not be collapsed into it.
  resolution_note TEXT,
  resolved_by   TEXT REFERENCES firm_user (id),
  resolved_at   TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  UNIQUE (firm_scope, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_cross_office_status ON cross_office_conflict (status, conflict_type);

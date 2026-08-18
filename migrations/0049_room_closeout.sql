-- 0049 — what came out of a Room.
--
-- WHY NOT REUSE meeting_commitment. Its meeting_id is a hard foreign key into `meeting`, so
-- storing a Room's follow-ups there would mean forging a meeting row for every gathering — which
-- would then show up in the meetings surface, in meeting counts, and in the IC workspace. The
-- POLICY is what deserves reuse (shared/meetings/delegationPolicy.ts decides every assignment
-- here, so the operator's rule lives in exactly one place); the storage does not.
--
-- WHAT IS DELIBERATELY NOT CAPTURED. A meeting close-out records COUNTERPARTY commitments as well
-- as the firm's, because a counterparty there is a founder or an LP inside a deal. At a Room the
-- other people are members, and "a member promising another member an introduction should be
-- handled between those members" (operator, 17 Aug 2026). So evt_commitment has no owner_side: it
-- holds West Peek's obligations only, and there is nowhere to put anyone else's.
CREATE TABLE IF NOT EXISTS evt_closeout (
  id                TEXT PRIMARY KEY,
  event_id          TEXT NOT NULL REFERENCES evt_event (id),
  digest_md         TEXT NOT NULL,
  commitment_count  INTEGER NOT NULL DEFAULT 0,
  assigned_count    INTEGER NOT NULL DEFAULT 0,
  recommended_count INTEGER NOT NULL DEFAULT 0,
  -- How many community acts this close-out recorded. Attendance is the cheapest Council evidence
  -- there is, and it is only capturable in the days after a Room.
  acts_recorded     INTEGER NOT NULL DEFAULT 0,
  state             TEXT NOT NULL DEFAULT 'COMPLETE'
                    CHECK (state IN ('COMPLETE','NO_NOTES','EXTRACTION_FAILED')),
  detail            TEXT,
  ai_run_id         TEXT,
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- One close-out per Room. Re-running replaces nothing silently; it is refused.
  UNIQUE (event_id)
);

CREATE TABLE IF NOT EXISTS evt_commitment (
  id                 TEXT PRIMARY KEY,
  event_id           TEXT NOT NULL REFERENCES evt_event (id),
  closeout_id        TEXT NOT NULL REFERENCES evt_closeout (id),
  commitment_text    TEXT NOT NULL,
  due_date           TEXT,
  -- Decided by resolveAssignment(): AI employees by default, humans only where the work genuinely
  -- requires one. Never chosen by the extracting model.
  assignee_kind      TEXT NOT NULL
                     CHECK (assignee_kind IN ('AI_EMPLOYEE','AI_WITH_HUMAN_TOUCH','HUMAN_RECOMMENDED','UNASSIGNED')),
  ai_employee_id     TEXT,
  human_touch_reason TEXT,
  -- Words that appear in the notes. No quote, no commitment — the guard against a plausible
  -- follow-up nobody actually agreed to.
  source_quote       TEXT,
  status             TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DONE','DROPPED')),
  firm_scope         TEXT NOT NULL DEFAULT 'west-peek',
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_evt_commitment_event ON evt_commitment (event_id, status);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0049_room_closeout');

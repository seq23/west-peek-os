-- 0026_meeting_live_help.sql — P31: Live Help, the meeting workspace's chat with AI employees.
--
-- Canon §3 (Meeting Buddy Layer) and §28.5 (General Meeting Intelligence Workspace) specify a
-- workspace whose Live Help tab is "where Walter lives". The meeting RECORD was built — participants,
-- consent, notes, commitments, debriefs — but the colleague sitting next to you was never built.
-- Walter is role 17 on the roster with nothing to inhabit.
--
-- Two additive tables. Nothing existing is altered, so every current meeting surface behaves
-- exactly as before and a meeting with no Live Help is simply a meeting nobody asked for help in.
--
-- GOVERNANCE CARRIED OVER, NOT RE-INVENTED:
--   * an employee must be ACTIVE to be seated (the ≤5 activation cap already governs that);
--   * each turn records its `ai_run_id`, so cost, provider, model and quarantine stay attached;
--   * the workspace is INTERNAL-ONLY and a drafted follow-up is a draft — canon §3.2 is explicit
--     that "no external follow-up is sent without human approval", so nothing here sends anything.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0026_meeting_live_help');

-- Who is in the room with you. A seat, not an authorisation: seating an employee grants no new
-- capability, it scopes which context and voice answer in this meeting.
CREATE TABLE IF NOT EXISTS meeting_employee (
  id             TEXT PRIMARY KEY,
  meeting_id     TEXT NOT NULL REFERENCES meeting (id),
  ai_employee_id TEXT NOT NULL REFERENCES ai_employee (id),
  seated_by      TEXT NOT NULL,
  seated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  released_at    TEXT,
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  UNIQUE (meeting_id, ai_employee_id)
);

CREATE INDEX IF NOT EXISTS idx_meeting_employee_meeting ON meeting_employee (meeting_id, released_at);

-- The conversation. Append-only by convention: a live meeting record that can be edited after the
-- fact is not evidence of what was said during it.
CREATE TABLE IF NOT EXISTS meeting_chat_turn (
  id             TEXT PRIMARY KEY,
  meeting_id     TEXT NOT NULL REFERENCES meeting (id),
  turn_no        INTEGER NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('OPERATOR','EMPLOYEE','SYSTEM')),
  -- NULL for an operator turn; set when a specific employee answered.
  ai_employee_id TEXT REFERENCES ai_employee (id),
  body           TEXT NOT NULL,
  -- Provenance for anything a model produced. NULL on operator turns.
  ai_run_id      TEXT,
  -- REFUSED covers a governed refusal (privacy, budget, no active employee) so a blocked turn is
  -- visible in the transcript rather than silently missing.
  state          TEXT NOT NULL DEFAULT 'OK' CHECK (state IN ('OK','REFUSED','FAILED')),
  detail         TEXT,
  author_id      TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  UNIQUE (meeting_id, turn_no)
);

CREATE INDEX IF NOT EXISTS idx_meeting_chat_meeting ON meeting_chat_turn (meeting_id, turn_no);

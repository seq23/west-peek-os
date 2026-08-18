-- Capture resolves to a company or a person — and says when it cannot.
--
-- THE HOLE THIS CLOSES. Four things were easy to confuse because only two of them are allowed to
-- be the truth about anything:
--
--   Network OS   system of record for PEOPLE. Read-only from here (D5, canon §12A.2).
--   companies    system of record for COMPANIES (D3). Everything deal-shaped hangs off it.
--   capture      a holding pen. Owns nothing.
--   community    a lens on the population. Explicitly NOT the roster (see communityOs.ts).
--
-- Capture routed to a processing machine and could raise a work card, and that was all. Nothing
-- ever said "this note is about a company" and reconciled it against the company register, or
-- "this is a person" and checked Network OS. So the two systems of record were fed by hand while
-- the inbox filled up beside them.
--
-- The sharper problem sat underneath: Network OS is READ-ONLY from here, and writeback is governed
-- separately (canon §12A.5). When capture surfaces someone Network OS has never heard of, there is
-- nowhere to put them. Not a missing screen — a missing destination.
--
-- So a capture records what it resolved to, and `LOCAL_UNRESOLVED` is a first-class outcome rather
-- than a failure. A person Network OS does not know is written here, marked, and QUEUED — the same
-- vocabulary com_member already uses for exactly this state (migration 0029). The queue is the
-- honest artifact: it does not pretend the person is in the system of record, and it turns "we
-- should probably build writeback" into a countable list of people who are actually waiting.
--
-- Deliberately NOT here: any write to Network OS. That decision wants evidence of how often this
-- happens, and the queue is how that evidence accumulates.

ALTER TABLE capture ADD COLUMN resolved_kind TEXT
  CHECK (resolved_kind IN ('COMPANY','PERSON','NEITHER'));

-- Whichever register the resolution landed in. Exactly one is ever set.
ALTER TABLE capture ADD COLUMN resolved_company_id TEXT REFERENCES canonical_company (id);
ALTER TABLE capture ADD COLUMN resolved_person_id TEXT REFERENCES person (id);

-- For a PERSON: whether the system of record actually knows them.
-- Same vocabulary as com_member.membership_source, on purpose — one question, one answer shape.
ALTER TABLE capture ADD COLUMN person_source TEXT
  CHECK (person_source IN ('NETWORK_OS','LOCAL_UNRESOLVED'));

ALTER TABLE capture ADD COLUMN resolved_at TEXT;
ALTER TABLE capture ADD COLUMN resolution_note TEXT;

-- The queue: people this firm has met who are not in the system of record. Small, and the whole
-- point is that it is visible.
CREATE INDEX IF NOT EXISTS idx_capture_unresolved_person
  ON capture (person_source, resolved_at)
  WHERE person_source = 'LOCAL_UNRESOLVED';

CREATE INDEX IF NOT EXISTS idx_capture_resolved_kind
  ON capture (resolved_kind, firm_scope);

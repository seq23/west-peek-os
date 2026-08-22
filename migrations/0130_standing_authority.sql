-- Approving something once, and not being asked again — within bounds that cannot be omitted.
--
-- Operator, 22 Aug 2026: "can we click a button on work cards and dismiss need for approvals on
-- future cards for the day / week or for this specific task?" Reasoning in
-- docs/APPROVAL_AND_WORK_DESIGN.md; the architectural half is ADR-018.
--
-- THIS IS DELEGATED AUTHORITY AND NOT DISMISSAL, which is the distinction the schema enforces. An
-- LPA lets a GP act within stated limits without going back to the LPs; a board delegates spend up
-- to a threshold; a desk sets a daily limit. Each carries a scope, a limit and an expiry. Authority
-- is delegable. Judgment is not.
--
-- ALL THREE BOUNDS ARE REQUIRED. `ends_at` is NOT NULL and `max_uses` is NOT NULL with a CHECK above
-- zero, so there is no way to record an unbounded grant even by mistake. A grant with no expiry
-- becomes permanent through neglect: revoking one means first remembering it exists, and the whole
-- reason it was granted was to stop thinking about the thing.
--
-- WHAT IT CAN NEVER COVER is enforced in authorize() rather than here, because the reserved and
-- external-effect flags live on `action_type` and can change: a key that becomes reserved next month
-- must immediately stop being coverable by a grant written last month. `grantStandingAuthority()`
-- also refuses at creation, so the impossible row is never written in the first place.
CREATE TABLE IF NOT EXISTS standing_authority (
  id             TEXT PRIMARY KEY,
  action_key     TEXT NOT NULL REFERENCES action_type (key),
  -- Optional narrowing to one object. NULL means the action key anywhere, which is still bounded by
  -- the use count and the expiry.
  object_type    TEXT,
  object_id      TEXT,
  -- END OF THIS TASK is the recommended expiry: its lifetime is a real event rather than a clock
  -- that keeps running overnight. When set, the grant also dies when the card leaves an open state.
  work_card_id   TEXT REFERENCES work_card (id),
  ends_at        TEXT NOT NULL,
  max_uses       INTEGER NOT NULL CHECK (max_uses > 0),
  uses           INTEGER NOT NULL DEFAULT 0,
  -- Human only, and named. An AI employee cannot grant itself authority.
  granted_by     TEXT NOT NULL REFERENCES firm_user (id),
  reason         TEXT NOT NULL CHECK (length(trim(reason)) >= 4),
  revoked_at     TEXT,
  revoked_by     TEXT REFERENCES firm_user (id),
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_standing_authority_live
  ON standing_authority (action_key, revoked_at, ends_at);

-- Every use is recorded. A grant whose uses cannot be enumerated is a grant nobody can audit, and
-- the count on the row alone would say how many without saying what.
CREATE TABLE IF NOT EXISTS standing_authority_use (
  id           TEXT PRIMARY KEY,
  authority_id TEXT NOT NULL REFERENCES standing_authority (id),
  object_type  TEXT,
  object_id    TEXT,
  actor_type   TEXT NOT NULL CHECK (actor_type IN ('HUMAN','AI','SYSTEM')),
  actor_id     TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_standing_authority_use ON standing_authority_use (authority_id, created_at);

-- Append-only, same as every other record of who allowed what. A grant that could be edited after
-- the fact would let somebody widen yesterday's permission to cover today's action.
CREATE TRIGGER IF NOT EXISTS standing_authority_use_no_update
BEFORE UPDATE ON standing_authority_use
BEGIN
  SELECT RAISE(ABORT, 'standing_authority_use is append-only');
END;

CREATE TRIGGER IF NOT EXISTS standing_authority_use_no_delete
BEFORE DELETE ON standing_authority_use
BEGIN
  SELECT RAISE(ABORT, 'standing_authority_use is append-only');
END;

-- The scope, the limit and the expiry are fixed at grant time. Only the use count and the two
-- revocation columns may move — widening a live grant is how a bounded permission quietly becomes an
-- unbounded one.
CREATE TRIGGER IF NOT EXISTS standing_authority_bounds_are_fixed
BEFORE UPDATE ON standing_authority
FOR EACH ROW WHEN
     NEW.action_key <> OLD.action_key
  OR NEW.ends_at    <> OLD.ends_at
  OR NEW.max_uses   <> OLD.max_uses
  OR IFNULL(NEW.object_id, '')   <> IFNULL(OLD.object_id, '')
  OR IFNULL(NEW.object_type, '') <> IFNULL(OLD.object_type, '')
  OR IFNULL(NEW.work_card_id, '') <> IFNULL(OLD.work_card_id, '')
BEGIN
  SELECT RAISE(ABORT, 'a standing grant cannot be widened after it is made — revoke it and grant another');
END;

-- OR IGNORE here and NOWHERE else in this file: the version marker is the one row where a re-apply
-- is genuinely a no-op rather than a swallowed failure.
INSERT OR IGNORE INTO schema_version (migration) VALUES ('0130_standing_authority');

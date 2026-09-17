-- 0176 · Deciding a packet by replying to Parker's email, and the month that is not his
--
-- ══ PART ONE — THE PER-PACKET DECISION TOKEN ══════════════════════════════════════════════════
--
-- Operator, 17 Sep 2026: "you can have Parker give us a special #hashtag to use and anything after
-- that is the reason?" Yes — with one change, and the change is the rule this repo already turns
-- on. `src/worker/effects/inboundEmail.ts`, at the top, in as many words:
--
--   "A hashtag is a public word — so it may route but must never authorise."
--
-- That is why `#wpdealflow` files a CAPTURE rather than creating an opportunity: anyone who learns
-- a published word can type it. A fixed tag like `#wpno` is precisely what that rule forbids —
-- one forwarded email, one screenshot, one contractor who saw one, and a stranger can cancel a
-- month's plan by writing five characters.
--
-- So the tag is MINTED PER PACKET and lives here, one row, with three properties the scheme
-- depends on:
--
--   SINGLE USE     `used_at` is set when it is spent. A partner who replies twice does not
--                  re-decide something already decided, and a thread cannot be replayed.
--   EXPIRES        with the month the packet is FOR. October's email cannot decide anything in
--                  February, because the thing it decided has already happened or not.
--   NOT ENOUGH     on its own. The token is one of two required facts; the other is an
--                  authenticated `From` on one of the two assigning partner addresses
--                  (`mailAuthority`, the same bar an emailed work assignment clears). A leaked
--                  token alone does nothing; a forged From alone does nothing.
--
-- WHY A TABLE AND NOT A DERIVED SECRET. An HMAC of the packet id would need no row — and would
-- also be un-revocable and un-spendable: "used once" is state, and state belongs in a row. The
-- row is also the audit trail for the question that matters after the fact, "who decided this and
-- through which door".
--
-- WHAT THIS TABLE DOES NOT DO: decide anything. The reply handler calls `decidePacket`, the same
-- function the button on Events & Rooms calls — same status, same note, same event, same shelf.
-- A second decision path would be a second set of rules to keep in step, and this repo has that
-- defect written down as "two components each keeping their own list with no link".
CREATE TABLE IF NOT EXISTS evt_packet_decision_token (
  -- The token as it appears after the tag: `#wpno-7Q4K` stores `7Q4K`. Upper case, no O/0/I/1/L —
  -- it is read off a screen and retyped on a phone.
  token          TEXT PRIMARY KEY,
  packet_id      TEXT NOT NULL REFERENCES evt_room_packet (id),
  -- Carried rather than joined, so expiry is answerable without reading the packet: a token whose
  -- packet was deleted must still refuse rather than fail open.
  proposed_for_month TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  -- Spent. Null while it is live; the timestamp and the address that spent it once it is not.
  used_at        TEXT,
  used_by        TEXT,
  -- APPROVED or DECLINED, once spent. Kept so "what did this token do" needs no event search.
  used_decision  TEXT CHECK (used_decision IN ('APPROVED','DECLINED')),
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- One live token per packet: the email carries exactly one code, so a second live row for the same
-- packet would mean two codes in circulation and no way to say which the partner is holding.
CREATE UNIQUE INDEX IF NOT EXISTS idx_packet_decision_token_live
  ON evt_packet_decision_token (packet_id) WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_packet_decision_token_scope
  ON evt_packet_decision_token (firm_scope, expires_at);

-- ══ PART TWO — OCTOBER IS NOT PARKER'S, AND ADJACENCY HAS TO KNOW ═════════════════════════════
--
-- Operator, 17 Sep 2026: October's Workshop is "externally hosted by a friend of Scooter's, and it
-- is about content creation."
--
-- This row is not bookkeeping. The adjacency rule ("one month back, not too similar") must measure
-- against WHAT ACTUALLY RAN, and October's session is the one month in the window that this system
-- never built. Without this row, adjacency for November reads Parker's own October AI packet —
-- which she DECLINED — so November would carefully avoid a dead idea and walk straight into the
-- subject that is actually being run.
--
-- IDEMPOTENT, AND SCOPED. A fixed id and `INSERT OR IGNORE`, so re-applying the migration cannot
-- produce a second October; `firm_scope` is west-peek, like every other row here, so it is visible
-- to exactly the reader that needs it.
--
-- `packet_id` is NULL on purpose: there is no packet, because the firm did not plan it. That is
-- the fact being recorded.
INSERT OR IGNORE INTO evt_event (
  id, title, event_type, event_class, cadence, theme, status, starts_at, ends_at,
  location, live_url, summary, packet_id, target_min, target_max, firm_scope, created_by, kind
) VALUES (
  'evt_external_2026_10_workshop',
  'October Workshop (hosted outside the firm) — content creation',
  'WORKSHOP', 'OTHER', 'ONE_OFF',
  'Content creation',
  'PLANNED',
  '2026-10-15T17:00:00.000Z', NULL,
  'Hosted by a friend of Scooter''s — not a West Peek production',
  NULL,
  'October 2026''s Workshop slot is hosted by a friend of Scooter''s and is about content creation. '
  || 'West Peek is not building it. It is on the record because it is what RAN, and the adjacency '
  || 'rule for November''s Workshop measures against what ran rather than against what was proposed.',
  NULL, NULL, NULL,
  'west-peek', 'system', 'WORKSHOP'
);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0176_decide_a_packet_by_replying');

-- 0194 — A one-off is built now; a steer waits for its month. And the Rooms poll stops being a poll.
--
-- Operator, 18 Sep 2026:
--   "if i make an ask of Parker for next month's proposal or ask for a one-off that is 2 diff
--    things: a one off should be delivered and acted upon immediately; asking for a specific topic
--    or angle to next months propoals should come when the month's proposal comes"
--
-- ── WHAT WAS ACTUALLY TRUE, REPRODUCED BEFORE ANY OF THIS WAS WRITTEN ───────────────────────────
--
-- Both asks were the same ask. `handleGeneratePacket` queues a DRAFT and opens Parker's card in the
-- request path, whatever month the ask names. Confirmed by running it, not by reading it: an ask on
-- 18 September naming 2026-11 — "Black lawyers, several distinct name ideas this time", which is a
-- STEER in her words and in her plan — came back `201 queued:true` with a work_card in state OPEN
-- titled "Parker: build the November 2026 Room packet". The sweep would have built and emailed
-- November's packet that afternoon, six weeks before its cadence and with no way for her to tell it
-- had happened except the email arriving.
--
-- ── 1 · THE TWO KINDS ARE DECLARED, NOT GUESSED ────────────────────────────────────────────────
--
-- The door now takes an `intent` of NOW or STEER. There is NO classifier over her prose: a regex or
-- a model deciding what "next month, try Black lawyers" meant is right until it is confidently
-- wrong, and being wrong here is exactly the defect above with a confidence score attached. Where
-- no intent is declared, `classifyAsk` (src/shared/events/monthlyPlan.ts) applies ONE calendar
-- comparison anybody can check: an ask for a month at or before the one being delivered has nothing
-- to wait for and is built now; an ask for a later month is AMBIGUOUS and the door refuses with
-- both readings written out. Asking costs a click. Guessing costs November.
--
-- ── 2 · WHERE A STEER LIVES, AND WHY IT IS ITS OWN TABLE ───────────────────────────────────────
--
-- `evt_room_packet` was the obvious place and it is the wrong one: a steer given in September for
-- November exists BEFORE there is a packet to hang it on, and the whole point is that it survives
-- the gap. `MONTHLY_PLAN` is the other half of this and stays in code — a decision the partners
-- made once, reviewable in a diff. This table is the half she can write from the page, keyed by the
-- month it is FOR rather than the month it arrived in.
--
-- APPEND-ONLY, AND TWO STEERS FOR ONE MONTH BOTH SURVIVE. Replacing the first with the second
-- discards an instruction she gave with no trace and no way to notice; both are carried into the
-- packet oldest-first, and the interpretation prompt already says a later instruction outranks an
-- earlier one where they conflict. Withdrawal is a column she sets from a control, never implicit.
--
-- `delivered_packet_id` is what stops it being remembered for ever: a steer that reached the packet
-- says which packet, and the page shows "Parker has this" instead of pretending it is still owed.
CREATE TABLE IF NOT EXISTS evt_month_steer (
  id                  TEXT PRIMARY KEY,
  firm_scope          TEXT NOT NULL,
  -- YYYY-MM, THE MONTH IT IS FOR. Not the month it arrived in — that is `given_at`.
  for_month           TEXT NOT NULL,
  stream              TEXT NOT NULL CHECK (stream IN ('ROOM', 'WORKSHOP')),
  -- Her words, exactly as typed. Never paraphrased before storage: the receipt rule.
  words               TEXT NOT NULL,
  given_by            TEXT,
  given_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  withdrawn_at        TEXT,
  withdrawn_by        TEXT,
  delivered_packet_id TEXT,
  delivered_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_evt_month_steer_month
  ON evt_month_steer (firm_scope, for_month, stream, withdrawn_at);

-- ── 3 · THE POLL BECOMES A BACKSTOP, AND DROPS FROM 96 TICKS A DAY TO 24 ────────────────────────
--
-- The Rooms job did two unrelated jobs every fifteen minutes: open a card for a DRAFT nothing had
-- opened, and mint next month's packets. The first is an EVENT — it already happens in the request
-- path, the moment she asks, which is zero wait rather than up to fifteen minutes — so the tick is
-- a safety net for a case that should not occur. The second is a CALENDAR rule: the 1st of the
-- month prior, which one tick an hour reaches within an hour of midnight.
--
-- Ninety-six ticks a day to catch a miss that should not happen is the runaway shape migration 0193
-- just removed from the deck lane. And when the backstop DOES catch a draft whose card was never
-- opened, that is a defect in the event path: it notifies the partners and says so in the run
-- summary, rather than quietly papering over it and looking like a successful poll.
--
-- ── 4 · THE MONTH ROLLS OVER ON HER CLOCK ──────────────────────────────────────────────────────
--
-- `daily_at_tz` on an INTERVAL row does not schedule anything — `computeNextRun` returns before it
-- reads the zone for INTERVAL, so the cadence is unchanged and every other job is untouched. It is
-- stored because "the 1st of the month prior" is a LOCAL-TIME boundary and `deliveryMonth` was
-- reading it in UTC: at 2026-10-01T00:30Z the clock in Chicago reads 30 September, so November's
-- packets minted on the evening of the 30th by her calendar. The job now hands its own zone to
-- `deliveryMonth`, which takes the offset from the platform's timezone database at the instant in
-- question, so the November clock change is not an event this code has to know about. Same column,
-- same meaning — "the clock this job is written against" — rather than a second column carrying it.
UPDATE scheduled_job
   SET schedule_kind    = 'INTERVAL',
       interval_minutes = 60,
       daily_at_tz      = 'America/Chicago',
       name             = 'Rooms: mint the month''s packets, and catch anything the request path missed'
 WHERE job_key = 'monthly_room_proposal';

-- A migration that reports success while changing nothing is a defect this repo has shipped twice.
-- A CHECK that only accepts 1 turns "the UPDATE matched no row" into an error the runner reports,
-- because RAISE() is legal only in a trigger body and a bare SELECT that finds nothing still exits 0.
CREATE TABLE migration_guard_0194 (matched INTEGER NOT NULL CHECK (matched = 1));
INSERT INTO migration_guard_0194 (matched)
SELECT COUNT(*) FROM scheduled_job
 WHERE job_key = 'monthly_room_proposal'
   AND schedule_kind = 'INTERVAL'
   AND interval_minutes = 60
   AND daily_at_tz = 'America/Chicago';
DROP TABLE migration_guard_0194;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0194_a_steer_waits_for_its_month');

-- 0048 — things we know about a person, written down so a match can use them.
--
-- The Mastermind produces needs and experience as a by-product of members asking and answering.
-- But most of what West Peek learns about someone is learned in a hallway: "Ada is quietly looking
-- for a job", "Dev has hired thirty engineers". Without somewhere to put that, matching only works
-- in the months a Mastermind actually ran.
--
-- TWO THINGS MAKE THIS SAFE RATHER THAN CREEPY:
--
--   1. EVERY SIGNAL EXPIRES. "Looking for a job" is true for a season, not forever. An
--      introduction proposed on a two-year-old job hunt is embarrassing in front of the person it
--      is about, and it is the obvious way this feature would rot. expires_at is NOT NULL and the
--      matcher ignores anything past it — so the default behaviour of a forgotten signal is to go
--      quiet, not to keep firing.
--
--   2. IT IS CONFIDENTIAL BY DEFAULT. That someone is job-hunting while employed is exactly the
--      kind of thing that must not leak. Signals are INTERNAL, they are never part of a
--      sponsor-facing payload, and the rationale a partner reads is not something a machine sends
--      onward — a person writes the actual introduction.
CREATE TABLE IF NOT EXISTS rel_signal (
  id          TEXT PRIMARY KEY,
  person_id   TEXT NOT NULL REFERENCES person (id),
  -- NEED: what they are working through. OFFER: what they have done and could help with.
  kind        TEXT NOT NULL CHECK (kind IN ('NEED','OFFER')),
  -- Plain English, the way it would be said out loud: "looking for a job in climate hardware".
  body        TEXT NOT NULL CHECK (length(trim(body)) >= 8),
  source      TEXT NOT NULL DEFAULT 'PARTNER_ENTRY'
              CHECK (source IN ('PARTNER_ENTRY','MASTERMIND','EVENT_CLOSEOUT','PLATFORM')),
  event_id    TEXT REFERENCES evt_event (id),
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- NOT NULL on purpose: there is no such thing as a permanent signal here.
  expires_at  TEXT NOT NULL,
  -- Retired early when it stops being true — they took the job, they found the cofounder.
  retired_at  TEXT,
  retired_by  TEXT,
  recorded_by TEXT NOT NULL,
  firm_scope  TEXT NOT NULL DEFAULT 'west-peek'
);

CREATE INDEX IF NOT EXISTS idx_rel_signal_person ON rel_signal (person_id, kind);
CREATE INDEX IF NOT EXISTS idx_rel_signal_live ON rel_signal (expires_at, retired_at);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0048_relationship_signals');

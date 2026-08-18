-- 0028_event_community_scaffold.sql — P33: Event OS and Community OS, bare bones.
--
-- V1 #20 (Event OS core and AI Event Planner) and canon §14 (Community OS) were both genuinely
-- unbuilt — the audit on 17 Aug 2026 found no tables for either. The near-miss worth recording:
-- `event_record` LOOKS like Event OS and is not. It is the domain event log from 0001. A name
-- collision, and the reason this migration prefixes its tables `evt_` rather than taking `event`.
--
-- SCOPE IS DELIBERATELY THIN. Operator direction, 17 Aug 2026: "Event OS and community OS can just
-- have the bare bones and scaffolding for now and we can move to make it meatier later." So this
-- is the smallest schema that can hold a real record without pre-judging the shape of features
-- nobody has specified. No run-of-show, no sponsorship, no ticketing, no cohort analytics.
--
-- WEST PEEK LIVE IS ALREADY BUILT and lives outside this system (the agency-event-os repo, served
-- at westpeek.live). It is a LiveKit virtual conference app — this module must not reimplement it.
-- `live_url` is the whole integration for now: West Peek OS owns the event as a firm record
-- (who, when, which companies, what came out of it) and links to the app that runs the room.
-- Duplicating the conference app's own state here would create exactly the second source of truth
-- that canon §0E.4 forbids.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0028_event_community_scaffold');

-- ── Event OS ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS evt_event (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  event_type    TEXT NOT NULL DEFAULT 'OTHER'
                CHECK (event_type IN ('DINNER','SUMMIT','WORKSHOP','OFFICE_HOURS','MASTERMIND','WEBINAR','OTHER')),
  status        TEXT NOT NULL DEFAULT 'DRAFT'
                CHECK (status IN ('DRAFT','PLANNED','LIVE','COMPLETE','CANCELLED')),
  starts_at     TEXT,
  ends_at       TEXT,
  location      TEXT,
  -- Link to the room in West Peek Live. NULL for a purely physical event.
  live_url      TEXT,
  summary       TEXT,
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_evt_event_status ON evt_event (status, starts_at);

-- Attendance points at `person`, the existing canonical person record, rather than storing names.
-- An event that invents its own copy of a person is how the relationship graph rots.
CREATE TABLE IF NOT EXISTS evt_attendee (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES evt_event (id),
  person_id     TEXT REFERENCES person (id),
  display_name  TEXT NOT NULL,
  attendee_role TEXT NOT NULL DEFAULT 'GUEST'
                CHECK (attendee_role IN ('HOST','SPEAKER','GUEST','FOUNDER','LP','PORTFOLIO')),
  rsvp          TEXT NOT NULL DEFAULT 'INVITED'
                CHECK (rsvp IN ('INVITED','ACCEPTED','DECLINED','ATTENDED','NO_SHOW')),
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (event_id, display_name)
);

CREATE INDEX IF NOT EXISTS idx_evt_attendee_event ON evt_attendee (event_id);

-- ── Community OS ────────────────────────────────────────────────────────────
--
-- Canon §14. Note for whoever picks this up: the `west-peek-community` repo is the MARKETING SITE
-- (joinwestpeek.com) and has nothing to do with this module — confirmed by the operator on
-- 17 Aug 2026, after the audit initially mistook the two.

CREATE TABLE IF NOT EXISTS com_member (
  id            TEXT PRIMARY KEY,
  person_id     TEXT REFERENCES person (id),
  display_name  TEXT NOT NULL,
  member_type   TEXT NOT NULL DEFAULT 'MEMBER'
                CHECK (member_type IN ('MEMBER','FOUNDER','OPERATOR','INVESTOR','ALUMNI')),
  status        TEXT NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('PROSPECT','ACTIVE','LAPSED','REMOVED')),
  joined_at     TEXT,
  notes         TEXT,
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (firm_scope, display_name)
);

CREATE INDEX IF NOT EXISTS idx_com_member_status ON com_member (status);

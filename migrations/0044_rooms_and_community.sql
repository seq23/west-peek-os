-- 0044 — Rooms, the community model, and where deals actually come from.
--
-- Built against docs/COMMUNITY.md, which is the source of truth. Read it before changing anything
-- here; several columns exist because of a sentence in that document and look arbitrary without it.
--
-- Two absences are deliberate and load-bearing:
--
--   1. There is NO member stage column. The document says most members remain in the broad
--      mastermind forever and that this is intentional. A stage column makes them look stalled and
--      invites a conversion-rate-to-Council metric, which manufactures the status ladder the
--      Council is defined as not being.
--
--   2. There is NO participation score. Council membership is a human decision recorded with a
--      reason. `com_act` records what happened; a partner reads it. See src/shared/community/acts.ts,
--      which has a test that fails if a score is ever added.

-- ── Rooms ────────────────────────────────────────────────────────────────────
--
-- A Room is not a new table. It is West Peek's flagship event product, and the existing evt_event
-- already carries title, times, location, status and the westpeek.live URL.
--
-- WHY event_class INSTEAD OF WIDENING event_type. event_type's CHECK cannot be widened without
-- rebuilding the table, and a rebuild here means dropping the evt_attendee foreign key — with
-- PRAGMA foreign_keys being a no-op inside a transaction, that is a real risk for a cosmetic gain.
-- It is also better modelling: class is which product line this belongs to, type is what form it
-- takes. The document lists Rooms as "dinners, workshops, salons, deep-work sessions, operator
-- roundtables" — so a ROOM can perfectly well be a DINNER.
ALTER TABLE evt_event ADD COLUMN event_class TEXT NOT NULL DEFAULT 'OTHER'
  CHECK (event_class IN ('ROOM','MASTERMIND','OFFICE','SUMMIT','COUNCIL','OTHER'));

-- The Office is weekly, the Mastermind and Room monthly, regional gatherings quarterly, the Summit
-- annual. Recurrence is a property of the series, and Tap In Tuesday is one row per occurrence with
-- WEEKLY cadence rather than a recurrence-rule engine nobody asked for.
ALTER TABLE evt_event ADD COLUMN cadence TEXT NOT NULL DEFAULT 'ONE_OFF'
  CHECK (cadence IN ('ONE_OFF','WEEKLY','MONTHLY','QUARTERLY','ANNUAL'));

-- "Each month West Peek hosts one focused Room around a specific theme."
ALTER TABLE evt_event ADD COLUMN theme TEXT;

-- The packet this Room was executed from, when it came out of a proposal.
ALTER TABLE evt_event ADD COLUMN packet_id TEXT;

-- "a curated working dinner or hybrid salon for 25–35". A Room has a size it is designed for, and
-- a Room that doubles is a different event.
ALTER TABLE evt_event ADD COLUMN target_min INTEGER;
ALTER TABLE evt_event ADD COLUMN target_max INTEGER;

CREATE INDEX IF NOT EXISTS idx_evt_event_class ON evt_event (event_class, starts_at);

-- ── The Room packet ──────────────────────────────────────────────────────────
--
-- Parker proposes a Room at least monthly. The packet is the proposal: theme, format, guest ideas,
-- agenda, venue options with real prices and real booking contacts, and the economics.
--
-- The operator's bar is "all the humans have to do is execute". That is a high bar and the reason
-- evt_packet_venue enforces sourcing the way it does below.
CREATE TABLE IF NOT EXISTS evt_room_packet (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  theme               TEXT NOT NULL,
  -- The Zero-to-One Room's "What actually changes when an operator becomes a founder?" — a Room
  -- is organised around one question, not a topic area.
  central_question    TEXT,
  status              TEXT NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT','PROPOSED','APPROVED','DECLINED','SCHEDULED','USED')),
  -- YYYY-MM. One proposal per month, generated idempotently — the job runs daily and checks.
  proposed_for_month  TEXT NOT NULL,
  format              TEXT NOT NULL DEFAULT 'DINNER'
                      CHECK (format IN ('DINNER','SALON','WORKSHOP','ROUNDTABLE','DEEP_WORK','EXCURSION','VIRTUAL','HYBRID')),
  -- Virtual Rooms run on westpeek.live. Set when the format is VIRTUAL or HYBRID.
  live_url            TEXT,
  target_min          INTEGER NOT NULL DEFAULT 25,
  target_max          INTEGER NOT NULL DEFAULT 35,
  -- Who should be in the room, in prose. "strong operators, first-time founders, startup lawyers…"
  audience            TEXT,
  agenda_md           TEXT,
  -- Questions to seed the room with. The document has participants submit these anonymously; these
  -- are Parker's starting set, not member submissions.
  seed_questions_json TEXT NOT NULL DEFAULT '[]',
  -- Guest ideas as prose descriptions plus, where they exist, person ids from the graph.
  guest_ideas_json    TEXT NOT NULL DEFAULT '[]',
  -- Venue cost, F&B, travel, target sponsor revenue. Per-Room economics, not firm accounting.
  economics_json      TEXT NOT NULL DEFAULT '{}',
  -- Why a sponsor would underwrite this. "You are underwriting a trusted founder-formation
  -- experience", never "buying access to members".
  sponsor_thesis      TEXT,
  -- Every packet is traceable to the run that produced it.
  ai_run_id           TEXT,
  -- Set once a packet becomes a real Room.
  event_id            TEXT REFERENCES evt_event (id),
  -- Set when a human decides. A packet nobody decided on stays PROPOSED, visibly.
  decided_by          TEXT,
  decided_at          TEXT,
  decision_note       TEXT,
  firm_scope          TEXT NOT NULL DEFAULT 'west-peek',
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_evt_room_packet_status ON evt_room_packet (status, proposed_for_month);
-- One proposal per month per scope. The monthly job relies on this to stay idempotent under retry.
CREATE UNIQUE INDEX IF NOT EXISTS idx_evt_room_packet_month
  ON evt_room_packet (firm_scope, proposed_for_month, title);

-- Venue options.
--
-- source_url IS NOT NULL AND IS NOT EMPTY. This is the most important constraint in the migration.
--
-- A model asked for a venue's phone number will produce a confident, plausible, wrong one — the
-- same failure that put a fictional company on a market map. Here it is worse, because the failure
-- is discovered by a Managing Partner dialling a dead line, and a packet whose first phone number
-- is wrong is a packet nobody opens again.
--
-- So: no source, no row. And what survives is UNVERIFIED until a person has actually called.
CREATE TABLE IF NOT EXISTS evt_packet_venue (
  id             TEXT PRIMARY KEY,
  packet_id      TEXT NOT NULL REFERENCES evt_room_packet (id),
  name           TEXT NOT NULL,
  city           TEXT,
  address        TEXT,
  capacity       INTEGER,
  -- A range, because venue pricing is a range until someone calls. Held as numbers for the
  -- economics and as prose for what the range actually covers.
  price_low_usd  REAL,
  price_high_usd REAL,
  price_note     TEXT,
  booking_phone  TEXT,
  booking_email  TEXT,
  booking_url    TEXT,
  source_url     TEXT NOT NULL CHECK (length(trim(source_url)) > 8),
  verification   TEXT NOT NULL DEFAULT 'UNVERIFIED'
                 CHECK (verification IN ('UNVERIFIED','CONFIRMED','WRONG','UNREACHABLE')),
  verified_by    TEXT,
  verified_at    TEXT,
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_evt_packet_venue_packet ON evt_packet_venue (packet_id);

-- ── Sponsors ─────────────────────────────────────────────────────────────────
--
-- Rooms are the primary monetization layer, so sponsors are a pipeline: prospect, tier, ask, stage,
-- close. Wynn works it.
--
-- Note what is NOT here: any join from a sponsor to an attendee. There is no table that would let
-- someone assemble "which members did this sponsor's money buy access to", because that question
-- has no legitimate answer. See src/shared/community/sponsorPolicy.ts.
CREATE TABLE IF NOT EXISTS evt_sponsor_prospect (
  id              TEXT PRIMARY KEY,
  org_name        TEXT NOT NULL,
  -- One presenting, one supporting, one in-kind. "Do not start with six logos."
  tier            TEXT NOT NULL DEFAULT 'SUPPORTING'
                  CHECK (tier IN ('PRESENTING','SUPPORTING','IN_KIND')),
  -- Ramp and Brex do not go in the same Room. Category is how that is caught rather than
  -- remembered — enforced in the service, since it depends on the event.
  category        TEXT NOT NULL DEFAULT 'OTHER'
                  CHECK (category IN ('CLOUD','FINTECH_SPEND','EQUITY_CAPTABLE','LEGAL','PAYROLL_HR','BANKING','HOSPITALITY','RECRUITING','OTHER')),
  ask_low_usd     REAL,
  ask_high_usd    REAL,
  -- The one-line pitch. "Own the moment between idea and first product."
  pitch           TEXT,
  -- What we are asking for beyond money: credits, a specialist in the room, office hours.
  ask_detail      TEXT,
  stage           TEXT NOT NULL DEFAULT 'IDENTIFIED'
                  CHECK (stage IN ('IDENTIFIED','RESEARCHING','DRAFTED','SENT','IN_CONVERSATION','COMMITTED','DECLINED','PARKED')),
  packet_id       TEXT REFERENCES evt_room_packet (id),
  event_id        TEXT REFERENCES evt_event (id),
  -- A sponsor's own staff are business contacts, not members. This is not member data.
  contact_name    TEXT,
  contact_email   TEXT,
  contact_url     TEXT,
  source_url      TEXT,
  committed_usd   REAL,
  decline_reason  TEXT,
  note            TEXT,
  owner_employee  TEXT NOT NULL DEFAULT 'Wynn',
  firm_scope      TEXT NOT NULL DEFAULT 'west-peek',
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_evt_sponsor_stage ON evt_sponsor_prospect (stage, tier);
CREATE INDEX IF NOT EXISTS idx_evt_sponsor_event ON evt_sponsor_prospect (event_id);

-- ── Community acts ───────────────────────────────────────────────────────────
--
-- What West Peek witnessed a member do. Only that: a member promising another member an
-- introduction is between those two members, and the OS does not watch conversations West Peek is
-- not part of.
--
-- `source` exists from day one although only three of its four values are reachable. Where the
-- continuous community eventually lives is undecided and may be a white-labelled platform; when it
-- arrives, an act from it is this row with a different source. Adding the column later would mean
-- backfilling every existing row with a guess.
CREATE TABLE IF NOT EXISTS com_act (
  id            TEXT PRIMARY KEY,
  person_id     TEXT NOT NULL REFERENCES person (id),
  kind          TEXT NOT NULL
                CHECK (kind IN ('ATTENDED','HOSTED','SPOKE','ASKED_QUESTION','ANSWERED_QUESTION',
                                'MADE_INTRODUCTION','REFERRED_MEMBER','BROUGHT_GUEST',
                                'KEPT_COMMITMENT','MISSED_COMMITMENT')),
  source        TEXT NOT NULL DEFAULT 'PARTNER_ENTRY'
                CHECK (source IN ('PARTNER_ENTRY','EVENT_CLOSEOUT','MASTERMIND','PLATFORM')),
  occurred_at   TEXT NOT NULL,
  event_id      TEXT REFERENCES evt_event (id),
  note          TEXT,
  -- Retraction rather than deletion. Evidence that can be quietly edited is not evidence, but a
  -- mis-keyed act is a real thing that happens and has to be correctable.
  retracted_at  TEXT,
  retracted_by  TEXT,
  retraction_reason TEXT,
  recorded_by   TEXT NOT NULL,
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_com_act_person ON com_act (person_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_com_act_event ON com_act (event_id);

-- Substantively append-only (D15). The note and the retraction fields may be updated; who did what
-- and when may not. Rewriting a member's history is exactly the failure this guards.
CREATE TRIGGER IF NOT EXISTS com_act_substance_immutable
BEFORE UPDATE ON com_act
FOR EACH ROW
WHEN OLD.person_id <> NEW.person_id
  OR OLD.kind <> NEW.kind
  OR OLD.occurred_at <> NEW.occurred_at
  OR IFNULL(OLD.event_id,'') <> IFNULL(NEW.event_id,'')
  OR OLD.source <> NEW.source
BEGIN
  SELECT RAISE(ABORT, 'com_act substance is append-only (D15): retract the act and record a new one');
END;

CREATE TRIGGER IF NOT EXISTS com_act_reject_delete
BEFORE DELETE ON com_act
BEGIN
  SELECT RAISE(ABORT, 'com_act is append-only (D15): retract rather than DELETE');
END;

-- ── The Council ──────────────────────────────────────────────────────────────
--
-- A log rather than a flag, so "when did they join and who decided" survives. Current membership is
-- the most recent decision for a person.
--
-- A reason is NOT NULL because an unexplained Council flag cannot be reviewed a year later, and the
-- Council is the part of the model where judgement most needs to be legible.
CREATE TABLE IF NOT EXISTS com_council_decision (
  id           TEXT PRIMARY KEY,
  person_id    TEXT NOT NULL REFERENCES person (id),
  in_council   INTEGER NOT NULL CHECK (in_council IN (0,1)),
  reason       TEXT NOT NULL CHECK (length(trim(reason)) >= 10),
  decided_by   TEXT NOT NULL,
  decided_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  firm_scope   TEXT NOT NULL DEFAULT 'west-peek'
);

CREATE INDEX IF NOT EXISTS idx_com_council_person ON com_council_decision (person_id, decided_at);

CREATE TRIGGER IF NOT EXISTS com_council_decision_reject_update
BEFORE UPDATE ON com_council_decision
BEGIN
  SELECT RAISE(ABORT, 'com_council_decision is append-only (D15): record a new decision');
END;

-- ── Introductions West Peek proposes ─────────────────────────────────────────
--
-- "Relationship OS algorithmically matches people who should meet, sporadically — but it is not a
-- full-time job" (operator, 17 Aug 2026).
--
-- Tuned for precision, not recall. An introduction spends West Peek's reputation, and a weekly
-- stream of mediocre suggestions is how this feature dies and takes credibility with it.
--
-- `strength` ranks PAIRS, never people. It exists so three good suggestions can be chosen over
-- forty plausible ones, and it is deliberately not stored against a person — see the note at the
-- top about scores.
CREATE TABLE IF NOT EXISTS rel_match_suggestion (
  id                TEXT PRIMARY KEY,
  person_a_id       TEXT NOT NULL REFERENCES person (id),
  person_b_id       TEXT NOT NULL REFERENCES person (id),
  -- Why these two, in a sentence a partner could paste into an email without editing.
  rationale         TEXT NOT NULL,
  -- The complementarity: what A needs, what B has done. Profile similarity produces garbage —
  -- two people in fintech have nothing to say to each other.
  need_signal       TEXT,
  experience_signal TEXT,
  strength          REAL NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'PROPOSED'
                    CHECK (status IN ('PROPOSED','DISMISSED','CONSENT_PENDING','CONSENTED','CONNECTED','EXPIRED')),
  -- Double opt-in. A cold connection made in West Peek's name that either side resents costs more
  -- than the introduction was worth.
  consent_a         INTEGER NOT NULL DEFAULT 0 CHECK (consent_a IN (0,1)),
  consent_b         INTEGER NOT NULL DEFAULT 0 CHECK (consent_b IN (0,1)),
  -- Proposed by a machine, sent by a person. Always.
  approved_by       TEXT,
  approved_at       TEXT,
  dismissed_reason  TEXT,
  connected_at      TEXT,
  ai_run_id         TEXT,
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- The same pair suggested every month is noise. One live suggestion per pair.
  UNIQUE (person_a_id, person_b_id)
);

CREATE INDEX IF NOT EXISTS idx_rel_match_status ON rel_match_suggestion (status, strength);

-- ── Early inclusion ──────────────────────────────────────────────────────────
--
-- "The output is not engagement. The output is early inclusion."
--
-- That sentence rules out the dashboard this module would otherwise grow — members, attendance,
-- engagement rate. The measurement that actually matches it is provenance: when something enters
-- the investment pipeline, where did the relationship start and how long before the deal existed.
--
-- "We met this founder at the Zero-to-One Room eleven months before they incorporated" is the
-- number that proves the community thesis. It is captured at creation because nobody remembers it
-- later, and if nothing traces back to a Room after eighteen months, that should be visible too.
ALTER TABLE investment_opportunity ADD COLUMN relationship_origin TEXT NOT NULL DEFAULT 'UNRECORDED'
  CHECK (relationship_origin IN ('UNRECORDED','ROOM','MASTERMIND','OFFICE','COUNCIL','COMMUNITY_INTRO',
                                 'PORTFOLIO_REFERRAL','LP_REFERRAL','INBOUND','OUTBOUND','NETWORK','OTHER'));

ALTER TABLE investment_opportunity ADD COLUMN origin_event_id TEXT;

-- When the relationship began — NOT when the deal did. The gap between the two is the whole point.
ALTER TABLE investment_opportunity ADD COLUMN relationship_started_at TEXT;

CREATE INDEX IF NOT EXISTS idx_opportunity_origin ON investment_opportunity (relationship_origin);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0044_rooms_and_community');

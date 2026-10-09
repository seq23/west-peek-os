-- 0255 — Every partner email lands in one right place, and Porter knows who is writing (9 Oct 2026).
--
-- WHAT WENT WRONG (8–9 Oct 2026). Scooter's "Spam on the Ventures form" card was BLOCKED on his preview.
-- His NEW email "New site build: voting.topbarz.xyz/entry" (not a reply) was recorded as the ANSWER to
-- that block: block_answer set, card re-opened, the build queued on the wrong site, and block_nag_at wiped
-- so no reminder would ever have fired. Re-reading the stored email then CANCELLED the spam card as
-- "superseded", and two re-reads two seconds apart made two cards and sent him two "Got it" emails.
--
-- WHAT THIS ADDS
--
--   inbound_clarification — rule 1d. When Porter cannot tell which open card a new email is about, he
--     asks the partner ONCE (UNIQUE message_id: never twice about the same email). The reply routes it;
--     no reply in 24 h → a new card. services/emailRouting.ts.
--
--   inbound_reingest_claim — rule 2. A re-read of a stored message claims it for five minutes, so two
--     re-reads seconds apart produce one card and one "Got it", never two.
--
--   partner_profile / partner_profile_line — rule 4. One short living profile per partner, in D1 and
--     never in the repo (the repo is public): who they are, what they are working on now (dated lines;
--     a line with no activity for 30 days drops off), how they write, what they usually ask for, and
--     "Porter, note: …" lines stored verbatim. Only the partner's own projects: services/partnerProfile.ts
--     runs every line through shared/partners/profileFilter.ts (no LP names, deal terms or fund details),
--     on the way in AND on the way out.
--
--   work_card_blocked_keeps_its_nag — rule 3. A BLOCKED card always has a reminder time. Any write that
--     leaves a BLOCKED card with block_nag_at NULL is repaired in the same statement's wake (24 h out),
--     so "nobody will ever be reminded" cannot be written by any path, present or future.

CREATE TABLE IF NOT EXISTS inbound_clarification (
  id               TEXT PRIMARY KEY,
  message_id       TEXT NOT NULL UNIQUE,
  partner_email    TEXT NOT NULL CHECK (partner_email = lower(partner_email) AND partner_email LIKE '%@%'),
  subject          TEXT,
  eml_key          TEXT,
  -- The message itself when it is small and no stored copy exists (a test, a store outage).
  raw_text         TEXT,
  candidates_json  TEXT NOT NULL DEFAULT '[]',
  asked_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent             INTEGER NOT NULL DEFAULT 0,
  resolved_at      TEXT,
  resolution       TEXT CHECK (resolution IS NULL OR resolution IN ('CARD', 'NEW', 'TIMED_OUT')),
  resolved_card_id TEXT,
  resolved_by      TEXT,
  firm_scope       TEXT NOT NULL DEFAULT 'west-peek'
);
CREATE INDEX IF NOT EXISTS idx_inbound_clarification_open ON inbound_clarification (resolved_at, asked_at);

CREATE TABLE IF NOT EXISTS inbound_reingest_claim (
  -- The stored message's R2 key: one key per message (the store is idempotent by Message-ID).
  object_key TEXT PRIMARY KEY,
  claimed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS partner_profile (
  partner_email TEXT NOT NULL CHECK (partner_email = lower(partner_email) AND partner_email LIKE '%@%'),
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  who           TEXT NOT NULL DEFAULT '',
  writes_like   TEXT NOT NULL DEFAULT '',
  usually_asks  TEXT NOT NULL DEFAULT '',
  -- [{ "host": "voting.topbarz.xyz", "words": ["top barz", "culturecon", "voting"] }] — what the partner
  -- calls a site when he does not write its host. Read by the router.
  aliases_json  TEXT NOT NULL DEFAULT '[]',
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (firm_scope, partner_email)
);

CREATE TABLE IF NOT EXISTS partner_profile_line (
  id             TEXT PRIMARY KEY,
  partner_email  TEXT NOT NULL CHECK (partner_email = lower(partner_email) AND partner_email LIKE '%@%'),
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  kind           TEXT NOT NULL CHECK (kind IN ('WORKING_ON', 'NOTE')),
  body           TEXT NOT NULL CHECK (length(trim(body)) >= 3),
  -- A WORKING_ON line is about one card; its last activity is the card's.
  card_id        TEXT,
  last_active_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_profile_line_card ON partner_profile_line (firm_scope, partner_email, card_id) WHERE card_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_partner_profile_line_partner ON partner_profile_line (firm_scope, partner_email, kind, last_active_at);

CREATE TRIGGER IF NOT EXISTS work_card_blocked_keeps_its_nag_update
AFTER UPDATE ON work_card
WHEN NEW.state = 'BLOCKED' AND NEW.block_nag_at IS NULL
BEGIN
  UPDATE work_card SET block_nag_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','+24 hours') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS work_card_blocked_keeps_its_nag_insert
AFTER INSERT ON work_card
WHEN NEW.state = 'BLOCKED' AND NEW.block_nag_at IS NULL
BEGIN
  UPDATE work_card SET block_nag_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','+24 hours') WHERE id = NEW.id;
END;

-- A no-op in production on 9 Oct 2026 (zero BLOCKED cards without a reminder time, checked); kept so
-- every other database meets the invariant too.
UPDATE work_card SET block_nag_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','+24 hours') WHERE state = 'BLOCKED' AND block_nag_at IS NULL;
INSERT OR IGNORE INTO schema_version (migration) VALUES ('0255_one_email_one_place_and_partner_profiles');

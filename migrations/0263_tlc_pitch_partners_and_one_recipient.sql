-- 0263_tlc_pitch_partners_and_one_recipient.sql — owner rulings, 22 Oct 2026. Additive only.
--
-- 1. Pricing: a TLC deal is a "Partner" ($5,000) or a "Presenting partner" ($15,000). Several per
--    club; no category exclusivity. `tier` is NULL until it is known.
-- 2. Every brand "yes" shows on the Rooms page: `yes_at` is when the brand said yes (a partner
--    moved the deal on, or approved the reply that sends the pitch). The "New yes" badge reads it.
-- 3. The brand pitch has a public, read-only, unguessable address so a brand can open it without a
--    staff login: `pitch_token` (128 random bits, hex). The token IS the credential.
-- 4. A general Room may carry its own sponsor target; with none the panel says "no target set".
-- 5. February 2027's club is Thursday 11 February 2027, an evening (owner's ruling; review M1: the
--    stored 20 Feb fell after the Valentine's Day the pitch depends on). Only that row, only if it
--    still holds the old date. Nothing else about any club, its veto window or its status changes.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0263_tlc_pitch_partners_and_one_recipient');

ALTER TABLE tlc_deal ADD COLUMN tier TEXT CHECK (tier IS NULL OR tier IN ('PARTNER','PRESENTING'));
ALTER TABLE tlc_deal ADD COLUMN yes_at TEXT;
ALTER TABLE tlc_event ADD COLUMN pitch_token TEXT;
UPDATE tlc_event SET pitch_token = lower(hex(randomblob(16))) WHERE pitch_token IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tlc_event_pitch_token ON tlc_event (pitch_token);
ALTER TABLE evt_event ADD COLUMN sponsor_target_usd REAL;

-- 6. After a brand replies yes, ONE email back with the brand pitch PDF and a call link. Like every
--    brand email it waits behind the send gate and a partner's approval; one per deal.
CREATE TABLE tlc_pitch_followup (
  deal_id            TEXT PRIMARY KEY REFERENCES tlc_deal(id),
  subject            TEXT NOT NULL,
  body               TEXT NOT NULL,
  state              TEXT NOT NULL CHECK (state IN ('HELD','AWAITING_APPROVAL','SENT','FAILED')),
  held_reason        TEXT,
  effect_request_id  TEXT,
  approval_card_id   TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at            TEXT
);

UPDATE tlc_event SET event_date = '2027-02-11', slot = 'EVENING' WHERE month = '2027-02' AND event_date = '2027-02-20';

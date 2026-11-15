-- 0306 · EVERY ASK IS HEARD, AND EVERY ASK IS ANSWERED (14 Nov 2026, the "emailing the OS feels like typing to
-- Claude" plan, steps 1 and 7; her ruling is in the west-peek-ventures brain's Settled decisions).
--
-- partner_understood: one row per partner email that opened or steered a card. The row is the claim (a second tick
-- cannot send a second "Got it") and the record of what was sent and how (MODEL, or FALLBACK when no seat answered).
--
-- partner_ask: each thing he asked for in that email, in his own words, in order. The final DONE reply marks every
-- one DONE, IN_PROGRESS or NOT_DONE with a reason; services/partnerUnderstood.ts refuses to send a DONE while any ask
-- on the card has no status.
--
-- Additive: two new tables. Nothing existing is touched.
CREATE TABLE IF NOT EXISTS partner_understood (
  inbound_message_id TEXT PRIMARY KEY REFERENCES inbound_message (id),
  work_card_id       TEXT NOT NULL REFERENCES work_card (id),
  partner_email      TEXT NOT NULL,
  -- CLAIMED while the tick works it; SENT, NOT_SENT (the reason is in detail) or NOTHING_ASKED.
  state              TEXT NOT NULL DEFAULT 'CLAIMED' CHECK (state IN ('CLAIMED', 'SENT', 'NOT_SENT', 'NOTHING_ASKED')),
  via                TEXT CHECK (via IS NULL OR via IN ('MODEL', 'FALLBACK')),
  asks               INTEGER NOT NULL DEFAULT 0,
  detail             TEXT,
  firm_scope         TEXT NOT NULL DEFAULT 'west-peek',
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at            TEXT
);
CREATE INDEX IF NOT EXISTS idx_partner_understood_card ON partner_understood (work_card_id);

CREATE TABLE IF NOT EXISTS partner_ask (
  id                 TEXT PRIMARY KEY,
  work_card_id       TEXT NOT NULL REFERENCES work_card (id),
  inbound_message_id TEXT NOT NULL REFERENCES inbound_message (id),
  seq                INTEGER NOT NULL,
  words              TEXT NOT NULL CHECK (length(trim(words)) >= 2),
  status             TEXT CHECK (status IS NULL OR status IN ('DONE', 'IN_PROGRESS', 'NOT_DONE')),
  why                TEXT,
  marked_at          TEXT,
  firm_scope         TEXT NOT NULL DEFAULT 'west-peek',
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (inbound_message_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_partner_ask_card ON partner_ask (work_card_id);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0306_every_ask_is_heard_and_answered');

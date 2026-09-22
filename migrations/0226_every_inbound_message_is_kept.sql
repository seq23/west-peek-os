-- 0226 — Every inbound message is kept, indexed, and readable (owner, 22 Sep 2026).
--
-- HER WORDS: "the original emails received for the work card or replied should be kept … we need
-- to overhaul this."
--
-- WHAT HAPPENED. On 21 Sep Scooter replied to a hire-search email. The door did not recognise it
-- as a reply, read it as a NEW request, wrote the first 4,000 characters of RAW MIME — `Received:`,
-- `ARC-Seal:`, `DKIM-Signature:` — into the work card's description, and stored no `.eml`. His
-- words are unrecoverable. They were never written anywhere.
--
-- WHY A TABLE AND NOT A BUCKET LISTING. Since PR #150 exactly one door kept a copy
-- (`openAssignmentCard`), and the oversize branch kept another. Nothing recorded WHAT had been
-- kept: recovering a message meant string-matching `'Stored message: '` inside
-- `work_card.description`, which is prose, and prose is not an index. This repo's own Rule 0
-- names that defect — "two components each keeping their own list" — and the list here was
-- "whatever happens to be in R2", readable only by asking R2.
--
--   · ONE ROW PER STORED MESSAGE, written in the same place the `.eml` is written, so the index
--     and the object cannot disagree. A key in the bucket with no row here means the write that
--     was supposed to record it did not run, and that is now a visible fault rather than a
--     silence.
--   · `message_id` IS UNIQUE, which is what makes the store idempotent: a re-read through
--     `POST /api/inbound-email/reingest` finds the row, reuses the key it names, and writes no
--     second copy of the same bytes.
--   · `work_card_id` is filled once a door opens or steers a card, so "show me the email this
--     card came from" is a join rather than a search.
--
-- RETENTION IS NOT DECIDED HERE, and deliberately. Her decision, 22 Sep 2026: the index comes
-- first and retention is decided after it exists. So there is no lifecycle rule on the bucket, no
-- cleanup job, and nothing in this migration deletes anything. See `docs/RECOVERY.md`.

CREATE TABLE IF NOT EXISTS inbound_message (
  id                  TEXT PRIMARY KEY,
  -- The sender's own identity for the message (RFC 5322 §3.6.4), as `inbound_email_seen` records
  -- it. A message that carries none gets `no-message-id:<row id>` so the column can stay NOT NULL
  -- and UNIQUE: an unidentifiable message is honestly unique rather than dishonestly merged.
  message_id          TEXT NOT NULL UNIQUE,
  r2_key              TEXT NOT NULL,
  from_address        TEXT NOT NULL,
  to_address          TEXT,
  subject             TEXT,
  received_at         TEXT NOT NULL,
  bytes               INTEGER NOT NULL DEFAULT 0,
  -- The SPF/DKIM/DMARC verdict as it stood when the message arrived. Kept beside the message
  -- because "was this really from her" is a question asked months later, and re-deriving it from
  -- the stored headers would re-trust headers rather than the resolver.
  mail_authority_json TEXT,
  work_card_id        TEXT REFERENCES work_card (id),
  firm_scope          TEXT NOT NULL DEFAULT 'west-peek',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_inbound_message_card ON inbound_message (work_card_id);
CREATE INDEX IF NOT EXISTS idx_inbound_message_received ON inbound_message (received_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_message_key ON inbound_message (r2_key);

-- ── The messages already in the bucket ────────────────────────────────────────────────────────
--
-- THE ONLY LISTING PATH IS D1, because R2 is not enumerated from a migration. Three places name a
-- stored key today and all three are read: the `Stored message: <key>` line `openAssignmentCard`
-- and the oversize branch append to a card, `request_attachment.eml_key` (0221), and
-- `pending_deck.object_key` when the oversize branch queued the whole `.eml` for reading.
--
-- IDEMPOTENT BY CONSTRUCTION: `INSERT OR IGNORE` against the unique `r2_key` index, so a re-apply
-- adds nothing and a key the live code has since indexed itself is left exactly as it is. Nothing
-- is deleted and nothing in the bucket is touched.
--
-- `bytes` is 0 on a backfilled row because the size was never recorded anywhere — an honest zero,
-- not a guess. `message_id` is derived from the key, which is unique by construction.
INSERT OR IGNORE INTO inbound_message
  (id, message_id, r2_key, from_address, to_address, subject, received_at, bytes, work_card_id, firm_scope)
SELECT
  'inm_bf_' || lower(hex(randomblob(8))),
  'backfilled:' || k.r2_key,
  k.r2_key,
  COALESCE(NULLIF(TRIM(c.requested_by_email), ''), '(unrecorded)'),
  NULL,
  c.title,
  COALESCE(c.created_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  0,
  k.work_card_id,
  'west-peek'
FROM (
  SELECT MIN(work_card_id) AS work_card_id, r2_key
    FROM (
      -- 1 · The `Stored message: <key>` line on a card's description.
      SELECT
        d.card_id AS work_card_id,
        CASE WHEN INSTR(d.tail, char(10)) > 0 THEN SUBSTR(d.tail, 1, INSTR(d.tail, char(10)) - 1) ELSE d.tail END AS r2_key
      FROM (
        SELECT id AS card_id,
               SUBSTR(description, INSTR(description, 'Stored message: ') + 16) AS tail
          FROM work_card
         WHERE description LIKE '%Stored message: inbound-email/%'
      ) d
      UNION ALL
      -- 2 · The message a kept attachment is extracted from (0221).
      SELECT work_card_id, eml_key FROM request_attachment WHERE eml_key LIKE 'inbound-email/%'
      UNION ALL
      -- 3 · The whole `.eml` queued as a deck by the oversize branch.
      SELECT work_card_id, object_key FROM pending_deck WHERE object_key LIKE 'inbound-email/%'
    )
   WHERE r2_key LIKE 'inbound-email/%.eml'
   GROUP BY r2_key
) k
LEFT JOIN work_card c ON c.id = k.work_card_id;

-- ── The action that reads a raw message ───────────────────────────────────────────────────────
--
-- THE P4 CONVENTION. The key is declared once in `src/shared/registry/actionTypes.ts`, emitted
-- into 0003's generated block by `scripts/seed/generate-machine-seed.mjs`, and repeated here as a
-- compensating insert — because rewriting 0003 reaches a FRESH database only, and production
-- applied 0003 long ago.
--
-- RESTRICTED, NOT RESERVED. The decoded body is on the card for whoever may see the card; the RAW
-- message is headers, routing and signatures, and it is a Managing Partner's to read. Restricted
-- is the tier that says so without raising an approval card for every read — `authorize()` returns
-- ALLOW for the role and DENY with the role named for everybody else.
INSERT OR IGNORE INTO action_type (key, name, description, is_reserved, is_external_effect) VALUES
  ('inbound_message.read_raw', 'Read a stored message raw', 'Read the stored `.eml` of an inbound message exactly as it arrived, headers and all.', 0, 0);

INSERT OR IGNORE INTO restricted_action (key, description, allowed_json) VALUES
  ('inbound_message.read_raw',
   'Read a stored inbound message raw. The decoded body is on the card; the headers, routing and signatures are a partner''s.',
   '{"roles":["MANAGING_PARTNER"],"employees":[]}');

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0226_every_inbound_message_is_kept');

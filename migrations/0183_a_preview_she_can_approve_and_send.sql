-- 0183 — "YES, SEND THAT." (17 Sep 2026)
--
-- Operator: "if i approve i'm going to want him to email it to scooter right away — how would i do
-- that?" Until now a deliverable on her Home could be DISMISSED or given FEEDBACK. There was no
-- third answer. The only ways to say yes were to write a second work card, or to forward the thing
-- from her own mailbox — which strips the employee's name off his own work and loses the point of
-- having employees at all.
--
-- Her default rule, in her words:
--
--   "anything to anyone other than sequoia@ and scooter@ should be default preview. everything else
--    does not need to be default preview unless i specifically ask for it"
--
-- Scooter is INSIDE the firm. Walker's Monday hire search still lands in his inbox on Monday with
-- nobody's hand in between. See `src/shared/work/previewLane.ts` for the decision, which asks the
-- partner registry rather than typing either address.
--
-- ─── WHAT THIS TABLE HOLDS ────────────────────────────────────────────────────────────────────
--
-- One row per thing waiting for her yes. It holds the FINISHED MESSAGE — subject, text, html,
-- exactly as the employee composed it — because "Send it" must put his words on the wire unchanged.
-- Re-rendering at send time would be a second composition and a second chance to differ; storing
-- the bytes she approved is the only version of this that can honestly claim his voice.
--
-- ─── THE TOKEN, AND WHY IT IS STRONGER THAN THE PACKET REPLY TOKEN ────────────────────────────
--
-- Earlier today Scooter's STEERING replies were deliberately given no token: the worst a forged
-- steer does is waste a week of one employee's attention, and it is visible in the next note.
--
-- This is the opposite kind of link. A click here SENDS MAIL ON HER BEHALF to somebody outside the
-- firm, in an employee's voice, over the firm's domain. It cannot be unsent, the recipient is a
-- real founder, LP or journalist, and the damage is reputational rather than clerical. Recognising
-- the sender is NOT sufficient for that — a `From` header is an assertion, and the click arrives
-- over HTTP where there is no DKIM to check at all.
--
-- So the link itself is the credential, and it is treated as one:
--
--   · PER PREVIEW.    One token authorises exactly one message to exactly one recipient. There is
--                     no standing "approve" URL to leak.
--   · UNGUESSABLE.    26 characters of a 31-symbol alphabet — about 2^128 — from
--                     `crypto.getRandomValues`. A wrong token matches no row.
--   · STORED HASHED.  `token_sha256` only. A database read, a backup, or a log line yields no
--                     working authorisation. The packet token is stored in the clear because it is
--                     useless without an authenticated partner `From`; this one is not.
--   · SINGLE USE.     `used_at` is set in the same statement that claims the row, so two taps on a
--                     phone cannot send twice.
--   · EXPIRING.       `expires_at`. An approval is only meaningful while the thing it approves is
--                     still the current draft.
--   · UNWILLING TO GUESS. Wrong length, a stray character, a missing row, an expired or spent
--                     token: all refuse. Nothing is fuzzy-matched. See `readApprovalToken`.

CREATE TABLE IF NOT EXISTS preview_approval (
  id                TEXT PRIMARY KEY,

  -- What the work was, and who did it.
  work_card_id      TEXT REFERENCES work_card (id),
  card_kind         TEXT,
  employee          TEXT NOT NULL,          -- roster name; signs the message
  what              TEXT NOT NULL,          -- in words, for her Home and the preview subject

  -- THE MESSAGE, BYTE FOR BYTE. Sent unchanged when she says yes.
  subject           TEXT NOT NULL,
  body_text         TEXT NOT NULL,
  body_html         TEXT,

  -- WHO IT IS FOR. Proposed by the employee; she may change it before sending, which is why this
  -- column is updated rather than being a second row. `recipient_set_by` says whether the address
  -- on it is still the employee's proposal or her override — "send it" is never ambiguous.
  recipient         TEXT NOT NULL,
  recipient_set_by  TEXT NOT NULL DEFAULT 'EMPLOYEE'
                    CHECK (recipient_set_by IN ('EMPLOYEE','PARTNER')),
  -- The address the employee originally proposed, kept even after an override so the trail shows
  -- what he asked for and what she changed it to.
  proposed_recipient TEXT NOT NULL,

  -- Why this is in the lane at all: 'DEFAULT_OUTSIDE_FIRM' (her rule) or 'ASKED_FOR' (she marked
  -- the card preview-first even though the recipient is a partner).
  lane_reason       TEXT NOT NULL
                    CHECK (lane_reason IN ('DEFAULT_OUTSIDE_FIRM','ASKED_FOR')),

  state             TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (state IN ('PENDING','SENT','RETURNED','DISMISSED')),

  -- The credential. Hash only; the plaintext exists in her inbox and nowhere else.
  token_sha256      TEXT NOT NULL UNIQUE,
  expires_at        TEXT NOT NULL,
  used_at           TEXT,

  -- The decision.
  decided_by        TEXT REFERENCES firm_user (id),
  decided_at        TEXT,
  decided_via       TEXT CHECK (decided_via IN ('HOME','EMAIL')),
  -- Her words when she sends it back, carried to the employee so he can redo it.
  note              TEXT,
  -- What the transport said, when it was sent.
  send_detail       TEXT,
  provider_message_id TEXT,

  -- Her Home copy, so the preview is filed as well as emailed.
  deliverable_id    TEXT REFERENCES deliverable (id),

  privacy_label     TEXT NOT NULL DEFAULT 'INTERNAL',
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_preview_approval_state
  ON preview_approval (state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_preview_approval_card
  ON preview_approval (work_card_id);

-- ── THE LANE ON A CARD ────────────────────────────────────────────────────────────────────────
--
-- "Preview" meant two different things before today: the mechanism behind the scheduled-job
-- "Preview it to me" button, enforced at the send boundary and unable to escape; and PROSE IN A
-- WORK CARD that an employee was expected to interpret. One is a guarantee, the other is a hope.
-- This column is the guarantee — a flag the send path reads, not a sentence a model reads.
--
-- NULL is not "no". NULL means "nobody said", and the DEFAULT RULE then decides from the
-- recipient: a partner sends, anybody else previews. `preview_first = 1` is her asking for one on
-- something that would otherwise have gone straight out.
ALTER TABLE work_card ADD COLUMN preview_first INTEGER CHECK (preview_first IN (0, 1));

-- Who the card's result is for, when the card knows. An address, resolved by the composer.
ALTER TABLE work_card ADD COLUMN result_recipient TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0183_a_preview_she_can_approve_and_send');

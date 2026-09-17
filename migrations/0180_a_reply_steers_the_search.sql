-- 0180 · A REPLY STEERS THE SEARCH (17 Sep 2026)
--
-- Operator, on Walker's weekly hire note: "i really dont think we should give him extra work if he
-- likes one he will reach out with the sample draft intro language walker creates." The two buttons
-- Scooter was asked to press are gone (see services/productionsHire.ts). What replaces them is the
-- thing he was always going to do anyway — hit reply and type a sentence.
--
-- Two tables, for the two halves of making that work.
--
-- ── 1 · email_thread — WHICH CONVERSATION A REPLY BELONGS TO ─────────────────────────────────────
--
-- The reasoning is in full in `src/shared/email/thread.ts`. In short:
--
--   · A SUBJECT CODE IS REFUSED. A subject is RFC 2047 encoded the moment it carries an em-dash or
--     an accent, and this repo has already lost a live trigger to exactly that.
--
--   · `provider_message_id` CANNOT BE MATCHED ON, and this is the finding that decided the design
--     rather than an opinion. Resend's POST response `id` is a bare UUID; the RFC 5322 Message-ID
--     the delivered mail carries is a different value, issued by Amazon SES, and SES overrides any
--     Message-ID a caller supplies — so it is not knowable when we send. Cloudflare returns a
--     `messageId` documented only as identifying the mail in its own logs, and refuses
--     `E_HEADER_NOT_ALLOWED` to anybody trying to set a Message-ID. Matching `In-Reply-To` against
--     the stored provider id would therefore never match, silently, and look exactly like working
--     software.
--
--   · SO THE KEY IS OURS AND IT TRAVELS IN `References`, which both transports explicitly allow us
--     to set. Every client builds a reply's `References` from the original's `References` plus the
--     original's `Message-ID`, so a token we put there comes back whatever the provider did.
--
-- The provider's own id is still recorded, because a receipt should say what the transport called
-- the message. It is evidence, never a key.
--
-- NO TOKEN OF THE PACKET KIND, DELIBERATELY. `evt_packet_decision_token` is unguessable,
-- single-use and expiring because a forged reply carrying it would commit the firm to a date and a
-- budget. A thread token is an ADDRESS, not a permission: it says which conversation a reply is
-- about and grants nothing. Steering a search is not destructive — the worst a forged reply can do
-- is waste a week of a search nobody has to act on — so the bar is the one the mailbox already
-- applies to everything else: the sender authenticated, and is one of the two partners.

CREATE TABLE IF NOT EXISTS email_thread (
  -- `wpt_` and 32 hex. Not a secret and not a capability; see the note above.
  token               TEXT PRIMARY KEY,
  -- What the conversation is about. A reply lands back on this.
  object_type         TEXT NOT NULL,
  object_id           TEXT NOT NULL,
  -- The card kind, when the object is a work card, so a reply can steer the KIND of work rather
  -- than only the one card — a weekly duty opens a new card every week, and a reply to last week's
  -- note is about the search, not about a card that is already closed.
  card_kind           TEXT,
  employee            TEXT,
  -- Who it was addressed to BEFORE any preview redirect. A preview's thread is still the real
  -- conversation, and a reply to one steers the real work — which is correct, and why this column
  -- records the intended recipient rather than the delivered one.
  to_address          TEXT NOT NULL,
  subject             TEXT NOT NULL,
  -- Evidence, never a key. See above.
  provider_message_id TEXT,
  provider            TEXT,
  firm_scope          TEXT NOT NULL DEFAULT 'west-peek',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_email_thread_object ON email_thread (object_type, object_id);
CREATE INDEX IF NOT EXISTS idx_email_thread_kind ON email_thread (card_kind, created_at);

-- ── 2 · work_steer — WHAT A PARTNER SAID, CARRIED TO THE NEXT RUN ───────────────────────────────
--
-- WHY A `work_card_note` IS NOT ENOUGH, and this is the part that would have been a silent failure.
--
-- `steerFor` reads notes on the card it is given. Walker's hire search opens a NEW card every week
-- (`Walker: West Peek Productions hire search (2026-W39)`), and by the time Scooter replies, that
-- week's card is DONE. A note filed on it would be read by nothing, ever: next Monday's card is a
-- different row with no notes on it. The reply would have been stored, acknowledged, and had no
-- effect on a single search — which is precisely the defect `shared/work/instruction.ts` was written
-- to remove, reappearing one level up.
--
-- So a reply that steers a RECURRING duty is stored against the KIND of work, and every run of that
-- kind reads it as `SteerRequest.extra` before its first stage. "stop showing me agency people, I
-- want independents" then applies next week and the week after, which is plainly what it means.
--
-- NOT CONSUMED, NOT EXPIRING. A standing instruction that quietly stopped applying after one run
-- would be worse than none: he would have no way to tell the difference between "Walker forgot" and
-- "Walker disagreed". The newest entries win where two conflict, which is what the interpretation
-- prompt already asks the model to do with a later instruction.
--
-- A NOTE IS STILL FILED ON THE CARD when there is a live one, because the thread on that card is
-- where a person looks for what was said. This table is what makes it outlive the card.

CREATE TABLE IF NOT EXISTS work_steer (
  id          TEXT PRIMARY KEY,
  -- The work this steers. A card kind ('PRODUCTIONS_HIRE_SEARCH'), so it outlives any one card.
  card_kind   TEXT NOT NULL,
  -- The card the reply arrived against, for the trail. Null once that card is long gone.
  from_card_id TEXT,
  -- The partner. Only a partner can steer: the sender authenticated and is on the two-address list.
  said_by     TEXT NOT NULL,
  -- What they WROTE — never what their mail client quoted back. See shared/intake/replyBody.ts.
  body        TEXT NOT NULL,
  -- The thread it came in on, so the trail can be walked in both directions.
  thread_token TEXT,
  firm_scope  TEXT NOT NULL DEFAULT 'west-peek',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_work_steer_kind ON work_steer (card_kind, firm_scope, created_at);

-- AN EMPTY STEER IS NOT A STEER. A reply whose written part is only a signature would otherwise
-- store a blank instruction, which the interpreter would then have to make sense of.
CREATE TRIGGER IF NOT EXISTS work_steer_has_words
BEFORE INSERT ON work_steer
FOR EACH ROW WHEN length(trim(NEW.body)) < 2
BEGIN
  SELECT RAISE(ABORT, 'a work_steer must carry what the partner actually wrote');
END;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0180_a_reply_steers_the_search');

-- 0221 — Porter reads the email (owner, 21 Sep 2026; the first real run).
--
-- WHAT HAPPENED. Scooter's first request reached Porter as 6,000 characters of `Received:` and
-- DKIM headers — the door stored the raw MIME message as "what was asked", and the words were cut
-- off before they began. His second email ("the photo is attached", 3.9 MB) took the oversize
-- path, became "Deck: Sensori …", failed to read as a deck, and never reached Porter at all. And
-- nobody told him anything: the only emails the lane sends are DONE and BLOCKED.
--
-- Her words: "porter should be able to read an email and understand what he needs to do from the
-- email. the email says 'the photo is attached'." The PARTNER'S WRITTEN REQUEST is the
-- specification; attachments, Drive folders and links are assets it references.
--
-- THREE THINGS, each a row rather than a promise:
--   1 · `request_attachment` — every image/PDF a partner attached, kept by name against the card
--       with the stored `.eml` it lives in (the intake already keeps oversize messages in R2; a
--       small message with a file is now kept the same way). The Mac lane fetches each by name
--       through a Worker route and lists them under ATTACHMENTS: in Porter's job context.
--   2 · `web_property_change.request_text` — the readable request, the partner's own words with
--       quoted replies stripped, handed to Porter verbatim under REQUEST:. A Drive folder is
--       OPTIONAL: "change the tagline to X" is a whole request.
--   3 · `work_card_notice` — what the partner has been told about this card and when. Her final
--       decision (21 Sep): over its life a request gets at most RECEIVED ("got it — I'm on it",
--       at intake), PLAN / PREVIEW / QUESTION (as built), STUCK (only when the work genuinely
--       cannot proceed without a person, or has sat idle past the ceiling — 45 min inside
--       06–22 CT; a run returned and re-claimed inside the ceiling sends nothing), and DONE with
--       the proof. UNIQUE on (card, kind, cause), so each is sent at most once per cause
--       whatever the sweep does.

CREATE TABLE IF NOT EXISTS request_attachment (
  id            TEXT PRIMARY KEY,
  work_card_id  TEXT NOT NULL REFERENCES work_card (id),
  filename      TEXT NOT NULL CHECK (length(trim(filename)) >= 1),
  media_type    TEXT NOT NULL,
  bytes         INTEGER NOT NULL DEFAULT 0,
  -- The stored message it is extracted from, on demand. Never the bytes themselves in D1.
  eml_key       TEXT NOT NULL,
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_request_attachment_card ON request_attachment (work_card_id, created_at);

ALTER TABLE web_property_change ADD COLUMN request_text TEXT;

CREATE TABLE IF NOT EXISTS work_card_notice (
  id            TEXT PRIMARY KEY,
  work_card_id  TEXT NOT NULL REFERENCES work_card (id),
  kind          TEXT NOT NULL CHECK (kind IN ('RECEIVED', 'PLAN', 'PREVIEW', 'QUESTION', 'STUCK', 'DONE')),
  -- What this notice was about: '' for RECEIVED/DONE, the plan's filing time, the green time,
  -- the question's text, the run id or block reason for STUCK.
  cause         TEXT NOT NULL DEFAULT '',
  sent_to       TEXT NOT NULL,
  -- Our own thread token (the References header a reply carries back) — the id a person can find.
  message_id    TEXT,
  sent          INTEGER NOT NULL DEFAULT 1 CHECK (sent IN (0, 1)),
  detail        TEXT,
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  sent_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (work_card_id, kind, cause)
);

INSERT OR IGNORE INTO work_kind_rule (kind, rule_key, label, value, editable, note, set_by) VALUES
  ('WEB_PROPERTY_CHANGE', 'stuck_after_minutes', 'Say "stuck" after (minutes idle)', '45', 1,
   'A phase queued for the Mac and unclaimed this long, inside the window below, emails the partner ONE "I''m stuck" with what happens next. Her decision, 21 Sep 2026.', 'fu_sequoia_taylor'),
  ('WEB_PROPERTY_CHANGE', 'stuck_window_ct', 'Hours (Central) when "stuck" may be sent', '06-22', 1,
   'Outside these hours a sleeping Mac is ordinary; nothing is emailed until the window opens.', 'fu_sequoia_taylor');

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0221_porter_reads_the_email');

-- 0276 — The LP deck is finished as a PREVIEW first, and a PDF only on "approved" (26 Oct 2026).
--
-- Owner's design: stop producing a PDF deck version per change. When the fund records change, or a
-- partner asks for a change, Preston builds a DECK PREVIEW — a web page inside the OS, behind partner
-- sign-in, every slide as a page with a short "what changed" note at the top. ONE email per round to
-- both partners. Either replies with changes in plain words; Preston applies them to the SAME preview
-- and replies on the thread with what changed. On "approved" from a partner, Preston builds the final
-- PDF deck version — the last step, recorded in deck_version like every deck before it.
--
-- THE SLIDES ARE DATA IN THIS TABLE, never in the public repository: the preview carries pipeline
-- companies, founders' quotes and team photos that do not belong in git. Pictures are files in R2
-- under `deck-assets/`, named in `deck_asset`; a slide names a picture, the renderer fetches it.

CREATE TABLE IF NOT EXISTS deck_preview (
  id                    TEXT PRIMARY KEY,
  fund_id               TEXT NOT NULL,
  -- A round runs from the first build to the final PDF. One email starts it; replies continue it.
  round_no              INTEGER NOT NULL,
  -- OPEN: being reviewed (emailed or held). APPROVED: a partner said approved, PDF being built.
  -- FINAL: the PDF deck version exists. SUPERSEDED: closed without a PDF (never deleted).
  state                 TEXT NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'APPROVED', 'FINAL', 'SUPERSEDED')),
  -- The deck itself: the same Slide[] shape the renderer draws (src/shared/deck/definition.ts).
  slides_json           TEXT NOT NULL,
  -- The note at the top of the page: what changed in this round, newest last.
  what_changed_json     TEXT NOT NULL DEFAULT '[]',
  -- Why this round exists, in words.
  reason                TEXT,
  -- 1 = do not email yet; a partner releases it from the preview page. The first preview is held
  -- for Sequoia's own look before Scooter sees anything (26 Oct 2026); later rounds are not.
  hold                  INTEGER NOT NULL DEFAULT 0 CHECK (hold IN (0, 1)),
  -- The round's one email. Set once; the send is refused when it is already set.
  sent_at               TEXT,
  sent_to               TEXT,
  thread_token          TEXT,
  -- One line: what was carried over from the earlier decks (shown under the note).
  kept_note             TEXT,
  -- The fund-record versions the preview's figures were read against, to spot the records moving.
  policy_versions_json  TEXT NOT NULL DEFAULT '{}',
  approved_by           TEXT,
  approved_at           TEXT,
  final_deck_version_id TEXT,
  final_note            TEXT,
  firm_scope            TEXT NOT NULL DEFAULT 'west-peek',
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ONE open round per fund: a second open preview is two documents competing to be "the deck".
CREATE UNIQUE INDEX IF NOT EXISTS idx_deck_preview_one_open
  ON deck_preview (fund_id) WHERE state IN ('OPEN', 'APPROVED');

-- Every change to a preview, and every partner request, in order. A request is recorded the moment
-- the reply arrives (PENDING) and applied by the diagnostics sweep with its own budget, so a reply
-- never waits on a model inside the email handler.
CREATE TABLE IF NOT EXISTS deck_preview_change (
  id            TEXT PRIMARY KEY,
  preview_id    TEXT NOT NULL REFERENCES deck_preview(id),
  kind          TEXT NOT NULL CHECK (kind IN ('BUILT', 'RECORDS', 'REQUEST', 'APPROVAL', 'FINAL')),
  state         TEXT NOT NULL DEFAULT 'DONE' CHECK (state IN ('PENDING', 'DONE', 'REFUSED')),
  by_whom       TEXT,
  said          TEXT,
  applied       TEXT,
  replied_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_deck_preview_change_pending ON deck_preview_change (state, created_at);

-- The deck's pictures: name → R2 object. Kept so a slide can only name a picture that exists.
CREATE TABLE IF NOT EXISTS deck_asset (
  name          TEXT PRIMARY KEY,
  r2_key        TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  -- Where it came from: "deck v15 p7", "partner upload", …
  source        TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0276_deck_preview_first');

-- A partner can talk to whoever runs the page they are standing on.
--
-- Operator, item 14: an AI chat panel on every page, top right. Item 8 put a named host on 17 pages
-- with their picture and their machines; this is the half that lets you ask them something.
--
-- WHY A FOURTH TURN TABLE, WHICH NEEDS DEFENDING. Three already exist — `meeting_chat_turn`,
-- `university_turn`, `research_turn` — and 0110 argued against adding one. That argument was about
-- reusing a table whose SCOPE was wrong: `meeting_chat_turn` requires a meeting and its seated
-- employees, and generalising it would have meant changing the thing that governs who may speak in
-- a room with founders in it. The same objection applies here, to all three: a page is not a
-- meeting, a course session or a research project, and hanging a page thread off any of them would
-- mean inventing a fake parent row for every conversation. The scope really is new.
--
-- WHAT IS DELIBERATELY NOT NEW: the shape. Same three roles, same OK/FAILED/REFUSED states, same
-- rule that a provider failure is a VISIBLE turn rather than a swallowed error. Four tables that
-- behave identically are maintainable; four that each invented their own error handling are not.
--
-- ONE THREAD PER PARTNER PER PAGE, and that is a decision rather than an omission. Two partners
-- typing into one page thread is a ROOM — it needs presence, ordering across two clients and the
-- Durable Object machinery AGENTS.md forbids without cause. A 1:1 with the host needs none of that.
-- Sequoia asking Preston about the LP page does not appear in Scooter's panel, which is also the
-- honest reading: he did not hear it.
--
-- KEYED BY NAV KEY, not by a page id, because pages are not rows. The nav key is already the
-- identifier `pageHosts.ts` and `pagePurpose.ts` are keyed by, and a test reads the real nav out of
-- App.tsx so a key cannot drift without failing. No foreign key is possible or wanted.
CREATE TABLE IF NOT EXISTS page_turn (
  id            TEXT PRIMARY KEY,
  nav_key       TEXT NOT NULL,
  firm_user_id  TEXT NOT NULL REFERENCES firm_user (id),
  turn_no       INTEGER NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('PARTNER','HOST','SYSTEM')),
  body          TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'OK' CHECK (state IN ('OK','FAILED','REFUSED')),
  detail        TEXT,
  ai_run_id     TEXT REFERENCES ai_run (id),
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (nav_key, firm_user_id, turn_no)
);

CREATE INDEX IF NOT EXISTS idx_page_turn ON page_turn (nav_key, firm_user_id, turn_no);

-- OR IGNORE here and NOWHERE else in this file: the version marker is the one row where a
-- re-apply is genuinely a no-op rather than a swallowed failure.
INSERT OR IGNORE INTO schema_version (migration) VALUES ('0123_every_page_has_a_1_1');

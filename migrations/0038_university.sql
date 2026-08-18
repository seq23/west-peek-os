-- 0038_university.sql — P45: West Peek University.
--
-- Deliberately two tables and no more. The brief is explicit: no curriculum database, no lesson
-- catalogue, no mastery engine, no topic graph. The teaching engine is a system prompt; what needs
-- storing is only enough that a learner can leave the page and come back to the same conversation.
--
-- WHY NO LESSON TABLE. The whole point is that any venture topic works — "liquidation preferences"
-- and "health tech reimbursement" and something nobody has thought of yet. A lesson catalogue would
-- cap the product at whatever was seeded, which is the failure the brief spends a paragraph ruling
-- out.
--
-- PRIVACY: a session belongs to one learner. Someone working through what they do not yet
-- understand is doing something private, and the service filters every read by firm_user_id — a
-- partner should not be able to browse what the other partner has been studying.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0038_university');

CREATE TABLE IF NOT EXISTS university_session (
  id            TEXT PRIMARY KEY,
  firm_user_id  TEXT NOT NULL REFERENCES firm_user (id),
  topic         TEXT NOT NULL,
  mode          TEXT NOT NULL DEFAULT 'LEARN'
                CHECK (mode IN ('LEARN','EXPLAIN_SIMPLY','TEST_ME','TEACH_BACK','REAL_SCENARIO','ONE_PAGER')),
  status        TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_university_session_user ON university_session (firm_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS university_turn (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES university_session (id),
  turn_no       INTEGER NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('LEARNER','INSTRUCTOR','SYSTEM')),
  body          TEXT NOT NULL,
  -- FAILED and REFUSED are visible turns, not swallowed errors: the brief requires that a provider
  -- failure never loses the conversation, and the honest way to do that is to show it happened.
  state         TEXT NOT NULL DEFAULT 'OK' CHECK (state IN ('OK','FAILED','REFUSED')),
  detail        TEXT,
  ai_run_id     TEXT REFERENCES ai_run (id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (session_id, turn_no)
);

CREATE INDEX IF NOT EXISTS idx_university_turn ON university_turn (session_id, turn_no);

-- The optional diary from the brief. Kept because it is three columns and genuinely useful: the
-- thing a learner wants to keep is usually one sentence, and without somewhere to put it that
-- sentence is lost when the session scrolls away.
CREATE TABLE IF NOT EXISTS university_diary (
  id            TEXT PRIMARY KEY,
  firm_user_id  TEXT NOT NULL REFERENCES firm_user (id),
  session_id    TEXT REFERENCES university_session (id),
  topic         TEXT NOT NULL,
  text          TEXT NOT NULL,
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_university_diary_user ON university_diary (firm_user_id, created_at DESC);

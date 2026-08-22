-- Research is a conversation with the analyst, not a form with two buttons.
--
-- Operator, item 18 and again on 21 Aug 2026: "i dont see the chat 1:1 for research", and — asked
-- whether the buttons started one — "this is confusing." They were right to be. The page had two
-- one-shot calls: one returned a list of proposed questions, the other produced a packet. Neither
-- was a conversation, and calling the page "a guided conversation" while it held neither was the
-- kind of gap between what a surface claims and what it does that this whole review exists to close.
--
-- MODELLED ON UNIVERSITY, which already has a working 1:1 — the same turn table, the same rule that
-- a failed or refused turn is VISIBLE rather than swallowed. Two chat implementations would drift,
-- and the second one would be the one nobody maintained.
--
-- WHY NOT REUSE THE MEETING CHAT. `askLiveHelp` requires a meeting and its seated employees; a
-- research 1:1 has neither. Generalising it would have meant changing the thing that governs who may
-- speak in a room with founders in it, which is not a change to make in passing.
--
-- THE THREAD BELONGS TO THE PROJECT so the questions asked along the way sit with the findings they
-- produced. A chat kept somewhere else is a conversation nobody can find when they read the packet.

CREATE TABLE IF NOT EXISTS research_turn (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES research_project (id),
  turn_no     INTEGER NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('PARTNER','ANALYST','SYSTEM')),
  body        TEXT NOT NULL,
  -- A provider failure must never lose the conversation, and the honest way is to show it happened.
  state       TEXT NOT NULL DEFAULT 'OK' CHECK (state IN ('OK','FAILED','REFUSED')),
  detail      TEXT,
  ai_run_id   TEXT REFERENCES ai_run (id),
  firm_scope  TEXT NOT NULL DEFAULT 'west-peek',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, turn_no)
);

CREATE INDEX IF NOT EXISTS idx_research_turn_project ON research_turn (project_id, turn_no);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0110_research_is_a_conversation');

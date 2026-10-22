-- 0261_tlc_ideas.sql — every Learning Club topic idea, with who it came from and where it stands.
--
-- Owner, 22 Oct 2026: "I want all room ideas i sent to be captured somewhere in the rooms tab".
-- A partner's idea is NEVER deleted or hidden: a partner may mark it DROPPED, and it stays listed.
-- Until a partner drops it, Parker must make it a pick or list it in the alternatives (enforced in
-- src/shared/tlc/learningClub.ts `topicsEmailProblems`, guarded by tests/tlcIdeas.test.ts).
--
-- origin: OWNER_IDEA (a partner sent it), BRANDS_SPENDING (reverse-engineered from a brand that is
-- clearly buying right now), TREND (what people are searching for and curious about).
-- Brand names live in rows, never in this public repository.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0261_tlc_ideas');

CREATE TABLE tlc_idea (
  id              TEXT PRIMARY KEY,
  topic           TEXT NOT NULL,
  topic_key       TEXT NOT NULL,
  note            TEXT,
  origin          TEXT NOT NULL CHECK (origin IN ('OWNER_IDEA','BRANDS_SPENDING','TREND')),
  suggested_by    TEXT NOT NULL,
  suggested_at    TEXT NOT NULL,
  source_ref      TEXT,
  preferred_month TEXT,
  status          TEXT NOT NULL DEFAULT 'LATER' CHECK (status IN ('LATER','PICKED','ALTERNATIVE','DROPPED')),
  status_month    TEXT,
  status_card_id  TEXT,
  dropped_by      TEXT,
  dropped_at      TEXT,
  firm_scope      TEXT NOT NULL DEFAULT 'west-peek',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (firm_scope, topic_key)
);

-- NEVER DELETED. A partner's idea leaves the list only by being shown as DROPPED.
CREATE TRIGGER tlc_idea_never_deleted BEFORE DELETE ON tlc_idea
BEGIN
  SELECT RAISE(ABORT, 'a TLC idea is never deleted; a partner marks it DROPPED and it stays listed');
END;

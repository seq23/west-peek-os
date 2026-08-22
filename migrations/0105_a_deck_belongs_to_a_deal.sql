-- A document can say what it is about.
--
-- Operator, 21 Aug 2026: "is there a way to add the deck directly from the 'add a company' button
-- flow manually?" There was not, and the missing piece was not the button.
--
-- `document` carries id, title, doc_type, privacy, scope, current version and who uploaded it — and
-- nothing about WHAT IT IS ABOUT. So a deck uploaded today lands on a general shelf with no tie to
-- the company it describes: to find it again you search a list of every file the firm holds by a
-- title somebody typed. The deck and the deal were two records that never met.
--
-- A LINK TABLE RATHER THAN A COLUMN, for two reasons that both showed up in this system already.
-- One document legitimately concerns more than one thing — a sector report covers four companies, a
-- data-room artifact belongs to an LP and a fund — and a `company_id` column forces a choice that is
-- wrong for those. And the same shape then serves opportunities, LPs and rooms without a fifth
-- column each time somebody wants to attach a file to something new.
--
-- The version is NOT recorded here on purpose. Versions are immutable and a link is to the document,
-- so "the deck for this deal" follows the document forward when a founder sends v2 — which is what
-- anybody means by it. Pinning a version would make the link go stale the moment the deck improved.

CREATE TABLE IF NOT EXISTS document_link (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES document (id),
  -- What it is about: 'canonical_company', 'investment_opportunity', 'lp_record', 'event'.
  object_type  TEXT NOT NULL,
  object_id    TEXT NOT NULL,
  -- Why it is attached, in a word: 'DECK', 'MEMO', 'FINANCIALS', 'LEGAL', 'OTHER'.
  role         TEXT NOT NULL DEFAULT 'OTHER',
  note         TEXT,
  firm_scope   TEXT NOT NULL DEFAULT 'west-peek',
  linked_by    TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- The same document attached twice to the same thing in the same role is a mistake, not a fact.
CREATE UNIQUE INDEX IF NOT EXISTS idx_document_link_unique
  ON document_link (document_id, object_type, object_id, role);

CREATE INDEX IF NOT EXISTS idx_document_link_object ON document_link (object_type, object_id);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0105_a_deck_belongs_to_a_deal');

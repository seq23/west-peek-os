-- 0298 · WYNN'S DRAFTS COUNT UP, SAY WHAT CHANGED, AND A BRAND CAN HAVE SERIES PRICES (owner, 7 Nov 2026: "go this is
--   perfect! all emails from wynn should be like this", on the Pinecone Pricing Reply v2 mock-up).
--   · tlc_brand_reply.version: v1, v2, v3… one up per redraft; the subject to her carries it.
--   · tlc_brand_reply.changes_json: what Wynn did with each note on the last redraft, [{who, note, done}]; a note with no
--     line here holds the email to her.
--   · tlc_brand_reply_version: every version as it went to the partners (its words, its change lines, the email's ref),
--     read by the reply page's version history.
--   · tlc_deal.series_json: the per-event prices one brand sees for 1, 4 and 6 evenings, and the named evenings of each
--     series (shared/tlc/series.ts reads it; Partner never below $5,000).
--   · tlc_deal.people_json: the names and roles of the brand's people on the thread, {address: {name, role}}, so the
--     email to her says "Aaron Kao (VP Marketing)" and never guesses.
-- Additive only; no row changes.
ALTER TABLE tlc_brand_reply ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tlc_brand_reply ADD COLUMN changes_json TEXT;
ALTER TABLE tlc_deal ADD COLUMN series_json TEXT;
ALTER TABLE tlc_deal ADD COLUMN people_json TEXT;

CREATE TABLE IF NOT EXISTS tlc_brand_reply_version (
  reply_id TEXT NOT NULL REFERENCES tlc_brand_reply(id),
  notice_ref TEXT NOT NULL,
  version INTEGER NOT NULL,
  round TEXT,
  draft_body TEXT NOT NULL,
  changes_json TEXT,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (reply_id, notice_ref)
);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0298_wynn_versions_and_series_pricing');

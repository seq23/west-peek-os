-- 0246 — A subscription seat may run a LIVE WEB SEARCH, and a search is only believed with proof.
--
-- WHY (1 Oct 2026). Parker's November Room stopped at DISCOVER: sponsor discovery is a live-web
-- search, the router never offered a search call to a seat ("a local session is not search-grounded"),
-- and with the spend lever on Free only the one thing that could search (Perplexity, paid) was not
-- allowed. The owner's rule: when Claude Code is out of usage, Codex must be able to take the work —
-- any work. A probe on her Mac showed `codex exec --json -c web_search=live` searches the live web on
-- her ChatGPT seat and records every search as a `web_search` event in its JSON stream.
--
-- WHAT THIS ADDS. Three columns on the queue row, all additive:
--
--   needs_search          1 when the call is a search call. A claimer is only handed such a row when
--                         it said it can search (the device's `capabilities_json` carries
--                         "web_search"), so an older claimer that would answer from memory never sees one.
--   search_events         what the claimer COUNTED in the CLI's own event stream — Codex `web_search`
--                         items, Claude Code WebSearch/WebFetch tool calls. NULL on every other row.
--   search_queries_json   the queries and pages it reported, kept so "did it actually search" is
--                         answerable from the row, not from a model's say-so.
--
-- THE PROOF RULE (enforced in reportRun, not here): a search row is REPORTED only when it carries at
-- least one counted search event. An answer with none is recorded FAILED — "answered without
-- searching" — and the chain moves on to the paid search lane. A fluent answer from memory about what
-- happened this week is indistinguishable from research, and it gets believed.
--
-- Nothing existing reads these columns; a row with the defaults behaves exactly as before.
ALTER TABLE subscription_seat_run ADD COLUMN needs_search INTEGER NOT NULL DEFAULT 0
  CHECK (needs_search IN (0, 1));
ALTER TABLE subscription_seat_run ADD COLUMN search_events INTEGER;
ALTER TABLE subscription_seat_run ADD COLUMN search_queries_json TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0246_a_seat_can_search_the_web');

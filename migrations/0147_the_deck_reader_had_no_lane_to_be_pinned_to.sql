-- 0147 — The deck reader was pinned to a routing lane that does not exist.
--
-- Scooter's Sensori deck was queued, extracted, and refused at the door:
--   `model_cannot_read_documents:@cf/ibm-granite/granite-4.0-h-micro`
--
-- `deckReader.ts` passes `routing: { category: "RESEARCH", taskClass: "deck_reading" }` and says why
-- in its own docstring: "without a taskClass, selection falls to the cheapest priced capable model —
-- and the cheapest models cannot read a PDF at all, so an unpinned deck run would be refused by the
-- document gate every time." That is exactly what happened. The pin was written; the POLICY IT
-- NAMES was never created. `latestRoutingPolicy` returned null, selection fell to the cheapest tier,
-- and the document gate refused it — correctly, and for the second time in this repo after the
-- identical failure took down every University session.
--
-- The five policies that do exist are all hyphenated (`daily-intelligence`, `research-packet`), so
-- nothing about the missing underscore key stood out to anybody reading the table.
--
-- claude-sonnet-5 because it is on `DOCUMENT_CAPABLE_MODELS` in `runAi.ts` — a NAMED list, because
-- guessing capability from a model string is how a model that cannot read a PDF gets handed one and
-- answers about nothing. A deck is roughly twenty pages read once; the `deck_reading` job carries a
-- $0.50 budget and this sits well inside it. Reading a deck wrong is more expensive than reading it.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0147_the_deck_reader_had_no_lane_to_be_pinned_to');

-- WHERE NOT EXISTS rather than INSERT OR IGNORE: this repo has twice shipped a migration that
-- reported success while silently dropping the row it existed to add.
INSERT INTO routing_policy
  (id, task_class, version_no, candidates_json, require_capability, max_data_class, allow_fallback, notes, set_by)
SELECT
  'rpol_deck_reading_v1', 'deck_reading', 1,
  '[{"provider_key":"openrouter","model":"anthropic/claude-sonnet-5"}]',
  'text-completion', 'INTERNAL',
  -- NO FALLBACK. Falling back means falling to a cheaper model, and every cheaper model is refused
  -- by the document gate — so a fallback here converts a clear refusal into a slower one.
  0,
  'Reading an emailed deck. Pinned because the document gate refuses every cheap model, so an unpinned run cannot succeed at all — the same failure that made every University session fail before it was pinned.',
  'migration:0147'
WHERE NOT EXISTS (SELECT 1 FROM routing_policy WHERE task_class = 'deck_reading');

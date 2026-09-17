-- 0175 · Everything she says reaches a thinking model, and she can see what it turned into
--
-- Operator, twice: "when I give a task, the agent should use an LLM that is highly intelligent to
-- interpret the ask" and "make sure everything I say reaches a thinking model." Then, afterwards:
-- "tell me what my instructions turned into."
--
-- ─── What was true before this migration ──────────────────────────────────────────────────────
--
-- A work card can carry human prose in four places: `prompt` (how she wants it done), the card's
-- own request text, `work_card_note` (a steering note left while the work is running), and
-- `block_answer` (what she typed to clear a block). The general employee loop reads all of them.
--
-- The SPECIALISED CHAINS — dispatched by `work_card.kind` in services/workSweep.ts, which is how
-- Parker's Room and Workshop packets, Walker's Productions duties and hire search, a partner's
-- blog help and Preston's deck rework are all run — read NONE of them. Confirmed by reading every
-- one of those services: not one referenced `work_card.prompt`, `work_card_note` or `block_answer`.
--
-- So on a chain card she could type an instruction, press send, and it went into a column that
-- nothing ever read. Parker's workshops packet is the case that surfaced it: she asked for "a
-- packet on workshops, much like he does for rooms" and that sentence reached no model at all.
--
-- ─── What this table is ───────────────────────────────────────────────────────────────────────
--
-- The RECEIPT. One row per interpretation: exactly what she typed (unedited, with where each piece
-- came from), what the model made of it, and the governed run that did it — so "which model read
-- my words, and what did it think I meant" is answerable from the product rather than from an
-- agent reading a database.
--
-- WHY THE ORIGINAL TEXT IS STORED RATHER THAN JOINED. The pieces come from four different tables
-- and two of them are mutable: a note can be acknowledged, a block answer overwritten by the next
-- block. A receipt that re-derives its own left-hand side is a receipt that changes after the
-- fact, which is the one thing a receipt may not do. P18's rule — the original text is immutable —
-- is the same rule, and the trigger below enforces it here the way 0118 does there.
--
-- WHY `ai_run_id` IS NOT NULLABLE-BY-HABIT. A row with no run behind it would mean an
-- interpretation nothing actually interpreted, which is precisely the defect being closed. It is
-- nullable only because a run that was BLOCKED by the AI boundary (budget, kill switch, egress)
-- still produces a row so the failure is visible; `interpreted_json` is then NULL and the card
-- blocks rather than proceeding.

CREATE TABLE IF NOT EXISTS work_card_instruction (
  id                TEXT PRIMARY KEY,
  work_card_id      TEXT NOT NULL REFERENCES work_card (id),
  -- The chain this was interpreted for, e.g. 'ROOM_PACKET'. NULL for the general employee loop,
  -- which carries the words into its own step prompt and needs no separate pass.
  card_kind         TEXT,
  -- Exactly what the humans typed: [{source, text, who}]. Immutable, see the trigger below.
  said_json         TEXT NOT NULL,
  -- {understood, steer[], cannot[]} — or NULL when the model could not be read or never ran.
  interpreted_json  TEXT,
  -- Why there is no interpretation, when there is none. A row may not be silently empty.
  failure_reason    TEXT,
  ai_run_id         TEXT REFERENCES ai_run (id),
  model             TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  -- A receipt that says nothing is not a receipt. Either the model answered, or the row says why
  -- it did not; a row carrying neither is the "exists but does nothing" shape Rule 0 forbids.
  CHECK (interpreted_json IS NOT NULL OR IFNULL(length(trim(failure_reason)), 0) > 0)
);

CREATE INDEX IF NOT EXISTS idx_work_card_instruction_card
  ON work_card_instruction (work_card_id, created_at DESC);

-- ── Her words are not editable, by anybody ────────────────────────────────────────────────────
--
-- The same rule as P18's immutable original text, enforced the same way. An UPDATE that changed
-- `said_json` would let the record of what she asked for be rewritten to match what was built,
-- which is the exact failure the receipt exists to make impossible.
CREATE TRIGGER IF NOT EXISTS work_card_instruction_said_is_immutable
BEFORE UPDATE ON work_card_instruction
WHEN NEW.said_json IS NOT OLD.said_json
BEGIN
  SELECT RAISE(ABORT, 'what a partner typed cannot be edited after the fact (0175)');
END;

CREATE TRIGGER IF NOT EXISTS work_card_instruction_is_append_only
BEFORE DELETE ON work_card_instruction
BEGIN
  SELECT RAISE(ABORT, 'a record of what a partner asked for cannot be deleted (0175)');
END;

-- ── The model that does the reading has to exist in the catalogue ────────────────────────────
--
-- FOUND WHILE BUILDING THE ABOVE, and it is the same defect as 0147 for the third time.
--
-- `runAi` now asks the catalogue which models can reason, because price must not be allowed to
-- decide who reads a partner's instruction (see RunAiBudgetContext.interpretation). Asked of a
-- freshly migrated database, the answer was NONE: the only ACTIVE `provider_model` row in the repo
-- is `perplexity/sonar`, which is `supports_reasoning = 0` and is the search model this must never
-- use. A capability filter that can never match anything is the "runs but inert" shape, so the
-- filter is only half the fix.
--
-- The other half is worse. FIVE routing policies — `university` (0088), `market-map` (0088),
-- `research-packet` (0088), `deck_reading` (0147) and the lanes that followed — all pin
-- `openrouter` / `anthropic/claude-sonnet-5`, and that model has NO `provider_model` row and NO
-- `provider_pricing_snapshot` row anywhere in `migrations/`. `runAi` routes only to a priced model,
-- so on a fresh database every one of those pins resolves to "names no available candidate" and the
-- run is refused. 0147's own comment describes this exact failure and fixed one lane of it by
-- writing the policy; nobody registered the model the policy names.
--
-- Registered ACTIVE and priced so it is reachable, `supports_reasoning = 1` because that is what it
-- is and it is now a routing input rather than a decoration, and INSERTed with WHERE NOT EXISTS so
-- a production database that already carries a live price keeps it.
--
-- The price is ILLUSTRATIVE and says so. $2/$10 per Mtok is the figure this repo already states for
-- this model in `src/shared/ai/models.ts`; it is a placeholder, not a vendor invoice, and nothing
-- may present it to an operator as a current price. It matters here only for ORDERING among models
-- that have already passed the capability filter — which is the entire point of doing it that way
-- round.

INSERT INTO provider_model
  (id, provider_id, model, display_name, capabilities_json, context_window, max_output_tokens,
   supports_tools, supports_reasoning, max_data_class, pricing_state, pricing_source_note,
   status, registered_by, firm_scope)
SELECT
  'pm_openrouter_claude_sonnet_5', 'prov_openrouter', 'anthropic/claude-sonnet-5',
  'Claude Sonnet 5 (reasoning)', '["text-completion"]', 200000, 8192,
  1, 1, 'INTERNAL', 'ILLUSTRATIVE',
  'Placeholder rate matching the figure stated in src/shared/ai/models.ts. Not a vendor invoice.',
  'ACTIVE', 'migration:0175', 'west-peek'
WHERE NOT EXISTS (
  SELECT 1 FROM provider_model WHERE provider_id = 'prov_openrouter' AND model = 'anthropic/claude-sonnet-5'
);

INSERT INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, captured_at)
SELECT 'pps_openrouter_claude_sonnet_5', 'prov_openrouter', 'anthropic/claude-sonnet-5', 2.00, 10.00, '2026-09-16T00:00:00.000Z'
WHERE NOT EXISTS (
  SELECT 1 FROM provider_pricing_snapshot WHERE provider_id = 'prov_openrouter' AND model = 'anthropic/claude-sonnet-5'
);

-- ── The lane this interpretation runs in ──────────────────────────────────────────────────────
--
-- Pinned for the same reason `university` and `research-packet` are: unpinned work falls to a price
-- comparison, and this is the call every other call in the firm inherits its instructions from.
-- The pin and the capability filter agree here — belt and braces, deliberately, because they fail
-- differently: a pin is a decision that can go stale, a capability filter is a property that cannot.
--
-- NO FALLBACK. Falling back means falling to a model the catalogue does not credit with reasoning,
-- which for this call is the failure rather than the recovery. A run that cannot be interpreted
-- blocks the card with a sentence she can act on, which is a better outcome than a cheap guess at
-- what she meant carried silently through six stages of work.

INSERT INTO routing_policy
  (id, task_class, version_no, candidates_json, require_capability, max_data_class, allow_fallback, notes, set_by, firm_scope)
SELECT
  'rpol_instruction_interpretation_v1', 'instruction-interpretation', 1,
  '[{"provider_key":"openrouter","model":"anthropic/claude-sonnet-5"}]',
  'text-completion', 'INTERNAL', 0,
  'Reading what a partner asked for, before any work is done on it. Everything downstream carries whatever this decides she meant, so it is never the cheap tier and never a search-grounded model.',
  'migration:0175', 'west-peek'
WHERE NOT EXISTS (SELECT 1 FROM routing_policy WHERE task_class = 'instruction-interpretation');

-- ── Parker's Workshop card, which is the card that started all of this ───────────────────────
--
-- She asked Parker for "a packet on workshops, much like he does for rooms". 0171 built the
-- Workshop chain — the Room stages with a Workshop brief, virtual only — and 0173 reopened his
-- card after it blocked with a reason written for an engineer. Both were right as far as they went.
--
-- What neither did is put HER SENTENCE anywhere the work would read it. The card's description is
-- written by `openPacketCard` from the month, the packet id and a recital of the chain's own
-- stages; `prompt` — the one column meant for "how the partner wants this done" — is empty, and
-- until this migration nothing in the packet chain read it anyway.
--
-- So the words go on the card, in her terms, and from the next sweep tick they reach a model before
-- the first stage runs. Written ONLY where `prompt` is empty: a card she has since typed on carries
-- her more recent words, and those outrank anything written here.
--
-- Scoped to a Workshop packet card of Parker's that is not finished. If there is none — the packet
-- was built and kept between this being written and applied — this updates nothing, which is the
-- correct outcome and not a silent failure: there is no card left to steer.
UPDATE work_card
   SET prompt = 'A packet on workshops, in the same shape as the ones you produce for rooms.',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE kind = 'ROOM_PACKET'
   AND owner_id = 'aie_parker'
   AND state NOT IN ('DONE', 'CANCELLED')
   AND IFNULL(length(trim(prompt)), 0) = 0
   AND id IN (SELECT work_card_id FROM evt_room_packet WHERE kind = 'WORKSHOP' AND work_card_id IS NOT NULL);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0175_an_instruction_reaches_a_thinking_model');

-- ONE LADDER, WALKED DOWN — PAID ONLY WHEN EVERYTHING FREE IS EXHAUSTED.
--
-- Migration 0187 built rung 0: two subscription seats on the owner's own machine. This builds the
-- rest of the ladder and, more importantly, establishes the thing this firm did not have — MORE
-- THAN ONE LANE THAT MAY SEE AN LP NAME.
--
--   rung 0a. Claude Code, her Claude Max seat        $0        PRIVATE-CAPABLE   (0187)
--   rung 0b. Codex CLI, her ChatGPT Plus seat        $0        PRIVATE-CAPABLE   (0187)
--   rung 1.  nvidia/nemotron-3-ultra-550b-a55b:free  $0        PUBLIC-ONLY       (already ACTIVE)
--   rung 2.  deepseek/deepseek-v4-flash-0731:free    $0        PUBLIC-ONLY
--   rung 3.  thinkingmachines/inkling:free           $0        PUBLIC-ONLY       BENCH — refused
--   rung 4.  z-ai/glm-5.2:free                       $0        PUBLIC-ONLY       BENCH — saturated
--   rung 5.  qwen/qwen3.8-27b:free                   $0        PUBLIC-ONLY
--   rung 6.  nvidia/nemotron-3-super-120b-a12b:free  $0        PUBLIC-ONLY
--   rung 7.  google/gemini-2.5-flash-lite            $0.10/$0.40   private-capable
--   rung 8.  openai/gpt-5-mini                       $0.25/$2.00   private-capable
--   rung 9.  google/gemini-2.5-flash                 $0.30/$2.50   private-capable
--   rung 10. nvidia/nemotron-3-ultra-550b-a55b       $0.625/$3.125 private-capable
--   rung 11. anthropic/claude-haiku-4.5              $1.00/$5.00   private-capable
--   rung 12. anthropic/claude-sonnet-5:batch         $1.00/$5.00   BENCH — batch API only
--   rung 13. anthropic/claude-sonnet-5               $2.00/$10.00  private-capable (already ACTIVE)
--
-- THE NUMBER THIS EXISTS TO MOVE: $48.67 spent this month against a ~$10 target, and 52 of the last
-- 70 Sonnet-5 runs were labelled INTERNAL — work that had nowhere cheaper to go because
-- `claude-sonnet-5` was the ONLY private-capable lane in the catalogue. After this, it is one of
-- nine.
--
-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- WHAT MAKES A PAID LANE PRIVATE-CAPABLE, AND WHY THIS IS NOW CONFIRMED RATHER THAN SUSPECTED
--
-- This was the open question and it is closed, but NOT the way it was expected to close.
--
-- THE ROUTE THAT DOES NOT WORK. OpenRouter's account-level training opt-out lives at
-- openrouter.ai/settings/privacy. `GET /api/v1/key` was probed for it and does NOT expose it — it
-- returns limits, usage and `allowed_data_regions: ["global"]`, and nothing about data collection.
-- So the account flag cannot be read from here, cannot be asserted in a test, and can be flipped by
-- anybody with the login without a single thing in this repository noticing. Registering nine lanes
-- as private-capable on the strength of an unreadable setting would be exactly the "looks perfect
-- right up to the outage it was meant to survive" failure this firm keeps writing migrations about.
--
-- THE ROUTE THAT DOES. OpenRouter accepts a PER-REQUEST routing constraint,
-- `provider: { data_collection: "deny" }`, and it is enforced by their router rather than by our
-- good intentions. Probed against the live key on 17 Sep 2026, three calls:
--
--   google/gemini-2.5-flash-lite        deny   → HTTP 200, "lane is alive", served by Google
--   nvidia/nemotron-3-ultra-550b:free   deny   → HTTP 404, "No endpoints found matching your data
--                                                policy (Free model training)"
--   nvidia/nemotron-3-ultra-550b:free   allow  → HTTP 200, served by Nvidia
--
-- Three things follow, and the second is the one worth pausing on:
--
--   1. A PAID LANE GENUINELY SERVES under a no-training constraint. Not a claim; a 200.
--   2. THE VENDOR'S OWN ROUTER CLASSIFIES THE `:free` TIER AS TRAINING-PERMITTING, in those words.
--      This firm has been asserting that since migration 0178 on the reasonable grounds that free
--      is usually free in exchange for training rights. It is no longer an inference.
--   3. THE FAILURE MODE IS THE SAFE ONE. If a paid lane ever loses its non-training endpoint, the
--      call returns 404 — outage-class, so it chains to the next private-capable rung — rather than
--      quietly being served by a provider that keeps the prompt. A lane that cannot serve privately
--      REMOVES ITSELF from the private ladder, with no human noticing required.
--
-- The flag is set in `runAi` once per run, from `contentClass`, and carried into every adapter that
-- run builds. See `denyDataCollection` there and in `providers/openRouter.ts`.
--
-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- PROOF STANDARD: EVERY ACTIVE ROW BELOW COMPLETED A REAL GENERATION.
--
-- Not a read-only probe. Migration 0184's entire incident was a lane that passed a probe and then
-- failed every real call with "credit balance too low", so "the endpoint answered" is not evidence
-- that a lane can serve. Each row marked ACTIVE returned HTTP 200 and real text from
-- `POST /api/v1/chat/completions` on 17 Sep 2026, and each row marked BENCH was probed and refused,
-- with the vendor's own words recorded.
--
-- TWO EARLIER "FAILURES" WERE WITHDRAWN, and the reason is recorded because it is a trap that will
-- catch the next person. A first sweep capped `max_tokens` at 16 and reported
-- `deepseek-v4-flash-0731:free` and `gpt-5-mini` as returning HTTP 200 with EMPTY content. They are
-- reasoning models: the whole 16-token budget went to reasoning tokens and nothing was left for the
-- answer. An empty completion from a reasoning model under a tight cap is a MEASUREMENT ARTEFACT,
-- not a dead lane. Re-run with a real budget, both returned the expected text. Likewise a `429` on
-- `qwen3.8-27b:free` in one sweep and a `200` in another: free capacity fluctuates, a 429 is
-- already outage-class, and the chain handles it — so the lane is registered on its successful
-- generation rather than written off for a busy minute.
--
-- AND ALL TEN ACTIVE LANES ARE REASONING-CAPABLE, verified by passing `reasoning: {effort:"low"}`
-- and reading back a populated `reasoning` field with non-zero `reasoning_tokens` (haiku 36,
-- flash 26, flash-lite 32). This matters mechanically rather than decoratively: `runAi` refuses a
-- lane with `supports_reasoning = 0` for any interpretation call, so a wrong zero here would leave
-- a rung registered, visible, and permanently unreachable — the "runs but inert" defect, in a table.
--
-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- PRICES READ FROM https://openrouter.ai/api/v1/models ON 17 SEP 2026, and re-read rather than
-- copied: every figure below was pulled from the live feed in this session and matched against the
-- brief independently. The feed is public and needs no key, which is why `scripts/prices/refresh.mjs`
-- already uses it as an authoritative source. `pricing_state = 'SOURCED'` is therefore true in the
-- sense this repo means it — somebody read it from the vendor and wrote down when.

-- ── RUNGS 2-6: THE FREE REASONING LANES ──────────────────────────────────────────────────────
-- All on `prov_openrouter_free`, which migration 0178 registered as training-permitting and capped
-- at PUBLIC for the correct reason. Nothing here widens that: these rungs may never see an LP name,
-- and the per-request deny constraint means a private call cannot reach them even by accident —
-- OpenRouter refuses to route it.
INSERT OR IGNORE INTO provider_model
  (id, provider_id, model, display_name, capabilities_json, context_window, max_output_tokens,
   supports_tools, supports_reasoning, latency_source, max_data_class,
   pricing_state, pricing_source_note, pricing_sourced_at, status, registered_by, firm_scope)
VALUES
  ('pm_or_free_deepseek_v4_flash', 'prov_openrouter_free', 'deepseek/deepseek-v4-flash-0731:free',
   'DeepSeek V4 Flash (free)', '["text-completion"]', 1048576, 393216, 1, 1, 'UNKNOWN', 'PUBLIC',
   'SOURCED', 'Read 17 Sep 2026 from openrouter.ai/api/v1/models: $0 in / $0 out, 1,048,576-token context. Real generation completed 17 Sep 2026. An earlier sweep recorded an empty completion under a 16-token cap; that was the reasoning budget consuming the whole allowance, not a dead lane.',
   '2026-09-17', 'ACTIVE', 'migration:0188', 'west-peek'),

  ('pm_or_free_inkling', 'prov_openrouter_free', 'thinkingmachines/inkling:free',
   'Thinking Machines Inkling (free)', '["text-completion"]', 1048576, 262144, 1, 1, 'UNKNOWN', 'PUBLIC',
   'SOURCED', 'Read 17 Sep 2026 from openrouter.ai/api/v1/models: $0 in / $0 out. BENCH, and not for want of trying: a real generation was refused with HTTP 403, "thinkingmachines/inkling:free is only available on agentic harnesses. Try plugging it into a coding agent." This is not a transient outage and not a capacity limit — the model is not reachable from a server-side chat completion at all, so no amount of retrying will promote it. It is registered rather than omitted so the next person reads this line instead of rediscovering the 403.',
   '2026-09-17', 'BENCH', 'migration:0188', 'west-peek'),

  ('pm_or_free_glm_52', 'prov_openrouter_free', 'z-ai/glm-5.2:free',
   'GLM 5.2 (free)', '["text-completion"]', 32768, 29491, 1, 1, 'UNKNOWN', 'PUBLIC',
   'SOURCED', 'Read 17 Sep 2026 from openrouter.ai/api/v1/models: $0 in / $0 out. BENCH: every attempt answered HTTP 429 — three consecutive tries three seconds apart in one sweep, and again in a second independent sweep. Saturated free capacity rather than a blip. Promote on a single successful generation; a 429 is already outage-class, so if it is promoted and is still busy the chain steps past it without a partner noticing.',
   '2026-09-17', 'BENCH', 'migration:0188', 'west-peek'),

  ('pm_or_free_qwen38_27b', 'prov_openrouter_free', 'qwen/qwen3.8-27b:free',
   'Qwen 3.8 27B (free)', '["text-completion"]', 262144, 235929, 1, 1, 'UNKNOWN', 'PUBLIC',
   'SOURCED', 'Read 17 Sep 2026 from openrouter.ai/api/v1/models: $0 in / $0 out. Real generation completed 17 Sep 2026. One sweep saw HTTP 429 and another saw a clean 200 minutes later; registered on the success, because free capacity fluctuates by the minute and a 429 is outage-class — the chain steps past a busy lane rather than failing on it.',
   '2026-09-17', 'ACTIVE', 'migration:0188', 'west-peek'),

  ('pm_or_free_nemotron_super_120b', 'prov_openrouter_free', 'nvidia/nemotron-3-super-120b-a12b:free',
   'Nemotron 3 Super 120B (free)', '["text-completion"]', 262144, 235929, 1, 1, 'UNKNOWN', 'PUBLIC',
   'SOURCED', 'Read 17 Sep 2026 from openrouter.ai/api/v1/models: $0 in / $0 out. Real generation completed 17 Sep 2026, served by Nvidia.',
   '2026-09-17', 'ACTIVE', 'migration:0188', 'west-peek');

INSERT OR IGNORE INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, request_usd, captured_at) VALUES
  ('pps_0188_deepseek_v4_flash', 'prov_openrouter_free', 'deepseek/deepseek-v4-flash-0731:free', 0.0, 0.0, 0.0, '2026-09-17T00:00:00.000Z'),
  ('pps_0188_inkling', 'prov_openrouter_free', 'thinkingmachines/inkling:free', 0.0, 0.0, 0.0, '2026-09-17T00:00:00.000Z'),
  ('pps_0188_glm_52', 'prov_openrouter_free', 'z-ai/glm-5.2:free', 0.0, 0.0, 0.0, '2026-09-17T00:00:00.000Z'),
  ('pps_0188_qwen38_27b', 'prov_openrouter_free', 'qwen/qwen3.8-27b:free', 0.0, 0.0, 0.0, '2026-09-17T00:00:00.000Z'),
  ('pps_0188_nemotron_super_120b', 'prov_openrouter_free', 'nvidia/nemotron-3-super-120b-a12b:free', 0.0, 0.0, 0.0, '2026-09-17T00:00:00.000Z');

-- ── RUNGS 7-12: THE PAID LANES, CHEAPEST FIRST, ALL PRIVATE-CAPABLE ──────────────────────────
-- On `prov_openrouter`, which is NOT training-permitting and carries a CONFIDENTIAL data policy
-- already. `max_data_class` is INTERNAL for each: the same ceiling rung 0 carries, and for the same
-- reason — the private slice this ladder exists for arrives labelled INTERNAL with
-- `model_access = PRIVATE_MODEL_ONLY`, and widening anything to CONFIDENTIAL is a separate decision
-- that nobody has asked for and that `tests/ai.test.ts` currently guarantees against.
INSERT OR IGNORE INTO provider_model
  (id, provider_id, model, display_name, capabilities_json, context_window, max_output_tokens,
   supports_tools, supports_reasoning, latency_source, max_data_class,
   pricing_state, pricing_source_note, pricing_sourced_at, status, registered_by, firm_scope)
VALUES
  ('pm_or_gemini_25_flash_lite', 'prov_openrouter', 'google/gemini-2.5-flash-lite',
   'Gemini 2.5 Flash Lite', '["text-completion"]', 1048576, 65535, 1, 1, 'UNKNOWN', 'INTERNAL',
   'SOURCED', 'Read 17 Sep 2026 from openrouter.ai/api/v1/models: $0.10 in / $0.40 out per Mtok, 1,048,576-token context. Real generation completed 17 Sep 2026 UNDER provider.data_collection=deny, served by Google — which is what makes it private-capable: the no-training constraint is carried by the request and enforced by OpenRouter''s router, not asserted by us. Reasoning confirmed by a second pass with reasoning effort low, returning 32 reasoning tokens. The cheapest private-capable lane in the firm by a factor of twenty against Sonnet 5.',
   '2026-09-17', 'ACTIVE', 'migration:0188', 'west-peek'),

  ('pm_or_gpt5_mini', 'prov_openrouter', 'openai/gpt-5-mini',
   'GPT-5 mini', '["text-completion"]', 400000, 128000, 1, 1, 'UNKNOWN', 'INTERNAL',
   'SOURCED', 'Read 17 Sep 2026 from openrouter.ai/api/v1/models: $0.25 in / $2.00 out per Mtok. Real generation completed 17 Sep 2026 under provider.data_collection=deny, served by OpenAI. An earlier sweep recorded an empty completion under a 16-token cap; that was the reasoning budget consuming the whole allowance, not a dead lane.',
   '2026-09-17', 'ACTIVE', 'migration:0188', 'west-peek'),

  ('pm_or_gemini_25_flash', 'prov_openrouter', 'google/gemini-2.5-flash',
   'Gemini 2.5 Flash', '["text-completion"]', 1048576, 65535, 1, 1, 'UNKNOWN', 'INTERNAL',
   'SOURCED', 'Read 17 Sep 2026 from openrouter.ai/api/v1/models: $0.30 in / $2.50 out per Mtok. Real generation completed 17 Sep 2026 under provider.data_collection=deny, served by Google. Reasoning confirmed: 26 reasoning tokens on a low-effort pass.',
   '2026-09-17', 'ACTIVE', 'migration:0188', 'west-peek'),

  ('pm_or_nemotron_ultra_metered', 'prov_openrouter', 'nvidia/nemotron-3-ultra-550b-a55b',
   'Nemotron 3 Ultra 550B (metered)', '["text-completion"]', 262144, 32768, 1, 1, 'UNKNOWN', 'INTERNAL',
   'SOURCED', 'Read 17 Sep 2026 from openrouter.ai/api/v1/models: $0.625 in / $3.125 out per Mtok. Real generation completed 17 Sep 2026 under provider.data_collection=deny, served by Venice. The PAID twin of rung 1: the same model the firm already runs free, on a metered endpoint that may carry private work — so a private call and a public one can use the same model at different prices and different terms, which is exactly the distinction migration 0178 drew between the two OpenRouter provider rows.',
   '2026-09-17', 'ACTIVE', 'migration:0188', 'west-peek'),

  ('pm_or_haiku_45', 'prov_openrouter', 'anthropic/claude-haiku-4.5',
   'Claude Haiku 4.5 (OpenRouter)', '["text-completion"]', 200000, 64000, 1, 1, 'UNKNOWN', 'INTERNAL',
   'SOURCED', 'Read 17 Sep 2026 from openrouter.ai/api/v1/models: $1.00 in / $5.00 out per Mtok. Real generation completed 17 Sep 2026 under provider.data_collection=deny, served by Amazon Bedrock. Reasoning confirmed: 36 reasoning tokens on a low-effort pass. DISTINCT FROM migration 0184''s pm_anthropic_haiku_45, which is the DIRECT Anthropic lane and is BENCH behind an unfunded account. Same model, different lane, different health: this one has completed work and that one has not, which is precisely the distinction provider_lane_health exists to keep.',
   '2026-09-17', 'ACTIVE', 'migration:0188', 'west-peek'),

  ('pm_or_sonnet5_batch', 'prov_openrouter', 'anthropic/claude-sonnet-5:batch',
   'Claude Sonnet 5 (batch)', '["text-completion"]', 1000000, 128000, 1, 1, 'UNKNOWN', 'INTERNAL',
   'SOURCED', 'Read 17 Sep 2026 from openrouter.ai/api/v1/models: $1.00 in / $5.00 out per Mtok — exactly half realtime Sonnet 5, which is why it is worth registering at all. BENCH: a real generation was refused with HTTP 404, "This model is only available through the Batch API. Use the /api/beta/batches endpoint instead." That is a different wire contract from the chat-completions shape every adapter in this repo speaks, not a configuration problem, so promoting it needs a batch adapter and an asynchronous result path rather than a status change. Recorded here so the halving is not forgotten; it is the obvious next saving once the ladder is proven.',
   '2026-09-17', 'BENCH', 'migration:0188', 'west-peek');

INSERT OR IGNORE INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, request_usd, captured_at) VALUES
  ('pps_0188_gemini_flash_lite', 'prov_openrouter', 'google/gemini-2.5-flash-lite', 0.10, 0.40, 0.0, '2026-09-17T00:00:00.000Z'),
  ('pps_0188_gpt5_mini', 'prov_openrouter', 'openai/gpt-5-mini', 0.25, 2.00, 0.0, '2026-09-17T00:00:00.000Z'),
  ('pps_0188_gemini_flash', 'prov_openrouter', 'google/gemini-2.5-flash', 0.30, 2.50, 0.0, '2026-09-17T00:00:00.000Z'),
  ('pps_0188_nemotron_ultra_metered', 'prov_openrouter', 'nvidia/nemotron-3-ultra-550b-a55b', 0.625, 3.125, 0.0, '2026-09-17T00:00:00.000Z'),
  ('pps_0188_or_haiku_45', 'prov_openrouter', 'anthropic/claude-haiku-4.5', 1.00, 5.00, 0.0, '2026-09-17T00:00:00.000Z'),
  ('pps_0188_or_sonnet5_batch', 'prov_openrouter', 'anthropic/claude-sonnet-5:batch', 1.00, 5.00, 0.0, '2026-09-17T00:00:00.000Z');

-- ── THE REGISTRATION DECISIONS, ON RECORD ────────────────────────────────────────────────────
-- The promotion gate refuses ACTIVE without a recorded evaluation. These are LIVE rather than
-- FIXTURE, unlike 0184's and 0187's, because unlike those there IS a real generation to cite: each
-- of these lanes answered a chat completion with real text on 17 Sep 2026. `score` stays 0 and
-- `sample_size` 1 — one successful call is proof that a lane CAN SERVE and says nothing whatever
-- about whether it serves WELL. Quality is `model_job_outcome`'s question and it stays silent below
-- twenty decided outcomes, on purpose.
INSERT OR IGNORE INTO model_evaluation (id, provider_model_id, task_class, method, score, sample_size, notes, evaluated_by) VALUES
  ('mev_0188_deepseek_v4_flash', 'pm_or_free_deepseek_v4_flash', 'public-model-approved-reasoning', 'LIVE', 0, 1, 'One real generation, 17 Sep 2026. Proves the lane can serve; proves nothing about quality.', 'system'),
  ('mev_0188_qwen38_27b', 'pm_or_free_qwen38_27b', 'public-model-approved-reasoning', 'LIVE', 0, 1, 'One real generation, 17 Sep 2026, after a 429 in an earlier sweep. Proves the lane can serve; proves nothing about quality.', 'system'),
  ('mev_0188_nemotron_super_120b', 'pm_or_free_nemotron_super_120b', 'public-model-approved-reasoning', 'LIVE', 0, 1, 'One real generation, 17 Sep 2026, served by Nvidia. Proves the lane can serve; proves nothing about quality.', 'system'),
  ('mev_0188_gemini_flash_lite', 'pm_or_gemini_25_flash_lite', 'private-model-only-drafting', 'LIVE', 0, 1, 'One real generation under provider.data_collection=deny, 17 Sep 2026. Proves the lane can serve PRIVATE work under an enforced no-training constraint; proves nothing about quality.', 'system'),
  ('mev_0188_gpt5_mini', 'pm_or_gpt5_mini', 'private-model-only-drafting', 'LIVE', 0, 1, 'One real generation under provider.data_collection=deny, 17 Sep 2026, served by OpenAI.', 'system'),
  ('mev_0188_gemini_flash', 'pm_or_gemini_25_flash', 'private-model-only-drafting', 'LIVE', 0, 1, 'One real generation under provider.data_collection=deny, 17 Sep 2026, served by Google.', 'system'),
  ('mev_0188_nemotron_ultra_metered', 'pm_or_nemotron_ultra_metered', 'private-model-only-drafting', 'LIVE', 0, 1, 'One real generation under provider.data_collection=deny, 17 Sep 2026, served by Venice.', 'system'),
  ('mev_0188_or_haiku_45', 'pm_or_haiku_45', 'private-model-only-drafting', 'LIVE', 0, 1, 'One real generation under provider.data_collection=deny, 17 Sep 2026, served by Amazon Bedrock.', 'system');

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- WHAT IS DELIBERATELY *NOT* IN THIS MIGRATION
--
-- A ROUTING POLICY PINNING THE ORDER. It would be the wrong mechanism and it would fight three that
-- already work. The router already walks cheapest-effective-first: `costRanked` orders on price,
-- `orderByEvidence` puts measured-good lanes ahead of unproven ones, and `orderByLaneHealth` puts
-- working-in-practice ahead of cheap-on-paper and removes anything in back-off. A pinned list would
-- freeze the ladder at tonight's prices and tonight's beliefs, and — the real cost — it would
-- override `model_job_outcome`, which is the thing that lets a free lane whose output keeps getting
-- reworked SINK ON ITS OWN with nobody adjudicating. The ladder in the header is the order these
-- rungs fall into today by price; it is a description, not a configuration.
--
-- A VOLUME COUNTER ON THE SUBSCRIPTION SEATS. The throttle is the eligibility gate in `runAi`, and
-- it is a real one rather than an absence: the seats are offered ONLY judgement-class
-- PRIVATE_MODEL_ONLY calls with no images, no documents and no search. At the observed rate — 52
-- INTERNAL runs in seven days, about seven a day — that is single-digit calls per day against a
-- subscription sized for a person working all day. Adding a counter on top would be a second
-- mechanism governing a volume the first mechanism already bounds, and this repo has now written
-- three migrations about what two overlapping mechanisms cost. If the observed volume ever rises to
-- where it competes with her own sessions, a counter is the right answer THEN, measured rather than
-- guessed.
--
-- A CHANGE TO THE CAPS. $2.50/day and the ~$10/month target are untouched. This ladder is how the
-- firm gets under them, not a reason to move them.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0188_one_ladder_walked_down');

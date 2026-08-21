-- Two defects with one cause: work reached a model nobody chose for it.
--
-- WHY THE PINS. `runAi` escapes its default — "cheapest priced capable model, one attempt, no
-- fallback" — only when a routing_policy row matches the run's taskClass. Two task classes were
-- ever given one: daily-intelligence and employee-work. Everything else passed `category`, which
-- is a SPEND bucket and not a routing key, and fell to the default.
--
-- That default sent University, market maps and research packets to granite-4.0-h-micro, the
-- cheapest registered model, on an adapter that returned a malformed response every time. The
-- adapter is fixed now, which makes this MORE urgent rather than less: those three surfaces will
-- newly succeed on the cheap tier and quietly produce weak prose that a partner reads as the
-- firm's own work. The note on the employee-work policy already records what that looks like —
-- a brief containing "the 30-year U.S. tax at 19 year high", shipped as fact.
--
-- These three are pinned because a human reads their output directly as a firm document. The
-- remaining unpinned callers (briefingSynthesis, liveHelp, meetingDelegation, roomCloseout) are
-- recorded in BACKLOG.md rather than changed here; liveSearch already pins its provider itself.
--
-- Fallback is OFF on all three, matching the existing two. Work that fails loudly is better than
-- work done badly and reported as done.

INSERT OR IGNORE INTO routing_policy
  (id, task_class, version_no, candidates_json, require_capability, max_data_class, allow_fallback, notes, set_by, firm_scope)
VALUES
  ('rpol_university_v1', 'university', 1,
   '[{"provider_key":"openrouter","model":"anthropic/claude-sonnet-5"}]',
   'text-completion', 'PUBLIC', 0,
   'West Peek University teaches a first-time GP fund mechanics. Unpinned it fell to the cheapest tier, which is how every session in production failed. A lesson is roughly 1,200 output tokens — about a penny at this rate against a $25 daily cap. Being taught something wrong costs more.',
   'fu_sequoia_taylor', 'west-peek'),

  ('rpol_market_map_v1', 'market-map', 1,
   '[{"provider_key":"openrouter","model":"anthropic/claude-sonnet-5"}]',
   'text-completion', 'PUBLIC', 0,
   'Segments companies into a market map read as a firm document. A mislabelled company puts every downstream count wrong while the map still looks finished.',
   'fu_sequoia_taylor', 'west-peek'),

  ('rpol_research_packet_v1', 'research-packet', 1,
   '[{"provider_key":"openrouter","model":"anthropic/claude-sonnet-5"}]',
   'text-completion', 'INTERNAL', 0,
   'The research synthesis itself — findings grounded against source ids and read by a partner. The cheap tier exists for small frequent work, not for this.',
   'fu_sequoia_taylor', 'west-peek');

-- ── The Workers AI catalogue that silently never registered ──────────────────
--
-- `0081_workers_ai_cheap_tier.sql` inserted the provider, three pricing snapshots and three
-- provider_model rows. The provider and the prices landed; the models did not, and nothing said so.
--
-- CAUSE: `provider_model.registered_by` is TEXT NOT NULL with no default (0015). The 0081 insert
-- names seven columns and omits it, so every row violated NOT NULL — and `INSERT OR IGNORE`
-- swallows a constraint violation as silently as it swallows a duplicate. That is the trap: OR
-- IGNORE reads as "skip if already there" and also means "skip if malformed".
--
-- CONSEQUENCE: routing selects candidates from provider_pricing_snapshot, which HAS the rows, so
-- the firm has been routing to models that do not appear in its own model catalogue — the Cockpit
-- reads provider_model. The operator could not see the tier they were being billed for.
--
-- registered_by is the seed identity used elsewhere for machine-written catalogue rows.
INSERT OR IGNORE INTO provider_model
  (id, provider_id, model, display_name, capabilities_json, context_window, max_output_tokens,
   max_data_class, pricing_state, pricing_source_note, status, registered_by, firm_scope)
VALUES
  ('pm_wai_granite', 'prov_workers_ai', '@cf/ibm-granite/granite-4.0-h-micro',
   'Granite 4 Micro (cheapest)', '["text-completion"]', 32000, 4096,
   'INTERNAL', 'ILLUSTRATIVE',
   'Converted from Cloudflare published neuron rates, August 2026. Not a vendor invoice.',
   'BENCH', 'system', 'west-peek'),

  ('pm_wai_qwen', 'prov_workers_ai', '@cf/qwen/qwen3-30b-a3b-fp8',
   'Qwen3 30B (cheap and capable)', '["text-completion"]', 32000, 8192,
   'INTERNAL', 'ILLUSTRATIVE',
   'Converted from Cloudflare published neuron rates, August 2026. Not a vendor invoice.',
   'BENCH', 'system', 'west-peek'),

  ('pm_wai_llama_v', 'prov_workers_ai', '@cf/meta/llama-3.2-11b-vision-instruct',
   'Llama 3.2 11B Vision', '["text-completion"]', 16000, 4096,
   'INTERNAL', 'ILLUSTRATIVE',
   'Converted from Cloudflare published neuron rates, August 2026. Meta community licence accepted by a Managing Partner on 21 Aug 2026; before that every call returned error 5016.',
   'BENCH', 'system', 'west-peek');

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0088_routing_pins_and_workers_ai_catalogue');

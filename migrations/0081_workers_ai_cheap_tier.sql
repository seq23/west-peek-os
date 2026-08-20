-- Cloudflare Workers AI: the cheap tier, and the only one that is ever actually free.
--
-- THE QUESTION THIS ANSWERS. "Is there still a lever for me to drag to get us the cheapest closest
-- to $0 possible? Is there an open source model in this that is completely free? Did we survey the
-- best open source models to keep us close to $0?"
--
-- The honest answers were: there is a lever (cost_mode CHEAPO) but it had nowhere cheap to go; the
-- cheapest thing registered was gemini-1.5-flash at $0.075/$0.30 per million tokens; and no, nobody
-- had surveyed anything — the catalogue still listed gpt-4o and claude-sonnet-4.
--
-- Workers AI runs open-weight models on the platform this firm already pays for. 10,000 neurons per
-- day are included at no cost, which for the small frequent work that makes up most runs is free
-- outright. Beyond that it is $0.011 per 1,000 neurons. Prices below are converted from Cloudflare's
-- published per-model neuron rates (August 2026) into the per-million-token figures this system
-- prices in, so they sit on the same scale as every other model and the cost centre needs no
-- special case.
--
-- IT IS A BINDING. No hostname, no bearer token, no third-party credential, and nothing on the
-- egress allowlist — the same property that made the Cloudflare email transport preferable to
-- Resend. base_url is deliberately NULL: there is no URL to call.
--
-- WHAT IT DOES NOT DO. It does not take over the morning brief, which is pinned to a frontier model
-- because the cheap tier once produced "the 30-year U.S. tax at 19 year high" and shipped it as
-- fact. See the spend posture in runAi for how the cheap tier and the pinned work are kept apart.

INSERT OR IGNORE INTO provider_registry
  (id, provider_key, display_name, enabled, kill_switched, capabilities_json, base_url, firm_scope)
VALUES
  ('prov_workers_ai', 'workers_ai', 'Cloudflare Workers AI', 1, 0, '["text-completion"]', NULL, 'west-peek');

-- Three models, chosen rather than dumped: the cheapest that can hold a sentence, a mid-size one
-- that can actually reason, and the only Workers AI model that can see. Roughly eighty are
-- available; listing all of them would make the routing catalogue unreadable for no gain.
INSERT OR IGNORE INTO provider_model
  (id, provider_id, model, display_name, capabilities_json, context_window, max_output_tokens)
VALUES
  ('pm_wai_granite', 'prov_workers_ai', '@cf/ibm-granite/granite-4.0-h-micro', 'Granite 4 Micro (cheapest)', '["text-completion"]', 32000, 4096),
  ('pm_wai_qwen',    'prov_workers_ai', '@cf/qwen/qwen3-30b-a3b-fp8',          'Qwen3 30B (cheap and capable)', '["text-completion"]', 32000, 8192),
  ('pm_wai_llama_v', 'prov_workers_ai', '@cf/meta/llama-3.2-11b-vision-instruct', 'Llama 3.2 11B Vision', '["text-completion"]', 16000, 4096);

-- Converted from Cloudflare's neuron rates at $0.011 per 1,000 neurons.
--   granite-4.0-h-micro       1,542 in / 10,158 out neurons per Mtok -> $0.017 / $0.112
--   qwen3-30b-a3b-fp8         4,625 in / 30,475 out                  -> $0.051 / $0.335
--   llama-3.2-11b-vision      4,410 in / 61,493 out                  -> $0.049 / $0.676
-- For comparison, the pinned frontier model is $2.00 / $10.00 — roughly forty times more on input.
INSERT INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, captured_at)
SELECT 'pps_wai_granite', 'prov_workers_ai', '@cf/ibm-granite/granite-4.0-h-micro', 0.017, 0.112, strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE NOT EXISTS (SELECT 1 FROM provider_pricing_snapshot WHERE id = 'pps_wai_granite');

INSERT INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, captured_at)
SELECT 'pps_wai_qwen', 'prov_workers_ai', '@cf/qwen/qwen3-30b-a3b-fp8', 0.051, 0.335, strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE NOT EXISTS (SELECT 1 FROM provider_pricing_snapshot WHERE id = 'pps_wai_qwen');

INSERT INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, captured_at)
SELECT 'pps_wai_llama_v', 'prov_workers_ai', '@cf/meta/llama-3.2-11b-vision-instruct', 0.049, 0.676, strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE NOT EXISTS (SELECT 1 FROM provider_pricing_snapshot WHERE id = 'pps_wai_llama_v');

-- The egress policy has to permit it or routing filters it straight back out. PUBLIC and INTERNAL
-- only, exactly as OpenRouter is permitted — the binding runs on Cloudflare's infrastructure, which
-- is not the same thing as running inside this Worker, and it gets no wider a label for being close.
INSERT OR IGNORE INTO provider_data_policy (id, provider_id, privacy_label, allowed) VALUES
  ('pdp_wai_public',       'prov_workers_ai', 'PUBLIC',         1),
  ('pdp_wai_internal',     'prov_workers_ai', 'INTERNAL',       1),
  ('pdp_wai_restricted',   'prov_workers_ai', 'RESTRICTED',     0),
  ('pdp_wai_lp_private',   'prov_workers_ai', 'LP_PRIVATE',     0),
  ('pdp_wai_confidential', 'prov_workers_ai', 'CONFIDENTIAL',   0),
  ('pdp_wai_mnpi',         'prov_workers_ai', 'MNPI_SENSITIVE', 0);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0081_workers_ai_cheap_tier');

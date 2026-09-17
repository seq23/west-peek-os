-- "i want to be cheapo for everything except the important stuff and with the important stuff u
-- should find a way to use my freemium aspect of the models" — and, asked what must never touch a
-- free tier: "yes LP names and deal terms are confidential."
--
-- Those two sentences pull in opposite directions, and the whole of this migration is resolving
-- that honestly rather than picking one.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- WHY A FREE LANE IS A SEPARATE PROVIDER ROW RATHER THAN A CHEAPER MODEL
--
-- A free route is usually free because the provider may train on what you send it. That is not a
-- quality property, it is a CONFIDENTIALITY property, and this schema already has exactly the right
-- machinery for it: `provider_data_policy`, default-deny, checked in the router before a request is
-- ever formed. So the free lanes are their OWN providers, with their own data policy allowing
-- PUBLIC and nothing else. An INTERNAL-labelled run cannot reach them — not because a caller
-- remembered, but because the egress gate that has always been there refuses it.
--
-- This is the lesson of the sonar incident applied deliberately. Callers used to say "must not be
-- the search model" in an if-statement AFTER the run. A rule enforced after the request has left
-- is not a rule.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- THE TERMS WERE READ, NOT ASSUMED. 17 Sep 2026.
--
-- CLOUDFLARE WORKERS AI — NOT training-permitting. From Cloudflare's own Workers AI "Data usage"
-- page (last updated 21 Apr 2026): "Cloudflare does not use your Customer Content to (1) train any
-- AI model". So Workers AI keeps its INTERNAL data class: it is free capacity that is also safe.
--
-- GOOGLE GEMINI UNPAID QUOTA — training-permitting, and Google says so in terms in the plainest
-- possible words. From the Gemini API Terms: "When you use Unpaid Services ... Google uses the
-- content you submit to the Services and any generated responses to provide, improve, and develop
-- Google products and services and machine learning technologies", "human reviewers may read,
-- annotate, and process your API input and output", and — verbatim — "Do not submit sensitive,
-- confidential, or personal information to the Unpaid Services." The PAID quota is explicitly the
-- opposite: "Google doesn't use your prompts ... or responses to improve our products."
--
-- OPENROUTER :free VARIANTS — treated as training-permitting because it could NOT be established
-- otherwise. OpenRouter's own documentation says each upstream provider has its own logging and
-- training policy, and the public model feed exposes no per-model flag for it. An unestablished
-- term is a term that fails closed. That is the rule, and it is the rule precisely so that nobody
-- has to be right about a vendor's policy from memory.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- WHAT STILL COSTS MONEY, AND WHY THE CEILING CHANGED
--
-- Real billed spend 1–17 Sep: claude-sonnet-5 85 runs / $8.78, perplexity/sonar 90 runs / $0.59,
-- auto 35 runs / $0.02. Sonnet-5 is 93% of the bill at about $0.103 a run.
--
-- `firm_spend_budget` was EMPTY. There was no monthly ceiling at all — only a daily one, and
-- 31 × $2.50 is $77.50, well past the $50 the owner named as her worst case. A budget table with
-- no rows in it is the "runs but inert" defect wearing a reassuring name.

-- ── Free lanes: their own providers, with their own terms ────────────────────────────────────
ALTER TABLE provider_registry ADD COLUMN training_permitted INTEGER NOT NULL DEFAULT 0;

-- The belt to the data policy's braces. The data class stops confidential CONTENT CLASSES; this
-- stops a call the caller has marked confidential even when its label would have been allowed —
-- because "LP names and deal terms" is a fact about the words, and a PUBLIC-labelled summary of a
-- deal still contains the terms.
UPDATE provider_registry SET training_permitted = 0;

INSERT OR IGNORE INTO provider_registry
  (id, provider_key, display_name, enabled, kill_switched, capabilities_json, cost_metadata_json, base_url, training_permitted, firm_scope)
VALUES
  ('prov_openrouter_free', 'openrouter_free', 'OpenRouter (free tier)', 1, 0, '["text-completion"]',
   '{"note":"The same OpenRouter credential and the same adapter, at the :free endpoints. A SEPARATE provider row because the TERMS differ, and terms are what provider_data_policy exists to express. Treated as training-permitting: OpenRouter states each upstream provider sets its own training and logging policy, and the public model feed exposes no per-model flag, so it could not be established otherwise and fails closed."}',
   'https://openrouter.ai', 1, 'west-peek'),

  ('prov_google_free', 'google_free', 'Google Gemini (unpaid quota)', 1, 0, '["text-completion"]',
   '{"note":"The GEMINI_API_KEY unpaid quota. Training-permitting by Google''s own terms, which say in as many words: Do not submit sensitive, confidential, or personal information to the Unpaid Services."}',
   'https://generativelanguage.googleapis.com', 1, 'west-peek');

-- PUBLIC AND NOTHING ELSE. This is the enforcement, and it is the existing default-deny egress gate
-- rather than anything new: a run labelled INTERNAL or above cannot reach either lane, checked
-- before a request is formed.
INSERT OR IGNORE INTO provider_data_policy (id, provider_id, privacy_label, allowed) VALUES
  ('pdp_orfree_public',       'prov_openrouter_free', 'PUBLIC',         1),
  ('pdp_orfree_internal',     'prov_openrouter_free', 'INTERNAL',       0),
  ('pdp_orfree_restricted',   'prov_openrouter_free', 'RESTRICTED',     0),
  ('pdp_orfree_lp',           'prov_openrouter_free', 'LP_PRIVATE',     0),
  ('pdp_orfree_conf',         'prov_openrouter_free', 'CONFIDENTIAL',   0),
  ('pdp_orfree_mnpi',         'prov_openrouter_free', 'MNPI_SENSITIVE', 0),
  ('pdp_orfree_bank',         'prov_openrouter_free', 'BANKING_RESTRICTED', 0),
  ('pdp_gfree_public',        'prov_google_free', 'PUBLIC',         1),
  ('pdp_gfree_internal',      'prov_google_free', 'INTERNAL',       0),
  ('pdp_gfree_restricted',    'prov_google_free', 'RESTRICTED',     0),
  ('pdp_gfree_lp',            'prov_google_free', 'LP_PRIVATE',     0),
  ('pdp_gfree_conf',          'prov_google_free', 'CONFIDENTIAL',   0),
  ('pdp_gfree_mnpi',          'prov_google_free', 'MNPI_SENSITIVE', 0),
  ('pdp_gfree_bank',          'prov_google_free', 'BANKING_RESTRICTED', 0);

-- One model each, chosen for being frontier-class rather than merely free. Both are ACTIVE and both
-- record max_data_class PUBLIC, which is the catalogue saying the same thing as the data policy.
--
-- nemotron-3-ultra-550b-a55b:free — 550B parameters, 1M context, reasoning-capable, $0 in the
-- OpenRouter feed. It is free frontier capacity, which is exactly what the owner asked to be used.
-- gemini-2.5-flash on the unpaid quota is the second, and its id is the one OpenRouter lists for
-- the same model, so it is not a guess.
INSERT OR IGNORE INTO provider_model
  (id, provider_id, model, display_name, capabilities_json, context_window, max_output_tokens,
   supports_tools, supports_reasoning, max_data_class, pricing_state, pricing_source_note,
   pricing_sourced_at, status, registered_by, firm_scope)
VALUES
  ('pm_orfree_nemotron', 'prov_openrouter_free', 'nvidia/nemotron-3-ultra-550b-a55b:free',
   'Nemotron 3 Ultra 550B (free)', '["text-completion"]', 1000000, 8192, 0, 1, 'PUBLIC', 'SOURCED',
   'Read 17 Sep 2026 from the OpenRouter public model feed: prompt 0, completion 0. Free, and free is a price that was read.',
   '2026-09-17T00:00:00.000Z', 'ACTIVE', 'system', 'west-peek'),

  ('pm_gfree_flash', 'prov_google_free', 'gemini-2.5-flash',
   'Gemini 2.5 Flash (unpaid quota)', '["text-completion"]', 1000000, 8192, 0, 1, 'PUBLIC', 'SOURCED',
   'Free on the unpaid quota. The PAID rate for the same model is $0.30/$2.50 per Mtok, read 17 Sep 2026 from the OpenRouter feed entry google/gemini-2.5-flash, which is what a run costs once the free quota is exhausted — and that exhaustion arrives as HTTP 429, which the router treats as an outage and falls through to the paid lane, visibly.',
   '2026-09-17T00:00:00.000Z', 'ACTIVE', 'system', 'west-peek');

INSERT INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, request_usd, captured_at)
SELECT 'pps_0178_nemotron', 'prov_openrouter_free', 'nvidia/nemotron-3-ultra-550b-a55b:free', 0, 0, 0, '2026-09-17T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM provider_pricing_snapshot WHERE id = 'pps_0178_nemotron');

INSERT INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, request_usd, captured_at)
SELECT 'pps_0178_gfree_flash', 'prov_google_free', 'gemini-2.5-flash', 0, 0, 0, '2026-09-17T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM provider_pricing_snapshot WHERE id = 'pps_0178_gfree_flash');

-- ── A monthly ceiling that exists ────────────────────────────────────────────────────────────
-- $50, the worst case the owner named. Not $5: $5 is the TARGET, and a ceiling set at the target
-- stops the firm working in a normal month. The target is watched instead — an alert fires the
-- moment month-to-date passes $5, then again at $25 and $40, so the number is visible long before
-- it binds. See raiseFirmBudgetWarning in src/worker/ai/spend.ts.
INSERT OR IGNORE INTO firm_spend_budget (id, firm_scope, budget_window, cap_cents, version_no, active, reason, set_by)
VALUES ('fsb_0178_monthly', 'west-peek', 'MONTHLY', 5000, 1, 1,
  'The first monthly ceiling this firm has ever had; the table was empty, so only a daily cap existed and 31 x $2.50 is $77.50 — past the $50 the owner named as her worst case. $50 is the ceiling, $5 the target, and the gap between them is watched rather than guessed at.',
  'fu_sequoia_taylor');

-- ── CHEAPO ──────────────────────────────────────────────────────────────────────────────────
-- Appended, not edited: budget_policy is immutable and the latest row wins.
--
-- SAFE TO DO ONLY BECAUSE THE CALL SITES ARE CLASSIFIED FIRST. CHEAPO ignores `preferredModel`,
-- and eight calls pinned the search model that way and marked nothing — so flipping this switch
-- before marking them would have sent every live search to a 3B local model with no web access,
-- which would have answered fluently from memory about this morning's market. Those eight now
-- carry `requiresSearch`, the ten judgement calls and two interpretation calls are unchanged by a
-- cost posture by construction, and `scripts/validate/every-call-is-classified.mjs` fails on a
-- call site that carries no marker at all.
--
-- The caps are the ones already in force and are restated because a new row does not inherit.
-- A COST MIGRATION CHANGES COST. IT DOES NOT CHANGE PRIVACY.
--
-- `budget_policy` rows are immutable and inherit nothing, so writing a new one means restating
-- every column — and restating `privacy_mode` as a literal is how a cost change silently becomes a
-- privacy change. Production is on FRONTIER; a firm that has never been configured is on LOCKDOWN,
-- where no external provider may be used at all. Hard-coding FRONTIER here would switch such a
-- deployment to "external calls are fine" as a side effect of trying to save money, which is not a
-- decision this migration gets to make.
--
-- So the privacy posture, the pin behaviour and the frontier preference are all COPIED from the
-- policy currently in force. Only the two things this migration is actually about — the cost mode
-- and the caps — are stated. And if no policy exists at all, nothing is written: there is no line
-- to amend.
INSERT INTO budget_policy (id, firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, honours_pins, prefers_frontier, set_by)
SELECT 'bp_0178_cheapo', 'west-peek', 'CHEAPO', b.privacy_mode, 2.5, 0.75, b.honours_pins, b.prefers_frontier, 'fu_sequoia_taylor'
  FROM budget_policy b
 WHERE b.firm_scope = 'west-peek'
   AND NOT EXISTS (SELECT 1 FROM budget_policy WHERE id = 'bp_0178_cheapo')
 ORDER BY b.created_at DESC, b.rowid DESC
 LIMIT 1;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0178_free_lanes_a_real_ceiling_and_cheapo');

-- 0022_specialist_providers.sql — P23 Specialist AI provider lane (task §9 P23; GAP-15).
--
-- Newly authorized by the continuation task. Harvey and Norm are registered exactly the way every
-- other provider is: as CONFIGURATION (D9), disabled, with NO data-class allowance, so default-deny
-- means nothing can egress to them until an operator explicitly allows a label.
--
-- The boundary that matters: a specialist vendor is still a provider behind `run_ai()`. There is no
-- second call path, no bypass, and no way for a vendor to return a legal or compliance CONCLUSION —
-- output is quarantined like any other external output, and the reserved actions for legal and
-- compliance conclusions remain human-only.
--
-- Verification note (task §8 GAP-15 asks that official provider requirements be checked before
-- coding): this environment has no network access, no vendor account, and no published contract for
-- either vendor. The adapters therefore implement the generic governed shape and are labelled
-- UNPROVEN — VENDOR ACCESS GATE. No wire format is claimed to match a real vendor API.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0022_specialist_providers');

INSERT OR IGNORE INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('specialist_engagement.open', 'Open a specialist engagement', 'Open a bounded engagement with a specialist AI provider through the governed AI boundary.', 0, 0),
  ('specialist_engagement.accept', 'Accept specialist output', 'Human accept of a quarantined specialist output. Never a legal or compliance conclusion.', 0, 0);

INSERT OR IGNORE INTO provider_registry (id, provider_key, display_name, enabled, kill_switched, capabilities_json, cost_metadata_json, base_url) VALUES
  ('prov_harvey', 'harvey', 'Harvey (legal specialist)', 0, 0, '["text-completion","legal-research"]',
   '{"note":"Specialist vendor registered as configuration (D9). No account, credential, contract, or published API contract is available in this environment."}', NULL),
  ('prov_norm', 'norm', 'Norm (compliance specialist)', 0, 0, '["text-completion","compliance-review"]',
   '{"note":"Specialist vendor registered as configuration (D9). No account, credential, contract, or published API contract is available in this environment."}', NULL);

-- No provider_data_policy rows: default-deny means NOTHING may egress to either vendor until an
-- operator allows a specific label. Registering a vendor grants it no data.

INSERT OR IGNORE INTO provider_model
  (id, provider_id, model, display_name, capabilities_json, max_data_class, pricing_state, pricing_source_note, status, registered_by)
VALUES
  ('pm_harvey_default', 'prov_harvey', 'harvey-default', 'Harvey default', '["text-completion","legal-research"]', 'CONFIDENTIAL', 'UNKNOWN',
   'No vendor pricing has been obtained. This model is unpriced, so the cost preflight refuses it.', 'BENCH', 'system'),
  ('pm_norm_default', 'prov_norm', 'norm-default', 'Norm default', '["text-completion","compliance-review"]', 'CONFIDENTIAL', 'UNKNOWN',
   'No vendor pricing has been obtained. This model is unpriced, so the cost preflight refuses it.', 'BENCH', 'system');

-- An engagement is a bounded question put to a specialist lane. It records the matter, the data
-- class, the governed run, and the disposition — and it can never record a conclusion as the
-- firm's own.
CREATE TABLE IF NOT EXISTS specialist_engagement (
  id             TEXT PRIMARY KEY,
  provider_key   TEXT NOT NULL,
  matter_type    TEXT NOT NULL CHECK (matter_type IN ('LEGAL_RESEARCH','CONTRACT_REVIEW','COMPLIANCE_REVIEW','POLICY_QUESTION')),
  question       TEXT NOT NULL,
  data_class     TEXT NOT NULL DEFAULT 'INTERNAL',
  status         TEXT NOT NULL DEFAULT 'OPENED'
                 CHECK (status IN ('OPENED','BLOCKED','RETURNED_QUARANTINED','ACCEPTED_AS_INPUT','CLOSED')),
  block_reason   TEXT,
  ai_run_id      TEXT REFERENCES ai_run (id),
  accepted_by    TEXT,
  accepted_at    TEXT,
  -- Deliberately named: whatever comes back is an INPUT to a human decision, never a conclusion.
  disposition_note TEXT NOT NULL DEFAULT '',
  opened_by      TEXT NOT NULL,
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_specialist_engagement ON specialist_engagement (provider_key, status, created_at DESC);

-- There is no `conclusion` column, and there never will be: legal.final_conclusion and
-- compliance.act_as_officer are human-reserved actions in the canon register.

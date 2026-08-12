# migrations

D1 migrations, applied in filename order by `wrangler d1 migrations apply` (local:
`npm run migrate:local`). Additive-first; defensive (`IF NOT EXISTS`, `INSERT OR IGNORE`);
wrangler tracks applied files in `d1_migrations`, so re-application is a no-op.

The set matches the approved plan §9.2 migration sequence, one file per phase:

- `0001_runtime_identity.sql` — schema_version, firm_user, role, firm_user_role,
  authority_scope, append-only event_record (D15 triggers), seeded roles + Managing
  Partner users. Table convention: lowercase snake_case.
- `0002_company_fund_policy.sql` — canonical_company, aliases, external identities,
  person, merge/split receipts, fund, fund_entity, and the four **immutable** policy
  version tables (mandate/sleeve/reserve/concentration): UPDATE and DELETE are
  rejected for every role, so a policy change is a new version, never a rewrite.
- `0003_work_authority_approval.sql` — capture, work_card, action_type,
  human_reserved_action, approval_card/decision, external_effect_request,
  governance_update, plus the **generated seeds** section (machines, domains, reserved
  actions, action types) written by `scripts/seed/generate-machine-seed.mjs` from the
  TypeScript registry (D14 — one source). Do not hand-edit that section.
- `0004_ai_cost_privacy.sql` — ai_employee (+status history, tool scopes), ai_run,
  cost/usage, immutable budget_policy (carries cost AND privacy mode, ADR-010),
  provider registry/pricing/data policy, eval records.
- `0005_evidence_documents.sql` — document/document_version (R2-backed),
  diligence_claim with the self-promotion CHECK, claim_source, contradiction_record,
  knowledge promotion/records, source conflicts and resolutions (D16).
- `0006_investment_transaction_position.sql` — investment_opportunity, transaction and
  parties, security_class, position, ownership_snapshot, pricing_observation,
  deal_math_packet/assumptions, ic_packet/decision/dissent.
- `0007_meetings.sql` — meeting, participants, consent_record, transcript_import,
  notes, commitments, debrief.
- `0008_portfolio_support.sql` — metric definitions/snapshots, portfolio_alert,
  suppression rules, portfolio_update, support request/match/outcome.
- `0009_network_adapter.sql` — adapter contract versions, sync cursors, external
  mappings, network_conflict, sync receipts (D5 — no relationship tables here).
- `0010_lp_dataroom.sql` — lp_record/contact links/opportunity/diligence,
  lp_claim + lp_claim_evidence, data_room_artifact and the append-only
  access/revocation ledger.
- `0011_allocation.sql` — fund_construction_scenario (pins all four policy versions +
  the model version), append-only scenario_assumption, capital_allocation_option,
  immutable comparison runs/results/constraint_violation, reserve_allocation,
  follow_on_review.
- `0012_reporting_reconciliation.sql` — lp_reporting_period/packet, reporting_review
  rows, append-only distribution_receipt, immutable fund_reconciliation_run,
  fund_reconciliation_exception (values frozen by trigger — only `status` may change),
  append-only reconciliation_resolution.

## Trigger convention

Append-only and immutability are enforced **in the database**, not only in services, so
they hold for every actor including a Managing Partner and including direct SQL. The one
place that legitimately needs them off is `restore.mjs`, which drops and re-creates them
around a reload and verifies the full set is back (ADR-015).

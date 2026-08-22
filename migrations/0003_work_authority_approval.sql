-- 0003_work_authority_approval.sql — P3 work spine + authority substrate.
-- Convention: lowercase snake_case table names (P1). Defensive by construction:
-- CREATE TABLE IF NOT EXISTS / INSERT OR IGNORE so re-application is a no-op.
-- Every firm-data table carries firm_scope TEXT NOT NULL DEFAULT 'west-peek' (§11.7).
--
-- Reference-data seeds (domain, machine, action_type, human_reserved_action) are
-- GENERATED from the single TypeScript registry sources (D14) by:
--   node scripts/seed/generate-machine-seed.mjs
-- Do not hand-edit between the GENERATED SEEDS markers; edit the registry and re-run.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0003_work_authority_approval');

-- ── Reference data: domains + machines (one registry source, D14) ──

CREATE TABLE IF NOT EXISTS domain (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS machine (
  id                INTEGER PRIMARY KEY,
  key               TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  domain_id         TEXT NOT NULL REFERENCES domain (id),
  purpose           TEXT NOT NULL,
  in_initial_scope  INTEGER NOT NULL DEFAULT 0
);

-- ── Action vocabulary + human-reserved register ──

CREATE TABLE IF NOT EXISTS action_type (
  key                TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL,
  is_external_effect INTEGER NOT NULL DEFAULT 0,
  is_reserved        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS human_reserved_action (
  key                 TEXT PRIMARY KEY,
  category            TEXT NOT NULL,
  description         TEXT NOT NULL,
  approver_roles_json TEXT NOT NULL
);

-- BEGIN GENERATED SEEDS (scripts/seed/generate-machine-seed.mjs) — do not hand-edit
-- Registry provenance: machines v3.2.14+wp1 (canon §5A.2), reserved-action register v3.2.14 §3.1–3.4.

-- Domains (canon §0C 15-domain map, order preserved):
INSERT OR IGNORE INTO domain (id, name) VALUES
  ('COMMAND_MP_OFFICE', 'Command MP Office'),
  ('OPPORTUNITY_INTELLIGENCE', 'Opportunity Intelligence'),
  ('GOVERNANCE', 'Governance'),
  ('RELATIONSHIP_OS', 'Relationship OS'),
  ('COMMUNITY_OS', 'Community OS'),
  ('INVESTMENT_OS', 'Investment OS'),
  ('PORTFOLIO_OS', 'Portfolio OS'),
  ('FUNDRAISING_LP_OS', 'Fundraising LP OS'),
  ('EVENT_OS', 'Event OS'),
  ('KNOWLEDGE_OS', 'Knowledge OS'),
  ('FINANCE_OS', 'Finance OS'),
  ('LEGAL_COMPLIANCE_OS', 'Legal Compliance OS'),
  ('BUILDER_SYSTEMS_OS', 'Builder Systems OS'),
  ('BRAND_MARKETING_OS', 'Brand Marketing OS'),
  ('OPERATIONS_OS', 'Operations OS');

-- Machines (1–46: canon rows 1–45 plus West Peek's own row 46, in registry order).
-- Retired machines are seeded too: work_card and ai_run_attribution point at them, and a
-- row that vanished would orphan them. `ACTIVE_MACHINES` is what may take new work.
INSERT OR IGNORE INTO machine (id, key, name, domain_id, purpose, in_initial_scope) VALUES
  (1, 'command_center', 'Command Center Machine', 'COMMAND_MP_OFFICE', 'Calm daily operating surface for each MP: priorities, meetings, approvals, capture, activity, system health.', 1),
  (2, 'mp_personal_office', 'Managing Partner Personal Office Machines', 'COMMAND_MP_OFFICE', 'Scoped personal support for each MP; private assistant interactions unless promoted into firm work.', 0),
  (3, 'global_capture_routing', 'Global Capture + Routing Machine', 'OPERATIONS_OS', 'Accepts unstructured input (+Capture, assistants, email, meetings, mobile, field) and routes to the right machine.', 1),
  (4, 'governance_center_broadcast', 'Governance Center + AI Workforce Broadcast Machine', 'GOVERNANCE', 'MP-issued rules, bulletins, context notes, vendor updates, firm-wide workforce messages.', 1),
  (5, 'approval_center', 'Approval Center Machine', 'GOVERNANCE', 'Centralizes all actions requiring human judgment — external comms, compliance-sensitive work, material decisions.', 1),
  (6, 'activity_audit_ledger', 'Activity Feed + Audit Ledger Machine', 'GOVERNANCE', 'Recent operational activity with privacy boundaries; durable proof for firm-relevant events.', 1),
  (7, 'developer_diagnostics', 'Developer Diagnostics + Debug Copilot Machine', 'BUILDER_SYSTEMS_OS', 'Logs, traces, API diagnostics, permission explanations, memory diagnostics, AI-assisted repair guidance.', 1),
  (8, 'relationship_intelligence', 'Relationship Intelligence Machine', 'RELATIONSHIP_OS', 'Relationship memory, context, connection intelligence, warm paths; Network OS is source of truth.', 1),
  (9, 'network_os_sync_verification', 'Network OS Sync + Verification Machine', 'RELATIONSHIP_OS', 'Shared IDs, sync health, record consistency, conflict review between West Peek OS and Network OS.', 1),
  (10, 'relationship_capital_budget', 'Relationship Capital Budget Machine', 'RELATIONSHIP_OS', 'Tracks recent asks, value given/received, trust, overuse risk, cooldowns.', 0),
  (11, 'lp_fundraising', 'LP Fundraising Machine', 'FUNDRAISING_LP_OS', 'LP pipeline, records, warm paths, outreach drafts, meeting prep.', 1),
  (12, 'lp_diligence_request', 'LP Diligence Request Machine', 'FUNDRAISING_LP_OS', 'LP material requests → governed workflows with approved documents, compliance review, access tracking.', 1),
  (13, 'lp_proof_engine', 'LP Proof Engine Machine', 'FUNDRAISING_LP_OS', 'Converts real operating work into LP-safe evidence of platform value.', 1),
  (14, 'data_room_control', 'Data Room Control Machine', 'FUNDRAISING_LP_OS', 'Internal document vault + external VDR use; no native external-facing data room in v1.', 1),
  (15, 'early_stage_deal', 'Early-Stage Deal Machine', 'INVESTMENT_OS', 'Founder/deal intake, pipeline, mandate fit, diligence, meeting prep, IC readiness (pre-seed/seed).', 1),
  (16, 'secondaries_investment', 'Secondaries Investment Machine', 'INVESTMENT_OS', 'Series C+ secondaries; strict brokerage/fund separation and confidentiality controls.', 1),
  (17, 'investment_mandate_exclusion', 'Investment Mandate + Exclusion Machine', 'INVESTMENT_OS', 'Scope, exclusion, fast-no, watchlist, venture-scale, founder-quality, market-quality tests.', 1),
  (18, 'ic_decision', 'IC Decision Machine', 'INVESTMENT_OS', 'Internal investment-decision workflows: evidence, dissent, decision capture, final rationale.', 1),
  (19, 'venturedeals_deal_math', 'VentureDeals / Deal Math Machine', 'INVESTMENT_OS', 'Deal-level math workbench for primary, secondary, and fund math before IC decisions proceed.', 1),
  (20, 'ic_learning_loop', 'IC Learning Loop Machine', 'INVESTMENT_OS', 'Reviews assumptions vs. outcomes at 3/6/12/24 months and follow-on/exit/shutdown events.', 0),
  (21, 'meeting_intelligence', 'Meeting Intelligence Machine', 'OPERATIONS_OS', 'Meeting workspace: prep/live/debrief, follow-ups, memory routing.', 1),
  (22, 'meeting_capture_adapter', 'Meeting Capture Adapter Machine', 'OPERATIONS_OS', 'External capture/transcription providers; transcripts are inputs, not truth.', 1),
  (23, 'research_intelligence', 'Research & Intelligence Machine', 'KNOWLEDGE_OS', 'Public/paid/proprietary/human-sourced data → evidence-linked claims, signals, maps, memos.', 1),
  (24, 'research_data_license_quality', 'Research Data License + Quality Machine', 'KNOWLEDGE_OS', 'Governs what third-party/internal data can be stored, processed, reused, exported, surfaced to LPs.', 0),
  (25, 'source_of_truth_resolver', 'Source-of-Truth Resolver Machine', 'KNOWLEDGE_OS', 'Resolves conflicts across Network OS, Drive, email, calendar, provider data, meeting notes, human input.', 1),
  (26, 'knowledge_memory_promotion', 'Knowledge OS / Memory Promotion Machine', 'KNOWLEDGE_OS', 'Promotes approved info into durable institutional memory with provenance, versioning, confidence.', 1),
  (27, 'portfolio_support', 'Portfolio Support Machine', 'PORTFOLIO_OS', 'Founder/portfolio asks → support requests, service levels, support plans, approvals, outcome records.', 1),
  (28, 'portfolio_performance_followon', 'Portfolio Performance + Follow-On Decision Machine', 'PORTFOLIO_OS', 'Detects winners, KPIs/signals, pro-rata/follow-on decisions, capital allocation link.', 1),
  (29, 'fund_construction_allocation', 'Fund Construction + Capital Allocation Machine', 'INVESTMENT_OS', 'Fund construction, deployment pacing, ownership, reserve strategy, concentration, exposure.', 1),
  (30, 'west_peek_live_events', 'West Peek Live / Events Machine', 'EVENT_OS', 'Events, portfolio programming, sponsor workflows, event-to-value loops.', 0),
  (31, 'community_intelligence', 'Community Intelligence Machine', 'COMMUNITY_OS', 'Segmentation, programming, founder support signals, community-powered investing evidence.', 0),
  (32, 'brand_sponsorship_revenue', 'Brand Sponsorship + Experiential Revenue Machine', 'BRAND_MARKETING_OS', 'Sponsor discovery/fit/proposals, event sponsorships, revenue tracking.', 0),
  (33, 'marketing_pr_content', 'Marketing / PR / Content Machine', 'BRAND_MARKETING_OS', 'External-facing content, PR drafts, founder/LP-safe materials, brand assets.', 0),
  (34, 'taste_layer', 'West Peek Taste Layer Machine', 'BRAND_MARKETING_OS', 'Reviews outputs for West Peek voice, warmth, LP credibility, anti-generic quality.', 0),
  (35, 'finance_fund_admin', 'Finance / Fund Admin Machine', 'FINANCE_OS', 'Finance support, fund admin handoffs, reporting, entity records, treasury/banking, operating metrics.', 1),
  (36, 'legal_compliance_rules', 'Legal / Compliance Rules Machine', 'LEGAL_COMPLIANCE_OS', 'Detects/blocks/routes/logs compliance-sensitive actions: brokerage/fund separation, MNPI, LP marketing claims, conflicts.', 1),
  (37, 'external_helper_coordination', 'External Helper / Provider Coordination Machine', 'OPERATIONS_OS', 'Coordinates lawyers, fund admins, CPAs, auditors, banks, vendors — without making them internal AI employees.', 0),
  (38, 'vendor_risk_build_vs_buy', 'Vendor Risk + Build-vs-Buy Machine', 'BUILDER_SYSTEMS_OS', 'Vendor evaluation, API availability, security, export paths, cost, canonical-source risk.', 0),
  (39, 'systems_data_integration', 'Systems, Data, and Integration Machine', 'BUILDER_SYSTEMS_OS', 'System configuration, integrations, webhooks, APIs, sync jobs, model routing infrastructure.', 1),
  (40, 'model_governance_privacy_airlock', 'Model Governance + Privacy Airlock Machine', 'GOVERNANCE', 'Local/Frontier/Lockdown modes, outbound/inbound airlocks, redaction, sanitization, model ledgers, kill switches.', 1),
  (41, 'ai_employee_performance_lifecycle', 'AI Employee Performance + Cost Ledger + Lifecycle Control Machine', 'GOVERNANCE', 'Agent quality/cost/errors, lifecycle status, pause/restrict/retrain/retire recommendations.', 1),
  (42, 'prompt_enhancer_intent', 'Prompt Enhancer + Intent-to-Execution Machine', 'COMMAND_MP_OFFICE', 'Messy human intent → better prompts, machine assignments, privacy-safe prompts, prompt library.', 0),
  (43, 'builder_repo_product', 'Builder / Repo / Product Machine', 'BUILDER_SYSTEMS_OS', 'Canonical plans → code, repo work, implementation contracts, validation matrices, snapshot-first delivery.', 1),
  (44, 'continuity_maintenance', 'Continuity + System Maintenance Machine', 'OPERATIONS_OS', 'Emergency sovereignty, backups, offline/reduced modes, continuity drills, failure playbooks.', 1),
  (45, 'opportunity_radar_strategic_initiative', 'Opportunity Radar + Strategic Initiative Machine', 'OPPORTUNITY_INTELLIGENCE', 'AI-surfaced opportunities and Opportunity Briefs; separates opportunity review from workflow approval. (Proactive radar deferred P13+; record type exists.)', 0),
  (46, 'venture_teaching', 'Venture Teaching Machine', 'KNOWLEDGE_OS', 'West Peek University: teaching venture to the partners themselves — explanation at a chosen depth, assessment that marks honestly, and case work run against real firm decisions rather than invented companies.', 0);

-- Action types: human-reserved register first (is_reserved=1), then ordinary
-- internal actions, then external-effect action keys (is_external_effect=1).
INSERT OR IGNORE INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('investment.approve', 'investment.approve', 'Approve or reject an investment.', 0, 1),
  ('investment.final_conviction', 'investment.final_conviction', 'Determine final conviction.', 0, 1),
  ('investment.founder_character_judgment', 'investment.founder_character_judgment', 'Make final founder-character judgments.', 0, 1),
  ('investment.reference_call_final_truth', 'investment.reference_call_final_truth', 'Interpret reference calls as final truth.', 0, 1),
  ('valuation.approve', 'valuation.approve', 'Approve valuation.', 0, 1),
  ('scenario_probabilities.approve', 'scenario_probabilities.approve', 'Approve scenario probabilities.', 0, 1),
  ('ownership_targets.approve', 'ownership_targets.approve', 'Approve ownership targets.', 0, 1),
  ('reserve_allocation.approve', 'reserve_allocation.approve', 'Approve reserve allocations.', 0, 1),
  ('capital_allocation_cross_sleeve.approve', 'capital_allocation_cross_sleeve.approve', 'Approve capital allocation across sleeves.', 0, 1),
  ('follow_on.approve', 'follow_on.approve', 'Approve follow-on participation.', 0, 1),
  ('secondary_purchase.approve', 'secondary_purchase.approve', 'Approve a secondary purchase.', 0, 1),
  ('secondary_sale.approve', 'secondary_sale.approve', 'Approve a secondary sale.', 0, 1),
  ('exit.approve', 'exit.approve', 'Approve a partial or full exit.', 0, 1),
  ('fund_strategy.change', 'fund_strategy.change', 'Change the fund strategy.', 0, 1),
  ('sleeve_targets.change', 'sleeve_targets.change', 'Change sleeve targets.', 0, 1),
  ('concentration_limits.change', 'concentration_limits.change', 'Change concentration limits.', 0, 1),
  ('capital.move_or_commit', 'capital.move_or_commit', 'Move or commit capital.', 0, 1),
  ('wire.initiate_or_authorize', 'wire.initiate_or_authorize', 'Initiate or authorize wire instructions.', 0, 1),
  ('legal.final_conclusion', 'legal.final_conclusion', 'Issue final legal conclusions.', 0, 1),
  ('legal.act_as_counsel', 'legal.act_as_counsel', 'Act as legal counsel.', 0, 1),
  ('compliance.act_as_officer', 'compliance.act_as_officer', 'Act as the compliance officer.', 0, 1),
  ('communications.fund_or_brokerage.approve', 'communications.fund_or_brokerage.approve', 'Approve fund or brokerage communications.', 0, 1),
  ('conflict_of_interest.resolve', 'conflict_of_interest.resolve', 'Resolve conflicts of interest.', 0, 1),
  ('mnpi.treatment_determine', 'mnpi.treatment_determine', 'Determine MNPI treatment.', 0, 1),
  ('regulatory_interpretation.approve', 'regulatory_interpretation.approve', 'Approve regulatory interpretations.', 0, 1),
  ('sponsor_disclosure.approve', 'sponsor_disclosure.approve', 'Approve sponsor disclosures.', 0, 1),
  ('legal_document_execution.approve', 'legal_document_execution.approve', 'Approve legal documents for execution.', 0, 1),
  ('lp_marketing_claim.approve', 'lp_marketing_claim.approve', 'Approve LP marketing claims.', 0, 1),
  ('review.waive_required', 'review.waive_required', 'Waive required counsel, compliance, or registered-person review.', 0, 1),
  ('lp.promise', 'lp.promise', 'Make promises to LPs.', 0, 1),
  ('fund_terms.commit', 'fund_terms.commit', 'Commit fund terms.', 0, 1),
  ('lp_sensitive_communication.send', 'lp_sensitive_communication.send', 'Send sensitive LP communications.', 0, 1),
  ('capital_call.issue', 'capital_call.issue', 'Issue capital calls.', 0, 1),
  ('distribution.approve', 'distribution.approve', 'Approve distributions.', 0, 1),
  ('bank_account.change', 'bank_account.change', 'Change bank accounts.', 0, 1),
  ('payment_instruction.approve', 'payment_instruction.approve', 'Approve payment instructions.', 0, 1),
  ('official_valuation_or_capital_account.change', 'official_valuation_or_capital_account.change', 'Change official valuations or capital accounts.', 0, 1),
  ('fund_admin_record.override', 'fund_admin_record.override', 'Override the fund administrator, accountant, auditor, or authorized finance operator.', 0, 1),
  ('financial_statement.certify', 'financial_statement.certify', 'Certify financial statements or performance metrics.', 0, 1),
  ('introduction.relationship_sensitive', 'introduction.relationship_sensitive', 'Make relationship-sensitive introductions.', 0, 1),
  ('external_contact.unauthorized', 'external_contact.unauthorized', 'Contact founders, LPs, brokers, buyers, sellers, sponsors, or portfolio companies without authority.', 0, 1),
  ('public_statement.material', 'public_statement.material', 'Make material public statements.', 0, 1),
  ('promise.access_or_outcome', 'promise.access_or_outcome', 'Promise access, introductions, capital, liquidity, or outcomes.', 0, 1),
  ('portfolio_termination_advice.final', 'portfolio_termination_advice.final', 'Provide portfolio-company termination advice as final guidance.', 0, 1),
  ('mp.impersonate', 'mp.impersonate', 'Impersonate a Managing Partner.', 0, 1),
  ('identity_merge.execute', 'identity_merge.execute', 'Execute a destructive canonical-company merge.', 0, 1),
  ('governance.policy_change', 'governance.policy_change', 'Change firmwide cost/privacy/provider policy.', 0, 1),
  ('ai_employee.activate', 'ai_employee.activate', 'Activate or reactivate an AI employee.', 0, 1),
  ('external_effect.execute', 'external_effect.execute', 'Execute any external effect (send, publish, write to external system).', 0, 1),
  ('knowledge.promote', 'knowledge.promote', 'Promote evidence into durable institutional memory (knowledge_record).', 0, 1),
  ('transaction.void', 'transaction.void', 'Void a transaction (reverses its position effect; the record is preserved).', 0, 1),
  ('meeting.recording_policy.activate', 'meeting.recording_policy.activate', 'Activate recording/transcription policy for a meeting (human-reserved gate).', 0, 1),
  ('network_os.writeback', 'network_os.writeback', 'Write a West Peek OS record back into Network OS (live integration is a named human gate).', 0, 1),
  ('capture.create', 'Create capture', 'Record unstructured input into the capture intake.', 0, 0),
  ('capture.route', 'Route capture', 'Route a capture to a machine.', 0, 0),
  ('capture.resolve', 'Resolve capture', 'Say what a capture is about — a company, a person, or neither — and reconcile it against the register or Network OS.', 0, 0),
  ('capture.archive', 'Archive capture', 'Archive a capture without routing.', 0, 0),
  ('work_card.create', 'Create work card', 'Create a unit of governed work, optionally from a capture.', 0, 0),
  ('standing_authority.grant', 'Delegate an approval ahead of time', 'Grant standing authority for one action, bounded by a use count and an expiry. Can never cover a reserved action or an external effect — those come back to a partner every time.', 0, 0),
  ('work_card.update', 'Update work card', 'Change work-card state, owner, priority, or next action.', 0, 0),
  ('approval.request', 'Request approval', 'Draft or submit an approval card for a governed action.', 0, 0),
  ('approval.decide', 'Decide approval', 'Approve, reject, or request revision on a pending approval card (human with required role only).', 0, 0),
  ('approval.reopen', 'Change a decision already made', 'Record a new decision that supersedes an earlier one on the same card, with a required reason. The original decision is never edited or erased, and something already carried out can never be reopened.', 0, 0),
  ('approval.block', 'Block an approval', 'Stop an approval proceeding until a named blocker is resolved. Unlike a rejection this is not a verdict on the request: it names what the firm is waiting for, and it can be released.', 0, 0),
  ('approval.block_release', 'Release a block', 'Record that what an approval was waiting on is resolved, returning the card to exactly the state it was in when the block landed.', 0, 0),
  ('governance_update.issue', 'Issue governance update', 'Issue an MP rule, bulletin, or broadcast to the firm.', 0, 0),
  ('ai.run', 'Run AI task', 'Run an AI task through the governed run_ai boundary (privacy/cost/egress pipeline).', 0, 0),
  ('ai_employee.tool_scope.grant', 'Grant AI tool scope', 'Grant a tool to an AI employee. An employee can never grant scope to itself.', 0, 0),
  ('ai_output.accept', 'Accept quarantined AI output', 'Promote a quarantined external-provider AI output into governed state (human only).', 0, 0),
  ('image.generate', 'Generate an image', 'Turn a prompt into a picture and file it in Documents. Nothing leaves the firm but the prompt; publishing the result is a separate, approved act.', 0, 0),
  ('deliverable.deliver', 'Hand over a deliverable', 'Record something an employee produced — a brief, a review, a research packet — and file a copy in Documents.', 0, 0),
  ('deliverable.email_self', 'Email a deliverable to a partner', 'Send a deliverable to a Managing Partner''s own registered address. Cannot reach any address outside the firm.', 0, 0),
  ('document.upload', 'Upload document', 'Store a governed document binary in R2 with D1 metadata/provenance and a SHA-256 version row.', 0, 0),
  ('claim.create', 'Create diligence claim', 'Record a diligence claim with mandatory source provenance (source/date/location/method/confidence/status).', 0, 0),
  ('claim.extract', 'Extract claims from document', 'Run AI extraction over a document through the run_ai boundary; candidates land AI_INFERRED/UNVERIFIED, quarantined until human accept.', 0, 0),
  ('claim.verify', 'Verify claim', 'Set a claim VERIFIED (human only, requires a DOCUMENT or HUMAN_STATEMENT source; the self-promotion ban is structural).', 0, 0),
  ('claim.accept', 'Accept extracted claim', 'Human accept of an AI-extracted (quarantined) claim with a qualifying source; re-attributes the claim to the accepting human.', 0, 0),
  ('claim.supersede', 'Supersede claim', 'Replace a claim with a new one; the superseded claim stays readable and linked.', 0, 0),
  ('contradiction.create', 'Create contradiction', 'Open a contradiction record between conflicting claims (AI may propose; it enters OPEN with proposed-by recorded).', 0, 0),
  ('contradiction.update', 'Update contradiction', 'Assign an owner or move a contradiction to INVESTIGATING.', 0, 0),
  ('contradiction.resolve', 'Resolve contradiction', 'Human-only disposition of a contradiction (RESOLVED/ACCEPTED_RISK/INVALID) with evidence.', 0, 0),
  ('knowledge_promotion.propose', 'Propose knowledge promotion', 'Propose promoting claims into durable institutional memory; creates an approval card (humans decide).', 0, 0),
  ('source_conflict.create', 'Create source conflict', 'Record a cross-system source-of-truth conflict.', 0, 0),
  ('source_conflict.resolve', 'Resolve source conflict', 'Resolve a source conflict with an append-only resolution decision (human only).', 0, 0),
  ('security_class.create', 'Create security class', 'Record a distinct share class for a canonical company (classes are never merged).', 0, 0),
  ('opportunity.create', 'Create opportunity', 'Record an investment opportunity on a canonical company (secondaries keep seller/block provenance).', 0, 0),
  ('opportunity.update', 'Update opportunity', 'Update opportunity fields (price, quantity, fees, terms, provenance).', 0, 0),
  ('opportunity.transition', 'Transition opportunity', 'Move an opportunity through its lifecycle (NEW→SCREENING→DILIGENCE→IC_READY→IC_DECIDED→CLOSED, or PASS/WITHDRAWN).', 0, 0),
  ('opportunity.confirm_placeholder', 'Confirm placeholder value', 'Replace a value recorded as a provisional stand-in with the real one. Works on terminal records, but only for fields already marked provisional.', 0, 0),
  ('opportunity.backfill', 'Backfill opportunity', 'Record a holding that predates the system by placing its status directly, permanently marked as backfilled with a reason. Separate from transition so authority over history is grantable on its own.', 0, 0),
  ('opportunity_block_link.propose', 'Propose block link', 'Link two opportunities as duplicate candidates or related blocks. Linking never merges.', 0, 0),
  ('opportunity_block_link.decide', 'Decide block link', 'Human confirm/reject of a proposed duplicate/related block link (human only).', 0, 0),
  ('transaction.create', 'Create transaction', 'Draft a transaction (PURCHASE/SALE/PRIMARY_INVESTMENT/FOLLOW_ON/EXIT_*); approval via the type-specific reserved action.', 0, 0),
  ('transaction.execute', 'Execute transaction', 'Mark an approved transaction EXECUTED with a valid reserved-action receipt; creates/updates positions.', 0, 0),
  ('transaction.party.add', 'Add transaction party', 'Attach a seller/buyer/broker/fund-entity party to a transaction.', 0, 0),
  ('ownership_snapshot.create', 'Create ownership snapshot', 'Record an as-of ownership snapshot with dilution assumptions and source.', 0, 0),
  ('pricing_observation.create', 'Create pricing observation', 'Record a pricing observation (BID/ASK/INDICATION/EXECUTED_TRANSACTION/PRIMARY_ROUND/INTERNAL_ESTIMATE — statuses stay distinct).', 0, 0),
  ('deal_math_packet.create', 'Create deal math packet', 'Create a deal math packet by manual entry (D6: manual entry is always supported).', 0, 0),
  ('deal_math_packet.update', 'Update deal math packet', 'Change packet inputs/assumptions; every change appends to the assumption ledger.', 0, 0),
  ('deal_math.calculate', 'Calculate deal math', 'Run the independently verified deal-math functions over packet inputs (entry_mode=CALCULATED).', 0, 0),
  ('deal_math_packet.review', 'Review deal math packet', 'Human review transition of a packet''s math quality status.', 0, 0),
  ('ic_packet.assemble', 'Assemble IC packet', 'Assemble an IC packet: deal math + evidence summary + unresolved material contradictions (never filtered). AI may draft; humans decide.', 0, 0),
  ('dissent.create', 'Record dissent', 'Attach a dissent record to an IC decision (append-only).', 0, 0),
  ('ic_packet.question.raise', 'Name a gap in the IC packet', 'Record something the packet does not know as a question, with what was looked at and who owes the answer. Naming a gap is never the same as filling it in.', 0, 0),
  ('ic_packet.question.answer', 'Answer or withdraw an IC question', 'Answer an open question on an IC packet, or withdraw one the firm decided it does not need, with a reason. Withdrawing is recorded as withdrawing and never as answered.', 0, 0),
  ('meeting.create', 'Create meeting', 'Record a meeting (scheduled or historical) with its participants.', 0, 0),
  ('meeting.update', 'Update meeting', 'Update meeting fields or lifecycle status.', 0, 0),
  ('meeting.participant.add', 'Add meeting participant', 'Attach an internal or external participant to a meeting.', 0, 0),
  ('meeting.consent.record', 'Record consent', 'Append a consent state for recording/transcription/note-sharing (human only; append-only).', 0, 0),
  ('meeting.prep.assemble', 'Assemble meeting prep packet', 'Assemble a prep packet from company evidence and open questions. AI may draft.', 0, 0),
  ('meeting.transcript.import', 'Import transcript', 'Import a transcript for a meeting. Requires an activated recording policy AND granted consent.', 0, 0),
  ('meeting.note.add', 'Add meeting note', 'Add a manual, off-record, or transcript-derived meeting note.', 0, 0),
  ('meeting.commitment.create', 'Record meeting commitment', 'Record a commitment made in a meeting.', 0, 0),
  ('meeting.commitment.convert', 'Convert commitment to work card', 'Turn a meeting commitment into a governed work card.', 0, 0),
  ('meeting.debrief.create', 'Create meeting debrief', 'Record a post-meeting debrief. AI may draft; it is never evidence by itself.', 0, 0),
  ('meeting.debrief.promote_claim', 'Promote debrief line to claim candidate', 'Create a diligence claim candidate from a debrief/note with TRANSCRIPT/HUMAN_STATEMENT provenance (never VERIFIED).', 0, 0),
  ('portfolio_metric_definition.create', 'Define portfolio metric', 'Define a tracked portfolio metric with its direction and operator-set severity bands.', 0, 0),
  ('portfolio_metric_snapshot.create', 'Record metric snapshot', 'Record a dated portfolio metric value with its source.', 0, 0),
  ('portfolio_update.create', 'Record portfolio update', 'Record a received portfolio update for a period.', 0, 0),
  ('portfolio_alert.evaluate', 'Evaluate portfolio alerts', 'Run the deterministic alert evaluation (deterioration, stale update, missing metric).', 0, 0),
  ('portfolio_alert.decide', 'Decide portfolio alert', 'Acknowledge or resolve an alert (human disposition).', 0, 0),
  ('alert_suppression_rule.create', 'Create alert suppression rule', 'Suppress low-severity noise; a suppression can never hide a higher severity.', 0, 0),
  ('support_request.create', 'Create support request', 'Record a portfolio-company support request.', 0, 0),
  ('support_match.propose', 'Propose support match', 'Propose a match for a support request (AI may propose; it can never contact anyone).', 0, 0),
  ('support_match.decide', 'Decide support match', 'Human accept/reject of a proposed support match. Acting on it still needs the reserved introduction approval.', 0, 0),
  ('support_outcome.record', 'Record support outcome', 'Record what actually happened after support, including relationship and value notes.', 0, 0),
  ('network_adapter_contract.declare', 'Declare adapter contract', 'Publish a versioned Network OS adapter contract (ownership, direction, keys, freshness, conflict, idempotency, retry, audit, failure).', 0, 0),
  ('network_sync.pull', 'Pull from Network OS', 'Pull relationship records through the declared adapter (read-only; idempotent by delivery key).', 0, 0),
  ('network_conflict.resolve', 'Resolve sync conflict', 'Human disposition of a Network OS/WP OS divergence (never a silent overwrite).', 0, 0),
  ('network_os.propose_person', 'Propose a person to Network OS', 'Send a captured person to Network OS''s intake queue for a human there to review. Never writes a contact.', 1, 0),
  ('lp_record.create', 'Create LP record', 'Record an LP entity (LP_PRIVATE by default).', 0, 0),
  ('lp_opportunity.create', 'Create LP opportunity', 'Track a fundraising conversation with an LP.', 0, 0),
  ('company.update', 'Edit a company', 'Change what the firm records about a company. Identity fields are not editable by this path.', 0, 0),
  ('position.mark', 'Mark a holding', 'Record what a position is worth now, on what basis, as of when. Append-only; a mark is superseded, never edited.', 0, 0),
  ('capital_call.record', 'Record a capital call', 'Record capital called from a limited partner against their commitment.', 0, 0),
  ('capital_distribution.record', 'Record a distribution', 'Record cash paid back to a limited partner.', 0, 0),
  ('document.link', 'Attach a document to something', 'Record that a stored document is about a company, a deal, an LP or an event.', 0, 0),
  ('opportunity.recommend', 'Recommend what to do with a deal', 'An employee''s view on whether the firm should pass or look closer. Never moves the deal.', 0, 0),
  ('lp_commitment.record', 'Record an LP commitment', 'Record or revise how much a limited partner has committed to a fund.', 0, 0),
  ('fund.set_size', 'Set the fund''s target size', 'State what the fund is raising. What has actually been committed is derived from signed commitments, never typed.', 0, 0),
  ('lp_opportunity.transition', 'Transition LP opportunity', 'Move an LP opportunity through its governed stages.', 0, 0),
  ('lp_diligence_request.create', 'Record LP diligence request', 'Record a diligence question or document request from an LP.', 0, 0),
  ('lp_diligence_request.respond', 'Respond to LP diligence request', 'Record the firm response to an LP diligence request.', 0, 0),
  ('lp_claim.draft', 'Draft LP claim', 'Draft an LP-facing claim. AI may draft; publication needs approved evidence and a compliance receipt.', 0, 0),
  ('lp_claim.link_evidence', 'Link evidence to LP claim', 'Attach approved evidence (VERIFIED diligence claim, knowledge record, or governed document) to an LP claim.', 0, 0),
  ('lp_claim.submit', 'Submit LP claim for review', 'Submit an LP claim for the reserved marketing-claim approval.', 0, 0),
  ('data_room_artifact.create', 'Register data-room artifact', 'Register a versioned artifact intended for the EXTERNAL data room.', 0, 0),
  ('data_room_access.revoke', 'Revoke data-room access', 'Revoke a recorded data-room access grant (append-only revocation).', 0, 0),
  ('fund_scenario.create', 'Create fund construction scenario', 'Open a scenario pinned to specific mandate/sleeve/reserve/concentration policy versions.', 0, 0),
  ('fund_scenario.add_assumption', 'Record scenario assumption', 'Record a stated, visible assumption on a scenario (append-only).', 0, 0),
  ('allocation_option.create', 'Add capital allocation option', 'Add an initial, follow-on, reserve, secondary, or exit option to a scenario for comparison.', 0, 0),
  ('allocation_comparison.run', 'Run cross-sleeve comparison', 'Compute the deterministic constraint/concentration/reserve effects of every option in a scenario.', 0, 0),
  ('follow_on_review.create', 'Open follow-on review', 'Open a governed follow-on review for a portfolio position.', 0, 0),
  ('reporting_period.create', 'Open LP reporting period', 'Open a reporting period for a fund.', 0, 0),
  ('reporting_packet.create', 'Draft LP reporting packet', 'Draft a versioned LP reporting packet for a period.', 0, 0),
  ('reporting_packet.submit', 'Submit reporting packet for review', 'Move a packet into review, opening its required review rows.', 0, 0),
  ('reporting_review.record', 'Record a reporting review', 'Record a required finance/compliance/MP review decision on a packet.', 0, 0),
  ('reconciliation_run.import', 'Import administrator records for reconciliation', 'Import an administrator/accounting export and compare it against internal records (read-only import).', 0, 0),
  ('reconciliation_exception.resolve', 'Resolve a reconciliation exception', 'Record a human disposition of a discrepancy (never an overwrite of the administrator record).', 0, 0),
  ('intelligence_source.register', 'Register intelligence source', 'Register a daily-intelligence source with its kind, data class, and credential requirement.', 0, 0),
  ('intelligence_source.update', 'Update intelligence source', 'Enable, disable, or re-describe a registered intelligence source.', 0, 0),
  ('watchlist.manage', 'Manage watchlist', 'Add, deactivate, or reactivate a personal or firm watchlist entry.', 0, 0),
  ('mp_home_preference.set', 'Set MP home + briefing preferences', 'Record a new version of a user''s home module layout and briefing preferences.', 0, 0),
  ('intelligence_run.execute', 'Run the daily intelligence engine', 'Acquire, dedupe, score, and archive intelligence items through the governed engine.', 0, 0),
  ('intelligence_item.archive', 'Archive intelligence item', 'Remove an intelligence item from active briefings (the record is preserved).', 0, 0),
  ('intelligence_item.synthesize', 'Synthesize intelligence item', 'Run the governed AI boundary over one item to draft why-it-matters (quarantine rules apply).', 0, 0),
  ('intelligence_feedback.record', 'Record intelligence feedback', 'Record an operator relevance signal on an intelligence item.', 0, 0),
  ('personal_intelligence.configure', 'Configure personal intelligence', 'Configure the private, non-institutional personal-intelligence layer for the acting user only.', 0, 0),
  ('personal_intelligence.record', 'Record personal intelligence entry', 'Record a private personal-intelligence entry for the acting user only.', 0, 0),
  ('ai_employee.profile.update', 'Update AI employee profile', 'Set an employee''s department, manager, avatar, or brief (human only).', 0, 0),
  ('ai_employee.assign_machine', 'Assign machine to AI employee', 'Assign or unassign an operating machine for an AI employee (human only).', 0, 0),
  ('ai_employee.lifecycle_change', 'Lower AI employee lifecycle state', 'Pause, restrict, or retire an AI employee. Raising to ACTIVE stays on the reserved ai_employee.activate receipt path.', 0, 0),
  ('employee_room.post', 'Post to a department room', 'Post a governed message that references work, a run, or a firm announcement.', 0, 0),
  ('employee_handoff.propose', 'Propose a work handoff', 'Propose moving a work card from one employee to another.', 0, 0),
  ('employee_handoff.decide', 'Decide a work handoff', 'Accept or reject a proposed handoff (human only).', 0, 0),
  ('internal_memo.create', 'Write an internal memo', 'Publish an internal memo to a department or the firm.', 0, 0),
  ('governance_update.acknowledge', 'Acknowledge a governance update', 'Record that an actor has read and acknowledged an MP governance update.', 0, 0),
  ('employee_performance.compute', 'Compute an employee scorecard', 'Compute a deterministic performance snapshot from run and approval history.', 0, 0),
  ('employee_review.record', 'Record a manager review', 'Record a manager review, improvement plan, or retraining decision for an employee.', 0, 0),
  ('provider_model.register', 'Register a provider model', 'Add or update a model in the provider catalogue with its capability, context, latency, and pricing provenance.', 0, 0),
  ('provider_model.promote', 'Promote or demote a model', 'Move a model between ACTIVE, BENCH, and DEPRECATED.', 0, 0),
  ('provider_health.check', 'Run a provider health check', 'Record a provider reachability check, stamped LOCAL_FIXTURE or LIVE.', 0, 0),
  ('model_evaluation.record', 'Record a model evaluation', 'Record a benchmark or evaluation result with the method that produced it.', 0, 0),
  ('routing_policy.set', 'Set a task routing policy', 'Publish a new version of the ordered provider/model routing policy for a task class.', 0, 0),
  ('machine_model_policy.set', 'Set a machine model policy', 'Set the preferred provider/model and maximum data class for one machine.', 0, 0),
  ('budget_scope.set', 'Set a scoped AI budget', 'Publish a new version of a per-employee/machine/provider/model/category budget.', 0, 0),
  ('ai_output.discard', 'Throw away a quarantined AI output', 'Refuse a completed AI output so it is never used, with a stated reason. The run and its text stay on the record.', 0, 0),
  ('firm_budget.set', 'Set what the firm will spend', 'Publish a new version of the firmwide monthly or all-time spending ceiling. Enforced at the AI boundary, not just displayed.', 0, 0),
  ('cost_alert.decide', 'Acknowledge a cost alert', 'Acknowledge or resolve a budget-threshold alert.', 0, 0),
  ('machine_state.configure', 'Configure a machine', 'Set a machine''s owner, SLA, priority, allowed tools, data access, or evidence expectation.', 0, 0),
  ('machine_state.pause', 'Pause or resume a machine', 'Stop or restart work routing and AI spend for one machine.', 0, 0),
  ('machine_dependency.declare', 'Declare a machine dependency', 'Record that one machine depends on another.', 0, 0),
  ('machine_memory.append', 'Append machine memory', 'Append a durable operating note to a machine''s memory.', 0, 0),
  ('capability.register', 'Register a capability', 'Register an internal firm capability with its maturity, dependencies, and tested state.', 0, 0),
  ('capability.transition', 'Move a capability between Active, Bench, and Archive', 'Change a capability''s operating state.', 0, 0),
  ('firm_skill.draft', 'Draft a method from plain English', 'Turn what a partner wrote into a method the machine''s employees follow.', 0, 0),
  ('firm_skill.adopt', 'Adopt a drafted method', 'Put a drafted method into use for every employee on that machine.', 0, 0),
  ('firm_skill.retire', 'Retire a method', 'Stop a method being read by the employees on that machine.', 0, 0),
  ('document.archive', 'Archive a document', 'Take a document out of the shelf, keeping the record of who removed it and why.', 0, 0),
  ('opportunity.archive', 'Archive a deal record', 'Take a deal record off the board, keeping who removed it and why.', 0, 0),
  ('meeting.archive', 'Archive a meeting', 'Take a meeting off the record, keeping who removed it, when, and why. Nothing already taken out of it is removed.', 0, 0),
  ('capability.assign', 'Assign a capability', 'Assign a capability to an AI employee or a machine.', 0, 0),
  ('capability_after_action.record', 'Record capability after-action', 'Record what actually happened when a capability was used.', 0, 0),
  ('build_vs_buy.decide', 'Record a build-vs-buy decision', 'Record a build, buy, or defer decision for a capability with its rationale.', 0, 0),
  ('work_packet.create', 'Create a work packet', 'Capture a rough intent and open a governed work packet around it.', 0, 0),
  ('work_packet.enhance', 'Enhance a work packet', 'Derive interpretation, ambiguities, assumptions, risks, and acceptance criteria without replacing the original text.', 0, 0),
  ('work_packet.update', 'Revise a work packet', 'Change packet fields; every change appends a revision.', 0, 0),
  ('work_packet.execute', 'Execute a work packet', 'Run an accepted work packet through the governed AI boundary and open its work card.', 0, 0),
  ('lens.run', 'Run an institutional lens', 'Record a lens verdict, critique, evidence references, and summary for a work packet.', 0, 0),
  ('scheduled_job.create', 'Create a scheduled job', 'Define a recurring governed job with its schedule, target, budget, and data policy.', 0, 0),
  ('scheduled_job.pause', 'Pause or resume a scheduled job', 'Stop or restart a recurring job.', 0, 0),
  ('job_run.execute', 'Run a scheduled job', 'Execute one occurrence of a scheduled job (scheduled trigger or manual operator run).', 0, 0),
  ('job_run.cancel', 'Cancel a job run', 'Cancel a queued or running job occurrence.', 0, 0),
  ('notification.read', 'Read a notification', 'Mark a notification read for the acting user.', 0, 0),
  ('notification.acknowledge', 'Acknowledge a notification', 'Acknowledge a notification, recording that a human saw and accepted it.', 0, 0),
  ('notification_preference.set', 'Set notification preferences', 'Set quiet hours and per-kind notification preferences for the acting user.', 0, 0),
  ('research_project.create', 'Open a research project', 'Open a governed research project around a question.', 0, 0),
  ('research_question.add', 'Add a research question', 'Add a question the project must answer.', 0, 0),
  ('research_source.add', 'Record a research source', 'Record a source consulted, with its reliability stated.', 0, 0),
  ('research_finding.record', 'Record a research finding', 'Record a finding against a question and the source that supports it.', 0, 0),
  ('research_finding.promote', 'Promote a finding into evidence', 'Promote a research finding into the governed diligence-claim substrate.', 0, 0),
  ('market_map.create', 'Create a market map', 'Record a segmented market map produced by a research project.', 0, 0),
  ('research_packet.assemble', 'Assemble a research packet', 'Assemble findings, sources, and open contradictions into an IC-ready packet.', 0, 0),
  ('connector.check', 'Check a connector', 'Run a configuration check on an external connector and record the result.', 0, 0),
  ('meeting_prep.queue', 'Read the meeting prep queue', 'List upcoming meetings with their prep and consent state.', 0, 0),
  ('specialist_engagement.open', 'Open a specialist engagement', 'Open a bounded engagement with a specialist AI provider through the governed AI boundary.', 0, 0),
  ('specialist_engagement.accept', 'Accept specialist output', 'Human accept of a quarantined specialist output. Never a legal or compliance conclusion.', 0, 0),
  ('admin_source.register', 'Register an administrator source', 'Record an administrator, accounting, or VDR source with its contract state and freshness expectation.', 0, 0),
  ('reconciliation_schedule.set', 'Schedule reconciliation', 'Set the cadence on which a fund is reconciled against its administrator.', 0, 0),
  ('lp_engagement.update', 'Update LP engagement state', 'Record the current state of an LP relationship and its next step.', 0, 0),
  ('weekly_review.manage', 'Manage weekly review', 'Generate the weekly MP operating review from live firm state, and record how each agenda item exited.', 0, 0),
  ('event.manage', 'Manage event', 'Create or update an Event OS event and its attendee list. Internal record only; sending invitations is an external effect.', 0, 0),
  ('community.manage', 'Manage community member', 'Create or update a Community OS member record. Internal record only.', 0, 0),
  ('room_packet.manage', 'Manage Room packet', 'Generate or edit a Room proposal: theme, agenda, venue options, guest ideas and economics. Internal record only.', 0, 0),
  ('room_packet.decide', 'Decide on a Room packet', 'Approve or decline a proposed Room. Human only in code — a Room commits the firm to spend and to approaching sponsors.', 0, 0),
  ('sponsor.manage', 'Manage sponsor prospect', 'Create or advance a sponsor prospect in the Room sponsorship pipeline. Internal record only; contacting the sponsor is an external effect.', 0, 0),
  ('community.act', 'Record a community act', 'Record something West Peek witnessed a member do — attended, hosted, answered, referred. Append-only evidence.', 0, 0),
  ('council.decide', 'Decide Council membership', 'Record a Council decision with a reason. Human only in code — the Council is a judgement, never a computed threshold.', 0, 0),
  ('match.manage', 'Manage introduction suggestions', 'Propose or dismiss a suggested introduction between two people. Proposing is internal; making the introduction is a human act.', 0, 0),
  ('duty_override.set', 'Change who is on duty', 'Put an employee on or off a named shift, or give them explicit working hours that supersede the shift model for them. Stored as a difference from the firm''s default rota, never as a copy of it, and always with who changed it and why.', 0, 0),
  ('duty_override.clear', 'Put a duty change back to default', 'Remove a duty override so the employee follows the firm''s default rota again. The change and its removal both stay on the event spine.', 0, 0),
  ('effect.email.send', 'Send email', 'External effect: deliver an email to an outside recipient (simulated locally).', 1, 0),
  ('effect.message.send', 'Send message', 'External effect: deliver a message to an external channel (simulated locally).', 1, 0),
  ('effect.webhook.post', 'Post webhook', 'External effect: POST to an external webhook endpoint (simulated locally).', 1, 0);

-- Human-reserved action register (approver roles as JSON arrays):
INSERT OR IGNORE INTO human_reserved_action (key, category, description, approver_roles_json) VALUES
  ('investment.approve', 'INVESTMENT_CAPITAL', 'Approve or reject an investment.', '["MANAGING_PARTNER"]'),
  ('investment.final_conviction', 'INVESTMENT_CAPITAL', 'Determine final conviction.', '["MANAGING_PARTNER"]'),
  ('investment.founder_character_judgment', 'INVESTMENT_CAPITAL', 'Make final founder-character judgments.', '["MANAGING_PARTNER"]'),
  ('investment.reference_call_final_truth', 'INVESTMENT_CAPITAL', 'Interpret reference calls as final truth.', '["MANAGING_PARTNER"]'),
  ('valuation.approve', 'INVESTMENT_CAPITAL', 'Approve valuation.', '["MANAGING_PARTNER"]'),
  ('scenario_probabilities.approve', 'INVESTMENT_CAPITAL', 'Approve scenario probabilities.', '["MANAGING_PARTNER"]'),
  ('ownership_targets.approve', 'INVESTMENT_CAPITAL', 'Approve ownership targets.', '["MANAGING_PARTNER"]'),
  ('reserve_allocation.approve', 'INVESTMENT_CAPITAL', 'Approve reserve allocations.', '["MANAGING_PARTNER"]'),
  ('capital_allocation_cross_sleeve.approve', 'INVESTMENT_CAPITAL', 'Approve capital allocation across sleeves.', '["MANAGING_PARTNER"]'),
  ('follow_on.approve', 'INVESTMENT_CAPITAL', 'Approve follow-on participation.', '["MANAGING_PARTNER"]'),
  ('secondary_purchase.approve', 'INVESTMENT_CAPITAL', 'Approve a secondary purchase.', '["MANAGING_PARTNER"]'),
  ('secondary_sale.approve', 'INVESTMENT_CAPITAL', 'Approve a secondary sale.', '["MANAGING_PARTNER"]'),
  ('exit.approve', 'INVESTMENT_CAPITAL', 'Approve a partial or full exit.', '["MANAGING_PARTNER"]'),
  ('fund_strategy.change', 'INVESTMENT_CAPITAL', 'Change the fund strategy.', '["MANAGING_PARTNER"]'),
  ('sleeve_targets.change', 'INVESTMENT_CAPITAL', 'Change sleeve targets.', '["MANAGING_PARTNER"]'),
  ('concentration_limits.change', 'INVESTMENT_CAPITAL', 'Change concentration limits.', '["MANAGING_PARTNER"]'),
  ('capital.move_or_commit', 'INVESTMENT_CAPITAL', 'Move or commit capital.', '["MANAGING_PARTNER"]'),
  ('wire.initiate_or_authorize', 'INVESTMENT_CAPITAL', 'Initiate or authorize wire instructions.', '["MANAGING_PARTNER"]'),
  ('legal.final_conclusion', 'LEGAL_COMPLIANCE', 'Issue final legal conclusions.', '["MANAGING_PARTNER","COUNSEL"]'),
  ('legal.act_as_counsel', 'LEGAL_COMPLIANCE', 'Act as legal counsel.', '["MANAGING_PARTNER","COUNSEL"]'),
  ('compliance.act_as_officer', 'LEGAL_COMPLIANCE', 'Act as the compliance officer.', '["MANAGING_PARTNER","COMPLIANCE_OFFICER"]'),
  ('communications.fund_or_brokerage.approve', 'LEGAL_COMPLIANCE', 'Approve fund or brokerage communications.', '["MANAGING_PARTNER","COMPLIANCE_OFFICER"]'),
  ('conflict_of_interest.resolve', 'LEGAL_COMPLIANCE', 'Resolve conflicts of interest.', '["MANAGING_PARTNER"]'),
  ('mnpi.treatment_determine', 'LEGAL_COMPLIANCE', 'Determine MNPI treatment.', '["MANAGING_PARTNER","COMPLIANCE_OFFICER"]'),
  ('regulatory_interpretation.approve', 'LEGAL_COMPLIANCE', 'Approve regulatory interpretations.', '["MANAGING_PARTNER","COMPLIANCE_OFFICER"]'),
  ('sponsor_disclosure.approve', 'LEGAL_COMPLIANCE', 'Approve sponsor disclosures.', '["MANAGING_PARTNER","COMPLIANCE_OFFICER"]'),
  ('legal_document_execution.approve', 'LEGAL_COMPLIANCE', 'Approve legal documents for execution.', '["MANAGING_PARTNER","COUNSEL"]'),
  ('lp_marketing_claim.approve', 'LEGAL_COMPLIANCE', 'Approve LP marketing claims.', '["MANAGING_PARTNER","COMPLIANCE_OFFICER"]'),
  ('review.waive_required', 'LEGAL_COMPLIANCE', 'Waive required counsel, compliance, or registered-person review.', '["MANAGING_PARTNER"]'),
  ('lp.promise', 'LP_BANKING_FUND_ADMIN', 'Make promises to LPs.', '["MANAGING_PARTNER"]'),
  ('fund_terms.commit', 'LP_BANKING_FUND_ADMIN', 'Commit fund terms.', '["MANAGING_PARTNER"]'),
  ('lp_sensitive_communication.send', 'LP_BANKING_FUND_ADMIN', 'Send sensitive LP communications.', '["MANAGING_PARTNER"]'),
  ('capital_call.issue', 'LP_BANKING_FUND_ADMIN', 'Issue capital calls.', '["MANAGING_PARTNER","FUND_ADMINISTRATOR","FINANCE_AUTHORITY"]'),
  ('distribution.approve', 'LP_BANKING_FUND_ADMIN', 'Approve distributions.', '["MANAGING_PARTNER","FUND_ADMINISTRATOR","FINANCE_AUTHORITY"]'),
  ('bank_account.change', 'LP_BANKING_FUND_ADMIN', 'Change bank accounts.', '["MANAGING_PARTNER","FUND_ADMINISTRATOR","FINANCE_AUTHORITY"]'),
  ('payment_instruction.approve', 'LP_BANKING_FUND_ADMIN', 'Approve payment instructions.', '["MANAGING_PARTNER","FUND_ADMINISTRATOR","FINANCE_AUTHORITY"]'),
  ('official_valuation_or_capital_account.change', 'LP_BANKING_FUND_ADMIN', 'Change official valuations or capital accounts.', '["MANAGING_PARTNER","FUND_ADMINISTRATOR","FINANCE_AUTHORITY"]'),
  ('fund_admin_record.override', 'LP_BANKING_FUND_ADMIN', 'Override the fund administrator, accountant, auditor, or authorized finance operator.', '["MANAGING_PARTNER"]'),
  ('financial_statement.certify', 'LP_BANKING_FUND_ADMIN', 'Certify financial statements or performance metrics.', '["MANAGING_PARTNER","FUND_ADMINISTRATOR","FINANCE_AUTHORITY"]'),
  ('introduction.relationship_sensitive', 'RELATIONSHIP_PUBLIC', 'Make relationship-sensitive introductions.', '["MANAGING_PARTNER"]'),
  ('external_contact.unauthorized', 'RELATIONSHIP_PUBLIC', 'Contact founders, LPs, brokers, buyers, sellers, sponsors, or portfolio companies without authority.', '["MANAGING_PARTNER"]'),
  ('public_statement.material', 'RELATIONSHIP_PUBLIC', 'Make material public statements.', '["MANAGING_PARTNER"]'),
  ('promise.access_or_outcome', 'RELATIONSHIP_PUBLIC', 'Promise access, introductions, capital, liquidity, or outcomes.', '["MANAGING_PARTNER"]'),
  ('portfolio_termination_advice.final', 'RELATIONSHIP_PUBLIC', 'Provide portfolio-company termination advice as final guidance.', '["MANAGING_PARTNER"]'),
  ('mp.impersonate', 'RELATIONSHIP_PUBLIC', 'Impersonate a Managing Partner.', '["MANAGING_PARTNER"]'),
  ('identity_merge.execute', 'INVESTMENT_CAPITAL', 'Execute a destructive canonical-company merge.', '["MANAGING_PARTNER"]'),
  ('governance.policy_change', 'LEGAL_COMPLIANCE', 'Change firmwide cost/privacy/provider policy.', '["MANAGING_PARTNER"]'),
  ('ai_employee.activate', 'LEGAL_COMPLIANCE', 'Activate or reactivate an AI employee.', '["MANAGING_PARTNER"]'),
  ('external_effect.execute', 'RELATIONSHIP_PUBLIC', 'Execute any external effect (send, publish, write to external system).', '["MANAGING_PARTNER"]'),
  ('knowledge.promote', 'LEGAL_COMPLIANCE', 'Promote evidence into durable institutional memory (knowledge_record).', '["MANAGING_PARTNER"]'),
  ('transaction.void', 'INVESTMENT_CAPITAL', 'Void a transaction (reverses its position effect; the record is preserved).', '["MANAGING_PARTNER"]'),
  ('meeting.recording_policy.activate', 'LEGAL_COMPLIANCE', 'Activate recording/transcription policy for a meeting (human-reserved gate).', '["MANAGING_PARTNER","COMPLIANCE_OFFICER"]'),
  ('network_os.writeback', 'RELATIONSHIP_PUBLIC', 'Write a West Peek OS record back into Network OS (live integration is a named human gate).', '["MANAGING_PARTNER"]');
-- END GENERATED SEEDS

-- ── Capture intake (+Capture) ──

CREATE TABLE IF NOT EXISTS capture (
  id                TEXT PRIMARY KEY,
  capture_type      TEXT NOT NULL,
  raw_text          TEXT NOT NULL,
  source_channel    TEXT NOT NULL,
  privacy_label     TEXT NOT NULL DEFAULT 'INTERNAL',
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  captured_by       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'NEW'
                    CHECK (status IN ('NEW','ROUTED','ARCHIVED')),
  routed_machine_id INTEGER REFERENCES machine (id),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_capture_status ON capture (status, firm_scope);

-- ── Work spine ──

CREATE TABLE IF NOT EXISTS work_card (
  id            TEXT PRIMARY KEY,
  capture_id    TEXT REFERENCES capture (id),
  title         TEXT NOT NULL,
  description   TEXT,
  domain_id     TEXT REFERENCES domain (id),
  machine_id    INTEGER REFERENCES machine (id),
  owner_type    TEXT NOT NULL DEFAULT 'UNASSIGNED'
                CHECK (owner_type IN ('HUMAN','AI','UNASSIGNED')),
  owner_id      TEXT,
  state         TEXT NOT NULL DEFAULT 'OPEN'
                CHECK (state IN ('OPEN','IN_PROGRESS','BLOCKED','DONE','CANCELLED')),
  priority      TEXT NOT NULL DEFAULT 'NORMAL',
  privacy_label TEXT NOT NULL DEFAULT 'INTERNAL',
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  next_action   TEXT,
  due_at        TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_work_card_state ON work_card (state, firm_scope);
CREATE INDEX IF NOT EXISTS idx_work_card_owner ON work_card (owner_type, owner_id);

-- ── Approval cards + append-only decision history ──
-- State machine (enforced in src/worker/services/approvals.ts):
--   drafted → pending_review → approved | rejected | revise_requested
--   revise_requested → pending_review (resubmit)
--   approved → executed | blocked        ('sent' is an alias of executed for comms)

CREATE TABLE IF NOT EXISTS approval_card (
  id                          TEXT PRIMARY KEY,
  action_key                  TEXT NOT NULL REFERENCES action_type (key),
  object_type                 TEXT NOT NULL,
  object_id                   TEXT NOT NULL,
  title                       TEXT NOT NULL,
  summary                     TEXT,
  payload_json                TEXT NOT NULL DEFAULT '{}',
  requested_by_type           TEXT NOT NULL
                              CHECK (requested_by_type IN ('HUMAN','AI','SYSTEM')),
  requested_by_id             TEXT NOT NULL,
  required_approver_roles_json TEXT NOT NULL,
  state                       TEXT NOT NULL DEFAULT 'drafted'
                              CHECK (state IN ('drafted','pending_review','approved','rejected','revise_requested','executed','blocked')),
  firm_scope                  TEXT NOT NULL DEFAULT 'west-peek',
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_by                  TEXT,
  decided_at                  TEXT,
  decision_note               TEXT
);

CREATE INDEX IF NOT EXISTS idx_approval_card_state ON approval_card (state, firm_scope);
CREATE INDEX IF NOT EXISTS idx_approval_card_object ON approval_card (object_type, object_id);
CREATE INDEX IF NOT EXISTS idx_approval_card_created ON approval_card (created_at);

-- Decision history is ALWAYS visible and NEVER rewritten: append-only by trigger.
CREATE TABLE IF NOT EXISTS approval_decision (
  id               TEXT PRIMARY KEY,
  approval_card_id TEXT NOT NULL REFERENCES approval_card (id),
  decision         TEXT NOT NULL,
  decided_by       TEXT NOT NULL,
  note             TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_approval_decision_card ON approval_decision (approval_card_id);

CREATE TRIGGER IF NOT EXISTS approval_decision_reject_update
BEFORE UPDATE ON approval_decision
BEGIN
  SELECT RAISE(ABORT, 'approval_decision is append-only: UPDATE rejected (D15)');
END;

CREATE TRIGGER IF NOT EXISTS approval_decision_reject_delete
BEFORE DELETE ON approval_decision
BEGIN
  SELECT RAISE(ABORT, 'approval_decision is append-only: DELETE rejected (D15)');
END;

-- ── External effects ──
-- The ONLY execution path is src/worker/effects/executor.ts, gated by an approved
-- approval_card receipt verified through authorize(). All adapters are LOCAL
-- SIMULATIONS in the initial build — no real sends.

CREATE TABLE IF NOT EXISTS external_effect_request (
  id                        TEXT PRIMARY KEY,
  effect_type               TEXT NOT NULL,
  destination               TEXT NOT NULL,
  payload_json              TEXT NOT NULL DEFAULT '{}',
  authorization_receipt_id  TEXT,
  state                     TEXT NOT NULL DEFAULT 'REQUESTED'
                            CHECK (state IN ('REQUESTED','APPROVED','EXECUTED','DENIED','FAILED')),
  requested_by_type         TEXT NOT NULL
                            CHECK (requested_by_type IN ('HUMAN','AI','SYSTEM')),
  requested_by_id           TEXT NOT NULL,
  approval_card_id          TEXT REFERENCES approval_card (id),
  created_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  executed_at               TEXT
);

CREATE INDEX IF NOT EXISTS idx_external_effect_request_state ON external_effect_request (state);

-- ── Governance updates (MP-issued rules / bulletins / broadcasts) ──

CREATE TABLE IF NOT EXISTS governance_update (
  id          TEXT PRIMARY KEY,
  update_type TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  issued_by   TEXT NOT NULL,
  firm_scope  TEXT NOT NULL DEFAULT 'west-peek',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_governance_update_created ON governance_update (created_at);

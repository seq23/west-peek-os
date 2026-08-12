/**
 * Core Machine Registry — canonical source: v3.2.14 Canon §5A.2 (rows 1–45).
 * D14/ADR-001: this file is the SINGLE versioned source; tests assert count === 45 from here.
 * The v1.11 plan's 44-machine requirement is stale and superseded.
 * Domain assignment is an implementation mapping onto the canon §0C 15-domain map.
 */

export const MACHINE_REGISTRY_VERSION = "3.2.14";

export const DOMAIN_IDS = [
  "COMMAND_MP_OFFICE",
  "OPPORTUNITY_INTELLIGENCE",
  "GOVERNANCE",
  "RELATIONSHIP_OS",
  "COMMUNITY_OS",
  "INVESTMENT_OS",
  "PORTFOLIO_OS",
  "FUNDRAISING_LP_OS",
  "EVENT_OS",
  "KNOWLEDGE_OS",
  "FINANCE_OS",
  "LEGAL_COMPLIANCE_OS",
  "BUILDER_SYSTEMS_OS",
  "BRAND_MARKETING_OS",
  "OPERATIONS_OS",
] as const;

export type DomainId = (typeof DOMAIN_IDS)[number];

export interface MachineRegistryEntry {
  id: number; // 1..45, canonical row number
  key: string;
  name: string;
  domain: DomainId;
  purpose: string;
  /** True when the machine's capability is part of the initial P0–P12 system boundary. */
  inInitialScope: boolean;
}

export const MACHINE_REGISTRY: readonly MachineRegistryEntry[] = [
  { id: 1, key: "command_center", name: "Command Center Machine", domain: "COMMAND_MP_OFFICE", purpose: "Calm daily operating surface for each MP: priorities, meetings, approvals, capture, activity, system health.", inInitialScope: true },
  { id: 2, key: "mp_personal_office", name: "Managing Partner Personal Office Machines", domain: "COMMAND_MP_OFFICE", purpose: "Scoped personal support for each MP; private assistant interactions unless promoted into firm work.", inInitialScope: false },
  { id: 3, key: "global_capture_routing", name: "Global Capture + Routing Machine", domain: "OPERATIONS_OS", purpose: "Accepts unstructured input (+Capture, assistants, email, meetings, mobile, field) and routes to the right machine.", inInitialScope: true },
  { id: 4, key: "governance_center_broadcast", name: "Governance Center + AI Workforce Broadcast Machine", domain: "GOVERNANCE", purpose: "MP-issued rules, bulletins, context notes, vendor updates, firm-wide workforce messages.", inInitialScope: true },
  { id: 5, key: "approval_center", name: "Approval Center Machine", domain: "GOVERNANCE", purpose: "Centralizes all actions requiring human judgment — external comms, compliance-sensitive work, material decisions.", inInitialScope: true },
  { id: 6, key: "activity_audit_ledger", name: "Activity Feed + Audit Ledger Machine", domain: "GOVERNANCE", purpose: "Recent operational activity with privacy boundaries; durable proof for firm-relevant events.", inInitialScope: true },
  { id: 7, key: "developer_diagnostics", name: "Developer Diagnostics + Debug Copilot Machine", domain: "BUILDER_SYSTEMS_OS", purpose: "Logs, traces, API diagnostics, permission explanations, memory diagnostics, AI-assisted repair guidance.", inInitialScope: true },
  { id: 8, key: "relationship_intelligence", name: "Relationship Intelligence Machine", domain: "RELATIONSHIP_OS", purpose: "Relationship memory, context, connection intelligence, warm paths; Network OS is source of truth.", inInitialScope: true },
  { id: 9, key: "network_os_sync_verification", name: "Network OS Sync + Verification Machine", domain: "RELATIONSHIP_OS", purpose: "Shared IDs, sync health, record consistency, conflict review between West Peek OS and Network OS.", inInitialScope: true },
  { id: 10, key: "relationship_capital_budget", name: "Relationship Capital Budget Machine", domain: "RELATIONSHIP_OS", purpose: "Tracks recent asks, value given/received, trust, overuse risk, cooldowns.", inInitialScope: false },
  { id: 11, key: "lp_fundraising", name: "LP Fundraising Machine", domain: "FUNDRAISING_LP_OS", purpose: "LP pipeline, records, warm paths, outreach drafts, meeting prep.", inInitialScope: true },
  { id: 12, key: "lp_diligence_request", name: "LP Diligence Request Machine", domain: "FUNDRAISING_LP_OS", purpose: "LP material requests → governed workflows with approved documents, compliance review, access tracking.", inInitialScope: true },
  { id: 13, key: "lp_proof_engine", name: "LP Proof Engine Machine", domain: "FUNDRAISING_LP_OS", purpose: "Converts real operating work into LP-safe evidence of platform value.", inInitialScope: true },
  { id: 14, key: "data_room_control", name: "Data Room Control Machine", domain: "FUNDRAISING_LP_OS", purpose: "Internal document vault + external VDR use; no native external-facing data room in v1.", inInitialScope: true },
  { id: 15, key: "early_stage_deal", name: "Early-Stage Deal Machine", domain: "INVESTMENT_OS", purpose: "Founder/deal intake, pipeline, mandate fit, diligence, meeting prep, IC readiness (pre-seed/seed).", inInitialScope: true },
  { id: 16, key: "secondaries_investment", name: "Secondaries Investment Machine", domain: "INVESTMENT_OS", purpose: "Series C+ secondaries; strict brokerage/fund separation and confidentiality controls.", inInitialScope: true },
  { id: 17, key: "investment_mandate_exclusion", name: "Investment Mandate + Exclusion Machine", domain: "INVESTMENT_OS", purpose: "Scope, exclusion, fast-no, watchlist, venture-scale, founder-quality, market-quality tests.", inInitialScope: true },
  { id: 18, key: "ic_decision", name: "IC Decision Machine", domain: "INVESTMENT_OS", purpose: "Internal investment-decision workflows: evidence, dissent, decision capture, final rationale.", inInitialScope: true },
  { id: 19, key: "venturedeals_deal_math", name: "VentureDeals / Deal Math Machine", domain: "INVESTMENT_OS", purpose: "Deal-level math workbench for primary, secondary, and fund math before IC decisions proceed.", inInitialScope: true },
  { id: 20, key: "ic_learning_loop", name: "IC Learning Loop Machine", domain: "INVESTMENT_OS", purpose: "Reviews assumptions vs. outcomes at 3/6/12/24 months and follow-on/exit/shutdown events.", inInitialScope: false },
  { id: 21, key: "meeting_intelligence", name: "Meeting Intelligence Machine", domain: "OPERATIONS_OS", purpose: "Meeting workspace: prep/live/debrief, follow-ups, memory routing.", inInitialScope: true },
  { id: 22, key: "meeting_capture_adapter", name: "Meeting Capture Adapter Machine", domain: "OPERATIONS_OS", purpose: "External capture/transcription providers; transcripts are inputs, not truth.", inInitialScope: true },
  { id: 23, key: "research_intelligence", name: "Research & Intelligence Machine", domain: "KNOWLEDGE_OS", purpose: "Public/paid/proprietary/human-sourced data → evidence-linked claims, signals, maps, memos.", inInitialScope: true },
  { id: 24, key: "research_data_license_quality", name: "Research Data License + Quality Machine", domain: "KNOWLEDGE_OS", purpose: "Governs what third-party/internal data can be stored, processed, reused, exported, surfaced to LPs.", inInitialScope: false },
  { id: 25, key: "source_of_truth_resolver", name: "Source-of-Truth Resolver Machine", domain: "KNOWLEDGE_OS", purpose: "Resolves conflicts across Network OS, Drive, email, calendar, provider data, meeting notes, human input.", inInitialScope: true },
  { id: 26, key: "knowledge_memory_promotion", name: "Knowledge OS / Memory Promotion Machine", domain: "KNOWLEDGE_OS", purpose: "Promotes approved info into durable institutional memory with provenance, versioning, confidence.", inInitialScope: true },
  { id: 27, key: "portfolio_support", name: "Portfolio Support Machine", domain: "PORTFOLIO_OS", purpose: "Founder/portfolio asks → support requests, service levels, support plans, approvals, outcome records.", inInitialScope: true },
  { id: 28, key: "portfolio_performance_followon", name: "Portfolio Performance + Follow-On Decision Machine", domain: "PORTFOLIO_OS", purpose: "Detects winners, KPIs/signals, pro-rata/follow-on decisions, capital allocation link.", inInitialScope: true },
  { id: 29, key: "fund_construction_allocation", name: "Fund Construction + Capital Allocation Machine", domain: "INVESTMENT_OS", purpose: "Fund construction, deployment pacing, ownership, reserve strategy, concentration, exposure.", inInitialScope: true },
  { id: 30, key: "west_peek_live_events", name: "West Peek Live / Events Machine", domain: "EVENT_OS", purpose: "Events, portfolio programming, sponsor workflows, event-to-value loops.", inInitialScope: false },
  { id: 31, key: "community_intelligence", name: "Community Intelligence Machine", domain: "COMMUNITY_OS", purpose: "Segmentation, programming, founder support signals, community-powered investing evidence.", inInitialScope: false },
  { id: 32, key: "brand_sponsorship_revenue", name: "Brand Sponsorship + Experiential Revenue Machine", domain: "BRAND_MARKETING_OS", purpose: "Sponsor discovery/fit/proposals, event sponsorships, revenue tracking.", inInitialScope: false },
  { id: 33, key: "marketing_pr_content", name: "Marketing / PR / Content Machine", domain: "BRAND_MARKETING_OS", purpose: "External-facing content, PR drafts, founder/LP-safe materials, brand assets.", inInitialScope: false },
  { id: 34, key: "taste_layer", name: "West Peek Taste Layer Machine", domain: "BRAND_MARKETING_OS", purpose: "Reviews outputs for West Peek voice, warmth, LP credibility, anti-generic quality.", inInitialScope: false },
  { id: 35, key: "finance_fund_admin", name: "Finance / Fund Admin Machine", domain: "FINANCE_OS", purpose: "Finance support, fund admin handoffs, reporting, entity records, treasury/banking, operating metrics.", inInitialScope: true },
  { id: 36, key: "legal_compliance_rules", name: "Legal / Compliance Rules Machine", domain: "LEGAL_COMPLIANCE_OS", purpose: "Detects/blocks/routes/logs compliance-sensitive actions: brokerage/fund separation, MNPI, LP marketing claims, conflicts.", inInitialScope: true },
  { id: 37, key: "external_helper_coordination", name: "External Helper / Provider Coordination Machine", domain: "OPERATIONS_OS", purpose: "Coordinates lawyers, fund admins, CPAs, auditors, banks, vendors — without making them internal AI employees.", inInitialScope: false },
  { id: 38, key: "vendor_risk_build_vs_buy", name: "Vendor Risk + Build-vs-Buy Machine", domain: "BUILDER_SYSTEMS_OS", purpose: "Vendor evaluation, API availability, security, export paths, cost, canonical-source risk.", inInitialScope: false },
  { id: 39, key: "systems_data_integration", name: "Systems, Data, and Integration Machine", domain: "BUILDER_SYSTEMS_OS", purpose: "System configuration, integrations, webhooks, APIs, sync jobs, model routing infrastructure.", inInitialScope: true },
  { id: 40, key: "model_governance_privacy_airlock", name: "Model Governance + Privacy Airlock Machine", domain: "GOVERNANCE", purpose: "Local/Frontier/Lockdown modes, outbound/inbound airlocks, redaction, sanitization, model ledgers, kill switches.", inInitialScope: true },
  { id: 41, key: "ai_employee_performance_lifecycle", name: "AI Employee Performance + Cost Ledger + Lifecycle Control Machine", domain: "GOVERNANCE", purpose: "Agent quality/cost/errors, lifecycle status, pause/restrict/retrain/retire recommendations.", inInitialScope: true },
  { id: 42, key: "prompt_enhancer_intent", name: "Prompt Enhancer + Intent-to-Execution Machine", domain: "COMMAND_MP_OFFICE", purpose: "Messy human intent → better prompts, machine assignments, privacy-safe prompts, prompt library.", inInitialScope: false },
  { id: 43, key: "builder_repo_product", name: "Builder / Repo / Product Machine", domain: "BUILDER_SYSTEMS_OS", purpose: "Canonical plans → code, repo work, implementation contracts, validation matrices, snapshot-first delivery.", inInitialScope: true },
  { id: 44, key: "continuity_maintenance", name: "Continuity + System Maintenance Machine", domain: "OPERATIONS_OS", purpose: "Emergency sovereignty, backups, offline/reduced modes, continuity drills, failure playbooks.", inInitialScope: true },
  { id: 45, key: "opportunity_radar_strategic_initiative", name: "Opportunity Radar + Strategic Initiative Machine", domain: "OPPORTUNITY_INTELLIGENCE", purpose: "AI-surfaced opportunities and Opportunity Briefs; separates opportunity review from workflow approval. (Proactive radar deferred P13+; record type exists.)", inInitialScope: false },
] as const;

/**
 * AI Employee reference roster — Revised v3.0 roster (supersedes prior conflicting roster names, ADR-002),
 * plus Whitney (Market Intelligence Coach). 31 unique employees. Rows are REFERENCE DATA:
 * every employee starts INACTIVE; activation (≤5) requires explicit human selection (D10).
 * Guard invariant: no entry may carry a Managing Partner name (see managingPartners.ts).
 */

export const AI_EMPLOYEE_ROSTER_VERSION = "3.0";

export type AIEmployeeLifecycleStatus =
  | "INACTIVE"
  | "CANDIDATE"
  | "ACTIVE"
  | "PAUSED"
  | "RESTRICTED"
  | "RETIRED";

export interface AIEmployeeRosterEntry {
  name: string;
  role: string;
  layer: string;
  primaryMachineKeys: string[];
  status: AIEmployeeLifecycleStatus;
}

const E = (
  name: string,
  role: string,
  layer: string,
  primaryMachineKeys: string[],
): AIEmployeeRosterEntry => ({ name, role, layer, primaryMachineKeys, status: "INACTIVE" });

export const AI_EMPLOYEE_ROSTER: readonly AIEmployeeRosterEntry[] = [
  // MP Support Layer
  E("Walker", "Scooter AI Chief of Staff", "MP Support", ["command_center", "mp_personal_office"]),
  E("Wendy", "Scooter AI Executive Assistant", "MP Support", ["mp_personal_office"]),
  E("Wren", "Sequoia AI Chief of Staff", "MP Support", ["command_center", "mp_personal_office"]),
  E("Willa", "Sequoia AI Executive Assistant", "MP Support", ["mp_personal_office"]),
  // Intake / Relationship / Memory / Governance
  E("Winton", "Field Intake Coordinator", "Intake/Relationship/Memory/Governance", ["global_capture_routing"]),
  E("Porter", "Network OS Sync + Verification Mirror", "Intake/Relationship/Memory/Governance", ["network_os_sync_verification"]),
  E("Winnie", "Connection Intelligence / Warm Path Finder", "Intake/Relationship/Memory/Governance", ["relationship_intelligence"]),
  E("Waverly", "Community Manager", "Intake/Relationship/Memory/Governance", ["community_intelligence"]),
  E("Wells", "Knowledge Manager", "Intake/Relationship/Memory/Governance", ["knowledge_memory_promotion"]),
  E("Willow", "Compliance + Privacy Gatekeeper / Compliance Linter", "Intake/Relationship/Memory/Governance + LP", ["legal_compliance_rules", "model_governance_privacy_airlock"]),
  E("Wilson", "Systems Operator", "Intake/Relationship/Memory/Governance", ["systems_data_integration"]),
  // Investment / IC / Meeting
  E("Pierce", "Principal", "Investment/IC/Meeting", ["early_stage_deal", "ic_decision"]),
  E("Priya", "Associate", "Investment/IC/Meeting", ["early_stage_deal", "secondaries_investment"]),
  E("Paige", "Research Analyst", "Investment/IC/Meeting", ["research_intelligence"]),
  E("Wyatt", "Deal Watchlist Analyst", "Investment/IC/Meeting", ["investment_mandate_exclusion", "venturedeals_deal_math"]),
  E("Poppy", "IC Facilitator", "Investment/IC/Meeting", ["ic_decision"]),
  E("Walter", "Meeting Buddy", "Investment/IC/Meeting", ["meeting_intelligence"]),
  // LP / Fundraising
  E("Piper", "LP Sourcer", "LP/Fundraising", ["lp_fundraising"]),
  E("Perry", "Enrichment + Scoring Agent", "LP/Fundraising", ["lp_fundraising"]),
  E("Wesley", "LP Relations Manager", "LP/Fundraising", ["lp_fundraising"]),
  E("Penn", "Outreach Composer", "LP/Fundraising", ["lp_fundraising", "marketing_pr_content"]),
  // Portfolio / Event / Brand / Ops
  E("Winter", "Portfolio Support Manager", "Portfolio/Event/Brand/Ops", ["portfolio_support"]),
  E("Parker", "Event Marketing Coordinator", "Portfolio/Event/Brand/Ops", ["west_peek_live_events"]),
  E("Wynn", "Sponsorship Scout", "Portfolio/Event/Brand/Ops", ["brand_sponsorship_revenue"]),
  E("Percy", "Marketing Lead", "Portfolio/Event/Brand/Ops", ["marketing_pr_content"]),
  E("Prue", "PR Lead", "Portfolio/Event/Brand/Ops", ["marketing_pr_content"]),
  E("Pippa", "Content Manager", "Portfolio/Event/Brand/Ops", ["marketing_pr_content"]),
  E("Pax", "Operations Manager", "Portfolio/Event/Brand/Ops", ["continuity_maintenance"]),
  E("Preston", "Finance Support", "Portfolio/Event/Brand/Ops", ["finance_fund_admin"]),
  E("Perrin", "Fund Admin Coordinator", "Portfolio/Event/Brand/Ops", ["finance_fund_admin"]),
  // Market Intelligence (canon line ~20626; separate future product surface, roster reference only)
  E("Whitney", "Market Intelligence Coach", "Market Intelligence (deferred product)", []),
] as const;

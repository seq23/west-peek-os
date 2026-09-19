/**
 * Human-Reserved Action Register — canon "Human Judgment and Reserved Authority Register"
 * (v3.2.14 §3.1–3.4, lines ~25726–25801). AI may prepare, extract, compare, calculate, draft,
 * flag, recommend, monitor, route, and record — it may NEVER independently complete these.
 * Every key here is enforced through authorize() as REQUIRE_APPROVAL (or DENY for AI actors).
 */

export type ReservedActionCategory =
  | "INVESTMENT_CAPITAL"
  | "LEGAL_COMPLIANCE"
  | "LP_BANKING_FUND_ADMIN"
  | "RELATIONSHIP_PUBLIC";

export interface ReservedActionDef {
  key: string;
  category: ReservedActionCategory;
  description: string;
  /** Human roles allowed to approve. Enforced by authorize(). */
  approverRoles: readonly string[];
}

const MP = ["MANAGING_PARTNER"] as const;
const MP_OR_COUNSEL = ["MANAGING_PARTNER", "COUNSEL"] as const;
const MP_OR_COMPLIANCE = ["MANAGING_PARTNER", "COMPLIANCE_OFFICER"] as const;
const MP_OR_FINANCE = ["MANAGING_PARTNER", "FUND_ADMINISTRATOR", "FINANCE_AUTHORITY"] as const;

export const HUMAN_RESERVED_ACTIONS: readonly ReservedActionDef[] = [
  // 3.1 Investment and Capital Authority
  { key: "investment.approve", category: "INVESTMENT_CAPITAL", description: "Approve or reject an investment.", approverRoles: MP },
  { key: "investment.final_conviction", category: "INVESTMENT_CAPITAL", description: "Determine final conviction.", approverRoles: MP },
  { key: "investment.founder_character_judgment", category: "INVESTMENT_CAPITAL", description: "Make final founder-character judgments.", approverRoles: MP },
  { key: "investment.reference_call_final_truth", category: "INVESTMENT_CAPITAL", description: "Interpret reference calls as final truth.", approverRoles: MP },
  { key: "valuation.approve", category: "INVESTMENT_CAPITAL", description: "Approve valuation.", approverRoles: MP },
  { key: "scenario_probabilities.approve", category: "INVESTMENT_CAPITAL", description: "Approve scenario probabilities.", approverRoles: MP },
  { key: "ownership_targets.approve", category: "INVESTMENT_CAPITAL", description: "Approve ownership targets.", approverRoles: MP },
  { key: "reserve_allocation.approve", category: "INVESTMENT_CAPITAL", description: "Approve reserve allocations.", approverRoles: MP },
  { key: "capital_allocation_cross_sleeve.approve", category: "INVESTMENT_CAPITAL", description: "Approve capital allocation across sleeves.", approverRoles: MP },
  { key: "follow_on.approve", category: "INVESTMENT_CAPITAL", description: "Approve follow-on participation.", approverRoles: MP },
  { key: "secondary_purchase.approve", category: "INVESTMENT_CAPITAL", description: "Approve a secondary purchase.", approverRoles: MP },
  { key: "secondary_sale.approve", category: "INVESTMENT_CAPITAL", description: "Approve a secondary sale.", approverRoles: MP },
  { key: "exit.approve", category: "INVESTMENT_CAPITAL", description: "Approve a partial or full exit.", approverRoles: MP },
  { key: "fund_strategy.change", category: "INVESTMENT_CAPITAL", description: "Change the fund strategy.", approverRoles: MP },
  { key: "sleeve_targets.change", category: "INVESTMENT_CAPITAL", description: "Change sleeve targets.", approverRoles: MP },
  { key: "concentration_limits.change", category: "INVESTMENT_CAPITAL", description: "Change concentration limits.", approverRoles: MP },
  { key: "capital.move_or_commit", category: "INVESTMENT_CAPITAL", description: "Move or commit capital.", approverRoles: MP },
  { key: "wire.initiate_or_authorize", category: "INVESTMENT_CAPITAL", description: "Initiate or authorize wire instructions.", approverRoles: MP },
  // 3.2 Legal and Compliance Authority
  { key: "legal.final_conclusion", category: "LEGAL_COMPLIANCE", description: "Issue final legal conclusions.", approverRoles: MP_OR_COUNSEL },
  { key: "legal.act_as_counsel", category: "LEGAL_COMPLIANCE", description: "Act as legal counsel.", approverRoles: MP_OR_COUNSEL },
  { key: "compliance.act_as_officer", category: "LEGAL_COMPLIANCE", description: "Act as the compliance officer.", approverRoles: MP_OR_COMPLIANCE },
  { key: "communications.fund_or_brokerage.approve", category: "LEGAL_COMPLIANCE", description: "Approve fund or brokerage communications.", approverRoles: MP_OR_COMPLIANCE },
  { key: "conflict_of_interest.resolve", category: "LEGAL_COMPLIANCE", description: "Resolve conflicts of interest.", approverRoles: MP },
  { key: "mnpi.treatment_determine", category: "LEGAL_COMPLIANCE", description: "Determine MNPI treatment.", approverRoles: MP_OR_COMPLIANCE },
  { key: "regulatory_interpretation.approve", category: "LEGAL_COMPLIANCE", description: "Approve regulatory interpretations.", approverRoles: MP_OR_COMPLIANCE },
  { key: "sponsor_disclosure.approve", category: "LEGAL_COMPLIANCE", description: "Approve sponsor disclosures.", approverRoles: MP_OR_COMPLIANCE },
  { key: "legal_document_execution.approve", category: "LEGAL_COMPLIANCE", description: "Approve legal documents for execution.", approverRoles: MP_OR_COUNSEL },
  { key: "lp_marketing_claim.approve", category: "LEGAL_COMPLIANCE", description: "Approve LP marketing claims.", approverRoles: MP_OR_COMPLIANCE },
  { key: "review.waive_required", category: "LEGAL_COMPLIANCE", description: "Waive required counsel, compliance, or registered-person review.", approverRoles: MP },
  // 3.3 LP, Banking, and Fund Administration Authority
  { key: "lp.promise", category: "LP_BANKING_FUND_ADMIN", description: "Make promises to LPs.", approverRoles: MP },
  { key: "fund_terms.commit", category: "LP_BANKING_FUND_ADMIN", description: "Commit fund terms.", approverRoles: MP },
  { key: "lp_sensitive_communication.send", category: "LP_BANKING_FUND_ADMIN", description: "Send sensitive LP communications.", approverRoles: MP },
  { key: "capital_call.issue", category: "LP_BANKING_FUND_ADMIN", description: "Issue capital calls.", approverRoles: MP_OR_FINANCE },
  { key: "distribution.approve", category: "LP_BANKING_FUND_ADMIN", description: "Approve distributions.", approverRoles: MP_OR_FINANCE },
  { key: "bank_account.change", category: "LP_BANKING_FUND_ADMIN", description: "Change bank accounts.", approverRoles: MP_OR_FINANCE },
  { key: "payment_instruction.approve", category: "LP_BANKING_FUND_ADMIN", description: "Approve payment instructions.", approverRoles: MP_OR_FINANCE },
  { key: "official_valuation_or_capital_account.change", category: "LP_BANKING_FUND_ADMIN", description: "Change official valuations or capital accounts.", approverRoles: MP_OR_FINANCE },
  { key: "fund_admin_record.override", category: "LP_BANKING_FUND_ADMIN", description: "Override the fund administrator, accountant, auditor, or authorized finance operator.", approverRoles: MP },
  { key: "financial_statement.certify", category: "LP_BANKING_FUND_ADMIN", description: "Certify financial statements or performance metrics.", approverRoles: MP_OR_FINANCE },
  // 3.4 Relationship and Public Authority
  { key: "introduction.relationship_sensitive", category: "RELATIONSHIP_PUBLIC", description: "Make relationship-sensitive introductions.", approverRoles: MP },
  { key: "external_contact.unauthorized", category: "RELATIONSHIP_PUBLIC", description: "Contact founders, LPs, brokers, buyers, sellers, sponsors, or portfolio companies without authority.", approverRoles: MP },
  { key: "public_statement.material", category: "RELATIONSHIP_PUBLIC", description: "Make material public statements.", approverRoles: MP },
  { key: "promise.access_or_outcome", category: "RELATIONSHIP_PUBLIC", description: "Promise access, introductions, capital, liquidity, or outcomes.", approverRoles: MP },
  { key: "portfolio_termination_advice.final", category: "RELATIONSHIP_PUBLIC", description: "Provide portfolio-company termination advice as final guidance.", approverRoles: MP },
  { key: "mp.impersonate", category: "RELATIONSHIP_PUBLIC", description: "Impersonate a Managing Partner.", approverRoles: MP },
  // Governance/system reserved actions implied by the approved plan (P3/P4 scope)
  { key: "identity_merge.execute", category: "INVESTMENT_CAPITAL", description: "Execute a destructive canonical-company merge.", approverRoles: MP },
  { key: "governance.policy_change", category: "LEGAL_COMPLIANCE", description: "Change firmwide cost/privacy/provider policy.", approverRoles: MP },
  { key: "ai_employee.activate", category: "LEGAL_COMPLIANCE", description: "Activate or reactivate an AI employee.", approverRoles: MP },
  { key: "external_effect.execute", category: "RELATIONSHIP_PUBLIC", description: "Execute any external effect (send, publish, write to external system).", approverRoles: MP },
  // P5 — promoting claims into durable institutional memory is human-reserved (D16):
  // AI may propose a promotion candidate; only a human approval receipt applies it.
  { key: "knowledge.promote", category: "LEGAL_COMPLIANCE", description: "Promote evidence into durable institutional memory (knowledge_record).", approverRoles: MP },
  // P6 — voiding a booked transaction rewrites position/history truth and is
  // human-reserved (MP), same pattern as knowledge.promote (ADR-011).
  { key: "transaction.void", category: "INVESTMENT_CAPITAL", description: "Void a transaction (reverses its position effect; the record is preserved).", approverRoles: MP },
  // P7 — recording/transcription policy activation is a named human gate (§15).
  // Consent from the counterparty is a SECOND, independent gate enforced in the service.
  {
    key: "meeting.recording_policy.activate",
    category: "LEGAL_COMPLIANCE",
    description: "Activate recording/transcription policy for a meeting (human-reserved gate).",
    approverRoles: MP_OR_COMPLIANCE,
  },
  // P9 — live Network OS writeback is a named integration approval gate (§15).
  {
    key: "network_os.writeback",
    category: "RELATIONSHIP_PUBLIC",
    description: "Write a West Peek OS record back into Network OS (live integration is a named human gate).",
    approverRoles: MP,
  },
  // Phase Meet (18 Sep 2026). ONE decision per firm, not one per call: recording/transcription
  // on by default for every Google Meet the firm hosts. Every meeting the ingest reads points its
  // recording_policy_receipt_id at this card, so the audit trail from any transcript leads back to
  // the human decision. Migration 0203 says why the per-meeting gate could not be the shape.
  {
    key: "meet.recording_policy.firm_default",
    category: "LEGAL_COMPLIANCE",
    description: "Turn the recording/transcription policy on by default for every Google Meet the firm hosts (human-reserved; one decision per firm).",
    approverRoles: MP_OR_COMPLIANCE,
  },
] as const;

export const HUMAN_RESERVED_ACTION_KEYS: readonly string[] = HUMAN_RESERVED_ACTIONS.map((a) => a.key);

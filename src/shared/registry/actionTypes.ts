/**
 * Action Type Registry — the vocabulary authorize() reasons about.
 *
 * Two families live elsewhere and are merged in by the seed generator:
 * - Human-reserved actions: src/shared/registry/reservedActions.ts (canon register).
 * Both families land in the `action_type` table; unknown action keys are DENIED
 * by authorize() (fail closed), so every action the system can perform is listed
 * in exactly one registry source.
 *
 * This file holds the implementation-defined families:
 * - ordinary internal actions (ALLOW for actors within firm scope), and
 * - external-effect action keys (is_external_effect: always REQUIRE_APPROVAL,
 *   executed only by src/worker/effects/executor.ts with an approved receipt).
 */

export interface OrdinaryActionTypeDef {
  key: string;
  name: string;
  description: string;
  isExternalEffect: boolean;
}

/** Ordinary internal actions — no external effect, not human-reserved. */
export const ORDINARY_ACTION_TYPES: readonly OrdinaryActionTypeDef[] = [
  { key: "capture.create", name: "Create capture", description: "Record unstructured input into the capture intake.", isExternalEffect: false },
  { key: "capture.route", name: "Route capture", description: "Route a capture to a machine.", isExternalEffect: false },
  { key: "capture.archive", name: "Archive capture", description: "Archive a capture without routing.", isExternalEffect: false },
  { key: "work_card.create", name: "Create work card", description: "Create a unit of governed work, optionally from a capture.", isExternalEffect: false },
  { key: "work_card.update", name: "Update work card", description: "Change work-card state, owner, priority, or next action.", isExternalEffect: false },
  { key: "approval.request", name: "Request approval", description: "Draft or submit an approval card for a governed action.", isExternalEffect: false },
  { key: "approval.decide", name: "Decide approval", description: "Approve, reject, or request revision on a pending approval card (human with required role only).", isExternalEffect: false },
  { key: "governance_update.issue", name: "Issue governance update", description: "Issue an MP rule, bulletin, or broadcast to the firm.", isExternalEffect: false },
  { key: "ai.run", name: "Run AI task", description: "Run an AI task through the governed run_ai boundary (privacy/cost/egress pipeline).", isExternalEffect: false },
  { key: "ai_employee.tool_scope.grant", name: "Grant AI tool scope", description: "Grant a tool to an AI employee. An employee can never grant scope to itself.", isExternalEffect: false },
  { key: "ai_output.accept", name: "Accept quarantined AI output", description: "Promote a quarantined external-provider AI output into governed state (human only).", isExternalEffect: false },
  // P5 — evidence/provenance substrate (D16).
  { key: "document.upload", name: "Upload document", description: "Store a governed document binary in R2 with D1 metadata/provenance and a SHA-256 version row.", isExternalEffect: false },
  { key: "claim.create", name: "Create diligence claim", description: "Record a diligence claim with mandatory source provenance (source/date/location/method/confidence/status).", isExternalEffect: false },
  { key: "claim.extract", name: "Extract claims from document", description: "Run AI extraction over a document through the run_ai boundary; candidates land AI_INFERRED/UNVERIFIED, quarantined until human accept.", isExternalEffect: false },
  { key: "claim.verify", name: "Verify claim", description: "Set a claim VERIFIED (human only, requires a DOCUMENT or HUMAN_STATEMENT source; the self-promotion ban is structural).", isExternalEffect: false },
  { key: "claim.accept", name: "Accept extracted claim", description: "Human accept of an AI-extracted (quarantined) claim with a qualifying source; re-attributes the claim to the accepting human.", isExternalEffect: false },
  { key: "claim.supersede", name: "Supersede claim", description: "Replace a claim with a new one; the superseded claim stays readable and linked.", isExternalEffect: false },
  { key: "contradiction.create", name: "Create contradiction", description: "Open a contradiction record between conflicting claims (AI may propose; it enters OPEN with proposed-by recorded).", isExternalEffect: false },
  { key: "contradiction.update", name: "Update contradiction", description: "Assign an owner or move a contradiction to INVESTIGATING.", isExternalEffect: false },
  { key: "contradiction.resolve", name: "Resolve contradiction", description: "Human-only disposition of a contradiction (RESOLVED/ACCEPTED_RISK/INVALID) with evidence.", isExternalEffect: false },
  { key: "knowledge_promotion.propose", name: "Propose knowledge promotion", description: "Propose promoting claims into durable institutional memory; creates an approval card (humans decide).", isExternalEffect: false },
  { key: "source_conflict.create", name: "Create source conflict", description: "Record a cross-system source-of-truth conflict.", isExternalEffect: false },
  { key: "source_conflict.resolve", name: "Resolve source conflict", description: "Resolve a source conflict with an append-only resolution decision (human only).", isExternalEffect: false },
  // P6 — investment workflow: opportunities, transactions, positions, deal math, IC.
  { key: "security_class.create", name: "Create security class", description: "Record a distinct share class for a canonical company (classes are never merged).", isExternalEffect: false },
  { key: "opportunity.create", name: "Create opportunity", description: "Record an investment opportunity on a canonical company (secondaries keep seller/block provenance).", isExternalEffect: false },
  { key: "opportunity.update", name: "Update opportunity", description: "Update opportunity fields (price, quantity, fees, terms, provenance).", isExternalEffect: false },
  { key: "opportunity.transition", name: "Transition opportunity", description: "Move an opportunity through its lifecycle (NEW→SCREENING→DILIGENCE→IC_READY→IC_DECIDED→CLOSED, or PASS/WITHDRAWN).", isExternalEffect: false },
  { key: "opportunity_block_link.propose", name: "Propose block link", description: "Link two opportunities as duplicate candidates or related blocks. Linking never merges.", isExternalEffect: false },
  { key: "opportunity_block_link.decide", name: "Decide block link", description: "Human confirm/reject of a proposed duplicate/related block link (human only).", isExternalEffect: false },
  { key: "transaction.create", name: "Create transaction", description: "Draft a transaction (PURCHASE/SALE/PRIMARY_INVESTMENT/FOLLOW_ON/EXIT_*); approval via the type-specific reserved action.", isExternalEffect: false },
  { key: "transaction.execute", name: "Execute transaction", description: "Mark an approved transaction EXECUTED with a valid reserved-action receipt; creates/updates positions.", isExternalEffect: false },
  { key: "transaction.party.add", name: "Add transaction party", description: "Attach a seller/buyer/broker/fund-entity party to a transaction.", isExternalEffect: false },
  { key: "ownership_snapshot.create", name: "Create ownership snapshot", description: "Record an as-of ownership snapshot with dilution assumptions and source.", isExternalEffect: false },
  { key: "pricing_observation.create", name: "Create pricing observation", description: "Record a pricing observation (BID/ASK/INDICATION/EXECUTED_TRANSACTION/PRIMARY_ROUND/INTERNAL_ESTIMATE — statuses stay distinct).", isExternalEffect: false },
  { key: "deal_math_packet.create", name: "Create deal math packet", description: "Create a deal math packet by manual entry (D6: manual entry is always supported).", isExternalEffect: false },
  { key: "deal_math_packet.update", name: "Update deal math packet", description: "Change packet inputs/assumptions; every change appends to the assumption ledger.", isExternalEffect: false },
  { key: "deal_math.calculate", name: "Calculate deal math", description: "Run the independently verified deal-math functions over packet inputs (entry_mode=CALCULATED).", isExternalEffect: false },
  { key: "deal_math_packet.review", name: "Review deal math packet", description: "Human review transition of a packet's math quality status.", isExternalEffect: false },
  { key: "ic_packet.assemble", name: "Assemble IC packet", description: "Assemble an IC packet: deal math + evidence summary + unresolved material contradictions (never filtered). AI may draft; humans decide.", isExternalEffect: false },
  { key: "dissent.create", name: "Record dissent", description: "Attach a dissent record to an IC decision (append-only).", isExternalEffect: false },
  // P7 — meeting intelligence: prep, consent, transcript, notes, commitments, debrief.
  { key: "meeting.create", name: "Create meeting", description: "Record a meeting (scheduled or historical) with its participants.", isExternalEffect: false },
  { key: "meeting.update", name: "Update meeting", description: "Update meeting fields or lifecycle status.", isExternalEffect: false },
  { key: "meeting.participant.add", name: "Add meeting participant", description: "Attach an internal or external participant to a meeting.", isExternalEffect: false },
  { key: "meeting.consent.record", name: "Record consent", description: "Append a consent state for recording/transcription/note-sharing (human only; append-only).", isExternalEffect: false },
  { key: "meeting.prep.assemble", name: "Assemble meeting prep packet", description: "Assemble a prep packet from company evidence and open questions. AI may draft.", isExternalEffect: false },
  { key: "meeting.transcript.import", name: "Import transcript", description: "Import a transcript for a meeting. Requires an activated recording policy AND granted consent.", isExternalEffect: false },
  { key: "meeting.note.add", name: "Add meeting note", description: "Add a manual, off-record, or transcript-derived meeting note.", isExternalEffect: false },
  { key: "meeting.commitment.create", name: "Record meeting commitment", description: "Record a commitment made in a meeting.", isExternalEffect: false },
  { key: "meeting.commitment.convert", name: "Convert commitment to work card", description: "Turn a meeting commitment into a governed work card.", isExternalEffect: false },
  { key: "meeting.debrief.create", name: "Create meeting debrief", description: "Record a post-meeting debrief. AI may draft; it is never evidence by itself.", isExternalEffect: false },
  {
    key: "meeting.debrief.promote_claim",
    name: "Promote debrief line to claim candidate",
    description: "Create a diligence claim candidate from a debrief/note with TRANSCRIPT/HUMAN_STATEMENT provenance (never VERIFIED).",
    isExternalEffect: false,
  },
  // P8 — portfolio monitoring, alerts, support, outcomes.
  { key: "portfolio_metric_definition.create", name: "Define portfolio metric", description: "Define a tracked portfolio metric with its direction and operator-set severity bands.", isExternalEffect: false },
  { key: "portfolio_metric_snapshot.create", name: "Record metric snapshot", description: "Record a dated portfolio metric value with its source.", isExternalEffect: false },
  { key: "portfolio_update.create", name: "Record portfolio update", description: "Record a received portfolio update for a period.", isExternalEffect: false },
  { key: "portfolio_alert.evaluate", name: "Evaluate portfolio alerts", description: "Run the deterministic alert evaluation (deterioration, stale update, missing metric).", isExternalEffect: false },
  { key: "portfolio_alert.decide", name: "Decide portfolio alert", description: "Acknowledge or resolve an alert (human disposition).", isExternalEffect: false },
  { key: "alert_suppression_rule.create", name: "Create alert suppression rule", description: "Suppress low-severity noise; a suppression can never hide a higher severity.", isExternalEffect: false },
  { key: "support_request.create", name: "Create support request", description: "Record a portfolio-company support request.", isExternalEffect: false },
  { key: "support_match.propose", name: "Propose support match", description: "Propose a match for a support request (AI may propose; it can never contact anyone).", isExternalEffect: false },
  { key: "support_match.decide", name: "Decide support match", description: "Human accept/reject of a proposed support match. Acting on it still needs the reserved introduction approval.", isExternalEffect: false },
  { key: "support_outcome.record", name: "Record support outcome", description: "Record what actually happened after support, including relationship and value notes.", isExternalEffect: false },
  // P9 — Network OS integration (D5): read-only pull, resolver cards, reserved writeback.
  { key: "network_adapter_contract.declare", name: "Declare adapter contract", description: "Publish a versioned Network OS adapter contract (ownership, direction, keys, freshness, conflict, idempotency, retry, audit, failure).", isExternalEffect: false },
  { key: "network_sync.pull", name: "Pull from Network OS", description: "Pull relationship records through the declared adapter (read-only; idempotent by delivery key).", isExternalEffect: false },
  { key: "network_conflict.resolve", name: "Resolve sync conflict", description: "Human disposition of a Network OS/WP OS divergence (never a silent overwrite).", isExternalEffect: false },
  // P10 — LP / fundraising / claims / data-room control.
  { key: "lp_record.create", name: "Create LP record", description: "Record an LP entity (LP_PRIVATE by default).", isExternalEffect: false },
  { key: "lp_opportunity.create", name: "Create LP opportunity", description: "Track a fundraising conversation with an LP.", isExternalEffect: false },
  { key: "lp_opportunity.transition", name: "Transition LP opportunity", description: "Move an LP opportunity through its governed stages.", isExternalEffect: false },
  { key: "lp_diligence_request.create", name: "Record LP diligence request", description: "Record a diligence question or document request from an LP.", isExternalEffect: false },
  { key: "lp_diligence_request.respond", name: "Respond to LP diligence request", description: "Record the firm response to an LP diligence request.", isExternalEffect: false },
  { key: "lp_claim.draft", name: "Draft LP claim", description: "Draft an LP-facing claim. AI may draft; publication needs approved evidence and a compliance receipt.", isExternalEffect: false },
  { key: "lp_claim.link_evidence", name: "Link evidence to LP claim", description: "Attach approved evidence (VERIFIED diligence claim, knowledge record, or governed document) to an LP claim.", isExternalEffect: false },
  { key: "lp_claim.submit", name: "Submit LP claim for review", description: "Submit an LP claim for the reserved marketing-claim approval.", isExternalEffect: false },
  { key: "data_room_artifact.create", name: "Register data-room artifact", description: "Register a versioned artifact intended for the EXTERNAL data room.", isExternalEffect: false },
  { key: "data_room_access.revoke", name: "Revoke data-room access", description: "Revoke a recorded data-room access grant (append-only revocation).", isExternalEffect: false },
  // P11 — fund construction, cross-sleeve allocation, reserves, follow-on. Deciding
  // an option is NOT here: each option type routes to its own reserved action.
  { key: "fund_scenario.create", name: "Create fund construction scenario", description: "Open a scenario pinned to specific mandate/sleeve/reserve/concentration policy versions.", isExternalEffect: false },
  { key: "fund_scenario.add_assumption", name: "Record scenario assumption", description: "Record a stated, visible assumption on a scenario (append-only).", isExternalEffect: false },
  { key: "allocation_option.create", name: "Add capital allocation option", description: "Add an initial, follow-on, reserve, secondary, or exit option to a scenario for comparison.", isExternalEffect: false },
  { key: "allocation_comparison.run", name: "Run cross-sleeve comparison", description: "Compute the deterministic constraint/concentration/reserve effects of every option in a scenario.", isExternalEffect: false },
  { key: "follow_on_review.create", name: "Open follow-on review", description: "Open a governed follow-on review for a portfolio position.", isExternalEffect: false },
  // P12 — LP reporting and fund-admin reconciliation. Distributing a packet is NOT
  // here: it routes to the reserved lp_sensitive_communication.send.
  { key: "reporting_period.create", name: "Open LP reporting period", description: "Open a reporting period for a fund.", isExternalEffect: false },
  { key: "reporting_packet.create", name: "Draft LP reporting packet", description: "Draft a versioned LP reporting packet for a period.", isExternalEffect: false },
  { key: "reporting_packet.submit", name: "Submit reporting packet for review", description: "Move a packet into review, opening its required review rows.", isExternalEffect: false },
  { key: "reporting_review.record", name: "Record a reporting review", description: "Record a required finance/compliance/MP review decision on a packet.", isExternalEffect: false },
  { key: "reconciliation_run.import", name: "Import administrator records for reconciliation", description: "Import an administrator/accounting export and compare it against internal records (read-only import).", isExternalEffect: false },
  { key: "reconciliation_exception.resolve", name: "Resolve a reconciliation exception", description: "Record a human disposition of a discrepancy (never an overwrite of the administrator record).", isExternalEffect: false },
] as const;

/**
 * External-effect action keys — one per effect type the executor can perform.
 * is_external_effect = true: authorize() returns REQUIRE_APPROVAL for every actor
 * unless a valid approved receipt is presented. All execution is LOCAL SIMULATION
 * in the initial build (no real sends).
 */
export const EXTERNAL_EFFECT_ACTION_TYPES: readonly OrdinaryActionTypeDef[] = [
  { key: "effect.email.send", name: "Send email", description: "External effect: deliver an email to an outside recipient (simulated locally).", isExternalEffect: true },
  { key: "effect.message.send", name: "Send message", description: "External effect: deliver a message to an external channel (simulated locally).", isExternalEffect: true },
  { key: "effect.webhook.post", name: "Post webhook", description: "External effect: POST to an external webhook endpoint (simulated locally).", isExternalEffect: true },
] as const;

/** Maps an external_effect_request.effect_type to its action key. */
export const EFFECT_TYPE_ACTION_KEYS: Readonly<Record<string, string>> = {
  "email.send": "effect.email.send",
  "message.send": "effect.message.send",
  "webhook.post": "effect.webhook.post",
};

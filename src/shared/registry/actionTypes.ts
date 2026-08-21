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
  { key: "capture.resolve", name: "Resolve capture", description: "Say what a capture is about — a company, a person, or neither — and reconcile it against the register or Network OS.", isExternalEffect: false },
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
  { key: "image.generate", name: "Generate an image", description: "Turn a prompt into a picture and file it in Documents. Nothing leaves the firm but the prompt; publishing the result is a separate, approved act.", isExternalEffect: false },
  { key: "deliverable.deliver", name: "Hand over a deliverable", description: "Record something an employee produced — a brief, a review, a research packet — and file a copy in Documents.", isExternalEffect: false },
  // NOT an external effect, and the narrowness is the whole argument. It can only reach a firm_user
  // row's registered address, enforced in the handler rather than described here, so there is no
  // version of this that leaves the firm. A typed address is effect.email.send and is approved.
  { key: "deliverable.email_self", name: "Email a deliverable to a partner", description: "Send a deliverable to a Managing Partner's own registered address. Cannot reach any address outside the firm.", isExternalEffect: false },
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
  { key: "opportunity.confirm_placeholder", name: "Confirm placeholder value", description: "Replace a value recorded as a provisional stand-in with the real one. Works on terminal records, but only for fields already marked provisional.", isExternalEffect: false },
  { key: "opportunity.backfill", name: "Backfill opportunity", description: "Record a holding that predates the system by placing its status directly, permanently marked as backfilled with a reason. Separate from transition so authority over history is grantable on its own.", isExternalEffect: false },
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
  // P14 — MP command center + daily intelligence engine. Intelligence is never evidence
  // by itself: promotion into a diligence claim still runs the P5 path.
  { key: "intelligence_source.register", name: "Register intelligence source", description: "Register a daily-intelligence source with its kind, data class, and credential requirement.", isExternalEffect: false },
  { key: "intelligence_source.update", name: "Update intelligence source", description: "Enable, disable, or re-describe a registered intelligence source.", isExternalEffect: false },
  { key: "watchlist.manage", name: "Manage watchlist", description: "Add, deactivate, or reactivate a personal or firm watchlist entry.", isExternalEffect: false },
  { key: "mp_home_preference.set", name: "Set MP home + briefing preferences", description: "Record a new version of a user's home module layout and briefing preferences.", isExternalEffect: false },
  { key: "intelligence_run.execute", name: "Run the daily intelligence engine", description: "Acquire, dedupe, score, and archive intelligence items through the governed engine.", isExternalEffect: false },
  { key: "intelligence_item.archive", name: "Archive intelligence item", description: "Remove an intelligence item from active briefings (the record is preserved).", isExternalEffect: false },
  { key: "intelligence_item.synthesize", name: "Synthesize intelligence item", description: "Run the governed AI boundary over one item to draft why-it-matters (quarantine rules apply).", isExternalEffect: false },
  { key: "intelligence_feedback.record", name: "Record intelligence feedback", description: "Record an operator relevance signal on an intelligence item.", isExternalEffect: false },
  { key: "personal_intelligence.configure", name: "Configure personal intelligence", description: "Configure the private, non-institutional personal-intelligence layer for the acting user only.", isExternalEffect: false },
  { key: "personal_intelligence.record", name: "Record personal intelligence entry", description: "Record a private personal-intelligence entry for the acting user only.", isExternalEffect: false },
  // P15 — employee lounge / digital office / performance. Raising an employee to ACTIVE stays on
  // the reserved ai_employee.activate receipt path; only the LOWERING moves live here.
  { key: "ai_employee.profile.update", name: "Update AI employee profile", description: "Set an employee's department, manager, avatar, or brief (human only).", isExternalEffect: false },
  { key: "ai_employee.assign_machine", name: "Assign machine to AI employee", description: "Assign or unassign an operating machine for an AI employee (human only).", isExternalEffect: false },
  { key: "ai_employee.lifecycle_change", name: "Lower AI employee lifecycle state", description: "Pause, restrict, or retire an AI employee. Raising to ACTIVE stays on the reserved ai_employee.activate receipt path.", isExternalEffect: false },
  { key: "employee_room.post", name: "Post to a department room", description: "Post a governed message that references work, a run, or a firm announcement.", isExternalEffect: false },
  { key: "employee_handoff.propose", name: "Propose a work handoff", description: "Propose moving a work card from one employee to another.", isExternalEffect: false },
  { key: "employee_handoff.decide", name: "Decide a work handoff", description: "Accept or reject a proposed handoff (human only).", isExternalEffect: false },
  { key: "internal_memo.create", name: "Write an internal memo", description: "Publish an internal memo to a department or the firm.", isExternalEffect: false },
  { key: "governance_update.acknowledge", name: "Acknowledge a governance update", description: "Record that an actor has read and acknowledged an MP governance update.", isExternalEffect: false },
  { key: "employee_performance.compute", name: "Compute an employee scorecard", description: "Compute a deterministic performance snapshot from run and approval history.", isExternalEffect: false },
  { key: "employee_review.record", name: "Record a manager review", description: "Record a manager review, improvement plan, or retraining decision for an employee.", isExternalEffect: false },
  // P16 — provider/model router + cost command center. These CONFIGURE the governed AI
  // boundary; they never become a second path to a provider.
  { key: "provider_model.register", name: "Register a provider model", description: "Add or update a model in the provider catalogue with its capability, context, latency, and pricing provenance.", isExternalEffect: false },
  { key: "provider_model.promote", name: "Promote or demote a model", description: "Move a model between ACTIVE, BENCH, and DEPRECATED.", isExternalEffect: false },
  { key: "provider_health.check", name: "Run a provider health check", description: "Record a provider reachability check, stamped LOCAL_FIXTURE or LIVE.", isExternalEffect: false },
  { key: "model_evaluation.record", name: "Record a model evaluation", description: "Record a benchmark or evaluation result with the method that produced it.", isExternalEffect: false },
  { key: "routing_policy.set", name: "Set a task routing policy", description: "Publish a new version of the ordered provider/model routing policy for a task class.", isExternalEffect: false },
  { key: "machine_model_policy.set", name: "Set a machine model policy", description: "Set the preferred provider/model and maximum data class for one machine.", isExternalEffect: false },
  { key: "budget_scope.set", name: "Set a scoped AI budget", description: "Publish a new version of a per-employee/machine/provider/model/category budget.", isExternalEffect: false },
  { key: "cost_alert.decide", name: "Acknowledge a cost alert", description: "Acknowledge or resolve a budget-threshold alert.", isExternalEffect: false },
  // P17 — machine control center + capability intelligence.
  { key: "machine_state.configure", name: "Configure a machine", description: "Set a machine's owner, SLA, priority, allowed tools, data access, or evidence expectation.", isExternalEffect: false },
  { key: "machine_state.pause", name: "Pause or resume a machine", description: "Stop or restart work routing and AI spend for one machine.", isExternalEffect: false },
  { key: "machine_dependency.declare", name: "Declare a machine dependency", description: "Record that one machine depends on another.", isExternalEffect: false },
  { key: "machine_memory.append", name: "Append machine memory", description: "Append a durable operating note to a machine's memory.", isExternalEffect: false },
  { key: "capability.register", name: "Register a capability", description: "Register an internal firm capability with its maturity, dependencies, and tested state.", isExternalEffect: false },
  { key: "capability.transition", name: "Move a capability between Active, Bench, and Archive", description: "Change a capability's operating state.", isExternalEffect: false },
  // The firm writing down its own methods. Drafting is an AI run; adopting is the partner deciding
  // that the drafted method is what they meant. Adoption is gated to a Managing Partner by role in
  // the service rather than by a reserved-action receipt: the budget-policy path was deliberately
  // reformed away from cards that approve themselves, and this is the same shape of act.
  { key: "firm_skill.draft", name: "Draft a method from plain English", description: "Turn what a partner wrote into a method the machine's employees follow.", isExternalEffect: false },
  { key: "firm_skill.adopt", name: "Adopt a drafted method", description: "Put a drafted method into use for every employee on that machine.", isExternalEffect: false },
  { key: "firm_skill.retire", name: "Retire a method", description: "Stop a method being read by the employees on that machine.", isExternalEffect: false },
  // Removing a document from view. Not a delete: the row, its versions and its bytes stay, and the
  // archive carries who did it, when, and why. An append-only spine cannot honestly offer more.
  { key: "document.archive", name: "Archive a document", description: "Take a document out of the shelf, keeping the record of who removed it and why.", isExternalEffect: false },
  // Removing a deal record that should not exist — a duplicate, or one created by mistake. Not a
  // pass and not a withdrawal, which are DECISIONS about a real company; this says the row itself
  // was wrong. Archive rather than delete: transactions, deal math packets and the event spine all
  // reference an opportunity by id.
  { key: "opportunity.archive", name: "Archive a deal record", description: "Take a deal record off the board, keeping who removed it and why.", isExternalEffect: false },
  { key: "capability.assign", name: "Assign a capability", description: "Assign a capability to an AI employee or a machine.", isExternalEffect: false },
  { key: "capability_after_action.record", name: "Record capability after-action", description: "Record what actually happened when a capability was used.", isExternalEffect: false },
  { key: "build_vs_buy.decide", name: "Record a build-vs-buy decision", description: "Record a build, buy, or defer decision for a capability with its rationale.", isExternalEffect: false },
  // P18 — intent-to-execution work packets + the institutional lens bench.
  { key: "work_packet.create", name: "Create a work packet", description: "Capture a rough intent and open a governed work packet around it.", isExternalEffect: false },
  { key: "work_packet.enhance", name: "Enhance a work packet", description: "Derive interpretation, ambiguities, assumptions, risks, and acceptance criteria without replacing the original text.", isExternalEffect: false },
  { key: "work_packet.update", name: "Revise a work packet", description: "Change packet fields; every change appends a revision.", isExternalEffect: false },
  { key: "work_packet.execute", name: "Execute a work packet", description: "Run an accepted work packet through the governed AI boundary and open its work card.", isExternalEffect: false },
  { key: "lens.run", name: "Run an institutional lens", description: "Record a lens verdict, critique, evidence references, and summary for a work packet.", isExternalEffect: false },
  // P19 — governed orchestration + scheduled AI employees.
  { key: "scheduled_job.create", name: "Create a scheduled job", description: "Define a recurring governed job with its schedule, target, budget, and data policy.", isExternalEffect: false },
  { key: "scheduled_job.pause", name: "Pause or resume a scheduled job", description: "Stop or restart a recurring job.", isExternalEffect: false },
  { key: "job_run.execute", name: "Run a scheduled job", description: "Execute one occurrence of a scheduled job (scheduled trigger or manual operator run).", isExternalEffect: false },
  { key: "job_run.cancel", name: "Cancel a job run", description: "Cancel a queued or running job occurrence.", isExternalEffect: false },
  // P20 — notifications. In-app delivery is the floor; push is an optional, unproven channel.
  { key: "notification.read", name: "Read a notification", description: "Mark a notification read for the acting user.", isExternalEffect: false },
  { key: "notification.acknowledge", name: "Acknowledge a notification", description: "Acknowledge a notification, recording that a human saw and accepted it.", isExternalEffect: false },
  { key: "notification_preference.set", name: "Set notification preferences", description: "Set quiet hours and per-kind notification preferences for the acting user.", isExternalEffect: false },
  // P21 — research workstation. Findings become evidence only through the P5 claim substrate.
  { key: "research_project.create", name: "Open a research project", description: "Open a governed research project around a question.", isExternalEffect: false },
  { key: "research_question.add", name: "Add a research question", description: "Add a question the project must answer.", isExternalEffect: false },
  { key: "research_source.add", name: "Record a research source", description: "Record a source consulted, with its reliability stated.", isExternalEffect: false },
  { key: "research_finding.record", name: "Record a research finding", description: "Record a finding against a question and the source that supports it.", isExternalEffect: false },
  { key: "research_finding.promote", name: "Promote a finding into evidence", description: "Promote a research finding into the governed diligence-claim substrate.", isExternalEffect: false },
  { key: "market_map.create", name: "Create a market map", description: "Record a segmented market map produced by a research project.", isExternalEffect: false },
  { key: "research_packet.assemble", name: "Assemble a research packet", description: "Assemble findings, sources, and open contradictions into an IC-ready packet.", isExternalEffect: false },
  // P22 — external connector status. Registering a connector is configuration, not integration.
  { key: "connector.check", name: "Check a connector", description: "Run a configuration check on an external connector and record the result.", isExternalEffect: false },
  { key: "meeting_prep.queue", name: "Read the meeting prep queue", description: "List upcoming meetings with their prep and consent state.", isExternalEffect: false },
  // P23 — specialist provider lane. A vendor is a provider behind run_ai(), never a bypass.
  { key: "specialist_engagement.open", name: "Open a specialist engagement", description: "Open a bounded engagement with a specialist AI provider through the governed AI boundary.", isExternalEffect: false },
  { key: "specialist_engagement.accept", name: "Accept specialist output", description: "Human accept of a quarantined specialist output. Never a legal or compliance conclusion.", isExternalEffect: false },
  // P24 — LP / fund-admin / VDR operating layer. The administrator stays authoritative.
  { key: "admin_source.register", name: "Register an administrator source", description: "Record an administrator, accounting, or VDR source with its contract state and freshness expectation.", isExternalEffect: false },
  { key: "reconciliation_schedule.set", name: "Schedule reconciliation", description: "Set the cadence on which a fund is reconciled against its administrator.", isExternalEffect: false },
  { key: "lp_engagement.update", name: "Update LP engagement state", description: "Record the current state of an LP relationship and its next step.", isExternalEffect: false },
  // P33 — Event OS and Community OS scaffolding. Ordinary internal actions: creating an event or
  // a member record changes nothing outside the firm. Inviting anyone is a separate external
  // effect and is NOT covered by these keys.
  // P37 — the weekly MP operating review (canon §8). Internal: it derives an agenda from records
  // that already exist and records how each item was resolved. Nothing leaves the firm.
  { key: "weekly_review.manage", name: "Manage weekly review", description: "Generate the weekly MP operating review from live firm state, and record how each agenda item exited.", isExternalEffect: false },
  { key: "event.manage", name: "Manage event", description: "Create or update an Event OS event and its attendee list. Internal record only; sending invitations is an external effect.", isExternalEffect: false },
  { key: "community.manage", name: "Manage community member", description: "Create or update a Community OS member record. Internal record only.", isExternalEffect: false },
  // P51 — Rooms and the community model (docs/COMMUNITY.md). All internal: a Room packet is a
  // proposal, a sponsor prospect is a record, and an act is something West Peek witnessed. The
  // external effects these lead to — emailing a sponsor, inviting a member — are already covered
  // by the email keys below, and deliberately are not granted by any key here.
  { key: "room_packet.manage", name: "Manage Room packet", description: "Generate or edit a Room proposal: theme, agenda, venue options, guest ideas and economics. Internal record only.", isExternalEffect: false },
  { key: "room_packet.decide", name: "Decide on a Room packet", description: "Approve or decline a proposed Room. Human only in code — a Room commits the firm to spend and to approaching sponsors.", isExternalEffect: false },
  { key: "sponsor.manage", name: "Manage sponsor prospect", description: "Create or advance a sponsor prospect in the Room sponsorship pipeline. Internal record only; contacting the sponsor is an external effect.", isExternalEffect: false },
  { key: "community.act", name: "Record a community act", description: "Record something West Peek witnessed a member do — attended, hosted, answered, referred. Append-only evidence.", isExternalEffect: false },
  { key: "council.decide", name: "Decide Council membership", description: "Record a Council decision with a reason. Human only in code — the Council is a judgement, never a computed threshold.", isExternalEffect: false },
  { key: "match.manage", name: "Manage introduction suggestions", description: "Propose or dismiss a suggested introduction between two people. Proposing is internal; making the introduction is a human act.", isExternalEffect: false },
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

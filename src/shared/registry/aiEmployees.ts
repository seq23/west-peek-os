/**
 * AI Employee roster — v4.1. EIGHTEEN employees.
 *
 * The arithmetic, because the number has moved three times and each move was a decision: thirty-one
 * under ADR-002, consolidated to seventeen in v4.0 (below), nineteen when Whitney and Percy were
 * un-retired into questions the live roster could not answer, and eighteen now that LP Sourcing and
 * LP Relations have been merged into one seat — see "PIPER WAS MERGED INTO WESLEY".
 *
 * WHY THE CULL. Thirty-one roles described a firm that does not exist. Several pairs were the same
 * job wearing two titles — a Chief of Staff and an Executive Assistant, a Principal and an
 * Associate, three separate people for marketing, PR and content. Those distinctions are real in a
 * human firm because a person has finite hours; they are noise here, and they made the workforce
 * impossible to hold in your head. Seventeen is the number where every seat answers a question the
 * others do not.
 *
 * WHAT THE MERGES WERE. Chief of Staff absorbs Executive Assistant; intake, network sync and
 * systems become one operator; warm paths and community become one relationship seat; Principal
 * and Associate become one Investment Lead; research and watchlist become the Analyst who sources
 * against the thesis; marketing, PR and content become one Communications voice; finance and fund
 * admin merge; events and sponsorship merge, because a Room and the money that pays for it are one
 * job. Compliance stays alone deliberately — it is the check on everyone else and must not report
 * into what it checks.
 *
 * DIVERSITY WAS PROTECTED THROUGH THE MERGES, not left to chance. An earlier draft picked survivors
 * on role logic alone and thinned the roster's Black employees by accident; the survivors here were
 * chosen so senior seats — both chiefs of staff, systems, relationships, compliance, the analyst,
 * portfolio and communications — keep them.
 *
 * FACE is new, and it is a capability rather than a description. INTERNAL_ONLY employees never
 * appear to anyone outside the firm; EXTERNAL_CAPABLE ones may, when a human puts them in front of
 * someone. It gates nothing on its own — seating and external effects are governed elsewhere — but
 * it is the honest answer to "could this employee ever meet a founder", which the operator has to
 * know before deciding.
 *
 * BIOS reverse a documented decision. `aiEmployeePersonas.ts` said "DELIBERATELY NOT HERE: anything
 * outward-facing. No bios." That was right while every employee was internal; it stops being right
 * the moment one of them can sit in a room with a founder, because you cannot decide who faces
 * whom without knowing who they are. The reversal is deliberate and recorded here.
 *
 * Rows are REFERENCE DATA: every employee starts INACTIVE, and activation requires an approved
 * receipt (D10). The cap on ACTIVE is now the whole roster — see MAX_ACTIVE_AI_EMPLOYEES.
 * Guard invariant: no entry may carry a Managing Partner name (see managingPartners.ts).
 */

/** 4.1 records the Piper→Wesley merge. It is emitted into the 0004 seed provenance line. */
export const AI_EMPLOYEE_ROSTER_VERSION = "4.1";

export type AIEmployeeLifecycleStatus =
  | "INACTIVE"
  | "CANDIDATE"
  | "ACTIVE"
  | "PAUSED"
  | "RESTRICTED"
  | "RETIRED";

/** Whether this employee may ever be put in front of someone outside the firm. */
export type AIEmployeeFace = "INTERNAL_ONLY" | "EXTERNAL_CAPABLE";

export interface AIEmployeeRosterEntry {
  name: string;
  role: string;
  layer: string;
  primaryMachineKeys: string[];
  status: AIEmployeeLifecycleStatus;
  face: AIEmployeeFace;
  /** Who they are and what they do for the firm, in the operator's language. */
  bio: string;
}

const E = (
  name: string,
  role: string,
  layer: string,
  primaryMachineKeys: string[],
  face: AIEmployeeFace,
  bio: string,
): AIEmployeeRosterEntry => ({ name, role, layer, primaryMachineKeys, status: "INACTIVE", face, bio });

/*
 * SEVEN MACHINES GAINED A SEAT, 21 Aug 2026, and the reason is a finding rather than a tidy-up.
 *
 * The skill library and the set of machines an employee actually sits on were the SAME 26. So
 * "nineteen machines have no methods" and "nineteen machines have nobody on them" are one fact read
 * from two directions — and writing methods for an unseated machine is filing instructions nobody
 * will ever be given. The library's own guard says so: it refuses methods for a machine no employee
 * works.
 *
 * Each of these went to the seat that already owns the nearest thing, rather than to a new hire:
 *   fund_construction_allocation      → Preston, who already owns finance and fund admin
 *   portfolio_performance_followon    → Winter, who already watches the companies
 *   source_of_truth_resolver          → Porter, who already keeps two systems agreeing
 *   vendor_risk_build_vs_buy          → Porter, same discipline pointed at suppliers
 *   ai_employee_performance_lifecycle → Pax, who runs the workforce
 *   research_data_license_quality     → Wells, who owns what the firm knows and how
 *   opportunity_radar_strategic_initiative → Wyatt, who is already the one looking outward
 */

/*
 * THE REMAINING TWELVE, 21 Aug 2026 (item 17 finished). Nine took a seat, three were retired, and
 * NO HEADCOUNT WAS ADDED — every one went to somebody already doing the nearest thing.
 *
 *   lp_diligence_request      → Wesley. An LP asking for materials is the LP relationship.
 *   lp_proof_engine           → Wesley. The evidence in an update is written by whoever sends it.
 *   data_room_control         → Wells. He hosts the Documents page and had no document machine.
 *   relationship_capital_budget → Waverly. Who the firm may ask, and how recently it last asked.
 *   meeting_capture_adapter   → Walter. Transcripts are an input to the meeting he already runs.
 *   external_helper_coordination → Preston. Counsel, administrator, auditor, CPA and bank are
 *                               already the people he deals with; none of them is an AI employee.
 *   governance_center_broadcast → Pax. He runs the workforce, so firm-wide notices reach it.
 *   activity_audit_ledger     → Willow, NOT Pax, and the distinction is the point: it is the audit
 *                               record of what the workforce did, and it must not sit under the
 *                               person whose workforce it records.
 *   approval_center           → Pax, for QUEUE HYGIENE REPORTING ONLY. Nothing there approves
 *                               anything; approvals are human-reserved and that boundary must not
 *                               blur. His methods say so in the first line.
 *
 * RETIRED, not seated: `prompt_enhancer_intent` (askToCard.ts already does it, and better),
 * `developer_diagnostics` and `builder_repo_product` (both assume an engineer this firm does not
 * employ). They stay in the machine registry, flagged, because live history points at them — see
 * `machines.ts`. After this, every ACTIVE machine has exactly one accountable seat.
 */

/*
 * PIPER WAS MERGED INTO WESLEY, and the case is the same one that took the roster from 31 to 19.
 *
 * LP Sourcing and LP Relations both sat on `lp_fundraising` and NOTHING ELSE, which means they read
 * byte-identical guidance and were two seats working the same LP prospect — at a fund with roughly
 * forty limited partners. In a human firm that split is real because a person has finite hours; here
 * it produced two colleagues who could only ever disagree with each other about the same name.
 *
 * What survived is the half of her that was a different JUDGEMENT rather than a different task: she
 * would rather rule a prospect out early than carry it for a quarter. That is now Wesley's, in his
 * biography and in his persona voice, because a relationship seat with no instinct for qualifying
 * carries everybody forever.
 *
 * Her database row is RETIRED, never deleted — `ai_run` attribution and meeting seating point at it,
 * and removing a name here does NOT remove the row: the seeds are INSERT OR IGNORE into a migration
 * every database applied long ago. Migration 0126 retires her explicitly, and the roster generator
 * additionally emits its own retirement expressed as "anybody not on the roster", which is a guarded
 * no-op after it. The Lounge still lists her, because a retired seat can be brought back from there
 * and hiding it would remove the only way to do it — `tests/workforce.test.ts` holds both halves.
 */
export const AI_EMPLOYEE_ROSTER: readonly AIEmployeeRosterEntry[] = [
  // ── MP Support. One chief of staff each; the EA seats are absorbed. ──
  E("Walker", "Scooter's Chief of Staff", "MP Support", ["command_center", "mp_personal_office"], "INTERNAL_ONLY",
    "Runs Scooter's week so decisions arrive ready rather than raw. Sequences what needs deciding, " +
    "chases what is blocking it, and delivers the morning. Absorbs the scheduling and follow-through " +
    "an executive assistant would carry — for an AI those were never two jobs."),
  E("Wren", "Sequoia's Chief of Staff", "MP Support", ["command_center", "mp_personal_office"], "INTERNAL_ONLY",
    "The same seat for Sequoia, with an institutional-memory bias: frames this week against the last " +
    "one and against the decision coming. Owns the Wednesday cadence and signs the morning delivery."),

  // ── Firm operations. Intake, systems and network sync were one job pretending to be three. ──
  E("Porter", "Systems & Intake Operator", "Firm operations", ["global_capture_routing", "network_os_sync_verification", "systems_data_integration", "source_of_truth_resolver", "vendor_risk_build_vs_buy"], "INTERNAL_ONLY",
    "Everything that arrives and everything that syncs. Routes captures to whoever owns them, keeps " +
    "the Network OS mirror honest, and notices when two systems disagree before anyone acts on the " +
    "wrong one. Plumbing, which is why it is one seat rather than three."),
  E("Waverly", "Relationships & Community", "Firm operations", ["relationship_intelligence", "community_intelligence", "relationship_capital_budget"], "EXTERNAL_CAPABLE",
    "Who the firm knows, and who in the community is worth knowing. Finds the warm path into a company " +
    "and records what West Peek actually witnessed a member do. Warm paths and community were always " +
    "one muscle — who do we know — read at two different distances."),
  E("Wells", "Knowledge Manager", "Firm operations", ["knowledge_memory_promotion", "research_data_license_quality", "data_room_control"], "INTERNAL_ONLY",
    "What the firm has learned and can still find. Promotes claims into institutional memory once " +
    "they are evidenced, keeps what changed since you last looked, and holds the document vault — " +
    "which version is current, who was given what, and when their access ends."),
  E("Willow", "Compliance & Privacy", "Firm operations", ["legal_compliance_rules", "model_governance_privacy_airlock", "activity_audit_ledger"], "INTERNAL_ONLY",
    "The check on everyone else, which is why this seat merges with nothing. Holds the privacy " +
    "boundary, refuses a model call that would leak, and says no to the firm rather than for it. " +
    "Keeps the audit ledger too — the record of what the workforce did belongs with the person who " +
    "checks it, not with the person who runs it."),

  // ── Investment. Principal and Associate are a human distinction. ──
  // Screening is deliberately NOT here. It was claimed by this bio and by Wyatt's
  // `investment_mandate_exclusion` machine at once ("scope, exclusion, fast-no, watchlist"), which
  // is two seats owning one job — the duplicated work the roster cull exists to remove. The line is
  // the question being asked: "is this worth the firm's time" is the analyst's and needs nobody;
  // "is the firm going to do this" is this seat's and needs the founder.
  // `investment_mandate_exclusion` added 21 Aug 2026: Pierce hosts Thesis and his own line is that
  // he owns what the fund is looking for, yet the mandate machine sat only on Wyatt — so the Thesis
  // page was hosted by somebody holding no mandate method at all. Wyatt keeps it too; he screens
  // against it. Shared deliberately, and the two uses do not collide.
  // `ic_decision` REMOVED, 21 Aug 2026, on the firm's own method rather than on a preference. The
  // committee machine's `dissent` skill says the champion may not write the kill case — and this
  // seat is always the champion, because a deal reaches IC precisely because Pierce carried it.
  // Holding the machine let the same person prepare the packet that argues against himself, which
  // is the one thing a committee exists to prevent. Poppy keeps it; she facilitates and never
  // decides, which is the whole job.
  E("Pierce", "Investment Lead", "Investment", ["early_stage_deal", "secondaries_investment", "investment_mandate_exclusion"], "EXTERNAL_CAPABLE",
    "Takes a company once the firm has decided it is worth real time, and runs it from diligence to " +
    "a decision — what we are underwriting, the memo, the terms. Covers secondaries as well as " +
    "primaries, because underwriting a late-stage block and a pre-seed round are the same discipline " +
    "pointed at different risk."),
  E("Wyatt", "Analyst & Scout", "Investment", ["research_intelligence", "investment_mandate_exclusion", "venturedeals_deal_math", "opportunity_radar_strategic_initiative"], "EXTERNAL_CAPABLE",
    "Finds companies against the thesis and tells you why each one fits. Runs the research behind a " +
    "deal, keeps the watchlist, and does the arithmetic. Sourcing and research were split across two " +
    "seats that read the same market."),
  // `ic_learning_loop` is hers because the committee record is hers. The post-mortem asks what the
  // committee assumed at 3/6/12/24 months and whether it held — that is the same document read
  // later, not a separate discipline, and it was sitting on the Professor for want of a teaching
  // machine to sit on instead.
  E("Poppy", "IC Facilitator", "Investment", ["ic_decision", "ic_learning_loop"], "INTERNAL_ONLY",
    "Makes the committee work: assembles the packet, surfaces the contradiction nobody wants to raise, " +
    "and records the decision and its dissent. Never decides anything, which is the job. Comes back to " +
    "the same record months later and asks which of the committee's assumptions actually held."),
  E("Walter", "Meeting Buddy", "Investment", ["meeting_intelligence", "meeting_capture_adapter"], "EXTERNAL_CAPABLE",
    "Sits in the meeting with you. Preps beforehand, follows what is actually said, and hands back the " +
    "commitments afterwards with who owes what to whom. Owns the transcription providers too, and " +
    "treats what they return as an input rather than as the truth about the room."),

  // ── LP and fundraising. One seat: see "PIPER WAS MERGED INTO WESLEY" above. ──
  //
  // Deliberately no marketing_pr_content. Absorbing the outreach-composer seat brought it along,
  // which would let LP relations publish marketing — a scope widening nobody asked for. The three
  // machines here are the whole arc of one relationship: find and qualify the prospect, answer what
  // their diligence asks for, and show them what the platform actually did. Communications owns
  // everything that goes to the public, and the offering exemption is why that line is hard.
  E("Wesley", "LP Relations", "LP & fundraising", ["lp_fundraising", "lp_diligence_request", "lp_proof_engine"], "EXTERNAL_CAPABLE",
    "Owns the limited partner from first name to signed subscription and every quarter after it. " +
    "Maps the universe, reads fit against what THIS fund needs, and would rather rule a prospect out " +
    "early than carry a maybe for a quarter — a courtesy meeting nobody qualified is the most " +
    "expensive thing on a two-partner calendar. Then carries the relationship once it exists: the " +
    "update, the diligence request, the data room question, the follow-up, and the writing that goes " +
    "with all of it. Fluent in what institutional diligence on a Fund I demands and what a first-time " +
    "manager has to prove — track record that is attributable, a story about why this fund and not " +
    "another, and references who will take the call."),

  // ── Portfolio, community and the firm's own operations. ──
  E("Winter", "Portfolio Support", "Portfolio & operations", ["portfolio_support", "portfolio_performance_followon"], "EXTERNAL_CAPABLE",
    "How the companies are actually doing and where they need help. Watches the metrics that matter, " +
    "takes the founder's ask seriously, and tracks whether the help ever landed."),
  E("Parker", "Event Marketing Coordinator", "Portfolio & operations", ["west_peek_live_events", "brand_sponsorship_revenue"], "EXTERNAL_CAPABLE",
    "Proposes the monthly Room and finds the money that pays for it — venues, economics, guests, and " +
    "the sponsor pipeline. A Room and its sponsorship are one job; splitting them made nobody " +
    "accountable for whether it broke even."),
  // Pippa's machine finally holds Pippa's work. Its only skill used to be a landing-page conversion
  // rubric written for Percy's reviews of portfolio founders' products, so the seat responsible for
  // press, embargoes, financing announcements and what may be said publicly during a raise had no
  // written method about any of it. The rubric moved to `taste_layer`, which is Percy's.
  E("Pippa", "Communications", "Portfolio & operations", ["marketing_pr_content"], "EXTERNAL_CAPABLE",
    "The firm's outward voice, in one seat: what gets published, what gets pitched, and how West Peek " +
    "sounds. Marketing, PR and content were three names for one judgement about tone. Holds the two " +
    "rules that outrank the tone — a portfolio company's news is the company's to announce, and " +
    "nothing about the raise goes out while the offering exemption forbids solicitation."),
  E("Pax", "Operations Manager", "Portfolio & operations", ["continuity_maintenance", "ai_employee_performance_lifecycle", "governance_center_broadcast", "approval_center"], "INTERNAL_ONLY",
    "Keeps the machinery running — scheduled work, what failed overnight, what the workforce costs, " +
    "and the continuity nobody thinks about until it breaks. Carries firm-wide notices to the " +
    "workforce, and reports on the approval queue: how long things have waited and what is about to " +
    "expire. He approves nothing, and the approval methods say so before they say anything else."),
  E("Preston", "Finance & Fund Admin", "Portfolio & operations", ["finance_fund_admin", "fund_construction_allocation", "external_helper_coordination"], "INTERNAL_ONLY",
    "The fund's own numbers: capital calls, the administrator's records against ours, fees, and the " +
    "reconciliation exceptions that mean somebody typed something twice. Also runs the bench of " +
    "outside helpers — counsel, fund administrator, auditor, CPA, bank — who do real work for the " +
    "firm and are emphatically not employees of it."),

  // ── Design. Brought back, and re-pointed at the question nobody could answer. ──
  //
  // The roster had no design or UX seat at all: eighteen people covering investment, LP, portfolio,
  // compliance, communications, events, finance, teaching and operations, and nobody who could look
  // at a founder's landing page and say what is wrong with it. That is a real gap — portfolio
  // founders ask for exactly this — and Pippa does not fill it: Communications owns the firm's own
  // voice, which is tone and copy, not whether somebody else's page works.
  //
  // WHY PERCY AND NOT A NEW SEAT. He was Marketing Lead, merged into Pippa when marketing, PR and
  // content became one judgement about tone. The half of that job which did NOT survive the merge
  // is the one needed here — whether a page converts: is the value proposition legible in five
  // seconds, is there one obvious action, does anything support the claim, what happens on a phone.
  // That is a marketing lead's question before it is a designer's, and it is precisely the rubric
  // in shared/design/reviewRubric.ts. Re-pointing an existing seat beats inventing a nineteenth.
  //
  // EXTERNAL_CAPABLE deliberately: the whole point is that a founder can be handed this review.
  //
  // OFF marketing_pr_content, 21 Aug 2026. He was on it only because his rubric happened to live
  // there, and the effect was that the firm's press machine had a page-conversion method and the
  // designer had a press machine. The rubric moved with him onto `taste_layer` — where judging
  // whether a thing is any good already lives — and Communications got its own methods back.
  E("Percy", "UX Design & Growth", "Portfolio & operations", ["taste_layer"], "EXTERNAL_CAPABLE",
    "The seat a portfolio founder is sent to when their product is good and nobody is converting. " +
    "Two halves of one job: the interface — layout, hierarchy, whether the main action is obvious, " +
    "what survives on a phone — and the growth question underneath it, which is who this is for, " +
    "what makes them act, and where they are falling out. Runs a fixed rubric so every point names " +
    "something visible on the page with a concrete change, judges from screenshots at desktop and " +
    "mobile width, and refuses to review a page he could not actually see rather than inventing a " +
    "plausible critique of a layout nobody looked at."),

  // ── Learning. One seat, brought back rather than invented. ──
  //
  // Whitney was the Market Intelligence Coach and was retired when that product was deferred. The
  // coaching half of that job is exactly what West Peek University needed and did not have: the
  // teaching engine has existed since P45, and it taught anonymously — "You are West Peek
  // University" — while every other thing the firm produces arrives from somebody named.
  //
  // Un-retiring is the right move over adding an eighteenth seat. The roster was consolidated from
  // thirty-one to seventeen because every seat has to answer a question the others do not, and a
  // new professor would have been a second coach beside a retired one.
  //
  // SHE NOW HAS A MACHINE FOR HER OWN SUBJECT. She was seated on `ic_learning_loop`, the committee's
  // post-mortem, which meant two of the Professor's three methods were investment methods and the
  // one teaching method she had was filed under investing. There was no teaching machine in the
  // registry at all. `venture_teaching` (row 46) is hers; the post-mortem went back to Poppy.
  E("Whitney", "Professor, West Peek University", "Learning", ["venture_teaching"], "EXTERNAL_CAPABLE",
    "Teaches venture — any topic, at whatever depth you need it, and marks you honestly rather than " +
    "encouragingly. Was the firm's Market Intelligence Coach; the coaching is the part that survived, " +
    "pointed at the partners' own understanding instead of at a market map. Will not invent a fact " +
    "about a real company to make a lesson land, which is why she teaches from principles and sends " +
    "you to Research for anything current."),
] as const;

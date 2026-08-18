/**
 * The West Peek IC Diligence Framework (P34).
 *
 * Authored by the Managing Partner, 17 Aug 2026. Reproduced here as data rather than prose so the
 * IC portal can render it, track which questions got answered, and refuse to call diligence
 * complete while a mandatory section is empty.
 *
 * THE STATED PURPOSE, in the operator's words: "The point isn't to mechanically ask 50 questions in
 * every IC; it's to prevent us from falling in love with a story and forgetting an entire category
 * of risk." That sentence is the design brief for the whole module. Coverage is the goal, not
 * interrogation — so sections track ANSWERED / OPEN / NOT_APPLICABLE, and an honest
 * "not applicable, because…" is a complete answer.
 *
 * Two structural rules come from the same source and are enforced elsewhere in code, not left to
 * good intentions:
 *
 *   1. THE CLOSING SIX are mandatory for every investment regardless of sector.
 *   2. THE DEAL CHAMPION MUST NOT ANSWER THE BEAR CASE FIRST. "Otherwise IC has a nasty tendency to
 *      become a sales meeting for the investment rather than an actual decision process." That is a
 *      procedural rule about WHO speaks, so it is modelled as an authorship constraint on the
 *      kill-case section rather than as advice in a tooltip.
 *
 * Every company gets CORE_SECTIONS. A sector module is layered on top when the company's sector
 * matches. Nothing here decides anything — it is the question set the humans work through.
 */

export type SectionId =
  | "founder" | "problem" | "product" | "market" | "traction" | "distribution"
  | "competition" | "moat" | "financing" | "return_math" | "kill_case";

export type Sector =
  | "AI" | "HEALTH_TECH" | "EDTECH" | "CONSUMER" | "B2B_SAAS"
  | "FINTECH" | "MARKETPLACE" | "BIOTECH" | "CYBERSECURITY" | "OTHER";

export interface DiligenceSection {
  id: SectionId;
  title: string;
  /** Why this section exists — shown to whoever is filling it in. */
  intent: string;
  questions: readonly string[];
  /**
   * The one question that does the most work. Called out separately because the operator wrote
   * them as "killer questions" and burying them in a list of twelve loses them.
   */
  killer?: string;
  /** Mandatory sections block completion when unanswered. */
  mandatory: boolean;
  /**
   * When set, the deal champion may not be the author. Enforced for the kill case: an anti-bias
   * rule that only works if the system knows who the champion is.
   */
  championMayNotAnswer?: boolean;
}

export const CORE_SECTIONS: readonly DiligenceSection[] = [
  {
    id: "founder",
    title: "Founder / Team",
    intent: "At early stage we underwrite people almost as much as the business.",
    mandatory: true,
    questions: [
      "Why this founder for this problem?",
      "What evidence of genuine domain expertise or unique insight do they have?",
      "How obsessed are they with the problem versus merely interested in building a startup?",
      "What have they learned that competitors and investors don't understand?",
      "What is their history of execution?",
      "Can they recruit exceptional people?",
      "Are the founders complementary, or are important capabilities missing?",
      "How do they respond when challenged?",
      "What have references, customers and former colleagues told us?",
      "Any integrity, governance, reputation, litigation or background concerns?",
      "What would have to be true for us to conclude the founder is the reason NOT to invest?",
    ],
    killer:
      "If this exact business had a mediocre founder, would we still want it? If not, what specifically makes us believe this founder can create the exceptional outcome?",
  },
  {
    id: "problem",
    title: "Problem / Customer",
    intent: "Evidence that the company solves something people genuinely care about.",
    mandatory: true,
    questions: [
      "Who exactly is the customer?",
      "Who is the user versus the economic buyer?",
      "What painful problem are they solving?",
      "How is the problem solved today?",
      "Must-have, painkiller, or vitamin?",
      "How frequently does the customer experience the problem?",
      "What measurable value does the product create?",
      "Are customers actually paying?",
      "Why did the first customers buy?",
      "Why have customers churned or declined to buy?",
      "What happens to a customer if this company disappears tomorrow?",
      "Is usage becoming more embedded over time?",
    ],
  },
  {
    id: "product",
    title: "Product",
    intent: "Great demo ≠ great product ≠ great company.",
    mandatory: true,
    questions: [
      "What exactly does the product do?",
      "Can we explain its value in one sentence?",
      "What is materially better than existing alternatives?",
      "How quickly does a new customer reach value?",
      "What does actual usage look like?",
      "Which features drive retention?",
      "What evidence of product-market fit exists?",
      "What's on the roadmap — and does it deepen the moat or merely add features?",
      "What can competitors replicate easily?",
      "What has to be built for the product to serve customers 10× larger?",
    ],
  },
  {
    id: "market",
    title: "Market",
    intent:
      "Beyond TAM. For an early-stage fund seeking extreme outcomes, 'could reach $1B' is not enough — we need a path to an outcome that moves the fund.",
    mandatory: true,
    questions: [
      "What is the realistic beachhead market?",
      "How large can the core business become?",
      "Is the market growing, shrinking, or being created?",
      "What structural change makes this possible now?",
      "Who controls purchasing?",
      "How fragmented or concentrated is the customer base?",
      "What adjacent markets can the company credibly enter?",
      "Does winning the first market create an advantage entering the second?",
      "Could this realistically support a $10B+ company?",
      "What revenue scale and multiple would that valuation require?",
      "Is there a credible path to that scale — or are we simply saying 'huge TAM'?",
    ],
  },
  {
    id: "traction",
    title: "Traction & Unit Economics",
    intent: "Which metrics matter depends on stage; asking is not optional.",
    mandatory: true,
    questions: [
      "Revenue; ARR/MRR where applicable",
      "YoY and MoM growth",
      "Number of paying customers",
      "Average contract or order value",
      "Gross margin",
      "CAC, LTV, CAC payback",
      "Burn, runway, burn multiple",
      "Revenue concentration",
      "Pipeline versus signed contracts",
      "Gross retention and net revenue retention",
      "Logo churn and revenue churn",
      "Cohort behaviour",
    ],
    killer: "What metric looks good superficially but gets worse when we inspect the underlying cohorts?",
  },
  {
    id: "distribution",
    title: "Distribution",
    intent: "One of the things West Peek cares about most.",
    mandatory: true,
    questions: [
      "How are customers acquired today?",
      "Who owns distribution?",
      "What is CAC by channel?",
      "Which acquisition channel has actually been proven?",
      "Founder-led sales or a repeatable sales machine?",
      "Sales cycle and conversion rate",
      "What prevents the company from simply buying unprofitable growth?",
      "Are there channel or platform dependencies?",
      "Does distribution improve as the company scales?",
      "Network effects, referrals, virality, partnerships, embedded distribution, ecosystem advantages?",
      "What is the credible path from today's distribution to 100× today's customer base?",
      "What breaks first if demand increases 10×?",
    ],
    killer: "If we gave them $20M tomorrow, do they actually know how to turn it into substantially more customers?",
  },
  {
    id: "competition",
    title: "Competition",
    intent: "Never accept 'we don't have competitors'.",
    mandatory: true,
    questions: [
      "What are customers using instead?",
      "Who are the direct competitors?",
      "Who are the indirect competitors?",
      "Why hasn't an incumbent already solved this?",
      "What happens if an incumbent copies the feature?",
      "What does the company consistently win on?",
      "Why does it lose deals?",
      "What are competitors better at?",
      "What happens if a well-capitalised entrant underprices them?",
      "Could a platform vendor simply absorb this functionality?",
    ],
    killer: "What would make us invest in the competitor instead?",
  },
  {
    id: "moat",
    title: "Moat",
    intent:
      "Don't ask 'what's the moat?' — break it apart. Sources: data, network effects, switching costs, distribution, brand, workflow, proprietary technology, regulatory advantage, economies of scale, ecosystem, supply, IP.",
    mandatory: true,
    questions: [
      "What moat exists today?",
      "What moat could exist in five years?",
      "Does every new customer strengthen it?",
      "Does accumulated data improve the product?",
      "Does switching become harder with time?",
      "Is proprietary data actually proprietary?",
      "Can competitors obtain equivalent data?",
      "Does scale improve economics?",
      "How long would a well-funded competitor need to replicate the product?",
    ],
    killer: "What becomes more defensible at 1,000 customers than it was at 100?",
  },
  {
    id: "financing",
    title: "Financing / Cap Table",
    intent: "What has been promised to whom, and what this round actually buys.",
    mandatory: true,
    questions: [
      "How much has been raised, at what valuations?",
      "Who owns what? Founder ownership? Employee option pool?",
      "Existing investors; any unusual preferences?",
      "SAFEs, notes or warrants outstanding?",
      "What does the fully diluted cap table look like?",
      "How much dilution does this round create?",
      "How much runway does the round purchase?",
      "What milestones must be achieved before the next financing?",
      "Is the company likely to require unusually large amounts of capital?",
      "Who is likely to finance subsequent rounds?",
    ],
  },
  {
    id: "return_math",
    title: "West Peek Return Math",
    intent:
      "Mandatory on every IC: a wonderful company can still be a bad venture investment at the wrong price or ownership.",
    mandatory: true,
    questions: [
      "Entry valuation, check size, initial ownership",
      "Expected dilution and expected exit ownership",
      "Base, upside and downside exit values",
      "Gross MOIC under each",
      "Potential cash returned to West Peek",
      "Percentage of the fund potentially returned",
      "How much follow-on capital would maintaining ownership require?",
      "Does pro rata make economic sense?",
      "What outcome is required to return 1× the fund?",
      "What outcome produces 3×+ the fund?",
      "Is a $10B+ outcome plausible?",
      "Does the return compensate us for the probability of failure and the duration?",
    ],
  },
  {
    id: "kill_case",
    title: "Risks / Kill Case",
    intent:
      "This section should be uncomfortable. The deal champion does not write it — otherwise IC becomes a sales meeting for the investment rather than a decision process.",
    mandatory: true,
    championMayNotAnswer: true,
    questions: [
      "What are the three strongest reasons not to invest?",
      "What assumption carries the most investment risk?",
      "What have we not verified?",
      "What evidence contradicts our thesis?",
      "What happens if growth slows by 50%?",
      "What happens if fundraising markets close?",
      "What happens if the incumbent responds?",
      "What regulatory, platform or customer dependency could kill this?",
      "What did management avoid answering?",
      "What are we assuming because we like the founder?",
      "What would have to happen over the next 12 months for us to admit our thesis was wrong?",
    ],
    killer: "If this company fails, what will probably have killed it?",
  },
] as const;

export interface SectorModule {
  sector: Sector;
  title: string;
  intent: string;
  questions: readonly string[];
  killer?: string;
}

export const SECTOR_MODULES: readonly SectorModule[] = [
  {
    sector: "AI",
    title: "AI / AI Infrastructure",
    intent: "Are we investing in durable company value, or a temporary wrapper around someone else's model?",
    questions: [
      "What models does the product depend on — proprietary, open source, or third-party APIs?",
      "What happens if frontier-model capabilities commoditise?",
      "What happens if inference prices fall 90%?",
      "What happens if the underlying model provider launches this feature?",
      "What proprietary data does the company accumulate?",
      "Does customer usage create a data flywheel? Is that data legally usable for improving the system?",
      "How is model quality evaluated? Hallucination and error rate?",
      "Human-in-the-loop requirements?",
      "Cost per inference or task; gross margin after compute; does margin improve with scale?",
      "Model and provider concentration — can they swap foundation models?",
      "Latency; security and privacy implications",
      "Why is AI necessary rather than merely marketable?",
      "Does the product replace labour, increase productivity, or create a new capability?",
      "How measurable is the ROI?",
      "What is the moat when everyone has access to similar models?",
    ],
    killer:
      "If OpenAI, Anthropic or Google made the underlying intelligence essentially free tomorrow, does this company become stronger or disappear?",
  },
  {
    sector: "HEALTH_TECH",
    title: "Health Tech",
    intent: "The danger is confusing an attractive product with something that survives healthcare's incentives and regulation.",
    questions: [
      "Who is the user, who is the buyer, who pays, who financially benefits — and are those four aligned?",
      "Provider, payer, employer, pharma, patient or government?",
      "Reimbursement required? Which codes?",
      "Regulatory pathway; FDA involvement; HIPAA; PHI",
      "Clinical validation; evidence of improved outcomes",
      "EHR integration; Epic/Cerner dependency",
      "Implementation time; procurement cycle; who approves purchasing",
      "Patient and provider adoption",
      "Medical liability; data ownership; security",
      "Does workflow integration create switching costs?",
      "Does accumulated longitudinal data create defensibility?",
      "Revenue concentration among health systems",
      "What happens if reimbursement changes?",
    ],
    killer: "Who has both the authority AND the economic incentive to buy this?",
  },
  {
    sector: "EDTECH",
    title: "EdTech",
    intent: "Who actually chooses, who pays, and whether anyone uses it.",
    questions: [
      "Student, teacher, parent, school, district, university or employer — which is the customer?",
      "Who pays? Procurement cycle? Budget source?",
      "Evidence that outcomes improve; engagement versus actual learning",
      "Retention across school years; seasonal revenue",
      "Teacher adoption; implementation burden",
      "FERPA, COPPA and privacy implications",
      "Does it integrate into existing LMS/SIS systems?",
      "District concentration; institutional versus direct-to-consumer",
      "What happens when school budgets tighten?",
      "AI cheating and academic-integrity implications",
      "Does AI commoditise the product? Can it prove educational ROI?",
    ],
    killer: "Is this something educators and students love using — or something administrators buy that nobody uses?",
  },
  {
    sector: "CONSUMER",
    title: "Consumer",
    intent: "Consumer diligence is heavily about behaviour.",
    questions: [
      "DAU/WAU/MAU and DAU/MAU ratio",
      "D1/D7/D30/D90 retention; cohort retention",
      "Organic versus paid acquisition; CAC by channel",
      "Viral coefficient and referrals",
      "Frequency of use; why does someone come back tomorrow; what habit is forming?",
      "Is growth driven by product or marketing spend?",
      "Monetisation, ARPU, LTV, payback",
      "Platform dependence and app-store risk",
      "Network effects; brand",
      "Does engagement survive after incentives and promotions disappear?",
      "What prevents TikTok, Meta or Apple from copying it?",
    ],
    killer: "If they stopped spending money acquiring users tomorrow, what happens to growth?",
  },
  {
    sector: "B2B_SAAS",
    title: "B2B SaaS",
    intent: "Whether the product is genuinely mission critical.",
    questions: [
      "ICP, buyer, user",
      "ACV, sales cycle, pipeline, win rate",
      "CAC, CAC payback, gross margin",
      "GRR, NRR, logo churn, expansion revenue",
      "Implementation time and time-to-value",
      "Seat and product expansion",
      "Mission critical? Switching costs?",
      "Customer concentration",
      "Founder-led versus repeatable sales",
      "Enterprise security requirements; integration depth",
    ],
    killer: "What happens when the customer tries to remove this product? If the answer is essentially 'nothing', that's telling.",
  },
  {
    sector: "FINTECH",
    title: "FinTech",
    intent: "Find the risk the company is actually holding.",
    questions: [
      "Who holds funds? Who moves funds? Who bears credit and fraud risk?",
      "Licences required; bank partner dependencies",
      "Regulatory exposure; KYC/AML",
      "Fraud rates, loss rates, chargebacks",
      "Take rate, transaction volume, gross and net revenue",
      "Contribution margin; cost of capital",
      "Default rates; funding source",
      "Concentration among banking and payment partners",
      "What happens if the sponsor bank terminates the relationship?",
      "Compliance organisation; state and federal regulatory exposure",
    ],
    killer: "Which risk is the company actually retaining, even if management describes itself as 'just software'?",
  },
  {
    sector: "MARKETPLACE",
    title: "Marketplace",
    intent: "Liquidity, and whether scale genuinely compounds it.",
    questions: [
      "Which side is harder to acquire?",
      "Supply growth; demand growth",
      "Liquidity by market and category; match rate; time to match",
      "GMV; take rate; repeat rate",
      "CAC by side; contribution margin",
      "Geographic density",
      "Disintermediation — what prevents buyer and seller going off-platform?",
      "Does greater scale actually improve liquidity?",
      "Are network effects local or global?",
    ],
    killer: "Does adding the 10,001st participant actually make the marketplace better for the other 10,000?",
  },
  {
    sector: "BIOTECH",
    title: "Biotech / Life Sciences",
    intent: "Needs specialised scientific diligence rather than pretending generalist VC judgement is enough.",
    questions: [
      "Biological mechanism and the evidence supporting it",
      "Preclinical or clinical stage; trial design; endpoints; safety",
      "Regulatory pathway",
      "IP and patent life; competing programs",
      "Probability of technical success",
      "Capital required to next inflection; time to next inflection",
      "Manufacturing",
      "Reimbursement and commercialisation; strategic acquirers",
      "What result would invalidate the scientific thesis?",
    ],
    killer: "What requires an outside scientific expert before IC can responsibly decide?",
  },
  {
    sector: "CYBERSECURITY",
    title: "Cybersecurity",
    intent: "Whether it is bought, deployed, and hard to remove.",
    questions: [
      "What attack or risk does it prevent?",
      "Buyer: CISO, CIO, developer, compliance?",
      "Budget source; deployment friction",
      "False positives and negatives",
      "Integrations; time-to-value; proof of efficacy",
      "Security certifications",
      "Does the product itself create a new attack surface?",
      "Incumbent bundling risk",
      "Renewal and expansion; how difficult is replacement?",
    ],
  },
] as const;

/**
 * The Closing Six — mandatory for every West Peek investment regardless of sector.
 *
 * "If IC cannot give strong answers to those six, we haven't finished diligence."
 */
export const CLOSING_SIX: readonly { n: number; question: string; championMayNotAnswer?: boolean }[] = [
  { n: 1, question: "Why this founder?" },
  { n: 2, question: "Why now?" },
  { n: 3, question: "How does this company acquire customers at enormous scale?" },
  { n: 4, question: "What becomes increasingly defensible as it grows?" },
  { n: 5, question: "How does this plausibly become a $10B+ company, and what does West Peek make if it does?" },
  // The anti-bias rule, attached to the question it protects.
  { n: 6, question: "What's the strongest argument that we should NOT invest?", championMayNotAnswer: true },
] as const;

export function sectorModule(sector: Sector): SectorModule | undefined {
  return SECTOR_MODULES.find((m) => m.sector === sector);
}

/** Every section a given company must work through: core, plus its sector module if any. */
export function sectionsFor(sector: Sector): {
  core: readonly DiligenceSection[];
  sector: SectorModule | undefined;
  closingSix: typeof CLOSING_SIX;
} {
  return { core: CORE_SECTIONS, sector: sectorModule(sector), closingSix: CLOSING_SIX };
}

/** Sections whose author may not be the deal champion. */
export function championRestrictedSections(): SectionId[] {
  return CORE_SECTIONS.filter((s) => s.championMayNotAnswer).map((s) => s.id);
}

/** Total question count for a sector — used to show coverage honestly rather than a fake percentage. */
export function questionCount(sector: Sector): number {
  const core = CORE_SECTIONS.reduce((n, s) => n + s.questions.length, 0);
  return core + (sectorModule(sector)?.questions.length ?? 0) + CLOSING_SIX.length;
}

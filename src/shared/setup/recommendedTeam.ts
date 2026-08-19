import { AI_EMPLOYEE_ROSTER, type AIEmployeeRosterEntry } from "../registry/aiEmployees";

/**
 * The recommended starting team (P26 §4).
 *
 * Pure and derived. It reads the SAME roster the rest of the system reads and returns a
 * recommendation with a reason per employee — it does not hold its own list of people, because a
 * second roster is a second source of truth and the brief forbids one.
 *
 * It recommends. It cannot activate: activation needs an approved `ai_employee.activate` receipt
 * and is capped at five by the server. Nothing here bypasses either, and this module deliberately
 * has no access to the database or the network so it *cannot*.
 */

/** The firm's stated operating priorities, in the order the brief lists them. */
export const FUND_PRIORITIES = [
  "FUNDRAISING_LP",
  "DEAL_SOURCING",
  "DILIGENCE_IC",
  "WEDNESDAY_MP_MEETING",
  "PORTFOLIO_COMMUNITY",
  "COMPLIANCE_SAFEGUARDS",
] as const;

export type FundPriority = (typeof FUND_PRIORITIES)[number];

export const PRIORITY_LABEL: Record<FundPriority, string> = {
  FUNDRAISING_LP: "Fund I fundraising and LP preparation",
  DEAL_SOURCING: "Deal sourcing and research",
  DILIGENCE_IC: "Diligence and investment-decision preparation",
  WEDNESDAY_MP_MEETING: "Wednesday MP meeting preparation",
  PORTFOLIO_COMMUNITY: "Portfolio and community support",
  COMPLIANCE_SAFEGUARDS: "Compliance, privacy and operating safeguards",
};

export interface Recommendation {
  /** Roster name — the join key back to the registry. */
  name: string;
  role: string;
  layer: string;
  /** Which stated priority this hire answers. */
  priority: FundPriority;
  /** Why this role, in the operator's language. Shown verbatim in the UI. */
  because: string;
  /** Rank within the recommendation, 1 = strongest case. */
  rank: number;
}

/**
 * Ranked candidates, strongest case first.
 *
 * One per priority, so a five-slot cap covers five of the six stated priorities and the sixth is
 * visibly the thing being traded away rather than silently dropped. The order encodes a judgement:
 * a fund that is raising Fund I and has no deal flow has a different first hire than one that is
 * deployed, and the brief puts fundraising first.
 */
const CANDIDATES: ReadonlyArray<Omit<Recommendation, "rank">> = [
  {
    name: "Wesley",
    role: "LP Relations",
    layer: "LP & fundraising",
    priority: "FUNDRAISING_LP",
    because:
      "Fund I is the firm's active constraint. Wesley keeps LP conversations, materials and " +
      "follow-ups moving so the raise does not depend on whichever partner last had time.",
  },
  {
    name: "Wyatt",
    role: "Analyst & Scout",
    layer: "Investment",
    priority: "DEAL_SOURCING",
    because:
      "Pre-seed sourcing is continuous monitoring, not a weekly search. Wyatt watches the " +
      "companies and signals already on the list so movement surfaces without being asked for.",
  },
  {
    name: "Pierce",
    role: "Investment Lead",
    layer: "Investment",
    priority: "DILIGENCE_IC",
    because:
      "Diligence is the most preparation-heavy work the partners do. Pierce runs a deal from " +
      "first look to a decision, so an IC discussion starts from a memo rather than a blank page.",
  },
  {
    name: "Wren",
    role: "Sequoia's Chief of Staff",
    layer: "MP Support",
    priority: "WEDNESDAY_MP_MEETING",
    because:
      "The Wednesday meeting is the firm's decision point. A chief of staff assembles the agenda, " +
      "the changes since last Wednesday and the open decisions before the meeting, not during it.",
  },
  {
    name: "Willow",
    role: "Compliance & Privacy",
    layer: "Firm operations",
    priority: "COMPLIANCE_SAFEGUARDS",
    because:
      "Willow is the one recommendation that reduces risk rather than workload. With LP material " +
      "in the system and West Peek Ventures needing to stay separate from the secondaries " +
      "brokerage activity, the compliance boundary should be staffed from the start.",
  },
  {
    name: "Winter",
    role: "Portfolio Support",
    layer: "Portfolio & operations",
    priority: "PORTFOLIO_COMMUNITY",
    because:
      "Community is the firm's stated competitive advantage. Winter is the first hire to make " +
      "once a slot frees up, and is ranked sixth only because the cap is five.",
  },
];

export interface TeamRecommendation {
  recommended: Recommendation[];
  /** Ranked beyond the cap — shown, never hidden, so the trade-off is visible. */
  alsoConsidered: Recommendation[];
  /** Priorities no recommended employee covers. */
  uncoveredPriorities: FundPriority[];
  /** Names in CANDIDATES that are not on the real roster. Should always be empty. */
  unknownNames: string[];
  cap: number;
}

/**
 * Build the recommendation against the live roster.
 *
 * `cap` is passed in rather than imported, because the authoritative value lives in the worker and
 * the client must not import worker code. Callers pass the real cap; the shape of the result makes
 * an honest UI easy and a dishonest one awkward.
 */
export function recommendTeam(
  cap: number,
  roster: readonly AIEmployeeRosterEntry[] = AI_EMPLOYEE_ROSTER,
): TeamRecommendation {
  const byName = new Map(roster.map((e) => [e.name, e]));
  const unknownNames = CANDIDATES.filter((c) => !byName.has(c.name)).map((c) => c.name);

  const ranked: Recommendation[] = CANDIDATES.filter((c) => byName.has(c.name)).map((c, i) => ({
    ...c,
    rank: i + 1,
  }));

  const safeCap = Math.max(0, Math.floor(cap));
  const recommended = ranked.slice(0, safeCap);
  const alsoConsidered = ranked.slice(safeCap);
  const covered = new Set(recommended.map((r) => r.priority));

  return {
    recommended,
    alsoConsidered,
    uncoveredPriorities: FUND_PRIORITIES.filter((p) => !covered.has(p)),
    unknownNames,
    cap: safeCap,
  };
}

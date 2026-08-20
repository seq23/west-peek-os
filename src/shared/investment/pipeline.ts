/**
 * The pipeline, in the language a partner uses out loud.
 *
 * WHY THIS EXISTS. Dealflow rendered `EARLY_STAGE_PRIMARY` and `SCREENING` in code badges beside
 * counts like "share classes: 0 · pricing observations: 0". Every one of those is true and none of
 * them is what a partner is asking. The database vocabulary leaked all the way to the screen.
 *
 * WHAT A PIPELINE IS FOR. Deals do not die of bad judgement; they die of neglect. So the shape
 * that matters is not "which column is it in" but "how long has it been there and what is stopping
 * it" — which is why every stage carries its own CLOCK. Screening measured in weeks and diligence
 * measured in weeks are different claims: a company sitting unscreened for nine days is a problem,
 * a company in diligence for nine days is Tuesday. One global staleness timer is useless.
 *
 * THE CLOCKS ARE JUDGEMENT, and they are stated here rather than hidden so they can be argued
 * with. They assume a pre-seed fund writing $500-750K cheques with two partners: fast to look,
 * fast to pass, slower to underwrite. A fund doing $5M Series A cheques would set them differently
 * and should.
 *
 * NOTHING HERE INVENTS STATUSES. The keys are exactly the `investment_opportunity.status` CHECK
 * from migration 0006, because a second vocabulary is a second source of truth — `tests/pipeline.test.ts`
 * fails if the two drift apart.
 */

export type StageKey =
  | "NEW"
  | "SCREENING"
  | "DILIGENCE"
  | "IC_READY"
  | "IC_DECIDED"
  | "CLOSED"
  | "PASS"
  | "WITHDRAWN";

export interface Stage {
  key: StageKey;
  /** What a partner calls it. */
  label: string;
  /** The question this stage is answering — shown under the stage on the spine. */
  question: string;
  /** Position along the spine; exits are not on it. */
  order: number | null;
  /**
   * How long a deal may sit here before it is stalled, in days. Null where waiting is not a
   * failure: a closed investment and a recorded pass are outcomes, not queues.
   */
  stallAfterDays: number | null;
  /** True for the outcomes a deal leaves the pipeline through. */
  isExit: boolean;
}

export const STAGES: readonly Stage[] = [
  {
    key: "NEW",
    label: "New",
    question: "Heard about them",
    order: 1,
    // A week. Not looking at something is itself a decision, and it should be a visible one.
    stallAfterDays: 7,
    isExit: false,
  },
  {
    key: "SCREENING",
    label: "Screening",
    question: "Does it fit the thesis?",
    order: 2,
    // Screening is a conversation and a read of the deck. Two weeks of it means nobody is doing it.
    stallAfterDays: 14,
    isExit: false,
  },
  {
    key: "DILIGENCE",
    label: "Diligence",
    question: "What would have to be true?",
    order: 3,
    // Real work with other people's calendars in it. Six weeks before it counts as drift.
    stallAfterDays: 42,
    isExit: false,
  },
  {
    key: "IC_READY",
    label: "Ready to decide",
    question: "Everything is in",
    order: 4,
    // The sharpest clock in the pipeline. Nothing is missing except a decision, and a founder
    // waiting a week on two partners who already have what they need is how a fund loses a deal.
    stallAfterDays: 7,
    isExit: false,
  },
  {
    key: "IC_DECIDED",
    label: "Decided",
    question: "Committee has ruled",
    order: 5,
    // Paperwork. Longer than this and the decision is drifting back open.
    stallAfterDays: 21,
    isExit: false,
  },
  {
    key: "CLOSED",
    label: "Invested",
    question: "Money is in",
    order: 6,
    stallAfterDays: null,
    isExit: false,
  },
  {
    key: "PASS",
    label: "Passed",
    question: "We said no",
    order: null,
    stallAfterDays: null,
    isExit: true,
  },
  {
    key: "WITHDRAWN",
    label: "Withdrawn",
    question: "It went away",
    order: null,
    stallAfterDays: null,
    isExit: true,
  },
] as const;

const BY_KEY = new Map(STAGES.map((s) => [s.key, s]));

export function stage(key: string): Stage | null {
  return BY_KEY.get(key as StageKey) ?? null;
}

/** The stages that form the spine, in order. Exits hang off it and are not part of the line. */
export const SPINE: readonly Stage[] = STAGES.filter((s) => s.order !== null).sort(
  (a, b) => (a.order ?? 0) - (b.order ?? 0),
);

export const EXITS: readonly Stage[] = STAGES.filter((s) => s.isExit);

export interface StallRead {
  days: number;
  stalled: boolean;
  /** Plain-English age, for the card. */
  label: string;
}

/**
 * How long this deal has sat where it is, and whether that is too long.
 *
 * `since` is the last time the deal MOVED, not when it was created — a company that reached
 * diligence yesterday after two months of screening is fresh, and dating it from creation would
 * paint every hard-won deal red.
 */
export function stallRead(stageKey: string, since: string | null, now: Date = new Date()): StallRead | null {
  const s = stage(stageKey);
  if (!s || !since) return null;
  const started = new Date(since).getTime();
  if (!Number.isFinite(started)) return null;

  const days = Math.max(0, Math.floor((now.getTime() - started) / 86_400_000));
  const label = days === 0 ? "today" : days === 1 ? "1 day" : `${days} days`;
  return { days, label, stalled: s.stallAfterDays !== null && days > s.stallAfterDays };
}

/**
 * The plain-English name for a deal type. `EARLY_STAGE_PRIMARY` is a database value; "Pre-seed" is
 * what it is.
 */
export function dealTypeLabel(key: string): string {
  switch (key) {
    case "EARLY_STAGE_PRIMARY":
      return "Primary";
    case "FOLLOW_ON":
      return "Follow-on";
    case "SECONDARY_PURCHASE":
      return "Secondary — buying";
    case "SECONDARY_SALE":
      return "Secondary — selling";
    default:
      return "Other";
  }
}

/** Where a relationship started, in the operator's words rather than the enum's. */
export function originLabel(key: string): string {
  switch (key) {
    case "ROOM":
      return "A Room";
    case "MASTERMIND":
      return "The mastermind";
    case "OFFICE":
      return "The Office";
    case "COUNCIL":
      return "The Council";
    case "COMMUNITY_INTRO":
      return "Community intro";
    case "PORTFOLIO_REFERRAL":
      return "A portfolio founder";
    case "LP_REFERRAL":
      return "An LP";
    case "INBOUND":
      return "They came to us";
    case "OUTBOUND":
      return "We went to them";
    case "NETWORK":
      return "Partner network";
    case "UNRECORDED":
      return "Not recorded";
    default:
      return "Other";
  }
}

/**
 * How the pipeline can be narrowed, defined next to the stages they depend on.
 *
 * WHY HERE AND NOT IN THE PAGE. The first version of this lived in the component and filtered on
 * `status === "INVESTED"` — a key that does not exist. The stage is `CLOSED` and only its LABEL is
 * "Invested", so the filter matched nothing and the page reported "Invested 0" beside a deal
 * showing an Invested badge. Two contradictory facts on one screen, from guessing an enum.
 *
 * That is the third bug of exactly this shape in this codebase — `firm_scope` on a table without
 * that column, `DAILY` where the value is `DAILY_AT`, and now this. A wrong string literal in
 * TypeScript does not fail; it silently never matches. So these predicates sit beside the STAGES
 * they read, where a rename breaks them visibly, and `tests/dealFilters.test.ts` asserts every one
 * still matches a real stage.
 */
/**
 * Every stage key, as VALUES rather than only as a type.
 *
 * A union type vanishes at runtime, so nothing could check a string literal against it — which is
 * precisely how `"INVESTED"` got written into a filter and silently matched nothing. Derived from
 * STAGES so it cannot drift from the stages themselves.
 */
export const STAGE_KEYS: readonly string[] = STAGES.map((s) => s.key);

export interface DealFilter {
  key: string;
  label: string;
  /** Which statuses this filter admits. Empty means everything. */
  matches: (status: string) => boolean;
}

export const DEAL_FILTERS: readonly DealFilter[] = [
  { key: "LIVE", label: "Live", matches: (s) => !stage(s)?.isExit },
  // "Needs you" is about time in stage rather than the stage itself, so the page supplies that
  // half; this entry exists so the filter list stays in one place.
  { key: "NEEDS_YOU", label: "Needs you", matches: (s) => !stage(s)?.isExit },
  { key: "INVESTED", label: "Invested", matches: (s) => s === "CLOSED" },
  { key: "PASSED", label: "Passed", matches: (s) => s === "PASS" || s === "WITHDRAWN" },
  { key: "ALL", label: "Everything", matches: () => true },
];

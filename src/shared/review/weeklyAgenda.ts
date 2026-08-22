/**
 * The sixteen headings of the weekly MP operating review (canon §8), and the six exits.
 *
 * Kept in code rather than the database for the same reason the IC framework is: this is the
 * firm's method, and a change to it should show up in a diff. It is also the join key between the
 * derivation queries and the rendered agenda, so a typo here fails a test rather than silently
 * producing a heading nobody reads.
 */

export const REVIEW_HEADINGS = [
  { key: "decisions_required", label: "Decisions required" },
  { key: "fundraising_lp", label: "Fundraising and LP pipeline" },
  { key: "early_stage", label: "Early-stage opportunities" },
  { key: "secondary", label: "Secondary opportunities" },
  { key: "portfolio_construction", label: "Portfolio construction" },
  { key: "portfolio_health", label: "Portfolio company health" },
  { key: "community_founder", label: "Community and founder support" },
  { key: "events", label: "Events" },
  { key: "relationship_intel", label: "Relationship intelligence" },
  { key: "finance_cash", label: "Finance and cash" },
  { key: "legal_compliance", label: "Legal and compliance" },
  { key: "operations_vendors", label: "Operations and vendors" },
  { key: "marketing_visibility", label: "Marketing and visibility" },
  { key: "agent_work", label: "Agent work and approvals" },
  { key: "risks_unresolved", label: "Risks and unresolved commitments" },
  { key: "seven_day", label: "Seven-day priorities" },
] as const;

export type ReviewHeading = (typeof REVIEW_HEADINGS)[number]["key"];

/**
 * The six exits canon §8 permits, plus UNRESOLVED.
 *
 * UNRESOLVED is not in canon and is deliberately added as the DEFAULT. Canon says every item
 * "exits as" one of six — that is a statement about a finished review. Before the meeting happens
 * nothing has exited, and defaulting to DECISION would make a freshly generated agenda look like
 * sixteen decisions the partners had already taken.
 */
export const EXIT_TYPES = [
  { key: "UNRESOLVED", label: "Not yet resolved", canon: false },
  { key: "DECISION", label: "Decision", canon: true },
  { key: "OWNER", label: "Owner assigned", canon: true },
  { key: "DEADLINE", label: "Deadline set", canon: true },
  { key: "DELEGATED_ACTION", label: "Delegated action", canon: true },
  { key: "DEFERRED_ITEM", label: "Deferred", canon: true },
  { key: "CLOSED_ITEM", label: "Closed", canon: true },
] as const;

export type ExitType = (typeof EXIT_TYPES)[number]["key"];

export function headingLabel(key: string): string {
  return REVIEW_HEADINGS.find((h) => h.key === key)?.label ?? key;
}

export function exitLabel(key: string): string {
  return EXIT_TYPES.find((e) => e.key === key)?.label ?? key;
}

/** A review is finished when nothing is still UNRESOLVED — canon's "every agenda item exits". */
export function isResolved(items: ReadonlyArray<{ exit_type: string }>): boolean {
  return items.length > 0 && items.every((i) => i.exit_type !== "UNRESOLVED");
}

/**
 * The Wednesday this review week began.
 *
 * THE FIRM MEETS ON WEDNESDAY, so the week must start on one. It used to shift to Monday, which put
 * the meeting in the MIDDLE of the period it was reviewing: everything decided in the room landed
 * in the next week's agenda instead of closing out the one on the table, and Wednesday's own events
 * were split across two reviews. A cadence whose boundary falls inside its own meeting cannot close
 * anything.
 *
 * Wednesday itself belongs to the week it opens, which is what makes the agenda you read at the
 * meeting the agenda for the week you are about to have.
 */
export function weekStart(d: Date): string {
  const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // getUTCDay(): 0 = Sunday, 3 = Wednesday. Shift back to the most recent Wednesday.
  const day = (copy.getUTCDay() + 4) % 7;
  copy.setUTCDate(copy.getUTCDate() - day);
  return copy.toISOString().slice(0, 10);
}

/** The Tuesday this review week ends — stated, because a week people plan against needs both ends. */
export function weekEnd(weekStartIso: string): string {
  const d = new Date(`${weekStartIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

/**
 * Guess which heading a typed line belongs under.
 *
 * A PARTNER MID-MEETING SHOULD NOT HAVE TO CATEGORISE. The point of the capture box is that a
 * thought survives the moment it occurs; making somebody choose from sixteen headings first is how
 * the thought gets lost instead. So this guesses, the guess is shown, and one click moves it.
 *
 * Deliberately keyword matching rather than a model call. It runs as you type, it must be instant
 * and free, and being wrong costs one click — nothing here is worth a round trip to a provider, and
 * an item silently mis-filed by a model is harder to notice than one mis-filed by an obvious rule.
 *
 * Order matters: the first heading with a hit wins, so the more specific vocabularies are listed
 * before the general ones.
 */
const HEADING_HINTS: ReadonlyArray<{ heading: ReviewHeading; words: readonly string[] }> = [
  { heading: "fundraising_lp", words: ["lp", "lps", "fundrais", "commit", "close the fund", "anchor", "allocation letter", "subscription"] },
  { heading: "secondary", words: ["secondar", "spv", "tender", "continuation", "direct secondary"] },
  { heading: "early_stage", words: ["pre-seed", "preseed", "seed", "founder", "pitch", "term sheet", "diligence", "deal", "dealflow", "screening"] },
  { heading: "portfolio_health", words: ["runway", "burn", "portfolio company", "struggling", "layoff", "bridge", "down round", "kpi"] },
  { heading: "portfolio_construction", words: ["ownership", "reserve", "check size", "concentration", "pacing", "construction", "target ownership"] },
  { heading: "finance_cash", words: ["cash", "invoice", "expense", "budget", "capital call", "management fee", "audit", "bank"] },
  { heading: "legal_compliance", words: ["legal", "counsel", "compliance", "contract", "sec ", "regulat", "filing", "nda"] },
  { heading: "events", words: ["event", "dinner", "summit", "venue", "invite", "rsvp", "speaker"] },
  { heading: "community_founder", words: ["community", "member", "mentor", "office hours", "founder support"] },
  { heading: "marketing_visibility", words: ["brand", "marketing", "press", "podcast", "content", "social", "website", "visibility"] },
  { heading: "relationship_intel", words: ["intro", "introduction", "warm path", "who knows", "connect me", "referral", "network"] },
  { heading: "operations_vendors", words: ["vendor", "tool", "subscription", "ops", "process", "hiring", "contractor"] },
  { heading: "agent_work", words: ["employee", "agent", "approval", "automation", "job", "sweep", "brief"] },
  { heading: "risks_unresolved", words: ["risk", "worried", "concern", "blocked", "stalled", "chase", "overdue"] },
  { heading: "seven_day", words: ["this week", "next week", "priority", "must do", "before friday"] },
];

export function guessHeading(text: string): ReviewHeading {
  const t = ` ${text.toLowerCase()} `;
  for (const { heading, words } of HEADING_HINTS) {
    if (words.some((w) => t.includes(w))) return heading;
  }
  // Nothing matched. Seven-day priorities is the honest default: a partner typed it into this
  // week's review, so at minimum it is something they think matters this week.
  return "seven_day";
}

/**
 * Where an agenda item came from, in words.
 *
 * THE OPERATOR'S QUESTION WAS "I have no idea where this LP from Marcus shit came from". The
 * answer was on the row the whole time: `source_type = 'operator'` means they typed it into the box
 * themselves. The page rendered that as "Sequoia raised this", which is true and answers a
 * different question — who, not how — and for derived items it printed the raw table name, so the
 * agenda said `from investment_opportunity`.
 *
 * Nobody thinks in table names. The distinction that actually matters on this page is between a
 * thought somebody had and a fact the system read off a record, because the second kind can be
 * checked and the first cannot.
 */
export interface SourceWords {
  /** One line: where this came from. */
  said: string;
  /** The nav key to open the record behind it, when there is one to open. */
  page: string | null;
}

const SOURCES: Readonly<Record<string, { said: string; page: string | null }>> = {
  operator: { said: "You typed this into the box", page: null },
  meeting_notes: { said: "Read out of meeting notes you pasted in", page: null },
  approval_card: { said: "An approval has been waiting for a decision", page: "approvals" },
  lp_engagement: { said: "From an LP relationship record", page: "lp" },
  investment_opportunity: { said: "From a deal in the pipeline", page: "dealflow" },
  portfolio_alert: { said: "A portfolio company raised an alert", page: "portfolio" },
  support_request: { said: "A founder asked for help", page: "portfolio" },
  evt_event: { said: "From an event in the calendar", page: "rooms" },
  job_run: { said: "A scheduled job failed or was refused", page: "work" },
  meeting_commitment: { said: "Somebody committed to this in a meeting", page: "meetings" },
  contradiction_record: { said: "Two records disagree with each other", page: "contradictions" },
};

export function sourceWords(sourceType: string | null): SourceWords {
  if (!sourceType) return { said: "No source recorded", page: null };
  return SOURCES[sourceType] ?? { said: `From a ${sourceType.replace(/_/g, " ")} record`, page: null };
}

/** True when a person put this here rather than the system deriving it from a row. */
export function isTyped(sourceType: string | null): boolean {
  return sourceType === "operator" || sourceType === "meeting_notes";
}

/**
 * What "pull in what has changed" actually reads, named for the page that has to explain it.
 *
 * "Refresh from records" was accurate and told nobody anything — the operator's response was
 * literally "what does that mean". These are the eight places it looks.
 */
export const REFRESH_READS: readonly string[] = [
  "approvals still waiting on a decision",
  "deals moving through the pipeline",
  "LP relationships that have gone quiet",
  "portfolio alerts raised by companies",
  "founders who asked for help",
  "events coming up",
  "scheduled jobs that failed or were refused",
  "commitments people made in meetings",
];

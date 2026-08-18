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

/** Monday of the ISO week containing `d`, as YYYY-MM-DD. */
export function weekStart(d: Date): string {
  const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // getUTCDay(): 0 = Sunday. Shift so Monday is the first day.
  const day = (copy.getUTCDay() + 6) % 7;
  copy.setUTCDate(copy.getUTCDate() - day);
  return copy.toISOString().slice(0, 10);
}

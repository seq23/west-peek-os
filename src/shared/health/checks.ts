/**
 * What "healthy" means for this firm's system, stated once.
 *
 * The Diagnostics page reported that four bindings were bound and how many approvals had been
 * raised. Both true, neither an answer to the question somebody opens that page with — is anything
 * broken, and if so what do I do about it. A binding being present says the deploy worked; it says
 * nothing about whether the morning brief ran, whether a scheduled job is failing every night, or
 * whether a feature has been quietly dead for a week.
 *
 * THREE STATES AND NO MORE. Green means working. Amber means degraded or unconfigured — something a
 * person may want to fix, but nothing is broken. Red means something that should be working is not.
 * A fourth state invites a judgement call at the moment somebody least wants one.
 *
 * EVERY CHECK CARRIES A READING AND A REMEDY. "AI provider: OK" is a light with nothing behind it.
 * "64 runs, $0.31 spent, last one 4 minutes ago" is a reading, and if it is red the check says what
 * to do rather than leaving the operator to guess which page fixes it.
 */

export type HealthState = "OK" | "DEGRADED" | "DOWN";

export interface HealthCheck {
  key: string;
  /** What is being checked, in the operator's words. */
  label: string;
  state: HealthState;
  /** The actual measurement — a count, an age, an amount. Never just "OK". */
  reading: string;
  /** What to do, when there is something to do. */
  remedy?: string;
  /** Which page fixes it. */
  page?: string;
}

export interface HealthReport {
  overall: HealthState;
  checks: HealthCheck[];
  summary: string;
}

const RANK: Record<HealthState, number> = { OK: 0, DEGRADED: 1, DOWN: 2 };

export function worstOf(checks: readonly HealthCheck[]): HealthState {
  return checks.reduce<HealthState>((worst, c) => (RANK[c.state] > RANK[worst] ? c.state : worst), "OK");
}

export function summarise(checks: readonly HealthCheck[]): string {
  const down = checks.filter((c) => c.state === "DOWN");
  const degraded = checks.filter((c) => c.state === "DEGRADED");
  if (down.length > 0) {
    return `${down.length} thing${down.length === 1 ? "" : "s"} that should be working ${down.length === 1 ? "is" : "are"} not: ${down.map((c) => c.label).join(", ")}.`;
  }
  if (degraded.length > 0) {
    return `Everything essential is working. ${degraded.length} ${degraded.length === 1 ? "thing is" : "things are"} unconfigured or degraded: ${degraded.map((c) => c.label).join(", ")}.`;
  }
  return "Everything is working.";
}

/** How long ago, in words. "4 minutes ago" beats an ISO timestamp on a health board. */
export function ago(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "never";
  const mins = Math.max(0, Math.round((now.getTime() - then) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

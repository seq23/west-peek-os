import { AI_EMPLOYEE_ROSTER } from "../registry/aiEmployees";

/**
 * Who brought you this, and why it is in front of you this morning.
 *
 * THE PROBLEM. Home was a grid of anonymous panels — "Portfolio risk", "LP signals", "AI spend" —
 * each true and none of them from anybody. A firm with thirty-one employees rendered as twelve
 * unattributed boxes, which is the opposite of what having a workforce should feel like. The
 * operator asked for a delivery window: things arriving each morning, brought by someone.
 *
 * So every module gets an author, and the author is a real employee off the same roster the rest
 * of the system reads rather than a decorative name. If the roster is consolidated, this file
 * follows it — `tests/deliveries.test.ts` fails if a module is attributed to somebody who does not
 * exist, which is what stops the workforce and the screen drifting apart.
 *
 * WHY AN AUTHOR CHANGES ANYTHING. "Portfolio risk: 3" is a number. "Winter has three companies she
 * is worried about" is a message from a colleague, and it is answerable — you can go and ask her.
 * The panel is identical; what changes is whether the firm feels staffed.
 *
 * ATTRIBUTION IS NOT AUTHORSHIP, and the distinction matters enough to state. These modules are
 * assembled from records by a query, not written by a model. The employee named is the one whose
 * job that area is — the person to take it up with — not a claim that they composed the text. The
 * one genuinely authored thing on the page is the morning brief, which really is written by a
 * model through the governed boundary and says so.
 */

export interface Delivery {
  /** Module key from mpHome. */
  module: string;
  /** Roster name of the employee whose area this is. */
  by: string;
  /** What they are handing you, in their voice — shown when the module has something in it. */
  headline: string;
  /** Shown instead when the module is empty. Silence from a colleague is information too. */
  whenEmpty: string;
}

export const DELIVERIES: readonly Delivery[] = [
  {
    module: "approvals",
    by: "Walker",
    headline: "Decisions waiting on you",
    whenEmpty: "Nothing is blocked on your signature.",
  },
  {
    module: "intelligence",
    by: "Wyatt",
    headline: "What moved overnight",
    whenEmpty: "Nothing in the sweep worth pulling out.",
  },
  {
    module: "portfolio_risk",
    by: "Winter",
    headline: "Companies I am watching",
    whenEmpty: "No open alerts on anything you own.",
  },
  {
    module: "allocation_constraints",
    by: "Preston",
    headline: "Where the capital plan is tight",
    whenEmpty: "Allocation is within every policy you have set.",
  },
  {
    module: "meetings",
    by: "Walter",
    headline: "Rooms you are in today",
    whenEmpty: "Nothing scheduled.",
  },
  {
    module: "ic_priorities",
    by: "Poppy",
    headline: "Deals close to a decision",
    whenEmpty: "Nothing is waiting on the committee.",
  },
  {
    module: "lp_signals",
    by: "Wesley",
    headline: "Where the raise stands",
    whenEmpty: "No movement on the LP side since you last looked.",
  },
  {
    module: "reconciliation",
    by: "Preston",
    headline: "Numbers that do not agree",
    whenEmpty: "The administrator's records and ours match.",
  },
  {
    module: "ai_spend",
    by: "Pax",
    headline: "What the workforce cost today",
    whenEmpty: "No spend recorded yet today.",
  },
  {
    module: "employees",
    by: "Wren",
    headline: "Who is working",
    whenEmpty: "Nobody is currently employed.",
  },
  {
    module: "what_changed",
    by: "Wells",
    headline: "Changed since you last looked",
    whenEmpty: "Nothing has changed since your last visit.",
  },
  {
    module: "my_work",
    by: "Wren",
    headline: "Your open work",
    whenEmpty: "Nothing open in your name.",
  },
] as const;

const BY_MODULE = new Map(DELIVERIES.map((d) => [d.module, d]));

export function deliveryFor(module: string): Delivery | null {
  return BY_MODULE.get(module) ?? null;
}

/**
 * The employee's role, for the byline. Resolved from the roster rather than stored here, so a
 * retitle in one place reaches the screen — the Event Marketing Coordinator rename reached
 * everything except the places that kept their own copy.
 */
export function roleFor(name: string): string | null {
  return AI_EMPLOYEE_ROSTER.find((e) => e.name === name)?.role ?? null;
}

/**
 * Which shift the clock says it is, in the operator's words.
 *
 * Home greets by time of day because a delivery has a moment — "this morning" means something,
 * "your dashboard" does not. Hours come from the browser, since a Worker runs in UTC and the
 * partner does not.
 */
export function greetingFor(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  if (h < 12) return "This morning";
  if (h < 17) return "This afternoon";
  if (h < 22) return "This evening";
  return "Tonight";
}

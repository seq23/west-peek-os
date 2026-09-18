/**
 * WHETHER THE EXECUTIVE BRIEF IS FOLDED AWAY ON HOME, REMEMBERED PER VIEWER (17 Sep 2026).
 *
 * Operator: "we also need to be able to collapse the executive brief on the home page."
 *
 * THE PANEL ALREADY FOLDS ITS OWN INSIDES — the summary and the traffic lights stay, the long read
 * opens on a click. What it could not do was get out of the way. On a busy morning the brief is
 * still the tallest thing on the page even folded, and everything she came to Home for is below it.
 *
 * REMEMBERED IS THE WHOLE POINT. A collapse that forgets itself overnight is not a control, it is a
 * chore she performs every morning. This is the difference between the two.
 *
 * ─── WHY PER VIEWER, AND WHY THE ID IS IN THE KEY ──────────────────────────────────────────────
 *
 * Both partners sign in to the same application, and on a shared laptop they would share the store.
 * Keying on the `firm_user.id` means Scooter folding his brief away does not fold hers, which is
 * the behaviour "remember the state per viewer" actually asks for.
 *
 * ─── WHY localStorage AND NOT A ROW ────────────────────────────────────────────────────────────
 *
 * This is a reading preference about one surface, not a fact about the firm — the same call
 * `RoomsPage` and `ConnectPanel` already made, and for the same reason: a per-device display
 * choice does not belong in the event spine, and writing one would put a `mp_home_preference`
 * version bump on the record every time she folded a panel. The cost is that it does not follow her
 * to a new device, where the brief is open on the first morning and stays folded after that.
 *
 * EVERY READ AND WRITE IS WRAPPED. A private window, a blocked store or a browser with site data
 * cleared throws on access rather than returning null, and a Home page that fails to render because
 * a preference could not be read would be a far worse bug than a forgotten fold.
 */

import { briefArrival, type BriefReportState } from "./briefState";

const KEY_PREFIX = "wp.home.brief-collapsed";

function keyFor(viewerId: string): string {
  return `${KEY_PREFIX}:${viewerId}`;
}

/**
 * OPEN UNLESS SHE SAID OTHERWISE. The default must be the brief showing: a partner who has never
 * touched this control should not discover one morning that her briefing is hidden behind a
 * disclosure she does not know exists.
 */
export function readBriefCollapsed(viewerId: string): boolean {
  try {
    return window.localStorage.getItem(keyFor(viewerId)) === "1";
  } catch {
    return false;
  }
}

export function writeBriefCollapsed(viewerId: string, collapsed: boolean): void {
  try {
    window.localStorage.setItem(keyFor(viewerId), collapsed ? "1" : "0");
  } catch {
    /* A blocked store means the fold is not remembered. Nothing else depends on it. */
  }
}

/**
 * THE ONE LINE A COLLAPSED BRIEF SHOWS, AND WHY IT IS A FUNCTION RATHER THAN JSX.
 *
 * "Collapsed must still show the date and whether today's brief arrived at all. A panel that hides
 * whether the thing ran is worse than no panel." That is a RULE, not a layout, and a rule stated
 * only inside a component is a rule nothing can check — this repo has no DOM renderer in its tests,
 * so a sentence written inline would be asserted by nobody and could quietly lose the date on the
 * next edit.
 *
 * Pulled out here, it is a pure function of the three states the panel can be in, and
 * `tests/briefCollapse.test.ts` asserts every one of them carries a date and says plainly whether
 * a brief exists. THREE STATES, NOT TWO: "arrived", "not arrived", and "we have not looked yet" —
 * collapsing the third into the second would tell her the brief failed every time the page loaded.
 */
export interface CollapsedBriefState {
  /*
   * Null when no report row exists for the day being shown — which is NOT the same as "no brief".
   * A row can exist and be FAILED, or still be writing, and this line used to call both of those
   * "arrived" because it only ever checked whether the row was null. On 18 Sep 2026 both partners'
   * rows existed and neither brief did. `briefArrival` is now the single answer; see `briefState.ts`.
   */
  report: BriefReportState | null;
  /** How many sections are actually on screen. A READY report with none is still an empty card. */
  sectionCount?: number;
  /** The request is still in flight: we do not yet know, and must not claim either way. */
  loading: boolean;
  /** The day the panel is reporting on, from the server, so it is the server's idea of "today". */
  date: string | null;
  /** The schedule's own reason, when it has one. Better than a blank. */
  noBriefBecause?: string | null;
}

export function collapsedBriefLine(s: CollapsedBriefState): string {
  if (s.report) {
    const arrival = briefArrival(s.report, s.sectionCount ?? 0);
    // ONLY AN ARRIVED BRIEF IS INVITED TO BE SHOWN. Telling her a failed brief is "folded away,
    // show it when you want it" sends her to open an empty panel, which is what happened.
    return arrival.arrived
      ? `${arrival.line} Folded away; show it when you want it.`
      : arrival.line;
  }
  // "CHECKING FOR", NOT "CHECKING WHETHER IT ARRIVED". Its own test caught the second wording: the
  // word "arrived" reads as an arrival at a glance, which is the exact claim this state must not
  // make while nothing is known yet.
  if (s.loading) return `${s.date ?? "Today"} — checking for today's brief…`;
  return `${s.date ?? "Today"} — no brief yet. ${s.noBriefBecause ?? "Nothing has been built for today."}`;
}

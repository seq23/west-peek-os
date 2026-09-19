/**
 * THE FILTER RAIL'S MEMORY — per viewer, and never an empty screen (design/HOME_DESIGN.md §3.2).
 *
 * "The show / put away is stupid and clunky and should be some kind of filter that is easy to
 * return to home state." Four separate collapse controls become one rail: All · Waiting on me ·
 * Arrived · Quiet. The choice is remembered per viewer in `localStorage`, keyed on `firm_user.id`
 * — the `briefCollapse.ts` mechanism, generalised — so two partners on one laptop never inherit
 * each other's filter.
 *
 * THE ONE RULE THAT MATTERS: a remembered filter whose band is empty this morning opens on ALL. A
 * page that opened on "Waiting on me · 0" would be a blank screen at 7 AM, which is the exact
 * failure the rail exists to end. `effectiveFilter` is pure so `tests/homeFilter.test.ts` pins it.
 */

export const HOME_FILTERS = ["all", "waiting", "arrived", "quiet"] as const;
export type HomeFilter = (typeof HOME_FILTERS)[number];

const KEY_PREFIX = "wp.home.filter";
const keyFor = (viewerId: string): string => `${KEY_PREFIX}:${viewerId}`;

export function isHomeFilter(v: unknown): v is HomeFilter {
  return typeof v === "string" && (HOME_FILTERS as readonly string[]).includes(v);
}

export function readHomeFilter(viewerId: string): HomeFilter {
  try {
    const raw = window.localStorage.getItem(keyFor(viewerId));
    return isHomeFilter(raw) ? raw : "all";
  } catch {
    return "all";
  }
}

export function writeHomeFilter(viewerId: string, filter: HomeFilter): void {
  try {
    window.localStorage.setItem(keyFor(viewerId), filter);
  } catch {
    /* A blocked store means the filter is not remembered. Nothing else depends on it. */
  }
}

export interface HomeBandCounts {
  waiting: number;
  arrived: number;
  quiet: number;
}

/** The filter the page opens on: the remembered one, unless its band is empty — then All. */
export function effectiveFilter(remembered: HomeFilter, counts: HomeBandCounts): HomeFilter {
  if (remembered === "all") return "all";
  return counts[remembered] > 0 ? remembered : "all";
}

/** Which bands render under a filter. The brief is on every filter: it is the one thing built on request. */
export function bandsFor(filter: HomeFilter): { waiting: boolean; arrived: boolean; quiet: boolean; brief: boolean } {
  return {
    waiting: filter === "all" || filter === "waiting",
    arrived: filter === "all" || filter === "arrived",
    quiet: filter === "all" || filter === "quiet",
    brief: true,
  };
}

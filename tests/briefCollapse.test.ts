import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  collapsedBriefLine,
  readBriefCollapsed,
  writeBriefCollapsed,
} from "../src/client/lib/briefCollapse";

/**
 * COLLAPSING THE EXECUTIVE BRIEF ON HOME (17 Sep 2026).
 *
 * Operator: "we also need to be able to collapse the executive brief on the home page."
 *
 * Two properties, and the second is the one that is easy to lose:
 *
 *   · IT IS REMEMBERED, PER VIEWER. A collapse that forgets itself overnight is a chore she
 *     performs every morning, not a control. Two partners share the application and, on a shared
 *     laptop, the store — so one folding their brief away must not fold the other's.
 *   · COLLAPSED STILL SAYS THE DATE AND WHETHER TODAY'S BRIEF ARRIVED. A panel that hides whether
 *     the thing ran is worse than no panel: it turns "did my brief arrive?" from a glance into an
 *     action, and it makes a failed overnight job indistinguishable from a tidy morning.
 */

/** A localStorage that behaves, and one that throws the way a private window does. */
function stubStorage(mode: "works" | "throws" = "works"): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem(k: string) {
        if (mode === "throws") throw new Error("the operation is insecure");
        return store.get(k) ?? null;
      },
      setItem(k: string, v: string) {
        if (mode === "throws") throw new Error("the operation is insecure");
        store.set(k, v);
      },
    },
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the fold is remembered, per viewer", () => {
  it("defaults to open, survives a write, and does not leak between the two partners", () => {
    stubStorage();
    // OPEN UNLESS SHE SAID OTHERWISE. A partner who has never touched the control must not find her
    // briefing hidden behind a disclosure she does not know exists.
    expect(readBriefCollapsed("fu_sequoia_taylor")).toBe(false);

    writeBriefCollapsed("fu_sequoia_taylor", true);
    // This is the whole point of persisting it: tomorrow it is still folded.
    expect(readBriefCollapsed("fu_sequoia_taylor")).toBe(true);
    expect(readBriefCollapsed("fu_scooter_taylor"), "one partner folded the other's brief").toBe(false);

    writeBriefCollapsed("fu_sequoia_taylor", false);
    expect(readBriefCollapsed("fu_sequoia_taylor")).toBe(false);
  });

  it("survives a store that throws, rather than taking Home down with it", () => {
    stubStorage("throws");
    // A private window, cleared site data or a blocked store. A forgotten fold is a nuisance; a
    // Home page that fails to render because a preference could not be read is an outage.
    expect(() => readBriefCollapsed("fu_sequoia_taylor")).not.toThrow();
    expect(readBriefCollapsed("fu_sequoia_taylor")).toBe(false);
    expect(() => writeBriefCollapsed("fu_sequoia_taylor", true)).not.toThrow();
  });
});

describe("collapsed still says whether it ran", () => {
  const DATE = "2026-09-17";

  it("names the date and the arrival in every one of the three states", () => {
    const arrived = collapsedBriefLine({
      report: { report_date: DATE, completed_at: "2026-09-17T06:12:00.000Z" },
      loading: false,
      date: DATE,
    });
    const missing = collapsedBriefLine({
      report: null,
      loading: false,
      date: DATE,
      noBriefBecause: "the overnight sweep found nothing to read.",
    });
    const unknown = collapsedBriefLine({ report: null, loading: true, date: DATE });

    // THE DATE IS ON SCREEN IN ALL THREE. Without it "no brief yet" does not say which day.
    for (const line of [arrived, missing, unknown]) {
      expect(line, line).toContain(DATE);
    }

    expect(arrived).toMatch(/arrived/i);
    expect(missing).toMatch(/no brief/i);
    // The schedule's own reason, not a blank — a partner who cannot tell "nothing today" from
    // "this is broken" stops trusting the thing she reads first every morning.
    expect(missing).toContain("the overnight sweep found nothing to read.");

    /*
     * AND THE THIRD STATE IS ITS OWN STATE. While the request is in flight nothing is known, and
     * saying "no brief yet" would report a failure on every page load.
     */
    expect(unknown).not.toMatch(/no brief/i);
    expect(unknown).toMatch(/checking/i);
  });

  it("never claims a brief arrived when none did", () => {
    for (const loading of [true, false]) {
      expect(collapsedBriefLine({ report: null, loading, date: DATE })).not.toMatch(/arrived/i);
    }
  });
});

/**
 * AND THE CONTROL EXISTS ON HOME.
 *
 * There is no DOM renderer in this suite, so the wiring is asserted at the source: that Home passes
 * the state and the setter, and that the panel offers the toggle. Weaker than a click, and
 * deliberately narrow — it catches the failure that actually happens, which is a well-tested pure
 * function nothing on the page ever calls. This repo's name for that is "exists but nothing
 * invokes it".
 */
describe("the control is wired to the page", () => {
  it("Home passes the remembered state to the panel, and the panel offers the toggle", () => {
    const home = readFileSync(new URL("../src/client/pages/HomePage.tsx", import.meta.url), "utf8");
    expect(home).toMatch(/readBriefCollapsed\(me\.id\)/);
    expect(home).toMatch(/writeBriefCollapsed\(me\.id,\s*next\)/);
    expect(home).toMatch(/collapsed=\{briefCollapsed\}/);

    const panel = readFileSync(new URL("../src/client/pages/DailyBriefPanel.tsx", import.meta.url), "utf8");
    expect(panel).toMatch(/onToggleCollapsed/);
    expect(panel).toMatch(/collapsedBriefLine\(/);
    expect(panel, "the toggle must say what it does to a screen reader").toMatch(/aria-expanded=\{!collapsed\}/);
  });
});

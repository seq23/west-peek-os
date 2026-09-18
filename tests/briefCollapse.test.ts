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
      // READY *AND* WITH SECTIONS ON SCREEN. This fixture used to be `{ report_date, completed_at }`
      // and nothing else, which is precisely the bug: the line called any non-null row an arrival.
      report: { report_date: DATE, completed_at: "2026-09-17T06:12:00.000Z", status: "READY" },
      sectionCount: 7,
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

  /*
   * STRENGTHENED 18 Sep 2026. This assertion was right and its coverage was not: it only ever tried
   * `report: null`, so the case that actually happened — a report row that EXISTS and is FAILED —
   * was never put to it, and the line told both partners their brief had arrived on a morning
   * neither had one. A row is now driven through in every state it can be in.
   */
  it("never claims a brief arrived when none did — including when the row exists", () => {
    for (const loading of [true, false]) {
      expect(collapsedBriefLine({ report: null, loading, date: DATE })).not.toMatch(/arrived/i);
    }

    // The real 18 Sep shapes: his failed, hers was still writing, and both rows were present.
    const failed = collapsedBriefLine({
      report: {
        report_date: DATE,
        completed_at: "2026-09-18T12:40:06.505Z",
        status: "FAILED",
        error_code: "incomplete",
        error_message: "the brief was rejected twice: executive_summary carries no [n] citation",
      },
      sectionCount: 0,
      loading: false,
      date: DATE,
    });
    expect(failed, "a FAILED row was reported as an arrival").not.toMatch(/brief arrived/i);
    expect(failed, "collapsed said nothing about the failure").toMatch(/did not arrive/i);
    expect(failed).toContain(DATE);
    // AND IT DOES NOT INVITE HER TO OPEN AN EMPTY PANEL.
    expect(failed, "she was invited to show a brief that is not there").not.toMatch(/show it when you want it/i);

    const writing = collapsedBriefLine({
      report: { report_date: DATE, completed_at: null, status: "GENERATING" },
      sectionCount: 0,
      loading: false,
      date: DATE,
    });
    expect(writing, "a mid-flight row was reported as an arrival").not.toMatch(/brief arrived/i);
    expect(writing, "collapsed did not say it is still coming").toMatch(/still being built/i);
    expect(writing).toContain(DATE);

    // A READY row whose every section the verifier held back is an empty card by another route.
    const emptyReady = collapsedBriefLine({
      report: { report_date: DATE, completed_at: "2026-09-18T12:40:06.505Z", status: "READY" },
      sectionCount: 0,
      loading: false,
      date: DATE,
    });
    expect(emptyReady, "a READY row with no sections was reported as an arrival").not.toMatch(/brief arrived/i);
    expect(emptyReady).toMatch(/held back/i);
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

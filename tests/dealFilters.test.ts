import { describe, expect, it } from "vitest";
import { DEAL_FILTERS, STAGE_KEYS, stage } from "@shared/investment/pipeline";

/**
 * Every filter matches a stage that actually exists.
 *
 * This is the third bug of the same shape in this codebase and the first one with a guard. The
 * pipeline filtered on `status === "INVESTED"` — a key that does not exist, because the stage is
 * `CLOSED` and only its LABEL is "Invested". So the page showed "Invested 0" next to a deal
 * displaying an Invested badge: two contradictory facts on one screen.
 *
 * The other two were `WHERE firm_scope` on a table without that column, and `DAILY` where the
 * stored value is `DAILY_AT`. `validate:sql` catches the SQL variety. This is the TypeScript
 * variety, where a wrong string literal does not fail — it silently never matches — and the only
 * defence is asserting the literal against the real vocabulary.
 */
describe("pipeline filters point at real stages", () => {
  const everyStatus = STAGE_KEYS;

  it("has at least one real status behind every filter", () => {
    const dead = DEAL_FILTERS.filter((f) => !everyStatus.some((s) => f.matches(s))).map((f) => f.key);
    expect(dead).toEqual([]);
  });

  it("finds an invested deal under the stage that actually means invested", () => {
    // The exact bug. CLOSED is the key; "Invested" is only what it is called.
    const invested = DEAL_FILTERS.find((f) => f.key === "INVESTED")!;
    expect(invested.matches("CLOSED")).toBe(true);
    expect(stage("CLOSED")?.label).toBe("Invested");
    // And the key that was guessed does not exist at all.
    expect(everyStatus).not.toContain("INVESTED");
  });

  it("separates what left the pipeline from what is still in it", () => {
    const live = DEAL_FILTERS.find((f) => f.key === "LIVE")!;
    const passed = DEAL_FILTERS.find((f) => f.key === "PASSED")!;
    expect(live.matches("SCREENING")).toBe(true);
    expect(live.matches("PASS")).toBe(false);
    expect(passed.matches("PASS")).toBe(true);
    expect(passed.matches("WITHDRAWN")).toBe(true);
    expect(passed.matches("SCREENING")).toBe(false);
  });

  it("lets everything through the last one, so nothing is unreachable", () => {
    const all = DEAL_FILTERS.find((f) => f.key === "ALL")!;
    for (const s of everyStatus) expect(all.matches(s)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { localJobKind, WEB_PROPERTY_CHANGE_KIND } from "../src/shared/work/localJobs";
// @ts-expect-error — a plain .mjs script with no type declarations.
import { outOfTime } from "../scripts/claimer/local-job-claimer.mjs";

/*
 * 17 Nov 2026, wc_76e6d7ff: Scooter's six-item rebuild took 70 minutes to build and 2 to review, then the 90-minute
 * ceiling cut the first fix turn and the run reported "the fix after the review ended (exit null) but the phase wrote
 * no result file". Twice in one day on the same card.
 */
describe("a site BUILD has room for its review loop, and a run cut at the ceiling says so", () => {
  it("the BUILD ceiling covers the measured 70-minute build plus the review loop (3 reviews, 2 fixes) and the first run", () => {
    const build = localJobKind(WEB_PROPERTY_CHANGE_KIND)!.phases.BUILD!.maxSeconds;
    const measured = 70 * 60 + 3 * 5 * 60 + 2 * 25 * 60 + 10 * 60;
    expect(build).toBeGreaterThanOrEqual(measured);
  });

  it("a failed report from a run whose signal was aborted is NAMED OUT_OF_TIME, keeping the step that was cut", () => {
    const ac = new AbortController();
    ac.abort(new Error("the BUILD phase did not finish within 5400s and was stopped"));
    const r = outOfTime({ phase: "BUILD", status: "failed", reason: "the fix after the review ended (exit null) but the phase wrote no result file" }, ac.signal);
    expect(r.reason).toMatch(/^NAMED STOP \[OUT_OF_TIME\] the BUILD phase did not finish within 5400s/);
    expect(r.reason).toContain("the fix after the review ended (exit null)");
  });

  it("negative: a run that was not cut, an ok report, and a plan-reset wait are left exactly as they are", () => {
    const live = new AbortController().signal;
    const failed = { phase: "BUILD", status: "failed", reason: "x" };
    expect(outOfTime(failed, live)).toBe(failed);
    const cut = new AbortController();
    cut.abort(new Error("stopped"));
    const ok = { phase: "BUILD", status: "ok" };
    expect(outOfTime(ok, cut.signal)).toBe(ok);
    const wait = { phase: "BUILD", status: "failed", reason: "spent", waits_seconds: 600 };
    expect(outOfTime(wait, cut.signal)).toBe(wait);
  });
});

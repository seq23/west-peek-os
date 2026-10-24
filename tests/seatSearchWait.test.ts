import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SEARCH_CLAIM_WAIT_MS } from "../src/worker/ai/subscriptionSeats";

/**
 * THE ROUTER WAITS FOR A SEARCH AS LONG AS THE CLAIMER WILL RUN ONE (22 Oct 2026). A Learning Club search on the
 * Claude Code seat took 114–159 s and one passed 180 s, the old wait, so it was abandoned with the answer nearly in.
 * What has to be true: the wait is at least 220 s and still ends before the claimer's kill timer, so an abandoned
 * run is never one the Mac is about to finish, and never one it is still allowed to report.
 */
describe("the seat search wait", () => {
  it("runs to just inside the claimer's own search timeout", () => {
    const claimer = readFileSync(new URL("../scripts/claimer/subscription-seat-claimer.mjs", import.meta.url), "utf8");
    const m = /const SEARCH_RUN_TIMEOUT_MS = ([\d_]+);/.exec(claimer);
    expect(m).toBeTruthy();
    const kill = Number(m![1]!.replace(/_/g, ""));
    // 24 Oct 2026: measured TLC searches ran past 230 s; the wait is at least 500 s and inside the 15-minute scheduled limit.
    expect(SEARCH_CLAIM_WAIT_MS).toBeGreaterThanOrEqual(500_000);
    expect(kill).toBeLessThan(900_000);
    expect(SEARCH_CLAIM_WAIT_MS).toBeLessThan(kill);
  });
});

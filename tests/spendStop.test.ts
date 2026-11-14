import { describe, expect, it } from "vitest";
import { readResult, SPEND_STOP, spendIn } from "../scripts/duties/web-property-change.mjs";
import { SPEND_STOP as WORKER_SPEND_STOP } from "../src/worker/services/webPropertyChange";

/**
 * NOTHING THAT COSTS MONEY HAPPENS FROM AN EMAIL (owner, 13 Nov 2026). A result that lists something to buy, or asks
 * for a run that reads as a purchase, becomes a named stop at the one place every model result is read — before any
 * run happens. Everything free passes untouched.
 */
describe("a result that would spend money is a named stop before anything runs", () => {
  it("an explicit spend item or a purchase run stops the phase by name; free work passes", () => {
    const listed = readResult(JSON.stringify({ phase: "BUILD", status: "ok", pr_url: "https://github.com/seq23/x/pull/1", spend: [{ what: "register westpeekstudio.com", why: "the partner wants his own domain" }] }), "BUILD");
    expect(listed.result).toMatchObject({ phase: "BUILD", status: "failed" });
    expect(String(listed.result!.reason)).toMatch(/^NAMED STOP \[SPEND_NEEDS_THE_OWNER\].*register westpeekstudio\.com.*Nothing was bought/);
    for (const script of ["buy-domain", "checkout", "plan-upgrade", "subscribe"]) {
      const run = readResult(JSON.stringify({ phase: "BUILD", status: "needs_runs", runs: [{ script, env: "production" }] }), "BUILD");
      expect(run.result?.status, script).toBe("failed");
      expect(String(run.result?.reason), "no run is made: the result is a stop, not a needs_runs").toContain(SPEND_STOP);
    }
    // Free work is untouched — the stop can tell them apart.
    const free = readResult(JSON.stringify({ phase: "BUILD", status: "needs_runs", runs: [{ script: "load-beats", env: "preview", args: ["--env", "preview"] }] }), "BUILD");
    expect(free.result?.status).toBe("needs_runs");
    expect(spendIn({ runs: [{ script: "export-voters" }], spend: [] })).toEqual([]);
    expect(WORKER_SPEND_STOP, "the Worker holds the card on the Mac's own tag").toBe(SPEND_STOP);
  });
});

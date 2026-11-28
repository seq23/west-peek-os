import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeRunSettler } from "../scripts/duties/web-property-change.mjs";

/**
 * A BUILD OVER SEVERAL REPOS RUNS THE RUNBOOK RUNS ITS BUILDER ASKS FOR (28 Nov 2026, wc_e1d13d5c). Scooter's Give and
 * Take + Forms job spans join-west-peek-main and west-peek-network-os. Each BUILD turn asked for runs; the several-repo
 * path had no runs loop, so it reported `needs_runs` with an empty reason three times and the card BLOCKED as
 * "tried three times". One settler now serves both paths.
 */
describe("one runs loop for every BUILD turn", () => {
  it("runs what was asked, gives the model the results, and stops when it finishes", async () => {
    const applied: unknown[] = [];
    const turns: Array<{ done: unknown; round: number; note: string | null }> = [];
    const settle = makeRunSettler({
      apply: async (runs: unknown) => (applied.push(runs), [{ script: "forms:seed", env: "preview", exit: 0, line: "seeded 3 TEST forms" }]),
      rerun: async (done: unknown, round: number, note: string | null) => {
        turns.push({ done, round, note });
        return { result: { phase: "BUILD", status: "ok", pr_url: "https://github.com/o/r/pull/9" }, problem: null };
      },
    });
    const asked = { phase: "BUILD", status: "needs_runs", runs: [{ script: "forms:seed", env: "preview" }] };
    const out = await settle(asked);
    expect(out.result?.status).toBe("ok");
    expect(applied).toEqual([asked.runs]);
    expect(turns).toEqual([{ done: [{ script: "forms:seed", env: "preview", exit: 0, line: "seeded 3 TEST forms" }], round: 0, note: null }]);
  });

  it("is bounded, and a builder that never finishes is a failure that says why, never an empty reason", async () => {
    let turns = 0;
    const settle = makeRunSettler({
      apply: async () => [],
      rerun: async () => (turns++, { result: { phase: "BUILD", status: "needs_runs", runs: [{ script: "x", env: "local" }] }, problem: null }),
    });
    const out = await settle({ phase: "BUILD", status: "needs_runs", runs: [{ script: "x", env: "local" }] });
    expect(turns).toBe(3);
    expect(out.result?.status).toBe("failed");
    expect(String(out.result?.reason ?? "").trim().length).toBeGreaterThan(10);
  });

  it("an ok result is untouched and nothing is run", async () => {
    let calls = 0;
    const settle = makeRunSettler({ apply: async () => (calls++, []), rerun: async () => (calls++, { result: null, problem: "x" }) });
    const ok = { phase: "BUILD", status: "ok" };
    expect((await settle(ok)).result).toBe(ok);
    expect(calls).toBe(0);
  });

  it("both BUILD paths, one repo and several, settle a needs_runs turn through it (the several-repo path had none)", () => {
    const src = readFileSync(new URL("../scripts/duties/web-property-change.mjs", import.meta.url), "utf8");
    const several = src.slice(src.indexOf("async function runSeveral("), src.indexOf("// LAND. The recorded gate passed in run()"));
    expect(several.length).toBeGreaterThan(1000);
    expect(several).toMatch(/makeRunSettler\(/);
    expect(several).toMatch(/if \(result\?\.status === "needs_runs"\) \(\{ result, problem \} = await settleRuns\(result\)\);/);
    expect(several, "a fix turn after the review may ask for runs too").toMatch(/await reviewBuild\(\{ job, base: prompt, result, names: p\.names,.*settleRuns \}\);/);
    const single = src.slice(src.indexOf("let { result, problem } = readResult(existsSync(resultPath)"), src.indexOf("async function runSeveral("));
    expect(single).toMatch(/makeRunSettler\(/);
  });
});

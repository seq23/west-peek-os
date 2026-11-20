import { describe, expect, it } from "vitest";
import { capTests, crashedSuites, TEST_CAP } from "../scripts/ci/check-changed.mjs";

describe("the pre-push check runs at most TEST_CAP test files", () => {
  it("a change imported by 70 tests runs the changed tests and the closest importers, not all 70", () => {
    const changed = ["t/wholeSentence.test.ts", "t/partnerHandOff.test.ts"];
    const direct = new Map<string, number>();
    for (let i = 0; i < 70; i++) direct.set(`t/importer${String(i).padStart(2, "0")}.test.ts`, 1);
    direct.set("t/firstReadDecides.test.ts", 3);
    const { run, left } = capTests(changed, direct, ["t/far.test.ts"]);
    expect(run).toHaveLength(TEST_CAP);
    expect(run).toEqual(expect.arrayContaining([...changed, "t/firstReadDecides.test.ts"]));
    expect(run).not.toContain("t/far.test.ts");
    expect(left).toBe(71 - (TEST_CAP - 2) + 1);
  });
  it("a small change still runs every direct and transitive test", () => {
    const { run, left } = capTests(["t/a.test.ts"], new Map([["t/b.test.ts", 1]]), ["t/c.test.ts"]);
    expect(run).toEqual(["t/a.test.ts", "t/b.test.ts", "t/c.test.ts"]);
    expect(left).toBe(0);
  });
  it("changed test files always run, even past the cap", () => {
    const own = Array.from({ length: TEST_CAP + 3 }, (_, i) => `t/own${i}.test.ts`);
    const { run, left } = capTests(own, new Map([["t/x.test.ts", 5]]), []);
    expect(run).toHaveLength(TEST_CAP + 3);
    expect(left).toBe(1);
  });
});

describe("a suite that crashed under load is run again; a failing test never is", () => {
  const crash = [
    " FAIL  tests/blocks.test.ts [ tests/blocks.test.ts ]",
    "TypeError: fetch failed",
    "Caused by: Error: read ECONNRESET",
    " FAIL  tests/artifacts.test.ts [ tests/artifacts.test.ts ]",
    " Test Files  2 failed | 3 passed (5)",
    "      Tests  72 passed | 351 skipped (423)",
  ].join("\n");
  it("names the crashed suites (20 Nov 2026 pre-push log)", () => {
    expect(crashedSuites(crash)).toEqual(["tests/blocks.test.ts", "tests/artifacts.test.ts"]);
  });
  it("a setup hook that timed out under load is a crash too (the second 20 Nov run)", () => {
    expect(crashedSuites(" FAIL  tests/blocks.test.ts [ tests/blocks.test.ts ]\nError: Hook timed out in 60000ms.\n      Tests  74 passed | 351 skipped (425)")).toEqual(["tests/blocks.test.ts"]);
  });
  it("a run with a failed test is not a crash", () => {
    expect(crashedSuites(crash.replace("Tests  72 passed", "Tests  1 failed | 71 passed"))).toEqual([]);
    expect(crashedSuites(" FAIL  tests/a.test.ts [ tests/a.test.ts ]\nSyntaxError: Unexpected token")).toEqual([]);
  });
});

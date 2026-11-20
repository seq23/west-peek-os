import { describe, expect, it } from "vitest";
// @ts-expect-error — a plain .mjs script with no type declarations
import { capTests, TEST_CAP } from "../scripts/ci/check-changed.mjs";

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

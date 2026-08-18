import { describe, expect, it } from "vitest";
import { operatorAttention } from "../src/shared/setup/operatorAttention";

describe("Home's attention strip only reports what it can prove", () => {
  it("says nothing when there is nothing to say", () => {
    // An empty command surface is a correct outcome. Manufacturing an item to look useful is the
    // failure this asserts against.
    expect(operatorAttention({})).toEqual([]);
    expect(
      operatorAttention({ jobs: [], unactivatedRecommendations: [], aiProviderConfigured: true }),
    ).toEqual([]);
  });

  it("treats a dead-lettered job as blocking, because that work silently stopped", () => {
    const out = operatorAttention({
      jobs: [{ job_key: "j1", name: "Daily briefing", status: "ACTIVE", dead_letters: 2 }],
    });
    expect(out[0]!.severity).toBe("BLOCKING");
    expect(out[0]!.headline).toContain("dead-letter");
    expect(out[0]!.headline).toContain("will not retry");
    expect(out[0]!.link).toBe("jobs");
  });

  it("reports refusals and failures as degraded, not as silence", () => {
    const out = operatorAttention({
      jobs: [
        {
          job_key: "j2",
          name: "LP monitor",
          status: "ACTIVE",
          recent_runs: [{ status: "REFUSED" }],
        },
      ],
    });
    expect(out.map((i) => i.key)).toContain("jobs-refused");
    expect(out.find((i) => i.key === "jobs-refused")!.severity).toBe("DEGRADED");
  });

  it("calls out an employee who is active but cannot work", () => {
    const out = operatorAttention({
      blockedActiveEmployees: [{ name: "Wesley", reason: "every machine is paused" }],
    });
    expect(out[0]!.headline).toContain("active but cannot work");
    expect(out[0]!.link).toBe("employees");
  });

  it("orders by consequence: blocking before degraded before info", () => {
    const out = operatorAttention({
      jobs: [
        { job_key: "a", name: "A", status: "PAUSED", pause_reason: "operator" },
        { job_key: "b", name: "B", status: "ACTIVE", dead_letters: 1 },
        { job_key: "c", name: "C", status: "ACTIVE", recent_runs: [{ status: "FAILED" }] },
      ],
      unactivatedRecommendations: ["Wren"],
    });
    expect(out.map((i) => i.severity)).toEqual(["BLOCKING", "DEGRADED", "INFO", "INFO"]);
  });

  it("every item carries an action and a destination", () => {
    const out = operatorAttention({
      aiProviderConfigured: false,
      jobs: [{ job_key: "a", name: "A", status: "ACTIVE", dead_letters: 1 }],
      unactivatedRecommendations: ["Wren"],
      blockedActiveEmployees: [{ name: "Paige", reason: "machine paused" }],
    });
    expect(out.length).toBeGreaterThan(3);
    for (const i of out) {
      expect(i.action.length).toBeGreaterThan(10);
      expect(i.link.length).toBeGreaterThan(0);
      expect(i.headline.length).toBeGreaterThan(10);
    }
  });

  it("omits provider trouble when the caller does not know, rather than assuming failure", () => {
    // `undefined` means unknown. Only an explicit `false` is a finding.
    const out = operatorAttention({ aiProviderConfigured: undefined });
    expect(out.map((i) => i.key)).not.toContain("no-provider");
  });
});

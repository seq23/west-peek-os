import { describe, expect, it } from "vitest";
import { readinessFor, type MachineStatus, type ReadinessInputs } from "../src/shared/setup/employeeReadiness";

/** Wesley works through exactly one machine: lp_fundraising. */
const WESLEY_MACHINE = "lp_fundraising";

function inputs(over: Partial<ReadinessInputs> = {}): ReadinessInputs {
  const machines = new Map<string, MachineStatus>([
    [WESLEY_MACHINE, { key: WESLEY_MACHINE, name: "LP & Fundraising", status: "ACTIVE" }],
  ]);
  return {
    employeeStatusByName: new Map([["Wesley", "ACTIVE"]]),
    machineStatusByKey: machines,
    aiProviderConfigured: true,
    ...over,
  };
}

describe("employee readiness reflects the real dependency chain", () => {
  it("an active employee with a live machine and a provider is READY", () => {
    const r = readinessFor("Wesley", inputs())!;
    expect(r.state).toBe("READY");
    expect(r.blockers).toEqual([]);
    expect(r.summary).toBe("Ready to work now.");
  });

  it("a paused machine blocks an otherwise-active employee", () => {
    // This is the case a naive UI gets wrong: the employee looks fine, but the server refuses to
    // route work to a paused machine (p17-machines.spec.ts).
    const r = readinessFor(
      "Wesley",
      inputs({
        machineStatusByKey: new Map([
          [WESLEY_MACHINE, { key: WESLEY_MACHINE, name: "LP & Fundraising", status: "PAUSED" }],
        ]),
      }),
    )!;
    expect(r.state).toBe("BLOCKED");
    expect(r.blockers.map((b) => b.kind)).toContain("ALL_MACHINES_PAUSED");
    expect(r.blockers.every((b) => b.action.length > 0)).toBe(true);
  });

  it("no provider blocks everyone, and says so once", () => {
    const r = readinessFor("Wesley", inputs({ aiProviderConfigured: false }))!;
    expect(r.state).toBe("BLOCKED");
    expect(r.blockers.map((b) => b.kind)).toContain("NO_AI_PROVIDER");
  });

  it("a pending activation is reported as awaiting approval, not as a failure", () => {
    const r = readinessFor(
      "Wesley",
      inputs({ employeeStatusByName: new Map([["Wesley", "CANDIDATE"]]) }),
    )!;
    expect(r.state).toBe("NOT_ACTIVATED");
    const b = r.blockers.find((x) => x.kind === "EMPLOYEE_NOT_ACTIVE")!;
    expect(b.detail).toContain("waiting for a Managing Partner approval receipt");
    expect(b.action).toContain("Approvals");
  });

  it("an unactivated employee is NOT_ACTIVATED and is told how to request activation", () => {
    const r = readinessFor("Wesley", inputs({ employeeStatusByName: new Map() }))!;
    expect(r.state).toBe("NOT_ACTIVATED");
    expect(r.blockers[0]!.action).toContain("Team → Employees");
  });

  it("a partially paused role can still work, and is not reported as blocked", () => {
    // Wyatt has two machines; pausing one narrows the work rather than stopping it.
    const r = readinessFor("Wyatt", {
      employeeStatusByName: new Map([["Wyatt", "ACTIVE"]]),
      machineStatusByKey: new Map<string, MachineStatus>([
        ["investment_mandate_exclusion", { key: "investment_mandate_exclusion", name: "Mandate", status: "PAUSED" }],
        ["venturedeals_deal_math", { key: "venturedeals_deal_math", name: "Deal math", status: "ACTIVE" }],
      ]),
      aiProviderConfigured: true,
    })!;
    expect(r.state).toBe("READY");
    expect(r.blockers.map((b) => b.kind)).toContain("SOME_MACHINES_PAUSED");
    expect(r.blockers.find((b) => b.kind === "SOME_MACHINES_PAUSED")!.fatal).toBe(false);
    expect(r.summary).toBe("Ready, with some work unavailable.");
  });

  it("a machine the server does not know about is surfaced, not ignored", () => {
    const r = readinessFor("Wesley", inputs({ machineStatusByKey: new Map() }))!;
    expect(r.blockers.map((b) => b.kind)).toContain("MACHINE_MISSING");
    expect(r.state).toBe("BLOCKED");
  });

  it("returns null for someone who is not on the roster rather than inventing them", () => {
    expect(readinessFor("Nobody", inputs())).toBeNull();
  });
});

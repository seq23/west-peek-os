import { describe, expect, it } from "vitest";
import { SKILL_LIBRARY, guidanceBlock, skillsForMachines } from "@shared/skills/library";
import { MACHINE_REGISTRY } from "@shared/registry/machines";
import { AI_EMPLOYEE_ROSTER } from "@shared/registry/aiEmployees";
import { DEPARTMENTS_COVER_ALL_DOMAINS, departmentDef } from "@shared/registry/departments";

/**
 * The firm's methods, and the two ways a written-down method rots.
 *
 * It attaches to a department that no longer exists, or it attaches to one no employee sits in —
 * either way it is guidance nobody will ever read, and nothing would say so.
 */
describe("the skill library is attached to a real firm", () => {
  it("keys every skill to a machine that exists", () => {
    const keys = new Set(MACHINE_REGISTRY.map((m) => m.key));
    const orphans = SKILL_LIBRARY.filter((d) => !keys.has(d.machineKey)).map((d) => d.machineKey);
    expect(orphans).toEqual([]);
  });

  it("puts the methods somewhere an employee actually sits", () => {
    // Guidance on a machine nobody works is guidance nobody reads.
    const seated = new Set(AI_EMPLOYEE_ROSTER.flatMap((e) => e.primaryMachineKeys));
    const unread = SKILL_LIBRARY.filter((d) => !seated.has(d.machineKey)).map((d) => d.machineKey);
    expect(unread).toEqual([]);
  });

  it("gives every domain the machine registry uses a human name", () => {
    // Otherwise the page falls back to shouting an enum, which is what it used to do.
    expect(DEPARTMENTS_COVER_ALL_DOMAINS).toBe(true);
    expect(departmentDef("INVESTMENT_OS").name).toBe("Investing");
  });
});

describe("what an employee is actually told", () => {
  it("gives Wyatt the research methods, because that is where he sits", () => {
    const wyatt = AI_EMPLOYEE_ROSTER.find((e) => e.name === "Wyatt")!;
    const block = guidanceBlock(wyatt.primaryMachineKeys);
    expect(block).toContain("Judging a source before believing it");
    expect(block).toContain("A finding with no source is an opinion");
  });

  it("gives Percy the page-review methods rather than the research ones", () => {
    const percy = AI_EMPLOYEE_ROSTER.find((e) => e.name === "Percy")!;
    const block = guidanceBlock(percy.primaryMachineKeys);
    expect(block).toContain("Why a page does not convert");
    expect(block).not.toContain("Judging a source before believing it");
  });

  it("says nothing at all for a department with no methods written down", () => {
    // An employee told "HOW THIS FIRM DOES THIS WORK:" followed by nothing has been told something
    // false about the firm. Empty means the section is omitted entirely.
    expect(guidanceBlock(["continuity_maintenance"])).toBe("");
    expect(skillsForMachines(["continuity_maintenance"])).toEqual([]);
  });

  it("frames them as guidelines and says the rules live elsewhere", () => {
    // The distinction is load-bearing: a rule belongs in code where it can be enforced. If this
    // ever reads as "these are the rules", an employee may believe it can break a real one.
    const block = guidanceBlock(["research_intelligence"]);
    expect(block).toContain("guidelines");
    expect(block).toContain("the rules are enforced elsewhere");
  });
});

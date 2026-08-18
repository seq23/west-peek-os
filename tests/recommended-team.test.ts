import { describe, expect, it } from "vitest";
import {
  FUND_PRIORITIES,
  recommendTeam,
} from "../src/shared/setup/recommendedTeam";
import { AI_EMPLOYEE_ROSTER } from "../src/shared/registry/aiEmployees";
// The recommended team is a SHORTLIST, so it is sized by the duty-roster window, not by how
// many employees may be employed at once. Those were one number until the cap was split.
import { FOCUS_TEAM_SIZE } from "../src/worker/services/aiEmployees";

describe("the recommended starting team", () => {
  it("only ever recommends people who exist on the real roster", () => {
    const r = recommendTeam(FOCUS_TEAM_SIZE);
    expect(r.unknownNames).toEqual([]);
    const names = new Set(AI_EMPLOYEE_ROSTER.map((e) => e.name));
    for (const rec of [...r.recommended, ...r.alsoConsidered]) {
      expect(names.has(rec.name), `${rec.name} is not on the roster`).toBe(true);
    }
  });

  it("never recommends more than the focus-team size", () => {
    const r = recommendTeam(FOCUS_TEAM_SIZE);
    expect(r.recommended.length).toBeLessThanOrEqual(FOCUS_TEAM_SIZE);
    // And the cap is genuinely respected rather than coincidentally satisfied.
    expect(recommendTeam(2).recommended).toHaveLength(2);
    expect(recommendTeam(0).recommended).toHaveLength(0);
  });

  it("surfaces what the cap costs instead of hiding it", () => {
    const r = recommendTeam(FOCUS_TEAM_SIZE);
    // Six priorities, five slots: exactly one priority must be visibly uncovered, and the person
    // who would have covered it must still be listed rather than dropped.
    expect(r.uncoveredPriorities.length).toBe(FUND_PRIORITIES.length - r.recommended.length);
    expect(r.alsoConsidered.length).toBeGreaterThan(0);
    for (const p of r.uncoveredPriorities) {
      expect(r.alsoConsidered.some((c) => c.priority === p)).toBe(true);
    }
  });

  it("gives every recommendation a distinct priority and a real reason", () => {
    const r = recommendTeam(FOCUS_TEAM_SIZE);
    const priorities = r.recommended.map((x) => x.priority);
    expect(new Set(priorities).size).toBe(priorities.length);
    for (const rec of r.recommended) {
      expect(rec.because.length).toBeGreaterThan(40);
      expect(rec.rank).toBeGreaterThan(0);
    }
  });

  it("is pure — recommending twice changes nothing", () => {
    expect(recommendTeam(FOCUS_TEAM_SIZE)).toEqual(
      recommendTeam(FOCUS_TEAM_SIZE),
    );
  });

  it("degrades honestly if a recommended name leaves the roster", () => {
    const shrunk = AI_EMPLOYEE_ROSTER.filter((e) => e.name !== "Willow");
    const r = recommendTeam(FOCUS_TEAM_SIZE, shrunk);
    expect(r.unknownNames).toContain("Willow");
    expect(r.recommended.some((x) => x.name === "Willow")).toBe(false);
    // It must not invent a replacement to keep the slot count up.
    expect(r.recommended.length).toBeLessThanOrEqual(FOCUS_TEAM_SIZE);
  });
});

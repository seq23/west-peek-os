import { describe, expect, it } from "vitest";
import {
  CLOSING_SIX,
  CORE_SECTIONS,
  SECTOR_MODULES,
  championRestrictedSections,
  questionCount,
  sectionsFor,
  sectorModule,
} from "../src/shared/ic/diligenceFramework";

/**
 * The framework is operator-authored content, so these tests guard its STRUCTURE — the rules that
 * make it a decision process rather than a questionnaire. Wording can change; the anti-bias rule
 * and the mandatory Closing Six cannot silently disappear.
 */

describe("core framework", () => {
  it("covers all eleven sections", () => {
    // The list IS the count. A separate toHaveLength(11) beside it could only ever fail together
    // with the toEqual below, and it was the half a reader had to update twice.
    expect(CORE_SECTIONS.map((s) => s.id)).toEqual([
      "founder", "problem", "product", "market", "traction", "distribution",
      "competition", "moat", "financing", "return_math", "kill_case",
    ]);
  });

  it("makes every core section mandatory", () => {
    // The operator's framing is that skipping a section is how a category of risk gets forgotten.
    expect(CORE_SECTIONS.filter((s) => !s.mandatory)).toEqual([]);
  });

  it("gives every section real questions", () => {
    for (const s of CORE_SECTIONS) expect(s.questions.length).toBeGreaterThanOrEqual(9);
  });
});

describe("the anti-bias rule", () => {
  it("bars the deal champion from answering the kill case", () => {
    const kill = CORE_SECTIONS.find((s) => s.id === "kill_case")!;
    expect(kill.championMayNotAnswer).toBe(true);
    expect(championRestrictedSections()).toContain("kill_case");
  });

  it("bars the champion from Closing Six question 6", () => {
    const six = CLOSING_SIX.find((q) => q.n === 6)!;
    expect(six.question).toMatch(/should NOT invest/);
    expect(six.championMayNotAnswer).toBe(true);
  });

  it("restricts only the bear-case questions and nothing else", () => {
    // Over-restricting would stall diligence; under-restricting loses the rule. Exactly one each.
    expect(championRestrictedSections()).toEqual(["kill_case"]);
    expect(CLOSING_SIX.filter((q) => q.championMayNotAnswer)).toHaveLength(1);
  });
});

describe("the Closing Six", () => {
  it("is exactly six, numbered one to six", () => {
    expect(CLOSING_SIX).toHaveLength(6);
    expect(CLOSING_SIX.map((q) => q.n)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("applies to every sector, including unknown ones", () => {
    expect(sectionsFor("OTHER").closingSix).toHaveLength(6);
    expect(sectionsFor("BIOTECH").closingSix).toHaveLength(6);
  });
});

describe("sector modules", () => {
  it("covers the nine named sectors", () => {
    expect(SECTOR_MODULES.map((m) => m.sector).sort()).toEqual([
      "AI", "B2B_SAAS", "BIOTECH", "CONSUMER", "CYBERSECURITY",
      "EDTECH", "FINTECH", "HEALTH_TECH", "MARKETPLACE",
    ]);
  });

  it("layers a sector module on top of core rather than replacing it", () => {
    const ai = sectionsFor("AI");
    // Counted from the framework: "on top of core" is the rule, and eleven is only today's core.
    expect(ai.core).toHaveLength(CORE_SECTIONS.length);
    expect(ai.sector?.title).toBe("AI / AI Infrastructure");
  });

  it("returns no module for OTHER without dropping the core", () => {
    const other = sectionsFor("OTHER");
    expect(other.sector).toBeUndefined();
    expect(other.core).toHaveLength(CORE_SECTIONS.length);
  });

  it("carries the killer question for the sectors that have one", () => {
    expect(sectorModule("AI")?.killer).toMatch(/essentially free tomorrow/);
    expect(sectorModule("B2B_SAAS")?.killer).toMatch(/tries to remove this product/);
    expect(sectorModule("HEALTH_TECH")?.killer).toMatch(/authority AND the economic incentive/);
  });
});

describe("coverage counting", () => {
  it("counts more questions for a sector deal than a generic one", () => {
    expect(questionCount("AI")).toBeGreaterThan(questionCount("OTHER"));
  });

  it("includes the Closing Six in the count", () => {
    const core = CORE_SECTIONS.reduce((n, s) => n + s.questions.length, 0);
    expect(questionCount("OTHER")).toBe(core + 6);
  });
});

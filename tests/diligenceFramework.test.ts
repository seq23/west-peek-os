import { describe, expect, it } from "vitest";
import {
  CLOSING_SIX,
  CORE_SECTIONS,
  championRestrictedSections,
  sectionsFor,
} from "../src/shared/ic/diligenceFramework";

/**
 * The framework is operator-authored content, so these tests guard its STRUCTURE — the rules that
 * make it a decision process rather than a questionnaire. Wording can change; the anti-bias rule
 * and the mandatory Closing Six cannot silently disappear.
 */

describe("core framework", () => {
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
  it("applies to every sector, including unknown ones", () => {
    expect(sectionsFor("OTHER").closingSix).toHaveLength(6);
    expect(sectionsFor("BIOTECH").closingSix).toHaveLength(6);
  });
});

describe("sector modules", () => {
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
});


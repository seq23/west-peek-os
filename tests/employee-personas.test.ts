import { describe, expect, it } from "vitest";
import { AI_EMPLOYEE_ROSTER } from "../src/shared/registry/aiEmployees";
import {
  EMPLOYEE_PERSONAS,
  VETERAN_STANDARD,
  personaFor,
  personaGaps,
  personaPrompt,
} from "../src/shared/registry/aiEmployeePersonas";

describe("every employee is a distinct veteran, not a badge on one assistant", () => {
  it("covers the whole roster with no gaps", () => {
    expect(personaGaps()).toEqual([]);
    expect(EMPLOYEE_PERSONAS).toHaveLength(AI_EMPLOYEE_ROSTER.length);
  });

  it("names only people who are actually on the roster", () => {
    const roster = new Set(AI_EMPLOYEE_ROSTER.map((e) => e.name));
    for (const p of EMPLOYEE_PERSONAS) expect(roster.has(p.name), `${p.name} is not on the roster`).toBe(true);
  });

  it("gives every employee a DISTINCT voice — the whole point", () => {
    // If two personas share a voice, seating either produces the same answer and the roster is
    // decorative. This is the assertion that keeps them genuinely different.
    const voices = EMPLOYEE_PERSONAS.map((p) => p.voice);
    expect(new Set(voices).size).toBe(voices.length);
    const expertise = EMPLOYEE_PERSONAS.map((p) => p.expertise);
    expect(new Set(expertise).size).toBe(expertise.length);
  });

  it("holds everyone to the veteran standard regardless of title", () => {
    // An "Associate" must not be framed as junior. The title is the seat, not the ceiling.
    const priya = personaFor("Priya")!;
    expect(priya.expertise).toMatch(/veteran|depth/i);
    for (const p of EMPLOYEE_PERSONAS) {
      expect(p.expertise.length).toBeGreaterThan(30);
      expect(p.voice.length).toBeGreaterThan(20);
    }
  });

  it("builds a prompt carrying identity, expertise, voice and the standard", () => {
    const prompt = personaPrompt("Walter", "Meeting Buddy");
    expect(prompt).toContain("Walter");
    expect(prompt).toContain("EXPERTISE:");
    expect(prompt).toContain("VOICE:");
    expect(prompt).toContain(VETERAN_STANDARD);
  });

  it("degrades to the standard rather than breaking for an unknown name", () => {
    const prompt = personaPrompt("Nobody", "Some Role");
    expect(prompt).toContain("Nobody");
    expect(prompt).toContain(VETERAN_STANDARD);
  });

  it("the standard forbids invention rather than merely praising the employee", () => {
    // "Best in discipline" has to mean something operational or it is just flattery in a prompt.
    expect(VETERAN_STANDARD).toMatch(/never invent/i);
    expect(VETERAN_STANDARD).toMatch(/outside your competence|unknowable/i);
  });
});

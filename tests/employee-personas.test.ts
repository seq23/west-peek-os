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
    // The title is the seat, not the ceiling. This used to check "Priya", the Associate, who was
    // merged into the Investment Lead in roster v4.0. Naming one person was always the weaker
    // test: the rule is that NO seat is framed as junior, and "Analyst" is simply the
    // junior-sounding title that happens to survive today.
    const junior = /\b(junior|entry.level|assists a|supports a senior|under the direction of|trainee)\b/i;
    for (const p of EMPLOYEE_PERSONAS) {
      expect(junior.test(p.expertise), `${p.name} is framed as junior`).toBe(false);
      expect(junior.test(p.voice), `${p.name} is framed as junior`).toBe(false);
    }
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

/**
 * Roster v4.0 added two facts that get read together before a human decision: who somebody IS, and
 * whether they can be put in front of an outsider. Both have to be present and honest on every
 * seat, or the decision gets made on a guess.
 */
describe("bios and outward-facing capability", () => {
  it("gives every employee a bio that says what they do", () => {
    for (const e of AI_EMPLOYEE_ROSTER) {
      expect(e.bio.length, `${e.name} has a thin bio`).toBeGreaterThan(80);
      // A bio that only restates the title tells the operator nothing they did not have.
      expect(e.bio.toLowerCase()).not.toBe(e.role.toLowerCase());
    }
  });

  it("declares a face for every employee", () => {
    for (const e of AI_EMPLOYEE_ROSTER) {
      expect(["INTERNAL_ONLY", "EXTERNAL_CAPABLE"]).toContain(e.face);
    }
  });

  it("keeps the seats that check the firm internal", () => {
    // Compliance and the money must not be outward-facing: one is the check on everyone else, the
    // other holds the fund's own numbers. Both would be a strange thing to put in a founder meeting.
    for (const name of ["Willow", "Preston", "Pax"]) {
      expect(AI_EMPLOYEE_ROSTER.find((e) => e.name === name)!.face).toBe("INTERNAL_ONLY");
    }
    // …and the seats whose whole job is meeting people are not locked inside.
    for (const name of ["Walter", "Wesley", "Parker"]) {
      expect(AI_EMPLOYEE_ROSTER.find((e) => e.name === name)!.face).toBe("EXTERNAL_CAPABLE");
    }
  });

  it("consolidated to seventeen, plus the seats brought back, minus the merge, without losing a discipline", () => {
    // Seventeen after the v4.0 consolidation. Nineteen once two RETIRED seats were re-pointed at
    // questions the live roster could not answer — Whitney to teach in University, Percy to review
    // design and growth — rather than new seats being invented beside people who already did the
    // job. EIGHTEEN since 21 Aug 2026: LP Sourcing merged into LP Relations, because Piper and
    // Wesley sat on `lp_fundraising` and nothing else, read byte-identical guidance, and were
    // therefore two seats working the same prospect at a fund with roughly forty LPs.
    //
    // The number is asserted because every move is a decision, and a roster silently growing back
    // towards thirty-one is exactly the failure this guards.
    expect(AI_EMPLOYEE_ROSTER).toHaveLength(18);
    // The merged seat is gone from the REGISTRY and only from there. Her database row is RETIRED
    // by migration 0126 rather than deleted, because ai_run attribution and meeting seating point
    // at it — see tests/workforce.test.ts, which asserts both halves.
    expect(AI_EMPLOYEE_ROSTER.some((e) => e.name === "Piper")).toBe(false);
    // Every one of these still has somebody accountable for it after the merges.
    const layers = new Set(AI_EMPLOYEE_ROSTER.map((e) => e.layer));
    expect(layers.size).toBeGreaterThanOrEqual(4);
    const roles = AI_EMPLOYEE_ROSTER.map((e) => e.role).join(" ").toLowerCase();
    for (const discipline of ["chief of staff", "compliance", "investment", "analyst", "lp", "portfolio", "finance", "communications", "operations", "professor", "ux design"]) {
      expect(roles, `nobody covers ${discipline}`).toContain(discipline);
    }
  });
});

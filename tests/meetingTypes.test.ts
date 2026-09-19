import { describe, expect, it } from "vitest";
import { MEETING_TYPES, meetingType, seatableFor } from "@shared/meetings/meetingTypes";
import { MEETING_TYPES as DB_TYPES } from "../src/worker/services/meetings";
import { AI_EMPLOYEE_ROSTER } from "@shared/registry/aiEmployees";

const EVERYONE = AI_EMPLOYEE_ROSTER.map((e) => e.name);

/**
 * The UI hardcoded FOUNDER on every meeting it created, so every meeting the firm recorded claimed
 * to be a founder meeting. That is not cosmetic — close-out delegation reads the type to decide who
 * follows up, so an LP call filed as a founder meeting routes its commitments to the wrong person.
 */
describe("meeting types", () => {
  it("covers exactly the types the database allows", () => {
    expect(MEETING_TYPES.map((t) => t.key).sort()).toEqual([...DB_TYPES].sort());
  });

  it("says what each one is for, in words rather than a noun", () => {
    for (const t of MEETING_TYPES) {
      expect(t.label).not.toMatch(/_/);
      expect(t.when.length).toBeGreaterThan(25);
      expect(t.suggests.length).toBeGreaterThan(0);
    }
  });

  it("only ever suggests employees who exist", () => {
    const names = new Set(EVERYONE);
    for (const t of MEETING_TYPES) {
      for (const s of t.suggests) expect(names.has(s), `${t.key} suggests ${s}, who is not on the roster`).toBe(true);
    }
  });
});

describe("who can sit in the room", () => {
  it("puts the suggested employees first", () => {
    const seats = seatableFor("DILIGENCE", EVERYONE);
    expect(seats[0]!.name).toBe("Wyatt");
    expect(seats[0]!.suggested).toBe(true);
    // …and everyone suggested comes before everyone not.
    const firstUnsuggested = seats.findIndex((s) => !s.suggested);
    expect(seats.slice(0, firstUnsuggested).every((s) => s.suggested)).toBe(true);
  });

  it("offers EVERY active employee for EVERY type — the owner's rule — and warns rather than hides", () => {
    // 18 Sep 2026: "all AI employees can be added to any meeting." The list used to drop
    // INTERNAL_ONLY seats from external meetings, which read as a lock the server never held.
    for (const t of MEETING_TYPES) {
      const names = seatableFor(t.key, EVERYONE).map((s) => s.name).sort();
      expect(names, `${t.key} does not offer the whole active roster`).toEqual([...EVERYONE].sort());
    }
  });

  it("carries a warning — in words — for an internal-only seat in an external meeting, and nowhere else", () => {
    const internalOnly = AI_EMPLOYEE_ROSTER.filter((e) => e.face === "INTERNAL_ONLY").map((e) => e.name);
    expect(internalOnly.length).toBeGreaterThan(0);
    for (const t of MEETING_TYPES) {
      for (const s of seatableFor(t.key, EVERYONE)) {
        const shouldWarn = t.external && internalOnly.includes(s.name);
        if (shouldWarn) {
          expect(s.warning, `${s.name} on ${t.key} needs a warning`).toMatch(/internal-only/);
          expect(s.warning, "a warning has to name the seat and say why").toContain(s.name);
          expect(s.warning!.length).toBeGreaterThan(40);
        } else {
          expect(s.warning, `${s.name} on ${t.key} must not be warned about`).toBeNull();
        }
      }
    }
    // Concretely: compliance and fund finance ARE offered for a founder meeting, with the warning.
    const founder = seatableFor("FOUNDER", EVERYONE);
    expect(founder.find((s) => s.name === "Willow")?.warning).toBeTruthy();
    expect(founder.find((s) => s.name === "Preston")?.warning).toBeTruthy();
    // …and sit in the internal meeting with no warning at all.
    const internal = seatableFor("INTERNAL", EVERYONE);
    expect(internal.find((s) => s.name === "Willow")?.warning).toBeNull();
  });

  it("never offers somebody who is switched off", () => {
    // Offering to seat a paused employee produces a server refusal and reads as a bug.
    const seats = seatableFor("FOUNDER", ["Walter", "Pierce"]);
    expect(seats.map((s) => s.name).sort()).toEqual(["Pierce", "Walter"]);
  });

  it("gives every seat a reason a person can read", () => {
    for (const s of seatableFor("PORTFOLIO", EVERYONE)) {
      expect(s.because.length).toBeGreaterThan(15);
      expect(s.role.length).toBeGreaterThan(0);
    }
  });

  it("returns nothing rather than throwing on an unknown type", () => {
    expect(() => seatableFor("NOT_A_TYPE", EVERYONE)).not.toThrow();
    expect(seatableFor("FOUNDER", [])).toEqual([]);
  });
});

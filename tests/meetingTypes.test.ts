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

  it("never offers an internal-only employee for a meeting with outsiders in it", () => {
    // Compliance exists to check the firm. Putting it in front of a founder is a category error.
    const external = seatableFor("FOUNDER", EVERYONE).map((s) => s.name);
    expect(external).not.toContain("Willow");
    expect(external).not.toContain("Preston");
    // The internal meeting is exactly where those seats belong.
    const internal = seatableFor("INTERNAL", EVERYONE).map((s) => s.name);
    expect(internal).toContain("Willow");
    expect(internal).toContain("Preston");
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

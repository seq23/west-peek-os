import { describe, expect, it } from "vitest";
import { AI_EMPLOYEE_ROSTER } from "@shared/registry/aiEmployees";
import { resolveDuty, shiftForHour, SHIFTS } from "@shared/workforce/dutyRoster";

/**
 * The rota decides the shape of a day, so its guarantees are the ones the operator will rely on
 * without checking: that it is predictable, that it never promises someone who is switched off,
 * and that a human can overrule it.
 */
describe("duty roster", () => {
  it("covers all 24 hours with exactly one shift each", () => {
    const hours = Array.from({ length: 24 }, (_, h) => shiftForHour(h));
    expect(hours).toHaveLength(24);
    for (const s of hours) expect(SHIFTS.map((x) => x.key)).toContain(s);
    // The wrap around midnight is where an off-by-one would hide.
    expect(shiftForHour(23)).toBe("OVERNIGHT");
    expect(shiftForHour(0)).toBe("OVERNIGHT");
    expect(shiftForHour(4)).toBe("OVERNIGHT");
    expect(shiftForHour(5)).toBe("MORNING");
  });

  it("is deterministic — the same hour always produces the same roster", () => {
    expect(resolveDuty(9, 5)).toEqual(resolveDuty(9, 5));
  });

  it("actually rotates: a morning and an afternoon are not the same people", () => {
    const morning = resolveDuty(8, 5).onDuty.map((d) => d.name);
    const midday = resolveDuty(14, 5).onDuty.map((d) => d.name);
    expect(morning).not.toEqual(midday);
    // …and not merely reordered.
    expect(midday.some((n) => !morning.includes(n))).toBe(true);
  });

  it("never rosters someone who is not available", () => {
    // Two REAL seats. This read `["Willow", "Wilson"]`, and Wilson has never been on the roster —
    // `resolveDuty` reads AI_EMPLOYEE_ROSTER internally, so the second name contributed nothing and
    // the test was really only proving the one-name case while looking like it proved two. The
    // suite has been bitten by invented employees before ("Paige", "Priya"); no fixture uses one.
    const only = [AI_EMPLOYEE_ROSTER[0]!.name, AI_EMPLOYEE_ROSTER[1]!.name];
    const duty = resolveDuty(9, 5, { available: only });
    expect(duty.onDuty.length).toBeGreaterThan(0);
    for (const d of duty.onDuty) expect(only).toContain(d.name);
  });

  it("honours a pin even when the hour would not have chosen them", () => {
    const unpinned = resolveDuty(8, 5).onDuty.map((d) => d.name);
    expect(unpinned).not.toContain("Wesley"); // an evening name
    const pinned = resolveDuty(8, 5, { pinned: ["Wesley"] });
    expect(pinned.onDuty[0]!.name).toBe("Wesley");
    expect(pinned.onDuty[0]!.because).toContain("asked for them");
  });

  it("respects the size it is given and never exceeds it", () => {
    for (const size of [1, 3, 5, 8]) {
      expect(resolveDuty(14, size).onDuty.length).toBeLessThanOrEqual(size);
    }
  });

  it("leaves a thin shift thin rather than padding it with anyone spare", () => {
    // Overnight is deliberately three people. Asking for five must not invent two more.
    const overnight = resolveDuty(2, 5);
    expect(overnight.onDuty.length).toBeLessThanOrEqual(3);
  });

  it("only ever names employees that exist on the real roster", () => {
    const names = new Set(AI_EMPLOYEE_ROSTER.map((e) => e.name));
    for (const hour of [2, 8, 14, 19]) {
      for (const d of resolveDuty(hour, 5).onDuty) expect(names.has(d.name)).toBe(true);
    }
  });

  it("gives every assignment a reason a person can read", () => {
    for (const d of resolveDuty(9, 5).onDuty) {
      expect(d.because.length).toBeGreaterThan(10);
      expect(d.role.length).toBeGreaterThan(0);
    }
  });
});

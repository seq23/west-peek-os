import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DELIVERIES, deliveryFor, greetingFor, roleFor } from "@shared/home/deliveries";
import { AI_EMPLOYEE_ROSTER } from "@shared/registry/aiEmployees";

/**
 * Home attributes every module to an employee, which is only worth doing if the attribution stays
 * true. A byline naming somebody who left the roster is worse than no byline: it tells the
 * operator to go and ask a person who does not exist.
 */
describe("morning deliveries", () => {
  it("attributes every module to an employee who is actually on the roster", () => {
    const names = new Set(AI_EMPLOYEE_ROSTER.map((e) => e.name));
    for (const d of DELIVERIES) {
      expect(names.has(d.by), `${d.module} is attributed to ${d.by}, who is not on the roster`).toBe(true);
    }
  });

  it("resolves a role for every author, so the byline is never half-empty", () => {
    for (const d of DELIVERIES) {
      expect(roleFor(d.by), `no role for ${d.by}`).toBeTruthy();
    }
  });

  it("says something useful when a module is empty", () => {
    // Silence from a colleague is information. "Nothing here." is not.
    for (const d of DELIVERIES) {
      expect(d.whenEmpty.length).toBeGreaterThan(15);
      expect(d.whenEmpty).not.toMatch(/^nothing here\.?$/i);
    }
  });

  it("never gives one module two authors", () => {
    const modules = DELIVERIES.map((d) => d.module);
    expect(new Set(modules).size).toBe(modules.length);
  });

  it("has an author for every module the home surface can emit", () => {
    // The drift that matters: mpHome grows a module, nobody adds a byline, and one card on Home
    // silently goes back to being anonymous. Read the real service rather than a copy of its list.
    const source = readFileSync(new URL("../src/worker/services/mpHome.ts", import.meta.url), "utf8");
    const emitted = [...source.matchAll(/^\s*key: "([a-z_]+)",$/gm)].map((m) => m[1]!);
    expect(emitted.length).toBeGreaterThan(5);
    const authored = new Set(DELIVERIES.map((d) => d.module));
    const orphaned = emitted.filter((k) => !authored.has(k));
    expect(orphaned, `modules with no author: ${orphaned.join(", ")}`).toEqual([]);
  });

  it("looks up by module and misses cleanly", () => {
    expect(deliveryFor("approvals")?.by).toBe("Walker");
    expect(deliveryFor("not_a_module")).toBeNull();
  });

  it("greets by the hour, all the way round the clock", () => {
    expect(greetingFor(7)).toBe("This morning");
    expect(greetingFor(14)).toBe("This afternoon");
    expect(greetingFor(19)).toBe("This evening");
    expect(greetingFor(23)).toBe("Tonight");
    // Wrapping must not produce a gap or an exception at the boundaries.
    for (let h = -24; h < 48; h += 1) expect(greetingFor(h).length).toBeGreaterThan(0);
  });
});

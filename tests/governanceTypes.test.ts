import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { GOVERNANCE_UPDATE_TYPES, RECOMMENDED_GOVERNANCE, governanceType } from "@shared/governance/updateTypes";

/**
 * The page offered five nouns and no guidance, so the honest response was to pick the first and
 * hope — which is how a rule gets filed as a bulletin and binds nobody. What these protect is the
 * one distinction that carries consequence: whether the thing binds.
 */
describe("governance update types", () => {
  it("covers exactly the types the service accepts", () => {
    // The enum lives in the service's zod schema; read it rather than keeping a second copy.
    const source = readFileSync(new URL("../src/worker/services/governance.ts", import.meta.url), "utf8");
    const match = source.match(/update_type:\s*z\.enum\(\[([^\]]+)\]\)/);
    expect(match, "could not find the update_type enum").toBeTruthy();
    const accepted = [...match![1]!.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]!).sort();
    expect(GOVERNANCE_UPDATE_TYPES.map((t) => t.key).sort()).toEqual(accepted);
  });

  it("marks exactly the binding kind as binding", () => {
    // If more than one kind binds, "does this change what anyone may do" stops being a clean read.
    const binding = GOVERNANCE_UPDATE_TYPES.filter((t) => t.binds).map((t) => t.key);
    expect(binding).toEqual(["RULE"]);
  });

  it("explains each kind rather than naming it", () => {
    for (const t of GOVERNANCE_UPDATE_TYPES) {
      expect(t.label).not.toMatch(/_/);
      expect(t.what.length).toBeGreaterThan(40);
      expect(t.when.length).toBeGreaterThan(30);
    }
  });

  it("gives every kind an example somebody at this firm would recognise", () => {
    // Generic governance filler teaches nothing. These should read like this fund.
    const all = GOVERNANCE_UPDATE_TYPES.map((t) => `${t.example.title} ${t.example.body}`).join(" ");
    expect(all).toMatch(/Fund I|LP|reserves|Sensori|pre-seed|outbound/i);
    for (const t of GOVERNANCE_UPDATE_TYPES) {
      expect(t.example.title.length).toBeGreaterThan(10);
      expect(t.example.body.length).toBeGreaterThan(80);
    }
  });

  it("keeps the recommendations few, and each pointed at a real kind", () => {
    // A page that opens with fifteen missing policies teaches the operator the list is decoration.
    expect(RECOMMENDED_GOVERNANCE.length).toBeLessThanOrEqual(5);
    for (const g of RECOMMENDED_GOVERNANCE) {
      expect(governanceType(g.suggests), `${g.key} suggests an unknown kind`).toBeTruthy();
      expect(g.because.length).toBeGreaterThan(60);
    }
  });

  it("misses cleanly on an unknown kind", () => {
    expect(governanceType("NOT_A_TYPE")).toBeNull();
  });
});

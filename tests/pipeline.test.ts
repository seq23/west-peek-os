import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EXITS, SPINE, STAGES, dealTypeLabel, originLabel, stage, stallRead } from "@shared/investment/pipeline";
import { OPPORTUNITY_STATUSES, RELATIONSHIP_ORIGINS, OPPORTUNITY_TYPES } from "../src/worker/services/investment";

/**
 * The pipeline vocabulary is a SECOND description of things the database already defines, which is
 * exactly the shape that drifts. These pin it: every status has a stage, every stage is a real
 * status, and nothing on screen can name something the database will refuse.
 */
describe("the pipeline as a partner reads it", () => {
  it("covers every status the database allows, and invents none", () => {
    const stageKeys = STAGES.map((s) => s.key).sort();
    expect(stageKeys).toEqual([...OPPORTUNITY_STATUSES].sort());
  });

  it("puts the forward stages in a single unbroken order", () => {
    const orders = SPINE.map((s) => s.order!);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    // No gaps and no ties — the spine is drawn from this, so a duplicate order is a visual bug.
    expect(new Set(orders).size).toBe(orders.length);
    expect(orders[0]).toBe(1);
    expect(orders[orders.length - 1]).toBe(orders.length);
  });

  it("keeps exits off the spine", () => {
    expect(EXITS.map((s) => s.key).sort()).toEqual(["PASS", "WITHDRAWN"]);
    for (const e of EXITS) expect(e.order).toBeNull();
    for (const s of SPINE) expect(s.isExit).toBe(false);
  });

  it("gives a clock only to stages where waiting is a failure", () => {
    // An investment and a recorded pass are outcomes; nothing is waiting, so nothing can stall.
    expect(stage("CLOSED")!.stallAfterDays).toBeNull();
    expect(stage("PASS")!.stallAfterDays).toBeNull();
    // And the sharpest clock is on the stage where only a decision is missing.
    expect(stage("IC_READY")!.stallAfterDays).toBeLessThan(stage("DILIGENCE")!.stallAfterDays!);
  });

  it("measures staleness from the last move, not from creation", () => {
    const now = new Date("2026-08-18T12:00:00Z");
    const moved = "2026-08-09T12:00:00Z"; // 9 days in screening
    const read = stallRead("SCREENING", moved, now)!;
    expect(read.days).toBe(9);
    expect(read.label).toBe("9 days");
    // Nine days of screening is under its two-week clock.
    expect(read.stalled).toBe(false);
    // The same nine days sitting ready to decide is not.
    expect(stallRead("IC_READY", moved, now)!.stalled).toBe(true);
  });

  it("reads sensibly at the boundaries rather than throwing", () => {
    const now = new Date("2026-08-18T12:00:00Z");
    expect(stallRead("SCREENING", null, now)).toBeNull();
    expect(stallRead("NOT_A_STAGE", "2026-08-01", now)).toBeNull();
    expect(stallRead("SCREENING", "not a date", now)).toBeNull();
    expect(stallRead("SCREENING", "2026-08-18T12:00:00Z", now)!.label).toBe("today");
    // A clock never runs backwards on a clock-skewed row.
    expect(stallRead("SCREENING", "2026-09-01T12:00:00Z", now)!.days).toBe(0);
  });

  it("never shows a raw enum where a person will read it", () => {
    for (const t of OPPORTUNITY_TYPES) {
      const label = dealTypeLabel(t);
      expect(label).not.toMatch(/_/);
      expect(label).not.toBe(t);
    }
    for (const o of RELATIONSHIP_ORIGINS) {
      const label = originLabel(o);
      expect(label).not.toMatch(/_/);
      expect(label).not.toBe(o);
    }
    for (const s of STAGES) {
      expect(s.label).not.toMatch(/_/);
      expect(s.question.length).toBeGreaterThan(5);
    }
  });

  it("keeps its stage keys identical to the migration's CHECK constraint", () => {
    // The service constant and the SQL can themselves drift; check the schema directly.
    const sql = readFileSync(new URL("../migrations/0006_investment_transaction_position.sql", import.meta.url), "utf8");
    for (const s of STAGES) {
      expect(sql, `${s.key} missing from the status CHECK`).toContain(`'${s.key}'`);
    }
  });
});

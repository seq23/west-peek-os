/**
 * THE NETWORK OS PRACTICE RUN CAN REACH THE CONFLICT LAW IT EXISTS TO SHOW (5 Oct 2026).
 *
 * #206 narrowed what a conflict is: only a LINKED_FIELDS field on a linked person can disagree.
 * The "Practice run against sample data" form on the Network OS page kept sending
 * `relationship_owner` — a field the detector never compares — so the control could no longer
 * produce a conflict at all, and the P9 journey that walks it went red (run 36850533285). A guard
 * that cannot reach what it governs is a defect class here; this pins that the form sends at least
 * one field the conflict law actually compares, read from the page's own code.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isDisputableField } from "../src/worker/services/networkAdapter";

const APP = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");

function practiceFields(src: string): string[] {
  const form = src.indexOf('data-testid="fixture-form"');
  expect(form, "the practice-run form must exist on the Network OS page").toBeGreaterThan(-1);
  const end = src.indexOf("</form>", form);
  const block = src.slice(form, end);
  const m = /fields:\s*\{([^}]*)\}/.exec(block);
  expect(m, "the practice run must send a fixture record with fields").not.toBeNull();
  return m![1]!
    .split(",")
    .map((part) => part.split(":")[0]!.trim())
    .filter((k) => /^[a-z_]+$/.test(k));
}

describe("the Network OS practice run", () => {
  it("sends at least one field the conflict detector compares", () => {
    const fields = practiceFields(APP);
    // HARD-FAIL ON ZERO: a form whose fields could not be read examined nothing.
    expect(fields.length, `fields read: ${fields.join(", ")}`).toBeGreaterThanOrEqual(2);
    const disputable = fields.filter((f) => f !== "email" && isDisputableField(f));
    expect(disputable, `practice fields ${fields.join(", ")} — none can ever conflict`).not.toEqual([]);
  });

  it("the input the operator types into is the field that can conflict", () => {
    expect(APP).toContain('data-testid="fixture-company"');
    expect(APP).toMatch(/Network OS says company =/);
  });
});

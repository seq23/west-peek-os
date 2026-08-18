import { describe, expect, it } from "vitest";
import { AI_EMPLOYEE_ROSTER, MAX_ACTIVE_AI_EMPLOYEES_DOC } from "../src/client/lib/helpFacts";
import { AI_EMPLOYEE_ROSTER as ROSTER } from "../src/shared/registry/aiEmployees";
import { MAX_ACTIVE_AI_EMPLOYEES } from "../src/worker/services/aiEmployees";

/**
 * The Help Center is allowed to state numbers. It is not allowed to state stale ones.
 *
 * These two assertions are the entire reason the client may restate a worker constant: the
 * duplication is pinned, so a change to the real rule breaks this test instead of quietly leaving
 * the operator reading a false cap.
 */
describe("help facts stay true to the system", () => {
  it("the documented roster size is the real roster size", () => {
    expect(AI_EMPLOYEE_ROSTER).toBe(ROSTER.length);
    // Guards against the derivation silently resolving to zero if the import shape changes.
    expect(AI_EMPLOYEE_ROSTER).toBeGreaterThan(0);
  });

  it("the documented activation cap is the enforced activation cap", () => {
    expect(MAX_ACTIVE_AI_EMPLOYEES_DOC).toBe(MAX_ACTIVE_AI_EMPLOYEES);
  });
});

import { describe, expect, it } from "vitest";
import { MAX_ACTIVE_AI_EMPLOYEES_DOC } from "../src/client/lib/helpFacts";
import { MAX_ACTIVE_AI_EMPLOYEES } from "../src/worker/services/aiEmployees";

/**
 * The Help Center is allowed to state numbers. It is not allowed to state stale ones.
 *
 * These two assertions are the entire reason the client may restate a worker constant: the
 * duplication is pinned, so a change to the real rule breaks this test instead of quietly leaving
 * the operator reading a false cap.
 */
describe("help facts stay true to the system", () => {
  it("the documented activation cap is the enforced activation cap", () => {
    expect(MAX_ACTIVE_AI_EMPLOYEES_DOC).toBe(MAX_ACTIVE_AI_EMPLOYEES);
  });
});

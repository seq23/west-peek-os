import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { answerQuestionForCard, type QuestionAnswerer } from "../src/worker/services/questionRouting";

/**
 * `answerQuestionForCard` — the routing half of Addendum 12, independent of any one card kind's
 * runner. Escalation (the safe default) is proven here for every reason it can fire BEFORE the
 * model is ever asked: no registered kind host, and a registered host who is not ACTIVE. The
 * model-call path itself (confident vs. not, and what reaches the partner) is proven end to end
 * against a real `WEB_PROPERTY_CHANGE` card in `tests/intakeActionability.test.ts`, alongside the
 * classifier it sits behind.
 */

let t: TestDb;
let env: Env;

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});

afterAll(async () => {
  await disposeTestDb(t);
});

const shouldNeverBeCalled: QuestionAnswerer = async () => {
  throw new Error("the model must not be asked when there is no ACTIVE host to ask it as");
};

describe("answerQuestionForCard — escalates before ever asking a model, when there is nobody real to ask", () => {
  it("a kind with no registered host is not confident, and the model is never called", async () => {
    const out = await answerQuestionForCard(
      env,
      { cardId: "wc_test", firmScope: "west-peek", kind: "ARTIFACT", cardTitle: "t", question: "what does this do?" },
      shouldNeverBeCalled,
    );
    expect(out.confident).toBe(false);
    expect(out.answer).toBeNull();
    expect(out.employeeName).toBeNull();
    expect(out.reason).toContain("no owning employee is registered");
  });

  it("null/unknown kind is not confident, and the model is never called", async () => {
    const out = await answerQuestionForCard(env, { cardId: "wc_test", firmScope: "west-peek", kind: null, cardTitle: "t", question: "?" }, shouldNeverBeCalled);
    expect(out.confident).toBe(false);
    expect(out.employeeName).toBeNull();
  });

  it("a registered host who is not ACTIVE right now is not confident, and the model is never called", async () => {
    // Deactivated by hand rather than assumed from a fresh firm's seed state — the point under
    // test is "status is not assumed, it comes from the database" (the same rule `pageHosts.ts`
    // holds a page host to), whatever Porter's status happens to default to elsewhere.
    await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'INACTIVE' WHERE id = 'aie_porter'").run();
    const before = await env.WP_OS_DB.prepare("SELECT status FROM ai_employee WHERE id = 'aie_porter'").first<{ status: string }>();
    expect(before?.status).toBe("INACTIVE");

    const out = await answerQuestionForCard(
      env,
      { cardId: "wc_test", firmScope: "west-peek", kind: "WEB_PROPERTY_CHANGE", cardTitle: "t", question: "is the preview link live?" },
      shouldNeverBeCalled,
    );
    expect(out.confident).toBe(false);
    expect(out.answer).toBeNull();
    expect(out.employeeName).toBe("Porter");
    expect(out.reason).toContain("not available to answer");
  });

  it("once Porter is ACTIVE, the model IS asked — and his real answer comes back through", async () => {
    await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id = 'aie_porter'").run();
    let sawEmployeeName = "";
    const out = await answerQuestionForCard(
      env,
      { cardId: "wc_test", firmScope: "west-peek", kind: "WEB_PROPERTY_CHANGE", cardTitle: "t", question: "is the preview link live?" },
      async (_e, input) => {
        sawEmployeeName = input.employee.name;
        return { confident: true, answer: "Yes, it's live now.", reason: "checked the branch's deploy status", aiRunId: null };
      },
    );
    expect(sawEmployeeName).toBe("Porter");
    expect(out.confident).toBe(true);
    expect(out.answer).toBe("Yes, it's live now.");
    expect(out.employeeName).toBe("Porter");
    expect(out.employeeId).toBe("aie_porter");
  });
});

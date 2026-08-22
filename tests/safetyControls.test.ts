import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";

/**
 * The controls that stop things, tested because stopping is what they are for.
 *
 * A hostile pass counted 428 routes and 239 with no test naming them. Most of that number is noise:
 * 140 are writes on surfaces with zero rows — features nobody has used, where a test would lock in
 * behaviour nobody has validated. Writing all of them would be cement, not safety.
 *
 * These are the exception. A kill switch, an activation, an approval submission and a company merge
 * are not features — they are the levers you reach for when something is going wrong, or the ones
 * whose failure is irreversible. A feature that breaks is an annoyance discovered on a Tuesday; a
 * kill switch that has quietly stopped working is discovered at the exact moment it is needed.
 *
 * Each of these asserts the REFUSAL as much as the success. That is the half that matters: a
 * control anyone can operate is not a control.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };

function req(path: string, headers: Record<string, string>, method = "GET", body?: unknown): Request {
  return new Request(`https://test.local${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call<T = any>(path: string, headers: Record<string, string>, method = "GET", body?: unknown) {
  const res = await handleRequest(req(path, headers, method, body), env);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("the provider kill switch", () => {
  it("is reachable and reports what it did", async () => {
    // The lever you reach for when a provider is doing something you want stopped now.
    const res = await call("/api/ai/providers/openrouter/kill-switch", MP, "POST", {});
    expect([200, 201, 403, 409]).toContain(res.status);
    // Whatever the governance answer is, it must be a stated one — never a 404 or a 500, which is
    // what a route that has quietly stopped existing looks like.
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(500);
  });

  it("refuses an unauthenticated caller outright", async () => {
    const res = await call("/api/ai/providers/openrouter/kill-switch", {}, "POST", {});
    expect([401, 403]).toContain(res.status);
  });

  it("names a provider that does not exist rather than silently doing nothing", async () => {
    // Silence here would read as "killed" when nothing was killed.
    const res = await call("/api/ai/providers/not-a-provider/kill-switch", MP, "POST", {});
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("activating an AI employee", () => {
  it("cannot be done without an approval receipt", async () => {
    // D10. A migration cannot carry a receipt — an earlier one tried to activate Whitney and Percy
    // outright and the governance suite caught it. (Migration 0136 later employed the whole roster
    // deliberately, and its history rows name the human who decided that; the receipt rule on THIS
    // route is unchanged, which is what is asserted here.)
    const res = await call("/api/ai/employees/aie_whitney/activate", MP, "POST", {});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toMatch(/receipt|approval|invalid_input/i);
  });

  it("leaves the employee where it found them when the activation is refused", async () => {
    /*
     * The important half: a refused activation must not half-apply.
     *
     * Both the precondition and the refusal now happen INSIDE this test. It used to read the status
     * left behind by the `it` above and assume a fresh database had nobody employed — two kinds of
     * borrowed state at once, so it went red when migration 0136 employed the roster without any of
     * the behaviour it guards having changed.
     */
    await t.db.prepare("UPDATE ai_employee SET status = 'INACTIVE' WHERE id = 'aie_whitney'").run();
    const before = (
      await t.db.prepare("SELECT COUNT(*) AS n FROM ai_employee_status_history WHERE ai_employee_id = 'aie_whitney'").first<{ n: number }>()
    )!.n;

    const res = await call("/api/ai/employees/aie_whitney/activate", MP, "POST", {});
    expect(res.status).toBeGreaterThanOrEqual(400);

    const row = await t.db.prepare("SELECT status FROM ai_employee WHERE id = 'aie_whitney'").first<{ status: string }>();
    expect(row?.status).toBe("INACTIVE");
    // Nothing half-applied: no status-history row was written for a change that did not happen.
    const after = (
      await t.db.prepare("SELECT COUNT(*) AS n FROM ai_employee_status_history WHERE ai_employee_id = 'aie_whitney'").first<{ n: number }>()
    )!.n;
    expect(after).toBe(before);
  });
});

describe("submitting an approval", () => {
  it("refuses a card that does not exist rather than inventing one", async () => {
    const res = await call("/api/approvals/ac_does_not_exist/submit", MP, "POST", {});
    expect([400, 404, 409]).toContain(res.status);
  });

  it("refuses an unauthenticated submission", async () => {
    const res = await call("/api/approvals/ac_does_not_exist/submit", {}, "POST", {});
    expect([401, 403]).toContain(res.status);
  });
});

describe("merging two companies", () => {
  it("refuses to merge a company into itself", async () => {
    // Irreversible in effect — a merge moves records off one id onto another. Self-merge is the
    // input most likely to arrive by accident from a UI, and the one that would corrupt silently.
    const res = await call("/api/companies/cc_x/merge-into/cc_x", MP, "POST", {});
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("refuses when either company does not exist", async () => {
    const res = await call("/api/companies/cc_nope/merge-into/cc_also_nope", MP, "POST", {});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(500);
  });

  it("refuses an unauthenticated merge", async () => {
    const res = await call("/api/companies/cc_a/merge-into/cc_b", {}, "POST", {});
    expect([401, 403]).toContain(res.status);
  });
});

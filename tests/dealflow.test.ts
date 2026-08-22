import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";

/**
 * The pipeline's advice layer: an employee's view on a deal, kept apart from the decision.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

async function call<T = any>(path: string, headers: Record<string, string>, method = "GET", body?: unknown): Promise<{ status: number; body: T }> {
  const res = await handleRequest(
    new Request(`https://test.local${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
  return { status: res.status, body: (await res.json()) as T };
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});
afterAll(async () => {
  await disposeTestDb(t);
});

describe("an employee advises; the partner decides", () => {
  /**
   * Operator rule: "every arrival survives until i've seen it but it comes with a recommendation to
   * scrap it... never scrap our inbound stuff without our input."
   *
   * The easier implementation — let the analyst pass it outright and rely on the passed pile being
   * visible — inverts that rule. A passed deal has LEFT the funnel, so what was turned away becomes
   * something a partner has to remember to go and look for, and that is the thing decided by nobody.
   */
  it("records a recommendation without moving the deal", async () => {
    const co = await call<{ id: string }>("/api/companies", MP, "POST", { canonical_name: "Recommend Co" });
    const opp = await call<{ id: string; status: string }>("/api/opportunities", MP, "POST", {
      company_id: co.body.id,
      opportunity_type: "EARLY_STAGE_PRIMARY",
      title: "Recommend Co",
    });
    expect(opp.body.status).toBe("NEW");

    const rec = await call(`/api/opportunities/${opp.body.id}/recommend`, MP, "POST", {
      recommendation: "PASS",
      note: "Off-thesis: consumer marketplace, no AI component.",
      by: "Wyatt",
    });
    expect(rec.status).toBe(200);

    const after = await t.db
      .prepare("SELECT status, recommendation, recommendation_note, recommended_by FROM investment_opportunity WHERE id = ?1")
      .bind(opp.body.id)
      .first<{ status: string; recommendation: string; recommendation_note: string; recommended_by: string }>();
    // The deal has NOT moved. A recommendation is not a state.
    expect(after!.status).toBe("NEW");
    expect(after!.recommendation).toBe("PASS");
    expect(after!.recommended_by).toBe("Wyatt");
    expect(after!.recommendation_note).toContain("Off-thesis");
  });

  it("lets a partner dismiss the advice and keep the deal", async () => {
    const row = await t.db
      .prepare("SELECT id FROM investment_opportunity WHERE recommendation = 'PASS' LIMIT 1")
      .first<{ id: string }>();
    const cleared = await call(`/api/opportunities/${row!.id}/recommend`, MP, "POST", { recommendation: null });
    expect(cleared.status).toBe(200);

    const after = await t.db
      .prepare("SELECT status, recommendation, recommended_by FROM investment_opportunity WHERE id = ?1")
      .bind(row!.id)
      .first<{ status: string; recommendation: string | null; recommended_by: string | null }>();
    expect(after!.recommendation).toBeNull();
    expect(after!.recommended_by).toBeNull();
    // Still in the funnel, still where it was.
    expect(after!.status).toBe("NEW");
  });
});

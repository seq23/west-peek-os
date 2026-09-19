import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";

/**
 * A REMOVED DEAL RECORD DOES NOT COME BACK AS INTELLIGENCE.
 *
 * `acquireInternal` turns every open NEW/SCREENING/IC_READY opportunity into an intelligence item,
 * and it read them without regard to `archived_at` — so a record struck out as a duplicate or a
 * typo ("Remove this record", 0098) was scored as a live opportunity and could fill the partners'
 * Home module. Every other list already filters archived records; this pins that the engine does too,
 * from the route, with the removal made the way the product makes it.
 */

let t: TestDb;
let env: Env;
const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

async function call<T = any>(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: T }> {
  const res = await handleRequest(
    new Request(`https://test.local${path}`, {
      method,
      headers: body === undefined ? MP : { ...MP, "content-type": "application/json" },
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

describe("the intelligence engine and removed records", () => {
  it("acquires a live NEW deal and never one that was removed before the run", async () => {
    /*
     * The removal happens BEFORE the engine ever sees the record. A first version ran the engine,
     * removed the deal, ran again and looked for it in the second run's items — and passed with the
     * filter deleted, because items are deduped by external_id across runs and the second run would
     * not have re-emitted the record either way. The order here is what makes the assertion bite.
     */
    const deal = async (name: string): Promise<string> => {
      const co = await call<{ id: string }>("/api/companies", "POST", { canonical_name: name });
      expect(co.status).toBe(201);
      const opp = await call<{ id: string }>("/api/opportunities", "POST", {
        company_id: co.body.id,
        opportunity_type: "EARLY_STAGE_PRIMARY",
        title: `${name} — pre-seed`,
        relationship_origin: "INBOUND",
      });
      expect(opp.status).toBe(201);
      return opp.body.id;
    };

    const struck = await deal("Struck Out Twice Co");
    const removed = await call(`/api/opportunities/${struck}/archive`, "POST", { reason: "entered twice; the other record is the real one" });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    // A live deal beside it, so "nothing came back" cannot pass by accident.
    await deal("Still Live Co");

    const run = await call<{ items: Array<{ title: string }> }>("/api/intelligence/runs", "POST", {
      idempotency_key: "removed-records-run",
      source_keys: ["firm_state"],
      manual_items: [],
    });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect(
      run.body.items.some((i) => i.title.includes("Still Live Co")),
      "Rule 0 — no live deal was acquired at all, so the absence below would prove nothing",
    ).toBe(true);
    expect(
      run.body.items.some((i) => i.title.includes("Struck Out Twice Co")),
      "a removed record must not come back as an intelligence item",
    ).toBe(false);
  });
});

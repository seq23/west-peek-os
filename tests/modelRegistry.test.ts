import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { SEARCH_MODEL } from "../src/worker/services/liveSearch";

/**
 * A registered model with no price is an inert row wearing an ACTIVE badge.
 *
 * FOUND 14 Sep 2026: `perplexity/sonar` — the one search-grounded model, the whole reason
 * liveSearch.ts exists — had been ACTIVE in provider_model since migration 0042 and had never once
 * been chosen, because runAi routes only to a priced model and it had no pricing row. Every
 * employee "search" was answered by a general model saying it had no web access, and the
 * employee wrote that down as "the company does not exist".
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

describe("every ACTIVE model can actually be routed to", () => {
  it("has a pricing snapshot for every ACTIVE provider_model row, so none is unreachable by construction", async () => {
    const rows = (
      await env.WP_OS_DB.prepare(
        `SELECT pm.provider_id, pm.model
           FROM provider_model pm
          WHERE pm.status = 'ACTIVE'
            AND NOT EXISTS (SELECT 1 FROM provider_pricing_snapshot pps WHERE pps.provider_id = pm.provider_id AND pps.model = pm.model)`,
      ).all<{ provider_id: string; model: string }>()
    ).results ?? [];
    expect(rows, `ACTIVE models with no price (never routable): ${rows.map((r) => `${r.provider_id}/${r.model}`).join(", ")}`).toEqual([]);
    const active = (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM provider_model WHERE status = 'ACTIVE'").first<{ n: number }>())!.n;
    expect(active, "Rule 0: the registry examined has no active models").toBeGreaterThan(0);
  });

  it("the search model in particular is priced on the provider that carries it", async () => {
    const row = await env.WP_OS_DB.prepare(
      "SELECT input_per_mtok_usd FROM provider_pricing_snapshot WHERE provider_id = 'prov_openrouter' AND model = ?1",
    ).bind(SEARCH_MODEL).first<{ input_per_mtok_usd: number }>();
    expect(row, `${SEARCH_MODEL} has no price on OpenRouter and can never be selected`).toBeTruthy();
  });
});

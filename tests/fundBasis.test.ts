import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";

/**
 * Item 13 — what the fund actually is, so a scenario stops being modelled against fiction.
 *
 * THE BUG THIS EXISTS TO PREVENT COMING BACK. `App.tsx` created every allocation scenario with
 * `fund_size: 30000000, investable: 24000000, fund_deployed: 10000000, reserve_modeled_need:
 * 8000000` hardcoded into the request body. Not a form default a partner could see and correct —
 * numbers no partner ever laid eyes on. The constraint engine then answered "does this sleeve fit",
 * "is concentration within limit" and "is the reserve sufficient" against a thirty-million-dollar
 * fund the firm does not have, and printed the answers with the confidence of arithmetic.
 *
 * The rule now: every number carries where it came from, and MISSING is an answer the caller must
 * refuse on rather than paper over. There is deliberately no "assumed" — an assumption is what got
 * us here.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };

function req(path: string, headers: Record<string, string> = {}, method = "GET", body?: unknown): Request {
  return new Request(`https://test.local${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call<T = any>(path: string, headers: Record<string, string>, method = "GET", body?: unknown): Promise<{ status: number; body: T }> {
  const res = await handleRequest(req(path, headers, method, body), env);
  return { status: res.status, body: (await res.json()) as T };
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});

afterAll(async () => {
  await disposeTestDb(t);
});

interface Basis {
  fund_size: number | null;
  fund_size_source: string;
  fund_deployed: number;
  fund_deployed_source: string;
  positions_held: number;
  investable: number | null;
  investable_source: string;
  ready: boolean;
  blocked_because: string | null;
}

describe("a scenario is modelled against the fund that exists", () => {
  it("refuses, in English, when nobody has recorded how big the fund is", async () => {
    const fund = await call<{ id: string }>("/api/funds", MP, "POST", { name: "Unsized Fund", vintage_year: 2026 });
    expect(fund.status).toBe(201);

    const basis = await call<Basis>(`/api/funds/${fund.body.id}/basis`, MP);
    expect(basis.status).toBe(200);
    expect(basis.body.fund_size).toBeNull();
    expect(basis.body.fund_size_source).toBe("MISSING");
    expect(basis.body.ready).toBe(false);
    // The caller has to SHOW this when it refuses, so it must be a sentence, not a code.
    expect(basis.body.blocked_because).toMatch(/size has not been recorded/i);
  });

  it("reports nothing deployed as DERIVED, not MISSING — a fund that bought nothing deployed nothing", async () => {
    const fund = await call<{ id: string }>("/api/funds", MP, "POST", { name: "Fresh Fund", vintage_year: 2026 });
    const basis = await call<Basis>(`/api/funds/${fund.body.id}/basis`, MP);

    expect(basis.body.fund_deployed).toBe(0);
    // Calling this MISSING would send the caller looking for a number that does not exist to be found.
    expect(basis.body.fund_deployed_source).toBe("DERIVED");
    expect(basis.body.positions_held).toBe(0);
  });

  it("will not invent an investable figure from a fee model nobody recorded", async () => {
    const fund = await call<{ id: string }>("/api/funds", MP, "POST", { name: "Feeless Fund", vintage_year: 2026 });
    const basis = await call<Basis>(`/api/funds/${fund.body.id}/basis`, MP);

    // Substituting the standard 20% would be the same mistake at a smaller scale.
    expect(basis.body.investable).toBeNull();
    expect(basis.body.investable_source).toBe("MISSING");
  });

  it("reads a recorded fund size back in whole currency, and only then reports itself ready", async () => {
    const fund = await call<{ id: string }>("/api/funds", MP, "POST", { name: "Sized Fund", vintage_year: 2026 });
    // Minor units in the column — a REAL would put rounding into the one table where the number IS
    // the fact — and whole currency out, converted once here rather than in each caller.
    await env.WP_OS_DB.prepare("UPDATE fund SET target_size_minor = ?1 WHERE id = ?2")
      .bind(2_500_000_00, fund.body.id)
      .run();

    const basis = await call<Basis>(`/api/funds/${fund.body.id}/basis`, MP);
    expect(basis.body.fund_size).toBe(2_500_000);
    expect(basis.body.fund_size_source).toBe("RECORDED");
    expect(basis.body.ready).toBe(true);
    expect(basis.body.blocked_because).toBeNull();
  });

  it("has nothing to say about a fund that does not exist", async () => {
    const missing = await call(`/api/funds/fnd_nope/basis`, MP);
    expect(missing.status).toBe(404);
  });
});

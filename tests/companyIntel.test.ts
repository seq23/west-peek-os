import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { handleCompanyIntelligence, handleFollowOnCentre } from "../src/worker/services/companyIntel";

/**
 * Company Intelligence and the Follow-On Decision Centre (P35, V1 #32 and #39).
 *
 * These are SQL-heavy read surfaces, and TypeScript cannot check SQL. The queries involve a
 * latest-per-metric self-join that is easy to get subtly wrong — an off-by-one in the "previous
 * reading" subquery would silently compare a metric against itself and report everything as
 * pulling ahead. So the fixtures build a real position with a real metric history and assert the
 * comparison lands on the right pair of readings.
 */

let t: TestDb;
let env: Env;

const CO_UP = "cc_intel_up";
const CO_FLAT = "cc_intel_flat";

function ctx(env: Env, url: string, params: Record<string, string> = {}) {
  return { request: new Request(`https://test.local${url}`), env, params, identity: null } as never;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  const run = (sql: string) => env.WP_OS_DB.prepare(sql).run();

  await run(`INSERT INTO canonical_company (id, canonical_name, created_by, firm_scope) VALUES
    ('${CO_UP}','Ascending Co','fu_scooter_taylor','west-peek'),
    ('${CO_FLAT}','Flat Co','fu_scooter_taylor','west-peek')`);
  await run(`INSERT INTO fund (id, name, firm_scope) VALUES ('fund_intel','Fund I','west-peek')`);
  await run(`INSERT INTO security_class (id, company_id, class_name, seniority, firm_scope) VALUES
    ('sc_up','${CO_UP}','Seed Preferred',1,'west-peek'),
    ('sc_flat','${CO_FLAT}','Seed Preferred',1,'west-peek')`);
  await run(`INSERT INTO position (id, company_id, fund_id, security_class_id, quantity, cost_basis, status, firm_scope, opened_at) VALUES
    ('pos_up','${CO_UP}','fund_intel','sc_up',1000,50000,'OPEN','west-peek','2026-01-01'),
    ('pos_flat','${CO_FLAT}','fund_intel','sc_flat',1000,50000,'OPEN','west-peek','2026-01-01')`);

  // Three readings for the ascending company. The middle one exists specifically so the query has
  // to pick the correct "previous" — comparing Mar against Jan would still look like growth, so a
  // broken subquery would pass a two-point test.
  await run(`INSERT INTO portfolio_metric_snapshot (id, company_id, metric_key, as_of_date, value, source, firm_scope, created_by) VALUES
    ('pms_up_1','${CO_UP}','arr','2026-01-31',100,'UPDATE','west-peek','fu_scooter_taylor'),
    ('pms_up_2','${CO_UP}','arr','2026-02-28',120,'UPDATE','west-peek','fu_scooter_taylor'),
    ('pms_up_3','${CO_UP}','arr','2026-03-31',150,'UPDATE','west-peek','fu_scooter_taylor'),
    ('pms_flat_1','${CO_FLAT}','arr','2026-01-31',200,'UPDATE','west-peek','fu_scooter_taylor'),
    ('pms_flat_2','${CO_FLAT}','arr','2026-02-28',180,'UPDATE','west-peek','fu_scooter_taylor')`);

  await run(`INSERT INTO diligence_claim (id, company_id, subject_type, subject_id, claim_text, claim_status, confidence, extracted_by_type, extracted_by_id, firm_scope) VALUES
    ('dc_sourced','${CO_UP}','company','${CO_UP}','ARR is $150k','UNVERIFIED',0.8,'HUMAN','fu_scooter_taylor','west-peek'),
    ('dc_bare','${CO_UP}','company','${CO_UP}','Team is 12 people','UNVERIFIED',0.5,'HUMAN','fu_scooter_taylor','west-peek')`);
  await run(`INSERT INTO claim_source (id, claim_id, source_type, location, source_date, method, created_by, firm_scope) VALUES
    ('cs_1','dc_sourced','DOCUMENT','p3','2026-03-31','READ','fu_scooter_taylor','west-peek')`);
});

afterAll(async () => {
  await disposeTestDb(t);
});

async function body(res: Response) {
  return (await res.json()) as Record<string, never>;
}

describe("company intelligence", () => {
  it("404s a company that does not exist", async () => {
    const res = await handleCompanyIntelligence(ctx(env, "/api/companies/nope/intelligence", { id: "nope" }));
    expect(res.status).toBe(404);
  });

  it("returns only the LATEST reading per metric", async () => {
    const d = await body(await handleCompanyIntelligence(ctx(env, "/x", { id: CO_UP })));
    const metrics = d.metrics as unknown as Array<{ metric_key: string; value: number; as_of_date: string }>;
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.value).toBe(150);
    expect(metrics[0]!.as_of_date).toBe("2026-03-31");
  });

  it("carries the as-of date with every metric", async () => {
    // A number without a date invites someone to quote it in a meeting not knowing its age.
    const d = await body(await handleCompanyIntelligence(ctx(env, "/x", { id: CO_UP })));
    for (const m of d.metrics as unknown as Array<{ as_of_date: string }>) expect(m.as_of_date).toBeTruthy();
  });

  it("counts unsourced claims separately from sourced ones", async () => {
    const d = await body(await handleCompanyIntelligence(ctx(env, "/x", { id: CO_UP })));
    expect(d.unsourced_claims).toBe(1);
    const claims = d.claims as unknown as Array<{ id: string; source_count: number }>;
    expect(claims.find((c) => c.id === "dc_sourced")!.source_count).toBe(1);
    expect(claims.find((c) => c.id === "dc_bare")!.source_count).toBe(0);
  });

  it("reports how much is known so an empty page is distinguishable from a failure", async () => {
    const d = await body(await handleCompanyIntelligence(ctx(env, "/x", { id: CO_UP })));
    expect(Number(d.known)).toBeGreaterThan(0);
  });
});

describe("follow-on centre", () => {
  it("finds the company whose metric improved", async () => {
    const d = await body(await handleFollowOnCentre(ctx(env, "/api/follow-on")));
    const c = d.candidates as unknown as Array<{ company_name: string; latest_value: number; previous_value: number }>;
    const up = c.find((x) => x.company_name === "Ascending Co");
    expect(up).toBeTruthy();
  });

  it("compares against the IMMEDIATELY previous reading, not the earliest", async () => {
    // The bug this catches: comparing Mar (150) against Jan (100) instead of Feb (120). Both look
    // like growth, so only the exact previous value proves the subquery is right.
    const d = await body(await handleFollowOnCentre(ctx(env, "/api/follow-on")));
    const up = (d.candidates as unknown as Array<{ company_name: string; previous_value: number; latest_value: number }>)
      .find((x) => x.company_name === "Ascending Co")!;
    expect(up.previous_value).toBe(120);
    expect(up.latest_value).toBe(150);
  });

  it("excludes a company whose metric fell", async () => {
    const d = await body(await handleFollowOnCentre(ctx(env, "/api/follow-on")));
    const names = (d.candidates as unknown as Array<{ company_name: string }>).map((x) => x.company_name);
    expect(names).not.toContain("Flat Co");
  });

  it("publishes the rule it used rather than leaving it implicit", async () => {
    const d = await body(await handleFollowOnCentre(ctx(env, "/api/follow-on")));
    expect(String(d.candidate_rule)).toMatch(/open position/i);
  });
});

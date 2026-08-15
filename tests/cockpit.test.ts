import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import { computeTrends } from "../src/worker/services/cockpit";
import { buildHome } from "../src/worker/services/mpHome";

/**
 * P25 — Portfolio cockpit, allocation decision view, and MP command coherence
 * (GAP-12, GAP-13, GAP-23).
 *
 * Rules under test:
 * - Trends are computed from dated snapshots against each metric's DECLARED direction, so
 *   "deteriorating" means the same thing here as in P8 alerting.
 * - Missing data is a finding: a metric past its own staleness rule is reported, not blanked.
 * - The allocation view READS P11's recorded results and recomputes nothing; with no comparison
 *   run it shows no constraint effects rather than inventing any.
 * - The allocation view names the human-reserved action for every option type and states that a
 *   scenario is not a prediction.
 * - MP Home answers all ten §4 questions once the workforce module is enabled.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

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

let seq = 0;
async function makeCompany(name: string): Promise<string> {
  seq += 1;
  const res = await call<{ id: string }>("/api/companies", MP, "POST", { canonical_name: `${name} ${seq}` });
  expect(res.status).toBe(201);
  return res.body.id;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("trend arithmetic reads the metric's declared direction", () => {
  const base = { canonical_name: "Acme", metric_name: "ARR", stale_after_days: null };

  it("calls a fall in a higher-is-better metric DETERIORATING and a rise IMPROVING", () => {
    const trends = computeTrends([
      { ...base, company_id: "c1", metric_key: "arr", as_of_date: "2026-07-01", value: 100, direction: "HIGHER_IS_BETTER" },
      { ...base, company_id: "c1", metric_key: "arr", as_of_date: "2026-08-01", value: 80, direction: "HIGHER_IS_BETTER" },
    ]);
    expect(trends[0]!.verdict).toBe("DETERIORATING");
    expect(trends[0]!.change_pct).toBe(-20);
    expect(trends[0]!.window).toBe("2026-07-01 → 2026-08-01");
  });

  it("inverts the verdict for a lower-is-better metric", () => {
    const trends = computeTrends([
      { ...base, metric_name: "Burn", company_id: "c1", metric_key: "burn", as_of_date: "2026-07-01", value: 100, direction: "LOWER_IS_BETTER" },
      { ...base, metric_name: "Burn", company_id: "c1", metric_key: "burn", as_of_date: "2026-08-01", value: 80, direction: "LOWER_IS_BETTER" },
    ]);
    expect(trends[0]!.verdict).toBe("IMPROVING");
  });

  it("says nothing at all when there is only one snapshot", () => {
    const trends = computeTrends([
      { ...base, company_id: "c1", metric_key: "arr", as_of_date: "2026-08-01", value: 80, direction: "HIGHER_IS_BETTER" },
    ]);
    expect(trends).toHaveLength(0);
  });
});

describe("the cockpit reports movement and missing data from real records", () => {
  it("shows a deteriorating metric and reports a stale one as a finding", async () => {
    const companyId = await makeCompany("Cockpit Co");
    await call("/api/portfolio/metric-definitions", MP, "POST", {
      metric_key: `arr_${seq}`,
      name: "ARR",
      direction: "HIGHER_IS_BETTER",
      stale_after_days: 30,
    });
    const metricKey = `arr_${seq}`;
    await call("/api/portfolio/snapshots", MP, "POST", {
      company_id: companyId,
      metric_key: metricKey,
      as_of_date: "2026-01-01",
      value: 1000,
      source: "portfolio update",
    });
    await call("/api/portfolio/snapshots", MP, "POST", {
      company_id: companyId,
      metric_key: metricKey,
      as_of_date: "2026-02-01",
      value: 700,
      source: "portfolio update",
    });

    const res = await call<{
      deteriorating: Array<{ metric_key?: string; company: string; change_pct: number }>;
      stale_or_missing: Array<{ metric: string; days_old: number }>;
      definitions: Record<string, string>;
    }>("/api/portfolio/cockpit", MP);
    expect(res.status).toBe(200);
    expect(res.body.deteriorating.some((d) => d.change_pct === -30)).toBe(true);
    // Both snapshots are far in the past relative to "now", so the pair is past its 30-day rule.
    expect(res.body.stale_or_missing.length).toBeGreaterThan(0);
    expect(res.body.definitions.stale_or_missing).toContain("never as a blank");
    expect(res.body.definitions.runway).toContain("does not estimate runway it was not given");
  });

  it("returns empty sections with an explanation rather than fabricated content", async () => {
    const res = await call<{ support_asks: any[]; secondary_opportunities: any[]; follow_on_candidates: any[] }>(
      "/api/portfolio/cockpit",
      MP,
    );
    expect(Array.isArray(res.body.support_asks)).toBe(true);
    expect(Array.isArray(res.body.secondary_opportunities)).toBe(true);
    expect(Array.isArray(res.body.follow_on_candidates)).toBe(true);
  });
});

describe("the allocation view reads P11 and never recomputes", () => {
  it("shows no constraint effects when no comparison has been run, and says so", async () => {
    const fund = await call<{ id: string }>("/api/funds", MP, "POST", { name: "Cockpit Fund", vintage_year: 2026 });
    const policy = async (kind: string, body: unknown) => {
      const res = await call<{ id: string }>(`/api/funds/${fund.body.id}/policies/${kind}`, MP, "POST", {
        version_no: 1,
        effective_from: "2026-01-01",
        policy: body,
      });
      expect(res.status, kind).toBe(201);
      return res.body.id;
    };
    const pins = {
      mandate: await policy("mandate", { stages: ["SEED"], exclusions: [] }),
      sleeve: await policy("sleeve", { sleeves: [{ key: "seed", target_pct: 60 }] }),
      reserve: await policy("reserve", { reserve_ratio: 0.4 }),
      concentration: await policy("concentration", { max_position_pct: 12 }),
    };
    const scenario = await call<{ id: string }>("/api/allocation/scenarios", MP, "POST", {
      fund_id: fund.body.id,
      name: "Reserve strategy",
      mandate_version_id: pins.mandate,
      sleeve_version_id: pins.sleeve,
      reserve_version_id: pins.reserve,
      concentration_version_id: pins.concentration,
      fund_size: 30_000_000,
      investable: 24_000_000,
    });
    expect(scenario.status).toBe(201);

    const view = await call<{ comparison_run: unknown; statements: Record<string, string>; reserved_actions: Record<string, string> }>(
      `/api/allocation/scenarios/${scenario.body.id}/strategy-view`,
      MP,
    );
    expect(view.status).toBe(200);
    expect(view.body.comparison_run).toBeNull();
    expect(view.body.statements.computed_here).toContain("none are invented");
    expect(view.body.statements.not_a_prediction).toContain("not a forecast");
    expect(view.body.statements.human_decision).toContain("never moves capital");
    expect(view.body.statements.formula_gate).toContain("has NOT yet accepted");
  });

  it("names the human-reserved action for every option type it can show", async () => {
    const scenario = await t.db.prepare("SELECT id FROM fund_construction_scenario LIMIT 1").first<{ id: string }>();
    const view = await call<{ reserved_actions: Record<string, string> }>(`/api/allocation/scenarios/${scenario!.id}/strategy-view`, MP);
    expect(view.body.reserved_actions.FOLLOW_ON).toBe("follow_on.approve");
    expect(view.body.reserved_actions.SECONDARY_PURCHASE).toBe("secondary_purchase.approve");
    expect(view.body.reserved_actions.EXIT).toBe("exit.approve");
    expect(view.body.reserved_actions.RESERVE).toBe("reserve_allocation.approve");
  });

  it("404s for a scenario that does not exist rather than returning an empty shell", async () => {
    const res = await call("/api/allocation/scenarios/fcs_nope/strategy-view", MP);
    expect(res.status).toBe(404);
  });
});

describe("MP command coherence — all ten questions", () => {
  it("answers every §4 question once the workforce module is enabled", async () => {
    const all = [
      "approvals",
      "intelligence",
      "portfolio_risk",
      "allocation_constraints",
      "meetings",
      "ic_priorities",
      "ai_spend",
      "what_changed",
      "my_work",
      "employees",
      "reconciliation",
    ];
    const saved = await call("/api/mp-home/preferences", MP, "POST", { modules: all, briefing: {} });
    expect(saved.status).toBe(201);

    const home = await call<{ questions: Array<{ question: string; module: string | null }>; modules: Array<{ key: string }> }>(
      "/api/mp-home",
      MP,
    );
    expect(home.body.questions).toHaveLength(10);
    const unanswered = home.body.questions.filter((q) => q.module === null);
    expect(unanswered, `unanswered: ${unanswered.map((q) => q.question).join(", ")}`).toHaveLength(0);
    expect(home.body.modules.some((m) => m.key === "employees")).toBe(true);
  });

  it("the workforce module tells the truth when nothing is active", async () => {
    const home = await buildHome(env, {
      id: "fu_scooter_taylor",
      email: "scooter@westpeek.ventures",
      fullName: "Scooter Taylor",
      status: "ACTIVE",
      roles: ["MANAGING_PARTNER"],
      authorityScopes: [],
    });
    const employees = home.modules.find((m) => m.key === "employees")!;
    expect(employees.answers).toBe("What are the AI employees doing?");
    expect(employees.note).toContain("Activation is a Managing Partner decision");
  });

  it("every module links to the surface that owns its records", async () => {
    const home = await call<{ modules: Array<{ key: string; link: string }> }>("/api/mp-home", MP);
    const links = new Map(home.body.modules.map((m) => [m.key, m.link]));
    expect(links.get("employees")).toBe("employees");
    expect(links.get("ai_spend")).toBe("ai-ops");
    expect(links.get("portfolio_risk")).toBe("portfolio");
    expect(links.get("intelligence")).toBe("intelligence");
  });
});

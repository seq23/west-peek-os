import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { createOption, decideOption, OPTION_DECISION_ACTIONS } from "../src/worker/services/allocation";
import {
  ALLOCATION_MODEL_VERSION,
  concentrationAfter,
  evaluateOption,
  reserveEffect,
  signedCapitalEffect,
  sleeveCapacity,
} from "../src/shared/allocation";
import { runAi } from "../src/worker/ai/runAi";

/**
 * P11 — fund construction, cross-sleeve allocation, reserves, and follow-on.
 *
 * Rules under test (plan §8/P11 + §12.2): every scenario pins the mandate, sleeve,
 * reserve, and concentration policy VERSIONS plus the model version, and those pins
 * survive later policy changes; capacity, concentration, and reserve effects are
 * deterministic and visible; constraint violations are recorded and immutable;
 * assumptions are append-only; an AI may propose an option but can NEVER decide one;
 * each option type needs a receipt for its OWN reserved action; and approving an
 * option moves no capital.
 *
 * Every arithmetic fixture below corresponds to a hand-worked example in
 * docs/ALLOCATION_VERIFICATION.md. Nothing here claims valuation correctness,
 * investment soundness, or fund-performance correctness (§12.4); live allocation use
 * remains gated on the operator accepting that verification.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const MEMBER = { "x-wpos-dev-user": "member@westpeek.ventures" };

const MP_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const MEMBER_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_alloc_member", roles: ["INVESTMENT_TEAM"], firmScopes: ["west-peek"] };
const AI_ACTOR: Actor = { type: "AI", aiEmployeeId: "aie_paige", roles: [], firmScopes: ["west-peek"] };

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

/** The fund state every hand-worked example in ALLOCATION_VERIFICATION.md uses. */
const FUND_SIZE = 30_000_000;
const INVESTABLE = 24_000_000;

let fundId: string;
let pins: { mandate: string; sleeve: string; reserve: string; concentration: string };
let companyId: string;

async function policyVersion(kind: string, versionNo: number, policy: unknown): Promise<string> {
  const res = await call<{ id: string }>(`/api/funds/${fundId}/policies/${kind}`, MP, "POST", {
    version_no: versionNo,
    effective_from: "2026-01-01",
    policy,
  });
  expect(res.status, `${kind} v${versionNo}`).toBe(201);
  return res.body.id;
}

async function newScenario(overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await call<{ id: string }>("/api/allocation/scenarios", MP, "POST", {
    fund_id: fundId,
    name: `scenario ${crypto.randomUUID().slice(0, 8)}`,
    mandate_version_id: pins.mandate,
    sleeve_version_id: pins.sleeve,
    reserve_version_id: pins.reserve,
    concentration_version_id: pins.concentration,
    fund_size: FUND_SIZE,
    investable: INVESTABLE,
    ...overrides,
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function approvedCard(actionKey: string, objectId: string, headers = MP): Promise<string> {
  const created = await call<{ id: string }>("/api/approvals", headers, "POST", {
    action_key: actionKey,
    object_type: "capital_allocation_option",
    object_id: objectId,
    title: `p11: ${actionKey}`,
    submit: true,
  });
  expect(created.status).toBe(201);
  const decided = await call(`/api/approvals/${created.body.id}/decide`, headers, "POST", { decision: "approved" });
  expect(decided.status).toBe(200);
  return created.body.id;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_DOCUMENTS: t.docs });
  await t.db.prepare("INSERT INTO firm_user (id, email, full_name, status) VALUES ('fu_alloc_member', 'member@westpeek.ventures', 'Alloc Member', 'ACTIVE')").run();
  await t.db.prepare("INSERT INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_alloc_member', 'role_investment_team')").run();

  const fund = await call<{ id: string }>("/api/funds", MP, "POST", { name: `Fund ${crypto.randomUUID().slice(0, 8)}` });
  expect(fund.status).toBe(201);
  fundId = fund.body.id;
  pins = {
    mandate: await policyVersion("mandate", 1, { stages: ["seed", "series_a"], excluded_sectors: ["tobacco"] }),
    sleeve: await policyVersion("sleeve", 1, { sleeves: [{ key: "early", target_pct: 60 }, { key: "secondaries", target_pct: 40 }] }),
    reserve: await policyVersion("reserve", 1, { reserve_pct: 40 }),
    concentration: await policyVersion("concentration", 1, { max_single_company_pct: 10 }),
  };
  const company = await call<{ id: string }>("/api/companies", MP, "POST", { canonical_name: `Alloc Co ${crypto.randomUUID().slice(0, 8)}` });
  companyId = company.body.id;
});

afterAll(async () => {
  await disposeTestDb(t);
});

// ── 0. Unauthenticated requests are denied ──

describe("0. unauthenticated requests are denied (401) across the P11 surface", () => {
  it("returns 401 on every P11 route", async () => {
    const routes: Array<[string, string, unknown?]> = [
      ["POST", "/api/allocation/scenarios", {}],
      ["GET", "/api/allocation/scenarios"],
      ["GET", "/api/allocation/scenarios/fcs_x"],
      ["POST", "/api/allocation/scenarios/fcs_x/assumptions", {}],
      ["POST", "/api/allocation/scenarios/fcs_x/options", {}],
      ["POST", "/api/allocation/scenarios/fcs_x/compare", {}],
      ["GET", "/api/allocation/runs/csr_x"],
      ["POST", "/api/allocation/options/cao_x/request-approval", {}],
      ["POST", "/api/allocation/options/cao_x/decide", {}],
      ["GET", "/api/allocation/reserve-allocations"],
      ["POST", "/api/allocation/scenarios/fcs_x/follow-on-reviews", {}],
      ["POST", "/api/allocation/follow-on-reviews/for_x/review", {}],
    ];
    for (const [method, path, body] of routes) {
      const res = await handleRequest(req(path, {}, method, body), env);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

// ── 1. The pure formulas, against the hand-worked examples ──

describe("1. allocation arithmetic matches the hand-worked verification", () => {
  it("signedCapitalEffect: deployments are positive, realisations negative", () => {
    expect(signedCapitalEffect("INITIAL", 2_000_000)).toBe(2_000_000);
    expect(signedCapitalEffect("FOLLOW_ON", 900_000)).toBe(900_000);
    expect(signedCapitalEffect("RESERVE", 1_000_000)).toBe(1_000_000);
    expect(signedCapitalEffect("SECONDARY_PURCHASE", 500_000)).toBe(500_000);
    expect(signedCapitalEffect("EXIT", 750_000)).toBe(-750_000);
    expect(signedCapitalEffect("SECONDARY_SALE", 250_000)).toBe(-250_000);
  });

  it("sleeveCapacity: budget, remaining, and the SIZE of a breach", () => {
    const early = { key: "early", targetPct: 60, deployed: 10_000_000 };
    const fits = sleeveCapacity(INVESTABLE, early, "INITIAL", 2_000_000);
    expect(fits.sleeveBudget).toBe(14_400_000);
    expect(fits.remainingBefore).toBe(4_400_000);
    expect(fits.remainingAfter).toBe(2_400_000);
    expect(fits.overBy).toBe(0);
    expect(fits.fits).toBe(true);

    const breach = sleeveCapacity(INVESTABLE, early, "INITIAL", 5_000_000);
    expect(breach.remainingAfter).toBe(-600_000);
    expect(breach.overBy).toBe(600_000);
    expect(breach.fits).toBe(false);

    // A realisation FREES capacity.
    expect(sleeveCapacity(INVESTABLE, early, "EXIT", 3_000_000).remainingAfter).toBe(7_400_000);
  });

  it("sleeveCapacity: an over-deployed sleeve offers zero, but the breach is not clamped", () => {
    const over = { key: "early", targetPct: 60, deployed: 15_000_000 };
    const result = sleeveCapacity(INVESTABLE, over, "INITIAL", 100_000);
    expect(result.remainingBefore).toBe(0);
    expect(result.remainingAfter).toBe(-700_000);
    expect(result.overBy).toBe(700_000);
  });

  it("sleeveCapacity: exactly at the budget is not a breach", () => {
    const zero = sleeveCapacity(INVESTABLE, { key: "none", targetPct: 0, deployed: 500_000 }, "EXIT", 500_000);
    expect(zero.sleeveBudget).toBe(0);
    expect(zero.remainingAfter).toBe(0);
    expect(zero.fits).toBe(true);
  });

  it("concentrationAfter: cost-based, limit-aware, and floored at zero", () => {
    const ok = concentrationAfter(FUND_SIZE, 1_500_000, "FOLLOW_ON", 900_000, 10);
    expect(ok.pctBefore).toBe(5);
    expect(ok.pctAfter).toBe(8);
    expect(ok.deltaPct).toBe(3);
    expect(ok.withinLimit).toBe(true);

    const over = concentrationAfter(FUND_SIZE, 1_500_000, "FOLLOW_ON", 2_100_000, 10);
    expect(over.pctAfter).toBe(12);
    expect(over.overByPct).toBe(2);
    expect(over.withinLimit).toBe(false);

    // Exactly at the limit passes (≤, not <).
    expect(concentrationAfter(FUND_SIZE, 1_500_000, "FOLLOW_ON", 1_500_000, 10).withinLimit).toBe(true);

    const exited = concentrationAfter(FUND_SIZE, 1_500_000, "EXIT", 1_000_000, 10);
    expect(exited.costAfter).toBe(500_000);
    expect(exited.pctAfter).toBeCloseTo(1.6667, 4);
    expect(exited.deltaPct).toBeCloseTo(-3.3333, 4);

    // Over-exiting floors cost at zero rather than going negative.
    expect(concentrationAfter(FUND_SIZE, 1_500_000, "EXIT", 2_000_000, 10).costAfter).toBe(0);
  });

  it("concentrationAfter: an unstated limit is NO limit, and a zero fund size never divides", () => {
    const unlimited = concentrationAfter(FUND_SIZE, 12_000_000, "INITIAL", 0, null);
    expect(unlimited.pctAfter).toBe(40);
    expect(unlimited.withinLimit).toBe(true);
    expect(unlimited.overByPct).toBe(0);

    const noFund = concentrationAfter(0, 1_000_000, "INITIAL", 500_000, 10);
    expect(noFund.pctBefore).toBe(0);
    expect(noFund.pctAfter).toBe(0);
  });

  it("reserveEffect: coverage is measured against REMAINING need", () => {
    const idle = reserveEffect(INVESTABLE, 40, 0, 8_000_000, 0);
    expect(idle.reservePool).toBe(9_600_000);
    expect(idle.uncommittedAfter).toBe(9_600_000);
    expect(idle.coveragePctAfter).toBe(120);
    expect(idle.sufficient).toBe(true);

    // Committing reserve retires part of the need it was meant to cover, so coverage
    // RISES — the portfolio did not get riskier by reserving for it.
    const committed = reserveEffect(INVESTABLE, 40, 0, 8_000_000, 2_000_000);
    expect(committed.committedAfter).toBe(2_000_000);
    expect(committed.uncommittedAfter).toBe(7_600_000);
    expect(committed.coveragePctAfter).toBeCloseTo(126.6667, 4);
  });

  it("reserveEffect: overdraft, no-need, and an empty pool are each distinct", () => {
    const overdrawn = reserveEffect(INVESTABLE, 40, 0, 8_000_000, 10_000_000);
    expect(overdrawn.uncommittedAfter).toBe(-400_000);
    expect(overdrawn.sufficient).toBe(false);
    expect(overdrawn.coveragePctAfter).toBe(0);

    expect(reserveEffect(INVESTABLE, 40, 0, 0, 0).coveragePctAfter).toBe(100);

    // An empty reserve is a coverage problem (0%), not an overdraft.
    const empty = reserveEffect(INVESTABLE, 0, 0, 5_000_000, 0);
    expect(empty.reservePool).toBe(0);
    expect(empty.coveragePctAfter).toBe(0);
    expect(empty.sufficient).toBe(true);
  });

  it("evaluateOption: one option can breach four policies at once, and each is named", () => {
    const policy = {
      fundSize: FUND_SIZE,
      investable: INVESTABLE,
      concentrationLimitPct: 10,
      reservePct: 40,
      reserveCommitted: 9_000_000,
      reserveModeledNeed: 8_000_000,
      fundDeployed: 23_000_000,
    };
    const evaluation = evaluateOption(policy, {
      optionType: "INITIAL",
      capital: 2_000_000,
      reserveDraw: 1_000_000,
      sleeve: { key: "early", targetPct: 60, deployed: 14_000_000 },
      existingCompanyCost: 2_500_000,
    });
    expect(evaluation.capacity.remainingAfter).toBe(-1_600_000);
    expect(evaluation.concentration.pctAfter).toBe(15);
    expect(evaluation.reserve.uncommittedAfter).toBe(-400_000);
    expect(evaluation.undeployedAfter).toBe(-1_000_000);
    expect(evaluation.violations.map((v) => v.kind).sort()).toEqual([
      "CONCENTRATION_LIMIT",
      "RESERVE_SHORTFALL",
      "SLEEVE_CAPACITY",
      "UNDEPLOYED_CAPITAL",
    ]);
    expect(evaluation.violations.every((v) => v.severity === "BREACH")).toBe(true);
  });

  it("evaluateOption: a clean option raises nothing, and a mandate exclusion always does", () => {
    const policy = {
      fundSize: FUND_SIZE,
      investable: INVESTABLE,
      concentrationLimitPct: 10,
      reservePct: 40,
      reserveCommitted: 9_000_000,
      reserveModeledNeed: 8_000_000,
      fundDeployed: 23_000_000,
    };
    const clean = evaluateOption(policy, {
      optionType: "INITIAL",
      capital: 300_000,
      sleeve: { key: "early", targetPct: 60, deployed: 10_000_000 },
      existingCompanyCost: 0,
    });
    expect(clean.violations).toHaveLength(0);

    const excluded = evaluateOption(policy, {
      optionType: "INITIAL",
      capital: 300_000,
      sleeve: { key: "early", targetPct: 60, deployed: 10_000_000 },
      existingCompanyCost: 0,
      mandateExclusions: ["excluded_sector:tobacco"],
    });
    expect(excluded.violations.map((v) => v.kind)).toEqual(["MANDATE_EXCLUSION"]);
  });
});

// ── 2. Scenarios pin policy versions ──

describe("2. a scenario pins policy versions and the model version", () => {
  it("records all four pins plus the model version", async () => {
    const id = await newScenario();
    const scenario = await call<{
      mandate_version_id: string;
      sleeve_version_id: string;
      reserve_version_id: string;
      concentration_version_id: string;
      model_version: string;
      outcome_label: string;
    }>(`/api/allocation/scenarios/${id}`, MP);
    expect(scenario.body.mandate_version_id).toBe(pins.mandate);
    expect(scenario.body.sleeve_version_id).toBe(pins.sleeve);
    expect(scenario.body.reserve_version_id).toBe(pins.reserve);
    expect(scenario.body.concentration_version_id).toBe(pins.concentration);
    expect(scenario.body.model_version).toBe(ALLOCATION_MODEL_VERSION);
    expect(scenario.body.outcome_label).toContain("NOT AN EXPECTED RETURN");
  });

  it("refuses a pin that belongs to another fund", async () => {
    const other = await call<{ id: string }>("/api/funds", MP, "POST", { name: `Other Fund ${crypto.randomUUID().slice(0, 8)}` });
    const otherConcentration = await call<{ id: string }>(`/api/funds/${other.body.id}/policies/concentration`, MP, "POST", {
      version_no: 1,
      effective_from: "2026-01-01",
      policy: { max_single_company_pct: 25 },
    });
    const res = await call<{ error: string }>("/api/allocation/scenarios", MP, "POST", {
      fund_id: fundId,
      name: "cross-fund pin",
      mandate_version_id: pins.mandate,
      sleeve_version_id: pins.sleeve,
      reserve_version_id: pins.reserve,
      concentration_version_id: otherConcentration.body.id,
      fund_size: FUND_SIZE,
      investable: INVESTABLE,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("policy_version_fund_mismatch");
  });

  it("a LATER policy version never changes what a recorded run was computed against", async () => {
    const scenarioId = await newScenario({ fund_deployed: 10_000_000 });
    await call(`/api/allocation/scenarios/${scenarioId}/options`, MP, "POST", {
      option_type: "FOLLOW_ON",
      label: "follow-on at the old limit",
      sleeve_key: "early",
      sleeve_target_pct: 60,
      sleeve_deployed: 10_000_000,
      capital: 2_100_000,
      existing_company_cost: 1_500_000,
      company_id: companyId,
    });
    const run = await call<{ run: { id: string; concentration_version_id: string }; results: Array<{ concentration_within_limit: boolean }> }>(
      `/api/allocation/scenarios/${scenarioId}/compare`,
      MP,
      "POST",
      {},
    );
    expect(run.status).toBe(201);
    // 12% against the pinned 10% limit → a breach, recorded.
    expect(run.body.results[0]!.concentration_within_limit).toBe(false);
    expect(run.body.run.concentration_version_id).toBe(pins.concentration);

    // The firm loosens the limit. Policy change = a NEW version (0002 triggers make
    // rewriting v1 impossible), and the stored run keeps pointing at v1.
    const v2 = await policyVersion("concentration", 2, { max_single_company_pct: 20 });
    expect(v2).not.toBe(pins.concentration);
    const stored = await call<{ concentration_version_id: string; violations: Array<{ kind: string; limit_value: number }> }>(
      `/api/allocation/runs/${run.body.run.id}`,
      MP,
    );
    expect(stored.body.concentration_version_id).toBe(pins.concentration);
    expect(stored.body.violations.find((v) => v.kind === "CONCENTRATION_LIMIT")!.limit_value).toBe(10);

    // v1 itself is still immutable at the database layer.
    await expect(
      t.db.prepare("UPDATE concentration_policy_version SET concentration_json = '{}' WHERE id = ?1").bind(pins.concentration).run(),
    ).rejects.toThrow(/immutable/);
  });

  it("assumptions are visible on the scenario and append-only", async () => {
    const scenarioId = await newScenario();
    const created = await call<{ id: string }>(`/api/allocation/scenarios/${scenarioId}/assumptions`, MP, "POST", {
      assumption_key: "graduation_rate",
      assumption_value: "35%",
      basis: "operator-stated planning figure, not an observed rate",
    });
    expect(created.status).toBe(201);
    const scenario = await call<{ assumptions: Array<{ assumption_key: string; basis: string }> }>(`/api/allocation/scenarios/${scenarioId}`, MP);
    expect(scenario.body.assumptions).toHaveLength(1);
    expect(scenario.body.assumptions[0]!.basis).toContain("not an observed rate");

    await expect(t.db.prepare("UPDATE scenario_assumption SET assumption_value = '90%' WHERE id = ?1").bind(created.body.id).run()).rejects.toThrow(/append-only/);
    await expect(t.db.prepare("DELETE FROM scenario_assumption WHERE id = ?1").bind(created.body.id).run()).rejects.toThrow(/append-only/);
  });
});

// ── 3. Comparison runs ──

describe("3. a comparison run is a stored, immutable snapshot", () => {
  it("compares initial, follow-on, reserve, secondary, and exit options in ONE framework", async () => {
    const scenarioId = await newScenario({ fund_deployed: 12_000_000, reserve_committed: 1_000_000, reserve_modeled_need: 8_000_000 });
    const types = ["INITIAL", "FOLLOW_ON", "RESERVE", "SECONDARY_PURCHASE", "SECONDARY_SALE", "EXIT"] as const;
    for (const option_type of types) {
      const res = await call(`/api/allocation/scenarios/${scenarioId}/options`, MP, "POST", {
        option_type,
        label: `${option_type} option`,
        sleeve_key: option_type.startsWith("SECONDARY") ? "secondaries" : "early",
        sleeve_target_pct: option_type.startsWith("SECONDARY") ? 40 : 60,
        sleeve_deployed: 1_000_000,
        capital: 500_000,
        existing_company_cost: 500_000,
        company_id: companyId,
      });
      expect(res.status, option_type).toBe(201);
    }
    const run = await call<{ run: { option_count: number; outcome_label: string }; results: Array<{ option_id: string }> }>(
      `/api/allocation/scenarios/${scenarioId}/compare`,
      MP,
      "POST",
      {},
    );
    expect(run.body.run.option_count).toBe(6);
    expect(run.body.results).toHaveLength(6);
    expect(run.body.run.outcome_label).toContain("NOT AN EXPECTED RETURN");
    // The run reports; it does not rank. There is no score, rank, or recommendation.
    for (const result of run.body.results) {
      expect(Object.keys(result)).not.toContain("rank");
      expect(Object.keys(result)).not.toContain("recommendation");
    }
  });

  it("accumulates reserve draws WITHIN a run, so a joint overdraw surfaces", async () => {
    const scenarioId = await newScenario({ reserve_modeled_need: 8_000_000 });
    for (const [label, draw] of [
      ["first reserve", 6_000_000],
      ["second reserve", 5_000_000],
    ] as const) {
      await call(`/api/allocation/scenarios/${scenarioId}/options`, MP, "POST", {
        option_type: "RESERVE",
        label,
        sleeve_key: "early",
        sleeve_target_pct: 60,
        capital: draw,
        reserve_draw: draw,
        company_id: companyId,
      });
    }
    const run = await call<{ results: Array<{ reserve_uncommitted_after: number; reserve_sufficient: boolean }>; violations: Array<{ kind: string }> }>(
      `/api/allocation/scenarios/${scenarioId}/compare`,
      MP,
      "POST",
      {},
    );
    // Pool 9,600,000: the first draw fits (3,600,000 left), the second overdraws.
    expect(run.body.results[0]!.reserve_uncommitted_after).toBe(3_600_000);
    expect(run.body.results[0]!.reserve_sufficient).toBe(true);
    expect(run.body.results[1]!.reserve_uncommitted_after).toBe(-1_400_000);
    expect(run.body.results[1]!.reserve_sufficient).toBe(false);
    expect(run.body.violations.filter((v) => v.kind === "RESERVE_SHORTFALL")).toHaveLength(1);
  });

  it("refuses to run with no options, and stored runs/violations cannot be edited away", async () => {
    const empty = await call<{ error: string }>(`/api/allocation/scenarios/${await newScenario()}/compare`, MP, "POST", {});
    expect(empty.status).toBe(409);
    expect(empty.body.error).toBe("no_options");

    const scenarioId = await newScenario({ fund_deployed: 10_000_000 });
    await call(`/api/allocation/scenarios/${scenarioId}/options`, MP, "POST", {
      option_type: "INITIAL",
      label: "breaching option",
      sleeve_key: "early",
      sleeve_target_pct: 60,
      sleeve_deployed: 14_000_000,
      capital: 5_000_000,
      existing_company_cost: 2_500_000,
      company_id: companyId,
    });
    const run = await call<{ run: { id: string; breach_count: number }; violations: Array<{ id: string }> }>(
      `/api/allocation/scenarios/${scenarioId}/compare`,
      MP,
      "POST",
      {},
    );
    expect(run.body.run.breach_count).toBeGreaterThan(0);
    const violationId = run.body.violations[0]!.id;
    await expect(t.db.prepare("UPDATE constraint_violation SET severity = 'WARNING' WHERE id = ?1").bind(violationId).run()).rejects.toThrow(/immutable/);
    await expect(t.db.prepare("DELETE FROM constraint_violation WHERE id = ?1").bind(violationId).run()).rejects.toThrow(/immutable/);
    await expect(t.db.prepare("UPDATE cross_sleeve_comparison_run SET breach_count = 0 WHERE id = ?1").bind(run.body.run.id).run()).rejects.toThrow(/immutable/);
  });
});

// ── 4. Decisions are human-reserved, per action, and move no capital ──

describe("4. humans decide; AI proposes; nothing moves capital", () => {
  async function optionOfType(type: string, extra: Record<string, unknown> = {}): Promise<string> {
    const scenarioId = await newScenario();
    const res = await call<{ id: string }>(`/api/allocation/scenarios/${scenarioId}/options`, MP, "POST", {
      option_type: type,
      label: `${type} for decision`,
      sleeve_key: "early",
      sleeve_target_pct: 60,
      capital: 500_000,
      company_id: companyId,
      ...extra,
    });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  it("each option type routes to its OWN reserved action", () => {
    expect(OPTION_DECISION_ACTIONS.RESERVE).toBe("reserve_allocation.approve");
    expect(OPTION_DECISION_ACTIONS.FOLLOW_ON).toBe("follow_on.approve");
    expect(OPTION_DECISION_ACTIONS.INITIAL).toBe("capital_allocation_cross_sleeve.approve");
    expect(OPTION_DECISION_ACTIONS.SECONDARY_PURCHASE).toBe("capital_allocation_cross_sleeve.approve");
    expect(OPTION_DECISION_ACTIONS.EXIT).toBe("capital_allocation_cross_sleeve.approve");
  });

  it("refuses a decision with no receipt, and refuses another action's receipt", async () => {
    const optionId = await optionOfType("FOLLOW_ON");
    const noReceipt = await call<{ error: string }>(`/api/allocation/options/${optionId}/decide`, MP, "POST", { decision: "APPROVED" });
    expect(noReceipt.status).toBe(409);
    expect(noReceipt.body.error).toBe("approval_required");

    // A reserve receipt cannot approve a follow-on.
    const wrongAction = await approvedCard("reserve_allocation.approve", optionId);
    const mismatched = await call<{ error: string; detail: string }>(`/api/allocation/options/${optionId}/decide`, MP, "POST", {
      decision: "APPROVED",
      approval_receipt_id: wrongAction,
    });
    expect(mismatched.status).toBe(409);
    expect(mismatched.body.detail).toContain("receipt_action_mismatch");
  });

  it("refuses a receipt issued for a DIFFERENT option", async () => {
    const optionId = await optionOfType("FOLLOW_ON");
    const otherOptionId = await optionOfType("FOLLOW_ON");
    const receipt = await approvedCard("follow_on.approve", otherOptionId);
    const res = await call<{ detail: string }>(`/api/allocation/options/${optionId}/decide`, MP, "POST", {
      decision: "APPROVED",
      approval_receipt_id: receipt,
    });
    expect(res.status).toBe(409);
    expect(res.body.detail).toContain("receipt_object_mismatch");
  });

  it("approves once with the right receipt, consumes it, and refuses the replay", async () => {
    const optionId = await optionOfType("FOLLOW_ON");
    const receipt = await approvedCard("follow_on.approve", optionId);
    const decided = await call<{ option: { decision: string; decided_by: string; approval_card_id: string } }>(
      `/api/allocation/options/${optionId}/decide`,
      MP,
      "POST",
      { decision: "APPROVED", approval_receipt_id: receipt, note: "sized to the pro-rata" },
    );
    expect(decided.status).toBe(200);
    expect(decided.body.option.decision).toBe("APPROVED");
    expect(decided.body.option.decided_by).toBe("fu_scooter_taylor");
    expect(decided.body.option.approval_card_id).toBe(receipt);

    const replay = await call(`/api/allocation/options/${optionId}/decide`, MP, "POST", { decision: "APPROVED", approval_receipt_id: receipt });
    expect(replay.status).toBe(409);
  });

  it("a non-MP cannot obtain the authorization, and an AI can NEVER decide", async () => {
    const optionId = await optionOfType("FOLLOW_ON");
    const asMember = await call<{ error: string }>(`/api/allocation/options/${optionId}/decide`, MEMBER, "POST", { decision: "APPROVED" });
    expect(asMember.status).toBe(403);

    await expect(decideOption(env, AI_ACTOR, optionId, { decision: "APPROVED" })).rejects.toMatchObject({ status: 403 });
    // Even holding a valid MP receipt, an AI is refused before the receipt is read.
    const receipt = await approvedCard("follow_on.approve", optionId);
    await expect(decideOption(env, AI_ACTOR, optionId, { decision: "APPROVED", approval_receipt_id: receipt })).rejects.toMatchObject({ status: 403 });
  });

  it("an AI may PROPOSE an option, but only with its run trace", async () => {
    const scenarioId = await newScenario();
    await expect(
      createOption(env, AI_ACTOR, scenarioId, { option_type: "FOLLOW_ON", label: "ai idea", sleeve_key: "early", sleeve_target_pct: 60, capital: 100_000 }),
    ).rejects.toMatchObject({ status: 400 });

    const run = await runAi(env, { purpose: "allocation_option_draft", actor: AI_ACTOR, inputs: ["suggest a follow-on size"], sensitivity: "INTERNAL" });
    const option = await createOption(env, AI_ACTOR, scenarioId, {
      option_type: "FOLLOW_ON",
      label: "ai-proposed follow-on",
      sleeve_key: "early",
      sleeve_target_pct: 60,
      capital: 100_000,
      ai_run_id: run.run.id,
    });
    expect(option.proposed_by_type).toBe("AI");
    expect(option.decision).toBe("UNDECIDED");
  });

  it("an approved RESERVE writes the reserve allocation and still moves no capital", async () => {
    const optionId = await optionOfType("RESERVE", { reserve_draw: 400_000 });
    const receipt = await approvedCard("reserve_allocation.approve", optionId);
    const decided = await call<{ reserve_allocation_id: string }>(`/api/allocation/options/${optionId}/decide`, MP, "POST", {
      decision: "APPROVED",
      approval_receipt_id: receipt,
    });
    expect(decided.body.reserve_allocation_id).toMatch(/^rsa_/);
    const allocations = await call<{ reserve_allocations: Array<{ id: string; amount: number; status: string; approval_card_id: string }> }>(
      "/api/allocation/reserve-allocations",
      MP,
    );
    const row = allocations.body.reserve_allocations.find((r) => r.id === decided.body.reserve_allocation_id)!;
    expect(row.amount).toBe(400_000);
    expect(row.status).toBe("COMMITTED");
    expect(row.approval_card_id).toBe(receipt);

    // A reservation is a recorded intent, not a transfer: no external effect exists.
    const effects = await t.db.prepare("SELECT COUNT(*) AS n FROM external_effect_request").first<{ n: number }>();
    expect(effects!.n).toBe(0);
    const decision = await t.db
      .prepare("SELECT payload_json FROM event_record WHERE event_type = 'allocation.option_decided' AND object_id = ?1")
      .bind(optionId)
      .first<{ payload_json: string }>();
    expect(JSON.parse(decision!.payload_json).capital_moved).toBe(false);
  });

  it("a REJECTED option is recorded and stays rejected", async () => {
    const optionId = await optionOfType("INITIAL");
    const receipt = await approvedCard("capital_allocation_cross_sleeve.approve", optionId);
    const rejected = await call<{ option: { decision: string } }>(`/api/allocation/options/${optionId}/decide`, MP, "POST", {
      decision: "REJECTED",
      approval_receipt_id: receipt,
      note: "concentration is already too high",
    });
    expect(rejected.body.option.decision).toBe("REJECTED");
    const again = await call(`/api/allocation/options/${optionId}/decide`, MP, "POST", { decision: "APPROVED" });
    expect(again.status).toBe(409);
  });
});

// ── 5. Follow-on review, privacy, and the spine ──

describe("5. follow-on review, privacy, and the event spine", () => {
  it("a follow-on review stores the hand-verified path math, and only a human closes it", async () => {
    const scenarioId = await newScenario();
    const created = await call<{ id: string; path: { proRataRequired: number; scenarios: Array<{ key: string }> } }>(
      `/api/allocation/scenarios/${scenarioId}/follow-on-reviews`,
      MP,
      "POST",
      {
        company_id: companyId,
        path: {
          currentOwnershipPct: 10,
          currentFullyDilutedShares: 10_000_000,
          roundSize: 20_000_000,
          primaryPps: 10,
          secondaryPps: 9,
          secondaryCapital: 1_000_000,
          secondaryFeesPct: 2,
          targetOwnershipPct: 12,
          maxAllocation: 0,
          extraDilutionPct: 0,
          futureDilutionPct: 20,
          exitValue: 500_000_000,
          holdYears: 5,
          existingCost: 1_000_000,
          fundSize: FUND_SIZE,
        },
      },
    );
    expect(created.status).toBe(201);
    // 2,000,000 new shares; pro-rata = 10% × 2,000,000 × $10 = 2,000,000.
    expect(created.body.path.proRataRequired).toBe(2_000_000);
    expect(created.body.path.scenarios.map((s) => s.key)).toEqual(["skip", "pro_rata", "super_pro_rata", "secondary"]);

    const reviewed = await call<{ status: string; reviewed_by: string }>(`/api/allocation/follow-on-reviews/${created.body.id}/review`, MP, "POST", {
      review_note: "pro-rata only; super pro-rata breaches concentration",
    });
    expect(reviewed.body.status).toBe("REVIEWED");
    expect(reviewed.body.reviewed_by).toBe("fu_scooter_taylor");
    const again = await call(`/api/allocation/follow-on-reviews/${created.body.id}/review`, MP, "POST", { review_note: "x" });
    expect(again.status).toBe(409);
  });

  it("ordinary scenarios are investment-team work; a sensitive one is scoped away", async () => {
    // CONFIDENTIAL is deliberately team-visible: the investment team PREPARES these.
    // Visibility is not the control — the decision is (see the receipt tests above).
    const ordinary = await newScenario();
    expect((await call(`/api/allocation/scenarios/${ordinary}`, MEMBER)).status).toBe(200);

    // A scenario carrying MNPI is a different matter, and the label gates it.
    const sensitive = await newScenario({ privacy_label: "MNPI_SENSITIVE" });
    expect((await call(`/api/allocation/scenarios/${sensitive}`, MEMBER)).status).toBe(404);
    expect((await call(`/api/allocation/scenarios/${sensitive}`, MP)).status).toBe(200);
    const listed = await call<{ scenarios: Array<{ id: string }> }>("/api/allocation/scenarios", MEMBER);
    expect(listed.body.scenarios.some((s) => s.id === sensitive)).toBe(false);

    // A member still cannot decide anything, visible or not.
    const optionRes = await call<{ id: string }>(`/api/allocation/scenarios/${ordinary}/options`, MP, "POST", {
      option_type: "INITIAL",
      label: "member cannot decide this",
      sleeve_key: "early",
      sleeve_target_pct: 60,
      capital: 100_000,
      company_id: companyId,
    });
    expect((await call(`/api/allocation/options/${optionRes.body.id}/decide`, MEMBER, "POST", { decision: "APPROVED" })).status).toBe(403);
  });

  it("authorize() denies an AI the allocation-reserved actions outright", async () => {
    const { authorize } = await import("../src/worker/services/authorize");
    for (const key of ["capital_allocation_cross_sleeve.approve", "reserve_allocation.approve", "follow_on.approve"]) {
      expect((await authorize(env, AI_ACTOR, key, { objectType: "capital_allocation_option", firmScope: "west-peek" })).decision, key).toBe("DENY");
      expect((await authorize(env, MEMBER_ACTOR, key, { objectType: "capital_allocation_option", firmScope: "west-peek" })).decision, key).toBe("DENY");
      expect((await authorize(env, MP_ACTOR, key, { objectType: "capital_allocation_option", firmScope: "west-peek" })).decision, key).toBe("REQUIRE_APPROVAL");
    }
  });

  it("the journey leaves typed allocation.* events on the ONE spine (D15)", async () => {
    const events = await t.db.prepare("SELECT DISTINCT event_type FROM event_record WHERE event_type LIKE 'allocation.%'").all<{ event_type: string }>();
    const types = new Set((events.results ?? []).map((e) => e.event_type));
    for (const expected of [
      "allocation.scenario_created",
      "allocation.option_proposed",
      "allocation.comparison_run",
      "allocation.option_decided",
      "allocation.follow_on_review_opened",
    ]) {
      expect(types, expected).toContain(expected);
    }
  });
});

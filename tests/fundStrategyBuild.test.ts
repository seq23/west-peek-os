import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { paceGeometry, paceSeries, usdWords } from "../src/shared/fund/pace";
import { policySentences } from "../src/client/pages/FundConstruction";
import { figuresText } from "../src/client/pages/DashboardDoor";
import { handleRequest } from "../src/worker/index";

/**
 * FUND STRATEGY, BUILT (design/FUND_STRATEGY_DESIGN.md, approved 19 Sep 2026).
 *
 * The pace arithmetic in every state; the sentences the policy reads as; the six figures the door
 * copies; first close typed and set by the first signed commitment; the basis that no longer
 * contradicts the ring; and the split — the page reads no company list and draws no deployed slice.
 */

let t: TestDb;
let env: Env;
const MP = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };

async function call<T>(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: T }> {
  const res = await handleRequest(
    new Request(`https://os.test${path}`, { method, headers: { ...MP, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
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

describe("the pace against the plan — pure", () => {
  const plan = 10_080_000;
  it("with no first close the clock has not started: no plan line, the sentence says so, nothing is guessed", () => {
    const s = paceSeries({ firstCloseOn: null, investmentPeriodYears: 4, planInitialUsd: plan, timeline: [{ on: "2026-09-01", usd: 10_000 }], today: "2026-09-19" });
    expect(s.state).toBe("no_clock");
    expect(s.planByToday).toBeNull();
    expect(s.deployedToday).toBe(10_000);
    expect(s.verdict).toMatch(/clock starts at first close, which is not on the fund's record yet/);
    const g = paceGeometry(s, plan, 4);
    expect(g.today, "no today marker without a clock").toBeNull();
    expect(g.planToday).toBeNull();
    expect(g.ticks[0]!.label).toBe("first close");
  });

  it("with the clock running the plan by today is pro-rata and the verdict is in words, not colour", () => {
    const s = paceSeries({ firstCloseOn: "2026-01-19", investmentPeriodYears: 4, planInitialUsd: plan, timeline: [{ on: "2026-09-01", usd: 10_000 }], today: "2027-01-19" });
    expect(s.state).toBe("running");
    expect(s.yearsIn).toBeCloseTo(1, 1);
    expect(s.planByToday).toBeCloseTo(plan / 4, -4); // a year is 365.25 days on the clock; within $5K of the quarter
    expect(s.verdict).toMatch(/^Behind the plan by \$2\.51M: \$10K out against \$2\.52M planned by today\./);
    const g = paceGeometry(s, plan, 4);
    expect(g.today).not.toBeNull();
    expect(g.planToday).not.toBeNull();
    expect(g.today!.x).toBeCloseTo(g.planToday!.x, 5);
    expect(g.today!.y, "deployed sits below the plan marker on the drawing").toBeGreaterThan(g.planToday!.y);
  });

  it("ahead, on, and a clock later than today each say so; the period clamps; unsorted points are summed in order", () => {
    const ahead = paceSeries({ firstCloseOn: "2026-01-01", investmentPeriodYears: 4, planInitialUsd: 1_000_000, timeline: [{ on: "2026-03-01", usd: 400_000 }, { on: "2026-02-01", usd: 200_000 }], today: "2026-07-01" });
    expect(ahead.verdict).toMatch(/^Ahead of the plan by/);
    expect(ahead.actual.map((a) => a.usd)).toEqual([200_000, 600_000]);
    const on = paceSeries({ firstCloseOn: "2026-01-01", investmentPeriodYears: 4, planInitialUsd: 1_000_000, timeline: [{ on: "2027-01-01", usd: 250_000 }], today: "2027-01-01" });
    expect(on.verdict).toMatch(/^On the plan/);
    const future = paceSeries({ firstCloseOn: "2027-01-01", investmentPeriodYears: 4, planInitialUsd: 1_000_000, timeline: [], today: "2026-09-19" });
    expect(future.verdict).toMatch(/after today; the plan line has not started/);
    const late = paceSeries({ firstCloseOn: "2020-01-01", investmentPeriodYears: 4, planInitialUsd: 1_000_000, timeline: [], today: "2026-09-19" });
    expect(late.yearsIn).toBe(4);
    expect(late.planByToday).toBe(1_000_000);
  });

  it("no fund size is its own state and draws no chart line", () => {
    const s = paceSeries({ firstCloseOn: "2026-01-01", investmentPeriodYears: 4, planInitialUsd: 0, timeline: [], today: "2026-09-19" });
    expect(s.state).toBe("no_size");
    expect(usdWords(10_080_000)).toBe("$10.08M");
    expect(usdWords(10_000)).toBe("$10K");
    expect(usdWords(0)).toBe("$0");
  });
});

describe("the policy in one breath, and the six figures", () => {
  it("reads the stored policy as three sentences with nothing defaulted", () => {
    const s = policySentences(
      { target_size_usd: 30_000_000, target_positions: 20, check_size_usd: { min: 500_000, max: 750_000 }, sectors: ["AI", "FUTURE_OF_WORK", "HEALTH_TECH", "ED_TECH", "CONSUMER"] },
      { committed_usd: 30_000_000, estimated_fees_usd: 6_000_000, estimated_expenses_usd: 1_000_000, estimated_investable_usd: 23_000_000, sleeves: [{ key: "EARLY_STAGE_PRIMARY", target_pct: 70 }, { key: "SECONDARY_PURCHASE", target_pct: 30 }] },
      { reserve_pct: 40 },
    )!;
    expect(s.fund).toBe("A $30M fund, charging 2% a year over 10 years, with $1M of expenses — $23M investable.");
    expect(s.split).toBe("Split 70% early stage ($16.1M) / 30% secondaries ($6.9M), with 40% of the early-stage sleeve held in reserve ($6.44M).");
    expect(s.companies).toBe("20 companies at $500K–$750K each, in AI, Future of work, Healthcare, Education and Consumer.");
    expect(policySentences({}, {}, {}), "no mandate → no sentences, never a default").toBeNull();
  });

  it("the door copies exactly the six figures it shows, in order", () => {
    const text = figuresText({ target_size_usd: 30_000_000, management_fee_pct: 2, fund_life_years: 10, check_size_usd: { min: 500_000, max: 750_000 }, target_ownership_pct: 8, minimum_ownership_pct: 5, target_positions: 20 }, 40, 1);
    expect(text.split("\n")).toEqual([
      "West Peek Ventures — mandate v1",
      "Fund size: $30M",
      "Management fee: 2% a year over 10 years",
      "Initial cheque: $500K–$750K",
      "Target ownership: 8% (walk below 5%)",
      "Positions: 20",
      "Reserves: 40% of early stage",
    ]);
  });
});

describe("first close, and the basis that cannot contradict the ring", () => {
  let fundId: string;
  beforeAll(async () => {
    const fund = await call<{ id: string }>("/api/funds", "POST", { name: "Fund Strategy Test Fund", vintage_year: 2026 });
    expect(fund.status).toBe(201);
    fundId = fund.body.id;
  });

  it("with no recorded size the basis falls back to the current mandate's figure and says so (§1 #7, CONFIRMED in production)", async () => {
    await call(`/api/funds/${fundId}/policies/mandate`, "POST", { version_no: 9, effective_from: "2026-09-19", policy: { target_size_usd: 30_000_000, target_positions: 20 } });
    const basis = await call<{ fund_size: number | null; fund_size_source: string; ready: boolean; first_close_on: string | null }>(`/api/funds/${fundId}/basis`);
    expect(basis.status).toBe(200);
    expect(basis.body.fund_size).toBe(30_000_000);
    expect(basis.body.fund_size_source).toBe("DERIVED");
    expect(basis.body.ready).toBe(true);
    expect(basis.body.first_close_on).toBeNull();
  });

  it("a recorded size still wins over the mandate, and first close can be typed on the same route", async () => {
    const set = await call<{ ok: boolean; first_close_on: string | null }>(`/api/funds/${fundId}/size`, "PATCH", { target_size: 28_000_000, first_close_on: "2026-03-02" });
    expect(set.status).toBe(200);
    expect(set.body.first_close_on).toBe("2026-03-02");
    const basis = await call<{ fund_size: number; fund_size_source: string; first_close_on: string | null }>(`/api/funds/${fundId}/basis`);
    expect(basis.body.fund_size).toBe(28_000_000);
    expect(basis.body.fund_size_source).toBe("RECORDED");
    expect(basis.body.first_close_on).toBe("2026-03-02");
    // Absent keeps it; null clears it; a malformed date is refused.
    await call(`/api/funds/${fundId}/size`, "PATCH", { target_size: 28_000_000 });
    expect((await call<{ first_close_on: string | null }>(`/api/funds/${fundId}/basis`)).body.first_close_on).toBe("2026-03-02");
    expect((await call(`/api/funds/${fundId}/size`, "PATCH", { target_size: 28_000_000, first_close_on: "March 2nd" })).status).toBe(400);
    await call(`/api/funds/${fundId}/size`, "PATCH", { target_size: 28_000_000, first_close_on: null });
    expect((await call<{ first_close_on: string | null }>(`/api/funds/${fundId}/basis`)).body.first_close_on).toBeNull();
    const alloc = await call<{ fund: { first_close_on: string | null }; deployment: { timeline: unknown[]; secondaries_deployed: number } }>(`/api/portfolio/allocation?fund_id=${fundId}`);
    expect(alloc.body.fund.first_close_on).toBeNull();
    expect(Array.isArray(alloc.body.deployment.timeline)).toBe(true);
  });

  it("the first SIGNED commitment starts the clock; a SOFT one does not, and a second signature never moves it", async () => {
    const lp = await call<{ id: string }>("/api/lp/records", "POST", { legal_name: "Ferndale Test Partners", lp_type: "FAMILY_OFFICE" });
    const lpId = lp.status === 201 ? lp.body.id : (await env.WP_OS_DB.prepare("SELECT id FROM lp_record LIMIT 1").first<{ id: string }>())!.id;
    const soft = await call<{ first_close_on_set: string | null }>("/api/lp/commitments", "POST", { lp_record_id: lpId, fund_id: fundId, amount: 1_000_000, state: "SOFT" });
    expect([200, 201]).toContain(soft.status);
    expect(soft.body.first_close_on_set).toBeNull();
    expect((await call<{ first_close_on: string | null }>(`/api/funds/${fundId}/basis`)).body.first_close_on).toBeNull();

    const signed = await call<{ first_close_on_set: string | null }>("/api/lp/commitments", "POST", { lp_record_id: lpId, fund_id: fundId, amount: 1_000_000, state: "SIGNED", committed_on: "2026-04-10" });
    expect([200, 201]).toContain(signed.status);
    expect(signed.body.first_close_on_set).toBe("2026-04-10");
    expect((await call<{ first_close_on: string | null }>(`/api/funds/${fundId}/basis`)).body.first_close_on).toBe("2026-04-10");
    const ev = await env.WP_OS_DB.prepare("SELECT COUNT(*) n FROM event_record WHERE event_type = 'fund.first_close_recorded' AND object_id = ?1").bind(fundId).first<{ n: number }>();
    expect(ev!.n).toBe(1);

    const again = await call<{ first_close_on_set: string | null }>("/api/lp/commitments", "POST", { lp_record_id: lpId, fund_id: fundId, amount: 2_000_000, state: "SIGNED", committed_on: "2026-06-01" });
    expect([200, 201]).toContain(again.status);
    expect(again.body.first_close_on_set, "a later signature is not a first close").toBeNull();
    expect((await call<{ first_close_on: string | null }>(`/api/funds/${fundId}/basis`)).body.first_close_on).toBe("2026-04-10");
  });
});

describe("the split — the page reads no company list and draws no deployed slice", () => {
  const page = readFileSync(new URL("../src/client/pages/FundStrategyPage.tsx", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
  it("mounts neither Composition nor a cockpit, and the old stack is gone from App.tsx", () => {
    for (const src of [page, app.slice(app.indexOf('active === "fund-strategy"') - 400, app.indexOf('active === "fund-strategy"') + 400)]) {
      expect(src).not.toMatch(/<Composition\b|<CockpitPage\b|<PortfolioComposition\b|<PortfolioAllocation\b|STRATEGY_STEPS/);
    }
    expect(app).not.toMatch(/STRATEGY_STEPS|function AllocationPage|CockpitPage|FollowOnPage|ModelingPage/);
    expect(page).toMatch(/<DashboardDoor/);
    expect(page).toMatch(/<PlanVsReality/);
    expect(page).toMatch(/<FundConstruction/);
    expect(page).toMatch(/<DeckPanel/);
    expect(page).toMatch(/<ReservesBand/);
    expect(page).toMatch(/<ScenariosBand/);
  });
  it("the one orange control is the door's anchor, and the deck's Approve stays black", () => {
    const door = readFileSync(new URL("../src/client/pages/DashboardDoor.tsx", import.meta.url), "utf8");
    expect(door).toMatch(/className="btn-primary btn-lg"\s+href=/);
    expect(door).toMatch(/rel="noreferrer noopener"/);
    const deck = readFileSync(new URL("../src/client/pages/DeckPanel.tsx", import.meta.url), "utf8");
    expect(deck).not.toMatch(/btn-primary/);
    for (const f of ["PlanVsReality", "FundConstruction", "ReservesBand", "ScenariosBand", "FundStrategyPage"]) {
      expect(readFileSync(new URL(`../src/client/pages/${f}.tsx`, import.meta.url), "utf8"), `${f} carries a second primary`).not.toMatch(/btn-primary/);
    }
  });
});

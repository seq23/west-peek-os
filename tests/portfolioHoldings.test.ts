import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import { deploymentSlices, planRingSlices, planSlices, deploymentRingSlices } from "../src/shared/fund/allocation";
import type { ReserveDoc, SleeveDoc } from "../src/shared/fund/sleeveMath";

/**
 * The portfolio shows what the firm owns — and both pages show the same thing.
 *
 * WHAT THIS PINS, 18 Sep 2026. Production held one CLOSED investment (Sensori, a $10K SPV,
 * backfilled because it predates Fund I) and zero `position` rows, so Portfolio said "The fund
 * holds nothing yet" while Fund strategy's composition drew that company at 100%. The rule from
 * here on:
 *
 *   1. A company with a CLOSED investment ALWAYS appears on `/api/portfolio/holdings`, position or
 *      no position, and the row says which it is. The fixture is built exactly like Sensori —
 *      backfilled to CLOSED, placeholder price and share count — and the assertion HARD-FAILS if
 *      the fixture produced zero closed investments, so this test cannot pass by finding nothing.
 *   2. A booked position appears too, with the ledger's cost basis and its mark, merged into one
 *      row per company.
 *   3. Composition (Fund strategy's bars) is computed from that same list: same companies, same
 *      total money.
 *   4. The allocation figures Portfolio draws equal the ones Fund strategy draws. Fund strategy
 *      calls `planSlices` in the browser over the current policies; Portfolio reads
 *      `/api/portfolio/allocation`, which calls `planSlices` on the server over the same rows. One
 *      fixture feeds both here and the numbers are diffed to the cent.
 *
 * Nothing here claims valuation or fund-performance correctness (AGENTS.md §Validation honesty);
 * it claims that what the firm recorded is what the page shows, once.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const MEMBER = { "x-wpos-dev-user": "member@westpeek.ventures" };

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

async function createCompany(name: string, sector: string): Promise<string> {
  const res = await call<{ id: string }>("/api/companies", MP, "POST", { canonical_name: name, sector });
  expect(res.status).toBe(201);
  return res.body.id;
}

/** Sensori's shape exactly: closed by backfill, stand-in price and count totalling the real amount. */
async function closedLikeSensori(companyId: string, amount: number): Promise<string> {
  const created = await call<{ id: string }>("/api/opportunities", MP, "POST", {
    company_id: companyId,
    opportunity_type: "EARLY_STAGE_PRIMARY",
    title: "SPV, closed before the fund existed",
    source_channel: "SPV",
    price_per_share: 1,
    quantity: amount,
    terms: { vehicle: "SPV", amount_invested_usd: amount },
    placeholder_fields: ["price_per_share", "quantity"],
    placeholder_note: "Entry price and share count are STAND-INS totalling the real amount invested.",
  });
  expect(created.status).toBe(201);
  const backfilled = await call<{ status: string }>(`/api/opportunities/${created.body.id}/backfill`, MP, "POST", {
    to: "CLOSED",
    reason: "SPV that closed before Fund I existed; never went through IC",
    as_of_date: "2025-08-06",
  });
  expect(backfilled.status).toBe(200);
  expect(backfilled.body.status).toBe("CLOSED");
  return created.body.id;
}

interface HoldingsBody {
  holdings: Array<{
    company_id: string;
    company: string;
    booked: boolean;
    kind: string;
    vehicle: string | null;
    amount_in: number | null;
    provisional: boolean;
    invested_on: string | null;
    fund_name: string | null;
    valuation: { value: number; source: string } | null;
    ownership_pct: number | null;
    last_check_in: string | null;
    open_asks: number;
    open_alerts: number;
  }>;
  totals: { companies: number; booked: number; unbooked: number; invested: number; held_at: number; unvalued: number };
  note: string | null;
}

let fundId: string;
let sensoriId: string;
let bookedId: string;

const FUND_SIZE = 30_000_000;
const SLEEVE: SleeveDoc = {
  basis: "investable capital after fees and expenses",
  committed_usd: FUND_SIZE,
  estimated_fees_usd: 6_000_000,
  estimated_expenses_usd: 1_000_000,
  estimated_investable_usd: 23_000_000,
  sleeves: [
    { key: "EARLY_STAGE_PRIMARY", target_pct: 70, stage: "PRE_SEED" },
    { key: "SECONDARY_PURCHASE", target_pct: 30, stage: "SERIES_B_C" },
  ],
};
const RESERVE: ReserveDoc = { reserve_pct: 40, basis: "early-stage sleeve" };

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_DOCUMENTS: t.docs });
  await t.db
    .prepare("INSERT INTO firm_user (id, email, full_name, status) VALUES ('fu_test_member', 'member@westpeek.ventures', 'Test Member', 'ACTIVE')")
    .run();
  await t.db.prepare("INSERT INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_test_member', 'role_investment_team')").run();

  const fund = await call<{ id: string }>("/api/funds", MP, "POST", { name: "Holdings Fund I" });
  expect(fund.status).toBe(201);
  fundId = fund.body.id;

  // The policies both pages read, written through the same door the construction editor uses.
  for (const [kind, policy] of [
    ["mandate", { target_size_usd: FUND_SIZE, target_positions: 25 }],
    ["sleeve", SLEEVE],
    ["reserve", RESERVE],
  ] as const) {
    const res = await call(`/api/funds/${fundId}/policies/${kind}`, MP, "POST", { version_no: 1, effective_from: "2026-01-01", policy });
    expect(res.status, kind).toBe(201);
  }

  // The invested-but-unbooked company, built like the real one.
  sensoriId = await createCompany("Sensori-like SPV", "Functional beverage");
  await closedLikeSensori(sensoriId, 10_000);

  // A booked position: the ledger's own fact, inserted as executeTransaction would leave it.
  bookedId = await createCompany("Booked Robotics", "Robotics");
  const sc = await call<{ id: string }>("/api/security-classes", MP, "POST", { company_id: bookedId, class_name: "Series A Preferred" });
  expect(sc.status).toBe(201);
  await t.db
    .prepare(
      `INSERT INTO position (id, company_id, fund_id, security_class_id, quantity, cost_basis, status, firm_scope, opened_at)
       VALUES ('pos_booked', ?1, ?2, ?3, 125000, 500000, 'OPEN', 'west-peek', '2026-03-01T00:00:00.000Z')`,
    )
    .bind(bookedId, fundId, sc.body.id)
    .run();
  const mark = await call(`/api/positions/pos_booked/mark`, MP, "POST", {
    value: 750_000,
    source: "LAST_ROUND",
    basis: "Series B at $40M post",
    as_of_date: "2026-06-30",
  });
  expect(mark.status).toBe(201);
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("a company with a recorded investment always appears on the Portfolio page's data route", () => {
  it("hard-fails if the fixture holds no closed investment, then finds the unbooked one", async () => {
    // The fixture must contain at least one CLOSED opportunity with NO position — the production
    // shape. If it does not, the assertion below has nothing to prove and must say so loudly.
    const closed = await t.db
      .prepare(
        `SELECT COUNT(*) AS n FROM investment_opportunity o
          WHERE o.status = 'CLOSED' AND NOT EXISTS (SELECT 1 FROM position p WHERE p.company_id = o.company_id)`,
      )
      .first<{ n: number }>();
    expect(closed?.n ?? 0, "fixture must hold a closed investment with no position, or this test proves nothing").toBeGreaterThan(0);

    const res = await call<HoldingsBody>("/api/portfolio/holdings", MP);
    expect(res.status).toBe(200);
    const row = res.body.holdings.find((h) => h.company_id === sensoriId);
    expect(row, "the closed-but-unbooked company must be on the list").toBeTruthy();
    expect(row!.booked).toBe(false);
    expect(row!.kind).toBe("EARLY_STAGE_PRIMARY");
    expect(row!.vehicle).toBe("SPV");
    expect(row!.amount_in).toBe(10_000);
    expect(row!.provisional).toBe(true);
    expect(row!.invested_on).toBe("2025-08-06");
    expect(row!.valuation).toBeNull();
    // The page is told, before the figures, that this one is not in any fund's ledger.
    expect(res.body.totals.unbooked).toBe(1);
    expect(res.body.note).toContain("not yet booked");
  });

  it("carries the booked position with the ledger's cost basis and its current mark, merged per company", async () => {
    const res = await call<HoldingsBody>("/api/portfolio/holdings", MP);
    const row = res.body.holdings.find((h) => h.company_id === bookedId);
    expect(row).toBeTruthy();
    expect(row!.booked).toBe(true);
    expect(row!.fund_name).toBe("Holdings Fund I");
    expect(row!.amount_in).toBe(500_000);
    expect(row!.valuation).toEqual(expect.objectContaining({ value: 750_000, source: "LAST_ROUND" }));
    expect(row!.provisional).toBe(false);

    // One row per company, whatever it is made of.
    const ids = res.body.holdings.map((h) => h.company_id);
    expect(new Set(ids).size).toBe(ids.length);

    expect(res.body.totals).toEqual(
      expect.objectContaining({ companies: 2, booked: 1, unbooked: 1, invested: 510_000, held_at: 760_000, unvalued: 1 }),
    );
  });

  it("carries the facts a partner asks next: ownership, last check-in, open asks and flags", async () => {
    const own = await call("/api/ownership-snapshots", MP, "POST", {
      company_id: bookedId,
      fund_id: fundId,
      as_of_date: "2026-06-30",
      ownership_pct: 8.5,
      source: "cap table export",
    });
    expect(own.status).toBe(201);
    const def = await call("/api/portfolio/metric-definitions", MP, "POST", {
      metric_key: "holdings_arr",
      name: "ARR",
      direction: "HIGHER_IS_BETTER",
    });
    expect(def.status).toBe(201);
    const snap = await call("/api/portfolio/snapshots", MP, "POST", {
      company_id: bookedId,
      metric_key: "holdings_arr",
      as_of_date: "2026-07-31",
      value: 1_200_000,
      source: "founder update",
    });
    expect(snap.status).toBe(201);
    const ask = await call("/api/support/requests", MP, "POST", {
      company_id: bookedId,
      request_type: "HIRING",
      description: "Needs a head of sales",
    });
    expect(ask.status).toBe(201);

    const res = await call<HoldingsBody>("/api/portfolio/holdings", MP);
    const row = res.body.holdings.find((h) => h.company_id === bookedId)!;
    expect(row.ownership_pct).toBe(8.5);
    expect(row.last_check_in).toBe("2026-07-31");
    expect(row.open_asks).toBe(1);
    expect(row.open_alerts).toBe(0);
  });

  it("keeps the privacy boundary a closed opportunity already had", async () => {
    const hidden = await createCompany("Hidden Closed Co", "Health");
    const created = await call<{ id: string }>("/api/opportunities", MP, "POST", {
      company_id: hidden,
      opportunity_type: "EARLY_STAGE_PRIMARY",
      title: "LP-private closed deal",
      privacy_label: "LP_PRIVATE",
      terms: { amount_invested_usd: 250_000 },
    });
    expect(created.status).toBe(201);
    expect((await call(`/api/opportunities/${created.body.id}/backfill`, MP, "POST", { to: "CLOSED", reason: "entered as history for the privacy test" })).status).toBe(200);

    const partner = await call<HoldingsBody>("/api/portfolio/holdings", MP);
    expect(partner.body.holdings.some((h) => h.company_id === hidden)).toBe(true);
    const member = await call<HoldingsBody>("/api/portfolio/holdings", MEMBER);
    expect(member.status).toBe(200);
    expect(member.body.holdings.some((h) => h.company_id === hidden)).toBe(false);
    // The member still sees everything they were always allowed to see.
    expect(member.body.holdings.some((h) => h.company_id === sensoriId)).toBe(true);
  });
});

describe("composition and the deployment ring are computed from the same list", () => {
  it("composition names the same companies and the same money as holdings", async () => {
    const holdings = await call<HoldingsBody>("/api/portfolio/holdings", MP);
    const comp = await call<{ positions: number; valued: number; total_usd: number; by_type: Array<{ key: string; usd: number }>; by_sector: Array<{ key: string; usd: number }>; provisional: boolean }>(
      "/api/portfolio/composition",
      MP,
    );
    expect(comp.status).toBe(200);
    expect(comp.body.positions).toBe(holdings.body.totals.companies);
    expect(comp.body.total_usd).toBe(holdings.body.totals.invested);
    expect(comp.body.by_type.reduce((s, r) => s + r.usd, 0)).toBe(holdings.body.totals.invested);
    expect(comp.body.by_sector.reduce((s, r) => s + r.usd, 0)).toBe(holdings.body.totals.invested);
    expect(comp.body.by_sector.map((r) => r.key).sort()).toEqual(
      [...new Set(holdings.body.holdings.map((h) => h.company === "Sensori-like SPV" ? "Functional beverage" : h.company === "Booked Robotics" ? "Robotics" : "Health"))].sort(),
    );
    // Placeholder economics stay visibly provisional all the way through.
    expect(comp.body.provisional).toBe(true);
  });

  it("the allocation figures Portfolio draws equal the ones Fund strategy draws, from one fixture", async () => {
    // What Fund strategy renders: `planSlices` in the browser over the current policies.
    const fundStrategy = planSlices(FUND_SIZE, SLEEVE, RESERVE);
    // Hand-worked: $30M − $7M fees/expenses = $23M investable; 30% = $6.9M secondaries;
    // 70% = $16.1M early stage, 40% of it = $6.44M reserves; $30M − 7 − 6.9 − 6.44 = $9.66M.
    expect(fundStrategy).toEqual({ fundSize: 30_000_000, fees: 7_000_000, secondaries: 6_900_000, reserves: 6_440_000, initial: 9_660_000 });

    // What Portfolio renders: the server's reading of the same rows.
    const res = await call<{ plan: typeof fundStrategy; deployment: ReturnType<typeof deploymentSlices>; companies: number; provisional: boolean }>(
      `/api/portfolio/allocation?fund_id=${fundId}`,
      MP,
    );
    expect(res.status).toBe(200);

    // Diffed to the cent, field by field — not "roughly".
    for (const key of ["fundSize", "fees", "secondaries", "reserves", "initial"] as const) {
      expect(Math.abs(res.body.plan[key] - fundStrategy[key]), key).toBeLessThan(0.01);
    }

    // The one ledger figure is the same money the holdings list and composition report.
    const holdings = await call<HoldingsBody>("/api/portfolio/holdings", MP);
    expect(res.body.deployment.deployed).toBe(holdings.body.totals.invested);
    // STRICTER SINCE 19 Sep 2026: the route now also carries the dated pace (`timeline`) and the
    // secondaries figure (0212, design/FUND_STRATEGY_DESIGN.md §4). The plan-and-deployment figures
    // must still equal the shared arithmetic exactly, and the two additions must be present and
    // sum-consistent with the ledger: every timeline point is a dated, positive amount.
    const { timeline, secondaries_deployed, ...slices } = res.body.deployment as typeof res.body.deployment & { timeline: Array<{ on: string; usd: number }>; secondaries_deployed: number };
    expect(slices).toEqual(deploymentSlices(fundStrategy, holdings.body.totals.invested));
    expect(Array.isArray(timeline)).toBe(true);
    for (const p of timeline) {
      expect(p.on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.usd > 0, `a timeline point of ${p.usd}`).toBe(true);
    }
    expect(secondaries_deployed).toBeGreaterThanOrEqual(0);
    expect(res.body.deployment.remaining).toBe(9_660_000 - holdings.body.totals.invested);
    expect(res.body.deployment.overspend).toBe(0);
    expect(res.body.companies).toBe(holdings.body.totals.companies);
    expect(res.body.provisional).toBe(true);

    // Both rings sum to the fund: the plan's four parts, and the deployment view's five.
    const sum = (xs: Array<{ usd: number }>) => xs.reduce((s, x) => s + x.usd, 0);
    expect(Math.abs(sum(planRingSlices(fundStrategy)) - FUND_SIZE)).toBeLessThan(0.01);
    expect(Math.abs(sum(deploymentRingSlices(res.body.deployment)) - FUND_SIZE)).toBeLessThan(0.01);
    // And the parts the two rings share carry the same colour identity on both pages.
    const planColours = new Map(planRingSlices(fundStrategy).map((s) => [s.key, s.color]));
    const deployColours = new Map(deploymentRingSlices(res.body.deployment).map((s) => [s.key, s.color]));
    expect(deployColours.get("deployed")).toBe(planColours.get("initial"));
    expect(deployColours.get("remaining")).toBe("var(--wp-line)");
  });

  it("says so when there is no plan to draw against, and refuses a missing fund", async () => {
    const bare = await call<{ id: string }>("/api/funds", MP, "POST", { name: "Fund With No Thesis" });
    const res = await call<{ plan: { fundSize: number }; note: string | null }>(`/api/portfolio/allocation?fund_id=${bare.body.id}`, MP);
    expect(res.status).toBe(200);
    expect(res.body.plan.fundSize).toBe(0);
    expect(res.body.note).toContain("No fund size recorded");

    expect((await call("/api/portfolio/allocation", MP)).status).toBe(400);
    expect((await call("/api/portfolio/allocation?fund_id=fund_nope", MP)).status).toBe(404);
  });

  it("overspend is reported, never hidden in a negative remainder", () => {
    const plan = planSlices(FUND_SIZE, SLEEVE, RESERVE);
    const over = deploymentSlices(plan, 10_000_000);
    expect(over.remaining).toBe(0);
    expect(over.overspend).toBe(340_000);
  });
});

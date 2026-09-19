import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";

/**
 * THE SECONDARIES PAGE STATES ITS SLEEVE, AND EVERY FIGURE ON IT IS READ.
 *
 * design/DEALS_SECTION_DESIGN.md §8: the masthead carries the sleeve budget — what the sleeve is
 * (`sleeveTargetUsd(SECONDARY_PURCHASE)`, $7.2M on the commissioning policy) and what has gone out
 * of it. Neither may be typed into the page, and neither may be invented when the record is silent:
 *
 *   - no fund                       → target null, source says MISSING
 *   - a fund with no sleeve policy  → target null, source says MISSING
 *   - the commissioning policy      → $7,200,000, derived from 30% of the $24M investable base,
 *                                     NOT the $7.0M the same policy stores as `target_usd`
 *   - nothing bought                → deployed 0, DERIVED
 *   - a PURCHASE position           → counted; a PRIMARY_INVESTMENT position on the same fund is not
 *
 * And each row carries the company's last PRIMARY_ROUND pricing observation, or null — never a
 * BID or an INDICATION standing in for a round, and never a computed discount against nothing.
 *
 * Forbidden-claim discipline (§12.4): nothing here asserts valuation or fund-performance
 * correctness — only that the number the page shows is the number the policy and the ledger hold.
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

interface SecondariesResponse {
  opportunities: Array<Record<string, unknown>>;
  purchases: number;
  sales: number;
  stage_counts: Record<string, number>;
  sleeve: {
    fund_id: string | null;
    fund_name: string | null;
    target_usd: number | null;
    target_source: string;
    deployed_usd: number;
    deployed_source: string;
    positions: number;
  };
  separation_rule: string;
}

// The commissioning sleeve policy, as scripts/seed/commission-fund.mjs writes it — including the
// stale stored dollars, so the test proves the percentage wins (src/shared/fund/sleeveMath.ts).
const COMMISSIONING_SLEEVE = {
  basis: "investable capital after fees and expenses",
  committed_usd: 30_000_000,
  estimated_fees_usd: 5_000_000,
  estimated_expenses_usd: 1_000_000,
  estimated_investable_usd: 24_000_000,
  sleeves: [
    { key: "EARLY_STAGE_PRIMARY", target_pct: 70, target_usd: 17_000_000, stage: "PRE_SEED" },
    { key: "SECONDARY_PURCHASE", target_pct: 30, target_usd: 7_000_000, stage: "SERIES_B_C" },
  ],
};

async function createCompany(name: string): Promise<string> {
  const res = await call<{ id: string }>("/api/companies", MP, "POST", { canonical_name: name });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function createSecurityClass(companyId: string, className: string): Promise<string> {
  const res = await call<{ id: string }>("/api/security-classes", MP, "POST", { company_id: companyId, class_name: className });
  expect(res.status).toBe(201);
  return res.body.id;
}

/** Draft → submit → approve → execute, opening a position on `fundId`. Returns the transaction id. */
async function bookPosition(
  companyId: string,
  securityClassId: string,
  fundId: string,
  transactionType: "PURCHASE" | "PRIMARY_INVESTMENT",
  opportunityId: string | undefined,
  quantity: number,
  pricePerShare: number,
): Promise<string> {
  const drafted = await call<{ id: string }>("/api/transactions", MP, "POST", {
    company_id: companyId,
    security_class_id: securityClassId,
    transaction_type: transactionType,
    quantity,
    price_per_share: pricePerShare,
    fees: 0,
    carry: 0,
    transaction_date: "2026-03-01",
    opportunity_id: opportunityId,
  });
  expect(drafted.status).toBe(201);
  const submitted = await call<{ approval_card_id: string }>(`/api/transactions/${drafted.body.id}/submit`, MP, "POST", {});
  expect(submitted.status).toBe(200);
  const decided = await call(`/api/approvals/${submitted.body.approval_card_id}/decide`, MP, "POST", { decision: "approved", note: "test" });
  expect(decided.status).toBe(200);
  const executed = await call(`/api/transactions/${drafted.body.id}/execute`, MP, "POST", {
    approval_receipt_id: submitted.body.approval_card_id,
    fund_id: fundId,
  });
  expect(executed.status).toBe(200);
  return drafted.body.id;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_DOCUMENTS: t.docs });
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("the sleeve budget is read, never typed, never invented", () => {
  it("with no fund at all the target is null and says MISSING — not $0", async () => {
    const res = await call<SecondariesResponse>("/api/secondaries", MP);
    expect(res.status).toBe(200);
    expect(res.body.sleeve.fund_id).toBeNull();
    expect(res.body.sleeve.target_usd).toBeNull();
    expect(res.body.sleeve.target_source).toMatch(/MISSING/);
    expect(res.body.sleeve.deployed_usd).toBe(0);
    expect(res.body.sleeve.deployed_source).toMatch(/DERIVED/);
    // The rule travels with every response, empty or not.
    expect(res.body.separation_rule).toMatch(/separate sleeve/);
  });

  it("a fund with no sleeve policy is MISSING too; the commissioning policy derives $7,200,000 from the percentage", async () => {
    const fund = await call<{ id: string }>("/api/funds", MP, "POST", { name: "Sleeve Fund I" });
    expect(fund.status).toBe(201);

    const bare = await call<SecondariesResponse>(`/api/secondaries?fund_id=${fund.body.id}`, MP);
    expect(bare.body.sleeve.fund_id).toBe(fund.body.id);
    expect(bare.body.sleeve.target_usd).toBeNull();
    expect(bare.body.sleeve.target_source).toMatch(/MISSING — no sleeve policy/);

    const policy = await call(`/api/funds/${fund.body.id}/policies/sleeve`, MP, "POST", {
      version_no: 1,
      effective_from: "2026-08-18",
      policy: COMMISSIONING_SLEEVE,
    });
    expect(policy.status).toBe(201);

    const withPolicy = await call<SecondariesResponse>(`/api/secondaries?fund_id=${fund.body.id}`, MP);
    // 30% of $24,000,000 — the percentage is the policy. The stored $7,000,000 is the legacy
    // rounding the arithmetic exists to stop leaking back in.
    expect(withPolicy.body.sleeve.target_usd).toBe(7_200_000);
    expect(withPolicy.body.sleeve.target_source).toBe("sleeve_policy_version v1 · 30% of the investable base");
    expect(withPolicy.body.sleeve.deployed_usd).toBe(0);
    expect(withPolicy.body.sleeve.positions).toBe(0);

    // No fund_id → the firm's first fund, which is this one.
    const defaulted = await call<SecondariesResponse>("/api/secondaries", MP);
    expect(defaulted.body.sleeve.fund_id).toBe(fund.body.id);
    expect(defaulted.body.sleeve.target_usd).toBe(7_200_000);

    // A fund that does not exist is not silently the first one.
    const unknown = await call<SecondariesResponse>("/api/secondaries?fund_id=fund_nope", MP);
    expect(unknown.body.sleeve.fund_id).toBeNull();
    expect(unknown.body.sleeve.target_usd).toBeNull();
  });

  it("deployed counts a PURCHASE position and not a PRIMARY_INVESTMENT on the same fund", async () => {
    const fund = await call<{ id: string }>("/api/funds", MP, "POST", { name: "Sleeve Fund II" });
    expect(fund.status).toBe(201);
    await call(`/api/funds/${fund.body.id}/policies/sleeve`, MP, "POST", { version_no: 1, effective_from: "2026-08-18", policy: COMMISSIONING_SLEEVE });

    const company = await createCompany("Block Co");
    const cls = await createSecurityClass(company, "Series B Preferred");
    const opp = await call<{ id: string }>("/api/opportunities", MP, "POST", {
      company_id: company,
      opportunity_type: "SECONDARY_PURCHASE",
      title: "Seller block",
      security_class_id: cls,
      seller_name: "An early employee",
      broker_name: "A broker",
      quantity: 1000,
      price_per_share: 12,
      discount_premium: -0.2,
    });
    expect(opp.status).toBe(201);

    // A secondary purchase: 1000 × $12 = $12,000 into the sleeve.
    await bookPosition(company, cls, fund.body.id, "PURCHASE", opp.body.id, 1000, 12);
    // A primary cheque on the same fund, a different company: NOT the sleeve.
    const primaryCo = await createCompany("Primary Co");
    const primaryCls = await createSecurityClass(primaryCo, "Seed Preferred");
    await bookPosition(primaryCo, primaryCls, fund.body.id, "PRIMARY_INVESTMENT", undefined, 50_000, 10);

    const res = await call<SecondariesResponse>(`/api/secondaries?fund_id=${fund.body.id}`, MP);
    expect(res.body.sleeve.deployed_usd).toBe(12_000);
    expect(res.body.sleeve.positions).toBe(1);
    expect(res.body.sleeve.target_usd).toBe(7_200_000);
  });
});

describe("rows carry the last round, the stage clock, and nothing removed", () => {
  it("the last PRIMARY_ROUND observation rides on the row; a BID does not stand in for it; none → null", async () => {
    const company = await createCompany("Round Co");
    const opp = await call<{ id: string }>("/api/opportunities", MP, "POST", {
      company_id: company,
      opportunity_type: "SECONDARY_PURCHASE",
      title: "Round Co block",
      quantity: 500,
      price_per_share: 8,
    });
    expect(opp.status).toBe(201);

    const before = await call<SecondariesResponse>("/api/secondaries", MP);
    const rowBefore = before.body.opportunities.find((o) => o.id === opp.body.id)!;
    expect(rowBefore).toBeDefined();
    expect(rowBefore.last_round_price).toBeNull();
    expect(rowBefore.last_round_observed_at).toBeNull();
    // Never moved: the clock started at creation.
    expect(rowBefore.in_stage_since).toBe(rowBefore.created_at);
    expect(rowBefore.company_name).toBe("Round Co");

    // A BID is a bid. It is not the round.
    const bid = await call("/api/pricing-observations", MP, "POST", {
      company_id: company,
      observation_type: "BID",
      price_per_share: 9,
      observed_at: "2026-09-10",
      source: "a broker's email",
    });
    expect(bid.status).toBe(201);
    const afterBid = await call<SecondariesResponse>("/api/secondaries", MP);
    expect(afterBid.body.opportunities.find((o) => o.id === opp.body.id)!.last_round_price).toBeNull();

    // Two rounds: the latest by observed_at wins, not the latest written.
    for (const [price, when] of [
      [10, "2026-06-01"],
      [6, "2025-01-15"],
    ] as const) {
      const round = await call("/api/pricing-observations", MP, "POST", {
        company_id: company,
        observation_type: "PRIMARY_ROUND",
        price_per_share: price,
        observed_at: when,
        source: "the company's cap table",
      });
      expect(round.status).toBe(201);
    }
    const afterRounds = await call<SecondariesResponse>("/api/secondaries", MP);
    const row = afterRounds.body.opportunities.find((o) => o.id === opp.body.id)!;
    expect(row.last_round_price).toBe(10);
    expect(row.last_round_observed_at).toBe("2026-06-01");
  });

  it("a moved deal's clock restarts at the move; a removed deal leaves the page; the stage counts follow", async () => {
    const company = await createCompany("Moving Co");
    const opp = await call<{ id: string }>("/api/opportunities", MP, "POST", {
      company_id: company,
      opportunity_type: "SECONDARY_SALE",
      title: "Moving Co sale",
    });
    expect(opp.status).toBe(201);

    const moved = await call(`/api/opportunities/${opp.body.id}/transition`, MP, "POST", { to: "SCREENING" });
    expect(moved.status).toBe(200);
    const after = await call<SecondariesResponse>("/api/secondaries", MP);
    const row = after.body.opportunities.find((o) => o.id === opp.body.id)!;
    expect(row.status).toBe("SCREENING");
    expect(row.in_stage_since).toBe(row.last_moved_at);
    expect(after.body.stage_counts.SCREENING).toBeGreaterThanOrEqual(1);
    expect(after.body.sales).toBeGreaterThanOrEqual(1);
    const salesBefore = after.body.sales;

    const removed = await call(`/api/opportunities/${opp.body.id}/archive`, MP, "POST", { reason: "entered twice" });
    expect(removed.status).toBe(200);
    const gone = await call<SecondariesResponse>("/api/secondaries", MP);
    expect(gone.body.opportunities.find((o) => o.id === opp.body.id)).toBeUndefined();
    expect(gone.body.sales).toBe(salesBefore - 1);
  });

  it("is denied without a signed-in user", async () => {
    const res = await handleRequest(req("/api/secondaries"), env);
    expect(res.status).toBe(401);
  });
});

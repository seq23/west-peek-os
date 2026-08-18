import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { assembleIcPacket, recordDissent, recordIcDecision } from "../src/worker/services/ic";
import { createOpportunity, detectBlockLinkCandidates, type OpportunityRow } from "../src/worker/services/investment";

/**
 * P6 — investment / secondaries / deal math / IC / transactions / positions.
 *
 * Every test targets a rule from the approved plan §8 (P6) and §12.2:
 * one canonical identity behind many opportunities/transactions/positions;
 * distinct share classes and seller blocks; secondaries provenance preserved and
 * duplicates LINKED not merged; pricing statuses stay distinct; execution only
 * behind the type-specific reserved receipt (replay refused, void reverses);
 * deal math manual-vs-calculated with an append-only assumption ledger; IC packets
 * that can never hide an unresolved material contradiction; and the structural ban
 * on AI marking a human approval.
 *
 * Forbidden-claim discipline (§12.4): nothing here asserts legal, compliance,
 * brokerage/fund, MNPI, or valuation correctness — only routing, blocking,
 * provenance, arithmetic consistency, and recorded human decisions.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const MEMBER = { "x-wpos-dev-user": "member@westpeek.ventures" }; // INVESTMENT_TEAM, not MP

const MP_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const MEMBER_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_test_member", roles: ["INVESTMENT_TEAM"], firmScopes: ["west-peek"] };
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

let seq = 0;
async function createCompany(name?: string): Promise<string> {
  seq += 1;
  const res = await call<{ id: string }>("/api/companies", MP, "POST", { canonical_name: name ?? `P6 Co ${seq} ${crypto.randomUUID().slice(0, 8)}` });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function createFund(name = `P6 Fund ${crypto.randomUUID().slice(0, 8)}`): Promise<string> {
  const res = await call<{ id: string }>("/api/funds", MP, "POST", { name });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function createSecurityClass(companyId: string, className: string): Promise<string> {
  const res = await call<{ id: string }>("/api/security-classes", MP, "POST", { company_id: companyId, class_name: className });
  expect(res.status).toBe(201);
  return res.body.id;
}

interface OppOverrides {
  opportunity_type?: string;
  title?: string;
  security_class_id?: string;
  price_per_share?: number;
  quantity?: number;
  seller_name?: string;
  broker_name?: string;
  fees?: number;
  carry?: number;
  terms?: Record<string, unknown>;
  source_channel?: string;
  privacy_label?: string;
}

async function createOpportunityApi(companyId: string, o: OppOverrides = {}): Promise<OpportunityRow> {
  const res = await call<OpportunityRow>("/api/opportunities", MP, "POST", {
    company_id: companyId,
    opportunity_type: o.opportunity_type ?? "SECONDARY_PURCHASE",
    title: o.title ?? "block",
    ...o,
  });
  expect(res.status).toBe(201);
  return res.body;
}

/** Create + submit + approve an approval card as MP; returns the receipt (card) id. */
async function approvedCard(actionKey: string, objectType: string, objectId: string): Promise<string> {
  const created = await call<{ id: string }>("/api/approvals", MP, "POST", {
    action_key: actionKey,
    object_type: objectType,
    object_id: objectId,
    title: `p6: ${actionKey} ${objectId}`,
    submit: true,
  });
  expect(created.status).toBe(201);
  const decided = await call(`/api/approvals/${created.body.id}/decide`, MP, "POST", { decision: "approved" });
  expect(decided.status).toBe(200);
  return created.body.id;
}

interface TxnRow {
  id: string;
  status: string;
  gross_amount: number;
  fees: number;
  carry: number;
  net_amount: number;
  approval_card_id: string | null;
}

async function draftTransaction(
  companyId: string,
  securityClassId: string,
  over: Partial<{ opportunity_id: string; transaction_type: string; quantity: number; price_per_share: number; fees: number; carry: number; transaction_date: string; parties: unknown[] }> = {},
): Promise<TxnRow> {
  const res = await call<TxnRow>("/api/transactions", MP, "POST", {
    company_id: companyId,
    security_class_id: securityClassId,
    transaction_type: over.transaction_type ?? "PURCHASE",
    quantity: over.quantity ?? 1000,
    price_per_share: over.price_per_share ?? 10,
    fees: over.fees ?? 0,
    carry: over.carry ?? 0,
    transaction_date: over.transaction_date ?? "2026-03-01",
    opportunity_id: over.opportunity_id,
    parties: over.parties,
  });
  expect(res.status).toBe(201);
  return res.body;
}

/** DRAFT → submitted → approved receipt for the transaction's reserved action. */
async function submitAndApprove(txnId: string): Promise<string> {
  const submitted = await call<TxnRow>(`/api/transactions/${txnId}/submit`, MP, "POST", {});
  expect(submitted.status).toBe(200);
  expect(submitted.body.status).toBe("PENDING_APPROVAL");
  const cardId = submitted.body.approval_card_id!;
  const decided = await call(`/api/approvals/${cardId}/decide`, MP, "POST", { decision: "approved", note: "IC approved" });
  expect(decided.status).toBe(200);
  return cardId;
}

const HUMAN_SOURCE = {
  source_type: "HUMAN_STATEMENT",
  location: "founder call 2026-02-02, 10:00",
  source_date: "2026-02-02",
  method: "interview notes",
} as const;

async function createClaimApi(companyId: string, metricKey: string, metricValue: string, text: string): Promise<string> {
  const res = await call<{ id: string }>("/api/claims", MP, "POST", {
    company_id: companyId,
    subject_type: "company",
    subject_id: companyId,
    claim_text: text,
    metric_key: metricKey,
    metric_value: metricValue,
    period_start: "2025-01-01",
    period_end: "2025-12-31",
    confidence: 0.8,
    sources: [{ ...HUMAN_SOURCE }],
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_DOCUMENTS: t.docs });
  await t.db
    .prepare("INSERT INTO firm_user (id, email, full_name, status) VALUES ('fu_test_member', 'member@westpeek.ventures', 'Test Member', 'ACTIVE')")
    .run();
  await t.db.prepare("INSERT INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_test_member', 'role_investment_team')").run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

// ── 0. Unauthenticated requests are denied across the whole P6 surface ──

describe("0. unauthenticated requests are denied (401) across the P6 surface", () => {
  it("returns 401 on every P6 route", async () => {
    const routes: Array<[string, string, unknown?]> = [
      ["POST", "/api/security-classes", {}],
      ["GET", "/api/security-classes"],
      ["POST", "/api/opportunities", {}],
      ["GET", "/api/opportunities"],
      ["GET", "/api/opportunities/opp_x"],
      ["PATCH", "/api/opportunities/opp_x", {}],
      ["POST", "/api/opportunities/opp_x/transition", { to: "SCREENING" }],
      ["POST", "/api/opportunities/opp_x/block-links/scan", {}],
      ["POST", "/api/opportunities/opp_x/block-links", {}],
      ["GET", "/api/block-links"],
      ["POST", "/api/block-links/obl_x/decide", {}],
      ["POST", "/api/opportunities/opp_x/deal-math", {}],
      ["POST", "/api/opportunities/opp_x/deal-math/calculate", {}],
      ["GET", "/api/deal-math-packets/dmp_x"],
      ["PATCH", "/api/deal-math-packets/dmp_x", {}],
      ["POST", "/api/deal-math-packets/dmp_x/review", {}],
      ["POST", "/api/transactions", {}],
      ["GET", "/api/transactions"],
      ["GET", "/api/transactions/txn_x"],
      ["POST", "/api/transactions/txn_x/parties", {}],
      ["POST", "/api/transactions/txn_x/submit", {}],
      ["POST", "/api/transactions/txn_x/execute", {}],
      ["POST", "/api/transactions/txn_x/void", {}],
      ["GET", "/api/positions"],
      ["POST", "/api/ownership-snapshots", {}],
      ["GET", "/api/ownership-snapshots"],
      ["POST", "/api/pricing-observations", {}],
      ["GET", "/api/pricing-observations"],
      ["POST", "/api/ic/packets", {}],
      ["GET", "/api/ic/packets"],
      ["GET", "/api/ic/packets/icp_x"],
      ["POST", "/api/ic/packets/icp_x/submit", {}],
      ["POST", "/api/ic/packets/icp_x/decide", {}],
      ["POST", "/api/ic/decisions/icd_x/dissent", {}],
      ["GET", "/api/companies/cc_x/360"],
    ];
    for (const [method, path, body] of routes) {
      const res = await handleRequest(req(path, {}, method, body), env);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

// ── 1. One canonical company, many opportunities / transactions / positions (D3) ──

describe("1. multi-transaction company identity (D3)", () => {
  it("one canonical company carries many opportunities, transactions, and per-class positions", async () => {
    const company = await createCompany("Multi Txn Co");
    const fund = await createFund();
    const preferredB = await createSecurityClass(company, "Series B Preferred");
    const common = await createSecurityClass(company, "Common");

    const oppA = await createOpportunityApi(company, { title: "Seller A block", security_class_id: preferredB, seller_name: "Seller A", quantity: 1000, price_per_share: 10 });
    const oppB = await createOpportunityApi(company, { title: "Seller B block", security_class_id: common, seller_name: "Seller B", quantity: 250, price_per_share: 4 });

    const t1 = await draftTransaction(company, preferredB, { opportunity_id: oppA.id, quantity: 1000, price_per_share: 10 });
    const r1 = await submitAndApprove(t1.id);
    const e1 = await call(`/api/transactions/${t1.id}/execute`, MP, "POST", { approval_receipt_id: r1, fund_id: fund });
    expect(e1.status).toBe(200);

    const t2 = await draftTransaction(company, common, { opportunity_id: oppB.id, quantity: 250, price_per_share: 4 });
    const r2 = await submitAndApprove(t2.id);
    const e2 = await call(`/api/transactions/${t2.id}/execute`, MP, "POST", { approval_receipt_id: r2, fund_id: fund });
    expect(e2.status).toBe(200);

    // Distinct share classes stay distinct: two positions, never one blended row.
    const positions = await call<{ positions: Array<{ security_class_id: string; quantity: number; cost_basis: number }> }>(
      `/api/positions?company_id=${company}`,
      MP,
    );
    expect(positions.body.positions).toHaveLength(2);
    const byClass = Object.fromEntries(positions.body.positions.map((p) => [p.security_class_id, p]));
    expect(byClass[preferredB]!.quantity).toBe(1000);
    expect(byClass[preferredB]!.cost_basis).toBe(10000);
    expect(byClass[common]!.quantity).toBe(250);
    expect(byClass[common]!.cost_basis).toBe(1000);

    // Company 360 resolves everything through the ONE canonical identity.
    const view = await call<{ company: { id: string }; opportunities: unknown[]; transactions: unknown[]; positions: unknown[]; security_classes: unknown[] }>(
      `/api/companies/${company}/360`,
      MP,
    );
    expect(view.status).toBe(200);
    expect(view.body.company.id).toBe(company);
    expect(view.body.opportunities).toHaveLength(2);
    expect(view.body.transactions).toHaveLength(2);
    expect(view.body.positions).toHaveLength(2);
    expect(view.body.security_classes).toHaveLength(2);
  });

  it("a second buy in the SAME class adds to the existing position (no duplicate position row)", async () => {
    const company = await createCompany("Add To Position Co");
    const fund = await createFund();
    const cls = await createSecurityClass(company, "Series A Preferred");

    for (const [qty, price] of [[100, 5], [50, 6]] as const) {
      const txn = await draftTransaction(company, cls, { quantity: qty, price_per_share: price });
      const receipt = await submitAndApprove(txn.id);
      const executed = await call(`/api/transactions/${txn.id}/execute`, MP, "POST", { approval_receipt_id: receipt, fund_id: fund });
      expect(executed.status).toBe(200);
    }
    const positions = await call<{ positions: Array<{ quantity: number; cost_basis: number }> }>(`/api/positions?company_id=${company}`, MP);
    expect(positions.body.positions).toHaveLength(1);
    expect(positions.body.positions[0]!.quantity).toBe(150);
    expect(positions.body.positions[0]!.cost_basis).toBe(100 * 5 + 50 * 6);
  });
});

// ── 2. Secondaries: provenance preserved; related blocks linked, never merged ──

describe("2. secondaries provenance and non-destructive block linking", () => {
  it("preserves seller, broker, share class, fees, carry, and terms on the opportunity row", async () => {
    const company = await createCompany("Provenance Co");
    const cls = await createSecurityClass(company, "Series C Preferred");
    const opp = await createOpportunityApi(company, {
      title: "SPV block via broker",
      security_class_id: cls,
      seller_name: "Early Employee 17",
      broker_name: "Nasdaq Private Market",
      source_channel: "broker_email",
      price_per_share: 21.5,
      quantity: 5000,
      fees: 3200,
      carry: 0.1,
      terms: { rofr_days: 30, transfer_restriction: "board consent" },
    });
    const fetched = await call<OpportunityRow>(`/api/opportunities/${opp.id}`, MP);
    expect(fetched.status).toBe(200);
    expect(fetched.body.seller_name).toBe("Early Employee 17");
    expect(fetched.body.broker_name).toBe("Nasdaq Private Market");
    expect(fetched.body.security_class_id).toBe(cls);
    expect(fetched.body.fees).toBe(3200);
    expect(fetched.body.carry).toBe(0.1);
    expect(JSON.parse(fetched.body.terms_json)).toEqual({ rofr_days: 30, transfer_restriction: "board consent" });
    expect(fetched.body.source_channel).toBe("broker_email");
  });

  it("duplicate-looking blocks are LINKED for human decision — both rows survive intact", async () => {
    const company = await createCompany("Duplicate Block Co");
    const cls = await createSecurityClass(company, "Series B Preferred");
    const base = { security_class_id: cls, seller_name: "Founder Estate", broker_name: "Broker X", price_per_share: 20, quantity: 2000, fees: 1000 };
    const a = await createOpportunityApi(company, { ...base, title: "Block via Broker X" });
    const b = await createOpportunityApi(company, { ...base, title: "Same block re-offered", price_per_share: 20.4 });

    const scan = await call<{ links: Array<{ id: string; link_type: string; status: string }> }>(`/api/opportunities/${a.id}/block-links/scan`, MP, "POST", {});
    expect(scan.status).toBe(201);
    expect(scan.body.links).toHaveLength(1);
    expect(scan.body.links[0]!.link_type).toBe("DUPLICATE_CANDIDATE");
    expect(scan.body.links[0]!.status).toBe("PROPOSED");

    // Re-scan is idempotent: linking twice does not create a second link.
    const rescan = await call<{ links: Array<{ id: string }> }>(`/api/opportunities/${a.id}/block-links/scan`, MP, "POST", {});
    expect(rescan.body.links[0]!.id).toBe(scan.body.links[0]!.id);
    const all = await call<{ links: unknown[] }>(`/api/block-links?opportunity_id=${a.id}`, MP);
    expect(all.body.links).toHaveLength(1);

    // Human confirms the link. BOTH opportunities remain, with their own economics.
    const decided = await call<{ status: string }>(`/api/block-links/${scan.body.links[0]!.id}/decide`, MP, "POST", { decision: "CONFIRMED" });
    expect(decided.status).toBe(200);
    expect(decided.body.status).toBe("CONFIRMED");
    const aAfter = await call<OpportunityRow>(`/api/opportunities/${a.id}`, MP);
    const bAfter = await call<OpportunityRow>(`/api/opportunities/${b.id}`, MP);
    expect(aAfter.status).toBe(200);
    expect(bAfter.status).toBe(200);
    expect(aAfter.body.price_per_share).toBe(20);
    expect(bAfter.body.price_per_share).toBe(20.4);
  });

  it("AI can propose a block link but can NEVER decide one", async () => {
    const company = await createCompany("AI Link Co");
    const cls = await createSecurityClass(company, "Common");
    const a = await createOpportunity(env, AI_ACTOR, { company_id: company, opportunity_type: "SECONDARY_PURCHASE", title: "ai a", security_class_id: cls, seller_name: "S", quantity: 100, price_per_share: 5 });
    const b = await createOpportunity(env, AI_ACTOR, { company_id: company, opportunity_type: "SECONDARY_PURCHASE", title: "ai b", security_class_id: cls, seller_name: "S", quantity: 100, price_per_share: 5 });
    const { scanBlockLinks, decideBlockLink } = await import("../src/worker/services/investment");
    const links = await scanBlockLinks(env, AI_ACTOR, a.id);
    expect(links.length).toBeGreaterThan(0);
    expect(links[0]!.status).toBe("PROPOSED");
    await expect(decideBlockLink(env, AI_ACTOR, links[0]!.id, "CONFIRMED")).rejects.toMatchObject({ status: 403 });
    expect(b.id).not.toBe(a.id);
  });

  it("detection is deterministic: unrelated blocks on the same issuer produce no candidate", () => {
    const row = (over: Partial<OpportunityRow>): OpportunityRow =>
      ({
        id: "opp_1",
        company_id: "cc_1",
        opportunity_type: "SECONDARY_PURCHASE",
        title: "t",
        status: "NEW",
        source_channel: null,
        security_class_id: null,
        price_per_share: null,
        discount_premium: null,
        quantity: null,
        seller_name: null,
        broker_name: null,
        fees: null,
        carry: null,
        terms_json: "{}",
        privacy_label: "INTERNAL",
        firm_scope: "west-peek",
        created_by: "fu",
        created_at: "2026-01-01T00:00:00.000Z",
        ...over,
      }) as OpportunityRow;

    const target = row({ id: "opp_a", seller_name: "Seller A", quantity: 1000, price_per_share: 10, created_at: "2026-01-01T00:00:00.000Z" });
    const unrelated = row({ id: "opp_b", seller_name: "Seller Z", quantity: 25, price_per_share: 99, created_at: "2026-09-01T00:00:00.000Z" });
    expect(detectBlockLinkCandidates(target, [unrelated])).toHaveLength(0);

    const otherIssuer = row({ id: "opp_c", company_id: "cc_2", seller_name: "Seller A", quantity: 1000, price_per_share: 10 });
    expect(detectBlockLinkCandidates(target, [otherIssuer])).toHaveLength(0);
  });
});

// ── 3. Pricing observation statuses stay distinct ──

describe("3. pricing observations keep bid / ask / indication / executed distinct", () => {
  it("stores each observation type separately and never collapses them", async () => {
    const company = await createCompany("Pricing Co");
    const types = ["BID", "ASK", "INDICATION", "EXECUTED_TRANSACTION", "PRIMARY_ROUND", "INTERNAL_ESTIMATE"] as const;
    for (const [i, type] of types.entries()) {
      const res = await call(`/api/pricing-observations`, MP, "POST", {
        company_id: company,
        observation_type: type,
        price_per_share: 10 + i,
        observed_at: `2026-04-0${i + 1}`,
        source: `desk ${type}`,
      });
      expect(res.status).toBe(201);
    }
    const listed = await call<{ pricing_observations: Array<{ observation_type: string; price_per_share: number }> }>(
      `/api/pricing-observations?company_id=${company}`,
      MP,
    );
    expect(listed.body.pricing_observations).toHaveLength(types.length);
    expect(new Set(listed.body.pricing_observations.map((o) => o.observation_type)).size).toBe(types.length);

    const onlyBids = await call<{ pricing_observations: Array<{ observation_type: string }> }>(
      `/api/pricing-observations?company_id=${company}&observation_type=BID`,
      MP,
    );
    expect(onlyBids.body.pricing_observations).toHaveLength(1);
    expect(onlyBids.body.pricing_observations[0]!.observation_type).toBe("BID");
  });

  it("an MNPI_SENSITIVE observation is invisible to a non-MP user (§11.7, not UI hiding)", async () => {
    const company = await createCompany("Sensitive Pricing Co");
    const created = await call(`/api/pricing-observations`, MP, "POST", {
      company_id: company,
      observation_type: "INDICATION",
      price_per_share: 42,
      observed_at: "2026-04-09",
      source: "restricted desk",
      privacy_label: "MNPI_SENSITIVE",
    });
    expect(created.status).toBe(201);
    const asMember = await call<{ pricing_observations: unknown[] }>(`/api/pricing-observations?company_id=${company}`, MEMBER);
    expect(asMember.body.pricing_observations).toHaveLength(0);
    const asMp = await call<{ pricing_observations: unknown[] }>(`/api/pricing-observations?company_id=${company}`, MP);
    expect(asMp.body.pricing_observations).toHaveLength(1);
  });
});

// ── 4. Transactions execute only behind the type-specific reserved receipt ──

describe("4. transaction execution is receipt-gated, non-replayable, and reversible", () => {
  it("refuses execution without a receipt and with a receipt for the wrong action/object", async () => {
    const company = await createCompany("Receipt Gate Co");
    const fund = await createFund();
    const cls = await createSecurityClass(company, "Series A");
    const txn = await draftTransaction(company, cls);

    const noReceipt = await call<{ error: string }>(`/api/transactions/${txn.id}/execute`, MP, "POST", { fund_id: fund });
    expect(noReceipt.status).toBe(409);
    expect(noReceipt.body.error).toBe("approval_required");

    // A receipt for a DIFFERENT reserved action does not authorize this execution.
    const wrongAction = await approvedCard("valuation.approve", "transaction", txn.id);
    const wrongActionRes = await call<{ error: string }>(`/api/transactions/${txn.id}/execute`, MP, "POST", { approval_receipt_id: wrongAction, fund_id: fund });
    expect(wrongActionRes.status).toBe(409);

    // A receipt for a different OBJECT does not authorize this execution either.
    const otherTxn = await draftTransaction(company, cls);
    const otherReceipt = await submitAndApprove(otherTxn.id);
    const wrongObject = await call<{ error: string }>(`/api/transactions/${txn.id}/execute`, MP, "POST", { approval_receipt_id: otherReceipt, fund_id: fund });
    expect(wrongObject.status).toBe(409);

    const stillDraft = await call<TxnRow>(`/api/transactions/${txn.id}`, MP);
    expect(stillDraft.body.status).toBe("DRAFT");
    const noPositions = await call<{ positions: unknown[] }>(`/api/positions?company_id=${company}`, MP);
    expect(noPositions.body.positions).toHaveLength(0);
  });

  it("executes once with a valid receipt, then refuses the replay (card consumed)", async () => {
    const company = await createCompany("Replay Co");
    const fund = await createFund();
    const cls = await createSecurityClass(company, "Series A");
    const txn = await draftTransaction(company, cls, { quantity: 10, price_per_share: 3 });
    const receipt = await submitAndApprove(txn.id);

    const first = await call<TxnRow>(`/api/transactions/${txn.id}/execute`, MP, "POST", { approval_receipt_id: receipt, fund_id: fund });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("EXECUTED");

    const replay = await call<{ error: string }>(`/api/transactions/${txn.id}/execute`, MP, "POST", { approval_receipt_id: receipt, fund_id: fund });
    expect(replay.status).toBe(409);
    const positions = await call<{ positions: Array<{ quantity: number }> }>(`/api/positions?company_id=${company}`, MP);
    expect(positions.body.positions).toHaveLength(1);
    expect(positions.body.positions[0]!.quantity).toBe(10);
  });

  it("secondary purchase / sale / follow-on / exit each require their OWN reserved action key", async () => {
    const company = await createCompany("Reserved Key Co");
    const fund = await createFund();
    const cls = await createSecurityClass(company, "Series B");
    const secondary = await createOpportunityApi(company, { opportunity_type: "SECONDARY_PURCHASE", title: "secondary buy" });

    const txn = await draftTransaction(company, cls, { opportunity_id: secondary.id, quantity: 100, price_per_share: 7 });
    const submitted = await call<TxnRow>(`/api/transactions/${txn.id}/submit`, MP, "POST", {});
    const card = await call<{ action_key: string }>(`/api/approvals/${submitted.body.approval_card_id}`, MP);
    expect(card.body.action_key).toBe("secondary_purchase.approve");

    // An investment.approve receipt cannot authorize a SECONDARY purchase execution.
    const wrong = await approvedCard("investment.approve", "transaction", txn.id);
    const refused = await call(`/api/transactions/${txn.id}/execute`, MP, "POST", { approval_receipt_id: wrong, fund_id: fund });
    expect(refused.status).toBe(409);

    const followOn = await draftTransaction(company, cls, { transaction_type: "FOLLOW_ON", quantity: 5, price_per_share: 9 });
    const followOnSubmitted = await call<TxnRow>(`/api/transactions/${followOn.id}/submit`, MP, "POST", {});
    const followOnCard = await call<{ action_key: string }>(`/api/approvals/${followOnSubmitted.body.approval_card_id}`, MP);
    expect(followOnCard.body.action_key).toBe("follow_on.approve");

    const exit = await draftTransaction(company, cls, { transaction_type: "EXIT_FULL", quantity: 5, price_per_share: 30 });
    const exitSubmitted = await call<TxnRow>(`/api/transactions/${exit.id}/submit`, MP, "POST", {});
    const exitCard = await call<{ action_key: string }>(`/api/approvals/${exitSubmitted.body.approval_card_id}`, MP);
    expect(exitCard.body.action_key).toBe("exit.approve");
  });

  it("a non-MP cannot approve an investment card, so the transaction cannot execute", async () => {
    const company = await createCompany("Non MP Co");
    const fund = await createFund();
    const cls = await createSecurityClass(company, "Series A");
    const txn = await draftTransaction(company, cls);
    const submitted = await call<TxnRow>(`/api/transactions/${txn.id}/submit`, MP, "POST", {});
    const decision = await call<{ error: string }>(`/api/approvals/${submitted.body.approval_card_id}/decide`, MEMBER, "POST", { decision: "approved" });
    expect(decision.status).toBe(403);
    const state = await call<TxnRow>(`/api/transactions/${txn.id}`, MP);
    expect(state.body.status).toBe("PENDING_APPROVAL");
    const blocked = await call(`/api/transactions/${txn.id}/execute`, MP, "POST", { approval_receipt_id: submitted.body.approval_card_id, fund_id: fund });
    expect(blocked.status).toBe(409);
  });

  it("sell-side relieves cost basis pro-rata and closes the position at zero", async () => {
    const company = await createCompany("Sell Side Co");
    const fund = await createFund();
    const cls = await createSecurityClass(company, "Series A");
    const buy = await draftTransaction(company, cls, { quantity: 100, price_per_share: 10 });
    const buyReceipt = await submitAndApprove(buy.id);
    await call(`/api/transactions/${buy.id}/execute`, MP, "POST", { approval_receipt_id: buyReceipt, fund_id: fund });

    const partial = await draftTransaction(company, cls, { transaction_type: "EXIT_PARTIAL", quantity: 40, price_per_share: 25, fees: 100 });
    const partialReceipt = await submitAndApprove(partial.id);
    const partialRes = await call<TxnRow>(`/api/transactions/${partial.id}/execute`, MP, "POST", { approval_receipt_id: partialReceipt, fund_id: fund });
    expect(partialRes.status).toBe(200);
    let positions = await call<{ positions: Array<{ quantity: number; cost_basis: number; status: string }> }>(`/api/positions?company_id=${company}`, MP);
    expect(positions.body.positions[0]!.quantity).toBe(60);
    expect(positions.body.positions[0]!.cost_basis).toBeCloseTo(600, 6);

    const rest = await draftTransaction(company, cls, { transaction_type: "EXIT_FULL", quantity: 60, price_per_share: 30 });
    const restReceipt = await submitAndApprove(rest.id);
    await call(`/api/transactions/${rest.id}/execute`, MP, "POST", { approval_receipt_id: restReceipt, fund_id: fund });
    positions = await call<{ positions: Array<{ quantity: number; cost_basis: number; status: string }> }>(`/api/positions?company_id=${company}`, MP);
    expect(positions.body.positions[0]!.quantity).toBe(0);
    expect(positions.body.positions[0]!.status).toBe("CLOSED");
  });

  it("selling more than the position holds is refused (no negative position)", async () => {
    const company = await createCompany("Oversell Co");
    const fund = await createFund();
    const cls = await createSecurityClass(company, "Series A");
    const buy = await draftTransaction(company, cls, { quantity: 10, price_per_share: 10 });
    const buyReceipt = await submitAndApprove(buy.id);
    await call(`/api/transactions/${buy.id}/execute`, MP, "POST", { approval_receipt_id: buyReceipt, fund_id: fund });

    const oversell = await draftTransaction(company, cls, { transaction_type: "EXIT_FULL", quantity: 25, price_per_share: 12 });
    const receipt = await submitAndApprove(oversell.id);
    const res = await call<{ error: string }>(`/api/transactions/${oversell.id}/execute`, MP, "POST", { approval_receipt_id: receipt, fund_id: fund });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("insufficient_position");
    const positions = await call<{ positions: Array<{ quantity: number }> }>(`/api/positions?company_id=${company}`, MP);
    expect(positions.body.positions[0]!.quantity).toBe(10);
  });

  it("void is MP-reserved, reverses the recorded position effect, and preserves the record", async () => {
    const company = await createCompany("Void Co");
    const fund = await createFund();
    const cls = await createSecurityClass(company, "Series A");
    const txn = await draftTransaction(company, cls, { quantity: 20, price_per_share: 5 });
    const receipt = await submitAndApprove(txn.id);
    await call(`/api/transactions/${txn.id}/execute`, MP, "POST", { approval_receipt_id: receipt, fund_id: fund });

    const withoutReceipt = await call<{ error: string }>(`/api/transactions/${txn.id}/void`, MP, "POST", {});
    expect(withoutReceipt.status).toBe(409);

    const voidReceipt = await approvedCard("transaction.void", "transaction", txn.id);
    const voided = await call<TxnRow>(`/api/transactions/${txn.id}/void`, MP, "POST", { approval_receipt_id: voidReceipt });
    expect(voided.status).toBe(200);
    expect(voided.body.status).toBe("VOID");

    const positions = await call<{ positions: Array<{ quantity: number; cost_basis: number }> }>(`/api/positions?company_id=${company}`, MP);
    expect(positions.body.positions[0]!.quantity).toBe(0);
    expect(positions.body.positions[0]!.cost_basis).toBeCloseTo(0, 6);
    // The transaction row itself is never deleted — history stays readable.
    const stillThere = await call<TxnRow>(`/api/transactions/${txn.id}`, MP);
    expect(stillThere.status).toBe(200);
  });

  it("transaction parties preserve seller / broker / fund-entity provenance", async () => {
    const company = await createCompany("Party Co");
    const cls = await createSecurityClass(company, "Series A");
    const txn = await draftTransaction(company, cls, {
      parties: [
        { party_type: "SELLER", party_name: "Employee Seller" },
        { party_type: "BROKER", party_name: "Broker X" },
      ],
    });
    const added = await call(`/api/transactions/${txn.id}/parties`, MP, "POST", { party_type: "FUND_ENTITY", party_name: "WP Fund I LP" });
    expect(added.status).toBe(201);
    const fetched = await call<{ parties: Array<{ party_type: string; party_name: string }> }>(`/api/transactions/${txn.id}`, MP);
    expect(fetched.body.parties.map((p) => p.party_type).sort()).toEqual(["BROKER", "FUND_ENTITY", "SELLER"]);
  });
});

// ── 5. Deal math: manual always available; CALCULATED only from verified formulas ──

describe("5. deal math packets (D6)", () => {
  it("manual entry works even with inputs missing, and records the missing set", async () => {
    const company = await createCompany("Manual Math Co");
    const opp = await createOpportunityApi(company, { opportunity_type: "EARLY_STAGE_PRIMARY", title: "primary" });
    const packet = await call<{ id: string; math_quality_status: string; missing_inputs_json: string; entry_mode: string; moic: number }>(
      `/api/opportunities/${opp.id}/deal-math`,
      MP,
      "POST",
      { deal_type: "EARLY_STAGE_PRIMARY", source_inputs: { check_size: 1_000_000 }, moic: 4.2, margin_of_safety_note: "hand-worked" },
    );
    expect(packet.status).toBe(201);
    expect(packet.body.entry_mode).toBe("MANUAL");
    expect(packet.body.math_quality_status).toBe("INPUTS_MISSING");
    expect(JSON.parse(packet.body.missing_inputs_json)).toContain("round_size");
    expect(packet.body.moic).toBe(4.2);

    const calc = await call<{ error: string; detail: string }>(`/api/opportunities/${opp.id}/deal-math/calculate`, MP, "POST", {});
    expect(calc.status).toBe(409);
    expect(calc.body.error).toBe("inputs_missing");
  });

  it("CALCULATED fills only verified-formula metrics and leaves tvpi/dpi untouched", async () => {
    const company = await createCompany("Calc Math Co");
    const opp = await createOpportunityApi(company, { opportunity_type: "EARLY_STAGE_PRIMARY", title: "primary calc" });
    await call(`/api/opportunities/${opp.id}/deal-math`, MP, "POST", {
      deal_type: "EARLY_STAGE_PRIMARY",
      source_inputs: {
        check_size: 1_000_000,
        round_size: 5_000_000,
        pre_money: 20_000_000,
        exit_value: 500_000_000,
        future_dilution_pct: 30,
        hold_years: 7,
        fund_size: 30_000_000,
      },
    });
    const calc = await call<{ id: string; entry_mode: string; valuation: number; ownership_at_close: number; moic: number; tvpi: number | null; dpi: number | null; math_quality_status: string }>(
      `/api/opportunities/${opp.id}/deal-math/calculate`,
      MP,
      "POST",
      {},
    );
    expect(calc.status).toBe(200);
    expect(calc.body.entry_mode).toBe("CALCULATED");
    expect(calc.body.valuation).toBe(25_000_000); // pre + round (verified in docs/DEAL_MATH_VERIFICATION.md)
    expect(calc.body.ownership_at_close).toBeCloseTo(4, 9); // 1M / 25M = 4%
    expect(calc.body.moic).toBeGreaterThan(0);
    expect(calc.body.tvpi).toBeNull(); // no verified formula → never machine-filled
    expect(calc.body.dpi).toBeNull();
    expect(calc.body.math_quality_status).toBe("DRAFT_MATH_COMPLETE");

    // The assumption ledger is append-only and records the calculation.
    const packet = await call<{ ledger: Array<{ change_json: string }> }>(`/api/deal-math-packets/${calc.body.id}`, MP);
    const kinds = packet.body.ledger.map((l) => (JSON.parse(l.change_json) as { kind: string }).kind);
    expect(kinds).toContain("packet_created");
    expect(kinds).toContain("calculated");
    await expect(t.db.prepare("UPDATE assumption_ledger SET change_json = '{}' WHERE packet_id = ?1").bind(calc.body.id).run()).rejects.toThrow(/append-only/);
    await expect(t.db.prepare("DELETE FROM assumption_ledger WHERE packet_id = ?1").bind(calc.body.id).run()).rejects.toThrow(/append-only/);
  });

  it("a deal type with no verified formula refuses to calculate but keeps manual entry open", async () => {
    const company = await createCompany("Unsupported Math Co");
    const opp = await createOpportunityApi(company, { opportunity_type: "OTHER", title: "other" });
    await call(`/api/opportunities/${opp.id}/deal-math`, MP, "POST", { deal_type: "OTHER", source_inputs: {}, moic: 2 });
    const calc = await call<{ error: string }>(`/api/opportunities/${opp.id}/deal-math/calculate`, MP, "POST", {});
    expect(calc.status).toBe(400);
    expect(calc.body.error).toBe("unsupported_deal_type");
  });

  it("human review moves math quality, and any later edit drops IC readiness", async () => {
    const company = await createCompany("Review Math Co");
    const opp = await createOpportunityApi(company, { opportunity_type: "SECONDARY_SALE", title: "sale" });
    const packet = await call<{ id: string }>(`/api/opportunities/${opp.id}/deal-math`, MP, "POST", {
      deal_type: "SECONDARY_SALE",
      source_inputs: { deal_size: 1_000_000, round_price: 10, secondary_price: 8 },
    });
    const reviewed = await call<{ math_quality_status: string; ic_ready: number; reviewed_by: string }>(
      `/api/deal-math-packets/${packet.body.id}/review`,
      MP,
      "POST",
      { to: "IC_READY" },
    );
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.ic_ready).toBe(1);
    expect(reviewed.body.reviewed_by).toBe("fu_scooter_taylor");

    const edited = await call<{ ic_ready: number; reviewed_by: string | null }>(`/api/deal-math-packets/${packet.body.id}`, MP, "PATCH", { moic: 1.9 });
    expect(edited.status).toBe(200);
    expect(edited.body.ic_ready).toBe(0);
    expect(edited.body.reviewed_by).toBeNull();
  });
});

// ── 6. IC packets: contradictions stay visible; AI drafts but never decides ──

describe("6. IC packet, decision, and dissent", () => {
  async function icReadyOpportunity(companyName: string): Promise<{ company: string; opportunity: OpportunityRow; packetId: string }> {
    const company = await createCompany(companyName);
    const opp = await createOpportunityApi(company, { opportunity_type: "EARLY_STAGE_PRIMARY", title: "ic candidate" });
    const dm = await call<{ id: string }>(`/api/opportunities/${opp.id}/deal-math`, MP, "POST", {
      deal_type: "EARLY_STAGE_PRIMARY",
      source_inputs: { check_size: 500_000, round_size: 4_000_000, pre_money: 16_000_000, exit_value: 200_000_000, future_dilution_pct: 25, hold_years: 6, fund_size: 30_000_000 },
    });
    for (const to of ["SCREENING", "DILIGENCE", "IC_READY"]) {
      const res = await call(`/api/opportunities/${opp.id}/transition`, MP, "POST", { to });
      expect(res.status).toBe(200);
    }
    return { company, opportunity: opp, packetId: dm.body.id };
  }

  it("an unresolved material contradiction opened AFTER assembly still reaches the decision", async () => {
    const { company, opportunity, packetId } = await icReadyOpportunity("Contradiction IC Co");
    const packet = await call<{ id: string; unresolved_contradictions_json: string }>("/api/ic/packets", MP, "POST", {
      opportunity_id: opportunity.id,
      deal_math_packet_id: packetId,
    });
    expect(packet.status).toBe(201);
    expect(JSON.parse(packet.body.unresolved_contradictions_json)).toHaveLength(0);

    // A HIGH-materiality contradiction opens after the packet was assembled.
    const a = await createClaimApi(company, "arr", "$4M", "ARR is $4M");
    const b = await createClaimApi(company, "arr", "$6M", "ARR is $6M");
    const contradiction = await call<{ id: string }>("/api/contradictions", MP, "POST", {
      contradiction_type: "VALUE",
      topic: "arr",
      company_id: company,
      materiality: "HIGH",
      claim_links: [
        { claim_id: a, side_label: "founder deck" },
        { claim_id: b, side_label: "data room" },
      ],
    });
    expect(contradiction.status).toBe(201);

    const read = await call<{ unresolved_material_contradictions_current: Array<{ id: string }> }>(`/api/ic/packets/${packet.body.id}`, MP);
    expect(read.body.unresolved_material_contradictions_current.map((c) => c.id)).toContain(contradiction.body.id);

    // Submission surfaces the count on the approval card the MP will see.
    const submitted = await call<{ approval_card_id: string }>(`/api/ic/packets/${packet.body.id}/submit`, MP, "POST", {});
    expect(submitted.status).toBe(200);
    const card = await call<{ payload_json: string }>(`/api/approvals/${submitted.body.approval_card_id}`, MP);
    expect(JSON.parse(card.body.payload_json).unresolved_material_contradictions).toBe(1);
  });

  it("APPROVE requires an approved receipt; the receipt is consumed and cannot be replayed", async () => {
    const { opportunity, packetId } = await icReadyOpportunity("Approve IC Co");
    const packet = await call<{ id: string }>("/api/ic/packets", MP, "POST", { opportunity_id: opportunity.id, deal_math_packet_id: packetId });
    const submitted = await call<{ approval_card_id: string }>(`/api/ic/packets/${packet.body.id}/submit`, MP, "POST", {});

    const noReceipt = await call<{ error: string }>(`/api/ic/packets/${packet.body.id}/decide`, MP, "POST", { decision: "APPROVE", rationale: "conviction" });
    expect(noReceipt.status).toBe(409);
    expect(noReceipt.body.error).toBe("approval_required");

    const decided = await call(`/api/approvals/${submitted.body.approval_card_id}/decide`, MP, "POST", { decision: "approved" });
    expect(decided.status).toBe(200);

    const recorded = await call<{ id: string; decision: string; decided_by: string }>(`/api/ic/packets/${packet.body.id}/decide`, MP, "POST", {
      decision: "APPROVE",
      rationale: "conviction",
      receipt_id: submitted.body.approval_card_id,
    });
    expect(recorded.status).toBe(201);
    expect(recorded.body.decision).toBe("APPROVE");
    expect(recorded.body.decided_by).toBe("fu_scooter_taylor");

    // Packet DECIDED, opportunity IC_DECIDED, receipt consumed.
    const after = await call<{ status: string; decisions: unknown[] }>(`/api/ic/packets/${packet.body.id}`, MP);
    expect(after.body.status).toBe("DECIDED");
    expect(after.body.decisions).toHaveLength(1);
    const opp = await call<{ status: string }>(`/api/opportunities/${opportunity.id}`, MP);
    expect(opp.body.status).toBe("IC_DECIDED");
    const card = await call<{ state: string }>(`/api/approvals/${submitted.body.approval_card_id}`, MP);
    expect(card.body.state).toBe("executed");

    const replay = await call<{ error: string }>(`/api/ic/packets/${packet.body.id}/decide`, MP, "POST", {
      decision: "APPROVE",
      receipt_id: submitted.body.approval_card_id,
    });
    expect(replay.status).toBe(409);
  });

  it("REJECT is recorded by an MP without a capital receipt and resolves the pending card", async () => {
    const { opportunity, packetId } = await icReadyOpportunity("Reject IC Co");
    const packet = await call<{ id: string }>("/api/ic/packets", MP, "POST", { opportunity_id: opportunity.id, deal_math_packet_id: packetId });
    const submitted = await call<{ approval_card_id: string }>(`/api/ic/packets/${packet.body.id}/submit`, MP, "POST", {});
    const rejected = await call<{ decision: string }>(`/api/ic/packets/${packet.body.id}/decide`, MP, "POST", { decision: "REJECT", rationale: "pass on price" });
    expect(rejected.status).toBe(201);
    expect(rejected.body.decision).toBe("REJECT");
    const card = await call<{ state: string }>(`/api/approvals/${submitted.body.approval_card_id}`, MP);
    expect(card.body.state).toBe("rejected");
    const opp = await call<{ status: string }>(`/api/opportunities/${opportunity.id}`, MP);
    expect(opp.body.status).toBe("IC_DECIDED");
  });

  it("a non-MP human cannot record any IC decision", async () => {
    const { opportunity, packetId } = await icReadyOpportunity("Non MP IC Co");
    const packet = await call<{ id: string }>("/api/ic/packets", MP, "POST", { opportunity_id: opportunity.id, deal_math_packet_id: packetId });
    await call(`/api/ic/packets/${packet.body.id}/submit`, MP, "POST", {});
    const res = await call<{ error: string }>(`/api/ic/packets/${packet.body.id}/decide`, MEMBER, "POST", { decision: "REJECT" });
    expect(res.status).toBe(403);
  });

  it("AI may draft a packet (with its run trace) but can NEVER record the decision or a dissent", async () => {
    const { opportunity, packetId } = await icReadyOpportunity("AI Draft IC Co");
    // AI drafting requires the ai_run_id trace.
    await expect(assembleIcPacket(env, AI_ACTOR, { opportunity_id: opportunity.id, deal_math_packet_id: packetId })).rejects.toMatchObject({ status: 400 });
    const drafted = await assembleIcPacket(env, AI_ACTOR, { opportunity_id: opportunity.id, deal_math_packet_id: packetId, ai_run_id: "air_fixture" });
    expect(drafted.drafted_by_type).toBe("AI");
    expect(drafted.ai_run_id).toBe("air_fixture");

    // The AI cannot decide — investment.approve is human-reserved (DENY, not 409).
    await expect(recordIcDecision(env, AI_ACTOR, drafted.id, "APPROVE", "ai says yes")).rejects.toMatchObject({ status: 403 });
    await expect(recordIcDecision(env, AI_ACTOR, drafted.id, "REJECT", "ai says no")).rejects.toMatchObject({ status: 403 });

    // A human MP decides; the AI still cannot attach a dissent record.
    const receipt = await approvedCard("investment.approve", "ic_packet", drafted.id);
    const decision = await recordIcDecision(env, MP_ACTOR, drafted.id, "APPROVE", "human conviction", receipt);
    expect(decision.decision).toBe("APPROVE");
    await expect(recordDissent(env, AI_ACTOR, decision.id, "ai dissent")).rejects.toMatchObject({ status: 403 });

    const dissent = await recordDissent(env, MEMBER_ACTOR, decision.id, "sizing too large for the reserve plan");
    expect(dissent).toBeTruthy();
    await expect(t.db.prepare("UPDATE ic_decision SET decision = 'REJECT' WHERE id = ?1").bind(decision.id).run()).rejects.toThrow(/append-only/);
    await expect(t.db.prepare("DELETE FROM ic_decision WHERE id = ?1").bind(decision.id).run()).rejects.toThrow(/append-only/);
    await expect(t.db.prepare("UPDATE dissent_record SET dissent_text = 'x' WHERE ic_decision_id = ?1").bind(decision.id).run()).rejects.toThrow(/append-only/);
  });

  it("DEFER returns the packet to DRAFT and leaves the opportunity open for more work", async () => {
    const { opportunity, packetId } = await icReadyOpportunity("Defer IC Co");
    const packet = await call<{ id: string }>("/api/ic/packets", MP, "POST", { opportunity_id: opportunity.id, deal_math_packet_id: packetId });
    const submitted = await call<{ approval_card_id: string }>(`/api/ic/packets/${packet.body.id}/submit`, MP, "POST", {});
    const deferred = await call<{ decision: string }>(`/api/ic/packets/${packet.body.id}/decide`, MP, "POST", { decision: "DEFER", rationale: "need Q1 data" });
    expect(deferred.status).toBe(201);
    const after = await call<{ status: string }>(`/api/ic/packets/${packet.body.id}`, MP);
    expect(after.body.status).toBe("DRAFT");
    const opp = await call<{ status: string }>(`/api/opportunities/${opportunity.id}`, MP);
    expect(opp.body.status).toBe("IC_READY");
    const card = await call<{ state: string }>(`/api/approvals/${submitted.body.approval_card_id}`, MP);
    expect(card.body.state).toBe("revise_requested");
  });
});

// ── 7. Opportunity lifecycle + spine ──

describe("7. opportunity lifecycle and the event spine", () => {
  it("refuses illegal lifecycle transitions and records every legal one on the spine", async () => {
    const company = await createCompany("Lifecycle Co");
    const opp = await createOpportunityApi(company, { title: "lifecycle" });
    const skip = await call<{ error: string }>(`/api/opportunities/${opp.id}/transition`, MP, "POST", { to: "IC_DECIDED" });
    expect(skip.status).toBe(409);

    for (const to of ["SCREENING", "DILIGENCE", "PASS"]) {
      const res = await call(`/api/opportunities/${opp.id}/transition`, MP, "POST", { to });
      expect(res.status).toBe(200);
    }
    const terminal = await call<{ error: string }>(`/api/opportunities/${opp.id}/transition`, MP, "POST", { to: "SCREENING" });
    expect(terminal.status).toBe(409);

    const events = await t.db
      .prepare("SELECT event_type FROM event_record WHERE object_type = 'investment_opportunity' AND object_id = ?1 ORDER BY created_at, id")
      .bind(opp.id)
      .all<{ event_type: string }>();
    const types = (events.results ?? []).map((e) => e.event_type);
    expect(types[0]).toBe("investment.opportunity_created");
    expect(types.filter((x) => x === "investment.opportunity_transitioned")).toHaveLength(3);
  });

  it("a transaction whose approval card is refused can be resubmitted, and is never auto-VOIDed", async () => {
    const company = await createCompany("Refused Submission Co");
    const cls = await createSecurityClass(company, "Series A");
    const txn = await draftTransaction(company, cls);

    const submitted = await call<{ approval_card_id: string; status: string }>(`/api/transactions/${txn.id}/submit`, MP, "POST", {});
    expect(submitted.status).toBe(200);
    expect(submitted.body.status).toBe("PENDING_APPROVAL");

    // While the card is genuinely pending, resubmission is refused — no going around a live review.
    const early = await call<{ error: string }>(`/api/transactions/${txn.id}/submit`, MP, "POST", {});
    expect(early.status).toBe(409);
    expect(early.body.error).toBe("illegal_state");

    // The reviewer refuses the CARD on the generic Approvals surface, which knows
    // nothing about `transaction`. Without the card-disposition rule the transaction
    // would keep a stale PENDING_APPROVAL forever with no way to request a new card.
    const decided = await call(`/api/approvals/${submitted.body.approval_card_id}/decide`, MP, "POST", {
      decision: "rejected",
      note: "price is above the approved range",
    });
    expect(decided.status).toBe(200);

    const resubmitted = await call<{ approval_card_id: string; status: string }>(`/api/transactions/${txn.id}/submit`, MP, "POST", {});
    expect(resubmitted.status).toBe(200);
    expect(resubmitted.body.status).toBe("PENDING_APPROVAL");
    expect(resubmitted.body.approval_card_id).not.toBe(submitted.body.approval_card_id);

    // A refused submission booked nothing, so it is NOT voided: VOID means "reverse a
    // booked transaction" and stays MP-reserved.
    const row = await t.db.prepare('SELECT status FROM "transaction" WHERE id = ?1').bind(txn.id).first<{ status: string }>();
    expect(row!.status).toBe("PENDING_APPROVAL");
    // The stale rejected receipt can never execute.
    const stale = await call(`/api/transactions/${txn.id}/execute`, MP, "POST", { approval_receipt_id: submitted.body.approval_card_id });
    expect(stale.status).toBe(409);
  });

  it("the executed transaction journey lands typed events on the ONE spine (D15)", async () => {
    const company = await createCompany("Spine Co");
    const fund = await createFund();
    const cls = await createSecurityClass(company, "Series A");
    const txn = await draftTransaction(company, cls, { quantity: 5, price_per_share: 2 });
    const receipt = await submitAndApprove(txn.id);
    await call(`/api/transactions/${txn.id}/execute`, MP, "POST", { approval_receipt_id: receipt, fund_id: fund });

    const events = await t.db
      .prepare("SELECT event_type FROM event_record WHERE object_type = 'transaction' AND object_id = ?1 ORDER BY created_at, id")
      .bind(txn.id)
      .all<{ event_type: string }>();
    const types = (events.results ?? []).map((e) => e.event_type);
    expect(types).toContain("investment.transaction_created");
    expect(types).toContain("investment.transaction_submitted");
    expect(types).toContain("investment.transaction_executed");
    const positionEvents = await t.db
      .prepare("SELECT event_type FROM event_record WHERE object_type = 'position' ORDER BY created_at, id")
      .all<{ event_type: string }>();
    expect((positionEvents.results ?? []).map((e) => e.event_type)).toContain("investment.position_opened");
  });
});

// ── 8. Forbidden-claim discipline: no legal/compliance conclusion is ever stored ──

describe("8. no legal, compliance, or brokerage conclusion is stored anywhere in P6", () => {
  it("no P6 table carries a compliance/legal conclusion column", async () => {
    const p6Tables = [
      "security_class",
      "investment_opportunity",
      "opportunity_block_link",
      "transaction",
      "transaction_party",
      "position",
      "ownership_snapshot",
      "pricing_observation",
      "deal_math_packet",
      "deal_math_assumption",
      "assumption_ledger",
      "ic_packet",
      "ic_decision",
      "dissent_record",
    ];
    for (const table of p6Tables) {
      const cols = await t.db.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>();
      const names = (cols.results ?? []).map((c) => c.name);
      expect(names.length, table).toBeGreaterThan(0);
      for (const forbidden of ["compliance_status", "legal_status", "mnpi_cleared", "brokerage_cleared", "is_compliant"]) {
        expect(names, `${table}.${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("ownership snapshots keep their dilution assumptions and stated source", async () => {
    const company = await createCompany("Ownership Co");
    const fund = await createFund();
    const res = await call<{ id: string; source: string; dilution_assumptions_json: string }>("/api/ownership-snapshots", MP, "POST", {
      company_id: company,
      fund_id: fund,
      as_of_date: "2026-06-30",
      ownership_pct: 4.2,
      fully_diluted_shares: 12_500_000,
      dilution_assumptions: { option_pool_pct: 10, safe_conversion: "assumed at cap" },
      source: "cap table export 2026-06-30",
    });
    expect(res.status).toBe(201);
    expect(res.body.source).toBe("cap table export 2026-06-30");
    expect(JSON.parse(res.body.dilution_assumptions_json).option_pool_pct).toBe(10);
  });
});

/**
 * Pre-dated holdings (migration 0050).
 *
 * The lifecycle machine deliberately offers no shortcut to CLOSED, which is right for anything
 * decided from here on and wrong for history: the firm's first investment was a $10K SPV that
 * closed before the fund existed and never saw an IC. The lane exists so that fact can be recorded
 * without either minting an ic_decision that never happened or parking a closed holding at NEW.
 *
 * What these assert is the thing that makes the lane safe rather than a hole in the machine: a
 * backfilled row is permanently distinguishable from a decision this firm made.
 */
describe("backfilling a holding that predates the system", () => {
  async function newOpportunity(title: string): Promise<string> {
    const company = await createCompany();
    const res = await call<{ id: string }>("/api/opportunities", MP, "POST", {
      company_id: company,
      opportunity_type: "EARLY_STAGE_PRIMARY",
      title,
    });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  it("reaches CLOSED directly, which the lifecycle machine refuses", async () => {
    const id = await newOpportunity(`backfill closed ${crypto.randomUUID().slice(0, 8)}`);

    // The ordinary path cannot get there — that is the whole reason this lane exists.
    const walked = await call(`/api/opportunities/${id}/transition`, MP, "POST", { to: "CLOSED" });
    expect(walked.status).toBe(409);

    const res = await call<{ status: string; backfilled_at: string | null; as_of_date: string | null }>(
      `/api/opportunities/${id}/backfill`, MP, "POST",
      { to: "CLOSED", reason: "SPV closed before the fund existed; never went to IC", as_of_date: "2025-08-06" },
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CLOSED");
    expect(res.body.as_of_date).toBe("2025-08-06");
    // The mark is the point: a reader can tell this was entered, not decided.
    expect(res.body.backfilled_at).toBeTruthy();
  });

  it("records WHY, and refuses a reason too thin to inform anyone", async () => {
    const id = await newOpportunity(`backfill reason ${crypto.randomUUID().slice(0, 8)}`);
    const thin = await call(`/api/opportunities/${id}/backfill`, MP, "POST", { to: "CLOSED", reason: "old" });
    expect(thin.status).toBe(400);

    const ok = await call<{ backfill_reason: string }>(
      `/api/opportunities/${id}/backfill`, MP, "POST",
      { to: "CLOSED", reason: "angel cheque predating the fund, entered as history" },
    );
    expect(ok.status).toBe(200);
    expect(ok.body.backfill_reason).toContain("predating the fund");
  });

  it("never overwrites a real lifecycle, and never runs twice", async () => {
    const id = await newOpportunity(`backfill guard ${crypto.randomUUID().slice(0, 8)}`);

    // A deal the firm has actually started working is not history and may not be rewritten as it.
    expect((await call(`/api/opportunities/${id}/transition`, MP, "POST", { to: "SCREENING" })).status).toBe(200);
    const live = await call(`/api/opportunities/${id}/backfill`, MP, "POST", {
      to: "CLOSED", reason: "trying to rewrite a deal that is genuinely in flight",
    });
    expect(live.status).toBe(409);
    expect(live.body.error).toBe("not_backfillable");

    const other = await newOpportunity(`backfill once ${crypto.randomUUID().slice(0, 8)}`);
    const first = await call(`/api/opportunities/${other}/backfill`, MP, "POST", {
      to: "CLOSED", reason: "first and only entry of this historical holding",
    });
    expect(first.status).toBe(200);
    const second = await call(`/api/opportunities/${other}/backfill`, MP, "POST", {
      to: "PASS", reason: "second attempt that must not be allowed to land",
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("already_backfilled");
  });

  it("leaves a trail that says the status was placed rather than walked", async () => {
    const id = await newOpportunity(`backfill trail ${crypto.randomUUID().slice(0, 8)}`);
    await call(`/api/opportunities/${id}/backfill`, MP, "POST", {
      to: "CLOSED", reason: "historical holding entered during commissioning",
    });
    const events = await t.db
      .prepare("SELECT event_type, payload_json FROM event_record WHERE object_id = ?1 ORDER BY created_at")
      .bind(id)
      .all<{ event_type: string; payload_json: string }>();
    const backfill = (events.results ?? []).find((e) => e.event_type === "investment.opportunity_backfilled");
    expect(backfill).toBeTruthy();
    // Anything reading the trail can distinguish the two without knowing this endpoint exists.
    expect(JSON.parse(backfill!.payload_json).backfill).toBe(true);
  });
});

/**
 * Placeholder economics (migration 0052).
 *
 * The firm's only investment is a closed SPV whose entry price and share count nobody has to hand.
 * The operator asked for editable stand-ins rather than empty fields, which is fine — but only
 * because they are marked. An unmarked stand-in gets charted and eventually reported to an LP, and
 * by then nobody can tell which figures were ever true.
 *
 * These assert the two properties that make a placeholder safe: it is always visibly provisional,
 * and the door that corrects it cannot become a general edit path for closed decisions.
 */
describe("values recorded as placeholders", () => {
  async function provisionalOpportunity(): Promise<string> {
    const company = await createCompany();
    const res = await call<{ id: string }>("/api/opportunities", MP, "POST", {
      company_id: company,
      opportunity_type: "EARLY_STAGE_PRIMARY",
      title: `provisional ${crypto.randomUUID().slice(0, 8)}`,
      price_per_share: 1,
      quantity: 10_000,
      placeholder_fields: ["price_per_share", "quantity"],
      placeholder_note: "stand-ins totalling the real amount invested",
    });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  it("is born provisional, and says which fields are", async () => {
    const id = await provisionalOpportunity();
    const got = await call<{ placeholder_fields: string; placeholder_note: string }>(`/api/opportunities/${id}`, MP);
    expect(JSON.parse(got.body.placeholder_fields)).toEqual(["price_per_share", "quantity"]);
    expect(got.body.placeholder_note).toContain("stand-ins");
  });

  it("can be corrected on a CLOSED record, which ordinary editing refuses", async () => {
    const id = await provisionalOpportunity();
    await call(`/api/opportunities/${id}/backfill`, MP, "POST", {
      to: "CLOSED",
      reason: "holding that predates the system, entered as history",
    });

    // The ordinary door is shut, and should be: a terminal opportunity is a decision.
    const edit = await call(`/api/opportunities/${id}`, MP, "PATCH", { price_per_share: 9 });
    expect(edit.status).toBe(409);

    // This one opens, because a placeholder was never a decision.
    const fixed = await call<{ price_per_share: number; placeholder_fields: string }>(
      `/api/opportunities/${id}/placeholders`, MP, "POST", { values: { price_per_share: 2.5 } },
    );
    expect(fixed.status).toBe(200);
    expect(fixed.body.price_per_share).toBe(2.5);
    // Corrected fields stop being provisional; the untouched one stays flagged.
    expect(JSON.parse(fixed.body.placeholder_fields)).toEqual(["quantity"]);
  });

  it("refuses to set a field that was never provisional", async () => {
    const id = await provisionalOpportunity();
    const res = await call(`/api/opportunities/${id}/placeholders`, MP, "POST", { values: { title: "sneaky rename" } });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_a_placeholder");
  });

  it("refuses a column the placeholder list has no business naming", async () => {
    // The list is data. If data could name a column and have it written, this route would be
    // arbitrary SQL with extra steps.
    const company = await createCompany();
    const made = await call<{ id: string }>("/api/opportunities", MP, "POST", {
      company_id: company,
      opportunity_type: "EARLY_STAGE_PRIMARY",
      title: `bad field ${crypto.randomUUID().slice(0, 8)}`,
      placeholder_fields: ["status"],
    });
    const res = await call(`/api/opportunities/${made.body.id}/placeholders`, MP, "POST", { values: { status: "CLOSED" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("not_settable");
  });

  it("clears the note once nothing is provisional any more", async () => {
    const id = await provisionalOpportunity();
    const done = await call<{ placeholder_fields: string; placeholder_note: string | null }>(
      `/api/opportunities/${id}/placeholders`, MP, "POST",
      { values: { price_per_share: 2.5, quantity: 4000 } },
    );
    expect(JSON.parse(done.body.placeholder_fields)).toEqual([]);
    // The warning must not outlive the thing it was warning about.
    expect(done.body.placeholder_note).toBeNull();
  });

  it("refuses on a record with nothing provisional", async () => {
    const company = await createCompany();
    const made = await call<{ id: string }>("/api/opportunities", MP, "POST", {
      company_id: company, opportunity_type: "EARLY_STAGE_PRIMARY", title: `solid ${crypto.randomUUID().slice(0, 8)}`,
    });
    const res = await call(`/api/opportunities/${made.body.id}/placeholders`, MP, "POST", { values: { price_per_share: 1 } });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("nothing_provisional");
  });

  it("leaves a trail naming what was confirmed and what is still provisional", async () => {
    const id = await provisionalOpportunity();
    await call(`/api/opportunities/${id}/placeholders`, MP, "POST", { values: { price_per_share: 3 } });
    const events = await t.db
      .prepare("SELECT payload_json FROM event_record WHERE object_id = ?1 AND event_type = 'investment.placeholders_confirmed'")
      .bind(id)
      .all<{ payload_json: string }>();
    expect(events.results).toHaveLength(1);
    const payload = JSON.parse(events.results![0]!.payload_json);
    expect(payload.confirmed).toEqual(["price_per_share"]);
    expect(payload.still_provisional).toEqual(["quantity"]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";

/**
 * Book it from the Portfolio row — Phase D (design §6, §12.4; decisions Q1 and Q5).
 *
 * WHAT THIS PINS. The owner's words: "there needs to be an easy intuitive way to book a company as
 * a real Fund I position and the MPs should be able to add the data there and save." The design's
 * answer, approved 18 Sep 2026: one Save on the row raises the one partner card, and APPROVING THAT
 * CARD EXECUTES THE BOOKING — no receipt paste, no third click.
 *
 *   1. One Save = share class → DRAFT → the `investment.approve` card. Nothing is booked by saving:
 *      asserted against `position`, not against the sentence the page shows.
 *   2. Approval books it. Exactly ONE position row afterwards, for the shares and the cost basis the
 *      partner approved, in the fund the DRAFT named — and the card is consumed, so the explicit
 *      execute route with the same receipt answers 409 and the holding is not doubled.
 *   3. The stand-ins heal from the partner's REAL figures (Sensori's $1 × 10,000 placeholder is
 *      replaced by what was typed, never the other way round).
 *   4. A second Save while one is in flight raises no second card (409 booking_in_flight).
 *   5. A rejected card reads "declined" on the row and books nothing; the draft can be resent.
 *   6. A draft with no fund (the older API shape) is approved-not-booked: the decision stands, the
 *      spine says why, `position` stays empty until the explicit route names the fund.
 *   7. Authority: a non-partner cannot approve, so cannot book; the reserve is an MP write; the
 *      sale door refuses an unbooked holding and opens exactly one SECONDARY_SALE on a booked one.
 *
 * Nothing here claims accounting, valuation or fund-performance correctness (AGENTS.md
 * §Validation honesty); it claims that what a partner approved is what got booked, once.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const OTHER_MP = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };
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

interface Holding {
  company_id: string;
  booked: boolean;
  standing: "unbooked" | "draft" | "awaiting" | "declined" | "booked";
  provisional: boolean;
  amount_in: number | null;
  opportunity_id: string | null;
  booking: { transaction_id: string; status: string; approval_card_id: string | null; card_state: string | null; fund_id: string | null; vehicle: string | null } | null;
  shares: { quantity: number; price_per_share: number | null } | null;
  reserve: { amount: number; as_of: string; note: string | null } | null;
  sale: { opportunity_id: string; status: string } | null;
}

async function holding(companyId: string): Promise<Holding> {
  const res = await call<{ holdings: Holding[] }>("/api/portfolio/holdings", MP);
  expect(res.status).toBe(200);
  const row = res.body.holdings.find((h) => h.company_id === companyId);
  expect(row, `company ${companyId} must be on the holdings list`).toBeTruthy();
  return row!;
}

async function positions(companyId: string): Promise<Array<{ id: string; fund_id: string; quantity: number; cost_basis: number; status: string; acquired_via_transaction_id: string | null }>> {
  const res = await call<{ positions: Array<{ id: string; fund_id: string; quantity: number; cost_basis: number; status: string; acquired_via_transaction_id: string | null }> }>(
    `/api/positions?company_id=${companyId}`,
    MP,
  );
  return res.body.positions;
}

async function createCompany(name: string): Promise<string> {
  const res = await call<{ id: string }>("/api/companies", MP, "POST", { canonical_name: name, sector: "Consumer" });
  expect(res.status).toBe(201);
  return res.body.id;
}

/** Sensori's shape: closed by backfill, stand-in price and count totalling the real amount. */
async function closedLikeSensori(companyId: string): Promise<string> {
  const created = await call<{ id: string }>("/api/opportunities", MP, "POST", {
    company_id: companyId,
    opportunity_type: "EARLY_STAGE_PRIMARY",
    title: "SPV, closed before the fund existed",
    source_channel: "SPV",
    price_per_share: 1,
    quantity: 10_000,
    terms: { vehicle: "SPV", amount_invested_usd: 10_000 },
    placeholder_fields: ["price_per_share", "quantity"],
    placeholder_note: "Entry price and share count are STAND-INS totalling the real amount invested.",
  });
  expect(created.status).toBe(201);
  const backfilled = await call(`/api/opportunities/${created.body.id}/backfill`, MP, "POST", {
    to: "CLOSED",
    reason: "SPV that closed before Fund I existed; never went through IC",
    as_of_date: "2025-08-06",
  });
  expect(backfilled.status).toBe(200);
  return created.body.id;
}

let fundId: string;

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_DOCUMENTS: t.docs });
  await t.db
    .prepare("INSERT INTO firm_user (id, email, full_name, status) VALUES ('fu_test_member', 'member@westpeek.ventures', 'Test Member', 'ACTIVE')")
    .run();
  await t.db.prepare("INSERT INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_test_member', 'role_investment_team')").run();
  const fund = await call<{ id: string }>("/api/funds", MP, "POST", { name: "Booking Fund I" });
  expect(fund.status).toBe(201);
  fundId = fund.body.id;
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("1. one Save raises the one partner card, and books nothing by itself", () => {
  let companyId: string;
  let opportunityId: string;
  let cardId: string;
  let txnId: string;

  it("the unbooked row is on the list, standing 'unbooked', with its stand-ins still provisional", async () => {
    companyId = await createCompany("Sensori-like Co");
    opportunityId = await closedLikeSensori(companyId);
    const row = await holding(companyId);
    expect(row.standing).toBe("unbooked");
    expect(row.booked).toBe(false);
    expect(row.provisional).toBe(true);
    expect(row.opportunity_id).toBe(opportunityId);
    expect(await positions(companyId)).toHaveLength(0);
  });

  it("refuses a save that neither picks a class nor names one, and one with a client-supplied nonsense amount", async () => {
    const neither = await call<{ error: string }>(`/api/holdings/${companyId}/book`, MP, "POST", {
      opportunity_id: opportunityId,
      price_per_share: 2.5,
      quantity: 4000,
      transaction_date: "2025-08-06",
      vehicle: "SPV",
      fund_id: fundId,
    });
    expect(neither.status).toBe(400);
    expect(neither.body.error).toBe("class_required");

    const negative = await call<{ error: string }>(`/api/holdings/${companyId}/book`, MP, "POST", {
      opportunity_id: opportunityId,
      class_name: "SPV interest",
      price_per_share: -2.5,
      quantity: 4000,
      transaction_date: "2025-08-06",
      vehicle: "SPV",
      fund_id: fundId,
    });
    expect(negative.status).toBe(400);
    expect(negative.body.error).toBe("invalid_input");

    // Gross and net are the ledger's arithmetic. A caller cannot hand them in: the keys are
    // dropped and the draft's figures are price × count, proved on the row below.
    const saved = await call<{ transaction: { id: string; gross_amount: number; net_amount: number; status: string } }>(`/api/holdings/${companyId}/book`, MP, "POST", {
      opportunity_id: opportunityId,
      class_name: "SPV interest",
      price_per_share: 2.5,
      quantity: 4000,
      gross_amount: 1,
      net_amount: 1,
      transaction_date: "2025-08-06",
      vehicle: "SPV",
      fund_id: fundId,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body.transaction.gross_amount).toBe(10_000);
    expect(saved.body.transaction.net_amount).toBe(10_000);
    expect(saved.body.transaction.status).toBe("PENDING_APPROVAL");
    expect(await positions(companyId), "nothing about saving reaches position").toHaveLength(0);
  });

  it("the save that exists drafted, healed the stand-ins from the REAL figures, and raised exactly one card", async () => {
    const row = await holding(companyId);
    expect(row.standing).toBe("awaiting");
    expect(row.booking, "the booking in flight is on the row").toBeTruthy();
    expect(row.booking!.status).toBe("PENDING_APPROVAL");
    expect(row.booking!.fund_id).toBe(fundId);
    expect(row.booking!.vehicle).toBe("SPV");
    cardId = row.booking!.approval_card_id!;
    txnId = row.booking!.transaction_id;
    expect(cardId).toMatch(/^apc_/);

    // The placeholders healed with the typed figures — 2.5 × 4,000, not $1 × 10,000.
    const opp = await call<{ placeholder_fields: string; price_per_share: number; quantity: number; placeholder_note: string | null }>(
      `/api/opportunities/${opportunityId}`,
      MP,
    );
    expect(JSON.parse(opp.body.placeholder_fields)).toEqual([]);
    expect(opp.body.price_per_share).toBe(2.5);
    expect(opp.body.quantity).toBe(4000);
    expect(opp.body.placeholder_note).toBeNull();
    expect((await holding(companyId)).provisional).toBe(false);

    const cards = await t.db
      .prepare("SELECT COUNT(*) AS n FROM approval_card WHERE object_type = 'transaction' AND object_id = ?1")
      .bind(txnId)
      .first<{ n: number }>();
    expect(cards!.n, "one card per booking").toBe(1);
    const card = await call<{ action_key: string; state: string; summary: string; payload_json: string }>(`/api/approvals/${cardId}`, MP);
    expect(card.body.action_key).toBe("investment.approve");
    expect(card.body.state).toBe("pending_review");
    expect(card.body.summary, "the card says what approving it does").toContain("Approving books the position");
    expect(await positions(companyId), "a draft plus a card is still not a position").toHaveLength(0);
  });

  it("a second Save while one is in flight raises no second card", async () => {
    const again = await call<{ error: string }>(`/api/holdings/${companyId}/book`, MP, "POST", {
      opportunity_id: opportunityId,
      class_name: "Another class",
      price_per_share: 2.5,
      quantity: 4000,
      transaction_date: "2025-08-06",
      vehicle: "SPV",
      fund_id: fundId,
    });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("booking_in_flight");
    const cards = await t.db.prepare("SELECT COUNT(*) AS n FROM approval_card WHERE object_type = 'transaction' AND object_id = ?1").bind(txnId).first<{ n: number }>();
    expect(cards!.n).toBe(1);
  });

  it("a non-partner cannot approve the card, so cannot book", async () => {
    const refused = await call<{ error: string }>(`/api/approvals/${cardId}/decide`, MEMBER, "POST", { decision: "approved" });
    expect(refused.status).toBe(403);
    expect(await positions(companyId)).toHaveLength(0);
    expect((await holding(companyId)).standing).toBe("awaiting");
  });

  it("APPROVAL BOOKS IT: exactly one position, the approved shares and cost, the fund the draft named", async () => {
    const decided = await call<{ state: string; booking?: { executed: boolean; position_id: string | null; reason: string } }>(
      `/api/approvals/${cardId}/decide`,
      OTHER_MP,
      "POST",
      { decision: "approved", note: "terms as drafted" },
    );
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(decided.body.booking?.executed, "the decision's own response says it booked").toBe(true);
    expect(decided.body.state, "the card is consumed by the booking, so it reads executed").toBe("executed");

    const rows = await positions(companyId);
    expect(rows, "approval is what creates the position, and it must have — once").toHaveLength(1);
    expect(rows[0]!.quantity).toBe(4000);
    expect(rows[0]!.cost_basis).toBe(10_000);
    expect(rows[0]!.fund_id).toBe(fundId);
    expect(rows[0]!.status).toBe("OPEN");
    expect(rows[0]!.acquired_via_transaction_id).toBe(txnId);
    expect(decided.body.booking?.position_id).toBe(rows[0]!.id);

    const txn = await call<{ status: string }>(`/api/transactions/${txnId}`, MP);
    expect(txn.body.status).toBe("EXECUTED");
    const row = await holding(companyId);
    expect(row.standing).toBe("booked");
    expect(row.booked).toBe(true);
    expect(row.amount_in).toBe(10_000);
    expect(row.shares).toEqual({ quantity: 4000, price_per_share: 2.5, security_class_id: expect.any(String) });

    // The spine carries both halves: the decision and the effect it authorized.
    const events = await t.db
      .prepare("SELECT event_type FROM event_record WHERE object_id IN (?1, ?2) ORDER BY created_at")
      .bind(txnId, cardId)
      .all<{ event_type: string }>();
    const types = (events.results ?? []).map((e) => e.event_type);
    expect(types).toContain("approval.decided");
    expect(types).toContain("investment.transaction_executed");
    expect(types).toContain("approval.executed");
  });

  it("the receipt is spent: the explicit route with the same card is refused and the holding is not doubled", async () => {
    const replay = await call<{ error: string; detail: string }>(`/api/transactions/${txnId}/execute`, MP, "POST", {
      approval_receipt_id: cardId,
      fund_id: fundId,
    });
    expect(replay.status).toBe(409);
    expect(await positions(companyId), "a refused replay must not double the holding").toHaveLength(1);
    // And the card cannot be approved again either — it is executed, not approved.
    const again = await call<{ error: string }>(`/api/approvals/${cardId}/decide`, OTHER_MP, "POST", { decision: "approved" });
    expect(again.status).toBe(409);
    expect(await positions(companyId)).toHaveLength(1);
  });

  it("a booked row can be reserved for (MP only) and marked; the reserve is on the row", async () => {
    const pos = (await positions(companyId))[0]!;
    const member = await call<{ error: string }>(`/api/positions/${pos.id}/reserve`, MEMBER, "POST", { amount: 20_000, as_of_date: "2026-09-18" });
    expect(member.status).toBe(403);
    const set = await call<{ id: string }>(`/api/positions/${pos.id}/reserve`, MP, "POST", { amount: 20_000, as_of_date: "2026-09-18", note: "for the seed extension" });
    expect(set.status).toBe(201);
    const row = await holding(companyId);
    expect(row.reserve).toEqual({ amount: 20_000, as_of: "2026-09-18", note: "for the seed extension" });
    // Superseded, never edited: a newer reserve wins and the old row survives.
    const newer = await call(`/api/positions/${pos.id}/reserve`, MP, "POST", { amount: 25_000, as_of_date: "2026-09-19" });
    expect(newer.status).toBe(201);
    expect((await holding(companyId)).reserve?.amount).toBe(25_000);
    const kept = await t.db.prepare("SELECT COUNT(*) AS n FROM position_reserve WHERE position_id = ?1").bind(pos.id).first<{ n: number }>();
    expect(kept!.n).toBe(2);
  });

  it("SELL starts from the booked row: one SECONDARY_SALE at NEW on Dealflow, and the row reads 'sale open'", async () => {
    const opened = await call<{ opportunity_id: string; status: string; already_open: boolean }>(`/api/holdings/${companyId}/sell`, MP, "POST", {});
    expect(opened.status).toBe(201);
    expect(opened.body.status).toBe("NEW");
    expect(opened.body.already_open).toBe(false);
    const deal = await call<{ opportunity_type: string; source_channel: string; security_class_id: string; quantity: number; terms_json: string }>(
      `/api/opportunities/${opened.body.opportunity_id}`,
      MP,
    );
    expect(deal.body.opportunity_type).toBe("SECONDARY_SALE");
    expect(deal.body.source_channel).toBe("portfolio:sell");
    expect(deal.body.quantity).toBe(4000);
    const terms = JSON.parse(deal.body.terms_json) as Record<string, unknown>;
    expect(terms.opened_from).toBe("portfolio_row");
    expect(terms.fund_id).toBe(fundId);
    expect(terms.held_quantity).toBe(4000);
    expect(terms.cost_basis_usd).toBe(10_000);
    expect(typeof terms.position_id).toBe("string");

    const row = await holding(companyId);
    expect(row.sale).toEqual({ opportunity_id: opened.body.opportunity_id, status: "NEW" });
    // Selling sells nothing: the position is untouched until a SALE transaction executes.
    expect((await positions(companyId))[0]!.quantity).toBe(4000);

    // Pressing Sell twice finds the open sale rather than opening a second.
    const twice = await call<{ opportunity_id: string; already_open: boolean }>(`/api/holdings/${companyId}/sell`, MP, "POST", {});
    expect(twice.status).toBe(200);
    expect(twice.body.already_open).toBe(true);
    expect(twice.body.opportunity_id).toBe(opened.body.opportunity_id);
  });
});

describe("2. a declined card books nothing, and the row says so", () => {
  it("rejected → standing 'declined', no position; the draft can be resent and approved", async () => {
    const companyId = await createCompany("Declined Co");
    const opportunityId = await closedLikeSensori(companyId);
    const saved = await call<{ approval_card_id: string; transaction: { id: string } }>(`/api/holdings/${companyId}/book`, MP, "POST", {
      opportunity_id: opportunityId,
      class_name: "Common",
      price_per_share: 4,
      quantity: 2500,
      transaction_date: "2025-08-06",
      vehicle: "Fund I direct",
      fund_id: fundId,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const rejected = await call(`/api/approvals/${saved.body.approval_card_id}/decide`, OTHER_MP, "POST", { decision: "rejected", note: "not these terms" });
    expect(rejected.status).toBe(200);
    expect(await positions(companyId)).toHaveLength(0);
    let row = await holding(companyId);
    expect(row.standing).toBe("declined");
    expect(row.booking!.card_state).toBe("rejected");

    // Resent through the existing route: a fresh card, then approved, then booked.
    const resent = await call<{ approval_card_id: string }>(`/api/transactions/${saved.body.transaction.id}/submit`, MP, "POST", {});
    expect(resent.status).toBe(200);
    expect(resent.body.approval_card_id).not.toBe(saved.body.approval_card_id);
    row = await holding(companyId);
    expect(row.standing).toBe("awaiting");
    const approved = await call<{ booking?: { executed: boolean } }>(`/api/approvals/${resent.body.approval_card_id}/decide`, OTHER_MP, "POST", { decision: "approved" });
    expect(approved.status).toBe(200);
    expect(approved.body.booking?.executed).toBe(true);
    expect(await positions(companyId)).toHaveLength(1);
    expect((await holding(companyId)).standing).toBe("booked");
  });
});

describe("3. the older draft shape — no fund named — is approved, not booked, and says so", () => {
  it("the decision stands, position stays empty, the spine says why, and the explicit route with the fund books it", async () => {
    const companyId = await createCompany("Legacy Draft Co");
    const sc = await call<{ id: string }>("/api/security-classes", MP, "POST", { company_id: companyId, class_name: "Common" });
    const txn = await call<{ id: string }>("/api/transactions", MP, "POST", {
      company_id: companyId,
      transaction_type: "PRIMARY_INVESTMENT",
      security_class_id: sc.body.id,
      quantity: 100,
      price_per_share: 10,
      transaction_date: "2026-03-01",
    });
    expect(txn.status).toBe(201);
    const submitted = await call<{ approval_card_id: string }>(`/api/transactions/${txn.body.id}/submit`, MP, "POST", {});
    expect(submitted.status).toBe(200);
    const card = await call<{ summary: string }>(`/api/approvals/${submitted.body.approval_card_id}`, MP);
    expect(card.body.summary, "the card tells the partner approving will not book this one").toContain("No fund is named");

    const decided = await call<{ state: string; booking?: { executed: boolean; reason: string } }>(
      `/api/approvals/${submitted.body.approval_card_id}/decide`,
      OTHER_MP,
      "POST",
      { decision: "approved" },
    );
    expect(decided.status).toBe(200);
    expect(decided.body.state).toBe("approved");
    expect(decided.body.booking?.executed).toBe(false);
    expect(decided.body.booking?.reason).toContain("names no fund");
    expect(await positions(companyId)).toHaveLength(0);
    const said = await t.db
      .prepare("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'investment.booking_awaits_fund' AND object_id = ?1")
      .bind(txn.body.id)
      .first<{ n: number }>();
    expect(said!.n, "an approval that booked nothing is written down, never silent").toBe(1);

    // The explicit route still books it, with the fund named — and only with a matching fund.
    const booked = await call<{ status: string }>(`/api/transactions/${txn.body.id}/execute`, MP, "POST", {
      approval_receipt_id: submitted.body.approval_card_id,
      fund_id: fundId,
    });
    expect(booked.status, JSON.stringify(booked.body)).toBe(200);
    expect(booked.body.status).toBe("EXECUTED");
    expect(await positions(companyId)).toHaveLength(1);
  });

  it("a draft that names a fund cannot be booked to a different one at execution", async () => {
    const companyId = await createCompany("Mismatch Co");
    const opportunityId = await closedLikeSensori(companyId);
    const other = await call<{ id: string }>("/api/funds", MP, "POST", { name: "Booking Fund II" });
    const sc = await call<{ id: string }>("/api/security-classes", MP, "POST", { company_id: companyId, class_name: "Common" });
    const txn = await call<{ id: string }>("/api/transactions", MP, "POST", {
      company_id: companyId,
      opportunity_id: opportunityId,
      transaction_type: "PRIMARY_INVESTMENT",
      security_class_id: sc.body.id,
      quantity: 100,
      price_per_share: 10,
      transaction_date: "2026-03-01",
      fund_id: fundId,
      vehicle: "Fund I direct",
    });
    expect(txn.status).toBe(201);
    // Not sent: the row reads 'draft' and no card exists.
    expect((await holding(companyId)).standing).toBe("draft");
    // Executing a DRAFT with the wrong fund is refused for the mismatch before anything else.
    const wrong = await call<{ error: string }>(`/api/transactions/${txn.body.id}/execute`, MP, "POST", { fund_id: other.body.id });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error).toBe("fund_mismatch");
    expect(await positions(companyId)).toHaveLength(0);
  });
});

describe("4. the sale door refuses what the ledger does not hold", () => {
  it("an unbooked holding cannot be sold", async () => {
    const companyId = await createCompany("Unbooked Sale Co");
    await closedLikeSensori(companyId);
    const refused = await call<{ error: string }>(`/api/holdings/${companyId}/sell`, MP, "POST", {});
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("not_booked");
    const sales = await t.db.prepare("SELECT COUNT(*) AS n FROM investment_opportunity WHERE company_id = ?1 AND opportunity_type = 'SECONDARY_SALE'").bind(companyId).first<{ n: number }>();
    expect(sales!.n).toBe(0);
  });
});

describe("5. the concentration line reads the plan's cap against committed capital", () => {
  it("names the cap, ranks by cost, and words the level rather than colouring it", async () => {
    for (const [kind, policy] of [
      ["mandate", { target_size_usd: 30_000_000, target_positions: 25 }],
      ["concentration", { max_single_company_pct: 10 }],
    ] as const) {
      const res = await call(`/api/funds/${fundId}/policies/${kind}`, MP, "POST", { version_no: 1, effective_from: "2026-01-01", policy });
      expect(res.status, kind).toBe(201);
    }
    const res = await call<{ concentration: { max_single_company_pct: number | null; committed_usd: number; cap_usd: number | null; rows: Array<{ company: string; at_cost_usd: number; pct_of_committed: number; level: string }> } }>(
      `/api/portfolio/holdings?fund_id=${fundId}`,
      MP,
    );
    expect(res.status).toBe(200);
    const c = res.body.concentration;
    expect(c.max_single_company_pct).toBe(10);
    expect(c.committed_usd).toBe(30_000_000);
    expect(c.cap_usd).toBe(3_000_000);
    expect(c.rows.length, "Rule 0: the view examined no holdings").toBeGreaterThan(0);
    for (let i = 1; i < c.rows.length; i += 1) expect(c.rows[i - 1]!.at_cost_usd).toBeGreaterThanOrEqual(c.rows[i]!.at_cost_usd);
    expect(c.rows.every((r) => r.level === "ok")).toBe(true);
    expect(c.rows[0]!.pct_of_committed).toBeCloseTo((c.rows[0]!.at_cost_usd / 30_000_000) * 100, 6);
  });
});

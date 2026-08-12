import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { compareRecords, createPacket, distributePacket, recordReview, resolveException } from "../src/worker/services/reporting";
import { runAi } from "../src/worker/ai/runAi";

/**
 * P12 — LP reporting and fund-administration reconciliation.
 *
 * Rules under test (plan §8/P12 + §12.2): a packet cannot be distributed until every
 * required review is COMPLETED and a reserved LP-communication receipt is presented;
 * a discrepancy creates an EXCEPTION recording both observed values and never an
 * overwrite; the administrator's reported value is frozen at the database layer for
 * every actor; AI can never review, distribute, resolve, or reach any banking /
 * fund-admin reserved action.
 *
 * What these tests prove is PROCESS: routing, blocking, review states, and recorded
 * discrepancies. They prove nothing about accounting, valuation, or financial
 * correctness (§12.4), and live reconciliation remains gated on a real administrator
 * source contract and human authorization (§7.2).
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const MEMBER = { "x-wpos-dev-user": "member@westpeek.ventures" };
const FINANCE = { "x-wpos-dev-user": "finance@westpeek.ventures" };
const COMPLIANCE = { "x-wpos-dev-user": "compliance@westpeek.ventures" };

const MP_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const MEMBER_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_rep_member", roles: ["INVESTMENT_TEAM"], firmScopes: ["west-peek"] };
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

async function approvedCard(actionKey: string, objectType: string, objectId: string): Promise<string> {
  const created = await call<{ id: string }>("/api/approvals", MP, "POST", {
    action_key: actionKey,
    object_type: objectType,
    object_id: objectId,
    title: `p12: ${actionKey}`,
    submit: true,
  });
  expect(created.status).toBe(201);
  expect((await call(`/api/approvals/${created.body.id}/decide`, MP, "POST", { decision: "approved" })).status).toBe(200);
  return created.body.id;
}

let fundId: string;

async function newPeriod(): Promise<string> {
  const res = await call<{ id: string }>("/api/reporting/periods", MP, "POST", {
    fund_id: fundId,
    label: `Q1 ${crypto.randomUUID().slice(0, 8)}`,
    period_start: "2026-01-01",
    period_end: "2026-03-31",
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function newPacket(): Promise<string> {
  const res = await call<{ id: string }>(`/api/reporting/periods/${await newPeriod()}/packets`, MP, "POST", { title: "Quarterly report" });
  expect(res.status).toBe(201);
  return res.body.id;
}

/** A packet with every required review completed by a properly-roled human. */
async function reviewedPacket(): Promise<string> {
  const packetId = await newPacket();
  expect((await call(`/api/reporting/packets/${packetId}/submit`, MP, "POST", {})).status).toBe(200);
  await call(`/api/reporting/packets/${packetId}/reviews`, FINANCE, "POST", { review_type: "FINANCE", status: "COMPLETED" });
  await call(`/api/reporting/packets/${packetId}/reviews`, COMPLIANCE, "POST", { review_type: "COMPLIANCE", status: "COMPLETED" });
  await call(`/api/reporting/packets/${packetId}/reviews`, MP, "POST", { review_type: "MANAGING_PARTNER", status: "COMPLETED" });
  return packetId;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_DOCUMENTS: t.docs });
  for (const [id, email, name, role] of [
    ["fu_rep_member", "member@westpeek.ventures", "Rep Member", "role_investment_team"],
    ["fu_rep_finance", "finance@westpeek.ventures", "Rep Finance", "role_finance_authority"],
    ["fu_rep_compliance", "compliance@westpeek.ventures", "Rep Compliance", "role_compliance_officer"],
  ] as const) {
    await t.db.prepare("INSERT INTO firm_user (id, email, full_name, status) VALUES (?1, ?2, ?3, 'ACTIVE')").bind(id, email, name).run();
    await t.db.prepare("INSERT INTO firm_user_role (firm_user_id, role_id) VALUES (?1, ?2)").bind(id, role).run();
  }
  const fund = await call<{ id: string }>("/api/funds", MP, "POST", { name: `Reporting Fund ${crypto.randomUUID().slice(0, 8)}` });
  fundId = fund.body.id;
});

afterAll(async () => {
  await disposeTestDb(t);
});

// ── 0. Unauthenticated requests are denied ──

describe("0. unauthenticated requests are denied (401) across the P12 surface", () => {
  it("returns 401 on every P12 route", async () => {
    const routes: Array<[string, string, unknown?]> = [
      ["POST", "/api/reporting/periods", {}],
      ["GET", "/api/reporting/periods"],
      ["POST", "/api/reporting/periods/lrp_x/packets", {}],
      ["GET", "/api/reporting/packets"],
      ["GET", "/api/reporting/packets/lrk_x"],
      ["POST", "/api/reporting/packets/lrk_x/submit", {}],
      ["POST", "/api/reporting/packets/lrk_x/reviews", {}],
      ["POST", "/api/reporting/packets/lrk_x/distribute", {}],
      ["POST", "/api/reconciliation/runs", {}],
      ["GET", "/api/reconciliation/runs"],
      ["GET", "/api/reconciliation/exceptions"],
      ["POST", "/api/reconciliation/exceptions/fre_x/resolve", {}],
    ];
    for (const [method, path, body] of routes) {
      const res = await handleRequest(req(path, {}, method, body), env);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

// ── 1. Distribution is blocked until every required review is complete ──

describe("1. a packet cannot leave the building without its reviews", () => {
  it("submitting opens one PENDING row per required review", async () => {
    const packetId = await newPacket();
    const submitted = await call<{ reviews: Array<{ review_type: string; status: string }>; outstanding: string[]; all_complete: boolean }>(
      `/api/reporting/packets/${packetId}/submit`,
      MP,
      "POST",
      {},
    );
    expect(submitted.status).toBe(200);
    expect(submitted.body.reviews.map((r) => r.review_type).sort()).toEqual(["COMPLIANCE", "FINANCE", "MANAGING_PARTNER"]);
    expect(submitted.body.reviews.every((r) => r.status === "PENDING")).toBe(true);
    expect(submitted.body.all_complete).toBe(false);
  });

  it("refuses distribution with reviews outstanding, naming exactly which ones", async () => {
    const packetId = await newPacket();
    await call(`/api/reporting/packets/${packetId}/submit`, MP, "POST", {});
    await call(`/api/reporting/packets/${packetId}/reviews`, FINANCE, "POST", { review_type: "FINANCE", status: "COMPLETED" });

    const receipt = await approvedCard("lp_sensitive_communication.send", "lp_reporting_packet", packetId);
    const blocked = await call<{ error: string; detail: string }>(`/api/reporting/packets/${packetId}/distribute`, MP, "POST", {
      recipients: [{ recipient_label: "lp@example.com" }],
      approval_receipt_id: receipt,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("reviews_incomplete");
    expect(blocked.body.detail).toContain("COMPLIANCE");
    expect(blocked.body.detail).toContain("MANAGING_PARTNER");
    // A valid receipt did NOT stand in for the missing reviews, and nothing shipped.
    const receipts = await t.db.prepare("SELECT COUNT(*) AS n FROM distribution_receipt WHERE packet_id = ?1").bind(packetId).first<{ n: number }>();
    expect(receipts!.n).toBe(0);
  });

  it("a reviewer must hold the function they sign off for", async () => {
    const packetId = await newPacket();
    await call(`/api/reporting/packets/${packetId}/submit`, MP, "POST", {});
    // Compliance cannot cover the finance review, and an investment-team member
    // cannot cover any of them.
    const wrongFunction = await call<{ error: string }>(`/api/reporting/packets/${packetId}/reviews`, COMPLIANCE, "POST", {
      review_type: "FINANCE",
      status: "COMPLETED",
    });
    expect(wrongFunction.status).toBe(403);
    expect(wrongFunction.body.error).toBe("wrong_reviewer_role");
    for (const reviewType of ["FINANCE", "COMPLIANCE", "MANAGING_PARTNER"]) {
      expect((await call(`/api/reporting/packets/${packetId}/reviews`, MEMBER, "POST", { review_type: reviewType, status: "COMPLETED" })).status, reviewType).toBe(403);
    }
    // The same review cannot be recorded twice.
    await call(`/api/reporting/packets/${packetId}/reviews`, FINANCE, "POST", { review_type: "FINANCE", status: "COMPLETED" });
    expect((await call(`/api/reporting/packets/${packetId}/reviews`, FINANCE, "POST", { review_type: "FINANCE", status: "COMPLETED" })).status).toBe(409);
  });

  it("all reviews complete moves the packet to APPROVED but does NOT distribute it", async () => {
    const packetId = await reviewedPacket();
    const packet = await call<{ status: string; all_complete: boolean; distributed_at: string | null }>(`/api/reporting/packets/${packetId}`, MP);
    expect(packet.body.all_complete).toBe(true);
    expect(packet.body.status).toBe("APPROVED");
    expect(packet.body.distributed_at).toBeNull();

    // Reviewed is not sent: distribution still needs the reserved receipt.
    const noReceipt = await call<{ error: string }>(`/api/reporting/packets/${packetId}/distribute`, MP, "POST", {
      recipients: [{ recipient_label: "lp@example.com" }],
    });
    expect(noReceipt.status).toBe(409);
    expect(noReceipt.body.error).toBe("approval_required");
  });

  it("distributes with both gates, records recipient + VERSION, and refuses the replay", async () => {
    const packetId = await reviewedPacket();
    const receipt = await approvedCard("lp_sensitive_communication.send", "lp_reporting_packet", packetId);
    const distributed = await call<{ packet: { status: string }; distribution_receipts: Array<{ recipient_label: string; packet_version: number; approval_card_id: string }> }>(
      `/api/reporting/packets/${packetId}/distribute`,
      MP,
      "POST",
      { recipients: [{ recipient_label: "lp-a@example.com" }, { recipient_label: "lp-b@example.com" }], delivery_note: "external data room link" },
    );
    // The receipt is presented, not discovered.
    expect(distributed.status).toBe(409);

    const withReceipt = await call<{ packet: { status: string }; distribution_receipts: Array<{ id: string; recipient_label: string; packet_version: number; approval_card_id: string }> }>(
      `/api/reporting/packets/${packetId}/distribute`,
      MP,
      "POST",
      {
        recipients: [{ recipient_label: "lp-a@example.com" }, { recipient_label: "lp-b@example.com" }],
        approval_receipt_id: receipt,
        delivery_note: "external data room link",
      },
    );
    expect(withReceipt.status).toBe(200);
    expect(withReceipt.body.packet.status).toBe("DISTRIBUTED");
    expect(withReceipt.body.distribution_receipts).toHaveLength(2);
    expect(withReceipt.body.distribution_receipts.every((r) => r.packet_version === 1 && r.approval_card_id === receipt)).toBe(true);

    const replay = await call(`/api/reporting/packets/${packetId}/distribute`, MP, "POST", {
      recipients: [{ recipient_label: "lp-c@example.com" }],
      approval_receipt_id: receipt,
    });
    expect(replay.status).toBe(409);

    // Distribution receipts are evidence: they cannot be edited or removed.
    const receiptId = withReceipt.body.distribution_receipts[0]!.id;
    await expect(t.db.prepare("UPDATE distribution_receipt SET recipient_label = 'x' WHERE id = ?1").bind(receiptId).run()).rejects.toThrow(/append-only/);
    await expect(t.db.prepare("DELETE FROM distribution_receipt WHERE id = ?1").bind(receiptId).run()).rejects.toThrow(/append-only/);
  });

  it("a REJECTED review withdraws the packet instead of stranding it", async () => {
    const packetId = await newPacket();
    await call(`/api/reporting/packets/${packetId}/submit`, MP, "POST", {});
    await call(`/api/reporting/packets/${packetId}/reviews`, FINANCE, "POST", { review_type: "FINANCE", status: "COMPLETED" });
    const rejected = await call<{ all_complete: boolean }>(`/api/reporting/packets/${packetId}/reviews`, COMPLIANCE, "POST", {
      review_type: "COMPLIANCE",
      status: "REJECTED",
      note: "the performance narrative overstates realised returns",
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.all_complete).toBe(false);

    // The packet is WITHDRAWN, not left sitting IN_REVIEW forever: `all_complete`
    // could never become true, the review cannot be re-recorded, and submit only
    // accepts DRAFT — that combination would be an unreachable state with no way out.
    const packet = await call<{ status: string }>(`/api/reporting/packets/${packetId}`, MP);
    expect(packet.body.status).toBe("WITHDRAWN");

    // Distribution is refused by NAME, so the reviewer sees the real reason.
    const receipt = await approvedCard("lp_sensitive_communication.send", "lp_reporting_packet", packetId);
    const blocked = await call<{ error: string }>(`/api/reporting/packets/${packetId}/distribute`, MP, "POST", {
      recipients: [{ recipient_label: "lp@example.com" }],
      approval_receipt_id: receipt,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("packet_withdrawn");

    // The rejection is preserved, not edited away, and no further review lands on it.
    const review = await t.db
      .prepare("SELECT status, reviewer_id, note FROM reporting_review WHERE packet_id = ?1 AND review_type = 'COMPLIANCE'")
      .bind(packetId)
      .first<{ status: string; reviewer_id: string; note: string }>();
    expect(review!.status).toBe("REJECTED");
    expect(review!.reviewer_id).toBe("fu_rep_compliance");
    expect((await call(`/api/reporting/packets/${packetId}/reviews`, MP, "POST", { review_type: "MANAGING_PARTNER", status: "COMPLETED" })).status).toBe(409);

    // The way forward is a corrected NEW VERSION of the same period.
    const period = await t.db.prepare("SELECT period_id FROM lp_reporting_packet WHERE id = ?1").bind(packetId).first<{ period_id: string }>();
    const v2 = await call<{ id: string; version: number }>(`/api/reporting/periods/${period!.period_id}/packets`, MP, "POST", {
      title: "Quarterly report (corrected)",
      version: 2,
    });
    expect(v2.status).toBe(201);
    expect(v2.body.version).toBe(2);
    expect((await call(`/api/reporting/packets/${v2.body.id}/submit`, MP, "POST", {})).status).toBe(200);
  });

  it("an AI may draft a packet with its trace, but can never submit, review, or distribute", async () => {
    const periodId = await newPeriod();
    await expect(createPacket(env, AI_ACTOR, periodId, { title: "ai draft" })).rejects.toMatchObject({ status: 400 });
    const run = await runAi(env, { purpose: "lp_report_draft", actor: AI_ACTOR, inputs: ["draft the quarterly narrative"], sensitivity: "INTERNAL" });
    const packet = await createPacket(env, AI_ACTOR, periodId, { title: "ai draft", ai_run_id: run.run.id });
    expect(packet.drafted_by_type).toBe("AI");

    await expect(recordReview(env, AI_ACTOR, packet.id, { review_type: "FINANCE", status: "COMPLETED" })).rejects.toMatchObject({ status: 403 });
    await expect(distributePacket(env, AI_ACTOR, packet.id, { recipients: [{ recipient_label: "lp@example.com" }] })).rejects.toMatchObject({ status: 403 });
  });
});

// ── 2. Reconciliation: discrepancies, never overwrites ──

describe("2. the administrator stays authoritative", () => {
  it("compareRecords classifies each difference without touching either side", () => {
    const administrator = [
      { record_kind: "CAPITAL_ACCOUNT" as const, record_key: "lp-1", field: "closing_balance", value: "1250000" },
      { record_kind: "NAV" as const, record_key: "fund", field: "nav", value: "31500000" },
      { record_kind: "POSITION" as const, record_key: "pos-9", field: "cost_basis", value: "500000" },
      { record_kind: "OTHER" as const, record_key: "note-1", field: "status", value: "final" },
    ];
    const internal = [
      { record_kind: "CAPITAL_ACCOUNT", record_key: "lp-1", field: "closing_balance", value: "1250000" },
      { record_kind: "NAV", record_key: "fund", field: "nav", value: "31000000" },
      { record_kind: "OTHER", record_key: "note-1", field: "status", value: "draft" },
      { record_kind: "DISTRIBUTION", record_key: "dist-3", field: "amount", value: "75000" },
    ];
    const exceptions = compareRecords(administrator, internal);

    // Matching values raise nothing.
    expect(exceptions.find((e) => e.record_key === "lp-1")).toBeUndefined();

    // A numeric mismatch reports the signed gap (internal − administrator).
    const nav = exceptions.find((e) => e.record_key === "fund")!;
    expect(nav.exception_kind).toBe("VALUE_MISMATCH");
    expect(nav.administrator_value).toBe("31500000");
    expect(nav.internal_value).toBe("31000000");
    expect(nav.difference).toBe(-500_000);

    // A non-numeric mismatch reports NO difference rather than a misleading 0.
    const note = exceptions.find((e) => e.record_key === "note-1")!;
    expect(note.exception_kind).toBe("VALUE_MISMATCH");
    expect(note.difference).toBeNull();

    // Each side missing the other is its own kind.
    expect(exceptions.find((e) => e.record_key === "pos-9")!.exception_kind).toBe("MISSING_INTERNAL");
    expect(exceptions.find((e) => e.record_key === "dist-3")!.exception_kind).toBe("MISSING_ADMINISTRATOR");
  });

  it("a run stores every exception, labels the source UNPROVEN, and writes nothing back", async () => {
    const run = await call<{
      run: { id: string; exception_count: number; source_mode: string; source_contract_version: string };
      exceptions: Array<{ id: string; administrator_value: string; internal_value: string }>;
      source_state: string;
    }>("/api/reconciliation/runs", MP, "POST", {
      fund_id: fundId,
      source_system: "example_fund_administrator",
      source_reference: "Q1-2026 export",
      administrator_records: [{ record_kind: "NAV", record_key: "fund", field: "nav", value: "31500000" }],
      internal_records: [{ record_kind: "NAV", record_key: "fund", field: "nav", value: "31000000" }],
    });
    expect(run.status).toBe(201);
    expect(run.body.run.exception_count).toBe(1);
    expect(run.body.run.source_mode).toBe("LOCAL_FIXTURE");
    expect(run.body.source_state).toContain("UNPROVEN");
    expect(run.body.source_state).toContain("FUND-ADMIN SOURCE CONTRACT GATE");

    // The event says so explicitly: zero administrator records were written.
    const event = await t.db
      .prepare("SELECT payload_json FROM event_record WHERE event_type = 'reconciliation.run_completed' AND object_id = ?1")
      .bind(run.body.run.id)
      .first<{ payload_json: string }>();
    expect(JSON.parse(event!.payload_json).administrator_records_written).toBe(0);

    // The run itself is a dated comparison and cannot be rewritten.
    await expect(t.db.prepare("UPDATE fund_reconciliation_run SET exception_count = 0 WHERE id = ?1").bind(run.body.run.id).run()).rejects.toThrow(/immutable/);
  });

  it("NO ROLE can overwrite the administrator's reported value — not even direct SQL", async () => {
    const run = await call<{ exceptions: Array<{ id: string }> }>("/api/reconciliation/runs", MP, "POST", {
      fund_id: fundId,
      source_system: "example_fund_administrator",
      administrator_records: [{ record_kind: "CAPITAL_ACCOUNT", record_key: "lp-frozen", field: "closing_balance", value: "1000000" }],
      internal_records: [{ record_kind: "CAPITAL_ACCOUNT", record_key: "lp-frozen", field: "closing_balance", value: "900000" }],
    });
    const exceptionId = run.body.exceptions[0]!.id;
    for (const [column, value] of [
      ["administrator_value", "900000"],
      ["internal_value", "1000000"],
      ["record_key", "lp-other"],
      ["field", "opening_balance"],
    ] as const) {
      await expect(
        t.db.prepare(`UPDATE fund_reconciliation_exception SET ${column} = ?2 WHERE id = ?1`).bind(exceptionId, value).run(),
        column,
      ).rejects.toThrow(/never overwritten/);
    }
    // A discrepancy is never deleted away either.
    await expect(t.db.prepare("DELETE FROM fund_reconciliation_exception WHERE id = ?1").bind(exceptionId).run()).rejects.toThrow(/append-only/);
    // Status alone may move — that is what a resolution does.
    await t.db.prepare("UPDATE fund_reconciliation_exception SET status = 'ESCALATED' WHERE id = ?1").bind(exceptionId).run();
    const row = await t.db.prepare("SELECT status, administrator_value FROM fund_reconciliation_exception WHERE id = ?1").bind(exceptionId).first<{ status: string; administrator_value: string }>();
    expect(row!.status).toBe("ESCALATED");
    expect(row!.administrator_value).toBe("1000000");
  });

  async function openException(): Promise<string> {
    const run = await call<{ exceptions: Array<{ id: string }> }>("/api/reconciliation/runs", MP, "POST", {
      fund_id: fundId,
      source_system: "example_fund_administrator",
      administrator_records: [{ record_kind: "NAV", record_key: `nav-${crypto.randomUUID().slice(0, 8)}`, field: "nav", value: "31500000" }],
      internal_records: [],
    });
    return run.body.exceptions[0]!.id;
  }

  it("restating an official figure is reserved; escalating is not", async () => {
    // ESCALATE changes no number, so it needs no receipt.
    const escalated = await call<{ exception: { status: string }; resolution: { approval_card_id: string | null } }>(
      `/api/reconciliation/exceptions/${await openException()}/resolve`,
      MP,
      "POST",
      { resolution: "ESCALATE_TO_ADMINISTRATOR", note: "asked the administrator to confirm the mark" },
    );
    expect(escalated.status).toBe(201);
    expect(escalated.body.exception.status).toBe("ESCALATED");
    expect(escalated.body.resolution.approval_card_id).toBeNull();

    // ACCEPT_ADMINISTRATOR restates our books against theirs — reserved.
    const exceptionId = await openException();
    const blocked = await call<{ error: string }>(`/api/reconciliation/exceptions/${exceptionId}/resolve`, MP, "POST", {
      resolution: "ACCEPT_ADMINISTRATOR",
      note: "their statement is authoritative",
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("approval_required");

    const receipt = await approvedCard("official_valuation_or_capital_account.change", "fund_reconciliation_exception", exceptionId);
    const resolved = await call<{ exception: { status: string }; resolution: { approval_card_id: string } }>(
      `/api/reconciliation/exceptions/${exceptionId}/resolve`,
      MP,
      "POST",
      { resolution: "ACCEPT_ADMINISTRATOR", note: "their statement is authoritative", approval_receipt_id: receipt },
    );
    expect(resolved.status).toBe(201);
    expect(resolved.body.exception.status).toBe("RESOLVED");
    expect(resolved.body.resolution.approval_card_id).toBe(receipt);

    // The spine records that the administrator's record was left as reported.
    const event = await t.db
      .prepare("SELECT payload_json FROM event_record WHERE event_type = 'reconciliation.exception_resolved' AND object_id = ?1")
      .bind(exceptionId)
      .first<{ payload_json: string }>();
    expect(JSON.parse(event!.payload_json).administrator_record_overwritten).toBe(false);

    // Resolutions are append-only, and an exception resolves once.
    await expect(t.db.prepare("UPDATE reconciliation_resolution SET note = 'x' WHERE exception_id = ?1").bind(exceptionId).run()).rejects.toThrow(/append-only/);
    expect((await call(`/api/reconciliation/exceptions/${exceptionId}/resolve`, MP, "POST", { resolution: "NO_ACTION", note: "again" })).status).toBe(409);
  });

  it("an AI can never resolve a discrepancy, and a non-MP cannot restate an official figure", async () => {
    const exceptionId = await openException();
    await expect(resolveException(env, AI_ACTOR, exceptionId, { resolution: "ACCEPT_ADMINISTRATOR", note: "x" })).rejects.toMatchObject({ status: 403 });
    expect(
      (await call(`/api/reconciliation/exceptions/${exceptionId}/resolve`, MEMBER, "POST", { resolution: "CORRECT_INTERNAL", note: "x" })).status,
    ).toBe(403);
  });

  it("reconciliation exceptions are BANKING_RESTRICTED: invisible without the scope", async () => {
    await openException();
    const asMember = await call<{ exceptions: unknown[] }>("/api/reconciliation/exceptions", MEMBER);
    expect(asMember.body.exceptions).toHaveLength(0);
    const asMp = await call<{ exceptions: unknown[] }>("/api/reconciliation/exceptions", MP);
    expect(asMp.body.exceptions.length).toBeGreaterThan(0);
  });
});

// ── 3. Banking and fund-admin authority stays human ──

describe("3. capital, banking, and certification remain reserved", () => {
  it("AI is DENIED every capital/banking/fund-admin reserved action outright", async () => {
    const { authorize } = await import("../src/worker/services/authorize");
    const reserved = [
      "capital_call.issue",
      "distribution.approve",
      "wire.initiate_or_authorize",
      "bank_account.change",
      "payment_instruction.approve",
      "official_valuation_or_capital_account.change",
      "fund_admin_record.override",
      "financial_statement.certify",
    ];
    for (const key of reserved) {
      expect((await authorize(env, AI_ACTOR, key, { objectType: "fund", firmScope: "west-peek" })).decision, `AI ${key}`).toBe("DENY");
      expect((await authorize(env, MEMBER_ACTOR, key, { objectType: "fund", firmScope: "west-peek" })).decision, `member ${key}`).toBe("DENY");
      // Even an MP only ever gets REQUIRE_APPROVAL: no one self-executes these.
      expect((await authorize(env, MP_ACTOR, key, { objectType: "fund", firmScope: "west-peek" })).decision, `MP ${key}`).toBe("REQUIRE_APPROVAL");
    }
  });

  it("the reporting surface certifies nothing, and no P12 table holds a certification", async () => {
    const packets = await call<{ certification_state: string }>("/api/reporting/packets", MP);
    expect(packets.body.certification_state).toContain("NO FINANCIAL, ACCOUNTING, OR VALUATION CORRECTNESS IS CERTIFIED");

    const p12Tables = [
      "lp_reporting_period",
      "lp_reporting_packet",
      "reporting_review",
      "distribution_receipt",
      "fund_reconciliation_run",
      "fund_reconciliation_exception",
      "reconciliation_resolution",
    ];
    for (const table of p12Tables) {
      const columns = await t.db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>();
      const names = (columns.results ?? []).map((c) => c.name);
      for (const forbidden of ["certified", "certification", "audited", "gaap_compliant", "verified_correct"]) {
        expect(names, `${table}.${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("the journey leaves typed reporting.* and reconciliation.* events on the ONE spine (D15)", async () => {
    const events = await t.db
      .prepare("SELECT DISTINCT event_type FROM event_record WHERE event_type LIKE 'reporting.%' OR event_type LIKE 'reconciliation.%'")
      .all<{ event_type: string }>();
    const types = new Set((events.results ?? []).map((e) => e.event_type));
    for (const expected of [
      "reporting.period_opened",
      "reporting.packet_drafted",
      "reporting.packet_submitted",
      "reporting.review_recorded",
      "reporting.packet_distributed",
      "reconciliation.run_completed",
      "reconciliation.exception_resolved",
    ]) {
      expect(types, expected).toContain(expected);
    }
  });
});

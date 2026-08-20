import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import { authorize, type Actor } from "../src/worker/services/authorize";
import { ApprovalError, decideApproval, requestApproval } from "../src/worker/services/approvals";
import { MACHINE_REGISTRY, DOMAIN_IDS } from "../src/shared/registry/machines";
import { HUMAN_RESERVED_ACTIONS } from "../src/shared/registry/reservedActions";
import { AI_EMPLOYEE_ROSTER } from "../src/shared/registry/aiEmployees";
import { MANAGING_PARTNER_NAMES } from "../src/shared/registry/managingPartners";
import { ORDINARY_ACTION_TYPES, EXTERNAL_EFFECT_ACTION_TYPES } from "../src/shared/registry/actionTypes";

/**
 * P3 — the adversarial authority suite. Each test targets a specific bypass or
 * privilege-escalation path against the authorize() choke point and the approval
 * state machine. Fail closed is the expected behavior everywhere.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const MEMBER = { "x-wpos-dev-user": "member@westpeek.ventures" }; // INVESTMENT_TEAM
const COUNSEL = { "x-wpos-dev-user": "counsel@westpeek.ventures" }; // COUNSEL
const OUTSIDER = { "x-wpos-dev-user": "outsider@westpeek.ventures" }; // firm_scope: other-firm

const MP_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const MEMBER_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_test_member", roles: ["INVESTMENT_TEAM"], firmScopes: ["west-peek"] };
const AI_ACTOR: Actor = { type: "AI", aiEmployeeId: "Pierce", roles: [], firmScopes: ["west-peek"] };

function req(path: string, headers: Record<string, string> = {}, method = "GET", body?: unknown): Request {
  return new Request(`https://test.local${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Create + submit + approve an approval card via the API as MP; returns the card id. */
async function approvedCard(actionKey: string, objectType: string, objectId: string, headers = MP): Promise<string> {
  const created = await handleRequest(
    req("/api/approvals", headers, "POST", { action_key: actionKey, object_type: objectType, object_id: objectId, title: `test: ${actionKey}`, submit: true }),
    env,
  );
  expect(created.status).toBe(201);
  const card = (await created.json()) as { id: string };
  const decided = await handleRequest(req(`/api/approvals/${card.id}/decide`, headers, "POST", { decision: "approved", note: "test approval" }), env);
  expect(decided.status).toBe(200);
  return card.id;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  await t.db
    .prepare("INSERT INTO firm_user (id, email, full_name, status) VALUES ('fu_test_member', 'member@westpeek.ventures', 'Test Member', 'ACTIVE')")
    .run();
  await t.db
    .prepare("INSERT INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_test_member', 'role_investment_team')")
    .run();
  await t.db
    .prepare("INSERT INTO firm_user (id, email, full_name, status) VALUES ('fu_test_counsel', 'counsel@westpeek.ventures', 'Test Counsel', 'ACTIVE')")
    .run();
  await t.db
    .prepare("INSERT INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_test_counsel', 'role_counsel')")
    .run();
  // A firm user whose ONLY firm scope is a different firm — the cross-scope probe.
  await t.db
    .prepare("INSERT INTO firm_user (id, email, full_name, status) VALUES ('fu_outsider', 'outsider@westpeek.ventures', 'Outsider', 'ACTIVE')")
    .run();
  await t.db
    .prepare("INSERT INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_outsider', 'role_operations')")
    .run();
  await t.db
    .prepare("INSERT INTO authority_scope (id, firm_user_id, scope_key, scope_value) VALUES ('as_outsider_firm', 'fu_outsider', 'firm_scope', 'other-firm')")
    .run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

// ── 1. Unauthorized actor denied ──

describe("1. unauthenticated requests are denied on every P3 route (401)", () => {
  it("returns 401 across the whole P3 surface", async () => {
    const routes: Array<[string, string, unknown?]> = [
      ["POST", "/api/captures", { capture_type: "note", raw_text: "x", source_channel: "web" }],
      ["GET", "/api/captures"],
      ["GET", "/api/captures/cap_x"],
      ["POST", "/api/captures/cap_x/route", { machine_id: 3 }],
      ["POST", "/api/captures/cap_x/archive", {}],
      ["POST", "/api/work-cards", { title: "x" }],
      ["GET", "/api/work-cards"],
      ["GET", "/api/work-cards/wc_x"],
      ["PATCH", "/api/work-cards/wc_x", { state: "DONE" }],
      ["POST", "/api/approvals", { action_key: "investment.approve", object_type: "x", object_id: "y", title: "z" }],
      ["GET", "/api/approvals"],
      ["GET", "/api/approvals/apc_x"],
      ["POST", "/api/approvals/apc_x/submit", {}],
      ["POST", "/api/approvals/apc_x/decide", { decision: "approved" }],
      ["POST", "/api/effects/requests", { effect_type: "email.send", destination: "a@b.c" }],
      ["GET", "/api/effects/requests"],
      ["POST", "/api/effects/requests/eer_x/execute", {}],
      ["GET", "/api/activity"],
      ["POST", "/api/governance/updates", { update_type: "BULLETIN", title: "t", body: "b" }],
      ["GET", "/api/governance/updates"],
      ["GET", "/api/diagnostics/approval-volume"],
      ["GET", "/api/diagnostics/health"],
      ["GET", "/api/machines"],
      ["GET", "/api/domains"],
    ];
    for (const [method, path, body] of routes) {
      const res = await handleRequest(req(path, {}, method, body), env);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

// ── 2. Out-of-scope actor denied (firm isolation §11.7) ──

describe("2. firm_scope isolation — enforced server-side, not by UI hiding", () => {
  it("an actor scoped to another firm cannot create, list, or read west-peek work", async () => {
    const created = await handleRequest(
      req("/api/captures", MP, "POST", { capture_type: "note", raw_text: "west-peek internal note", source_channel: "web" }),
      env,
    );
    expect(created.status).toBe(201);
    const capture = (await created.json()) as { id: string };

    // Create attempt: object scope west-peek is outside the outsider's firm scopes.
    const deniedCreate = await handleRequest(
      req("/api/captures", OUTSIDER, "POST", { capture_type: "note", raw_text: "probe", source_channel: "web" }),
      env,
    );
    expect(deniedCreate.status).toBe(403);
    expect(((await deniedCreate.json()) as { reason: string }).reason).toBe("cross_firm_scope");

    // List: scoped query returns nothing from west-peek.
    const list = await handleRequest(req("/api/captures", OUTSIDER), env);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { captures: unknown[] }).captures).toHaveLength(0);

    // Direct read: indistinguishable from non-existent.
    const get = await handleRequest(req(`/api/captures/${capture.id}`, OUTSIDER), env);
    expect(get.status).toBe(404);

    // authorize() itself fails closed on the scope mismatch.
    const outsiderActor: Actor = { type: "HUMAN", firmUserId: "fu_outsider", roles: ["OPERATIONS"], firmScopes: ["other-firm"] };
    const decision = await authorize(env, outsiderActor, "capture.create", { objectType: "capture", firmScope: "west-peek" });
    expect(decision.decision).toBe("DENY");
    expect(decision.reason).toBe("cross_firm_scope");
  });
});

// ── 3. AI cannot approve its own (or any) work ──

describe("3. AI actors can prepare but NEVER decide", () => {
  it("an AI-created card cannot be decided by an AI; a human without the role cannot decide either", async () => {
    const card = await requestApproval(env, AI_ACTOR, {
      action_key: "investment.approve",
      object_type: "canonical_company",
      object_id: "cc_ai_test",
      title: "AI-prepared investment approval",
      submit: true,
    });
    expect(card.state).toBe("pending_review");
    expect(card.requested_by_type).toBe("AI");

    // AI decider → refused, even for its own card. Especially for its own card.
    await expect(decideApproval(env, AI_ACTOR, card.id, "approved")).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });

    // Human without a required approver role → refused.
    await expect(decideApproval(env, MEMBER_ACTOR, card.id, "approved")).rejects.toMatchObject({ status: 403 });

    // Human WITH the required role → allowed; decision history appended.
    const decided = await decideApproval(env, MP_ACTOR, card.id, "approved", "reviewed by MP");
    expect(decided.state).toBe("approved");
    const history = await t.db
      .prepare("SELECT decision, decided_by FROM approval_decision WHERE approval_card_id = ?1")
      .bind(card.id)
      .all<{ decision: string; decided_by: string }>();
    expect(history.results).toEqual([{ decision: "approved", decided_by: "fu_scooter_taylor", note: "reviewed by MP" }].map((d) => ({ decision: d.decision, decided_by: d.decided_by })));
  });

  it("authorize() DENYs reserved actions to AI/SYSTEM actors outright", async () => {
    const ai = await authorize(env, AI_ACTOR, "investment.approve", { objectType: "canonical_company", objectId: "cc_x" });
    expect(ai.decision).toBe("DENY");
    expect(ai.reason).toBe("reserved_action_ai_actor");
    const sys = await authorize(env, { type: "SYSTEM", roles: [], firmScopes: ["west-peek"] }, "lp.promise", { objectType: "fund", objectId: "f1" });
    expect(sys.decision).toBe("DENY");
  });
});

// ── 4. Reserved action requires the CORRECT human role ──

describe("4. reserved actions enforce the register's approver roles", () => {
  it("COUNSEL cannot approve investment.approve; an MP can", async () => {
    const created = await handleRequest(
      req("/api/approvals", COUNSEL, "POST", {
        action_key: "investment.approve",
        object_type: "canonical_company",
        object_id: "cc_role_test",
        title: "approve the investment",
        submit: true,
      }),
      env,
    );
    expect(created.status).toBe(201);
    const card = (await created.json()) as { id: string; required_approver_roles_json: string };
    expect(JSON.parse(card.required_approver_roles_json)).toEqual(["MANAGING_PARTNER"]);

    const asCounsel = await handleRequest(req(`/api/approvals/${card.id}/decide`, COUNSEL, "POST", { decision: "approved" }), env);
    expect(asCounsel.status).toBe(403);

    const asMp = await handleRequest(req(`/api/approvals/${card.id}/decide`, MP, "POST", { decision: "approved", note: "conviction" }), env);
    expect(asMp.status).toBe(200);

    // And the COUNSEL role IS valid where the register says so (legal.final_conclusion).
    const legalDecision = await authorize(env, { type: "HUMAN", firmUserId: "fu_test_counsel", roles: ["COUNSEL"], firmScopes: ["west-peek"] }, "legal.final_conclusion", {
      objectType: "work_card",
      objectId: "wc_x",
    });
    expect(legalDecision.decision).toBe("REQUIRE_APPROVAL");
  });

  it("fails closed: unknown action keys are DENIED, missing roles are DENIED", async () => {
    const unknown = await authorize(env, MP_ACTOR, "does.not.exist", { objectType: "x" });
    expect(unknown.decision).toBe("DENY");
    expect(unknown.reason).toBe("unknown_action");

    const memberReserved = await authorize(env, MEMBER_ACTOR, "wire.initiate_or_authorize", { objectType: "fund", objectId: "f1" });
    expect(memberReserved.decision).toBe("DENY");
    expect(memberReserved.reason).toBe("missing_required_role");

    const mpReserved = await authorize(env, MP_ACTOR, "wire.initiate_or_authorize", { objectType: "fund", objectId: "f1" });
    expect(mpReserved.decision).toBe("REQUIRE_APPROVAL");
  });
});

// ── 5. External-effect route cannot bypass authorize() ──

describe("5. external effects execute only with a valid, object-matching, unconsumed receipt", () => {
  it("refuses without a receipt, with a wrong-object receipt, and on replay", async () => {
    const mk = async () => {
      const res = await handleRequest(
        req("/api/effects/requests", MP, "POST", { effect_type: "email.send", destination: "lp@example.com", payload: { subject: "update" } }),
        env,
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    const requestId = await mk();

    // No receipt → refused.
    const noReceipt = await handleRequest(req(`/api/effects/requests/${requestId}/execute`, MP, "POST", {}), env);
    expect(noReceipt.status).toBe(409);
    expect(((await noReceipt.json()) as { error: string }).error).toBe("authorization_required");

    // Receipt for a DIFFERENT object → refused.
    const wrongObjectReceipt = await approvedCard("effect.email.send", "external_effect_request", "eer_some_other_request");
    const wrongObject = await handleRequest(req(`/api/effects/requests/${requestId}/execute`, MP, "POST", { receipt_id: wrongObjectReceipt }), env);
    expect(wrongObject.status).toBe(409);
    const wrongBody = (await wrongObject.json()) as { detail: string };
    expect(wrongBody.detail).toContain("receipt_object_mismatch");

    // Receipt for the WRONG ACTION on the right object → refused.
    const wrongActionReceipt = await approvedCard("effect.webhook.post", "external_effect_request", requestId);
    const wrongAction = await handleRequest(req(`/api/effects/requests/${requestId}/execute`, MP, "POST", { receipt_id: wrongActionReceipt }), env);
    expect(wrongAction.status).toBe(409);
    expect(((await wrongAction.json()) as { detail: string }).detail).toContain("receipt_action_mismatch");

    // Correct receipt → executes (simulated delivery), card consumed.
    const receipt = await approvedCard("effect.email.send", "external_effect_request", requestId);
    const ok = await handleRequest(req(`/api/effects/requests/${requestId}/execute`, MP, "POST", { receipt_id: receipt }), env);
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { request: { state: string; authorization_receipt_id: string }; delivery: { simulated: boolean } };
    expect(okBody.request.state).toBe("EXECUTED");
    expect(okBody.request.authorization_receipt_id).toBe(receipt);
    expect(okBody.delivery.simulated).toBe(true);

    const card = await t.db.prepare("SELECT state FROM approval_card WHERE id = ?1").bind(receipt).first<{ state: string }>();
    expect(card!.state).toBe("executed");

    // The execution event carries the receipt id on the event spine.
    const evt = await t.db
      .prepare("SELECT payload_json FROM event_record WHERE event_type = 'effect.executed' AND object_id = ?1")
      .bind(requestId)
      .first<{ payload_json: string }>();
    expect(JSON.parse(evt!.payload_json)).toMatchObject({ receipt_id: receipt });

    // Replay of the consumed receipt → refused.
    const replayTarget = await mk();
    const replay = await handleRequest(req(`/api/effects/requests/${replayTarget}/execute`, MP, "POST", { receipt_id: receipt }), env);
    expect(replay.status).toBe(409);
    expect(((await replay.json()) as { detail: string }).detail).toContain("receipt_already_consumed");

    // Already-executed request cannot be executed again, even with a fresh receipt.
    const freshReceipt = await approvedCard("effect.email.send", "external_effect_request", requestId);
    const again = await handleRequest(req(`/api/effects/requests/${requestId}/execute`, MP, "POST", { receipt_id: freshReceipt }), env);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe("already_executed");
  });
});

// ── 6. Audit append-only (trigger level) ──

describe("6. audit tables reject UPDATE and DELETE at the database layer", () => {
  it("approval_decision and event_record are append-only", async () => {
    const cardId = await approvedCard("governance.policy_change", "fund", "fund_audit_test");
    const decision = await t.db
      .prepare("SELECT id FROM approval_decision WHERE approval_card_id = ?1 LIMIT 1")
      .bind(cardId)
      .first<{ id: string }>();
    expect(decision).toBeTruthy();

    await expect(t.db.prepare("UPDATE approval_decision SET note = 'rewrite history' WHERE id = ?1").bind(decision!.id).run()).rejects.toThrow(
      /append-only/,
    );
    await expect(t.db.prepare("DELETE FROM approval_decision WHERE id = ?1").bind(decision!.id).run()).rejects.toThrow(/append-only/);

    const evt = await t.db.prepare("SELECT id FROM event_record LIMIT 1").first<{ id: string }>();
    await expect(t.db.prepare("UPDATE event_record SET event_type = 'forged' WHERE id = ?1").bind(evt!.id).run()).rejects.toThrow(/append-only/);
    await expect(t.db.prepare("DELETE FROM event_record WHERE id = ?1").bind(evt!.id).run()).rejects.toThrow(/append-only/);

    // The rejected writes took no effect.
    const intact = await t.db.prepare("SELECT note FROM approval_decision WHERE id = ?1").bind(decision!.id).first<{ note: string }>();
    expect(intact!.note).toBe("test approval");
  });
});

// ── 7. Private visibility ──

describe("7. sensitive privacy labels are invisible without scope; visible to MP", () => {
  it("RESTRICTED / LP_PRIVATE / MNPI_SENSITIVE rows are hidden from unscoped users", async () => {
    const mkCapture = async (label: string) => {
      const res = await handleRequest(
        req("/api/captures", MP, "POST", { capture_type: "note", raw_text: `sensitive ${label}`, source_channel: "web", privacy_label: label }),
        env,
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    const restricted = await mkCapture("RESTRICTED");
    const lpPrivate = await mkCapture("LP_PRIVATE");
    const mnpi = await mkCapture("MNPI_SENSITIVE");
    const internal = await mkCapture("INTERNAL");

    const memberList = (await (
      await handleRequest(req("/api/captures", MEMBER), env)
    ).json()) as { captures: Array<{ id: string }> };
    const memberIds = memberList.captures.map((c) => c.id);
    expect(memberIds).toContain(internal);
    expect(memberIds).not.toContain(restricted);
    expect(memberIds).not.toContain(lpPrivate);
    expect(memberIds).not.toContain(mnpi);

    for (const id of [restricted, lpPrivate, mnpi]) {
      const res = await handleRequest(req(`/api/captures/${id}`, MEMBER), env);
      expect(res.status).toBe(404);
    }

    // Work cards inherit the same boundary.
    const wc = await handleRequest(
      req("/api/work-cards", MP, "POST", { title: "MNPI work", privacy_label: "MNPI_SENSITIVE" }),
      env,
    );
    const wcId = ((await wc.json()) as { id: string }).id;
    expect((await handleRequest(req(`/api/work-cards/${wcId}`, MEMBER), env)).status).toBe(404);
    const memberCards = (await (
      await handleRequest(req("/api/work-cards", MEMBER), env)
    ).json()) as { work_cards: Array<{ id: string }> };
    expect(memberCards.work_cards.map((c) => c.id)).not.toContain(wcId);

    // The MP sees everything.
    const mpList = (await (await handleRequest(req("/api/captures", MP), env)).json()) as { captures: Array<{ id: string }> };
    for (const id of [restricted, lpPrivate, mnpi, internal]) expect(mpList.captures.map((c) => c.id)).toContain(id);
    expect((await handleRequest(req(`/api/work-cards/${wcId}`, MP), env)).status).toBe(200);
  });
});

// ── 8. Approval state machine ──

describe("8. approval card state machine rejects illegal transitions", () => {
  it("drafted→executed, decided-from-draft, rejected→approved, double decisions all refused", async () => {
    const created = await handleRequest(
      req("/api/approvals", MP, "POST", { action_key: "work_card.update", object_type: "work_card", object_id: "wc_sm", title: "state machine probe" }),
      env,
    );
    const card = (await created.json()) as { id: string; state: string };
    expect(card.state).toBe("drafted");

    // drafted → approved directly: illegal (must pass through pending_review).
    const fromDraft = await handleRequest(req(`/api/approvals/${card.id}/decide`, MP, "POST", { decision: "approved" }), env);
    expect(fromDraft.status).toBe(409);
    expect(((await fromDraft.json()) as { error: string }).error).toBe("illegal_transition");

    // submit → pending_review, then reject.
    expect((await handleRequest(req(`/api/approvals/${card.id}/submit`, MP, "POST", {}), env)).status).toBe(200);
    const rejected = await handleRequest(req(`/api/approvals/${card.id}/decide`, MP, "POST", { decision: "rejected", note: "no" }), env);
    expect(rejected.status).toBe(200);

    // rejected → approved: illegal. rejected → pending_review: illegal. Both 409.
    const revive = await handleRequest(req(`/api/approvals/${card.id}/decide`, MP, "POST", { decision: "approved" }), env);
    expect(revive.status).toBe(409);
    const resubmit = await handleRequest(req(`/api/approvals/${card.id}/submit`, MP, "POST", {}), env);
    expect(resubmit.status).toBe(409);

    // revise_requested → pending_review → approved is the legal revision path.
    const card2 = (await (
      await handleRequest(
        req("/api/approvals", MP, "POST", { action_key: "work_card.update", object_type: "work_card", object_id: "wc_sm2", title: "revision path", submit: true }),
        env,
      )
    ).json()) as { id: string };
    expect((await handleRequest(req(`/api/approvals/${card2.id}/decide`, MP, "POST", { decision: "revise_requested", note: "fix summary" }), env)).status).toBe(200);
    expect((await handleRequest(req(`/api/approvals/${card2.id}/submit`, MP, "POST", {}), env)).status).toBe(200);
    expect((await handleRequest(req(`/api/approvals/${card2.id}/decide`, MP, "POST", { decision: "approved" }), env)).status).toBe(200);

    // approved → decide again: illegal.
    const double = await handleRequest(req(`/api/approvals/${card2.id}/decide`, MP, "POST", { decision: "rejected" }), env);
    expect(double.status).toBe(409);

    // Decision history is complete and always visible.
    const detail = (await (await handleRequest(req(`/api/approvals/${card2.id}`, MP), env)).json()) as {
      decisions: Array<{ decision: string }>;
    };
    expect(detail.decisions.map((d) => d.decision)).toEqual(["revise_requested", "approved"]);
  });

  it("work card state machine rejects illegal transitions", async () => {
    const created = await handleRequest(req("/api/work-cards", MP, "POST", { title: "transition probe" }), env);
    const card = (await created.json()) as { id: string; state: string };
    expect(card.state).toBe("OPEN");

    // OPEN → DONE directly: LEGAL, and this assertion was inverted until the operator found the
    // button that proved it. The rule used to be "you must start something before you can finish
    // it", which is process ceremony the product never observed: the Work page has offered "Done"
    // on every open card since it was written, and every press returned the 409 this test was
    // asserting. Plenty of work is noticed and done in the same moment.
    expect((await handleRequest(req(`/api/work-cards/${card.id}`, MP, "PATCH", { state: "DONE" }), env)).status).toBe(200);

    // Reopening it and taking the long way round is legal too.
    expect((await handleRequest(req(`/api/work-cards/${card.id}`, MP, "PATCH", { state: "OPEN" }), env)).status).toBe(200);
    expect((await handleRequest(req(`/api/work-cards/${card.id}`, MP, "PATCH", { state: "IN_PROGRESS" }), env)).status).toBe(200);
    expect((await handleRequest(req(`/api/work-cards/${card.id}`, MP, "PATCH", { state: "DONE" }), env)).status).toBe(200);

    // DONE → CANCELLED: still illegal, and this one is a real rule rather than ceremony. Something
    // that was finished was not then decided against; the honest move is to reopen it.
    const cancel = await handleRequest(req(`/api/work-cards/${card.id}`, MP, "PATCH", { state: "CANCELLED" }), env);
    expect(cancel.status).toBe(409);
    expect(((await cancel.json()) as { error: string }).error).toBe("illegal_transition");

    // A dropped card comes back. This is the operator-reported bug: "Put it back" rendered on every
    // dropped card and the transition table allowed nothing at all out of CANCELLED.
    const second = await handleRequest(req("/api/work-cards", MP, "POST", { title: "drop and restore probe" }), env);
    const dropped = (await second.json()) as { id: string };
    expect((await handleRequest(req(`/api/work-cards/${dropped.id}`, MP, "PATCH", { state: "CANCELLED" }), env)).status).toBe(200);
    expect((await handleRequest(req(`/api/work-cards/${dropped.id}`, MP, "PATCH", { state: "OPEN" }), env)).status).toBe(200);
  });
});

// ── 9. Registry guards (D14, D10) ──

describe("9. registry seeds come from the ONE TypeScript source", () => {
  it("seeds exactly 45 machines and 15 domains, matching the registry", async () => {
    const machines = await t.db.prepare("SELECT COUNT(*) AS n FROM machine").first<{ n: number }>();
    expect(machines!.n).toBe(45);
    expect(machines!.n).toBe(MACHINE_REGISTRY.length);

    const domains = await t.db.prepare("SELECT COUNT(*) AS n FROM domain").first<{ n: number }>();
    expect(domains!.n).toBe(15);
    expect(domains!.n).toBe(DOMAIN_IDS.length);

    // Spot-check: every registry row is present with its canonical id and domain.
    const row = await t.db.prepare("SELECT key, domain_id FROM machine WHERE id = 16").first<{ key: string; domain_id: string }>();
    const reg = MACHINE_REGISTRY.find((m) => m.id === 16)!;
    expect(row).toEqual({ key: reg.key, domain_id: reg.domain });
  });

  it("human_reserved_action matches the TS register exactly", async () => {
    const rows = await t.db.prepare("SELECT key, approver_roles_json FROM human_reserved_action").all<{ key: string; approver_roles_json: string }>();
    const dbMap = new Map((rows.results ?? []).map((r) => [r.key, JSON.parse(r.approver_roles_json) as string[]]));
    expect(dbMap.size).toBe(HUMAN_RESERVED_ACTIONS.length);
    for (const action of HUMAN_RESERVED_ACTIONS) {
      expect(dbMap.get(action.key), action.key).toEqual([...action.approverRoles]);
    }
  });

  it("action_type count matches the merged registry sources", async () => {
    const rows = await t.db.prepare("SELECT COUNT(*) AS n FROM action_type").first<{ n: number }>();
    expect(rows!.n).toBe(HUMAN_RESERVED_ACTIONS.length + ORDINARY_ACTION_TYPES.length + EXTERNAL_EFFECT_ACTION_TYPES.length);
    const flagged = await t.db
      .prepare("SELECT COUNT(*) AS n FROM action_type WHERE is_reserved = 1")
      .first<{ n: number }>();
    expect(flagged!.n).toBe(HUMAN_RESERVED_ACTIONS.length);
  });

  it("no Managing Partner name appears anywhere in the AI employee roster (D10)", async () => {
    for (const entry of AI_EMPLOYEE_ROSTER) {
      const name = entry.name.toLowerCase();
      for (const mpName of MANAGING_PARTNER_NAMES) {
        expect(name, `AI employee '${entry.name}' collides with MP name`).not.toContain(mpName.toLowerCase());
      }
    }
    // And no AI-employee-owned row may carry an MP name either.
    const aiOwned = await t.db
      .prepare("SELECT owner_id FROM work_card WHERE owner_type = 'AI'")
      .all<{ owner_id: string }>();
    for (const row of aiOwned.results ?? []) {
      for (const mpName of MANAGING_PARTNER_NAMES) {
        expect(row.owner_id.toLowerCase()).not.toContain(mpName.toLowerCase());
      }
    }
  });
});

// ── 10. Approval volume diagnostics (D7) ──

describe("10. approval volume endpoint reports correct counts", () => {
  it("counts fixture cards per day and flags days over 15", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    const baseline = (await (
      await handleRequest(req("/api/diagnostics/approval-volume", MP), env)
    ).json()) as { days: Array<{ date: string; count: number }> };
    const baseToday = baseline.days.find((d) => d.date === today)?.count ?? 0;
    const baseYesterday = baseline.days.find((d) => d.date === yesterday)?.count ?? 0;

    // Fixtures: +3 today, +16 yesterday (over target), +1 eight days ago.
    const insert = async (id: string, createdAt: string) => {
      await t.db
        .prepare(
          `INSERT INTO approval_card (id, action_key, object_type, object_id, title, requested_by_type, requested_by_id, required_approver_roles_json, state, created_at)
           VALUES (?1, 'work_card.update', 'work_card', 'wc_volume', 'volume fixture', 'HUMAN', 'fu_scooter_taylor', '["MANAGING_PARTNER"]', 'drafted', ?2)`,
        )
        .bind(id, createdAt)
        .run();
    };
    for (let i = 0; i < 3; i++) await insert(`apc_vol_today_${i}`, `${today}T12:00:00.000Z`);
    for (let i = 0; i < 16; i++) await insert(`apc_vol_yday_${i}`, `${yesterday}T12:00:00.000Z`);
    await insert("apc_vol_old", new Date(Date.now() - 8 * 86_400_000).toISOString());

    const volume = (await (
      await handleRequest(req("/api/diagnostics/approval-volume", MP), env)
    ).json()) as {
      targetPerDay: number;
      days: Array<{ date: string; count: number; overTarget: boolean }>;
      weekly: Array<{ week: string; count: number }>;
      daysOverTarget: string[];
    };

    expect(volume.targetPerDay).toBe(15);
    expect(volume.days).toHaveLength(14);
    expect(volume.days.find((d) => d.date === today)).toMatchObject({ count: baseToday + 3, overTarget: baseToday + 3 > 15 });
    expect(volume.days.find((d) => d.date === yesterday)).toMatchObject({ count: baseYesterday + 16, overTarget: true });
    expect(volume.daysOverTarget).toContain(yesterday);
    const total = volume.days.reduce((sum, d) => sum + d.count, 0);
    expect(total).toBe(baseToday + baseYesterday + 20 + (baseline.days.reduce((s, d) => s + d.count, 0) - baseToday - baseYesterday));
    expect(volume.weekly.length).toBeGreaterThan(0);
  });
});

// ── 12. Full governed chain leaves a typed event trail ──

describe("12. capture → work card → approval → event spine", () => {
  it("the full chain appends the correct typed events", async () => {
    const captureRes = await handleRequest(
      req("/api/captures", MP, "POST", { capture_type: "idea", raw_text: "Follow up with founder about deck", source_channel: "web" }),
      env,
    );
    const capture = (await captureRes.json()) as { id: string };

    const routed = await handleRequest(
      req(`/api/captures/${capture.id}/route`, MP, "POST", { machine_id: 21, create_work_card: true, title: "Follow up with founder" }),
      env,
    );
    expect(routed.status).toBe(200);
    const routedBody = (await routed.json()) as { capture: { status: string; routed_machine_id: number }; work_card: { id: string; domain_id: string } };
    expect(routedBody.capture.status).toBe("ROUTED");
    expect(routedBody.capture.routed_machine_id).toBe(21);
    expect(routedBody.work_card.domain_id).toBe("OPERATIONS_OS");

    const cardId = await approvedCard("external_effect.execute", "work_card", routedBody.work_card.id);

    const events = await t.db
      .prepare(
        `SELECT event_type, object_type, object_id FROM event_record
          WHERE object_id IN (?1, ?2, ?3) ORDER BY created_at, id`,
      )
      .bind(capture.id, routedBody.work_card.id, cardId)
      .all<{ event_type: string; object_type: string; object_id: string }>();
    const types = (events.results ?? []).map((e) => e.event_type);
    expect(types).toContain("capture.created");
    expect(types).toContain("capture.routed");
    expect(types).toContain("work_card.created");
    expect(types).toContain("approval.requested");
    expect(types).toContain("approval.submitted");
    expect(types).toContain("approval.decided");

    // The Activity feed is a view over the same spine, newest first.
    const feed = (await (await handleRequest(req("/api/activity?limit=5", MP), env)).json()) as {
      events: Array<{ event_type: string; created_at: string }>;
    };
    expect(feed.events.length).toBeGreaterThan(0);
    expect(feed.events[0]!.event_type).toBe("approval.decided");
    const createdAts = feed.events.map((e) => e.created_at);
    expect([...createdAts].sort().reverse()).toEqual(createdAts);
  });
});

// ── 3b/4b. Reserved execution paths consume receipts (merge, service-level) ──

describe("reserved execution requires an approved, object-matching receipt", () => {
  it("merge without a receipt is 409 approval_required; with one it executes and consumes", async () => {
    const mk = async (name: string) => {
      const res = await handleRequest(req("/api/companies", MP, "POST", { canonical_name: name }), env);
      return ((await res.json()) as { id: string }).id;
    };
    const source = await mk("Receipt Merge Source");
    const target = await mk("Receipt Merge Target");

    const noReceipt = await handleRequest(req(`/api/companies/${source}/merge-into/${target}`, MP, "POST", {}), env);
    expect(noReceipt.status).toBe(409);
    expect(((await noReceipt.json()) as { error: string }).error).toBe("approval_required");

    const receipt = await approvedCard("identity_merge.execute", "canonical_company", source);
    const ok = await handleRequest(req(`/api/companies/${source}/merge-into/${target}`, MP, "POST", { approval_receipt_id: receipt }), env);
    expect(ok.status).toBe(201);

    const card = await t.db.prepare("SELECT state FROM approval_card WHERE id = ?1").bind(receipt).first<{ state: string }>();
    expect(card!.state).toBe("executed");

    // Replaying the consumed receipt against a fresh pair is refused.
    const source2 = await mk("Receipt Merge Source 2");
    const target2 = await mk("Receipt Merge Target 2");
    const replay = await handleRequest(req(`/api/companies/${source2}/merge-into/${target2}`, MP, "POST", { approval_receipt_id: receipt }), env);
    expect(replay.status).toBe(409);
  });
});

// ── ApprovalError shape sanity ──

describe("approval service errors are typed", () => {
  it("unknown cards and unknown actions fail cleanly", async () => {
    await expect(decideApproval(env, MP_ACTOR, "apc_missing", "approved")).rejects.toBeInstanceOf(ApprovalError);
    await expect(
      requestApproval(env, MP_ACTOR, { action_key: "not.an.action", object_type: "x", object_id: "y", title: "z" }),
    ).rejects.toMatchObject({ status: 400, code: "unknown_action" });
  });
});

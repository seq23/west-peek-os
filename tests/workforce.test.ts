import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { changeLifecycle, computeScorecard, decideHandoff, postRoomMessage, proposeHandoff } from "../src/worker/services/workforce";
import { runAi } from "../src/worker/ai/runAi";

/**
 * P15 — Employee Lounge, Digital Office, Performance Management (GAP-01, GAP-10, GAP-11).
 *
 * Rules under test:
 * - The lounge exposes the WHOLE roster with department, manager, machines, tool scope,
 *   current work, recent runs, and cost — from the governed records, not a second store.
 * - The D10 activation law is untouched: nothing on this surface raises an employee to
 *   ACTIVE, `lifecycle` refuses ACTIVE outright, and RETIRED is terminal on this path.
 * - AI can never change a lifecycle state, decide a handoff, record a review, or post an
 *   unreferenced firm announcement.
 * - Collaboration maps to work: a room message must name a real work card, AI run, or
 *   handoff, and a message naming a non-existent record is refused.
 * - Accepting a handoff actually MOVES the work card's owner; work cannot be handed to a
 *   non-ACTIVE employee.
 * - Scorecards are deterministic counts with their definition stored alongside, and no
 *   subjective "value generated" figure is persisted anywhere.
 * - Rooms, memos, reviews, acknowledgements, and snapshots are append-only at the DB layer.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const MEMBER = { "x-wpos-dev-user": "member@westpeek.ventures" };

const MP_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
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

/** Activate an employee through the ONLY governed path: reserved card → approval → receipt. */
async function activate(employeeId: string): Promise<void> {
  const card = await call<{ id: string }>(`/api/ai/employees/${employeeId}/request-activation`, MP, "POST", { reason: "P15 test" });
  expect(card.status).toBe(201);
  await call(`/api/approvals/${card.body.id}/decide`, MP, "POST", { decision: "approved", note: "approved for test" });
  const activated = await call<{ status: string }>(`/api/ai/employees/${employeeId}/activate`, MP, "POST", {
    approval_receipt_id: card.body.id,
    reason: "P15 test",
  });
  expect(activated.status).toBe(200);
  expect(activated.body.status).toBe("ACTIVE");
}

let seq = 0;
async function makeWorkCard(): Promise<string> {
  seq += 1;
  const res = await call<{ id: string }>("/api/work-cards", MP, "POST", { title: `P15 card ${seq}`, priority: "NORMAL" });
  expect(res.status).toBe(201);
  return res.body.id;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  await t.db
    .prepare("INSERT INTO firm_user (id, email, full_name, status) VALUES ('fu_test_member', 'member@westpeek.ventures', 'Test Member', 'ACTIVE')")
    .run();
  await t.db.prepare("INSERT INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_test_member', 'role_investment_team')").run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("the lounge turns the roster into an operating surface", () => {
  it("lists all 31 employees with department, machines, scope, work, and cost", async () => {
    const res = await call<{ employees: any[]; departments: string[]; active_count: number; max_active: number; activation_law: string }>(
      "/api/workforce/lounge",
      MP,
    );
    expect(res.status).toBe(200);
    expect(res.body.employees).toHaveLength(31);
    expect(res.body.max_active).toBe(5);
    expect(res.body.departments.length).toBeGreaterThan(3);
    expect(res.body.activation_law).toContain("ai_employee.activate");

    const walker = res.body.employees.find((e: any) => e.name === "Walker")!;
    expect(walker.department).toBe("MP Support");
    expect(walker.avatar_initials).toBe("WA");
    expect(walker.primary_machines).toContain("command_center");
    expect(walker.status).toBe("INACTIVE");
    expect(Array.isArray(walker.current_work)).toBe(true);
    expect(typeof walker.cost_30d_usd).toBe("number");
  });

  it("gives every employee a department room seeded from the roster", async () => {
    const res = await call<{ rooms: any[]; rule: string }>("/api/workforce/rooms", MP);
    expect(res.status).toBe(200);
    expect(res.body.rooms.length).toBeGreaterThan(3);
    expect(res.body.rule).toContain("references a work card");
  });

  it("returns a full employee detail with the scorecard definition attached", async () => {
    const res = await call<{ employee: any; profile: any; scorecard_definition: Record<string, string> }>(
      "/api/workforce/employees/aie_paige",
      MP,
    );
    expect(res.status).toBe(200);
    expect(res.body.employee.name).toBe("Paige");
    expect(res.body.profile.department).toBe("Investment/IC/Meeting");
    expect(res.body.scorecard_definition.not_measured).toContain("No 'value generated' figure is stored");
  });
});

describe("profile and machine assignment are human acts", () => {
  it("sets department, manager, and brief", async () => {
    const res = await call<{ department: string; manager_employee_id: string; brief: string }>(
      "/api/workforce/employees/aie_priya/profile",
      MP,
      "PATCH",
      { department: "Investment/IC/Meeting", manager_employee_id: "aie_pierce", brief: "Associate covering secondaries diligence." },
    );
    expect(res.status).toBe(200);
    expect(res.body.manager_employee_id).toBe("aie_pierce");
    expect(res.body.brief).toContain("secondaries");
  });

  it("refuses to let an employee manage itself", async () => {
    const res = await call("/api/workforce/employees/aie_priya/profile", MP, "PATCH", { manager_employee_id: "aie_priya" });
    expect(res.status).toBe(400);
  });

  it("assigns a machine from the 45-machine registry and refuses an unknown one", async () => {
    const ok = await call<{ machine_id: number }>("/api/workforce/employees/aie_paige/machines", MP, "POST", { machine_id: 23 });
    expect(ok.status).toBe(201);
    expect(ok.body.machine_id).toBe(23);

    const bad = await call("/api/workforce/employees/aie_paige/machines", MP, "POST", { machine_id: 999 });
    expect(bad.status).toBe(404);

    const lounge = await call<{ employees: any[] }>("/api/workforce/lounge", MP);
    expect(lounge.body.employees.find((e: any) => e.id === "aie_paige")!.assigned_machine_ids).toContain(23);
  });
});

describe("the D10 activation law survives the new surface", () => {
  it("has no path to ACTIVE: the lifecycle route only accepts lowering states", async () => {
    const res = await call("/api/workforce/employees/aie_walker/lifecycle", MP, "POST", { to_status: "ACTIVE", reason: "try it" });
    expect(res.status).toBe(400);
  });

  it("lets a human pause an ACTIVE employee and records it on the same status history", async () => {
    await activate("aie_paige");
    const paused = await call<{ status: string }>("/api/workforce/employees/aie_paige/lifecycle", MP, "POST", {
      to_status: "PAUSED",
      reason: "cost review",
    });
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe("PAUSED");

    const history = await t.db
      .prepare("SELECT * FROM ai_employee_status_history WHERE ai_employee_id = 'aie_paige' ORDER BY created_at DESC LIMIT 1")
      .first<{ from_status: string; to_status: string; approval_receipt_id: string | null; reason: string }>();
    expect(history!.from_status).toBe("ACTIVE");
    expect(history!.to_status).toBe("PAUSED");
    // Lowering needs no capital-grade receipt — it removes capability rather than granting it.
    expect(history!.approval_receipt_id).toBeNull();
    expect(history!.reason).toBe("cost review");
  });

  it("refuses the same state twice and treats RETIRED as terminal on this path", async () => {
    const again = await call("/api/workforce/employees/aie_paige/lifecycle", MP, "POST", { to_status: "PAUSED", reason: "again" });
    expect(again.status).toBe(409);

    await call("/api/workforce/employees/aie_wyatt/lifecycle", MP, "POST", { to_status: "RETIRED", reason: "not needed" });
    const afterRetire = await call("/api/workforce/employees/aie_wyatt/lifecycle", MP, "POST", { to_status: "PAUSED", reason: "undo" });
    expect(afterRetire.status).toBe(409);
    expect((afterRetire.body as any).error).toBe("retired_is_terminal");
  });

  it("an AI actor can never change any lifecycle state", async () => {
    await expect(changeLifecycle(env, AI_ACTOR, "aie_pierce", "RESTRICTED", "self-service")).rejects.toThrow(/human-reserved/);
  });

  it("still enforces the ≤5 ACTIVE cap through the reserved path", async () => {
    const lounge = await call<{ active_count: number; max_active: number }>("/api/workforce/lounge", MP);
    expect(lounge.body.active_count).toBeLessThanOrEqual(lounge.body.max_active);
  });
});

describe("the digital office maps collaboration to work", () => {
  it("accepts a message that references a real work card", async () => {
    const cardId = await makeWorkCard();
    const res = await call<{ id: string; context_kind: string }>("/api/workforce/rooms/investment_ic_meeting/messages", MP, "POST", {
      context_kind: "WORK_CARD",
      context_id: cardId,
      body: "Picking this up; diligence questions drafted.",
    });
    expect(res.status).toBe(201);
    expect(res.body.context_kind).toBe("WORK_CARD");
  });

  it("refuses a message that names a record which does not exist", async () => {
    const res = await call("/api/workforce/rooms/investment_ic_meeting/messages", MP, "POST", {
      context_kind: "WORK_CARD",
      context_id: "wc_imaginary",
      body: "About that card…",
    });
    expect(res.status).toBe(404);
  });

  it("refuses a referenced message with no reference at all", async () => {
    const res = await call("/api/workforce/rooms/investment_ic_meeting/messages", MP, "POST", {
      context_kind: "AI_RUN",
      body: "no id supplied",
    });
    expect(res.status).toBe(400);
  });

  it("lets a HUMAN make a firm announcement but never an AI employee", async () => {
    const human = await call("/api/workforce/rooms/investment_ic_meeting/messages", MP, "POST", {
      context_kind: "ANNOUNCEMENT",
      body: "Reminder: IC packets close Thursday.",
    });
    expect(human.status).toBe(201);

    await expect(
      postRoomMessage(env, AI_ACTOR, "investment_ic_meeting", { context_kind: "ANNOUNCEMENT", body: "Hello firm", mentions: [] }),
    ).rejects.toThrow(/only a human/);
  });

  it("keeps room messages append-only at the database layer", async () => {
    const msg = await t.db.prepare("SELECT id FROM room_message LIMIT 1").first<{ id: string }>();
    await expect(t.db.prepare("UPDATE room_message SET body = 'rewritten' WHERE id = ?1").bind(msg!.id).run()).rejects.toThrow(/append-only/);
    await expect(t.db.prepare("DELETE FROM room_message WHERE id = ?1").bind(msg!.id).run()).rejects.toThrow(/append-only/);
  });
});

describe("handoffs move real work and stay human-decided", () => {
  it("an AI may PROPOSE a handoff but can never accept it", async () => {
    await activate("aie_pierce");
    const cardId = await makeWorkCard();
    const proposed = (await proposeHandoff(env, AI_ACTOR, {
      work_card_id: cardId,
      to_employee_id: "aie_pierce",
      reason: "Pierce owns early-stage diligence",
    })) as { id: string; status: string };
    expect(proposed.status).toBe("PROPOSED");

    await expect(decideHandoff(env, AI_ACTOR, proposed.id, { decision: "ACCEPTED" })).rejects.toThrow(/human-reserved/);

    const accepted = await call<{ status: string }>(`/api/workforce/handoffs/${proposed.id}/decide`, MP, "POST", {
      decision: "ACCEPTED",
      note: "agreed",
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe("ACCEPTED");

    // The work card actually moved.
    const card = await t.db.prepare("SELECT owner_type, owner_id FROM work_card WHERE id = ?1").bind(cardId).first<{ owner_type: string; owner_id: string }>();
    expect(card!.owner_type).toBe("AI");
    expect(card!.owner_id).toBe("aie_pierce");
  });

  it("refuses to hand work to an employee who is not ACTIVE", async () => {
    const cardId = await makeWorkCard();
    const res = await call("/api/workforce/handoffs", MP, "POST", {
      work_card_id: cardId,
      to_employee_id: "aie_wendy",
      reason: "she is inactive",
    });
    expect(res.status).toBe(409);
    expect((res.body as any).error).toBe("target_not_active");
  });

  it("refuses a second decision on the same handoff", async () => {
    const cardId = await makeWorkCard();
    const proposed = await call<{ id: string }>("/api/workforce/handoffs", MP, "POST", {
      work_card_id: cardId,
      to_employee_id: "aie_pierce",
      reason: "reassign",
    });
    await call(`/api/workforce/handoffs/${proposed.body.id}/decide`, MP, "POST", { decision: "REJECTED" });
    const again = await call(`/api/workforce/handoffs/${proposed.body.id}/decide`, MP, "POST", { decision: "ACCEPTED" });
    expect(again.status).toBe(409);
  });

  it("a rejected handoff does NOT move the work card", async () => {
    const cardId = await makeWorkCard();
    const proposed = await call<{ id: string }>("/api/workforce/handoffs", MP, "POST", {
      work_card_id: cardId,
      to_employee_id: "aie_pierce",
      reason: "maybe",
    });
    await call(`/api/workforce/handoffs/${proposed.body.id}/decide`, MP, "POST", { decision: "REJECTED", note: "no" });
    const card = await t.db.prepare("SELECT owner_type, owner_id FROM work_card WHERE id = ?1").bind(cardId).first<{ owner_type: string; owner_id: string | null }>();
    expect(card!.owner_id).toBeNull();
  });
});

describe("performance is deterministic, defined, and never dressed up as money", () => {
  it("counts real runs and stores the definition it used", async () => {
    // Two governed runs attributed to an employee: one completes, one is blocked by policy.
    await runAi(env, {
      purpose: "P15 scorecard probe",
      actor: { type: "AI", aiEmployeeId: "aie_pierce", roles: [], firmScopes: ["west-peek"] },
      inputs: ["a normal request"],
      sensitivity: "INTERNAL",
      aiEmployeeId: "aie_pierce",
    });
    await runAi(env, {
      purpose: "P15 scorecard probe with a credential",
      actor: { type: "AI", aiEmployeeId: "aie_pierce", roles: [], firmScopes: ["west-peek"] },
      inputs: ["sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd"],
      sensitivity: "INTERNAL",
      aiEmployeeId: "aie_pierce",
    });

    const res = await call<{ snapshot: any; definition: Record<string, string> }>("/api/workforce/employees/aie_pierce/scorecard", MP, "POST", {});
    expect(res.status).toBe(201);
    const s = res.body.snapshot;
    expect(s.runs_total).toBeGreaterThanOrEqual(2);
    expect(s.runs_blocked).toBeGreaterThanOrEqual(1);
    expect(s.outputs_accepted).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(s.definition_json).runs_blocked).toContain("governed pipeline refused");
    // A recurring failure cause is named rather than buried.
    const patterns = JSON.parse(s.failure_patterns_json) as Array<{ reason: string; count: number }>;
    expect(patterns.some((p) => p.reason.includes("credential_like_content"))).toBe(true);
  });

  it("reports cost per accepted output as null when nothing was accepted", async () => {
    const snapshot = (await computeScorecard(env, MP_ACTOR, "aie_wells", {
      start: "2020-01-01T00:00:00.000Z",
      end: "2020-01-02T00:00:00.000Z",
    })) as { runs_total: number; cost_per_accepted_output: number | null };
    expect(snapshot.runs_total).toBe(0);
    expect(snapshot.cost_per_accepted_output).toBeNull();
  });

  it("stores no subjective value column anywhere in the snapshot", async () => {
    const cols = await t.db.prepare("PRAGMA table_info(employee_performance_snapshot)").all<{ name: string }>();
    const names = (cols.results ?? []).map((c) => c.name);
    expect(names).not.toContain("value_generated");
    expect(names).not.toContain("value_usd");
    expect(names).toContain("cost_per_accepted_output");
  });

  it("keeps snapshots immutable", async () => {
    const s = await t.db.prepare("SELECT id FROM employee_performance_snapshot LIMIT 1").first<{ id: string }>();
    await expect(t.db.prepare("UPDATE employee_performance_snapshot SET runs_total = 999 WHERE id = ?1").bind(s!.id).run()).rejects.toThrow(/immutable/);
  });

  it("an AI can never compute a scorecard or record a review", async () => {
    await expect(
      computeScorecard(env, AI_ACTOR, "aie_pierce", { start: "2020-01-01T00:00:00.000Z", end: "2030-01-01T00:00:00.000Z" }),
    ).rejects.toThrow(/human-reserved/);
  });
});

describe("manager review and lifecycle stay consistent", () => {
  it("a RESTRICT disposition applies the restriction, so record and state cannot disagree", async () => {
    const res = await call<{ review: any; employee: any }>("/api/workforce/employees/aie_pierce/reviews", MP, "POST", {
      finding: "Repeated egress blocks on drafted inputs",
      disposition: "RESTRICT",
      note: "tighten inputs before reactivation",
    });
    expect(res.status).toBe(201);
    expect(res.body.review.disposition).toBe("RESTRICT");
    expect(res.body.employee.status).toBe("RESTRICTED");
  });

  it("a CONTINUE disposition changes nothing about the lifecycle", async () => {
    const before = await call<{ employee: { status: string } }>("/api/workforce/employees/aie_wells", MP);
    const res = await call<{ employee: any }>("/api/workforce/employees/aie_wells/reviews", MP, "POST", {
      finding: "Nothing to flag",
      disposition: "CONTINUE",
    });
    expect(res.status).toBe(201);
    expect(res.body.employee.status).toBe(before.body.employee.status);
  });

  it("keeps reviews append-only", async () => {
    const r = await t.db.prepare("SELECT id FROM employee_review LIMIT 1").first<{ id: string }>();
    await expect(t.db.prepare("UPDATE employee_review SET finding = 'x' WHERE id = ?1").bind(r!.id).run()).rejects.toThrow(/append-only/);
  });
});

describe("memos and governance acknowledgement", () => {
  it("requires a department on a department memo", async () => {
    const bad = await call("/api/workforce/memos", MP, "POST", { audience: "DEPARTMENT", title: "t", body: "b" });
    expect(bad.status).toBe(400);
  });

  it("publishes a firm memo append-only", async () => {
    const res = await call<{ id: string }>("/api/workforce/memos", MP, "POST", {
      audience: "FIRM",
      title: "Operating note",
      body: "Handoffs now require a human decision.",
    });
    expect(res.status).toBe(201);
    await expect(t.db.prepare("UPDATE internal_memo SET title = 'x' WHERE id = ?1").bind(res.body.id).run()).rejects.toThrow(/append-only/);
  });

  it("records one acknowledgement per actor per governance update", async () => {
    const update = await call<{ id: string }>("/api/governance/updates", MP, "POST", {
      update_type: "RULE",
      title: "Handoff rule",
      body: "AI proposes, humans decide.",
    });
    expect(update.status).toBe(201);
    const first = await call(`/api/governance/updates/${update.body.id}/acknowledge`, MEMBER, "POST");
    expect(first.status).toBe(201);
    const second = await call(`/api/governance/updates/${update.body.id}/acknowledge`, MEMBER, "POST");
    expect(second.status).toBe(409);
  });
});

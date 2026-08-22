import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import { AI_EMPLOYEE_ROSTER } from "@shared/registry/aiEmployees";
import { ACTIVE_MACHINES, MACHINE_REGISTRY } from "@shared/registry/machines";
import { resolveDuty } from "@shared/workforce/dutyRoster";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { changeLifecycle, computeScorecard, decideHandoff, postRoomMessage, proposeHandoff } from "../src/worker/services/workforce";
import { employEmployee } from "../src/worker/services/aiEmployees";
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
const AI_ACTOR: Actor = { type: "AI", aiEmployeeId: "aie_wyatt", roles: [], firmScopes: ["west-peek"] };

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
/**
 * Make sure this seat is employed — and since migration 0136 employed the whole roster, that is
 * usually already true.
 *
 * The helper's contract is "this employee is ACTIVE when I return", not "I was the one who did it".
 * Insisting on performing the activation made every test that used it depend on the roster starting
 * empty, which stopped being the case the day the partners employed everybody.
 */
async function activate(employeeId: string): Promise<void> {
  const already = await t.db
    .prepare("SELECT status FROM ai_employee WHERE id = ?1")
    .bind(employeeId)
    .first<{ status: string }>();
  if (already?.status === "ACTIVE") return;

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

/**
 * Make sure this seat is NOT employed — the mirror of `activate`, and needed for the same reason.
 *
 * Migration 0136 employed the whole roster, so "an employee who is not ACTIVE" stopped being
 * something a test could find lying around. A test that needs an unemployed seat has to CREATE that
 * precondition; one that inherits it from the seed is testing the seed as much as the mechanism,
 * and breaks the day the seed changes — which is exactly what happened here.
 *
 * The status history is deliberately NOT cleaned up afterwards, and cannot be:
 * `ai_employee_status_history` refuses DELETE at the database because it is append-only by design.
 * A test is not entitled to an exception, so anything that cares about the trail asserts what a call
 * ADDS rather than what the table holds.
 */
async function standDown(employeeId: string, status: "INACTIVE" | "PAUSED" = "INACTIVE"): Promise<void> {
  await t.db.prepare("UPDATE ai_employee SET status = ?2 WHERE id = ?1").bind(employeeId, status).run();
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
  it("lists every employee with department, machines, scope, work, and cost", async () => {
    const res = await call<{ employees: any[]; departments: string[]; active_count: number; max_active: number; activation_law: string }>(
      "/api/workforce/lounge",
      MP,
    );
    expect(res.status).toBe(200);

    /*
     * THE COUNT IS OF LIVE SEATS, NOT OF ROWS, and the difference is the whole rule.
     *
     * The lounge lists every row the database holds, RETIRED ones included — a retired seat can be
     * brought back from this surface, so hiding it would remove the only way to do it. But a seat
     * that has been culled from the registry does not disappear from the database: ai_employee rows
     * are seeded by migration, migrations are append-only, and the seed generator only ever
     * INSERTs. Dropping a name from `aiEmployees.ts` would therefore leave a ghost employee in
     * production for ever — the same trap as deleting a machine row that live work cards point at.
     *
     * So the seat is RETIRED in the database (migration 0126) and the count reconciles here: the
     * NON-RETIRED rows are exactly the registry, and anything extra is a row that outlived its
     * seat. Counted from the registry rather than a literal — the roster has been 31, 17, 19 and is
     * 18 since LP Sourcing merged into LP Relations.
     */
    const live = res.body.employees.filter((e: any) => e.status !== "RETIRED");
    expect(live).toHaveLength(AI_EMPLOYEE_ROSTER.length);
    expect(new Set(live.map((e: any) => e.name))).toEqual(new Set(AI_EMPLOYEE_ROSTER.map((e) => e.name)));

    /*
     * THE MERGED SEAT SURVIVES — but that cannot be asserted from a row here, and the distinction
     * matters more than the assertion did.
     *
     * A FRESH database seeds from the regenerated `0004`, which now carries 18 employees: Piper was
     * never inserted, so migration `0126`'s retirement finds nothing to update and there is no row
     * to find. PRODUCTION is the opposite case — it seeded 19 back when 0004 said 19, and the
     * migration turns that row RETIRED rather than deleting it, which is the whole point: deleting
     * it would break ai_run attribution and meeting seating and erase what she actually did.
     *
     * So the guarantee lives in the migration, and that is where it is checked. Asserting a row
     * here passed only on a database shaped like production and failed everywhere else.
     */
    const retire = readFileSync(
      new URL("../migrations/0129_ai_employee_retire.sql", import.meta.url),
      "utf8",
    );
    expect(retire).toMatch(/UPDATE ai_employee\s+SET status = 'RETIRED'/);
    expect(retire).not.toMatch(/DELETE\s+FROM ai_employee/i);
    // And where such a row DOES exist — production, and any database seeded before the merge — the
    // lounge must report it as retired rather than as a working seat.
    for (const e of res.body.employees.filter((x: any) => !AI_EMPLOYEE_ROSTER.some((r) => r.name === x.name))) {
      expect(e.status, `${e.name} is off the roster and must read as retired`).toBe("RETIRED");
    }

    // max_active is the whole ROSTER: employment and attention were one number and are not any
    // more. Everyone on the roster may be employed; who is ON DUTY is the short list, and that
    // rotates. It counts seats, so a retired row does not raise the cap.
    expect(res.body.max_active).toBe(AI_EMPLOYEE_ROSTER.length);
    expect(res.body.departments.length).toBeGreaterThan(3);
    expect(res.body.activation_law).toContain("ai_employee.activate");

    const walker = res.body.employees.find((e: any) => e.name === "Walker")!;
    expect(walker.department).toBe("MP Support");
    expect(walker.avatar_initials).toBe("WA");
    expect(walker.primary_machines).toContain("command_center");
    /*
     * ACTIVE since migration 0136. Employment and DUTY were one number and are not any more:
     * everyone on the roster is employed, and `dutyRoster.ts` governs who is actually covering the
     * hours. Asserting INACTIVE here pinned the old conflation, where hiring somebody was the only
     * way to hear from them and firing them was the only way to get quiet.
     */
    expect(walker.status).toBe("ACTIVE");
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
      "/api/workforce/employees/aie_wyatt",
      MP,
    );
    expect(res.status).toBe(200);
    expect(res.body.employee.name).toBe("Wyatt");
    expect(res.body.profile.department).toBe("Investment");
    expect(res.body.scorecard_definition.not_measured).toContain("No 'value generated' figure is stored");
  });
});

describe("profile and machine assignment are human acts", () => {
  it("sets department, manager, and brief", async () => {
    const res = await call<{ department: string; manager_employee_id: string; brief: string }>(
      "/api/workforce/employees/aie_pierce/profile",
      MP,
      "PATCH",
      { department: "Investment", manager_employee_id: "aie_walker", brief: "Investment lead covering secondaries diligence." },
    );
    expect(res.status).toBe(200);
    expect(res.body.manager_employee_id).toBe("aie_walker");
    expect(res.body.brief).toContain("secondaries");
  });

  it("refuses to let an employee manage itself", async () => {
    const res = await call("/api/workforce/employees/aie_pierce/profile", MP, "PATCH", { manager_employee_id: "aie_pierce" });
    expect(res.status).toBe(400);
  });

  it("assigns a machine that is in the registry and refuses one that is not", async () => {
    // Both ids come FROM the registry — a real row, and one past the end of it. Naming the fleet
    // size in the title dated this test twice already (45 → 46 when `venture_teaching` was added).
    const real = ACTIVE_MACHINES[Math.floor(ACTIVE_MACHINES.length / 2)]!.id;
    const unknown = Math.max(...MACHINE_REGISTRY.map((m) => m.id)) + 1;

    const ok = await call<{ machine_id: number }>("/api/workforce/employees/aie_wyatt/machines", MP, "POST", { machine_id: real });
    expect(ok.status).toBe(201);
    expect(ok.body.machine_id).toBe(real);

    const bad = await call("/api/workforce/employees/aie_wyatt/machines", MP, "POST", { machine_id: unknown });
    expect(bad.status).toBe(404);

    const lounge = await call<{ employees: any[] }>("/api/workforce/lounge", MP);
    expect(lounge.body.employees.find((e: any) => e.id === "aie_wyatt")!.assigned_machine_ids).toContain(real);
  });
});

describe("the D10 activation law survives the new surface", () => {
  it("has no path to ACTIVE: the lifecycle route only accepts lowering states", async () => {
    const res = await call("/api/workforce/employees/aie_walker/lifecycle", MP, "POST", { to_status: "ACTIVE", reason: "try it" });
    expect(res.status).toBe(400);
  });

  it("lets a human pause an ACTIVE employee and records it on the same status history", async () => {
    await activate("aie_wyatt");
    const paused = await call<{ status: string }>("/api/workforce/employees/aie_wyatt/lifecycle", MP, "POST", {
      to_status: "PAUSED",
      reason: "cost review",
    });
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe("PAUSED");

    const history = await t.db
      .prepare("SELECT * FROM ai_employee_status_history WHERE ai_employee_id = 'aie_wyatt' ORDER BY created_at DESC LIMIT 1")
      .first<{ from_status: string; to_status: string; approval_receipt_id: string | null; reason: string }>();
    expect(history!.from_status).toBe("ACTIVE");
    expect(history!.to_status).toBe("PAUSED");
    // Lowering needs no capital-grade receipt — it removes capability rather than granting it.
    expect(history!.approval_receipt_id).toBeNull();
    expect(history!.reason).toBe("cost review");
  });

  it("refuses the same state twice and treats RETIRED as terminal on this path", async () => {
    const again = await call("/api/workforce/employees/aie_wyatt/lifecycle", MP, "POST", { to_status: "PAUSED", reason: "again" });
    expect(again.status).toBe(409);

    await call("/api/workforce/employees/aie_wyatt/lifecycle", MP, "POST", { to_status: "RETIRED", reason: "not needed" });
    const afterRetire = await call("/api/workforce/employees/aie_wyatt/lifecycle", MP, "POST", { to_status: "PAUSED", reason: "undo" });
    expect(afterRetire.status).toBe(409);
    expect((afterRetire.body as any).error).toBe("retired_is_terminal");
  });

  it("an AI actor can never change any lifecycle state", async () => {
    await expect(changeLifecycle(env, AI_ACTOR, "aie_pierce", "RESTRICTED", "self-service")).rejects.toThrow(/human-reserved/);
  });

  /*
   * REMOVED, 22 Aug 2026: "still enforces the ≤5 ACTIVE cap through the reserved path". Its title
   * had been false since the cap became the whole roster, and its body only asserted
   * `active_count <= max_active` — true of any two numbers the same query produced, so it could
   * not fail. The cap that CAN fail is asserted where it means something: `max_active` equals the
   * registry length in the lounge test above, and `tests/ai.test.ts` proves a refused activation
   * is atomic.
   */
});

describe("employing someone is one press, and the trail says who", () => {
  /**
   * Operator direction, 21 Aug 2026: one button, an audit trail of who and when, and an optional
   * reason. The governance question this has to answer is whether collapsing five steps into one
   * skipped any of them — so these assert on the RECORDS, not on the response.
   */
  it("employs a never-hired employee in a single call, and writes the whole chain", async () => {
    /*
     * The precondition is CREATED rather than assumed. Migration 0136 employed the whole roster, so
     * "a never-hired employee" no longer exists by default — and a test that depended on the roster
     * happening to start empty was testing the seed as much as the mechanism. Setting the state it
     * needs makes it prove the same thing on any starting roster.
     */
    await standDown("aie_wren");

    const before = await t.db
      .prepare("SELECT COUNT(*) AS n FROM approval_card WHERE action_key = 'ai_employee.activate' AND object_id = 'aie_wren'")
      .first<{ n: number }>();
    expect(before!.n).toBe(0);

    const res = await call<{ outcome: string; note: string }>("/api/ai/employees/aie_wren/employ", MP, "POST", {
      employed: true,
      reason: "needed on the LP work",
    });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("EMPLOYED");

    // An approval card exists, was decided by a named human, and was consumed. Nothing was faked.
    const card = await t.db
      .prepare(
        `SELECT state, decided_by, summary FROM approval_card
          WHERE action_key = 'ai_employee.activate' AND object_id = 'aie_wren'`,
      )
      .first<{ state: string; decided_by: string; summary: string }>();
    expect(card!.decided_by).toBe("fu_scooter_taylor");
    expect(card!.summary).toBe("needed on the LP work");

    const decision = await t.db
      .prepare("SELECT decision, decided_by FROM approval_decision WHERE approval_card_id = (SELECT id FROM approval_card WHERE object_id = 'aie_wren' LIMIT 1)")
      .first<{ decision: string; decided_by: string }>();
    expect(decision!.decision).toBe("approved");
    expect(decision!.decided_by).toBe("fu_scooter_taylor");

    // The trail: who, when, why, and against which receipt.
    const history = await t.db
      .prepare("SELECT to_status, actor_id, reason, approval_receipt_id FROM ai_employee_status_history WHERE ai_employee_id = 'aie_wren' ORDER BY created_at DESC LIMIT 1")
      .first<{ to_status: string; actor_id: string; reason: string; approval_receipt_id: string | null }>();
    expect(history!.to_status).toBe("ACTIVE");
    expect(history!.actor_id).toBe("fu_scooter_taylor");
    expect(history!.reason).toBe("needed on the LP work");
    expect(history!.approval_receipt_id).toBeTruthy();
  });

  it("reads the trail back onto the surface where the decision is made", async () => {
    const lounge = await call<{ employees: Array<{ id: string; ever_employed: boolean; last_status_change: { by: string; reason: string | null } | null }> }>(
      "/api/workforce/lounge",
      MP,
    );
    const walker = lounge.body.employees.find((e) => e.id === "aie_wren")!;
    expect(walker.ever_employed).toBe(true);
    // The name, not the id — an audit trail nobody can read is not one.
    expect(walker.last_status_change!.by).not.toBe("fu_scooter_taylor");
    expect(walker.last_status_change!.reason).toBe("needed on the LP work");
  });

  it("turns someone off and back on without a second approval, reason optional throughout", async () => {
    const off = await call<{ outcome: string }>("/api/ai/employees/aie_wren/employ", MP, "POST", { employed: false });
    expect(off.status).toBe(200);
    expect(off.body.outcome).toBe("PAUSED");

    const on = await call<{ outcome: string }>("/api/ai/employees/aie_wren/employ", MP, "POST", { employed: true });
    expect(on.status).toBe(200);
    expect(on.body.outcome).toBe("RESUMED");

    // Exactly one activation card ever, however many times they go on and off.
    const cards = await t.db
      .prepare("SELECT COUNT(*) AS n FROM approval_card WHERE action_key = 'ai_employee.activate' AND object_id = 'aie_wren'")
      .first<{ n: number }>();
    expect(cards!.n).toBe(1);
  });

  it("only requests, for somebody who could not have approved it", async () => {
    // Same precondition discipline as above: the seat has to be unemployed for "employ them" to be
    // a request at all, and since 0136 nobody is unemployed by default. Stand them down first so
    // the test proves the AUTHORITY rule rather than inheriting a starting roster.
    await standDown("aie_winter");

    const res = await call<{ outcome: string; note: string }>("/api/ai/employees/aie_winter/employ", MEMBER, "POST", {
      employed: true,
      reason: "we need a scout",
    });
    // 202: filed, not done. The one-press collapse is available only to the person who holds the
    // authority — for everyone else the governance is exactly as it was.
    expect(res.status).toBe(202);
    expect(res.body.outcome).toBe("AWAITING_APPROVAL");

    const winter = await t.db.prepare("SELECT status FROM ai_employee WHERE id = 'aie_winter'").first<{ status: string }>();
    expect(winter!.status).not.toBe("ACTIVE");
  });

  it("an AI employee can never employ anybody, including itself", async () => {
    await expect(employEmployee(env, AI_ACTOR, "aie_wren", true, "promoting myself")).rejects.toThrow(/only a person/);
  });
});

describe("the digital office maps collaboration to work", () => {
  it("accepts a message that references a real work card", async () => {
    const cardId = await makeWorkCard();
    const res = await call<{ id: string; context_kind: string }>("/api/workforce/rooms/investment/messages", MP, "POST", {
      context_kind: "WORK_CARD",
      context_id: cardId,
      body: "Picking this up; diligence questions drafted.",
    });
    expect(res.status).toBe(201);
    expect(res.body.context_kind).toBe("WORK_CARD");
  });

  it("refuses a message that names a record which does not exist", async () => {
    const res = await call("/api/workforce/rooms/investment/messages", MP, "POST", {
      context_kind: "WORK_CARD",
      context_id: "wc_imaginary",
      body: "About that card…",
    });
    expect(res.status).toBe(404);
  });

  it("refuses a referenced message with no reference at all", async () => {
    const res = await call("/api/workforce/rooms/investment/messages", MP, "POST", {
      context_kind: "AI_RUN",
      body: "no id supplied",
    });
    expect(res.status).toBe(400);
  });

  it("lets a HUMAN make a firm announcement but never an AI employee", async () => {
    const human = await call("/api/workforce/rooms/investment/messages", MP, "POST", {
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
    // The precondition is CREATED. Pointing at whoever happened to be switched off made this pass
    // by accident until migration 0136 employed the roster and there was nobody switched off left.
    await standDown("aie_parker", "PAUSED");

    const cardId = await makeWorkCard();
    const res = await call("/api/workforce/handoffs", MP, "POST", {
      work_card_id: cardId,
      to_employee_id: "aie_parker",
      reason: "she is not on",
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

/**
 * The rota says something about each person, or it says nothing at all.
 *
 * `because` was set to the shift's own intent for everybody, and that same sentence is printed as
 * the heading above the list — so the page rendered it six times in a row and told the operator
 * nothing about any of the six. It looked like a rendering fault because it was one.
 */
describe("why each person is on duty", () => {
  // resolveDuty(hour, size) — the roster comes from the registry, not from an argument.
  const MORNING_HOUR = 8;

  it("gives every person a different reason", () => {
    const duty = resolveDuty(MORNING_HOUR, 5);
    const reasons = duty.onDuty.map((d) => d.because);
    expect(reasons.length).toBeGreaterThan(1);
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it("never repeats the shift's own heading back as a person's reason", () => {
    // The exact bug: the heading above the list and every row beneath it said the same thing.
    for (const hour of [8, 14, 19, 2]) {
      const duty = resolveDuty(hour, 6);
      for (const d of duty.onDuty) {
        expect(d.because, `${duty.shift}/${d.name} is just echoing the shift intent`).not.toBe(duty.intent);
      }
    }
  });

  it("says something about the person, not just their job title", () => {
    const duty = resolveDuty(MORNING_HOUR, 5);
    const wren = duty.onDuty.find((d) => d.name === "Wren");
    expect(wren?.because).toContain("morning brief");
  });

  it("still lets a pinned person say they were asked for", () => {
    const duty = resolveDuty(MORNING_HOUR, 5, { pinned: ["Willow"] });
    expect(duty.onDuty[0]!.name).toBe("Willow");
    expect(duty.onDuty[0]!.because).toContain("asked for them");
  });
});

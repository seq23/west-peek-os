import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { restoreAiAccess, revokeAllAiAccess, seatEmployee, seatedEmployees } from "../src/worker/services/liveHelp";
import { runCloseout } from "../src/worker/services/meetingDelegation";

/**
 * Revoke All (P36, V1 #27, canon §9.6.2E).
 *
 * The rule that makes this more than a bulk delete: "AI access resumes only if an authorized human
 * re-grants access." So the tests that matter are the ones asserting the latch HOLDS — that you
 * cannot simply seat someone straight back in, which is what a plain release-everyone would allow.
 */

let t: TestDb;
let env: Env;
const MP: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const MEETING = "mtg_revoke_probe";
let employeeId = "";

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  // The seat is set ACTIVE here rather than found that way, which keeps this suite about REVOCATION
  // rather than about the activation path — that has its own suite. (The comment used to say a
  // freshly migrated database has everybody INACTIVE. Migration 0136 employed the whole roster, so
  // that is no longer true; nothing here depended on it, but a false comment is a trap for the next
  // reader, who would take it as licence to delete the line below.)
  const row = await env.WP_OS_DB.prepare("SELECT id FROM ai_employee ORDER BY id LIMIT 1").first<{ id: string }>();
  employeeId = row?.id ?? "";
  await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id = ?1").bind(employeeId).run();
  await env.WP_OS_DB.prepare(
    `INSERT INTO meeting (id, title, meeting_type, status, privacy_label, firm_scope, created_by)
     VALUES (?1,'Revoke probe','FOUNDER','SCHEDULED','INTERNAL','west-peek','fu_scooter_taylor')`,
  ).bind(MEETING).run();
  await env.WP_OS_DB.prepare(
    `INSERT INTO meeting_note (id, meeting_id, note_type, body, author_type, author_id, firm_scope)
     VALUES ('mn_probe',?1,'MANUAL','We agreed to send the data room index.','HUMAN','fu_scooter_taylor','west-peek')`,
  ).bind(MEETING).run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("revoking all AI access", () => {
  it("needs an active employee to make the test meaningful", () => {
    expect(employeeId).toBeTruthy();
  });

  it("clears the seats", async () => {
    await seatEmployee(env, MP, MEETING, employeeId);
    expect(await seatedEmployees(env, MEETING)).toHaveLength(1);
    const r = await revokeAllAiAccess(env, MP, MEETING, "Sensitive discussion");
    expect(r.revoked).toContain(employeeId);
    expect(await seatedEmployees(env, MEETING)).toHaveLength(0);
  });

  it("records WHICH employees were affected, captured before the seats were cleared", async () => {
    // §9.6.2E requires this specifically, and it is the field a bulk delete destroys.
    const ev = await env.WP_OS_DB.prepare(
      "SELECT payload_json FROM event_record WHERE object_id = ?1 AND event_type = 'meeting.ai_access_revoked' ORDER BY created_at DESC LIMIT 1",
    ).bind(MEETING).first<{ payload_json: string }>();
    const payload = JSON.parse(ev!.payload_json);
    expect(payload.affected_employees.map((e: { id: string }) => e.id)).toContain(employeeId);
    expect(payload.access_removed).toContain("answer_in_room");
    expect(payload.note).toBe("Sensitive discussion");
  });

  it("HOLDS — an employee cannot simply be seated again", async () => {
    // The whole point. A plain release-everyone would let this succeed.
    await expect(seatEmployee(env, MP, MEETING, employeeId)).rejects.toMatchObject({ code: "ai_access_revoked" });
  });

  it("refuses close-out extraction while revoked", async () => {
    // "No AI employee can process follow-up from the room."
    const r = await runCloseout(env, MP, MEETING);
    expect(r.closeout.state).toBe("REFUSED");
    expect(r.closeout.detail).toMatch(/revoked/i);
    expect(r.commitments).toHaveLength(0);
  });

  it("lets an authorised human restore access", async () => {
    const r = await restoreAiAccess(env, MP, MEETING);
    expect(r.state).toBe("GRANTED");
  });

  it("does NOT re-seat anyone on restore — permission is not attendance", async () => {
    expect(await seatedEmployees(env, MEETING)).toHaveLength(0);
  });

  it("allows seating again once restored", async () => {
    const seat = await seatEmployee(env, MP, MEETING, employeeId);
    expect(seat.ai_employee_id).toBe(employeeId);
  });
});

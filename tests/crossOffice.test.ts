import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { detectConflicts, recordFindings } from "../src/worker/services/crossOffice";

/**
 * Cross-office reconciliation (P38, V1 #8, canon §7.5).
 *
 * Each of canon's four detectors gets a fixture that makes it fire AND a near-miss that must not.
 * The near-misses are the important half: a detector that flags everything is as useless as one
 * that flags nothing, and "two offices are colliding" has to mean something specific or people
 * stop reading the surface.
 */

let t: TestDb;
let env: Env;
const SCOPE = "west-peek";
const A = "fu_scooter_taylor";
const B = "fu_sequoia_taylor";

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  const run = (sql: string) => env.WP_OS_DB.prepare(sql).run();

  const machine = await env.WP_OS_DB.prepare("SELECT id FROM machine LIMIT 1").first<{ id: string }>();
  const m = machine!.id;
  const other = (await env.WP_OS_DB.prepare("SELECT id FROM machine WHERE id <> ?1 LIMIT 1").bind(m).first<{ id: string }>())!.id;
  const emp = (await env.WP_OS_DB.prepare("SELECT id FROM ai_employee LIMIT 1").first<{ id: string }>())!.id;

  // 1 · duplicate: two offices, same machine. Plus a near-miss: same machine, SAME creator.
  await run(`INSERT INTO work_card (id, title, machine_id, state, owner_type, created_by, firm_scope) VALUES
    ('wc_dup_a','Draft LP update','${m}','OPEN','UNASSIGNED','${A}','${SCOPE}'),
    ('wc_dup_b','LP update draft','${m}','OPEN','UNASSIGNED','${B}','${SCOPE}'),
    ('wc_same_1','Same office one','${other}','OPEN','UNASSIGNED','${A}','${SCOPE}'),
    ('wc_same_2','Same office two','${other}','OPEN','UNASSIGNED','${A}','${SCOPE}')`);

  // 2 · resource conflict: one employee, two requesters.
  await run(`INSERT INTO work_card (id, title, state, owner_type, owner_id, created_by, firm_scope) VALUES
    ('wc_res_a','From Scooter','OPEN','AI','${emp}','${A}','${SCOPE}'),
    ('wc_res_b','From Sequoia','OPEN','AI','${emp}','${B}','${SCOPE}')`);

  // 3 · overlapping outbound: two unsent emails to one address. Near-miss: a third, already EXECUTED.
  await run(`INSERT INTO external_effect_request (id, effect_type, destination, requested_by_type, requested_by_id, state) VALUES
    ('eer_1','email.send','lp@example.test','HUMAN','${A}','REQUESTED'),
    ('eer_2','email.send','lp@example.test','HUMAN','${B}','APPROVED'),
    ('eer_3','email.send','solo@example.test','HUMAN','${A}','REQUESTED'),
    ('eer_4','email.send','done@example.test','HUMAN','${A}','EXECUTED'),
    ('eer_5','email.send','done@example.test','HUMAN','${B}','EXECUTED')`);

  // 4 · contradictory instructions: same title, different issuers. Near-miss: same issuer twice.
  await run(`INSERT INTO governance_update (id, update_type, title, body, issued_by, firm_scope) VALUES
    ('gu_1','RULE','Outbound tone','Be formal','${A}','${SCOPE}'),
    ('gu_2','RULE','Outbound tone','Be casual','${B}','${SCOPE}'),
    ('gu_3','RULE','Solo rule','x','${A}','${SCOPE}'),
    ('gu_4','RULE','Solo rule','y','${A}','${SCOPE}')`);
});

afterAll(async () => {
  await disposeTestDb(t);
});

async function findings() {
  return await detectConflicts(env, SCOPE);
}

describe("the four detectors canon names", () => {
  it("finds duplicate work across two offices", async () => {
    const f = (await findings()).filter((x) => x.conflict_type === "DUPLICATE_REQUEST");
    expect(f.some((x) => x.detail.a === "wc_dup_a" && x.detail.b === "wc_dup_b")).toBe(true);
  });

  it("does NOT flag two cards from the same office", async () => {
    // One person opening two cards is their own business, not a cross-office collision.
    const f = (await findings()).filter((x) => x.conflict_type === "DUPLICATE_REQUEST");
    expect(f.some((x) => x.detail.a === "wc_same_1")).toBe(false);
  });

  it("finds an employee holding work from two requesters", async () => {
    const f = (await findings()).filter((x) => x.conflict_type === "RESOURCE_CONFLICT");
    expect(f).toHaveLength(1);
    expect(Number(f[0]!.detail.requesters)).toBe(2);
  });

  it("finds two unsent drafts aimed at one recipient", async () => {
    const f = (await findings()).filter((x) => x.conflict_type === "OVERLAPPING_OUTBOUND");
    expect(f.some((x) => x.detail.destination === "lp@example.test")).toBe(true);
  });

  it("does NOT flag a single draft, nor already-sent ones", async () => {
    const f = (await findings()).filter((x) => x.conflict_type === "OVERLAPPING_OUTBOUND");
    expect(f.some((x) => x.detail.destination === "solo@example.test")).toBe(false);
    // Two EXECUTED effects to one address are history, not a pending collision.
    expect(f.some((x) => x.detail.destination === "done@example.test")).toBe(false);
  });

  it("finds two partners issuing the same instruction", async () => {
    const f = (await findings()).filter((x) => x.conflict_type === "CONTRADICTORY_INSTRUCTION");
    expect(f.some((x) => x.summary.includes("Outbound tone"))).toBe(true);
  });

  it("does NOT flag one partner issuing twice", async () => {
    const f = (await findings()).filter((x) => x.conflict_type === "CONTRADICTORY_INSTRUCTION");
    expect(f.some((x) => x.summary.includes("Solo rule"))).toBe(false);
  });
});

describe("detection is idempotent", () => {
  it("raises each conflict once, however many times it runs", async () => {
    const f = await findings();
    const first = await recordFindings(env, SCOPE, f);
    expect(first).toBeGreaterThan(0);
    const second = await recordFindings(env, SCOPE, await findings());
    expect(second).toBe(0);
  });

  it("does not reopen a conflict a partner accepted", async () => {
    // The rule that keeps this surface readable: re-detection must never override a human decision.
    await env.WP_OS_DB.prepare(
      "UPDATE cross_office_conflict SET status = 'ACCEPTED' WHERE conflict_type = 'RESOURCE_CONFLICT'",
    ).run();
    await recordFindings(env, SCOPE, await findings());
    const row = await env.WP_OS_DB.prepare(
      "SELECT status FROM cross_office_conflict WHERE conflict_type = 'RESOURCE_CONFLICT'",
    ).first<{ status: string }>();
    expect(row!.status).toBe("ACCEPTED");
  });

  it("keeps a stable key whichever order a pair is returned in", async () => {
    const f = (await findings()).filter((x) => x.conflict_type === "DUPLICATE_REQUEST");
    for (const x of f) {
      const parts = x.dedupe_key.replace("dup:", "").split(":");
      expect([...parts].sort()).toEqual(parts);
    }
  });
});

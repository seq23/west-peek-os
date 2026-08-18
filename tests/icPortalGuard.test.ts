import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { IcPortalError, saveAnswer } from "../src/worker/services/icPortal";

/**
 * The champion rule, tested against a real database rather than in the abstract (P34).
 *
 * This is the rule the whole IC module hangs on: "the deal champion should not answer #6 first.
 * Have someone else make the bear case. Otherwise IC has a nasty tendency to become a sales meeting
 * for the investment rather than an actual decision process."
 *
 * Testing it only at the readiness layer would miss the point — readiness reports, the SERVICE
 * refuses. These tests drive saveAnswer() directly so the refusal itself is what is under test.
 */

let t: TestDb;
let env: Env;

// The real scenario: Scooter champions the deal, so Sequoia has to make the bear case.
const CHAMPION: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const OTHER: Actor = { type: "HUMAN", firmUserId: "fu_sequoia_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };

const PACKET = "icp_guard_test";

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);

  // Both MPs are seeded by the migrations; only the deal-specific rows are created here.
  await env.WP_OS_DB.prepare(
    `INSERT INTO canonical_company (id, canonical_name, created_by, firm_scope)
     VALUES ('cc_guard','Guard Co','fu_scooter_taylor','west-peek')`,
  ).run();
  await env.WP_OS_DB.prepare(
    `INSERT INTO investment_opportunity (id, company_id, opportunity_type, title, created_by, firm_scope)
     VALUES ('opp_guard','cc_guard','EARLY_STAGE_PRIMARY','Guard Co seed','fu_scooter_taylor','west-peek')`,
  ).run();
  await env.WP_OS_DB.prepare(
    `INSERT INTO ic_packet (id, opportunity_id, drafted_by_type, drafted_by_id, firm_scope, sector, champion_user_id)
     VALUES (?1,'opp_guard','HUMAN','fu_scooter_taylor','west-peek','AI','fu_scooter_taylor')`,
  )
    .bind(PACKET)
    .run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("the deal champion cannot write the bear case", () => {
  it("refuses the kill case from the champion", async () => {
    await expect(
      saveAnswer(env, CHAMPION, PACKET, { section_id: "kill_case", state: "ANSWERED", body: "Nothing much worries me." }),
    ).rejects.toMatchObject({ status: 409, code: "champion_may_not_answer" });
  });

  it("refuses Closing Six #6 from the champion", async () => {
    await expect(
      saveAnswer(env, CHAMPION, PACKET, { section_id: "closing_6", state: "ANSWERED", body: "There isn't one." }),
    ).rejects.toMatchObject({ status: 409, code: "champion_may_not_answer" });
  });

  it("refuses even when the champion marks it not applicable", async () => {
    // The obvious way round the rule: declare the bear case irrelevant instead of writing it.
    await expect(
      saveAnswer(env, CHAMPION, PACKET, { section_id: "kill_case", state: "NOT_APPLICABLE", na_reason: "no real risks" }),
    ).rejects.toMatchObject({ code: "champion_may_not_answer" });
  });

  it("lets the champion answer every other section", async () => {
    const saved = await saveAnswer(env, CHAMPION, PACKET, {
      section_id: "founder",
      state: "ANSWERED",
      body: "Second-time founder, sold previous company, deep domain history.",
    });
    expect(saved.state).toBe("ANSWERED");
    expect(saved.answered_by).toBe("fu_scooter_taylor");
  });

  it("lets someone who is not the champion write the bear case", async () => {
    const saved = await saveAnswer(env, OTHER, PACKET, {
      section_id: "kill_case",
      state: "ANSWERED",
      body: "Distribution is unproven and the incumbent can bundle this within a year.",
    });
    expect(saved.state).toBe("ANSWERED");
    expect(saved.answered_by).toBe("fu_sequoia_taylor");
  });
});

describe("answer validation", () => {
  it("rejects a section that is not part of this packet", async () => {
    await expect(
      saveAnswer(env, OTHER, PACKET, { section_id: "sector_fintech", state: "ANSWERED", body: "x" }),
    ).rejects.toMatchObject({ code: "unknown_section" });
  });

  it("accepts the sector section that IS part of this packet", async () => {
    // The packet is sector AI, so sector_ai is expected and sector_fintech is not.
    const saved = await saveAnswer(env, OTHER, PACKET, {
      section_id: "sector_ai",
      state: "ANSWERED",
      body: "Own inference stack; margin holds after compute.",
    });
    expect(saved.section_id).toBe("sector_ai");
  });

  it("refuses an empty answer", async () => {
    await expect(
      saveAnswer(env, OTHER, PACKET, { section_id: "moat", state: "ANSWERED", body: "   " }),
    ).rejects.toMatchObject({ code: "empty_answer" });
  });

  it("refuses 'not applicable' with no reason", async () => {
    await expect(
      saveAnswer(env, OTHER, PACKET, { section_id: "moat", state: "NOT_APPLICABLE" }),
    ).rejects.toMatchObject({ code: "reason_required" });
  });

  it("accepts 'not applicable' with a reason", async () => {
    const saved = await saveAnswer(env, OTHER, PACKET, {
      section_id: "traction",
      state: "NOT_APPLICABLE",
      na_reason: "Pre-revenue; there is nothing to measure yet.",
    });
    expect(saved.state).toBe("NOT_APPLICABLE");
    expect(saved.na_reason).toMatch(/pre-revenue/i);
  });

  it("overwrites rather than duplicating when a section is answered twice", async () => {
    await saveAnswer(env, OTHER, PACKET, { section_id: "product", state: "ANSWERED", body: "first" });
    await saveAnswer(env, OTHER, PACKET, { section_id: "product", state: "ANSWERED", body: "second" });
    const rows = await env.WP_OS_DB.prepare(
      "SELECT body FROM ic_diligence_answer WHERE ic_packet_id = ?1 AND section_id = 'product'",
    )
      .bind(PACKET)
      .all<{ body: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results?.[0]?.body).toBe("second");
  });
});

describe("errors are typed", () => {
  it("throws IcPortalError, so routes map them to real status codes", async () => {
    await expect(saveAnswer(env, OTHER, "icp_missing", { section_id: "moat", state: "OPEN" }))
      .rejects.toBeInstanceOf(IcPortalError);
  });
});

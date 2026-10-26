import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { saidNothing } from "./helpers/interpret";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { recordDeckVersion, requestDeckRework, runDeckRework } from "../src/worker/services/deck";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";

/**
 * A rejected deck becomes Preston's card, and the card becomes the next version — with a PDF.
 *
 * WHAT THE OPERATOR SAW, 14 Sep 2026. She sent v10 back with "you need to pull from the current
 * deck and make it full and ready for LPs and fix all discrepancies" and asked where to see
 * Preston working on it again. There was nowhere: rejection wrote a row. And v6–v10 had each been
 * "rebuilt" by the daily job with no PDF at all — five proposals about nothing.
 */

let t: TestDb;
let env: Env;
const ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_sequoia_taylor", firmScopes: ["west-peek"], roles: ["MANAGING_PARTNER"] };
const FUND = "fund_rework_test";

async function setPolicy(table: string, column: string, versionNo: number, doc: unknown): Promise<void> {
  await env.WP_OS_DB.prepare(
    `INSERT INTO ${table} (id, fund_id, version_no, effective_from, ${column}, created_by, firm_scope)
     VALUES (?1, ?2, ?3, '2026-09-09', ?4, 'fu_sequoia_taylor', 'west-peek')`,
  )
    .bind(`pv_rw_${table}_${versionNo}`, FUND, versionNo, JSON.stringify(doc))
    .run();
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_DOCUMENTS: t.docs });
  await env.WP_OS_DB.prepare("DELETE FROM fund").run();
  await env.WP_OS_DB.prepare(
    "INSERT INTO fund (id, name, status, firm_scope) VALUES (?1, 'West Peek Ventures Fund I', 'ACTIVE', 'west-peek')",
  ).bind(FUND).run();
  await setPolicy("investment_mandate_version", "mandate_json", 1, {
    target_size_usd: 30_000_000, sectors: ["AI", "FINTECH"], target_positions: 25,
    check_size_usd: { min: 250_000, max: 1_000_000 }, management_fee_pct: 2, carried_interest_pct: 20,
  });
  await setPolicy("sleeve_policy_version", "sleeve_json", 1, {
    estimated_fees_usd: 6_000_000, estimated_expenses_usd: 600_000,
    sleeves: [{ key: "EARLY_STAGE_PRIMARY", target_pct: 70 }, { key: "SECONDARY_PURCHASE", target_pct: 30 }],
  });
  await setPolicy("reserve_policy_version", "reserve_json", 1, { reserve_pct: 40 });
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("sending a built deck back opens Preston's card", () => {
  it("creates one DECK_REWORK card for Preston carrying her reason, aimed at the deck preview", async () => {
    const v1 = await recordDeckVersion(env, ACTOR, {
      fundId: FUND, title: "West Peek Ventures Fund I — rebuilt from the records", origin: "BUILT",
      createdBy: "Preston", createdByType: "AI",
    });
    const reason = "pull from the current deck and make it full and ready for LPs and fix all discrepancies";
    const card = await requestDeckRework(env, v1, reason, "Sequoia Taylor");
    expect(card).not.toBeNull();
    const row = await env.WP_OS_DB.prepare("SELECT title, kind, owner_type, owner_id, state, description, prompt FROM work_card WHERE id = ?1")
      .bind(card!.id)
      .first<{ title: string; kind: string; owner_type: string; owner_id: string; state: string; description: string; prompt: string }>();
    expect(row).toMatchObject({ title: "Take this change to the LP deck preview", kind: "DECK_REWORK", owner_type: "AI", owner_id: "aie_preston", state: "OPEN" });
    expect(row!.description).toContain(reason);
    expect(row!.description).toContain("sent back by Sequoia Taylor");
    expect(row!.prompt).toBe(reason);
  });

  it("does NOT open a card when she rejects a version she uploaded herself", async () => {
    const up = await recordDeckVersion(env, ACTOR, {
      fundId: FUND, title: "West Peek Ventures Fund I", origin: "UPLOADED", createdBy: "Sequoia Taylor", createdByType: "HUMAN", pageCount: 12,
    });
    expect(await requestDeckRework(env, up, "mistake", "Sequoia Taylor")).toBeNull();
  });
});

describe("the card becomes a change request on the deck preview, never a PDF (26 Oct 2026)", () => {
  it("folds her reason into the open preview as a request in her name, closes the card, and writes no deck version", async () => {
    const before = (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM deck_version").first<{ n: number }>())!.n;
    const v = await recordDeckVersion(env, ACTOR, { fundId: FUND, title: "built", origin: "BUILT", createdBy: "Preston", createdByType: "AI" });
    const reason = "page 4 should lead with the Rooms evenings";
    const card = (await requestDeckRework(env, v, reason, "Sequoia Taylor"))!;
    const out = await runDeckRework(env, { id: card.id, title: "Take this change to the LP deck preview", firm_scope: "west-peek" }, saidNothing);
    expect(out).toMatchObject({ finished: true, blocked: false });
    expect(out.detail).toMatch(/deck preview round 1 as a change request/);
    const req = await env.WP_OS_DB.prepare("SELECT kind, state, by_whom, said FROM deck_preview_change WHERE kind = 'REQUEST'").first();
    expect(req).toMatchObject({ kind: "REQUEST", state: "PENDING", by_whom: "Sequoia" });
    expect(String((req as { said: string }).said).startsWith(reason), "her words lead the request, as she typed them").toBe(true);
    const row = await env.WP_OS_DB.prepare("SELECT state, requested_by_email FROM work_card WHERE id = ?1").bind(card.id).first();
    expect(row).toMatchObject({ state: "DONE", requested_by_email: "sequoia@westpeek.ventures" });
    // Only the recorded version above: the rework itself made no PDF version.
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM deck_version").first<{ n: number }>())!.n).toBe(before + 1);
  });
});

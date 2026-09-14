import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { recordDeckVersion, requestDeckRework, runDeckRework, runDeckRebuild, type DeckVersionRow } from "../src/worker/services/deck";
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

/** A browser double that "prints" the page: enough of a PDF that the page counter finds pages. */
const FAKE_PDF = "%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Type /Page >> endobj\n3 0 obj << /Type /Page >> endobj\n%%EOF";
let printed: string | null = null;
const fakeLaunch = async () => ({
  newPage: async () => ({
    setContent: async (html: string) => { printed = html; },
    evaluate: async () => undefined,
    pdf: async () => new TextEncoder().encode(FAKE_PDF).buffer,
  }),
  close: async () => undefined,
});

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
  it("creates one DECK_REWORK card for Preston carrying her reason, named for the next version", async () => {
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
    expect(row).toMatchObject({ title: "Rebuild the LP deck as v2", kind: "DECK_REWORK", owner_type: "AI", owner_id: "aie_preston", state: "OPEN" });
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

describe("the card becomes the next version, with a PDF", () => {
  it("builds the deck in the Worker, records it PROPOSED with a document, supersedes older proposals, and closes the card with a note that says where to look", async () => {
    const card = await env.WP_OS_DB.prepare("SELECT id, title, firm_scope FROM work_card WHERE kind = 'DECK_REWORK' ORDER BY created_at DESC LIMIT 1")
      .first<{ id: string; title: string; firm_scope: string }>();
    expect(card).toBeTruthy();
    const before = (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM deck_version WHERE fund_id = ?1 AND state = 'PROPOSED'").bind(FUND).first<{ n: number }>())!.n;
    expect(before).toBeGreaterThan(0);

    const out = await runDeckRework(env, card!, fakeLaunch);
    expect(out.finished).toBe(true);
    expect(out.detail).toMatch(/is proposed on Fund strategy/);
    expect(out.detail).toMatch(/3 pages/);
    // The HTML that was printed is the deck, with a figure from the records on it.
    expect(printed).toContain("30");
    const latest = await env.WP_OS_DB.prepare("SELECT * FROM deck_version WHERE fund_id = ?1 ORDER BY version_no DESC LIMIT 1").bind(FUND).first<DeckVersionRow>();
    expect(latest!.state).toBe("PROPOSED");
    expect(latest!.origin).toBe("BUILT");
    expect(latest!.document_id, "a rebuilt version with no PDF is the empty daily this replaces").not.toBeNull();
    expect(latest!.page_count).toBe(3);
    // One proposal at a time: everything older that was waiting is superseded.
    const stillProposed = (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM deck_version WHERE fund_id = ?1 AND state = 'PROPOSED'").bind(FUND).first<{ n: number }>())!.n;
    expect(stillProposed).toBe(1);
    const c = await env.WP_OS_DB.prepare("SELECT state FROM work_card WHERE id = ?1").bind(card!.id).first<{ state: string }>();
    expect(c!.state).toBe("DONE");
    const note = await env.WP_OS_DB.prepare("SELECT description FROM work_card WHERE id = ?1").bind(card!.id).first<{ description: string }>();
    expect(note!.description).toMatch(/Preston: v\d+ is proposed on Fund strategy/);
  });

  it("with no browser the version is still recorded but the card says so and goes BLOCKED, never a silent empty proposal", async () => {
    const v = await recordDeckVersion(env, ACTOR, { fundId: FUND, title: "x", origin: "BUILT", createdBy: "Preston", createdByType: "AI" });
    const card = await requestDeckRework(env, v, "still wrong", "Sequoia Taylor");
    const out = await runDeckRework(env, { id: card!.id, title: "Rebuild", firm_scope: "west-peek" }, async () => { throw new Error("no browser in this test"); });
    expect(out.finished).toBe(false);
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(/NO PDF could be rendered/);
    const c = await env.WP_OS_DB.prepare("SELECT state, next_action FROM work_card WHERE id = ?1").bind(card!.id).first<{ state: string; next_action: string }>();
    expect(c!.state).toBe("BLOCKED");
    expect(c!.next_action).toMatch(/could not be rendered/);
  });

  it("runDeckRebuild itself renders the PDF, so the on-request job no longer produces an empty version", async () => {
    const out = await runDeckRebuild(env, { type: "SYSTEM", roles: [], firmScopes: ["west-peek"] }, { launch: fakeLaunch });
    expect(out.rendered).toBe(true);
    expect(out.version.document_id).not.toBeNull();
  });
});

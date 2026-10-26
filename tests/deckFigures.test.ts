import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { figuresFromDocs } from "../src/shared/deck/figures";
import { renderDeckHtml } from "../src/shared/deck/render";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";

/**
 * THE DECK'S FIGURES ARE READ FROM THE MANDATE AND THE FEE RECORDS, NEVER TYPED.
 *
 * 26 Oct 2026: Fund I's final math landed on Fund strategy (mandate v5, fee/capital-split v7) and the
 * LP deck kept printing 8% ownership, $6.0M fees, $250K–$750K checks, $23M investable and a 5%
 * minimum. These tests pin three things: every figure is a function of the records (odd values in,
 * the same odd values out — a literal anywhere fails); the Worker and the Mac render share ONE
 * builder; and when the records move under the deck, one PROPOSED version follows, once.
 */

const ODD = {
  mandate: {
    target_size_usd: 31_700_000,
    sectors: ["AI"],
    target_positions: 23,
    check_size_usd: { min: 210_000, max: 470_000, typical: 330_000 },
    management_fee_pct: 1.9,
    management_fee_schedule: "1.9% for years 1–3, then 0.7% after",
    carried_interest_pct: 17,
    target_ownership_pct: 3.3,
    follow_on_check_usd: { min: 610_000, max: 930_000, companies: 7 },
    secondary_check_usd: { min: 520_000, max: 1_370_000, positions: 11 },
    concentration_cap_usd: 2_900_000,
    gp_commitment_pct: 1.3,
    gp_commitment_usd: 412_000,
    target_net_multiple_lps: 2.3,
  },
  sleeve: {
    committed_usd: 31_700_000,
    estimated_fees_usd: 4_100_000,
    estimated_expenses_usd: 600_000,
    estimated_investable_usd: 27_000_000,
    sleeves: [{ key: "EARLY_STAGE_PRIMARY", target_pct: 60 }, { key: "SECONDARY_PURCHASE", target_pct: 40 }],
  },
  reserve: { reserve_pct: 50 },
};

describe("every deck figure is a function of the records", () => {
  const f = figuresFromDocs({ ...ODD, origins: [{ o: "COMMUNITY_INTRO", n: 3 }, { o: null, n: 4 }], positionsHeld: 0, asOf: new Date("2026-10-26T12:00:00Z") });

  it("reads each field from the mandate, fee/capital-split and reserve records", () => {
    expect(f.fund_size).toBe(31_700_000);
    expect(f.fees).toBe(4_100_000);
    expect(f.expenses).toBe(600_000);
    expect(f.investable_base).toBe(27_000_000);
    expect(f.early_sleeve_usd).toBeCloseTo(16_200_000, 0);
    expect(f.secondary_sleeve_usd).toBeCloseTo(10_800_000, 0);
    expect(f.reserve_usd).toBeCloseTo(8_100_000, 0);
    expect(f.initial_capital_usd).toBeCloseTo(8_100_000, 0);
    expect(f.target_positions).toBe(23);
    expect([f.check_min, f.check_typical, f.check_max]).toEqual([210_000, 330_000, 470_000]);
    expect([f.follow_on_companies, f.follow_on_min, f.follow_on_max]).toEqual([7, 610_000, 930_000]);
    expect([f.secondary_positions, f.secondary_check_min, f.secondary_check_max]).toEqual([11, 520_000, 1_370_000]);
    expect(f.concentration_cap).toBe(2_900_000);
    expect([f.gp_commit_pct, f.gp_commit_usd]).toEqual([1.3, 412_000]);
    expect(f.target_net_multiple).toBe(2.3);
    expect(f.target_ownership_pct).toBe(3.3);
    expect(f.mgmt_fee_schedule).toBe("1.9% for years 1–3, then 0.7% after");
    expect(f.community_sourced).toEqual({ through_community: 3, total: 7 });
  });

  it("supplies NO default: empty records give a deck of gaps, never a remembered number", () => {
    const empty = figuresFromDocs({ mandate: {}, sleeve: {}, reserve: {}, origins: [], positionsHeld: 0, asOf: new Date() });
    for (const [key, value] of Object.entries(empty)) {
      if (["as_of_date", "positions_held", "sectors"].includes(key)) continue;
      expect(value, `${key} has a value with no record behind it`).toBeNull();
    }
    expect(renderDeckHtml(empty)).toContain("not recorded");
  });

  it("prints the records' figures on the rendered deck, the stepped fee in its own words", () => {
    const html = renderDeckHtml(f).replace(/&thinsp;/g, "");
    for (const printed of ["$31.7M", "$27M", "$330K", "$2.9M", "$412K", "2.3x", "3.3%", "1.9% for years 1–3, then 0.7% after", "$1.37M"]) {
      expect(html, `${printed} is in the records but not on the deck`).toContain(printed);
    }
    expect(html).not.toMatch(/minimum ownership/i);
  });
});

describe("one builder, two callers", () => {
  const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("the Worker rebuild and the Mac render both call figuresFromDocs and build no figure object of their own", () => {
    for (const path of ["../src/worker/services/deck.ts", "../scripts/deck/build.mjs"]) {
      const src = read(path);
      expect(src, `${path} does not use the shared builder`).toMatch(/figuresFromDocs\(/);
      // A hand-built figures object is the second list that falls behind the records.
      expect(src, `${path} builds its own figures object`).not.toMatch(/\bcheck_max:\s*(?:mandate|snap)/);
      expect(src, `${path} builds its own figures object`).not.toMatch(/\bfees:\s*(?:sleeve|snap)/);
    }
  });
});

describe("when the records move under the deck, one proposal follows", () => {
  let t: TestDb;
  let env: Env;
  const FUND = "fund_deck_moves";
  const ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_sequoia_taylor", firmScopes: ["west-peek"], roles: ["MANAGING_PARTNER"] };
  const setPolicy = (table: string, column: string, v: number, doc: unknown) =>
    env.WP_OS_DB.prepare(
      `INSERT INTO ${table} (id, fund_id, version_no, effective_from, ${column}, created_by, firm_scope) VALUES (?1, ?2, ?3, '2026-10-26', ?4, 'fu_sequoia_taylor', 'west-peek')`,
    ).bind(`pv_${table}_${v}`, FUND, v, JSON.stringify(doc)).run();

  beforeAll(async () => {
    t = await createTestDb();
    env = makeTestEnv(t.db);
    await env.WP_OS_DB.prepare("INSERT INTO fund (id, name, status, firm_scope) VALUES (?1, 'Fund under test', 'ACTIVE', 'west-peek')").bind(FUND).run();
  });
  afterAll(async () => { await disposeTestDb(t); });

  it("does nothing with no deck to compare, nothing when current, and opens ONE preview round — never a PDF — when a record is newer", async () => {
    const { recordDeckVersion } = await import("../src/worker/services/deck");
    const { previewIfRecordsMoved } = await import("../src/worker/services/deckPreview");
    await setPolicy("investment_mandate_version", "mandate_json", 1, { target_size_usd: 30_000_000 });
    await setPolicy("sleeve_policy_version", "sleeve_json", 1, { committed_usd: 30_000_000, estimated_fees_usd: 6_000_000, estimated_expenses_usd: 1_000_000 });
    expect((await previewIfRecordsMoved(env)).moved).toBe(false);

    await recordDeckVersion(env, ACTOR, { fundId: FUND, title: "v1", origin: "UPLOADED", createdBy: "Sequoia", createdByType: "HUMAN", pdfBase64: null, pageCount: null, changeSummary: null });
    const steady = await previewIfRecordsMoved(env);
    expect(steady.moved, steady.reason).toBe(false);

    await setPolicy("investment_mandate_version", "mandate_json", 2, { target_size_usd: 30_000_000, target_ownership_pct: 2.7 });
    await setPolicy("sleeve_policy_version", "sleeve_json", 2, { committed_usd: 30_000_000, estimated_fees_usd: 4_500_000, estimated_expenses_usd: 500_000 });
    const moved = await previewIfRecordsMoved(env);
    expect(moved.moved).toBe(true);
    expect(moved.reason).toMatch(/mandate v1 → v2/);
    const versions = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM deck_version WHERE fund_id = ?1").bind(FUND).first<{ n: number }>();
    expect(versions!.n, "a records move made a PDF version").toBe(1);
    const round = await env.WP_OS_DB.prepare("SELECT round_no, state, what_changed_json FROM deck_preview").first<{ round_no: number; state: string; what_changed_json: string }>();
    expect(round).toMatchObject({ round_no: 1, state: "OPEN" });
    expect(round!.what_changed_json).toMatch(/mandate v1 → v2/);

    const again = await previewIfRecordsMoved(env);
    expect(again.moved, "the same records moved the preview twice").toBe(false);
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM deck_preview").first<{ n: number }>())!.n).toBe(1);
  });

});

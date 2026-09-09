import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { driftSince, recordDeckVersion, summariseDrift, takeRecordsSnapshot } from "../src/worker/services/deck";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";

/**
 * THE COLUMN THAT WOULD HAVE PREVENTED THE WHOLE DAY.
 *
 * Operator, 9 Sep 2026: "changes are tracked and the latest edits and date and timestamps in the OS".
 *
 * The August deck says early stage is $21M. The OS held $17.0M against a $24.0M investable base.
 * NOBODY COULD SAY WHICH CAME FIRST, or whether either was ever derived from the other, because no
 * version of the deck ever recorded the numbers it was built from. Six discrepancies survived from
 * August to September inside that gap.
 *
 * `records_snapshot_json` closes it, and these tests exist to stop it being closed in name only: a
 * version that carries an empty snapshot is worse than one that carries none, because it looks
 * tracked. The column is NOT NULL with no default and `takeRecordsSnapshot` throws on a fund with no
 * readable policy — the same guard from two directions.
 */

let t: TestDb;
let env: Env;

const ACTOR: Actor = {
  type: "HUMAN",
  firmUserId: "fu_sequoia_taylor",
  firmScopes: ["west-peek"],
  roles: ["MANAGING_PARTNER"],
};

const FUND = "fund_deck_test";

async function setPolicy(table: string, column: string, versionNo: number, doc: unknown): Promise<void> {
  await env.WP_OS_DB.prepare(
    `INSERT INTO ${table} (id, fund_id, version_no, effective_from, ${column}, created_by, firm_scope)
     VALUES (?1, ?2, ?3, '2026-09-09', ?4, 'fu_sequoia_taylor', 'west-peek')`,
  )
    .bind(`pv_${table}_${versionNo}`, FUND, versionNo, JSON.stringify(doc))
    .run();
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  await env.WP_OS_DB.prepare(
    "INSERT INTO fund (id, name, status, firm_scope) VALUES (?1, 'West Peek Ventures Fund I', 'ACTIVE', 'west-peek')",
  ).bind(FUND).run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("a snapshot is a photograph of the records, not a promise about them", () => {
  it("REFUSES to snapshot a fund with no readable policy, rather than storing an empty one", async () => {
    /*
     * The empty-loop guard for this file. An empty snapshot with a timestamp on it is the worst
     * outcome available: the version looks tracked, the diff against it is meaningless, and nobody
     * finds out until they need the answer.
     */
    await expect(takeRecordsSnapshot(env, FUND)).rejects.toThrow(/no readable mandate or sleeve policy/i);
  });

  it("captures every figure a slide would print, and the policy versions behind them", async () => {
    await setPolicy("investment_mandate_version", "mandate_json", 1, {
      target_size_usd: 30_000_000,
      sectors: ["AI", "HEALTH_TECH", "CONSUMER", "ED_TECH", "FUTURE_OF_WORK"],
      target_positions: 25,
      check_size_usd: { min: 250_000, max: 750_000 },
    });
    await setPolicy("sleeve_policy_version", "sleeve_json", 1, {
      committed_usd: 30_000_000,
      estimated_fees_usd: 5_000_000,
      estimated_expenses_usd: 1_000_000,
      estimated_investable_usd: 24_000_000,
      sleeves: [
        { key: "EARLY_STAGE_PRIMARY", target_pct: 70 },
        { key: "SECONDARY_PURCHASE", target_pct: 30 },
      ],
    });
    await setPolicy("reserve_policy_version", "reserve_json", 1, { reserve_pct: 40, basis: "early-stage sleeve" });

    const snap = await takeRecordsSnapshot(env, FUND);

    expect(snap.fund_size_usd).toBe(30_000_000);
    expect(snap.investable_base_usd).toBe(24_000_000);
    // Derived, not read: the policy stores 70 and 30 and no dollars at all.
    expect(snap.sleeves.find((s) => s.key === "EARLY_STAGE_PRIMARY")!.derived_usd).toBeCloseTo(16_800_000, 6);
    expect(snap.sleeves.find((s) => s.key === "SECONDARY_PURCHASE")!.derived_usd).toBeCloseTo(7_200_000, 6);
    expect(snap.reserve_usd).toBeCloseTo(6_720_000, 6);
    expect(snap.initial_capital_usd).toBeCloseTo(10_080_000, 6);
    expect(snap.sectors).toEqual(["AI", "HEALTH_TECH", "CONSUMER", "ED_TECH", "FUTURE_OF_WORK"]);
    expect(snap.target_positions).toBe(25);

    // Traceable to its sources, so a snapshot can be argued with rather than merely believed.
    expect(snap.policy_versions).toEqual({ mandate: 1, sleeve: 1, reserve: 1 });
    expect(snap.taken_at).toBeTruthy();
  });
});

describe("every version carries the records it was built from", () => {
  it("stores a non-empty snapshot on v1 and reports no diff, because there is nothing before it", async () => {
    const v1 = await recordDeckVersion(env, ACTOR, {
      fundId: FUND,
      title: "West Peek Ventures Fund I — August 2026",
      origin: "UPLOADED",
      createdBy: "Sequoia Taylor",
      createdByType: "HUMAN",
      pageCount: 16,
    });

    expect(v1.version_no).toBe(1);
    // THE ASSERTION THIS FILE EXISTS FOR.
    expect(v1.records_snapshot_json, "v1 carries no snapshot").toBeTruthy();
    const snap = JSON.parse(v1.records_snapshot_json) as { fund_size_usd: number; sleeves: unknown[] };
    expect(snap.fund_size_usd, "the snapshot is present but empty, which is worse than absent").toBe(30_000_000);
    expect(snap.sleeves.length).toBeGreaterThan(0);

    // v1 is the historical record of what LPs received, so it is current on arrival.
    expect(v1.state).toBe("CURRENT");
    expect(v1.origin).toBe("UPLOADED");
    expect(v1.change_summary, "a diff against nothing would be prose pretending to be a measurement").toBeNull();
    expect(JSON.parse(v1.changed_fields_json)).toEqual([]);
  });

  it("measures the diff from the two snapshots when the records move", async () => {
    // The 70/30 split becomes 60/40. Nothing else is touched.
    await setPolicy("sleeve_policy_version", "sleeve_json", 2, {
      committed_usd: 30_000_000,
      estimated_fees_usd: 5_000_000,
      estimated_expenses_usd: 1_000_000,
      estimated_investable_usd: 24_000_000,
      sleeves: [
        { key: "EARLY_STAGE_PRIMARY", target_pct: 60 },
        { key: "SECONDARY_PURCHASE", target_pct: 40 },
      ],
    });

    const v2 = await recordDeckVersion(env, ACTOR, {
      fundId: FUND,
      title: "West Peek Ventures Fund I — rebuilt",
      origin: "BUILT",
      createdBy: "Preston",
      createdByType: "AI",
      pageCount: 16,
    });

    const changed = JSON.parse(v2.changed_fields_json) as Array<{ field: string; was: string; now: string }>;
    expect(changed.length, "the records moved and the version recorded no diff").toBeGreaterThan(0);

    const sleeve = changed.find((c) => c.field === "Sleeve EARLY_STAGE_PRIMARY")!;
    expect(sleeve.was).toBe("$16.8M");
    expect(sleeve.now).toBe("$14.4M");
    expect(changed.some((c) => c.field === "Sleeve EARLY_STAGE_PRIMARY share" && c.was === "70%" && c.now === "60%")).toBe(true);
    // Reserves and initials follow the sleeve, so they move too — which is the point of deriving.
    expect(changed.some((c) => c.field === "Reserves")).toBe(true);
    expect(changed.some((c) => c.field === "Capital for initial cheques")).toBe(true);

    expect(v2.change_summary, "no words were written for a list of moved figures").toContain("changed");

    /*
     * A BUILT version is a PROPOSAL. An outward-facing LP document publishes nothing by itself, so
     * v1 stays current until a human approves the new one.
     */
    expect(v2.state).toBe("PROPOSED");
    expect(v2.created_by).toBe("Preston");
    expect(v2.created_by_type).toBe("AI");
  });
});

describe("the staleness line the operator asked for", () => {
  it("names which figures have moved since a deck was built, not merely that some have", () => {
    const was = {
      taken_at: "2026-08-18T00:00:00.000Z",
      fund_size_usd: 30_000_000,
      estimated_fees_usd: 5_000_000,
      estimated_expenses_usd: 1_000_000,
      investable_base_usd: 24_000_000,
      sleeves: [{ key: "EARLY_STAGE_PRIMARY", target_pct: 70, derived_usd: 16_800_000 }],
      reserve_pct: 40,
      reserve_usd: 6_720_000,
      initial_capital_usd: 10_080_000,
      sectors: ["HEALTH_TECH", "ED_TECH", "CONSUMER", "FUTURE_OF_WORK"],
      target_positions: 20,
      check_size_usd: { min: 500_000, max: 750_000 },
      policy_versions: { mandate: 1, sleeve: 1, reserve: 1 },
    };
    const now = {
      ...was,
      taken_at: "2026-09-09T00:00:00.000Z",
      sectors: ["AI", "HEALTH_TECH", "CONSUMER", "ED_TECH", "FUTURE_OF_WORK"],
      target_positions: 25,
      check_size_usd: { min: 250_000, max: 750_000 },
    };

    const drift = driftSince(was, now);
    expect(drift.length, "nothing was detected between two visibly different snapshots").toBeGreaterThan(0);

    const sectors = drift.find((d) => d.field === "Sector focus")!;
    expect(sectors.now).toContain("AI");
    expect(drift.some((d) => d.field === "Target positions" && d.was === "20" && d.now === "25")).toBe(true);
    expect(drift.some((d) => d.field === "Cheque range" && d.now.startsWith("$250K"))).toBe(true);

    // And a figure that did NOT move is not reported, or the line becomes noise.
    expect(drift.some((d) => d.field === "Fund size")).toBe(false);
  });

  it("says plainly when nothing has moved, rather than saying nothing", () => {
    const snap = {
      taken_at: "2026-09-09T00:00:00.000Z",
      fund_size_usd: 30_000_000,
      estimated_fees_usd: 5_000_000,
      estimated_expenses_usd: 1_000_000,
      investable_base_usd: 24_000_000,
      sleeves: [{ key: "EARLY_STAGE_PRIMARY", target_pct: 70, derived_usd: 16_800_000 }],
      reserve_pct: 40,
      reserve_usd: 6_720_000,
      initial_capital_usd: 10_080_000,
      sectors: ["AI"],
      target_positions: 25,
      check_size_usd: { min: 250_000, max: 750_000 },
      policy_versions: { mandate: 3, sleeve: 5, reserve: 5 },
    };
    expect(driftSince(snap, snap)).toEqual([]);
    expect(summariseDrift([])).toContain("No fund figure changed");
  });
});

describe("what was sent to an LP is not editable", () => {
  it("refuses to change a version's snapshot, and refuses to delete it", async () => {
    const row = await env.WP_OS_DB.prepare(
      "SELECT id FROM deck_version WHERE fund_id = ?1 ORDER BY version_no LIMIT 1",
    ).bind(FUND).first<{ id: string }>();
    expect(row, "no deck version to test immutability against").toBeTruthy();

    await expect(
      env.WP_OS_DB.prepare("UPDATE deck_version SET records_snapshot_json = '{}' WHERE id = ?1").bind(row!.id).run(),
    ).rejects.toThrow(/immutable/i);

    await expect(
      env.WP_OS_DB.prepare("DELETE FROM deck_version WHERE id = ?1").bind(row!.id).run(),
    ).rejects.toThrow(/append-only/i);
  });

  it("still allows the approval decision to be recorded, which is a later human act", async () => {
    const proposed = await env.WP_OS_DB.prepare(
      "SELECT id FROM deck_version WHERE fund_id = ?1 AND state = 'PROPOSED' LIMIT 1",
    ).bind(FUND).first<{ id: string }>();
    expect(proposed, "no proposed version to approve").toBeTruthy();

    await env.WP_OS_DB.prepare(
      "UPDATE deck_version SET state = 'CURRENT', approved_by = 'fu_sequoia_taylor', approved_at = '2026-09-09T00:00:00.000Z' WHERE id = ?1",
    ).bind(proposed!.id).run();

    const after = await env.WP_OS_DB.prepare("SELECT state FROM deck_version WHERE id = ?1")
      .bind(proposed!.id).first<{ state: string }>();
    expect(after!.state).toBe("CURRENT");
  });
});

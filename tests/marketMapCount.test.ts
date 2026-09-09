import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { landedCompanyCount } from "../src/worker/services/marketMap";
import type { Env } from "../src/worker/env";

/**
 * A COUNT MUST DESCRIBE THE ROWS, NOT THE INTENTION.
 *
 * `mkt_map.company_count` was written as `merged.length` — how many companies the build MEANT to
 * insert. The insert is `INSERT OR IGNORE` against `UNIQUE (map_id, name)`, so any two companies
 * the merge left sharing a name are silently reduced to one while the stored number keeps counting
 * both. The map then reports "3 companies" over a list of 2, on the Market Map page and again on
 * the IC portal, for ever — the number is written once at build time and nothing ever reconciles it
 * with the rows it claims to describe.
 *
 * This is the shape that has turned up repeatedly across this portfolio today: a value derived once
 * at write time and never checked against the state it describes. Production holds zero market maps
 * right now, so this was never visible there; it is reproduced here instead, which is the only
 * honest way to call it CONFIRMED.
 */

let t: TestDb;
let env: Env;

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  await env.WP_OS_DB.prepare(
    `INSERT INTO mkt_map (id, sector, status, created_by, firm_scope)
     VALUES ('mm_test', 'AI infrastructure', 'BUILDING', 'fu_sequoia_taylor', 'west-peek')`,
  ).run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

/** The exact statement the builder uses, so this tests the real write and not a paraphrase of it. */
async function insertCompany(name: string): Promise<void> {
  await env.WP_OS_DB.prepare(
    `INSERT OR IGNORE INTO mkt_map_company (id, map_id, name, segment, funding_source)
     VALUES (?1, 'mm_test', ?2, 'Unsegmented', 'FIRM_RECORD')`,
  )
    .bind(`mkc_${crypto.randomUUID()}`, name)
    .run();
}

describe("the number of companies on a map", () => {
  it("reproduces the drop: three intended, two stored", async () => {
    const intended = ["Ravenna", "Ravenna", "Solace"];
    for (const name of intended) await insertCompany(name);

    const landed = await landedCompanyCount(env, "mm_test");

    // The premise, asserted so this cannot pass for the wrong reason: the collision really happened.
    expect(intended.length, "nothing was inserted, so nothing is being counted").toBe(3);
    expect(landed, "the UNIQUE (map_id, name) collision did not occur, so there is no drop to catch").toBe(2);
    expect(landed).not.toBe(intended.length);
  });

  it("counts what is on the map, and moves when the map does", async () => {
    await insertCompany("Thornbury");
    expect(await landedCompanyCount(env, "mm_test")).toBe(3);
    await env.WP_OS_DB.prepare("DELETE FROM mkt_map_company WHERE map_id = 'mm_test' AND name = 'Thornbury'").run();
    expect(await landedCompanyCount(env, "mm_test")).toBe(2);
  });

  it("returns zero for a map with nothing on it rather than throwing", async () => {
    expect(await landedCompanyCount(env, "mm_missing")).toBe(0);
  });
});

/**
 * AND THE BUILDER USES IT.
 *
 * Everything above passes with `buildMarketMap` still storing `merged.length`: the helper would be
 * correct and unused, which is this repo's "exists but nothing invokes it" defect. Building a real
 * map needs a model and a live web search, so the wiring is asserted from the source instead —
 * narrowly, on the statement that writes the column.
 */
describe("the builder stores the counted number", () => {
  const SRC = readFileSync(fileURLToPath(new URL("../src/worker/services/marketMap.ts", import.meta.url)), "utf8");

  it("binds the landed count into company_count and never the intended length", () => {
    const update = SRC.indexOf("UPDATE mkt_map SET status = 'READY'");
    expect(update, "the completing UPDATE has moved; this guard can no longer see it").toBeGreaterThan(-1);

    // The bind list follows the statement; take the call up to its `.run()`.
    const tail = SRC.slice(update);
    const stmt = tail.slice(0, tail.indexOf(".run()"));
    expect(stmt).toContain("company_count");
    expect(stmt, "company_count is bound to the intended length again").not.toContain("merged.length");
    expect(stmt).toContain("landed");
    expect(SRC, "the builder never calls the counter").toContain("await landedCompanyCount(env, id)");
  });
});

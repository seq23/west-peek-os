import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { EXTERNAL_EFFECT_ACTION_TYPES, ORDINARY_ACTION_TYPES } from "../src/shared/registry/actionTypes";
import { HUMAN_RESERVED_ACTION_KEYS } from "../src/shared/registry/reservedActions";

/**
 * Every action key the code can ask for must exist in the database (P37).
 *
 * WHY THIS TEST EXISTS. The seed generator writes the registry into migration 0003. A fresh
 * database therefore always matches, and `validate:authority` compares code against that same
 * regenerated file — so both agreed while PRODUCTION, which applied 0003 long ago, silently lacked
 * three keys added on 17 Aug 2026. authorize() denies unknown keys, so three shipped features
 * returned 403 in production and worked everywhere else.
 *
 * This test cannot catch a stale production database on its own — nothing local can. What it does
 * catch is the other half: a key added to the registry with no migration carrying it, which is the
 * step that gets forgotten. Combined with querying prod after deploy, that closes the gap.
 */

let t: TestDb;
let env: Env;

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("action type coverage", () => {
  it("has every ordinary and external-effect key in the database", async () => {
    const rows = await env.WP_OS_DB.prepare("SELECT key FROM action_type").all<{ key: string }>();
    const inDb = new Set((rows.results ?? []).map((r) => r.key));
    const inCode = [...ORDINARY_ACTION_TYPES, ...EXTERNAL_EFFECT_ACTION_TYPES].map((a) => a.key);
    expect(inCode.filter((k) => !inDb.has(k))).toEqual([]);
  });

  it("has every human-reserved action in the database", async () => {
    const rows = await env.WP_OS_DB.prepare("SELECT key FROM action_type").all<{ key: string }>();
    const inDb = new Set((rows.results ?? []).map((r) => r.key));
    expect(HUMAN_RESERVED_ACTION_KEYS.filter((k) => !inDb.has(k))).toEqual([]);
  });

  it("carries the three keys the 0033 backfill exists for", async () => {
    // Named explicitly: these are the ones that were missing in production, and a regression here
    // means the same three features 403 again.
    const rows = await env.WP_OS_DB.prepare(
      "SELECT key FROM action_type WHERE key IN ('event.manage','community.manage','weekly_review.manage')",
    ).all<{ key: string }>();
    expect((rows.results ?? []).map((r) => r.key).sort()).toEqual([
      "community.manage", "event.manage", "weekly_review.manage",
    ]);
  });
});

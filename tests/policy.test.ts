import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createTestDb, disposeTestDb, latestMigrationName, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";

/**
 * P2 — fund/policy substrate proofs: policy immutability at trigger level,
 * version history preservation, referential integrity, migration idempotency.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

function req(path: string, method = "GET", body?: unknown): Request {
  return new Request(`https://test.local${path}`, {
    method,
    headers: body === undefined ? MP : { ...MP, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const POLICY_TABLES = [
  "investment_mandate_version",
  "sleeve_policy_version",
  "reserve_policy_version",
  "concentration_policy_version",
] as const;

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("migration 0002 — schema + idempotency", () => {
  it("records schema version 0002 (later migrations are additive)", async () => {
    const row = await t.db
      .prepare("SELECT migration FROM schema_version WHERE migration = '0002_company_fund_policy'")
      .first<{ migration: string }>();
    expect(row?.migration).toBe("0002_company_fund_policy");
    const latest = await t.db
      .prepare("SELECT migration FROM schema_version ORDER BY migration DESC LIMIT 1")
      .first<{ migration: string }>();
    expect(latest?.migration).toBe(latestMigrationName());
  });

  it("creates all P2 tables with firm_scope defaulting to 'west-peek' (§11.7)", async () => {
    const tables = await t.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>();
    const names = (tables.results ?? []).map((r) => r.name);
    for (const expected of [
      "canonical_company",
      "company_alias",
      "company_external_identity",
      "person",
      "organization_relationship",
      "identity_resolution_candidate",
      "identity_merge_receipt",
      "identity_split_receipt",
      "fund",
      "fund_entity",
      ...POLICY_TABLES,
    ]) {
      expect(names).toContain(expected);
    }

    await t.db.prepare("INSERT INTO fund (id, name) VALUES ('fund_scope_check', 'Scope Check')").run();
    const fund = await t.db
      .prepare("SELECT firm_scope FROM fund WHERE id = 'fund_scope_check'")
      .first<{ firm_scope: string }>();
    expect(fund?.firm_scope).toBe("west-peek");
  });

  it("re-applying migrations is a tracked no-op (idempotency)", async () => {
    const secondRun = await applyMigrations(t.db);
    expect(secondRun).toEqual([]);
    const funds = await t.db.prepare("SELECT COUNT(*) AS n FROM fund").first<{ n: number }>();
    expect(funds?.n).toBe(1);
  });
});

describe("policy version immutability (trigger-level, every role)", () => {
  let fundId: string;

  it("creates a fund and a v1 of every policy kind via the API", async () => {
    const res = await handleRequest(req("/api/funds", "POST", { name: "Policy Test Fund" }), env);
    expect(res.status).toBe(201);
    fundId = ((await res.json()) as { id: string }).id;

    for (const kind of ["mandate", "sleeve", "reserve", "concentration"]) {
      const created = await handleRequest(
        req(`/api/funds/${fundId}/policies/${kind}`, "POST", {
          version_no: 1,
          effective_from: "2026-01-01",
          policy: { note: `${kind} v1` },
        }),
        env,
      );
      expect(created.status).toBe(201);
    }

    const evt = await t.db
      .prepare("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'policy.version_created'")
      .first<{ n: number }>();
    expect(evt!.n).toBe(4);
  });

  it("rejects UPDATE and DELETE on all four policy version tables at the database layer", async () => {
    for (const table of POLICY_TABLES) {
      await expect(
        t.db.prepare(`UPDATE ${table} SET created_by = 'tamper' WHERE fund_id = ?1`).bind(fundId).run(),
      ).rejects.toThrow(/immutable/);
      await expect(t.db.prepare(`DELETE FROM ${table} WHERE fund_id = ?1`).bind(fundId).run()).rejects.toThrow(
        /immutable/,
      );
      // Rejected writes must not have taken effect.
      const row = await t.db
        .prepare(`SELECT created_by FROM ${table} WHERE fund_id = ?1`)
        .bind(fundId)
        .first<{ created_by: string }>();
      expect(row?.created_by).toBe("fu_scooter_taylor");
    }
  });

  it("creating v2 preserves v1 readable (history never rewritten)", async () => {
    const v2 = await handleRequest(
      req(`/api/funds/${fundId}/policies/mandate`, "POST", {
        version_no: 2,
        effective_from: "2026-06-01",
        policy: { note: "mandate v2 supersedes v1" },
      }),
      env,
    );
    expect(v2.status).toBe(201);

    const v1 = await handleRequest(req(`/api/funds/${fundId}/policies/mandate/1`), env);
    expect(v1.status).toBe(200);
    const v1Body = (await v1.json()) as { version_no: number; mandate_json: string };
    expect(JSON.parse(v1Body.mandate_json)).toEqual({ note: "mandate v1" });

    const list = (await (
      await handleRequest(req(`/api/funds/${fundId}/policies/mandate`), env)
    ).json()) as { versions: Array<{ version_no: number }> };
    expect(list.versions.map((v) => v.version_no)).toEqual([1, 2]);

    // Duplicate version_no is a conflict, not an overwrite.
    const dup = await handleRequest(
      req(`/api/funds/${fundId}/policies/mandate`, "POST", {
        version_no: 2,
        effective_from: "2026-07-01",
        policy: { note: "duplicate" },
      }),
      env,
    );
    expect(dup.status).toBe(409);
  });

  it("no update/delete API surface exists for policy versions (405-free: routes absent → 404)", async () => {
    const patch = await handleRequest(req(`/api/funds/${fundId}/policies/mandate/1`, "PATCH", { policy: {} }), env);
    expect(patch.status).toBe(404);
    const del = await handleRequest(req(`/api/funds/${fundId}/policies/mandate/1`, "DELETE"), env);
    expect(del.status).toBe(404);
  });
});

describe("referential integrity", () => {
  it("FK violations surface as errors, not silent corruption", async () => {
    await expect(
      t.db
        .prepare("INSERT INTO company_alias (id, company_id, alias) VALUES ('ca_bad_fk', 'no_such_company', 'x')")
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/i);

    await expect(
      t.db
        .prepare(
          "INSERT INTO fund_entity (id, fund_id, legal_entity_name, entity_type) VALUES ('fe_bad_fk', 'no_such_fund', 'x', 'LLC')",
        )
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/i);

    await expect(
      t.db
        .prepare(
          "INSERT INTO investment_mandate_version (id, fund_id, version_no, effective_from, mandate_json, created_by) VALUES ('pv_bad_fk', 'no_such_fund', 1, '2026-01-01', '{}', 'fu_scooter_taylor')",
        )
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/i);

    await expect(
      t.db
        .prepare(
          "INSERT INTO identity_resolution_candidate (id, company_id_a, company_id_b, match_basis, proposed_by) VALUES ('irc_bad_fk', 'nope_a', 'nope_b', 'x', 'fu_scooter_taylor')",
        )
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/i);

    // Nothing was persisted by the failed inserts.
    expect((await t.db.prepare("SELECT COUNT(*) AS n FROM company_alias WHERE id = 'ca_bad_fk'").first<{ n: number }>())!.n).toBe(0);
    expect((await t.db.prepare("SELECT COUNT(*) AS n FROM fund_entity WHERE id = 'fe_bad_fk'").first<{ n: number }>())!.n).toBe(0);
  });

  it("(system, external_key) uniqueness is enforced", async () => {
    await t.db
      .prepare("INSERT INTO canonical_company (id, canonical_name, created_by) VALUES ('cc_uniq_1', 'Uniq Co', 'fu_scooter_taylor')")
      .run();
    await t.db
      .prepare(
        "INSERT INTO company_external_identity (id, company_id, system, external_key) VALUES ('cei_uniq_1', 'cc_uniq_1', 'crunchbase', 'uniq-co')",
      )
      .run();
    await expect(
      t.db
        .prepare(
          "INSERT INTO company_external_identity (id, company_id, system, external_key) VALUES ('cei_uniq_2', 'cc_uniq_1', 'crunchbase', 'uniq-co')",
        )
        .run(),
    ).rejects.toThrow(/UNIQUE/i);
  });
});

/*
 * Amending the mandate said "Saved as version 2" and changed nothing on screen.
 *
 * `handleListPolicyVersions` returns versions oldest-first, which is right for a history. Seven
 * call sites then took `versions[0]` believing it was the newest, and one took `.at(-1)` believing
 * the opposite — so the Thesis page, Deal Math and the fund allocation ring displayed version 1 for
 * ever while the allocation model pinned the latest. Only one version had ever existed in
 * production, which is why nobody saw it; it would have fired the first time a partner did the
 * thing the Thesis page exists for.
 *
 * The fix is to name the current one rather than answer the indexing question seven times.
 */
describe("the mandate in force is named, not indexed", () => {
  it("returns versions oldest-first and names the newest as current", async () => {
    const fund = await t.db.prepare("SELECT id FROM fund LIMIT 1").first<{ id: string }>();

    // Two versions, so the two ends of the list are different rows.
    await t.db
      .prepare(
        `INSERT INTO investment_mandate_version (id, fund_id, version_no, mandate_json, effective_from, created_by)
         VALUES (?1, ?2, 99, ?3, '2026-08-21', 'fu_scooter_taylor')`,
      )
      .bind(`imv_${crypto.randomUUID()}`, fund!.id, JSON.stringify({ statement: "the newest one" }))
      .run();

    const raw = await handleRequest(req(`/api/funds/${fund!.id}/policies/mandate`), env);
    expect(raw.status).toBe(200);
    const body = (await raw.json()) as {
      versions: Array<{ version_no: number }>;
      current: { version_no: number; mandate_json: string } | null;
      note: string;
    };
    const list = body.versions;
    expect(list.length).toBeGreaterThan(1);

    // Oldest first — the history order, deliberately kept.
    expect(list[0]!.version_no).toBeLessThan(list[list.length - 1]!.version_no);

    // And `current` is the newest, which is what every surface should read.
    expect(body.current?.version_no).toBe(list[list.length - 1]!.version_no);
    expect(body.current?.mandate_json).toContain("the newest one");

    // The reader is told not to index, so this does not come back.
    expect(body.note).toContain("do not index");
  });

  it("names nothing as current when a fund has no versions of that policy", async () => {
    const fund = await t.db.prepare("SELECT id FROM fund LIMIT 1").first<{ id: string }>();
    const raw = await handleRequest(req(`/api/funds/${fund!.id}/policies/concentration`), env);
    const body = (await raw.json()) as { versions: unknown[]; current: unknown };
    if ((body.versions ?? []).length === 0) expect(body.current).toBeNull();
  });
});

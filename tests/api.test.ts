import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, latestMigrationName, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";

let t: TestDb;
let env: Env;

function req(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://test.local${path}`, { headers });
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  // Firm scope fixture: Scooter holds an authority scope over a fund sleeve.
  await t.db
    .prepare(
      "INSERT INTO authority_scope (id, firm_user_id, scope_key, scope_value) VALUES ('as_test_1', 'fu_scooter_taylor', 'fund_sleeve', 'fund_iv_early')",
    )
    .run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("authentication (ADR-006) — fail closed", () => {
  it("denies /api/me with no identity header (401)", async () => {
    const res = await handleRequest(req("/api/me"), env);
    expect(res.status).toBe(401);
  });

  it("denies /api/me for an unknown email (401)", async () => {
    const res = await handleRequest(
      req("/api/me", { "x-wpos-dev-user": "nobody@example.com" }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("denies even unknown /api/* paths when unauthenticated (401 before 404)", async () => {
    const res = await handleRequest(req("/api/does-not-exist"), env);
    expect(res.status).toBe(401);
  });

  it("ignores the dev identity header when WP_OS_ENV is not local", async () => {
    const previewEnv = makeTestEnv(t.db, { WP_OS_ENV: "preview" });
    const res = await handleRequest(
      req("/api/me", { "x-wpos-dev-user": "scooter@westpeek.ventures" }),
      previewEnv,
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /api/me", () => {
  it("returns the FirmUser, roles, and authority scopes for a known dev identity", async () => {
    const res = await handleRequest(
      req("/api/me", { "x-wpos-dev-user": "scooter@westpeek.ventures" }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      email: string;
      fullName: string;
      roles: string[];
      authorityScopes: Array<{ scopeKey: string; scopeValue: string }>;
    };
    expect(body.email).toBe("scooter@westpeek.ventures");
    expect(body.fullName).toBe("Scooter Taylor");
    expect(body.roles).toEqual(["MANAGING_PARTNER"]);
    expect(body.authorityScopes).toEqual([{ scopeKey: "fund_sleeve", scopeValue: "fund_iv_early" }]);
  });

  it("resolves Sequoia Taylor as a Managing Partner", async () => {
    const res = await handleRequest(
      req("/api/me", { "x-wpos-dev-user": "Sequoia@WestPeek.Ventures" }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fullName: string; roles: string[] };
    expect(body.fullName).toBe("Sequoia Taylor");
    expect(body.roles).toEqual(["MANAGING_PARTNER"]);
  });
});

describe("GET /api/health", () => {
  it("answers unauthenticated with env, schema version, and binding presence", async () => {
    const res = await handleRequest(req("/api/health"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      env: string;
      d1: { reachable: boolean; schemaVersion: string | null };
      bindings: Record<string, boolean>;
    };
    expect(body.ok).toBe(true);
    expect(body.env).toBe("local");
    expect(body.d1.reachable).toBe(true);
    expect(body.d1.schemaVersion).toBe(latestMigrationName());
    expect(body.bindings.WP_OS_DB).toBe(true);
  });

  it("degrades cleanly when optional bindings are absent (reported, not fatal)", async () => {
    const res = await handleRequest(req("/api/health"), env);
    const body = (await res.json()) as { ok: boolean; bindings: Record<string, boolean> };
    expect(body.ok).toBe(true);
    expect(body.bindings.WP_OS_DOCUMENTS).toBe(false);
    expect(body.bindings.WP_OS_KV).toBe(false);
  });
});

describe("SPA delegation", () => {
  it("delegates non-/api paths to ASSETS", async () => {
    const res = await handleRequest(req("/"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("spa");
  });
});

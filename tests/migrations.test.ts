import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createTestDb, disposeTestDb, type TestDb } from "./helpers/db";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("migration 0001 — schema + seeds", () => {
  it("records schema version 0001", async () => {
    const row = await t.db
      .prepare("SELECT migration FROM schema_version WHERE migration = '0001_runtime_identity'")
      .first<{ migration: string }>();
    expect(row?.migration).toBe("0001_runtime_identity");
  });

  it("seeds the eight application roles", async () => {
    const rows = await t.db.prepare("SELECT key FROM role ORDER BY key").all<{ key: string }>();
    expect((rows.results ?? []).map((r) => r.key)).toEqual([
      "ACCOUNTANT_AUDITOR",
      "COMPLIANCE_OFFICER",
      "COUNSEL",
      "FINANCE_AUTHORITY",
      "FUND_ADMINISTRATOR",
      "INVESTMENT_TEAM",
      "MANAGING_PARTNER",
      "OPERATIONS",
    ]);
  });

  it("seeds both Managing Partners as firm users with the MANAGING_PARTNER role", async () => {
    const rows = await t.db
      .prepare(
        `SELECT fu.email, fu.full_name, r.key AS role_key
           FROM firm_user fu
           JOIN firm_user_role fur ON fur.firm_user_id = fu.id
           JOIN role r ON r.id = fur.role_id
          ORDER BY fu.email`,
      )
      .all<{ email: string; full_name: string; role_key: string }>();
    expect(rows.results).toEqual([
      { email: "scooter@westpeek.ventures", full_name: "Scooter Taylor", role_key: "MANAGING_PARTNER" },
      { email: "sequoia@westpeek.ventures", full_name: "Sequoia Taylor", role_key: "MANAGING_PARTNER" },
    ]);
  });

  it("re-applying migrations is a tracked no-op (idempotency)", async () => {
    const secondRun = await applyMigrations(t.db);
    expect(secondRun).toEqual([]);

    /*
     * Three rows, and the third is not a person.
     *
     * This asserted a bare count of two, which was the right check while every firm_user was a
     * partner. Migration 0085 adds `fu_browser_agent` — the identity the firm's own browser uses to
     * open the firm's own pages, since everything here sits behind Cloudflare Access.
     *
     * A count would now pass for the wrong reasons, so what is asserted is the PROPERTY that makes
     * that row safe: exactly two principals hold a role, and the agent holds none. Its entire
     * control is the absence — `authorize()` denies every reserved action to an actor without the
     * approver role, so a roleless identity cannot approve, activate or decide anything.
     */
    const users = await t.db.prepare("SELECT COUNT(*) AS n FROM firm_user").first<{ n: number }>();
    expect(users?.n).toBe(3);

    const withRoles = await t.db
      .prepare("SELECT COUNT(DISTINCT firm_user_id) AS n FROM firm_user_role")
      .first<{ n: number }>();
    expect(withRoles?.n).toBe(2);

    const agentRoles = await t.db
      .prepare("SELECT COUNT(*) AS n FROM firm_user_role WHERE firm_user_id = 'fu_browser_agent'")
      .first<{ n: number }>();
    expect(agentRoles?.n).toBe(0);
  });
});

describe("event_record append-only enforcement (D15)", () => {
  it("accepts inserts and rejects UPDATE and DELETE", async () => {
    await t.db
      .prepare(
        `INSERT INTO event_record (id, event_type, actor_type, actor_id, object_type, object_id, firm_scope, payload_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(
        "evt_test_1",
        "test.inserted",
        "firm_user",
        "fu_scooter_taylor",
        "test_object",
        "obj_1",
        "firm",
        "{}",
      )
      .run();

    await expect(
      t.db.prepare("UPDATE event_record SET payload_json = '{}' WHERE id = 'evt_test_1'").run(),
    ).rejects.toThrow(/append-only/);

    await expect(t.db.prepare("DELETE FROM event_record WHERE id = 'evt_test_1'").run()).rejects.toThrow(
      /append-only/,
    );

    // Rejected writes must not have taken effect.
    const row = await t.db
      .prepare("SELECT id FROM event_record WHERE id = 'evt_test_1'")
      .first<{ id: string }>();
    expect(row?.id).toBe("evt_test_1");
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDb, type TestDb } from "./helpers/db";

/**
 * Every job the dispatcher handles must actually exist as a row.
 *
 * WHY THIS TEST EXISTS. Migration 0046 registered `monthly_room_proposal` with `INSERT OR IGNORE`
 * and omitted a NOT NULL column. The constraint violation was swallowed, the migration reported
 * success, schema_version advanced, and the job existed in no database at all — discovered only by
 * querying production by hand. Nothing in the suite would have caught it.
 *
 * Seeding is the one place a migration can "succeed" while doing nothing, so the seeded rows need
 * an assertion of their own rather than trust in the migration runner.
 */

let t: TestDb;
beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => { await t.mf.dispose(); });

/** Job keys the dispatcher special-cases, read from the source so the two cannot drift apart. */
const JOBS_SRC = readFileSync(fileURLToPath(new URL("../src/worker/services/jobs.ts", import.meta.url)), "utf8");
const DISPATCHED = [...JOBS_SRC.matchAll(/job\.job_key === "([a-z_]+)"/g)].map((m) => m[1]!);

describe("seeded scheduled jobs", () => {
  it("finds the dispatcher's job keys in the source", () => {
    expect(DISPATCHED.length).toBeGreaterThan(0);
    expect(DISPATCHED).toContain("monthly_room_proposal");
  });

  it("has a real row for every dispatched job key", async () => {
    for (const key of DISPATCHED) {
      const row = await t.db.prepare("SELECT job_key, status, created_by FROM scheduled_job WHERE job_key = ?1")
        .bind(key).first<{ job_key: string; status: string; created_by: string }>();
      expect(
        row,
        `No scheduled_job row for "${key}". A migration seeded it with INSERT OR IGNORE and a ` +
          "constraint failure was swallowed — see migration 0047.",
      ).toBeTruthy();
      expect(row!.created_by, `${key} has no created_by`).toBeTruthy();
    }
  });

  it("starts recurring work paused, because recurring spend is opt-in", async () => {
    const row = await t.db.prepare("SELECT status FROM scheduled_job WHERE job_key = 'monthly_room_proposal'")
      .first<{ status: string }>();
    expect(row?.status).toBe("PAUSED");
  });

  it("points every job at a capability key that exists in the registry", async () => {
    // The other half of the same failure: a job that runs but is refused by authorize() on a key
    // no database ever received.
    const rows = await t.db.prepare(
      `SELECT job_key, capability_key FROM scheduled_job
       WHERE capability_key IS NOT NULL
         AND capability_key NOT IN (SELECT key FROM action_type)`,
    ).all<{ job_key: string; capability_key: string }>();
    expect(rows.results ?? []).toEqual([]);
  });
});

describe("no migration seeds with INSERT OR IGNORE into scheduled_job", () => {
  it("uses WHERE NOT EXISTS instead, so a constraint failure is loud", () => {
    const dir = fileURLToPath(new URL("../migrations", import.meta.url));
    const GRANDFATHERED = new Set(["0018_orchestration.sql", "0043_scheduled_briefings.sql", "0046_monthly_room_proposal.sql"]);
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
      // Grandfathered. These predate the rule and their rows demonstrably exist, so rewriting
      // them would churn working history for nothing. 0046 is the one that actually failed and is
      // left in place on purpose: an applied migration does not re-run, and editing it would make
      // the history lie about what happened. 0047 is the fix.
      if (GRANDFATHERED.has(file)) continue;
      const sql = readFileSync(`${dir}/${file}`, "utf8");
      if (/INSERT\s+OR\s+IGNORE\s+INTO\s+scheduled_job/i.test(sql)) offenders.push(file);
    }
    expect(offenders, "seed scheduled_job with INSERT … SELECT … WHERE NOT EXISTS").toEqual([]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { DRIP_PASS_WALL_MS, claimDripPass } from "../src/worker/services/learningClub";

/**
 * ONE DRIP PASS AT A TIME (6 Nov 2026). The 17:38 UTC pass was ended by the platform at 15 minutes, sat RUNNING for 30
 * more before the sweeper closed it "abandoned", and the 18:09 pass ran on top of it. A run past the wall limit is dead
 * and is closed at once; a younger one is alive, and the new pass stands down with a named stop.
 */
let t: TestDb;
let env: Env;
beforeAll(async () => { t = await createTestDb(); env = makeTestEnv(t.db) as Env; });
afterAll(async () => { await disposeTestDb(t); });

describe("one drip pass at a time", () => {
  it("closes a pass killed at the wall limit, and stands down while a live one runs", async () => {
    const now = Date.parse("2026-11-13T18:00:00.000Z");
    const run = (id: string, minutesAgo: number) => env.WP_OS_DB.prepare("INSERT INTO job_run (id, job_id, idempotency_key, trigger_kind, status, attempt, started_at, requested_by, firm_scope) VALUES (?1, 'sjb_tlc_drip', ?1, 'SCHEDULED', 'RUNNING', 1, ?2, 'system', 'west-peek')")
      .bind(id, new Date(now - minutesAgo * 60_000).toISOString()).run();
    const status = async (id: string) => (await env.WP_OS_DB.prepare("SELECT status FROM job_run WHERE id = ?1").bind(id).first<{ status: string }>())!.status;
    await run("jrun_dead", DRIP_PASS_WALL_MS / 60_000 + 1);
    await run("jrun_me", 0);
    expect(await claimDripPass(env, "sjb_tlc_drip", "jrun_me", now)).toEqual({ ok: true, released: 1 });
    expect(await status("jrun_dead")).toBe("FAILED");
    expect(await status("jrun_me"), "never closes itself").toBe("RUNNING");
    await run("jrun_alive", 3);
    const stood = await claimDripPass(env, "sjb_tlc_drip", "jrun_me", now);
    expect(stood.ok).toBe(false);
    expect(!stood.ok && stood.why).toContain("NAMED STOP [DRIP_PASS_OVERLAP]");
    expect(await status("jrun_alive"), "a live pass is left alone").toBe("RUNNING");
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { earlierSearch } from "../src/worker/services/liveSearch";

/**
 * A SEAT'S ANSWER THAT ARRIVED AFTER THE WORKER WAS GONE IS REUSED (14 Nov 2026, wc_bd8b68cb).
 * Production: the Mac reported Walker's third search at 20:56:50, three minutes after the cron invocation awaiting it
 * had ended; its ai_run stayed RUNNING and the retry would have searched again from zero.
 */
let t: TestDb;
beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => { await disposeTestDb(t); });

const park = (id: string, prompt: string, status: string, events: number | null, output: string | null, at = "2026-11-14T20:50:46.000Z") =>
  t.db.prepare(
    `INSERT INTO subscription_seat_run (id, seat, purpose, prompt, model_access, firm_scope, status, max_seconds, run_kind, needs_search, search_events, output_text, created_at)
     VALUES (?1, 'claude_code', 'Walker: West Peek Productions research', ?2, 'PUBLIC_MODEL_APPROVED', 'west-peek', ?3, 450, 'ANSWER', 1, ?4, ?5, ?6)`,
  ).bind(id, prompt, status, events, output, at).run();

describe("earlierSearch reads a finished seat search whose ai_run was orphaned", () => {
  it("reuses a REPORTED search row for the same prompt since the run began, and nothing weaker", async () => {
    const env = makeTestEnv(t.db);
    await park("ccr_done", "find press for November", "REPORTED", 53, "PRESS ANSWER");
    await park("ccr_nosearch", "find leads", "REPORTED", 0, "FROM MEMORY");
    await park("ccr_abandoned", "find leads", "ABANDONED", null, null);
    await park("ccr_old", "find old", "REPORTED", 9, "OLD ANSWER", "2026-11-13T00:00:00.000Z");
    const since = "2026-11-14T20:00:00.000Z";
    const got = await earlierSearch(env, { purpose: "Walker: West Peek Productions research", prompt: "find press for November", since });
    expect(got?.text).toBe("PRESS ANSWER");
    expect(await earlierSearch(env, { purpose: "Walker: West Peek Productions research", prompt: "find leads", since }), "no counted searches or no answer is never reused").toBeNull();
    expect(await earlierSearch(env, { purpose: "Walker: West Peek Productions research", prompt: "find old", since }), "an earlier run's answer is not this run's").toBeNull();
    expect(await earlierSearch(env, { purpose: "Walker: West Peek Productions research", prompt: "find press for November", since, verify: () => "wrong shape" }), "the reply's required shape still applies").toBeNull();
  });
});

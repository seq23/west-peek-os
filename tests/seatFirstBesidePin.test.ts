import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { runAi, type RunAiInput } from "../src/worker/ai/runAi";
import { claimRun, recordHeartbeat, reportRun, type Seat } from "../src/worker/ai/subscriptionSeats";

/**
 * A `seatFirst` CALL'S PIN DOES NOT HIDE THE SEATS (1 Oct 2026). Parker's November Room packet was written by a free model
 * (Nemotron) while both seats were paid for and idle: the judge and the writer pin OpenRouter, and outside Free only a pin
 * left OpenRouter as the one candidate, so `seatFirst` never had a seat to put in front.
 */

let t: TestDb;
const MP_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const env = (): Env => makeTestEnv(t.db, { OPENROUTER_API_KEY: "or", WP_ANTHROPIC_API_KEY: "ant", GEMINI_API_KEY: "g", OPENAI_API_KEY: "o" });

async function setLever(lever: "FREE_ONLY" | "MODERATE" | "OPEN"): Promise<void> {
  await t.db
    .prepare(
      `INSERT INTO budget_policy (id, firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, honours_pins, prefers_frontier, spend_lever, defer_non_critical, set_by)
       VALUES (?1, 'west-peek', 'NORMAL', 'FRONTIER', 500, 500, 1, 0, ?2, 0, 'fu_sequoia_taylor')`,
    )
    .bind(`bp_sfbp_${crypto.randomUUID()}`, lever)
    .run();
}

function vendors(): { fetchImpl: typeof fetch; models: string[] } {
  const models: string[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    let model = "";
    try {
      model = String((JSON.parse(String(init?.body ?? "{}")) as { model?: string }).model ?? "");
    } catch {
      /* not JSON */
    }
    models.push(model);
    return new Response(JSON.stringify({ model, choices: [{ message: { content: `ANSWER FROM ${model}` }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, models };
}

const awake = (seat: Seat): Promise<void> => recordHeartbeat(env(), { seat, deviceId: "mac-test", hostname: "her-mac", capabilities: [] });

function claimer(seats: Seat[]): { stop: () => Promise<void> } {
  let live = true;
  const loop = (async () => {
    while (live) {
      const run = await claimRun(env(), "mac-test", seats, new Date(), ["ANSWER"], false);
      if (!run) {
        await new Promise((r) => setTimeout(r, 20));
        continue;
      }
      await reportRun(env(), { runId: run.id, deviceId: "mac-test", outputText: `SEAT ANSWER (${run.seat})` });
    }
  })();
  return { stop: async () => { live = false; await loop; } };
}

const PACKET_CALL = (seatFirst: boolean): RunAiInput => ({
  purpose: "Parker: Room packet writer",
  actor: MP_ACTOR,
  inputs: ["Write the packet."],
  sensitivity: "PUBLIC" as never,
  budgetContext: { expectedOutputTokens: 300, providerKey: "openrouter", judgement: true, ...(seatFirst ? { seatFirst: true } : {}) },
  routing: { category: "INTELLIGENCE" as const },
});

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await disposeTestDb(t);
});
beforeEach(async () => {
  await t.db.prepare("DELETE FROM subscription_seat_device").run();
  await t.db.prepare("DELETE FROM subscription_seat_run").run();
  await t.db.prepare("DELETE FROM provider_lane_health").run();
  await setLever("MODERATE");
});

describe("a pinned seatFirst call at Moderate", () => {
  it("is served by an awake seat, with nothing sent to a vendor", async () => {
    await awake("codex");
    const c = claimer(["codex"]);
    const v = vendors();
    const { run } = await runAi(env(), PACKET_CALL(true), { fetchImpl: v.fetchImpl });
    await c.stop();
    expect(run.status, run.failure_reason ?? "").toBe("COMPLETED");
    expect(run.output_text).toContain("SEAT ANSWER (codex)");
    expect(v.models).toEqual([]);
  }, 60_000);

  it("falls back to the pinned lane when no seat is awake", async () => {
    const v = vendors();
    const { run } = await runAi(env(), PACKET_CALL(true), { fetchImpl: v.fetchImpl });
    expect(run.status, run.failure_reason ?? "").toBe("COMPLETED");
    expect(v.models.length).toBeGreaterThan(0);
  }, 60_000);

  it("a pinned call NOT named seatFirst is unchanged — it never reaches a seat", async () => {
    await awake("codex");
    const c = claimer(["codex"]);
    const v = vendors();
    const { run } = await runAi(env(), PACKET_CALL(false), { fetchImpl: v.fetchImpl });
    await c.stop();
    expect(run.status, run.failure_reason ?? "").toBe("COMPLETED");
    expect(run.output_text ?? "").not.toContain("SEAT ANSWER");
  }, 60_000);
});

describe("a pinned seatFirst call whose pin is unusable", () => {
  it("is still served by an awake seat when OpenRouter is kill-switched (review of #223)", async () => {
    await t.db.prepare("UPDATE provider_registry SET kill_switched = 1 WHERE provider_key = 'openrouter'").run();
    try {
      await awake("codex");
      const c = claimer(["codex"]);
      const v = vendors();
      const { run } = await runAi(env(), PACKET_CALL(true), { fetchImpl: v.fetchImpl });
      await c.stop();
      expect(run.status, run.failure_reason ?? "").toBe("COMPLETED");
      expect(run.output_text).toContain("SEAT ANSWER (codex)");
      expect(v.models).toEqual([]);
    } finally {
      await t.db.prepare("UPDATE provider_registry SET kill_switched = 0 WHERE provider_key = 'openrouter'").run();
    }
  }, 60_000);

  it("is still blocked when the pin is unusable and no seat is awake", async () => {
    await t.db.prepare("UPDATE provider_registry SET kill_switched = 1 WHERE provider_key = 'openrouter'").run();
    try {
      const { run } = await runAi(env(), PACKET_CALL(true), { fetchImpl: vendors().fetchImpl });
      expect(run.status).not.toBe("COMPLETED");
    } finally {
      await t.db.prepare("UPDATE provider_registry SET kill_switched = 0 WHERE provider_key = 'openrouter'").run();
    }
  }, 60_000);
});

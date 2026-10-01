import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { runAi, type RunAiInput } from "../src/worker/ai/runAi";
import { claimRun, recordHeartbeat, reportRun, type Seat } from "../src/worker/ai/subscriptionSeats";
import { deliver } from "../src/worker/services/deliverables";
import { degradedNoteForRun, withQualityBanner } from "../src/worker/services/qualityNotes";

/**
 * THE FREE-ONLY LADDER (1 Oct 2026). The owner's rule at Free only: get the work done at the price I set.
 *
 *   1. the subscription seats lead — they are already paid for, cost nothing per call, and are FULL quality: never flagged;
 *   2. when both are away, a free lane carries the work instead of the call being stopped, and the deliverable says so
 *      unless that model's quality tier is FULL (the owner's decision per model; the default is UNMEASURED);
 *   3. only when NOTHING at $0 can carry it — private content with the seats away — does the call stop, and the
 *      sentence names the lever.
 * A call's quality label ("judgement") never turns "free" into "stop": it is why a seat leads, not why a call is refused.
 *
 * Reproduces the owner's card: "Room packet: one topic, three angles" — a PUBLIC call marked judgement, pinned to OpenRouter,
 * stopped at Free only with "needs a paid model" while two paid seats and free lanes were available.
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
    .bind(`bp_ladder_${crypto.randomUUID()}`, lever)
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

function claimer(seats: Seat[]): { stop: () => Promise<void>; handled: string[] } {
  const handled: string[] = [];
  let live = true;
  const loop = (async () => {
    while (live) {
      const run = await claimRun(env(), "mac-test", seats, new Date(), ["ANSWER"], false);
      if (!run) {
        await new Promise((r) => setTimeout(r, 20));
        continue;
      }
      handled.push(run.seat);
      await reportRun(env(), { runId: run.id, deviceId: "mac-test", outputText: `SEAT ANSWER (${run.seat})` });
    }
  })();
  return { handled, stop: async () => { live = false; await loop; } };
}

/** The Room packet's own call, as `defaultSynthesise` makes it: PUBLIC, judgement, pinned to the paid OpenRouter lane. */
const ROOM_CALL = (extra: Partial<RunAiInput> = {}): RunAiInput => ({
  purpose: "Room packet: one topic, three angles",
  actor: MP_ACTOR,
  inputs: ["Choose one topic and three angles."],
  sensitivity: "PUBLIC" as never,
  budgetContext: { expectedOutputTokens: 300, providerKey: "openrouter", judgement: true },
  routing: { category: "INTELLIGENCE" as const },
  ...extra,
});
const PRIVATE_CALL = (): RunAiInput => ({
  purpose: "draft a note on the fund's position",
  actor: MP_ACTOR,
  inputs: ["Summarise where we landed."],
  sensitivity: "INTERNAL" as never,
  budgetContext: { expectedOutputTokens: 200, judgement: true, confidential: true },
  routing: { category: "OPERATIONS" as const },
});

const flag = async (id: string) => (await t.db.prepare("SELECT quality_degraded, quality_note, model FROM ai_run WHERE id = ?1").bind(id).first<{ quality_degraded: number; quality_note: string | null; model: string | null }>())!;

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
  await t.db.prepare("UPDATE provider_model SET quality_tier = 'UNMEASURED'").run();
  await setLever("FREE_ONLY");
});

describe("Free only: the seats lead, at full quality", () => {
  it("the owner's card — a PUBLIC judgement call pinned to OpenRouter — is served by a seat, with no vendor call and no warning", async () => {
    await awake("codex");
    const c = claimer(["codex"]);
    const v = vendors();
    const { run } = await runAi(env(), ROOM_CALL(), { fetchImpl: v.fetchImpl });
    await c.stop();
    expect(run.status, run.failure_reason ?? "").toBe("COMPLETED");
    expect(run.output_text).toContain("SEAT ANSWER (codex)");
    expect(v.models, "nothing was sent to a vendor").toEqual([]);
    expect((await flag(run.id)).quality_degraded, "a seat is full quality and is never flagged").toBe(0);
  }, 60_000);

  it("a PRIVATE judgement call is served by a seat too — seats do not train", async () => {
    await awake("claude_code");
    const c = claimer(["claude_code"]);
    const { run } = await runAi(env(), PRIVATE_CALL(), { fetchImpl: vendors().fetchImpl });
    await c.stop();
    expect(run.status, run.failure_reason ?? "").toBe("COMPLETED");
    expect(run.output_text).toContain("SEAT ANSWER (claude_code)");
  }, 60_000);
});

describe("Free only, seats away: a free lane carries the work and the warning says so", () => {
  it("serves the Room call on a free lane (never stops), records the warning, and says it has not been measured", async () => {
    const v = vendors();
    const { run } = await runAi(env(), ROOM_CALL(), { fetchImpl: v.fetchImpl });
    expect(run.status, run.failure_reason ?? "").toBe("COMPLETED");
    expect(run.output_text).toContain("ANSWER FROM");
    const f = await flag(run.id);
    expect(f.quality_degraded).toBe(1);
    expect(f.quality_note).toMatch(/free model whose quality has not been measured/);
    expect(f.quality_note, "valid at any setting: it claims nothing about why a seat was not used").not.toMatch(/seats were not available|spend setting/);
    expect(await degradedNoteForRun(env(), run.id)).toBe(f.quality_note);
  }, 60_000);

  it("a model the owner has marked DEGRADED says it is known to be weaker", async () => {
    await t.db.prepare("UPDATE provider_model SET quality_tier = 'DEGRADED' WHERE provider_id IN (SELECT id FROM provider_registry WHERE training_permitted = 1)").run();
    const { run } = await runAi(env(), ROOM_CALL(), { fetchImpl: vendors().fetchImpl });
    expect(run.status, run.failure_reason ?? "").toBe("COMPLETED");
    expect((await flag(run.id)).quality_note).toMatch(/known to be weaker/);
  }, 60_000);

  it("a model the owner has marked FULL carries no warning at all — which model it is decides", async () => {
    await t.db.prepare("UPDATE provider_model SET quality_tier = 'FULL' WHERE provider_id IN (SELECT id FROM provider_registry WHERE training_permitted = 1)").run();
    const { run } = await runAi(env(), ROOM_CALL(), { fetchImpl: vendors().fetchImpl });
    expect(run.status, run.failure_reason ?? "").toBe("COMPLETED");
    expect((await flag(run.id)).quality_degraded).toBe(0);
  }, 60_000);

  it("a seat that is out of usage falls to the free lane in the same run", async () => {
    await awake("codex");
    // the seat is awake but reports a spent plan; the free lane takes over inside the one run
    let live = true;
    const loop = (async () => {
      while (live) {
        const run = await claimRun(env(), "mac-test", ["codex"], new Date(), ["ANSWER"], false);
        if (!run) { await new Promise((r) => setTimeout(r, 20)); continue; }
        await reportRun(env(), { runId: run.id, deviceId: "mac-test", error: "Codex has run out of usage and said: usage limit reached" });
      }
    })();
    const { run } = await runAi(env(), ROOM_CALL(), { fetchImpl: vendors().fetchImpl });
    live = false; await loop;
    expect(run.status, run.failure_reason ?? "").toBe("COMPLETED");
    expect(run.output_text).toContain("ANSWER FROM");
    expect((await flag(run.id)).quality_degraded).toBe(1);
  }, 60_000);
});

describe("Free only still stops when NOTHING at $0 can carry the work", () => {
  it("private content, seats away: free lanes may not see it, so the call stops and the sentence names the lever", async () => {
    const v = vendors();
    const { run } = await runAi(env(), PRIVATE_CALL(), { fetchImpl: v.fetchImpl });
    expect(run.status).toBe("PREFLIGHT_BLOCKED");
    expect(run.failure_reason).toContain("free_only_cannot_serve_protected_work");
    expect(run.failure_reason).toContain("FREE_ONLY");
    expect(run.failure_reason).toMatch(/No subscription seat is available/);
    expect(v.models).toEqual([]);
  }, 60_000);
});

describe("other settings are unchanged", () => {
  it("MODERATE: a protected call is never given a free lane, so no warning exists to write", async () => {
    await setLever("MODERATE");
    const { run } = await runAi(env(), ROOM_CALL(), { fetchImpl: vendors().fetchImpl });
    expect(run.status, run.failure_reason ?? "").toBe("COMPLETED");
    expect((await flag(run.id)).quality_degraded).toBe(0);
  }, 60_000);
});

describe("the warning reaches the deliverable", () => {
  it("withQualityBanner leads the body once, and leaves a body with no note exactly as it was", () => {
    expect(withQualityBanner("the body", [])).toBe("the body");
    const once = withQualityBanner("the body", ["Written by a free model."]);
    expect(once).toBe("⚠ Quality note: Written by a free model.\n\nthe body");
    expect(withQualityBanner(once, ["Written by a free model."]), "idempotent").toBe(once);
  });

  it("deliver() puts the note of a degraded run attributed to the card on top of its body; a clean card is untouched", async () => {
    const mk = async (title: string) => {
      const { createWorkCardInternal, } = await import("../src/worker/services/workCards");
      const { sweepIdentity } = await import("../src/worker/services/workSweep");
      return (await createWorkCardInternal(env(), sweepIdentity(), { title, description: "x", owner_type: "AI", owner_id: "aie_parker", firm_scope: "west-peek" })).id;
    };
    const degradedCard = await mk("Parker: a Room packet written by a free lane");
    const cleanCard = await mk("Parker: a Room packet written by a seat");
    const { run } = await runAi(env(), ROOM_CALL({ routing: { category: "INTELLIGENCE" as const, workCardId: degradedCard } }), { fetchImpl: vendors().fetchImpl });
    expect((await flag(run.id)).quality_degraded).toBe(1);
    const a = await deliver(env(), MP_ACTOR, { kind: "research_packet", title: "a", body: "BODY", preparedBy: "Parker", preparedFor: "fu_scooter_taylor", sourceType: "work_card", sourceId: degradedCard } as never);
    const b = await deliver(env(), MP_ACTOR, { kind: "research_packet", title: "b", body: "BODY", preparedBy: "Parker", preparedFor: "fu_scooter_taylor", sourceType: "work_card", sourceId: cleanCard } as never);
    expect(a.body.startsWith("⚠ Quality note: ")).toBe(true);
    expect(a.body.endsWith("BODY")).toBe(true);
    expect(b.body).toBe("BODY");
  }, 60_000);
});

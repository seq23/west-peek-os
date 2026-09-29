import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { runAi, type RunAiInput } from "../src/worker/ai/runAi";
import {
  claimRun,
  isSeat,
  markSeatExhausted,
  recordHeartbeat,
  reportRun,
  type Seat,
  type SeatRunRow,
} from "../src/worker/ai/subscriptionSeats";
import { allSeatAvailability } from "../src/worker/ai/subscriptionSeats";
import { BRIEF_USUAL_MODEL, briefServing } from "../src/shared/ai/briefServing";

/**
 * THE OWNER'S LADDER, PROVEN AT EVERY RUNG AND AT EVERY POSITION OF THE LEVER (29 Sep 2026).
 *
 *     Claude Code seat → Codex seat → free lanes (where the content may go there) → Sonnet → Anthropic → …
 *
 * "I already pay $200 a month for CC and ChatGPT Plus and I want all of this to run off the strength
 *  of that. If both are gone we stay at $0. When I flip the switch, money is fine."
 *
 * Nothing here is asserted from a comment. The claimer is played by a loop that takes the parked
 * run and answers it (or says the plan is out of usage), the vendors are stubs that record which
 * model was asked for, and the lever is a real `budget_policy` row. Each case says what it proves
 * and what it would have looked like if the property did not hold.
 *
 * WHAT THIS DOES NOT PROVE: that the live CLIs print the sentences `detectUsageLimit` reads, that
 * the free lanes are good enough at the brief's job, or that OpenRouter's no-training constraint
 * still holds. Those need a real Mac and real vendors; the ledger labels them UNPROVEN.
 */

let t: TestDb;

const MP_ACTOR: Actor = {
  type: "HUMAN",
  firmUserId: "fu_scooter_taylor",
  roles: ["MANAGING_PARTNER"],
  firmScopes: ["west-peek"],
};

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

const awake = (seat: Seat): Promise<void> => recordHeartbeat(env(), { seat, deviceId: "mac-test", hostname: "her-mac" });

interface Vendor {
  fetchImpl: typeof fetch;
  /** Every model asked for, in order. */
  models: string[];
  hosts: string[];
}

/**
 * A vendor stub keyed by the MODEL in the request body. `free429` makes every `:free` lane and
 * Gemini's free tier answer 429 (the quota-exhausted shape); `freeText`/`paidText` are what each
 * side says, so a test can tell who answered from the text alone.
 */
function vendors(opts: { free429?: boolean; freeText?: string; paidText?: string } = {}): Vendor {
  const models: string[] = [];
  const hosts: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url);
    hosts.push(url.host);
    let model = "";
    try {
      model = String((JSON.parse(String(init?.body ?? "{}")) as { model?: string }).model ?? "");
    } catch {
      /* not JSON */
    }
    if (!model && url.host.includes("generativelanguage")) model = "gemini-free";
    models.push(model);
    const isFree = model.endsWith(":free") || model === "gemini-free";
    if (isFree && opts.free429) return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
    const text = isFree ? (opts.freeText ?? "FREE LANE ANSWER") : (opts.paidText ?? "PAID LANE ANSWER");
    if (url.host.includes("generativelanguage")) {
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ model, choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, models, hosts };
}

/**
 * PLAY THE CLAIMER. Takes every run parked for the given seats and answers it: with `answer`, or —
 * for the seats in `outOfUsage` — with the failure report the real claimer sends when a CLI says
 * its plan is spent (which also marks the seat exhausted, exactly as the report route does).
 */
function claimer(seats: Seat[], opts: { answer?: string; outOfUsage?: Seat[] } = {}): { stop: () => Promise<void>; handled: SeatRunRow[] } {
  const handled: SeatRunRow[] = [];
  let live = true;
  const loop = (async () => {
    while (live) {
      const run = await claimRun(env(), "mac-test", seats);
      if (!run) {
        await new Promise((r) => setTimeout(r, 20));
        continue;
      }
      handled.push(run);
      if (isSeat(run.seat) && opts.outOfUsage?.includes(run.seat)) {
        await reportRun(env(), { runId: run.id, deviceId: "mac-test", error: `${run.seat} has run out of usage and said: usage limit reached` });
        await markSeatExhausted(env(), { seat: run.seat, deviceId: "mac-test", retryAfterSeconds: 3600, reason: "usage limit reached" });
      } else {
        await reportRun(env(), { runId: run.id, deviceId: "mac-test", outputText: opts.answer ?? `SEAT ANSWER (${run.seat})` });
      }
    }
  })();
  return {
    handled,
    stop: async () => {
      live = false;
      await loop;
    },
  };
}

const call = (overrides: Partial<RunAiInput> & { budgetContext?: RunAiInput["budgetContext"] }): RunAiInput => ({
  purpose: "ladder test",
  actor: MP_ACTOR,
  inputs: ["Write a careful answer."],
  sensitivity: "PUBLIC" as never,
  budgetContext: { judgement: true, expectedOutputTokens: 200 },
  routing: { category: "INTELLIGENCE" as const },
  ...overrides,
});

/** Card work, the brief, University, the market map — public content the owner named to lead on the seats. */
const SEAT_FIRST_PUBLIC = call({ budgetContext: { judgement: true, seatFirst: true, expectedOutputTokens: 200 }, routing: { category: "INTELLIGENCE" as const, taskClass: "university" } });
/** The same public judgement work, NOT named — what a blog help or a room packet is. */
const PLAIN_PUBLIC = call({ routing: { category: "INTELLIGENCE" as const, taskClass: "blog-help" } });
/** LP names, deal terms — private, so free lanes can never see it. */
const PRIVATE = call({
  sensitivity: "INTERNAL" as never,
  budgetContext: { judgement: true, confidential: true, expectedOutputTokens: 200 },
  routing: { category: "OPERATIONS" as const, taskClass: "employee-work" },
});
/** The brief's shape: pinned to Sonnet, allowed to degrade, seat-first, judged by its own verifier. */
const BRIEF = (extra: { degradeAllowed?: boolean } = {}) =>
  call({
    verify: (text: string) => (text.length >= 20 ? null : "too short to be a brief"),
    budgetContext: {
      judgement: true,
      seatFirst: true,
      requireModel: BRIEF_USUAL_MODEL,
      ...(extra.degradeAllowed === false ? {} : { degradeAllowed: true }),
      expectedOutputTokens: 200,
    },
    routing: { category: "INTELLIGENCE" as const, taskClass: "daily-intelligence" },
  });

async function attemptsOf(runId: string) {
  const row = await t.db
    .prepare("SELECT attempts_json, explanation, selected_provider_key FROM ai_run_routing WHERE ai_run_id = ?1")
    .bind(runId)
    .first<{ attempts_json: string; explanation: string; selected_provider_key: string }>();
  return { attempts: JSON.parse(row!.attempts_json) as Array<{ provider_key: string; model: string; outcome: string }>, explanation: row!.explanation, selected: row!.selected_provider_key };
}

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await disposeTestDb(t);
});
beforeEach(async () => {
  // A case starts with both seats away and nothing parked: state left behind by one case must not decide the next.
  await t.db.prepare("DELETE FROM subscription_seat_device").run();
  await t.db.prepare("DELETE FROM subscription_seat_run").run();
  await t.db.prepare("DELETE FROM provider_lane_health").run();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
describe("MODERATE — the ladder as the owner drew it", () => {
  beforeEach(() => setLever("MODERATE"));

  it("public work she named leads on Claude Code, spends nothing, and calls no vendor", async () => {
    await awake("claude_code");
    await awake("codex");
    const c = claimer(["claude_code", "codex"]);
    const v = vendors();
    const { run } = await runAi(env(), SEAT_FIRST_PUBLIC, { fetchImpl: v.fetchImpl });
    await c.stop();
    expect(run.status).toBe("COMPLETED");
    expect(run.output_text).toContain("SEAT ANSWER (claude_code)");
    expect(c.handled.map((r) => r.seat)).toEqual(["claude_code"]);
    expect(v.models, "no vendor was asked").toEqual([]);
  }, 60_000);

  it("hands on to Codex when Claude Code is out of usage, in the same run, and never asks Claude Code twice", async () => {
    await awake("claude_code");
    await awake("codex");
    const c = claimer(["claude_code", "codex"], { outOfUsage: ["claude_code"] });
    const v = vendors();
    const { run } = await runAi(env(), SEAT_FIRST_PUBLIC, { fetchImpl: v.fetchImpl });
    await c.stop();
    expect(run.status).toBe("COMPLETED");
    expect(run.output_text).toContain("SEAT ANSWER (codex)");
    expect(c.handled.map((r) => r.seat)).toEqual(["claude_code", "codex"]);
    expect(v.models).toEqual([]);
    // And the next call does not even try the seat that said its plan is spent.
    const seats = await allSeatAvailability(env());
    expect(seats.find((s) => s.seat === "claude_code")?.available).toBe(false);
    expect(seats.find((s) => s.seat === "codex")?.available).toBe(true);
  }, 90_000);

  it("reaches the FREE lanes only after both seats, and calls no paid model", async () => {
    await awake("claude_code");
    await awake("codex");
    await markSeatExhausted(env(), { seat: "claude_code", deviceId: "mac-test", retryAfterSeconds: 3600 });
    await markSeatExhausted(env(), { seat: "codex", deviceId: "mac-test", retryAfterSeconds: 3600 });
    const v = vendors();
    const { run } = await runAi(env(), SEAT_FIRST_PUBLIC, { fetchImpl: v.fetchImpl });
    expect(run.status).toBe("COMPLETED");
    expect(run.output_text).toContain("FREE LANE ANSWER");
    expect(v.models.length).toBeGreaterThan(0);
    expect(v.models.every((m) => m.endsWith(":free") || m === "gemini-free"), `only free models were asked: ${v.models.join(", ")}`).toBe(true);
    const parked = await t.db.prepare("SELECT COUNT(*) AS n FROM subscription_seat_run").first<{ n: number }>();
    expect(parked?.n, "nothing was parked on a seat that is out of usage").toBe(0);
  }, 60_000);

  it("falls to paid Sonnet only when the seats AND every free lane have failed, and records the walk", async () => {
    const v = vendors({ free429: true });
    const { run } = await runAi(env(), SEAT_FIRST_PUBLIC, { fetchImpl: v.fetchImpl });
    expect(run.status).toBe("COMPLETED");
    expect(run.output_text).toContain("PAID LANE ANSWER");
    const { attempts } = await attemptsOf(run.id);
    const last = attempts[attempts.length - 1]!;
    expect(last.model).toBe("anthropic/claude-sonnet-5");
    expect(last.outcome).toBe("COMPLETED");
    expect(attempts.slice(0, -1).every((a) => a.outcome !== "COMPLETED")).toBe(true);
    expect(v.models.findIndex((m) => m === "anthropic/claude-sonnet-5"), "Sonnet came after the free lanes, not before").toBeGreaterThan(0);
  }, 60_000);

  it("does NOT spend her seat on public work she did not name: a plain public call stays free-first", async () => {
    await awake("claude_code");
    await awake("codex");
    const v = vendors();
    const { run } = await runAi(env(), PLAIN_PUBLIC, { fetchImpl: v.fetchImpl });
    expect(run.status).toBe("COMPLETED");
    expect(run.output_text).toContain("FREE LANE ANSWER");
    const parked = await t.db.prepare("SELECT COUNT(*) AS n FROM subscription_seat_run").first<{ n: number }>();
    expect(parked?.n).toBe(0);
  }, 60_000);

  it("private work still leads on the seats and still never touches a free lane", async () => {
    await awake("claude_code");
    const c = claimer(["claude_code"]);
    const v = vendors();
    const { run } = await runAi(env(), PRIVATE, { fetchImpl: v.fetchImpl });
    await c.stop();
    expect(run.output_text).toContain("SEAT ANSWER (claude_code)");
    expect(v.models.some((m) => m.endsWith(":free"))).toBe(false);
  }, 60_000);

  it("private work with both seats gone goes to PAID Claude, never to a free lane", async () => {
    const v = vendors();
    const { run } = await runAi(env(), PRIVATE, { fetchImpl: v.fetchImpl });
    expect(run.status).toBe("COMPLETED");
    expect(v.models[0]).toBe("anthropic/claude-sonnet-5");
    expect(v.models.some((m) => m.endsWith(":free") || m === "gemini-free"), "no free lane saw private work").toBe(false);
  }, 60_000);

  it("the brief: seats first, then a free lane whose reply the brief's own verifier accepts, then Sonnet", async () => {
    // Free lane says something too short for the verifier → refused → the walk reaches Sonnet.
    const v = vendors({ freeText: "short", paidText: "A real brief that is long enough to pass the verifier." });
    const { run } = await runAi(env(), BRIEF(), { fetchImpl: v.fetchImpl });
    expect(run.status).toBe("COMPLETED");
    expect(run.output_text).toContain("A real brief");
    const { attempts } = await attemptsOf(run.id);
    expect(attempts.some((a) => a.model.endsWith(":free") && a.outcome !== "COMPLETED"), "a rejected free reply is a failed attempt, not an answer").toBe(true);
    expect(attempts[attempts.length - 1]!.model).toBe("anthropic/claude-sonnet-5");
  }, 90_000);

  it("a free lane that writes an acceptable brief is accepted — and briefServing marks it as a weaker model", async () => {
    const v = vendors({ freeText: "A free-lane brief that is long enough to pass the verifier." });
    const { run } = await runAi(env(), BRIEF(), { fetchImpl: v.fetchImpl });
    expect(run.status).toBe("COMPLETED");
    const served = briefServing((run as unknown as { model?: string }).model);
    expect(served.degraded).toBe(true);
    expect(served.note).toContain("not by Claude");
  }, 60_000);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
describe("OPEN — the switch for 'I need good work right now'", () => {
  beforeEach(() => setLever("OPEN"));

  it("skips the free lanes for named work: seats away → Sonnet is the first model asked", async () => {
    const v = vendors();
    const { run } = await runAi(env(), SEAT_FIRST_PUBLIC, { fetchImpl: v.fetchImpl });
    expect(run.status).toBe("COMPLETED");
    expect(v.models[0]).toBe("anthropic/claude-sonnet-5");
    expect(v.models.some((m) => m.endsWith(":free") || m === "gemini-free")).toBe(false);
  }, 60_000);

  it("still leads on the seats when one is awake — the subscription is free even when money is fine", async () => {
    await awake("claude_code");
    const c = claimer(["claude_code"]);
    const v = vendors();
    const { run } = await runAi(env(), SEAT_FIRST_PUBLIC, { fetchImpl: v.fetchImpl });
    await c.stop();
    expect(run.output_text).toContain("SEAT ANSWER (claude_code)");
    expect(v.models).toEqual([]);
  }, 60_000);

  it("the brief goes seats → Sonnet, with no free lane in between", async () => {
    const v = vendors({ paidText: "A real brief that is long enough to pass the verifier." });
    const { run } = await runAi(env(), BRIEF(), { fetchImpl: v.fetchImpl });
    expect(run.status).toBe("COMPLETED");
    expect(v.models[0]).toBe("anthropic/claude-sonnet-5");
    expect(briefServing((run as unknown as { model?: string }).model).degraded).toBe(false);
  }, 60_000);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
describe("FREE ONLY — the $0 posture: her seats, then free lanes, and nothing that costs money", () => {
  beforeEach(() => setLever("FREE_ONLY"));

  it("private work runs on her seat — a seat counts as a $0 lane — and calls no vendor", async () => {
    await awake("claude_code");
    const c = claimer(["claude_code"]);
    const v = vendors();
    const { run } = await runAi(env(), PRIVATE, { fetchImpl: v.fetchImpl });
    await c.stop();
    expect(run.status).toBe("COMPLETED");
    expect(run.output_text).toContain("SEAT ANSWER (claude_code)");
    expect(v.models).toEqual([]);
  }, 60_000);

  it("private work with both seats gone STOPS with a sentence naming the lever, and calls nothing", async () => {
    const v = vendors();
    const { run } = await runAi(env(), PRIVATE, { fetchImpl: v.fetchImpl });
    expect(run.status).not.toBe("COMPLETED");
    expect(run.failure_reason ?? "").toContain("FREE_ONLY");
    expect(run.failure_reason ?? "").toMatch(/Free only|FREE_ONLY/);
    expect(v.models, "not a paid model, and not a free one that trains").toEqual([]);
  }, 60_000);

  it("a pinned class (University) runs on the best $0 lane instead of stopping, and says it is weaker than the pin", async () => {
    const v = vendors();
    const { run } = await runAi(env(), SEAT_FIRST_PUBLIC, { fetchImpl: v.fetchImpl });
    expect(run.status).toBe("COMPLETED");
    expect(run.output_text).toContain("FREE LANE ANSWER");
    expect(v.models.every((m) => m.endsWith(":free") || m === "gemini-free")).toBe(true);
    const { explanation } = await attemptsOf(run.id);
    expect(explanation).toContain("Free only");
    expect(explanation).toContain("weaker lane than the pin");
  }, 60_000);

  it("a pinned class leads on a seat when one is awake", async () => {
    await awake("codex");
    const c = claimer(["codex"]);
    const v = vendors();
    const { run } = await runAi(env(), SEAT_FIRST_PUBLIC, { fetchImpl: v.fetchImpl });
    await c.stop();
    expect(run.output_text).toContain("SEAT ANSWER (codex)");
    expect(v.models).toEqual([]);
  }, 60_000);

  it("the brief runs on a free lane that passes its verifier, instead of stopping, and the explanation says so", async () => {
    const v = vendors({ freeText: "A free-lane brief that is long enough to pass the verifier." });
    const { run } = await runAi(env(), BRIEF(), { fetchImpl: v.fetchImpl });
    expect(run.status).toBe("COMPLETED");
    expect(v.models.every((m) => m.endsWith(":free") || m === "gemini-free")).toBe(true);
    const { explanation } = await attemptsOf(run.id);
    expect(explanation).toContain("allowed to run on the best free lane");
    expect(briefServing((run as unknown as { model?: string }).model).degraded).toBe(true);
  }, 60_000);

  it("the NEGATIVE PROOF: a pinned call that did NOT say degradeAllowed still stops, exactly as before", async () => {
    const v = vendors();
    const { run } = await runAi(env(), BRIEF({ degradeAllowed: false }), { fetchImpl: v.fetchImpl });
    expect(run.status).not.toBe("COMPLETED");
    expect(run.failure_reason ?? "").toContain("required_model_unavailable");
    expect(v.models).toEqual([]);
  }, 60_000);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
describe("briefServing — who wrote it, in words", () => {
  it("marks only a model nobody has decided is good enough at the brief's job", () => {
    expect(briefServing("anthropic/claude-sonnet-5")).toMatchObject({ kind: "USUAL", degraded: false, note: null });
    expect(briefServing("claude-sonnet-5")).toMatchObject({ kind: "USUAL", degraded: false });
    expect(briefServing("claude-code-local")).toMatchObject({ kind: "SEAT", degraded: false, note: null });
    expect(briefServing("codex-local")).toMatchObject({ kind: "SEAT", degraded: false });
    expect(briefServing("nvidia/nemotron-3-ultra-550b-a55b:free")).toMatchObject({ kind: "DEGRADED", degraded: true });
    expect(briefServing("@cf/ibm-granite/granite-4.0-h-micro").degraded).toBe(true);
  });

  it("says nothing rather than guessing when the model is not recorded", () => {
    for (const m of [null, undefined, "", "  "]) expect(briefServing(m)).toMatchObject({ kind: "UNKNOWN", degraded: false, label: null, note: null });
  });

  it("the note names the model and what to do about it", () => {
    const n = briefServing("deepseek/deepseek-v4-flash-0731:free").note!;
    expect(n).toContain("deepseek/deepseek-v4-flash-0731:free");
    expect(n).toContain("weaker draft");
    expect(n).toContain("Build again");
  });
});

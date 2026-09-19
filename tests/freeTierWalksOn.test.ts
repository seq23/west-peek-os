import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { runAi } from "../src/worker/ai/runAi";
import { MAX_ATTEMPT_MS, attemptDeadlineMs, wireOutputCeiling } from "../src/worker/ai/chainBudget";
import { isUnservedReply, outageKind } from "../src/shared/ai/providerFailure";
import { finishReasonFrom } from "../src/worker/ai/providers/finishReason";

/**
 * WHY THE FREE TIERS WERE FAILING — fixed at the router, for every lane (19 Sep 2026).
 *
 * The owner: "fix why the free tiers are failing!" What production showed on 18–19 Sep:
 *
 *   (a) twelve brief replies from a free lane at exactly 256 output tokens, each recorded COMPLETED,
 *       each refused by the brief's verifier, none walked to Sonnet standing behind the free lanes;
 *   (b) the 256 came from a platform default applied when no cap was sent — PR #100 sent the cap,
 *       and this file pins that the cap on the wire is the caller's ask, widened, never a default;
 *   (c) a verifier rejection was the caller's business: it asked the SAME lane again, twice;
 *   (d) one free-lane call still RUNNING fifteen minutes after it started.
 *
 * Every case below drives `runAi` with a fake wire that plays a free lane and a paid one, and proves
 * the walk moves on to the paid lane — and that the attempt record says why, in one word.
 */

let t: TestDb;
const MP_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const GOOD = "===SECTION executive_summary\nA fine paragraph [1].\n===END";

function reply(text: string, over: { finish_reason?: string | null; completion_tokens?: number } = {}): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: text }, ...(over.finish_reason !== undefined ? { finish_reason: over.finish_reason } : {}) }],
      usage: { prompt_tokens: 10, completion_tokens: over.completion_tokens ?? 20 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** The same reply in each vendor's own shape, so a walk that reaches Gemini or Anthropic direct is answered, not stubbed out. */
function shaped(host: string, text: string, over: { finish_reason?: string | null; completion_tokens?: number } = {}): Response {
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  if (host.includes("googleapis")) {
    return json({ candidates: [{ content: { parts: [{ text }] }, finishReason: over.finish_reason === "length" ? "MAX_TOKENS" : "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: over.completion_tokens ?? 20 } });
  }
  if (host.includes("anthropic")) {
    return json({ model: "claude-sonnet-5", content: [{ type: "text", text }], stop_reason: over.finish_reason === "length" ? "max_tokens" : "end_turn", usage: { input_tokens: 10, output_tokens: over.completion_tokens ?? 20 } });
  }
  return reply(text, over);
}

/** A wire that answers by LANE: free lanes one way, paid lanes another, whatever the vendor. */
function wire(
  onFree: (init: RequestInit, host: string) => Response | Promise<Response>,
  onPaid: (init: RequestInit, host: string) => Response = (_, host) => shaped(host, GOOD),
) {
  const models: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const host = new URL(url).host;
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    // Gemini's model is in the URL; its unpaid quota is the google_free lane.
    const model = body.model ?? (host.includes("googleapis") ? "google/gemini:free-quota" : host.includes("anthropic") ? "anthropic/claude-sonnet-5" : "?");
    models.push(model);
    const free = model.includes(":free");
    return free ? onFree(init ?? {}, host) : onPaid(init ?? {}, host);
  }) as unknown as typeof fetch;
  return { fetchImpl, models };
}

function env(): Env {
  return makeTestEnv(t.db, { OPENROUTER_API_KEY: "or-key", GEMINI_API_KEY: "gem-key", WP_ANTHROPIC_API_KEY: "ant-key" });
}

async function routingFor(runId: string) {
  const row = await t.db
    .prepare("SELECT attempts_json, fallback_used, explanation FROM ai_run_routing WHERE ai_run_id = ?1")
    .bind(runId)
    .first<{ attempts_json: string; fallback_used: number; explanation: string }>();
  return { ...row!, attempts: JSON.parse(row!.attempts_json) as Array<{ provider_key: string; model: string; outcome: string; detail?: string }> };
}

const judgement = (extra: Record<string, unknown> = {}) => ({
  purpose: "Parker: Workshop research judgement",
  actor: MP_ACTOR,
  inputs: ["write the angles"],
  sensitivity: "PUBLIC" as const,
  budgetContext: { judgement: true, expectedOutputTokens: 2_000 },
  ...extra,
});

beforeAll(async () => {
  t = await createTestDb();
  // CAUTIOUS posture: free-first is on for public judgement work, exactly as production was.
  await t.db
    .prepare(
      `INSERT INTO budget_policy (id, firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, honours_pins, prefers_frontier, set_by)
       VALUES ('bp_free_walk', 'west-peek', 'CHEAPO', 'FRONTIER', 2.5, 0.75, 1, 0, 'fu_sequoia_taylor')`,
    )
    .run();
});
afterAll(async () => {
  await disposeTestDb(t);
});

describe("(a) a reply that stopped at its cap is not a completion", () => {
  it("the vendor says length → the free attempt is TRUNCATED and the walk moves on to the paid lane", async () => {
    const w = wire((_, host) => shaped(host, "The Fed held ra", { finish_reason: "length", completion_tokens: 256 }));
    const { run } = await runAi(env(), judgement(), { fetchImpl: w.fetchImpl });
    expect(run.status).toBe("COMPLETED");
    expect(run.output_text).toBe(GOOD);
    const r = await routingFor(run.id);
    expect(r.fallback_used).toBe(1);
    const first = r.attempts[0]!;
    expect(first.model).toContain(":free");
    expect(first.outcome).toBe("FAILED_OVER");
    expect(first.detail).toMatch(/^TRUNCATED: truncated_reply:the lane stopped at its output cap \(256 tokens of \d+ allowed\)/);
    expect(r.attempts.at(-1)!.outcome).toBe("COMPLETED");
    expect(r.attempts.at(-1)!.model).not.toContain(":free");
    expect(w.models.some((m) => !m.includes(":free")), "the paid lane was never asked").toBe(true);
  });

  it("the vendor says nothing but the tokens used reached the cap that was sent → the same", async () => {
    const cap = wireOutputCeiling(2_000);
    const w = wire((_, host) => shaped(host, "cut off mid", { completion_tokens: cap }));
    const { run } = await runAi(env(), judgement(), { fetchImpl: w.fetchImpl });
    expect(run.status).toBe("COMPLETED");
    const r = await routingFor(run.id);
    expect(r.attempts[0]!.outcome).toBe("FAILED_OVER");
    expect(r.attempts[0]!.detail).toMatch(new RegExp(`\\(${cap} tokens of ${cap} allowed\\)`));
  });

  it("a truncated reply is NOT an outage: no back-off is armed against the lane, it is simply not this reply", async () => {
    const w = wire((_, host) => shaped(host, "short", { finish_reason: "length", completion_tokens: 256 }));
    const { run } = await runAi(env(), judgement(), { fetchImpl: w.fetchImpl });
    const health = await t.db.prepare("SELECT COUNT(*) n FROM provider_lane_health WHERE model LIKE '%:free' AND cooldown_until IS NOT NULL AND cooldown_until > ?1").bind(new Date().toISOString()).first<{ n: number }>();
    expect(health?.n ?? 0, "a healthy lane that wrote a short answer was put in back-off").toBe(0);
    expect(run.status).toBe("COMPLETED");
  });

  it("every vendor's word for the cap maps to one word", () => {
    for (const v of ["length", "max_tokens", "MAX_TOKENS", "max_output_tokens"]) expect(finishReasonFrom(v)).toBe("length");
    for (const v of ["stop", "end_turn", "stop_sequence", "STOP"]) expect(finishReasonFrom(v)).toBe("stop");
    expect(finishReasonFrom("content_filter")).toBe("other");
    expect(finishReasonFrom(undefined)).toBeUndefined();
    expect(isUnservedReply("truncated_reply:x")).toBe(true);
    expect(isUnservedReply("verifier_rejected:x")).toBe(true);
    expect(isUnservedReply("provider_http_500:x")).toBe(false);
    expect(outageKind("truncated_reply:x")).toBe("TRUNCATED");
    expect(outageKind("verifier_rejected:x")).toBe("VERIFIER_REJECTED");
  });
});

describe("(b) the cap on the wire is the caller's ask, widened — never a platform default", () => {
  it("the free lane is sent max_tokens derived from expectedOutputTokens, well above 256", async () => {
    let sent: number | undefined;
    const w = wire((init, host) => { if (host.includes("openrouter")) sent = (JSON.parse(String(init.body)) as { max_tokens?: number }).max_tokens; return shaped(host, GOOD); });
    const { run } = await runAi(env(), judgement({ budgetContext: { judgement: true, expectedOutputTokens: 24_000 } }), { fetchImpl: w.fetchImpl });
    expect(run.status).toBe("COMPLETED");
    expect(sent).toBe(wireOutputCeiling(24_000));
    expect(sent!).toBeGreaterThan(256);
    expect(sent!).toBeGreaterThanOrEqual(24_000);
  });
});

describe("(c) a verifier rejection is a failed attempt for the ladder", () => {
  it("the free lane's prose is refused by the caller's verifier → the walk moves on and the paid lane's reply is verified too", async () => {
    let verified = 0;
    const w = wire((_, host) => shaped(host, "Here is a friendly summary of the news."));
    const { run } = await runAi(
      env(),
      judgement({ verify: (text: string) => { verified += 1; return text.includes("===SECTION") ? null : "the reply was not in the ===SECTION format"; } }),
      { fetchImpl: w.fetchImpl },
    );
    expect(run.status).toBe("COMPLETED");
    expect(run.output_text).toBe(GOOD);
    const r = await routingFor(run.id);
    expect(verified, "every reply that reached the router was verified, and only those").toBe(w.models.length);
    expect(r.attempts[0]!.outcome).toBe("FAILED_OVER");
    expect(r.attempts[0]!.detail).toBe("VERIFIER_REJECTED: verifier_rejected:the reply was not in the ===SECTION format");
    expect(r.attempts.at(-1)!.outcome).toBe("COMPLETED");
  });

  it("with one pinned lane and a rejected reply the run STOPS with the verifier's reason — it never quietly accepts", async () => {
    const w = wire((_, host) => shaped(host, "unused"), (_, host) => shaped(host, "prose from Sonnet"));
    const { run } = await runAi(
      env(),
      judgement({ budgetContext: { judgement: true, requireModel: "anthropic/claude-sonnet-5" }, verify: () => "the markets_macro section is missing" }),
      { fetchImpl: w.fetchImpl },
    );
    expect(run.status).toBe("BLOCKED_DEFERRED");
    expect(run.failure_reason).toMatch(/verifier_rejected:the markets_macro section is missing/);
    // The pinned model at OpenRouter, then the SAME model at its own vendor (Anthropic names it
    // without the vendor prefix), then nothing else — never another model.
    expect(w.models.every((m) => m === "anthropic/claude-sonnet-5" || m === "claude-sonnet-5"), `another model was asked: ${w.models.join(", ")}`).toBe(true);
    expect(w.models.length).toBeGreaterThanOrEqual(1);
  });
});

describe("(d) a rung that never answers is abandoned on its deadline and the walk moves on", () => {
  it("the free lane hangs → aborted at the attempt deadline → TIMEOUT hand-over → the paid lane answers", async () => {
    const w = wire(
      (init) =>
        new Promise<Response>((_, reject) => {
          const signal = init.signal as AbortSignal | undefined;
          if (!signal) reject(new Error("the adapter sent no abort signal — a hung lane could never be abandoned"));
          else signal.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
        }),
    );
    const started = Date.now();
    const { run } = await runAi(env(), judgement(), { fetchImpl: w.fetchImpl, attemptDeadlineMsForTests: 150 });
    expect(run.status).toBe("COMPLETED");
    expect(Date.now() - started).toBeLessThan(10_000);
    const r = await routingFor(run.id);
    expect(r.attempts[0]!.model).toContain(":free");
    expect(r.attempts[0]!.outcome).toBe("FAILED_OVER");
    expect(r.attempts[0]!.detail).toMatch(/^TIMEOUT_OR_NETWORK/);
    expect(r.attempts.at(-1)!.outcome).toBe("COMPLETED");
  });

  it("in production that deadline is the chain's: 450 seconds for the brief's ask, and never more", () => {
    expect(MAX_ATTEMPT_MS).toBe(450_000);
    expect(attemptDeadlineMs(24_000)).toBe(450_000);
    expect(attemptDeadlineMs(24_000, 100_000)).toBe(100_000);
  });
});

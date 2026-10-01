import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { cardTimeline, laneWords, whyItEnded, type TimelineSteps } from "../src/shared/work/cardTimeline";
import { handleGetWorkCardSteps } from "../src/worker/services/requestMessage";
import { createWorkCardInternal } from "../src/worker/services/workCards";
import { sweepIdentity, sweepOnce } from "../src/worker/services/workSweep";
import { runAi } from "../src/worker/ai/runAi";

/**
 * "THE TIMESTAMPS DON'T SHOW ANY OF THE RETRIES OR ANYTHING" (owner, 1 Oct 2026, reading a Workshop packet card that had finished
 * its angles stage, been retried by hand and was waiting between stages). The card's "What has happened" listed emails and notices,
 * so a card could finish a stage, fail and retry with no trace. It now lists, with times: each stage the sweep finished, each try
 * that did not finish and why, each model call attributed to the card and which lane answered, and being re-queued or waiting.
 */

let t: TestDb;
let env: Env;

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});
afterAll(async () => {
  await disposeTestDb(t);
});

const STEPS: TimelineSteps = {
  ticks: [
    { at: "2026-10-01T16:50:00Z", outcome: "PROGRESSED", attempt: 1, detail: 'topic "Community" (the partners\'); chose the angle "Community as a Service"' },
    { at: "2026-10-01T16:55:00Z", outcome: "FAILED", attempt: 2, detail: "free_only_cannot_serve_protected_work:this call is marked 'judgement' and needs a paid model" },
  ],
  runs: [
    { at: "2026-10-01T16:49:00Z", purpose: "Workshop packet: one topic, three angles", model: "codex-local", provider: "codex", provider_name: "Codex CLI", status: "COMPLETED", failure: null, degraded: false },
    { at: "2026-10-01T16:54:00Z", purpose: "Workshop packet proposal", model: null, provider: null, provider_name: null, status: "PREFLIGHT_BLOCKED", failure: "free_only_cannot_serve_protected_work:x", degraded: false },
    { at: "2026-10-01T16:56:00Z", purpose: "Workshop packet proposal", model: "nvidia/nemotron-3-ultra-550b-a55b:free", provider: "openrouter_free", provider_name: "OpenRouter (free tier)", status: "COMPLETED", failure: null, degraded: true },
  ],
  events: [{ at: "2026-10-01T16:57:00Z", kind: "auto_released", detail: null }],
};
const base = { created_at: "2026-10-01T16:00:00Z", owner_name: "Parker", asked_by: "You", trail: [] as never[] };

describe("the timeline, as sentences", () => {
  it("lists every stage, every try with its reason, every call with the lane that answered, and the re-queue — in time order", () => {
    const e = cardTimeline({ ...base, steps: STEPS });
    const text = e.map((x) => x.text);
    expect(text.some((x) => /Finished a step: topic "Community"/.test(x))).toBe(true);
    expect(text.some((x) => /Try 2 did not finish — the spend setting is on Free only and nothing at \$0 could take it\. It tries again on its own\./.test(x))).toBe(true);
    expect(text.some((x) => /^Codex on your plan answered: Workshop packet: one topic, three angles\.$/.test(x))).toBe(true);
    expect(text.some((x) => /Workshop packet proposal was not answered — the spend setting is on Free only/.test(x))).toBe(true);
    expect(text.some((x) => /answered: Workshop packet proposal\. A free model that may be weaker than your seats wrote it\./.test(x))).toBe(true);
    expect(text.some((x) => /Put back in the queue automatically/.test(x))).toBe(true);
    const times = e.map((x) => x.at);
    expect(times).toEqual([...times].sort());
  });

  it("with no step record the timeline reads exactly as before, last failure line included", () => {
    const withLast = cardTimeline({ ...base, last_failure: "Attempt 1 of 3 did not get anywhere.", last_failure_at: "2026-10-01T16:30:00Z" });
    expect(withLast.some((x) => /First try stalled on our side/.test(x.text))).toBe(true);
    const withSteps = cardTimeline({ ...base, last_failure: "Attempt 1 of 3 did not get anywhere.", last_failure_at: "2026-10-01T16:30:00Z", steps: { ticks: [], runs: [], events: [] } });
    expect(withSteps.some((x) => /stalled on our side/.test(x.text)), "the single last-failure line is replaced by the full list, never repeated").toBe(false);
  });

  it("names the lane in a partner's words and the reason without a code", () => {
    expect(laneWords("codex-local", "codex", "Codex CLI")).toBe("Codex on your plan");
    expect(laneWords("claude-code-local", "claude_code", null)).toBe("Claude Code on your plan");
    expect(laneWords("x/y:free", "openrouter_free", "OpenRouter (free tier)")).toBe("OpenRouter (free tier)");
    expect(whyItEnded("provider_http_402:insufficient credit")).toMatch(/out of credit/);
    expect(whyItEnded("provider_timeout")).toMatch(/did not answer in time/);
    expect(whyItEnded("subscription_seat_unavailable:the Codex seat checked in 9 hours ago")).toMatch(/asleep or out of usage/);
    expect(whyItEnded("")).toBe("it did not say why");
  });
});

describe("the steps endpoint and the sweep's own record", () => {
  it("a worked card leaves a PROGRESSED / FAILED record per tick, and the endpoint returns it with the card's model calls", async () => {
    const card = await createWorkCardInternal(env, sweepIdentity(), { title: "Parker: a card with steps", description: "x", owner_type: "AI", owner_id: "aie_parker", firm_scope: "west-peek" });
    await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id = 'aie_parker'").run();
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id != ?1 AND state IN ('OPEN','IN_PROGRESS')").bind(card.id).run();
    const when = new Date("2026-10-01T17:00:00.000Z");
    // A tick that makes progress, then one that fails — through the real sweep, with runners that say so.
    let n = 0;
    const runners = { general: (async () => { n += 1; return { finished: false, blocked: false, steps: n === 1 ? [{ step: 1, action: "searched", detail: "found three things" }] : [{ step: 1, action: "failed", detail: "provider_timeout" }], detail: "x" }; }) as never };
    const first = await sweepOnce(env, when, runners);
    expect(first.card?.id).toBe(card.id);
    await sweepOnce(env, new Date(when.getTime() + 10 * 60_000), runners);
    // a model call attributed to the card
    await runAi(env, { purpose: "Parker: a call on the card", actor: { type: "SYSTEM", roles: [], firmScopes: ["west-peek"] } as never, inputs: ["hi"], sensitivity: "PUBLIC" as never, budgetContext: { expectedOutputTokens: 50 }, routing: { category: "INTELLIGENCE" as const, workCardId: card.id } });

    const res = await handleGetWorkCardSteps({ env, request: new Request("https://os.test/x"), params: { id: card.id }, identity: { ...sweepIdentity(), id: "fu_sequoia_taylor", roles: ["MANAGING_PARTNER"] } } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TimelineSteps;
    expect(body.ticks.map((x) => x.outcome)).toContain("PROGRESSED");
    expect(body.ticks.map((x) => x.outcome)).toContain("FAILED");
    expect(body.ticks.every((x) => typeof x.at === "string" && x.at.length > 10)).toBe(true);
    expect(body.runs.some((r) => r.purpose === "Parker: a call on the card")).toBe(true);
    // chronological, oldest first, so the page can print it top to bottom
    expect(body.ticks.map((x) => x.at)).toEqual([...body.ticks.map((x) => x.at)].sort());
  }, 60_000);

  it("a card the caller cannot see has no steps to read (404), and an unauthenticated caller gets 401", async () => {
    const missing = await handleGetWorkCardSteps({ env, request: new Request("https://os.test/x"), params: { id: "wc_does_not_exist" }, identity: { ...sweepIdentity(), id: "fu_sequoia_taylor", roles: ["MANAGING_PARTNER"] } } as never);
    expect(missing.status).toBe(404);
    const anon = await handleGetWorkCardSteps({ env, request: new Request("https://os.test/x"), params: { id: "wc_x" }, identity: null } as never);
    expect(anon.status).toBe(401);
  });
});

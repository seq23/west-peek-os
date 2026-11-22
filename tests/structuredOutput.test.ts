import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { runAi } from "../src/worker/ai/runAi";
import { failedOnShape, jsonSchemaOf, readStructured, readStructuredText, structuredOutput } from "../src/worker/ai/structuredOutput";

/**
 * THE SHAPE OF AN ANSWER IS CHECKED AT THE ONE AI BOUNDARY (22 Nov 2026, engineering sweep row 6).
 * A caller hands `runAi` a schema; a reply in any other shape is a verifier rejection and the walk moves on; the run's
 * output_text is the checked JSON; the lanes whose API constrains decoding are sent the schema.
 */
let t: TestDb;
const MP_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const VERDICT = structuredOutput("verdict", z.object({ ok: z.boolean(), why: z.string() }));
const GOOD_JSON = '{"ok":true,"why":"fine"}';

function shaped(host: string, text: string): Response {
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  if (host.includes("googleapis")) return json({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } });
  if (host.includes("anthropic")) return json({ model: "claude-sonnet-5", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 20 } });
  return json({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20 } });
}

/** A wire that answers free lanes one way and paid lanes another, and keeps every request body by host. */
function wire(onFree: (host: string) => string, onPaid: (host: string) => string = () => GOOD_JSON) {
  const bodies: Array<{ host: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const host = new URL(url).host;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    bodies.push({ host, body });
    const model = (body.model as string | undefined) ?? (host.includes("googleapis") ? "google/gemini:free-quota" : "anthropic/claude-sonnet-5");
    return shaped(host, model.includes(":free") ? onFree(host) : onPaid(host));
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

const env = (): Env => makeTestEnv(t.db, { OPENROUTER_API_KEY: "or-key", GEMINI_API_KEY: "gem-key", WP_ANTHROPIC_API_KEY: "ant-key" });
const ask = (extra: Record<string, unknown> = {}) => ({
  purpose: "Parker: a structured verdict",
  actor: MP_ACTOR,
  inputs: ["is it fine?"],
  sensitivity: "PUBLIC" as const,
  output: VERDICT,
  budgetContext: { judgement: true, expectedOutputTokens: 500 },
  ...extra,
});
async function attempts(runId: string) {
  const row = await t.db.prepare("SELECT attempts_json FROM ai_run_routing WHERE ai_run_id = ?1").bind(runId).first<{ attempts_json: string }>();
  return JSON.parse(row!.attempts_json) as Array<{ outcome: string; detail?: string }>;
}

beforeEach(async () => {
  await t.db.prepare("DELETE FROM ai_run_routing").run();
});
beforeAll(async () => {
  t = await createTestDb();
  await t.db
    .prepare(
      `INSERT INTO budget_policy (id, firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, honours_pins, prefers_frontier, set_by)
       VALUES ('bp_shape', 'west-peek', 'CHEAPO', 'FRONTIER', 2.5, 0.75, 1, 0, 'fu_sequoia_taylor')`,
    )
    .run();
});
afterAll(async () => {
  await disposeTestDb(t);
});

describe("a reply in the wrong shape is a failed attempt for the ladder", () => {
  it("the free lane's prose label is refused → the walk moves on; the run keeps the checked JSON", async () => {
    const w = wire(() => "OK: yes\nWHY: fine");
    const { run } = await runAi(env(), ask(), { fetchImpl: w.fetchImpl });
    expect(run.status).toBe("COMPLETED");
    expect(run.output_text).toBe(GOOD_JSON);
    const a = await attempts(run.id);
    expect(a[0]!.outcome).toBe("FAILED_OVER");
    expect(a[0]!.detail).toMatch(/^VERIFIER_REJECTED: verifier_rejected:structured_output:the reply is not a JSON object/);
    expect(a.at(-1)!.outcome).toBe("COMPLETED");
  });

  it("JSON with a missing field is refused the same way, never read as a default", async () => {
    const w = wire(() => '{"ok":true}');
    const { run } = await runAi(env(), ask(), { fetchImpl: w.fetchImpl });
    expect(run.output_text).toBe(GOOD_JSON);
    expect((await attempts(run.id))[0]!.detail).toMatch(/structured_output:the reply does not match the verdict shape \(why:/);
  });

  it("a fenced, thinking reply is the JSON inside it; the caller's own verifier sees that canonical JSON", async () => {
    const seen: string[] = [];
    const w = wire(() => '<think>hmm</think>\n```json\n{"why":"fine","ok":true,"extra":1}\n```');
    const { run } = await runAi(env(), ask({ verify: (text: string) => { seen.push(text); return null; } }), { fetchImpl: w.fetchImpl });
    expect(run.status).toBe("COMPLETED");
    expect(seen[0]).toBe(GOOD_JSON);
    expect(run.output_text, "keys the schema does not know are dropped; the order is the schema's").toBe(GOOD_JSON);
  });

  it("outage: no lane answers in the shape → the run fails with the shape reason, never a COMPLETED guess", async () => {
    const w = wire(() => "sure!", () => "Yes, it is fine.");
    const { run } = await runAi(env(), ask(), { fetchImpl: w.fetchImpl });
    expect(run.status).not.toBe("COMPLETED");
    expect(failedOnShape(run.failure_reason), String(run.failure_reason)).toBe(true);
  });
});

describe("the lanes that constrain decoding are sent the schema", () => {
  it("Gemini gets responseJsonSchema and Anthropic gets output_config; every lane's prompt carries the schema", async () => {
    const w = wire(() => "prose", (host) => (host.includes("anthropic") ? GOOD_JSON : "prose"));
    await runAi(env(), ask({ budgetContext: { judgement: true, requireModel: "anthropic/claude-sonnet-5" } }), { fetchImpl: w.fetchImpl });
    const anthropic = w.bodies.find((b) => b.host.includes("anthropic"));
    expect(anthropic, w.bodies.map((b) => b.host).join(", ")).toBeTruthy();
    expect(anthropic!.body.output_config).toEqual({ format: { type: "json_schema", schema: jsonSchemaOf(VERDICT) } });
    expect(JSON.stringify(anthropic!.body.messages)).toContain("ANSWER FORMAT");

    // Every lane answers in prose, so the walk reaches each vendor's own API, Gemini's included.
    const g = wire(() => "prose", () => "prose");
    await runAi(env(), ask(), { fetchImpl: g.fetchImpl });
    const gemini = g.bodies.find((b) => b.host.includes("googleapis"));
    expect(gemini, g.bodies.map((b) => b.host).join(", ")).toBeTruthy();
    const config = gemini!.body.generationConfig as Record<string, unknown>;
    expect(config.responseMimeType).toBe("application/json");
    expect(config.responseJsonSchema).toEqual(jsonSchemaOf(VERDICT));
    for (const b of g.bodies.filter((x) => !x.host.includes("googleapis") && !x.host.includes("anthropic"))) {
      expect(b.body.output_config, "an OpenAI-compatible lane is never sent a field it may refuse").toBeUndefined();
      expect(JSON.stringify(b.body.messages)).toContain("ANSWER FORMAT");
    }
  });

  it("a call with no output is sent no schema at all", async () => {
    const w = wire(() => "plain", () => "plain");
    await runAi(env(), ask({ output: undefined, budgetContext: { judgement: true, requireModel: "anthropic/claude-sonnet-5" } }), { fetchImpl: w.fetchImpl });
    for (const b of w.bodies) {
      expect(b.body.output_config).toBeUndefined();
      expect(JSON.stringify(b.body)).not.toContain("ANSWER FORMAT");
    }
  });
});

describe("reading a reply", () => {
  it("never throws, and says why", () => {
    expect(readStructuredText(VERDICT, null)).toMatchObject({ ok: false });
    expect(readStructuredText(VERDICT, "{not json}")).toMatchObject({ ok: false, why: expect.stringContaining("not valid JSON") });
    expect(readStructured(VERDICT, '{"ok":"yes","why":"x"}'), "a string is not a boolean").toBeNull();
    expect(readStructured(VERDICT, 'Sure: {"ok":false,"why":"x"} done'), "prose around an object is a lane that ignored the format").toBeNull();
    expect(readStructured(VERDICT, '<think>hm</think>\n```json\n{"ok":false,"why":"x"}\n```'), "a think block and one fence are not the answer").toEqual({ ok: false, why: "x" });
  });
  it("the lanes are never sent bounds their decoders refuse, and the boundary still checks them", () => {
    const counted = structuredOutput("counted", z.object({ n: z.number().int().min(1), label: z.string().max(5) }));
    const sent = JSON.stringify(jsonSchemaOf(counted));
    expect(sent).not.toMatch(/minimum|maximum|maxLength/);
    expect(sent).toContain('"type":"integer"');
    expect(readStructured(counted, '{"n":0,"label":"ok"}'), "below the minimum").toBeNull();
    expect(readStructured(counted, '{"n":1.5,"label":"ok"}'), "not an integer").toBeNull();
    expect(readStructured(counted, '{"n":2,"label":"too long"}'), "over the length").toBeNull();
    expect(readStructured(counted, '{"n":2,"label":"ok"}')).toEqual({ n: 2, label: "ok" });
  });
  it("a shape name a lane would refuse is caught when the shape is made", () => {
    expect(() => structuredOutput("has space", z.object({}))).toThrow();
  });
});

describe("un-retire advice is read from its fields, never guessed from prose", () => {
  it("RE_POINT keeps its new role; any other verdict has none; an old prose answer is no advice", async () => {
    const { parseUnretireAdvice } = await import("../src/shared/workforce/unretireAdvice");
    expect(parseUnretireAdvice(JSON.stringify({ verdict: "RE_POINT", why: "Half the job is uncovered.", newRole: "Teaching Coach", watchFor: "overlap" }))).toEqual({ verdict: "RE_POINT", why: "Half the job is uncovered.", newRole: "Teaching Coach", watchFor: "overlap" });
    expect(parseUnretireAdvice(JSON.stringify({ verdict: "DECLINE", why: "Wren covers it.", newRole: "re-point to anything", watchFor: "" }))?.newRole).toBeNull();
    expect(parseUnretireAdvice("VERDICT: BRING_BACK\nWHY: sure\nWATCH FOR: x"), "a half-read recommendation is worse than none").toBeNull();
    expect(parseUnretireAdvice(JSON.stringify({ verdict: "MAYBE", why: "x", newRole: null, watchFor: "" }))).toBeNull();
  });
});

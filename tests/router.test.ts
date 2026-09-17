import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { runAi } from "../src/worker/ai/runAi";
import { periodStart, scopeApplies, type BudgetScopeRow } from "../src/worker/ai/routing";
import { createOpenRouterAdapter } from "../src/worker/ai/providers/openRouter";
import { createFireworksAdapter } from "../src/worker/ai/providers/fireworks";
import { createWorkersAiAdapter, type WorkersAiBinding } from "../src/worker/ai/providers/workersAi";

/**
 * P16 — Provider/model router + AI Cost Command Center (GAP-02, GAP-03).
 *
 * Rules under test:
 * - The catalogue reports credential PRESENCE, never a value, and states pricing provenance.
 * - A task class with NO routing policy behaves exactly as P4 did (cheapest capable, no fallback).
 * - A routing policy orders the candidates, the choice is EXPLAINED on the run record, and
 *   fallback is used only when the policy allows it — a fallback never hides the first failure.
 * - A machine model policy outranks the routing policy for runs attributed to that machine.
 * - Scoped budgets (employee/machine/provider/model/category) block a run by name and raise a
 *   deduped cost alert; the firmwide caps still apply first.
 * - The OpenRouter and Fireworks adapters fail CLOSED without a credential, before any network
 *   attempt, with a reason the operator can read.
 * - A LIVE evaluation must cite an ai_run that completed on the model being evaluated.
 * - Promotion to ACTIVE requires a recorded evaluation.
 * - A health check can only be LOCAL_FIXTURE here, and says so in its own detail text.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const MP_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };

function req(path: string, headers: Record<string, string> = {}, method = "GET", body?: unknown): Request {
  return new Request(`https://test.local${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call<T = any>(path: string, headers: Record<string, string>, method = "GET", body?: unknown): Promise<{ status: number; body: T }> {
  const res = await handleRequest(req(path, headers, method, body), env);
  return { status: res.status, body: (await res.json()) as T };
}

/** Put the firm on the FRONTIER path with generous firm caps, so scoped budgets are what bite. */
async function setFrontier(dailyCap = 100, perRunCap = 100): Promise<void> {
  await t.db
    .prepare(
      `INSERT INTO budget_policy (id, firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, set_by)
       VALUES (?1, 'west-peek', 'NORMAL', 'FRONTIER', ?2, ?3, 'fu_scooter_taylor')`,
    )
    .bind(`bp_${crypto.randomUUID()}`, dailyCap, perRunCap)
    .run();
}

/** Enable a provider and allow one label to egress to it. */
async function enableProvider(providerId: string, label = "PUBLIC"): Promise<void> {
  await t.db.prepare("UPDATE provider_registry SET enabled = 1, kill_switched = 0 WHERE id = ?1").bind(providerId).run();
  /*
   * TWO THINGS A FIXTURE NOW HAS TO SAY, both of them the point of migration 0177.
   *
   * ADOPTED: selection requires `provider_model.status = 'ACTIVE'`. Reading the pricing table alone
   * is how three BENCH Workers AI models came to take every unpinned call in the firm, so a price
   * no longer adopts a model — a human decision does.
   *
   * PRICED BY SOMEBODY: a price whose `pricing_state` is ILLUSTRATIVE takes no part in any cost
   * comparison, because ranking on a number nobody read is how migration 0158 elected a search
   * model for every judgement call. The seeded catalogue is entirely placeholders, so a fixture
   * that wants its model to win on price has to state that the price is real. Tests that exercise
   * the guard itself plant their own rows — see tests/aiFallback.test.ts.
   */
  await t.db
    .prepare(
      `UPDATE provider_model
          SET status = 'ACTIVE', pricing_state = 'SOURCED', pricing_sourced_at = '2026-09-17T00:00:00.000Z'
        WHERE provider_id = ?1`,
    )
    .bind(providerId)
    .run();

  await t.db
    .prepare("INSERT OR REPLACE INTO provider_data_policy (id, provider_id, privacy_label, allowed) VALUES (?1, ?2, ?3, 1)")
    .bind(`pdp_${providerId}_${label}`, providerId, label)
    .run();
}

function stubFetch(handler: (url: string) => { ok: boolean; body: unknown }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const { ok, body } = handler(url);
    return new Response(JSON.stringify(body), { status: ok ? 200 : 500, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

beforeAll(async () => {
  t = await createTestDb();
  /*
   * OPENROUTER IS DELIBERATELY LEFT UNCONFIGURED — the credential-gate test below depends on it.
   * The other vendors are configured because their adapters fail closed before any network call
   * (`credential_missing:<vendor>`), which the old generic adapter did not: it sent the request
   * with no authorization header and a stub answered it. A test that expects a vendor call to
   * complete now has to say that vendor is configured.
   */
  env = makeTestEnv(t.db, {
    OPENAI_API_KEY: "test-openai",
    WP_ANTHROPIC_API_KEY: "test-anthropic",
    GEMINI_API_KEY: "test-gemini",
  });
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("the catalogue is honest about credentials, pricing, and health", () => {
  it("reports credential presence by NAME without ever returning a value", async () => {
    const res = await call<{ providers: any[]; notes: Record<string, string> }>("/api/ai/catalog", MP);
    expect(res.status).toBe(200);
    const openrouter = res.body.providers.find((p: any) => p.provider_key === "openrouter")!;
    expect(openrouter.credential_name).toBe("OPENROUTER_API_KEY");
    expect(openrouter.credential_configured).toBe(false);
    // No secret-shaped field is present at all.
    expect(Object.keys(openrouter)).not.toContain("api_key");
    expect(JSON.stringify(res.body)).not.toContain("sk-");
    expect(res.body.notes.credentials).toContain("No secret value is read");
  });

  it("marks the seeded catalogue ILLUSTRATIVE rather than presenting placeholder prices as fact", async () => {
    const res = await call<{ models: any[] }>("/api/ai/catalog", MP);
    const gpt = res.body.models.find((m: any) => m.model === "gpt-4o-mini")!;
    expect(gpt.pricing_state).toBe("ILLUSTRATIVE");
    expect(gpt.pricing_source_note).toContain("no vendor price has been read");
    expect(gpt.status).toBe("BENCH");
    // Fireworks was registered at P16, disabled and with no egress allowance.
    const fireworks = res.body.models.find((m: any) => m.model === "llama-v3p1-70b-instruct");
    expect(fireworks).toBeDefined();
  });

  it("refuses to record a SOURCED price with no date", async () => {
    const res = await call("/api/ai/models", MP, "POST", {
      provider_key: "openai",
      model: "gpt-4o-mini",
      display_name: "GPT-4o mini",
      pricing: { input_per_mtok_usd: 0.15, output_per_mtok_usd: 0.6, state: "SOURCED", source_note: "read from the vendor page" },
    });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe("sourced_pricing_requires_date");
  });

  it("runs a health check that says plainly it did not contact the vendor", async () => {
    const res = await call<{ mode: string; ok: boolean; detail: string; problems: string[] }>(
      "/api/ai/providers/openai/health-check",
      MP,
      "POST",
    );
    expect(res.status).toBe(201);
    expect(res.body.mode).toBe("LOCAL_FIXTURE");
    expect(res.body.detail).toContain("No request was made");
    // OpenAI is enabled since 0177 (a key exists in production) and configured in this suite's
    // environment, so its configuration IS coherent — and the check still refuses to call that
    // evidence the vendor is reachable, which is the whole point of the LOCAL_FIXTURE stamp.
    expect(res.body.ok).toBe(true);

    // Fireworks is the provider with no key anywhere, so it is the one that must report a MISSING
    // CREDENTIAL BY ITS OWN NAME. THE FIX THIS ASSERTS: every vendor but OpenRouter used to report
    // AI_PROVIDER_API_KEY, one name shared by five companies, which could not tell anybody which
    // of them was actually unconfigured.
    const fw = await call<{ ok: boolean; problems: string[] }>("/api/ai/providers/fireworks/health-check", MP, "POST");
    expect(fw.body.ok).toBe(false);
    expect(fw.body.problems.join(" ")).toContain("FIREWORKS_API_KEY");
    expect(fw.body.problems.join(" ")).not.toContain("AI_PROVIDER_API_KEY");
  });

  it("refuses a LIVE evaluation that cites no run", async () => {
    // Was: refused outright, because no provider credential existed. That stopped being true, so
    // the rule is now that a LIVE claim must point at the call it rests on — see the dedicated
    // describe block at the end of this file.
    const res = await call("/api/ai/models/pm_openai_gpt4o_mini/evaluations", MP, "POST", {
      task_class: "drafting",
      method: "LIVE",
      score: 0.9,
      notes: "would be a false record",
    });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe("evidence_required");
  });

  it("requires an evaluation before a model can be promoted to ACTIVE", async () => {
    const refused = await call("/api/ai/models/pm_openai_gpt4o_mini/status", MP, "POST", { status: "ACTIVE", reason: "seems fine" });
    expect(refused.status).toBe(409);
    expect((refused.body as any).error).toBe("evaluation_required");

    const evaluated = await call("/api/ai/models/pm_openai_gpt4o_mini/evaluations", MP, "POST", {
      task_class: "drafting",
      method: "OFFLINE_DETERMINISTIC",
      score: 0.72,
      sample_size: 20,
      notes: "offline fixture comparison, no vendor call",
    });
    expect(evaluated.status).toBe(201);

    /*
     * AND AN EVALUATION IS NO LONGER THE ONLY GATE. gpt-4o-mini's price is ILLUSTRATIVE — the P4
     * seed, never read from anybody — and ACTIVE is what makes a model selectable at all. Promoting
     * on a placeholder number is how a guess becomes the firm's default, so it now takes an
     * explicit acknowledgement rather than happening by omission.
     */
    const unacknowledged = await call<{ error: string; detail: string }>("/api/ai/models/pm_openai_gpt4o_mini/status", MP, "POST", {
      status: "ACTIVE",
      reason: "best offline score for drafting",
    });
    expect(unacknowledged.status).toBe(409);
    expect(unacknowledged.body.error).toBe("price_never_read");
    expect(unacknowledged.body.detail).toContain("nobody has read a figure from the vendor");

    const promoted = await call<{ status: string }>("/api/ai/models/pm_openai_gpt4o_mini/status", MP, "POST", {
      status: "ACTIVE",
      reason: "best offline score for drafting; priced by nobody and we know it",
      price_unread_acknowledged: true,
    });
    expect(promoted.status).toBe(200);
    expect(promoted.body.status).toBe("ACTIVE");

    // The acknowledgement is ON THE RECORD, not just accepted at the door.
    const ev = await t.db
      .prepare("SELECT payload_json FROM event_record WHERE object_id = 'pm_openai_gpt4o_mini' ORDER BY rowid DESC LIMIT 1")
      .first<{ payload_json: string }>();
    expect(JSON.parse(ev!.payload_json).price_unread_acknowledged).toBe(true);
  });
});

/*
 * WHY THIS BLOCK EXISTS. The Workers AI adapter shipped with no test of any kind, and the bug that
 * followed was not subtle: it read `response`, the cheapest registered model answers only in the
 * OpenAI chat-completion shape, and so every run routed to the cheap tier failed from the day the
 * tier was added. The fixtures below are the two real shapes, recorded from live calls to
 * granite-4.0-h-micro and qwen3-30b-a3b-fp8 on 21 Aug 2026 — not invented.
 */
describe("the Workers AI adapter reads both response shapes", () => {
  const bindingReturning = (value: unknown): WorkersAiBinding => ({
    run: async () => value as Awaited<ReturnType<WorkersAiBinding["run"]>>,
  });

  it("reads the OpenAI chat-completion shape, which granite answers in and carries no response field", async () => {
    const adapter = createWorkersAiAdapter({
      binding: bindingReturning({
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "A capital call is a demand for committed capital." } }],
        usage: { prompt_tokens: 34, completion_tokens: 38 },
      }),
      model: "@cf/ibm-granite/granite-4.0-h-micro",
    });

    const result = await adapter.complete({ purpose: "p", inputs: ["i"], model: null });
    expect(result.text).toBe("A capital call is a demand for committed capital.");
    expect(result.usage.inputTokens).toBe(34);
    expect(result.usage.outputTokens).toBe(38);
  });

  it("still reads the legacy response field, which qwen answers with alongside choices", async () => {
    const adapter = createWorkersAiAdapter({
      binding: bindingReturning({
        response: "Legacy shape.",
        choices: [{ message: { content: "Ignored — response wins when both are present." } }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      }),
      model: "@cf/qwen/qwen3-30b-a3b-fp8",
    });

    await expect(adapter.complete({ purpose: "p", inputs: ["i"], model: null })).resolves.toMatchObject({
      text: "Legacy shape.",
    });
  });

  it("separates a response that never arrived from one that arrived empty", async () => {
    const missing = createWorkersAiAdapter({ binding: bindingReturning({ usage: {} }), model: "m" });
    await expect(missing.complete({ purpose: "p", inputs: ["i"], model: null })).rejects.toThrow(
      "provider_malformed_response",
    );

    const empty = createWorkersAiAdapter({ binding: bindingReturning({ response: "" }), model: "m" });
    await expect(empty.complete({ purpose: "p", inputs: ["i"], model: null })).rejects.toThrow(
      "provider_empty_response",
    );
  });

  const anImage = { mediaType: "image/png", dataBase64: "AAA", label: "a screenshot of the page" };

  it("refuses images for a model that cannot see, rather than dropping them and answering anyway", async () => {
    const adapter = createWorkersAiAdapter({
      binding: bindingReturning({ response: "text" }),
      model: "@cf/ibm-granite/granite-4.0-h-micro",
    });
    await expect(
      adapter.complete({ purpose: "p", inputs: ["i"], model: null, images: [anImage] }),
    ).rejects.toThrow("workers_ai_no_vision");
  });

  it("sends images to the vision model as data-URI content parts", async () => {
    let sent: Record<string, unknown> | null = null;
    const adapter = createWorkersAiAdapter({
      binding: {
        run: async (_model, input) => {
          sent = input;
          return { response: "I can see the page." } as Awaited<ReturnType<WorkersAiBinding["run"]>>;
        },
      },
      model: "@cf/meta/llama-3.2-11b-vision-instruct",
    });

    const result = await adapter.complete({ purpose: "p", inputs: ["what is wrong here?"], model: null, images: [anImage] });
    expect(result.text).toBe("I can see the page.");

    const messages = (sent as unknown as { messages: Array<{ role: string; content: unknown }> }).messages;
    expect(messages[1]?.content).toEqual([
      { type: "text", text: "what is wrong here?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
    ]);
  });

  it("keeps a text-only run's content a plain string, exactly as before vision existed", async () => {
    let sent: Record<string, unknown> | null = null;
    const adapter = createWorkersAiAdapter({
      binding: {
        run: async (_model, input) => {
          sent = input;
          return { response: "ok" } as Awaited<ReturnType<WorkersAiBinding["run"]>>;
        },
      },
      model: "@cf/ibm-granite/granite-4.0-h-micro",
    });

    await adapter.complete({ purpose: "p", inputs: ["a", "b"], model: null });
    const messages = (sent as unknown as { messages: Array<{ role: string; content: unknown }> }).messages;
    expect(messages[1]?.content).toBe("a\n\nb");
  });
});

describe("adapters fail closed without a credential", () => {
  it("OpenRouter throws before attempting any network call", async () => {
    let called = false;
    const adapter = createOpenRouterAdapter({
      baseUrl: "https://provider.invalid",
      model: "auto",
      fetchImpl: (async () => {
        called = true;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    await expect(adapter.complete({ purpose: "p", inputs: ["i"], model: "auto" })).rejects.toThrow("credential_missing:openrouter");
    expect(called).toBe(false);
  });

  it("Fireworks throws before attempting any network call", async () => {
    let called = false;
    const adapter = createFireworksAdapter({
      baseUrl: "https://provider.invalid",
      model: "llama-v3p1-70b-instruct",
      fetchImpl: (async () => {
        called = true;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    await expect(adapter.complete({ purpose: "p", inputs: ["i"], model: null })).rejects.toThrow("credential_missing:fireworks");
    expect(called).toBe(false);
  });

  it("a run against a credential-less provider records the reason instead of failing silently", async () => {
    await setFrontier();
    await enableProvider("prov_openrouter", "PUBLIC");
    const { run } = await runAi(env, {
      purpose: "credential gate probe",
      actor: MP_ACTOR,
      inputs: ["hello"],
      sensitivity: "PUBLIC",
      budgetContext: { providerKey: "openrouter" },
    });
    expect(run.status).toBe("BLOCKED_DEFERRED");
    expect(run.failure_reason).toContain("credential_missing:openrouter");

    const routing = await call<{ routing: { attempts_json: string; explanation: string } }>(`/api/ai/runs/${run.id}/routing`, MP);
    expect(routing.status).toBe(200);
    const attempts = JSON.parse(routing.body.routing.attempts_json) as Array<{ outcome: string; detail: string }>;
    // FAILED, not FAILED_OVER: openrouter has no key here and nothing caught the work, which is
    // exactly what the record should say. The two outcomes are different facts.
    expect(attempts[0]!.outcome).toBe("FAILED");
    expect(attempts[0]!.detail).toContain("credential_missing");
  });
});

describe("routing is explained, ordered, and opt-in", () => {
  beforeEach(async () => {
    await setFrontier();
  });

  it("with no policy, behaves exactly as P4: cheapest capable model, one attempt", async () => {
    await enableProvider("prov_google", "INTERNAL");
    await enableProvider("prov_openai", "INTERNAL");
    const { run } = await runAi(env, {
      purpose: "unrouted drafting",
      actor: MP_ACTOR,
      inputs: ["draft something"],
      sensitivity: "INTERNAL",
    });
    // gemini-1.5-flash is the cheapest seeded model.
    expect(run.model).toBe("gemini-1.5-flash");
    const routing = await call<{ routing: { explanation: string; attempts_json: string; policy_id: string | null } }>(
      `/api/ai/runs/${run.id}/routing`,
      MP,
    );
    expect(routing.body.routing.policy_id).toBeNull();
    expect(routing.body.routing.explanation).toContain("no routing policy");
    expect(JSON.parse(routing.body.routing.attempts_json)).toHaveLength(1);
  });

  it("refuses a policy that names a model outside the catalogue", async () => {
    const res = await call("/api/ai/routing-policies", MP, "POST", {
      task_class: "nonsense",
      candidates: [{ provider_key: "openai", model: "gpt-9-imaginary" }],
    });
    expect(res.status).toBe(404);
    expect((res.body as any).error).toBe("unknown_candidate");
  });

  it("orders candidates by the policy and records the explanation", async () => {
    const policy = await call<{ id: string; version_no: number }>("/api/ai/routing-policies", MP, "POST", {
      task_class: "diligence-drafting",
      candidates: [
        { provider_key: "openai", model: "gpt-4o" },
        { provider_key: "google", model: "gemini-1.5-flash" },
      ],
      allow_fallback: false,
      notes: "quality first for diligence",
    });
    expect(policy.status).toBe(201);
    expect(policy.body.version_no).toBe(1);

    const { run } = await runAi(env, {
      purpose: "routed drafting",
      actor: MP_ACTOR,
      inputs: ["draft something"],
      sensitivity: "INTERNAL",
      routing: { taskClass: "diligence-drafting" },
    });
    // The policy's FIRST candidate wins even though it is the more expensive model.
    expect(run.model).toBe("gpt-4o");
    const routing = await call<{ routing: { explanation: string; policy_id: string } }>(`/api/ai/runs/${run.id}/routing`, MP);
    expect(routing.body.routing.policy_id).toBe(policy.body.id);
    expect(routing.body.routing.explanation).toContain("routing policy 'diligence-drafting' v1");
    expect(routing.body.routing.explanation).toContain("no fallback");
  });

  it("falls back only when the policy allows it, and keeps the failed attempt visible", async () => {
    await call("/api/ai/routing-policies", MP, "POST", {
      task_class: "fallback-probe",
      candidates: [
        { provider_key: "openai", model: "gpt-4o" },
        { provider_key: "google", model: "gemini-1.5-flash" },
      ],
      allow_fallback: true,
      notes: "prefer gpt-4o, fall back to flash",
    });

    // The stub fails for the OpenAI base URL and succeeds for Google's.
    const fetchImpl = stubFetch((url) =>
      url.includes("openai")
        ? { ok: false, body: { error: "upstream down" } }
        : {
            ok: true,
            // Gemini's own wire shape since 0177: `google` no longer resolves to the generic
            // adapter, which posted to a path no vendor implements.
            body: {
              text: "fallback answer",
              model: "gemini-1.5-flash",
              candidates: [{ content: { parts: [{ text: "fallback answer" }] } }],
              usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 },
              usage: { input_tokens: 5, output_tokens: 5, cost_usd: 0.0001 },
            },
          },
    );

    const { run } = await runAi(
      env,
      {
        purpose: "fallback drafting",
        actor: MP_ACTOR,
        inputs: ["draft something"],
        sensitivity: "INTERNAL",
        routing: { taskClass: "fallback-probe" },
      },
      { fetchImpl },
    );
    expect(run.status).toBe("COMPLETED");
    expect(run.model).toBe("gemini-1.5-flash");

    const routing = await call<{ routing: { attempts_json: string; fallback_used: number } }>(`/api/ai/runs/${run.id}/routing`, MP);
    const attempts = JSON.parse(routing.body.routing.attempts_json) as Array<{ provider_key: string; outcome: string }>;
    expect(attempts).toHaveLength(2);
    // FAILED_OVER, not FAILED: the attempt failed AND handed the work on, and the record says so
    // rather than leaving "did anything catch this?" to be inferred.
    expect(attempts[0]!.outcome).toBe("FAILED_OVER");
    expect(attempts[0]!.provider_key).toBe("openai");
    expect(attempts[1]!.outcome).toBe("COMPLETED");
    expect(routing.body.routing.fallback_used).toBe(1);
  });

  it("a machine model policy outranks the task routing policy", async () => {
    await call("/api/machines/23/model-policy", MP, "POST", {
      preferred_provider_key: "google",
      preferred_model: "gemini-1.5-flash",
      notes: "research machine stays cheap",
    });
    const { run } = await runAi(env, {
      purpose: "machine-pinned drafting",
      actor: MP_ACTOR,
      inputs: ["draft something"],
      sensitivity: "INTERNAL",
      routing: { taskClass: "diligence-drafting", machineId: 23 },
    });
    expect(run.model).toBe("gemini-1.5-flash");
    const routing = await call<{ routing: { explanation: string }; attribution: { machine_id: number } }>(
      `/api/ai/runs/${run.id}/routing`,
      MP,
    );
    expect(routing.body.routing.explanation).toContain("machine 23 pins google/gemini-1.5-flash");
    expect(routing.body.attribution.machine_id).toBe(23);
  });
});

describe("scoped budgets", () => {
  it("computes period boundaries from the clock, not from row order", () => {
    const now = new Date("2026-08-12T15:30:00.000Z");
    expect(periodStart("DAILY", now)).toBe("2026-08-12T00:00:00.000Z");
    expect(periodStart("WEEKLY", now)).toBe("2026-08-10T00:00:00.000Z"); // Monday
    expect(periodStart("MONTHLY", now)).toBe("2026-08-01T00:00:00.000Z");
  });

  it("applies a scope only to runs that actually fall inside it", () => {
    const scope = { scope_type: "MACHINE", scope_id: "23", period: "DAILY", cap_usd: 1 } as BudgetScopeRow;
    expect(scopeApplies(scope, { machineId: 23 }, "west-peek")).toBe(true);
    expect(scopeApplies(scope, { machineId: 24 }, "west-peek")).toBe(false);
    expect(scopeApplies(scope, {}, "west-peek")).toBe(false);
  });

  it("refuses a budget for a scope target that does not exist", async () => {
    const res = await call("/api/ai/budgets", MP, "POST", {
      scope_type: "EMPLOYEE",
      scope_id: "aie_nobody",
      period: "DAILY",
      cap_usd: 1,
      reason: "typo",
    });
    expect(res.status).toBe(404);
    expect((res.body as any).error).toBe("unknown_scope_target");
  });

  it("blocks a run by NAME when a scoped cap would be exceeded, and raises one alert", async () => {
    await setFrontier(1000, 1000);
    await enableProvider("prov_google", "INTERNAL");

    const budget = await call<{ version_no: number }>("/api/ai/budgets", MP, "POST", {
      scope_type: "CATEGORY",
      scope_id: "RESEARCH",
      period: "DAILY",
      cap_usd: 0.000001,
      reason: "hard cap for the test",
    });
    expect(budget.status).toBe(201);
    expect(budget.body.version_no).toBe(1);

    const { run } = await runAi(env, {
      purpose: "expensive research",
      actor: MP_ACTOR,
      inputs: ["x".repeat(4000)],
      sensitivity: "INTERNAL",
      routing: { category: "RESEARCH" },
    });
    expect(run.status).toBe("BUDGET_BLOCKED");
    expect(run.failure_reason).toContain("scoped_cap_exceeded:CATEGORY:RESEARCH:DAILY");

    const alerts = await t.db
      .prepare("SELECT * FROM cost_alert WHERE scope_type = 'CATEGORY' AND scope_id = 'RESEARCH'")
      .all<{ severity: string; id: string }>();
    expect((alerts.results ?? []).length).toBe(1);
    expect(alerts.results![0]!.severity).toBe("BREACH");

    // A second identical breach on the same day dedupes rather than spamming.
    await runAi(env, {
      purpose: "expensive research again",
      actor: MP_ACTOR,
      inputs: ["x".repeat(4000)],
      sensitivity: "INTERNAL",
      routing: { category: "RESEARCH" },
    });
    const again = await t.db.prepare("SELECT COUNT(*) AS n FROM cost_alert WHERE scope_type = 'CATEGORY'").first<{ n: number }>();
    expect(again!.n).toBe(1);
  });

  it("keeps budget versions immutable and enforces the newest", async () => {
    const first = await call<{ id: string }>("/api/ai/budgets", MP, "POST", {
      scope_type: "PROVIDER",
      scope_id: "google",
      period: "MONTHLY",
      cap_usd: 5,
      reason: "initial",
    });
    const second = await call<{ version_no: number }>("/api/ai/budgets", MP, "POST", {
      scope_type: "PROVIDER",
      scope_id: "google",
      period: "MONTHLY",
      cap_usd: 25,
      reason: "raised for the quarter",
    });
    expect(second.body.version_no).toBe(2);
    await expect(t.db.prepare("UPDATE budget_scope SET cap_usd = 999 WHERE id = ?1").bind(first.body.id).run()).rejects.toThrow(/immutable/);
  });

  it("acknowledges a cost alert once", async () => {
    const alert = await t.db.prepare("SELECT id FROM cost_alert LIMIT 1").first<{ id: string }>();
    const first = await call(`/api/ai/cost-alerts/${alert!.id}/acknowledge`, MP, "POST");
    expect(first.status).toBe(200);
    const second = await call(`/api/ai/cost-alerts/${alert!.id}/acknowledge`, MP, "POST");
    expect(second.status).toBe(409);
  });
});

describe("the cost centre reports spend with its definitions attached", () => {
  it("breaks spend down by employee, provider, model, machine, and category", async () => {
    const res = await call<{
      totals: Record<string, number>;
      by_provider: Array<{ key: string }>;
      by_category: Array<{ key: string }>;
      by_machine: Array<{ key: string }>;
      definitions: Record<string, string>;
      budgets: any[];
    }>("/api/ai/cost?period=MONTHLY", MP);
    expect(res.status).toBe(200);
    expect(res.body.totals.runs).toBeGreaterThan(0);
    expect(res.body.by_category.some((c) => c.key === "RESEARCH")).toBe(true);
    expect(res.body.by_machine.some((m) => m.key === "23")).toBe(true);
    // The one definition, served from ai/spend.ts. Asserted on the substance rather than the exact
    // wording, but asserted HERE because this payload is what puts the sentence on the page.
    expect(res.body.definitions.committed).toContain("our own estimate where it did not");
    expect(res.body.definitions.committed).toContain("counts as nothing");
    expect(res.body.definitions.value).toContain("benefit is not measured as money");
    expect(res.body.budgets.length).toBeGreaterThan(0);
  });

  it("counts blocked runs separately and never charges for them", async () => {
    const res = await call<{ totals: { blocked_runs: number; committed_usd: number } }>("/api/ai/cost?period=MONTHLY", MP);
    expect(res.body.totals.blocked_runs).toBeGreaterThan(0);
    expect(res.body.totals.committed_usd).toBeGreaterThanOrEqual(0);
  });

  it("labels estimate-only totals as estimates rather than invoices", async () => {
    const res = await call<{ totals: { estimate_only_runs: number }; definitions: Record<string, string> }>("/api/ai/cost", MP);
    expect(res.body.definitions.estimate_only_runs).toContain("not invoices");
  });
});

/**
 * LIVE evaluations must prove themselves.
 *
 * This method used to be refused outright because no provider credential existed — true when
 * written, false once OpenRouter was configured, at which point the refusal was blocking the honest
 * case rather than preventing a dishonest one. Verification replaced refusal, so these tests exist
 * to keep it verification and stop it drifting back into a rubber stamp.
 */
describe("a LIVE model evaluation cites the run that proves it", () => {
  const M = "/api/ai/models/pm_openai_gpt4o_mini/evaluations";

  it("refuses a LIVE evaluation with no evidence at all", async () => {
    const res = await call(M, MP, "POST", { task_class: "drafting", method: "LIVE", score: 9, notes: "trust me" });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe("evidence_required");
  });

  it("refuses a cited run that does not exist", async () => {
    const res = await call(M, MP, "POST", {
      task_class: "drafting", method: "LIVE", score: 9, notes: "n", ai_run_id: "air_not_a_real_run",
    });
    expect(res.status).toBe(404);
    expect((res.body as any).error).toBe("unknown_run");
  });

  it("still records the methods that make no claim about a vendor call", async () => {
    // FIXTURE and OFFLINE_DETERMINISTIC assert nothing happened at a vendor, so demanding
    // evidence of a vendor call would be theatre rather than rigour.
    const res = await call(M, MP, "POST", {
      task_class: "drafting", method: "FIXTURE", score: 7, sample_size: 5, notes: "ran the fixture set",
    });
    expect(res.status).toBe(201);
  });
});

/**
 * The OpenRouter adapter reports what a run cost.
 *
 * Every completed run was recording cost_usd: 0, because OpenRouter returns a cost only when the
 * request asks for one and nothing was asking. Spend-to-date is summed from that field, so "spent
 * today" was permanently zero and the firm's daily cap could never fire — the per-run cap was the
 * only ceiling actually in force. A cap that cannot fire is not a cap.
 */
describe("OpenRouter cost accounting", () => {
  function adapterWith(usage: Record<string, unknown>, seen: { body?: any } = {}) {
    return createOpenRouterAdapter({
      baseUrl: "https://provider.invalid",
      model: "anthropic/claude-sonnet-5",
      apiKey: "test-key-not-a-real-credential",
      fetchImpl: (async (_url: unknown, init: any) => {
        seen.body = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({ model: "anthropic/claude-sonnet-5", choices: [{ message: { content: "ok" } }], usage }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
  }

  it("asks OpenRouter to include usage accounting on every request", async () => {
    const seen: { body?: any } = {};
    await adapterWith({ prompt_tokens: 10, completion_tokens: 20, total_cost: 0.5 }, seen)
      .complete({ purpose: "p", inputs: ["i"], model: "anthropic/claude-sonnet-5" });
    // Without this flag the response carries tokens and no cost, which is how spend read as zero.
    expect(seen.body?.usage).toEqual({ include: true });
  });

  it("reads the cost under either spelling OpenRouter has used", async () => {
    const a = await adapterWith({ prompt_tokens: 1, completion_tokens: 2, total_cost: 0.25 })
      .complete({ purpose: "p", inputs: ["i"], model: "anthropic/claude-sonnet-5" });
    expect(a.usage.costUsd).toBe(0.25);

    const b = await adapterWith({ prompt_tokens: 1, completion_tokens: 2, cost: 0.75 })
      .complete({ purpose: "p", inputs: ["i"], model: "anthropic/claude-sonnet-5" });
    expect(b.usage.costUsd).toBe(0.75);
  });

  it("reports zero only when the provider genuinely says nothing, leaving runAi to price it", async () => {
    const r = await adapterWith({ prompt_tokens: 1, completion_tokens: 2 })
      .complete({ purpose: "p", inputs: ["i"], model: "anthropic/claude-sonnet-5" });
    expect(r.usage.costUsd).toBe(0);
    expect(r.usage.inputTokens).toBe(1);
    expect(r.usage.outputTokens).toBe(2);
  });
});

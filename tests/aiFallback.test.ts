import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { runAi } from "../src/worker/ai/runAi";
import { isProviderOutage, outageKind } from "../src/shared/ai/providerFailure";
import { directVendorRouteFor } from "../src/shared/ai/directVendorRoute";
import { credentialConfigured, credentialNameFor } from "../src/shared/ai/providerCredentials";

/**
 * A FALLBACK NOBODY HAS SEEN WORK IS NOT A FALLBACK.
 *
 * Every ACTIVE model in this firm sits behind OpenRouter, so until this suite existed, one expired
 * key or one bad hour at one company stopped the whole firm thinking. "Exists but nothing invokes
 * it" and "a guard that cannot reach what it governs" are the two named recurring defects in this
 * portfolio, and a failover lane is an easy place for both.
 *
 * So each of the five ways a provider can fail is produced here — a dead key, a 403 from a VALID
 * key, a 429, a 5xx, and a request that never answers — and in every one the assertion is not that
 * the fallback was CONFIGURED but that THE WORK COMPLETED, on the second vendor, with the handover
 * on the record.
 *
 * And the refusals are asserted too, because a fallback that engages on everything is its own
 * defect: a capability refusal must not be passed to a second vendor, and a vendor with no key
 * must not be tried at all.
 */

let t: TestDb;
let baseEnv: Env;

const MP_ACTOR: Actor = {
  type: "HUMAN",
  firmUserId: "fu_scooter_taylor",
  roles: ["MANAGING_PARTNER"],
  firmScopes: ["west-peek"],
};

/** The model the firm's pinned work actually runs on, and the one with a direct Anthropic lane. */
const PRIMARY_MODEL = "anthropic/claude-sonnet-5";

/**
 * A fetch stub that answers per HOST, so "OpenRouter is down and Anthropic is up" is expressible.
 * Records every host it was asked for, which is how the negative cases prove a vendor was NEVER
 * contacted rather than merely that the run failed.
 */
function hostRouter(routes: Record<string, () => Response | Promise<Response>>): {
  fetchImpl: typeof fetch;
  seen: string[];
} {
  const seen: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const host = new URL(url).host;
    seen.push(host);
    const handler = routes[host];
    if (!handler) throw new Error(`no stub for ${host} — the test did not expect this vendor to be called`);
    return handler();
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const openRouterDown = (status: number) => () => new Response(JSON.stringify({ error: "down" }), { status });
const openRouterTimesOut = () => () => {
  // What an AbortSignal.timeout rejection looks like by the time executeAttempt catches it.
  throw new Error("The operation was aborted due to timeout");
};
const anthropicAnswers = (text: string) => () =>
  new Response(
    JSON.stringify({
      model: "claude-sonnet-5",
      content: [{ type: "text", text }],
      usage: { input_tokens: 120, output_tokens: 80 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

async function setFrontier(): Promise<void> {
  await t.db
    .prepare(
      `INSERT INTO budget_policy (id, firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, set_by)
       VALUES (?1, 'west-peek', 'NORMAL', 'FRONTIER', 500, 500, 'fu_scooter_taylor')`,
    )
    .bind(`bp_${crypto.randomUUID()}`)
    .run();
}

async function routingFor(runId: string): Promise<{
  attempts: Array<{ provider_key: string; model: string; outcome: string; detail?: string }>;
  fallback_used: number;
  selected_provider_key: string | null;
  explanation: string;
}> {
  const row = await t.db
    .prepare("SELECT attempts_json, fallback_used, selected_provider_key, explanation FROM ai_run_routing WHERE ai_run_id = ?1")
    .bind(runId)
    .first<{ attempts_json: string; fallback_used: number; selected_provider_key: string | null; explanation: string }>();
  return { ...row!, attempts: JSON.parse(row!.attempts_json) };
}

/** Run the pinned frontier call: OpenRouter, claude-sonnet-5, which has a direct Anthropic lane. */
async function runPinned(env: Env, fetchImpl: typeof fetch) {
  return runAi(
    env,
    {
      purpose: "drafting for a partner",
      actor: MP_ACTOR,
      inputs: ["draft the summary"],
      sensitivity: "INTERNAL",
      budgetContext: { providerKey: "openrouter", preferredModel: PRIMARY_MODEL },
    },
    { fetchImpl },
  );
}

beforeAll(async () => {
  t = await createTestDb();
  baseEnv = makeTestEnv(t.db);
  await setFrontier();
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("the same model by a different road", () => {
  it("derives the vendor's own id from the OpenRouter id, and leaves open weights alone", () => {
    expect(directVendorRouteFor("anthropic/claude-sonnet-5")).toEqual({ providerKey: "anthropic", model: "claude-sonnet-5" });
    expect(directVendorRouteFor("openai/gpt-4o")).toEqual({ providerKey: "openai", model: "gpt-4o" });
    // An OpenRouter routing variant describes how OPENROUTER picks a host. It means nothing to the
    // vendor and must not be sent to it.
    expect(directVendorRouteFor("anthropic/claude-sonnet-5:nitro")).toEqual({ providerKey: "anthropic", model: "claude-sonnet-5" });
    // Perplexity's ids are namespaced at Perplexity too — bare `sonar` is HTTP 400 there.
    expect(directVendorRouteFor("perplexity/sonar")).toEqual({ providerKey: "perplexity", model: "perplexity/sonar" });
    // Open weights served by OpenRouter have no single vendor to fall back to. No guess is made.
    expect(directVendorRouteFor("qwen/qwen3-30b")).toBeNull();
    expect(directVendorRouteFor("@cf/ibm-granite/granite-4.0-h-micro")).toBeNull();
    expect(directVendorRouteFor("auto")).toBeNull();
  });

  it("names one credential per vendor, so one vendor being configured says nothing about another", () => {
    expect(credentialNameFor("openrouter")).toBe("OPENROUTER_API_KEY");
    expect(credentialNameFor("openai")).toBe("OPENAI_API_KEY");
    // WP_-prefixed deliberately: the bare name is reserved by the owner's vault.
    expect(credentialNameFor("anthropic")).toBe("WP_ANTHROPIC_API_KEY");
    expect(credentialNameFor("google")).toBe("GEMINI_API_KEY");
    expect(credentialNameFor("perplexity")).toBe("PERPLEXITY_API_KEY");

    const onlyAnthropic = { WP_ANTHROPIC_API_KEY: "k" };
    expect(credentialConfigured(onlyAnthropic, "anthropic")).toBe(true);
    // THE DEFECT THIS REPLACES: one shared name reported all five vendors as configured together.
    expect(credentialConfigured(onlyAnthropic, "openai")).toBe(false);
    expect(credentialConfigured(onlyAnthropic, "google")).toBe(false);
    // The shared legacy name still configures anybody, so nothing set before this change broke.
    expect(credentialConfigured({ AI_PROVIDER_API_KEY: "k" }, "openai")).toBe(true);
  });
});

describe("failing over is the provider's failure, never the request's", () => {
  it("classifies each mode, and refuses to fail over on anything it does not recognise", () => {
    expect(isProviderOutage("provider_http_401")).toBe(true);
    expect(outageKind("provider_http_401")).toBe("AUTH_REJECTED");
    // A VALID key can be refused. Perplexity answers 403 to a chat-completions call — reporting
    // that as a bad credential would send somebody to rotate a key that is fine.
    expect(isProviderOutage("provider_http_403")).toBe(true);
    expect(outageKind("provider_http_403")).toBe("REFUSED_BY_VENDOR");
    expect(outageKind("provider_http_429")).toBe("RATE_LIMITED");
    expect(outageKind("provider_http_503")).toBe("VENDOR_ERROR");
    expect(outageKind("provider_http_404")).toBe("MODEL_NOT_SERVED");
    expect(outageKind("The operation was aborted due to timeout")).toBe("TIMEOUT_OR_NETWORK");
    expect(isProviderOutage("credential_missing:anthropic")).toBe(true);

    // A fact about the REQUEST. Asking a second vendor finds one willing to answer about a file it
    // never saw.
    expect(isProviderOutage("provider_cannot_read_documents:perplexity")).toBe(false);
    expect(isProviderOutage("provider_http_400")).toBe(false);
    expect(isProviderOutage("something nobody has classified")).toBe(false);
    expect(isProviderOutage("")).toBe(false);
  });
});

describe("the work completes on the fallback — each failure mode, end to end", () => {
  const cases: Array<[string, () => Response | Promise<Response>, string]> = [
    ["a dead key (401)", openRouterDown(401), "AUTH_REJECTED"],
    ["a valid key the vendor still refuses (403)", openRouterDown(403), "REFUSED_BY_VENDOR"],
    ["being rate limited (429)", openRouterDown(429), "RATE_LIMITED"],
    ["the vendor erroring (503)", openRouterDown(503), "VENDOR_ERROR"],
    ["nobody answering at all", openRouterTimesOut(), "TIMEOUT_OR_NETWORK"],
  ];

  for (const [name, openRouter, expectedKind] of cases) {
    it(`survives ${name} and finishes on Anthropic directly`, async () => {
      const { fetchImpl, seen } = hostRouter({
        "openrouter.ai": openRouter,
        "api.anthropic.com": anthropicAnswers("the summary, written by the fallback"),
      });
      const env = makeTestEnv(t.db, { OPENROUTER_API_KEY: "or-key", WP_ANTHROPIC_API_KEY: "ant-key" });
      const { run } = await runPinned(env, fetchImpl);

      // THE ASSERTION THAT MATTERS: the work got done, not that a lane was configured.
      expect(run.status).toBe("COMPLETED");
      expect(run.output_text).toBe("the summary, written by the fallback");
      // On the vendor's own id for the same model — not a cheaper stand-in.
      expect(run.model).toBe("claude-sonnet-5");
      expect(seen).toContain("api.anthropic.com");

      const routing = await routingFor(run.id);
      expect(routing.fallback_used).toBe(1);
      const handover = routing.attempts.find((a) => a.outcome === "FAILED_OVER")!;
      expect(handover.provider_key).toBe("openrouter");
      expect(handover.detail).toContain(expectedKind);
      // The failure is preserved, never tidied away by the recovery.
      expect(routing.attempts.some((a) => a.outcome === "COMPLETED")).toBe(true);
      expect(routing.selected_provider_key).toBe("anthropic");
    });
  }

  it("says on the run, before anything fails, that a direct lane is standing by", async () => {
    const { fetchImpl } = hostRouter({
      "openrouter.ai": () =>
        new Response(
          JSON.stringify({ model: PRIMARY_MODEL, choices: [{ message: { content: "fine" } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const env = makeTestEnv(t.db, { OPENROUTER_API_KEY: "or-key", WP_ANTHROPIC_API_KEY: "ant-key" });
    const { run } = await runPinned(env, fetchImpl);
    expect(run.status).toBe("COMPLETED");
    const routing = await routingFor(run.id);
    expect(routing.explanation).toContain("anthropic/claude-sonnet-5");
    expect(routing.explanation).toContain("engages only if the provider itself fails");
    expect(routing.fallback_used).toBe(0);
  });
});

describe("what must NOT fail over", () => {
  it("does not try a second vendor when the vendor has no key — it fails loudly instead", async () => {
    const { fetchImpl, seen } = hostRouter({ "openrouter.ai": openRouterDown(503) });
    // No WP_ANTHROPIC_API_KEY. A provider with no key is invisible, not enabled-but-broken.
    const env = makeTestEnv(t.db, { OPENROUTER_API_KEY: "or-key" });
    const { run } = await runPinned(env, fetchImpl);

    expect(run.status).toBe("BLOCKED_DEFERRED");
    expect(run.failure_reason).toContain("provider_http_503");
    expect(seen).not.toContain("api.anthropic.com");
    const routing = await routingFor(run.id);
    expect(routing.fallback_used).toBe(0);
    expect(routing.explanation).not.toContain("Direct-vendor fallback is available");
  });

  it("does not hand a request-shaped failure to another vendor", async () => {
    // 400 is a malformed REQUEST. It is malformed everywhere; spraying it across vendors finds
    // four ways to be wrong and burns four bills doing it.
    const { fetchImpl, seen } = hostRouter({
      "openrouter.ai": openRouterDown(400),
      "api.anthropic.com": anthropicAnswers("should never be reached"),
    });
    const env = makeTestEnv(t.db, { OPENROUTER_API_KEY: "or-key", WP_ANTHROPIC_API_KEY: "ant-key" });
    const { run } = await runPinned(env, fetchImpl);

    expect(run.status).toBe("BLOCKED_DEFERRED");
    expect(seen).not.toContain("api.anthropic.com");
    expect(run.output_text ?? "").toBe("");
  });

  it("fails loudly rather than quietly, when even the fallback is down", async () => {
    const { fetchImpl } = hostRouter({
      "openrouter.ai": openRouterDown(500),
      "api.anthropic.com": openRouterDown(500),
    });
    const env = makeTestEnv(t.db, { OPENROUTER_API_KEY: "or-key", WP_ANTHROPIC_API_KEY: "ant-key" });
    const { run } = await runPinned(env, fetchImpl);

    expect(run.status).toBe("BLOCKED_DEFERRED");
    const routing = await routingFor(run.id);
    // Both attempts are on the record. A failover never hides a provider failure.
    expect(routing.attempts.filter((a) => a.outcome === "FAILED_OVER" || a.outcome === "FAILED").length).toBe(2);
    expect(routing.attempts.map((a) => a.provider_key)).toEqual(["openrouter", "anthropic"]);
  });
});

describe("a fallback may never be a quality downgrade", () => {
  it("lands an instruction on a reasoning model even when the primary is down", async () => {
    const { fetchImpl } = hostRouter({
      "openrouter.ai": openRouterDown(429),
      "api.anthropic.com": anthropicAnswers("read the instruction"),
    });
    const env = makeTestEnv(t.db, { OPENROUTER_API_KEY: "or-key", WP_ANTHROPIC_API_KEY: "ant-key" });
    const { run } = await runAi(
      env,
      {
        purpose: "read what the partner asked for",
        actor: MP_ACTOR,
        inputs: ["do the thing I described"],
        sensitivity: "INTERNAL",
        budgetContext: { interpretation: true },
      },
      { fetchImpl },
    );

    expect(run.status).toBe("COMPLETED");
    // The model that ran must itself be one the catalogue records as able to reason. The cheap
    // tier is 40x cheaper and sitting right there; it must not be what catches this.
    const reasoning = await t.db
      .prepare("SELECT supports_reasoning FROM provider_model WHERE model IN (?1, ?2)")
      .bind(run.model, `anthropic/${run.model}`)
      .first<{ supports_reasoning: number }>();
    expect(reasoning?.supports_reasoning).toBe(1);
    expect(run.model).not.toContain("@cf/");
  });

  it("keeps the promoted Workers AI models away from an instruction entirely", async () => {
    // Migration 0177 promotes all three to ACTIVE, deliberately. All three record
    // supports_reasoning = 0, and this asserts that bar still holds AFTER the promotion rather
    // than assuming the filter added earlier still covers them.
    const active = await t.db
      .prepare("SELECT model, status, supports_reasoning FROM provider_model WHERE provider_id = 'prov_workers_ai'")
      .all<{ model: string; status: string; supports_reasoning: number }>();
    expect(active.results.length).toBe(3);
    for (const m of active.results) {
      expect(m.status).toBe("ACTIVE");
      expect(m.supports_reasoning).toBe(0);
    }

    const { fetchImpl } = hostRouter({
      "openrouter.ai": () =>
        new Response(
          JSON.stringify({ model: PRIMARY_MODEL, choices: [{ message: { content: "interpreted" } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const env = makeTestEnv(t.db, {
      OPENROUTER_API_KEY: "or-key",
      // The binding present, so the cheap tier is genuinely available and genuinely cheapest.
      AI: { run: async () => ({ response: "cheap" }) } as unknown as Env["AI"],
    });
    const { run } = await runAi(
      env,
      {
        purpose: "read what the partner asked for",
        actor: MP_ACTOR,
        inputs: ["do the thing I described"],
        sensitivity: "INTERNAL",
        budgetContext: { interpretation: true },
      },
      { fetchImpl },
    );
    expect(run.status).toBe("COMPLETED");
    expect(run.model).not.toContain("@cf/");
  });
});

describe("a price nobody read may not decide anything", () => {
  beforeEach(async () => {
    await t.db.prepare("DELETE FROM provider_pricing_snapshot WHERE id LIKE 'pps_test_%'").run();
    await t.db.prepare("DELETE FROM provider_model WHERE id LIKE 'pm_test_%'").run();
  });

  /** A model that is ACTIVE, egress-allowed, and cheaper than anything real. */
  async function plantCheapModel(pricingState: string): Promise<void> {
    await t.db
      .prepare(
        `INSERT INTO provider_model (id, provider_id, model, display_name, capabilities_json, context_window,
            max_output_tokens, supports_tools, supports_reasoning, max_data_class, pricing_state,
            pricing_source_note, status, registered_by, firm_scope)
         VALUES ('pm_test_bait', 'prov_openrouter', 'test/bait', 'Bait', '["text-completion"]', 8000, 1024,
                 0, 0, 'INTERNAL', ?1, 'planted by the test', 'ACTIVE', 'system', 'west-peek')`,
      )
      .bind(pricingState)
      .run();
    await t.db
      .prepare(
        `INSERT INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, request_usd, captured_at)
         VALUES ('pps_test_bait', 'prov_openrouter', 'test/bait', 0.000001, 0.000001, 0, '2026-09-17T00:00:00.000Z')`,
      )
      .run();
  }

  async function cheapestChosen(): Promise<string> {
    const { fetchImpl } = hostRouter({
      "openrouter.ai": () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const env = makeTestEnv(t.db, { OPENROUTER_API_KEY: "or-key" });
    const { run } = await runAi(
      env,
      { purpose: "routine drafting", actor: MP_ACTOR, inputs: ["draft"], sensitivity: "INTERNAL", budgetContext: { providerKey: "openrouter" } },
      { fetchImpl },
    );
    return run.model ?? "";
  }

  it("refuses to let a placeholder price win, however cheap the number is", async () => {
    await plantCheapModel("ILLUSTRATIVE");
    // This is migration 0158 exactly: one pricing row, no evaluation, no vendor figure, and by
    // that row alone the model became "cheapest adequate" for every unpinned call in the firm.
    expect(await cheapestChosen()).not.toBe("test/bait");
  });

  it("and the NEGATIVE PROOF: the same row wins the moment somebody actually reads the price", async () => {
    await plantCheapModel("SOURCED");
    // Nothing changed but the provenance. If this does not flip, the guard above is passing for
    // some other reason and proves nothing.
    expect(await cheapestChosen()).toBe("test/bait");
  });

  it("refuses a model the catalogue has not made ACTIVE, whatever its price says", async () => {
    await plantCheapModel("SOURCED");
    await t.db.prepare("UPDATE provider_model SET status = 'BENCH' WHERE id = 'pm_test_bait'").run();
    // A pricing row alone used to be enough: selection read provider_pricing_snapshot and never
    // looked at status. That is how three BENCH Workers AI models took every unpinned call.
    expect(await cheapestChosen()).not.toBe("test/bait");
  });

  it("still honours a model somebody NAMED, because a pin is a decision and not a price", async () => {
    await plantCheapModel("ILLUSTRATIVE");
    const { fetchImpl } = hostRouter({
      "openrouter.ai": () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const env = makeTestEnv(t.db, { OPENROUTER_API_KEY: "or-key" });
    const { run } = await runAi(
      env,
      {
        purpose: "routine drafting",
        actor: MP_ACTOR,
        inputs: ["draft"],
        sensitivity: "INTERNAL",
        budgetContext: { providerKey: "openrouter", preferredModel: "test/bait" },
      },
      { fetchImpl },
    );
    expect(run.model).toBe("test/bait");
  });
});

describe("the per-search fee is part of the price", () => {
  it("records the $0.005 a search request costs, which was modelled as zero", async () => {
    const row = await t.db
      .prepare(
        `SELECT request_usd FROM provider_pricing_snapshot
          WHERE provider_id = 'prov_openrouter' AND model = 'perplexity/sonar'
          ORDER BY captured_at DESC LIMIT 1`,
      )
      .first<{ request_usd: number }>();
    expect(row?.request_usd).toBe(0.005);

    // And it reaches the estimate: a short search call's fee dominates its tokens.
    const { fetchImpl } = hostRouter({
      "openrouter.ai": () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "found it" } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const env = makeTestEnv(t.db, { OPENROUTER_API_KEY: "or-key" });
    const { run } = await runAi(
      env,
      {
        purpose: "look something up",
        actor: MP_ACTOR,
        inputs: ["what happened"],
        sensitivity: "PUBLIC",
        budgetContext: { providerKey: "openrouter", preferredModel: "perplexity/sonar" },
      },
      { fetchImpl },
    );
    const estimate = JSON.parse(run.cost_estimate_json) as { estimated_cost_usd: number };
    expect(estimate.estimated_cost_usd).toBeGreaterThanOrEqual(0.005);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { runAi } from "../src/worker/ai/runAi";
import { isProviderOutage, outageKind, vendorCannotServe } from "../src/shared/ai/providerFailure";
import { vendorMessageFrom } from "../src/worker/ai/providers/httpError";
import { classifyContent } from "../src/shared/ai/contentClass";
import { cooldownMsFor, isCoolingDown, orderByLaneHealth, type LaneHealthRow } from "../src/worker/ai/laneHealth";

/**
 * A LANE THAT CANNOT SERVE MUST CHAIN, NOT STOP THE WORK — and must not have been chosen.
 *
 * Every assertion here comes from one production incident on 17 Sep 2026. A work card for Parker
 * deferred three times in fourteen minutes on
 *
 *     prov_anthropic  claude-sonnet-5  BLOCKED_DEFERRED  provider_failure:provider_http_400
 *
 * whose body, probed with the same key, reads "Your credit balance is too low to access the
 * Anthropic API." The key authenticates; the account is unfunded; the lane cannot serve anyone.
 *
 * The four things this file proves, in the order they went wrong:
 *
 *   1. A 400 that says the PROVIDER cannot serve is an outage and chains. A 400 that says the
 *      REQUEST was wrong still defers — the guard is narrow, and the negative case is asserted
 *      alongside every positive one.
 *   2. Cheaper-on-paper never beats working-in-practice, and OpenRouter leads.
 *   3. The chain reaches a lane that is WORKING, not merely the next name on a list.
 *   4. The back-off recovers on its own, because a lane disabled forever by a transient outage is
 *      its own defect.
 *
 * And the fifth, which is the money: an internal, not-private card and the daily executive brief
 * both land on a FREE reasoning lane, while LP and deal material cannot.
 */

let t: TestDb;

const MP_ACTOR: Actor = {
  type: "HUMAN",
  firmUserId: "fu_scooter_taylor",
  roles: ["MANAGING_PARTNER"],
  firmScopes: ["west-peek"],
};

const PRIMARY_MODEL = "anthropic/claude-sonnet-5";

/** Anthropic's actual 400 body for an unfunded account, verbatim from the 17 Sep probe. */
const UNFUNDED_BODY = JSON.stringify({
  type: "error",
  error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." },
});

/** A genuinely malformed request, which must NOT chain. */
const MALFORMED_BODY = JSON.stringify({
  type: "error",
  error: { type: "invalid_request_error", message: "messages.0.content.1.image.source.base64: invalid base64 data" },
});

function hostRouter(routes: Record<string, () => Response | Promise<Response>>): { fetchImpl: typeof fetch; seen: string[] } {
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

const answers = (model: string, text: string) => () =>
  new Response(JSON.stringify({ model, content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 10 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const openRouterAnswers = (model: string, text: string) => () =>
  new Response(
    JSON.stringify({ model, choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const fails = (status: number, body: string) => () => new Response(body, { status });

async function routingFor(runId: string) {
  const row = await t.db
    .prepare("SELECT attempts_json, fallback_used, selected_provider_key, explanation FROM ai_run_routing WHERE ai_run_id = ?1")
    .bind(runId)
    .first<{ attempts_json: string; fallback_used: number; selected_provider_key: string | null; explanation: string }>();
  return { ...row!, attempts: JSON.parse(row!.attempts_json) as Array<{ provider_key: string; model: string; outcome: string; detail?: string }> };
}

beforeAll(async () => {
  t = await createTestDb();
  await t.db
    .prepare(
      `INSERT INTO budget_policy (id, firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, set_by)
       VALUES (?1, 'west-peek', 'NORMAL', 'FRONTIER', 500, 500, 'fu_scooter_taylor')`,
    )
    .bind(`bp_${crypto.randomUUID()}`)
    .run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

beforeEach(async () => {
  // Every case starts from a known lane-health state. Leaving a cooldown armed between cases would
  // make one test's back-off silently decide the next test's routing, which is the sort of coupling
  // that makes a suite pass for the wrong reason.
  await t.db.prepare("DELETE FROM provider_lane_health").run();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("a 400 the vendor used to say IT cannot serve", () => {
  it("reads the vendor's sentence out of every shape an error body comes in", () => {
    expect(vendorMessageFrom(UNFUNDED_BODY)).toContain("credit balance is too low");
    // OpenAI / OpenRouter shape, where the machine-readable code matters as much as the prose.
    expect(vendorMessageFrom(JSON.stringify({ error: { code: "insufficient_quota", message: "You exceeded your current quota" } })))
      .toContain("insufficient_quota");
    // Not JSON at all. The raw text is the message.
    expect(vendorMessageFrom("Payment Required")).toBe("Payment Required");
    // A body that echoes a credential back is scrubbed before it is ever stored.
    expect(vendorMessageFrom(JSON.stringify({ error: { message: "bad key sk-proj-AAAAAAAAAAAAAAAAAAAA" } }))).not.toContain("sk-proj-AAAA");
  });

  it("classifies the unfunded 400 as an outage and names it for what it is", () => {
    const reason = `provider_http_400:${"Your credit balance is too low to access the Anthropic API."}`;
    expect(isProviderOutage(reason)).toBe(true);
    // Not "HTTP_400" and not "AUTH_REJECTED": the fix is a billing page, and the label should send
    // somebody there rather than to a bug hunt or a key rotation.
    expect(outageKind(reason)).toBe("PROVIDER_OUT_OF_CREDIT");
    expect(outageKind("provider_http_402")).toBe("PROVIDER_OUT_OF_CREDIT");
  });

  it("covers the other vendors' spellings of the same fact", () => {
    for (const detail of [
      "You exceeded your current quota, please check your plan and billing details.",
      "insufficient_quota",
      "Insufficient credits. Add more using https://openrouter.ai/credits",
      "Your account is suspended",
      "billing_not_active",
      "Payment Required",
    ]) {
      expect(vendorCannotServe(detail)).toBe(true);
      expect(isProviderOutage(`provider_http_400:${detail}`)).toBe(true);
    }
  });

  it("AND THE NEGATIVE PROOF: a 400 that really is our fault still defers, and does not chain", () => {
    // This is the guard that keeps the change narrow. Blanket-reclassifying 400 would hide real
    // malformed-request bugs behind four vendors all failing the same way.
    expect(isProviderOutage("provider_http_400")).toBe(false);
    expect(isProviderOutage("provider_http_400:messages.0.content.1.image.source.base64: invalid base64 data")).toBe(false);
    expect(isProviderOutage("provider_http_400:model is not supported")).toBe(false);
    expect(isProviderOutage("provider_http_422:Unprocessable Entity")).toBe(false);
    expect(outageKind("provider_http_400:invalid base64 data")).toBe("HTTP_400");
    // A capability refusal is about the REQUEST and can never be overturned by a vendor phrase.
    expect(isProviderOutage("provider_cannot_read_documents:perplexity")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("the unfunded lane chains instead of stopping the work", () => {
  /*
   * THE PRODUCTION CHAIN, RECONSTRUCTED EXACTLY.
   *
   *   head            openrouter / anthropic/claude-sonnet-5   — fails outage-class
   *   outage peer     anthropic  / claude-sonnet-5             — HTTP 400, "credit balance too low"
   *   last resort     openrouter / openai/gpt-4o-mini          — the lane that is WORKING
   *
   * Tonight the third row did not exist: every routing policy in the firm names ONE candidate, so
   * the chain ended at the unfunded peer and the card deferred. A second adequate model is
   * registered here because that is the situation the fix is for.
   */
  const SECOND_MODEL = "openai/gpt-4o-mini";

  beforeEach(async () => {
    await t.db
      .prepare(
        `INSERT OR IGNORE INTO provider_model
           (id, provider_id, model, display_name, capabilities_json, supports_reasoning, max_data_class,
            pricing_state, pricing_source_note, status, registered_by)
         VALUES ('pm_test_mini', 'prov_openrouter', ?1, 'GPT-4o mini', '["text-completion"]', 1, 'INTERNAL',
                 'SOURCED', 'test fixture', 'ACTIVE', 'system')`,
      )
      .bind(SECOND_MODEL)
      .run();
    await t.db
      .prepare(
        `INSERT OR IGNORE INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, captured_at)
         VALUES ('pps_test_mini', 'prov_openrouter', ?1, 0.15, 0.6, '2026-09-17T00:00:00.000Z')`,
      )
      .bind(SECOND_MODEL)
      .run();
  });

  /** OpenRouter, answering per MODEL rather than per host: sonnet is down, the small model is up. */
  function openRouterWhereSonnetIsDown(): () => Promise<Response> {
    return async () =>
      new Response(JSON.stringify({ error: "upstream" }), { status: 503 });
  }

  async function runInterpretation(env: Env, fetchImpl: typeof fetch) {
    return runAi(
      env,
      {
        purpose: "read what the partner asked for",
        actor: MP_ACTOR,
        inputs: ["do the thing I described"],
        sensitivity: "INTERNAL",
        budgetContext: { interpretation: true, preferredModel: PRIMARY_MODEL },
      },
      { fetchImpl },
    );
  }

  /** Answers by looking at the model in the body, so one host can be up for one model and down for another. */
  function byModel(routes: Record<string, () => Response>): { fetchImpl: typeof fetch; seen: string[] } {
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const host = new URL(url).host;
      const body = String(init?.body ?? "");
      seen.push(host);
      for (const [needle, handler] of Object.entries(routes)) {
        if (needle === host || body.includes(needle)) return handler();
      }
      /*
       * ── AN UNSTUBBED LANE IS A BROKEN VENDOR, NOT A TEST ERROR ────────────────────────────
       *
       * This used to throw, and that was right when the catalogue held five models: an unexpected
       * call meant the test had lost track of the chain. Migration 0188 registered ten more lanes,
       * so the chain now legitimately walks past lanes these cases have no opinion about — and a
       * thrown "no stub" is NOT outage-class, so it HALTED the chain and the run deferred. The test
       * would have been asserting the size of the catalogue rather than the behaviour of the chain.
       *
       * A 503 is the honest stand-in: it says "this vendor is down", which is exactly the situation
       * each of these cases is about. The assertions below therefore now prove something STRONGER
       * than they did — the chain reaches the working lane past MORE broken ones, not fewer.
       */
      return new Response(JSON.stringify({ error: `unstubbed lane ${host} treated as down` }), { status: 503 });
    }) as unknown as typeof fetch;
    return { fetchImpl, seen };
  }

  it("completes the run on a working lane after the direct vendor says it has no credit", async () => {
    const { fetchImpl, seen } = byModel({
      // The head fails outage-class, so the chain engages...
      [PRIMARY_MODEL]: () => new Response(JSON.stringify({ error: "upstream" }), { status: 503 }),
      // ...and the direct Anthropic peer is unfunded. Before this change the run stopped HERE.
      "api.anthropic.com": () => new Response(UNFUNDED_BODY, { status: 400 }),
      // The lane that is actually working.
      [SECOND_MODEL]: () =>
        new Response(
          JSON.stringify({ model: SECOND_MODEL, choices: [{ message: { content: "written by the lane that works" } }], usage: { prompt_tokens: 9, completion_tokens: 9 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const env = makeTestEnv(t.db, { OPENROUTER_API_KEY: "or", WP_ANTHROPIC_API_KEY: "ant" });
    const { run } = await runInterpretation(env, fetchImpl);

    // THE ASSERTION THAT MATTERS: the partner got the work, not a deferral to be retried in
    // fourteen minutes.
    expect(run.status).toBe("COMPLETED");
    expect(run.output_text).toBe("written by the lane that works");
    expect(seen).toContain("api.anthropic.com");

    const routing = await routingFor(run.id);
    const outOfCredit = routing.attempts.find((a) => a.detail?.includes("PROVIDER_OUT_OF_CREDIT"));
    expect(outOfCredit).toBeTruthy();
    // The failure is preserved, never tidied away by the recovery.
    expect(outOfCredit!.outcome).toBe("FAILED_OVER");
    expect(outOfCredit!.detail).toContain("credit balance is too low");
    expect(routing.attempts.some((a) => a.outcome === "COMPLETED")).toBe(true);
    expect(routing.fallback_used).toBe(1);
  });

  it("AND THE NEGATIVE PROOF: with the vendor's words missing, the same run stops exactly as it did tonight", async () => {
    /*
     * The ONLY difference from the case above is that the 400 carries no body — which is precisely
     * the state every adapter was in before this change, because each threw the bare status and
     * dropped the body on the floor. The 400 is then indistinguishable from a malformed request,
     * the chain correctly refuses to continue, and the card defers. That one sentence from the
     * vendor is the whole difference between the two outcomes is the proof that the sentence is
     * what does the work — and that the guard is narrow rather than a blanket 400 reclassification.
     */
    const { fetchImpl } = byModel({
      [PRIMARY_MODEL]: () => new Response(JSON.stringify({ error: "upstream" }), { status: 503 }),
      "api.anthropic.com": () => new Response("", { status: 400 }),
      [SECOND_MODEL]: () =>
        new Response(JSON.stringify({ model: SECOND_MODEL, choices: [{ message: { content: "should never be reached" } }], usage: {} }), { status: 200 }),
    });
    const env = makeTestEnv(t.db, { OPENROUTER_API_KEY: "or", WP_ANTHROPIC_API_KEY: "ant" });
    const { run } = await runInterpretation(env, fetchImpl);
    expect(run.status).toBe("BLOCKED_DEFERRED");
    expect(run.failure_reason).toContain("provider_http_400");
  });

  it("skips a lane already in back-off rather than spending the chain on a certainty", async () => {
    // The unfunded peer failed a moment ago, so it is cooling. The chain must not walk back into it.
    await t.db
      .prepare(
        `INSERT INTO provider_lane_health (provider_id, model, completed_runs, consecutive_outages, outage_runs, last_outage_at, last_outage_reason, cooldown_until, updated_at)
         VALUES ('prov_anthropic', 'claude-sonnet-5', 0, 1, 1, ?1, 'provider_http_400:Your credit balance is too low', ?2, ?1)`,
      )
      .bind(new Date().toISOString(), new Date(Date.now() + 5 * 60 * 1000).toISOString())
      .run();

    const { fetchImpl, seen } = byModel({
      [PRIMARY_MODEL]: () => new Response(JSON.stringify({ error: "upstream" }), { status: 503 }),
      "api.anthropic.com": () => new Response(UNFUNDED_BODY, { status: 400 }),
      [SECOND_MODEL]: () =>
        new Response(
          JSON.stringify({ model: SECOND_MODEL, choices: [{ message: { content: "straight to the working lane" } }], usage: { prompt_tokens: 9, completion_tokens: 9 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const env = makeTestEnv(t.db, { OPENROUTER_API_KEY: "or", WP_ANTHROPIC_API_KEY: "ant" });
    const { run } = await runInterpretation(env, fetchImpl);

    expect(run.status).toBe("COMPLETED");
    expect(run.output_text).toBe("straight to the working lane");
    // The unfunded vendor was never contacted at all.
    expect(seen).not.toContain("api.anthropic.com");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("a price on paper is not a cost", () => {
  it("prefers the lane that has completed work over the cheaper one that never has", () => {
    const health = new Map<string, LaneHealthRow>([
      [
        "prov_openrouter anthropic/claude-sonnet-5",
        {
          provider_id: "prov_openrouter",
          model: "anthropic/claude-sonnet-5",
          completed_runs: 412,
          consecutive_outages: 0,
          outage_runs: 0,
          last_completed_at: "2026-09-17T00:00:00.000Z",
          last_outage_at: null,
          last_outage_reason: null,
          cooldown_until: null,
        },
      ],
    ]);
    // The production shape exactly: the direct lane is CHEAPER, because it carries no margin.
    const candidates = [
      { providerId: "prov_anthropic", providerKey: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.004 },
      { providerId: "prov_openrouter", providerKey: "openrouter", model: "anthropic/claude-sonnet-5", estimatedCostUsd: 0.006 },
    ];
    const ranked = orderByLaneHealth(candidates, health, new Date("2026-09-18T00:00:00Z"));
    expect(ranked.ordered[0]!.providerId).toBe("prov_openrouter");
    expect(ranked.applied).toBe(true);
    expect(ranked.note).toContain("never completed a run");
    expect(ranked.note).toContain("A price on paper is not a cost");
  });

  it("AND THE NEGATIVE PROOF: with no history at all, nothing is reordered and price decides again", () => {
    const candidates = [
      { providerId: "prov_anthropic", providerKey: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.004 },
      { providerId: "prov_openrouter", providerKey: "openrouter", model: "anthropic/claude-sonnet-5", estimatedCostUsd: 0.006 },
    ];
    const ranked = orderByLaneHealth(candidates, new Map(), new Date());
    expect(ranked.applied).toBe(false);
    expect(ranked.ordered).toEqual(candidates);
    // An unproven lane is unknown, not good — and unknown is also not BAD. A newly registered model
    // must still be able to get its first run.
    expect(ranked.note).toBe("");
  });

  it("removes a lane in back-off from the comparison entirely, and says so", () => {
    const now = new Date("2026-09-17T22:00:00Z");
    const health = new Map<string, LaneHealthRow>([
      [
        "prov_anthropic claude-sonnet-5",
        {
          provider_id: "prov_anthropic",
          model: "claude-sonnet-5",
          completed_runs: 0,
          consecutive_outages: 2,
          outage_runs: 2,
          last_completed_at: null,
          last_outage_at: "2026-09-17T21:55:00.000Z",
          last_outage_reason: "provider_http_400:Your credit balance is too low",
          cooldown_until: "2026-09-17T22:05:00.000Z",
        },
      ],
    ]);
    const ranked = orderByLaneHealth(
      [
        { providerId: "prov_anthropic", providerKey: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.004 },
        { providerId: "prov_openrouter", providerKey: "openrouter", model: "anthropic/claude-sonnet-5", estimatedCostUsd: 0.006 },
      ],
      health,
      now,
    );
    expect(ranked.ordered.map((c) => c.providerId)).toEqual(["prov_openrouter"]);
    expect(ranked.note).toContain("credit balance is too low");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("the back-off recovers on its own", () => {
  it("lengthens while the lane keeps failing and is capped rather than unbounded", () => {
    expect(cooldownMsFor(1)).toBe(5 * 60 * 1000);
    expect(cooldownMsFor(2)).toBe(10 * 60 * 1000);
    expect(cooldownMsFor(4)).toBe(40 * 60 * 1000);
    // Capped. A lane that has been fixed must not sit idle waiting for an exponential to elapse.
    expect(cooldownMsFor(9)).toBe(60 * 60 * 1000);
    expect(cooldownMsFor(0)).toBe(0);
  });

  it("is a timestamp and not a flag, so the clock alone restores the lane", () => {
    const row = (until: string | null): LaneHealthRow => ({
      provider_id: "p",
      model: "m",
      completed_runs: 0,
      consecutive_outages: 1,
      outage_runs: 1,
      last_completed_at: null,
      last_outage_at: null,
      last_outage_reason: null,
      cooldown_until: until,
    });
    const now = new Date("2026-09-17T22:00:00Z");
    expect(isCoolingDown(row("2026-09-17T22:05:00.000Z"), now)).toBe(true);
    // No human act, no cron, no half-open bookkeeping: five minutes later it is a candidate again.
    expect(isCoolingDown(row("2026-09-17T21:55:00.000Z"), now)).toBe(false);
    expect(isCoolingDown(row(null), now)).toBe(false);
    // A lane disabled forever by a transient outage is its own defect, so there is no state that
    // can outlive the clock — including a value nobody can parse.
    expect(isCoolingDown(row("not a date"), now)).toBe(false);
  });

  it("arms after a real outage and clears on the next completion", async () => {
    const env = makeTestEnv(t.db, { OPENROUTER_API_KEY: "or", WP_ANTHROPIC_API_KEY: "ant" });
    const down = hostRouter({
      "openrouter.ai": fails(429, JSON.stringify({ error: "rate limited" })),
      "api.anthropic.com": answers("claude-sonnet-5", "caught it"),
    });
    const first = await runAi(
      env,
      {
        purpose: "drafting for a partner",
        actor: MP_ACTOR,
        inputs: ["draft"],
        sensitivity: "PUBLIC",
        budgetContext: { judgement: true, preferredModel: PRIMARY_MODEL },
      },
      { fetchImpl: down.fetchImpl },
    );
    expect(first.run.status).toBe("COMPLETED");

    const cooled = await t.db
      .prepare("SELECT consecutive_outages, cooldown_until, last_outage_reason FROM provider_lane_health WHERE provider_id = 'prov_openrouter'")
      .first<{ consecutive_outages: number; cooldown_until: string | null; last_outage_reason: string | null }>();
    expect(cooled?.consecutive_outages).toBe(1);
    expect(Date.parse(cooled!.cooldown_until!)).toBeGreaterThan(Date.now());

    // And the lane that DID the work is recorded as working, which is what stops the next
    // selection preferring an untried lane on price.
    const served = await t.db
      .prepare("SELECT completed_runs FROM provider_lane_health WHERE provider_id = 'prov_anthropic' AND model = 'claude-sonnet-5'")
      .first<{ completed_runs: number }>();
    expect(served?.completed_runs).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("OpenRouter first and foremost; the direct lanes are fallbacks", () => {
  it("prefers OpenRouter for work both can do, even when the direct lane prices lower", async () => {
    /*
     * THE PRODUCTION SHAPE, RECONSTRUCTED. Tonight `prov_anthropic` held an ACTIVE, PRICED
     * `claude-sonnet-5` row that undercut the OpenRouter lane for the identical model. The registry
     * comment says a direct vendor "cannot win an ordinary selection" — but that was a property of
     * the DATA, and the data had changed. This registers the row that breaks the doctrine and
     * asserts the doctrine holds anyway.
     */
    await t.db
      .prepare(
        `INSERT OR IGNORE INTO provider_model
           (id, provider_id, model, display_name, capabilities_json, supports_reasoning, max_data_class,
            pricing_state, pricing_source_note, status, registered_by)
         VALUES ('pm_direct_sonnet5', 'prov_anthropic', 'claude-sonnet-5', 'Claude Sonnet 5 (direct)',
                 '["text-completion"]', 1, 'INTERNAL', 'SOURCED', 'test fixture', 'ACTIVE', 'system')`,
      )
      .run();
    await t.db
      .prepare(
        `INSERT OR IGNORE INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, captured_at)
         VALUES ('pps_direct_sonnet5', 'prov_anthropic', 'claude-sonnet-5', 1.0, 5.0, '2026-09-17T00:00:00.000Z')`,
      )
      .run();
    await t.db.prepare("UPDATE provider_registry SET enabled = 1 WHERE provider_key = 'anthropic'").run();

    const { fetchImpl, seen } = hostRouter({
      "openrouter.ai": openRouterAnswers(PRIMARY_MODEL, "written by OpenRouter"),
    });
    const env = makeTestEnv(t.db, { OPENROUTER_API_KEY: "or", WP_ANTHROPIC_API_KEY: "ant" });
    const { run } = await runAi(
      env,
      {
        purpose: "drafting for a partner",
        actor: MP_ACTOR,
        inputs: ["draft the summary"],
        sensitivity: "INTERNAL",
        budgetContext: { interpretation: true },
      },
      { fetchImpl },
    );

    expect(run.status).toBe("COMPLETED");
    // Half the fix: the direct lane, which is HALF THE PRICE, was not even contacted.
    expect(seen).not.toContain("api.anthropic.com");
    expect(seen).toContain("openrouter.ai");
    const routing = await routingFor(run.id);
    expect(routing.explanation).toContain("OpenRouter leads and a direct vendor lane");

    await t.db.prepare("DELETE FROM provider_model WHERE id = 'pm_direct_sonnet5'").run();
    await t.db.prepare("DELETE FROM provider_pricing_snapshot WHERE id = 'pps_direct_sonnet5'").run();
  });

  it("and the direct lane IS reached the moment OpenRouter cannot serve", async () => {
    const { fetchImpl, seen } = hostRouter({
      "openrouter.ai": fails(503, JSON.stringify({ error: "upstream" })),
      "api.anthropic.com": answers("claude-sonnet-5", "written by the direct lane"),
    });
    const env = makeTestEnv(t.db, { OPENROUTER_API_KEY: "or", WP_ANTHROPIC_API_KEY: "ant" });
    const { run } = await runAi(
      env,
      {
        purpose: "drafting for a partner",
        actor: MP_ACTOR,
        inputs: ["draft the summary"],
        sensitivity: "INTERNAL",
        budgetContext: { interpretation: true, preferredModel: PRIMARY_MODEL },
      },
      { fetchImpl },
    );
    expect(run.status).toBe("COMPLETED");
    expect(run.output_text).toBe("written by the direct lane");
    expect(seen).toContain("api.anthropic.com");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("two labels, and neither one implies the other", () => {
  it("lets a hire search, an event kit and a room packet reach a free reasoning lane", () => {
    for (const [machineKey, work] of [
      ["external_helper_coordination", "Find three freelance producers in Los Angeles for the November shoot."],
      ["west_peek_live_events", "Draft the run of show for the founder dinner: doors 6pm, two panels, close at 9."],
      ["community_intelligence", "Write the room packet for Thursday: who is coming, what they care about, three questions."],
      ["venture_teaching", "Build the workshop packet on reading a term-sheet-free intro deck."],
      ["marketing_pr_content", "Draft five social posts about the new season of the podcast."],
    ] as const) {
      const verdict = classifyContent({ machineKey, inputs: [work] });
      expect(verdict.publicModelApproved, `${machineKey} should be public-model approved`).toBe(true);
    }
  });

  it("AND THE NEGATIVE PROOF: LP and deal material cannot, whatever the card says", () => {
    // Declared safe by the caller AND sitting on an allow-listed machine — and still refused,
    // because the text itself carries the marker.
    const revoked = classifyContent({
      declaredPublicModelApproved: true,
      machineKey: "west_peek_live_events",
      inputs: ["Guest list for the LP dinner, cross-checked against the limited partner register."],
    });
    expect(revoked.publicModelApproved).toBe(false);
    expect(revoked.revokedBy).toContain("limited partner");

    // And the explicit label always wins on its own.
    expect(classifyContent({ declaredPrivateModelOnly: true, machineKey: "west_peek_live_events", inputs: ["anything"] }).publicModelApproved).toBe(false);
    // An unlisted machine keeps today's behaviour: undeclared is private, not permissive.
    expect(classifyContent({ machineKey: "ic_decision", inputs: ["Summarise the committee's view."] }).publicModelApproved).toBe(false);
    expect(classifyContent({ inputs: ["anything at all"] }).publicModelApproved).toBe(false);
  });

  it("AND THE MISFIRE PROOF: ordinary prose does not trip the detector", () => {
    /*
     * A notice in the sister system containing the single word "commitment" tripped a deal-term
     * pattern and made EVERY RUN FIRM-WIDE scan as LP material, refusing every free route. These
     * sentences are the fixtures for that failure: each contains a word that a looser detector
     * would catch, and none of them is about the private side of the fund.
     */
    for (const prose of [
      "We need a commitment from the venue by Friday.",
      "The capital of the state is a four-hour drive from the venue.",
      "Round two of the interviews is on Thursday.",
      "The investor day livestream runs on West Peek Live.",
      "Funding the coffee cart out of the events budget.",
      "Safe to assume forty people; the room is capped at sixty.",
      "Interest in the workshop has been strong.",
    ]) {
      const verdict = classifyContent({ machineKey: "west_peek_live_events", inputs: [prose] });
      expect(verdict.publicModelApproved, `misfired on: ${prose}`).toBe(true);
    }
  });

  it("treats a PUBLIC-labelled run as already approved — the daily brief was never the problem", () => {
    // The daily executive brief is assembled from third-party headlines and published market
    // levels and has been labelled PUBLIC for months. PUBLIC is a statement about CONTENT, so
    // requiring a second declaration on top of it would have made the firm's largest recurring job
    // ineligible for the free lanes on the very day they arrived.
    const verdict = classifyContent({ sensitivity: "PUBLIC", inputs: ["Overnight: the 30-year yield moved."] });
    expect(verdict.publicModelApproved).toBe(true);
    expect(verdict.reason).toContain("labelled PUBLIC");
    // And it is still only a CONTENT verdict: PRIVATE_MODEL_ONLY overrides even a PUBLIC label.
    expect(classifyContent({ sensitivity: "PUBLIC", declaredPrivateModelOnly: true, inputs: ["x"] }).publicModelApproved).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("the money: what actually runs, and what it costs", () => {
  it("lands the daily executive brief on a FREE reasoning lane, at $0", async () => {
    /*
     * "THE DAILY EXECUTIVE BRIEF IS PUBLIC MODEL APPROVED / NOT CONFIDENTIAL SO MAKE SURE THOSE DO
     * NOT COST A LOT OF MONEY SINCE THEY RUN DAILY." — the owner, 17 Sep 2026.
     *
     * It was costing $0.30–$0.67 a day on `anthropic/claude-sonnet-5`. It was ALREADY labelled
     * PUBLIC and ALREADY marked judgement, so it was always eligible for the free-first path — the
     * free lanes simply did not exist until migration 0178, which landed the same day. This asserts
     * the outcome rather than the intention.
     */
    const { fetchImpl, seen } = hostRouter({
      "openrouter.ai": openRouterAnswers("nvidia/nemotron-3-ultra-550b-a55b:free", "the brief"),
    });
    const env = makeTestEnv(t.db, { OPENROUTER_API_KEY: "or", GEMINI_API_KEY: "g" });
    const { run } = await runAi(
      env,
      {
        purpose: "daily intelligence report 2026-09-18 for Sequoia Taylor",
        actor: MP_ACTOR,
        inputs: ["Overnight headlines and published market levels, assembled for the morning brief."],
        sensitivity: "PUBLIC",
        budgetContext: { judgement: true, expectedOutputTokens: 8000 },
      },
      { fetchImpl },
    );

    expect(run.status).toBe("COMPLETED");
    expect(run.model).toContain(":free");
    const usage = JSON.parse(run.actual_usage_json!) as { cost_usd: number };
    expect(usage.cost_usd).toBe(0);
    expect(seen).toEqual(["openrouter.ai"]);

    const routing = await routingFor(run.id);
    // The paid head is still behind it, so a free tier running out does not cost her the brief.
    expect(routing.explanation).toContain("Free frontier capacity is tried first");
    expect(routing.explanation).toContain("falls through to");
  });

  it("falls through to the paid head when the free quota is exhausted, so quality is never the price of thrift", async () => {
    let call = 0;
    const { fetchImpl } = hostRouter({
      "openrouter.ai": () => {
        call += 1;
        // The free lane answers 429 when its quota is gone; the paid head then serves.
        return call === 1
          ? new Response(JSON.stringify({ error: { message: "Rate limit exceeded: free-models-per-day" } }), { status: 429 })
          : new Response(
              JSON.stringify({ model: PRIMARY_MODEL, choices: [{ message: { content: "the brief, paid for" } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
      },
      "generativelanguage.googleapis.com": () =>
        new Response(JSON.stringify({ error: { message: "Quota exceeded for quota metric" } }), { status: 429 }),
    });
    const env = makeTestEnv(t.db, { OPENROUTER_API_KEY: "or", GEMINI_API_KEY: "g" });
    const { run } = await runAi(
      env,
      {
        purpose: "daily intelligence report 2026-09-19 for Sequoia Taylor",
        actor: MP_ACTOR,
        inputs: ["Overnight headlines and published market levels."],
        sensitivity: "PUBLIC",
        budgetContext: { judgement: true, expectedOutputTokens: 8000 },
      },
      { fetchImpl },
    );
    expect(run.status).toBe("COMPLETED");
    expect(run.output_text).toBe("the brief, paid for");
    const routing = await routingFor(run.id);
    expect(routing.fallback_used).toBe(1);
    expect(routing.attempts.some((a) => a.detail?.includes("RATE_LIMITED"))).toBe(true);
  });

  it("keeps LP and deal work off every free lane, at any price", async () => {
    const { fetchImpl, seen } = hostRouter({
      "openrouter.ai": openRouterAnswers(PRIMARY_MODEL, "the LP memo"),
    });
    const env = makeTestEnv(t.db, { OPENROUTER_API_KEY: "or", GEMINI_API_KEY: "g" });
    const { run } = await runAi(
      env,
      {
        purpose: "LP memo",
        actor: MP_ACTOR,
        inputs: ["Draft the quarterly note for our limited partners, including the fund's net TVPI."],
        sensitivity: "INTERNAL",
        budgetContext: { judgement: true, confidential: true },
      },
      { fetchImpl },
    );
    expect(run.status).toBe("COMPLETED");
    // Not a free model, and never Gemini's unpaid quota.
    expect(run.model).not.toContain(":free");
    expect(seen).not.toContain("generativelanguage.googleapis.com");
  });
});

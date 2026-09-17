import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { runAi } from "../src/worker/ai/runAi";
import { firmBudgetStates, FIRM_BUDGET_ALERT_USD } from "../src/worker/ai/spend";

/**
 * CHEAPO FOR EVERYTHING, FREE FRONTIER CAPACITY FOR THE IMPORTANT THINGS, AND A HARD LINE.
 *
 * The owner asked for two things that pull against each other: use free tiers for the important
 * work, and never let LP names or deal terms near one. They pull against each other because a free
 * route is generally free BECAUSE the provider may train on what you send it — Google says so in
 * terms: "Do not submit sensitive, confidential, or personal information to the Unpaid Services."
 *
 * This suite proves the resolution holds at runtime rather than in a comment:
 *   · CHEAPO does not downgrade the calls that were classified as quality-critical;
 *   · a live search still reaches a model that can search, which is where CHEAPO would have done
 *     its real damage — eight calls pinned the search model in a way CHEAPO ignores;
 *   · free lanes are tried first for public-facing judgement work, and the handover to the paid
 *     model when the free quota runs out is recorded rather than silent;
 *   · a confidential call cannot reach a training-permitting lane, and the negative proof is the
 *     same call with the flag removed reaching one.
 */

let t: TestDb;
const MP_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };

const OK_OPENAI_SHAPE = (text: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function hostRouter(routes: Record<string, () => Response>): { fetchImpl: typeof fetch; seen: string[]; paths: string[] } {
  const seen: string[] = [];
  const paths: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const u = new URL(url);
    seen.push(u.host);
    paths.push(u.pathname);
    const handler = routes[u.host];
    if (!handler) throw new Error(`no stub for ${u.host}`);
    return handler();
  }) as unknown as typeof fetch;
  return { fetchImpl, seen, paths };
}

function env(extra: Partial<Env> = {}): Env {
  return makeTestEnv(t.db, {
    OPENROUTER_API_KEY: "or-key",
    GEMINI_API_KEY: "gem-key",
    WP_ANTHROPIC_API_KEY: "ant-key",
    ...extra,
  });
}

async function routingFor(runId: string) {
  const row = await t.db
    .prepare("SELECT attempts_json, fallback_used, selected_provider_key, selected_model, explanation FROM ai_run_routing WHERE ai_run_id = ?1")
    .bind(runId)
    .first<{ attempts_json: string; fallback_used: number; selected_provider_key: string; selected_model: string; explanation: string }>();
  return { ...row!, attempts: JSON.parse(row!.attempts_json) as Array<{ provider_key: string; model: string; outcome: string; detail?: string }> };
}

/**
 * The policy migration 0178 appends in production, set here explicitly.
 *
 * 0178 copies the privacy posture from whatever policy is in force rather than restating it, so a
 * cost migration cannot move a firm from LOCKDOWN to FRONTIER as a side effect. The seeded firm is
 * on LOCKDOWN, so this suite writes the FRONTIER line production is actually on.
 */
beforeAll(async () => {
  t = await createTestDb();
  await t.db
    .prepare(
      `INSERT INTO budget_policy (id, firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, honours_pins, prefers_frontier, set_by)
       VALUES ('bp_test_cheapo', 'west-peek', 'CHEAPO', 'FRONTIER', 2.5, 0.75, 1, 0, 'fu_sequoia_taylor')`,
    )
    .run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("the firm is on CHEAPO, and the caps are the ones the owner set", () => {
  it("is what migration 0178 writes, guarded so it can only AMEND a policy and never open one", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(new URL("../migrations/0178_free_lanes_a_real_ceiling_and_cheapo.sql", import.meta.url), "utf8");
    // A new budget_policy row inherits NOTHING, so omitting the caps would silently reset them to
    // the column default of 0 — which blocks every run rather than capping it.
    expect(sql).toContain("'CHEAPO', b.privacy_mode, 2.5, 0.75");
    expect(sql).toContain("fu_sequoia_taylor");
    // And the guard: a firm with no policy line is on LOCKDOWN, and a cost migration does not get
    // to switch a deployment to FRONTIER as a side effect.
    // The privacy posture is COPIED from the policy in force, never restated as a literal: a cost
    // migration must not be able to move a firm from LOCKDOWN to FRONTIER as a side effect.
    expect(sql).not.toMatch(/'CHEAPO',\s*'FRONTIER'/);
    expect(sql).toContain("FROM budget_policy b");

    const policy = await t.db
      .prepare("SELECT cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd FROM budget_policy WHERE firm_scope = 'west-peek' ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .first<{ cost_mode: string; privacy_mode: string; daily_cap_usd: number; per_run_cap_usd: number }>();
    expect(policy?.cost_mode).toBe("CHEAPO");
    expect(policy?.daily_cap_usd).toBe(2.5);
    expect(policy?.per_run_cap_usd).toBe(0.75);
  });

  it("finally has a monthly ceiling, where before there was only a daily one", async () => {
    const states = await firmBudgetStates(t.db && (env() as Env), "west-peek");
    const monthly = states.find((s) => s.budget_window === "MONTHLY")!;
    // 31 x $2.50 of daily cap is $77.50. A daily cap alone was never a monthly ceiling.
    // 0179 raised it to $75 and made $50 the NOTIFY line instead of the stop, which is the ladder
    // the owner actually set: she is told at $50 and the firm stops at $75.
    expect(monthly.cap_usd).toBe(75);
    expect(monthly.reason).toContain("$50 is where she is NOTIFIED");
  });

  it("warns at the owner's own numbers, in dollars, not at a percentage of a ceiling that moved", () => {
    // These were percentages — 10/50/80 — which worked only while the ceiling was $50 and 10% of it
    // happened to land on her $5 target. The ceiling is now $75 and 10% of it is $7.50, a number she
    // never named. A threshold expressed as a fraction of something else moves when that thing moves.
    expect(FIRM_BUDGET_ALERT_USD).toEqual([5, 10, 50]);
  });

  it("raises a WARNING before the ceiling bites, and only one per threshold", async () => {
    const e = env();
    const { raiseFirmBudgetWarning } = await import("../src/worker/ai/spend");
    const now = new Date("2026-09-17T12:00:00.000Z");
    await raiseFirmBudgetWarning(e, "west-peek", "MONTHLY", 75, 6.2, now);
    await raiseFirmBudgetWarning(e, "west-peek", "MONTHLY", 75, 7.4, now);
    const alerts = await t.db
      .prepare("SELECT severity, observed_usd FROM cost_alert WHERE scope_type = 'FIRM' AND scope_id = 'west-peek'")
      .all<{ severity: string; observed_usd: number }>();
    expect(alerts.results.length).toBe(1);
    expect(alerts.results[0]!.severity).toBe("WARNING");

    // A second, higher threshold is a separate fact and gets its own alert.
    await raiseFirmBudgetWarning(e, "west-peek", "MONTHLY", 75, 12, now);
    const after = await t.db.prepare("SELECT dedupe_key FROM cost_alert WHERE scope_type = 'FIRM'").all<{ dedupe_key: string }>();
    expect(after.results.map((r) => r.dedupe_key.split(":").pop()).sort()).toEqual(["USD10", "USD5"]);
  });
});

describe("CHEAPO must not break a live search — the reason the classification came first", () => {
  it("still reaches a search-grounded model under CHEAPO, where a bare pin would have been ignored", async () => {
    const { fetchImpl } = hostRouter({ "openrouter.ai": () => OK_OPENAI_SHAPE("what happened in the market") });
    const { run } = await runAi(
      env(),
      {
        purpose: "daily market levels and calendar",
        actor: MP_ACTOR,
        inputs: ["what moved today"],
        sensitivity: "PUBLIC",
        // Exactly what liveSearch.ts now passes. Before the marker existed it passed only
        // `preferredModel: SEARCH_MODEL`, which CHEAPO ignores outright.
        budgetContext: { requiresSearch: true, preferredModel: "perplexity/sonar", providerKey: "openrouter" },
      },
      { fetchImpl },
    );
    expect(run.status).toBe("COMPLETED");
    expect(run.model).toBe("perplexity/sonar");
  });

  it("refuses rather than answering from memory when nothing can search", async () => {
    // Kill-switch the only search-capable model's provider for the length of this assertion.
    await t.db.prepare("UPDATE provider_model SET status = 'BENCH' WHERE provider_id = 'prov_openrouter' AND model = 'perplexity/sonar'").run();
    const { fetchImpl } = hostRouter({ "openrouter.ai": () => OK_OPENAI_SHAPE("I think the market rose") });
    const { run } = await runAi(
      env(),
      {
        purpose: "daily market levels and calendar",
        actor: MP_ACTOR,
        inputs: ["what moved today"],
        sensitivity: "PUBLIC",
        budgetContext: { requiresSearch: true, providerKey: "openrouter" },
      },
      { fetchImpl },
    );
    // THE WHOLE POINT. A cheap model handed this question does not error — it answers fluently from
    // memory, and the answer is indistinguishable from research.
    // PREFLIGHT_BLOCKED: refused before a request was formed, which is the point — the decision is
    // made by the router rather than by whatever a model chose to say.
    expect(run.status).toBe("PREFLIGHT_BLOCKED");
    expect(run.failure_reason).toContain("no_search_grounded_model_available");
    expect(run.output_text ?? "").toBe("");
    await t.db.prepare("UPDATE provider_model SET status = 'ACTIVE' WHERE provider_id = 'prov_openrouter' AND model = 'perplexity/sonar'").run();
  });
});

describe("free frontier capacity carries the important, public-facing work", () => {
  it("tries the free lane first and completes there, spending nothing", async () => {
    const { fetchImpl, seen } = hostRouter({
      "openrouter.ai": () => OK_OPENAI_SHAPE("the packet, written free"),
    });
    const { run } = await runAi(
      env(),
      {
        purpose: "Parker: Workshop research judgement",
        actor: MP_ACTOR,
        inputs: ["write the angles"],
        sensitivity: "PUBLIC",
        budgetContext: { judgement: true },
      },
      { fetchImpl },
    );
    expect(run.status).toBe("COMPLETED");
    expect(run.model).toContain(":free");
    expect(seen).toContain("openrouter.ai");
    const usage = JSON.parse(run.actual_usage_json!) as { cost_usd: number };
    // Free, and priced as free — the fallback carries its own rates now, so a run is never billed
    // at the rate of a model it did not use.
    expect(usage.cost_usd).toBe(0);
  });

  it("falls through to the paid model when the free quota runs out, and SAYS SO", async () => {
    let call = 0;
    const { fetchImpl } = hostRouter({
      // First the free endpoint is rate-limited (which is what an exhausted free tier looks like),
      // then the paid one answers.
      "openrouter.ai": () => (++call === 1 ? new Response("{}", { status: 429 }) : OK_OPENAI_SHAPE("the packet, paid for")),
      "generativelanguage.googleapis.com": () => new Response("{}", { status: 429 }),
    });
    const { run } = await runAi(
      env(),
      {
        purpose: "Parker: Workshop research judgement",
        actor: MP_ACTOR,
        inputs: ["write the angles"],
        sensitivity: "PUBLIC",
        budgetContext: { judgement: true },
      },
      { fetchImpl },
    );
    expect(run.status).toBe("COMPLETED");
    const routing = await routingFor(run.id);
    // QUOTA EXHAUSTION IS VISIBLE, NOT SILENT: "we started paying at 11am on the 9th" is a query.
    expect(routing.fallback_used).toBe(1);
    const handover = routing.attempts.find((a) => a.outcome === "FAILED_OVER")!;
    expect(handover.model).toContain(":free");
    expect(handover.detail).toContain("RATE_LIMITED");
    expect(routing.attempts.some((a) => a.outcome === "COMPLETED")).toBe(true);
  });

  it("says on the run, before anything happens, that free capacity is being tried", async () => {
    const { fetchImpl } = hostRouter({ "openrouter.ai": () => OK_OPENAI_SHAPE("done") });
    const { run } = await runAi(
      env(),
      { purpose: "blog help: judgement", actor: MP_ACTOR, inputs: ["draft"], sensitivity: "PUBLIC", budgetContext: { judgement: true } },
      { fetchImpl },
    );
    const routing = await routingFor(run.id);
    expect(routing.explanation).toContain("Free frontier capacity is tried first");
    expect(routing.explanation).toContain("carries no LP names or deal terms");
  });
});

describe("the hard line: LP names and deal terms never reach a lane that may train", () => {
  it("refuses the free lanes for a confidential call, and uses a paid one", async () => {
    const { fetchImpl, seen } = hostRouter({ "openrouter.ai": () => OK_OPENAI_SHAPE("the LP report") });
    const { run } = await runAi(
      env(),
      {
        purpose: "Draft the LP report for Fund I",
        actor: MP_ACTOR,
        inputs: ["Ferndale Partners committed $2m at a 2% fee"],
        // PUBLIC on purpose: the label alone would have permitted a free lane. The flag is a fact
        // about the WORDS, and this is the case it exists for.
        sensitivity: "PUBLIC",
        budgetContext: { judgement: true, confidential: true },
      },
      { fetchImpl },
    );
    expect(run.status).toBe("COMPLETED");
    expect(run.model).not.toContain(":free");
    expect(seen).not.toContain("generativelanguage.googleapis.com");
    const routing = await routingFor(run.id);
    expect(routing.explanation).not.toContain("Free frontier capacity");
  });

  it("and the NEGATIVE PROOF: the identical call WITHOUT the flag does reach a free lane", async () => {
    const { fetchImpl } = hostRouter({ "openrouter.ai": () => OK_OPENAI_SHAPE("the report") });
    const { run } = await runAi(
      env(),
      {
        purpose: "Draft the LP report for Fund I",
        actor: MP_ACTOR,
        inputs: ["Ferndale Partners committed $2m at a 2% fee"],
        sensitivity: "PUBLIC",
        budgetContext: { judgement: true },
      },
      { fetchImpl },
    );
    // If this did not reach the free lane, the assertion above was passing for some other reason
    // and proves nothing about the flag.
    expect(run.model).toContain(":free");
  });

  it("refuses at the EGRESS GATE too, on the label alone, with no flag involved", async () => {
    const { fetchImpl } = hostRouter({ "openrouter.ai": () => OK_OPENAI_SHAPE("internal work") });
    const { run } = await runAi(
      env(),
      {
        purpose: "an internal judgement",
        actor: MP_ACTOR,
        inputs: ["something internal"],
        sensitivity: "INTERNAL",
        budgetContext: { judgement: true },
      },
      { fetchImpl },
    );
    expect(run.status).toBe("COMPLETED");
    // Two independent gates. The free lanes allow PUBLIC and nothing else, so an INTERNAL run never
    // reaches one even when nobody marks it confidential.
    expect(run.model).not.toContain(":free");
  });

  it("blocks loudly when a confidential call has no lane that does not train", async () => {
    // Every non-training provider switched off: the only thing left is a free lane, and a free lane
    // is not an acceptable substitute at any price.
    await t.db.prepare("UPDATE provider_registry SET enabled = 0 WHERE training_permitted = 0").run();
    const { fetchImpl } = hostRouter({ "openrouter.ai": () => OK_OPENAI_SHAPE("should not happen") });
    const { run } = await runAi(
      env(),
      {
        purpose: "Draft the LP report",
        actor: MP_ACTOR,
        inputs: ["deal terms"],
        sensitivity: "PUBLIC",
        budgetContext: { judgement: true, confidential: true },
      },
      { fetchImpl },
    );
    expect(run.status).toBe("EGRESS_BLOCKED");
    expect(run.failure_reason).toContain("confidential_call_has_no_lane_that_does_not_train");
    await t.db.prepare("UPDATE provider_registry SET enabled = 1 WHERE provider_key IN ('openrouter','workers_ai','anthropic','openai','google','perplexity')").run();
  });
});
